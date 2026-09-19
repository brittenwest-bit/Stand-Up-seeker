# Stand Up Seeker

Vercel-hosted stand-up comedy discovery app backed by Supabase.

## Structure
- `index.html` — app UI
- `hero-stage.png` — hero image
- `api/events.js` — verified-event search API
- `api/comedians.js` — comedian search API
- `api/ingest.js` — authenticated structured ingestion API

## Required Vercel environment variables
- `SUPABASE_URL` — project URL
- `SUPABASE_ANON_KEY` — publishable/anon key used by read APIs
- `SUPABASE_SERVICE_ROLE_KEY` — server-only service-role key used only by `/api/ingest`; never expose it to browser code
- `INGEST_API_KEY` — long random secret required as `Authorization: Bearer <secret>` for `/api/ingest`

## Ingestion safety
`POST /api/ingest` accepts a JSON body containing `events` (1–100 items). It does not scrape tour pages and it does not invent timestamps. Every event must include an exact timezone-aware `starts_at`, a display `local_time`, normalized venue/city/country information, an HTTPS official ticket URL, and at least one authoritative source marked official. Invalid/TBA-time records are rejected. Duplicate source keys are detected before insertion. Venue coordinates are never written by ingestion; use the separate verified-coordinate workflow.

The former scheduled scraper cron was removed because it created noon placeholder timestamps and could mark artist-page discoveries as verified without exact performance-time corroboration.

## Deployment
The repository is Vercel-ready. Production must have the environment variables above configured before the ingestion endpoint will accept requests. Keep `SUPABASE_SERVICE_ROLE_KEY` and `INGEST_API_KEY` server-side only.

## Atomic ingestion and retry contract
Apply `db/controlled_ingestion.sql` and `db/publishable_exact_time.sql` before deploying this version. The RPC is SECURITY INVOKER and executable only by `service_role`. Existing RLS remains enabled. Source-key uniqueness is enforced by the existing partial unique index; transaction locks also deduplicate legacy keys by comedian, venue and exact instant. Source evidence and publication commit together. Coordinates are never written by this endpoint.

Supply either `comedian_id`, or `comedian: {name, slug, official_url}` for a new roster entry. Every source requires `checked_at` within the preceding seven days and `source_type` of `artist`, `venue`, `promoter`, or `ticketing`. `starts_at` must carry the local UTC offset and agree with `local_date` and `local_time`; no default times are generated. The endpoint requires human/source verification upstream; an official flag alone does not independently verify a website.

A successful result includes `show_id`, `source_key`, and `verified: true` after separate database read-back. Retrying the same performance returns the same ID. HTTP 207 indicates rejected/failed items; inspect each `code` and `retryable` field. Network/read-back uncertainty can be retried safely. Raw database errors are not returned. Batches commit per performance, so retry failed items after partial success. The new database constraint excludes TBA/TBD times from publication and retains quarantined legacy records.

Run regression tests with `node --test test/*.test.js`. Before population, configure the four server environment variables, redeploy, submit one verified event, retry it, and compare IDs. Then submit the remaining batch. Never commit keys or include them in browser code.

## Production diagnosis and restart gate
A POST returning HTTP 503 with `Ingestion service is not configured` means at least one of `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, or `INGEST_API_KEY` is missing from that deployment. This happens before any database request; it is not an RLS rejection. Save the actual secret values under their separate names in the Production environment, then redeploy. Never use one variable's name as another variable's value. Store both ingestion credentials as Secret and never prefix them with `NEXT_PUBLIC_`.

Apply `db/verified_venue_coordinates.sql` before using Map. The coordinate helper runs as SECURITY INVOKER, is executable only by service_role, and requires a complete coordinate pair plus source URL, source type, and verification timestamp. It does not verify sources or guess coordinates automatically.

Keep bulk ingestion paused until a single freshly verified future show succeeds through the production API, independent read-back confirms the row and evidence, and an identical retry returns the same show ID with zero new rows. A green Vercel build alone does not prove secrets or database migrations are configured. Connector permission/argument errors should be diagnosed separately from application HTTP responses and Postgres errors.
