// /api/build.js — deep per-scenario builder (CommonJS).
// Fixes n8n import errors by enforcing unique node names and connecting by returned names only.
// Two lanes (Prod + Demo), vertical channel fan, wide spacing, waypoint arrows, demo seeds.

const fetch = global.fetch;

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Preview, X-Debug",
  "Content-Type": "application/json; charset=utf-8",
};

// ---------------- helpers ----------------
const toObj = (header,row)=>Object.fromEntries(header.map((h,i)=>[h,(row[i]??"").toString().trim()]));
const listify = (v)=>Array.isArray(v)?v.map(s=>String(s||'').trim()).filter(Boolean):String(v||'').split(/[;,/|\n]+/).map(s=>s.trim()).filter(Boolean);
const safeLower = (v)=>String(v||'').toLowerCase();
const uid = (p)=>`${p}_${Math.random().toString(36).slice(2,10)}`;
const pos = (x,y)=>[x,y];

// ---------------- demo seeds ----------------
const DEMO = {
  to: "+34613030526",
  emailTo: "kevanm.spain@gmail.com",
  waFrom: "+14155238886",
  smsFrom: "+13412184164",
  callFrom: "+13412184164",
};

// ---------------- layout ----------------
const LAYOUT = {
  laneGap: 2400,     // distance between PROD and DEMO lanes
  stepX: 460,        // horizontal step size
  channelGap: 320,   // vertical gap between channels (more readable)
  prodHeader: { x: -1800, y: 60 },
  prodStart:  { x: -1600, y: 420 },
  demoHeader: { x: -1800, y: 60 },
  demoStart:  { x: -1600, y: 420 },
  switchX: -520,
};
const GUIDE = { showWaypoints:true, numberSteps:true };

// ---------------- n8n primitives ----------------
function baseWorkflow(name){
  return { name, nodes:[], connections:{}, active:false, settings:{}, staticData:{}, __yOffset:0 };
}
function addNode(wf,node){
  if(Array.isArray(node.position)){ node.position=[node.position[0], node.position[1]+(wf.__yOffset||0)]; }
  wf.nodes.push(node);
  return node.name; // return the *actual* name we used to connect from/to
}
function connect(wf, fromName, toName, outputIndex=0){
  // Ensure the map exists
  wf.connections[fromName] ??= {};
  wf.connections[fromName].main ??= [];
  for(let i=wf.connections[fromName].main.length;i<=outputIndex;i++) wf.connections[fromName].main[i]=[];
  wf.connections[fromName].main[outputIndex].push({ node: toName, type: "main", index: 0 });
}
function withYOffset(wf,yOffset,fn){ const prev=wf.__yOffset||0; wf.__yOffset=yOffset; try{ fn(); } finally { wf.__yOffset=prev; } }

