// /api/build.js — import-safe builder (CommonJS)
// Uses only Function/Manual/If/Switch/Split nodes to avoid vendor param pitfalls.
// Two lanes (Prod + Demo), vertical channel fan + horizontal per-channel steps, wide spacing.
// Unique names + variable-based connects + strict sanitizer.

const fetch = global.fetch;

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Preview, X-Debug",
  "Content-Type": "application/json; charset=utf-8",
};

// -------- helpers --------
const toObj = (header,row)=>Object.fromEntries(header.map((h,i)=>[h,(row[i]??"").toString().trim()]));
const listify = (v)=>Array.isArray(v)?v.map(s=>String(s||'').trim()).filter(Boolean):String(v||'').split(/[;,/|\n]+/).map(s=>s.trim()).filter(Boolean);
const safeLower = (v)=>String(v||'').toLowerCase();
const uid = (p)=>`${p}_${Math.random().toString(36).slice(2,10)}`;
const pos = (x,y)=>[x,y];

// -------- demo seeds --------
const DEMO = {
  to: "+34613030526",
  emailTo: "kevanm.spain@gmail.com",
  waFrom: "+14155238886",
  smsFrom: "+13412184164",
  callFrom: "+13412184164",
};

// -------- layout (extra wide & spaced) --------
const LAYOUT = {
  laneGap: 2600,
  stepX: 480,
  channelGap: 340,
  prodHeader: { x: -2000, y: 60 },
  prodStart:  { x: -1800, y: 420 },
  demoHeader: { x: -2000, y: 60 },
  demoStart:  { x: -1800, y: 420 },
  switchX: -560,
};
const GUIDE = { showWaypoints:true, numberSteps:true };

