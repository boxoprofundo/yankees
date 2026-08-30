/*
 * Marketplace adapters.
 *
 * Every adapter implements:
 *   search(games, qty, settings) -> Promise<Quote[]>
 *
 * Quote = {
 *   gamePk:    number       // MLB gamePk this quote belongs to
 *   provider:  string       // display name
 *   section:   string|null  // stadium section, when the source exposes it
 *   price:     number|null  // lowest per-ticket price for a block of `qty`
 *   faceValue: number|null  // primary-market price where known
 *   url:       string       // where to buy / verify
 * }
 *
 * Only Ticketmaster and SeatGeek offer public, browser-callable (CORS-enabled)
 * APIs, and both are event-level: they report a lowest listed price for the
 * whole game, not per section. The other four marketplaces have no public API,
 * so their adapters return link-only quotes (price null) pointing at a search
 * for the right game with the quantity applied where the site supports it.
 */

(function () {
  "use strict";

  const YANKEE_STADIUM = /yankee stadium/i;

  function money(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function gameQuery(game) {
    return `New York Yankees vs ${game.opponent} ${game.dateShort}`;
  }

  /* ---------------- Ticketmaster (Discovery API, free key) --------------- */

  const ticketmaster = {
    id: "ticketmaster",
    name: "Ticketmaster",
    async search(games, qty, settings) {
      const fallback = games.map((g) => ({
        gamePk: g.gamePk,
        provider: this.name,
        section: null,
        price: null,
        faceValue: null,
        url:
          "https://www.ticketmaster.com/search?q=" +
          encodeURIComponent(gameQuery(g)),
      }));
      if (!settings.tmKey) return fallback;

      const last = games[games.length - 1];
      const end = new Date(last.dateUTC.getTime() + 12 * 3600 * 1000);
      const params = new URLSearchParams({
        apikey: settings.tmKey,
        keyword: "New York Yankees",
        classificationName: "Baseball",
        size: "199",
        sort: "date,asc",
        startDateTime: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        endDateTime: end.toISOString().replace(/\.\d{3}Z$/, "Z"),
      });
      const res = await fetch(
        "https://app.ticketmaster.com/discovery/v2/events.json?" + params
      );
      if (!res.ok) throw new Error("Ticketmaster API HTTP " + res.status);
      const data = await res.json();
      const events = (data._embedded && data._embedded.events) || [];

      return games.map((g, i) => {
        const ev = events.find((e) => {
          const venue =
            e._embedded && e._embedded.venues && e._embedded.venues[0];
          if (!venue || !YANKEE_STADIUM.test(venue.name || "")) return false;
          if (/parking/i.test(e.name || "")) return false;
          return e.dates && e.dates.start &&
            e.dates.start.localDate === g.isoDateET;
        });
        if (!ev) return fallback[i];
        const std =
          (ev.priceRanges || []).find((p) => p.type === "standard") ||
          (ev.priceRanges || [])[0];
        return {
          gamePk: g.gamePk,
          provider: this.name,
          section: null,
          price: std ? money(std.min) : null,
          faceValue: std ? money(std.min) : null,
          url: ev.url || fallback[i].url,
        };
      });
    },
  };

  /* ------------------- SeatGeek (public API, free key) ------------------- */

  const seatgeek = {
    id: "seatgeek",
    name: "SeatGeek",
    async search(games, qty, settings) {
      const fallback = games.map((g) => ({
        gamePk: g.gamePk,
        provider: this.name,
        section: null,
        price: null,
        faceValue: null,
        url:
          "https://seatgeek.com/search?search=" +
          encodeURIComponent(gameQuery(g)),
      }));
      if (!settings.sgKey) return fallback;

      const params = new URLSearchParams({
        client_id: settings.sgKey,
        per_page: "100",
        sort: "datetime_utc.asc",
        "datetime_utc.gte": new Date().toISOString().slice(0, 19),
      });
      // Any event with the Yankees as a performer; the per-game date match
      // below narrows it to home games (a home game and an away game can't
      // share a date). More reliable than the home_team taxonomy filter.
      params.append("performers.slug", "new-york-yankees");
      const res = await fetch("https://api.seatgeek.com/2/events?" + params);
      if (!res.ok) throw new Error("SeatGeek API HTTP " + res.status);
      const data = await res.json();
      const events = data.events || [];

      return games.map((g, i) => {
        const ev = events.find((e) => {
          const t = Date.parse(e.datetime_utc + "Z");
          return Math.abs(t - g.dateUTC.getTime()) < 6 * 3600 * 1000;
        });
        if (!ev) return fallback[i];
        return {
          gamePk: g.gamePk,
          provider: this.name,
          section: null,
          price: money(ev.stats && ev.stats.lowest_price),
          faceValue: null,
          url: ev.url
            ? ev.url + (ev.url.includes("?") ? "&" : "?") + "quantity=" + qty
            : fallback[i].url,
        };
      });
    },
  };

  /* --------------- Link-only marketplaces (no public API) ---------------- */

  function linkProvider(name, buildUrl) {
    return {
      id: name.toLowerCase().replace(/\s/g, ""),
      name,
      async search(games, qty) {
        return games.map((g) => ({
          gamePk: g.gamePk,
          provider: name,
          section: null,
          price: null,
          faceValue: null,
          url: buildUrl(g, qty),
        }));
      },
    };
  }

  const stubhub = linkProvider("StubHub", (g) =>
    "https://www.stubhub.com/secure/search?q=" +
    encodeURIComponent(gameQuery(g))
  );

  const vividseats = linkProvider("Vivid Seats", (g) =>
    "https://www.vividseats.com/search?searchTerm=" +
    encodeURIComponent(gameQuery(g))
  );

  const tickpick = linkProvider("TickPick", (g) =>
    "https://www.tickpick.com/search?q=" + encodeURIComponent(gameQuery(g))
  );

  const xp = linkProvider("XP", (g) =>
    "https://xp.tickets/search?q=" + encodeURIComponent(gameQuery(g))
  );

  // No public API either, but the ticket-scraper repo covers it, so cached
  // listings regularly carry Gametime prices.
  const gametime = linkProvider("Gametime", () =>
    "https://gametime.co/mlb-baseball/yankees-tickets"
  );

  window.PROVIDERS = [ticketmaster, seatgeek, stubhub, xp, vividseats, tickpick, gametime];
})();
