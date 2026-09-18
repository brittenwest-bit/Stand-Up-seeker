-- One transaction per verified performance. Existing source keys remain unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS shows_source_key_unique
ON public.shows(source_key) WHERE source_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.ingest_verified_show(event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v public.venues%ROWTYPE;
  s public.shows%ROWTYPE;
  src jsonb;
  k text;
  inserted boolean := false;
  matches integer;
  comedian uuid;
  existing_name text;
BEGIN
  IF jsonb_typeof(event->'sources') IS DISTINCT FROM 'array'
     OR jsonb_array_length(event->'sources') = 0
     OR coalesce(event->>'local_time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     OR coalesce(event->>'official_ticket_url','') !~ '^https://'
     OR coalesce(event->>'starts_at','') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
  THEN RAISE EXCEPTION 'Invalid verified performance'; END IF;
  FOR src IN SELECT value FROM jsonb_array_elements(event->'sources') LOOP
    IF src->'is_official' IS DISTINCT FROM 'true'::jsonb OR coalesce(src->>'source_url','') !~ '^https://'
       OR coalesce(src->>'source_name','') = '' OR coalesce(src->>'source_type','') NOT IN ('artist','venue','promoter','ticketing')
       OR src->>'checked_at' IS NULL
       OR (src->>'checked_at')::timestamptz < now() - interval '7 days'
       OR (src->>'checked_at')::timestamptz > now() + interval '1 minute'
    THEN RAISE EXCEPTION 'Invalid authoritative source'; END IF;
  END LOOP;
  IF substring(event->>'starts_at',1,10) <> event->>'local_date'
     OR substring(event->>'starts_at',12,5) <> event->>'local_time'
     OR coalesce(event#>>'{venue,name}','') = ''
     OR coalesce(event#>>'{venue,city}','') = ''
     OR coalesce(event#>>'{venue,country}','') = ''
     OR event->>'city' IS DISTINCT FROM event#>>'{venue,city}'
     OR event->>'country' IS DISTINCT FROM event#>>'{venue,country}'
  THEN RAISE EXCEPTION 'Inconsistent performance location or local time'; END IF;

  comedian := nullif(event->>'comedian_id','')::uuid;
  IF comedian IS NULL THEN
    INSERT INTO public.comedians(name,slug,official_url)
    VALUES(event#>>'{comedian,name}',event#>>'{comedian,slug}',event#>>'{comedian,official_url}')
    ON CONFLICT(slug) DO NOTHING;
    SELECT id,name INTO comedian,existing_name FROM public.comedians WHERE slug=event#>>'{comedian,slug}';
    IF existing_name IS DISTINCT FROM event#>>'{comedian,name}' THEN RAISE EXCEPTION 'Comedian identity conflict'; END IF;
  END IF;
  event := jsonb_set(event,'{comedian_id}',to_jsonb(comedian::text));

  -- Serialize normalization for this venue, including concurrent first inserts.
  PERFORM pg_advisory_xact_lock(hashtextextended(lower(concat_ws('|',event#>>'{venue,name}',event#>>'{venue,city}',event#>>'{venue,state_region}',event#>>'{venue,country}')),0));
  SELECT count(*) INTO matches FROM public.venues
  WHERE lower(trim(name))=lower(event#>>'{venue,name}')
    AND lower(trim(city))=lower(event#>>'{venue,city}')
    AND lower(coalesce(state_region,''))=lower(coalesce(event#>>'{venue,state_region}',''))
    AND lower(country)=lower(event#>>'{venue,country}');
  IF matches > 1 THEN RAISE EXCEPTION 'Ambiguous venue; normalize existing venues first'; END IF;
  SELECT * INTO v FROM public.venues
  WHERE lower(trim(name))=lower(event#>>'{venue,name}')
    AND lower(trim(city))=lower(event#>>'{venue,city}')
    AND lower(coalesce(state_region,''))=lower(coalesce(event#>>'{venue,state_region}',''))
    AND lower(country)=lower(event#>>'{venue,country}');
  IF v.id IS NULL THEN
    INSERT INTO public.venues(name,city,state_region,country,official_url)
    VALUES(event#>>'{venue,name}',event#>>'{venue,city}',nullif(event#>>'{venue,state_region}',''),event#>>'{venue,country}',event#>>'{venue,official_url}') RETURNING * INTO v;
  END IF;
  -- UTC canonical timestamp; titles and URL tracking parameters do not affect identity.
  k := 'v2:' || (event->>'comedian_id') || ':' || v.id::text || ':' ||
       to_char((event->>'starts_at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  SELECT count(*) INTO matches FROM public.shows WHERE comedian_id=(event->>'comedian_id')::uuid
    AND venue_id=v.id AND starts_at=(event->>'starts_at')::timestamptz;
  IF matches > 1 THEN RAISE EXCEPTION 'Ambiguous existing performance'; END IF;
  SELECT * INTO s FROM public.shows WHERE comedian_id=(event->>'comedian_id')::uuid
    AND venue_id=v.id AND starts_at=(event->>'starts_at')::timestamptz FOR UPDATE;
  IF s.id IS NULL THEN
    INSERT INTO public.shows(comedian_id,venue_id,event_name,starts_at,local_date,local_time,city,state_region,country,official_ticket_url,ticket_provider,status,verification_status,source_key)
    VALUES((event->>'comedian_id')::uuid,v.id,event->>'event_name',(event->>'starts_at')::timestamptz,(event->>'local_date')::date,event->>'local_time',v.city,v.state_region,v.country,event->>'official_ticket_url',event->>'ticket_provider','scheduled','unverified',k)
    ON CONFLICT(source_key) WHERE source_key IS NOT NULL DO NOTHING RETURNING * INTO s;
    inserted := s.id IS NOT NULL;
    IF s.id IS NULL THEN SELECT * INTO s FROM public.shows WHERE source_key=k FOR UPDATE; END IF;
  END IF;
  IF s.status <> 'scheduled' OR s.local_date <> (event->>'local_date')::date THEN
    RAISE EXCEPTION 'Existing performance conflicts with submitted evidence';
  END IF;
  FOR src IN SELECT value FROM jsonb_array_elements(event->'sources') LOOP
    INSERT INTO public.show_sources(show_id,source_type,source_name,source_url,is_official,last_checked_at,last_result)
    VALUES(s.id,src->>'source_type',src->>'source_name',src->>'source_url',true,(src->>'checked_at')::timestamptz,'confirmed')
    ON CONFLICT(show_id,source_url) DO UPDATE SET source_type=excluded.source_type,source_name=excluded.source_name,
      is_official=true,last_checked_at=excluded.last_checked_at,last_result='confirmed';
  END LOOP;
  UPDATE public.shows SET source_key=coalesce(source_key,k),verification_status=CASE WHEN verification_status='verified_2_source' THEN verification_status ELSE 'verified' END,publishable=true,
    last_verified_at=now(),updated_at=now(),local_time=event->>'local_time',
    source_count=(SELECT count(*) FROM public.show_sources WHERE show_id=s.id AND is_official),
    confidence_score=greatest(confidence_score,70),
    verification_reason='Structured ingestion: exact time and authoritative source(s) supplied'
  WHERE id=s.id RETURNING * INTO s;
  RETURN jsonb_build_object('show_id',s.id,'comedian_id',comedian,'source_key',s.source_key,'status',CASE WHEN inserted THEN 'inserted' ELSE 'duplicate' END);
END $$;
REVOKE ALL ON FUNCTION public.ingest_verified_show(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_verified_show(jsonb) TO service_role;
