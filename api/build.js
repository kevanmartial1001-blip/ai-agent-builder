// api/build.js
// Wide layout, vertical-per-channel *fan-out*, strict chronology, fully linked A→Z.
// Adds a visible Communication (Stage) BEFORE the per-channel fan-out.
// Per-channel gates:  Channel = X?  →  X Allowlist  →  X Allowed?  →  Send X
// All sends converge into a single "Wait for Reply" node.
// Uses conservative n8n node versions (every node has link handles).
// Env: SHEET_ID, GOOGLE_API_KEY, SHEET_TAB?=Scenarios, OPENAI_API_KEY

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

// ====== Layout (extra air) ======
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

// ====== Archetypes & rules ======
const ARCH_RULES = [
  { a:'APPOINTMENT_SCHEDULING', rx:/(appointment|appointments|scheduling|no[-_ ]?show|calendar)/i },
  { a:'CUSTOMER_SUPPORT_INTAKE', rx:/\b(cs|support|helpdesk|ticket|sla|triage|escalation|deflection|kb)\b/i },
  { a:'FEEDBACK_NPS', rx:/\b(nps|survey|surveys|feedback|csat|ces)\b/i },
  { a:'KNOWLEDGEBASE_FAQ', rx:/\b(kb|faq|knowledge|self-?service)\b/i },
  { a:'SALES_OUTREACH', rx:/\b(sales|outreach|cadence|sequence|abm|prospect|cold[-_ ]?email)\b/i },
  { a:'LEAD_QUAL_INBOUND', rx:/\b(inbound|lead[-_ ]?qual|qualification|routing|router|forms?)\b/i },
  { a:'CHURN_WINBACK', rx:/\b(churn|win[-_ ]?back|reactivation|retention|loyalty)\b/i },
  { a:'RENEWALS_CSM', rx:/\b(renewal|qbr|success|csm|upsell|cross-?sell)\b/i },
  { a:'AR_FOLLOWUP', rx:/\b(a\/?r|accounts?\s*receivable|invoice|collections?|dso|reconciliation)\b/i },
  { a:'AP_AUTOMATION', rx:/\b(a\/?p|accounts?\s*payable|invoices?|3[-\s]?way|three[-\s]?way|matching|approvals?)\b/i },
  { a:'INVENTORY_MONITOR', rx:/\b(inventory|stock|sku|threshold|warehouse|3pl|wms|backorder)\b/i },
  { a:'REPLENISHMENT_PO', rx:/\b(replenishment|purchase[-_ ]?order|po|procure|procurement|vendors?|suppliers?)\b/i },
  { a:'FIELD_SERVICE_DISPATCH', rx:/\b(dispatch|work[-_ ]?orders?|technicians?|field|geo|eta|route|yard)\b/i },
  { a:'COMPLIANCE_AUDIT', rx:/\b(compliance|audit|audits|policy|governance|sox|iso|gdpr|hipaa|attestation)\b/i },
  { a:'INCIDENT_MGMT', rx:/\b(incident|sev[: ]?(high|p[12])|major|rca|postmortem|downtime|uptime|slo)\b/i },
  { a:'DATA_PIPELINE_ETL', rx:/\b(etl|pipeline|ingest|transform|load|csv|s3|gcs|orchestration)\b/i },
  { a:'REPORTING_KPI_DASH', rx:/\b(dashboard|dashboards|kpi|scorecard|report|reporting)\b/i },
  { a:'ACCESS_GOVERNANCE', rx:/\b(access|rbac|sso|entitlements|seats|identity|pii|dlp)\b/i },
  { a:'PRIVACY_DSR', rx:/\b(dsr|data\s*subject|privacy\s*request|gdpr|ccpa)\b/i },
  { a:'RECRUITING_INTAKE', rx:/\b(recruit(ing)?|ats|cv|resume|candidate|interviews?)\b/i },
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

const CHANNEL_NORMALIZE = [
  { k: 'whatsapp', rx: /whatsapp/i },
  { k: 'sms', rx: /(sms|text)/i },
  { k: 'call', rx: /(voice|call|phone)/i },
  { k: 'email', rx: /email/i },
];

// ---------- utils ----------
const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const pos = (x, y) => [x, y];
function toObj(header, row) { return Object.fromEntries(header.map((h,i)=>[h,(row[i]??"").toString().trim()])); }
const listify = (v) => Array.isArray(v) ? v.map(x=>String(x).trim()).filter(Boolean) : String(v||'').split(/[;,/|\n]+/).map(x=>x.trim()).filter(Boolean);

function chooseArchetype(row){
  const hay=[row["scenario_id"],row["name"],row["tags"],row["triggers"],row["how_it_works"],row["tool_stack_dev"]].map(x=>String(x||'')).join(' ');
  for(const r of ARCH_RULES) if(r.rx.test(hay)) return r.a;
  return 'SALES_OUTREACH';
}

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

async function openaiJSON(prompt, schemaHint){
  const key=process.env.OPENAI_API_KEY; if(!key) return null;
  try{
    const r=await fetch("https://api.openai.com/v1/chat/completions",{
      method:"POST",
      headers:{ "Authorization":`Bearer ${key}`,"Content-Type":"application/json"},
      body:JSON.stringify({
        model:"gpt-4o-mini",
        temperature:0.25,
        response_format:{type:"json_object"},
        messages:[
          {role:"system",content:"Return concise JSON only."},
          {role:"user",content:prompt+(schemaHint?("\n\nSchema:\n"+schemaHint):"")}
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
  return `
Write two ultra-brief variants per channel (YES vs NO hypothesis). 3–5 lines each.

Return JSON:
{
  "yes": { "email":{"subject":"...","body":"..."},"sms":{"body":"..."},"whatsapp":{"body":"..."},"call":{"script":"..."} },
  "no":  { "email":{"subject":"...","body":"..."},"sms":{"body":"..."},"whatsapp":{"body":"..."},"call":{"script":"..."} }
}

Channels: ${JSON.stringify(channels)}
Archetype: ${archetype}

Context:
${ctx}`.trim();
}

// ---------- workflow primitives (known versions) ----------
function baseWorkflow(name){ return { name, nodes:[], connections:{}, active:false, settings:{}, staticData:{}, __yOffset:0 }; }

function uniqueName(wf, base){
  const existing = new Set((wf.nodes||[]).map(n=>String(n.name||'').toLowerCase()));
  if(!base || typeof base!=='string') base = 'Node';
  let name = base;
  let i = 1;
  while(existing.has(name.toLowerCase())){ i += 1; name = `${base} #${i}`; }
  return name;
}

function nudgeIfOverlapping(wf, x, y){
  const EPS = 64, STEP = 72;
  let yy = y;
  for(let i=0;i<50;i++){
    const hit = (wf.nodes||[]).some(n=>{
      if(!Array.isArray(n.position)) return false;
      const [nx, ny] = n.position;
      return Math.abs(nx - x) < EPS && Math.abs(ny - yy) < EPS;
    });
    if(!hit) return yy;
    yy += STEP;
  }
  return yy;
}

function addNode(wf,node){
  node.name = uniqueName(wf, node.name);
  if(Array.isArray(node.position)){
    const x = node.position[0];
    const y = node.position[1] + (wf.__yOffset||0);
    const yy = nudgeIfOverlapping(wf, x, y);
    node.position=[x, yy];
  }
  wf.nodes.push(node);
  return node.name;
}

function connect(wf,from,to,outputIndex=0){
  wf.connections[from]??={};
  wf.connections[from].main??=[];
  for(let i=wf.connections[from].main.length;i<=outputIndex;i++) wf.connections[from].main[i]=[];
  wf.connections[from].main[outputIndex].push({node:to,type:"main",index:0});
}

function withYOffset(wf,yOffset,fn){ const prev=wf.__yOffset||0; wf.__yOffset=yOffset; try{ fn(); } finally{ wf.__yOffset=prev; } }

// Section headers
function addHeader(wf,label,x,y){
  return addNode(wf,{ id:uid("label"), name:`=== ${label} ===`, type:"n8n-nodes-base.function", typeVersion:1, position:pos(x,y), parameters:{ functionCode:"return [$json];" } });
}

function addManual(wf,x,y,label="Manual Trigger"){ return addNode(wf,{ id:uid("manual"), name:label, type:"n8n-nodes-base.manualTrigger", typeVersion:1, position:pos(x,y), parameters:{} }); }
function addCron(wf,label,x,y,compat){ if(compat==="full"){ return addNode(wf,{ id:uid("cron"), name:label, type:"n8n-nodes-base.cron", typeVersion:1, position:pos(x,y), parameters:{ triggerTimes:{ item:[{ mode:"everyX", everyX:{ hours:0, minutes:15 } }] } } }); } return addNode(wf,{ id:uid("cronph"), name:`${label} (Placeholder)`, type:"n8n-nodes-base.function", typeVersion:1, position:pos(x,y), parameters:{ functionCode:"return [$json];" } }); }
function addWebhook(wf,label,x,y,compat){ if(compat==="full"){ return addNode(wf,{ id:uid("webhook"), name:label, type:"n8n-nodes-base.webhook", typeVersion:1, position:pos(x,y), parameters:{ path:uid("hook"), methods:["POST"], responseMode:"onReceived" } }); } return addNode(wf,{ id:uid("webph"), name:`${label} (Placeholder)`, type:"n8n-nodes-base.function", typeVersion:1, position:pos(x,y), parameters:{ functionCode:"return [$json];" } }); }
function addHTTP(wf,name,urlExpr,bodyExpr,x,y,method="POST"){ return addNode(wf,{ id:uid("http"), name, type:"n8n-nodes-base.httpRequest", typeVersion:3, position:pos(x,y), parameters:{ url:urlExpr, method, jsonParameters:true, sendBody:true, bodyParametersJson:bodyExpr } }); }
function addFunction(wf,name,code,x,y){ return addNode(wf,{ id:uid("func"), name, type:"n8n-nodes-base.function", typeVersion:1, position:pos(x,y), parameters:{ functionCode:code } }); }
function addIf(wf,name,left,op,right,x,y){ return addNode(wf,{ id:uid("if"), name, type:"n8n-nodes-base.if", typeVersion:2, position:pos(x,y), parameters:{ conditions:{ number:[], string:[{ value1:left, operation:op, value2:right }] } } }); }
function addCollector(wf,x,y){ return addFunction(wf,"Collector (Inspect)",`const now=new Date().toISOString(); const arr=Array.isArray(items)?items:[{json:$json}]; return arr.map((it,i)=>({json:{...it.json,__collected_at:now, index:i}}));`,x,y); }
function addWait(wf,x,y){ return addNode(wf,{ id:uid("wait"), name:"Wait for Reply", type:"n8n-nodes-base.wait", typeVersion:1, position:pos(x,y), parameters:{} }); }

// sender nodes
function makeSenderNode(wf, channel, x, y, compat, demo){
  const friendly = channel.toUpperCase();
  if(compat==='full'){
    if(channel==='email'){
      return addNode(wf,{ id:uid("email"), name:"Email Send", type:"n8n-nodes-base.emailSend", typeVersion:3, position:pos(x,y),
        parameters:{ to:"={{$json.emailTo || 'user@example.com'}}", subject:"={{$json.subject || $json.scenario?.agent_name || 'Update'}}", text:"={{$json.message || 'Hello!'}}" } });
    }
    if(channel==='sms'){
      return addNode(wf,{ id:uid("sms"), name:"Twilio SMS", type:"n8n-nodes-base.twilio", typeVersion:3, position:pos(x,y),
        parameters:{ resource:"message", operation:"create", from:"={{$json.smsFrom || '+10000000000'}}", to:"={{$json.to || '+10000000001'}}", message:"={{$json.message || 'Hello!'}}" } });
    }
    if(channel==='whatsapp'){
      return addNode(wf,{ id:uid("wa"), name:"Twilio WhatsApp", type:"n8n-nodes-base.twilio", typeVersion:3, position:pos(x,y),
        parameters:{ resource:"message", operation:"create", from:"={{'whatsapp:' + ($json.waFrom || '+10000000002')}}", to:"={{'whatsapp:' + ($json.to || '+10000000003')}}", message:"={{$json.message || 'Hello!'}}" } });
    }
    if(channel==='call'){
      return addHTTP(wf,"Twilio Call (TTS)","={{$json.callWebhook || 'https://example.com/call'}}","={{ { to:$json.to, from:$json.callFrom, text: ($json.message || 'Hello!') } }}",x,y,"POST");
    }
  }
  return addFunction(wf, `Demo Send ${friendly}`, "return [$json];", x, y);
}

// ---------- sanitization ----------
function sanitizeWorkflow(wf){
  const REQUIRED_TYPE="n8n-nodes-base.function";
  const byName=new Map();

  wf.nodes=(wf.nodes||[]).map((n,idx)=>{
    if(!n.name||typeof n.name!=='string') n.name=`Node ${idx+1}`;
    if(!n.type||typeof n.type!=='string'||!n.type.trim()){ n.type=REQUIRED_TYPE; n.typeVersion=1; n.parameters={ functionCode:"return [$json];" }; }
    if(typeof n.typeVersion!=='number') n.typeVersion=1;
    if(!Array.isArray(n.position)||n.position.length!==2){ n.position=[-1000, 300+(idx*40)]; }
    if(!n.parameters||typeof n.parameters!=='object') n.parameters={};
    if(n.type==="n8n-nodes-base.function" && !n.parameters.functionCode){
      n.parameters.functionCode = "return [$json];";
    }
    byName.set(n.name,n); return n;
  });

  const conns=wf.connections||{};
  for(const [from,m] of Object.entries(conns)){
    if(!byName.has(from)){ delete conns[from]; continue; }
    if(!m||typeof m!=="object"){ delete conns[from]; continue; }
    if(!Array.isArray(m.main)) m.main=[];
    m.main=m.main.map(arr=>Array.isArray(arr)?arr.filter(link=>byName.has(link?.node)):[]);
  }
  wf.connections=conns;
  wf.name=String(wf.name||"AI Agent Workflow");
  return wf;
}

// ---------- LLM orchestration ----------
function makeDesigner(row){
  return openaiJSON(
    makeMessagingPrompt(row, 'GENERAL', ['email']),
    `{"email":{"subject":string,"body":string},"sms":{"body":string},"whatsapp":{"body":string},"call":{"script":string}}`
  );
}
function makeMessages(row, archetype, channels){
  return openaiJSON(
    makeMessagingPrompt(row, archetype, channels),
    `{"yes":{"email":{"subject":string,"body":string},"sms":{"body":string},"whatsapp":{"body":string},"call":{"script":string}},"no":{"email":{"subject":string,"body":string},"sms":{"body":string},"whatsapp":{"body":string},"call":{"script":string}}}`
  );
}

// ---------- core build ----------
async function buildWorkflowFromRow(row, opts){
  const compat=(opts.compat||'safe')==='full'?'full':'safe';

  // channels from best_reply_shapes
  const channels=[]; const shapes=listify(row.best_reply_shapes);
  for(const sh of shapes){ for(const norm of CHANNEL_NORMALIZE){ if(norm.rx.test(sh) && !channels.includes(norm.k)) channels.push(norm.k); } }
  if(!channels.length) channels.push('email');

  // choose archetype/trigger
  let archetype=chooseArchetype(row);
  let prodTrigger=TRIGGER_PREF[archetype]||'manual';

  // messages (YES/NO)
  const designMsgs=(await makeMessages(row, archetype, channels))||{};
  const msgVariants = designMsgs && typeof designMsgs==='object' ? designMsgs : {
    yes:{ email:{subject:"Quick confirmation", body:"All set — confirming plan."}, sms:{body:"All set ✅"}, whatsapp:{body:"All set ✅"}, call:{script:"Calling to confirm we’re set."} },
    no:{  email:{subject:"Need a small change", body:"Looks like we need a tweak — what works?"}, sms:{body:"Small change needed. What works?"}, whatsapp:{body:"Small change needed. What works?"}, call:{script:"We need a quick change. What works?"} }
  };

  const title=`${row.scenario_id||'Scenario'} — ${row.name||''}`.trim();
  const wf=baseWorkflow(title);

  // ===== PROD LANE =====
  withYOffset(wf, 0, () => {
    addHeader(wf, `${ZONE.FLOW} · PRODUCTION LANE`, LAYOUT.prodHeader.x, LAYOUT.prodHeader.y);

    // Trigger
    let trig;
    if (prodTrigger==='cron') trig = addCron(wf, "Cron (from LLM)", LAYOUT.prodStart.x, LAYOUT.prodStart.y - 160, compat);
    else if (prodTrigger==='webhook') trig = addWebhook(wf, "Webhook (from LLM)", LAYOUT.prodStart.x, LAYOUT.prodStart.y, compat);
    else if (prodTrigger==='imap') trig = addFunction(wf, "IMAP Intake (Placeholder)", "return [$json];", LAYOUT.prodStart.x, LAYOUT.prodStart.y);
    else trig = addManual(wf, LAYOUT.prodStart.x, LAYOUT.prodStart.y, "Manual Trigger");

    // Init context (incl. hypothesis YES/NO selection)
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
  archetype,
})};
const channels=${JSON.stringify(channels)};
const systems=${JSON.stringify(['email','twilio'])};
const messages=${JSON.stringify(msgVariants)};
const hypothesis = (String($json.__hypothesis||'yes').toLowerCase()==='no') ? 'no' : 'yes';
const payload = {...$json, scenario, channels, systems, msg:messages, hypothesis,
  emailTo: $json.emailTo || ${JSON.stringify(DEMO.emailTo)},
  to: $json.to || ${JSON.stringify(DEMO.to)},
  smsFrom: $json.smsFrom || ${JSON.stringify(DEMO.smsFrom)},
  waFrom: $json.waFrom || ${JSON.stringify(DEMO.waFrom)},
  callFrom: $json.callFrom || ${JSON.stringify(DEMO.callFrom)}
};
return [payload];`,
      LAYOUT.prodStart.x+LAYOUT.stepX, LAYOUT.prodStart.y);
    connect(wf, trig, init);

    // Communication hub
    const commHubX = LAYOUT.prodStart.x + Math.floor(2*LAYOUT.stepX);
    const commHub = addFunction(wf, "Communication (Stage)", "return [$json];", commHubX, LAYOUT.prodStart.y);
    connect(wf, init, commHub);

    // Compose Message (shared)
    const compose = addFunction(wf, "[1] Compose Message", `
const hyp=$json.hypothesis||'yes'; const m=$json.msg?.[hyp]||{};
const chBodies={ email:(m.email?.body)||'', sms:(m.sms?.body)||'', whatsapp:(m.whatsapp?.body)||'', call:(m.call?.script)||''};
const subject=(m.email?.subject)||'Update';
return [{...$json, subject, chBodies}];`, LAYOUT.prodStart.x + 3*LAYOUT.stepX, LAYOUT.prodStart.y);
    connect(wf, commHub, compose);

    // Wait for Reply (merge target)
    const waitNode = addWait(wf, LAYOUT.prodStart.x + 7*LAYOUT.stepX, LAYOUT.prodStart.y);

    // Build per-channel GATING lanes in parallel (fan-out from Compose; converge into Wait)
    const chCount = Math.max(channels.length,1);
    const firstChY = LAYOUT.prodStart.y - Math.floor(LAYOUT.channelY * (chCount-1)/2);

    channels.forEach((ch, chIdx)=>{
      const rowY = firstChY + chIdx*LAYOUT.channelY;

      // 1) Channel = X? (enabled)
      const enabledIf = addIf(wf, `Channel = ${ch.toUpperCase()}?`,
        "={{ $json.channels && ($json.channels.indexOf('"+ch+"')>-1 ? 'yes':'no') }}", "equal", "yes",
        LAYOUT.prodStart.x + 4*LAYOUT.stepX, rowY);
      connect(wf, compose, enabledIf);

      // 2) X Allowlist (compute flags)
      const allowFn = addFunction(wf, `${ch.toUpperCase()} Allowlist`, `
const flags=$json.flags||{};
if('${ch}'==='email'){ flags.emailAllowed = !!$json.emailTo; }
if('${ch}'==='sms'){ flags.phoneAllowed = !!$json.to; }
if('${ch}'==='whatsapp'){ flags.waAllowed = !!$json.to; }
if('${ch}'==='call'){ flags.callAllowed = !!$json.to; }
return [{...$json, flags}];`,
        LAYOUT.prodStart.x + 5*LAYOUT.stepX, rowY);
      connect(wf, enabledIf, allowFn, 0); // true branch

      // 3) X Allowed? (IF)
      const condExprMap = {
        email: "={{ $json.flags?.emailAllowed ? 'yes':'no' }}",
        sms: "={{ $json.flags?.phoneAllowed ? 'yes':'no' }}",
        whatsapp: "={{ $json.flags?.waAllowed ? 'yes':'no' }}",
        call: "={{ $json.flags?.callAllowed ? 'yes':'no' }}",
      };
      const allowedIf = addIf(wf, `${ch.toUpperCase()} Allowed?`,
        condExprMap[ch] || "={{ 'no' }}", "equal", "yes",
        LAYOUT.prodStart.x + 6*LAYOUT.stepX, rowY);
      connect(wf, allowFn, allowedIf);

      // Prepare per-channel body
      const prep = addFunction(wf, `Prepare ${ch.toUpperCase()} Body`, `
const bodies=$json.chBodies||{};
const txt = bodies['${ch}'] || bodies.email || 'Hello!';
return [{...$json, message: txt}];`,
        LAYOUT.prodStart.x + 6.2*LAYOUT.stepX, rowY);
      connect(wf, allowedIf, prep, 0);

      // 4) Sender → Wait
      const sender = makeSenderNode(wf, ch, LAYOUT.prodStart.x + 6.8*LAYOUT.stepX, rowY, compat, false);
      connect(wf, prep, sender);
      connect(wf, sender, waitNode);

      // false branches (not allowed) terminate without send (as in screenshot)
    });

    // static design (kept to avoid UI fallback)
    wf.staticData=wf.staticData||{};
    wf.staticData.__design={
      archetype,
      prodTrigger,
      channels,
      systems:['email','twilio'],
      branches:[{ name:'Main', condition:'Essential comms', steps:[] }],
      errors:[],
      guide: GUIDE,
      layout: { verticalChannels:true, decisions:"if-gates", spacing: LAYOUT, antiOverlap:true, commHub:true },
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
      return res.status(200).json({ ok:true, usage:'POST {"scenario_id":"<id>", "compat":"safe|full", "__hypothesis":"yes|no"}' });
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
