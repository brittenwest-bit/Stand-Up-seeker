const crypto = require('node:crypto');

class IngestError extends Error {
  constructor(code, retryable = false) { super(code); this.code = code; this.retryable = retryable; }
}
const text = value => typeof value === 'string' ? value.trim() : '';
function https(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
}
function normalize(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new IngestError('INVALID_EVENT');
  const e = {...event, venue: {...event.venue}};
  for (const key of ['comedian_id','event_name','city','country','state_region','local_date','local_time','starts_at','official_ticket_url']) e[key] = text(e[key]);
  for (const key of ['name','city','state_region','country','official_url']) e.venue[key] = text(e.venue[key]);
  if (e.comedian_id) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(e.comedian_id)) throw new IngestError('INVALID_COMEDIAN');
    e.comedian_id = e.comedian_id.toLowerCase();
  } else if (!text(e.comedian?.name) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(e.comedian?.slug) || !https(e.comedian?.official_url)) throw new IngestError('INVALID_COMEDIAN');
  const iso = e.starts_at.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::00)?(Z|[+-]\d{2}:\d{2})$/);
  const time = e.local_time.match(/^(\d{1,2}):([0-5]\d)\s*(AM|PM)?$/i);
  if (!iso || !time || !Number.isFinite(Date.parse(e.starts_at))) throw new IngestError('EXACT_TIME_REQUIRED');
  let hour = Number(time[1]);
  if (time[3]) { if (hour < 1 || hour > 12) throw new IngestError('INVALID_LOCAL_TIME'); hour = hour % 12 + (/pm/i.test(time[3]) ? 12 : 0); }
  if (hour > 23) throw new IngestError('INVALID_LOCAL_TIME');
  e.local_time = `${String(hour).padStart(2,'0')}:${time[2]}`;
  if (e.local_date !== iso[1] || e.local_time !== iso[2] || new Date(`${iso[1]}T00:00:00Z`).toISOString().slice(0,10) !== iso[1]) throw new IngestError('LOCAL_TIME_TIMESTAMP_MISMATCH');
  if (!e.event_name || !e.city || !e.country || !e.venue.name || e.venue.city !== e.city || e.venue.country !== e.country || e.venue.state_region !== e.state_region) throw new IngestError('INVALID_VENUE');
  if (!https(e.official_ticket_url) || (e.venue.official_url && !https(e.venue.official_url))) throw new IngestError('OFFICIAL_HTTPS_URL_REQUIRED');
  if (!Array.isArray(e.sources) || !e.sources.length || e.sources.length > 20) throw new IngestError('AUTHORITATIVE_SOURCES_REQUIRED');
  e.sources = e.sources.map(s => {
    if (!s || s.is_official !== true || !['artist','venue','promoter','ticketing'].includes(s.source_type) || !text(s.source_name) || !https(s.source_url)) throw new IngestError('INVALID_OFFICIAL_SOURCE');
    const checked = Date.parse(s.checked_at);
    if (!Number.isFinite(checked) || checked > Date.now() + 60000 || checked < Date.now() - 7*86400000) throw new IngestError('SOURCE_VERIFICATION_STALE');
    return {...s,checked_at:new Date(checked).toISOString()};
  });
  // Coordinates are managed separately; never infer or alter them during ingestion.
  delete e.venue.latitude; delete e.venue.longitude;
  return e;
}
async function db(path, options = {}) {
  let response;
  try {
    response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
      ...options, signal: AbortSignal.timeout(15000), headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type':'application/json'
      }
    });
  } catch { throw new IngestError('DATABASE_UNREACHABLE_RETRY_SAFE',true); }
  if (!response.ok) {
    // Never expose raw database messages or credentials to callers.
    throw new IngestError(`DATABASE_HTTP_${response.status}`,response.status >= 500 || response.status === 429);
  }
  try { return await response.json(); } catch { throw new IngestError('INVALID_DATABASE_RESPONSE',true); }
}
async function ingestOne(e) {
  const result = await db('rpc/ingest_verified_show',{method:'POST',body:JSON.stringify({event:e})});
  const params = new URLSearchParams({select:'id,source_key,comedian_id,starts_at,local_date,local_time,publishable,verification_status,show_sources(source_url,is_official)',id:`eq.${result.show_id}`});
  const rows = await db(`shows?${params}`);
  const s = rows?.[0];
  if (rows.length !== 1 || !s.publishable || !['verified','verified_2_source'].includes(s.verification_status) || s.source_key !== result.source_key || s.comedian_id !== (e.comedian_id || result.comedian_id) || Date.parse(s.starts_at) !== Date.parse(e.starts_at) || s.local_date !== e.local_date || s.local_time !== e.local_time || !e.sources.every(src => s.show_sources.some(saved => saved.is_official && saved.source_url === src.source_url))) throw new IngestError('READ_BACK_FAILED_RETRY_SAFE',true);
  return {...result,ok:true,verified:true};
}
module.exports = async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if (req.method !== 'POST') { res.setHeader('Allow','POST'); return res.status(405).json({error:'POST required'}); }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.INGEST_API_KEY) return res.status(503).json({error:'Ingestion service is not configured'});
  const supplied = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i,''));
  const expected = Buffer.from(process.env.INGEST_API_KEY);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied,expected)) return res.status(401).json({error:'Unauthorized'});
  const events = req.body?.events;
  if (!Array.isArray(events) || !events.length || events.length > 100) return res.status(400).json({error:'events must contain 1-100 items'});
  const results=[];
  for (let index=0;index<events.length;index++) {
    let e;
    try { e=normalize(events[index]); }
    catch(error) { results.push({index,ok:false,status:'rejected',code:error.code || 'INVALID_EVENT',retryable:false}); continue; }
    try { results.push({index,...await ingestOne(e)}); }
    catch(error) { results.push({index,ok:false,status:'error',code:error.code || 'INGESTION_FAILED',retryable:error.retryable === true}); }
  }
  const count = status => results.filter(r=>r.status === status).length;
  const ok=results.every(r=>r.ok);
  return res.status(ok ? 200 : 207).json({ok,inserted:count('inserted'),duplicates:count('duplicate'),rejected:count('rejected'),errors:count('error'),results});
};
module.exports.normalize=normalize;
