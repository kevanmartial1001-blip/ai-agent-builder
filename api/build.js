// api/build.js
// Essential-only generator that keeps the external shape your UI expects.
// Flow: Trigger → Init → Communication(Stage) → per-channel [Enter → Compose → Send → Collect]
// Adds YES/NO hypothesis message variants (default "yes"; override by posting {"__hypothesis":"no"}).
// Env: SHEET_ID, GOOGLE_API_KEY, SHEET_TAB?=Scenarios, OPENAI_API_KEY

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

// ====== Layout (compatible with your UI) ======
const LAYOUT = {
  laneGap: 3200,
  stepX: 720,
  branchY: 820,
  channelY: 520,
  outcomeRowY: 380,
  prodHeader: { x: -1700, y: 40 },
  prodStart:  { x: -1560, y: 300 },
  demoHeader: { x: -1700, y: 40 },
  demoStart:  { x: -1560, y: 300 },
  switchX: -760,
  errorRowYPad: 760,
};

const GUIDE = { showWaypoints: false, numberSteps: true };
const ZONE = { FLOW: "FLOW AREA", ERR: "ERROR AREA" };

const DEMO = {
  to: "+34613030526",
  emailTo: "kevanm.spain@gmail.com",
  waFrom: "+14155238886",
  smsFrom: "+13412184164",
  callFrom: "+13412184164",
};

const DEFAULT_HTTP = {
  pms_upcoming: "https://example.com/pms/upcoming",
  ticket_create: "https://example.com/ticket/create",
  calendar_book: "https://example.com/calendar/book",
};

// ====== Light inference ======
const CHANNEL_NORMALIZE = [
  { k: 'whatsapp', rx: /whatsapp/i },
  { k: 'sms', rx: /(sms|text)/i },
  { k: 'call', rx: /(voice|call|phone)/i },
  { k: 'email', rx: /email/i },
];

const TRIGGER_PREF = {
  APPOINTMENT_SCHEDULING: 'cron', CUSTOMER_SUPPORT_INTAKE: 'webhook', FEEDBACK_NPS: 'cron',
  KNOWLEDGEBASE_FAQ: 'webhook', SALES_OUTREACH: 'manual', LEAD_QUAL_INBOUND: 'webhook',
  CHURN_WINBACK: 'cron', RENEWALS_CSM: 'cron', AR_FOLLOWUP: 'cron', AP_AUTOMATION: 'webhook',
  INVENTORY_MONITOR: 'cron', REPLENISHMENT_PO: 'webhook', FIELD_SERVICE_DISPATCH: 'webhook',
  COMPLIANCE_AUDIT: 'cron', INCIDENT_MGMT: 'webhook', DATA_PIPELINE_ETL: 'cron',
  REPORTING_KPI_DASH: 'cron', ACCESS_GOVERNANCE: 'webhook', PRIVACY_DSR: 'webhook',
  RECRUITING_INTAKE: 'webhook',
};

// ---------- utils ----------
const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const pos = (x, y) => [x, y];
function toObj(header, row) { return Object.fromEntries(header.map((h,i)=>[h,(row[i]??"").toString().trim()])); }
const listify = (v) => Array.isArray(v)
  ? v.map(x=>String(x).trim()).filter(Boolean)
  : String(v||'').split(/[;,/|\n]+/).map(x=>x.trim()).filter(Boolean);

// ---------- sheet + LLM (messages only, optional) ----------
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
      headers:{
        "Authorization":`Bearer ${key}`,
        "Content-Type":"application/json"
      },
      body:JSON.stringify({
        model:"gpt-4o-mini",
        temperature:0.25,
        response_format:{type:"json_object"},
        messages:[
          {role:"system",content:"Return concise JSON only."},
          {role:"user",content:prompt}
        ]
      })
    });
    const j=await r.json(); const txt=j.choices?.[0]?.message?.content?.trim(); if(!txt) return null;
    try{ return JSON.parse(txt); }catch{ return null; }
  }catch{ return null; }
}

