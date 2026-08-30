// ==UserScript==
// @name         NYY Aggregator — StubHub collector
// @namespace    boxoprofundo.github.io/yankees-tickets
// @version      1.0.0
// @description  Scrapes StubHub Yankees prices from YOUR real logged-in browser (where StubHub renders normally) and publishes them to the aggregator. Triggered by the site's Refresh button.
// @author       boxoprofundo
// @match        https://boxoprofundo.github.io/yankees-tickets/*
// @match        https://yankees.mikeboxer.com/*
// @match        https://www.stubhub.com/new-york-yankees-bronx-tickets*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// @run-at       document-idle
// ==/UserScript==

/*
 * Why this exists: StubHub serves *automation* browsers a blank page, but your
 * real Chrome renders it fine. This userscript runs the StubHub scrape inside
 * your genuine browser session, so the listings are actually there to read.
 *
 * Flow:
 *   • On the aggregator site it hooks "Refresh prices" (and adds its own
 *     button). When you refresh from THIS browser, it opens each StubHub game
 *     page in a background tab, one at a time.
 *   • On each StubHub page it reads the section/price listings and hands them
 *     back. The controller assembles them and commits
 *     yankees-tickets/data/listings-stubhub-<qty>.json to the site via the
 *     GitHub token you already saved in Settings — so the site merges it in
 *     like every other source.
 *
 * It only works in the browser where this script is installed. Refreshing from
 * a phone or another computer still updates every other site, just not StubHub.
 */

