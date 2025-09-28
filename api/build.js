// api/build.js
// Wide layout retained; outputs ESSENTIAL steps with a single YES/NO hypothesis decision.
// Structure preserved so your UI doesn't fall back.
// Flow per channel: Trigger → Init → Communication(Stage) → Enter → [Decision YES/NO] → Compose → Send → Store
// Env: SHEET_ID, GOOGLE_API_KEY, SHEET_TAB?=Scenarios, OPENAI_API_KEY

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

// ====== Layout (extra air, unchanged) ======
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

// ====== Archetypes & rules (unchanged) ======
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
          {role:"system",content:"Return valid JSON only."},
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
  return `Write two ultra-brief variants per channel for a YES vs NO hypothesis. 3–5 lines each.
Return JSON {"yes":{"email":{"subject":"...","body":"..."},"sms":{"body":"..."},"whatsapp":{"body":"..."},"call":{"script":"..."}},
"no":{"email":{"subject":"...","body":"..."},"sms":{"body":"..."},"whatsapp":{"body":"..."},"call":{"script":"..."}}}

Channels: ${JSON.stringify(channels)} | Archetype: ${archetype}

Context:
${ctx}`;
}

function makeMessages(row, archetype, channels){
  return openaiJSON(
    makeMessagingPrompt(row, archetype, channels),
    `{"yes":{"email":{"subject":string,"body":string},"sms":{"body":string},"whatsapp":{"body":string},"call":{"script":string}},"no":{"email":{"subject":string,"body":string},"sms":{"body":string},"whatsapp":{"body":string},"call":{"script":string}}}`
  );
}

// ---------- workflow primitives (known versions) ----------
function baseWorkflow(name){ return { name, nodes:[], connections:{}, active:false, settings:{}, staticData:{}, __yOffset:0 }; }

// ensure unique names BEFORE inserting
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
function addSwitch(wf,name,valueExpr,rules,x,y){ return addNode(wf,{ id:uid("switch"), name, type:"n8n-nodes-base.switch", typeVersion:2, position:pos(x,y), parameters:{ value1:valueExpr, rules } }); }
function addCollector(wf,x,y){ return addFunction(wf,"Collector (Inspect)",`const now=new Date().toISOString(); const arr=Array.isArray(items)?items:[{json:$json}]; return arr.map((it,i)=>({json:{...it.json,__collected_at:now, index:i}}));`,x,y); }