function makeMessagingPrompt(row, archetype, channels){
  const ctx=[
    `SCENARIO_ID: ${row.scenario_id||''}`,
    `AGENT_NAME: ${row.agent_name||''}`,
    `INDUSTRY (name): ${row.name||''}`,
    `TRIGGERS: ${row.triggers||''}`,
    `HOW_IT_WORKS: ${row.how_it_works||''}`,
    `ROI_HYPOTHESIS: ${row.roi_hypothesis||''}`,
    `RISK_NOTES: ${row.risk_notes||''}`,
  ].join("\n");
  return `Write two ultra-brief variants per channel (YES vs NO hypothesis). 3–5 lines each.

Return JSON:
{
  "yes": {
    "email":{"subject":"...","body":"..."},
    "sms":{"body":"..."},
    "whatsapp":{"body":"..."},
    "call":{"script":"..."}
  },
  "no": {
    "email":{"subject":"...","body":"..."},
    "sms":{"body":"..."},
    "whatsapp":{"body":"..."},
    "call":{"script":"..."}
  }
}

Channels: ${JSON.stringify(channels)}
Archetype: ${archetype}

Context:
${ctx}`;
}

// ---------- workflow primitives ----------
function baseWorkflow(name){ return { name, nodes:[], connections:{}, active:false, settings:{}, staticData:{}, __yOffset:0 }; }

function uniqueName(wf, base){
  const existing = new Set((wf.nodes||[]).map(n=>String(n.name||'').toLowerCase()));
  if(!base || typeof base!=='string') base = 'Node';
  let name = base; let i = 1;
  while(existing.has(name.toLowerCase())){ i += 1; name = `${base} #${i}`; }
  return name;
}

function nudgeIfOverlapping(wf, x, y){
  const EPS = 64, STEP = 72; let yy = y;
  for(let i=0;i<50;i++){
    const hit = (wf.nodes||[]).some(n=>Array.isArray(n.position)&&Math.abs(n.position[0]-x)<EPS&&Math.abs(n.position[1]-yy)<EPS);
    if(!hit) return yy; yy += STEP;
  }
  return yy;
}

function addNode(wf,node){
  node.name = uniqueName(wf, node.name);
  if(Array.isArray(node.position)){
    const x=node.position[0]; const y=nudgeIfOverlapping(wf,node.position[0], node.position[1]+(wf.__yOffset||0));
    node.position=[x,y];
  } else { node.position=[-1000,300]; }
  wf.nodes.push(node); return node.name;
}

function connect(wf,from,to,outputIndex=0){
  wf.connections[from]??={}; wf.connections[from].main??=[];
  for(let i=wf.connections[from].main.length;i<=outputIndex;i++) wf.connections[from].main[i]=[];
  wf.connections[from].main[outputIndex].push({node:to,type:"main",index:0});
}

function withYOffset(wf,yOffset,fn){ const prev=wf.__yOffset||0; wf.__yOffset=yOffset; try{ fn(); } finally{ wf.__yOffset=prev; } }