// -------- n8n primitives (safe set) --------
function baseWorkflow(name){
  return { name, nodes:[], connections:{}, active:false, settings:{}, staticData:{}, __yOffset:0 };
}
function addNode(wf,node){
  if(Array.isArray(node.position)){ node.position=[node.position[0], node.position[1]+(wf.__yOffset||0)]; }
  // enforce minimal fields now to avoid undefined later
  if (!node.name) node.name = `Node ${wf.nodes.length+1}`;
  if (!node.type) {
    node.type = "n8n-nodes-base.function";
    node.typeVersion = 2;
    node.parameters = { functionCode: "return [$json];" };
  }
  if (!Array.isArray(node.position) || node.position.length !== 2) {
    node.position = [-1200, 300 + wf.nodes.length * 60];
  }
  wf.nodes.push(node);
  return node.name;
}
function connect(wf, fromName, toName, outputIndex=0){
  if (!fromName || !toName) return;
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
function addFunction(wf,name,code,x,y){
  return addNode(wf,{ id:uid("func"), name, type:"n8n-nodes-base.function", typeVersion:2, position:pos(x,y), parameters:{ functionCode: code || "return [$json];" }});
}
function addIf(wf,name,left,op,right,x,y){
  return addNode(wf,{ id:uid("if"), name, type:"n8n-nodes-base.if", typeVersion:2, position:pos(x,y),
    parameters:{ conditions:{ number:[], string:[{ value1:left||"={{$json.ok}}", operation:op||"equal", value2:right??"" }] } }});
}
function addSwitch(wf,name,valueExpr,rules,x,y){
  const r = Array.isArray(rules) && rules.length ? rules : [{ operation:"equal", value2:"main" }];
  return addNode(wf,{ id:uid("switch"), name, type:"n8n-nodes-base.switch", typeVersion:2, position:pos(x,y),
    parameters:{ value1:valueExpr || "={{'main'}}", rules: r }});
}
function addSplit(wf,x,y,size=25){
  return addNode(wf,{ id:uid("split"), name:"Split In Batches", type:"n8n-nodes-base.splitInBatches", typeVersion:1, position:pos(x,y), parameters:{ batchSize:size }});
}
function addArrow(wf,label,x,y){
  const nm = GUIDE.showWaypoints ? `➡️ ${label}` : label;
  return addFunction(wf, nm, "return [$json];", x, y);
}
function uniqueName(base, suffix){ return `${base} — ${suffix}`; }

// placeholder for anything “external” (HTTP/Email/SMS/WA/Call/CRM/etc.)
function addExternalStep(wf, label, x, y){
  return addFunction(wf, `[${label}]`, "return [$json];", x, y);
}
function addCollector(wf,x,y){
  return addFunction(wf,"Collector (Inspect)",`
const now=new Date().toISOString();
const arr=Array.isArray(items)?items:[{json:$json}];
return arr.map((it,i)=>({json:{...it.json,__collected_at:now,index:i}}));`,x,y);
}

// -------- classifier & channels (safe) --------
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

// -------- optional LLM (kept, but *not required* for import safety) --------
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
- branches: array of branch objects { id, steps:[{name,kind}] }
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

// -------- lane builder (channels vertical → steps horizontal; all placeholders) --------
function buildLane(wf, scenario, messaging, designer, { yOffset, isDemo }){
  const channels = Array.isArray(designer?.channels)&&designer.channels.length ? designer.channels : deriveChannels(scenario);

  withYOffset(wf, yOffset, ()=>{
    addHeader(
      wf,
      isDemo ? "DEMO LANE (Manual Trigger + Seeds)" : "PRODUCTION LANE",
      isDemo?LAYOUT.demoHeader.x:LAYOUT.prodHeader.x,
      isDemo?LAYOUT.demoHeader.y:LAYOUT.prodHeader.y
    );

    const trig = isDemo
      ? addManual(wf, LAYOUT.demoStart.x, LAYOUT.demoStart.y, "Demo Manual Trigger")
      : addManual(wf, LAYOUT.prodStart.x, LAYOUT.prodStart.y, "Manual Trigger (Prod)");

    const w1 = addArrow(wf, "Start → Init", (isDemo?LAYOUT.demoStart.x:LAYOUT.prodStart.x)+Math.floor(LAYOUT.stepX/2), LAYOUT.prodStart.y);
    connect(wf, trig, w1);

    const init = addFunction(
      wf,
      isDemo? "Init Demo Context":"Init Context",
      `
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
      (isDemo?LAYOUT.demoStart.x:LAYOUT.prodStart.x)+LAYOUT.stepX,
      LAYOUT.prodStart.y
    );
    connect(wf, w1, init);

    const enterBranch = addArrow(wf, "Init → Branch", LAYOUT.switchX - 120, LAYOUT.prodStart.y);
    connect(wf, init, enterBranch);

    const sw = addSwitch(wf, "Branch", "={{$json.__branch || 'main'}}", [{operation:"equal",value2:"main"}], LAYOUT.switchX, LAYOUT.prodStart.y);
    connect(wf, enterBranch, sw);

    let stepNo = 0;
    const enterMain = addFunction(
      wf,
      GUIDE.numberSteps?`[${++stepNo}] Enter: main`:"Enter: main",
      "return [{...$json,__branch:'main'}];",
      LAYOUT.prodStart.x + 4*LAYOUT.stepX,
      LAYOUT.prodStart.y
    );
    connect(wf, sw, enterMain, 0);

    // fan vertically by channel, then horizontal steps for each
    const chBaseY = LAYOUT.prodStart.y - Math.floor(LAYOUT.channelGap * (Math.max(channels.length,1)-1)/2);
    const chStartX = LAYOUT.prodStart.x + 6*LAYOUT.stepX;

    const collectors=[];
    channels.forEach((ch, idx)=>{
      const channel = String(ch||'email').toLowerCase();
      const cy = chBaseY + idx*LAYOUT.channelGap;

      const fan = addArrow(wf, `main → ${channel.toUpperCase()}`, chStartX - Math.floor(LAYOUT.stepX/2), cy);
      connect(wf, enterMain, fan);

      const compose = addFunction(
        wf,
        uniqueName("Compose", channel.toUpperCase()),
        `
const msg = $json.msg || {};
let body = '';
let subject = $json.scenario?.agent_name ? \`\${$json.scenario.agent_name} — \${$json.scenario.scenario_id||''}\` : ($json.scenario?.scenario_id||'AI Workflow');
if('${channel}'==='email'){ body = msg.email?.body || $json.message || 'Hello from the workflow.'; subject = msg.email?.subject || subject; }
else if('${channel}'==='sms'){ body = msg.sms || $json.message || 'Quick update.'; }
else if('${channel}'==='whatsapp'){ body = msg.whatsapp || $json.message || 'Heads up.'; }
else if('${channel}'==='call'){ body = msg.call || $json.message || 'Talk track.'; }
return [{...$json, message: body, subject }];`,
        chStartX,
        cy
      );
      connect(wf, fan, compose);

      const send = addExternalStep(wf, `${channel.toUpperCase()} Send`, chStartX + LAYOUT.stepX, cy);
      connect(wf, compose, send);

      const after = addArrow(wf, "→", chStartX + Math.floor(1.5*LAYOUT.stepX), cy);
      connect(wf, send, after);

      const wait = addFunction(wf, uniqueName("Wait / Listen", channel.toUpperCase()), "return [$json];", chStartX + 2*LAYOUT.stepX, cy);
      connect(wf, after, wait);

      const route = addIf(wf, uniqueName("Positive Reply?", channel.toUpperCase()), "={{$json.reply || ''}}", "notEmpty", "", chStartX + 3*LAYOUT.stepX, cy);
      connect(wf, wait, route);

      const posN = addExternalStep(wf, `${channel.toUpperCase()} → Log/Update (OK)`, chStartX + 4*LAYOUT.stepX, cy - 60);
      connect(wf, route, posN, 0);

      const negN = addExternalStep(wf, `${channel.toUpperCase()} → Log/Update (Retry/Nurture)`, chStartX + 4*LAYOUT.stepX, cy + 60);
      connect(wf, route, negN, 1);

      const join = addArrow(wf, "→", chStartX + 4.6*LAYOUT.stepX, cy);
      connect(wf, posN, join);
      connect(wf, negN, join);

      const col = addCollector(wf, chStartX + 5.2*LAYOUT.stepX, cy);
      connect(wf, join, col);
      collectors.push(col);
    });

    for(let i=0;i<collectors.length-1;i++){ connect(wf, collectors[i], collectors[i+1]); }
  });
}