// sender nodes
function makeSenderNode(wf, channel, x, y, compat, demo){
  const friendly = channel.toUpperCase();
  if(compat==='full'){
    if(channel==='email'){
      return addNode(wf,{ id:uid("email"), name: demo?"[Send  Email] (Demo)":"[Send  Email]", type:"n8n-nodes-base.emailSend", typeVersion:3, position:pos(x,y),
        parameters:{ to: demo?"={{$json.emailTo}}":"={{$json.emailTo || 'user@example.com'}}", subject:"={{($json.msg?.[$json.__decision||'yes']?.email?.subject) || ($json.msg?.yes?.email?.subject) || 'Update'}}", text:"={{$json.message || ($json.msg?.[$json.__decision||'yes']?.email?.body) || ($json.msg?.yes?.email?.body) || 'Hello!'}}" } });
    }
    if(channel==='sms'){
      return addNode(wf,{ id:uid("sms"), name: demo?"[Send  SMS] (Demo)":"[Send  SMS] (Twilio)", type:"n8n-nodes-base.twilio", typeVersion:3, position:pos(x,y),
        parameters:{ resource:"message", operation:"create", from:"={{$json.smsFrom || '+10000000000'}}", to:"={{$json.to || '+10000000001'}}", message:"={{$json.message || ($json.msg?.[$json.__decision||'yes']?.sms?.body) || ($json.msg?.yes?.sms?.body) || 'Hello!'}}" } });
    }
    if(channel==='whatsapp'){
      return addNode(wf,{ id:uid("wa"), name: demo?"[Send  WhatsApp] (Demo)":"[Send  WhatsApp] (Twilio)", type:"n8n-nodes-base.twilio", typeVersion:3, position:pos(x,y),
        parameters:{ resource:"message", operation:"create", from:"={{'whatsapp:' + ($json.waFrom || '+10000000002')}}", to:"={{'whatsapp:' + ($json.to || '+10000000003')}}", message:"={{$json.message || ($json.msg?.[$json.__decision||'yes']?.whatsapp?.body) || ($json.msg?.yes?.whatsapp?.body) || 'Hello!'}}" } });
    }
    if(channel==='call'){
      return addHTTP(wf, demo?"[Place Call] (Demo)":"[Place Call]", "={{$json.callWebhook || 'https://example.com/call'}}",
        "={{ { to:$json.to, from:$json.callFrom, text: ($json.message || ($json.msg?.[$json.__decision||'yes']?.call?.script) || ($json.msg?.yes?.call?.script) || 'Hello!') } }}", x, y, "POST");
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

// ---------- LLM orchestration (structure disabled; messages only) ----------
function makeDesigner(row){ return null; }

// ---------- core build ----------
async function buildWorkflowFromRow(row, opts){
  const compat=(opts.compat||'safe')==='full'?'full':'safe';
  const includeDemo=false; // DEMO lane removed

  // channels from best_reply_shapes
  const channels=[]; const shapes=listify(row.best_reply_shapes);
  for(const sh of shapes){ for(const norm of CHANNEL_NORMALIZE){ if(norm.rx.test(sh) && !channels.includes(norm.k)) channels.push(norm.k); } }
  if(!channels.length) channels.push('email');

  // choose archetype/trigger
  let archetype=chooseArchetype(row);
  let prodTrigger=TRIGGER_PREF[archetype]||'manual';

  // YES/NO messages
  let msg=(await makeMessages(row, archetype, channels))||null;
  if(!msg||typeof msg!=="object"){
    msg={
      yes:{ email:{subject:"Confirmed ✔", body:"Good news — your request is confirmed."}, sms:{body:"Confirmed."}, whatsapp:{body:"Confirmed."}, call:{script:"Calling to confirm."} },
      no:{  email:{subject:"Next steps needed ✖", body:"We need one more step from you to proceed."}, sms:{body:"Action needed."}, whatsapp:{body:"Action needed."}, call:{script:"Calling to clarify next steps."} }
    };
  }

  // Minimal branches: one decision
  const branches=[{
    name:"Essential",
    condition:"Hypothesis check",
    steps:[{ name:"Decision: Hypothesis valid?", kind:"decision", outcomes:[
      { value:"yes", steps:[ { name:"Compose: YES response", kind:"compose" } ] },
      { value:"no",  steps:[ { name:"Compose: NO response",  kind:"compose" } ] },
    ] }]
  }];

  const systems=[]; // keep minimal
  const errors=[];

  const title=`${row.scenario_id||'Scenario'} — ${row.name||''}`.trim();
  const wf=baseWorkflow(title);

  // lane builder (PROD only)
  function buildLane({ laneLabel, yOffset, triggerKind, isDemo }){
    withYOffset(wf, yOffset, () => {
      addHeader(wf, `${ZONE.FLOW} · ${laneLabel}`, LAYOUT.prodHeader.x, LAYOUT.prodHeader.y);

      let trig;
      if (triggerKind==='cron') trig = addCron(wf, "Cron (from Pref)", LAYOUT.prodStart.x, LAYOUT.prodStart.y - 160, compat);
      else if (triggerKind==='webhook') trig = addWebhook(wf, "Webhook (from Pref)", LAYOUT.prodStart.x, LAYOUT.prodStart.y, compat);
      else if (triggerKind==='imap') trig = addFunction(wf, "IMAP Intake (Placeholder)", "return [$json];", LAYOUT.prodStart.x, LAYOUT.prodStart.y);
      else trig = addManual(wf, LAYOUT.prodStart.x, LAYOUT.prodStart.y, "Manual Trigger");

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
const systems=${JSON.stringify(systems)};
const msg=${JSON.stringify(msg)};
return [{...$json, scenario, channels, systems, msg}];`,
        LAYOUT.prodStart.x+LAYOUT.stepX, LAYOUT.prodStart.y);
      connect(wf, trig, init);

      const sw = addSwitch(wf, "Branch (Essential)", "={{$json.__branch || 'Essential'}}",
        [{operation:'equal', value2:'Essential'}], LAYOUT.switchX, LAYOUT.prodStart.y);
      connect(wf, init, sw);

      // Communication hub before channels
      const commHubX = LAYOUT.prodStart.x + Math.floor(3.6*LAYOUT.stepX);
      const commHub = addFunction(wf, "Communication (Stage)", "return [$json];", commHubX, LAYOUT.prodStart.y);
      connect(wf, sw, commHub, 0);

      const chCount = Math.max(channels.length,1);
      const firstChY = LAYOUT.prodStart.y - Math.floor(LAYOUT.channelY * (chCount-1)/2);
      let prevChannelCollector = null;

      channels.forEach((ch, chIdx)=>{
        const rowY = firstChY + chIdx*LAYOUT.channelY;
        let stepNo=0;

        const enterName = GUIDE.numberSteps?`[${++stepNo}] Enter: Essential · ${ch.toUpperCase()}`:`Enter: Essential · ${ch.toUpperCase()}`;
        const enter = addFunction(wf, enterName,
          `return [{...$json,__branch:'Essential',__cond:'Hypothesis',__channel:${JSON.stringify(ch)}}];`,
          LAYOUT.prodStart.x + 4*LAYOUT.stepX, rowY);
        if (chIdx === 0) connect(wf, commHub, enter);
        if (prevChannelCollector) connect(wf, prevChannelCollector, enter);

        // Decision (YES/NO)
        const dSwitch = addSwitch(wf, GUIDE.numberSteps?`[${++stepNo}] Decision: Hypothesis valid?`:`Decision: Hypothesis valid?`, "={{$json.__decision || 'yes'}}",
          [{operation:'equal', value2:'yes'},{operation:'equal', value2:'no'}], LAYOUT.prodStart.x + 5*LAYOUT.stepX, rowY);
        connect(wf, enter, dSwitch);

        let chainCollector = null;
        ["yes","no"].forEach((outcome, oIdx)=>{
          const oy = rowY + (oIdx===0? -Math.floor(LAYOUT.outcomeRowY/2) : Math.floor(LAYOUT.outcomeRowY/2));
          const oEnter = addFunction(wf, `[${stepNo}.${oIdx+1}] Outcome: ${outcome.toUpperCase()}`,
            `return [{...$json,__decision:${JSON.stringify(outcome)}}];`, LAYOUT.prodStart.x + Math.floor(5.6*LAYOUT.stepX), oy);
          connect(wf, dSwitch, oEnter, oIdx);

          // Compose (uses msg[__decision])
          const compose = addFunction(wf, `[${stepNo}.${oIdx+1}.1] Compose: ${outcome.toUpperCase()}`, `
const ch=${JSON.stringify(ch)}; const variant = String($json.__decision||'yes');
const m = ($json.msg && $json.msg[variant]) ? $json.msg[variant] : ($json.msg?.yes || {});
const bodies={ email:(m.email?.body)||'', sms:(m.sms?.body)||'', whatsapp:(m.whatsapp?.body)||'', call:(m.call?.script)||''};
return [{...$json, message:bodies[ch] || bodies.email || 'Hello!'}];`, LAYOUT.prodStart.x + Math.floor(6.2*LAYOUT.stepX), oy);
          connect(wf, oEnter, compose);

          const sender = makeSenderNode(wf, ch, LAYOUT.prodStart.x + Math.floor(7.2*LAYOUT.stepX), oy, compat, includeDemo);
          connect(wf, compose, sender);

          const oCollector = addCollector(wf, LAYOUT.prodStart.x + Math.floor(8.0*LAYOUT.stepX), oy);
          connect(wf, sender, oCollector);

          if(chainCollector) connect(wf, chainCollector, oCollector);
          chainCollector = oCollector;
        });

        // chain channels
        prevChannelCollector = chainCollector;
      });
    });
  }

  // build PROD lane only
  buildLane({ laneLabel:"PRODUCTION LANE", yOffset:0, triggerKind:prodTrigger, isDemo:false });

  wf.staticData=wf.staticData||{};
  wf.staticData.__design={
    archetype, prodTrigger, channels, systems, branches, errors,
    guide: GUIDE,
    layout: { verticalChannels: true, decisions: "switch+lanes", spacing: LAYOUT, antiOverlap: true, commHub: true },
    zones: ZONE
  };

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

// Force Node runtime on Vercel (same as before)
module.exports.config = { runtime: 'nodejs20.x' };
