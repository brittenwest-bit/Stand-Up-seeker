# Stand Up Seeker — API-ready Vercel build

This build adds a working Vercel serverless endpoint at `api/events.js` and a normalized seed store at `data/events.json`.

## Deploy/update on Vercel
Upload the **contents** of this folder to the existing GitHub `Stand-Up-seeker` repository and commit the changes. Vercel will automatically redeploy the existing project.

No API key or environment variable is required for this API-ready version.

## Test after deployment
Open your live site and search **Boston / October 29, 2026**. You should see one clearly labeled demo listing rather than “Unable to load listings.”

You can also test the endpoint directly at:
`/api/events?city=Boston&date=2026-10-29&window=0`

## Important
The included event is deliberately labeled demo/seed data. This build proves the frontend-to-backend path; it does **not** claim to contain live tour data yet.

## Next data layer
The API is source-agnostic. Future collectors can write normalized records to a persistent database from official comedian tour pages, venue calendars, and primary ticketing sources. Ticketmaster can remain optional.

## Ticket destination priority
1. explicit official/primary ticket URL
2. comedian official tour page
3. venue official event page
4. primary ticketing platform

## Image rights
The frontend only renders headshots marked `official`, `licensed`, `feed_authorized`, `artist_supplied`, or `promoter_supplied`; otherwise it uses initials.
