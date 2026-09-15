const crypto = require("crypto");

const json = (res, code, body) => res.status(code).json(body);
const headers = key => ({apikey:key, Authorization:`Bearer ${key}`, "Content-Type":"application/json", Prefer:"return=representation"});
const base = () => process.env.SUPABASE_URL;
const key = () => process.env.SUPABASE_ANON_KEY;

async function db(path, options={}) {
  const r=await fetch(`${base()}/rest/v1/${path}`,{...options,headers:{...headers(key()),...(options.headers||{})}});
  const text=await r.text(); if(!r.ok) throw new Error(`Supabase ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
function absolute(href, origin){ try{return new URL(href,origin).href}catch{return ""} }
function clean(s){return String(s||"").replace(/<[^>]*>/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim()}
function isoDate(s){const m=String(s).match(/\b(20\d{2})[-\/](\d{1,2})[-\/](\d{1,2})\b/);if(m)return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`; const d=new Date(s);return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10)}
function extractGeneric(html,url){
 const out=[]; const blocks=[...html.matchAll(/<(?:article|li|div)[^>]*(?:event|show|tour)[^>]*>([\s\S]{0,6000}?)<\/(?:article|li|div)>/gi)].map(m=>m[0]);
 for(const b of blocks.slice(0,300)){const text=clean(b);const date=isoDate(text);if(!date)continue;const cityState=text.match(/([A-Z][A-Za-z .'-]{2,40}),\s*([A-Z]{2})\b/);if(!cityState)continue;const link=b.match(/href=["']([^"']+)["']/i);out.push({date,city:cityState[1].trim(),state:cityState[2],ticketUrl:link?absolute(link[1],url):url,raw:text.slice(0,500)});}
 return out;
}
module.exports=async function handler(req,res){
 if(!base()||!key()) return json(res,500,{error:"Supabase environment variables missing"});
 const started=new Date().toISOString(); let run;
 try{
  run=(await db("ingestion_runs",{method:"POST",body:JSON.stringify({details:{trigger:req.headers["user-agent"]||"manual"}})}))[0];
  const sources=await db("ingestion_sources?enabled=eq.true&select=id,comedian_id,name,source_type,url,adapter&order=priority.asc&limit=25");
  let seen=0,upserted=0,errors=0;
  for(const s of sources){
   try{
    const r=await fetch(s.url,{headers:{"User-Agent":"StandUpSeeker/0.2 (+https://stand-up-seeker.vercel.app)"}});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const html=await r.text(); const items=extractGeneric(html,s.url); seen+=items.length;
    for(const item of items){
      if(!s.comedian_id) continue;
      const sourceKey=crypto.createHash("sha256").update([s.comedian_id,item.date,item.city,item.state].join("|").toLowerCase()).digest("hex");
      const payload={comedian_id:s.comedian_id,event_name:null,starts_at:`${item.date}T12:00:00Z`,local_date:item.date,local_time:null,city:item.city,state_region:item.state,country:"US",official_ticket_url:item.ticketUrl,ticket_provider:s.name,status:"scheduled",verification_status:s.source_type==="artist"?"verified":"unverified",last_verified_at:s.source_type==="artist"?new Date().toISOString():null,source_key:sourceKey};
      const rows=await db("shows?on_conflict=source_key",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=representation"},body:JSON.stringify(payload)});
      const show=rows&&rows[0]; if(show){upserted++;await db("show_sources?on_conflict=show_id,source_url",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify({show_id:show.id,source_type:s.source_type,source_name:s.name,source_url:s.url,is_official:true,last_checked_at:new Date().toISOString(),last_result:"confirmed"})});}
    }
    await db(`ingestion_sources?id=eq.${s.id}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({last_checked_at:new Date().toISOString(),last_success_at:new Date().toISOString(),last_error:null})});
   }catch(e){errors++;await db(`ingestion_sources?id=eq.${s.id}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({last_checked_at:new Date().toISOString(),last_error:String(e.message).slice(0,1000)})});}
  }
  await db(`ingestion_runs?id=eq.${run.id}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({finished_at:new Date().toISOString(),status:errors?"partial":"success",sources_checked:sources.length,shows_seen:seen,shows_upserted:upserted,errors})});
  return json(res,200,{ok:true,started,sourcesChecked:sources.length,showsSeen:seen,showsUpserted:upserted,errors});
 }catch(e){if(run)try{await db(`ingestion_runs?id=eq.${run.id}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({finished_at:new Date().toISOString(),status:"failed",errors:1,details:{error:e.message}})});}catch{} return json(res,500,{error:e.message});}
};