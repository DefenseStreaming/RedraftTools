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
    const pws = num(st.playoff_week_start, 15) || 15;
    const regEnd = pws - 1;
    const lastWeek = Math.min(18, pws + Math.max(1, Math.ceil(Math.log2(num(st.playoff_teams, 6) || 6))) - 1);
    const um = {};
    for (const u of users || []) um[u.user_id] = u;
    const teams = (rosters || []).map((r) => {
      const u = um[r.owner_id] || {};
      const s = r.settings || {};
      return {
        rid: r.roster_id, name: (u.metadata && u.metadata.team_name) || u.display_name || `Team ${r.roster_id}`,
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

    say("Getting the player list…");
    let db = {};
    try { db = (await net.fetchJson(`${API}/players/nfl`)) || {}; }
    catch (e) { notes.push("Sleeper's player list could not be loaded, so some injury statuses may be missing."); }
    return { leagueId, league, season, scoring: league.scoring_settings || {}, slots: startSlots(league.roster_positions),
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
    for (const t of b.teams) rosterScore[t.rid] = lineupStrength(b, vals, t.players.filter((p) => !t.taxi.has(p)));
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
    const histRate = (pid) => {
      const p = vals.players[pid];
      if (!p) return null;
      return p.games ? 0.5 * p.ppg + 0.5 * (p.projPg || p.ppg) : p.rate;
    };
    for (let w = 1; w <= b.gp; w++) {
      let sc;
      if (w === b.gp && current) sc = Object.fromEntries(current.map((r) => [r.rid, r.score]));
      else {
        const rec = standingsThrough(b, w);
        const rosterAt = {};
        for (const row of b.matchups[w] || []) rosterAt[row.roster_id] = (row.players || []).map(String);
        const rows = b.teams.map((t) => {
          const r = rec[t.rid], g = r.w + r.l + r.t;
          const pool = (rosterAt[t.rid] || t.players).map((pid) => ({ pts: histRate(pid), pos: (vals.players[pid] || {}).pos }))
            .filter((x) => x.pts !== null && x.pos);
          return { rid: t.rid, winPct: g ? (r.w + 0.5 * r.t) / g : 0.5, pf: r.pf, roster: bestLineup(pool, b.slots, vals.repl).total };
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
    const impact = (rid, gives, gets) => {
      const t = team(rid);
      if (!t) return null;
      const base = t.players.filter((p) => !t.taxi.has(p));
      const after = base.filter((p) => !gives.includes(p)).concat(gets);
      const before = lineupStrength(b, vals, base, 99), now = lineupStrength(b, vals, after, 99);
      const spots = gets.length - gives.length;
      const drops = spots > 0 ? after.filter((p) => !t.reserve.has(p)).map((p) => P[p] || { pid: p, name: p, value: 0 })
        .sort((x, y) => x.value - y.value).slice(0, spots).map((p) => p.name) : [];
      return { before, after: now, delta: now - before, drops };
    };
    return { aGet, bGet, lean, level, a: impact(aRid, aGives, bGives), b: impact(bRid, bGives, aGives) };
  }

  /* ---------------- sample league (same code path, fake network) ---------------- */
  function makeSampleNet(seed = 20261127) {
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
          position: pos, fantasy_positions: [pos], team: NFL[Math.floor(rnd() * NFL.length)], injury_status: inj, _mu: mu };
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
    const league = { name: "Sample league", season: "2026", roster_positions: slots, settings: { playoff_week_start: 15, playoff_teams: 7 },
      scoring_settings: { rec: 1, pass_yd: 0.04, pass_td: 4, rush_yd: 0.1, rush_td: 6, rec_yd: 0.1, rec_td: 6 } };
    const projRows = (w) => plist.map((p) => {
      let v = bye[p.team] === w ? 0 : p._mu * (0.9 + 0.2 * rnd());
      if (p.injury_status === "IR" || (p.injury_status === "Out" && w === cw)) v = 0;
      const pl = { first_name: p.first_name, last_name: p.last_name, position: p.position, fantasy_positions: p.fantasy_positions, team: p.team, injury_status: p.injury_status };
      return { player_id: p.player_id, player: pl, team: p.team, stats: { pts_ppr: Math.round(v * 10) / 10 } };
    });
    const db = Object.fromEntries(plist.map((p) => { const { _mu, ...rest } = p; return [p.player_id, rest]; }));
    return {
      fetchJson: async (url) => {
        let m;
        if (/\/state\/nfl$/.test(url)) return { season: "2026", season_type: "regular", week: cw };
        if (/\/rosters$/.test(url)) return rosters;
        if (/\/users$/.test(url)) return users;
        if ((m = /\/matchups\/(\d+)$/.exec(url))) return matchups[+m[1]] || [];
        if (/\/players\/nfl$/.test(url)) return db;
        if ((m = /\/projections\/nfl\/2026\/(\d+)/.exec(url))) return projRows(+m[1]);
        if (/\/v1\/league\/[^/]+$/.test(url)) return league;
        throw new Error("sample: unknown url " + url);
      },
    };
  }

  const api = { API, POSITIONS, SLOT_ACCEPTS, TIERS, liveNet, makeSampleNet, loadLeague, computeValues, bestLineup,
    lineupStrength, powerRankings, powerHistory, powerScores, standingsThrough, evaluateTrade, projPoints, tierFor, zscores,
    settings: { DONE_WEIGHT, FULL_GAMES, BYE_CREDIT, WAIVER_RANK, STAR_POWER, STREAM_DISCOUNT, ROSTER_WEEKS, QUESTIONABLE, DOUBTFUL } };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SleeperCore = api;
})(typeof self !== "undefined" ? self : this);
