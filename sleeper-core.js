/* Sleeper Tools shared core: league loading, player values, best lineups, power scores.
   No DOM. Used by power.html and trade.html (and by Node for tests).
   Every network call goes through `net.fetchJson(url)`, so the sample league uses the same code. */
(function (root) {
  "use strict";
  const API = "https://api.sleeper.app/v1";
  const HOSTS = ["https://api.sleeper.com", "https://api.sleeper.app"];
  const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
  const SLOT_ACCEPTS = {
    QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], K: ["K"], DEF: ["DEF"],
    FLEX: ["RB", "WR", "TE"], WRRB_FLEX: ["RB", "WR"], REC_FLEX: ["WR", "TE"], SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  };
  // tuning (explained on the pages)
  const DONE_WEIGHT = 0.5;      // weekly rate = 50% points per game so far + 50% projected points per game
  const FULL_GAMES = 6;         // ...once he has this many games; fewer games lean on the projection
  const BYE_CREDIT = 0.8;       // a bye week still counts 80% of a week (small penalty); weeks out count 0
  const WAIVER_RANK = 3;        // replacement level = 3rd best free agent at the position
  const STAR_POWER = 1.5;       // value curve: one great player beats two good ones
  const STREAM_DISCOUNT = { K: 0.5, DEF: 0.5 };   // easy to stream and hard to project: count half
  const ROSTER_WEEKS = 4;       // power rankings: roster score looks this many weeks ahead
  const QUESTIONABLE = 0.78, DOUBTFUL = 0.10;
  const TIERS = [[80, "Thanos"], [67, "Juggernaut"], [53, "Playoff Contender"], [42, "Playoff Hopeful"],
    [30, "Purgatory"], [-Infinity, "Pit of Doom and Despair"]];

  const num = (x, d = 0) => { const v = Number(x); return Number.isFinite(v) ? v : d; };
  const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const pstdev = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

  /* ---------------- scoring ---------------- */
  // League points from one projections-feed row (same rules as odds_engine.projected_points).
  function projPoints(row, scoring, pos) {
    const stats = (row && row.stats) || {};
    const rec = num(scoring.rec, 1);
    const famKey = rec >= 0.9 ? "pts_ppr" : rec >= 0.4 ? "pts_half_ppr" : "pts_std";
    let family = null;
    for (const k of [famKey, "pts_ppr", "pts_half_ppr", "pts_std"]) { if (k in stats) { family = num(stats[k]); break; } }
    if (family === null) for (const k of [famKey, "pts_ppr", "pts_half_ppr", "pts_std"]) { if (row && k in row) { family = num(row[k]); break; } }
    if (pos === "K" || pos === "DEF") return family;
    let calc = 0, found = false;
    for (const [k, w] of Object.entries(scoring)) {
      if (k in stats && typeof w === "number") { calc += num(stats[k]) * w; found = true; }
    }
    if (found && (family === null || calc >= 0.75 * family)) return calc;
    return family;
  }
  function mainPos(info) {
    const fp = (info && (info.fantasy_positions || [])) || [];
    const all = [info && info.position, ...fp].filter(Boolean).map((p) => String(p).toUpperCase());
    return POSITIONS.find((p) => all.includes(p)) || null;
  }
  function startSlots(rosterPositions) {
    return (rosterPositions || []).map((s) => String(s).toUpperCase()).filter((s) => SLOT_ACCEPTS[s]);
  }

  /* ---------------- loading ---------------- */
  const liveNet = {
    fetchJson: async (url) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30000);
      try {
        const res = await fetch(url, { signal: ctl.signal });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
      } finally { clearTimeout(timer); }
    },
  };
  async function firstOk(net, urls, ok) {
    let last = null;
    for (const u of urls) {
      try { const d = await net.fetchJson(u); if (ok(d)) return d; } catch (e) { last = e; }
    }
    throw last || new Error("no data");
  }
  const projUrls = (season, week) => {
    const q = "season_type=regular&order_by=ppr&" + POSITIONS.map((p) => "position%5B%5D=" + p).join("&");
    return HOSTS.map((h) => `${h}/projections/nfl/${season}/${week}?${q}`);
  };

  async function loadLeague(net, leagueId, say = () => {}) {
    say("Reading your league…");
    const league = await net.fetchJson(`${API}/league/${leagueId}`);
    if (!league || typeof league !== "object" || !league.roster_positions) throw new Error("That league was not found or is not public. Check the league ID.");
    const [users, rosters, state] = await Promise.all([
      net.fetchJson(`${API}/league/${leagueId}/users`), net.fetchJson(`${API}/league/${leagueId}/rosters`),
      net.fetchJson(`${API}/state/nfl`).catch(() => ({})),
    ]);
    const season = String(league.season);
    const st = league.settings || {};
    // Sleeper league type: 0 redraft, 1 keeper, 2 dynasty
    const leagueType = num(st.type, 0);
    const dynasty = leagueType === 2;
    const pws = num(st.playoff_week_start, 15) || 15;
    const regEnd = pws - 1;
    const lastWeek = Math.min(18, pws + Math.max(1, Math.ceil(Math.log2(num(st.playoff_teams, 6) || 6))) - 1);
    const um = {};
    for (const u of users || []) um[u.user_id] = u;
    const teams = (rosters || []).map((r) => {
      const u = um[r.owner_id] || {};
      const s = r.settings || {};
      return {
        rid: r.roster_id, ownerId: r.owner_id, name: (u.metadata && u.metadata.team_name) || u.display_name || `Team ${r.roster_id}`,
        owner: u.display_name || "", players: (r.players || []).map(String), taxi: new Set((r.taxi || []).map(String)),
        reserve: new Set((r.reserve || []).map(String)),
        wins: num(s.wins), losses: num(s.losses), ties: num(s.ties), pf: num(s.fpts) + num(s.fpts_decimal) / 100,
      };
    });
    if (!teams.length) throw new Error("This league has no rosters yet.");
    const gp = Math.max(...teams.map((t) => t.wins + t.losses + t.ties));
    // cw = the first week that is not finished (it may be in progress)
    let cw = gp + 1;
    const sameSeason = String(state.season || season) === season;
    if (sameSeason && state.season_type === "regular") cw = Math.max(gp + 1, num(state.week, gp + 1));
    else if (!sameSeason && String(state.season) > season) cw = lastWeek + 1;      // an old season
    else if (sameSeason && state.season_type === "post") cw = lastWeek + 1;
    cw = Math.max(1, Math.min(cw, lastWeek + 1));

    say("Reading every week's scores…");
    const mWeeks = [];
    for (let w = 1; w <= Math.min(cw, regEnd); w++) mWeeks.push(w);
    const matchups = {};
    await Promise.all(mWeeks.map(async (w) => {
      try { matchups[w] = (await net.fetchJson(`${API}/league/${leagueId}/matchups/${w}`)) || []; } catch (e) { matchups[w] = []; }
    }));

    say("Getting Sleeper projections for the rest of the season…");
    const remaining = [];
    for (let w = cw; w <= lastWeek; w++) remaining.push(w);
    const proj = {}, rowInfo = {};
    const notes = [];
    await Promise.all(remaining.map(async (w) => {
      try {
        let rows = await firstOk(net, projUrls(season, w), (d) => d && (Array.isArray(d) ? d.length : Object.keys(d).length) > 50);
        if (!Array.isArray(rows)) rows = Object.values(rows);
        proj[w] = rows;
        for (const r of rows) { const pid = String(r.player_id || (r.player && r.player.player_id) || ""); if (pid && r.player) rowInfo[pid] = r.player; }
      } catch (e) { proj[w] = null; }
    }));
    const missing = remaining.filter((w) => !proj[w]);
    if (missing.length && missing.length === remaining.length) notes.push("Sleeper projections could not be loaded, so values use points scored so far only.");
    else if (missing.length) notes.push(`Projections were missing for week ${missing.join(", ")}.`);

    let tradedPicks = [], drafts = [];
    if (dynasty) {
      say("Reading draft picks…");
      [tradedPicks, drafts] = await Promise.all([
        net.fetchJson(`${API}/league/${leagueId}/traded_picks`).catch(() => []),
        net.fetchJson(`${API}/league/${leagueId}/drafts`).catch(() => []),
      ]);
    }

    say("Getting the player list…");
    let db = {};
    try { db = (await net.fetchJson(`${API}/players/nfl`)) || {}; }
    catch (e) { notes.push("Sleeper's player list could not be loaded, so some injury statuses may be missing."); }
    return { leagueId, league, season, leagueType, dynasty, tradedPicks: tradedPicks || [], drafts: drafts || [],
      scoring: league.scoring_settings || {}, slots: startSlots(league.roster_positions),
      teams, gp, cw, regEnd, lastWeek, remaining, matchups, proj, db, rowInfo, notes };
  }

  /* ---------------- best lineup ---------------- */
  // pool: [{pts, pos}] ; greedy fill, tightest slots first (exact for the usual Sleeper layouts)
  function bestLineup(pool, slots, repl) {
    const order = slots.slice().sort((a, b) => SLOT_ACCEPTS[a].length - SLOT_ACCEPTS[b].length);
    const left = pool.filter((p) => p.pts > 0).sort((a, b) => b.pts - a.pts);
    let total = 0;
    const used = [];
    for (const s of order) {
      const acc = SLOT_ACCEPTS[s];
      const i = left.findIndex((p) => acc.includes(p.pos));
      const fill = Math.max(...acc.map((a) => num(repl && repl[a])));
      if (i >= 0 && left[i].pts >= fill) { total += left[i].pts; used.push(left[i]); left.splice(i, 1); }
      else total += fill;                         // empty or worse than waivers: grab a free agent
    }
    return { total, used };
  }

  /* ---------------- player values ---------------- */
  function computeValues(b) {
    const { scoring, gp, cw, remaining, matchups, proj, db, rowInfo, teams } = b;
    const info = (pid) => db[pid] || rowInfo[pid] || {};
    // points scored so far with the league's own scoring (every rostered player, bench included)
    const tot = {}, games = {};
    for (let w = 1; w <= gp; w++) for (const row of matchups[w] || []) {
      for (const [pid, pts] of Object.entries(row.players_points || {})) {
        const v = num(pts);
        if (v !== 0) { tot[pid] = (tot[pid] || 0) + v; games[pid] = (games[pid] || 0) + 1; }
      }
    }
    const livePts = {};
    if (cw > gp && matchups[cw]) for (const row of matchups[cw]) {
      for (const [pid, pts] of Object.entries(row.players_points || {})) if (num(pts) !== 0) livePts[pid] = num(pts);
    }
    const owner = {};
    for (const t of teams) for (const pid of t.players) owner[pid] = t.rid;
    const pids = new Set([...Object.keys(owner), ...Object.keys(tot)]);   // includes players since dropped
    const projW = {};
    for (const w of remaining) {
      projW[w] = {};
      for (const r of proj[w] || []) {
        const pid = String(r.player_id || (r.player && r.player.player_id) || "");
        if (!pid) continue;
        const pos = mainPos(info(pid)) || mainPos(r.player) || mainPos(r);
        if (!pos) continue;
        const v = projPoints(r, scoring, pos);
        if (v !== null && v > 0) { projW[w][pid] = v; pids.add(pid); }
      }
    }
    const haveProj = remaining.some((w) => Object.keys(projW[w]).length);
    // which NFL teams play each remaining week (anyone on the team projected) -> bye vs injured
    const teamPlays = {};
    for (const w of remaining) {
      teamPlays[w] = new Set();
      for (const r of proj[w] || []) {
        const pid = String(r.player_id || (r.player && r.player.player_id) || "");
        const tm = r.team || (r.player && r.player.team) || (info(pid) || {}).team;
        if (tm && projW[w][pid] > 0) teamPlays[w].add(String(tm).toUpperCase());
      }
    }
    const players = {};
    for (const pid of pids) {
      const inf = info(pid);
      const pos = mainPos(inf);
      if (!pos) continue;
      const g = games[pid] || 0;
      const ppg = g ? tot[pid] / g : 0;
      const nfl = String(inf.team || (pos === "DEF" ? pid : "")).toUpperCase();
      // each remaining week: played (already this week), bye, out (team plays, he is projected 0) or on
      const status = remaining.map((w) => {
        if (w === cw && livePts[pid] !== undefined) return "played";
        if (!haveProj) return "on";
        if ((projW[w][pid] || 0) > 0) return "on";
        return nfl && teamPlays[w].size > 20 && !teamPlays[w].has(nfl) ? "bye" : "out";
      });
      const onProj = remaining.map((w, i) => (status[i] === "on" ? projW[w][pid] || 0 : 0)).filter((x) => x > 0);
      const projPg = onProj.length ? onProj.reduce((a, x) => a + x, 0) / onProj.length : 0;
      const wDone = !haveProj ? 1 : g ? DONE_WEIGHT * Math.min(1, g / FULL_GAMES) : 0;
      const rate = !haveProj ? ppg : onProj.length ? wDone * ppg + (1 - wDone) * projPg : 0;
      const weekly = status.map((st) => (st === "on" ? rate : 0));
      const counted = status.filter((x) => x !== "played").length;
      const on = status.filter((x) => x === "on").length, byes = status.filter((x) => x === "bye").length;
      const avail = counted ? (on + BYE_CREDIT * byes) / counted : 1;
      const name = inf.full_name || [inf.first_name, inf.last_name].filter(Boolean).join(" ") || (pos === "DEF" ? `${pid} D/ST` : pid);
      players[pid] = { pid, name, pos, nfl: inf.team || (pos === "DEF" ? pid : ""), injury: inf.injury_status || "",
        owner: owner[pid] || null, ppg, games: g, total: tot[pid] || 0, weekly, rate, projPg, avail,
        byeWeeks: remaining.filter((w, i) => status[i] === "bye"), outWeeks: remaining.filter((w, i) => status[i] === "out"),
        ros: weekly.reduce((s, x) => s + x, 0), live: livePts[pid] };
    }
    // replacement level: what you could pick up off waivers right now (avg weekly pts)
    const repl = {};
    for (const pos of POSITIONS) {
      const fa = Object.values(players).filter((p) => p.pos === pos && !p.owner).map((p) => p.rate * p.avail).sort((a, b) => b - a);
      repl[pos] = fa[WAIVER_RANK - 1] || fa[fa.length - 1] || 0;
    }
    let maxRaw = 0;
    for (const p of Object.values(players)) {
      p.vor = Math.max(0, p.rate - repl[p.pos]) * p.avail;   // points above waivers per week, times availability
      p.vor *= STREAM_DISCOUNT[p.pos] || 1;
      maxRaw = Math.max(maxRaw, p.vor);
    }
    for (const p of Object.values(players)) p.value = maxRaw > 0 ? 100 * Math.pow(p.vor / maxRaw, STAR_POWER) : 0;
    // season value: the same scale for what a player was worth this season as a whole, ignoring who is
    // hurt or on bye now. Used to rate the rosters teams had in earlier weeks (score-by-week chart).
    let maxSeason = 0;
    for (const p of Object.values(players)) {
      const r = p.games ? 0.5 * p.ppg + 0.5 * (p.projPg || p.ppg) : p.rate;
      p.seasonVor = Math.max(0, r - repl[p.pos]) * (STREAM_DISCOUNT[p.pos] || 1);
      maxSeason = Math.max(maxSeason, p.seasonVor);
    }
    for (const p of Object.values(players)) p.seasonValue = maxSeason > 0 ? 100 * Math.pow(p.seasonVor / maxSeason, STAR_POWER) : 0;
    // positional ranks by value
    for (const pos of POSITIONS) {
      Object.values(players).filter((p) => p.pos === pos).sort((a, b) => b.value - a.value || b.rate - a.rate).forEach((p, i) => { p.posRank = i + 1; });
    }
    return { players, repl, haveProj };
  }

  // a team's average best starting lineup over the next `weeks` remaining weeks (players: pid list)
  function lineupStrength(b, vals, pids, weeks = ROSTER_WEEKS) {
    const n = Math.min(weeks, b.remaining.length);
    const pool = pids.map((pid) => vals.players[pid]).filter(Boolean);
    if (!n) return bestLineup(pool.map((p) => ({ pts: p.ppg, pos: p.pos })), b.slots, vals.repl).total;
    let s = 0;
    for (let i = 0; i < n; i++) {
      s += bestLineup(pool.map((p) => {
        let pts = p.weekly[i];
        if (i === 0 && b.remaining[0] === b.cw && p.live === undefined) {   // the coming game: injury odds
          const st = String(p.injury).toLowerCase();
          if (st === "questionable") pts *= QUESTIONABLE; else if (st === "doubtful") pts *= DOUBTFUL; else if (st === "out") pts = 0;
        }
        return { pts, pos: p.pos };
      }), b.slots, vals.repl).total;
    }
    return s / n;
  }

  /* roster strength = trade value of the best starting lineup + a little for bench depth
     (same values as the trade calculator: rest of season, half done / half projected, above waivers) */
  const BENCH_CREDIT = 0.15, BENCH_COUNT = 6;
  function rosterValue(b, vals, pids, key = "value") {
    const pool = pids.map((pid) => vals.players[pid]).filter(Boolean).map((p) => ({ pid: p.pid, pts: p[key] || 0, pos: p.pos }));
    const lu = bestLineup(pool, b.slots, {});
    const used = new Set(lu.used.map((x) => x.pid));
    const bench = pool.filter((x) => !used.has(x.pid)).map((x) => x.pts).sort((a, c) => c - a).slice(0, BENCH_COUNT);
    return lu.total + BENCH_CREDIT * bench.reduce((s2, v) => s2 + v, 0);
  }

  /* ---------------- power rankings ---------------- */
  function zscores(obj) {
    const ids = Object.keys(obj), vals = ids.map((k) => obj[k]);
    const m = mean(vals), s = pstdev(vals);
    const out = {};
    for (const k of ids) out[k] = s > 0 ? (obj[k] - m) / s : 0;
    return out;
  }
  function tierFor(score) { return TIERS.find(([lo]) => score >= lo)[1]; }
  function powerScores(rows, weights = [0.5, 0.3, 0.2]) {
    const zw = zscores(Object.fromEntries(rows.map((r) => [r.rid, r.winPct])));
    const zp = zscores(Object.fromEntries(rows.map((r) => [r.rid, r.pf])));
    const zr = zscores(Object.fromEntries(rows.map((r) => [r.rid, r.roster])));
    return Object.fromEntries(rows.map((r) => {
      const z = weights[0] * zw[r.rid] + weights[1] * zp[r.rid] + weights[2] * zr[r.rid];
      return [r.rid, { score: (z + 2.5) / 5 * 100, zWin: zw[r.rid], zPf: zp[r.rid], zRoster: zr[r.rid] }];
    }));
  }
  // records + points for through week `upto`, rebuilt from the weekly matchups
  function standingsThrough(b, upto) {
    const out = {};
    for (const t of b.teams) out[t.rid] = { w: 0, l: 0, t: 0, pf: 0 };
    for (let w = 1; w <= upto; w++) {
      const byM = {};
      for (const row of b.matchups[w] || []) {
        if (!(row.roster_id in out)) continue;
        out[row.roster_id].pf += num(row.points);
        if (row.matchup_id != null) (byM[row.matchup_id] = byM[row.matchup_id] || []).push(row);
      }
      for (const pair of Object.values(byM)) {
        if (pair.length !== 2) continue;
        const [a, c] = pair, pa = num(a.points), pc = num(c.points);
        if (pa > pc) { out[a.roster_id].w++; out[c.roster_id].l++; }
        else if (pc > pa) { out[c.roster_id].w++; out[a.roster_id].l++; }
        else { out[a.roster_id].t++; out[c.roster_id].t++; }
      }
    }
    return out;
  }
  function powerRankings(b, vals) {
    const rosterScore = {};
    for (const t of b.teams) rosterScore[t.rid] = rosterValue(b, vals, t.players.filter((p) => !t.taxi.has(p)));
    const build = (rec) => b.teams.map((t) => {
      const r = rec[t.rid], g = r.w + r.l + r.t;
      return { rid: t.rid, winPct: g ? (r.w + 0.5 * r.t) / g : 0.5, pf: r.pf, roster: rosterScore[t.rid] };
    });
    const now = Object.fromEntries(b.teams.map((t) => [t.rid, { w: t.wins, l: t.losses, t: t.ties, pf: t.pf }]));
    const cur = powerScores(build(now));
    const order = b.teams.slice().sort((x, y) => cur[y.rid].score - cur[x.rid].score);
    let prevRank = null;
    if (b.gp >= 2) {
      const prev = powerScores(build(standingsThrough(b, b.gp - 1)));
      const po = b.teams.slice().sort((x, y) => prev[y.rid].score - prev[x.rid].score);
      prevRank = Object.fromEntries(po.map((t, i) => [t.rid, i + 1]));
    }
    return order.map((t, i) => ({
      rank: i + 1, rid: t.rid, name: t.name, owner: t.owner, wins: t.wins, losses: t.losses, ties: t.ties, pf: t.pf,
      gp: t.wins + t.losses + t.ties, roster: rosterScore[t.rid], ...cur[t.rid], tier: tierFor(cur[t.rid].score),
      move: prevRank ? prevRank[t.rid] - (i + 1) : null,
    }));
  }

  // power score for every week played: that week's record and points for, plus the roster the team
  // actually had that week (from Sleeper's weekly matchups), rated by what each player has done and
  // is projected to do. The last week is replaced by the current rankings so the line ends on today's score.
  function powerHistory(b, vals, current) {
    const weeks = [], series = {}, ranks = {};
    for (const t of b.teams) { series[t.rid] = []; ranks[t.rid] = []; }
    for (let w = 1; w <= b.gp; w++) {
      let sc;
      if (w === b.gp && current) sc = Object.fromEntries(current.map((r) => [r.rid, r.score]));
      else {
        const rec = standingsThrough(b, w);
        const rosterAt = {};
        for (const row of b.matchups[w] || []) rosterAt[row.roster_id] = (row.players || []).map(String);
        const rows = b.teams.map((t) => {
          const r = rec[t.rid], g = r.w + r.l + r.t;
          return { rid: t.rid, winPct: g ? (r.w + 0.5 * r.t) / g : 0.5, pf: r.pf, roster: rosterValue(b, vals, rosterAt[t.rid] || t.players, "seasonValue") };
        });
        const ps = powerScores(rows);
        sc = Object.fromEntries(rows.map((r) => [r.rid, ps[r.rid].score]));
      }
      weeks.push(w);
      const order = Object.keys(sc).sort((x, y) => sc[y] - sc[x]);
      for (const t of b.teams) { series[t.rid].push(sc[t.rid]); ranks[t.rid].push(order.indexOf(String(t.rid)) + 1); }
    }
    return { weeks, series, ranks };
  }

  /* ---------------- dynasty: age-adjusted multi-season values + draft picks ----------------
     Production relative to a player's peak, by position and age (RBs fall off first, QBs last). */
  const AGE_CURVE = {
    QB: { up: { 21: 0.75, 22: 0.85, 23: 0.93 }, peak: [24, 33], down: [0.92, 0.84, 0.75, 0.65, 0.55] },
    RB: { up: { 21: 0.95 }, peak: [22, 26], down: [0.9, 0.78, 0.65, 0.5, 0.38] },
    WR: { up: { 21: 0.85, 22: 0.93 }, peak: [23, 28], down: [0.92, 0.83, 0.72, 0.6, 0.48] },
    TE: { up: { 21: 0.7, 22: 0.8, 23: 0.9 }, peak: [24, 29], down: [0.9, 0.8, 0.68, 0.55, 0.45] },
  };
  const FUTURE_SEASONS = [0.8, 0.6, 0.45];   // weight of the next three seasons (later seasons are less certain)
  const PICK_YEAR_DISCOUNT = 0.9;           // each extra year until a pick is used
  function ageFactor(pos, age) {
    const c = AGE_CURVE[pos];
    if (!c || !age) return 1;
    const a = Math.round(age);
    if (a >= c.peak[0] && a <= c.peak[1]) return 1;
    if (a < c.peak[0]) return c.up[a] || 0.65;
    const k = a - c.peak[1] - 1;
    return k < c.down.length ? c.down[k] : c.down[c.down.length - 1] * Math.pow(0.8, k - c.down.length + 1);
  }
  function playerAge(info) {
    if (info && Number.isFinite(+info.age) && +info.age > 15) return +info.age;
    if (info && info.birth_date) { const d = new Date(info.birth_date); if (!isNaN(d)) return (Date.now() - d) / 31557600000; }
    return null;
  }
  const ordinal = (n) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");

  // returns a values object shaped like computeValues' (players, repl) with dynasty values, plus picks
  function computeDynasty(b, vals, powerRows) {
    const info = (pid) => b.db[pid] || b.rowInfo[pid] || {};
    const remW = b.remaining.length;
    const players = {};
    let maxRaw = 0;
    for (const p of Object.values(vals.players)) {
      const age = playerAge(info(p.pid));
      const now = Math.max(0.3, ageFactor(p.pos, age));
      let future = 0;
      FUTURE_SEASONS.forEach((w, k) => { future += w * ageFactor(p.pos, age ? age + k + 1 : null) / now; });
      const raw = p.vor * remW + (p.seasonVor || 0) * 17 * future;
      players[p.pid] = { ...p, age, redraftValue: p.value, dynRaw: raw };
      maxRaw = Math.max(maxRaw, raw);
    }
    for (const p of Object.values(players)) p.value = maxRaw > 0 ? 100 * Math.pow(p.dynRaw / maxRaw, STAR_POWER) : 0;
    for (const pos of POSITIONS) Object.values(players).filter((p) => p.pos === pos).sort((a, c) => c.value - a.value).forEach((p, i) => { p.posRank = i + 1; });

    // ---- draft picks ----
    const N = b.teams.length, cur = +b.season;
    const drafts = (b.drafts || []).slice().sort((x, y) => +y.season - +x.season);
    const pending = drafts.find((d) => String(d.season) === String(cur) && d.status !== "complete");
    const rounds = num((drafts[0] && drafts[0].settings && drafts[0].settings.rounds) || (b.league.settings || {}).draft_rounds, 4) || 4;
    const seasons = (pending ? [cur] : []).concat([cur + 1, cur + 2, cur + 3]);
    // asset value ladder: the league's players by value, best first
    const ladder = Object.values(players).map((p) => p.value).sort((a, c) => c - a);
    const valueAtRank = (r) => {                                   // r is 1-based and can be fractional
      const i = Math.max(0, r - 1), lo = Math.floor(i), hi = Math.min(ladder.length - 1, lo + 1);
      if (lo >= ladder.length) return 0;
      return ladder[lo] + (ladder[hi] - ladder[lo]) * (i - lo);
    };
    // a pick is worth about the league's Nth most valuable player: early 1st ~ a top-15 asset
    const pickValue = (round, slot) => valueAtRank(N + 3.2 * ((round - 1) * N + slot));
    const rankOf = {};
    (powerRows || []).forEach((r) => { rankOf[r.rid] = r.rank; });
    const mid = (N + 1) / 2;
    const orderSlot = {};
    if (pending && pending.draft_order) {
      for (const t of b.teams) { const sl = pending.draft_order[t.ownerId]; if (sl) orderSlot[t.rid] = +sl; }
    }
    const owner = {};
    for (const tp of b.tradedPicks || []) owner[`${tp.season}:${tp.round}:${tp.roster_id}`] = tp.owner_id;
    const teamName = (rid) => (b.teams.find((t) => t.rid === rid) || {}).name || `Team ${rid}`;
    const teamPicks = {};
    for (const t of b.teams) teamPicks[t.rid] = [];
    for (const season of seasons) {
      const yearsOut = season - cur;
      for (let round = 1; round <= rounds; round++) {
        for (const t of b.teams) {
          const orig = t.rid;
          const own = owner[`${season}:${round}:${orig}`] != null ? +owner[`${season}:${round}:${orig}`] : orig;
          if (!(own in teamPicks)) continue;
          let slot, slotKnown = false;
          if (yearsOut <= 0 && orderSlot[orig]) { slot = orderSlot[orig]; slotKnown = true; }
          else if (yearsOut <= 1 && rankOf[orig]) slot = 0.6 * (N + 1 - rankOf[orig]) + 0.4 * mid;   // weaker team, earlier pick
          else slot = mid;
          const value = pickValue(round, slot) * Math.pow(PICK_YEAR_DISCOUNT, Math.max(0, yearsOut - 1));
          const pid = `pick:${season}:${round}:${orig}`;
          const label = slotKnown ? `${season} ${round}.${String(slot).padStart(2, "0")}` : `${season} ${ordinal(round)}`;
          players[pid] = { pid, name: label, pos: "PICK", nfl: "", injury: "", owner: own, orig, season, round, slot, slotKnown,
            from: orig !== own ? teamName(orig) : null, value, ppg: 0, games: 0, ros: 0, projPg: 0, rate: 0, weekly: [], byeWeeks: [] };
          teamPicks[own].push(pid);
        }
      }
    }
    for (const rid in teamPicks) teamPicks[rid].sort((x, y) => players[x].season - players[y].season || players[x].round - players[y].round || players[y].value - players[x].value);
    return { players, repl: vals.repl, haveProj: vals.haveProj, dynasty: true, teamPicks, seasons, rounds };
  }

  /* ---------------- weekly rankings ----------------
     score = 75% (adjustable: o.projWeight) Sleeper's projection for that week + 25% form (season average, or average of his last
     few games), both scored with the league's settings. Form only uses games before the chosen week. */
  const WEEKLY_PROJ = 0.75, RECENT_GAMES = 3;
  const WEEKLY_POS = ["QB", "RB", "WR", "TE"];
  const statUrls = (season, week) => {
    const q = "season_type=regular&" + POSITIONS.map((p) => "position%5B%5D=" + p).join("&");
    return HOSTS.map((h) => `${h}/stats/nfl/${season}/${week}?${q}`);
  };
  // raw rows from Sleeper's projections or stats feed for one week (null if it can't be read)
  async function loadWeekRows(net, season, week, kind = "projections") {
    try {
      const urls = kind === "stats" ? statUrls(season, week) : projUrls(season, week);
      let rows = await firstOk(net, urls, (d) => d && (Array.isArray(d) ? d.length : Object.keys(d).length) > (kind === "stats" ? 0 : 50));
      if (!Array.isArray(rows)) rows = Object.entries(rows).map(([pid, r]) => (r && r.player_id ? r : { player_id: pid, stats: r }));
      return rows;
    } catch (e) { return null; }
  }
  const rowPid = (r) => String(r.player_id || (r.player && r.player.player_id) || "");
  // { pid: {pts, played} } for one finished week: from the stats feed, or the league's matchups if that is missing
  function weekPoints(b, rows, w) {
    const out = {};
    const info = (pid) => b.db[pid] || b.rowInfo[pid] || {};
    if (rows && rows.length) {
      for (const r of rows) {
        const pid = rowPid(r);
        if (!pid) continue;
        const pos = mainPos(info(pid)) || mainPos(r.player) || mainPos(r);
        if (!pos) continue;
        const v = num(projPoints(r, b.scoring, pos));
        const st = r.stats || {};
        const played = "gp" in st ? num(st.gp) > 0 : v !== 0;
        if (played || v !== 0) out[pid] = { pts: v, played };
      }
      return out;
    }
    for (const row of b.matchups[w] || []) {
      for (const [pid, pts] of Object.entries(row.players_points || {})) if (num(pts) !== 0) out[pid] = { pts: num(pts), played: true };
    }
    return out;
  }
  /* o: { week, projRows, points: {w: weekPoints}, done (last finished week), form: "season"|"recent", recent, projWeight (0-1) } */
  function weeklyRankings(b, o) {
    const info = (pid) => b.db[pid] || b.rowInfo[pid] || {};
    const form = o.form === "recent" ? "recent" : "season";
    const recentN = o.recent || RECENT_GAMES;
    const pw = Number.isFinite(o.projWeight) ? Math.min(1, Math.max(0, o.projWeight)) : WEEKLY_PROJ;
    const owner = {};
    for (const t of b.teams) for (const pid of t.players) owner[pid] = t;
    const proj = {}, opp = {}, rowPl = {}, teamPlays = new Set();
    for (const r of o.projRows || []) {
      const pid = rowPid(r);
      if (!pid) continue;
      const pos = mainPos(info(pid)) || mainPos(r.player) || mainPos(r);
      if (!WEEKLY_POS.includes(pos)) continue;
      const v = num(projPoints(r, b.scoring, pos));
      rowPl[pid] = r.player || {};
      if (r.opponent) opp[pid] = String(r.opponent);
      if (v > 0) { proj[pid] = v; const tm = r.team || (r.player && r.player.team) || info(pid).team; if (tm) teamPlays.add(String(tm).toUpperCase()); }
    }
    const histTo = Math.min(o.week - 1, o.done);
    const result = o.week <= o.done ? "final" : o.week === o.done + 1 && o.points[o.week] ? "live" : null;
    const pids = new Set(Object.keys(proj));
    for (const pid of Object.keys(owner)) pids.add(pid);       // rostered players on bye / out still show for their team
    const rows = [];
    for (const pid of pids) {
      const inf = Object.keys(info(pid)).length ? info(pid) : rowPl[pid] || {};
      const pos = mainPos(inf);
      if (!WEEKLY_POS.includes(pos)) continue;
      const games = [];
      for (let w = 1; w <= histTo; w++) { const g = o.points[w] && o.points[w][pid]; if (g && g.played) games.push(g.pts); }
      const seasonAvg = games.length ? mean(games) : null;
      const recent = games.slice(-recentN);
      const recentAvg = recent.length ? mean(recent) : null;
      const formAvg = form === "recent" ? recentAvg : seasonAvg;
      const p = proj[pid] || 0;
      const nfl = String(inf.team || "").toUpperCase();
      const playing = p > 0;
      const score = playing ? pw * p + (1 - pw) * (formAvg === null ? p : formAvg) : 0;
      const t = owner[pid];
      const act = result && o.points[o.week] ? o.points[o.week][pid] : null;
      rows.push({ pid, pos, name: inf.full_name || [inf.first_name, inf.last_name].filter(Boolean).join(" ") || pid, nfl: inf.team || "",
        opp: opp[pid] || "", injury: inf.injury_status || "", proj: p, seasonAvg, recentAvg, form: formAvg, games: games.length, score, playing,
        status: playing ? "on" : nfl && teamPlays.size > 20 && !teamPlays.has(nfl) ? "bye" : "out",
        ownerRid: t ? t.rid : null, ownerName: t ? t.name : "", actual: act ? act.pts : result === "final" ? 0 : null });
    }
    rows.sort((a, c) => c.score - a.score || c.proj - a.proj);
    const cnt = {};
    let flex = 0;
    for (const r of rows) {
      if (!r.playing) continue;
      r.posRank = cnt[r.pos] = (cnt[r.pos] || 0) + 1;
      if (r.pos !== "QB") r.flexRank = ++flex;
    }
    // where each player actually finished that week (finished weeks only)
    if (result === "final") {
      const fin = {};
      rows.filter((r) => r.actual !== null).slice().sort((a, c) => c.actual - a.actual).forEach((r) => { r.actualRank = fin[r.pos] = (fin[r.pos] || 0) + 1; });
    }
    return { rows, result, form, recentN, histTo, projWeight: pw };
  }

  /* ---------------- league analysis: median and all-play standings, every season ----------------
     Seasons are linked through Sleeper's previous_league_id. Only finished regular-season weeks count.
     All-time totals follow the manager (Sleeper user), not the roster slot, so they survive renumbering. */
  async function loadLeagueHistory(net, leagueId, say = () => {}) {
    say("Reading your league…");
    const state = await net.fetchJson(`${API}/state/nfl`).catch(() => ({}));
    const chain = [];
    let id = String(leagueId);
    const seen = new Set();
    while (id && id !== "0" && !seen.has(id) && chain.length < 20) {
      seen.add(id);
      let lg = null;
      try { lg = await net.fetchJson(`${API}/league/${id}`); } catch (e) { if (!chain.length) throw e; }
      if (!lg || typeof lg !== "object" || !lg.settings) {
        if (!chain.length) throw new Error("That league was not found or is not public. Check the league ID.");
        break;
      }
      chain.push(lg);
      id = lg.previous_league_id ? String(lg.previous_league_id) : null;
    }
    const seasons = [];
    for (const lg of chain) {
      const lid = String(lg.league_id || leagueId);
      const season = String(lg.season);
      say(`Reading the ${season} season…`);
      const st = lg.settings || {};
      const regEnd = (num(st.playoff_week_start, 15) || 15) - 1;
      let lastDone = regEnd;
      if (season === String(state.season) && lg.status !== "complete") {
        if (state.season_type === "regular") lastDone = Math.min(regEnd, num(state.week, 1) - 1);
        else if (state.season_type === "pre" || lg.status === "pre_draft" || lg.status === "drafting") lastDone = 0;
      }
      const [users, rosters] = await Promise.all([
        net.fetchJson(`${API}/league/${lid}/users`).catch(() => []), net.fetchJson(`${API}/league/${lid}/rosters`).catch(() => []),
      ]);
      const um = {};
      for (const u of users || []) um[u.user_id] = u;
      const teams = (rosters || []).map((r) => {
        const u = um[r.owner_id] || {};
        return { rid: r.roster_id, key: r.owner_id ? String(r.owner_id) : `${lid}:${r.roster_id}`,
          name: (u.metadata && u.metadata.team_name) || u.display_name || `Team ${r.roster_id}`, owner: u.display_name || "" };
      });
      const wk = [];
      for (let w = 1; w <= lastDone; w++) wk.push(w);
      const weeks = (await Promise.all(wk.map(async (w) => {
        let rows = [];
        try { rows = (await net.fetchJson(`${API}/league/${lid}/matchups/${w}`)) || []; } catch (e) { rows = []; }
        rows = rows.map((r) => ({ rid: r.roster_id, pts: num(r.points), mid: r.matchup_id }));
        return rows.some((r) => r.pts !== 0) ? { w, rows } : null;
      }))).filter(Boolean);
      seasons.push({ season, leagueId: lid, name: lg.name || "", teams, weeks, regEnd, lastDone,
        sleeperMedian: !!st.league_average_match, current: lg === chain[0] });
    }
    return { seasons, notes: [] };
  }

  // seasons: subset of loadLeagueHistory().seasons. One row per manager.
  function analyzeSeasons(seasons) {
    const acc = {};
    const order = seasons.slice().sort((a, b) => +a.season - +b.season);      // oldest first: newest name wins
    for (const s of order) {
      const byRid = {};
      for (const t of s.teams) {
        byRid[t.rid] = t;
        const a = acc[t.key] || (acc[t.key] = { key: t.key, seasons: new Set(), games: 0, w: 0, l: 0, t: 0, pf: 0, pa: 0,
          mw: 0, ml: 0, mt: 0, aw: 0, al: 0, at: 0, xw: 0, weeksHigh: 0, weeksLow: 0 });
        a.name = t.name; a.owner = t.owner;
      }
      for (const wk of s.weeks) {
        const rows = wk.rows.filter((r) => byRid[r.rid]);
        if (rows.length < 2) continue;
        const sorted = rows.map((r) => r.pts).sort((x, y) => x - y);
        const n = sorted.length, med = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
        const hi = sorted[n - 1], lo = sorted[0];
        const byM = {};
        for (const r of rows) if (r.mid != null) (byM[r.mid] = byM[r.mid] || []).push(r);
        for (const r of rows) {
          const a = acc[byRid[r.rid].key];
          a.seasons.add(s.season);
          a.pf += r.pts;
          if (r.pts > med) a.mw++; else if (r.pts < med) a.ml++; else a.mt++;
          let beat = 0, tie = 0;
          for (const o of rows) if (o !== r) { if (r.pts > o.pts) beat++; else if (r.pts === o.pts) tie++; }
          a.aw += beat; a.at += tie; a.al += n - 1 - beat - tie;
          a.xw += (beat + 0.5 * tie) / (n - 1);
          if (r.pts === hi) a.weeksHigh++;
          if (r.pts === lo) a.weeksLow++;
        }
        for (const pair of Object.values(byM)) {
          if (pair.length !== 2) continue;
          const [x, y] = pair, ax = acc[byRid[x.rid].key], ay = acc[byRid[y.rid].key];
          ax.games++; ay.games++; ax.pa += y.pts; ay.pa += x.pts;
          if (x.pts > y.pts) { ax.w++; ay.l++; } else if (y.pts > x.pts) { ay.w++; ax.l++; } else { ax.t++; ay.t++; }
        }
      }
    }
    const pct = (w, l, t) => (w + l + t ? (w + 0.5 * t) / (w + l + t) : 0);
    const rows = Object.values(acc).filter((a) => a.seasons.size).map((a) => ({ ...a, seasons: a.seasons.size,
      h2hPct: pct(a.w, a.l, a.t), medPct: pct(a.mw, a.ml, a.mt),
      cw: a.w + a.mw, cl: a.l + a.ml, ct: a.t + a.mt, combPct: pct(a.w + a.mw, a.l + a.ml, a.t + a.mt),
      allPct: pct(a.aw, a.al, a.at), luck: a.w + 0.5 * a.t - a.xw }));
    const h2hOrder = rows.slice().sort((a, b) => b.h2hPct - a.h2hPct || b.pf - a.pf);
    h2hOrder.forEach((r, i) => { r.h2hRank = i + 1; });
    const median = rows.slice().sort((a, b) => b.combPct - a.combPct || b.pf - a.pf);
    median.forEach((r, i) => { r.medRank = i + 1; });
    const allPlay = rows.slice().sort((a, b) => b.allPct - a.allPct || b.pf - a.pf);
    allPlay.forEach((r, i) => { r.allRank = i + 1; });
    const weeks = seasons.reduce((n, s) => n + s.weeks.length, 0);
    return { median, allPlay, weeks };
  }

  /* ---------------- trades ---------------- */
  const DEPTH = [1, 0.85, 0.72, 0.62, 0.55];   // extra pieces count for less: you can only start so many
  const sideValue = (vals) => vals.slice().sort((a, b) => b - a).reduce((s, v, i) => s + v * DEPTH[Math.min(i, DEPTH.length - 1)], 0);
  // left gives `aGives`, right gives `bGives` (pid lists). Positive lean = good for the left team.
  function evaluateTrade(b, vals, aRid, bRid, aGives, bGives) {
    const P = vals.players, team = (rid) => b.teams.find((t) => t.rid === rid);
    const aGet = sideValue(bGives.map((p) => P[p] ? P[p].value : 0));
    const bGet = sideValue(aGives.map((p) => P[p] ? P[p].value : 0));
    const big = Math.max(aGet, bGet);
    const lean = big > 0 ? (aGet - bGet) / big : 0;
    const mag = Math.abs(lean);
    const level = !aGives.length && !bGives.length ? "empty" : mag < 0.08 ? "even" : mag < 0.2 ? "slight" : mag < 0.38 ? "favors" : "fleece";
    const isPick = (p) => String(p).startsWith("pick:");
    const impact = (rid, gives, gets) => {
      const t = team(rid);
      if (!t) return null;
      const base = t.players.filter((p) => !t.taxi.has(p));
      const after = base.filter((p) => !gives.includes(p)).concat(gets.filter((p) => !isPick(p)));
      const before = lineupStrength(b, vals, base, 99), now = lineupStrength(b, vals, after, 99);
      const spots = gets.filter((p) => !isPick(p)).length - gives.filter((p) => !isPick(p)).length;
      const drops = spots > 0 ? after.filter((p) => !t.reserve.has(p)).map((p) => P[p] || { pid: p, name: p, value: 0 })
        .sort((x, y) => x.value - y.value).slice(0, spots).map((p) => p.name) : [];
      return { before, after: now, delta: now - before, drops };
    };
    return { aGet, bGet, lean, level, a: impact(aRid, aGives, bGives), b: impact(bRid, bGives, aGives) };
  }

  /* ---------------- sample league (same code path, fake network) ---------------- */
  function makeSampleNet(seed = 20261127, opts = {}) {
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const FIRST = ["Jalen", "Marcus", "Tyrell", "Devon", "Cole", "Brandon", "Jaylen", "Trey", "Malik", "Austin", "Darius", "Caleb", "Isaiah", "Nico", "Drew", "Kendrick", "Zach", "Andre", "Bryce", "Elijah", "Garrett", "Rashad", "Owen", "Xavier", "Terrell", "Quinn", "Hunter", "Jordan", "Corey", "Mason"];
    const LAST = ["Holloway", "Bridges", "Carter", "Whitfield", "Moreno", "Pruitt", "Dawson", "Kincaid", "Ellison", "Rhodes", "Barlow", "Sutton", "McCray", "Fontaine", "Graves", "Hale", "Ivers", "Jennings", "Lockhart", "Mabry", "Nash", "Oakes", "Pryor", "Quarles", "Ridley", "Sosa", "Tatum", "Upshaw", "Vance", "Wilder"];
    const NFL = ["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC", "LV", "LAC", "LAR", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SF", "SEA", "TB", "TEN", "WAS"];
    const bye = Object.fromEntries(NFL.map((t, i) => [t, 5 + (i % 10)]));
    const players = {}, plist = [];
    const counts = { QB: 40, RB: 80, WR: 100, TE: 40, K: 32 };
    const base = { QB: [19, 3], RB: [16, 4], WR: [15.5, 4], TE: [11, 3], K: [8.5, 1] };
    let id = 1000;
    for (const [pos, n] of Object.entries(counts)) {
      for (let i = 0; i < n; i++) {
        const pid = String(id++);
        const tier = Math.pow(1 - i / n, 1.6);
        const spread = pos === "K" ? [0.8, 0.35] : pos === "QB" ? [0.62, 0.62] : [0.3, 1.0];
        const mu = Math.max(2, base[pos][0] * (spread[0] + spread[1] * tier) + gauss() * base[pos][1] * 0.25);
        const r = rnd();
        const inj = r < 0.04 ? "Out" : r < 0.1 ? "Questionable" : r < 0.12 ? "IR" : r < 0.13 ? "Doubtful" : null;
        const p = { player_id: pid, first_name: FIRST[Math.floor(rnd() * FIRST.length)], last_name: LAST[Math.floor(rnd() * LAST.length)],
          position: pos, fantasy_positions: [pos], team: NFL[Math.floor(rnd() * NFL.length)], injury_status: inj, _mu: mu,
          age: Math.round(21 + rnd() * (pos === "QB" ? 15 : pos === "RB" ? 9 : 12)) };
        p.full_name = p.first_name + " " + p.last_name;
        players[pid] = p; plist.push(p);
      }
    }
    for (const t of NFL) { const p = { player_id: t, first_name: t, last_name: "Defense", full_name: `${t} Defense`, position: "DEF", fantasy_positions: ["DEF"], team: t, _mu: 6 + gauss() * 1.6 }; players[t] = p; plist.push(p); }
    const NAMES = ["Joyless Murderball", "KingNjigbas", "The Third Reichard", "Wolf of Ballstreet", "Bijan Mustard", "Tua Legit", "Chubb Club", "Kittle Me This", "Lamb Chops", "Puka Shells", "Waddle Waddle", "Hurts Donut"];
    const slots = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN"];
    const byPos = (pos) => plist.filter((p) => p.position === pos).sort((a, b) => b._mu - a._mu);
    const need = { QB: 2, RB: 5, WR: 5, TE: 2, K: 1, DEF: 1 };
    const rosters = NAMES.map((n, i) => ({ roster_id: i + 1, owner_id: "u" + (i + 1), players: [], taxi: [], reserve: [], settings: {} }));
    for (const [pos, k] of Object.entries(need)) {
      const pool = byPos(pos);
      let idx = 0;
      for (let round = 0; round < k; round++) {
        const order = round % 2 ? rosters.slice().reverse() : rosters;
        for (const r of order) { if (idx > 8 && idx + 1 < pool.length && rnd() < 0.08) idx++; r.players.push(pool[Math.min(idx++, pool.length - 1)].player_id); }
      }
    }
    const weeksPlayed = 11, cw = 12;
    const score = (p, w) => (bye[p.team] === w ? 0 : Math.max(0, Math.round((p._mu + gauss() * p._mu * 0.4) * 10) / 10));
    const sched = {};
    for (let w = 1; w <= 14; w++) {
      const ids = rosters.map((r) => r.roster_id).sort(() => rnd() - 0.5);
      sched[w] = []; for (let i = 0; i < ids.length; i += 2) sched[w].push([ids[i], ids[i + 1]]);
    }
    const matchups = {};
    const lineupPts = (r, pts) => {
      const pool = r.players.map((pid) => ({ pid, pts: pts[pid] || 0, pos: players[pid].position }));
      return bestLineup(pool, startSlots(slots), {});
    };
    for (let w = 1; w <= cw; w++) {
      matchups[w] = [];
      sched[w].forEach(([a, c], mi) => {
        for (const rid of [a, c]) {
          const r = rosters[rid - 1];
          const pts = {};
          for (const pid of r.players) {
            const p = players[pid];
            if (w === cw) pts[pid] = rnd() < 0.3 ? score(p, w) : 0;          // week in progress
            else pts[pid] = (p.injury_status === "IR" && w > 6) ? 0 : score(p, w);
          }
          const lu = lineupPts(r, pts);
          matchups[w].push({ roster_id: rid, matchup_id: mi + 1, points: Math.round(lu.total * 100) / 100, players: r.players, players_points: pts,
            starters: lu.used.map((x) => x.pid), starters_points: lu.used.map((x) => x.pts) });
        }
      });
    }
    // final standings through week 11
    const rec = {};
    for (const r of rosters) rec[r.roster_id] = { wins: 0, losses: 0, ties: 0, fpts: 0 };
    for (let w = 1; w <= weeksPlayed; w++) {
      const by = {};
      for (const row of matchups[w]) { rec[row.roster_id].fpts += row.points; (by[row.matchup_id] = by[row.matchup_id] || []).push(row); }
      for (const [a, c] of Object.values(by)) {
        if (a.points > c.points) { rec[a.roster_id].wins++; rec[c.roster_id].losses++; }
        else if (c.points > a.points) { rec[c.roster_id].wins++; rec[a.roster_id].losses++; }
        else { rec[a.roster_id].ties++; rec[c.roster_id].ties++; }
      }
    }
    for (const r of rosters) { const x = rec[r.roster_id]; const cents = Math.round(x.fpts * 100); r.settings = { wins: x.wins, losses: x.losses, ties: x.ties, fpts: Math.floor(cents / 100), fpts_decimal: cents % 100 }; }
    const users = NAMES.map((n, i) => ({ user_id: "u" + (i + 1), display_name: "owner" + (i + 1), metadata: { team_name: n } }));
    const league = { league_id: "sample", previous_league_id: "sample2025", status: "in_season",
      name: opts.dynasty ? "Sample dynasty league" : "Sample league", season: "2026", roster_positions: slots,
      settings: { playoff_week_start: 15, playoff_teams: 7, type: opts.dynasty ? 2 : 0, draft_rounds: 4 },
      scoring_settings: { rec: 1, pass_yd: 0.04, pass_td: 4, rush_yd: 0.1, rush_td: 6, rec_yd: 0.1, rec_td: 6 } };
    // NFL opponents: rotate the teams each week (teams on bye still get a listed opponent; harmless)
    const nflOpp = (team, w) => { const order = NFL.slice(w % 32).concat(NFL.slice(0, w % 32)); const i = order.indexOf(team); return order[i % 2 ? i - 1 : i + 1]; };
    // weekly stats feed: rostered players match their matchup points, everyone else gets a fresh score
    const statsCache = {};
    const statsRows = (w) => {
      if (w > cw) return [];
      if (statsCache[w]) return statsCache[w];
      const known = {};
      for (const row of matchups[w] || []) Object.assign(known, row.players_points);
      return (statsCache[w] = plist.map((p) => {
        const v = p.player_id in known ? known[p.player_id] : (w === cw && rnd() < 0.7) || (p.injury_status === "IR" && w > 6) ? 0 : score(p, w);
        const gp = bye[p.team] === w || (p.injury_status === "IR" && w > 6) || (w === cw && !v) ? 0 : 1;
        return { player_id: p.player_id, team: p.team, opponent: nflOpp(p.team, w), stats: gp ? { gp, pts_ppr: v } : {} };
      }));
    };
    const projRows = (w) => plist.map((p) => {
      let v = bye[p.team] === w ? 0 : p._mu * (0.9 + 0.2 * rnd());
      if (p.injury_status === "IR" || (p.injury_status === "Out" && w === cw)) v = 0;
      const pl = { first_name: p.first_name, last_name: p.last_name, position: p.position, fantasy_positions: p.fantasy_positions, team: p.team, injury_status: p.injury_status };
      return { player_id: p.player_id, player: pl, team: p.team, opponent: bye[p.team] === w ? null : nflOpp(p.team, w), stats: { pts_ppr: Math.round(v * 10) / 10 } };
    });
    const db = Object.fromEntries(plist.map((p) => { const { _mu, ...rest } = p; return [p.player_id, rest]; }));
    // two finished earlier seasons (league history): same managers, one new manager in 2024, made-up scores
    const past = {};
    for (const [yr, prev] of [["2025", "sample2024"], ["2024", null]]) {
      const pUsers = users.map((u, i) => (yr === "2024" && i === 11 ? { user_id: "u99", display_name: "oldowner", metadata: { team_name: "Gone But Not Forgotten" } }
        : { ...u, metadata: { team_name: `${u.metadata.team_name}${yr === "2024" ? " ’24" : " ’25"}` } }));
      const pRosters = pUsers.map((u, i) => ({ roster_id: i + 1, owner_id: u.user_id, players: [], settings: {} }));
      const lvl = pRosters.map(() => 105 + gauss() * 12);
      const pm = {};
      for (let w = 1; w <= 14; w++) {
        const ids = pRosters.map((r) => r.roster_id).sort(() => rnd() - 0.5);
        pm[w] = [];
        for (let i = 0; i < ids.length; i += 2) for (const rid of [ids[i], ids[i + 1]])
          pm[w].push({ roster_id: rid, matchup_id: i / 2 + 1, points: Math.round((lvl[rid - 1] + gauss() * 22) * 100) / 100 });
      }
      past["sample" + yr] = { league: { league_id: "sample" + yr, previous_league_id: prev, status: "complete", name: "Sample league", season: yr,
        roster_positions: slots, settings: { playoff_week_start: 15, playoff_teams: 6, type: 0 }, scoring_settings: league.scoring_settings },
        users: pUsers, rosters: pRosters, matchups: pm };
    }
    return {
      fetchJson: async (url) => {
        let m;
        if ((m = /\/league\/(sample20\d\d)(\/.*)?$/.exec(url))) {
          const P = past[m[1]], rest = m[2] || "";
          if (!P) return null;
          if (!rest) return P.league;
          if (rest === "/users") return P.users;
          if (rest === "/rosters") return P.rosters;
          if ((m = /^\/matchups\/(\d+)$/.exec(rest))) return P.matchups[+m[1]] || [];
          return [];
        }
        if (/\/state\/nfl$/.test(url)) return { season: "2026", season_type: "regular", week: cw };
        if (/\/rosters$/.test(url)) return rosters;
        if (/\/users$/.test(url)) return users;
        if ((m = /\/matchups\/(\d+)$/.exec(url))) return matchups[+m[1]] || [];
        if (/\/players\/nfl$/.test(url)) return db;
        if (/\/traded_picks$/.test(url)) return [
          { season: "2027", round: 1, roster_id: 3, previous_owner_id: 3, owner_id: 1 },
          { season: "2027", round: 2, roster_id: 1, previous_owner_id: 1, owner_id: 5 },
          { season: "2028", round: 1, roster_id: 12, previous_owner_id: 12, owner_id: 2 } ];
        if (/\/drafts$/.test(url)) return [{ season: "2026", status: "complete", settings: { rounds: 4 } }];
        if ((m = /\/projections\/nfl\/2026\/(\d+)/.exec(url))) return projRows(+m[1]);
        if ((m = /\/stats\/nfl\/2026\/(\d+)/.exec(url))) return statsRows(+m[1]);
        if (/\/v1\/league\/[^/]+$/.test(url)) return league;
        throw new Error("sample: unknown url " + url);
      },
    };
  }

  const api = { API, POSITIONS, SLOT_ACCEPTS, TIERS, liveNet, makeSampleNet, loadLeague, computeValues, bestLineup,
    lineupStrength, rosterValue, powerRankings, loadWeekRows, weekPoints, weeklyRankings, loadLeagueHistory, analyzeSeasons, computeDynasty, ageFactor, powerHistory, powerScores, standingsThrough, evaluateTrade, projPoints, tierFor, zscores,
    settings: { BENCH_CREDIT, BENCH_COUNT, DONE_WEIGHT, FULL_GAMES, BYE_CREDIT, WAIVER_RANK, STAR_POWER, STREAM_DISCOUNT, ROSTER_WEEKS, QUESTIONABLE, DOUBTFUL, WEEKLY_PROJ, RECENT_GAMES } };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SleeperCore = api;
})(typeof self !== "undefined" ? self : this);