(function () {
  "use strict";

  const PAGES_REPO = "boxoprofundo/yankees";
  const S = (slug, id) =>
    `https://www.stubhub.com/new-york-yankees-bronx-tickets-${slug}/event/${id}/`;

  // gamePk -> StubHub event URL (mirror of stubhub-events.js). Regenerate for
  // a new season alongside that file.
  const EVENTS = {
    823505: S("8-25-2026", 159257453), 823506: S("8-26-2026", 159257454),
    823503: S("8-27-2026", 159257455), 823504: S("8-28-2026", 159257456),
    823539: S("8-29-2026", 159257421), 823501: S("8-29-2026", 159257457),
    823502: S("8-30-2026", 159257458), 823500: S("9-8-2026", 159257459),
    823497: S("9-9-2026", 159257460),  823499: S("9-10-2026", 159257461),
    823498: S("9-11-2026", 159257462), 823496: S("9-12-2026", 159257463),
    823495: S("9-13-2026", 159257464), 823543: S("9-22-2026", 159257415),
    823494: S("9-22-2026", 159257465), 823492: S("9-23-2026", 159257466),
    823493: S("9-24-2026", 159257467), 823491: S("9-25-2026", 159257468),
    823489: S("9-26-2026", 159257469), 823490: S("9-27-2026", 159257470),
  };
  const ID_TO_GAME = {};
  for (const [pk, url] of Object.entries(EVENTS)) {
    const m = url.match(/event\/(\d+)/);
    if (m) ID_TO_GAME[m[1]] = Number(pk);
  }

  const onStubHub = location.host.includes("stubhub.com");
  const onAggregator = location.host.includes("boxoprofundo.github.io");

  /* ─────────────────────────── StubHub worker ─────────────────────────── */
  // Runs in each StubHub tab: waits for listings, expands them, extracts
  // (section, per-ticket price, obstructed), and hands the result back via
  // shared storage keyed by gamePk. Mirrors ariana_2tickets.scrape_stubhub.
  if (onStubHub) {
    const idMatch = location.pathname.match(/event\/(\d+)/);
    const gamePk = idMatch ? ID_TO_GAME[idMatch[1]] : null;
    // Only act when a collection job is live (so ordinary manual visits to
    // StubHub don't fire off scraping).
    const job = GM_getValue("yk_stub_job", null);
    if (gamePk && job && job.active && (Date.now() - job.startedAt) < 30 * 60000) {
      runWorker(gamePk).catch((e) => console.error("[StubHub collector]", e));
    }
    return;

    async function runWorker(pk) {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // Wait for listings to render.
      for (let i = 0; i < 40; i++) {
        const t = document.body ? document.body.innerText : "";
        if ((t.match(/\$\s*\d{2,}/g) || []).length >= 3) break;
        await sleep(300);
      }
      // Expand "Show more" a handful of times.
      for (let round = 0; round < 15; round++) {
        const clicked = clickShowMore();
        if (!clicked) break;
        await sleep(1400);
      }
      const body = document.body ? document.body.innerText : "";
      const quotes = extractQuotes(body, pk);
      console.log(`[StubHub collector] game ${pk}: ${quotes.length} sections`);
      GM_setValue("yk_stub_result_" + pk, { ts: Date.now(), quotes, chars: body.length });
    }

    function clickShowMore() {
      window.scrollTo(0, document.body.scrollHeight);
      const els = document.querySelectorAll('button, a, [role="button"], div[tabindex], span[tabindex]');
      for (const el of els) {
        const t = (el.innerText || "").trim().toLowerCase();
        if (["show more", "view more", "load more", "see more", "show all"].includes(t)) {
          el.scrollIntoView({ block: "center" });
          el.click();
          return true;
        }
      }
      return false;
    }
  }

  // Section code pattern + price extraction, ported from the Python scraper.
  const SECTION_CODE = "(?:NORD[A-Za-z0-9]*|FLOOR[A-Za-z0-9]*|[A-Za-z]*\\d[A-Za-z0-9]*|[A-Z]{1,2})";
  function extractQuotes(body, gamePk) {
    const url = EVENTS[gamePk];
    const re = new RegExp("(?=\\bSection\\s+" + SECTION_CODE + "\\b)");
    const chunks = body.split(re);
    const bySec = {};
    for (const chunk of chunks) {
      const sm = chunk.match(new RegExp("^\\bSection\\s+(" + SECTION_CODE + ")\\b"));
      if (!sm) continue;
      const sec = sm[1].trim().toUpperCase();
      const fees = chunk.match(/incl\.?\s*fees/i);
      if (!fees) continue;
      const before = chunk.slice(0, fees.index);
      const priceMatches = [...before.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)];
      if (!priceMatches.length) continue;
      const price = parseFloat(priceMatches[priceMatches.length - 1][1].replace(/,/g, ""));
      if (!(price > 20 && price < 50000)) continue;
      const obstructed = /obstruct/i.test(chunk.slice(0, (fees.index || 0) + 20));
      if (!(sec in bySec) || price < bySec[sec].price) {
        bySec[sec] = { price, obstructed };
      }
    }
    return Object.entries(bySec).map(([sec, v]) => ({
      gamePk,
      provider: "StubHub",
      section: v.obstructed ? `${sec} (obstructed)` : sec,
      price: Math.round(v.price * 100) / 100,
      faceValue: null,
      url,
    }));
  }

  /* ────────────────────────── Aggregator controller ───────────────────── */
  if (!onAggregator) return;

  function settings() {
    try { return JSON.parse(localStorage.getItem("ytf-settings")) || {}; }
    catch { return {}; }
  }
  function qtyNow() {
    const el = document.querySelector("#qty-all") || document.querySelector("#qty-specific");
    return Math.max(1, Math.min(12, parseInt(el && el.value, 10) || 2));
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // A small status chip so you can see the collector is installed & working.
  let chip;
  function setChip(text, busy) {
    if (!chip) {
      chip = document.createElement("div");
      chip.id = "stub-chip";
      chip.style.cssText =
        "position:fixed;right:12px;bottom:12px;z-index:9999;background:#0c2340;color:#fff;" +
        "font:600 12px/1.3 -apple-system,system-ui,sans-serif;padding:.5rem .7rem;border-radius:8px;" +
        "box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:16rem;cursor:pointer;";
      chip.title = "StubHub collector (this browser). Click to scrape StubHub now.";
      chip.addEventListener("click", () => startStubHub());
      document.body.appendChild(chip);
    }
    chip.textContent = (busy ? "⏳ " : "🎟️ ") + text;
  }

  async function ghApi(method, path, body) {
    const token = settings().ghToken;
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: "https://api.github.com/repos/" + PAGES_REPO + path,
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/vnd.github+json",
        },
        data: body ? JSON.stringify(body) : undefined,
        onload: (r) => resolve({ status: r.status, json: safeJson(r.responseText) }),
        onerror: (e) => reject(e),
      });
    });
  }
  function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }
  function b64(str) { return btoa(unescape(encodeURIComponent(str))); }

  async function publish(qty, quotes) {
    const path = `/contents/data/listings-stubhub-${qty}.json`;
    const payload = {
      fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      quotes,
    };
    let sha;
    const cur = await ghApi("GET", path + "?ref=main");
    if (cur.status === 200 && cur.json && cur.json.sha) sha = cur.json.sha;
    const res = await ghApi("PUT", path, {
      message: `StubHub listings (blocks of ${qty}, browser collector)`,
      content: b64(JSON.stringify(payload, null, 2) + "\n"),
      sha,
      branch: "main",
    });
    if (res.status >= 300) throw new Error("GitHub PUT " + res.status);
  }

  let running = false;
  async function startStubHub() {
    if (running) return;
    const token = settings().ghToken;
    if (!token) { setChip("Set the access key in Settings first"); return; }
    running = true;
    const qty = qtyNow();
    const games = Object.keys(EVENTS).map(Number);
    GM_setValue("yk_stub_job", { active: true, startedAt: Date.now() });
    for (const pk of games) GM_deleteValue("yk_stub_result_" + pk);

    const collected = [];
    try {
      for (let i = 0; i < games.length; i++) {
        const pk = games[i];
        setChip(`StubHub ${i + 1}/${games.length}…`, true);
        const tab = GM_openInTab(EVENTS[pk] + "?quantity=" + qty, { active: false, insert: true });
        // Wait for the worker in that tab to post a result (or time out).
        let result = null;
        for (let w = 0; w < 60; w++) {           // up to ~30s
          result = GM_getValue("yk_stub_result_" + pk, null);
          if (result) break;
          await sleep(500);
        }
        try { tab.close(); } catch {}
        if (result && result.quotes) collected.push(...result.quotes);
        await sleep(6000 + Math.random() * 4000);  // gentle gap between games
      }
      setChip(`Publishing ${collected.length} StubHub prices…`, true);
      await publish(qty, collected);
      setChip(`StubHub done: ${collected.length} prices. Press Search.`);
    } catch (e) {
      console.error("[StubHub collector]", e);
      setChip("StubHub collection error — see console");
    } finally {
      GM_setValue("yk_stub_job", { active: false, startedAt: 0 });
      running = false;
    }
  }

  // Hook the site's Refresh buttons so a normal refresh from this browser also
  // runs StubHub, and show the ready chip.
  function wire() {
    document.querySelectorAll(".refresh-btn").forEach((b) => {
      if (b.dataset.stubWired) return;
      b.dataset.stubWired = "1";
      b.addEventListener("click", () => startStubHub());
    });
    setChip("StubHub ready (this browser)");
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
