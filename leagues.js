/* Sleeper Tools: your leagues.
   The home page looks up a Sleeper username and saves that user's leagues and a default league in this
   browser. Every tool page then gets a "Your leagues" dropdown above its league ID box: pick a league to
   load it, or type any league ID by hand as before. Nothing leaves the browser except calls to Sleeper. */
(function (root) {
  "use strict";
  const API = "https://api.sleeper.app/v1";
  const K = { user: "sleeperUser", leagues: "sleeperLeagues", def: "defaultLeague", last: "oddsLeague" };
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { if (v === null || v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} },
    json(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  async function getJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  // -> { user: {id, username, name}, leagues: [{id, name, season, teams}], season }
  async function fetchUserLeagues(username) {
    const name = String(username || "").trim().replace(/^@/, "");
    if (!name) throw new Error("Enter your Sleeper username.");
    const u = await getJson(`${API}/user/${encodeURIComponent(name)}`);
    if (!u || !u.user_id) throw new Error(`No Sleeper user named "${name}". Check the spelling.`);
    const state = await getJson(`${API}/state/nfl`).catch(() => ({}));
    let season = +(state.league_season || state.season) || new Date().getFullYear();
    let rows = (await getJson(`${API}/user/${u.user_id}/leagues/nfl/${season}`)) || [];
    if (!rows.length) { season -= 1; rows = (await getJson(`${API}/user/${u.user_id}/leagues/nfl/${season}`)) || []; }
    const leagues = rows.map((l) => ({ id: String(l.league_id), name: l.name || `League ${l.league_id}`, season: String(l.season || season), teams: l.total_rosters || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { user: { id: u.user_id, username: u.username || name, name: u.display_name || u.username || name }, leagues, season };
  }
  function save(res) {
    ls.set(K.user, JSON.stringify(res.user));
    ls.set(K.leagues, JSON.stringify(res.leagues));
    const def = ls.get(K.def);
    if (!def || !res.leagues.some((l) => l.id === def)) setDefault(res.leagues.length ? res.leagues[0].id : null);
  }
  function clear() { ls.set(K.user, null); ls.set(K.leagues, null); ls.set(K.def, null); }
  const getUser = () => ls.json(K.user);
  const getLeagues = () => ls.json(K.leagues) || [];
  const getDefault = () => ls.get(K.def);
  function setDefault(id) { ls.set(K.def, id || null); if (id) ls.set(K.last, id); }
  const label = (l) => `${l.name}${l.teams ? ` · ${l.teams} teams` : ""}`;

  /* ---- tool pages: dropdown above the league ID box ---- */
  function attach() {
    const input = document.getElementById("leagueId");
    if (!input || document.getElementById("leaguePick")) return;
    const loadBtn = document.getElementById("run") || document.getElementById("load");
    const lab = document.querySelector('label[for="leagueId"]') || input;
    const leagues = getLeagues();
    const def = getDefault();
    if (def) input.value = def;                 // the default league opens on every page
    const box = document.createElement("div");
    box.className = "lgpick";
    const st = document.createElement("style");
    st.textContent = ".lgpick{margin:0 0 12px}.lgpick label{display:block;font-weight:600;font-size:14px;margin-bottom:4px}" +
      ".lgpick select{width:100%;min-height:44px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;background:var(--surface-2);color:var(--ink);font:inherit}" +
      ".lgpick p{margin:0;font-size:13px;color:var(--muted)}.lgpick a{color:var(--accent);font-weight:600}";
    document.head.appendChild(st);
    if (!leagues.length) {
      box.innerHTML = `<p>Tip: add your Sleeper username on the <a href="index.html">home page</a> to pick from all your leagues here.</p>`;
      lab.parentNode.insertBefore(box, lab);
      return;
    }
    const user = getUser();
    box.innerHTML = `<label for="leaguePick">Your leagues${user ? ` (${esc(user.name)})` : ""}</label><select id="leaguePick">` +
      leagues.map((l) => `<option value="${esc(l.id)}">${esc(label(l))}${l.id === def ? " (default)" : ""}</option>`).join("") +
      `<option value="">Another league: type its ID below</option></select>`;
    lab.parentNode.insertBefore(box, lab);
    const pick = box.querySelector("select");
    const sync = () => { const v = input.value.trim(); pick.value = leagues.some((l) => l.id === v) ? v : ""; };
    sync();
    input.addEventListener("input", sync);
    pick.addEventListener("change", () => {
      if (!pick.value) { input.value = ""; input.focus(); return; }
      input.value = pick.value;
      ls.set(K.last, pick.value);
      if (loadBtn && !loadBtn.disabled) loadBtn.click();
    });
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach);
    else attach();
  }
  root.SleeperLeagues = { fetchUserLeagues, save, clear, getUser, getLeagues, getDefault, setDefault, label };
})(typeof self !== "undefined" ? self : this);
