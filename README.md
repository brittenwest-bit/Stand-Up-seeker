# Stand Up Seeker — source-agnostic build

This version does **not require Ticketmaster**. Stand Up Seeker owns a normalized show record and can merge many discovery/verification sources into one listing.

## Ticket destination priority
The UI always says **Official Tickets**. The backend chooses the best available destination in this order:
1. explicit primary/official ticket URL stored on the show
2. comedian official tour-page link
3. venue official event-page link
4. primary ticketing platform link (AXS / Etix / Eventbrite / Ticketmaster, etc.)

Ticketmaster is optional and is treated only as an extra discovery source when `TICKETMASTER_API_KEY` exists.

## What works now
- Runs with no API keys
- Normalized Stand Up Seeker event store (`data/events.json`)
- Source-agnostic event records
- Multiple verification sources per show
- Deduplication across feeds by comedian + venue + date + time
- Confidence/verification metadata
- Official Tickets button rather than seller branding
- Optional Ticketmaster adapter (`providers/ticketmaster.js`)
- Cleared-image logic with fallback initials

## Run locally
```bash
npm install
npm start
```
Then open `http://localhost:3000`.

Optional Ticketmaster enrichment:
```bash
TICKETMASTER_API_KEY=your_key_here npm start
```

## Adding real official listings
Add normalized events to `data/events.json`, or build source adapters that emit the same record shape. Each show can have:
- `officialArtistUrl`
- `officialVenueUrl`
- `primaryTicketUrl`
- `ticketProvider`
- `verificationSources[]`
- `confidence`
- `imageUrl` / `imageRights`

The next production step is to add per-site adapters or a scheduled ingestion worker for the curated comedian roster and venue calendars. Generic scraping is intentionally not embedded because official sites differ and some prohibit automated access; adapters should obey each site's terms/robots and prefer structured feeds when available.
