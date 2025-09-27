// /api/build.js  (CommonJS, Vercel Node runtime)
// Deep, per-scenario builder (Prod + Demo lanes, wide layout, vertical channel fan).
// Optional LLM calls via OPENAI_API_KEY. If the LLM fails or is missing, we fall back deterministically.
// Requires: templates/n8n.json.ejs (not used anymore; we return JSON directly).

const fetch = global.fetch; // Node 18+ on Vercel
const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Preview, X-Debug",
  "Content-Type": "application/json; charset=utf-8",
};

// ---------- Helpers ----------
const toObj = (header,row)=>Object.fromEntries(header.map((h,i)=>[h,(row[i]??"").toString().trim()]));
const listify = (v)=>Array.isArray(v)?v.map(s=>String(s||'').trim()).filter(Boolean):String(v||'').split(/[;,/|\n]+/).map(s=>s.trim()).filter(Boolean);

// Safety: never call toLowerCase on undefined
const safeLower = (v)=>String(v||'').toLowerCase();

// ---------- Demo seeds ----------
const DEMO = {
  to: "+34613030526",
  emailTo: "kevanm.spain@gmail.com",
  waFrom: "+14155238886",
  smsFrom: "+13412184164",
  callFrom: "+13412184164",
};

// ---------- Layout (wide & readable) ----------
const LAYOUT = {
  laneGap: 2200,      // distance between PROD and DEMO lanes
  stepX: 420,         // horizontal step width
  channelGap: 260,    // vertical gap between channels in the vertical fan
  prodHeader: { x: -1600, y: 40 },
  prodStart:  { x: -1400, y: 320 },
  demoHeader: { x: -1600, y: 40 },
  demoStart:  { x: -1400, y: 320 },
  switchX: -480,
};
const GUIDE = { showWaypoints:true, numberSteps:true };

// ---------- n8n builder primitives ----------
const uid = (p)=>`${p}_${Math.random().toString(36).slice(2,10)}`;
const pos = (x,y)=>[x,y];

