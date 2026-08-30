/*
 * StubHub event pages for the 2026 remaining Yankees home games, keyed by
 * MLB gamePk. StubHub can't be scraped (it serves automated browsers an
 * empty page), so instead every section row links to that game's exact
 * StubHub event page for a quick manual price check.
 *
 * Harvested 2026-08-25 (event IDs run sequentially per home game; the two
 * rescheduled doubleheader openers keep their original-date IDs). StubHub
 * routes by event ID — the date in the slug is cosmetic. Section filtering
 * isn't possible via the URL, so the link lands on the game with the
 * quantity applied and you pick the section on StubHub's seat map.
 *
 * Regenerate for a new season by re-running the ticket-scraper discovery.
 */
(function () {
  "use strict";
  const S = (slug, id) =>
    `https://www.stubhub.com/new-york-yankees-bronx-tickets-${slug}/event/${id}/`;

  // gamePk -> StubHub event URL
  window.STUBHUB_EVENTS = {
    823505: S("8-25-2026", 159257453),
    823506: S("8-26-2026", 159257454),
    823503: S("8-27-2026", 159257455),
    823504: S("8-28-2026", 159257456),
    823539: S("8-29-2026", 159257421), // Red Sox doubleheader, 1:05 PM
    823501: S("8-29-2026", 159257457), // Red Sox doubleheader, 7:15 PM
    823502: S("8-30-2026", 159257458),
    823500: S("9-8-2026", 159257459),
    823497: S("9-9-2026", 159257460),
    823499: S("9-10-2026", 159257461),
    823498: S("9-11-2026", 159257462),
    823496: S("9-12-2026", 159257463),
    823495: S("9-13-2026", 159257464),
    823543: S("9-22-2026", 159257415), // Rays doubleheader, 1:05 PM
    823494: S("9-22-2026", 159257465), // Rays doubleheader, 7:05 PM
    823492: S("9-23-2026", 159257466),
    823493: S("9-24-2026", 159257467),
    823491: S("9-25-2026", 159257468),
    823489: S("9-26-2026", 159257469),
    823490: S("9-27-2026", 159257470),
  };

  // Build the per-row link: exact event page + quantity. Falls back to a
  // StubHub search for the game if a gamePk isn't in the map (e.g. a
  // postseason game added later).
  window.stubhubLink = function (gamePk, qty, opponent, dateShort) {
    const base = window.STUBHUB_EVENTS[gamePk];
    if (base) return base + "?quantity=" + (qty || 2);
    return (
      "https://www.stubhub.com/secure/search?q=" +
      encodeURIComponent(`New York Yankees vs ${opponent || ""} ${dateShort || ""}`)
    );
  };
})();
