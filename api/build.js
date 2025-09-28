// api/build.js
// Single-channel, strictly chronological, fully linked A→Z.
// "Communication (Stage)" sits BEFORE the channel flow.
// Collectors are used as *data gates* right after steps that produce/need data,
// so the chain reads: Step → Collector (if needed) → Next Step … → Send → End.
// No demo lane. No junction nodes.
// Uses conservative n8n node versions (all nodes have link handles).
// Env: SHEET_ID, GOOGLE_API_KEY, SHEET_TAB?=Scenarios, OPENAI_API_KEY

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

// ====== Layout (spacious) ======
const LAYOUT = {
  stepX: 720,       // horizontal spacing
  branchY: 820,     // (kept for future multi-branches)
  channelY: 520,
  outcomeRowY: 380,
  prodHeader: { x: -1700, y: 40 },
  prodStart:  { x: -1560, y: 300 },
  switchX: -760,
  errorRowYPad: 760,
};

const GUIDE = { showWaypoints: false, numberSteps: true };
const ZONE  = { FLOW: "FLOW AREA", ERR: "ERROR AREA" };

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

const ALLOWED_CHANNELS = ['email','sms','whatsapp','call'];
function normalizeChannel(v){
  if(!v) return null;
  const s = String(v).toLowerCase().trim();
  return ALLOWED_CHANNELS.includes(s) ? s : null;
}

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

// ---------- Collector policy helpers ----------
function requiresCollector(kind, name=''){
  const k = String(kind||'').toLowerCase();
  const n = String(name||'').toLowerCase();
  if (['lookup','http','score','wait'].includes(k)) return true;   // fetch/compute -> data gate
  if (k==='book' || k==='ticket') return true;                     // returns confirmation payload
  if (['store','update','route','notify','compose'].includes(k)) return false;
  return false; // unknown kinds keep graph light
}
function collectorPosX(x){ return x + Math.floor(LAYOUT.stepX * 0.35); }

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
          {role:"system",content:"You are an expert workflow designer for n8n. Enumerate outcomes exhaustively. Always return valid JSON."},
          {role:"user",content:prompt+(schemaHint?("\n\nSchema:\n"+schemaHint):"")}
        ]
      })
    });
    const j=await r.json(); const txt=j.choices?.[0]?.message?.content?.trim(); if(!txt) return null;
    try{ return JSON.parse(txt); }catch{ return null; }
  }catch{ return null; }
}

function makeDesignerPrompt(row, forcedChannel){
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
    `FORCED_CHANNEL: ${forcedChannel||'(none)'}`,
  ].join("\n");
  return `
Design a bullet-proof, strictly chronological n8n workflow. We will auto-insert a
"Communication (Stage)" node right before the per-channel flow. Do NOT output any
junction/merge/placeholder nodes—only steps & decisions.

If FORCED_CHANNEL is provided, assume ONLY that channel is used for all comms.
Tailor steps and content (e.g., call vs sms).

Rules:
- "trigger": one of ["cron","webhook","imap","manual"].
- "channels": ordered subset of ["email","sms","whatsapp","call"]. If FORCED_CHANNEL is set, use [FORCED_CHANNEL].
- "branches": ≤6. Each branch is a high-level path.
- Step kinds: "compose" | "http" | "update" | "route" | "wait" | "score" | "lookup" | "book" | "ticket" | "notify" | "store" | "decision".
- A "decision" step MUST include exhaustive "outcomes". Each outcome: { "value": string, "steps": Step[] }.
- Preserve strict left-to-right chronological order.

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
Write concise outreach content ONLY for ${JSON.stringify(channels)} for archetype ${archetype}.
No IVR "press 1". 3–6 short lines each.

Return JSON (omit unused channels): { "email": { "subject":"...", "body":"..." }, "sms": {"body":"..."}, "whatsapp":{"body":"..."}, "call":{"script":"..."} }

Context:
${ctx}`;
}

// ---------- workflow primitives ----------
function baseWorkflow(name){ return { name, nodes:[], connections:{}, active:false, settings:{}, staticData:{}, __yOffset:0 }; }