function baseWorkflow(name){
  return { name, nodes:[], connections:{}, active:false, settings:{}, staticData:{}, __yOffset:0 };
}
function addNode(wf,node){
  if(Array.isArray(node.position)){ node.position=[node.position[0], node.position[1]+(wf.__yOffset||0)]; }
  wf.nodes.push(node); return node.name;
}
function connect(wf,from,to,outputIndex=0){
  wf.connections[from]??={}; wf.connections[from].main??=[];
  for(let i=wf.connections[from].main.length;i<=outputIndex;i++) wf.connections[from].main[i]=[];
  wf.connections[from].main[outputIndex].push({ node:to, type:"main", index:0 });
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
function addCron(wf,label,x,y){ // placeholder cron to keep imports simple
  return addNode(wf,{ id:uid("cron"), name:label, type:"n8n-nodes-base.function", typeVersion:2, position:pos(x,y), parameters:{ functionCode:"return [$json];" }});
}
function addWebhook(wf,label,x,y){ // placeholder webhook
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
  return addNode(wf,{ id:uid("switch"), name, type:"n8n-nodes-base.switch", typeVersion:2, position:pos(x,y), parameters:{ value1:valueExpr, rules }});
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
  if(channel==='email'){
    return addNode(wf,{ id:uid("email"), name: demo?"[Send  Email] (Demo)":"[Send  Email]", type:"n8n-nodes-base.function", typeVersion:2, position:pos(x,y), parameters:{ functionCode:"return [$json];" } });
  }
  if(channel==='sms'){ return addFunction(wf, demo?"[Send  SMS] (Demo)":"[Send  SMS]","return [$json];", x,y); }
  if(channel==='whatsapp'){ return addFunction(wf, demo?"[Send  WhatsApp] (Demo)":"[Send  WhatsApp]","return [$json];", x,y); }
  if(channel==='call'){ return addFunction(wf, demo?"[Place Call] (Demo)":"[Place Call]","return [$json];", x,y); }
  return addFunction(wf, "Send (Unknown)", "return [$json];", x,y);
}

// Make the JSON safe to import even if names/types/positions are weird
function sanitizeWorkflow(wf){
  const REQUIRED="n8n-nodes-base.function";
  const nameCounts={}; const byName=new Map();
  wf.nodes=(wf.nodes||[]).map((n,i)=>{
    if(!n.name||typeof n.name!=='string') n.name=`Node ${i+1}`;
    const k=n.name.toLowerCase(); nameCounts[k]=(nameCounts[k]||0); if(nameCounts[k]++) n.name=`${n.name} #${nameCounts[k]}`;
    if(!n.type||typeof n.type!=='string'){ n.type=REQUIRED; n.typeVersion=2; n.parameters={ functionCode:"return [$json];" }; }
    if(!Array.isArray(n.position)||n.position.length!==2){ n.position=[-1200, 300+(i*40)]; }
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

// ---------- Classifier & Channels ----------
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

// ---------- LLM (optional) ----------
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
    const txt = data?.choices?.[0]?.message?.content || "";
    return txt;
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
  kinds can be one of: ["lookup","compose","send","wait","route","update","log","approval","create_po","kb_search","ticket","calendar","score","assign","report","etl_extract","etl_transform","etl_load","notify"]
- errors: array of { when, action }
Keep it concise but realistic to the context. JSON only.

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
    system: "You write natural, human-sounding omni-channel outreach and service copy. Output strict JSON only.",
    user:
`Write short, natural copy for email, sms, whatsapp, and a call talk-track for this context.
Include keys: { "email": {subject,body}, "sms": body, "whatsapp": body, "call": script }.
Keep it concise, friendly, and specific to the scenario (no 'press 1'). JSON only.

context:
${ctx}`
  };
}

// ---------- Build per-lane (vertical channels, horizontal steps) ----------
function buildLane(wf, scenario, messaging, designer, { yOffset, isDemo }){
  const channels = Array.isArray(designer?.channels)&&designer.channels.length ? designer.channels : deriveChannels(scenario);
  const branches = Array.isArray(designer?.branches)&&designer.branches.length ? designer.branches : [{ id:"main", steps:[{ name:"Compose", kind:"compose"}]}];

  withYOffset(wf, yOffset, ()=>{
    addHeader(wf, isDemo ? "DEMO LANE (Manual Trigger + Seeds)" : "PRODUCTION LANE",
      isDemo?LAYOUT.demoHeader.x:LAYOUT.prodHeader.x,
      isDemo?LAYOUT.demoHeader.y:LAYOUT.prodHeader.y);

    // Triggers
    const trig = isDemo ? addManual(wf, LAYOUT.demoStart.x, LAYOUT.demoStart.y, "Demo Manual Trigger")
                        : designer?.trigger === "cron"    ? addCron(wf,"Cron (from designer)", LAYOUT.prodStart.x, LAYOUT.prodStart.y)
                        : designer?.trigger === "webhook" ? addWebhook(wf,"Webhook (from designer)", LAYOUT.prodStart.x, LAYOUT.prodStart.y)
                        : designer?.trigger === "imap"    ? addFunction(wf,"IMAP Intake (Placeholder)","return [$json];", LAYOUT.prodStart.x, LAYOUT.prodStart.y)
                        : addManual(wf, LAYOUT.prodStart.x, LAYOUT.prodStart.y, "Manual Trigger");

    // Init context
    const w1 = addArrow(wf, "Start → Init", (isDemo?LAYOUT.demoStart.x:LAYOUT.prodStart.x)+Math.floor(LAYOUT.stepX/2), LAYOUT.prodStart.y);
    connect(wf, trig, w1);

    const init = addFunction(wf, isDemo? "Init Demo Context":"Init Context", `
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
    connect(wf, w1, init);

    // One branch switch (we still keep branches extensible)
    const w2 = addArrow(wf, "Init → Branch", LAYOUT.switchX - 120, LAYOUT.prodStart.y);
    connect(wf, init, w2);
    const branchRules = branches.map((b)=>({ operation:"equal", value2:String(b.id||'main') }));
    const sw = addSwitch(wf, "Branch", "={{$json.__branch || 'main'}}", branchRules.length?branchRules:[{operation:"equal",value2:"main"}], LAYOUT.switchX, LAYOUT.prodStart.y);
    connect(wf, w2, sw);

    // For now, drive all branches into main (extensible later per-branch)
    const rowY = LAYOUT.prodStart.y;
    let stepNo = 0;
    let prev = addFunction(wf, GUIDE.numberSteps?`[${++stepNo}] Enter: main`:"Enter: main", "return [{...$json,__branch:'main'}];", LAYOUT.prodStart.x + 4*LAYOUT.stepX, rowY);
    connect(wf, sw, prev, 0);

    // Vertical channel fan from "prev", then each channel horizontal steps
    const chBaseY = rowY - Math.floor(LAYOUT.channelGap * (Math.max(channels.length,1)-1)/2);
    const chStartX = LAYOUT.prodStart.x + 6*LAYOUT.stepX;

    const collectors=[];
    channels.forEach((ch, idx)=>{
      const channel = String(ch||'email').toLowerCase();
      const cy = chBaseY + idx*LAYOUT.channelGap;

      const enterCh = addArrow(wf, `Branch → ${channel.toUpperCase()}`, chStartX - Math.floor(LAYOUT.stepX/2), cy);
      connect(wf, prev, enterCh);

      // Compose (use messaging when available)
      const compose = addFunction(wf, GUIDE.numberSteps?`[${++stepNo}] Compose (${channel.toUpperCase()})`:`Compose (${channel.toUpperCase()})`, `
const msg = $json.msg || {};
let body = '';
let subject = $json.scenario?.agent_name ? \`\${$json.scenario.agent_name} — \${$json.scenario.scenario_id||''}\` : ($json.scenario?.scenario_id||'AI Workflow');
if('${channel}'==='email'){ body = msg.email?.body || $json.message || 'Hello from the demo workflow.'; subject = msg.email?.subject || subject; }
else if('${channel}'==='sms'){ body = msg.sms || $json.message || 'Quick update from the demo workflow.'; }
else if('${channel}'==='whatsapp'){ body = msg.whatsapp || $json.message || 'Heads up from the demo workflow.'; }
else if('${channel}'==='call'){ body = msg.call || $json.message || 'Talk track for the demo call.'; }
return [{...$json, message: body, subject }];`, chStartX, cy);
      connect(wf, enterCh, compose);

      const send = makeSenderNode(wf, channel, chStartX + LAYOUT.stepX, cy, !!isDemo);
      connect(wf, compose, send);

      const after = addArrow(wf, "→", chStartX + Math.floor(1.5*LAYOUT.stepX), cy);
      connect(wf, send, after);

      const wait = addFunction(wf, "Wait / Listen", "return [$json];", chStartX + 2*LAYOUT.stepX, cy);
      connect(wf, after, wait);

      const route = addIf(wf, "Positive Reply?", "={{$json.reply || ''}}", "notEmpty", "", chStartX + 3*LAYOUT.stepX, cy);
      connect(wf, wait, route);

      const posN = addFunction(wf, "Handle Positive", "return [$json];", chStartX + 4*LAYOUT.stepX, cy - 40);
      connect(wf, route, posN, 0);
      const posLog = addHTTP(wf, "Log/Update (OK)", "={{'https://example.com/ok'}}", "={{$json}}", chStartX + 5*LAYOUT.stepX, cy - 40);
      connect(wf, "Handle Positive", posLog);

      const negN = addFunction(wf, "Handle Neutral/No-Reply", "return [$json];", chStartX + 4*LAYOUT.stepX, cy + 40);
      connect(wf, route, negN, 1);
      const negLog = addHTTP(wf, "Log/Update (Retry/Nurture)", "={{'https://example.com/nurture'}}", "={{$json}}", chStartX + 5*LAYOUT.stepX, cy + 40);
      connect(wf, "Handle Neutral/No-Reply", negLog);

      const join = addArrow(wf, "→", chStartX + 5.5*LAYOUT.stepX, cy);
      connect(wf, posLog, join); connect(wf, negLog, join);

      const col = addCollector(wf, chStartX + 6*LAYOUT.stepX, cy);
      connect(wf, join, col);
      collectors.push(col);
    });

    // link collectors to make one visible trail
    for(let i=0;i<collectors.length-1;i++){ connect(wf, collectors[i], collectors[i+1]); }
  });
}