// -------- workflow build --------
function buildWorkflowJSON(row, industry, designerJSON, messagingJSON){
  const name = `${row.scenario_id || 'Scenario'} — ${industry?.name || industry?.industry_id || 'Industry'}`;
  const wf = baseWorkflow(name);

  buildLane(wf, row, messagingJSON, designerJSON, { yOffset:0, isDemo:false });
  buildLane(wf, row, messagingJSON, designerJSON, { yOffset:LAYOUT.laneGap, isDemo:true });

  return sanitizeWorkflow(wf);
}

// -------- strong sanitizer --------
function sanitizeWorkflow(wf){
  const SAFE_TYPE = "n8n-nodes-base.function";
  const byName=new Map();

  // fix nodes
  wf.nodes = (wf.nodes||[]).map((n,i)=>{
    if(!n || typeof n !== 'object') n = {};
    if(!n.name || typeof n.name !== 'string') n.name = `Node ${i+1}`;
    if(!n.type || typeof n.type !== 'string'){ n.type = SAFE_TYPE; n.typeVersion = 2; }
    if(!n.parameters || typeof n.parameters !== 'object'){
      n.parameters = n.type === SAFE_TYPE ? { functionCode: "return [$json];" } : {};
    }
    if(!Array.isArray(n.position) || n.position.length!==2){
      n.position = [-1200, 300 + i * 80];
    }
    byName.set(n.name, n);
    return n;
  });

  // fix connections (drop any link to missing nodes)
  const fixed = {};
  for(const [from, obj] of Object.entries(wf.connections || {})){
    if(!byName.has(from)) continue;
    const main = Array.isArray(obj?.main) ? obj.main : [];
    const newMain = main.map(arr => Array.isArray(arr)
      ? arr.filter(l => l && typeof l.node === 'string' && byName.has(l.node))
      : []);
    fixed[from] = { main: newMain };
  }
  wf.connections = fixed;
  return wf;
}

// -------- sheets fetch --------
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

// -------- handler --------
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

    // LLM is optional; import safety does not rely on it
    let designerJSON=null, messagingJSON=null;
    const dPrompt = makeDesignerPrompt(row); const dResp = await callOpenAI(dPrompt);
    if (dResp) { try{ designerJSON = JSON.parse(dResp); } catch{} }
    const mPrompt = makeMessagingPrompt(row); const mResp = await callOpenAI(mPrompt);
    if (mResp) { try{ messagingJSON = JSON.parse(mResp); } catch{} }

    const wf = buildWorkflowJSON(row, industry, designerJSON, messagingJSON);
    res.status(200).json(wf);
  } catch (err) {
    res.status(500).json({ ok:false, error: String(err?.message || err) });
  }
};