function uniqueName(wf, base){
  const existing = new Set((wf.nodes||[]).map(n=>String(n.name||'').toLowerCase()));
  if(!base || typeof base!=='string') base = 'Node';
  let name = base, i = 1;
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
    node.position=[x, nudgeIfOverlapping(wf, x, y)];
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
function makeSenderNode(wf, channel, x, y, compat){
  const friendly = channel.toUpperCase();
  if(compat==='full'){
    if(channel==='email'){
      return addNode(wf,{ id:uid("email"), name:"[Send  Email]", type:"n8n-nodes-base.emailSend", typeVersion:3, position:pos(x,y),
        parameters:{ to:"={{$json.emailTo || 'user@example.com'}}", subject:"={{$json.msg?.email?.subject || $json.scenario?.agent_name || 'Update'}}", text:"={{$json.message || $json.msg?.email?.body || 'Hello!'}}" }, credentials:{} });
    }
    if(channel==='sms'){
      return addNode(wf,{ id:uid("sms"), name:"[Send  SMS] (Twilio)", type:"n8n-nodes-base.twilio", typeVersion:3, position:pos(x,y),
        parameters:{ resource:"message", operation:"create", from:"={{$json.smsFrom || '+10000000000'}}", to:"={{$json.to || '+10000000001'}}", message:"={{$json.message || $json.msg?.sms?.body || 'Hello!'}}" }, credentials:{} });
    }
    if(channel==='whatsapp'){
      return addNode(wf,{ id:uid("wa"), name:"[Send  WhatsApp] (Twilio)", type:"n8n-nodes-base.twilio", typeVersion:3, position:pos(x,y),
        parameters:{ resource:"message", operation:"create", from:"={{'whatsapp:' + ($json.waFrom || '+10000000002')}}", to:"={{'whatsapp:' + ($json.to || '+10000000003')}}", message:"={{$json.message || $json.msg?.whatsapp?.body || 'Hello!'}}" }, credentials:{} });
    }
    if(channel==='call'){
      return addHTTP(wf, "[Place Call]", "={{$json.callWebhook || 'https://example.com/call'}}",
        "={{ { to:$json.to, from:$json.callFrom, text: ($json.message || $json.msg?.call?.script || 'Hello!') } }}", x, y, "POST");
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
function makeDesigner(row, forcedChannel){
  return openaiJSON(
    makeDesignerPrompt(row, forcedChannel),
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
  const channels = Array.isArray(channelsIn)&&channelsIn.length ? [channelsIn[0]] : ['email'];
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
  return { channels, branches: [{ name:"Scheduling", condition:"All scheduling cases", steps }] };
}

// ---------- core build ----------
async function buildWorkflowFromRow(row, opts){
  const compat=(opts.compat||'safe')==='full'?'full':'safe';
  const uiSelected = normalizeChannel(opts?.channel || opts?.selectedChannel);

  // channels from best_reply_shapes (default)
  const channelsFromSheet=[]; const shapes=listify(row.best_reply_shapes);
  for(const sh of shapes){ for(const norm of CHANNEL_NORMALIZE){ if(norm.rx.test(sh) && !channelsFromSheet.includes(norm.k)) channelsFromSheet.push(norm.k); } }
  if(!channelsFromSheet.length) channelsFromSheet.push('email');

  // Start with a single channel; let UI override
  let channels = [channelsFromSheet[0]];
  if (uiSelected) channels = [uiSelected];

  // choose archetype/trigger
  let archetype=chooseArchetype(row);
  let prodTrigger=TRIGGER_PREF[archetype]||'manual';

  // LLM design + messages (hint: forced channel)
  const design=(await makeDesigner(row, uiSelected || channels[0]))||{};
  if(typeof design.trigger==='string' && ['cron','webhook','imap','manual'].includes(design.trigger?.toLowerCase?.())){
    prodTrigger=design.trigger.toLowerCase();
  }
  if(typeof design.archetype==='string' && design.archetype.trim()){
    archetype=design.archetype.trim().toUpperCase();
  }
  let systems=Array.isArray(design.systems)?design.systems.map(s=>String(s).toLowerCase()):[];
  let branches=Array.isArray(design.branches)?design.branches:[];

  // UI wins last for channel
  channels = [ uiSelected || (Array.isArray(design.channels)&&design.channels[0] ? String(design.channels[0]).toLowerCase() : channels[0]) ]
            .filter(c=>ALLOWED_CHANNELS.includes(c));
  if(!channels.length) channels=['email'];

  // Fallback for Appointment Scheduling if LLM sparse
  if(archetype==='APPOINTMENT_SCHEDULING'){
    const sparse = !branches.length || !branches.some(b=>Array.isArray(b.steps)&&b.steps.length);
    if(sparse){
      const built = buildCanonicalSchedulingBranches(channels);
      branches = built.branches;
      channels = built.channels;
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

  // build single PROD lane
  function buildLane({ laneLabel, yOffset, triggerKind }){
    withYOffset(wf, yOffset, () => {
      addHeader(wf, `${ZONE.FLOW} · ${laneLabel}`, LAYOUT.prodHeader.x, LAYOUT.prodHeader.y);

      let trig;
      if (triggerKind==='cron') trig = addCron(wf, "Cron (from LLM)", LAYOUT.prodStart.x, LAYOUT.prodStart.y - 160, compat);
      else if (triggerKind==='webhook') trig = addWebhook(wf, "Webhook (from LLM)", LAYOUT.prodStart.x, LAYOUT.prodStart.y, compat);
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

      let cursor = init;
      if(systems.includes('pms')){
        const fetch = addHTTP(wf, "Fetch Upcoming (PMS)", `={{'${DEFAULT_HTTP.pms_upcoming}'}}`, "={{$json}}", LAYOUT.prodStart.x + 2*LAYOUT.stepX, LAYOUT.prodStart.y);
        connect(wf, cursor, fetch); cursor = fetch;

        // data gate after fetch
        const g = addCollector(wf, collectorPosX(LAYOUT.prodStart.x + 2*LAYOUT.stepX), LAYOUT.prodStart.y);
        connect(wf, fetch, g);
        cursor = g;
      }

      const branchesArr = (branches.length?branches:[{name:"main", steps:[]}] );
      const sw = addSwitch(wf, "Branch (LLM/Canonical)", "={{$json.__branch || 'main'}}",
        branchesArr.map(b=>({operation:'equal', value2:String(b.name||'main').slice(0,48)})),
        LAYOUT.switchX, LAYOUT.prodStart.y);
      connect(wf, cursor, sw);

      const baseBranchY = LAYOUT.prodStart.y - Math.floor(LAYOUT.branchY * (Math.max(branchesArr.length,1)-1)/2);
      let lastCollectorOfLastBranch = null;

      branchesArr.forEach((b, bIdx)=>{
        const branchY = baseBranchY + bIdx*LAYOUT.branchY;
        const ch = channels[0]; // single channel

        // Communication hub before the channel
        const commHubX = LAYOUT.prodStart.x + Math.floor(3.6*LAYOUT.stepX);
        const commHub = addFunction(wf, "Communication (Stage)", "return [$json];", commHubX, branchY);
        connect(wf, sw, commHub, bIdx);

        // Channel entry
        let stepNo=0;
        const enterName = GUIDE.numberSteps
          ? `[${++stepNo}] Enter: ${b.name||'Case'} · ${ch.toUpperCase()}`
          : `Enter: ${b.name||'Case'} · ${ch.toUpperCase()}`;
        const enter = addFunction(wf, enterName,
          `return [{...$json,__branch:${JSON.stringify(b.name||'case')},__cond:${JSON.stringify(b.condition||'')},__channel:${JSON.stringify(ch)}}];`,
          LAYOUT.prodStart.x + 4*LAYOUT.stepX, branchY);
        connect(wf, commHub, enter);

        const steps = Array.isArray(b.steps)?b.steps:[];
        let prev = enter;

        for (let k=0; k<steps.length; k++){
          const st = steps[k];
          const x = LAYOUT.prodStart.x + (5+k)*LAYOUT.stepX;
          const title = GUIDE.numberSteps ? `[${++stepNo}] ${st.name||'Step'}` : (st.name||'Step');
          const kind=String(st.kind||'').toLowerCase();

          if(kind==='decision' && Array.isArray(st.outcomes) && st.outcomes.length){
            const rulz = st.outcomes.map(o=>({operation:'equal', value2:String(o.value||'outcome').slice(0,64)}));
            const dSwitch = addSwitch(wf, `${title} (Decision)`, "={{$json.__decision || 'default'}}", rulz, x, branchY);
            connect(wf, prev, dSwitch);

            let chainCollector = null;

            st.outcomes.forEach((o, oIdx)=>{
              const outcomeValue = String(o.value||'path');
              const oy = branchY - (Math.floor((st.outcomes.length-1)/2)*LAYOUT.outcomeRowY) + (oIdx*LAYOUT.outcomeRowY);

              const oEnter = addFunction(wf, `[${stepNo}.${oIdx+1}] Outcome: ${outcomeValue}`,
                `return [{...$json,__decision:${JSON.stringify(outcomeValue)}}];`,
                x + Math.floor(LAYOUT.stepX*0.6), oy);
              connect(wf, dSwitch, oEnter, oIdx);

              let oPrev = oEnter;
              const oSteps = Array.isArray(o.steps)?o.steps:[];
              oSteps.forEach((os, ok)=>{
                const ox = x + (ok+1)*Math.floor(LAYOUT.stepX*1.05);
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
                } else {
                  node = addFunction(wf, ot, "return [$json];", ox, oy);
                }
                connect(wf, oPrev, node);

                // Data gate after steps that produce/need data
                if (requiresCollector(okind, os.name)) {
                  const oc = addCollector(wf, collectorPosX(ox), oy);
                  connect(wf, node, oc);
                  oPrev = oc;
                } else {
                  oPrev = node;
                }
              });

              // Sender (terminal per outcome path)
              const sendX = x + Math.floor(LAYOUT.stepX*1.1) + (Math.max(oSteps.length,0)+1)*Math.floor(LAYOUT.stepX*1.05);
              const sender = makeSenderNode(wf, ch, sendX, oy, compat);
              try{ wf.nodes[wf.nodes.findIndex(n=>n.name===sender)].name = `[${stepNo}.${oIdx+1}] Send: ${ch.toUpperCase()}`; }catch{}
              connect(wf, oPrev, sender);

              // End marker after send (makes terminal explicit)
              const end = addFunction(wf, "End (Terminal)", "return [$json];", sendX + Math.floor(LAYOUT.stepX*0.35), oy);
              connect(wf, sender, end);

              if(chainCollector) connect(wf, chainCollector, end);
              chainCollector = end;

              if (oIdx === st.outcomes.length-1){
                prev = chainCollector;
              }
            });
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
return [{...m, message:bodies[ch] || bodies.email || 'Hello!'}];`, x, branchY);
          } else if(['http','update','store','notify','route','lookup'].includes(kind)){
            node = addHTTP(wf, title, "={{'https://example.com/step'}}", "={{$json}}", x, branchY);
          } else if(kind==='book'){
            node = addHTTP(wf, title, `={{'${DEFAULT_HTTP.calendar_book}'}}`, "={{$json}}", x, branchY);
          } else if(kind==='ticket'){
            node = addHTTP(wf, title, `={{'${DEFAULT_HTTP.ticket_create}'}}`, "={{$json}}", x, branchY);
          } else{
            node = addFunction(wf, title, "return [$json];", x, branchY);
          }
          connect(wf, prev, node);

          // Data gate if needed
          if (requiresCollector(kind, st.name)) {
            const coll = addCollector(wf, collectorPosX(x), branchY);
            connect(wf, node, coll);
            prev = coll;
          } else {
            prev = node;
          }
        }

        // If last step wasn't a decision, send + end (terminal)
        const lastIsDecision = steps.some(s=>String(s.kind||'').toLowerCase()==='decision');
        let lastTerminal = null;
        if(!lastIsDecision){
          const sendX = LAYOUT.prodStart.x + (5 + steps.length)*LAYOUT.stepX + Math.floor(LAYOUT.stepX*0.4);
          const sendTitle = GUIDE.numberSteps ? `[${++stepNo}] Send: ${ch.toUpperCase()}` : `Send: ${ch.toUpperCase()}`;
          const sender = makeSenderNode(wf, ch, sendX, branchY, compat);
          try{ wf.nodes[wf.nodes.findIndex(n=>n.name===sender)].name = sendTitle; }catch{}
          connect(wf, prev, sender);

          const end = addFunction(wf, "End (Terminal)", "return [$json];", sendX + Math.floor(LAYOUT.stepX*0.35), branchY);
          connect(wf, sender, end);
          lastTerminal = end;
        } else {
          lastTerminal = prev; // came from chainCollector
        }

        lastCollectorOfLastBranch = lastTerminal;
      });

      if(Array.isArray(errors) && errors.length && lastCollectorOfLastBranch){
        const errY = LAYOUT.prodStart.y + LAYOUT.errorRowYPad;

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

  buildLane({ laneLabel:"PRODUCTION LANE", yOffset:0, triggerKind:prodTrigger });

  wf.staticData=wf.staticData||{};
  wf.staticData.__design={
    archetype, prodTrigger, channels, systems, branches, errors,
    selectedChannel: channels[0],
    guide: GUIDE,
    layout: { verticalChannels: true, decisions: "switch+lanes", spacing: LAYOUT, antiOverlap: true, commHub: true, collectors: "data-gates" },
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
      return res.status(200).json({ ok:true, usage:'POST {"scenario_id":"<id>", "compat":"safe|full", "channel":"email|sms|whatsapp|call"}' });
    }
    const body=await new Promise(resolve=>{
      const chunks=[]; req.on("data",c=>chunks.push(c)); req.on("end",()=>{ try{ resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }catch{ resolve({}); } });
    });
    const wanted=(body.scenario_id||"").toString().trim(); if(!wanted) throw new Error("Missing scenario_id");
    const compat=(body.compat||'safe').toLowerCase()==='full'?'full':'safe';
    const selectedChannel = body.channel || body.selectedChannel || null;

    const row=await fetchSheetRowByScenarioId(wanted);
    if(!row) return res.status(404).json({ ok:false, error:`scenario_id not found: ${wanted}` });

    const wf=await buildWorkflowFromRow(row,{ compat, channel: selectedChannel });

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