function addHeader(wf,label,x,y){
  return addNode(wf,{
    id:uid("label"),
    name:`=== ${label} ===`,
    type:"n8n-nodes-base.function",
    typeVersion:2,
    position:pos(x,y),
    parameters:{ functionCode:"return [$json];" }
  });
}
function addManual(wf,x,y,label="Manual Trigger"){
  return addNode(wf,{ id:uid("manual"), name:label, type:"n8n-nodes-base.manualTrigger", typeVersion:1, position:pos(x,y), parameters:{} });
}
function addCron(wf,label,x,y){
  // Use Function placeholder to minimize credential issues on import
  return addNode(wf,{ id:uid("cron"), name:label, type:"n8n-nodes-base.function", typeVersion:2, position:pos(x,y), parameters:{ functionCode:"return [$json];" }});
}
function addWebhook(wf,label,x,y){
  return addNode(wf,{ id:uid("webhook"), name:label, type:"n8n-nodes-base.function", typeVersion:2, position:pos(x,y), parameters:{ functionCode:"return [$json];" }});
}
function addHTTP(wf,name,urlExpr,bodyExpr,x,y,method="POST"){
  return addNode(wf,{ id:uid("http"), name, type:"n8n-nodes-base.httpRequest", typeVersion:4, position:pos(x,y),
    parameters:{ url:urlExpr, method, jsonParameters:true, sendBody:true, bodyParametersJson:bodyExpr } });
}
function addFunction(wf,name,code,x,y){
  return addNode(wf,{ id:uid("func"), name, type:"n8n-nodes-base.function", typeVersion:2, position:pos(x,y), parameters:{ functionCode:code }});
}
function addIf(wf,name,left,op,right,x,y){
  return addNode(wf,{ id:uid("if"), name, type:"n8n-nodes-base.if", typeVersion:2, position:pos(x,y),
    parameters:{ conditions:{ number:[], string:[{ value1:left, operation:op, value2:right }] } }});
}
function addSwitch(wf,name,valueExpr,rules,x,y){
  return addNode(wf,{ id:uid("switch"), name, type:"n8n-nodes-base.switch", typeVersion:2, position:pos(x,y),
    parameters:{ value1:valueExpr, rules }});
}
function addSplit(wf,x,y,size=25){
  return addNode(wf,{ id:uid("split"), name:"Split In Batches", type:"n8n-nodes-base.splitInBatches", typeVersion:1, position:pos(x,y), parameters:{ batchSize:size }});
}
function addCollector(wf,x,y){
  return addFunction(wf,"Collector (Inspect)",`
const now=new Date().toISOString();
const arr=Array.isArray(items)?items:[{json:$json}];
return arr.map((it,i)=>({json:{...it.json,__collected_at:now,index:i}}));`,x,y);
}
function addArrow(wf,label,x,y){
  return GUIDE.showWaypoints ? addFunction(wf, `➡️ ${label}`, "return [$json];", x, y)
                             : addFunction(wf, label, "return [$json];", x, y);
}
function makeSenderNode(wf, channel, x, y, demo){
  const nm = demo ? `(Demo) ${channel.toUpperCase()} Send` : `${channel.toUpperCase()} Send`;
  return addFunction(wf, nm, "return [$json];", x, y); // simple & import-safe
}

// Keep names unique and avoid importer renames
function uniqueName(base, suffix){ return `${base} — ${suffix}`; }

// Sanitize to ensure every node has strings and valid positions; drop broken links
function sanitizeWorkflow(wf){
  const REQUIRED="n8n-nodes-base.function";
  const byName=new Map();
  wf.nodes=(wf.nodes||[]).map((n,i)=>{
    if(!n.name||typeof n.name!=='string') n.name=`Node ${i+1}`;
    if(!n.type||typeof n.type!=='string'){ n.type=REQUIRED; n.typeVersion=2; n.parameters={ functionCode:"return [$json];" }; }
    if(!Array.isArray(n.position)||n.position.length!==2){ n.position=[-1200, 300+(i*60)]; }
    byName.set(n.name,n); return n;
  });
  const conns=wf.connections||{};
  for(const [from,m] of Object.entries(conns)){
    if(!byName.has(from)){ delete conns[from]; continue; }
    if(!m||typeof m!=="object"){ delete conns[from]; continue; }
    if(!Array.isArray(m.main)) m.main=[];
    m.main=m.main.map(arr=>Array.isArray(arr)?arr.filter(link=>byName.has(link?.node)):[]);
  }
  wf.connections=conns; return wf;
}

