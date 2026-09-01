// ==UserScript==
// @name         NYY Aggregator — Ticketmaster + SeatGeek + StubHub collector
// @namespace    boxoprofundo.github.io/yankees-tickets
// @version      3.8.0
// @description  Scrapes Ticketmaster, SeatGeek and StubHub Yankees prices from YOUR real logged-in browser (where they render normally) and publishes them to the aggregator. All three block automated browsers, so this is the only reliable way to get their per-section prices.
// @author       boxoprofundo
// @updateURL    https://yankees.mikeboxer.com/collector.user.js
// @downloadURL  https://yankees.mikeboxer.com/collector.user.js
// @match        https://boxoprofundo.github.io/yankees-tickets/*
// @match        https://yankees.mikeboxer.com/*
// @match        https://www.stubhub.com/*
// @match        https://seatgeek.com/*
// @match        https://www.seatgeek.com/*
// @match        https://www.ticketmaster.com/*
// @match        https://www.tickpick.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.github.com
// @connect      app.ticketmaster.com
// @connect      api.seatgeek.com
// @connect      api.tickpick.com
// @run-at       document-start
// ==/UserScript==

/*
 * Why this exists: SeatGeek and StubHub serve *automation* browsers a blank or
 * blocked page, but your real Chrome renders them fine. This userscript runs
 * their scrape inside your genuine browser session, so the listings are there
 * to read, then commits them to the site via the GitHub token you saved in
 * Settings. The site merges listings-seatgeek-<qty>.json and
 * listings-stubhub-<qty>.json like every other source.
 *
 * It only works in the browser where it's installed. Refreshing from a phone
 * still updates the other five sites — just not these two.
 *
 * First-run note for SeatGeek: the very first SeatGeek run also publishes a
 * small diagnostic (yankees-tickets/data/_seatgeek-diag.json) describing the
 * page's listing structure, so the parser can be tuned to the real markup.
 */

