const {test,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const handler=require('../api/ingest');
const originalFetch=global.fetch;
afterEach(()=>{global.fetch=originalFetch;});
const event=()=>({comedian_id:'11111111-1111-4111-8111-111111111111',event_name:'Verified show',starts_at:'2026-12-04T19:30:00-06:00',local_date:'2026-12-04',local_time:'7:30 PM',city:'Addison',state_region:'TX',country:'US',official_ticket_url:'https://www.ticketweb.com/event/example',venue:{name:'Addison Improv',city:'Addison',state_region:'TX',country:'US'},sources:[{source_type:'venue',source_name:'Addison Improv',source_url:'https://improvtx.com/addison/',is_official:true,checked_at:new Date().toISOString()}]});
async function call(events,authorization='Bearer test-secret'){
 Object.assign(process.env,{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-secret',INGEST_API_KEY:'test-secret'});
 const res={setHeader(){},status(s){this.code=s;return this;},json(b){this.body=b;return this;}};
 await handler({method:'POST',headers:{authorization},body:{events}},res);return res;
}
test('normalizes explicit local time and discards coordinates',()=>{const e=event();e.venue.latitude=12;const n=handler.normalize(e);assert.equal(n.local_time,'19:30');assert.equal(n.venue.latitude,undefined);});
for(const [name,change] of [
 ['TBA',e=>e.local_time='TBA'],['invalid clock',e=>e.local_time='29:30'],['impossible date',e=>{e.starts_at='2026-02-30T19:30:00-06:00';e.local_date='2026-02-30';}],['date mismatch',e=>e.local_date='2026-12-05'],['time mismatch',e=>e.local_time='8:30 PM'],['missing timezone',e=>e.starts_at='2026-12-04T19:30:00'],['unofficial source',e=>e.sources[0].is_official=false],['stale source',e=>e.sources[0].checked_at='2020-01-01'],['venue mismatch',e=>e.venue.city='Boston']]) {
 test(`rejects ${name} without writing`,async()=>{const e=event();change(e);global.fetch=()=>{assert.fail('must not access database');};const r=await call([e]);assert.equal(r.code,207);assert.equal(r.body.ok,false);assert.equal(r.body.rejected,1);});
}
test('rejects unauthorized calls without database access',async()=>{global.fetch=()=>assert.fail('database called');assert.equal((await call([event()],'Bearer wrong')).code,401);});
test('insert and retry read back same ID; second performance remains distinct',async()=>{
 const saved=new Map();global.fetch=async(url,opts)=>{
  if(url.endsWith('/rpc/ingest_verified_show')){const e=JSON.parse(opts.body).event;const k=e.starts_at;const old=saved.has(k);if(!old)saved.set(k,{...e,id:String(saved.size+1),source_key:k,publishable:true,verification_status:'verified',show_sources:e.sources});return {ok:true,json:async()=>({show_id:saved.get(k).id,source_key:k,status:old?'duplicate':'inserted'})};}
  const id=new URL(url).searchParams.get('id').slice(3);return {ok:true,json:async()=>[...saved.values()].filter(s=>s.id===id)};
 };
 const a=await call([event()]);const b=await call([event()]);const late=event();late.starts_at='2026-12-04T21:45:00-06:00';late.local_time='9:45 PM';await call([late]);
 assert.equal(a.body.inserted,1);assert.equal(b.body.duplicates,1);assert.equal(a.body.results[0].show_id,b.body.results[0].show_id);assert.equal(saved.size,2);
});
test('read-back mismatch is not reported as success',async()=>{global.fetch=async url=>({ok:true,json:async()=>url.includes('/rpc/')?{show_id:'1',source_key:'k',status:'inserted'}:[]});const r=await call([event()]);assert.equal(r.body.ok,false);assert.equal(r.body.results[0].code,'READ_BACK_FAILED_RETRY_SAFE');});
test('database failure is redacted and retryable',async()=>{global.fetch=async()=>({ok:false,status:503});const r=await call([event()]);assert.equal(r.body.results[0].retryable,true);assert.equal(r.body.results[0].code,'DATABASE_HTTP_503');});
