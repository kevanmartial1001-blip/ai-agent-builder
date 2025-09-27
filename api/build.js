// api/build.js
// Deep per-scenario builder with: wide layout, mirrored demo lane, numbered steps,
// and visual "➡️" waypoints to guide reading order.
// Env: SHEET_ID, GOOGLE_API_KEY, SHEET_TAB?=Scenarios, OPENAI_API_KEY

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

// ====== Layout & Guide ======
const LAYOUT = {
  laneGap: 1700,   // distance between PROD and DEMO lanes (vertical)
  stepX: 340,      // horizontal spacing
  branchY: 320,    // vertical spacing between branches (bigger so labels never overlap)
  prodHeader: { x: -1320, y: 40 },
  prodStart:  { x: -1180, y: 300 },
  demoHeader: { x: -1320, y: 40 },
  demoStart:  { x: -1180, y: 300 },
  switchX: -220,
  errorRowYPad: 260,
};

const GUIDE = {
  showWaypoints: true,   // ➡️ pass-through markers between sections
  numberSteps:   true,   // prefix steps inside a branch: [1], [2], ...
};

const DEMO = {
  to: "+34613030526",
  emailTo: "kevanm.spain@gmail.com",
  waFrom: "+14155238886",
  smsFrom: "+13412184164",
  callFrom: "+13412184164",
};

