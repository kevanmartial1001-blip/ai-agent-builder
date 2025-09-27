// /api/build.js — Rich LLM-structured workflow, import-safe (Function-only)
// Visuals: Prod lane (top), Demo lane (bottom). Branch swimlanes, channels vertical, steps horizontal.
// Uses only Manual Trigger + Function nodes (no If/Switch/HTTP/etc.) to avoid import issues.

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

// ---------- layout (wide, spaced, readable) ----------
const LAYOUT = {
  laneGapY: 3000,       // distance between PROD and DEMO lanes
  stepX: 520,           // horizontal distance between steps
  channelGapY: 360,     // vertical gap between channels under a branch
  branchGapY: 640,      // vertical gap between branches
  leftX: -2200,         // far left X
  entryX: -1700,        // where manual starts
  headerY: 60,
  baseY: 420,           // common Y baseline
};

function baseWorkflow(name){
  return { name, nodes:[], connections:{}, active:false, settings:{}, staticData:{}, __y:0, __names:new Set() };
}

// sanitize to ASCII & unique
function safeName(wf, raw){
  const ascii = String(raw||'')
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g,'')
    .replace(/\s+/g,' ')
    .replace(/[^\w\s\-().]/g,'')
    .trim() || 'Node';
  let name = ascii, n = 1;
  while (wf.__names.has(name)) { n++; name = `${ascii} ${n}`; }
  wf.__names.add(name);
  return name;
}

function addNode(wf, node){
  const name = safeName(wf, node.name || 'Node');
  const out = {
    id: node.id || `node_${Math.random().toString(36).slice(2,10)}`,
    name,
    type: "n8n-nodes-base.function",
    typeVersion: 2,
    position: Array.isArray(node.position)&&node.position.length===2
      ? [node.position[0], node.position[1] + wf.__y]
      : [LAYOUT.leftX, LAYOUT.baseY + wf.nodes.length*80 + wf.__y],
    parameters: { functionCode: node.parameters?.functionCode || "return [$json];" }
  };
  wf.nodes.push(out);
  return out.name;
}

function connect(wf, from, to){
  if(!from || !to) return;
  wf.connections[from] ??= { main: [[]] };
  if(!Array.isArray(wf.connections[from].main)) wf.connections[from].main=[[]];
  wf.connections[from].main[0].push({ node: to, type: "main", index: 0 });
}

function withYOffset(wf,y,fn){ const prev=wf.__y; wf.__y=y; try{ fn(); } finally { wf.__y=prev; } }

// primitives
function addHeader(wf,label,x,y){ return addNode(wf,{ name:`=== ${label} ===`, position:pos(x,y) }); }
function addManual(wf,x,y,label){ return addNode(wf,{ name: label||"Manual Trigger", position:pos(x,y) }); }
function addFn(wf,name,code,x,y){ return addNode(wf,{ name, position:pos(x,y), parameters:{ functionCode: code||"return [$json];" } }); }
function addArrow(wf,label,x,y){ return addFn(wf,label,"return [$json];",x,y); }
function addExternalStep(wf,label,x,y){ return addFn(wf, `[${label}]`, "return [$json];", x,y); }

