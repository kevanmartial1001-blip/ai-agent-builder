// public/builder.js
// Ultra-safe builder: ONLY core nodes (manualTrigger v1, set v1, function v1, if v1).
// Unique node names (mode-suffixed + auto-dedupe), ASCII only, no HTTP.
// Visual layout: PROD row + DEMO row; each with YES / NO lanes and 3 AI-agent step blocks.

(function () {
  'use strict';

  // ---------- Helpers ----------
  function safe(v){ return (v===null || v===undefined) ? '' : String(v); }

  function createWorkflow(title){
    return {
      name: title || 'Scenario',
      nodes: [],
      connections: {},
      active: false,
      settings: { executionOrder: 'v1', timezone: 'Europe/Madrid' },
      staticData: {},
      tags: [],
      pinData: {}
    };
  }

  function uniqueName(wf, base){
    var baseName = safe(base);
    var n = baseName, i = 2;
    var names = new Set((wf.nodes||[]).map(function(n){return String(n.name||'');}));
    while (names.has(n)) { n = baseName + ' #' + i; i++; }
    return n;
  }

  function addNode(wf, node){
    node.name = uniqueName(wf, node.name);
    wf.nodes.push(node);
    return node.name;
  }

  function connect(wf, fromName, toName, outputIndex){
    var idx = typeof outputIndex === 'number' ? outputIndex : 0;
    wf.connections[fromName] = wf.connections[fromName] || {};
    wf.connections[fromName].main = wf.connections[fromName].main || [];
    while (wf.connections[fromName].main.length <= idx) wf.connections[fromName].main.push([]);
    wf.connections[fromName].main[idx].push({ node: toName, type: 'main', index: 0 });
  }

  // ---------- Node factories (typeVersion = 1 everywhere) ----------
  function nManual(name, x, y){
    return { id:'n_'+Math.random().toString(36).slice(2,10), name: name,
      type:'n8n-nodes-base.manualTrigger', typeVersion:1, position:[x,y], parameters:{} };
  }
  function nSet(name, fields, x, y){
    var strings=[], k;
    for(k in (fields||{})) if(Object.prototype.hasOwnProperty.call(fields,k)){
      strings.push({ name:k, value: safe(fields[k]) });
    }
    return { id:'n_'+Math.random().toString(36).slice(2,10), name:name,
      type:'n8n-nodes-base.set', typeVersion:1, position:[x,y],
      parameters:{ keepOnlySet:false, values:{ string: strings } } };
  }
  function nFunction(name, code, x, y){
    return { id:'n_'+Math.random().toString(36).slice(2,10), name:name,
      type:'n8n-nodes-base.function', typeVersion:1, position:[x,y],
      parameters:{ functionCode: code } };
  }
  function nIf(name, boolValue, x, y){
    return { id:'n_'+Math.random().toString(36).slice(2,10), name:name,
      type:'n8n-nodes-base.if', typeVersion:1, position:[x,y],
      parameters:{ conditions:{ boolean:[ { value1: !!boolValue, value2: true } ] } } };
  }

  // ---------- Function code (no HTTP; AI simulated) ----------
  var FC_CONTEXT =
"var scenario = $json.scenario || {};\\n" +
"var industry = $json.industry || {};\\n" +
"var ctx = {\\n" +
"  intent: 'Automate: ' + (scenario.name || scenario.id || 'Scenario'),\\n" +
"  industry: industry.id || 'generic',\\n" +
"  success: 'End user reaches the intended outcome',\\n" +
"  channels_ranked: ['whatsapp','email','sms','call'],\\n" +
"  guardrails: ['no spam','respect opt-out']\\n" +
"};\\n" +
"return [{ context: ctx }];";

  var FC_PLANNER =
"var plan = {\\n" +
"  trigger: { kind: 'manual' },\\n" +
"  archetype: { name: 'custom', confidence: 0.6 },\\n" +
"  branches: [\\n" +
"    { key: 'yes', title: 'Yes path', steps: [\\n" +
"      { id:'s1', title:'Step 1 Compose', type:'send_message', channel:'whatsapp', tool:'Twilio', params:{ body:'Hello on WhatsApp' } },\\n" +
"      { id:'s2', title:'Step 2 Check',   type:'check_data',  channel:'none',     tool:'',        params:{ check:'profile' } },\\n" +
"      { id:'s3', title:'Step 3 Execute', type:'wait',        channel:'none',     tool:'',        params:{ seconds: 2 } }\\n" +
"    ]},\\n" +
"    { key: 'no', title: 'No path', steps: [\\n" +
"      { id:'s1', title:'Step 1 Fallback', type:'send_message', channel:'email', tool:'MAILING', params:{ subject:'We are here', body:'Reply anytime.' } },\\n" +
"      { id:'s2', title:'Step 2 Check',    type:'check_data',  channel:'none',  tool:'',        params:{ check:'reason' } },\\n" +
"      { id:'s3', title:'Step 3 Execute',  type:'wait',        channel:'none',  tool:'',        params:{ seconds: 2 } }\\n" +
"    ]}\\n" +
"  ]\\n" +
"};\\n" +
"return [{ plan: plan }];";

  var FC_PICK =
"var p = $json.plan || {};\\n" +
"var yesB = (p.branches||[]).find(function(b){return b.key==='yes';}) || { steps: [] };\\n" +
"var noB  = (p.branches||[]).find(function(b){return b.key==='no';})  || { steps: [] };\\n" +
"return [{ isYes: true, yesBranch: yesB, noBranch: noB }];";

  function FC_STEP_DRAFT(i, label, branchKey){
    return ""
+ "var steps = ($json."+ (branchKey==='yes'?'yesBranch':'noBranch') +"||{}).steps || [];\\n"
+ "var s = steps["+(i-1)+"] || { id:'s"+i+"', title:'"+label+"', type:'send_message', channel:'email', tool:'MAILING', params:{} };\\n"
+ "return [{ draft: s }];";
  }

  var FC_AI_SIMULATE =
"// Simulated AI Agent: turn draft into action (no network)\\n" +
"var d = $json.draft || { id:'s', title:'Step', type:'send_message', channel:'email', tool:'MAILING', params:{} };\\n" +
"// You can enrich 'd' here based on $json.context if desired\\n" +
"return [{ action: d, notes: ['ai-simulated'] }];";

  var FC_RUNNER =
"function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\\n" +
"var a = $json.action || {};\\n" +
"async function exec(){\\n" +
"  var t = String(a.type||'').toLowerCase();\\n" +
"  if (t==='send_message') return { ok:true, channel:a.channel||'none', tool:a.tool||'', payload:a.params||{} };\\n" +
"  if (t==='check_data')  return { ok:true, check:a.params||{} };\\n" +
"  if (t==='wait')        { await sleep((a.params && a.params.seconds? a.params.seconds:1)*250); return { ok:true, waited:a.params?a.params.seconds||1:1 }; }\\n" +
"  return { ok:true, noop:true };\\n" +
"}\\n" +
"return exec().then(function(r){ return [{ __exec:r }]; });";

  function FC_REC(label){
    return ""
+ "var hist = Array.isArray($json.history) ? $json.history : [];\\n"
+ "hist.push({ step: '"+ label.replace(/'/g,"\\'") +"', action: $json.action, result: $json.__exec });\\n"
+ "return [{ history: hist }];";
  }

  // ---------- Build one AI step block (all Function nodes) ----------
  function addAIStep(wf, baseX, y, idx, branchKey, mode){
    var tag = branchKey.toUpperCase() + ' ' + mode.toUpperCase() + ' Step ' + idx;

    var title = (idx===1 ? (branchKey==='yes'?'Compose / Reach out':'Compose Fallback')
               : idx===2 ? 'Check / Decision'
               :           'Execute');

    var draft = nFunction(tag + ' Draft', FC_STEP_DRAFT(idx, title, branchKey), baseX + 0, y);
    var agent = nFunction(tag + ' AI Agent (simulated)', FC_AI_SIMULATE, baseX + 70, y);
    var run   = nFunction(tag + ' Run', FC_RUNNER, baseX + 140, y);
    var rec   = nFunction(tag + ' Record', FC_REC(tag+' '+title), baseX + 210, y);

    addNode(wf, draft); addNode(wf, agent); addNode(wf, run); addNode(wf, rec);
    connect(wf, draft.name, agent.name);
    connect(wf, agent.name, run.name);
    connect(wf, run.name,   rec.name);

    return { in: draft.name, out: rec.name };
  }

  // ---------- Row backbone ----------
  function addBackbone(wf, scenario, industry, y, mode){
    var X0=-860, SPAN=280, GAP=180;

    // Unique manual trigger per mode
    var m = nManual('Manual Trigger ('+mode+')', X0, y); addNode(wf, m);

    var init = nSet('Init ('+mode+')', {
      'scenario.id': safe(scenario && scenario.scenario_id),
      'scenario.name': safe(scenario && scenario.name),
      'industry.id': safe(industry && industry.industry_id),
      'mode': mode
    }, X0+SPAN, y); addNode(wf, init); connect(wf, m.name, init.name);

    var put = nSet('Init Data ('+mode+')', {
      'scenario': JSON.stringify({ id: safe(scenario && scenario.scenario_id), name: safe(scenario && scenario.name) }),
      'industry': JSON.stringify({ id: safe(industry && industry.industry_id) })
    }, X0+SPAN, y+120); addNode(wf, put); connect(wf, m.name, put.name);

    var ctx = nFunction('Context Agent ('+mode+')', FC_CONTEXT, X0+SPAN*2, y); addNode(wf, ctx); connect(wf, init.name, ctx.name);
    var plan = nFunction('Schema Planner ('+mode+')', FC_PLANNER, X0+SPAN*3, y); addNode(wf, plan); connect(wf, ctx.name, plan.name);
    var pick = nFunction('Pick Branch ('+mode+')', FC_PICK, X0+SPAN*4, y); addNode(wf, pick); connect(wf, plan.name, pick.name);

    // IF router: output 0 (true) -> YES; output 1 (false) -> NO
    var router = nIf('Route Branch ('+mode+')', true, X0+SPAN*5, y); addNode(wf, router); connect(wf, pick.name, router.name);

    // YES lane
    var YES_Y = y - GAP;
    var enterYes = nFunction('Enter YES ('+mode+')',
      "return [{ context:$items(2,0).json.context, yesBranch: $items(3,0).json.plan && ($items(3,0).json.plan.branches||[]).find(function(b){return b.key==='yes';}) || {steps:[]}, mode:'"+mode+"' }];",
      X0+SPAN*6, YES_Y
    );
    addNode(wf, enterYes);
    connect(wf, router.name, enterYes.name, 0);

    var baseYesX = X0 + SPAN*7;
    var y1 = addAIStep(wf, baseYesX + SPAN*0, YES_Y, 1, 'yes', mode);
    var y2 = addAIStep(wf, baseYesX + SPAN*3, YES_Y, 2, 'yes', mode);
    var y3 = addAIStep(wf, baseYesX + SPAN*6, YES_Y, 3, 'yes', mode);
    connect(wf, enterYes.name, y1.in);
    connect(wf, y1.out, y2.in);
    connect(wf, y2.out, y3.in);

    // NO lane
    var NO_Y = y + GAP;
    var enterNo = nFunction('Enter NO ('+mode+')',
      "return [{ context:$items(2,0).json.context, noBranch: $items(3,0).json.plan && ($items(3,0).json.plan.branches||[]).find(function(b){return b.key==='no';}) || {steps:[]}, mode:'"+mode+"' }];",
      X0+SPAN*6, NO_Y
    );
    addNode(wf, enterNo);
    connect(wf, router.name, enterNo.name, 1);

    var baseNoX = X0 + SPAN*7;
    var n1 = addAIStep(wf, baseNoX + SPAN*0, NO_Y, 1, 'no', mode);
    var n2 = addAIStep(wf, baseNoX + SPAN*3, NO_Y, 2, 'no', mode);
    var n3 = addAIStep(wf, baseNoX + SPAN*6, NO_Y, 3, 'no', mode);
    connect(wf, enterNo.name, n1.in);
    connect(wf, n1.out, n2.in);
    connect(wf, n2.out, n3.in);
  }

  // ---------- Main ----------
  function buildWorkflowJSON(scenario, industry){
    var titleLeft  = safe(scenario && scenario.scenario_id ? scenario.scenario_id : 'Scenario');
    var titleRight = safe(scenario && scenario.name ? scenario.name : '');
    var title = (titleLeft + ' — ' + titleRight).replace(/\s+—\s+$/, '').replace(/^—\s+/, '');

    var wf = createWorkflow(title);

    // Two rows: PROD and DEMO (identical; you can later differentiate inside Function code)
    addBackbone(wf, scenario, industry, 240, 'PROD');
    addBackbone(wf, scenario, industry, 620, 'DEMO');

    wf.staticData.__design = {
      notes: [
        'Core-only nodes (manualTrigger v1, set v1, function v1, if v1).',
        'Unique node names per row, preventing import crashes.',
        'Per-step AI Agent blocks simulated via Function nodes (no HTTP).',
        'Straight rails: easy to read, no overlaps.'
      ]
    };

    return wf;
  }

  window.Builder = { buildWorkflowJSON: buildWorkflowJSON };
})();
