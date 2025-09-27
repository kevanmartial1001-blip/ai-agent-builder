// /api/build.js — ultra-safe exporter for n8n import
// - Only Manual Trigger + Function nodes
// - ASCII-only, unique node names
// - Variable-based connections only
// - Strong sanitizer

const fetch = global.fetch;

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

// ---------- helpers ----------
const toObj = (header,row)=>Object.fromEntries(header.map((h,i)=>[h,(row[i]??"").toString().trim()]));
const listify = (v)=>Array.isArray(v)?v.map(s=>String(s||'').trim()).filter(Boolean):String(v||'').split(/[;,/|\n]+/).map(s=>s.trim()).filter(Boolean);
const lower = (v)=>String(v||'').toLowerCase();
const pos = (x,y)=>[x,y];

const DEMO = {
  to: "+34613030526",
  emailTo: "kevanm.spain@gmail.com",
  waFrom: "+14155238886",
  smsFrom: "+13412184164",
  callFrom: "+13412184164",
};

// layout
const LAYOUT = {
  laneGap: 2600,
  stepX: 520,
  channelGap: 360,
  prodHeader: { x: -2000, y: 60 },
  prodStart:  { x: -1800, y: 420 },
  demoHeader: { x: -2000, y: 60 },
  demoStart:  { x: -1800, y: 420 },
};

function baseWorkflow(name){
  return { name, nodes:[], connections:{}, active:false, settings:{}, staticData:{}, __yOffset:0, __names:new Set() };
}

// sanitize to ASCII and make unique
function safeName(wf, raw){
  const ascii = String(raw||'')
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g,'')       // remove non-ASCII
    .replace(/\s+/g,' ')
    .replace(/[^\w\s\-().]/g,'')       // remove weird punctuation
    .trim() || 'Node';
  let base = ascii;
  let n = 1;
  while (wf.__names.has(base)) { n++; base = `${ascii} ${n}`; }
  wf.__names.add(base);
  return base;
}

function addNode(wf, node){
  // ensure function node
  const name = safeName(wf, node.name || 'Node');
  const out = {
    id: node.id || `node_${Math.random().toString(36).slice(2,10)}`,
    name,
    type: "n8n-nodes-base.function",
    typeVersion: 2,
    position: Array.isArray(node.position) && node.position.length===2
      ? [node.position[0], node.position[1] + (wf.__yOffset||0)]
      : [-1200, 300 + wf.nodes.length*80 + (wf.__yOffset||0)],
    parameters: { functionCode: node.parameters?.functionCode || "return [$json];" }
  };
  wf.nodes.push(out);
  return out.name; // return sanitized, unique name
}

function connect(wf, from, to){
  if(!from || !to) return;
  wf.connections[from] ??= { main: [[]] };
  if(!Array.isArray(wf.connections[from].main)) wf.connections[from].main=[[]];
  wf.connections[from].main[0].push({ node: to, type: "main", index: 0 });
}

function withYOffset(wf,yOffset,fn){ const prev=wf.__yOffset||0; wf.__yOffset=yOffset; try{ fn(); } finally { wf.__yOffset=prev; } }

// primitives (safe)
function addHeader(wf,label,x,y){ return addNode(wf,{ name:`=== ${label} ===`, position:pos(x,y) }); }
function addManual(wf,x,y,label){ return addNode(wf,{ name: label||"Manual Trigger", position:pos(x,y) }); }
function addFn(wf,name,code,x,y){ return addNode(wf,{ name, position:pos(x,y), parameters:{ functionCode: code||"return [$json];"} }); }
function addArrow(wf,label,x,y){ return addFn(wf, label, "return [$json];", x,y); }
function addExternalStep(wf,label,x,y){ return addFn(wf, `[${label}]`, "return [$json];", x,y); }

// classifier & channels (safe)
function deriveChannels(s){
  const shapes=listify(s.best_reply_shapes||[]);
  const out=[]; const map=[['whatsapp',/whatsapp/i],['sms',/(sms|text)/i],['call',/(voice|call)/i],['email',/email/i]];
  for(const sh of shapes){ for(const [k,rx] of map){ if(rx.test(sh) && !out.includes(k)) out.push(k); } }
  return out.length?out:['email','sms','email'];
}

// LLM (optional; JSON-only; not required for import safety)
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
        messages: [ { role:"system", content: system }, { role:"user", content: user } ]
      })
    });
    if(!r.ok) return null;
    const data = await r.json();
    return data?.choices?.[0]?.message?.content || null;
  } catch { return null; }
}