const DEFAULT_HTTP = {
  pms_upcoming: "https://example.com/pms/upcoming",
  pms_update: "https://example.com/pms/update",
  waitlist_fill: "https://example.com/waitlist/fill",
  kb_search: "https://example.com/kb/search",
  ticket_create: "https://example.com/ticket/create",
  nps_create: "https://example.com/nps/create",
  bi_nps: "https://example.com/bi/nps",
  crm_log: "https://example.com/crm/log",
  crm_upsert: "https://example.com/crm/upsert",
  calendar_book: "https://example.com/calendar/book",
  dispatch_assign: "https://example.com/dispatch/assign",
  erp_po: "https://example.com/erp/po",
  wms_levels: "https://example.com/wms/levels",
  wms_update: "https://example.com/wms/update",
  accounting_aging: "https://example.com/accounting/aging",
  ar_dispute: "https://example.com/ar/dispute",
  compliance_list: "https://example.com/compliance/list",
  compliance_report: "https://example.com/compliance/report",
  legal_notify: "https://example.com/legal/notify",
  alert: "https://example.com/alert",
  metrics: "https://example.com/metrics",
  dash_export: "https://example.com/dash/export",
  iam_provision: "https://example.com/iam/provision",
  iam_log: "https://example.com/iam/log",
  privacy_collect: "https://example.com/privacy/collect",
  privacy_respond: "https://example.com/privacy/respond",
  privacy_attest: "https://example.com/privacy/attest",
  kyc: "https://example.com/kyc",
};

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
  { k: 'call', rx: /(voice|call)/i },
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
        temperature:0.3,
        response_format:{type:"json_object"},
        messages:[
          {role:"system",content:"You are an expert workflow designer for n8n. Always return valid JSON objects only."},
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
Based on the context below, design a bullet-proof workflow shape for n8n with:
- "trigger": one of ["cron","webhook","imap","manual"]
- "channels": array subset of ["email","sms","whatsapp","call"] (ordered)
- "branches": array (max 6). Each branch:
  { "name": string, "condition": string, "steps": [ { "name": string, "kind": "compose|http|update|route|wait|score|lookup|book|ticket|notify|store|decision" } ] }
- "errors": likely errors + mitigations
- "systems": external systems to involve
- "archetype": one of the 20 standard archetypes (customize allowed)
Return JSON:
{
  "archetype": "...",
  "trigger": "cron|webhook|imap|manual",
  "channels": ["email","sms",...],
  "branches": [{ "name": "...", "condition": "...", "steps": [{"name":"...","kind":"..."}]}],
  "errors": [{ "name":"...", "mitigation":"..." }],
  "systems": ["pms","crm",...]
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
Compose human, natural outreach content for channels ${JSON.stringify(channels)} for archetype ${archetype}.
No "press 1" UX. 3–6 short lines each.
Return JSON: { "email": { "subject":"...", "body":"..." }, "sms": {"body":"..."}, "whatsapp":{"body":"..."}, "call":{"script":"..."} }

Context:
${ctx}`;
}

// ---------- workflow primitives ----------
function baseWorkflow(name){ return { name, nodes:[], connections:{}, active:false, settings:{}, staticData:{}, __yOffset:0 }; }
function addNode(wf,node){ if(Array.isArray(node.position)){ node.position=[node.position[0], node.position[1]+(wf.__yOffset||0)]; } wf.nodes.push(node); return node.name; }
function connect(wf,from,to,outputIndex=0){ wf.connections[from]??={}; wf.connections[from].main??=[]; for(let i=wf.connections[from].main.length;i<=outputIndex;i++) wf.connections[from].main[i]=[]; wf.connections[from].main[outputIndex].push({node:to,type:"main",index:0}); }
function withYOffset(wf,yOffset,fn){ const prev=wf.__yOffset||0; wf.__yOffset=yOffset; try{ fn(); } finally{ wf.__yOffset=prev; } }
function addHeader(wf,label,x,y){ return addNode(wf,{ id:uid("label"), name:`=== ${label} ===`, type:"n8n-nodes-base.function", typeVersion:2, position:pos(x,y), parameters:{ functionCode:"return [$json];" } }); }
function addManual(wf,x,y,label="Manual Trigger"){ return addNode(wf,{ id:uid("manual"), name:label, type:"n8n-nodes-base.manualTrigger", typeVersion:1, position:pos(x,y), parameters:{} }); }
function addCron(wf,label,x,y,compat){ if(compat==="full"){ return addNode(wf,{ id:uid("cron"), name:label, type:"n8n-nodes-base.cron", typeVersion:1, position:pos(x,y), parameters:{ triggerTimes:{ item:[{ mode:"everyX", everyX:{ hours:0, minutes:15 } }] } } }); } return addNode(wf,{ id:uid("cronph"), name:`${label} (Placeholder)`, type:"n8n-nodes-base.function", typeVersion:2, position:pos(x,y), parameters:{ functionCode:"return [$json];" } }); }
function addWebhook(wf,label,x,y,compat){ if(compat==="full"){ return addNode(wf,{ id:uid("webhook"), name:label, type:"n8n-nodes-base.webhook", typeVersion:1, position:pos(x,y), parameters:{ path:uid("hook"), methods:["POST"], responseMode:"onReceived" } }); } return addNode(wf,{ id:uid("webph"), name:`${label} (Placeholder)`, type:"n8n-nodes-base.function", typeVersion:2, position:pos(x,y), parameters:{ functionCode:"return [$json];" } }); }
function addHTTP(wf,name,urlExpr,bodyExpr,x,y,method="POST"){ return addNode(wf,{ id:uid("http"), name, type:"n8n-nodes-base.httpRequest", typeVersion:4, position:pos(x,y), parameters:{ url:urlExpr, method, jsonParameters:true, sendBody:true, bodyParametersJson:bodyExpr } }); }
function addFunction(wf,name,code,x,y){ return addNode(wf,{ id:uid("func"), name, type:"n8n-nodes-base.function", typeVersion:2, position:pos(x,y), parameters:{ functionCode:code } }); }
function addIf(wf,name,left,op,right,x,y){ return addNode(wf,{ id:uid("if"), name, type:"n8n-nodes-base.if", typeVersion:2, position:pos(x,y), parameters:{ conditions:{ number:[], string:[{ value1:left, operation:op, value2:right }] } } }); }
function addSwitch(wf,name,valueExpr,rules,x,y){ return addNode(wf,{ id:uid("switch"), name, type:"n8n-nodes-base.switch", typeVersion:2, position:pos(x,y), parameters:{ value1:valueExpr, rules } }); }
function addSplit(wf,x,y,size=20){ return addNode(wf,{ id:uid("split"), name:"Split In Batches", type:"n8n-nodes-base.splitInBatches", typeVersion:1, position:pos(x,y), parameters:{ batchSize:size } }); }
function addCollector(wf,x,y){ return addFunction(wf,"Collector (Inspect)",`const now=new Date().toISOString(); const arr=Array.isArray(items)?items:[{json:$json}]; return arr.map((it,i)=>({json:{...it.json,__collected_at:now, index:i}}));`,x,y); }

// ➡️ Waypoint (visual arrow)
function addArrow(wf,label,x,y){
  return GUIDE.showWaypoints
    ? addFunction(wf, `➡️ ${label}`, "return [$json];", x, y)
    : addFunction(wf, label, "return [$json];", x, y);
}

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
  const REQUIRED_TYPE="n8n-nodes-base.function"; const nameCounts={}; const byName=new Map();
  wf.nodes=(wf.nodes||[]).map((n,idx)=>{
    if(!n.name||typeof n.name!=='string') n.name=`Node ${idx+1}`;
    const k=n.name.toLowerCase(); if(nameCounts[k]==null) nameCounts[k]=0; else nameCounts[k]+=1; if(nameCounts[k]>0) n.name=`${n.name} #${nameCounts[k]}`;
    if(!n.type||typeof n.type!=='string'||!n.type.trim()){ n.type=REQUIRED_TYPE; n.typeVersion=typeof n.typeVersion==='number'?n.typeVersion:2; n.parameters||={ functionCode:"return [$json];" }; }
    if(typeof n.typeVersion!=='number') n.typeVersion=1;
    if(!Array.isArray(n.position)||n.position.length!==2){ n.position=[-1000, 300+(idx*40)]; } else { n.position=[Number(n.position[0])||0, Number(n.position[1])||0]; }
    if(!n.parameters||typeof n.parameters!=='object') n.parameters={};
    byName.set(n.name,n); return n;
  });
  const conns=wf.connections||{};
  for(const [from,m] of Object.entries(conns)){
    if(!byName.has(from)){ delete conns[from]; continue; }
    if(!m||typeof m!=="object"){ delete conns[from]; continue; }
    if(!Array.isArray(m.main)) m.main=[];
    m.main=m.main.map(arr=>Array.isArray(arr)?arr.filter(link=>byName.has(link?.node)):[]);
  }
  wf.connections=conns; wf.name=String(wf.name||"AI Agent Workflow"); return wf;
}