// ---------- Main builder ----------
function buildWorkflowJSON(row, industry, designerJSON, messagingJSON){
  const name = `${row.scenario_id || 'Scenario'} — ${industry?.name || industry?.industry_id || 'Industry'}`;
  const wf = baseWorkflow(name);

  // Build PROD lane (top)
  buildLane(wf, row, messagingJSON, designerJSON, { yOffset:0, isDemo:false });

  // Build DEMO lane (bottom)
  buildLane(wf, row, messagingJSON, designerJSON, { yOffset:LAYOUT.laneGap, isDemo:true });

  return sanitizeWorkflow(wf);
}

// ---------- Sheets fetch ----------
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
  // Normalize
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

// ---------- Handler ----------
module.exports = async (req, res) => {
  Object.entries(HEADERS).forEach(([k,v])=>res.setHeader(k,v));
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const debugHeader = req.headers["x-debug"] || "";
    const wantDebug = /1|true/i.test(String(debugHeader)) || /debug=1/.test(req.url||"");

    if (req.method !== "POST") {
      return res.status(200).json({ ok:true, usage:'POST {"scenario_id":"<id>"}  (optional: {"compat":"safe","includeDemo":true})' });
    }

    // Parse body
    const body = await new Promise(resolve => {
      const chunks = [];
      req.on("data", c=>chunks.push(c));
      req.on("end", ()=>{
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

    // Fetch row
    const row = await fetchScenarioRow({ sheetId: SHEET_ID, tab: SHEET_TAB, apiKey: GOOGLE_API_KEY, wanted });
    if(!row) return res.status(404).json({ ok:false, error:`scenario_id not found: ${wanted}` });

    // Industry is currently the "name" column (you can swap to /api/industries if needed)
    const industry = { name: row.name, industry_id: safeLower(row.name).replace(/\s+/g,'_') };

    // LLM: Designer (trigger/channels/branches/errors)
    let designerJSON = null;
    const dPrompt = makeDesignerPrompt(row);
    const dResp = await callOpenAI({ system:dPrompt.system, user:dPrompt.user, model:"gpt-4o-mini" });
    if (dResp) {
      try { designerJSON = JSON.parse(dResp); } catch {}
    }

    // LLM: Messaging (email/sms/wa/call copy)
    let messagingJSON = null;
    const mPrompt = makeMessagingPrompt(row);
    const mResp = await callOpenAI({ system:mPrompt.system, user:mPrompt.user, model:"gpt-4o-mini" });
    if (mResp) {
      try { messagingJSON = JSON.parse(mResp); } catch {}
    }

    // Build JSON directly
    const wf = buildWorkflowJSON(row, industry, designerJSON, messagingJSON);

    res.status(200).json(wf);
  } catch (err) {
    res.status(500).json({ ok:false, error: String(err?.message || err) });
  }
};