(function () {
  "use strict";

  const PAGES_REPO = "boxoprofundo/yankees";
  const JOB_TTL = 30 * 60000;

  // Per-tab network captures (shared between the hook and the worker, which run
  // in the same userscript execution). Each event page is its own tab.
  const SG_CAPTURES = [];   // { url, body } for listing-shaped responses
  const SG_CAP_URLS = [];   // every response URL seen (for diagnostics)

  /* ── StubHub event map (gamePk -> URL) ──────────────────────────────── */
  const SH = (slug, id) =>
    `https://www.stubhub.com/new-york-yankees-bronx-tickets-${slug}/event/${id}/`;
  const STUBHUB_EVENTS = {
    823505: SH("8-25-2026", 159257453), 823506: SH("8-26-2026", 159257454),
    823503: SH("8-27-2026", 159257455), 823504: SH("8-28-2026", 159257456),
    823539: SH("8-29-2026", 159257421), 823501: SH("8-29-2026", 159257457),
    823502: SH("8-30-2026", 159257458), 823500: SH("9-8-2026", 159257459),
    823497: SH("9-9-2026", 159257460),  823499: SH("9-10-2026", 159257461),
    823498: SH("9-11-2026", 159257462), 823496: SH("9-12-2026", 159257463),
    823495: SH("9-13-2026", 159257464), 823543: SH("9-22-2026", 159257415),
    823494: SH("9-22-2026", 159257465), 823492: SH("9-23-2026", 159257466),
    823493: SH("9-24-2026", 159257467), 823491: SH("9-25-2026", 159257468),
    823489: SH("9-26-2026", 159257469), 823490: SH("9-27-2026", 159257470),
  };
  const SH_ID_TO_GAME = {};
  for (const [pk, url] of Object.entries(STUBHUB_EVENTS)) {
    const m = url.match(/event\/(\d+)/);
    if (m) SH_ID_TO_GAME[m[1]] = Number(pk);
  }

  /* ── date → gamePk(s), reused from the StubHub slugs (M-D-YYYY → YYYY-MM-DD).
   * Ticketmaster's Discovery API gives each event a localDate; matching it here
   * maps a TM event to the right gamePk. A date with two gamePks is a
   * doubleheader — resolved by start time when needed. */
  const DATE_TO_PKS = {};
  for (const [pk, url] of Object.entries(STUBHUB_EVENTS)) {
    const m = url.match(/tickets-(\d{1,2})-(\d{1,2})-(\d{4})\//);
    if (!m) continue;
    const iso = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    (DATE_TO_PKS[iso] = DATE_TO_PKS[iso] || []).push(Number(pk));
  }

  // Per-tab captures of Ticketmaster's seat-map (ISM DS / quickpicks) JSON.
  const TM_CAPTURES = [];   // { url, body }
  const TM_CAP_URLS = [];   // every services.ticketmaster.com URL seen

  /* ── SeatGeek event map ──────────────────────────────────────────────
   * SeatGeek doesn't expose gamePk, so each event page's real date+time is
   * read from __NEXT_DATA__ and mapped to a gamePk here. That makes the map
   * self-correcting: even a guessed eventId only contributes if its actual
   * date matches a Yankees home game. Confirmed eventIds come from the team
   * page harvest; 17691597–17691600 are sequential guesses for 9/24–9/27
   * (validated on load).                                                     */
  const SGU = (d, id) =>
    `https://seatgeek.com/new-york-yankees-tickets/${d}-bronx-new-york-yankee-stadium/mlb/${id}`;
  const SEATGEEK_URLS = [
    SGU("8-28-2026", 17691586), SGU("8-29-2026", 17691587), SGU("8-29-2026", 17691551),
    SGU("8-30-2026", 17691588), SGU("9-8-2026", 17691589),  SGU("9-9-2026", 17691590),
    SGU("9-10-2026", 17691591), SGU("9-11-2026", 17691592), SGU("9-12-2026", 17691593),
    SGU("9-13-2026", 17691594), SGU("9-22-2026", 17691595), SGU("9-22-2026", 17691545),
    SGU("9-23-2026", 17691596), SGU("9-24-2026", 17691597), SGU("9-25-2026", 17691598),
    SGU("9-26-2026", 17691599), SGU("9-27-2026", 17691600),
  ];
  // Confirmed SeatGeek eventId -> gamePk (all validated by date/time resolution
  // in earlier runs; doubleheaders split by the 1pm/7pm event). Used by the
  // direct-API collector, which fetches listings by eventId.
  const SG_EID_TO_PK = {
    17691586: 823504, 17691587: 823501, 17691551: 823539, 17691588: 823502,
    17691589: 823500, 17691590: 823497, 17691591: 823499, 17691592: 823498,
    17691593: 823496, 17691594: 823495, 17691595: 823494, 17691545: 823543,
    17691596: 823492, 17691597: 823493, 17691598: 823491, 17691599: 823489,
    17691600: 823490,
  };
  // SeatGeek's public web client id (fixed) for the event_listings_v2 endpoint.
  const SG_CLIENT_ID = "MTY2MnwxMzgzMzIwMTU4";
  const uuid = () => (crypto && crypto.randomUUID ? crypto.randomUUID() :
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16);
    }));
  const sgListingsUrl = (eid, qty) =>
    "https://seatgeek.com/api/event_listings_v2?_include_seats=1&client_id=" + SG_CLIENT_ID +
    "&event_page_view_id=" + uuid() + "&id=" + eid + "&quantity=" + qty +
    "&sixpack_client_id=" + uuid();

  // Single-game dates -> gamePk (derived from the StubHub date slugs).
  const SG_PK_BY_DATE = {
    "2026-08-28": 823504, "2026-08-30": 823502, "2026-09-08": 823500,
    "2026-09-09": 823497, "2026-09-10": 823499, "2026-09-11": 823498,
    "2026-09-12": 823496, "2026-09-13": 823495, "2026-09-23": 823492,
    "2026-09-24": 823493, "2026-09-25": 823491, "2026-09-26": 823489,
    "2026-09-27": 823490,
  };
  // Doubleheaders: day game (≈1pm) vs night game (≈7pm).
  const SG_PK_DH = {
    "2026-08-29": { day: 823539, night: 823501 },
    "2026-09-22": { day: 823543, night: 823494 },
  };
  function sgGamePk(date, hour) {
    if (!date) return null;
    if (SG_PK_DH[date]) return (hour != null && hour < 16) ? SG_PK_DH[date].day : SG_PK_DH[date].night;
    return SG_PK_BY_DATE[date] || null;
  }
  // Normalize a SeatGeek section slug to a plain section id that matches the
  // other providers: "bleachers-204"->"204", "320-b"->"320", "318"->"318".
  function normSGSection(raw) {
    let s = String(raw || "").trim().toLowerCase();
    s = s.replace(/^(sections?|sec)[-_ ]+/, "");
    // Premium/named areas: keep a readable name rather than reducing to a stray
    // number (e.g. "legends-suite-12" must not become section "12").
    if (/suite|mvp|legend|delta|club|lounge|porch|steak|audi|beam|ford|budweiser|party|deck|patio|standing|\bsro\b|premium|dugout/.test(s)) {
      const named = s.replace(/[^a-z0-9]+/g, " ").trim().toUpperCase();
      return named ? named.slice(0, 16) : null;
    }
    // Preserve a real section's trailing letter: Yankee Stadium home-plate and
    // corner sections are lettered (021A, 320B, 420C, 214A). Grab digits plus a
    // single A–D suffix when one directly follows (optionally past one
    // separator) and isn't the start of a word like "ada". Fall back to the
    // bare number for unlettered sections ("bleachers-204" -> "204").
    const m = s.match(/(\d{1,3})[-_ ]?([a-d])(?![a-z])/);
    if (m) return (m[1] + m[2]).toUpperCase();
    const n = s.match(/\d{1,3}/);
    if (n) return n[0];
    const named = s.replace(/[^a-z0-9]+/g, " ").trim().toUpperCase();
    return named ? named.slice(0, 16) : null;
  }

  const SG_EID_TO_URL = {};
  for (const u of SEATGEEK_URLS) { const m = u.match(/\/(\d{5,})/); if (m) SG_EID_TO_URL[m[1]] = u; }

  // Upcoming SeatGeek events (eid + url), earliest first, dates parsed from the
  // slug (M-D-YYYY). A PAST event's page redirects off the ticket-listing view,
  // so seeding the session on one leaves the driver with no event page to start
  // on (the whole run then yields "no result"), and fetching one is wasted.
  function sgUpcoming() {
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    return SEATGEEK_URLS
      .map((u) => {
        const em = u.match(/\/(\d{5,})/);
        const dm = u.match(/\/(\d{1,2})-(\d{1,2})-(\d{4})-bronx/);
        return { eid: em ? +em[1] : null, url: u,
          // slug is M-D-YYYY → Date(year, month-1, day)
          date: dm ? new Date(+dm[3], +dm[1] - 1, +dm[2]) : null };
      })
      .filter((e) => e.eid && (!e.date || e.date >= t0))
      .sort((a, b) => (a.date && b.date ? a.date - b.date : 0));
  }

  // SeatGeek's OFFICIAL Open API (api.seatgeek.com) — documented, CORS/GM
  // friendly, and NOT behind DataDome/Fastly, so it never 503s the way the
  // internal listings endpoint does. Needs a free client_id. Returns every
  // remaining Yankees home game with its event id, url, date and event-level
  // lowest price: used both to discover event ids (no hardcoded list) and to
  // publish a lowest-price-per-game fallback when per-section collection is
  // blocked. Returns { events:[{eid,url,date,hour,gamePk,lowest}] } or { error }.
  async function sgOpenDiscover() {
    const cid = settings().sgClientId;
    if (!cid) return { error: "no-client-id" };
    const params = new URLSearchParams({
      client_id: cid, "performers.slug": "new-york-yankees",
      "datetime_local.gte": new Date().toISOString().slice(0, 10),
      per_page: "60", sort: "datetime_local.asc",
    });
    let resp;
    try {
      resp = await new Promise((res, rej) => GM_xmlhttpRequest({
        method: "GET", url: "https://api.seatgeek.com/2/events?" + params,
        onload: res, onerror: rej, ontimeout: rej, timeout: 15000,
      }));
    } catch (e) { return { error: "network" }; }
    if (!resp || resp.status !== 200) return { error: "http-" + (resp && resp.status) };
    const data = safeJson(resp.responseText) || {};
    const evs = Array.isArray(data.events) ? data.events : [];
    const events = [];
    for (const ev of evs) {
      const venue = ev.venue || {};
      if (!/yankee stadium/i.test(venue.name || "")) continue;   // home games only
      const dt = ev.datetime_local || "";                        // "2026-09-08T19:15:00"
      const date = dt.slice(0, 10);
      const hour = parseInt(dt.slice(11, 13), 10);
      const gamePk = sgGamePk(date, isFinite(hour) ? hour : null);
      if (!gamePk) continue;                                     // not a game we track
      const st = ev.stats || {};
      const lowest = [st.lowest_price, st.lowest_price_good_deals]
        .find((v) => typeof v === "number" && v > 0);
      events.push({ eid: String(ev.id), url: ev.url || `https://seatgeek.com/e/${ev.id}`,
        date, hour: isFinite(hour) ? hour : null, gamePk, lowest: lowest != null ? lowest : null });
    }
    return { events, seen: evs.length };
  }

  // Parse a SeatGeek event_listings_v2 JSON body into lowest-per-section quotes.
  // Rows use short keys: sr=section, s=section slug, p/pf/dp=price, q=available,
  // sp=allowed split sizes. Returns [{provider, section, price, faceValue}].
  function sgQuotesFromJson(root, qtyWanted) {
    const bySec = {};
    const num = (v) => {
      if (v == null) return null;
      if (typeof v === "object")
        v = (v.total != null ? v.total : v.amount != null ? v.amount :
             v.value != null ? v.value : v.price);
      const n = typeof v === "string" ? parseFloat(v.replace(/[^\d.]/g, "")) : Number(v);
      return (isFinite(n) && n > 3 && n < 100000) ? n : null;
    };
    const readPrice = (o) => {
      for (const k of ["pf", "dp", "display_price", "price", "lowest_price",
        "list_price", "total_price", "amount", "p"]) { const n = num(o[k]); if (n != null) return n; }
      return null;
    };
    const stack = [root]; let steps = 0;
    while (stack.length && steps < 1500000) {
      steps++;
      const o = stack.pop();
      if (!o || typeof o !== "object") continue;
      if (Array.isArray(o)) { for (const v of o) if (v && typeof v === "object") stack.push(v); continue; }
      let secRaw = null;
      if (typeof o.sr === "string" && o.sr) secRaw = o.sr;
      else if (typeof o.s === "string" && o.s && (o.pf != null || o.dp != null || o.p != null)) secRaw = o.s;
      else if (typeof o.section === "string" && o.section) secRaw = o.section;
      if (secRaw && !/\{\{|\}\}/.test(secRaw)) {
        const price = readPrice(o);
        if (price != null) {
          const q = typeof o.q === "number" ? o.q : null;
          const sp = Array.isArray(o.sp) ? o.sp : null;
          const okQty = (q == null || q >= qtyWanted) && (!sp || !sp.length || sp.includes(qtyWanted));
          if (okQty) {
            const sec = normSGSection(secRaw);
            if (sec) {
              const meta = JSON.stringify(o.deal_types || o.tags || o.notes || o.mk || "");
              const obstructed = /obstruct|limited/i.test(meta);
              if (!(sec in bySec) || price < bySec[sec].price) bySec[sec] = { price, obstructed };
            }
          }
        }
      }
      for (const k in o) { const v = o[k]; if (v && typeof v === "object") stack.push(v); }
    }
    return Object.entries(bySec).map(([sec, v]) => ({
      provider: "SeatGeek",
      section: v.obstructed ? `${sec} (obstructed)` : sec,
      price: Math.round(v.price * 100) / 100, faceValue: null,
    }));
  }

  const host = location.host;
  const onStubHub = host.includes("stubhub.com");
  const onSeatGeek = host.includes("seatgeek.com");
  const onTicketmaster = host.includes("ticketmaster.com");
  const onTickpick = host.includes("tickpick.com");
  const onAggregator = host.includes("boxoprofundo.github.io") || host.includes("mikeboxer.com");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ════════════════════════ Ticketmaster worker ══════════════════════════ */
  if (onTicketmaster) {
    installTMNetHook();  // capture the page's own seat-map API responses
    const m = location.href.match(/\/event\/([A-Za-z0-9]+)/);
    const eid = m ? m[1] : null;
    const job = GM_getValue("yk_tm_job", null);
    if (eid && job && job.active && (Date.now() - job.startedAt) < JOB_TTL) {
      ticketmasterWorker(eid).catch((e) => console.error("[collector/TM]", e));
    }
    return;
  }

  // Hook fetch/XHR so we keep the page's own services.ticketmaster.com JSON
  // (ISM DS facets / quickpicks) — that's where per-section primary price and,
  // if present, faceValue live. Must install at document-start.
  function installTMNetHook() {
    let w;
    try { w = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window; }
    catch (e) { w = window; }
    if (!w || w.__ykTMHooked) return;
    const sink = (url, text) => {
      try {
        const u = String(url || "");
        if (!/services\.ticketmaster\.com/.test(u)) return;
        TM_CAP_URLS.push(u.split("?")[0]);
        if (!text || text.length < 40) return;
        if (!/ismds|quickpicks|facets|"price|faceValue|listPrice|offer/i.test(u + text)) return;
        TM_CAPTURES.push({ url: u, body: text.slice(0, 4000000) });
      } catch (e) {}
    };
    try {
      w.__ykTMHooked = 1;
      const of = w.fetch;
      if (of) {
        w.fetch = function () {
          const a = arguments;
          return of.apply(this, a).then((r) => {
            try { r.clone().text().then((t) => sink(r.url || a[0], t)); } catch (e) {}
            return r;
          });
        };
      }
      const XP = w.XMLHttpRequest && w.XMLHttpRequest.prototype;
      if (XP) {
        const XO = XP.open, XS = XP.send;
        XP.open = function (m, u) { this.__ykUrl = u; return XO.apply(this, arguments); };
        XP.send = function () {
          const x = this;
          this.addEventListener("load", function () {
            try { sink(x.__ykUrl, x.responseText); } catch (e) {}
          });
          return XS.apply(this, arguments);
        };
      }
    } catch (e) { console.error("[collector/TM] hook install failed", e); }
  }

  // Summarize a seat-map JSON blob without assuming its exact schema, so the
  // first-run diagnostic reveals whether per-section price/face is in there.
  function tmSummarize(text) {
    const faces = (text.match(/"face[Vv]alue"\s*:\s*"?\$?([\d.]+)/g) || []).slice(0, 8);
    const prices = (text.match(/"(?:listPrice|price|totalPrice|currentPrice|standardPrice|amount)"\s*:\s*"?\$?([\d.]+)/g) || []).length;
    const secs = [...new Set((text.match(/"(?:section|sectionName|sectionLabel|name)"\s*:\s*"([^"]{1,16})"/g) || []))].slice(0, 10);
    return { bytes: text.length, faceHits: faces.length, faceSamples: faces, priceHits: prices, sectionSamples: secs };
  }

  // Parse Ticketmaster's rendered listing text into per-section min prices.
  // TM writes listings as body text, e.g. "Sec 228 • Row 3 | Verified Resale
  // Ticket | $747.50" — the same shape the headless scraper parses. Price shown
  // is already per-ticket.
  function tmQuotesFromBody(body, gamePk, url) {
    const SECTION_CODE = "(?:[A-Za-z]*\\d[A-Za-z0-9]*|[A-Z]{1,3})";
    const re = new RegExp("(?=\\bSec\\s+" + SECTION_CODE + "\\s*[•·]\\s*Row\\b)");
    const bySec = {};
    for (const chunk of body.split(re)) {
      const sm = chunk.match(new RegExp("^\\bSec\\s+(" + SECTION_CODE + ")\\s*[•·]\\s*Row\\b"));
      if (!sm) continue;
      const sec = sm[1].trim().toUpperCase();
      const pm = chunk.slice(sm[0].length).match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
      if (!pm) continue;
      const price = parseFloat(pm[1].replace(/,/g, ""));
      if (!(price > 5 && price < 50000)) continue;
      const obstructed = /obstruct/i.test(chunk.slice(0, 160));
      if (!(sec in bySec) || price < bySec[sec].price) bySec[sec] = { price, obstructed };
    }
    return Object.entries(bySec).map(([sec, v]) => ({
      gamePk, provider: "Ticketmaster",
      section: v.obstructed ? `${sec} (obstructed)` : sec,
      price: Math.round(v.price * 100) / 100, faceValue: null, url,
    }));
  }

  // Ticketmaster's real (official) per-section face value. The rendered page
  // text never shows it, but the seat-map API the page fetches does: the
  // quickpicks endpoint returns picks tagged with a human section ("214A")
  // plus offer ids, and _embedded.offer[] carries each offer's faceValue.
  // faceValue is a fixed per-price-level attribute — so a "Standard Ticket"
  // offer's faceValue IS the section's face; Mastercard/promo offers discount
  // BELOW face, so prefer the standard offer and otherwise take the max.
  // Returns { "214A": 120, ... }. Coverage == the sections that have listings,
  // which is exactly the sections we quote a price for.
  function tmFaceFromCaptures() {
    const offer = {}; // offerId -> { face, standard }
    const picks = []; // { section, ids:[] }
    for (const c of TM_CAPTURES) {
      let j;
      try { j = JSON.parse(c.body); } catch (e) { continue; }
      const emb = j._embedded || {};
      for (const o of emb.offer || []) {
        if (o && o.offerId != null && o.faceValue != null) {
          offer[o.offerId] = {
            face: +o.faceValue,
            standard: o.name === "Standard Ticket" && o.offerType === "standard",
          };
        }
      }
      for (const p of j.picks || []) {
        if (!p || !p.section) continue;
        const ids = [];
        for (const og of p.offerGroups || []) for (const id of og.offers || []) ids.push(id);
        picks.push({ section: String(p.section).toUpperCase(), ids });
      }
    }
    const bySec = {};
    for (const p of picks) {
      let std = null, any = null;
      for (const id of p.ids) {
        const o = offer[id];
        if (!o || !(o.face > 0)) continue;
        if (any == null || o.face > any) any = o.face;
        if (o.standard) std = std == null ? o.face : Math.min(std, o.face);
      }
      const face = std != null ? std : any;
      if (face != null) bySec[p.section] = p.section in bySec ? Math.min(bySec[p.section], face) : face;
    }
    return bySec;
  }

  async function ticketmasterWorker(eid) {
    try { await ticketmasterWorkerInner(eid); }
    catch (e) {
      // Always post *something* so the controller isn't left blind.
      GM_setValue("yk_tm_result_" + eid,
        { ts: Date.now(), quotes: [], diag: { error: String(e).slice(0, 200), where: "worker" } });
    }
  }
  async function ticketmasterWorkerInner(eid) {
    // We run at document-start; wait for the DOM before touching it.
    for (let i = 0; i < 100 && !document.body; i++) await sleep(50);
    // Dismiss cookie/consent popups that can cover the listings.
    for (let i = 0; i < 20; i++) {
      clickMore(["accept", "accept all", "got it", "ok", "agree", "i accept"]);
      const t = document.body ? document.body.innerText : "";
      if (/Row\s+\w+\s+.*?\$\s*\d/.test(t)) break;
      await sleep(400);
    }
    // Nudge the seat list to render / lazy-load.
    for (let r = 0; r < 6; r++) { window.scrollBy(0, 1400); await sleep(700); }
    const body = document.body ? document.body.innerText : "";
    const job = GM_getValue("yk_tm_job", null);
    const gamePk = (job && job.eidToPk && job.eidToPk[eid]) || null;
    const url = location.href.split("?")[0];
    const quotes = tmQuotesFromBody(body, gamePk, url);

    // Stamp official face value onto each quote from the seat-map API.
    const faceMap = tmFaceFromCaptures();
    for (const q of quotes) {
      const key = String(q.section).replace(/\s*\(obstructed\)$/, "").toUpperCase();
      if (faceMap[key] != null) q.faceValue = faceMap[key];
    }

    // Diagnostic: page shape + any captured seat-map JSON, so the parser and a
    // future face-value reader can be built from the real markup.
    const faceCtx = [];
    for (const mm of body.matchAll(/face\s*value/gi)) {
      const s = Math.max(0, mm.index - 40);
      faceCtx.push(body.slice(s, mm.index + 40).replace(/\s+/g, " "));
      if (faceCtx.length >= 5) break;
    }
    const secText = (body.match(/Sec\s+[A-Za-z0-9]+\s*[•·]\s*Row[^$]{0,60}\$\s*[\d,]+/g) || []).slice(0, 8);
    const captures = TM_CAPTURES.slice(0, 6).map((c) => ({
      url: c.url.split("?")[0], summary: tmSummarize(c.body),
      sample: /face[Vv]alue|listPrice|"price"/.test(c.body) ? c.body.slice(0, 700) : null,
    }));
    // Full bodies of the two most face-value-rich captures, so the exact
    // schema linking faceValue → section can be read once and a parser built.
    const rawFace = TM_CAPTURES
      .map((c) => ({ c, n: (c.body.match(/face[Vv]alue/g) || []).length }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 2)
      .map((x) => ({ url: x.c.url.split("?")[0], faces: x.n, body: x.c.body.slice(0, 1500) }));
    const diag = {
      title: (document.title || "").slice(0, 120),
      blocked: /paused|denied|robot|captcha|access to this page/i.test(body.slice(0, 400)),
      bodyLen: body.length,
      sectionRows: secText,
      faceMentions: faceCtx,
      ismdsUrls: [...new Set(TM_CAP_URLS)].slice(0, 12),
      faces: faceMap,
      captures,
      rawFace,
    };
    console.log(`[collector/TM] event ${eid}: ${quotes.length} sections`, diag);
    GM_setValue("yk_tm_result_" + eid, { ts: Date.now(), quotes, diag });
  }

  /* ════════════════════════ StubHub worker ═══════════════════════════════ */
  if (onStubHub) {
    const idMatch = location.pathname.match(/event\/(\d+)/);
    const gamePk = idMatch ? SH_ID_TO_GAME[idMatch[1]] : null;
    const job = GM_getValue("yk_sh_job", null);
    if (gamePk && job && job.active && (Date.now() - job.startedAt) < JOB_TTL) {
      stubhubWorker(gamePk).catch((e) => console.error("[collector/StubHub]", e));
    }
    return;
  }

  async function stubhubWorker(pk) {
    for (let i = 0; i < 40; i++) {
      const t = document.body ? document.body.innerText : "";
      if ((t.match(/\$\s*\d{2,}/g) || []).length >= 3) break;
      await sleep(300);
    }
    for (let round = 0; round < 15; round++) {
      if (!clickMore(["show more", "view more", "load more", "see more", "show all"])) break;
      await sleep(1400);
    }
    const body = document.body ? document.body.innerText : "";
    const SECTION_CODE = "(?:NORD[A-Za-z0-9]*|FLOOR[A-Za-z0-9]*|[A-Za-z]*\\d[A-Za-z0-9]*|[A-Z]{1,2})";
    const url = STUBHUB_EVENTS[pk];
    const re = new RegExp("(?=\\bSection\\s+" + SECTION_CODE + "\\b)");
    const bySec = {};
    for (const chunk of body.split(re)) {
      const sm = chunk.match(new RegExp("^\\bSection\\s+(" + SECTION_CODE + ")\\b"));
      if (!sm) continue;
      const sec = sm[1].trim().toUpperCase();
      const fees = chunk.match(/incl\.?\s*fees/i);
      if (!fees) continue;
      const before = chunk.slice(0, fees.index);
      const pm = [...before.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)];
      if (!pm.length) continue;
      const price = parseFloat(pm[pm.length - 1][1].replace(/,/g, ""));
      if (!(price > 5 && price < 50000)) continue;
      const obstructed = /obstruct/i.test(chunk.slice(0, (fees.index || 0) + 20));
      if (!(sec in bySec) || price < bySec[sec].price) bySec[sec] = { price, obstructed };
    }
    const quotes = Object.entries(bySec).map(([sec, v]) => ({
      gamePk: pk, provider: "StubHub",
      section: v.obstructed ? `${sec} (obstructed)` : sec,
      price: Math.round(v.price * 100) / 100, faceValue: null, url,
    }));
    console.log(`[collector/StubHub] game ${pk}: ${quotes.length} sections`);
    GM_setValue("yk_sh_result_" + pk, { ts: Date.now(), quotes });
  }

  /* ════════════════════════ SeatGeek worker ══════════════════════════════ */
  if (onSeatGeek) {
    const isEvent = /\/\d{6,}(?:\?|$|\/)/.test(location.pathname);
    const apiJob = GM_getValue("yk_sg_apijob", null);
    const apiActive = apiJob && apiJob.active && (Date.now() - apiJob.startedAt) < JOB_TTL;
    const job = GM_getValue("yk_sg_job", null);
    const active = job && job.active && (Date.now() - job.startedAt) < JOB_TTL;
    if (apiActive && isEvent) {
      // Direct-API mode: this one tab establishes a real SeatGeek session (the
      // page's own load passes DataDome + sets cookies), then fetches every
      // game's listings straight from event_listings_v2 — no tab per game.
      installSGNetHook();
      seatgeekApiDriver(apiJob).catch((e) => console.error("[collector/SeatGeek api]", e));
    } else if (active && isEvent) {
      // Legacy per-tab mode (used by the single-game probe): capture the page's
      // own network calls and parse them.
      installSGNetHook();
      seatgeekWorker().catch((e) => console.error("[collector/SeatGeek]", e));
    } else if (active && /yankees-tickets|new-york-yankees/.test(location.pathname)) {
      if (document.readyState === "loading")
        document.addEventListener("DOMContentLoaded", () =>
          seatgeekHarvest().catch((e) => console.error("[collector/SeatGeek harvest]", e)));
      else seatgeekHarvest().catch((e) => console.error("[collector/SeatGeek harvest]", e));
    }
    return;
  }

  // Runs inside ONE SeatGeek event tab. Waits until the page's own session is
  // live (its own event_listings_v2 call succeeds → DataDome passed), then
  // fetches each game's listings directly (same-origin, cookies included) with
  // gentle spacing. Posts one combined result for the controller to publish.
  async function seatgeekApiDriver(job) {
    const qty = job.qty || 2;
    const eids = job.eids || [];
    const w = (function () { try { return (typeof unsafeWindow !== "undefined") ? unsafeWindow : window; } catch (e) { return window; } })();
    const diag = { qty, fetched: [] };

    // Is the seed page itself a DataDome / CDN block page?
    const pageBlocked = () => {
      try {
        const t = (document.body ? document.body.innerText : "") + " " + (document.title || "");
        return /are you a robot|verify you are human|access denied|pardon the interruption|max restarts|error 5\d\d|unusual (traffic|activity)/i.test(t);
      } catch (e) { return false; }
    };

    // Brief wait for the page's own listings call (session established), bailing
    // early if the seed page is clearly a block page.
    for (let i = 0; i < 40; i++) {                    // up to ~20s
      if (SG_CAPTURES.some((c) => /event_listings/i.test(c.url))) { diag.saw_listings = true; break; }
      if (i > 6 && pageBlocked()) { diag.seed_blocked = true; break; }
      await sleep(500);
    }

    // One fetch with a hard 9s timeout so a stalled (blocked) connection can
    // never hang the whole run.
    const fetchOne = async (eid) => {
      const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      const to = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 9000) : null;
      try {
        const res = await w.fetch(sgListingsUrl(eid, qty),
          ctrl ? { credentials: "include", signal: ctrl.signal } : { credentials: "include" });
        const txt = await res.text();
        if (to) clearTimeout(to);
        const blocked = /datadome|captcha|are you a robot|max restarts|^\s*<(!doctype|html)/i.test(txt.slice(0, 200));
        let json = null; try { json = JSON.parse(txt); } catch (e) {}
        const quotes = json ? sgQuotesFromJson(json, qty) : [];
        return { status: res.status, n: quotes.length, blocked, quotes };
      } catch (e) {
        if (to) clearTimeout(to);
        const timeout = e && (e.name === "AbortError" || /abort/i.test(String(e)));
        return { status: timeout ? "timeout" : "error", n: 0, blocked: false, quotes: [] };
      }
    };

    const byEid = {}; let consecFail = 0;
    for (let idx = 0; idx < eids.length; idx++) {
      const eid = eids[idx];
      const r = await fetchOne(eid);
      if (r.n > 0) byEid[eid] = r.quotes;
      diag.fetched.push({ eid, status: r.status, n: r.n, blocked: r.blocked });
      GM_setValue("yk_sg_apiprogress", { done: idx + 1, total: eids.length, eid, n: r.n });
      const fail = r.n === 0 && (r.blocked || r.status === "timeout" || r.status === "error" ||
        (typeof r.status === "number" && r.status >= 400));
      consecFail = fail ? consecFail + 1 : 0;
      // If the first handful all fail and nothing has come back, it's a block —
      // stop early rather than grinding through 17 stalled calls.
      if (consecFail >= 3 && Object.keys(byEid).length === 0) { diag.aborted_early = true; break; }
      await sleep(700 + Math.random() * 600);
    }

    diag.blocked = Object.keys(byEid).length === 0 && (diag.seed_blocked ||
      diag.fetched.some((f) => f.blocked || f.status === "timeout" ||
        f.status === 403 || f.status === 503));
    console.log("[collector/SeatGeek api] done", diag);
    GM_setValue("yk_sg_apiresult", { ts: Date.now(), byEid, diag });
  }

  // Wrap the PAGE's fetch/XHR to record responses. SeatGeek's CSP blocks an
  // injected <script>, so we wrap unsafeWindow directly from the sandbox — the
  // page's window.fetch === unsafeWindow.fetch, so its calls route through ours.
  // No CSP violation (we assign a property, we don't inject markup).
  function installSGNetHook() {
    let w;
    try { w = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window; }
    catch (e) { w = window; }
    if (!w || w.__ykSGHooked) return;
    const sink = (url, text) => {
      try {
        if (url) SG_CAP_URLS.push(String(url).split("?")[0]);
        if (!text || text.length < 40) return;
        if (!/"section"|section_id|"lp"|"dp"|"price|listings?/i.test(text)) return;
        SG_CAPTURES.push({ url: String(url || ""), body: text.slice(0, 4000000) });
      } catch (e) {}
    };
    try {
      w.__ykSGHooked = 1;
      const of = w.fetch;
      if (of) {
        w.fetch = function () {
          const a = arguments;
          return of.apply(this, a).then((r) => {
            try { r.clone().text().then((t) => sink(r.url || a[0], t)); } catch (e) {}
            return r;
          });
        };
      }
      const XP = w.XMLHttpRequest && w.XMLHttpRequest.prototype;
      if (XP) {
        const XO = XP.open, XS = XP.send;
        XP.open = function (m, u) { this.__ykUrl = u; return XO.apply(this, arguments); };
        XP.send = function () {
          const x = this;
          this.addEventListener("load", function () {
            try { sink(x.__ykUrl, x.responseText); } catch (e) {}
          });
          return XS.apply(this, arguments);
        };
      }
    } catch (e) { console.error("[collector/SeatGeek] hook install failed", e); }
  }

  // Scan free-form text for JSON listing objects, string- and escape-aware.
  // Handles three shapes in one pass: (1) real JSON objects, brace-matched and
  // parsed; (2) SeatGeek/Next.js RSC "flight" payloads, where JSON is serialized
  // *inside* a JS string literal (self.__next_f.push([1,"...\"section\":..."])) —
  // any string literal that looks like it holds listing data is JSON-decoded and
  // rescanned; (3) nested combinations of the two (depth-limited). Each small
  // object carrying a section key is handed to `emit` (the caller's walk()).
  function scanForListings(text, emit, depth) {
    if (!text || (depth || 0) > 3) return;
    const stack = []; let inStr = false, esc = false, strStart = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') {
          inStr = false;
          const lit = text.slice(strStart, i + 1);
          if (lit.length > 30 && lit.length < 4000000 &&
              /section/.test(lit) && lit.indexOf('\\"') >= 0) {
            try { const dec = JSON.parse(lit); if (typeof dec === "string") scanForListings(dec, emit, (depth || 0) + 1); }
            catch (e) {}
          }
        }
        continue;
      }
      if (ch === '"') { inStr = true; strStart = i; }
      else if (ch === "{") stack.push(i);
      else if (ch === "}") {
        const s = stack.pop();
        if (s == null) continue;
        const len = i - s + 1;
        if (len < 12 || len > 20000) continue;
        const frag = text.slice(s, i + 1);
        if (!/"section(?:_id)?"\s*:/.test(frag)) continue;
        try { emit(JSON.parse(frag)); } catch (e) {}
      }
    }
  }

  // Harvest home-game event URLs from the SeatGeek Yankees team page (real
  // browser renders it). Primary source is the Next.js __NEXT_DATA__ blob
  // (reliable); DOM anchors are a fallback. Always emits a rich diagnostic so
  // the team-page structure is visible even when nothing is harvested.
  async function seatgeekHarvest() {
    for (let i = 0; i < 40; i++) {
      const t = document.body ? document.body.innerText : "";
      if (/\$\s*\d/.test(t) || document.querySelectorAll("a[href]").length > 40) break;
      await sleep(300);
    }
    const diag = { url: location.href };
    try { diag.title = document.title; } catch (e) {}
    const bodyText = document.body ? document.body.innerText : "";
    diag.body_len = bodyText.length;
    diag.blocked = /are you a robot|verify you are human|captcha|access denied|pardon the interruption/i.test(bodyText);

    const rows = [], seen = new Set();
    const pushRow = (url, text) => {
      if (!url) return;
      url = String(url).replace(/\\\//g, "/").split("?")[0];
      if (!/^https?:\/\/(www\.)?seatgeek\.com\//.test(url)) return;
      if (seen.has(url)) return;
      seen.add(url); rows.push({ url, text: (text || "").slice(0, 90) });
    };

    // Primary: parse __NEXT_DATA__ and deep-walk for event-like objects.
    const ndEl = document.getElementById("__NEXT_DATA__");
    diag.next_present = !!ndEl;
    let nd = null;
    if (ndEl) {
      diag.next_len = (ndEl.textContent || "").length;
      try { nd = JSON.parse(ndEl.textContent); }
      catch (e) { diag.next_parse_err = String(e).slice(0, 100); }
    }
    const eventSamples = [];
    if (nd) {
      const stack = [nd]; let steps = 0;
      while (stack.length && steps < 300000) {
        steps++;
        const o = stack.pop();
        if (!o || typeof o !== "object") continue;
        const url = o.url || o.href;
        const title = o.title || o.short_title || o.name;
        const venue = o.venue || {};
        const vname = (venue && (venue.name || venue.name_v2)) || "";
        const vcity = (venue && venue.city) || "";
        const looksEvent =
          (typeof url === "string" && /seatgeek\.com\/.+\/\d{5,}/.test(url)) ||
          (o.id && title && /yankee/i.test(String(title)));
        if (looksEvent) {
          const home = /yankee stadium/i.test(vname) || /bronx/i.test(vcity) ||
            /yankees tickets|vs\.?\s*.*yankees|yankees\s*vs/i.test(String(title || url));
          if (home && typeof url === "string") pushRow(url, title);
          if (eventSamples.length < 6) eventSamples.push({
            id: o.id, title: String(title).slice(0, 60), url: String(url).slice(0, 120),
            vname, vcity, dt: o.datetime_utc || o.datetime_local || o.datetime,
          });
        }
        for (const k in o) { const v = o[k]; if (v && typeof v === "object") stack.push(v); }
      }
    }
    diag.next_event_samples = eventSamples;

    // Secondary: regex event URLs straight out of the raw blob.
    if (ndEl) {
      const raw = ndEl.textContent || "";
      const re = /"url":"(https:[^"]*?\/\d{5,})"/g;
      let m, c = 0;
      while ((m = re.exec(raw)) && c < 80) { c++; const u = m[1]; if (/yankee/i.test(u)) pushRow(u); }
      diag.next_url_hits = c;
    }

    // Fallback + diagnostic: DOM anchors.
    const anchors = [...document.querySelectorAll("a[href]")].map((a) => ({
      href: a.getAttribute("href") || "", text: (a.innerText || "").trim().slice(0, 50),
    }));
    diag.anchor_count = anchors.length;
    diag.anchor_samples = anchors.filter((a) => /\/\d{5,}/.test(a.href)).slice(0, 15);
    anchors.forEach((a) => {
      if (/\/\d{5,}(?:\?|$|\/)/.test(a.href) && /yankee|bronx/i.test(a.text + " " + a.href)) {
        pushRow(a.href.startsWith("http") ? a.href : "https://seatgeek.com" + a.href, a.text);
      }
    });

    diag.rows_found = rows.length;
    console.log(`[collector/SeatGeek harvest] ${rows.length} event links`, diag);
    GM_setValue("yk_sg_harvest", { ts: Date.now(), rows, diag });
  }

  async function seatgeekWorker() {
    // Per-section listings arrive over the NETWORK after load (not in the DOM
    // or __NEXT_DATA__). installSGNetHook() (called at document-start) records
    // those responses into a hidden node; here we wait for them, parse each,
    // and deep-walk for listing objects (a string `section` + a price). The
    // event's date/time still comes from __NEXT_DATA__, for the gamePk.
    const diag = { url: location.href };
    const bySec = {};
    let sampleListing = null, sampleSection = null, listingCount = 0;
    const qtyWanted = Math.max(1, parseInt(
      new URLSearchParams(location.search).get("quantity"), 10) || 2);

    const num = (v) => {
      if (v == null) return null;
      if (typeof v === "object")
        v = (v.total != null ? v.total : v.amount != null ? v.amount :
             v.value != null ? v.value : v.price);
      const n = typeof v === "string" ? parseFloat(v.replace(/[^\d.]/g, "")) : Number(v);
      return (isFinite(n) && n > 3 && n < 100000) ? n : null;
    };
    // All-in per-ticket price, preferring fee-inclusive fields. SeatGeek's real
    // event_listings_v2 objects use short keys: pf = price+fees, dp = display,
    // p = base; long-form feeds use price / display_price / etc.
    const readPrice = (o) => {
      const keys = ["pf", "dp", "display_price", "price", "lowest_price",
        "list_price", "total_price", "amount", "p"];
      for (const k of keys) { const n = num(o[k]); if (n != null) return n; }
      return null;
    };
    // Deep-walk one parsed JSON root, folding listing objects into bySec. Handles
    // two shapes: (a) long-form { "section": "318", "price": … } and (b) the real
    // SeatGeek API row { "sr":"136","s":"field level 136","q":2,"sp":[2],"pf":… }.
    const walk = (root) => {
      const stack = [root]; let steps = 0;
      while (stack.length && steps < 1500000) {
        steps++;
        const o = stack.pop();
        if (!o || typeof o !== "object") continue;
        if (Array.isArray(o)) {
          for (const v of o) if (v && typeof v === "object") stack.push(v);
          continue;
        }
        // Section id: prefer the raw section number sr; fall back to s / section.
        let secRaw = null;
        if (typeof o.sr === "string" && o.sr) secRaw = o.sr;
        else if (typeof o.s === "string" && o.s && (o.pf != null || o.dp != null || o.p != null)) secRaw = o.s;
        else if (typeof o.section === "string" && o.section) secRaw = o.section;
        else if (typeof o.section_id === "string" && o.section_id) secRaw = o.section_id;
        // Ignore i18n template strings like "Section {{section}}".
        if (secRaw && !/\{\{|\}\}/.test(secRaw)) {
          if (!sampleSection) sampleSection = JSON.stringify(o).slice(0, 900);
          const price = readPrice(o);
          if (price != null) {
            // Quantity filter: q = available seats, sp = allowed split sizes.
            const q = typeof o.q === "number" ? o.q : null;
            const sp = Array.isArray(o.sp) ? o.sp : null;
            const okQty = (q == null || q >= qtyWanted) &&
              (!sp || !sp.length || sp.includes(qtyWanted));
            if (okQty) {
              listingCount++;
              if (!sampleListing) sampleListing = JSON.stringify(o).slice(0, 900);
              const sec = normSGSection(secRaw);
              if (sec) {
                const meta = JSON.stringify(o.deal_types || o.tags || o.notes || o.disclosures || o.mk || "");
                const obstructed = /obstruct|limited/i.test(meta);
                if (!(sec in bySec) || price < bySec[sec].price) bySec[sec] = { price, obstructed };
              }
            }
          }
        }
        for (const k in o) { const v = o[k]; if (v && typeof v === "object") stack.push(v); }
      }
    };

    // 1) Event date/hour from __NEXT_DATA__ (present at load), for gamePk.
    let eventDate = null, eventHour = null, eventTitle = null;
    for (let i = 0; i < 30; i++) {
      const nd = document.getElementById("__NEXT_DATA__");
      if (nd && (nd.textContent || "").length > 20000) break;
      await sleep(200);
    }
    try {
      const nd = document.getElementById("__NEXT_DATA__");
      if (nd) {
        diag.next_len = (nd.textContent || "").length;
        const data = JSON.parse(nd.textContent);
        const st = [data]; let steps = 0;
        while (st.length && steps < 400000 && !eventDate) {
          steps++;
          const o = st.pop();
          if (!o || typeof o !== "object") continue;
          if (Array.isArray(o)) { for (const v of o) if (v && typeof v === "object") st.push(v); continue; }
          const dt = o.datetime_local || o.datetime_utc || o.datetime;
          if (typeof dt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(dt) &&
              /yankee/i.test(JSON.stringify(o.title || o.short_title || o.name || ""))) {
            eventDate = dt.slice(0, 10);
            eventHour = parseInt(dt.slice(11, 13), 10);
            eventTitle = String(o.title || o.short_title || o.name || "").slice(0, 80);
            break;
          }
          for (const k in o) { const v = o[k]; if (v && typeof v === "object") st.push(v); }
        }
      }
    } catch (e) { diag.next_err = String(e).slice(0, 160); }

    // Parse text for listings: whole-JSON first, then the brace/flight scanner.
    // Gate on a *quoted* "section" so minified framework bundles (which contain
    // the bare word "section") aren't scanned pointlessly.
    const parseText = (text) => {
      if (!text || !/\\?"section/.test(text)) return;
      try { walk(JSON.parse(text)); } catch (e) {}
      scanForListings(text, walk, 0);
    };
    // Gather from: (a) captured network bodies (grow over time — always re-read),
    // (b) the page's own <script> tags (Next.js streams listing data in here),
    // scanned once each via a seen-set, (c) whole-page HTML as a last resort.
    let capIdx = 0;
    const seenScripts = new WeakSet();
    const gather = () => {
      // Network bodies (e.g. event_listings_v2) are pure JSON with short-key
      // rows that don't contain the literal "section" — always JSON-parse+walk;
      // fall back to the brace/flight scanner only if it isn't clean JSON.
      for (; capIdx < SG_CAPTURES.length; capIdx++) {
        const body = SG_CAPTURES[capIdx].body;
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) {}
        if (parsed) walk(parsed);
        else scanForListings(body, walk, 0);
      }
      for (const s of document.querySelectorAll("script")) {
        if (seenScripts.has(s)) continue;
        seenScripts.add(s);
        parseText(s.textContent || "");
      }
    };

    // Nudge the seat map so it initializes and fetches per-section prices
    // (hover/click the map canvas/svg; the map's "deals" fetch colors sections).
    const nudgeMap = () => {
      try {
        const cands = [...document.querySelectorAll(
          'canvas, svg, [class*="map" i], [class*="Map" ], [class*="seat" i], [data-testid*="map" i]')]
          .filter((el) => el.offsetWidth > 200 && el.offsetHeight > 200);
        const el = cands[0];
        if (!el) return;
        const r = el.getBoundingClientRect();
        for (const [dx, dy] of [[0.5, 0.5], [0.4, 0.4], [0.6, 0.6], [0.5, 0.35]]) {
          const x = r.left + r.width * dx, y = r.top + r.height * dy;
          for (const type of ["mousemove", "mouseover", "mousedown", "mouseup", "click"]) {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
          }
        }
      } catch (e) {}
    };

    // 2) Poll — foreground map init + price fetch is slow; give it time.
    for (let i = 0; i < 80; i++) {                    // up to ~40s
      gather();
      if (Object.keys(bySec).length) break;
      if (i % 3 === 0) { try { window.scrollTo(0, (i % 6 ? document.body.scrollHeight : 0)); } catch (e) {} }
      if (i % 4 === 1) nudgeMap();
      if (i % 6 === 3) { try { clickMore(["all areas", "list", "list view", "lowest price", "sort", "all tickets", "view tickets"]); } catch (e) {} }
      await sleep(500);
    }
    gather();
    // Last resort: scan the whole rendered HTML (catches listings held outside
    // <script> tags, e.g. in element attributes).
    if (!Object.keys(bySec).length) {
      try { parseText(document.documentElement.innerHTML); } catch (e) {}
    }

    const quotes = Object.entries(bySec).map(([sec, v]) => ({
      provider: "SeatGeek",
      section: v.obstructed ? `${sec} (obstructed)` : sec,
      price: Math.round(v.price * 100) / 100, faceValue: null,
    }));

    diag.cap_count = SG_CAPTURES.length;
    diag.cap_urls_all = [...new Set(SG_CAP_URLS)].slice(0, 30);
    // Full listings-API URL (with query) — enables a future direct-fetch path
    // that avoids opening a foreground tab per game.
    const apiCap = SG_CAPTURES.find((c) => /event_listings|\/api\/listings/i.test(c.url));
    diag.listings_api_url = apiCap ? apiCap.url : null;
    diag.listing_count = listingCount;
    diag.sections = quotes.length;
    diag.sample_listing = sampleListing;
    diag.sample_section = sampleSection;
    // Safety net: if nothing parsed, surface the exact format for one more pass.
    if (!quotes.length) {
      const priceRe = /(\$\s*\d|"(?:lp|dp|p|price|amount|min_price|lowest_price)"\s*:\s*\d)/i;
      let scriptHits = 0;
      for (const s of document.querySelectorAll("script"))
        if (/"?\\?"section/.test(s.textContent || "")) scriptHits++;
      diag.script_section_tags = scriptHits;
      // Which captured responses actually carry prices (reveals the deals API).
      diag.cap_price_urls = [...new Set(SG_CAPTURES.filter((c) => priceRe.test(c.body))
        .map((c) => String(c.url).split("?")[0]))].slice(0, 20);
      // Dump the capture most likely to be the price/deals payload (has a price
      // token), else the one with the most "section" mentions.
      const priced = SG_CAPTURES.filter((c) => priceRe.test(c.body));
      const pick = (priced.length ? priced : SG_CAPTURES).slice().sort((a, b) =>
        (b.body.match(/section|"lp"|"dp"|price/gi) || []).length -
        (a.body.match(/section|"lp"|"dp"|price/gi) || []).length)[0];
      if (pick) {
        const at = pick.body.search(priceRe);
        diag.cap_body_head = {
          url: String(pick.url).split("?")[0], len: pick.body.length,
          head: pick.body.slice(0, 900),
          around_price: at >= 0 ? pick.body.slice(Math.max(0, at - 300), at + 500) : null,
        };
      }
      const html = (() => { try { return document.documentElement.innerHTML; } catch (e) { return ""; } })();
      const idx = html.search(/\\?"section(?:_id)?\\?"\s*:/);
      diag.html_section_sample = idx >= 0 ? html.slice(Math.max(0, idx - 150), idx + 500) : "no 'section' in page HTML";
    }
    diag.event_date = eventDate;
    diag.event_hour = eventHour;
    diag.event_title = eventTitle;

    console.log(`[collector/SeatGeek] ${quotes.length} sections, date=${eventDate}, caps=${SG_CAPTURES.length}`, diag);
    const eid = (location.pathname.match(/\/(\d{5,})/) || [])[1] || location.href;
    GM_setValue("yk_sg_result_" + eid, { ts: Date.now(), quotes, eventDate, eventHour, diag });
  }

  /* ── shared: click a "show more"-style control ──────────────────────── */
  function clickMore(labels) {
    if (!document.body) return false;
    window.scrollTo(0, document.body.scrollHeight);
    const els = document.querySelectorAll('button, a, [role="button"], div[tabindex], span[tabindex]');
    for (const el of els) {
      const t = (el.innerText || "").trim().toLowerCase();
      if (labels.includes(t)) { el.scrollIntoView({ block: "center" }); el.click(); return true; }
    }
    return false;
  }

  /* ════════════════════════ TickPick worker ══════════════════════════════ */
  // TickPick renders per-section listings from an internal JSON API
  // (api.tickpick.com/1.0/listings/internal/event-v2/<eid>) that DataDome
  // 403s from datacenter IPs but serves fine to a real browser. One tab on the
  // Yankees team page establishes the DataDome cookie AND lists every home
  // game's event page; from there we fetch each event's API (cookie carried,
  // CORS allowed since the page's own origin calls it) and parse per-section
  // prices plus the NY-law "Face Value: $X" disclosure in each listing's note.
  function tickpickDiscover(html) {
    const PAT = /\/buy-[a-z0-9-]*yankee-stadium-(\d{1,2})-(\d{1,2})-26-(\d{1,2})([ap])m\/(\d{6,})/g;
    const found = {};
    let m;
    while ((m = PAT.exec(html))) {
      const [full, mo, md, hh, ap, eid] = m;
      const date = `2026-${String(+mo).padStart(2, "0")}-${String(+md).padStart(2, "0")}`;
      const hour = (+hh % 12) + (ap === "p" ? 12 : 0);
      found[eid] = { eid, url: "https://www.tickpick.com" + full + "/", date, hour };
    }
    return Object.values(found);
  }

  function tickpickQuotesFromListings(listings, qty) {
    const FACE = /face\s*value[^$]{0,12}\$\s*([\d,]+(?:\.\d{1,2})?)/i;
    const SEC_OK = /^[A-Za-z0-9]{1,5}$/;
    const bySec = {}, faces = {};
    for (const it of listings || []) {
      if (!it || typeof it !== "object") continue;
      const flags = it.d || [];
      if (it.is_pk || (Array.isArray(flags) && flags.includes("pk")) ||
          String(it.r || "").toUpperCase().startsWith("PARK")) continue;
      const sec = String(it.sid || "").trim().toUpperCase();
      if (!SEC_OK.test(sec)) continue;
      const price = parseFloat(String(it.p).replace(/[$,]/g, ""));
      if (!(price > 5 && price < 50000)) continue;
      const q = it.q || 0, sp = it.sp || [];
      if (q < qty || (sp.length && !sp.includes(qty))) continue;   // must fill a block of qty
      const note = String(it.n || "");
      const obstructed = /obstruct|limited view/i.test(note);
      if (!(sec in bySec) || price < bySec[sec].price) bySec[sec] = { price, obstructed };
      const fm = FACE.exec(note);
      if (fm) {
        const face = parseFloat(fm[1].replace(/,/g, ""));
        if (face > 5 && face < 50000 && (!(sec in faces) || face < faces[sec])) faces[sec] = face;
      }
    }
    const quotes = Object.entries(bySec).map(([sec, v]) => ({
      section: v.obstructed ? `${sec} (obstructed)` : sec,
      price: Math.round(v.price * 100) / 100,
      faceValue: faces[sec] != null ? faces[sec] : null,
    }));
    return { quotes, faces };
  }

  async function tickpickDriver(job) {
    const qty = job.qty || 2;
    const w = (function () { try { return (typeof unsafeWindow !== "undefined") ? unsafeWindow : window; } catch (e) { return window; } })();
    // Let the team page render + set the DataDome cookie; scroll to lazy-load
    // every game, collecting event links as they appear.
    const events = {};
    for (let i = 0; i < 10; i++) {
      for (const e of tickpickDiscover(document.documentElement.innerHTML)) events[e.eid] = e;
      try { window.scrollTo(0, document.body.scrollHeight); } catch (e) {}
      await sleep(700);
    }
    const list = Object.values(events);
    const byEid = {}; const diag = { events: list.length, fetched: [] };
    for (const ev of list) {
      const api = `https://api.tickpick.com/1.0/listings/internal/event-v2/${ev.eid}` +
        "?trackView=true&includeParkingOptions=false";
      try {
        const res = await w.fetch(api, { credentials: "include", headers: { accept: "application/json" } });
        const txt = await res.text();
        let j = null; try { j = JSON.parse(txt); } catch (e) {}
        const blocked = /datadome|captcha|blocked/i.test(txt.slice(0, 200)) || res.status === 403;
        const parsed = j ? tickpickQuotesFromListings(j.listings || [], qty) : { quotes: [], faces: {} };
        if (parsed.quotes.length) byEid[ev.eid] = Object.assign({ url: ev.url, date: ev.date, hour: ev.hour }, parsed);
        diag.fetched.push({ eid: ev.eid, status: res.status, n: parsed.quotes.length, blocked });
      } catch (e) {
        diag.fetched.push({ eid: ev.eid, error: String(e).slice(0, 80) });
      }
      await sleep(600 + Math.random() * 500);
    }
    diag.blocked = !Object.keys(byEid).length && diag.fetched.some((f) => f.blocked || f.status === 403);
    console.log("[collector/TickPick] done", diag);
    GM_setValue("yk_tp_apiresult", { ts: Date.now(), byEid, diag });
  }

  if (onTickpick) {
    const job = GM_getValue("yk_tp_apijob", null);
    const active = job && job.active && (Date.now() - job.startedAt) < JOB_TTL;
    if (active && /new-york-yankees-tickets/.test(location.pathname)) {
      if (document.readyState === "loading")
        document.addEventListener("DOMContentLoaded", () =>
          tickpickDriver(job).catch((e) => console.error("[collector/TickPick]", e)));
      else tickpickDriver(job).catch((e) => console.error("[collector/TickPick]", e));
    }
    return;
  }

  /* ════════════════════════ Aggregator controller ════════════════════════ */
  if (!onAggregator) return;

  function settings() {
    try { return JSON.parse(localStorage.getItem("ytf-settings")) || {}; }
    catch { return {}; }
  }
  function qtyNow() {
    const el = document.querySelector("#qty-all") || document.querySelector("#qty-specific");
    return Math.max(1, Math.min(12, parseInt(el && el.value, 10) || 2));
  }

  async function ghApi(method, path, body) {
    const token = settings().ghToken;
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url: "https://api.github.com/repos/" + PAGES_REPO + path,
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" },
        data: body ? JSON.stringify(body) : undefined,
        onload: (r) => resolve({ status: r.status, json: safeJson(r.responseText) }),
        onerror: (e) => reject(e),
      });
    });
  }
  function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }
  function b64(str) { return btoa(unescape(encodeURIComponent(str))); }

  async function putFile(path, obj, message) {
    let sha;
    const cur = await ghApi("GET", path + "?ref=main");
    if (cur.status === 200 && cur.json && cur.json.sha) sha = cur.json.sha;
    const res = await ghApi("PUT", path, {
      message, content: b64(JSON.stringify(obj, null, 2) + "\n"), sha, branch: "main",
    });
    if (res.status >= 300) throw new Error("GitHub PUT " + res.status + " for " + path);
  }

  let chip;
  function setChip(text, busy) {
    if (!chip) {
      chip = document.createElement("div");
      chip.style.cssText =
        "position:fixed;right:12px;bottom:12px;z-index:9999;background:#0c2340;color:#fff;" +
        "font:600 12px/1.35 -apple-system,system-ui,sans-serif;padding:.5rem .7rem;border-radius:8px;" +
        "box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:17rem;cursor:pointer;";
      chip.title = "Ticketmaster + SeatGeek + StubHub collector (this browser). Click to run all now.";
      chip.addEventListener("click", () => runAll());
      document.body.appendChild(chip);
    }
    chip.textContent = (busy ? "⏳ " : "🎟️ ") + text;
  }

  // Generic game-cycler: opens each URL in a background tab, waits for the
  // worker in that tab to post a result under `resultKey(key)`, collects them.
  async function cycle(label, jobKey, entries, resultKey, stampUrl, opts) {
    opts = opts || {};
    const qty = qtyNow();
    const waits = opts.waits || 70;                 // result-poll iterations (×500ms)
    const gapMin = opts.gapMin != null ? opts.gapMin : 3000;
    const gapRand = opts.gapRand != null ? opts.gapRand : 3000;
    GM_setValue(jobKey, Object.assign({ active: true, startedAt: Date.now() }, opts.jobExtra || {}));
    if (!opts.keepResults) entries.forEach(([k]) => GM_deleteValue(resultKey(k)));
    const collected = [];
    for (let i = 0; i < entries.length; i++) {
      const [key, url, gamePk] = entries[i];
      setChip(`${label} ${i + 1}/${entries.length}…`, true);
      const tab = GM_openInTab(url + (url.includes("?") ? "&" : "?") + "quantity=" + qty,
                               { active: !!opts.active, insert: true });
      let result = null;
      for (let w = 0; w < waits; w++) { result = GM_getValue(resultKey(key), null); if (result) break; await sleep(500); }
      try { tab.close(); } catch {}
      if (result && result.quotes) {
        for (const q of result.quotes) {
          collected.push(Object.assign({ gamePk, url: stampUrl ? url : q.url }, q, { gamePk, url: url }));
        }
      }
      await sleep(gapMin + Math.random() * gapRand);
    }
    GM_setValue(jobKey, { active: false, startedAt: 0 });
    return { qty, collected };
  }

  let running = false;
  async function runStubHub() {
    const entries = Object.entries(STUBHUB_EVENTS).map(([pk, url]) => [Number(pk), url, Number(pk)]);
    const { qty, collected } = await cycle("StubHub", "yk_sh_job", entries,
      (pk) => "yk_sh_result_" + pk, false);
    setChip(`Publishing ${collected.length} StubHub prices…`, true);
    await putFile(`/contents/data/listings-stubhub-${qty}.json`,
      { fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), quotes: collected },
      `StubHub listings (blocks of ${qty}, browser collector)`);
    return collected.length;
  }

  // Publish SeatGeek's event-level lowest price per game (from the Open API) as
  // a section-less fallback the app merges into the per-game table. Always
  // available, so a SeatGeek number shows even when per-section collection 503s.
  async function publishSgFallback(events) {
    const quotes = [];
    for (const e of events) {
      if (e.lowest == null || !e.gamePk) continue;
      quotes.push({ provider: "SeatGeek", gamePk: e.gamePk, section: null,
        price: Math.round(e.lowest * 100) / 100, faceValue: null, eventLevel: true, url: e.url });
    }
    if (!quotes.length) return;
    await putFile("/contents/data/listings-seatgeek-fallback.json",
      { fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), quotes },
      "SeatGeek lowest-price-per-game fallback (official Open API)")
      .catch((e) => console.error("[collector/SG] fallback publish", e));
  }

  async function runSeatGeek() {
    // Direct-API mode: open ONE SeatGeek event tab to establish a real session
    // (its own page load passes DataDome + sets cookies), then that tab fetches
    // every game's listings straight from event_listings_v2. No tab per game,
    // so no CDN rate-limit flood.
    const qty = qtyNow();

    // Official Open-API discovery (no DataDome): event ids + an event-level
    // lowest price per game. Publish that price as a fallback right away, so the
    // site has a SeatGeek number for every game even if per-section collection
    // is blocked below. Without a client id, fall back to the hardcoded list.
    const disc = await sgOpenDiscover();
    const eidToPk = {}, eidToUrl = {};
    let upcoming;
    if (disc.events && disc.events.length) {
      for (const e of disc.events) { eidToPk[e.eid] = e.gamePk; eidToUrl[e.eid] = e.url; }
      upcoming = disc.events.map((e) => ({ eid: e.eid, url: e.url }));
      await publishSgFallback(disc.events);
    } else {
      upcoming = sgUpcoming();
    }
    // Hardcoded maps backstop any eid discovery didn't cover (or no client id).
    for (const k in SG_EID_TO_PK) if (!(k in eidToPk)) eidToPk[k] = SG_EID_TO_PK[k];
    for (const k in SG_EID_TO_URL) if (!(k in eidToUrl)) eidToUrl[k] = SG_EID_TO_URL[k];
    const eids = upcoming.map((e) => +e.eid).filter((e) => eidToPk[e]);

    // Seed the session by loading a live SeatGeek event page (its own load
    // passes DataDome + sets cookies). SeatGeek's CDN sometimes 503s ("Max
    // restarts limit reached") on a particular event page, so try DIFFERENT
    // events across attempts — earliest first (most likely fully on-sale and
    // healthy), then a middle game, then the farthest-out. All of them 503ing
    // means SeatGeek is down site-wide / the IP is throttled, not a bad page.
    const cand = [];
    if (upcoming.length) {
      cand.push(upcoming[0].url);                                  // earliest (healthiest)
      if (upcoming.length > 2) cand.push(upcoming[Math.floor(upcoming.length / 2)].url);
      cand.push(upcoming[upcoming.length - 1].url);                // farthest
    }
    const seeds = [...new Set(cand.length ? cand : [SEATGEEK_URLS[SEATGEEK_URLS.length - 1]])];

    let res = null;
    for (let attempt = 1; attempt <= seeds.length; attempt++) {
      const seedUrl = seeds[attempt - 1] + "?quantity=" + qty;
      GM_deleteValue("yk_sg_apiresult");
      GM_deleteValue("yk_sg_apiprogress");
      GM_setValue("yk_sg_apijob", { active: true, startedAt: Date.now(), eids, qty });
      const tag = attempt > 1 ? ` (try ${attempt}/${seeds.length})` : "";
      setChip(`SeatGeek: opening session…${tag}`, true);
      const tab = GM_openInTab(seedUrl, { active: true, insert: true });
      const started = Date.now();
      for (let w = 0; w < 400; w++) {                // up to ~200s
        res = GM_getValue("yk_sg_apiresult", null);
        if (res) break;
        const p = GM_getValue("yk_sg_apiprogress", null);
        const secs = Math.round((Date.now() - started) / 1000);
        // Show elapsed time even before the first fetch, so a stalled session
        // reads as "still trying (30s)" rather than a silent freeze.
        if (p) setChip(`SeatGeek: ${p.done}/${p.total} games…${tag} (${secs}s)`, true);
        else setChip(`SeatGeek: opening session…${tag} (${secs}s)`, true);
        await sleep(500);
      }
      try { tab.close(); } catch {}
      GM_setValue("yk_sg_apijob", { active: false, startedAt: 0 });
      if (res && Object.keys(res.byEid || {}).length) break;   // got data
      if (attempt < seeds.length) { setChip("SeatGeek: server busy (503) — trying another game in 20s…", true); await sleep(20000); }
    }

    const byEid = (res && res.byEid) || {};
    const collected = [];
    for (const [eid, quotes] of Object.entries(byEid)) {
      const pk = eidToPk[eid];
      const url = eidToUrl[eid] || `https://seatgeek.com/e/${eid}`;
      if (!pk || !Array.isArray(quotes)) continue;
      for (const q of quotes) collected.push(Object.assign({}, q, { gamePk: pk, url }));
    }

    await putFile(`/contents/data/_seatgeek-diag.json`,
      { fetchedAt: new Date().toISOString(), mode: "direct-api",
        result: res ? res.diag : "no result (session tab produced nothing)",
        games: new Set(collected.map((q) => q.gamePk)).size, quotes: collected.length },
      "SeatGeek collector diagnostic (direct API)");

    if (collected.length) {
      await putFile(`/contents/data/listings-seatgeek-${qty}.json`,
        { fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), quotes: collected },
        `SeatGeek listings (blocks of ${qty}, browser collector, direct API)`);
    }
    const games = new Set(collected.map((q) => q.gamePk)).size;
    if (collected.length) {
      setChip(`SeatGeek: ${collected.length} prices across ${games} games`);
    } else if (!res || (res.diag && res.diag.blocked) || (res.diag && res.diag.seed_blocked)) {
      // Distinguish an active bot-block from a genuine empty result.
      setChip("SeatGeek: blocked by DataDome — try later or another network");
    } else {
      setChip("SeatGeek: 0 (no listings found)");
    }
    return collected.length;
  }

  // Discover every remaining Yankees home-game Ticketmaster event via the
  // official Discovery API (CORS/GM-friendly, uses the free key in Settings),
  // mapped to gamePk by date. Returns entries [eid, url, gamePk] for cycle().
  function extractEid(u) { const m = String(u).match(/\/event\/([A-Za-z0-9]+)/); return m ? m[1] : String(u); }

  // Keyless event map published in the repo: data/tm-events.json =
  // { entries: [[eid, url, gamePk], …] }. This is the primary source, so the
  // site needs no Ticketmaster key. A run that still has a key in storage
  // rediscovers via the API and republishes this file, keeping it complete and
  // current on its own (Phase-2 auto-collect does this unattended).
  async function loadTmEvents() {
    try {
      const r = await fetch("data/tm-events.json?_=" + Date.now(), { cache: "no-store" });
      if (!r.ok) return null;
      const j = await r.json();
      return Array.isArray(j.entries) && j.entries.length ? j.entries : null;
    } catch (e) { return null; }
  }

  async function tmDiscover() {
    const key = settings().tmKey;
    const cached = await loadTmEvents();
    if (!key) return cached ? { entries: cached } : { error: "no-events" };
    const params = new URLSearchParams({
      apikey: key, keyword: "New York Yankees", classificationName: "Baseball",
      size: "199", sort: "date,asc",
      startDateTime: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      endDateTime: new Date().getFullYear() + "-11-15T23:59:59Z",
    });
    const resp = await new Promise((res, rej) => GM_xmlhttpRequest({
      method: "GET",
      url: "https://app.ticketmaster.com/discovery/v2/events.json?" + params,
      onload: res, onerror: rej,
    }));
    const data = safeJson(resp.responseText) || {};
    const events = ((data._embedded || {}).events) || [];
    const byDate = {};
    for (const ev of events) {
      const venue = ((ev._embedded || {}).venues || [{}])[0];
      if (!/yankee stadium/i.test(venue.name || "")) continue;
      // Games only — skip stadium tours, parking, and other non-matchup events
      // (a tour runs most days at the same venue, so name must say "… vs …").
      if (!/\bvs\.?\b/i.test(ev.name || "")) continue;
      if (/parking|tour/i.test(ev.name || "")) continue;
      const start = (ev.dates || {}).start || {};
      const date = start.localDate, time = (start.localTime || "").slice(0, 5);
      const url = ev.url;
      if (!date || !url || !/\/event\/[A-Za-z0-9]+/.test(url)) continue;
      (byDate[date] = byDate[date] || []).push({ time, url });
    }
    const entries = [];
    for (const [date, evs] of Object.entries(byDate)) {
      const pks = (DATE_TO_PKS[date] || []).slice().sort((a, b) => a - b);
      if (!pks.length) continue;                       // not a remaining home game
      evs.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
      evs.forEach((e, i) => entries.push([extractEid(e.url), e.url, pks[Math.min(i, pks.length - 1)]]));
    }
    // Republish the keyless map so future runs (and other devices) need no key.
    if (entries.length) {
      await putFile("/contents/data/tm-events.json",
        { fetchedAt: new Date().toISOString(),
          note: "Keyless TM event map; refreshed by any run that still has a TM key in storage.",
          entries },
        "Refresh Ticketmaster event map").catch((e) => console.error("[collector/TM] map publish", e));
    }
    return { entries: entries.length ? entries : (cached || []) };
  }

  // Cycle every discovered TM event through a real tab; publish per-section
  // prices + a first-run diagnostic (page shape + seat-map JSON) for tuning.
  async function collectTicketmaster(probeOnly) {
    const disc = await tmDiscover();
    if (disc.error === "no-events") { setChip("Ticketmaster: no event map yet (data/tm-events.json)"); return 0; }
    let entries = disc.entries || [];
    if (!entries.length) { setChip("Ticketmaster: no events discovered"); return 0; }
    if (probeOnly) entries = entries.slice(0, 1);
    const eidToPk = {};
    entries.forEach(([eid, , pk]) => { eidToPk[eid] = pk; });
    const { qty, collected } = await cycle(
      probeOnly ? "TM probe" : "Ticketmaster", "yk_tm_job", entries,
      (eid) => "yk_tm_result_" + eid, true,
      { active: !!probeOnly, waits: probeOnly ? 120 : 100,
        gapMin: probeOnly ? 500 : 2500, gapRand: probeOnly ? 500 : 2500,
        jobExtra: { eidToPk } });
    const firstRes = GM_getValue("yk_tm_result_" + entries[0][0], null);
    await putFile("/contents/data/_tm-diag.json",
      { fetchedAt: new Date().toISOString(), games: entries.length,
        sampleEvent: entries[0][1], totalQuotes: collected.length,
        diag: firstRes ? firstRes.diag : "no result (event tab produced nothing)" },
      "Ticketmaster collector diagnostic");
    if (collected.length) {
      await putFile(`/contents/data/listings-tm-browser-${qty}.json`,
        { fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), quotes: collected },
        `Ticketmaster listings (blocks of ${qty}, browser collector)`);

      // Publish Ticketmaster's official per-section face values, keyed
      // "gamePk|SECTION" (and the section's canonical code when the app's
      // classifier is on this page) so the app's face store can merge them.
      const faces = {};
      const classify = (window.Sections && window.Sections.classify) || null;
      for (const q of collected) {
        if (q.faceValue == null || !q.gamePk) continue;
        const sec = String(q.section).replace(/\s*\(obstructed\)$/, "").toUpperCase();
        faces[`${q.gamePk}|${sec}`] = q.faceValue;
        try {
          const code = classify && classify(sec).code;
          if (code) faces[`${q.gamePk}|${code}`] = q.faceValue;
        } catch (e) {}
      }
      if (!probeOnly && Object.keys(faces).length) {
        await putFile("/contents/data/face-values-tm-browser.json",
          { fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), faces },
          "Ticketmaster official face values (browser collector)");
      }
    }
    const games = new Set(collected.map((q) => q.gamePk)).size;
    if (probeOnly) {
      setChip(firstRes && firstRes.diag && !firstRes.diag.blocked
        ? `TM probe: ${collected.length} sections captured ✓ (tell Claude)`
        : "TM probe: blocked/empty — see _tm-diag.json");
    } else {
      setChip(collected.length ? `Ticketmaster: ${collected.length} prices across ${games} games`
                               : "Ticketmaster: 0 (blocked or empty)");
    }
    return collected.length;
  }
  const runTicketmaster = () => collectTicketmaster(false);

  // Open the TickPick Yankees team page in one tab; it discovers every home
  // game and fetches each event's internal API (per-section prices + NY-law
  // face values). Publishes listings-tickpick-<qty>.json and the face map.
  async function runTickPick() {
    const qty = qtyNow();
    GM_deleteValue("yk_tp_apiresult");
    GM_setValue("yk_tp_apijob", { active: true, startedAt: Date.now(), qty });
    setChip("TickPick: opening…", true);
    const tab = GM_openInTab("https://www.tickpick.com/mlb/new-york-yankees-tickets/",
      { active: true, insert: true });
    let res = null;
    const started = Date.now();
    for (let w = 0; w < 400; w++) {                        // up to ~200s
      res = GM_getValue("yk_tp_apiresult", null);
      if (res) break;
      setChip(`TickPick: collecting… (${Math.round((Date.now() - started) / 1000)}s)`, true);
      await sleep(500);
    }
    try { tab.close(); } catch {}
    GM_setValue("yk_tp_apijob", { active: false, startedAt: 0 });

    const byEid = (res && res.byEid) || {};
    const collected = [];
    const faces = {};
    const classify = (window.Sections && window.Sections.classify) || null;
    for (const info of Object.values(byEid)) {
      const pk = sgGamePk(info.date, info.hour);
      if (!pk || !Array.isArray(info.quotes)) continue;
      for (const q of info.quotes) {
        collected.push({ gamePk: pk, provider: "TickPick", section: q.section,
          price: q.price, faceValue: q.faceValue, url: info.url });
      }
      for (const [sec, face] of Object.entries(info.faces || {})) {
        faces[`${pk}|${sec}`] = face;
        try { const code = classify && classify(sec).code; if (code) faces[`${pk}|${code}`] = face; } catch (e) {}
      }
    }

    await putFile("/contents/data/_tickpick-diag.json",
      { fetchedAt: new Date().toISOString(),
        result: res ? res.diag : "no result (team-page tab produced nothing)",
        games: new Set(collected.map((q) => q.gamePk)).size, quotes: collected.length,
        faces: Object.keys(faces).length },
      "TickPick collector diagnostic");
    if (collected.length) {
      await putFile(`/contents/data/listings-tickpick-${qty}.json`,
        { fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), quotes: collected },
        `TickPick listings (blocks of ${qty}, browser collector)`);
    }
    if (Object.keys(faces).length) {
      await putFile("/contents/data/face-values-tickpick.json",
        { fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), faces },
        "TickPick per-section face values (NY-law disclosures)");
    }
    const games = new Set(collected.map((q) => q.gamePk)).size;
    setChip(collected.length
      ? `TickPick: ${collected.length} prices / ${Object.keys(faces).length} faces across ${games} games`
      : (res && res.diag && res.diag.blocked ? "TickPick: blocked by DataDome — try later"
                                             : "TickPick: 0 (blocked or empty)"));
    return collected.length;
  }

  async function runAll() {
    if (running) return null;
    if (!settings().ghToken) { setChip("Set the access key in Settings first"); return null; }
    running = true;
    try {
      setChip("Ticketmaster…", true);
      const tm = await runTicketmaster();
      setChip("TickPick…", true);
      const tp = await runTickPick();
      setChip("StubHub…", true);
      const sh = await runStubHub();
      setChip("SeatGeek…", true);
      const sg = await runSeatGeek();
      setChip(`Done: TM ${tm}, TickPick ${tp}, StubHub ${sh}, SeatGeek ${sg}. Press Search.`);
      return { tm: tm || 0, tp: tp || 0, sh: sh || 0, sg: sg || 0,
        total: (tm || 0) + (tp || 0) + (sh || 0) + (sg || 0) };
    } catch (e) {
      console.error("[collector]", e);
      setChip("Collector error — see console");
      return null;
    } finally { running = false; }
  }

  /* ═══════════════════════ opportunistic auto-collect ════════════════════
     So the machine only needs to be on *sometimes*: whenever this browser has
     the aggregator open, collect on startup and then every few hours. Spacing
     + DataDome back-off keep it gentle; it only runs on a maintainer's browser
     (the access key must be set) and never overlaps a manual collection. */
  const AUTORUN_ON = "yk_autorun_on";        // enabled? (default true)
  const AUTORUN_LAST = "yk_autorun_last";    // ms timestamp of last attempt
  const AUTORUN_WAIT = "yk_autorun_wait";    // current spacing in ms
  const AUTORUN_BASE = 3 * 60 * 60 * 1000;   // 3h between healthy runs
  const AUTORUN_MAX = 12 * 60 * 60 * 1000;   // back off to 12h when blocked
  const autoRunOn = () => GM_getValue(AUTORUN_ON, true);

  async function maybeAutoRun(reason) {
    if (!autoRunOn() || running) return;
    if (!settings().ghToken) return;                 // maintainer devices only
    const wait = GM_getValue(AUTORUN_WAIT, AUTORUN_BASE);
    const last = GM_getValue(AUTORUN_LAST, 0);
    if (Date.now() - last < wait) return;            // too soon
    GM_setValue(AUTORUN_LAST, Date.now());           // debounce reloads/other tabs
    console.log(`[collector] auto-collect (${reason})`);
    const res = await runAll();
    if (!res) { GM_setValue(AUTORUN_LAST, Date.now()); return; }
    // Adapt spacing: a dry run (everything blocked/empty) backs off; a
    // productive run resets to the base interval.
    const next = res.total > 0 ? AUTORUN_BASE : Math.min(AUTORUN_MAX, wait * 2);
    GM_setValue(AUTORUN_WAIT, next);
    GM_setValue(AUTORUN_LAST, Date.now());
    const hrs = Math.round(next / 3600000);
    setChip(`Auto-collect done (TM ${res.tm}, SH ${res.sh}, SG ${res.sg}) · next in ~${hrs}h`);
  }

  function startAutoRun() {
    // A grace delay after load so opening the page to just look at prices isn't
    // immediately hijacked; then a periodic check while the tab stays open.
    setTimeout(() => maybeAutoRun("startup").catch((e) => console.error(e)), 45000);
    setInterval(() => maybeAutoRun("timer").catch((e) => console.error(e)), 15 * 60 * 1000);
  }

  // Gentle single-game probe: opens ONE SeatGeek event tab and reports the full
  // price-API URL it calls (event_listings_v2, with query). One page load — no
  // flood — so it won't trip SeatGeek's CDN rate limit. Used to build a direct-
  // fetch collector that avoids opening a foreground tab per game.
  async function probeSeatGeekApi() {
    const url = (sgUpcoming().slice(-1)[0] || {}).url || SEATGEEK_URLS[SEATGEEK_URLS.length - 1];
    const eid = (url.match(/\/(\d{5,})/) || [])[1];
    GM_deleteValue("yk_sg_result_" + eid);
    GM_setValue("yk_sg_job", { active: true, startedAt: Date.now() });
    setChip("Probing SeatGeek API (1 tab)…", true);
    const tab = GM_openInTab(url + "?quantity=2", { active: true, insert: true });
    let r = null;
    for (let w = 0; w < 130; w++) { r = GM_getValue("yk_sg_result_" + eid, null); if (r) break; await sleep(500); }
    try { tab.close(); } catch {}
    GM_setValue("yk_sg_job", { active: false, startedAt: 0 });
    const apiUrl = r && r.diag && r.diag.listings_api_url;
    console.log("[collector/SeatGeek] listings_api_url =", apiUrl, "sections =", r && r.quotes && r.quotes.length, r && r.diag);
    await putFile("/contents/data/_seatgeek-apiurl.json",
      { fetchedAt: new Date().toISOString(), eid, apiUrl: apiUrl || null,
        sections: r && r.quotes ? r.quotes.length : 0,
        cap_urls: r && r.diag ? r.diag.cap_urls_all : null },
      "SeatGeek API URL probe");
    setChip(apiUrl ? "API URL captured ✓ (tell Claude)" : "API URL not captured — see console");
  }

  GM_registerMenuCommand("Collect all (TM + SeatGeek + StubHub) now", runAll);
  GM_registerMenuCommand("Collect Ticketmaster only", async () => { if (!running) { running = true; try { const n = await runTicketmaster(); setChip(`Ticketmaster done: ${n}`); } finally { running = false; } } });
  GM_registerMenuCommand("Probe Ticketmaster (1 game)", async () => { if (!running) { running = true; try { await collectTicketmaster(true); } finally { running = false; } } });
  GM_registerMenuCommand("Collect TickPick only", async () => { if (!running) { running = true; try { const n = await runTickPick(); setChip(`TickPick done: ${n}`); } finally { running = false; } } });
  GM_registerMenuCommand("Collect StubHub only", async () => { if (!running) { running = true; try { const n = await runStubHub(); setChip(`StubHub done: ${n}`); } finally { running = false; } } });
  GM_registerMenuCommand("Collect SeatGeek only", async () => { if (!running) { running = true; try { const n = await runSeatGeek(); setChip(`SeatGeek done: ${n}`); } finally { running = false; } } });
  GM_registerMenuCommand("Probe SeatGeek API (1 game)", async () => { if (!running) { running = true; try { await probeSeatGeekApi(); } finally { running = false; } } });
  GM_registerMenuCommand(
    autoRunOn() ? "Auto-collect: ON — click to disable" : "Auto-collect: OFF — click to enable",
    () => {
      const on = !autoRunOn();
      GM_setValue(AUTORUN_ON, on);
      if (on) GM_setValue(AUTORUN_LAST, 0);   // allow a run right away
      setChip(on ? "Auto-collect ON — will collect on startup + every few hours while open"
                 : "Auto-collect OFF");
    });

  function wire() {
    document.querySelectorAll(".refresh-btn").forEach((b) => {
      if (b.dataset.collWired) return;
      b.dataset.collWired = "1";
      b.addEventListener("click", () => runAll());
    });
    setChip("Ticketmaster + SeatGeek + StubHub ready (this browser)");
    startAutoRun();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