// ---------- LLM orchestration ----------
function makeDesigner(row){
  return openaiJSON(
    makeDesignerPrompt(row),
    `{"archetype":string,"trigger":"cron|webhook|imap|manual","channels":string[],"branches":[{"name":string,"condition":string,"steps":[{"name":string,"kind":string}]}],"errors":[{"name":string,"mitigation":string}],"systems":string[]}`
  );
}
function makeMessages(row, archetype, channels){
  return openaiJSON(
    makeMessagingPrompt(row, archetype, channels),
    `{"email":{"subject":string,"body":string},"sms":{"body":string},"whatsapp":{"body":string},"call":{"script":string}}`
  );
}

// ---------- core build ----------
async function buildWorkflowFromRow(row, opts){
  const compat=(opts.compat||'safe')==='full'?'full':'safe';
  const includeDemo=opts.includeDemo!==false;

  // channels from best_reply_shapes
  const channels=[]; const shapes=listify(row.best_reply_shapes);
  for(const sh of shapes){ for(const norm of CHANNEL_NORMALIZE){ if(norm.rx.test(sh) && !channels.includes(norm.k)) channels.push(norm.k); } }
  if(!channels.length) channels.push('email');

  // choose archetype/trigger
  let archetype=chooseArchetype(row);
  let prodTrigger=TRIGGER_PREF[archetype]||'manual';

  // LLM design + messages
  const design=(await makeDesigner(row))||{};
  if(Array.isArray(design.channels)&&design.channels.length){
    const allowed=['email','sms','whatsapp','call'];
    const llmCh=design.channels.filter(c=>allowed.includes(String(c).toLowerCase()));
    if(llmCh.length){ channels.splice(0,channels.length,...llmCh); }
  }
  if(typeof design.trigger==='string' && ['cron','webhook','imap','manual'].includes(design.trigger.toLowerCase())){
    prodTrigger=design.trigger.toLowerCase();
  }
  if(typeof design.archetype==='string' && design.archetype.trim()){
    archetype=design.archetype.trim().toUpperCase();
  }
  const systems=Array.isArray(design.systems)?design.systems.map(s=>String(s).toLowerCase()):[];
  const branches=Array.isArray(design.branches)?design.branches:[];
  const errors=Array.isArray(design.errors)?design.errors:[];
  const msg=(await makeMessages(row, archetype, channels))||{};

  const title=`${row.scenario_id||'Scenario'} — ${row.name||''}`.trim();
  const wf=baseWorkflow(title);

  // lane builder (prod/demo)
  function buildLane({ laneLabel, yOffset, triggerKind, isDemo }){
    withYOffset(wf, yOffset, () => {
      // header
      addHeader(wf, laneLabel, isDemo?LAYOUT.demoHeader.x:LAYOUT.prodHeader.x, isDemo?LAYOUT.demoHeader.y:LAYOUT.prodHeader.y);

      // trigger
      let trig;
      if(isDemo) trig = addManual(wf, LAYOUT.demoStart.x, LAYOUT.demoStart.y, "Demo Manual Trigger");
      else {
        if (triggerKind==='cron') trig = addCron(wf, "Cron (from LLM)", LAYOUT.prodStart.x, LAYOUT.prodStart.y - 160, compat);
        else if (triggerKind==='webhook') trig = addWebhook(wf, "Webhook (from LLM)", LAYOUT.prodStart.x, LAYOUT.prodStart.y, compat);
        else if (triggerKind==='imap') trig = addFunction(wf, "IMAP Intake (Placeholder)", "return [$json];", LAYOUT.prodStart.x, LAYOUT.prodStart.y);
        else trig = addManual(wf, LAYOUT.prodStart.x, LAYOUT.prodStart.y, "Manual Trigger");
      }

      // ➡️ waypoint
      const w1 = addArrow(wf, "Start → Init", (isDemo?LAYOUT.demoStart.x:LAYOUT.prodStart.x)+Math.floor(LAYOUT.stepX/2), LAYOUT.prodStart.y);
      connect(wf, trig, w1);

      // init context
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
      connect(wf, w1, init);

      // optional fetch/split
      let cursor = init;
      let didList=false;
      if(!isDemo){
        if(systems.includes('pms')){
          const w2 = addArrow(wf, "Init → Fetch", LAYOUT.prodStart.x + 1.5*LAYOUT.stepX, LAYOUT.prodStart.y);
          connect(wf, cursor, w2);
          const fetch = addHTTP(wf, "Fetch Upcoming (PMS)", `={{'${DEFAULT_HTTP.pms_upcoming}'}}`, "={{$json}}", LAYOUT.prodStart.x + 2*LAYOUT.stepX, LAYOUT.prodStart.y);
          connect(wf, w2, fetch); cursor = fetch;
        }
        if(['RENEWALS_CSM','AR_FOLLOWUP','REPORTING_KPI_DASH','DATA_PIPELINE_ETL'].includes(archetype)){
          const w3 = addArrow(wf, "Fetch → Split", LAYOUT.prodStart.x + 2.5*LAYOUT.stepX, LAYOUT.prodStart.y);
          connect(wf, cursor, w3);
          const split = addSplit(wf, LAYOUT.prodStart.x + 3*LAYOUT.stepX, LAYOUT.prodStart.y, 25);
          connect(wf, w3, split); cursor = split; didList=true;
        }
      }

      // branch switch
      const w4 = addArrow(wf, `${didList?"Split":"Init"} → Branch`, LAYOUT.switchX - 120, LAYOUT.prodStart.y);
      connect(wf, cursor, w4);
      const sw = addSwitch(wf, "Branch (LLM)", "={{$json.__branch || 'main'}}",
        (branches.length?branches:[{name:"main"}]).map(b=>({operation:'equal', value2:String(b.name||'main').slice(0,48)})),
        LAYOUT.switchX, LAYOUT.prodStart.y);
      connect(wf, w4, sw);

      // branches
      const lastNodes=[]; const baseY = LAYOUT.prodStart.y - Math.floor(LAYOUT.branchY * (Math.max(branches.length,1)-1)/2);
      (branches.length?branches:[{name:"main",steps:[]}]).forEach((b, idx)=>{
        const rowY = baseY + idx*LAYOUT.branchY;

        // enter + numbering
        let stepNo=0;
        const enterName = GUIDE.numberSteps ? `[${++stepNo}] Enter: ${b.name||'Case'}` : `Enter: ${b.name||'Case'}`;
        let prev = addFunction(wf, enterName,
          `return [{...$json,__branch:${JSON.stringify(b.name||'case')},__cond:${JSON.stringify(b.condition||'')}}];`,
          LAYOUT.prodStart.x + 4*LAYOUT.stepX, rowY);
        connect(wf, sw, prev, idx);

        // steps
        const steps = Array.isArray(b.steps)?b.steps:[];
        steps.forEach((st,k)=>{
          const x = LAYOUT.prodStart.x + (5+k)*LAYOUT.stepX;
          const y = rowY;
          const title = GUIDE.numberSteps ? `[${++stepNo}] ${st.name||'Step'}` : (st.name||'Step');
          const kind=String(st.kind||'').toLowerCase();
          let node;
          if(kind==='compose'){
            node = addFunction(wf, title, `
const ch=($json.channels && $json.channels[0]) || 'email';
const m=$json.msg||{};
const bodies={ email:(m.email?.body)||'', sms:(m.sms?.body)||'', whatsapp:(m.whatsapp?.body)||'', call:(m.call?.script)||''};
return [{...$json, message:bodies[ch] || bodies.email || 'Hello!'}];`, x, y);
          }else if(['http','update','store','notify','route'].includes(kind)){
            node = addHTTP(wf, title, "={{'https://example.com/step'}}", "={{$json}}", x, y);
          }else if(kind==='book'){
            node = addHTTP(wf, title, `={{'${DEFAULT_HTTP.calendar_book}'}}`, "={{$json}}", x, y);
          }else if(kind==='ticket'){
            node = addHTTP(wf, title, `={{'${DEFAULT_HTTP.ticket_create}'}}`, "={{$json}}", x, y);
          }else{
            node = addFunction(wf, title, "return [$json];", x, y);
          }
          connect(wf, prev, node);
          // tiny arrow between step blocks
          const wp = addArrow(wf, "→", x + Math.floor(LAYOUT.stepX/2), y);
          connect(wf, node, wp);
          prev = wp;
        });

        // sends (sequential)
        channels.forEach((ch,i)=>{
          const x = LAYOUT.prodStart.x + (5 + steps.length + i)*LAYOUT.stepX;
          const sendTitle = GUIDE.numberSteps ? `[${++stepNo}] Send: ${ch.toUpperCase()}` : `Send: ${ch.toUpperCase()}`;
          const sender = makeSenderNode(wf, ch, x, rowY, compat, isDemo);
          // rename with numbered prefix if possible
          try{ wf.nodes[wf.nodes.findIndex(n=>n.name===sender)].name = sendTitle; }catch{}
          connect(wf, prev, sender);
          prev = addArrow(wf, "→", x + Math.floor(LAYOUT.stepX/2), rowY);
          connect(wf, sender, prev);
        });

        const end = addCollector(wf, LAYOUT.prodStart.x + (6 + steps.length + channels.length)*LAYOUT.stepX, rowY);
        const wpEnd = addArrow(wf, "→ End", LAYOUT.prodStart.x + (5.5 + steps.length + channels.length)*LAYOUT.stepX, rowY);
        connect(wf, prev, wpEnd); connect(wf, wpEnd, end);
        lastNodes.push(end);
      });

      // chain collectors so the itinerary is obvious
      for(let i=0;i<lastNodes.length-1;i++){ connect(wf, lastNodes[i], lastNodes[i+1]); }
      const afterBranch = lastNodes[lastNodes.length-1];

      // Errors row
      if(errors.length){
        const errY = baseY + (Math.max(branches.length,1)-1)*LAYOUT.branchY + LAYOUT.errorRowYPad;
        const wErr = addArrow(wf, "Branches → Errors", LAYOUT.prodStart.x + 3.6*LAYOUT.stepX, errY);
        connect(wf, afterBranch, wErr);
        let prev = addFunction(wf, "Error Monitor (LLM List)", "return [$json];", LAYOUT.prodStart.x + 4*LAYOUT.stepX, errY);
        connect(wf, wErr, prev);
        errors.forEach((e,i)=>{
          const fix = addFunction(wf, GUIDE.numberSteps?`[E${i+1}] ${e.name||'Error'}`:(e.name||'Error'),
            `// ${e.mitigation||''}\nreturn [$json];`, LAYOUT.prodStart.x + (5+i)*LAYOUT.stepX, errY);
          connect(wf, prev, fix); prev = addArrow(wf, "→", LAYOUT.prodStart.x + (5+i)*LAYOUT.stepX + Math.floor(LAYOUT.stepX/2), errY); connect(wf, fix, prev);
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
  wf.staticData.__design={ archetype, prodTrigger, channels, systems, branches, errors, guide: GUIDE };

  return sanitizeWorkflow(wf);
}

// ---------- HTTP handler ----------
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