// ---------------- archetype + channels ----------------
function chooseArchetype(s){
  const hay=[
    safeLower(s.scenario_id),
    safeLower(s.name),
    safeLower((s.tags||[]).join(' ')),
    safeLower(s.triggers),
    safeLower(s.how_it_works),
    safeLower(s.tool_stack_dev),
  ].join(' ');
  const rules=[
    ['APPOINTMENT_SCHEDULING', /(appointment|scheduling|no-?show|calendar)/],
    ['CUSTOMER_SUPPORT_INTAKE', /\b(support|ticket|sla|triage|escalation|deflection|kb)\b/],
    ['FEEDBACK_NPS', /\b(nps|survey|feedback|csat|ces)\b/],
    ['KNOWLEDGEBASE_FAQ', /\b(kb|faq|knowledge|self-?service)\b/],
    ['SALES_OUTREACH', /\b(sales|outreach|cadence|sequence|prospect|abm)\b/],
    ['LEAD_QUAL_INBOUND', /\b(inbound|qual|routing|router|form)\b/],
    ['CHURN_WINBACK', /\b(churn|winback|reactivation|retention)\b/],
    ['RENEWALS_CSM', /\b(renewal|qbr|success|csm|upsell|cross-?sell)\b/],
    ['AR_FOLLOWUP', /\b(a\/?r|receivable|invoice|collections?)\b/],
    ['AP_AUTOMATION', /\b(a\/?p|payable|invoice|matching|approval)\b/],
    ['INVENTORY_MONITOR', /\b(inventory|stock|sku|threshold|warehouse|wms)\b/],
    ['REPLENISHMENT_PO', /\b(replenishment|purchase[-_ ]?order|po|procure|vendor|supplier)\b/],
    ['FIELD_SERVICE_DISPATCH', /\b(dispatch|work[-_ ]?order|technician|geo|eta|route)\b/],
    ['COMPLIANCE_AUDIT', /\b(compliance|audit|policy|governance|iso|sox|gdpr)\b/],
    ['INCIDENT_MGMT', /\b(incident|sev|downtime|uptime|slo)\b/],
    ['DATA_PIPELINE_ETL', /\b(etl|pipeline|ingest|transform|load)\b/],
    ['REPORTING_KPI_DASH', /\b(dashboard|kpi|scorecard|report)\b/],
    ['ACCESS_GOVERNANCE', /\b(access|rbac|sso|entitlements|identity)\b/],
    ['PRIVACY_DSR', /\b(dsr|data\s*subject|privacy|gdpr|ccpa)\b/],
    ['RECRUITING_INTAKE', /\b(recruit|ats|resume|candidate|interview)\b/],
  ];
  for(const [a,rx] of rules){ if(rx.test(hay)) return a; }
  return 'SALES_OUTREACH';
}
function deriveChannels(s){
  const shapes=listify(s.best_reply_shapes||[]);
  const out=[]; const map=[['whatsapp',/whatsapp/i],['sms',/(sms|text)/i],['call',/(voice|call)/i],['email',/email/i]];
  for(const sh of shapes){ for(const [k,rx] of map){ if(rx.test(sh) && !out.includes(k)) out.push(k); } }
  return out.length?out:['email','sms','email'];
}

