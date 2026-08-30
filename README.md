# Yankees Ticket Finder

A static web app (served by GitHub Pages at `/yankees-tickets/`) that takes a
ticket quantity and finds, for each section of Yankee Stadium, the cheapest
block of that size across **every remaining Yankees home game**, comparing
Ticketmaster, SeatGeek, StubHub, XP, Vivid Seats and TickPick.

## How it works

1. **Schedule** — every remaining home game (date, time, opponent) comes from
   the free, keyless MLB Stats API (`statsapi.mlb.com`), which allows
   cross-origin browser requests. This always works, no setup needed.
2. **Prices** — each marketplace has an adapter in `providers.js`:

   | Marketplace | Live data from the browser? | What you get |
   |---|---|---|
   | Ticketmaster | ✅ with a free [Discovery API key](https://developer.ticketmaster.com/) | Event link + standard price range; the range minimum doubles as the approximate **face value** (Ticketmaster is the Yankees' primary seller) |
   | SeatGeek | ✅ with a free [client ID](https://seatgeek.com/account/develop) | Lowest listed price per game + event link with your quantity pre-applied |
   | StubHub | ❌ | Direct search link for the exact game |
   | XP (xp.tickets) | ❌ | Direct search link for the exact game |
   | Vivid Seats | ❌ | Direct search link for the exact game |
   | TickPick | ❌ | Direct search link for the exact game |
   | Gametime | ❌ | Yankees schedule link; prices arrive via the scraper data files below |

3. **Aggregation** — all quotes are pooled and, for each stadium section, the
   single cheapest per-ticket price (and block total) across all games and
   marketplaces is shown with the game's date/time, opponent, marketplace,
   link and face value. Columns are sortable.

## Why not live per-section prices from all six sites?

GitHub Pages is static hosting — there is no server, so every request runs in
the visitor's browser, and browsers enforce CORS. StubHub, Vivid Seats,
TickPick and XP publish **no public API** and do not allow cross-origin
browser requests to their internal listing endpoints; section-level listing
feeds on all six sites are partner/enterprise APIs. That is a hard platform
constraint, not a missing feature — no purely static page can do it.

**Demo mode** (checkbox next to Search) generates realistic sample listings
for every section so the full aggregation UI can be exercised; demo rows are
clearly labeled.

## When do prices update?

**When you ask, from this page.** Nothing runs on a schedule:

- **Search** — with API keys saved in Settings, every press queries
  Ticketmaster and SeatGeek live from your browser at that moment, and also
  loads the latest scraped prices for the other marketplaces.
- **↻ Refresh prices** — with the one-time access key saved in Settings
  (the pre-filled setup link is right next to the box), the button starts
  the scraper in the companion ticket-scraper repo on GitHub's servers,
  shows progress, and loads the fresh per-section prices automatically when
  it finishes. With the key, Search reads results straight from that repo's
  `published/` folder via the GitHub API — no publish step needed at all.

## Optional: shared cached prices for visitors without keys

A manual-only GitHub Action (`.github/workflows/update-listings.yml`, run
from the repo's Actions tab whenever you like) executes
`scripts/fetch-listings.mjs` on GitHub's servers (server-side, so no CORS),
collects Ticketmaster and SeatGeek prices, and commits them to
`yankees-tickets/data/listings.json`. The app merges that file into every
search, so visitors without keys still see those prices. Live quotes fetched
in the browser always override the cached file.

To enable it, add the API keys as repository secrets — they stay private on
GitHub and never appear in the site's code:

1. Get the free keys: a Ticketmaster "Consumer Key" from
   [developer.ticketmaster.com](https://developer.ticketmaster.com/) and a
   SeatGeek "client ID" from
   [seatgeek.com/account/develop](https://seatgeek.com/account/develop).
2. On GitHub: repo **Settings → Secrets and variables → Actions →
   New repository secret**. Add `TICKETMASTER_API_KEY` and
   `SEATGEEK_CLIENT_ID` with those values.
3. Trigger a run from the **Actions** tab → "Update ticket listings" →
   "Run workflow".

Until secrets are added, the workflow runs harmlessly and writes nothing.

## Plugging in your own scrapers (StubHub, XP, Vivid Seats, TickPick…)

Any program that can fetch prices — including scrapers you already run on
your own computer — can feed this app. The contract is one JSON file:

- `yankees-tickets/data/listings.json` — generic prices, or
- `yankees-tickets/data/listings-<qty>.json` — prices for blocks of exactly
  `<qty>` tickets (e.g. `listings-4.json`). When someone searches for 4
  tickets, the app prefers `listings-4.json` and falls back to
  `listings.json`.

File format:

```json
{
  "fetchedAt": "2026-08-25T18:00:00Z",
  "quotes": [
    {
      "gamePk": 813205,
      "provider": "StubHub",
      "section": "214",
      "price": 87.5,
      "faceValue": 70,
      "url": "https://www.stubhub.com/...event page, section-filtered if possible..."
    }
  ]
}
```

- `gamePk` is MLB's ID for the game. Get the mapping of remaining home games
  by running `node scripts/fetch-listings.mjs` (it prints nothing sensitive
  and needs no keys for the schedule), or fetch
  `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=147&startDate=<today>&endDate=<year>-11-15`
  and read `dates[].games[].gamePk`.
- `provider` should be one of: `Ticketmaster`, `SeatGeek`, `StubHub`, `XP`,
  `Vivid Seats`, `TickPick`, `Gametime` (matching these names makes the per-game table
  line up; other names still work in the section table).
- `section` filled in → the quote appears in the per-section table; the
  cheapest per section across all games wins automatically. `section: null`
  → event-level only.
- `price` is per ticket. `faceValue` and `url` are optional but feed the
  Face value and Link columns.

Workflow that fits the existing setup on this site: run the scraper on your
own machine on whatever schedule you like (or right before you search),
write the file(s) into `yankees-tickets/data/`, then `git commit` and
`git push` — GitHub Pages republishes in under a minute and the next Search
includes the data (the status bar shows its `fetchedAt` age). Stale games
(already played) are filtered out automatically, so leftover quotes do no
harm.

Alternatively, normalize a source directly in `scripts/fetch-listings.mjs`
and run it via the manual GitHub Action — but note that runs from GitHub's
data-center IPs are more likely to be blocked by marketplace bot-detection
than runs from a home connection. Whether to scrape marketplaces whose terms
of service prohibit it is your call, not the app's; this design keeps that
decision (and any credentials) off the public site entirely.

## Files

- `index.html` — UI shell, settings panel
- `style.css` — styling
- `app.js` — schedule fetch, orchestration, aggregation, rendering
- `providers.js` — one adapter per marketplace (documented `Quote` shape)
- `demo-data.js` — Yankee Stadium section chart + deterministic sample data

API keys are stored in `localStorage` in your browser only; they are never
committed or sent anywhere except to the marketplace that issued them.