// ---------- LLM helpers ----------
async function callOpenAI({ system, user, model }){
  const key = process.env.OPENAI_API_KEY;
  if(!key) return null;
  try{
    const r = await fetch("https://api.openai.com/v1/chat/completions",{
      method:"POST",
      headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${key}` },
      body: JSON.stringify({
        model: model || "gpt-4o-mini",
        temperature: 0.35,
        messages:[{role:"system",content:system},{role:"user",content:user}]
      })
    });
    if(!r.ok) return null;
    const data = await r.json();
    return data?.choices?.[0]?.message?.content || null;
  }catch{ return null; }
}

function makeDesignerPrompt(row){
  const ctx = JSON.stringify({
    scenario_id: row.scenario_id,
    name: row.name,
    agent_name: row.agent_name,
    triggers: row.triggers,
    best_reply_shapes: row.best_reply_shapes,
    risk_notes: row.risk_notes,
    how_it_works: row.how_it_works,
    tool_stack_dev: row.tool_stack_dev,
    roi_hypothesis: row.roi_hypothesis,
    tags: row.tags
  }, null, 2);

  return {
    system: "You are a senior solutions architect for business automations using n8n. Output JSON only.",
    user:
`From the context below, design a robust workflow spec with these keys:
{
  "trigger": "manual" | "cron" | "webhook" | "imap",
  "channels": ["email"|"sms"|"whatsapp"|"call", ...],    // preferred order
  "branches": [
    {
      "id": "main" | "alt" | "vip" | ...,
      "label": "Short label for the branch",
      "steps": [
        { "name": "Human readable step name", "kind": "fetch|compose|decide|update|notify|wait|route|external|transform|log|error|end", "detail": "short description" }
      ]
    }
  ],
  "errors": [
    { "when": "where the error can happen", "action": "fallback or corrective action" }
  ]
}

Guidelines:
- Make branches exhaustive enough to be useful (2–4 typical branches per scenario).
- Steps should be concise and specific to this scenario and industry.
- Include realistic step names and detail, not placeholders.

Context:
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
    system: "You write natural, human-sounding omni-channel copy. Output JSON only.",
    user:
`Write concise, human copy for:
{ "email": { "subject": "...", "body": "..." }, "sms": "....", "whatsapp": "....", "call": "...." }

Style: friendly, professional, scenario-specific. Use the context:

${ctx}`
  };
}

// ---------- channels ----------
function deriveChannelsFallback(s){
  const shapes=listify(s.best_reply_shapes||[]);
  const out=[]; const map=[['whatsapp',/whatsapp/i],['sms',/(sms|text)/i],['call',/(voice|call)/i],['email',/email/i]];
  for(const sh of shapes){ for(const [k,rx] of map){ if(rx.test(sh) && !out.includes(k)) out.push(k); } }
  return out.length?out:['email','sms','email'];
}

// ---------- core rendering (branch swimlanes → channels vertical → steps horizontal) ----------
function renderLane(wf, row, designer, messaging, { isDemo, yStart }){
  withYOffset(wf, yStart, ()=>{

    // Header + Trigger + Init
    addHeader(wf, isDemo ? "DEMO LANE (Manual Trigger + Seeds)" : "PRODUCTION LANE", LAYOUT.leftX, LAYOUT.headerY);

    const trig = addManual(wf, LAYOUT.entryX, LAYOUT.baseY, isDemo ? "Demo Manual Trigger" : "Manual Trigger");
    const toInit = addArrow(wf, "Start -> Init", LAYOUT.entryX + Math.floor(LAYOUT.stepX/2), LAYOUT.baseY); connect(wf, trig, toInit);

    const init = addFn(wf, isDemo ? "Init Demo Context" : "Init Context", `
const seed=${JSON.stringify(DEMO)};
const scenario=${JSON.stringify({
  scenario_id: row.scenario_id || '',
  agent_name: row.agent_name || '',
  name: row.name || '',
  triggers: row.triggers || '',
  roi_hypothesis: row.roi_hypothesis || ''
})};
const msg=${JSON.stringify(messaging||{})};
const d = ${isDemo ? "{...seed, scenario, msg, demo:true}" : "{...$json, scenario, msg}"};
return [d];`, LAYOUT.entryX + LAYOUT.stepX, LAYOUT.baseY);
    connect(wf, toInit, init);

    const toBranches = addArrow(wf, "Init -> Branching", LAYOUT.entryX + 2*LAYOUT.stepX, LAYOUT.baseY);
    connect(wf, init, toBranches);

    // Branch list (from LLM or fallback)
    const branches = Array.isArray(designer?.branches) && designer.branches.length
      ? designer.branches
      : [{ id:"main", label:"Main Path", steps:[
          { name:"Prepare Data",   kind:"transform", detail:"Normalize and enrich scenario fields" },
          { name:"Compose Message", kind:"compose", detail:"Channel-aware message from context" },
          { name:"Update System",   kind:"external", detail:"Log/update status in external system" },
          { name:"End",             kind:"end", detail:"Finish branch" }
        ] }];

    // Channels preference (LLM or fallback)
    const channels = Array.isArray(designer?.channels)&&designer.channels.length
      ? designer.channels.map(s=>String(s||'').toLowerCase())
      : deriveChannelsFallback(row);

    // For each branch → a block; inside each block → channels vertical
    let branchTopY = LAYOUT.baseY - Math.floor((branches.length-1)*LAYOUT.branchGapY/2);
    const branchBlocks = [];

    branches.forEach((br, bi)=>{
      const brY = branchTopY + bi*LAYOUT.branchGapY;
      const brLabel = addFn(wf, `Branch: ${br.label || br.id || ('branch_'+(bi+1))}`, "return [$json];", LAYOUT.entryX + 3*LAYOUT.stepX, brY);
      connect(wf, toBranches, brLabel);

      // channels vertical fan
      const chBaseY = brY - Math.floor((channels.length-1)*LAYOUT.channelGapY/2);
      const chStartX = LAYOUT.entryX + 4*LAYOUT.stepX;

      const collectors=[];
      channels.forEach((ch, ci)=>{
        const chY = chBaseY + ci*LAYOUT.channelGapY;

        const toCh = addArrow(wf, `to ${ch.toUpperCase()}`, chStartX - Math.floor(LAYOUT.stepX/2), chY);
        connect(wf, brLabel, toCh);

        // Step chain horizontally for this channel
        // We will map LLM steps -> labeled Function nodes
        const steps = Array.isArray(br.steps)&&br.steps.length ? br.steps : [{name:"Compose Message",kind:"compose",detail:"Default message"},{name:"Send",kind:"external",detail:"Send via provider"},{name:"Wait",kind:"wait",detail:"Listen for reply"},{name:"Route Outcome",kind:"route",detail:"Positive or Neutral"},{name:"Update",kind:"external",detail:"Log/Update"},{name:"End",kind:"end",detail:"Finish"}];

        let prev = toCh;
        steps.forEach((st, si)=>{
          const title = `${(si+1).toString().padStart(2,'0')} ${st.name || 'Step'}`;
          const detail = st.detail ? `// ${String(st.detail).replace(/\n/g,' ')}` : '';
          const code = `
${detail}
const step = ${JSON.stringify({ kind: st.kind||'step', channel: ch, branch: br.id||('branch_'+(bi+1)) })};
return [{...$json, __step: step}];`;
          const node = addFn(wf, `${title} (${ch.toUpperCase()})`, code, chStartX + si*LAYOUT.stepX, chY);
          connect(wf, prev, node);
          prev = node;

          // add tiny arrow between steps for readability
          if (si < steps.length-1) {
            const arrow = addArrow(wf, "->", chStartX + si*LAYOUT.stepX + Math.floor(LAYOUT.stepX/2), chY);
            connect(wf, prev, arrow);
            prev = arrow;
          }
        });

        const collect = addFn(wf, "Collector", `
const now=new Date().toISOString();
return [{...$json, __collected_at: now}];`, chStartX + steps.length*LAYOUT.stepX + 80, chY);
        connect(wf, prev, collect);
        collectors.push(collect);
      });

      // join collectors (chain them so importer shows a connected path)
      for(let i=0;i<collectors.length-1;i++){ connect(wf, collectors[i], collectors[i+1]); }

      branchBlocks.push({ head: brLabel, tail: collectors.at(-1) || brLabel });
    });

    // Chain branches (visual itinerary across branches)
    for(let i=0;i<branchBlocks.length-1;i++){
      connect(wf, branchBlocks[i].tail, branchBlocks[i+1].head);
    }

    // Errors block (from LLM)
    if (Array.isArray(designer?.errors) && designer.errors.length){
      const errHead = addFn(wf, "Errors / Fallbacks", "return [$json];", LAYOUT.entryX + 3*LAYOUT.stepX, LAYOUT.baseY + branches.length*LAYOUT.branchGapY/2 + 240);
      // link from last branch tail to errors for a clean, readable end
      connect(wf, (branchBlocks.at(-1)?.tail)||toBranches, errHead);

      let prev = errHead;
      designer.errors.forEach((er, ei)=>{
        const eNode = addFn(wf, `On: ${er.when || ('case_'+(ei+1))}`, `// action: ${er.action||'n/a'}\nreturn [$json];`, LAYOUT.entryX + (4+ei)*LAYOUT.stepX, LAYOUT.baseY + branches.length*LAYOUT.branchGapY/2 + 240);
        connect(wf, prev, eNode);
        prev = eNode;
      });
    }
  });
}

// ---------- sanitizer ----------
function sanitizeWorkflow(wf){
  const byName = new Map();
  wf.nodes = (wf.nodes||[]).map((n,i)=>{
    const out = {
      id: n.id || `node_${i}_${Math.random().toString(36).slice(2,8)}`,
      name: typeof n.name==='string' ? n.name : `Node ${i+1}`,
      type: "n8n-nodes-base.function",
      typeVersion: 2,
      position: Array.isArray(n.position)&&n.position.length===2 ? n.position : [LAYOUT.leftX, LAYOUT.baseY + i*80],
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

  wf.name = (wf.name||'Workflow').replace(/[^\x20-\x7E]/g,'').trim();
  return wf;
}

// ---------- build ----------
function buildWorkflowJSON(row, designerJSON, messagingJSON){
  const wf = baseWorkflow(`${row.scenario_id || 'Scenario'} — ${row.name || 'Industry'}`);

  // PROD lane (top)
  renderLane(wf, row, designerJSON, messagingJSON, { isDemo:false, yStart: 0 });
  // DEMO lane (bottom)
  renderLane(wf, row, designerJSON, messagingJSON, { isDemo:true,  yStart: LAYOUT.laneGapY });

  return sanitizeWorkflow(wf);
}

// ---------- sheets ----------
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

// ---------- handler ----------
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

    // LLM calls
    const [dResp, mResp] = await Promise.all([
      callOpenAI(makeDesignerPrompt(row)),
      callOpenAI(makeMessagingPrompt(row)),
    ]);

    let designerJSON=null, messagingJSON=null;
    if (dResp) { try { designerJSON = JSON.parse(dResp); } catch {} }
    if (mResp) { try { messagingJSON = JSON.parse(mResp); } catch {} }

    const wf = buildWorkflowJSON(row, designerJSON, messagingJSON);
    res.status(200).json(wf);
  } catch (err) {
    res.status(500).json({ ok:false, error:String(err?.message||err) });
  }
};