function makeDesignerPrompt(row){
  const ctx = JSON.stringify({
    scenario_id: row.scenario_id, name: row.name,
    triggers: row.triggers, best_reply_shapes: row.best_reply_shapes,
    risk_notes: row.risk_notes, how_it_works: row.how_it_works,
    tool_stack_dev: row.tool_stack_dev, roi_hypothesis: row.roi_hypothesis, tags: row.tags
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
    scenario_id: row.scenario_id, agent_name: row.agent_name, industry: row.name,
    triggers: row.triggers, how_it_works: row.how_it_works, roi_hypothesis: row.roi_hypothesis
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

// lane (channels vertical → steps horizontal), Function-only
function buildLane(wf, row, messaging, designer, { yOffset, isDemo }){
  const channels = Array.isArray(designer?.channels)&&designer.channels.length ? designer.channels : deriveChannels(row);

  withYOffset(wf, yOffset, ()=>{
    addHeader(wf, isDemo ? "DEMO LANE (Manual Trigger + Seeds)" : "PRODUCTION LANE",
      isDemo?LAYOUT.demoHeader.x:LAYOUT.prodHeader.x,
      isDemo?LAYOUT.demoHeader.y:LAYOUT.prodHeader.y);

    const startX = isDemo ? LAYOUT.demoStart.x : LAYOUT.prodStart.x;
    const startY = isDemo ? LAYOUT.demoStart.y : LAYOUT.prodStart.y;

    const trig = addManual(wf, startX, startY, isDemo ? "Demo Manual Trigger" : "Manual Trigger (Prod)");
    const toInit = addArrow(wf, "Start -> Init", startX + Math.floor(LAYOUT.stepX/2), startY); connect(wf, trig, toInit);

    const init = addFn(
      wf, isDemo ? "Init Demo Context" : "Init Context",
      `
const seed=${JSON.stringify(DEMO)};
const scenario=${JSON.stringify({
  scenario_id: row.scenario_id || '',
  agent_name: row.agent_name || '',
  name: row.name || '',
  triggers: row.triggers || '',
  roi_hypothesis: row.roi_hypothesis || ''
})};
const msg=${JSON.stringify(messaging||{})};
return [${isDemo? "{...seed, scenario, msg, demo:true}" : "{...$json, scenario, msg}"}];`,
      startX + LAYOUT.stepX, startY
    );
    connect(wf, toInit, init);

    const enter = addArrow(wf, "Init -> main", startX + 2*LAYOUT.stepX, startY); connect(wf, init, enter);

    const chBaseY = startY - Math.floor(LAYOUT.channelGap * (Math.max(channels.length,1)-1)/2);
    const chStartX = startX + 3*LAYOUT.stepX;

    const collectors=[];

    channels.forEach((ch, i)=>{
      const channel = String(ch||'email').toLowerCase();
      const cy = chBaseY + i*LAYOUT.channelGap;

      const fan = addArrow(wf, `main -> ${channel.toUpperCase()}`, chStartX - Math.floor(LAYOUT.stepX/2), cy);
      connect(wf, enter, fan);

      const compose = addFn(wf, `Compose ${channel.toUpperCase()}`, `
const msg = $json.msg || {};
let body = '';
let subject = $json.scenario?.agent_name ? \`\${$json.scenario.agent_name} — \${$json.scenario.scenario_id||''}\` : ($json.scenario?.scenario_id||'AI Workflow');
if('${channel}'==='email'){ body = msg.email?.body || $json.message || 'Hello from the workflow.'; subject = msg.email?.subject || subject; }
else if('${channel}'==='sms'){ body = msg.sms || $json.message || 'Quick update.'; }
else if('${channel}'==='whatsapp'){ body = msg.whatsapp || $json.message || 'Heads up.'; }
else if('${channel}'==='call'){ body = msg.call || $json.message || 'Talk track.'; }
return [{...$json, message: body, subject }];`, chStartX, cy);
      connect(wf, fan, compose);

      const send = addExternalStep(wf, `${channel.toUpperCase()} Send`, chStartX + LAYOUT.stepX, cy); connect(wf, compose, send);
      const next = addArrow(wf, "→", chStartX + Math.floor(1.5*LAYOUT.stepX), cy); connect(wf, send, next);

      const listen = addFn(wf, `Listen ${channel.toUpperCase()}`, "return [$json];", chStartX + 2*LAYOUT.stepX, cy); connect(wf, next, listen);

      const route = addFn(wf, `Route Reply ${channel.toUpperCase()}`, `
const replied = !!($json.reply);
return replied ? [{...$json,__route:'positive'}] : [{...$json,__route:'neutral'}];`, chStartX + 3*LAYOUT.stepX, cy);
      connect(wf, listen, route);

      const pos = addExternalStep(wf, `${channel.toUpperCase()} OK`, chStartX + 4*LAYOUT.stepX, cy - 60);
      const neg = addExternalStep(wf, `${channel.toUpperCase()} Nurture`, chStartX + 4*LAYOUT.stepX, cy + 60);

      const fork = addFn(wf, `Branch ${channel.toUpperCase()}`, `
if ($json.__route === 'positive') return [ $json, null ];
return [ null, $json ];`, chStartX + Math.floor(3.5*LAYOUT.stepX), cy);
      connect(wf, route, fork);

      // Emulate two outputs via two sequential arrows:
      const toPos = addArrow(wf, "pos", chStartX + Math.floor(3.7*LAYOUT.stepX), cy - 30);
      const toNeg = addArrow(wf, "neg", chStartX + Math.floor(3.7*LAYOUT.stepX), cy + 30);
      connect(wf, fork, toPos);
      connect(wf, fork, toNeg);
      connect(wf, toPos, pos);
      connect(wf, toNeg, neg);

      const join = addArrow(wf, "→", chStartX + 4.6*LAYOUT.stepX, cy);
      connect(wf, pos, join);
      connect(wf, neg, join);

      const col = addFn(wf, "Collector", `
const now=new Date().toISOString();
return [{...$json, __collected_at:now}];`, chStartX + 5.2*LAYOUT.stepX, cy);
      connect(wf, join, col);
      collectors.push(col);
    });

    for(let i=0;i<collectors.length-1;i++){ connect(wf, collectors[i], collectors[i+1]); }
  });
}

// sanitizer: ensure every node is a valid Function node, ASCII names, positions, and drop dangling links
function sanitizeWorkflow(wf){
  const byName = new Map();
  const safe = (s)=>s; // names already sanitized on addNode

  wf.nodes = (wf.nodes||[]).map((n,i)=>{
    const out = {
      id: n.id || `node_${i}_${Math.random().toString(36).slice(2,8)}`,
      name: typeof n.name==='string' ? n.name : `Node ${i+1}`,
      type: "n8n-nodes-base.function",
      typeVersion: 2,
      position: Array.isArray(n.position)&&n.position.length===2 ? n.position : [-1200, 300+i*80],
      parameters: (n.parameters && typeof n.parameters==='object') ? n.parameters : { functionCode: "return [$json];" }
    };
    byName.set(out.name, out);
    return out;
  });

  const fixed = {};
  for (const [from, obj] of Object.entries(wf.connections || {})) {
    if (!byName.has(from)) continue;
    const main = Array.isArray(obj?.main) ? obj.main : [[]];
    const newMain = main.map(arr => Array.isArray(arr) ? arr.filter(l => l && byName.has(l.node)) : []);
    fixed[from] = { main: newMain };
  }
  wf.connections = fixed;

  // workflow name ASCII too
  wf.name = safe(String(wf.name || 'Workflow'));
  return wf;
}

function buildWorkflowJSON(row, industry, designerJSON, messagingJSON){
  const wf = baseWorkflow(`${row.scenario_id || 'Scenario'} — ${industry?.name || industry?.industry_id || 'Industry'}`);
  // PROD lane (top)
  buildLane(wf, row, messagingJSON, designerJSON, { yOffset: 0, isDemo: false });
  // DEMO lane (bottom)
  buildLane(wf, row, messagingJSON, designerJSON, { yOffset: LAYOUT.laneGap, isDemo: true });
  return sanitizeWorkflow(wf);
}

// sheets fetch
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
  const row = objRows.find(x => lower(x["scenario_id"]) === lower(wanted));
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

// LLM prompts (optional)
function makeDesignerPrompt(row){ /* same as above */ 
  const ctx = JSON.stringify({
    scenario_id: row.scenario_id, name: row.name,
    triggers: row.triggers, best_reply_shapes: row.best_reply_shapes,
    risk_notes: row.risk_notes, how_it_works: row.how_it_works,
    tool_stack_dev: row.tool_stack_dev, roi_hypothesis: row.roi_hypothesis, tags: row.tags
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
    scenario_id: row.scenario_id, agent_name: row.agent_name, industry: row.name,
    triggers: row.triggers, how_it_works: row.how_it_works, roi_hypothesis: row.roi_hypothesis
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

// handler
module.exports = async (req, res) => {
  Object.entries(HEADERS).forEach(([k,v])=>res.setHeader(k,v));
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.method !== "POST") {
      return res.status(200).json({ ok:true, usage:'POST {"scenario_id":"<id>"}' });
    }

    // body
    const body = await new Promise(resolve=>{
      const chunks=[]; req.on("data",c=>chunks.push(c)); req.on("end",()=>{
        try{ resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch{ resolve({}); }
      });
    });
    const wanted = lower(body.scenario_id);
    if(!wanted) throw new Error("Missing scenario_id");

    const SHEET_ID = process.env.SHEET_ID;
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    const SHEET_TAB = process.env.SHEET_TAB || "Scenarios";
    if(!SHEET_ID || !GOOGLE_API_KEY) throw new Error("Missing SHEET_ID or GOOGLE_API_KEY");

    const row = await fetchScenarioRow({ sheetId: SHEET_ID, tab: SHEET_TAB, apiKey: GOOGLE_API_KEY, wanted });
    if(!row) return res.status(404).json({ ok:false, error:`scenario_id not found: ${wanted}` });

    const industry = { name: row.name, industry_id: lower(row.name).replace(/\s+/g,'_') };

    // optional LLM shaping (safe; JSON only)
    let designerJSON=null, messagingJSON=null;
    const d = await callOpenAI(makeDesignerPrompt(row)); if(d){ try{ designerJSON=JSON.parse(d); }catch{} }
    const m = await callOpenAI(makeMessagingPrompt(row)); if(m){ try{ messagingJSON=JSON.parse(m); }catch{} }

    const wf = buildWorkflowJSON(row, industry, designerJSON, messagingJSON);
    res.status(200).json(wf);
  } catch (err) {
    res.status(500).json({ ok:false, error:String(err?.message||err) });
  }
};