// ---------------- LLM (optional) ----------------
async function callOpenAI({ system, user, model }){
  const key = process.env.OPENAI_API_KEY;
  if(!key) return null;
  try{
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method:"POST",
      headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${key}` },
      body: JSON.stringify({
        model: model || "gpt-4o-mini",
        temperature: 0.4,
        messages: [
          { role:"system", content: system },
          { role:"user", content: user }
        ]
      })
    });
    if(!r.ok) return null;
    const data = await r.json();
    return data?.choices?.[0]?.message?.content || "";
  } catch {
    return null;
  }
}

function makeDesignerPrompt(row){
  const ctx = JSON.stringify({
    scenario_id: row.scenario_id,
    name: row.name,
    triggers: row.triggers,
    best_reply_shapes: row.best_reply_shapes,
    risk_notes: row.risk_notes,
    how_it_works: row.how_it_works,
    tool_stack_dev: row.tool_stack_dev,
    roi_hypothesis: row.roi_hypothesis,
    tags: row.tags
  }, null, 2);
  return {
    system: "You design bulletproof business workflows for n8n. Output strict JSON only.",
    user:
`Given this scenario context (JSON below), propose:
- trigger: one of ["manual","cron","webhook","imap"] (string)
- channels: array of any of ["email","sms","whatsapp","call"] in delivery order
- branches: array of branch objects:
  { id: "main", steps: [ { name, kind } ... ] }
- errors: array of { when, action }
JSON only.

context:
${ctx}`
  };
}
function makeMessagingPrompt(row){
  const ctx = JSON.stringify({
    scenario_id: row.scenario_id,
    agent_name: row.agent_name,
    industry: row.name,
    triggers: row.triggers,
    how_it_works: row.how_it_works,
    roi_hypothesis: row.roi_hypothesis
  }, null, 2);
  return {
    system: "You write natural, human-sounding omni-channel copy. Output strict JSON only.",
    user:
`Write short, natural copy for email, sms, whatsapp, and a call talk-track for this context.
Include keys: { "email": {subject,body}, "sms": body, "whatsapp": body, "call": script }.
JSON only.

context:
${ctx}`
  };
}

// ---------------- lane builder (unique names + proper connects) ----------------
function buildLane(wf, scenario, messaging, designer, { yOffset, isDemo }){
  const channels = Array.isArray(designer?.channels)&&designer.channels.length ? designer.channels : deriveChannels(scenario);

  withYOffset(wf, yOffset, ()=>{
    const header = addHeader(wf, isDemo ? "DEMO LANE (Manual Trigger + Seeds)" : "PRODUCTION LANE",
      isDemo?LAYOUT.demoHeader.x:LAYOUT.prodHeader.x,
      isDemo?LAYOUT.demoHeader.y:LAYOUT.prodHeader.y);

    const triggerName = isDemo
      ? addManual(wf, LAYOUT.demoStart.x, LAYOUT.demoStart.y, "Demo Manual Trigger")
      : (designer?.trigger==="cron"    ? addCron(wf,"Cron (from designer)", LAYOUT.prodStart.x, LAYOUT.prodStart.y)
        : designer?.trigger==="webhook"? addWebhook(wf,"Webhook (from designer)", LAYOUT.prodStart.x, LAYOUT.prodStart.y)
        : designer?.trigger==="imap"   ? addFunction(wf,"IMAP Intake (Placeholder)","return [$json];", LAYOUT.prodStart.x, LAYOUT.prodStart.y)
        : addManual(wf, LAYOUT.prodStart.x, LAYOUT.prodStart.y, "Manual Trigger"));

    const w1 = addArrow(wf, "Start → Init", (isDemo?LAYOUT.demoStart.x:LAYOUT.prodStart.x)+Math.floor(LAYOUT.stepX/2), LAYOUT.prodStart.y);
    connect(wf, triggerName, w1);

    const initName = addFunction(wf, isDemo? "Init Demo Context":"Init Context", `
const seed=${JSON.stringify(DEMO)};
const scenario=${JSON.stringify({
  scenario_id: scenario.scenario_id || '',
  agent_name: scenario.agent_name || '',
  name: scenario.name || '',
  triggers: scenario.triggers || '',
  roi_hypothesis: scenario.roi_hypothesis || ''
})};
const msg=${JSON.stringify(messaging||{})};
return [${isDemo? "{...seed, scenario, msg, demo:true}" : "{...$json, scenario, msg}"}];`,
      (isDemo?LAYOUT.demoStart.x:LAYOUT.prodStart.x)+LAYOUT.stepX, LAYOUT.prodStart.y);
    connect(wf, w1, initName);

    const enterBranch = addArrow(wf, "Init → Branch", LAYOUT.switchX - 120, LAYOUT.prodStart.y);
    connect(wf, initName, enterBranch);

    const swName = addSwitch(wf, "Branch", "={{$json.__branch || 'main'}}", [{operation:"equal",value2:"main"}], LAYOUT.switchX, LAYOUT.prodStart.y);
    connect(wf, enterBranch, swName);

    let stepNo = 0;
    const enterMain = addFunction(wf, GUIDE.numberSteps?`[${++stepNo}] Enter: main`:"Enter: main",
      "return [{...$json,__branch:'main'}];", LAYOUT.prodStart.x + 4*LAYOUT.stepX, LAYOUT.prodStart.y);
    connect(wf, swName, enterMain, 0);

    // vertical channel fan
    const chBaseY = LAYOUT.prodStart.y - Math.floor(LAYOUT.channelGap * (Math.max(channels.length,1)-1)/2);
    const chStartX = LAYOUT.prodStart.x + 6*LAYOUT.stepX;

    const collectors=[];
    channels.forEach((ch, idx)=>{
      const channel = String(ch||'email').toLowerCase();
      const cy = chBaseY + idx*LAYOUT.channelGap;
      const fanStep = addArrow(wf, `main → ${channel.toUpperCase()}`, chStartX - Math.floor(LAYOUT.stepX/2), cy);
      connect(wf, enterMain, fanStep);

      const composeName = addFunction(wf, uniqueName("Compose", channel.toUpperCase()), `
const msg = $json.msg || {};
let body = '';
let subject = $json.scenario?.agent_name ? \`\${$json.scenario.agent_name} — \${$json.scenario.scenario_id||''}\` : ($json.scenario?.scenario_id||'AI Workflow');
if('${channel}'==='email'){ body = msg.email?.body || $json.message || 'Hello from the workflow.'; subject = msg.email?.subject || subject; }
else if('${channel}'==='sms'){ body = msg.sms || $json.message || 'Quick update.'; }
else if('${channel}'==='whatsapp'){ body = msg.whatsapp || $json.message || 'Heads up.'; }
else if('${channel}'==='call'){ body = msg.call || $json.message || 'Talk track.'; }
return [{...$json, message: body, subject }];`, chStartX, cy);
      connect(wf, fanStep, composeName);

      const sendName = makeSenderNode(wf, channel, chStartX + LAYOUT.stepX, cy, !!isDemo);
      connect(wf, composeName, sendName);

      const afterSend = addArrow(wf, "→", chStartX + Math.floor(1.5*LAYOUT.stepX), cy);
      connect(wf, sendName, afterSend);

      const waitName = addFunction(wf, uniqueName("Wait / Listen", channel.toUpperCase()), "return [$json];", chStartX + 2*LAYOUT.stepX, cy);
      connect(wf, afterSend, waitName);

      const routeName = addIf(wf, uniqueName("Positive Reply?", channel.toUpperCase()), "={{$json.reply || ''}}", "notEmpty", "", chStartX + 3*LAYOUT.stepX, cy);
      connect(wf, waitName, routeName);

      const handlePos = addFunction(wf, uniqueName("Handle Positive", channel.toUpperCase()), "return [$json];", chStartX + 4*LAYOUT.stepX, cy - 60);
      connect(wf, routeName, handlePos, 0);
      const posLog = addHTTP(wf, uniqueName("Log/Update (OK)", channel.toUpperCase()), "={{'https://example.com/ok'}}", "={{$json}}", chStartX + 5*LAYOUT.stepX, cy - 60);
      connect(wf, handlePos, posLog);

      const handleNeg = addFunction(wf, uniqueName("Handle Neutral/No-Reply", channel.toUpperCase()), "return [$json];", chStartX + 4*LAYOUT.stepX, cy + 60);
      connect(wf, routeName, handleNeg, 1);
      const negLog = addHTTP(wf, uniqueName("Log/Update (Retry/Nurture)", channel.toUpperCase()), "={{'https://example.com/nurture'}}", "={{$json}}", chStartX + 5*LAYOUT.stepX, cy + 60);
      connect(wf, handleNeg, negLog);

      const join = addArrow(wf, "→", chStartX + 5.6*LAYOUT.stepX, cy);
      connect(wf, posLog, join);
      connect(wf, negLog, join);

      const col = addCollector(wf, chStartX + 6.2*LAYOUT.stepX, cy);
      connect(wf, join, col);
      collectors.push(col);
    });

    for(let i=0;i<collectors.length-1;i++){ connect(wf, collectors[i], collectors[i+1]); }
  });
}

