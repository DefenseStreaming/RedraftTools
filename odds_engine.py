#!/usr/bin/env python3
"""Old Balls playoff odds - Sleeper Monte Carlo (v4).

League rule (editable by flag): seeds 1-6 go to the best records (points-for
tiebreak) and seed 7 goes to the highest points-for among the other teams.

OUTPUT (best playoff odds first):
  Rank | Team | Top 6 Odds | #1 Seed Odds | 7th Seed If Not Top 6 | 7th Seed Odds | Playoff Odds
  Playoff Odds = Top 6 Odds + 7th Seed Odds, and it is always the last column.

HOW THE MODEL WORKS
  1. Pulls standings, weekly scores and the REAL remaining schedule from Sleeper.
  2. Estimates each team's true scoring level by Bayesian shrinkage:
        prior (roster strength)  +  recency-weighted scoring history.
     Early in the season the prior leads; every week the scoring history gets
     more weight, so nothing needs to be changed during the season.
  3. Every simulated season it
        - draws a plausible "true level" for each team (talent is uncertain),
        - simulates player availability week by week (injury status, returns,
          new injuries, bye weeks),
        - re-optimises each team's best legal lineup from who is available;
          holes are filled with the league's real best free agent,
        - draws weekly scores (with occasional boom/bust weeks), plays the real
          matchups, and seeds the field with the league rule.
  4. Reports the table above and appends a row to a log so you can grade the
     model against what really happened (--grade).

Python 3.9+, standard library only. Public read-only Sleeper API (no key).

  python sleeper_playoff_odds_v4.py                    # live run, 10,000 sims
  python sleeper_playoff_odds_v4.py --diagnose         # check every API piece first
  python sleeper_playoff_odds_v4.py --simulations 50000
  python sleeper_playoff_odds_v4.py --force "Oliver:11:L"   # what-if: Oliver loses wk 11
  python sleeper_playoff_odds_v4.py --roster-csv roster.csv # use your sheet's Roster scores
  python sleeper_playoff_odds_v4.py --paste            # tab-separated block for Google Sheets
  python sleeper_playoff_odds_v4.py --grade            # after the season: score the log
  python sleeper_playoff_odds_v4.py --demo --demo-weeks 6   # offline fake league
  python sleeper_playoff_odds_v4.py --selftest | --backtest
"""
from __future__ import annotations

import argparse
import csv
import itertools
import json
import math
import random
import statistics
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

API = "https://api.sleeper.app/v1"
# The projections feed is undocumented (it is what the Sleeper web app calls).
# Both hosts are tried; if it fails the model falls back to scoring history.
PROJ_BASES = ("https://api.sleeper.com/projections/nfl",
              "https://api.sleeper.app/projections/nfl")
DEFAULT_LEAGUE_ID = "1326964109681385472"
USER_AGENT = "SleeperPlayoffOdds/4.0 (personal fantasy analytics)"

NON_START_SLOTS = {"BN", "IR", "TAXI", "RESERVE"}
PROJ_POSITIONS = ("QB", "RB", "WR", "TE", "K", "DEF")
# Weekly chance a healthy player is newly hurt (heuristic; scale with --injury-scale).
BASE_HAZARD = {"QB": 0.020, "RB": 0.050, "WR": 0.040, "TE": 0.040, "K": 0.010, "DEF": 0.005}
FALLBACK_REPLACEMENT = {"QB": 13.0, "RB": 8.0, "WR": 8.0, "TE": 5.5, "K": 7.0, "DEF": 6.0}
SLOT_ACCEPTS = {
    "QB": {"QB"}, "RB": {"RB"}, "WR": {"WR"}, "TE": {"TE"}, "K": {"K"}, "DEF": {"DEF"},
    "FLEX": {"RB", "WR", "TE"}, "REC_FLEX": {"WR", "TE"}, "WRRB_FLEX": {"RB", "WR"},
    "SUPER_FLEX": {"QB", "RB", "WR", "TE"},
    "DL": {"DL", "DE", "DT"}, "LB": {"LB"}, "DB": {"DB", "CB", "S"},
    "IDP_FLEX": {"DL", "DE", "DT", "LB", "DB", "CB", "S"},
}
OUT_STATUSES = {"out", "ir", "doubtful", "pup", "sus", "cov", "nfi", "dnr", "na"}

DEFAULT_WEEKLY_SD = 24.0       # per-team weekly scoring SD until enough weeks exist
DEFAULT_TALENT_SD = 6.5        # spread of true team scoring levels (points / game)
HEAVY_TAIL_PROB, HEAVY_TAIL_MULT = 0.08, 2.0
TYPICAL_RETURN = 0.35          # weekly return rate used for "typical" availability


# --------------------------------------------------------------------------- #
# helpers / HTTP
# --------------------------------------------------------------------------- #
def num(value, default=0.0):
    try:
        return default if value is None else float(value)
    except (TypeError, ValueError):
        return default


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


def _browser_get_json(url: str):
    """Used only when this script runs inside a web page (Pyodide). Browsers cannot use urlopen."""
    from pyodide.http import open_url
    return json.loads(open_url(url).read())


def get_json(url: str, timeout: int = 30, retries: int = 2):
    if sys.platform == "emscripten":
        try:
            return _browser_get_json(url)
        except Exception as exc:
            raise RuntimeError(f"Could not load {url} in the browser: {exc}")
    last = RuntimeError(f"No response from {url}")
    for attempt in range(retries + 1):
        req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        try:
            with urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except HTTPError as exc:
            last = RuntimeError(f"HTTP {exc.code} from {url}")
            if exc.code in (400, 401, 403, 404):
                break
        except (URLError, TimeoutError, OSError) as exc:
            last = RuntimeError(f"Network error requesting {url}: {exc}")
        except json.JSONDecodeError:
            last = RuntimeError(f"Invalid JSON from {url}")
            break
        time.sleep(0.7 * (attempt + 1))
    raise last


class Net:
    """Single network entry point so tests can swap in a fake Sleeper."""
    fetch = staticmethod(get_json)


def api(path: str, timeout: int = 30):
    return Net.fetch(f"{API}{path}", timeout)


# --------------------------------------------------------------------------- #
# league, standings, schedule
# --------------------------------------------------------------------------- #
def games_played(t):
    return t["wins"] + t["losses"] + t["ties"]


def roster_pf(settings):
    return num(settings.get("fpts")) + num(settings.get("fpts_decimal")) / 100.0


def name_for(user, rid):
    md = user.get("metadata") or {}
    return md.get("team_name") or user.get("display_name") or user.get("username") or f"Roster {rid}"


def parse_renames(specs):
    out = {}
    for spec in specs or []:
        if "=" not in spec:
            raise RuntimeError(f'--rename "{spec}": use "Sleeper Name=Sheet Name"')
        a, b = spec.split("=", 1)
        out[a.strip().lower()] = b.strip()
    return out


def load_league(league_id, renames=None):
    league = api(f"/league/{league_id}")
    if not league:
        raise RuntimeError(f"League {league_id} was not found or is not public.")
    rosters = api(f"/league/{league_id}/rosters") or []
    users = api(f"/league/{league_id}/users") or []
    state = api("/state/nfl") or {}
    user_map = {u.get("user_id"): u for u in users}
    teams = {}
    for r in rosters:
        rid = int(r["roster_id"])
        s = r.get("settings") or {}
        nm = name_for(user_map.get(r.get("owner_id"), {}), rid)
        nm = (renames or {}).get(nm.lower(), nm)
        teams[rid] = {
            "roster_id": rid, "name": nm,
            "wins": int(s.get("wins", 0) or 0), "losses": int(s.get("losses", 0) or 0),
            "ties": int(s.get("ties", 0) or 0), "pf": roster_pf(s),
            "players": [str(x) for x in (r.get("players") or [])],
            "reserve": {str(x) for x in (r.get("reserve") or [])},
            "taxi": {str(x) for x in (r.get("taxi") or [])},
            "weekly_scores": [],
        }
    if len(teams) < 8:
        raise RuntimeError(f"Expected at least 8 teams for a 7-team playoff; found {len(teams)}.")
    return league, state, teams


def matchup_rows(league_id, week):
    return api(f"/league/{league_id}/matchups/{week}") or []


def parse_pairs(rows, roster_ids, week):
    grouped = defaultdict(list)
    for row in rows:
        rid = int(row.get("roster_id", -1))
        if rid in roster_ids and row.get("matchup_id") is not None:
            grouped[row["matchup_id"]].append(rid)
    pairs, covered = [], set()
    for members in grouped.values():
        if len(members) == 2:
            pairs.append((members[0], members[1]))
            covered.update(members)
    if covered != set(roster_ids):
        raise RuntimeError(f"Week {week} schedule is not published yet or has a bye "
                           f"(unmatched roster ids: {sorted(set(roster_ids) - covered)}).")
    return pairs


def row_score(row):
    val = row.get("custom_points")
    if val is None:
        val = row.get("points")
    return None if val is None else num(val)


def load_history(league_id, teams, upto):
    """Weekly scores for weeks 1..upto. `upto` is the number of fully played weeks
    (the fewest games any team has played), so a week still in progress is never
    mistaken for a completed one."""
    done = []
    for week in range(1, upto + 1):
        try:
            rows = matchup_rows(league_id, week)
        except RuntimeError:
            continue
        scores = {}
        for row in rows:
            rid = int(row.get("roster_id", -1))
            if rid in teams:
                sc = row_score(row)
                if sc is not None:
                    scores[rid] = sc
        if len(scores) == len(teams) and any(v > 0 for v in scores.values()):
            done.append(week)
            for rid, sc in scores.items():
                teams[rid]["weekly_scores"].append((week, sc))
    return done


# --------------------------------------------------------------------------- #
# players, injuries, projections
# --------------------------------------------------------------------------- #
PLAYERS_AGE = {"minutes": None}


def load_players_db(cache_dir: Path, refresh=False, max_age_hours=0.5):
    """Injury statuses live in this file. Sleeper asks apps not to pull it constantly, so a
    copy younger than 30 minutes is reused; anything older is re-downloaded."""
    path = cache_dir / "players_nfl.json"
    if path.exists() and not refresh:
        age = time.time() - path.stat().st_mtime
        if age < max_age_hours * 3600:
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                PLAYERS_AGE["minutes"] = age / 60
                return data
            except (OSError, json.JSONDecodeError):
                pass
    data = Net.fetch(f"{API}/players/nfl", 120)
    PLAYERS_AGE["minutes"] = 0.0
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8")
    except OSError:
        pass
    return data


def player_positions(info):
    pos = {str(x).upper() for x in (info.get("fantasy_positions") or []) if x}
    if info.get("position"):
        pos.add(str(info["position"]).upper())
    if "D/ST" in pos:
        pos.add("DEF")
    return frozenset(pos)