function addHeader(wf,label,x,y){
  return addNode(wf,{ id:uid("label"), name:`=== ${label} ===`, type:"n8n-nodes-base.function", typeVersion:1, position:pos(x,y), parameters:{ functionCode:"return [$json];" } });
}
function addManual(wf,x,y,label="Manual Trigger"){ return addNode(wf,{ id:uid("manual"), name:label, type:"n8n-nodes-base.manualTrigger", typeVersion:1, position:pos(x,y), parameters:{} }); }
function addCron(wf,label,x,y,compat){ if(compat==="full"){ return addNode(wf,{ id:uid("cron"), name:label, type:"n8n-nodes-base.cron", typeVersion:1, position:pos(x,y), parameters:{ triggerTimes:{ item:[{ mode:"everyX", everyX:{ hours:0, minutes:30 } }] } } }); } return addManual(wf,x,y,`${label} (Manual)`); }
function addWebhook(wf,label,x,y,compat){ if(compat==="full"){ return addNode(wf,{ id:uid("webhook"), name:label, type:"n8n-nodes-base.webhook", typeVersion:1, position:pos(x,y), parameters:{ path:uid("hook"), methods:["POST"], responseMode:"onReceived" } }); } return addManual(wf,x,y,`${label} (Manual)`); }
function addHTTP(wf,name,urlExpr,bodyExpr,x,y,method="POST"){ return addNode(wf,{ id:uid("http"), name, type:"n8n-nodes-base.httpRequest", typeVersion:3, position:pos(x,y), parameters:{ url:urlExpr, method, jsonParameters:true, sendBody:true, bodyParametersJson:bodyExpr } }); }
function addFunction(wf,name,code,x,y){ return addNode(wf,{ id:uid("func"), name, type:"n8n-nodes-base.function", typeVersion:1, position:pos(x,y), parameters:{ functionCode:code } }); }
function addCollector(wf,x,y){ return addFunction(wf,"Collector (Inspect)",`const now=new Date().toISOString(); const arr=Array.isArray(items)?items:[{json:$json}]; return arr.map((it,i)=>({json:{...it.json,__collected_at:now, index:i}}));`,x,y); }

