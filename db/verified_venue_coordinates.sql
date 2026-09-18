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

alter table public.venues drop constraint if exists venues_verified_coordinates_complete;
alter table public.venues add constraint venues_verified_coordinates_complete check (
  coordinates_verified_at is null
  or (
    latitude is not null
    and longitude is not null
    and nullif(trim(coordinates_source_url), '') is not null
    and coordinates_source_url ~ '^https?://'
    and nullif(trim(coordinates_source_type), '') is not null
  )
);

create index if not exists venues_verified_coordinates_idx
  on public.venues (coordinates_verified_at)
  where coordinates_verified_at is not null;

comment on column public.venues.coordinates_source_url is
  'Authoritative source used to verify the stored venue coordinates.';
comment on column public.venues.coordinates_source_type is
  'Verification source class, e.g. official_venue, official_promoter, authoritative_map.';

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
  if nullif(trim(p_source_type), '') is null then
    raise exception 'coordinate source type is required';
  end if;

  update public.venues
     set latitude = p_latitude,
         longitude = p_longitude,
         coordinates_source_url = trim(p_source_url),
         coordinates_source_type = trim(p_source_type),
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