// ---------------- builder ----------------
function buildWorkflowJSON(row, industry, designerJSON, messagingJSON){
  const name = `${row.scenario_id || 'Scenario'} — ${industry?.name || industry?.industry_id || 'Industry'}`;
  const wf = baseWorkflow(name);

  buildLane(wf, row, messagingJSON, designerJSON, { yOffset:0, isDemo:false });
  buildLane(wf, row, messagingJSON, designerJSON, { yOffset:LAYOUT.laneGap, isDemo:true });

  return sanitizeWorkflow(wf);
}

// ---------------- sheets fetch ----------------
async function fetchScenarioRow({ sheetId, tab, apiKey, wanted }){
  const range = encodeURIComponent(tab || "Scenarios");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?key=${apiKey}`;
  const r = await fetch(url, { cache:"no-store" });
  if(!r.ok) throw new Error(`Sheets API error: ${r.status} ${r.statusText}`);
  const data = await r.json();
  const rows = data.values || [];
  if(!rows.length) throw new Error("Sheet has no rows");
  const header = rows[0].map(h=>h.trim());
  const objRows = rows.slice(1).map(rw=>toObj(header,rw));
  const row = objRows.find(x => safeLower(x["scenario_id"]) === safeLower(wanted));
  if(!row) return null;
  return {
    scenario_id: row["scenario_id"] || "unknown_scenario",
    name: row["name"] || (row["scenario_id"] || "Scenario"),
    agent_name: row["agent_name"] || "Agent",
    tags: listify(row["tags (;)"] || row["tags"] || ""),
    triggers: row["triggers"] || "",
    best_reply_shapes: listify(row["best_reply_shapes"] || ""),
    risk_notes: row["risk_notes"] || "",
    how_it_works: row["how_it_works"] || "",
    tool_stack_dev: row["tool_stack_dev"] || "",
    tool_stack_autonomous: row["tool_stack_autonomous"] || "",
    roi_hypothesis: row["roi_hypothesis"] || ""
  };
}

// ---------------- LLM prompts ----------------
async function callOpenAI({ system, user, model }){
  const key = process.env.OPENAI_API_KEY;
  if(!key) return null;
  try{
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method:"POST",
      headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${key}` },
      body: JSON.stringify({
        model: model || "gpt-4o-mini",
        temperature: 0.4,
        messages: [
          { role:"system", content: system },
          { role:"user", content: user }
        ]
      })
    });
    if(!r.ok) return null;
    const data = await r.json();
    return data?.choices?.[0]?.message?.content || "";
  } catch { return null; }
}
function makeDesignerPrompt(row){ /* same as above */ 
  const ctx = JSON.stringify({
    scenario_id: row.scenario_id,
    name: row.name,
    triggers: row.triggers,
    best_reply_shapes: row.best_reply_shapes,
    risk_notes: row.risk_notes,
    how_it_works: row.how_it_works,
    tool_stack_dev: row.tool_stack_dev,
    roi_hypothesis: row.roi_hypothesis,
    tags: row.tags
  }, null, 2);
  return {
    system: "You design bulletproof business workflows for n8n. Output strict JSON only.",
    user:
`Given this scenario context (JSON below), propose:
- trigger: one of ["manual","cron","webhook","imap"] (string)
- channels: array of any of ["email","sms","whatsapp","call"] in delivery order
- branches: array of branch objects { id, steps:[{name,kind}] }
- errors: array of { when, action }
JSON only.

context:
${ctx}`
  };
}
function makeMessagingPrompt(row){ /* same as above */ 
  const ctx = JSON.stringify({
    scenario_id: row.scenario_id,
    agent_name: row.agent_name,
    industry: row.name,
    triggers: row.triggers,
    how_it_works: row.how_it_works,
    roi_hypothesis: row.roi_hypothesis
  }, null, 2);
  return {
    system: "You write natural, human-sounding omni-channel copy. Output strict JSON only.",
    user:
`Write short, natural copy for email, sms, whatsapp, and a call talk-track for this context.
Include keys: { "email": {subject,body}, "sms": body, "whatsapp": body, "call": script }.
JSON only.

context:
${ctx}`
  };
}

