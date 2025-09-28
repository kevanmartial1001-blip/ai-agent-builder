// api/build.js
// Wide layout, vertical-per-channel branches, strict chronology, fully linked.
// Adds LLM-driven DECISION steps with explicit outcomes (all paths A→Z).
// For APPOINTMENT_SCHEDULING, auto-builds a canonical chronological flow if LLM is sparse.
// Uses conservative n8n node versions (every node has link handles).
// Env: SHEET_ID, GOOGLE_API_KEY, SHEET_TAB?=Scenarios, OPENAI_API_KEY

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

// ====== Layout (more air to prevent overlap) ======
const LAYOUT = {
  laneGap: 2100,
  stepX: 520,
  branchY: 520,
  channelY: 360,
  outcomeRowY: 200,
  prodHeader: { x: -1520, y: 40 },
  prodStart:  { x: -1380, y: 300 },
  demoHeader: { x: -1520, y: 40 },
  demoStart:  { x: -1380, y: 300 },
  switchX: -420,
  errorRowYPad: 460,
};

// Visual guide options
const GUIDE = { showWaypoints: false, numberSteps: true };

// “Orange band” labels for your UI
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
        temperature:0.35,
        response_format:{type:"json_object"},
        messages:[
          {role:"system",content:"You are an expert workflow designer for n8n. Exhaustively enumerate decision outcomes. Always return valid JSON."},
          {role:"user",content:prompt+(schemaHint?("\n\nSchema:\n"+schemaHint):"")}
        ]
      })
    });
    const j=await r.json(); const txt=j.choices?.[0]?.message?.content?.trim(); if(!txt) return null;
    try{ return JSON.parse(txt); }catch{ return null; }
  }catch{ return null; }
}

function makeDesignerPrompt(row){
  const ctx=[
    `SCENARIO_ID: ${row.scenario_id||''}`,
    `AGENT_NAME: ${row.agent_name||''}`,
    `INDUSTRY (name): ${row.name||''}`,
    `TRIGGERS: ${row.triggers||''}`,
    `BEST_REPLY_SHAPES: ${row.best_reply_shapes||''}`,
    `HOW_IT_WORKS: ${row.how_it_works||''}`,
    `ROI_HYPOTHESIS: ${row.roi_hypothesis||''}`,
    `RISK_NOTES: ${row.risk_notes||''}`,
    `TAGS: ${row["tags (;)"]||row.tags||''}`,
  ].join("\n");
  return `
Design a bullet-proof n8n workflow and enumerate ALL realistic outcomes using industry knowledge + context (TRIGGERS/BEST_REPLY_SHAPES/RISK_NOTES/ROI_HYPOTHESIS).

Rules:
- "trigger": one of ["cron","webhook","imap","manual"].
- "channels": ordered subset of ["email","sms","whatsapp","call"].
- "branches": ≤6. Each branch is a high-level path.
- Step kinds: "compose" | "http" | "update" | "route" | "wait" | "score" | "lookup" | "book" | "ticket" | "notify" | "store" | "decision".
- A "decision" step MUST include exhaustive "outcomes". Each outcome: { "value": string, "steps": Step[] }.
- Preserve strict chronological order. No ambiguous jumps.

Return JSON:
{
  "archetype": "...",
  "trigger": "cron|webhook|imap|manual",
  "channels": ["email","sms","whatsapp","call"],
  "branches": [
    { "name":"...", "condition":"...", "steps":[
        { "name":"...", "kind":"compose|http|update|route|wait|score|lookup|book|ticket|notify|store" },
        { "name":"...", "kind":"decision", "outcomes":[
          { "value":"...", "steps":[{ "name":"...","kind":"..." }, ...] }, ...
        ] }
    ] }
  ],
  "errors": [{ "name":"...", "mitigation":"..." }],
  "systems": ["pms","crm","calendar","kb","twilio","email"]
}

Context:
${ctx}`;
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
Write concise outreach content for ${JSON.stringify(channels)} for archetype ${archetype}.
No IVR "press 1". 3–6 short lines each.

Return JSON: { "email": { "subject":"...", "body":"..." }, "sms": {"body":"..."}, "whatsapp":{"body":"..."}, "call":{"script":"..."} }

Context:
${ctx}`;
}

// ---------- workflow primitives (known versions) ----------
function baseWorkflow(name){ return { name, nodes:[], connections:{}, active:false, settings:{}, staticData:{}, __yOffset:0 }; }

// ensure unique names BEFORE inserting (prevents breaking connections later)
function uniqueName(wf, base){
  const existing = new Set((wf.nodes||[]).map(n=>String(n.name||'').toLowerCase()));
  if(!base || typeof base!=='string') base = 'Node';
  let name = base;
  let i = 1;
  while(existing.has(name.toLowerCase())){
    i += 1;
    name = `${base} #${i}`;
  }
  return name;
}

