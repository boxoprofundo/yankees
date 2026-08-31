/*
 * NYY Ticket Aggregator — orchestration and rendering.
 *
 * 1. Pull every remaining Yankees home game from the free MLB Stats API
 *    (statsapi.mlb.com, keyless and CORS-enabled).
 * 2. Ask each marketplace adapter (providers.js) for quotes at the chosen
 *    block size, and merge in prices collected out-of-browser by the scraper.
 * 3. Aggregate: for every stadium section, the single cheapest block across
 *    the games in scope and all marketplaces.
 *
 * Two search scopes share the same machinery: "all" (every remaining home
 * game) and "specific" (only the games ticked in the picker).
 */

(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const TEAM_ID = 147; // New York Yankees
  const SETTINGS_KEY = "ytf-settings";
  const PRICE_HISTORY_KEY = "ytf-price-history"; // { "qty|section": price } from last run

  const state = {
    games: null,          // all remaining home games
    picked: null,         // Set of gamePk chosen in the specific-games picker
    sectionRows: [],
    // Ordered list of sort criteria, most-significant first. Clicking a header
    // makes that column primary and pushes the previous keys down as
    // tiebreakers, so an earlier sort is retained when you sort on a second
    // column. Index 0 is the primary sort. Default: custom seating order
    // (deck/infield-outfield buckets), then home-plate distance within each.
    sortKeys: [{ key: "seating", asc: true }],
    lastQty: 2,
  };

  /* ------------------------------ settings ------------------------------ */

  function loadSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch {
      return {};
    }
  }

  function saveSettings() {
    const s = {
      tmKey: $("#tm-key").value.trim(),
      sgKey: $("#sg-key").value.trim(),
      ghToken: $("#gh-token").value.trim(),
      homeRunner: $("#home-runner").checked,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    const note = $("#settings-saved");
    note.hidden = false;
    setTimeout(() => (note.hidden = true), 2500);
    return s;
  }

  function loadPriceHistory() {
    try {
      return JSON.parse(localStorage.getItem(PRICE_HISTORY_KEY)) || {};
    } catch {
      return {};
    }
  }

  function savePriceHistory(map) {
    try {
      localStorage.setItem(PRICE_HISTORY_KEY, JSON.stringify(map));
    } catch {
      /* storage full / disabled — arrows just won't show next time */
    }
  }

  /* ------------------------------- status ------------------------------- */

  function setStatus(msg, isError) {
    const el = $("#status");
    if (!msg) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.textContent = msg;
    el.classList.toggle("error", !!isError);
  }

  /* ------------------------------ schedule ------------------------------ */

  const fmtET = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
  // Compact date for the dense section table: no weekday, keeps the column tight.
  const fmtCompact = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  const fmtISO = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const fmtShort = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "numeric", day: "numeric", year: "numeric",
  });

  async function fetchRemainingHomeGames() {
    const today = fmtISO.format(new Date());
    const year = new Date().getFullYear();
    const url =
      "https://statsapi.mlb.com/api/v1/schedule?sportId=1" +
      `&teamId=${TEAM_ID}&startDate=${today}&endDate=${year}-11-15` +
      "&gameTypes=R,F,D,L,W";
    const res = await fetch(url);
    if (!res.ok) throw new Error("MLB schedule HTTP " + res.status);
    const data = await res.json();
    const games = [];
    for (const day of data.dates || []) {
      for (const g of day.games || []) {
        if (g.teams.home.team.id !== TEAM_ID) continue;
        if (g.status.abstractGameState === "Final") continue;
        const dateUTC = new Date(g.gameDate);
        if (dateUTC.getTime() < Date.now() - 4 * 3600 * 1000) continue;
        games.push({
          gamePk: g.gamePk,
          dateUTC,
          opponent: g.teams.away.team.name,
          displayET: fmtET.format(dateUTC),
          compactET: fmtCompact.format(dateUTC),
          isoDateET: fmtISO.format(dateUTC),
          dateShort: fmtShort.format(dateUTC),
        });
      }
    }
    games.sort((a, b) => a.dateUTC - b.dateUTC);
    return games;
  }

  /* --------------------- cached / collected listings -------------------- */

  const SCRAPER_REPO = "boxoprofundo/ticket-scraper";
  const SCRAPER_API = `https://api.github.com/repos/${SCRAPER_REPO}`;
  const SCRAPE_WORKFLOW = "yankees-scrape.yml";
  const SCRAPE_WORKFLOW_HOME = "yankees-scrape-home.yml";
  const POLL_MS = 20000;

  function ghHeaders(token, raw) {
    return {
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      Authorization: "Bearer " + token,
    };
  }

  // Prices collected outside the browser, freshest source first:
  //  1. published/ in the scraper repo (needs the access key);
  //  2. this site's own data/ files (for visitors without a key).
  // A quantity-specific file (listings-4.json) wins over the generic one.
  async function fetchOneListing(qty, base) {
    const { ghToken } = loadSettings();
    const sources = [];
    for (const name of [`${base}-${qty}.json`, `${base}.json`]) {
      if (ghToken) {
        sources.push({
          url: `${SCRAPER_API}/contents/published/${name}?ref=main`,
          opts: { headers: ghHeaders(ghToken, true), cache: "no-cache" },
        });
      }
      sources.push({ url: `data/${name}`, opts: { cache: "no-cache" } });
    }
    for (const s of sources) {
      try {
        const res = await fetch(s.url, s.opts);
        if (!res.ok) continue;
        return await res.json();
      } catch {
        /* try next */
      }
    }
    return null;
  }

  // The cloud run writes "listings" (everything but StubHub); a home run
  // writes "listings-stubhub". Merge both.
  // Collected sources, each written by a different run:
  //   listings          — the cloud run (XP, Vivid Seats, Gametime, …)
  //   listings-tm       — the home runner (Ticketmaster + TickPick, clean IP)
  //   listings-stubhub  — the browser collector (StubHub, real Chrome)
  //   listings-seatgeek — the browser collector (SeatGeek, real Chrome)
  // Merge whatever exists; the newest fetchedAt is shown as the collected time.
  async function fetchCachedListings(qty) {
    const parts = await Promise.all(
      ["listings", "listings-tm", "listings-stubhub", "listings-seatgeek"]
        .map((name) => fetchOneListing(qty, name))
    );
    if (parts.every((p) => !p)) return null;
    const quotes = parts.reduce(
      (acc, p) => acc.concat(p && Array.isArray(p.quotes) ? p.quotes : []), []);
    const times = parts.filter((x) => x && x.fetchedAt).map((x) => x.fetchedAt);
    return { fetchedAt: times.sort().slice(-1)[0] || null, quotes };
  }

  // Persistent face-value store: { "gamePk|section": number }. "Prices may
  // fluctuate, but face value is forever," so the scraper accumulates these.
  async function fetchFaceValues() {
    const { ghToken } = loadSettings();
    const sources = [];
    if (ghToken) {
      sources.push({
        url: `${SCRAPER_API}/contents/published/face-values.json?ref=main`,
        opts: { headers: ghHeaders(ghToken, true), cache: "no-cache" },
      });
    }
    sources.push({ url: "data/face-values.json", opts: { cache: "no-cache" } });
    for (const s of sources) {
      try {
        const res = await fetch(s.url, s.opts);
        if (!res.ok) continue;
        const data = await res.json();
        return data && typeof data === "object" ? data.faces || data : {};
      } catch {
        /* try next */
      }
    }
    return {};
  }

  /* --------------------------- refresh prices --------------------------- */

  let pollTimer = null;

  const reenableRefresh = () => $$(".refresh-btn").forEach((b) => (b.disabled = false));

  async function refreshPrices(scope) {
    const qty = readQty(scope);
    const settings = loadSettings();
    const ghToken = settings.ghToken;
    if (!ghToken) {
      selectTab("settings");
      $("#gh-token").focus();
      setStatus(
        "The Refresh button needs a one-time access key — add it in Settings " +
        "(opened for you), then press Save.",
        true
      );
      return;
    }

    // With the home runner on, fan out: the Mac scrapes only Ticketmaster
    // while the cloud does everything else, concurrently and into separate
    // files the site merges. Without it, one cloud run covers all sites.
    const jobs = settings.homeRunner
      ? [
          { file: SCRAPE_WORKFLOW, inputs: { qty: String(qty), skip: "StubHub Ticketmaster" }, home: false },
          { file: SCRAPE_WORKFLOW_HOME, inputs: { qty: String(qty) }, home: true },
        ]
      : [{ file: SCRAPE_WORKFLOW, inputs: { qty: String(qty) }, home: false }];

    $$(".refresh-btn").forEach((b) => (b.disabled = true));
    try {
      const startedAt = Date.now();
      for (const j of jobs) {
        const res = await fetch(
          `${SCRAPER_API}/actions/workflows/${j.file}/dispatches`,
          {
            method: "POST",
            headers: ghHeaders(ghToken),
            body: JSON.stringify({ ref: "main", inputs: j.inputs }),
          }
        );
        if (res.status !== 204) {
          const body = await res.text();
          throw new Error(`GitHub answered ${res.status} for ${j.file}: ${body.slice(0, 160)}`);
        }
      }
      setStatus(
        settings.homeRunner
          ? `Refresh started (blocks of ${qty}): your Mac is scraping Ticketmaster ` +
            "while the cloud handles the rest. Keep the Mac awake — prices load " +
            "here automatically when both finish."
          : `Price scrape started for blocks of ${qty} — usually 5–10 minutes. ` +
            "Fresh prices will load here automatically when it finishes."
      );
      watchScrape(scope, startedAt, jobs);
    } catch (err) {
      console.error(err);
      reenableRefresh();
      setStatus(
        "Couldn't start the scraper: " + err.message +
        " — check the access key in Settings.",
        true
      );
    }
  }

  // Poll every dispatched workflow's latest run; reload prices once all have
  // completed (or on timeout, so a stuck home runner can't block the rest).
  function watchScrape(scope, startedAt, jobs) {
    clearInterval(pollTimer);
    const label = (j) => (j.home ? "your Mac (Ticketmaster)" : "the cloud");
    const done = {}; // workflow file -> conclusion

    pollTimer = setInterval(async () => {
      const mins = Math.round((Date.now() - startedAt) / 60000);
      if (Date.now() - startedAt > 25 * 60000) {
        clearInterval(pollTimer);
        reenableRefresh();
        const stuck = jobs.filter((j) => !done[j.file]).map(label).join(" and ");
        setStatus(
          `Loading what's ready… ${stuck} didn't finish in time` +
          (jobs.some((j) => j.home) ? " (is the Mac awake and the helper installed?)." : "."),
          true
        );
        await runSearch(scope);
        return;
      }
      try {
        const { ghToken } = loadSettings();
        for (const j of jobs) {
          if (done[j.file]) continue;
          const res = await fetch(
            `${SCRAPER_API}/actions/workflows/${j.file}/runs?per_page=1`,
            { headers: ghHeaders(ghToken) }
          );
          if (!res.ok) continue;
          const run = ((await res.json()).workflow_runs || [])[0];
          if (!run || Date.parse(run.created_at) < startedAt - 60000) continue;
          if (run.status === "completed") done[j.file] = run.conclusion || "completed";
        }
        const pending = jobs.filter((j) => !done[j.file]);
        if (pending.length) {
          setStatus(
            `Still scraping: ${pending.map(label).join(" and ")} (${mins} min elapsed). ` +
            "Prices load here automatically when done."
          );
          return;
        }
        clearInterval(pollTimer);
        reenableRefresh();
        const failed = jobs.filter((j) => done[j.file] !== "success");
        setStatus(
          failed.length
            ? `Loading fresh prices… (${failed.map(label).join(", ")} ended as ` +
              `${failed.map((j) => done[j.file]).join(", ")} — you can Refresh again.)`
            : "Scrape finished — loading fresh prices…"
        );
        await runSearch(scope);
      } catch (err) {
        console.error(err);
      }
    }, POLL_MS);
  }

  /* ------------------------------- search ------------------------------- */

  function readQty(scope) {
    const el = scope === "specific" ? $("#qty-specific") : $("#qty-all");
    return Math.max(1, Math.min(12, parseInt(el.value, 10) || 2));
  }

  function gamesInScope(scope) {
    if (scope !== "specific") return state.games;
    const picked = state.picked || new Set();
    return state.games.filter((g) => picked.has(g.gamePk));
  }

  async function runSearch(scope) {
    if (!state.games) {
      try {
        state.games = await fetchRemainingHomeGames();
        renderGamePicker();
      } catch (err) {
        setStatus("Couldn't load the schedule: " + err.message, true);
        return;
      }
    }
    const qty = readQty(scope);
    state.lastQty = qty;
    const settings = loadSettings();
    const allGames = state.games;
    const games = gamesInScope(scope);

    if (!allGames.length) {
      setStatus("No remaining Yankees home games were found on the MLB schedule.", true);
      return;
    }
    if (!games.length) {
      setStatus("Pick at least one game to search.", true);
      return;
    }

    $$(".search-btn").forEach((b) => (b.disabled = true));
    setStatus(`Searching ${games.length} game${games.length > 1 ? "s" : ""} across ${window.PROVIDERS.length} marketplaces…`);

    try {
      // Provider adapters query all games; cached listings + face values too.
      const [cached, faces, ...results] = await Promise.allSettled([
        fetchCachedListings(qty),
        fetchFaceValues(),
        ...window.PROVIDERS.map((p) => p.search(allGames, qty, settings)),
      ]);

      const quotes = [];
      const failed = [];
      let cachedAt = null;

      const listings = cached.status === "fulfilled" ? cached.value : null;
      if (listings && Array.isArray(listings.quotes)) {
        quotes.push(...listings.quotes);
        cachedAt = listings.fetchedAt || null;
      }
      results.forEach((r, i) => {
        if (r.status === "fulfilled") quotes.push(...r.value);
        else {
          failed.push(window.PROVIDERS[i].name);
          console.error(window.PROVIDERS[i].name, r.reason);
        }
      });
      const faceMap = faces.status === "fulfilled" ? faces.value : {};

      render(allGames, games, quotes, qty, faceMap);

      let note = failed.length
        ? `Some sources failed and were skipped: ${failed.join(", ")}. `
        : "";
      if (cachedAt) {
        note += `Includes prices auto-collected ${new Date(cachedAt).toLocaleString()}. `;
      } else {
        note +=
          "No collected prices loaded yet for this block size — press " +
          "↻ Refresh prices to run the scraper, then they'll load here " +
          "automatically. Store links below work either way.";
      }
      setStatus(note || null, !!failed.length);
    } catch (err) {
      console.error(err);
      setStatus("Search failed: " + err.message, true);
    } finally {
      $$(".search-btn").forEach((b) => (b.disabled = false));
    }
  }

  /* ------------------------------ rendering ------------------------------ */

  function fmtMoney(v) {
    return v == null
      ? "—"
      : "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Whole-dollar money for the dense section table (no cents → thinner columns).
  function fmtMoney0(v) {
    return v == null ? "—" : "$" + Math.round(v).toLocaleString("en-US");
  }

  function render(allGames, scopeGames, quotes, qty, faceMap) {
    const byGame = new Map(allGames.map((g) => [g.gamePk, g]));
    const scopeSet = new Set(scopeGames.map((g) => g.gamePk));

    renderSectionTable(scopeGames, scopeSet, quotes, qty, byGame, faceMap);
    renderGameTable(scopeGames, quotes);
  }

  // Look up a stored per-section face value for a game/section, trying the
  // section's canonical code and its raw form. Returns null when we have no
  // real face for that exact section — we deliberately do NOT fall back to the
  // game's cheapest price, which would stamp premium sections (e.g. Legends)
  // with the stadium minimum and show absurd faces like $28 on Legends.
  function faceFor(faceMap, gamePk, cls, rawSection) {
    const keys = [`${gamePk}|${cls.code}`, `${gamePk}|${rawSection}`];
    for (const k of keys) {
      if (faceMap && faceMap[k] != null) return faceMap[k];
    }
    return null;
  }

  function renderSectionTable(games, scopeSet, quotes, qty, byGame, faceMap) {
    const wrap = $("#section-results");
    const soonest = games[0]; // games are date-sorted; used for empty-row StubHub links

    // Union of every real section seen anywhere in the data (all games), so
    // sections with no block in the current scope still get a row + StubHub
    // link. Fold raw codes to canonical form to kill duplicates.
    const canon = new Map(); // code -> classified
    for (const q of quotes) {
      if (!q.section) continue;
      const cls = window.Sections.classify(q.section);
      if (!cls.code) continue;
      if (!canon.has(cls.code)) canon.set(cls.code, cls);
    }

    if (!canon.size) {
      wrap.hidden = true;
      return;
    }

    // Cheapest in-scope block per canonical section.
    const best = new Map(); // code -> { q, cls }
    for (const q of quotes) {
      if (!q.section || q.price == null) continue;
      if (!scopeSet.has(q.gamePk)) continue;
      const cls = window.Sections.classify(q.section);
      if (!cls.code) continue;
      const cur = best.get(cls.code);
      if (!cur || q.price < cur.q.price) best.set(cls.code, { q, cls });
    }

    // Per-game SeatGeek event URL, harvested from the SeatGeek quotes (the
    // adapter emits one per game — a real event page, or a search fallback).
    const sgUrlByGame = new Map();
    for (const q of quotes) {
      if (q.provider === "SeatGeek" && q.url && !sgUrlByGame.has(q.gamePk)) {
        sgUrlByGame.set(q.gamePk, q.url);
      }
    }
    const seatgeekLink = (g) =>
      (g && sgUrlByGame.get(g.gamePk)) ||
      "https://seatgeek.com/search?search=" +
        encodeURIComponent(`New York Yankees ${g ? g.opponent : ""} ${g ? g.dateShort : ""}`);

    const history = loadPriceHistory();
    const nextHistory = {};

    state.sectionRows = [...canon.values()].map((cls) => {
      const hit = best.get(cls.code);
      const q = hit ? hit.q : null;
      const game = q ? byGame.get(q.gamePk) : null;
      const face = q
        ? faceFor(faceMap, q.gamePk, cls, q.section)
        : null;
      const price = q ? q.price : null;

      // Price-change arrow vs the previous run at this block size.
      const histKey = `${qty}|${cls.code}`;
      const prev = history[histKey];
      let trend = 0; // -1 down, +1 up, 0 same/new
      if (price != null && prev != null) {
        if (price < prev - 0.005) trend = -1;
        else if (price > prev + 0.005) trend = 1;
      }
      if (price != null) nextHistory[histKey] = price;

      // SeatGeek link: this game if we have one, else the soonest in scope.
      const linkGame = game || soonest;

      return {
        code: cls.code,
        display: cls.display || cls.code,
        cls,
        level: cls.level,
        location: cls.location,
        label: cls.label,
        num: cls.num,
        price,
        trend,
        total: price != null ? price * qty : null,
        face,
        pctFace: price != null && face ? (price / face) * 100 : null,
        date: game ? game.dateUTC.getTime() : null,
        dateLabel: game ? game.displayET : "",
        opponent: game ? game.opponent : "",
        provider: q ? q.provider : "",
        url: q ? q.url : "",
        seatgeek: linkGame ? seatgeekLink(linkGame) : "",
      };
    });

    savePriceHistory(nextHistory);

    // Seat-quality rank: fixed 1..N in the default seating order, so it stays
    // meaningful no matter how the table is currently sorted (and sorting by
    // the Rank column returns rows to seat-quality order).
    [...state.sectionRows]
      .sort((a, b) => cmpKey(a, b, "seating", true))
      .forEach((r, i) => { r.rank = i + 1; });

    $("#section-sub").textContent =
      `— block of ${qty} ticket${qty > 1 ? "s" : ""}, cheapest across ` +
      `${games.length} game${games.length > 1 ? "s" : ""} in scope`;
    sortAndPaintSections();
    wrap.hidden = false;
  }

  // Map a value to a green→red gradient across the visible [lo, hi] range:
  // low = green (cheapest / best), high = red (priciest / worst).
  function gradColor(v, lo, hi) {
    if (v == null) return "";
    let t = hi > lo ? (v - lo) / (hi - lo) : 0;
    t = Math.max(0, Math.min(1, t));
    const hue = 120 - 120 * t; // 120 green → 0 red
    return `hsl(${hue}, 70%, 38%)`;
  }

  // Home-plate proximity for a row: distance = |lastTwoDigits - 20|, and a
  // side flag so the higher-numbered side sorts first within a tie.
  function plateInfo(row) {
    if (row.num == null) return null;
    const d = row.num % 100;
    return { dist: Math.abs(d - 20), side: d >= 20 ? 0 : 1 };
  }

  // Custom seating-order bucket for the default sort. Best views first:
  // Legends, then infield/outfield by deck interleaved as requested. Decks are
  // keyed off the numeric hundreds tier (100s/200s/300s/400s), so Bleachers
  // (201–204, 235–239) count as outfield 200s just like any other section.
  // Non-numbered sections (Suite, Audi Club, Standing Room, Other) sink to end.
  function bucketRank(row) {
    if (row.level === "Legends") return 0;
    if (row.num != null) {
      const tier = Math.floor(row.num / 100); // 1=100s … 4=400s
      const inf = row.location === "Infield" || row.location === "Home Plate";
      if (tier === 1) return inf ? 1 : 3;
      if (tier === 2) return inf ? 2 : 5;
      if (tier === 3) return inf ? 4 : 7;
      if (tier === 4) return inf ? 6 : 8;
    }
    return 99;
  }

  // Compare two rows on one sort key, honouring direction. Nulls always sink
  // to the bottom regardless of direction so blank rows don't interleave.
  function cmpKey(a, b, key, asc) {
    if (key === "section") {
      const c = window.Sections.compare(a.cls, b.cls);
      return asc ? c : -c;
    }
    if (key === "level") {
      // Order by deck (Legends→Grandstand), not alphabetically.
      const wa = window.Sections.LEVEL_ORDER[a.level] ?? 99;
      const wb = window.Sections.LEVEL_ORDER[b.level] ?? 99;
      const c = wa < wb ? -1 : wa > wb ? 1 : 0;
      return asc ? c : -c;
    }
    if (key === "seating") {
      // Custom seating buckets first (Legends, infield/outfield decks), then
      // home-plate distance within each: |lastTwoDigits - 20|, higher side
      // winning ties (21 before 19), then section number.
      const ba = bucketRank(a), bb = bucketRank(b);
      let c;
      if (ba !== bb) {
        c = ba - bb;
      } else {
        const pa = plateInfo(a), pb = plateInfo(b);
        if (pa && pb) {
          c = pa.dist - pb.dist || pa.side - pb.side ||
              window.Sections.compare(a.cls, b.cls);
        } else if (pa) c = -1;
        else if (pb) c = 1;
        else c = window.Sections.compare(a.cls, b.cls);
      }
      return asc ? c : -c;
    }
    const va = a[key], vb = b[key];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const c = va < vb ? -1 : va > vb ? 1 : 0;
    return asc ? c : -c;
  }

  function sortAndPaintSections() {
    const rows = [...state.sectionRows];

    // Walk the sort keys most-significant first; the first that separates the
    // two rows wins, so earlier sorts act as tiebreakers for later ones.
    rows.sort((a, b) => {
      for (const s of state.sortKeys) {
        const c = cmpKey(a, b, s.key, s.asc);
        if (c) return c;
      }
      return 0;
    });

    // % of face gradient bounds across rows that have a value.
    const pcts = rows.map((r) => r.pctFace).filter((v) => v != null);
    const lo = pcts.length ? Math.min(...pcts) : 0;
    const hi = pcts.length ? Math.max(...pcts) : 1;

    // Price-per-ticket gradient bounds across rows that have a price.
    const prices = rows.map((r) => r.price).filter((v) => v != null);
    const plo = prices.length ? Math.min(...prices) : 0;
    const phi = prices.length ? Math.max(...prices) : 1;

    const tbody = $("#section-table tbody");
    tbody.innerHTML = "";
    for (const r of rows) {
      const tr = document.createElement("tr");

      const sgCell =
        `<td class="link-cell"><a href="${r.seatgeek}" target="_blank" rel="noopener" ` +
        `title="Opens this game on SeatGeek; then pick section ${r.display} on the seat map">` +
        `§<span class="sec-code">${r.display}</span> ↗</a></td>`;

      // Cap the code so a rare long non-numeric code (e.g. "TERRACEDUGOUT3")
      // can't widen the whole column; the full value stays available on hover.
      const sectionCell =
        `<td><span class="sec-code" title="${r.display}">${r.display}</span>` +
        (r.cls.obstructed ? ' <span class="obstructed">obstructed</span>' : "") +
        `</td>`;

      // Level badge in its own sortable column. Abbreviate the long ones so the
      // badge (and column) stay tight; full name is on the tooltip.
      const levelAbbr = { "Standing Room": "SR" };
      const levelText = levelAbbr[r.level] || r.level;
      const levelCell =
        `<td><span class="badge lvl-${r.level.replace(/\s/g, "")}" title="${r.level}">${levelText}</span></td>`;

      // Own column so it can be sorted; abbreviated label, full word as tooltip.
      const LOC_ABBR = { "Home Plate": "HP", "Infield": "IF", "Outfield": "OF" };
      const locCell = r.location
        ? `<td><span class="badge loc-${r.location.replace(/\s/g, "")}" title="${r.location}">` +
          `${LOC_ABBR[r.location] || r.location}</span></td>`
        : `<td class="na">—</td>`;

      const rankCell = `<td class="rank">${r.rank}</td>`;

      if (r.price == null) {
        tr.innerHTML =
          rankCell +
          sectionCell +
          levelCell +
          locCell +
          `<td class="na noblock" colspan="6"></td>` +
          sgCell;
      } else {
        // The arrow alone carries the up/down colour; the price value itself is
        // painted on a green→red gradient (cheapest green, priciest red).
        const arrow =
          r.trend < 0 ? '<span class="trend down">▼</span>'
          : r.trend > 0 ? '<span class="trend up">▲</span>'
          : "";
        const priceStyle = ` style="color:${gradColor(r.price, plo, phi)}"`;
        const pctStyle = r.pctFace != null
          ? ` style="color:${gradColor(r.pctFace, lo, hi)};font-weight:700"`
          : "";
        const pctText = r.pctFace != null ? Math.round(r.pctFace) + "%" : "—";
        tr.innerHTML =
          rankCell +
          sectionCell +
          levelCell +
          locCell +
          `<td class="price">${arrow}<span${priceStyle}>${fmtMoney0(r.price)}</span></td>` +
          `<td>${fmtMoney0(r.face)}</td>` +
          `<td${pctStyle}>${pctText}</td>` +
          `<td>${r.dateLabel}</td>` +
          `<td>${r.opponent}</td>` +
          `<td>${r.url
            ? `<a href="${r.url}" target="_blank" rel="noopener">${r.provider} →</a>`
            : r.provider}</td>` +
          sgCell;
      }
      tbody.appendChild(tr);
    }
  }

  function renderGameTable(games, quotes) {
    // Provider columns ordered alphabetically by site name.
    const providerNames = window.PROVIDERS.map((p) => p.name)
      .sort((a, b) => a.localeCompare(b));

    const byGameProvider = new Map();
    for (const q of quotes) {
      const key = q.gamePk + "|" + q.provider;
      const prev = byGameProvider.get(key);
      if (q.price == null) {
        if (!prev) byGameProvider.set(key, q);
      } else if (!prev || prev.price == null || q.price < prev.price) {
        byGameProvider.set(key, q);
      }
    }

    // Header: Date | Game | <providers…>
    const head = $("#game-head");
    head.innerHTML =
      "<th>Date &amp; time</th><th>Game</th>" +
      providerNames.map((n) => `<th>${n}</th>`).join("");

    const tbody = $("#game-table tbody");
    tbody.innerHTML = "";
    for (const g of games) {
      const cells = providerNames.map((name) => {
        const q = byGameProvider.get(g.gamePk + "|" + name);
        if (!q) return `<td class="na">—</td>`;
        const label = q.price != null ? fmtMoney0(q.price) : "search →";
        const cls = q.price != null ? "price" : "";
        if (!q.url) return `<td class="${cls}">${label}</td>`;
        return `<td class="${cls}"><a href="${q.url}" target="_blank" rel="noopener">${label}</a></td>`;
      });
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td>${g.displayET}</td><td>vs ${g.opponent}</td>` + cells.join("");
      tbody.appendChild(tr);
    }
    $("#game-results").hidden = false;
  }

  /* --------------------------- game picker ------------------------------ */

  function renderGamePicker() {
    const host = $("#game-list");
    if (!state.games) return;
    if (!state.picked) state.picked = new Set(state.games.map((g) => g.gamePk));
    host.innerHTML = "";
    for (const g of state.games) {
      const id = "game-" + g.gamePk;
      const row = document.createElement("label");
      row.className = "game-opt";
      // Date/time on top, team underneath — narrower cards, more per row.
      row.innerHTML =
        `<input type="checkbox" id="${id}" value="${g.gamePk}" ` +
        `${state.picked.has(g.gamePk) ? "checked" : ""}>` +
        `<span class="g-meta">` +
        `<span class="g-date">${g.displayET}</span>` +
        `<span class="g-opp">vs ${g.opponent}</span>` +
        `</span>`;
      row.querySelector("input").addEventListener("change", (e) => {
        if (e.target.checked) state.picked.add(g.gamePk);
        else state.picked.delete(g.gamePk);
        syncSelectAll();
      });
      host.appendChild(row);
    }
    // Column-major fill: N rows so the games flow down each column, wrapping
    // to the next column, capped at ~5 columns wide.
    const rows = Math.max(1, Math.ceil(state.games.length / 5));
    host.style.gridTemplateRows = `repeat(${rows}, auto)`;
    syncSelectAll();
  }

  // Keep the master "Select all" checkbox in sync: checked when all picked,
  // unchecked when none, indeterminate in between.
  function syncSelectAll() {
    const cb = $("#pick-all-cb");
    if (!cb || !state.games) return;
    const total = state.games.length;
    const n = state.picked ? state.picked.size : 0;
    cb.checked = n === total && total > 0;
    cb.indeterminate = n > 0 && n < total;
  }

  function setAllPicked(on) {
    if (!state.games) return;
    state.picked = new Set(on ? state.games.map((g) => g.gamePk) : []);
    $$("#game-list input[type=checkbox]").forEach((cb) => (cb.checked = on));
    syncSelectAll();
  }

  /* ------------------------------- tabs --------------------------------- */

  function selectTab(name) {
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    $("#panel-all").hidden = name !== "all";
    $("#panel-specific").hidden = name !== "specific";
    $("#panel-settings").hidden = name !== "settings";
    // Results hide on the Settings tab (settings only), reappear elsewhere.
    const showResults = name !== "settings";
    const secHas = $("#section-table tbody").children.length > 0;
    const gameHas = $("#game-table tbody").children.length > 0;
    $("#section-results").hidden = !(showResults && secHas);
    $("#game-results").hidden = !(showResults && gameHas);
  }

  /* --------------------------- stadium map ------------------------------ */

  const MAP_IMG =
    "https://dvvwrk0u94pdu.cloudfront.net/seatingcharts/yankee-seating-chart-1299x1261.jpeg";

  function openMap() {
    const holder = $("#map-holder");
    if (!holder.querySelector("img")) {
      holder.innerHTML =
        `<img src="${MAP_IMG}" alt="Yankee Stadium seating chart" ` +
        `class="map-img" loading="lazy">`;
    }
    $("#map-modal").hidden = false;
  }
  function closeMap() {
    $("#map-modal").hidden = true;
  }

  /* -------------------------------- wiring ------------------------------- */

  document.addEventListener("DOMContentLoaded", () => {
    const s = loadSettings();
    $("#tm-key").value = s.tmKey || "";
    $("#sg-key").value = s.sgKey || "";
    $("#gh-token").value = s.ghToken || "";
    $("#home-runner").checked = !!s.homeRunner;

    $$(".tab").forEach((t) =>
      t.addEventListener("click", () => selectTab(t.dataset.tab))
    );

    $$(".search-btn").forEach((b) =>
      b.addEventListener("click", () => runSearch(b.dataset.scope))
    );
    $$(".refresh-btn").forEach((b) =>
      b.addEventListener("click", () => refreshPrices(b.dataset.scope))
    );
    $$(".qty").forEach((el) =>
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          const scope = el.id === "qty-specific" ? "specific" : "all";
          runSearch(scope);
        }
      })
    );

    $("#save-settings").addEventListener("click", saveSettings);

    $("#pick-all-cb").addEventListener("change", (e) => setAllPicked(e.target.checked));

    $("#open-map").addEventListener("click", (e) => { e.preventDefault(); openMap(); });
    $("#map-close").addEventListener("click", closeMap);
    $("#map-modal").addEventListener("click", (e) => {
      if (e.target.id === "map-modal") closeMap();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeMap();
    });

    $$("#section-table th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        const primary = state.sortKeys[0];
        if (primary && primary.key === key) {
          // Re-clicking the primary column just flips its direction.
          primary.asc = !primary.asc;
        } else {
          // Make this column primary; keep the others as tiebreakers below it
          // (dropping any stale copy of this key) so the previous sort holds.
          state.sortKeys = [
            { key, asc: true },
            ...state.sortKeys.filter((s) => s.key !== key),
          ];
        }
        if (state.sectionRows.length) sortAndPaintSections();
      });
    });

    // Populate the game picker up front so the "specific" tab is usable.
    fetchRemainingHomeGames()
      .then((games) => { state.games = games; renderGamePicker(); })
      .catch((err) => {
        $("#game-list").textContent = "Couldn't load games: " + err.message;
      });
  });
})();