function makeSenderNode(wf, channel, x, y, compat, demo){
  const friendly = channel.toUpperCase();
  if(compat==='full'){
    if(channel==='email'){
      return addNode(wf,{ id:uid("email"), name: demo?"[Send  Email] (Demo)":"[Send  Email]", type:"n8n-nodes-base.emailSend", typeVersion:3, position:pos(x,y),
        parameters:{ to: demo?"={{$json.emailTo}}":"={{$json.emailTo || 'user@example.com'}}", subject:"={{($json.msg?.[$json.hypothesis||'yes']?.email?.subject) || ($json.scenario?.agent_name) || 'Update'}}", text:"={{$json.message}}" } });
    }
    if(channel==='sms'){
      return addNode(wf,{ id:uid("sms"), name: demo?"[Send  SMS] (Demo)":"[Send  SMS] (Twilio)", type:"n8n-nodes-base.twilio", typeVersion:3, position:pos(x,y),
        parameters:{ resource:"message", operation:"create", from:"={{$json.smsFrom || '+10000000000'}}", to:"={{$json.to || '+10000000001'}}", message:"={{$json.message}}" } });
    }
    if(channel==='whatsapp'){
      return addNode(wf,{ id:uid("wa"), name: demo?"[Send  WhatsApp] (Demo)":"[Send  WhatsApp] (Twilio)", type:"n8n-nodes-base.twilio", typeVersion:3, position:pos(x,y),
        parameters:{ resource:"message", operation:"create", from:"={{'whatsapp:' + ($json.waFrom || '+10000000002')}}", to:"={{'whatsapp:' + ($json.to || '+10000000003')}}", message:"={{$json.message}}" } });
    }
    if(channel==='call'){
      return addHTTP(wf, demo?"[Place Call] (Demo)":"[Place Call]", "={{$json.callWebhook || 'https://example.com/call'}}",
        "={{ { to:$json.to, from:$json.callFrom, text: $json.message } }}", x, y, "POST");
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

// ---------- core build (ESSENTIAL, with YES/NO hypothesis) ----------
async function buildWorkflowFromRow(row, opts){
  const compat=(opts.compat||'safe')==='full'?'full':'safe';
  const includeDemo = !!opts.includeDemo;

  // channels from best_reply_shapes (fallback email)
  const channels=[]; const shapes=listify(row.best_reply_shapes);
  for(const sh of shapes){ for(const norm of CHANNEL_NORMALIZE){ if(norm.rx.test(sh) && !channels.includes(norm.k)) channels.push(norm.k); } }
  if(!channels.length) channels.push('email');

  // pick a simple archetype label for the prompt
  const archetypeGuess = /appointment|schedule|calendar/i.test(`${row.tags||''} ${row.triggers||''} ${row.name||''}`) ? 'APPOINTMENT_SCHEDULING' : 'GENERAL';

  // light trigger inference; allow override by TRIGGER_PREF if we matched a known archetype
  let trigger = 'manual';
  const tagBag = `${row.tags||''} ${row.triggers||''} ${row.how_it_works||''} ${row.name||''}`.toLowerCase();
  if(/webhook|inbound|form|ticket|lead|privacy|dsr|faq|chat/.test(tagBag)) trigger='webhook';
  else if(/daily|cron|schedule|nps|renewal|report|kpi/.test(tagBag)) trigger='cron';
  if(TRIGGER_PREF[archetypeGuess]) trigger = TRIGGER_PREF[archetypeGuess];

  // ask for YES/NO variants; fall back to a tiny default
  let msg = await openaiJSON(makeMessagingPrompt(row, archetypeGuess, channels));
  if(!msg || typeof msg!== 'object' || (!msg.yes && !msg.no)){
    msg = {
      yes: {
        email: { subject: "Quick confirmation", body: "Hi — confirming we’re good to proceed. Reply if you need changes." },
        sms: { body: "All set ✅ — reply if you need changes." },
        whatsapp: { body: "All set ✅ — reply if you need changes." },
        call: { script: "Calling to confirm we are good to proceed. Any changes needed?" }
      },
      no: {
        email: { subject: "Need a quick correction", body: "Hi — looks like we need a small change. Can you share your preference?" },
        sms: { body: "Small change needed. What works for you?" },
        whatsapp: { body: "Small change needed. What works for you?" },
        call: { script: "Calling because we need a small change. What works for you?" }
      }
    };
  }

  const title=`${row.scenario_id||'Scenario'} — ${row.name||''}`.trim();
  const wf=baseWorkflow(title);

  // ===== PROD LANE =====
  withYOffset(wf, 0, () => {
    addHeader(wf, `${ZONE.FLOW} · PRODUCTION LANE`, LAYOUT.prodHeader.x, LAYOUT.prodHeader.y);

    // Trigger
    let trig;
    if (trigger==='cron') trig = addCron(wf, "Cron", LAYOUT.prodStart.x, LAYOUT.prodStart.y - 160, compat);
    else if (trigger==='webhook') trig = addWebhook(wf, "Webhook", LAYOUT.prodStart.x, LAYOUT.prodStart.y, compat);
    else trig = addManual(wf, LAYOUT.prodStart.x, LAYOUT.prodStart.y, "Manual Trigger");

    // Init (+ hypothesis selection)
    const init = addFunction(wf, "Init Context (PROD)", `
const scenario=${JSON.stringify({
  scenario_id: row.scenario_id || '',
  agent_name: row.agent_name || '',
  name: row.name || '',
  triggers: row.triggers || '',
  how_it_works: row.how_it_works || '',
  roi_hypothesis: row.roi_hypothesis || '',
  risk_notes: row.risk_notes || '',
  tags: listify(row["tags (;)"] || row.tags),
  archetype: archetypeGuess,
})};
const channels=${JSON.stringify(channels)};
const systems=${JSON.stringify([])};
const messages=${JSON.stringify(msg)};
const hypothesis = String($json.__hypothesis || 'yes').toLowerCase()==='no' ? 'no' : 'yes';
const demo=${JSON.stringify(DEMO)};
return [{...$json, scenario, channels, systems, msg: messages, hypothesis, ...demo}];`,
      LAYOUT.prodStart.x+LAYOUT.stepX, LAYOUT.prodStart.y);
    connect(wf, trig, init);

    // Communication hub
    const commHubX = LAYOUT.prodStart.x + Math.floor(2*LAYOUT.stepX);
    const commHub = addFunction(wf, "Communication (Stage)", "return [$json];", commHubX, LAYOUT.prodStart.y);
    connect(wf, init, commHub);

    // Channels laid out vertically, chained linearly
    let prev = commHub;
    const chCount = Math.max(channels.length,1);
    const firstChY = LAYOUT.prodStart.y - Math.floor(LAYOUT.channelY * (chCount-1)/2);

    channels.forEach((ch, chIdx)=>{
      const rowY = firstChY + chIdx*LAYOUT.channelY;
      let stepNo=0;

      const enterName = GUIDE.numberSteps ? `[${++stepNo}] Enter · ${ch.toUpperCase()}` : `Enter · ${ch.toUpperCase()}`;
      const enter = addFunction(wf, enterName, `return [{...$json,__channel:${JSON.stringify(ch)}}];`, LAYOUT.prodStart.x + 3*LAYOUT.stepX, rowY);
      connect(wf, prev, enter);

      // Compose from YES/NO variant
      const compose = addFunction(wf, GUIDE.numberSteps?`[${++stepNo}] Compose Message`:`Compose Message`, `
const ch=${JSON.stringify(ch)};
const hyp = $json.hypothesis || 'yes';
const m = ($json.msg && $json.msg[hyp]) ? $json.msg[hyp] : {};
const choose = (obj, key) => (obj && obj[key] && typeof obj[key].body==='string') ? obj[key].body : '';
const text = choose(m, ch) || choose(m, 'email') || 'Hello!';
const subject = (m.email && m.email.subject) ? m.email.subject : 'Update';
return [{...$json, message:text, subject}];`,
        LAYOUT.prodStart.x + 4*LAYOUT.stepX, rowY);
      connect(wf, enter, compose);

      const sender = makeSenderNode(wf, ch, LAYOUT.prodStart.x + 5*LAYOUT.stepX, rowY, compat, includeDemo);
      connect(wf, compose, sender);

      const collector = addCollector(wf, LAYOUT.prodStart.x + 6*LAYOUT.stepX, rowY);
      connect(wf, sender, collector);

      prev = collector;
    });

    // decorate staticData to satisfy UI expectations
    wf.staticData=wf.staticData||{};
    wf.staticData.__design={
      archetype: archetypeGuess,
      prodTrigger: trigger,
      channels,
      systems: [],
      branches: [{ name: 'Main', condition: 'Essential path', steps: [] }],
      errors: [],
      guide: GUIDE,
      layout: { verticalChannels: true, decisions: "none", spacing: LAYOUT, antiOverlap: true, commHub: true },
      zones: ZONE
    };
  });

  return sanitizeWorkflow(wf);
}

// ---------- HTTP handler ----------
module.exports = async (req,res)=>{
  Object.entries(HEADERS).forEach(([k,v])=>res.setHeader(k,v));
  if(req.method==="OPTIONS") return res.status(204).end();

  try{
    if(req.method!=="POST"){
      return res.status(200).json({ ok:true, usage:'POST {"scenario_id":"<id>", "compat":"safe|full", "__hypothesis":"yes|no", "includeDemo":true }' });
    }
    const body=await new Promise(resolve=>{
      const chunks=[]; req.on("data",c=>chunks.push(c)); req.on("end",()=>{ try{ resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }catch{ resolve({}); } });
    });
    const wanted=(body.scenario_id||"").toString().trim(); if(!wanted) throw new Error("Missing scenario_id");
    const compat=(body.compat||'safe').toLowerCase()==='full'?'full':'safe';
    const includeDemo = !!body.includeDemo;

    const row=await fetchSheetRowByScenarioId(wanted);
    if(!row) return res.status(404).json({ ok:false, error:`scenario_id not found: ${wanted}` });

    // pass hypothesis through the pipeline (Init picks it up)
    const wf=await buildWorkflowFromRow({ ...row }, { compat, includeDemo });

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
