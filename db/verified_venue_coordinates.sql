-- Stand Up Seeker: verified venue coordinate workflow
-- Apply after reviewing against the live schema. This intentionally does not geocode
-- or infer coordinates; it only provides a safe contract for storing verified ones.

alter table public.venues add column if not exists latitude double precision;
alter table public.venues add column if not exists longitude double precision;
alter table public.venues add column if not exists coordinates_verified_at timestamptz;
alter table public.venues add column if not exists coordinates_source_url text;
alter table public.venues add column if not exists coordinates_source_type text;

alter table public.venues drop constraint if exists venues_latitude_range;
alter table public.venues add constraint venues_latitude_range
  check (latitude is null or latitude between -90 and 90);

alter table public.venues drop constraint if exists venues_longitude_range;
alter table public.venues add constraint venues_longitude_range
  check (longitude is null or longitude between -180 and 180);

-- Coordinates are all-or-nothing. This prevents a partially populated venue from
-- looking geocoded to future queries or maintenance scripts.
alter table public.venues drop constraint if exists venues_coordinate_pair_complete;
alter table public.venues add constraint venues_coordinate_pair_complete check (
  (latitude is null and longitude is null)
  or (latitude is not null and longitude is not null)
);

-- Only source classes with a repeatable verification path may mark coordinates as
-- verified. Generic search results, snippets, inferred addresses, or guessed points
-- are deliberately excluded.
alter table public.venues drop constraint if exists venues_coordinate_source_type_allowed;
alter table public.venues add constraint venues_coordinate_source_type_allowed check (
  coordinates_source_type is null
  or coordinates_source_type in (
    'official_venue',
    'official_promoter',
    'official_ticketing',
    'government_gis',
    'authoritative_map'
  )
);

-- Verification metadata is also all-or-nothing. If coordinates are marked verified,
-- retain their source. Conversely, source metadata/timestamps cannot exist without a
-- complete coordinate pair. Unverified coordinate pairs may exist temporarily, but
-- Map/API code must continue to require coordinates_verified_at before publishing.
alter table public.venues drop constraint if exists venues_verified_coordinates_complete;
alter table public.venues add constraint venues_verified_coordinates_complete check (
  (
    coordinates_verified_at is null
    and coordinates_source_url is null
    and coordinates_source_type is null
  )
  or (
    coordinates_verified_at is not null
    and latitude is not null
    and longitude is not null
    and nullif(trim(coordinates_source_url), '') is not null
    and coordinates_source_url ~ '^https?://'
    and coordinates_source_type in (
      'official_venue',
      'official_promoter',
      'official_ticketing',
      'government_gis',
      'authoritative_map'
    )
  )
);

create index if not exists venues_verified_coordinates_idx
  on public.venues (coordinates_verified_at)
  where coordinates_verified_at is not null;

comment on column public.venues.coordinates_source_url is
  'Authoritative source used to verify the stored venue coordinates.';
comment on column public.venues.coordinates_source_type is
  'Controlled verification source class: official_venue, official_promoter, official_ticketing, government_gis, or authoritative_map.';

-- Safe write helper. Intended for trusted server-side/service-role use only.
create or replace function public.set_verified_venue_coordinates(
  p_venue_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_source_url text,
  p_source_type text,
  p_verified_at timestamptz default now()
) returns public.venues
language plpgsql
security definer
set search_path = public
as $$
declare
  v_venue public.venues;
  v_source_type text := lower(trim(p_source_type));
begin
  if p_latitude is null or p_latitude not between -90 and 90 then
    raise exception 'latitude must be between -90 and 90';
  end if;
  if p_longitude is null or p_longitude not between -180 and 180 then
    raise exception 'longitude must be between -180 and 180';
  end if;
  if nullif(trim(p_source_url), '') is null or p_source_url !~ '^https?://' then
    raise exception 'an authoritative http(s) source URL is required';
  end if;
  if v_source_type is null or v_source_type not in (
    'official_venue',
    'official_promoter',
    'official_ticketing',
    'government_gis',
    'authoritative_map'
  ) then
    raise exception 'unsupported coordinate source type: %', p_source_type;
  end if;

  update public.venues
     set latitude = p_latitude,
         longitude = p_longitude,
         coordinates_source_url = trim(p_source_url),
         coordinates_source_type = v_source_type,
         coordinates_verified_at = coalesce(p_verified_at, now())
   where id = p_venue_id
   returning * into v_venue;

  if not found then raise exception 'venue not found: %', p_venue_id; end if;
  return v_venue;
end;
$$;

revoke all on function public.set_verified_venue_coordinates(uuid,double precision,double precision,text,text,timestamptz) from public;
revoke all on function public.set_verified_venue_coordinates(uuid,double precision,double precision,text,text,timestamptz) from anon;
revoke all on function public.set_verified_venue_coordinates(uuid,double precision,double precision,text,text,timestamptz) from authenticated;
grant execute on function public.set_verified_venue_coordinates(uuid,double precision,double precision,text,text,timestamptz) to service_role;