// ---------------- handler ----------------
module.exports = async (req, res) => {
  Object.entries(HEADERS).forEach(([k,v])=>res.setHeader(k,v));
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.method !== "POST") {
      return res.status(200).json({ ok:true, usage:'POST {"scenario_id":"<id>"}' });
    }

    // Parse body
    const body = await new Promise(resolve => {
      const chunks=[]; req.on("data", c=>chunks.push(c)); req.on("end", ()=>{
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { resolve({}); }
      });
    });

    const wanted = safeLower(body.scenario_id);
    if(!wanted) throw new Error("Missing scenario_id");

    const SHEET_ID = process.env.SHEET_ID;
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    const SHEET_TAB = process.env.SHEET_TAB || "Scenarios";
    if(!SHEET_ID || !GOOGLE_API_KEY) throw new Error("Missing SHEET_ID or GOOGLE_API_KEY");

    const row = await fetchScenarioRow({ sheetId: SHEET_ID, tab: SHEET_TAB, apiKey: GOOGLE_API_KEY, wanted });
    if(!row) return res.status(404).json({ ok:false, error:`scenario_id not found: ${wanted}` });

    const industry = { name: row.name, industry_id: safeLower(row.name).replace(/\s+/g,'_') };

    // Optional LLM shaping
    let designerJSON=null, messagingJSON=null;
    const dR = await callOpenAI(makeDesignerPrompt(row)); if(dR){ try{ designerJSON=JSON.parse(dR); }catch{} }
    const mR = await callOpenAI(makeMessagingPrompt(row)); if(mR){ try{ messagingJSON=JSON.parse(mR); }catch{} }

    const wf = buildWorkflowJSON(row, industry, designerJSON, messagingJSON);
    res.status(200).json(wf);
  } catch (err) {
    res.status(500).json({ ok:false, error: String(err?.message || err) });
  }
};
