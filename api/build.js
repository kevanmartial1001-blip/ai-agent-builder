// api/build.js
// Essential-only n8n file generator: one linear path per channel.
// - No junctions, no complex branching, no error lane.
// - Always: Trigger → Init → Communication(Stage) → per-channel [Enter → Compose → Send → Store]
// - LLM optional (only for lightweight messaging + channels if available).
// Env: SHEET_ID, GOOGLE_API_KEY, SHEET_TAB?=Scenarios, OPENAI_API_KEY

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

// ====== Minimal layout ======
const LAYOUT = {
  stepX: 720,
  rowY: 380,
  prodHeader: { x: -1400, y: 40 },
  prodStart:  { x: -1260, y: 300 },
};

const GUIDE = { numberSteps: true };

const TRIGGER_PREF = {
  APPOINTMENT_SCHEDULING: 'cron', CUSTOMER_SUPPORT_INTAKE: 'webhook', FEEDBACK_NPS: 'cron',
  KNOWLEDGEBASE_FAQ: 'webhook', SALES_OUTREACH: 'manual', LEAD_QUAL_INBOUND: 'webhook',
  CHURN_WINBACK: 'cron', RENEWALS_CSM: 'cron', AR_FOLLOWUP: 'cron', AP_AUTOMATION: 'webhook',
  INVENTORY_MONITOR: 'cron', REPLENISHMENT_PO: 'webhook', FIELD_SERVICE_DISPATCH: 'webhook',
  COMPLIANCE_AUDIT: 'cron', INCIDENT_MGMT: 'webhook', DATA_PIPELINE_ETL: 'cron',
  REPORTING_KPI_DASH: 'cron', ACCESS_GOVERNANCE: 'webhook', PRIVACY_DSR: 'webhook',
  RECRUITING_INTAKE: 'webhook',
};

const CHANNEL_NORMALIZE = [
  { k: 'email', rx: /email/i },
  { k: 'sms', rx: /(sms|text)/i },
  { k: 'whatsapp', rx: /whatsapp/i },
  { k: 'call', rx: /(voice|call|phone)/i },
];

// ---------- utils ----------
const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const pos = (x, y) => [x, y];
function toObj(header, row) { return Object.fromEntries(header.map((h,i)=>[h,(row[i]??"").toString().trim()])); }
const listify = (v) => Array.isArray(v) ? v.map(x=>String(x).trim()).filter(Boolean) : String(v||'').split(/[;,/|\n]+/).map(x=>x.trim()).filter(Boolean);

// ---------- sheet + llm ----------
async function fetchSheetRowByScenarioId(scenarioId){
  const SHEET_ID=process.env.SHEET_ID; const GOOGLE_API_KEY=process.env.GOOGLE_API_KEY; const TAB=process.env.SHEET_TAB||"Scenarios";
  if(!SHEET_ID||!GOOGLE_API_KEY) throw new Error("Missing SHEET_ID or GOOGLE_API_KEY");
  const url=`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}?key=${GOOGLE_API_KEY}`;
  const r=await fetch(url,{cache:"no-store"}); if(!r.ok) throw new Error(`Sheets API error: ${r.status} ${r.statusText}`);
  const data=await r.json(); const rows=data.values||[]; if(!rows.length) throw new Error("Sheet has no rows");
  const header=rows[0].map(h=>h.trim()); const obj=rows.slice(1).map(rw=>toObj(header,rw));
  return obj.find(x=>(x["scenario_id"]||"").toString().trim().toLowerCase()===scenarioId.toLowerCase());
}

