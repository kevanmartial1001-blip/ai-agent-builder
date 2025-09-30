// public/builder.js
// Ultra-compatible builder: ONLY core, legacy-safe nodes
// manualTrigger v1, set v1, if v1, function v1
// ASCII names only, no credentials, tags: []

(function () {
  "use strict";

  // ------- Layout -------
  const L = { START_X: -860, ROW_PROD_Y: 240, ROW_DEMO_Y: 620 };
  const SPAN = 280;      // fixed horizontal gap between nodes
  const LANE_GAP_Y = 180; // vertical gap between YES / NO lanes

  // ------- Utils -------
  const uid = (p)=>`${p}_${Math.random().toString(36).slice(2,10)}`;
  const pos = (x,y)=>[x,y];
  const oneline = (v)=> v==null ? "" : Array.isArray(v) ? v.map(oneline).filter(Boolean).join(" | ") : (typeof v==="object" ? JSON.stringify(v) : String(v));
  const esc = (s)=> oneline(s).replace(/"/g,'\\"');

  function baseWorkflow(name){
    return {
      name,
      nodes: [],
      connections: {},
      active: false,
      settings: { executionOrder: "v1", timezone: "Europe/Madrid" },
      staticData: {},
      tags: [],
      pinData: {}
    };
  }
  function addNode(wf,node){ wf.nodes.push(node); return node.name; }
  function connect(wf,from,to,idx=0){
    wf.connections[from]??={}; wf.connections[from].main??=[];
    for(let i=wf.connections[from].main.length;i<=idx;i++) wf.connections[from].main[i]=[];
    wf.connections[from].main[idx].push({ node: to, type: "main", index: 0 });
  }

  // ------- Core palette (legacy-safe) -------
  function nManual(x,y){
    return {
      id: uid('man'),
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: pos(x,y),
      parameters: {}
    };
  }
  function nSet(name, fields, x, y){
    return {
      id: uid('set'),
      name,
      type: 'n8n-nodes-base.set',
      typeVersion: 1,
      position: pos(x,y),
      parameters: {
        keepOnlySet: false,
        values: { string: Object.entries(fields||{}).map(([k,v])=>({ name:k, value: v })) }
      }
    };
  }
  function nIf(name, expr, x, y){
    // IF node with a single boolean rule on "value1"
    return {
      id: uid('if'),
      name,
      type: 'n8n-nodes-base.if',
      typeVersion: 1,
      position: pos(x,y),
      parameters: {
        conditions: {
          boolean: [
            { value1: expr, value2: true }
          ]
        }
      }
    };
  }
  function nFn(name, js, x, y){
    // legacy Function node (NOT the newer Code node)
    return {
      id: uid('fn'),
      name,
      type: 'n8n-nodes-base.function',
      typeVersion: 1,
      position: pos(x,y),
      parameters: { functionCode: js }
    };
  }

  // ------- Stubs (no HTTP, no external deps) -------
  const JS_CONTEXT =
`// Build a small context object from scenario fields (stub; no network)
const scenario = $json.scenario || {};
const industry = $json.industry || {};
const ctx = {
  intent: "Automate: " + (scenario.name || scenario.id || "Scenario"),
  industry: industry.id || "generic",
  constraints: [],
  success: "End user reaches the intended outcome",
  channels_ranked: ["whatsapp","email","sms","call"],
  guardrails: ["no spam", "respect opt-out"]
};
return [{ context: ctx }];`;

  const JS_PLANNER =
`// Build a simple plan with two branches: yes and no
const plan = {
  trigger: { kind: "manual", why: "safe import" },
  archetype: { name: "custom", confidence: 0.5 },
  branches: [
    { key: "yes", title: "Yes path", steps: [
      { id:"s1", title:"Step 1 Compose", type:"send_message", channel:"whatsapp", tool:"Twilio", params:{ body:"Hello on WhatsApp" } },
      { id:"s2", title:"Step 2 Check",   type:"check_data",  channel:"none",     tool:"",       params:{ check:"profile" } },
      { id:"s3", title:"Step 3 Execute", type:"wait",        channel:"none",     tool:"",       params:{ seconds: 1 } }
    ]},
    { key: "no", title: "No path", steps: [
      { id:"s1", title:"Step 1 Compose Fallback", type:"send_message", channel:"email", tool:"MAILING", params:{ subject:"We are here", body:"Reply anytime." } },
      { id:"s2", title:"Step 2 Check",            type:"check_data",  channel:"none",  tool:"",        params:{ check:"reason" } },
      { id:"s3", title:"Step 3 Execute",          type:"wait",        channel:"none",  tool:"",        params:{ seconds: 1 } }
    ]}
  ]
};
return [{ plan }];`;

  const JS_PICK_BRANCH =
`// choose yes by default (you can change logic here)
const plan = $json.plan || {};
const yesBranch = (plan.branches || []).find(b => b.key==='yes') || { steps: [] };
const noBranch  = (plan.branches || []).find(b => b.key==='no')  || { steps: [] };
// emit booleans for the IF node to read
return [{ isYes: true, yesBranch, noBranch }];`;

  const JS_STEP_AGENT =
`// Echo back the provided step as the "agent" output (stub)
const step = $json.__step || { id:'s', title:'Step', type:'send_message', channel:'email', tool:'MAILING', params:{} };
return [{ action: step }];`;

  const JS_RUNNER =
`// Simulate execution only
const a = $json.action || {};
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function exec(){
  switch(String(a.type||'').toLowerCase()){
    case 'send_message': return { ok:true, channel:a.channel||'none', tool:a.tool||'', payload: a.params||{} };
    case 'check_data':   return { ok:true, check: a.params||{} };
    case 'wait':         await wait((a.params && a.params.seconds ? a.params.seconds : 1)*200); return { ok:true, waited: a.params?.seconds||1 };
    default:             return { ok:true, noop:true };
  }
}
return exec().then(r => [{ ...$json, exec: r }]);`;

  const JS_REC(label) =
`const hist = Array.isArray($json.history) ? $json.history : [];
hist.push({ step: "${label}", action: $json.action, result: $json.exec });
return [{ ...$json, history: hist }];`;

  // ------- Backbone (per row) -------
  function addBackbone(wf, scenario, industry, y, modeLabel){
    const x0 = L.START_X;

    const n0 = nManual(x0, y);
    addNode(wf, n0);

    const n1 = nSet(`Init (${modeLabel})`, {
      'scenario.id': `={{'${esc(scenario?.scenario_id)}'}}`,
      'scenario.name': `={{'${esc(scenario?.name)}'}}`,
      'industry.id': `={{'${esc(industry?.industry_id)}'}}`
    }, x0 + SPAN, y); addNode(wf, n1); connect(wf, n0.name, n1.name);

    const nCtx = nFn(`Context Agent (${modeLabel})`, JS_CONTEXT, x0 + SPAN*2, y); addNode(wf, nCtx); connect(wf, n1.name, nCtx.name);

    const nPlan = nFn(`Schema Planner (${modeLabel})`, JS_PLANNER, x0 + SPAN*3, y); addNode(wf, nPlan); connect(wf, nCtx.name, nPlan.name);

    const nPick = nFn(`Pick Branch (${modeLabel})`, JS_PICK_BRANCH, x0 + SPAN*4, y); addNode(wf, nPick); connect(wf, nPlan.name, nPick.name);

    // IF node routes: output 0 = true (Yes), output 1 = false (No)
    const nIfRoute = nIf(`Route Branch (${modeLabel})`, "={{$json.isYes}}", x0 + SPAN*5, y);
    addNode(wf, nIfRoute); connect(wf, nPick.name, nIfRoute.name);

    return { branchIf: nIfRoute, pickNode: nPick };
  }

  // ------- Lane (YES or NO): 3 steps, each as Function nodes only -------
  function addLane(wf, startX, baseY, branchKey, prefixLabel){
    const title = branchKey === 'yes' ? 'YES' : 'NO';

    const enter = nFn(`Enter ${title}`, 
`// Bring branch steps into scope
const branch = $json.${branchKey==='yes' ? 'yesBranch' : 'noBranch'} || { steps: [] };
return [{ ...$json, __branchKey: '${branchKey}', __steps: branch.steps || [] }];`, 
      startX, baseY);
    addNode(wf, enter);

    function addStep(i, label){
      const draft = nFn(`Step ${i} Draft (${title})`,
`const steps = $json.__steps || [];
const s = steps[${i-1}] || { id:'s${i}', title: '${label}', type: 'send_message', channel: 'email', tool: 'MAILING', params:{} };
return [{ ...$json, __step: s }];`,
        startX + SPAN*(1 + (i-1)*4), baseY);
      addNode(wf, draft);

      const agent = nFn(`Step ${i} Agent (${title})`, JS_STEP_AGENT, startX + SPAN*(2 + (i-1)*4), baseY); addNode(wf, agent);
      connect(wf, draft.name, agent.name);

      const run = nFn(`Run Step ${i} (${title})`, JS_RUNNER, startX + SPAN*(3 + (i-1)*4), baseY); addNode(wf, run);
      connect(wf, agent.name, run.name);

      const rec = nFn(`Record Step ${i} (${title})`, JS_REC(`Step ${i} ${label} (${title})`), startX + SPAN*(4 + (i-1)*4), baseY); addNode(wf, rec);
      connect(wf, run.name, rec.name);

      return { in: draft, out: rec };
    }

    const s1 = addStep(1, branchKey==='yes' ? 'Compose / Reach out' : 'Compose Fallback');
    const s2 = addStep(2, 'Check / Decision');
    const s3 = addStep(3, 'Execute');

    return { enter, tail: s3.out };
  }

  // ------- Main build -------
  function buildWorkflowJSON(scenario, industry, opts = {}){
    const title = `${oneline(scenario?.scenario_id)||'Scenario'} — ${oneline(scenario?.name)||''}`.trim();
    const wf = baseWorkflow(title);

    // PROD row
    const prod = addBackbone(wf, scenario, industry, L.ROW_PROD_Y, 'PROD');
    // DEMO row (identical skeleton)
    const demo = addBackbone(wf, scenario, industry, L.ROW_DEMO_Y, 'DEMO');

    function wireRow(backbone, rowY){
      const startX = L.START_X + SPAN*7;
      const yesLane = addLane(wf, startX, rowY + 0*LANE_GAP_Y, 'yes', 'Yes path');
      const noLane  = addLane(wf, startX, rowY + 1*LANE_GAP_Y, 'no',  'No path');

      // IF: output 0 (true) -> yes; output 1 (false) -> no
      connect(wf, backbone.branchIf.name, yesLane.enter.name, 0);
      connect(wf, backbone.branchIf.name,  noLane.enter.name, 1);
    }

    wireRow(prod, L.ROW_PROD_Y);
    wireRow(demo, L.ROW_DEMO_Y);

    wf.staticData.__design = {
      notes: [
        'Only core nodes: manualTrigger v1, set v1, if v1, function v1.',
        'ASCII names; no custom nodes; no HTTP; no credentials.',
        'Two rows (PROD/DEMO), two lanes (YES/NO), three steps per lane.'
      ],
      layout: { span: SPAN, laneGapY: LANE_GAP_Y, rows: { prod: L.ROW_PROD_Y, demo: L.ROW_DEMO_Y } }
    };

    return wf;
  }

  window.Builder = { buildWorkflowJSON };
})();
