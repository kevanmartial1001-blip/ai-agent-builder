// public/builder.js
// SAFE builder: imports on any n8n. Uses only core nodes (Manual, Set, Code, Switch) with typeVersion=1.
// ASCII names; no credentials; no resource locators; no headers; no emojis.
// Visual structure preserved: Context -> Planner -> Switch -> YES/NO lanes (3 steps each).
// Flip SAFE_MODE=false to enable a fuller HTTP/OpenAI build later.

(function () {
  "use strict";

  // ---- Global toggle ----
  const SAFE_MODE = true; // keep true until your import works; then we can switch to HTTP/OpenAI version.

  // ---- Layout (fixed rails, no overlaps) ----
  const L = { HEADER_X: -900, HEADER_Y: 40, ROW_PROD_Y: 240, ROW_DEMO_Y: 720, START_X: -860 };
  const G = { SPAN: 300, LANE_GAP_Y: 220, AFTER_SWITCH_SPANS: 2, BLOCK_SPAN: 4 }; // fixed gaps horizontally

  // ---- Utils ----
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
  function uniqueName(wf, base){
    const exists = new Set((wf.nodes||[]).map(n=>String(n.name||"").toLowerCase()));
    let nm = base || "Node", i=1;
    while (exists.has(nm.toLowerCase())) { i++; nm = `${base} #${i}`; }
    return nm;
  }
  function addNode(wf, node){
    node.name = uniqueName(wf, node.name);
    wf.nodes.push(node);
    return node.name;
  }
  function connect(wf, from, to, idx=0){
    wf.connections[from] ??= {};
    wf.connections[from].main ??= [];
    for (let i=wf.connections[from].main.length; i<=idx; i++) wf.connections[from].main[i] = [];
    wf.connections[from].main[idx].push({ node: to, type: "main", index: 0 });
  }

  // ---- Basic palette (all typeVersion=1, ASCII names) ----
  const label = (wf, txt, x, y)=> addNode(wf, {
    id: uid('lbl'), name: `=== ${txt} ===`,
    type: 'n8n-nodes-base.set', typeVersion: 1, position: pos(x,y),
    parameters: { keepOnlySet: false, values: { string: [{ name: '__zone', value: `={{'${txt}'}}` }] } }
  });
  const manual = (wf, x, y)=> addNode(wf, {
    id: uid('man'), name: 'Manual Trigger',
    type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: pos(x,y), parameters: {}
  });
  const setNode = (wf, name, fields, x, y)=> addNode(wf, {
    id: uid('set'), name,
    type: 'n8n-nodes-base.set', typeVersion: 1, position: pos(x,y),
    parameters: { keepOnlySet: false, values: { string: Object.entries(fields||{}).map(([k,v])=>({ name:k, value:v })) } }
  });
  const codeNode = (wf, name, js, x, y)=> addNode(wf, {
    id: uid('code'), name,
    type: 'n8n-nodes-base.code', typeVersion: 1, position: pos(x,y),
    parameters: { jsCode: js }
  });
  const switchNode = (wf, name, expr, values, x, y)=> addNode(wf, {
    id: uid('sw'), name,
    type: 'n8n-nodes-base.switch', typeVersion: 1, position: pos(x,y),
    parameters: { value1: expr, rules: values.map(v=>({ operation: 'equal', value2: String(v) })) }
  });

  // ---- Safe JSON validators (no external deps) ----
  const VALIDATE_CONTEXT = `
const raw = $json && $json.contextRaw;
let out = {};
try { out = typeof raw==='string' ? JSON.parse(raw) : (raw || {}); } catch(e) { throw new Error('Context JSON invalid'); }
if (typeof out !== 'object' || Array.isArray(out)) throw new Error('Context must be an object');
return [ { context: out } ];
  `.trim();

  const VALIDATE_PLAN = `
const raw = $json && $json.planRaw;
let out = {};
try { out = typeof raw==='string' ? JSON.parse(raw) : (raw || {}); } catch(e) { throw new Error('Plan JSON invalid'); }
if (!out || !Array.isArray(out.branches)) out.branches = [{ key:'yes', title:'Yes path', steps:[] },{ key:'no', title:'No path', steps:[] }];
return [ { plan: out } ];
  `.trim();

  const VALIDATE_STEP = `
const raw = $json && $json.stepRaw;
let out = {};
try { out = typeof raw==='string' ? JSON.parse(raw) : (raw || {}); } catch(e) { throw new Error('Step JSON invalid'); }
if (!out || !out.action) out.action = { id:'step', title:'Step', type:'send_message', channel:'email', tool:'MAILING', params:{} };
return [ { ...$json, action: out.action } ];
  `.trim();

  // ---- Safe stubs for "LLM" agents (pure Code nodes producing JSON) ----
  function stubContext(scenario, industry) {
    const ctx = {
      intent: "Automate scenario: " + oneline(scenario?.name || scenario?.scenario_id || "Scenario"),
      industry: oneline(industry?.industry_id || "generic"),
      constraints: [],
      success: "User reaches the intended outcome",
      channels_ranked: ["whatsapp","email","sms","call"],
      guardrails: ["no spam", "respect opt-out"]
    };
    return JSON.stringify(ctx);
  }
  function stubPlan() {
    const plan = {
      trigger: { kind: "manual", why: "Safe import mode" },
      archetype: { name: "custom", confidence: 0.5 },
      branches: [
        { key: "yes", title: "Yes path", why: "Positive intent",
          steps: [
            { id:"s1", title:"Step 1 - Compose message", type:"send_message", channel:"whatsapp", tool:"Twilio", params:{ body:"Hello! This is a demo WhatsApp." } },
            { id:"s2", title:"Step 2 - Check data",      type:"check_data",  channel:"none",     tool:"",       params:{ check:"profile" } },
            { id:"s3", title:"Step 3 - Execute",         type:"http",        channel:"none",     tool:"HTTP",   params:{ url:"", method:"POST", body:{ ok:true } } }
          ]
        },
        { key: "no", title: "No path", why: "Negative intent",
          steps: [
            { id:"s1", title:"Step 1 - Compose fallback", type:"send_message", channel:"email", tool:"MAILING", params:{ subject:"We are here", body:"Reply anytime." } },
            { id:"s2", title:"Step 2 - Check data",       type:"check_data",  channel:"none",  tool:"",        params:{ check:"reason" } },
            { id:"s3", title:"Step 3 - Execute",          type:"wait",        channel:"none",  tool:"",        params:{ seconds: 3 } }
          ]
        }
      ],
      errors: [],
      tools_suggested: ["Twilio","HTTP","Mailing"]
    };
    return JSON.stringify(plan);
  }
  function stubStep(branchKey, stepIndex, plan) {
    // echo back the plan step as the "agent output"
    const branch = (plan && Array.isArray(plan.branches) ? plan.branches : []).find(b => b.key === branchKey);
    const draft = branch && branch.steps && branch.steps[stepIndex-1] ? branch.steps[stepIndex-1] : {
      id: `s${stepIndex}`, title:`Step ${stepIndex}`, type:"send_message", channel:"email", tool:"MAILING", params:{ body:"Hello" }
    };
    return JSON.stringify({ action: draft, notes: [] });
  }

  // ---- Runner & Recorder (pure Code) ----
  const RUNNER = `
const a = $json.action || {};
const mode = $json.__mode || 'prod';
function demoFill(p){
  const out = { ...(p||{}) };
  if (!out.to && (a.channel==='whatsapp'||a.channel==='sms'||a.channel==='call')) out.to = '+34613030526';
  if (!out.to && a.channel==='email') out.to = 'kevanm.spain@gmail.com';
  if (a.channel==='whatsapp') out.from = out.from || '+14155238886';
  if (a.channel==='sms' || a.channel==='call') out.from = out.from || '+13412184164';
  return out;
}
async function exec(){
  switch (String(a.type||'').toLowerCase()){
    case 'send_message': return { ok:true, channel:a.channel||'none', tool:a.tool||'', payload: mode==='demo' ? demoFill(a.params) : (a.params||{}) };
    case 'place_call':   return { ok:true, channel:'call', tool:a.tool||'', payload: mode==='demo' ? demoFill(a.params) : (a.params||{}) };
    case 'check_data':   return { ok:true, check: a.params||{} };
    case 'wait':         await new Promise(r=>setTimeout(r, (a.params?.seconds||2)*1000)); return { ok:true, waited: a.params?.seconds||2 };
    case 'http':         return { ok:true, simulated: true, url: a.params?.url||'', method: a.params?.method||'POST', body: a.params?.body||{} };
    default:             return { ok:true, noop:true };
  }
}
return exec().then(r => [{ ...$json, __exec:r }]);
  `.trim();

  const RECORDER = (label, lane, mode)=>`
const hist = Array.isArray($json.__history) ? $json.__history : [];
hist.push({ step: '${label}', lane: '${lane}', mode: '${mode}', action: $json.action, result: $json.__exec });
return [{ ...$json, __history: hist }];
  `.trim();

  // ---- Backbone per row (Context -> Planner -> Switch) ----
  function addBackbone(wf, scenario, industry, y, mode){
    const t0 = manual(wf, L.START_X, y);

    const init = setNode(wf, `Init (${mode.toUpperCase()})`, {
      'scenario.id': `={{'${esc(scenario?.scenario_id)}'}}`,
      'scenario.name': `={{'${esc(scenario?.name)}'}}`,
      'industry.id': `={{'${esc(industry?.industry_id)}'}}`,
      '__mode': `={{'${mode}'}}`
    }, L.START_X + G.SPAN, y);
    connect(wf, t0, init);

    // Context "agent" (stub)
    const ctxStub = codeNode(wf, `Context Agent (${mode})`,
      `return [{ contextRaw: ${JSON.stringify(stubContext(scenario, industry))} }];`,
      L.START_X + G.SPAN*2, y);
    const ctxVal = codeNode(wf, `Context JSON Validator (${mode})`, VALIDATE_CONTEXT, L.START_X + G.SPAN*3, y);
    connect(wf, init, ctxStub);
    connect(wf, ctxStub, ctxVal);

    // Planner "agent" (stub)
    const planStub = codeNode(wf, `Schema Planner (${mode})`,
      `return [{ planRaw: ${JSON.stringify(stubPlan())} }];`,
      L.START_X + G.SPAN*4, y);
    const planVal = codeNode(wf, `Plan JSON Validator (${mode})`, VALIDATE_PLAN, L.START_X + G.SPAN*5, y);
    connect(wf, ctxVal, planStub);
    connect(wf, planStub, planVal);

    // Pack (make both context+plan accessible to lanes)
    const pack = codeNode(wf, `Pack Context+Plan (${mode})`,
      `return [{ __context: $items(0,0).json.context, __plan: $items(1,0).json.plan, __mode: '${mode}' }];`,
      L.START_X + G.SPAN*6, y);
    connect(wf, planVal, pack);

    // Switch with exactly 2 outputs: yes (0), no (1)
    const sw = switchNode(wf, `Route Branch (${mode})`, "={{'yes'}}", ["yes","no"], L.START_X + G.SPAN*7, y);
    connect(wf, pack, sw);

    return { switchName: sw };
  }

  // ---- One Lane (YES or NO): 3 visible steps, each as Agent -> Validator -> Runner -> Recorder ----
  function addLane(wf, startX, baseY, branchKey, scenario, mode){
    const enter = codeNode(wf, `Enter ${branchKey.toUpperCase()} (${mode})`,
      `return [{ ...$json, __branchKey: '${branchKey}' }];`,
      startX, baseY);

    // Agent groups
    const baseX0 = startX + G.SPAN;
    const y = baseY;

    function addStep(idx, labelText){
      const stepDraft = codeNode(wf, `Step ${idx} Draft (${branchKey}, ${mode})`,
        `const plan = $json.__plan || {};
return [{ stepRaw: ${JSON.stringify(stubStep(branchKey, idx, null))} }];`,
        baseX0 + G.SPAN*G.BLOCK_SPAN*(idx-1) + G.SPAN*0, y);

      const validate = codeNode(wf, `Step ${idx} JSON Validator (${branchKey}, ${mode})`,
        VALIDATE_STEP,
        baseX0 + G.SPAN*G.BLOCK_SPAN*(idx-1) + G.SPAN*1, y);

      const run = codeNode(wf, `Run Step ${idx} (${branchKey}, ${mode})`,
        RUNNER,
        baseX0 + G.SPAN*G.BLOCK_SPAN*(idx-1) + G.SPAN*2, y);

      const rec = codeNode(wf, `Record Step ${idx} (${branchKey}, ${mode})`,
        RECORDER(`Step ${idx} - ${labelText}`, branchKey, mode),
        baseX0 + G.SPAN*G.BLOCK_SPAN*(idx-1) + G.SPAN*3, y);

      connect(wf, stepDraft, validate);
      connect(wf, validate, run);
      connect(wf, run, rec);
      return { in: stepDraft, out: rec };
    }

    const g1 = addStep(1, branchKey === 'yes' ? 'Compose/Reach out' : 'Compose fallback');
    const g2 = addStep(2, 'Check/Decision');
    const g3 = addStep(3, 'Execute');

    connect(wf, enter, g1.in);
    connect(wf, g1.out, g2.in);
    connect(wf, g2.out, g3.in);

    const done = setNode(wf, `Lane Done (${branchKey.toUpperCase()}, ${mode.toUpperCase()})`, { [`__lane_${branchKey}_${mode}`]: '={{true}}' }, baseX0 + G.SPAN*G.BLOCK_SPAN*3 + G.SPAN, y);
    connect(wf, g3.out, done);

    return { enter, done };
  }

  // ---- Build everything ----
  function buildWorkflowJSON(scenario, industry, opts = {}){
    const title = `${oneline(scenario?.scenario_id)||'Scenario'} — ${oneline(scenario?.name)||''}`.trim();
    const wf = baseWorkflow(title);

    label(wf, 'FLOW PROD',  L.HEADER_X, L.HEADER_Y);
    label(wf, 'FLOW DEMO',  L.HEADER_X, L.HEADER_Y + (L.ROW_DEMO_Y - L.ROW_PROD_Y));

    // Backbones
    const prod = addBackbone(wf, scenario, industry, L.ROW_PROD_Y, 'prod');
    const demo = addBackbone(wf, scenario, industry, L.ROW_DEMO_Y, 'demo');

    // Build lanes for each row
    function buildRow(rowY, switchName, mode){
      const startX = L.START_X + G.SPAN*(7 + G.AFTER_SWITCH_SPANS);
      const yesLane = addLane(wf, startX, rowY + 0*G.LANE_GAP_Y, 'yes', scenario, mode);
      const noLane  = addLane(wf, startX, rowY + 1*G.LANE_GAP_Y, 'no',  scenario, mode);
      connect(wf, switchName, yesLane.enter, 0);
      connect(wf, switchName, noLane.enter,  1);
    }

    buildRow(L.ROW_PROD_Y, prod.switchName, 'prod');
    buildRow(L.ROW_DEMO_Y, demo.switchName, 'demo');

    wf.staticData.__design = {
      layout: { span:G.SPAN, blockSpan:G.BLOCK_SPAN, laneGapY:G.LANE_GAP_Y, rows:{prod:L.ROW_PROD_Y, demo:L.ROW_DEMO_Y} },
      safeMode: SAFE_MODE,
      notes: [
        'SAFE mode: only core nodes, typeVersion=1, ASCII names. Should import on any n8n.',
        'Visual backbone preserved. Replace stub Code nodes with real HTTP/OpenAI when ready.'
      ]
    };

    return wf;
  }

  window.Builder = { buildWorkflowJSON };
})();