function addNode(wf,node){
  node.name = uniqueName(wf, node.name);
  if(Array.isArray(node.position)){
    node.position=[node.position[0], node.position[1]+(wf.__yOffset||0)];
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

// Section headers (your UI can render these as “orange bands”)
function addHeader(wf,label,x,y){
  return addNode(wf,{ id:uid("label"), name:`=== ${label} ===`, type:"n8n-nodes-base.function", typeVersion:1, position:pos(x,y), parameters:{ functionCode:"return [$json];" } });
}

function addManual(wf,x,y,label="Manual Trigger"){ return addNode(wf,{ id:uid("manual"), name:label, type:"n8n-nodes-base.manualTrigger", typeVersion:1, position:pos(x,y), parameters:{} }); }
function addCron(wf,label,x,y,compat){ if(compat==="full"){ return addNode(wf,{ id:uid("cron"), name:label, type:"n8n-nodes-base.cron", typeVersion:1, position:pos(x,y), parameters:{ triggerTimes:{ item:[{ mode:"everyX", everyX:{ hours:0, minutes:15 } }] } } }); } return addNode(wf,{ id:uid("cronph"), name:`${label} (Placeholder)`, type:"n8n-nodes-base.function", typeVersion:1, position:pos(x,y), parameters:{ functionCode:"return [$json];" } }); }
function addWebhook(wf,label,x,y,compat){ if(compat==="full"){ return addNode(wf,{ id:uid("webhook"), name:label, type:"n8n-nodes-base.webhook", typeVersion:1, position:pos(x,y), parameters:{ path:uid("hook"), methods:["POST"], responseMode:"onReceived" } }); } return addNode(wf,{ id:uid("webph"), name:`${label} (Placeholder)`, type:"n8n-nodes-base.function", typeVersion:1, position:pos(x,y), parameters:{ functionCode:"return [$json];" } }); }
function addHTTP(wf,name,urlExpr,bodyExpr,x,y,method="POST"){ return addNode(wf,{ id:uid("http"), name, type:"n8n-nodes-base.httpRequest", typeVersion:3, position:pos(x,y), parameters:{ url:urlExpr, method, jsonParameters:true, sendBody:true, bodyParametersJson:bodyExpr } }); }
function addFunction(wf,name,code,x,y){ return addNode(wf,{ id:uid("func"), name, type:"n8n-nodes-base.function", typeVersion:1, position:pos(x,y), parameters:{ functionCode:code } }); }
function addIf(wf,name,left,op,right,x,y){ return addNode(wf,{ id:uid("if"), name, type:"n8n-nodes-base.if", typeVersion:2, position:pos(x,y), parameters:{ conditions:{ number:[], string:[{ value1:left, operation:op, value2:right }] } } }); }
function addSwitch(wf,name,valueExpr,rules,x,y){ return addNode(wf,{ id:uid("switch"), name, type:"n8n-nodes-base.switch", typeVersion:2, position:pos(x,y), parameters:{ value1:valueExpr, rules } }); }
function addSplit(wf,x,y,size=20){ return addNode(wf,{ id:uid("split"), name:"Split In Batches", type:"n8n-nodes-base.splitInBatches", typeVersion:1, position:pos(x,y), parameters:{ batchSize:size } }); }
function addCollector(wf,x,y){ return addFunction(wf,"Collector (Inspect)",`const now=new Date().toISOString(); const arr=Array.isArray(items)?items:[{json:$json}]; return arr.map((it,i)=>({json:{...it.json,__collected_at:now, index:i}}));`,x,y); }

// sender nodes
function makeSenderNode(wf, channel, x, y, compat, demo){
  const friendly = channel.toUpperCase();
  if(compat==='full'){
    if(channel==='email'){
      return addNode(wf,{ id:uid("email"), name: demo?"[Send  Email] (Demo)":"[Send  Email]", type:"n8n-nodes-base.emailSend", typeVersion:3, position:pos(x,y),
        parameters:{ to: demo?"={{$json.emailTo}}":"={{$json.emailTo || 'user@example.com'}}", subject:"={{$json.msg?.email?.subject || $json.scenario?.agent_name || 'Update'}}", text:"={{$json.message || $json.msg?.email?.body || 'Hello!'}}" }, credentials:{} });
    }
    if(channel==='sms'){
      return addNode(wf,{ id:uid("sms"), name: demo?"[Send  SMS] (Demo)":"[Send  SMS] (Twilio)", type:"n8n-nodes-base.twilio", typeVersion:3, position:pos(x,y),
        parameters:{ resource:"message", operation:"create", from:"={{$json.smsFrom || '+10000000000'}}", to:"={{$json.to || '+10000000001'}}", message:"={{$json.message || $json.msg?.sms?.body || 'Hello!'}}" }, credentials:{} });
    }
    if(channel==='whatsapp'){
      return addNode(wf,{ id:uid("wa"), name: demo?"[Send  WhatsApp] (Demo)":"[Send  WhatsApp] (Twilio)", type:"n8n-nodes-base.twilio", typeVersion:3, position:pos(x,y),
        parameters:{ resource:"message", operation:"create", from:"={{'whatsapp:' + ($json.waFrom || '+10000000002')}}", to:"={{'whatsapp:' + ($json.to || '+10000000003')}}", message:"={{$json.message || $json.msg?.whatsapp?.body || 'Hello!'}}" }, credentials:{} });
    }
    if(channel==='call'){
      return addHTTP(wf, demo?"[Place Call] (Demo)":"[Place Call]", "={{$json.callWebhook || 'https://example.com/call'}}",
        "={{ { to:$json.to, from:$json.callFrom, text: ($json.message || $json.msg?.call?.script || 'Hello!') } }}", x, y, "POST");
    }
  }
  return addFunction(wf, `Demo Send ${friendly}`, "return [$json];", x, y);
}

// ---------- sanitization ----------
function sanitizeWorkflow(wf){
  const REQUIRED_TYPE="n8n-nodes-base.function";
  const byName=new Map();

  // Do NOT rename nodes here (keeps connections valid)
  wf.nodes=(wf.nodes||[]).map((n,idx)=>{
    if(!n.name||typeof n.name!=='string') n.name=`Node ${idx+1}`; // should not happen thanks to uniqueName
    if(!n.type||typeof n.type!=='string'||!n.type.trim()){ n.type=REQUIRED_TYPE; n.typeVersion=1; n.parameters={ functionCode:"return [$json];" }; }
    if(typeof n.typeVersion!=='number') n.typeVersion=1;
    if(!Array.isArray(n.position)||n.position.length!==2){ n.position=[-1000, 300+(idx*40)]; }
    if(!n.parameters||typeof n.parameters!=='object') n.parameters={};
    // ensure function nodes have code
    if(n.type==="n8n-nodes-base.function" && !n.parameters.functionCode){
      n.parameters.functionCode = "return [$json];";
    }
    byName.set(n.name,n); return n;
  });

  // prune invalid links; keep existing keys (names) untouched
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
    makeDesignerPrompt(row),
    `{"archetype":string,"trigger":"cron|webhook|imap|manual","channels":string[],"branches":[{"name":string,"condition":string,"steps":[{"name":string,"kind":string,"outcomes"?:Array}]}],"errors":[{"name":string,"mitigation":string}],"systems":string[]}`
  );
}
function makeMessages(row, archetype, channels){
  return openaiJSON(
    makeMessagingPrompt(row, archetype, channels),
    `{"email":{"subject":string,"body":string},"sms":{"body":string},"whatsapp":{"body":string},"call":{"script":string}}`
  );
}

// ---------- Canonical chronological flow for Appointment Scheduling ----------
function buildCanonicalSchedulingBranches(channelsIn){
  const desired = ['call','sms','whatsapp','email'];
  const channels = desired.filter(c=>channelsIn.includes(c)).concat(channelsIn.filter(c=>!desired.includes(c)));

  const steps = [
    { name:"Lookup: Upcoming Appointments (PMS/CRM)", kind:"lookup" },
    { name:"Decision: Do we have an upcoming appointment for this contact?", kind:"decision",
      outcomes:[
        { value:"yes_upcoming",
          steps:[
            { name:"Compose: Confirmation message with business address & reason", kind:"compose" },
            { name:"Book: Confirm in Calendar", kind:"book" },
            { name:"Notify: Reminder 2h before appointment", kind:"notify" },
            { name:"Update: CRM visit status → Confirmed", kind:"update" },
          ]
        },
        { value:"no_or_cannot_attend",
          steps:[
            { name:"Lookup: Next available time slots", kind:"lookup" },
            { name:"Compose: Offer reschedule options (3 choices)", kind:"compose" },
            { name:"Decision: Client chose a new slot?", kind:"decision",
              outcomes:[
                { value:"reschedule_yes",
                  steps:[
                    { name:"Book: New slot in Calendar", kind:"book" },
                    { name:"Compose: New confirmation with date/time/address/reason", kind:"compose" },
                    { name:"Notify: Reminder 2h before new appointment", kind:"notify" },
                    { name:"Update: CRM visit status → Rescheduled", kind:"update" },
                  ]
                },
                { value:"reschedule_no",
                  steps:[
                    { name:"Store: Add to follow-up list", kind:"store" },
                    { name:"Update: CRM visit status → Follow-up", kind:"update" },
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    { name:"Store: Audit trail & timeline event", kind:"store" }
  ];

  return {
    channels,
    branches: [{ name:"Scheduling", condition:"All scheduling cases", steps }]
  };
}

// ---------- core build ----------
async function buildWorkflowFromRow(row, opts){
  const compat=(opts.compat||'safe')==='full'?'full':'safe';
  const includeDemo=opts.includeDemo!==false;

  const channels=[]; const shapes=listify(row.best_reply_shapes);
  for(const sh of shapes){ for(const norm of CHANNEL_NORMALIZE){ if(norm.rx.test(sh) && !channels.includes(norm.k)) channels.push(norm.k); } }
  if(!channels.length) channels.push('email');

  let archetype=chooseArchetype(row);
  let prodTrigger=TRIGGER_PREF[archetype]||'manual';

  const design=(await makeDesigner(row))||{};
  if(Array.isArray(design.channels)&&design.channels.length){
    const allowed=['email','sms','whatsapp','call'];
    const llmCh=design.channels.map(c=>String(c).toLowerCase()).filter(c=>allowed.includes(c));
    if(llmCh.length){ channels.splice(0,channels.length,...llmCh); }
  }
  if(typeof design.trigger==='string' && ['cron','webhook','imap','manual'].includes(design.trigger?.toLowerCase?.())){
    prodTrigger=design.trigger.toLowerCase();
  }
  if(typeof design.archetype==='string' && design.archetype.trim()){
    archetype=design.archetype.trim().toUpperCase();
  }
  let systems=Array.isArray(design.systems)?design.systems.map(s=>String(s).toLowerCase()):[];
  let branches=Array.isArray(design.branches)?design.branches:[];

  if(archetype==='APPOINTMENT_SCHEDULING'){
    const sparse = !branches.length || !branches.some(b=>Array.isArray(b.steps)&&b.steps.length);
    if(sparse){
      const built = buildCanonicalSchedulingBranches(channels);
      branches = built.branches;
      const wanted = built.channels;
      channels.splice(0, channels.length, ...wanted);
      if(!systems.includes('calendar')) systems.push('calendar');
      if(!systems.includes('crm')) systems.push('crm');
      if(!systems.includes('pms')) systems.push('pms');
      if(!systems.includes('email')) systems.push('email');
      if(!systems.includes('twilio')) systems.push('twilio');
    }
  }

  const errors=Array.isArray(design.errors)?design.errors:[];
  const msg=(await makeMessages(row, archetype, channels))||{};

  const title=`${row.scenario_id||'Scenario'} — ${row.name||''}`.trim();
  const wf=baseWorkflow(title);

  // lane builder (prod/demo)
  function buildLane({ laneLabel, yOffset, triggerKind, isDemo }){
    withYOffset(wf, yOffset, () => {
      addHeader(wf, `${ZONE.FLOW} · ${laneLabel}`, isDemo?LAYOUT.demoHeader.x:LAYOUT.prodHeader.x, isDemo?LAYOUT.demoHeader.y:LAYOUT.prodHeader.y);

      let trig;
      if(isDemo) trig = addManual(wf, LAYOUT.demoStart.x, LAYOUT.demoStart.y, "Demo Manual Trigger");
      else {
        if (triggerKind==='cron') trig = addCron(wf, "Cron (from LLM)", LAYOUT.prodStart.x, LAYOUT.prodStart.y - 160, compat);
        else if (triggerKind==='webhook') trig = addWebhook(wf, "Webhook (from LLM)", LAYOUT.prodStart.x, LAYOUT.prodStart.y, compat);
        else if (triggerKind==='imap') trig = addFunction(wf, "IMAP Intake (Placeholder)", "return [$json];", LAYOUT.prodStart.x, LAYOUT.prodStart.y);
        else trig = addManual(wf, LAYOUT.prodStart.x, LAYOUT.prodStart.y, "Manual Trigger");
      }

      const init = addFunction(wf, isDemo ? "Init Demo Context" : "Init Context (PROD)", `
const seed=${JSON.stringify(DEMO)};
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
return [${isDemo ? "{...seed, scenario, channels, systems, msg, demo:true}" : "{...$json, scenario, channels, systems, msg}"}];`,
        (isDemo?LAYOUT.demoStart.x:LAYOUT.prodStart.x)+LAYOUT.stepX, LAYOUT.prodStart.y);
      connect(wf, trig, init);

      let cursor = init;
      if(!isDemo && systems.includes('pms')){
        const fetch = addHTTP(wf, "Fetch Upcoming (PMS)", `={{'${DEFAULT_HTTP.pms_upcoming}'}}`, "={{$json}}", LAYOUT.prodStart.x + 2*LAYOUT.stepX, LAYOUT.prodStart.y);
        connect(wf, cursor, fetch); cursor = fetch;
      }

      const sw = addSwitch(wf, "Branch (LLM/Canonical)", "={{$json.__branch || 'main'}}",
        (branches.length?branches:[{name:"main"}]).map(b=>({operation:'equal', value2:String(b.name||'main').slice(0,48)})),
        LAYOUT.switchX, LAYOUT.prodStart.y);
      connect(wf, cursor, sw);

      // VERTICAL CHANNELS PER BRANCH with DECISION support (extra spacing)
      let lastCollectorOfLastBranch = null;
      const baseBranchY = LAYOUT.prodStart.y - Math.floor(LAYOUT.branchY * (Math.max(branches.length,1)-1)/2);

      (branches.length?branches:[{name:"main",steps:[]}]).forEach((b, bIdx)=>{
        const branchTopY = baseBranchY + bIdx*LAYOUT.branchY;
        const chCount = Math.max(channels.length,1);
        const firstChY = branchTopY - Math.floor(LAYOUT.channelY * (chCount-1)/2);

        let prevChannelCollector = null;

        channels.forEach((ch, chIdx)=>{
          const rowY = firstChY + chIdx*LAYOUT.channelY;

          let stepNo=0;
          const enterName = GUIDE.numberSteps
            ? `[${++stepNo}] Enter: ${b.name||'Case'} · ${ch.toUpperCase()}`
            : `Enter: ${b.name||'Case'} · ${ch.toUpperCase()}`;
          const enter = addFunction(wf, enterName,
            `return [{...$json,__branch:${JSON.stringify(b.name||'case')},__cond:${JSON.stringify(b.condition||'')},__channel:${JSON.stringify(ch)}}];`,
            LAYOUT.prodStart.x + 4*LAYOUT.stepX, rowY);

          if (chIdx === 0) connect(wf, sw, enter, bIdx);
          if (prevChannelCollector) connect(wf, prevChannelCollector, enter);

          const steps = Array.isArray(b.steps)?b.steps:[];
          let prev = enter;

          for (let k=0; k<steps.length; k++){
            const st = steps[k];
            const x = LAYOUT.prodStart.x + (5+k)*LAYOUT.stepX;
            const title = GUIDE.numberSteps ? `[${++stepNo}] ${st.name||'Step'}` : (st.name||'Step');
            const kind=String(st.kind||'').toLowerCase();

            if(kind==='decision' && Array.isArray(st.outcomes) && st.outcomes.length){
              // Decision: fan out lanes per outcome with more vertical spacing
              const rulz = st.outcomes.map(o=>({operation:'equal', value2:String(o.value||'outcome').slice(0,64)}));
              const dSwitch = addSwitch(wf, `${title} (Decision)`, "={{$json.__decision || 'default'}}", rulz, x, rowY);
              connect(wf, prev, dSwitch);

              let lastOutcomeCollector = null;
              st.outcomes.forEach((o, oIdx)=>{
                const oy = rowY - (Math.floor((st.outcomes.length-1)/2)*LAYOUT.outcomeRowY) + (oIdx*LAYOUT.outcomeRowY);
                const oEnter = addFunction(wf, `[${stepNo}.${oIdx+1}] Outcome: ${o.value||'path'}`,
                  `return [{...$json,__decision:${JSON.stringify(String(o.value||'path'))}}];`,
                  x + Math.floor(LAYOUT.stepX*0.6), oy);
                connect(wf, dSwitch, oEnter, oIdx);

                let oPrev = oEnter;
                const oSteps = Array.isArray(o.steps)?o.steps:[];
                oSteps.forEach((os, ok)=>{
                  const ox = x + (ok+1)*Math.floor(LAYOUT.stepX*0.85);
                  const ot = `[${stepNo}.${oIdx+1}.${ok+1}] ${os.name||'Step'}`;
                  const okind = String(os.kind||'').toLowerCase();
                  let node;
                  if(okind==='compose'){
                    node = addFunction(wf, ot, `
const ch=${JSON.stringify(ch)};
const m=$json.msg||{};
const bodies={ email:(m.email?.body)||'', sms:(m.sms?.body)||'', whatsapp:(m.whatsapp?.body)||'', call:(m.call?.script)||''};
return [{...$json, message:bodies[ch] || bodies.email || 'Hello!'}];`, ox, oy);
                  } else if(['http','update','store','notify','route','lookup'].includes(okind)){
                    node = addHTTP(wf, ot, "={{'https://example.com/step'}}", "={{$json}}", ox, oy);
                  } else if(okind==='book'){
                    node = addHTTP(wf, ot, `={{'${DEFAULT_HTTP.calendar_book}'}}`, "={{$json}}", ox, oy);
                  } else if(okind==='ticket'){
                    node = addHTTP(wf, ot, `={{'${DEFAULT_HTTP.ticket_create}'}}`, "={{$json}}", ox, oy);
                  } else if(okind==='wait'){
                    node = addFunction(wf, ot, "return [$json];", ox, oy);
                  } else {
                    node = addFunction(wf, ot, "return [$json];", ox, oy);
                  }
                  connect(wf, oPrev, node);
                  oPrev = node;
                });

                // Sender & collector for this outcome
                const sendX = x + Math.floor(LAYOUT.stepX*0.85) + (Math.max(oSteps.length,0)+1)*Math.floor(LAYOUT.stepX*0.85);
                const sender = makeSenderNode(wf, ch, sendX, oy, compat, isDemo);
                try{ wf.nodes[wf.nodes.findIndex(n=>n.name===sender)].name = `[${stepNo}.${oIdx+1}] Send: ${ch.toUpperCase()}`; }catch{}
                connect(wf, oPrev, sender);

                const oCollector = addCollector(wf, sendX + Math.floor(LAYOUT.stepX*0.7), oy);
                connect(wf, sender, oCollector);

                if (lastOutcomeCollector) connect(wf, lastOutcomeCollector, oCollector);
                lastOutcomeCollector = oCollector;
              });

              prev = lastOutcomeCollector; // continue after decision fan-in
              continue;
            }

            // Non-decision step
            let node;
            if(kind==='compose'){
              node = addFunction(wf, title, `
const ch=${JSON.stringify(ch)};
const m=$json||{};
const msg=$json.msg||{};
const bodies={ email:(msg.email?.body)||'', sms:(msg.sms?.body)||'', whatsapp:(msg.whatsapp?.body)||'', call:(msg.call?.script)||''};
return [{...m, message:bodies[ch] || bodies.email || 'Hello!'}];`, x, rowY);
            } else if(['http','update','store','notify','route','lookup'].includes(kind)){
              node = addHTTP(wf, title, "={{'https://example.com/step'}}", "={{$json}}", x, rowY);
            } else if(kind==='book'){
              node = addHTTP(wf, title, `={{'${DEFAULT_HTTP.calendar_book}'}}`, "={{$json}}", x, rowY);
            } else if(kind==='ticket'){
              node = addHTTP(wf, title, `={{'${DEFAULT_HTTP.ticket_create}'}}`, "={{$json}}", x, rowY);
            } else if(kind==='wait'){
              node = addFunction(wf, title, "return [$json];", x, rowY);
            } else{
              node = addFunction(wf, title, "return [$json];", x, rowY);
            }
            connect(wf, prev, node);
            prev = node;
          }

          // Send + collect when last step was NOT a decision
          const lastIsDecision = steps.some(s=>String(s.kind||'').toLowerCase()==='decision');
          if(!lastIsDecision){
            const sendX = LAYOUT.prodStart.x + (5 + steps.length)*LAYOUT.stepX;
            const sendTitle = GUIDE.numberSteps ? `[${++stepNo}] Send: ${ch.toUpperCase()}` : `Send: ${ch.toUpperCase()}`;
            const sender = makeSenderNode(wf, ch, sendX, rowY, compat, isDemo);
            try{ wf.nodes[wf.nodes.findIndex(n=>n.name===sender)].name = sendTitle; }catch{}
            connect(wf, prev, sender);
            const collector = addCollector(wf, sendX + LAYOUT.stepX, rowY);
            connect(wf, sender, collector);
            if (prevChannelCollector) connect(wf, prevChannelCollector, collector);
            prevChannelCollector = collector;
          }

          if (bIdx === (Math.max(branches.length,1)-1) && chIdx === (chCount-1)) {
            lastCollectorOfLastBranch = prevChannelCollector;
          }
        });
      });

      if(Array.isArray(errors) && errors.length && lastCollectorOfLastBranch){
        const bottomOfBranches = baseBranchY + (Math.max(branches.length,1)-1)*LAYOUT.branchY;
        const errY = bottomOfBranches + LAYOUT.errorRowYPad;

        // Error “orange band”
        addHeader(wf, `${ZONE.ERR} · ${laneLabel}`, LAYOUT.prodStart.x + 3*LAYOUT.stepX, errY - 120);

        let prev = addFunction(wf, "Error Monitor (LLM List)", "return [$json];", LAYOUT.prodStart.x + 4*LAYOUT.stepX, errY);
        connect(wf, lastCollectorOfLastBranch, prev);
        errors.forEach((e,i)=>{
          const fix = addFunction(wf, GUIDE.numberSteps?`[E${i+1}] ${e.name||'Error'}`:(e.name||'Error'),
            `// ${e.mitigation||''}\nreturn [$json];`, LAYOUT.prodStart.x + (5+i)*LAYOUT.stepX, errY);
          connect(wf, prev, fix);
          prev = fix;
        });
        const fin = addCollector(wf, LAYOUT.prodStart.x + (6 + errors.length)*LAYOUT.stepX, errY);
        connect(wf, prev, fin);
      }
    });
  }

  // build lanes
  buildLane({ laneLabel:"PRODUCTION LANE", yOffset:0, triggerKind:prodTrigger, isDemo:false });
  if(includeDemo){
    buildLane({ laneLabel:"DEMO LANE (Manual Trigger + Seeded Contacts)", yOffset:LAYOUT.laneGap, triggerKind:'manual', isDemo:true });
  }

  wf.staticData=wf.staticData||{};
  wf.staticData.__design={
    archetype, prodTrigger, channels, systems, branches, errors,
    guide: GUIDE,
    layout: { verticalChannels: true, decisions: "switch+lanes", spacing: LAYOUT },
    zones: ZONE
  };

  return sanitizeWorkflow(wf);
}

// ---------- HTTP handler (unchanged signature) ----------
module.exports = async (req,res)=>{
  Object.entries(HEADERS).forEach(([k,v])=>res.setHeader(k,v));
  if(req.method==="OPTIONS") return res.status(204).end();

  try{
    if(req.method!=="POST"){
      return res.status(200).json({ ok:true, usage:'POST {"scenario_id":"<id>", "compat":"safe|full", "includeDemo": true }' });
    }
    const body=await new Promise(resolve=>{
      const chunks=[]; req.on("data",c=>chunks.push(c)); req.on("end",()=>{ try{ resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }catch{ resolve({}); } });
    });
    const wanted=(body.scenario_id||"").toString().trim(); if(!wanted) throw new Error("Missing scenario_id");
    const compat=(body.compat||'safe').toLowerCase()==='full'?'full':'safe';
    const includeDemo=body.includeDemo!==false;

    const row=await fetchSheetRowByScenarioId(wanted);
    if(!row) return res.status(404).json({ ok:false, error:`scenario_id not found: ${wanted}` });

    const wf=await buildWorkflowFromRow(row,{ compat, includeDemo });

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
