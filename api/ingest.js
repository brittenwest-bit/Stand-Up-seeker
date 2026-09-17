const crypto = require("crypto");

const json = (res, code, body) => res.status(code).json(body);
const supabaseUrl = () => process.env.SUPABASE_URL;
const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
const ingestKey = () => process.env.INGEST_API_KEY;

function headers(prefer) {
  const key = serviceKey();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

async function db(path, options = {}) {
  const response = await fetch(`${supabaseUrl()}/rest/v1/${path}`, {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function isHttps(value) {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function exactIso(value) {
  const s = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s)) return false;
  return !Number.isNaN(Date.parse(s));
}

function validateEvent(event) {
  const errors = [];
  if (!isUuid(event.comedian_id)) errors.push("comedian_id must be a UUID");
  if (!event.event_name || !String(event.event_name).trim()) errors.push("event_name is required");
  if (!exactIso(event.starts_at)) errors.push("starts_at must be an exact ISO timestamp with timezone");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(event.local_date || ""))) errors.push("local_date is required");
  if (!/^\d{1,2}:\d{2}(\s?[AP]M)?$/i.test(String(event.local_time || ""))) errors.push("local_time is required; TBA/guessed times are rejected");
  if (!event.city || !event.country) errors.push("city and country are required");
  if (!isHttps(event.official_ticket_url)) errors.push("official_ticket_url must be HTTPS");
  if (!Array.isArray(event.sources) || event.sources.length === 0) errors.push("at least one authoritative source is required");
  else if (event.sources.some(s => !s.is_official || !isHttps(s.source_url) || !s.source_name || !s.source_type)) errors.push("every source must be official and include type, name, and HTTPS URL");
  if (!event.venue || !event.venue.name || !event.venue.city || !event.venue.country) errors.push("normalized venue name/city/country are required");
  return errors;
}

function esc(value) {
  return encodeURIComponent(String(value));
}

async function findOrCreateVenue(venue) {
  const state = venue.state_region || "";
  const query = `venues?select=id,name,city,state_region,country&name=eq.${esc(venue.name)}&city=eq.${esc(venue.city)}&country=eq.${esc(venue.country)}&limit=1`;
  const found = await db(query);
  if (found && found[0]) return found[0];

  const payload = {
    name: String(venue.name).trim(),
    city: String(venue.city).trim(),
    state_region: state || null,
    country: String(venue.country).trim(),
    official_url: isHttps(venue.official_url) ? venue.official_url : null,
    latitude: Number.isFinite(venue.latitude) && venue.coordinates_verified === true ? venue.latitude : null,
    longitude: Number.isFinite(venue.longitude) && venue.coordinates_verified === true ? venue.longitude : null,
  };
  const rows = await db("venues", { method: "POST", headers: headers("return=representation"), body: JSON.stringify(payload) });
  return rows[0];
}

async function ingestOne(event) {
  const validation = validateEvent(event);
  if (validation.length) return { ok: false, status: "rejected", errors: validation };

  const venue = await findOrCreateVenue(event.venue);
  const sourceKey = crypto.createHash("sha256").update([
    event.comedian_id,
    event.starts_at,
    venue.id,
    String(event.event_name).trim().toLowerCase(),
  ].join("|")).digest("hex");

  const existing = await db(`shows?select=id,source_key&source_key=eq.${sourceKey}&limit=1`);
  if (existing && existing[0]) return { ok: true, status: "duplicate", show_id: existing[0].id, source_key: sourceKey };

  const now = new Date().toISOString();
  const showPayload = {
    comedian_id: event.comedian_id,
    venue_id: venue.id,
    event_name: String(event.event_name).trim(),
    starts_at: event.starts_at,
    local_date: event.local_date,
    local_time: event.local_time,
    city: String(event.city).trim(),
    state_region: event.state_region || null,
    country: String(event.country).trim(),
    official_ticket_url: event.official_ticket_url,
    ticket_provider: event.ticket_provider || null,
    status: "scheduled",
    verification_status: "verified",
    last_verified_at: now,
    source_key: sourceKey,
    confidence_score: 1,
    publishable: true,
    source_count: event.sources.length,
    verification_reason: "Structured ingestion: exact time and authoritative source(s) supplied",
  };
  const shows = await db("shows", { method: "POST", headers: headers("return=representation"), body: JSON.stringify(showPayload) });
  const show = shows[0];

  for (const source of event.sources) {
    await db("show_sources", {
      method: "POST",
      headers: headers("return=minimal"),
      body: JSON.stringify({
        show_id: show.id,
        source_type: source.source_type,
        source_name: source.source_name,
        source_url: source.source_url,
        is_official: true,
        last_checked_at: now,
        last_result: "confirmed",
      }),
    });
  }
  return { ok: true, status: "inserted", show_id: show.id, source_key: sourceKey };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "POST required" });
  if (!supabaseUrl() || !serviceKey() || !ingestKey()) return json(res, 503, { error: "Ingestion service is not configured" });

  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(supplied, ingestKey())) return json(res, 401, { error: "Unauthorized" });

  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  if (!events.length || events.length > 100) return json(res, 400, { error: "events must contain 1-100 items" });

  const results = [];
  for (let i = 0; i < events.length; i++) {
    try { results.push({ index: i, ...(await ingestOne(events[i])) }); }
    catch (error) { results.push({ index: i, ok: false, status: "error", errors: [String(error.message).slice(0, 1000)] }); }
  }

  const inserted = results.filter(r => r.status === "inserted").length;
  const duplicates = results.filter(r => r.status === "duplicate").length;
  const rejected = results.filter(r => r.status === "rejected").length;
  const errors = results.filter(r => r.status === "error").length;
  return json(res, errors ? 207 : 200, { ok: errors === 0, inserted, duplicates, rejected, errors, results });
};