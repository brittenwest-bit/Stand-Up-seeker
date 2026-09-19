# Verified venue coordinate workflow

Stand Up Seeker must never place a venue on the Map using guessed, inferred, or unreviewed coordinates.

## Preconditions

Apply `db/verified_venue_coordinates.sql` before writing venue coordinates. Coordinate writes must use the server-side service role and the controlled `set_verified_venue_coordinates()` function introduced by that migration.

## Verification queue

Build the queue from normalized venues referenced by future events where `publishable = true` and the event verification state is `verified` or `verified_2_source`. Prioritize venues with the largest number of future publishable events. Skip venues that already have `latitude`, `longitude`, and `coordinates_verified_at` populated.

For each venue, preserve its normalized venue identity and city/state/country context. Do not merge venues merely because their names are similar.

## Accepted coordinate evidence

Coordinates must be supported by an authoritative or high-confidence venue-location source. Preferred evidence, in order:

1. The venue's official website/contact or directions page when it exposes a precise location.
2. The venue's official ticketing/promoter page when it identifies the exact venue location.
3. A reputable mapping/geocoding provider result that exactly matches the normalized venue name and locality.

Store the supporting URL in `coordinate_source_url` and the source class in `coordinate_source_type`. If the returned place, locality, or venue identity is ambiguous, leave the venue unmapped and record it for manual review.

## Write rules

A coordinate write is allowed only when all of the following are true:

- Latitude is between -90 and 90.
- Longitude is between -180 and 180.
- Venue identity matches the normalized venue record.
- City/state/country context agrees with the source.
- A source URL is retained.
- The verification timestamp is set at write time.

Never derive coordinates from a city centroid, ZIP/postal-code centroid, neighboring business, venue-name guess, or another venue in the same complex unless the source explicitly identifies the target venue at that coordinate.

## Post-write checks

After each coordinate batch:

1. Query `/api/events?view=map` and confirm only verified + publishable future events are returned.
2. Confirm every returned event has finite latitude/longitude and a coordinate verification timestamp.
3. Spot-check newly mapped venues against their retained source URLs.
4. Check for suspicious duplicate coordinates across unrelated normalized venues.
5. Open `/map.html`, verify pins render in the expected locality, and confirm grouped performances at one venue remain on one pin.
6. Verify comedian filtering clears/overrides city filtering and that ticket links remain HTTP/HTTPS only.

## Coverage reporting

For each batch, report:

- normalized venues eligible for mapping;
- venues with verified coordinates;
- percentage coordinate coverage by venue;
- future publishable events covered by verified coordinates;
- venues skipped for ambiguity and the reason;
- sources used;
- any duplicate-coordinate or locality mismatches found.

Coordinate coverage should be reported separately from comedian/event ingestion coverage.

## Failure behavior

If the Supabase write path is unavailable, do not retry writes repeatedly. Continue building a source-backed verification queue and keep Map output restricted to already verified coordinates. Resume coordinate writes only after the database write path is explicitly restored.