def primary_position(positions):
    return next((p for p in PROJ_POSITIONS if p in positions), "WR")


def availability_profile(info, injury_scale=1.0, q_prob=0.78):
    """(P(plays first simulated week), P(returns each later week), P(new injury / week),
    weeks a player stays out before any return is allowed).
    Questionable ~78% to play, Out misses the next game (30%/wk return), IR mostly out (10%/wk)."""
    hz = BASE_HAZARD.get(primary_position(player_positions(info)), 0.04) * injury_scale
    inj = str(info.get("injury_status") or "").strip().lower()
    status = str(info.get("status") or "").strip().lower()
    if inj == "out":
        return 0.0, 0.30, hz, 0
    if inj == "ir" or "injured reserve" in status:
        return 0.0, 0.10, hz, 0
    if inj in ("pup", "nfi", "dnr", "na") or "physically" in status or "non football" in status:
        return 0.0, 0.10, hz, 0
    if inj == "sus" or "suspend" in status:
        return 0.0, 0.50, hz, 1
    if inj == "cov":
        return 0.0, 0.60, hz, 1
    if inj == "doubtful":
        return 0.10, 0.45, hz, 0
    if inj == "questionable":
        return q_prob, 0.85, hz, 0
    if status == "inactive":
        return 0.0, 0.25, hz, 1
    return 1.0 - hz, TYPICAL_RETURN, hz, 0


def projected_points(row, scoring, positions):
    """League-specific projected points from one projections-feed row."""
    stats = row.get("stats") or {}
    rec = num(scoring.get("rec"), 1.0)
    fam_key = "pts_ppr" if rec >= 0.9 else ("pts_half_ppr" if rec >= 0.4 else "pts_std")
    family = None
    for key in (fam_key, "pts_ppr", "pts_half_ppr", "pts_std"):
        if key in stats:
            family = num(stats[key])
            break
    if family is None:
        for key in (fam_key, "pts_ppr", "pts_half_ppr", "pts_std"):
            if key in row:
                family = num(row[key])
                break
    if positions & {"K", "DEF"}:          # K / DEF buckets rarely match the feed's stat keys
        return family
    calc, found = 0.0, False
    for key, weight in scoring.items():
        if key in stats and isinstance(weight, (int, float)):
            calc += num(stats[key]) * float(weight)
            found = True
    if found and (family is None or calc >= 0.75 * family):
        return calc                        # respects custom scoring (TE premium, etc.)
    return family


class ProjectionStore:
    """Fetches and disk-caches weekly projections (already in league points)."""

    def __init__(self, league_id, scoring, season, cache_dir: Path, current_week, ttl_hours=0.25):
        self.scoring, self.season, self.current_week = scoring, str(season), current_week
        self.path = cache_dir / f"projections_{league_id}.json"
        self.ttl = ttl_hours * 3600
        self.cache, self.dirty, self.errors = {}, False, []
        self.raw_sample = None
        try:
            self.cache = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self.cache = {}

    def _fetch(self, week, players_db):
        last = None
        for base in PROJ_BASES:
            params = [("season_type", "regular"), ("order_by", "ppr")]
            params += [("position[]", p) for p in PROJ_POSITIONS]
            url = f"{base}/{self.season}/{week}?{urlencode(params)}"
            try:
                data = Net.fetch(url, 60)
                if isinstance(data, dict):
                    data = list(data.values())
                if data:
                    if self.raw_sample is None:
                        self.raw_sample = data[:2]
                    out = {}
                    for row in data:
                        pid = str(row.get("player_id") or (row.get("player") or {}).get("player_id") or "")
                        if not pid:
                            continue
                        info = players_db.get(pid) or row.get("player") or {}
                        pos = player_positions(info) or player_positions(row)
                        pts = projected_points(row, self.scoring, pos)
                        if pts is not None:
                            out[pid] = round(pts, 3)
                    if out:
                        return out
            except RuntimeError as exc:
                last = exc
        raise last or RuntimeError(f"empty projection feed for week {week}")

    def week(self, week, players_db):
        key = f"{self.season}-{week}"
        entry = self.cache.get(key)
        if entry and (week < self.current_week or time.time() - entry.get("ts", 0) < self.ttl):
            return entry["pts"]
        try:
            pts = self._fetch(week, players_db)
        except RuntimeError as exc:
            self.errors.append(f"week {week}: {exc}")
            return entry["pts"] if entry else {}
        self.cache[key] = {"ts": time.time(), "pts": pts}
        self.dirty = True
        return pts

    def save(self):
        if self.dirty:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self.path.write_text(json.dumps(self.cache), encoding="utf-8")
            except OSError:
                pass


# --------------------------------------------------------------------------- #
# lineup optimiser
# --------------------------------------------------------------------------- #
def slot_set(slot):
    s = str(slot).upper()
    return SLOT_ACCEPTS.get(s, {s})


def start_slots(roster_positions):
    return [str(s).upper() for s in roster_positions if str(s).upper() not in NON_START_SLOTS]


def is_laminar(slots):
    sets = {frozenset(slot_set(s)) for s in slots}
    return all(not (a & b) or a <= b or b <= a for a, b in itertools.combinations(sets, 2))