async function openaiJSON(prompt){
  const key=process.env.OPENAI_API_KEY; if(!key) return null;
  try{
    const r=await fetch("https://api.openai.com/v1/chat/completions",{
      method:"POST",
      headers:{ "Authorization":`Bearer ${key}","Content-Type":"application/json"},
      body:JSON.stringify({ model:"gpt-4o-mini", temperature:0.2, response_format:{type:"json_object"}, messages:[
        {role:"system",content:"Return concise JSON only."},
        {role:"user",content:prompt}
      ]})
    });
    const j=await r.json();
    const txt=j.choices?.[0]?.message?.content?.trim();
    try{ return JSON.parse(txt); }catch{ return null; }
  }catch{ return null; }
}

function makeMessagingPrompt(row, channels){
  const ctx=[
    `SCENARIO_ID: ${row.scenario_id||''}`,
    `AGENT_NAME: ${row.agent_name||''}`,
    `INDUSTRY: ${row.name||''}`,
    `HOW_IT_WORKS: ${row.how_it_works||''}`,
    `ROI_HYPOTHESIS: ${row.roi_hypothesis||''}`,
  ].join("\n");
  return `Write ultra-brief outreach content per channel ${JSON.stringify(channels)}. 3–5 lines each. Return JSON {"email":{"subject":"...","body":"..."},"sms":{"body":"..."},"whatsapp":{"body":"..."},"call":{"script":"..."}}\n\n${ctx}`;
}

// ---------- workflow primitives ----------
function baseWorkflow(name){ return { name, nodes:[], connections:{}, active:false, settings:{}, staticData:{} }; }

function uniqueName(wf, base){
  const existing = new Set((wf.nodes||[]).map(n=>String(n.name||'').toLowerCase()));
  if(!base) base='Node'; let name=base; let i=1;
  while(existing.has(name.toLowerCase())){ i+=1; name=`${base} #${i}`; }
  return name;
}

function addNode(wf,node){
  node.name = uniqueName(wf, node.name);
  if(!Array.isArray(node.position)) node.position=[-1000,300];
  wf.nodes.push(node); return node.name;
}

function connect(wf,from,to,outputIndex=0){
  wf.connections[from]??={}; wf.connections[from].main??=[];
  for(let i=wf.connections[from].main.length;i<=outputIndex;i++) wf.connections[from].main[i]=[];
  wf.connections[from].main[outputIndex].push({node:to,type:"main",index:0});
}

function addHeader(wf,label,x,y){
  return addNode(wf,{ id:uid("label"), name:`=== ${label} ===`, type:"n8n-nodes-base.function", typeVersion:1, position:pos(x,y), parameters:{ functionCode:"return [$json];" } });
}
function addManual(wf,x,y,label="Manual Trigger"){ return addNode(wf,{ id:uid("manual"), name:label, type:"n8n-nodes-base.manualTrigger", typeVersion:1, position:pos(x,y), parameters:{} }); }
function addCron(wf,label,x,y,compat){ if(compat==='full'){ return addNode(wf,{ id:uid("cron"), name:label, type:"n8n-nodes-base.cron", typeVersion:1, position:pos(x,y), parameters:{ triggerTimes:{ item:[{ mode:"everyX", everyX:{ hours:0, minutes:30 } }] } } }); } return addManual(wf,x,y,`${label} (Manual)`); }
function addWebhook(wf,label,x,y,compat){ if(compat==='full'){ return addNode(wf,{ id:uid("webhook"), name:label, type:"n8n-nodes-base.webhook", typeVersion:1, position:pos(x,y), parameters:{ path:uid("hook"), methods:["POST"], responseMode:"onReceived" } }); } return addManual(wf,x,y,`${label} (Manual)`); }
function addFunction(wf,name,code,x,y){ return addNode(wf,{ id:uid("func"), name, type:"n8n-nodes-base.function", typeVersion:1, position:pos(x,y), parameters:{ functionCode:code } }); }

function makeSenderNode(wf, channel, x, y, compat){
  const friendly = channel.toUpperCase();
  if(compat==='full'){
    if(channel==='email'){
      return addNode(wf,{ id:uid("email"), name:`Send: ${friendly}`, type:"n8n-nodes-base.emailSend", typeVersion:3, position:pos(x,y), parameters:{ to:"={{$json.emailTo || 'user@example.com'}}", subject:"={{$json.msg?.email?.subject || 'Update'}}", text:"={{$json.message || $json.msg?.email?.body || 'Hello!'}}" }});
    }
    if(channel==='sms'){
      return addNode(wf,{ id:uid("sms"), name:`Send: ${friendly}`, type:"n8n-nodes-base.twilio", typeVersion:3, position:pos(x,y), parameters:{ resource:"message", operation:"create", from:"={{$json.smsFrom || '+10000000000'}}", to:"={{$json.to || '+10000000001'}}", message:"={{$json.message || $json.msg?.sms?.body || 'Hello!'}}" } });
    }
    if(channel==='whatsapp'){
      return addNode(wf,{ id:uid("wa"), name:`Send: ${friendly}`, type:"n8n-nodes-base.twilio", typeVersion:3, position:pos(x,y), parameters:{ resource:"message", operation:"create", from:"={{'whatsapp:' + ($json.waFrom || '+10000000002')}}", to:"={{'whatsapp:' + ($json.to || '+10000000003')}}", message:"={{$json.message || $json.msg?.whatsapp?.body || 'Hello!'}}" } });
    }
    if(channel==='call'){
      return addNode(wf,{ id:uid("call"), name:`Send: ${friendly}`, type:"n8n-nodes-base.function", typeVersion:1, position:pos(x,y), parameters:{ functionCode:"// Replace with your voice/IVR webhook\nreturn [$json];" } });
    }
  }
  return addFunction(wf, `Demo Send ${friendly}`, "return [$json];", x, y);
}

function sanitizeWorkflow(wf){
  const REQUIRED_TYPE="n8n-nodes-base.function";
  const byName=new Map();
  wf.nodes=(wf.nodes||[]).map((n,idx)=>{
    if(!n.name||typeof n.name!=='string') n.name=`Node ${idx+1}`;
    if(!n.type||typeof n.type!=='string'||!n.type.trim()){ n.type=REQUIRED_TYPE; n.typeVersion=1; n.parameters={ functionCode:"return [$json];" }; }
    if(typeof n.typeVersion!=='number') n.typeVersion=1;
    if(!Array.isArray(n.position)||n.position.length!==2){ n.position=[-1000, 300+(idx*40)]; }
    if(!n.parameters||typeof n.parameters!=='object') n.parameters={};
    if(n.type==="n8n-nodes-base.function" && !n.parameters.functionCode){ n.parameters.functionCode = "return [$json];"; }
    byName.set(n.name,n); return n;
  });
  const conns=wf.connections||{};
  for(const [from,m] of Object.entries(conns)){
    if(!byName.has(from)){ delete conns[from]; continue; }
    if(!m||typeof m!=="object"){ delete conns[from]; continue; }
    if(!Array.isArray(m.main)) m.main=[];
    m.main=m.main.map(arr=>Array.isArray(arr)?arr.filter(link=>byName.has(link?.node)):[]);
  }
  wf.connections=conns; wf.name=String(wf.name||"AI Agent Workflow (Essential)");
  return wf;
}

// ---------- core build (ESSENTIAL) ----------
async function buildWorkflowFromRow(row, opts){
  const compat=(opts.compat||'safe')==='full'?'full':'safe';

  // channels from best_reply_shapes (fallback email)
  const channels=[]; const shapes=listify(row.best_reply_shapes);
  for(const sh of shapes){ for(const norm of CHANNEL_NORMALIZE){ if(norm.rx.test(sh) && !channels.includes(norm.k)) channels.push(norm.k); } }
  if(!channels.length) channels.push('email');

  // infer trigger from tags/notes lightly, else manual
  let trigger = 'manual';
  const tagBag = `${row.tags||''} ${row.triggers||''} ${row.how_it_works||''}`.toLowerCase();
  if(/webhook|inbound|form|ticket|lead|privacy|dsr|faq|chat/.test(tagBag)) trigger='webhook';
  else if(/daily|cron|schedule|nps|renewal|report|kpi/.test(tagBag)) trigger='cron';

  // Ask LLM for concise message bodies (optional)
  let msg = await openaiJSON(makeMessagingPrompt(row, channels));
  if(!msg || typeof msg!== 'object') msg = { email:{subject:"Update", body:"Hello — quick update regarding your request."}, sms:{body:"Quick update regarding your request."}, whatsapp:{body:"Quick update regarding your request."}, call:{script:"Calling with a quick update regarding your request."} };

  const title=`${row.scenario_id||'Scenario'} — ${row.name||''} (Essential)`;
  const wf=baseWorkflow(title);

  // Header
  addHeader(wf, "FLOW · PRODUCTION", LAYOUT.prodHeader.x, LAYOUT.prodHeader.y);

  // Trigger
  let trig;
  if(trigger==='cron') trig = addCron(wf, "Cron", LAYOUT.prodStart.x, LAYOUT.prodStart.y-160, compat);
  else if(trigger==='webhook') trig = addWebhook(wf, "Webhook", LAYOUT.prodStart.x, LAYOUT.prodStart.y, compat);
  else trig = addManual(wf, LAYOUT.prodStart.x, LAYOUT.prodStart.y, "Manual Trigger");

  // Init
  const init = addFunction(wf, "Init Context", `
const scenario={
  scenario_id: ${JSON.stringify(row.scenario_id||'')},
  agent_name: ${JSON.stringify(row.agent_name||'')},
  name: ${JSON.stringify(row.name||'')},
  tags: ${JSON.stringify(listify(row["tags (;)"]||row.tags))},
};
const channels=${JSON.stringify(channels)};
const msg=${JSON.stringify(msg)};
return [{...$json, scenario, channels, msg}];`, LAYOUT.prodStart.x+LAYOUT.stepX, LAYOUT.prodStart.y);
  connect(wf, trig, init);

  // Communication Stage (visible hub)
  const comm = addFunction(wf, "Communication (Stage)", "return [$json];", LAYOUT.prodStart.x + 2*LAYOUT.stepX, LAYOUT.prodStart.y);
  connect(wf, init, comm);

  // One linear lane per channel, chained in series (no fan-out, no merges)
  let prev = comm;
  const firstRowY = LAYOUT.prodStart.y - Math.floor(LAYOUT.rowY * (channels.length-1)/2);

  channels.forEach((ch, i)=>{
    const rowY = firstRowY + i*LAYOUT.rowY;
    let stepNo = 0;

    const enter = addFunction(wf, GUIDE.numberSteps?`[${++stepNo}] Enter · ${ch.toUpperCase()}`:`Enter · ${ch.toUpperCase()}`,
      `return [{...$json,__channel:${JSON.stringify(ch)}}];`, LAYOUT.prodStart.x + 3*LAYOUT.stepX, rowY);
    connect(wf, prev, enter);

    const compose = addFunction(wf, GUIDE.numberSteps?`[${++stepNo}] Compose Message`:`Compose Message`, `
const ch=${JSON.stringify(ch)}; const m=$json.msg||{};
const bodies={ email:(m.email?.body)||'', sms:(m.sms?.body)||'', whatsapp:(m.whatsapp?.body)||'', call:(m.call?.script)||''};
return [{...$json, message: bodies[ch] || bodies.email || 'Hello!'}];`, LAYOUT.prodStart.x + 4*LAYOUT.stepX, rowY);
    connect(wf, enter, compose);

    const sender = makeSenderNode(wf, ch, LAYOUT.prodStart.x + 5*LAYOUT.stepX, rowY, compat);
    connect(wf, compose, sender);

    const store = addFunction(wf, GUIDE.numberSteps?`[${++stepNo}] Store Audit`:`Store Audit`,
      `const now=new Date().toISOString(); return [{...$json, __sent_at:now}];`, LAYOUT.prodStart.x + 6*LAYOUT.stepX, rowY);
    connect(wf, sender, store);

    prev = store; // chain channels linearly
  });

  // Metadata
  wf.staticData.__essential = { trigger, channels };
  return sanitizeWorkflow(wf);
}

// ---------- HTTP handler ----------
module.exports = async (req,res)=>{
  Object.entries(HEADERS).forEach(([k,v])=>res.setHeader(k,v));
  if(req.method==="OPTIONS") return res.status(204).end();

  try{
    if(req.method!=="POST"){
      return res.status(200).json({ ok:true, usage:'POST {"scenario_id":"<id>", "compat":"safe|full"}' });
    }
    const body=await new Promise(resolve=>{
      const chunks=[]; req.on("data",c=>chunks.push(c)); req.on("end",()=>{ try{ resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }catch{ resolve({}); } });
    });
    const wanted=(body.scenario_id||"").toString().trim(); if(!wanted) throw new Error("Missing scenario_id");
    const compat=(body.compat||'safe').toLowerCase()==='full'?'full':'safe';

    const row=await fetchSheetRowByScenarioId(wanted);
    if(!row) return res.status(404).json({ ok:false, error:`scenario_id not found: ${wanted}` });

    const wf=await buildWorkflowFromRow(row,{ compat });

    res.status(200);
    res.setHeader("Content-Type","application/json; charset=utf-8");
    res.setHeader("Content-Disposition",`attachment; filename="${(row.scenario_id||'workflow')}.n8n.json"`);
    res.end(JSON.stringify(wf,null,2));
  }catch(err){
    res.status(500).json({ ok:false, error:String(err?.message||err) });
  }
};

// Force Node runtime on Vercel
module.exports.config = { runtime: 'nodejs20.x' };