def hungarian_min(cost):
    """Minimum-cost assignment (rows <= cols). Returns (total, column_of_row)."""
    n, m = len(cost), len(cost[0])
    INF = float("inf")
    u, v, p, way = [0.0] * (n + 1), [0.0] * (m + 1), [0] * (m + 1), [0] * (m + 1)
    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv, used = [INF] * (m + 1), [False] * (m + 1)
        while True:
            used[j0] = True
            i0, delta, j1 = p[j0], INF, 0
            for j in range(1, m + 1):
                if not used[j]:
                    cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
                    if cur < minv[j]:
                        minv[j], way[j] = cur, j0
                    if minv[j] < delta:
                        delta, j1 = minv[j], j
            for j in range(m + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while True:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
            if j0 == 0:
                break
    col_of_row = [0] * n
    for j in range(1, m + 1):
        if p[j]:
            col_of_row[p[j] - 1] = j - 1
    return -v[0], col_of_row


class Lineup:
    """Best legal lineup scorer. Candidates are (points, positions) pairs; any slot
    can also be filled by a replacement-level free agent at its eligible positions."""

    def __init__(self, slots, replacement_by_pos):
        self.slots = list(slots)
        self.sets = [slot_set(s) for s in self.slots]
        self.repl = [max([replacement_by_pos.get(p, 0.0) for p in st] or [0.0]) for st in self.sets]
        self.laminar = is_laminar(self.slots)
        self.order = sorted(range(len(self.slots)), key=lambda i: len(self.sets[i]))

    def best(self, cands):
        return self._greedy(cands) if self.laminar else self._hungarian(cands)

    def _greedy(self, cands):
        """Exact for nested slot sets (QB/RB/WR/TE/FLEX/SUPER_FLEX...): fill the most
        restrictive slot first with the best eligible player."""
        pool = sorted(cands, key=lambda c: -c[0])
        taken = [False] * len(pool)
        total = 0.0
        for i in self.order:
            st, rep = self.sets[i], self.repl[i]
            pick = -1
            for k, (pts, pos) in enumerate(pool):
                if not taken[k] and pos & st:
                    pick = k
                    break
            if pick >= 0 and pool[pick][0] >= rep:
                taken[pick] = True
                total += pool[pick][0]
            else:
                total += rep
        return total

    def _hungarian(self, cands):
        n = len(self.slots)
        cost = []
        for i in range(n):
            row = [(-pts if (pos & self.sets[i]) else 1e6) for pts, pos in cands]
            row += [-self.repl[i]] * n
            cost.append(row)
        total, _ = hungarian_min(cost)
        return -total


@dataclass
class Cand:
    pid: str
    name: str
    positions: frozenset
    nominal: float
    p0: float
    ret: float
    hz: float
    status: str
    weekly: dict = field(default_factory=dict)
    lock: int = 0
    trust: bool = False


class TeamLineup:
    """Per-team cache of lineup scores for (week index, unavailable-player bitmask)."""
    CACHE_LIMIT = 250_000

    def __init__(self, cands, lineup: Lineup, weeks):
        self.cands, self.lineup, self.weeks = cands, lineup, weeks
        self.cache = {}
        self.base = self.score(None, 0)       # everyone healthy, season-average projections
        self.typical = self.base

    def score(self, wi, mask):
        key = (wi, mask)
        hit = self.cache.get(key)
        if hit is not None:
            return hit
        w = self.weeks[wi] if wi is not None else None
        pool = []
        for i, c in enumerate(self.cands):
            if (mask >> i) & 1:
                continue
            pts = c.nominal if w is None else c.weekly.get(w, c.nominal)
            if pts is None:                    # bye week
                continue
            pool.append((pts, c.positions))
        val = self.lineup.best(pool)
        if len(self.cache) > self.CACHE_LIMIT:
            self.cache.clear()
        self.cache[key] = val
        return val

    def estimate_typical(self, rng, draws=150):
        """Average lineup score under *typical* availability. Scoring history already
        reflects normal injury luck, so weekly adjustments are measured against this,
        not against a fully healthy roster (which would double-count injuries)."""
        pa = [TYPICAL_RETURN / (c.hz + TYPICAL_RETURN) for c in self.cands]
        tot = 0.0
        for _ in range(draws):
            m = 0
            for i, p in enumerate(pa):
                if rng.random() >= p:
                    m |= 1 << i
            tot += self.score(None, m)
        self.typical = tot / draws


def nominal_map(week_feeds, hist_feeds):
    """Average projection per player (future weeks preferred) + how many weeks seen."""
    fut, allv = defaultdict(list), defaultdict(list)
    for f in week_feeds.values():
        for pid, v in f.items():
            if v > 0:
                fut[pid].append(v)
                allv[pid].append(v)
    for f in hist_feeds.values():
        for pid, v in f.items():
            if v > 0:
                allv[pid].append(v)
    nominal = {pid: (sum(fut[pid]) / len(fut[pid]) if pid in fut else sum(v) / len(v))
               for pid, v in allv.items()}
    return nominal, {pid: len(v) for pid, v in allv.items()}


def replacement_levels(nominal, rostered, players_db, fa_rank):
    """Replacement level = the Nth-best healthy, unrostered player at each position
    in this league (the real waiver wire, not a guess)."""
    pools = defaultdict(list)
    for pid, v in nominal.items():
        if pid in rostered:
            continue
        info = players_db.get(pid) or {}
        if str(info.get("injury_status") or "").strip().lower() in OUT_STATUSES:
            continue
        if str(info.get("status") or "active").strip().lower() not in ("active", ""):
            continue
        pos = player_positions(info)
        for p in PROJ_POSITIONS:
            if p in pos:
                pools[p].append(v)
    out = {}
    for p in PROJ_POSITIONS:
        lst = sorted(pools[p], reverse=True)
        fb = FALLBACK_REPLACEMENT[p]
        out[p] = clamp(lst[min(fa_rank - 1, len(lst) - 1)], 0.4 * fb, 2.2 * fb) if len(lst) >= 3 else fb
    return out


def build_team_lineups(teams, league, players_db, weeks, week_feeds, hist_feeds, args, rng):
    """Returns ({rid: TeamLineup}, replacement_levels, diagnostics)."""
    slots = start_slots(league.get("roster_positions") or [])
    diag = {"coverage": {}, "bye_weeks": 0, "injured": defaultdict(list), "repl": {}}
    if not slots:
        return {}, {}, diag
    nominal, seen = nominal_map(week_feeds, hist_feeds)
    rostered = {pid for t in teams.values() for pid in t["players"]}
    repl = replacement_levels(nominal, rostered, players_db, args.fa_rank)
    diag["repl"] = repl
    lineup = Lineup(slots, repl)
    need = defaultdict(int)
    for st in lineup.sets:
        for p in st:
            need[p] += 1
    byes = {}
    if getattr(args, "byes", None):
        byes = {str(k).upper(): int(v) for k, v in json.loads(Path(args.byes).read_text(encoding="utf-8")).items()}
    loaded = {w for w, f in week_feeds.items() if len(f) >= 150}
    returns, used_returns = {}, set()
    for spec in getattr(args, "return_", None) or []:
        try:
            nm_, wk_ = spec.rsplit(":", 1)
            returns[nm_.strip().lower()] = int(wk_)
        except ValueError:
            raise RuntimeError(f'--return "{spec}": use "Player Name:week" (the week he is healthy again)')
    lineups = {}
    for rid, team in teams.items():
        cands = []
        for pid in team["players"]:
            if pid in team["taxi"] or pid not in nominal:
                continue
            info = players_db.get(pid) or {}
            pos = player_positions(info)
            if not pos:
                continue
            if args.no_injuries:
                p0, ret, hz, lock = 1.0, 1.0, 0.0, 0
            else:
                p0, ret, hz, lock = availability_profile(info, args.injury_scale, args.questionable_prob)
            nm = info.get("full_name") or f"{info.get('first_name', '')} {info.get('last_name', '')}".strip() or pid
            st = str(info.get("injury_status") or info.get("status") or "")
            trust = False
            # The IR slot is ignored on purpose: in this league it can hold Out players and they must
            # come out when their status changes, so the slot says nothing. Status + projections decide.
            irlike = (str(info.get("injury_status") or "").strip().lower()
                      in ("ir", "pup", "nfi", "dnr", "na", "sus", "cov")
                      or "injured reserve" in str(info.get("status") or "").strip().lower())
            if getattr(args, "trust_projections", False) and not args.no_injuries:
                if irlike:                                  # projections alone decide when he plays
                    p0, ret, lock, trust = 1.0 - hz, TYPICAL_RETURN, 0, True
                elif str(info.get("injury_status") or "").strip().lower() == "out":
                    p0, ret, lock, trust = 0.0, args.out_return, 0, True   # misses next game; then 75%/wk back, points from projections
            ov = returns.get(nm.lower())
            if ov is not None:                           # manual: back from week ov onward
                used_returns.add(nm.lower())
                if ov <= weeks[0]:
                    p0, ret, lock = 1.0 - hz, TYPICAL_RETURN, 0
                else:
                    p0, ret, lock = 0.0, 1.0, ov - weeks[0]
                st = f"back wk {ov}"
            cands.append(Cand(pid, nm, pos, nominal[pid], p0, ret, hz, st, lock=lock, trust=trust and ov is None))
        diag["coverage"][rid] = (len(cands), len(team["players"]))
        if len(cands) < 4:
            continue
        keep = set()                                  # prune to players that can matter
        for p in PROJ_POSITIONS:
            pool = sorted((c for c in cands if p in c.positions), key=lambda c: -c.nominal)
            keep.update(c.pid for c in pool[: need.get(p, 0) + args.depth])
        cands = sorted((c for c in cands if c.pid in keep), key=lambda c: -c.nominal)
        for c in cands:
            abbr = str((players_db.get(c.pid) or {}).get("team") or "").upper()
            for w in weeks:
                if byes and abbr and byes.get(abbr) == w:
                    c.weekly[w] = None
                    diag["bye_weeks"] += 1
                elif w in loaded:
                    v = week_feeds[w].get(c.pid)
                    if v is None or v <= 0.0:
                        # missing from a loaded week while present in others: bye or out
                        if c.trust or (args.infer_byes and seen.get(c.pid, 0) >= 2):
                            c.weekly[w] = None
                            diag["bye_weeks"] += 1
                        else:
                            c.weekly[w] = c.nominal
                    else:
                        c.weekly[w] = v
            if c.trust:
                diag.setdefault("trusted", defaultdict(list))[rid].append(
                    (c.name, [(w, round(c.weekly.get(w) or 0.0, 1)) for w in weeks]))
            pri = primary_position(c.positions)
            if (not args.no_injuries and (c.p0 < 0.95 or c.ret < 0.9)
                    and c.status.lower() not in ("", "active") and c.nominal >= repl.get(pri, 0) + 1.5):
                diag["injured"][rid].append((c.name, c.status, round(c.nominal, 1)))
        tl = TeamLineup(cands, lineup, weeks)
        tl.estimate_typical(rng)
        lineups[rid] = tl
    missing = [k for k in returns if k not in used_returns]
    if missing:
        raise RuntimeError("--return: no rostered player matched " + ", ".join(missing)
                           + " (use the full name as Sleeper spells it, e.g. 'Davante Adams')")
    return lineups, repl, diag


# --------------------------------------------------------------------------- #
# team strength model (shrinkage)
# --------------------------------------------------------------------------- #
def weighted_stats(scores, last_week, halflife):
    ws = [0.5 ** (max(0, last_week - w) / halflife) for w, _ in scores]
    sw = sum(ws)
    mean = sum(w * s for w, (_, s) in zip(ws, scores)) / sw
    return mean, sw * sw / sum(w * w for w in ws)


def zscores(vals):
    m, s = statistics.mean(vals.values()), statistics.pstdev(vals.values())
    return {k: (v - m) / s for k, v in vals.items()} if s > 1e-9 else {}


def load_roster_csv(path, teams):
    """Two columns: Team, Roster score (header optional; tab or comma separated)."""
    text = Path(path).read_text(encoding="utf-8-sig").replace("\t", ",")
    vals, unmatched = {}, []
    for row in csv.reader(text.splitlines()):
        if len(row) < 2:
            continue
        try:
            v = float(row[1].replace(",", "").strip())
        except ValueError:
            continue
        name = row[0].strip().lower()
        hits = [r for r, t in teams.items() if t["name"].lower() == name]
        if not hits and name:
            hits = [r for r, t in teams.items() if name in t["name"].lower() or t["name"].lower() in name]
        if len(hits) == 1:
            vals[hits[0]] = v
        else:
            unmatched.append(row[0])
    if len(vals) < 6:
        raise RuntimeError(f"--roster-csv matched only {len(vals)} teams; check the team names.")
    return zscores(vals), unmatched


def build_strength_model(teams, lineups, args, roster_z=None):
    hist = {rid: t["weekly_scores"] for rid, t in teams.items()}
    all_scores = [s for h in hist.values() for _, s in h]
    last_week = max((w for h in hist.values() for w, _ in h), default=0)
    base_B = {rid: lineups[rid].base for rid in lineups}
    if all_scores:
        league_mean = statistics.mean(all_scores)
    elif base_B:
        league_mean = statistics.mean(base_B.values())
    else:
        league_mean = 115.0

    num_ss, dof = 0.0, 0                              # pooled within-team weekly SD
    for h in hist.values():
        if len(h) >= 2:
            m = statistics.mean(s for _, s in h)
            num_ss += sum((s - m) ** 2 for _, s in h)
            dof += len(h) - 1
    sigma = DEFAULT_WEEKLY_SD
    if dof >= 6:
        wf = dof / (dof + 15.0)
        sigma = math.sqrt(wf * (num_ss / dof) + (1 - wf) * DEFAULT_WEEKLY_SD ** 2)
    sigma = clamp(sigma, 14.0, 36.0)

    talent_sd = args.talent_sd                        # talent spread: method of moments
    means = {rid: statistics.mean(s for _, s in h) for rid, h in hist.items() if h}
    if len(means) >= 6:
        n_avg = statistics.mean(len(hist[r]) for r in means)
        est = max(0.0, statistics.pvariance(list(means.values())) - sigma ** 2 / n_avg)
        w = n_avg / (n_avg + 8.0)
        talent_sd = math.sqrt(w * est + (1 - w) * args.talent_sd ** 2)
    talent_sd = clamp(talent_sd, 4.0, 11.0)

    zB = zscores(base_B) if len(base_B) >= 6 else {}
    zs, used = {}, bool(zB) or bool(roster_z)
    for rid in teams:
        parts = [d[rid] for d in (zB, roster_z or {}) if rid in d]
        zs[rid] = sum(parts) / len(parts) if parts else 0.0
    rho = args.proj_trust if used else 0.0
    tau0 = talent_sd * math.sqrt(1 - rho * rho)

    mean_out, sd_out = {}, {}
    for rid in teams:
        m0 = league_mean + rho * talent_sd * zs[rid]
        h = hist[rid]
        if h:
            xbar, n_eff = weighted_stats(h, last_week, args.halflife)
            prec = 1 / tau0 ** 2 + n_eff / sigma ** 2
            mean_out[rid] = (m0 / tau0 ** 2 + n_eff * xbar / sigma ** 2) / prec
            sd_out[rid] = math.sqrt(1 / prec)
        else:
            mean_out[rid], sd_out[rid] = m0, tau0
    info = {"league_mean": league_mean, "sigma": sigma, "talent_sd": talent_sd, "rho": rho,
            "have_prior": used}
    return mean_out, sd_out, info


def build_live(rows, teams, feed, level_mean, lineups, final=False):
    """Mid-week scoring. Starters who already scored count as played (their points are
    locked in). Starters still at zero are assumed unplayed and contribute their projection.
    Returns {roster_id: (points_so_far, projected_remaining, fraction_of_week_remaining)}."""
    raw = {}
    for row in rows:
        rid = int(row.get("roster_id", -1))
        if rid not in teams:
            continue
        starters = [str(x) for x in (row.get("starters") or [])]
        sp = [num(x) for x in (row.get("starters_points") or [])]
        unplayed = [pid for pid, pt in zip(starters, sp) if pid not in ("0", "", "None") and pt == 0]
        raw[rid] = (sum(sp), unplayed, max(1, len(starters)))
    if not raw or sum(v[0] for v in raw.values()) <= 0:
        return {}
    have_feed = bool(feed) and len(feed) >= 150
    out = {}
    for rid, (played, unplayed, n) in raw.items():
        if have_feed:
            R = sum(max(0.0, feed.get(pid, 0.0)) for pid in unplayed)
        else:
            R = level_mean[rid] * len(unplayed) / n
        tl = lineups.get(rid)
        calib = clamp(level_mean[rid] / tl.typical, 0.85, 1.2) if (have_feed and tl and tl.typical > 0) else 1.0
        rem = 0.0 if final else R * calib      # final: every game is over, nothing left to add
        out[rid] = (played, rem, rem / (rem + played) if rem > 0 else 0.0)
    return out


# --------------------------------------------------------------------------- #
# seeding + simulation
# --------------------------------------------------------------------------- #
def rank_seeds(ids, records, pf, record_seeds=6, wildcard_seeds=1):
    def key(rid):
        w, l, t = records[rid]
        g = w + l + t
        return (-((w + 0.5 * t) / g if g else 0.0), -pf[rid], -w, rid)

    ranked = sorted(ids, key=key)
    rest = sorted(ranked[record_seeds:], key=lambda r: (-pf[r], r))
    return ranked[:record_seeds] + rest[:wildcard_seeds]


def simulate(teams, schedule, level_mean, level_sd, sigma, lineups, args, sims=None, rng=None, live=None):
    rng = rng or random.Random(args.seed)
    sims = sims or args.simulations
    ids = list(teams)
    weeks = sorted(schedule)
    K = len(weeks)
    n_seeds = args.record_seeds + args.wildcard_seeds
    cur = {rid: (t["wins"], t["losses"], t["ties"]) for rid, t in teams.items()}
    cur_pf = {rid: t["pf"] for rid, t in teams.items()}
    f_tail = (1 - HEAVY_TAIL_PROB) + HEAVY_TAIL_PROB * HEAVY_TAIL_MULT ** 2
    s0 = sigma / math.sqrt(f_tail)                    # keeps total weekly variance = sigma^2
    seeds = {rid: [0] * n_seeds for rid in ids}
    win_tot, pf_tot = dict.fromkeys(ids, 0.0), dict.fromkeys(ids, 0.0)
    forced = getattr(args, "forced", {}) or {}
    inj_w = args.injury_weight
    gauss, rand = rng.gauss, rng.random
    lineup_items = list(lineups.items())

    for _ in range(sims):
        level = {rid: gauss(level_mean[rid], level_sd[rid]) for rid in ids}
        adj = {rid: [0.0] * K for rid in ids}
        for rid, tl in lineup_items:
            masks = [0] * K
            for pi, c in enumerate(tl.cands):
                bit = 1 << pi
                avail = True
                for wi in range(K):
                    if wi == 0:
                        avail = rand() < c.p0
                    elif avail:
                        avail = rand() >= c.hz
                    else:
                        avail = wi >= c.lock and rand() < c.ret
                    if not avail:
                        masks[wi] |= bit
            row = adj[rid]
            for wi in range(K):
                row[wi] = inj_w * (tl.score(wi, masks[wi]) - tl.typical)
        rec = {rid: list(cur[rid]) for rid in ids}
        pf = dict(cur_pf)
        for wi, w in enumerate(weeks):
            sc = {}
            lv = live.get(w) if live else None
            for rid in ids:
                mult = HEAVY_TAIL_MULT if rand() < HEAVY_TAIL_PROB else 1.0
                if lv is not None and rid in lv:          # week in progress: locked points + what's left
                    played, rem, frac = lv[rid]
                    v = played + rem
                    if frac > 0:
                        v += (level[rid] - level_mean[rid]) * frac + gauss(0.0, s0 * mult * math.sqrt(frac))
                else:
                    v = level[rid] + adj[rid][wi] + gauss(0.0, s0 * mult)
                sc[rid] = v if v > 0 else 0.0
                pf[rid] += sc[rid]
            for a, b in schedule[w]:
                for who, other in ((a, b), (b, a)):   # what-if overrides
                    f = forced.get((who, w))
                    if f is not None and ((f and sc[who] < sc[other]) or (not f and sc[who] > sc[other])):
                        sc[who], sc[other] = sc[other], sc[who]
                        pf[who] += sc[who] - sc[other]
                        pf[other] += sc[other] - sc[who]
                if sc[a] > sc[b]:
                    rec[a][0] += 1
                    rec[b][1] += 1
                elif sc[b] > sc[a]:
                    rec[b][0] += 1
                    rec[a][1] += 1
                else:
                    rec[a][2] += 1
                    rec[b][2] += 1
        field_ = rank_seeds(ids, rec, pf, args.record_seeds, args.wildcard_seeds)
        for k, rid in enumerate(field_):
            seeds[rid][k] += 1
        for rid in ids:
            win_tot[rid] += rec[rid][0] + 0.5 * rec[rid][2]
            pf_tot[rid] += pf[rid]
    return {"seeds": seeds, "win_tot": win_tot, "pf_tot": pf_tot, "n": sims}


# --------------------------------------------------------------------------- #
# reporting
# --------------------------------------------------------------------------- #
def pct(a, b):
    return 100.0 * a / b if b else None


def build_results(teams, sim, record_seeds=6):
    n = sim["n"]
    out = []
    for rid, t in teams.items():
        s = sim["seeds"][rid]
        top6 = pct(sum(s[:record_seeds]), n)
        seed7 = pct(s[-1], n)
        missed = n - sum(s[:record_seeds])
        out.append({
            "team": t["name"], "roster_id": rid,
            "record": f"{t['wins']}-{t['losses']}" + (f"-{t['ties']}" if t["ties"] else ""),
            "pf": t["pf"], "proj_wins": sim["win_tot"][rid] / n,
            "top6": top6, "seed1": pct(s[0], n), "seed7": seed7,
            # only meaningful when a top-6 finish is not already a lock
            "seed7_if_miss": pct(s[-1], missed) if top6 < 99.5 and missed else None,
            "playoff": pct(sum(s), n),
        })
    out.sort(key=lambda r: (-r["playoff"], -r["top6"], -r["seed1"], -r["proj_wins"]))
    return out


def fp(v):
    return "--" if v is None else f"{v:.1f}%"


def table(results, detail=False):
    head = ["Rank", "Team"] + (["Record", "PF", "Proj W"] if detail else []) + [
        "Top 6 Odds", "#1 Seed Odds", "7th Seed If Not Top 6", "7th Seed Odds", "Playoff Odds"]
    rows = []
    for i, r in enumerate(results, 1):
        row = [str(i), r["team"]]
        if detail:
            row += [r["record"], f"{r['pf']:.1f}", f"{r['proj_wins']:.1f}"]
        row += [fp(r["top6"]), fp(r["seed1"]), fp(r["seed7_if_miss"]), fp(r["seed7"]), fp(r["playoff"])]
        rows.append(row)
    return head, rows


def print_table(results, detail=False):
    head, rows = table(results, detail)
    widths = [max(len(head[c]), *(len(r[c]) for r in rows)) for c in range(len(head))]
    left = {1}                                        # Team column is left-aligned
    fmt = lambda row: "  ".join(row[c].ljust(widths[c]) if c in left else row[c].rjust(widths[c])
                                for c in range(len(row)))
    print(fmt(head))
    print("-" * len(fmt(head)))
    for r in rows:
        print(fmt(r))
    n6 = sum(r["top6"] for r in results) / 100
    print(f"\nChecks: Top 6 sums to {n6:.2f} (should be 6) | #1 Seed sums to "
          f"{sum(r['seed1'] for r in results):.1f}% | 7th Seed sums to "
          f"{sum(r['seed7'] for r in results):.1f}% | Playoff Odds sums to "
          f"{sum(r['playoff'] for r in results) / 100:.2f} (should be 7)")


def write_csv(path, results, detail=False):
    head, rows = table(results, detail)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(head)
        w.writerows(rows)


def print_paste(results, detail=False):
    head, rows = table(results, detail)
    print("\n--- copy from here into Google Sheets ---")
    print("\t".join(head))
    for r in rows:
        print("\t".join(r))
    print("--- end ---")


LOG_HEAD = ["run_time", "league_id", "season", "first_sim_week", "sims", "team",
            "top6_pct", "seed1_pct", "seed7_pct", "playoff_pct", "proj_wins"]


def append_log(path, league_id, season, results, first_week, sims):
    p = Path(path)
    if p.exists():
        with open(p, newline="", encoding="utf-8") as f:
            first = next(csv.reader(f), [])
        if first != LOG_HEAD:                          # older log format: keep it, start fresh
            p.rename(p.with_suffix(".old.csv"))
    new = not p.exists()
    with open(p, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new:
            w.writerow(LOG_HEAD)
        stamp = datetime.now().isoformat(timespec="minutes")
        for r in results:
            w.writerow([stamp, league_id, season, first_week, sims, r["team"],
                        round(r["top6"], 2), round(r["seed1"], 2), round(r["seed7"], 2),
                        round(r["playoff"], 2), round(r["proj_wins"], 2)])


# --------------------------------------------------------------------------- #
# orchestration
# --------------------------------------------------------------------------- #
def parse_forced(specs, teams, weeks):
    out = {}
    for spec in specs or []:
        try:
            name, wk, res = spec.rsplit(":", 2)
            wk, res = int(wk), res.strip().upper()
            if res not in ("W", "L") or wk not in weeks:
                raise ValueError
        except ValueError:
            span = f"{weeks[0]}-{weeks[-1]}" if weeks else "none left"
            raise RuntimeError(f'--force "{spec}": use TeamName:week:W or L (weeks still to play: {span})')
        hits = [r for r, t in teams.items() if name.strip().lower() in t["name"].lower()]
        if len(hits) != 1:
            raise RuntimeError(f'--force "{spec}": team name matched {len(hits)} teams')
        out[(hits[0], wk)] = res == "W"
    return out


def plan(args, league, teams):
    settings = league.get("settings") or {}
    ps = settings.get("playoff_week_start")
    end_week = args.end_week or (int(ps) - 1 if ps else 14)
    floor = min(games_played(t) for t in teams.values())
    start_week = args.start_week or floor + 1
    return start_week, end_week, floor, settings


def run_league(args, quiet=False):
    say = (lambda *a, **k: None) if quiet else print
    cache_dir = Path(args.cache_dir)
    league, nfl_state, teams = load_league(args.league_id, parse_renames(args.rename))
    start_week, end_week, floor, settings = plan(args, league, teams)
    season = league.get("season")
    if settings.get("league_average_match"):
        say("WARNING: this league scores a win vs the weekly median; those extra games are not modelled.")
    pt = settings.get("playoff_teams")
    if pt and int(pt) != args.record_seeds + args.wildcard_seeds:
        say(f"WARNING: league playoff_teams={pt} but the model seeds {args.record_seeds}+{args.wildcard_seeds}.")
    complete = start_week > end_week
    rows_by_week, week_feeds = {}, {}
    completed = load_history(args.league_id, teams, min(floor, end_week))
    schedule = {}
    if not complete:
        ids = set(teams)
        rows_by_week = {w: matchup_rows(args.league_id, w) for w in range(start_week, end_week + 1)}
        schedule = {w: parse_pairs(rows_by_week[w], ids, w) for w in rows_by_week}
    weeks = sorted(schedule)
    args.forced = parse_forced(args.force, teams, weeks)

    say(f"\n{league.get('name', 'Sleeper league')} | season {season} | {len(teams)} teams")
    if complete:
        say(f"Regular season is complete ({floor} weeks played): showing the final playoff field.")
    else:
        say(f"Standings through week {floor} | simulating weeks {weeks[0]}-{weeks[-1]} | "
            f"{args.simulations:,} simulations")
    if args.forced:
        say("SCENARIO (what-if): " + ", ".join(
            f"{teams[r]['name']} {'wins' if v else 'loses'} week {w}" for (r, w), v in args.forced.items()))

    rng = random.Random(args.seed)
    lineups, diag = {}, {}
    if weeks and not args.no_projections:
        try:
            players_db = load_players_db(cache_dir, args.refresh_players)
            store = ProjectionStore(args.league_id, league.get("scoring_settings") or {},
                                    season, cache_dir, weeks[0])
            week_feeds = {w: store.week(w, players_db) for w in weeks}
            hist_feeds = {w: store.week(w, players_db)
                          for w in range(max(1, weeks[0] - args.proj_back), weeks[0])}
            store.save()
            age = PLAYERS_AGE["minutes"]
            say("Injury statuses: " + ("downloaded fresh from Sleeper just now" if not age
                                       else f"from a copy {age:.0f} min old (use --refresh-players to force a new download)"))
            if any({**week_feeds, **hist_feeds}.values()):
                lineups, _, diag = build_team_lineups(
                    teams, league, players_db, weeks, week_feeds, hist_feeds, args, rng)
            if not lineups:
                say("Projection feed unavailable or empty -> history-only model (injuries not modelled).")
                for e in store.errors[:3]:
                    say(f"  feed note: {e}")
        except RuntimeError as exc:
            if str(exc).startswith("--return"):
                raise                                  # user typo: fail loudly, never ignore
            say(f"Could not load players/projections ({exc}) -> history-only model.")
    roster_z = None
    if args.roster_csv:
        roster_z, unmatched = load_roster_csv(args.roster_csv, teams)
        say(f"Roster scores loaded for {len(roster_z)} teams from {args.roster_csv}"
            + (f" (no match for: {', '.join(unmatched)})" if unmatched else ""))
    level_mean, level_sd, minfo = build_strength_model(teams, lineups, args, roster_z)
    live = {}
    if weeks and not args.no_live:
        lv = build_live(rows_by_week.get(weeks[0], []), teams, week_feeds.get(weeks[0]), level_mean, lineups,
                        final=args.week_final)
        if lv:
            live = {weeks[0]: lv}
            nm = lambda r: teams[r]["name"][:16]
            say(f"LIVE: week {weeks[0]} " + ("is over (--week-final): all points scored are final." if args.week_final else
                "is in progress. Points already scored are locked in; unplayed starters use projections."))
            for a_, b_ in schedule[weeks[0]]:
                say(f"  {nm(a_):<16} {lv[a_][0]:6.1f} (+{lv[a_][1]:5.1f} left)   vs   "
                    f"{nm(b_):<16} {lv[b_][0]:6.1f} (+{lv[b_][1]:5.1f} left)")
    if weeks:
        src = "+".join(x for x, on in (("lineups", bool(lineups)), ("roster csv", bool(roster_z))) if on)
        say(f"Model: weekly SD {minfo['sigma']:.1f} | talent SD {minfo['talent_sd']:.1f} | "
            f"league avg {minfo['league_mean']:.1f} | prior: {src or 'none (history only)'}")
        if not minfo["have_prior"] and not completed:
            say("NOTE: no roster signal and no history yet, so every team starts equal. "
                "Add --roster-csv, or wait for projections/games.")
    if diag and not quiet:
        cov = diag["coverage"]
        low = [teams[r]["name"] for r, (a, b) in cov.items() if a < 10]
        say(f"Projection coverage: {sum(a for a, _ in cov.values())}/{sum(b for _, b in cov.values())} "
            f"rostered players matched" + (f" | low coverage: {', '.join(low)}" if low else "")
            + (f" | bye/no-game weeks found: {diag['bye_weeks']}" if diag["bye_weeks"] else ""))
        for rid, lst in diag.get("trusted", {}).items():
            for n, wk in lst:
                say(f"  IR by projections: {teams[rid]['name'][:18]} {n}: " + ", ".join(f"wk{w} {v:g}" for w, v in wk))
        shown = False
        for rid, lst in diag["injured"].items():
            if lst:
                if not shown:
                    say("Injury report (players who matter):")
                    shown = True
                say(f"  {teams[rid]['name'][:18]:<18} " + "; ".join(f"{n} ({s}, {p}pt)" for n, s, p in lst[:5]))

    t0 = time.time()
    sim = simulate(teams, schedule, level_mean, level_sd, minfo["sigma"], lineups, args,
                   sims=1 if complete else args.simulations, rng=rng, live=live)
    results = build_results(teams, sim, args.record_seeds)
    if not quiet:
        say(f"Simulated in {time.time() - t0:.1f}s\n")
        print_table(results, args.detail)
        write_csv(args.output, results, args.detail)
        say(f"\nCSV saved: {Path(args.output).resolve()}")
        if args.paste:
            print_paste(results, args.detail)
        if not args.no_log and not complete and not args.forced:
            append_log(args.log, args.league_id, season, results, weeks[0], args.simulations)
            say(f"Run logged to {Path(args.log).resolve()} (use --grade after the season)")
    return results, sim, minfo


# --------------------------------------------------------------------------- #
# power rankings (--power)
# --------------------------------------------------------------------------- #
def power_scores(stats, weights):
    """stats: {team_id: {"win": x|None, "pf": x|None, "roster": x|None}}; weights: (record, pf, roster).
    Each available component is z-scored across the league, weighted, then scaled (Z+2.5)/5*100.
    A component that is missing for any team is dropped and the remaining weights are renormalised."""
    comps = ("win", "pf", "roster")
    use = [(c, w) for c, w in zip(comps, weights) if w > 0 and all(v[c] is not None for v in stats.values())]
    tot = sum(w for _, w in use)
    if not use or tot <= 0:
        raise RuntimeError("No usable power-ranking inputs yet (no games played and no projections).")
    out = {rid: 0.0 for rid in stats}
    for c, w in use:
        z = zscores({rid: v[c] for rid, v in stats.items()})
        for rid in stats:
            out[rid] += (w / tot) * z.get(rid, 0.0)
    return {rid: (zz + 2.5) / 5.0 * 100.0 for rid, zz in out.items()}, [c for c, _ in use], \
           {c: w / tot for c, w in use}


def roster_strength(teams, league, db, feeds, weeks, args):
    """Roster score = average, over the next weeks, of the best legal lineup each team could field.
    Players with a zero/missing projection that week (bye, IR, out) are not available; for the
    coming game an Out player is excluded and Questionable/Doubtful players are scaled by their
    chance of playing. Holes are filled by the league's real best free agents."""
    slots = start_slots(league.get("roster_positions") or [])
    nominal, _ = nominal_map({w: f for w, f in feeds.items()}, {})
    rostered = {pid for t in teams.values() for pid in t["players"]}
    repl = replacement_levels(nominal, rostered, db, args.fa_rank)
    lineup = Lineup(slots, repl)
    loaded = [w for w in weeks if len(feeds.get(w, {})) >= 150]
    if not loaded:
        return {}
    result = {}
    for rid, t in teams.items():
        vals = []
        for w in loaded:
            pool = []
            for pid in t["players"]:
                if pid in t["taxi"]:
                    continue
                v = feeds[w].get(pid)
                if v is None or v <= 0:
                    continue
                info = db.get(pid) or {}
                pos = player_positions(info)
                if not pos:
                    continue
                if w == weeks[0]:
                    st = str(info.get("injury_status") or "").strip().lower()
                    if st == "out":
                        continue
                    if st == "questionable":
                        v *= args.questionable_prob
                    elif st == "doubtful":
                        v *= 0.10
                pool.append((v, pos))
            if pool:
                vals.append(lineup.best(pool))
        if vals:
            result[rid] = sum(vals) / len(vals)
    return result if len(result) == len(teams) else {}


def power_movement(path, season, week, ranks):
    """Compare with the most recent earlier week saved in the log."""
    prev = {}
    p = Path(path)
    if p.exists():
        with open(p, newline="", encoding="utf-8") as f:
            rows = [r for r in csv.DictReader(f) if r.get("season") == str(season)]
        earlier = sorted({int(r["week"]) for r in rows if int(r["week"]) < week})
        if earlier:
            prev = {r["team"]: int(r["rank"]) for r in rows if int(r["week"]) == earlier[-1]}
    return {team: (prev[team] - rk if team in prev else None) for team, rk in ranks.items()}


def power_log_write(path, season, week, rows):
    p = Path(path)
    keep = []
    if p.exists():
        with open(p, newline="", encoding="utf-8") as f:
            keep = [r for r in csv.DictReader(f)
                    if not (r.get("season") == str(season) and r.get("week") == str(week))]
    with open(p, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["season", "week", "team", "rank", "score"])
        for r in keep:
            w.writerow([r["season"], r["week"], r["team"], r["rank"], r["score"]])
        for team, rk, sc in rows:
            w.writerow([season, week, team, rk, f"{sc:.2f}"])


def power_rankings(args):
    try:
        wts = tuple(float(x) for x in args.power_weights.split(","))
        assert len(wts) == 3 and all(x >= 0 for x in wts) and sum(wts) > 0
    except (ValueError, AssertionError):
        raise RuntimeError('--power-weights: use three numbers like "50,30,20" (record, points for, roster)')
    cache_dir = Path(args.cache_dir)
    league, _, teams = load_league(args.league_id, parse_renames(args.rename))
    start_week, end_week, floor, _ = plan(args, league, teams)
    season = league.get("season")
    if start_week <= end_week:
        weeks = list(range(start_week, min(end_week, start_week + args.power_weeks - 1) + 1))
    else:
        weeks = [end_week]
    stats = {rid: {"win": None, "pf": None, "roster": None} for rid in teams}
    for rid, t in teams.items():
        g = games_played(t)
        if g:
            stats[rid]["win"] = (t["wins"] + 0.5 * t["ties"]) / g
            stats[rid]["pf"] = t["pf"] / g
    notes = []
    roster = {}
    try:
        db = load_players_db(cache_dir, args.refresh_players)
        store = ProjectionStore(args.league_id, league.get("scoring_settings") or {}, season, cache_dir, weeks[0])
        feeds = {w: store.week(w, db) for w in weeks}
        store.save()
        roster = roster_strength(teams, league, db, feeds, weeks, args)
    except RuntimeError as exc:
        notes.append(f"Could not load projections ({exc}).")
    if roster:
        for rid in teams:
            stats[rid]["roster"] = roster[rid]
    else:
        notes.append("Roster score unavailable, so its weight was spread across record and points for.")
    scores, used, eff = power_scores(stats, wts)
    order = sorted(teams, key=lambda r: (-scores[r], teams[r]["name"].lower()))
    ranks = {teams[r]["name"]: i for i, r in enumerate(order, 1)}
    move = power_movement(args.power_log, season, floor, ranks)
    print(f"\n{league.get('name', 'Sleeper league')} | power rankings through week {floor} | weights "
          + " / ".join(f"{c} {eff[c] * 100:.0f}%" for c in used))
    for n in notes:
        print("NOTE:", n)
    head = ["Rank", "Move", "Team", "Record", "PF", "Roster Pts", "Power Score"]
    rows = []
    for i, rid in enumerate(order, 1):
        t = teams[rid]
        mv = move[t["name"]]
        mv_txt = "new" if mv is None else ("-" if mv == 0 else (f"+{mv}" if mv > 0 else str(mv)))
        rec = f"{t['wins']}-{t['losses']}" + (f"-{t['ties']}" if t["ties"] else "")
        rows.append([str(i), mv_txt, t["name"], rec, f"{t['pf']:.1f}",
                     f"{roster[rid]:.1f}" if roster else "--", f"{scores[rid]:.1f}"])
    widths = [max(len(head[c]), *(len(r[c]) for r in rows)) for c in range(len(head))]
    line = lambda r: "  ".join(r[c].ljust(widths[c]) if c == 2 else r[c].rjust(widths[c]) for c in range(len(r)))
    print(line(head))
    print("-" * len(line(head)))
    for r in rows:
        print(line(r))
    with open(args.power_output, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(head)
        w.writerows(rows)
    print(f"\nCSV saved: {Path(args.power_output).resolve()}")
    if not args.no_log:
        power_log_write(args.power_log, season, floor,
                        [(teams[r]["name"], i, scores[r]) for i, r in enumerate(order, 1)])
        print(f"Saved to {Path(args.power_log).resolve()} (next week's run shows movement vs this one)")
    return rows


# --------------------------------------------------------------------------- #
# diagnose / grade
# --------------------------------------------------------------------------- #
def diagnose(args):
    ok = lambda m: print(f"  [OK]    {m}")
    bad = lambda m: print(f"  [FAIL]  {m}")
    warn = lambda m: print(f"  [WARN]  {m}")
    cache_dir = Path(args.cache_dir)
    print(f"Diagnosing league {args.league_id}\n")
    try:
        league, state, teams = load_league(args.league_id, parse_renames(args.rename))
    except RuntimeError as exc:
        bad(f"league/rosters/users: {exc}")
        return
    ok(f"league '{league.get('name')}' season {league.get('season')} | NFL state week {state.get('week')}")
    ok(f"{len(teams)} teams: " + ", ".join(t["name"] for t in teams.values()))
    start_week, end_week, floor, settings = plan(args, league, teams)
    ok(f"standings: min games played {floor}; regular season ends week {end_week}; "
       f"playoff_teams={settings.get('playoff_teams')} playoff_week_start={settings.get('playoff_week_start')}")
    slots = start_slots(league.get("roster_positions") or [])
    ok(f"starting slots ({len(slots)}): {slots}" if slots else "no roster_positions")
    if settings.get("league_average_match"):
        warn("league uses median scoring; not modelled")
    done = load_history(args.league_id, teams, min(floor, end_week))
    (ok if len(done) == min(floor, end_week) else warn)(
        f"weekly scores found for weeks {done or 'none'} (expected 1-{min(floor, end_week)})")
    if start_week <= end_week:
        try:
            parse_pairs(matchup_rows(args.league_id, start_week), set(teams), start_week)
            ok(f"schedule for week {start_week} is published (6 matchups)")
            rest = 0
            for w in range(start_week, end_week + 1):
                parse_pairs(matchup_rows(args.league_id, w), set(teams), w)
                rest += 1
            ok(f"all {rest} remaining weeks have a complete schedule")
        except RuntimeError as exc:
            bad(str(exc))
    else:
        ok("regular season is complete; script will show the final field")
    try:
        db = load_players_db(cache_dir, args.refresh_players)
        ok(f"players database loaded ({len(db):,} players)")
    except RuntimeError as exc:
        bad(f"players database: {exc}")
        return
    wk = min(max(start_week, 1), end_week)
    store = ProjectionStore(args.league_id, league.get("scoring_settings") or {}, league.get("season"),
                            cache_dir, wk)
    try:
        feed = store._fetch(wk, db)
        ok(f"projections feed week {wk}: {len(feed)} players parsed")
        rostered = {p for t in teams.values() for p in t["players"]}
        hit = sum(1 for p in rostered if p in feed)
        (ok if hit >= 0.8 * len(rostered) else warn)(
            f"{hit}/{len(rostered)} rostered players have projections")
        if store.raw_sample:
            cache_dir.mkdir(parents=True, exist_ok=True)
            sp = cache_dir / "feed_sample.json"
            sp.write_text(json.dumps(store.raw_sample, indent=1), encoding="utf-8")
            print(f"          first raw feed rows saved to {sp} (send this if projections look wrong)")
        nominal, _ = nominal_map({wk: feed}, {})
        repl = replacement_levels(nominal, rostered, db, args.fa_rank)
        ok("replacement level from the real waiver wire: " + ", ".join(f"{k} {v:.1f}" for k, v in repl.items()))
        sample = sorted(feed.items(), key=lambda kv: -kv[1])[:3]
        print("          top projections: " + "; ".join(
            f"{(db.get(p) or {}).get('full_name', p)} {v:.1f}" for p, v in sample))
    except RuntimeError as exc:
        bad(f"projections feed: {exc}  -> script will run history-only (injuries/lineups off)")
    print("\nDone. [FAIL] lines explain anything the script cannot do on your network.")


def grade_rows(log_rows, outcome):
    """log_rows: dicts with first_sim_week, team, playoff_pct. outcome: {team: 0/1}."""
    by_run = defaultdict(list)
    pooled = []
    for r in log_rows:
        if r["team"] in outcome:
            p = float(r["playoff_pct"]) / 100.0
            by_run[int(r["first_sim_week"])].append((p, outcome[r["team"]]))
            pooled.append((p, outcome[r["team"]]))
    if not pooled:
        raise RuntimeError("No logged rows match this league/season.")
    brier = lambda xs: sum((p - y) ** 2 for p, y in xs) / len(xs)
    runs = [(wk, brier(v), brier([(7 / 12, y) for _, y in v])) for wk, v in sorted(by_run.items())]
    bins = [(0, .05), (.05, .2), (.2, .4), (.4, .6), (.6, .8), (.8, .95), (.95, 1.0001)]
    rel = []
    for lo, hi in bins:
        sel = [(p, y) for p, y in pooled if lo <= p < hi]
        if sel:
            rel.append((lo, min(hi, 1.0), len(sel), sum(p for p, _ in sel) / len(sel),
                        sum(y for _, y in sel) / len(sel)))
    return runs, rel, brier(pooled)


def grade(args):
    league, _, teams = load_league(args.league_id, parse_renames(args.rename))
    start_week, end_week, floor, _ = plan(args, league, teams)
    if start_week <= end_week:
        raise RuntimeError(f"Season not finished (week {floor} of {end_week} played). Run --grade after the final game.")
    ids = list(teams)
    rec = {r: [teams[r]["wins"], teams[r]["losses"], teams[r]["ties"]] for r in ids}
    field_ = set(rank_seeds(ids, rec, {r: teams[r]["pf"] for r in ids}, args.record_seeds, args.wildcard_seeds))
    outcome = {teams[r]["name"]: int(r in field_) for r in ids}
    with open(args.log, newline="", encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f)
                if r.get("league_id") == str(args.league_id) and str(r.get("season")) == str(league.get("season"))]
    runs, rel, overall = grade_rows(rows, outcome)
    print(f"Final field: {', '.join(sorted(n for n, v in outcome.items() if v))}\n")
    print("Run (first simulated week) | Brier (model) | Brier (guess 58% for all)")
    for wk, b, nb in runs:
        print(f"  week {wk:<2}                  | {b:.4f}        | {nb:.4f}")
    print(f"\nOverall Brier {overall:.4f}  (lower is better; 0.2431 = no skill)\n")
    print("Calibration: predicted bin -> average predicted / actual rate (n)")
    for lo, hi, n, p, y in rel:
        print(f"  {lo:.2f}-{hi:.2f}: {p:.3f} / {y:.3f} ({n})")
    print("\nOne season is only 12 teams per run, so treat gaps as hints, not proof.")


# --------------------------------------------------------------------------- #
# synthetic world: backtest + offline demo league
# --------------------------------------------------------------------------- #
def _synthetic_season(rng, talent_sd=6.0, sigma=25.0, rho=0.5, mean=127.0):
    talent = [rng.gauss(0, talent_sd) for _ in range(12)]
    z = [rho * t / talent_sd + math.sqrt(1 - rho * rho) * rng.gauss(0, 1) for t in talent]
    sched, scores = {}, {}
    for w in range(1, 15):
        order = list(range(12))
        rng.shuffle(order)
        sched[w] = [(order[i], order[i + 1]) for i in range(0, 12, 2)]
        scores[w] = {i: max(0.0, mean + talent[i] + rng.gauss(0, sigma)) for i in range(12)}
    return z, sched, scores


def _record_after(sched, scores, g):
    rec = {i: [0, 0, 0] for i in range(12)}
    pf = dict.fromkeys(range(12), 0.0)
    for w in range(1, g + 1):
        for a, b in sched[w]:
            rec[a if scores[w][a] > scores[w][b] else b][0] += 1
            rec[b if scores[w][a] > scores[w][b] else a][1] += 1
        for i in range(12):
            pf[i] += scores[w][i]
    return rec, pf


def _backtest(args):
    """Calibration check on synthetic seasons that match the model's assumptions.
    It proves the code is calibrated; it cannot prove your real league behaves this way."""
    rng = random.Random(args.seed)
    a = parse_args(["--simulations", str(args.backtest_sims), "--seed", "1"])
    checkpoints = (2, 4, 6, 8, 10, 12)
    pairs = {g: [] for g in checkpoints}
    t0 = time.time()
    for s in range(args.backtest_seasons):
        z, sched, scores = _synthetic_season(rng)
        rec, pf = _record_after(sched, scores, 14)
        final = set(rank_seeds(list(range(12)), rec, pf))
        for g in checkpoints:
            rec_g, pf_g = _record_after(sched, scores, g)
            teams = {i: {"wins": rec_g[i][0], "losses": rec_g[i][1], "ties": 0, "pf": pf_g[i],
                         "name": str(i), "weekly_scores": [(w, scores[w][i]) for w in range(1, g + 1)]}
                     for i in range(12)}
            lineups = {}
            lu = Lineup(["QB"], {"QB": 0.0})
            for i in range(12):
                c = Cand(str(i), str(i), frozenset({"QB"}), 110.0 + 6.0 * z[i], 1.0, 1.0, 0.0, "")
                lineups[i] = TeamLineup([c], lu, list(range(g + 1, 15)))
            lm, ls, info = build_strength_model(teams, lineups, a)
            sim = simulate(teams, {w: sched[w] for w in range(g + 1, 15)}, lm, ls, info["sigma"], lineups, a,
                           rng=random.Random(s * 100 + g))
            for i in range(12):
                p = sum(sim["seeds"][i]) / sim["n"]
                pairs[g].append((p, int(i in final)))
    print(f"Backtest: {args.backtest_seasons} synthetic seasons x {len(checkpoints)} checkpoints "
          f"({time.time() - t0:.0f}s)\nweek | Brier model | Brier flat 58%")
    for g in checkpoints:
        b = sum((p - y) ** 2 for p, y in pairs[g]) / len(pairs[g])
        nb = sum((7 / 12 - y) ** 2 for _, y in pairs[g]) / len(pairs[g])
        print(f" {g:<3} | {b:.4f}      | {nb:.4f}")
    pooled = [x for g in (4, 6, 8, 10, 12) for x in pairs[g]]
    print("\nCalibration (weeks 4-12): predicted bin -> avg predicted / actual (n)")
    for lo, hi in [(0, .03), (.03, .1), (.1, .25), (.25, .5), (.5, .75), (.75, .9), (.9, .97), (.97, 1.0001)]:
        sel = [(p, y) for p, y in pooled if lo <= p < hi]
        if len(sel) >= 15:
            print(f"  {lo:.2f}-{min(hi, 1):.2f}: {sum(p for p, _ in sel) / len(sel):.3f} / "
                  f"{sum(y for _, y in sel) / len(sel):.3f} ({len(sel)})")


def _fake_api_factory(seed=11, weeks_played=10, live=False):
    """Sleeper-shaped fake league: 12 teams, byes, free agents, injuries."""
    rng = random.Random(seed)
    names = ["McGukin", "Garrett", "Fed", "Camran", "Miller", "Overstreet", "Oliver", "Spencer",
             "Grant", "Riley", "Keafen", "Fearn"]
    skill = [9, 7, 2, 2, 4, 0, -1, -3, -5, -5, -6, -5]
    layout = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN"]
    nfl = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"]
    bye = {t: 5 + i for i, t in enumerate(nfl)}
    base_pts = {"QB": 19, "RB": 13, "WR": 13, "TE": 9, "K": 8, "DEF": 8}
    players, rosters, n = {}, [], 100

    def make(pos, pts, label):
        nonlocal n
        n += 1
        players[str(n)] = {"fantasy_positions": [pos], "position": pos, "team": rng.choice(nfl),
                           "full_name": f"{label}-{pos}{n}", "status": "Active",
                           "injury_status": None, "_pts": max(2.0, pts)}
        return str(n)

    for t in range(12):
        pids = []
        for pos, cnt in (("QB", 2), ("RB", 5), ("WR", 5), ("TE", 2), ("K", 1), ("DEF", 1)):
            for _ in range(cnt):
                pids.append(make(pos, base_pts[pos] + skill[t] * 0.25 + rng.uniform(-4, 4), names[t][:3]))
        rosters.append({"roster_id": t + 1, "owner_id": f"u{t}", "players": pids, "starters": [],
                        "reserve": [], "taxi": [], "settings": {}})
    for pos, cnt in (("QB", 8), ("RB", 14), ("WR", 14), ("TE", 8), ("K", 6), ("DEF", 6)):   # free agents
        for _ in range(cnt):
            make(pos, base_pts[pos] * 0.55 + rng.uniform(-2, 3), "FA")
    star = max(rosters[0]["players"], key=lambda p: players[p]["_pts"])
    players[star].update(injury_status="Out", full_name="McGukin-STAR")
    q = max(rosters[4]["players"], key=lambda p: players[p]["_pts"])
    players[q].update(injury_status="Questionable")

    ids = list(range(1, 13))
    sched, wins, pf, scores = {}, dict.fromkeys(ids, 0), dict.fromkeys(ids, 0.0), {}
    for w in range(1, 15):
        order = ids[:]
        rng.shuffle(order)
        sched[w] = [(order[i], order[i + 1]) for i in range(0, 12, 2)]
    for w in range(1, weeks_played + 1):
        sc = {i: max(60, 127 + skill[i - 1] + rng.gauss(0, 24)) for i in ids}
        scores[w] = sc
        for a, b in sched[w]:
            wins[a if sc[a] > sc[b] else b] += 1
        for i in ids:
            pf[i] += sc[i]
    for r in rosters:
        i = r["roster_id"]
        r["settings"] = {"wins": wins[i], "losses": weeks_played - wins[i], "ties": 0,
                         "fpts": int(pf[i]), "fpts_decimal": int((pf[i] % 1) * 100)}
    league = {"name": "Old Balls (demo)", "season": "2026", "roster_positions": layout,
              "scoring_settings": {"rec": 1.0}, "settings": {"playoff_week_start": 15, "playoff_teams": 7}}
    users = [{"user_id": f"u{t}", "display_name": names[t]} for t in range(12)]

    livecache = {}

    def live_row(r, mid):
        if r not in livecache:
            st = rosters[r - 1]["players"][:10]
            pts = [round(players[x]["_pts"] * rng.uniform(0.6, 1.6), 1) if i < 4 else 0.0 for i, x in enumerate(st)]
            livecache[r] = {"roster_id": r, "matchup_id": mid, "starters": st, "starters_points": pts,
                            "points": round(sum(pts), 2)}
        return livecache[r]

    def matchups(w):
        if live and w == weeks_played + 1:
            return [live_row(r, mid) for mid, (a, b) in enumerate(sched[w], 1) for r in (a, b)]
        return [{"roster_id": r, "matchup_id": mid, "points": scores[w][r] if w in scores else 0.0}
                for mid, (a, b) in enumerate(sched[w], 1) for r in (a, b)]

    def feed(w):
        rows = []
        for pid, info in players.items():
            if bye.get(info["team"]) == w or info.get("injury_status") == "Out" and w < 13:
                continue
            rows.append({"player_id": pid, "stats": {"pts_ppr": round(info["_pts"] + rng.uniform(-1.5, 1.5), 2)}})
        return rows

    def fetch(url, timeout=30):
        if url.endswith("/state/nfl"):
            return {"week": min(weeks_played + 1, 18), "season": "2026"}
        if "/projections/nfl/" in url:
            return feed(int(url.split("/nfl/2026/")[1].split("?")[0]))
        if url.endswith("/players/nfl"):
            return players
        if url.endswith("/rosters"):
            return rosters
        if url.endswith("/users"):
            return users
        if "/matchups/" in url:
            return matchups(int(url.rsplit("/", 1)[1]))
        if "/league/" in url:
            return league
        raise RuntimeError(f"fake api: unknown url {url}")

    return fetch


def _use_demo(args):
    Net.fetch = _fake_api_factory(weeks_played=args.demo_weeks, live=args.demo_live)
    args.league_id = "demo"
    args.cache_dir = ".sleeper_demo_cache"
    args.output = "demo_odds.csv"
    args.log = "demo_log.csv"
    args.power_output = "demo_power.csv"
    args.power_log = "demo_power_log.csv"


# --------------------------------------------------------------------------- #
# self test
# --------------------------------------------------------------------------- #
def _selftest():
    rng = random.Random(7)
    for _ in range(300):                               # assignment solver vs brute force
        n, m = rng.randint(1, 4), rng.randint(4, 6)
        cost = [[rng.randint(0, 20) for _ in range(m)] for _ in range(n)]
        best = min(sum(cost[i][c[i]] for i in range(n)) for c in itertools.permutations(range(m), n))
        assert abs(hungarian_min(cost)[0] - best) < 1e-9
    repl = {"QB": 10, "RB": 6, "WR": 6, "TE": 4, "K": 5, "DEF": 5}
    for layout in (["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "SUPER_FLEX", "K", "DEF", "BN"],
                   ["QB", "RB", "WR", "WR", "TE", "REC_FLEX", "WRRB_FLEX", "K", "DEF"]):
        lu = Lineup(start_slots(layout), repl)
        for _ in range(400):
            cands = [(rng.uniform(1, 30), frozenset({rng.choice(["QB", "RB", "RB", "WR", "WR", "TE", "K", "DEF"])}))
                     for _ in range(rng.randint(8, 22))]
            h = lu._hungarian(cands)
            if lu.laminar:
                assert abs(lu._greedy(cands) - h) < 1e-6
            assert abs(lu.best(cands) - h) < 1e-6
    recs = {1: [9, 1, 0], 2: [9, 1, 0], 3: [8, 2, 0], 4: [7, 3, 0], 5: [6, 4, 0], 6: [6, 4, 0],
            7: [6, 4, 0], 8: [3, 7, 0], 9: [2, 8, 0], 10: [1, 9, 0]}
    pf = {i: 1000 + i for i in recs}
    pf[9] = 5000
    sd = rank_seeds(list(recs), recs, pf)
    assert sd[:2] == [2, 1] and sd[-1] == 9 and len(sd) == 7, sd

    class A:
        simulations = 6000; seed = 1; record_seeds = 6; wildcard_seeds = 1; injury_weight = 1.0
    teams = {i: {"wins": 0, "losses": 0, "ties": 0, "pf": 0.0, "name": f"T{i}", "weekly_scores": []}
             for i in range(1, 13)}
    sched = {w: [(i, i + 1) for i in range(1, 12, 2)] for w in range(1, 4)}
    sim = simulate(teams, sched, {i: 110.0 for i in teams}, {i: 0.0 for i in teams}, 24.0, {}, A())
    res = build_results(teams, sim)
    assert abs(sum(r["playoff"] for r in res) - 700) < 1e-6
    assert abs(sum(r["top6"] for r in res) - 600) < 1e-6 and abs(sum(r["seed1"] for r in res) - 100) < 1e-6
    assert abs(sum(r["seed7"] for r in res) - 100) < 1e-6
    assert all(abs(r["playoff"] - 700 / 12) < 3 for r in res)
    for r in res:
        assert abs(r["playoff"] - (r["top6"] + r["seed7"])) < 1e-9
    head, rows = table(res)
    assert head == ["Rank", "Team", "Top 6 Odds", "#1 Seed Odds", "7th Seed If Not Top 6",
                    "7th Seed Odds", "Playoff Odds"] and head[-1] == "Playoff Odds" and len(rows) == 12
    assert [int(r[0]) for r in rows] == list(range(1, 13))
    # season complete: one deterministic pass -> exactly 7 teams at 100%
    t2 = {i: {"wins": 14 - i, "losses": i, "ties": 0, "pf": 1500.0 - i, "name": f"T{i}", "weekly_scores": []}
          for i in range(1, 13)}
    t2[12]["pf"] = 9999.0
    r2 = build_results(t2, simulate(t2, {}, {i: 0.0 for i in t2}, {i: 0.0 for i in t2}, 24.0, {}, A(), sims=1))
    assert sorted(r["team"] for r in r2 if r["playoff"] == 100.0) == sorted(["T1", "T2", "T3", "T4", "T5", "T6", "T12"])
    assert [r["team"] for r in r2 if r["seed1"] == 100.0] == ["T1"]
    # live week: finished games are locked in (no unplayed starters left => deterministic winner)
    tl = {i: {"wins": 0, "losses": 0, "ties": 0, "pf": 0.0, "name": f"T{i}", "weekly_scores": []} for i in range(1, 13)}
    sch = {1: [(i, i + 1) for i in range(1, 12, 2)]}
    lv = {i: ((150.0 if i % 2 else 90.0), 0.0, 0.0) for i in tl}
    sl = simulate(tl, sch, {i: 110.0 for i in tl}, {i: 30.0 for i in tl}, 24.0, {}, A(), sims=300, live={1: lv})
    assert all(sl["win_tot"][i] == (300 if i % 2 else 0) for i in tl)
    rows = [{"roster_id": 1, "starters": ["a", "b", "c"], "starters_points": [20.0, 0.0, 0.0]},
            {"roster_id": 2, "starters": ["a", "b"], "starters_points": [0.0, 0.0]}]
    assert build_live(rows, {1: {}, 2: {}}, None, {1: 100.0, 2: 100.0}, {})[1][0] == 20.0
    assert build_live([rows[1]], {2: {}}, None, {2: 100.0}, {}) == {}
    assert build_live(rows, {1: {}, 2: {}}, None, {1: 100.0, 2: 100.0}, {}, final=True)[1] == (20.0, 0.0, 0.0)
    # power rankings: weights, scaling, dropped component
    st = {1: {"win": 0.9, "pf": 140.0, "roster": 130.0}, 2: {"win": 0.5, "pf": 125.0, "roster": 125.0},
          3: {"win": 0.1, "pf": 110.0, "roster": 120.0}}
    sc, used, eff = power_scores(st, (50, 30, 20))
    assert used == ["win", "pf", "roster"] and abs(sum(eff.values()) - 1) < 1e-9
    assert sc[1] > sc[2] > sc[3] and abs((sc[1] + sc[2] + sc[3]) / 3 - 50.0) < 1e-6
    st[2]["roster"] = None
    sc2, used2, eff2 = power_scores(st, (50, 30, 20))
    assert used2 == ["win", "pf"] and abs(eff2["win"] - 0.625) < 1e-9
    # grading maths
    runs, rel, overall = grade_rows([{"first_sim_week": 5, "team": "a", "playoff_pct": 90},
                                     {"first_sim_week": 5, "team": "b", "playoff_pct": 10}], {"a": 1, "b": 0})
    assert abs(overall - 0.01) < 1e-9 and runs[0][0] == 5
    # availability + free agent replacement
    assert availability_profile({"injury_status": "Out", "fantasy_positions": ["RB"]})[0] == 0.0
    assert availability_profile({"fantasy_positions": ["QB"]})[0] > 0.97
    assert availability_profile({"injury_status": "Questionable", "fantasy_positions": ["WR"]})[0] == 0.78
    db = {str(i): {"fantasy_positions": ["RB"], "status": "Active"} for i in range(10)}
    db["9"]["injury_status"] = "Out"
    nom = {str(i): float(20 - i) for i in range(10)}
    assert replacement_levels(nom, {"0", "1"}, db, 3)["RB"] == 20 - 4     # skips rostered + injured
    print("selftest passed: solver, seeding, output layout and sums, complete-season path, grading, FA replacement")


# --------------------------------------------------------------------------- #
def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Old Balls playoff odds (Sleeper Monte Carlo v4)")
    p.add_argument("--league-id", default=DEFAULT_LEAGUE_ID)
    p.add_argument("--simulations", type=int, default=10000)
    p.add_argument("--seed", type=int, default=20261118)
    p.add_argument("--start-week", type=int)
    p.add_argument("--end-week", type=int)
    p.add_argument("--record-seeds", type=int, default=6)
    p.add_argument("--wildcard-seeds", type=int, default=1)
    p.add_argument("--no-projections", action="store_true", help="scoring history only")
    p.add_argument("--no-injuries", action="store_true")
    p.add_argument("--injury-scale", type=float, default=1.0, help="scale new-injury hazards (0 = none)")
    p.add_argument("--questionable-prob", type=float, default=0.78,
                   help="chance a Questionable player plays (default 0.78; 1.0 = always plays)")
    p.add_argument("--return", dest="return_", action="append", default=[],
                   help='player back from a week, e.g. "Davante Adams:12" (repeatable)')
    p.add_argument("--power", action="store_true", help="power rankings instead of playoff odds")
    p.add_argument("--power-weights", default="50,30,20", help="record,points-for,roster (default 50,30,20)")
    p.add_argument("--power-weeks", type=int, default=4, help="roster score looks this many weeks ahead")
    p.add_argument("--power-output", default="old_balls_power_rankings.csv")
    p.add_argument("--power-log", default="power_rankings_log.csv")
    p.add_argument("--week-final", action="store_true",
                   help="use after Monday night: the current week is over, treat every point scored as final")
    p.add_argument("--no-live", action="store_true", help="ignore points scored in the current, unfinished week")
    p.add_argument("--demo-live", action="store_true", help="demo: next week is partly played")
    p.add_argument("--out-return", type=float, default=0.75,
                   help="weekly chance an Out player returns after missing the next game (default 0.75)")
    p.add_argument("--trust-projections", action=argparse.BooleanOptionalAction, default=True,
                   help="(default on) IR/PUP/suspended players follow weekly projections; Out players miss "
                        "the next game, then follow projections. Use --no-trust-projections for the old percentage rules")
    p.add_argument("--injury-weight", type=float, default=1.0, help="how fully lineup changes move scores")
    p.add_argument("--proj-trust", type=float, default=0.3, help="0-1: weight of the roster prior")
    p.add_argument("--talent-sd", type=float, default=DEFAULT_TALENT_SD)
    p.add_argument("--halflife", type=float, default=8.0, help="recency half-life (weeks) of scoring history")
    p.add_argument("--depth", type=int, default=2, help="extra bench depth kept per position")
    p.add_argument("--fa-rank", type=int, default=3, help="replacement level = Nth best free agent")
    p.add_argument("--proj-back", type=int, default=12, help="past weeks of projections used for baselines")
    p.add_argument("--no-infer-byes", dest="infer_byes", action="store_false")
    p.add_argument("--byes", help='optional JSON of NFL bye weeks, e.g. {"KC": 10, "PHI": 9}')
    p.add_argument("--force", action="append", default=[], help='what-if "Oliver:11:L" (W or L), repeatable')
    p.add_argument("--rename", action="append", default=[], help='"Sleeper Name=Sheet Name", repeatable')
    p.add_argument("--roster-csv", help="CSV/TSV of Team,Roster score (same numbers as your sheet)")
    p.add_argument("--refresh-players", action="store_true")
    p.add_argument("--cache-dir", default=".sleeper_cache")
    p.add_argument("--output", default="old_balls_playoff_odds.csv")
    p.add_argument("--log", default="playoff_odds_log.csv")
    p.add_argument("--no-log", action="store_true")
    p.add_argument("--detail", action="store_true", help="add Record, PF, Proj W columns before the odds")
    p.add_argument("--paste", action="store_true", help="also print a tab-separated block for Google Sheets")
    p.add_argument("--diagnose", action="store_true", help="check every API piece and exit")
    p.add_argument("--grade", action="store_true", help="after the season: score the log against results")
    p.add_argument("--backtest", action="store_true", help="calibration check on synthetic seasons")
    p.add_argument("--backtest-seasons", type=int, default=60)
    p.add_argument("--backtest-sims", type=int, default=1500)
    p.add_argument("--demo", action="store_true", help="offline fake league")
    p.add_argument("--demo-weeks", type=int, default=10, help="weeks already played in the demo (0-14)")
    p.add_argument("--selftest", action="store_true")
    a = p.parse_args(argv)
    if a.simulations < 1:
        p.error("--simulations must be positive")
    if not 0 <= a.demo_weeks <= 14:
        p.error("--demo-weeks must be 0-14")
    return a


def main(argv=None):
    args = parse_args(argv)
    if args.selftest:
        return _selftest()
    if args.backtest:
        return _backtest(args)
    if args.demo:
        _use_demo(args)
        args.no_log = True
    if args.power:
        return power_rankings(args)
    if args.diagnose:
        return diagnose(args)
    if args.grade:
        return grade(args)
    run_league(args)



# --------------------------------------------------------------------------- #
# web page entry point (used by the Playoff Odds page; harmless when run normally)
# --------------------------------------------------------------------------- #
def run_web(league_id, simulations=5000, questionable_prob=0.78, record_seeds=6, wildcard_seeds=1,
            demo=False, seed=20261127):
    """Returns a JSON string: {"rows": [...], "head": [...]} for the web page to draw."""
    argv = ["--league-id", str(league_id), "--simulations", str(int(simulations)),
            "--questionable-prob", str(questionable_prob), "--record-seeds", str(int(record_seeds)),
            "--wildcard-seeds", str(int(wildcard_seeds)), "--seed", str(int(seed)),
            "--no-log", "--cache-dir", "/tmp/sleeper_cache"]
    args = parse_args(argv)
    if demo:
        _use_demo(args)
        args.no_log = True
        args.cache_dir = "/tmp/sleeper_cache_demo"
    results, sim, minfo = run_league(args, quiet=True)
    head, rows = table(results, False)
    return json.dumps({"head": head, "rows": rows, "results": results, "sims": args.simulations,
                       "record_seeds": record_seeds, "wildcard_seeds": wildcard_seeds})


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nCancelled.", file=sys.stderr)
        sys.exit(130)
    except (RuntimeError, KeyError, ValueError, OSError) as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        sys.exit(1)
