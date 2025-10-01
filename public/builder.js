// public/builder.js
// Ultra-compatible builder for n8n: core nodes only (manualTrigger v1, set v1, function v1, if v1).
// ASCII names, no credentials, no custom nodes, no HTTP. Visible per-step "AI Agent (simulated)" blocks.

(function () {
  'use strict';

  // -------- Helpers (ES5 style) --------
  function safe(v) { return (v === null || v === undefined) ? '' : String(v); }
  function slug(txt, n) {
    var s = safe(txt).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (typeof n === 'number' && n > 0) s = s.slice(0, n);
    return s || 'scenario';
  }

  function addNode(wf, node) { wf.nodes.push(node); return node.name; }
  function connect(wf, fromName, toName, outputIndex) {
    var idx = typeof outputIndex === 'number' ? outputIndex : 0;
    if (!wf.connections[fromName]) wf.connections[fromName] = {};
    if (!wf.connections[fromName].main) wf.connections[fromName].main = [];
    while (wf.connections[fromName].main.length <= idx) wf.connections[fromName].main.push([]);
    wf.connections[fromName].main[idx].push({ node: toName, type: 'main', index: 0 });
  }

  // -------- Node factories (typeVersion = 1 partout) --------
  function nManual(x, y) {
    return { id:'n_'+Math.random().toString(36).slice(2,10), name:'Manual Trigger',
      type:'n8n-nodes-base.manualTrigger', typeVersion:1, position:[x,y], parameters:{} };
  }
  function nSet(name, fields, x, y) {
    var stringVals = [];
    for (var k in (fields || {})) if (Object.prototype.hasOwnProperty.call(fields, k)) {
      stringVals.push({ name:k, value:safe(fields[k]) });
    }
    return { id:'n_'+Math.random().toString(36).slice(2,10), name:name,
      type:'n8n-nodes-base.set', typeVersion:1, position:[x,y],
      parameters:{ keepOnlySet:false, values:{ string:stringVals } } };
  }
  function nFunction(name, code, x, y) {
    return { id:'n_'+Math.random().toString(36).slice(2,10), name:name,
      type:'n8n-nodes-base.function', typeVersion:1, position:[x,y],
      parameters:{ functionCode: code } };
  }
  function nIf(name, exprAsBoolean, x, y) {
    return { id:'n_'+Math.random().toString(36).slice(2,10), name:name,
      type:'n8n-nodes-base.if', typeVersion:1, position:[x,y],
      parameters:{ conditions:{ boolean:[ { value1: exprAsBoolean === true, value2: true } ] } } };
  }

  // -------- Function code blocks --------
  var FC_CONTEXT =
"// Build a small context object from scenario/industry (stub; no network)\\n" +
"var scenario = $json.scenario || {};\\n" +
"var industry = $json.industry || {};\\n" +
"var ctx = {\\n" +
"  intent: 'Automate: ' + (scenario.name || scenario.id || 'Scenario'),\\n" +
"  industry: industry.id || 'generic',\\n" +
"  constraints: [],\\n" +
"  success: 'End user reaches the intended outcome',\\n" +
"  channels_ranked: ['whatsapp','email','sms','call'],\\n" +
"  guardrails: ['no spam','respect opt-out']\\n" +
"};\\n" +
"return [{ context: ctx }];";

  var FC_PLANNER =
"// Build a simple plan with two branches (yes/no) and 3 steps each.\\n" +
"var plan = {\\n" +
"  trigger: { kind: 'manual', why: 'safe import' },\\n" +
"  archetype: { name: 'custom', confidence: 0.5 },\\n" +
"  branches: [\\n" +
"    { key: 'yes', title: 'Yes path', steps: [\\n" +
"      { id:'s1', title:'Step 1 Compose', type:'send_message', channel:'whatsapp', tool:'Twilio', params:{ body:'Hello on WhatsApp' } },\\n" +
"      { id:'s2', title:'Step 2 Check',   type:'check_data',  channel:'none',     tool:'',        params:{ check:'profile' } },\\n" +
"      { id:'s3', title:'Step 3 Execute', type:'wait',        channel:'none',     tool:'',        params:{ seconds: 1 } }\\n" +
"    ]},\\n" +
"    { key: 'no', title: 'No path', steps: [\\n" +
"      { id:'s1', title:'Step 1 Fallback', type:'send_message', channel:'email', tool:'MAILING', params:{ subject:'We are here', body:'Reply anytime.' } },\\n" +
"      { id:'s2', title:'Step 2 Check',    type:'check_data',  channel:'none',  tool:'',        params:{ check:'reason' } },\\n" +
"      { id:'s3', title:'Step 3 Execute',  type:'wait',        channel:'none',  tool:'',        params:{ seconds: 1 } }\\n" +
"    ]}\\n" +
"  ]\\n" +
"};\\n" +
"return [{ plan: plan }];";

  var FC_PICK_BRANCH =
"// Pick branch flags for IF routing. You can change this logic.\\n" +
"var plan = $json.plan || {};\\n" +
"var yesBranch = (plan.branches || []).find(function(b){return b.key==='yes';}) || { steps: [] };\\n" +
"var noBranch  = (plan.branches || []).find(function(b){return b.key==='no';})  || { steps: [] };\\n" +
"// Choose YES by default\\n" +
"return [{ isYes: true, yesBranch: yesBranch, noBranch: noBranch }];";

  // Step DRAFT now outputs { draft } (pas action)
  function FC_STEP_DRAFT(i, label, branchKey) {
    return ""
+ "// Select step " + i + " from branch steps or provide a default draft\\n"
+ "var steps = ($json." + (branchKey === 'yes' ? "yesBranch" : "noBranch") + " || {}).steps || [];\\n"
+ "var s = steps[" + (i - 1) + "] || { id:'s" + i + "', title:'" + label + "', type:'send_message', channel:'email', tool:'MAILING', params:{} };\\n"
+ "return [{ draft: s }];";
  }

  // --- NEW: Step AI Agent (simulated) : draft -> action context-aware ---
  var FC_STEP_AI_AGENT =
"// Simulated AI Agent — personalize 'action' from 'draft' + scenario context\\n" +
"var d = $json.draft || {};\\n" +
"var ctx = $json.context || {};\\n" +
"var sc  = $json.__scenario || { id:'', name:'' };\\n" +
"// prefer whatsapp if ranked first, else keep draft.channel\\n" +
"var topCh = (Array.isArray(ctx.channels_ranked) && ctx.channels_ranked[0]) ? ctx.channels_ranked[0] : (d.channel||'email');\\n" +
"var title = (d.title || 'Step').replace(/\\s+/g,' ').trim();\\n" +
"var scen  = (sc.id ? sc.id+': ' : '') + (sc.name || '');\\n" +
"var action = {\\n" +
"  id: d.id || 's',\\n" +
"  title: title + ' — ' + scen,\\n" +
"  type: d.type || 'send_message',\\n" +
"  channel: d.channel || topCh || 'email',\\n" +
"  tool: d.tool || '',\\n" +
"  params: d.params || {}\\n" +
"};\\n" +
"return [{ action: action }];";

  // Validator léger
  var FC_VALIDATE_ACTION =
"var a = $json.action;\\n" +
"if (!a || typeof a !== 'object') throw new Error('Missing action');\\n" +
"if (!a.type) a.type = 'send_message';\\n" +
"if (!a.title) a.title = 'Step';\\n" +
"if (!a.channel) a.channel = 'none';\\n" +
"if (!a.params || typeof a.params !== 'object') a.params = {};\\n" +
"return [{ action: a }];";

  // Runner + Recorder
  var FC_RUNNER =
"// Simulate execution only (no side effects)\\n" +
"function wait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\\n" +
"var a = $json.action || {};\\n" +
"async function exec(){\\n" +
"  var t = String(a.type || '').toLowerCase();\\n" +
"  if (t === 'send_message') return { ok:true, channel:a.channel||'none', tool:a.tool||'', payload:a.params||{} };\\n" +
"  if (t === 'check_data')  return { ok:true, check:a.params||{} };\\n" +
"  if (t === 'wait')        { await wait((a.params && a.params.seconds ? a.params.seconds : 1)*200); return { ok:true, waited:a.params ? a.params.seconds || 1 : 1 }; }\\n" +
"  return { ok:true, noop:true };\\n" +
"}\\n" +
"return exec().then(function(r){ return [{ exec:r }]; });";

  function FC_REC(label) {
    return ""
+ "var hist = Array.isArray($json.history) ? $json.history : [];\\n"
+ "hist.push({ step: '" + safe(label).replace(/'/g, "\\'") + "', action: $json.action, result: $json.exec });\\n"
+ "return [{ history: hist }];";
  }

  // -------- Builder --------
  function buildWorkflowJSON(scenario, industry) {
    var scenId  = safe(scenario && scenario.scenario_id);
    var scenNm  = safe(scenario && scenario.name);
    var scenTag = (scenId ? scenId + ' ' : '') + slug(scenNm, 24);
    var title   = (scenId || 'Scenario') + ' — ' + (scenNm || '');

    var wf = {
      name: title.replace(/\s+—\s+$/, '').replace(/^—\s+/, '') || 'Scenario',
      nodes: [],
      connections: {},
      active: false,
      settings: { executionOrder: 'v1', timezone: 'Europe/Madrid' },
      staticData: {},
      tags: [],
      pinData: {}
    };

    // Layout constants (fixed spacing; no overlaps)
    var X0 = -860, Y0 = 240;
    var SPAN = 280;       // horizontal gap between nodes in a row
    var LANE_GAP = 180;   // vertical gap between YES and NO lanes

    // Backbone: Manual -> Init -> Context -> Planner -> Pick -> IF
    var n0 = nManual(X0, Y0); addNode(wf, n0);

    var n1 = nSet('Init', {
      'scenario.id':   scenId,
      'scenario.name': scenNm,
      'industry.id':   safe(industry && industry.industry_id)
    }, X0 + SPAN, Y0); addNode(wf, n1); connect(wf, n0.name, n1.name);

    // Put raw scenario/industry for Function nodes to read if needed
    var n1b = nSet('Init Data', {
      'scenario': JSON.stringify({ id: scenId, name: scenNm }),
      'industry': JSON.stringify({ id: safe(industry && industry.industry_id) })
    }, X0 + SPAN, Y0 + 120); addNode(wf, n1b); connect(wf, n0.name, n1b.name);

    // Context Agent
    var n2 = nFunction('Context Agent ['+scenTag+']', FC_CONTEXT, X0 + SPAN * 2, Y0); addNode(wf, n2); connect(wf, n1.name, n2.name);

    var n3 = nFunction('Schema Planner ['+scenTag+']', FC_PLANNER, X0 + SPAN * 3, Y0); addNode(wf, n3); connect(wf, n2.name, n3.name);

    var n4 = nFunction('Pick Branch ['+scenTag+']', FC_PICK_BRANCH, X0 + SPAN * 4, Y0); addNode(wf, n4); connect(wf, n3.name, n4.name);

    // IF: output 0 (true) -> YES; output 1 (false) -> NO
    var n5 = nIf('Route Branch ['+scenTag+']', true, X0 + SPAN * 5, Y0); addNode(wf, n5); connect(wf, n4.name, n5.name);

    // YES lane (top)
    var YES_Y = Y0 - LANE_GAP;
    var enterYes = nFunction('Enter YES ['+scenTag+']',
      "return [{ yesBranch: $json.yesBranch || { steps: [] }, context: $items(1,0).json.context, __scenario: { id: '"+scenId.replace(/'/g,"\\'")+"', name: '"+scenNm.replace(/'/g,"\\'")+"' } }];",
      X0 + SPAN * 6, YES_Y
    ); addNode(wf, enterYes);
    connect(wf, n5.name, enterYes.name, 0);

    // YES Step 1
    var yesS1Draft = nFunction('YES Step 1 Draft ['+scenTag+']', FC_STEP_DRAFT(1, 'Compose / Reach out', 'yes'), X0 + SPAN * 7, YES_Y); addNode(wf, yesS1Draft);
    var yesS1AI    = nFunction('YES Step 1 AI Agent ['+scenTag+']', FC_STEP_AI_AGENT, X0 + SPAN * 8, YES_Y); addNode(wf, yesS1AI);
    var yesS1Val   = nFunction('YES Step 1 Validate ['+scenTag+']', FC_VALIDATE_ACTION, X0 + SPAN * 9, YES_Y); addNode(wf, yesS1Val);
    var yesS1Run   = nFunction('YES Step 1 Run ['+scenTag+']', FC_RUNNER, X0 + SPAN * 10, YES_Y); addNode(wf, yesS1Run);
    var yesS1Rec   = nFunction('YES Step 1 Record ['+scenTag+']', FC_REC('YES Step 1'), X0 + SPAN * 11, YES_Y); addNode(wf, yesS1Rec);
    connect(wf, enterYes.name, yesS1Draft.name);
    connect(wf, yesS1Draft.name, yesS1AI.name);
    connect(wf, yesS1AI.name,   yesS1Val.name);
    connect(wf, yesS1Val.name,  yesS1Run.name);
    connect(wf, yesS1Run.name,  yesS1Rec.name);

    // YES Step 2
    var yesS2Draft = nFunction('YES Step 2 Draft ['+scenTag+']', FC_STEP_DRAFT(2, 'Check / Decision', 'yes'), X0 + SPAN * 12, YES_Y); addNode(wf, yesS2Draft);
    var yesS2AI    = nFunction('YES Step 2 AI Agent ['+scenTag+']', FC_STEP_AI_AGENT, X0 + SPAN * 13, YES_Y); addNode(wf, yesS2AI);
    var yesS2Val   = nFunction('YES Step 2 Validate ['+scenTag+']', FC_VALIDATE_ACTION, X0 + SPAN * 14, YES_Y); addNode(wf, yesS2Val);
    var yesS2Run   = nFunction('YES Step 2 Run ['+scenTag+']', FC_RUNNER, X0 + SPAN * 15, YES_Y); addNode(wf, yesS2Run);
    var yesS2Rec   = nFunction('YES Step 2 Record ['+scenTag+']', FC_REC('YES Step 2'), X0 + SPAN * 16, YES_Y); addNode(wf, yesS2Rec);
    connect(wf, yesS1Rec.name,  yesS2Draft.name);
    connect(wf, yesS2Draft.name, yesS2AI.name);
    connect(wf, yesS2AI.name,    yesS2Val.name);
    connect(wf, yesS2Val.name,   yesS2Run.name);
    connect(wf, yesS2Run.name,   yesS2Rec.name);

    // YES Step 3
    var yesS3Draft = nFunction('YES Step 3 Draft ['+scenTag+']', FC_STEP_DRAFT(3, 'Execute', 'yes'), X0 + SPAN * 17, YES_Y); addNode(wf, yesS3Draft);
    var yesS3AI    = nFunction('YES Step 3 AI Agent ['+scenTag+']', FC_STEP_AI_AGENT, X0 + SPAN * 18, YES_Y); addNode(wf, yesS3AI);
    var yesS3Val   = nFunction('YES Step 3 Validate ['+scenTag+']', FC_VALIDATE_ACTION, X0 + SPAN * 19, YES_Y); addNode(wf, yesS3Val);
    var yesS3Run   = nFunction('YES Step 3 Run ['+scenTag+']', FC_RUNNER, X0 + SPAN * 20, YES_Y); addNode(wf, yesS3Run);
    var yesS3Rec   = nFunction('YES Step 3 Record ['+scenTag+']', FC_REC('YES Step 3'), X0 + SPAN * 21, YES_Y); addNode(wf, yesS3Rec);
    connect(wf, yesS2Rec.name,  yesS3Draft.name);
    connect(wf, yesS3Draft.name, yesS3AI.name);
    connect(wf, yesS3AI.name,    yesS3Val.name);
    connect(wf, yesS3Val.name,   yesS3Run.name);
    connect(wf, yesS3Run.name,   yesS3Rec.name);

    // NO lane (bottom)
    var NO_Y = Y0 + LANE_GAP;
    var enterNo = nFunction('Enter NO ['+scenTag+']',
      "return [{ noBranch: $json.noBranch || { steps: [] }, context: $items(1,0).json.context, __scenario: { id: '"+scenId.replace(/'/g,"\\'")+"', name: '"+scenNm.replace(/'/g,"\\'")+"' } }];",
      X0 + SPAN * 6, NO_Y
    ); addNode(wf, enterNo);
    connect(wf, n5.name, enterNo.name, 1);

    // NO Step 1
    var noS1Draft = nFunction('NO Step 1 Draft ['+scenTag+']', FC_STEP_DRAFT(1, 'Compose Fallback', 'no'), X0 + SPAN * 7, NO_Y); addNode(wf, noS1Draft);
    var noS1AI    = nFunction('NO Step 1 AI Agent ['+scenTag+']', FC_STEP_AI_AGENT, X0 + SPAN * 8, NO_Y); addNode(wf, noS1AI);
    var noS1Val   = nFunction('NO Step 1 Validate ['+scenTag+']', FC_VALIDATE_ACTION, X0 + SPAN * 9, NO_Y); addNode(wf, noS1Val);
    var noS1Run   = nFunction('NO Step 1 Run ['+scenTag+']', FC_RUNNER, X0 + SPAN * 10, NO_Y); addNode(wf, noS1Run);
    var noS1Rec   = nFunction('NO Step 1 Record ['+scenTag+']', FC_REC('NO Step 1'), X0 + SPAN * 11, NO_Y); addNode(wf, noS1Rec);
    connect(wf, enterNo.name,  noS1Draft.name);
    connect(wf, noS1Draft.name, noS1AI.name);
    connect(wf, noS1AI.name,    noS1Val.name);
    connect(wf, noS1Val.name,   noS1Run.name);
    connect(wf, noS1Run.name,   noS1Rec.name);

    // NO Step 2
    var noS2Draft = nFunction('NO Step 2 Draft ['+scenTag+']', FC_STEP_DRAFT(2, 'Check / Decision', 'no'), X0 + SPAN * 12, NO_Y); addNode(wf, noS2Draft);
    var noS2AI    = nFunction('NO Step 2 AI Agent ['+scenTag+']', FC_STEP_AI_AGENT, X0 + SPAN * 13, NO_Y); addNode(wf, noS2AI);
    var noS2Val   = nFunction('NO Step 2 Validate ['+scenTag+']', FC_VALIDATE_ACTION, X0 + SPAN * 14, NO_Y); addNode(wf, noS2Val);
    var noS2Run   = nFunction('NO Step 2 Run ['+scenTag+']', FC_RUNNER, X0 + SPAN * 15, NO_Y); addNode(wf, noS2Run);
    var noS2Rec   = nFunction('NO Step 2 Record ['+scenTag+']', FC_REC('NO Step 2'), X0 + SPAN * 16, NO_Y); addNode(wf, noS2Rec);
    connect(wf, noS1Rec.name,  noS2Draft.name);
    connect(wf, noS2Draft.name, noS2AI.name);
    connect(wf, noS2AI.name,    noS2Val.name);
    connect(wf, noS2Val.name,   noS2Run.name);
    connect(wf, noS2Run.name,   noS2Rec.name);

    // NO Step 3
    var noS3Draft = nFunction('NO Step 3 Draft ['+scenTag+']', FC_STEP_DRAFT(3, 'Execute', 'no'), X0 + SPAN * 17, NO_Y); addNode(wf, noS3Draft);
    var noS3AI    = nFunction('NO Step 3 AI Agent ['+scenTag+']', FC_STEP_AI_AGENT, X0 + SPAN * 18, NO_Y); addNode(wf, noS3AI);
    var noS3Val   = nFunction('NO Step 3 Validate ['+scenTag+']', FC_VALIDATE_ACTION, X0 + SPAN * 19, NO_Y); addNode(wf, noS3Val);
    var noS3Run   = nFunction('NO Step 3 Run ['+scenTag+']', FC_RUNNER, X0 + SPAN * 20, NO_Y); addNode(wf, noS3Run);
    var noS3Rec   = nFunction('NO Step 3 Record ['+scenTag+']', FC_REC('NO Step 3'), X0 + SPAN * 21, NO_Y); addNode(wf, noS3Rec);
    connect(wf, noS2Rec.name,  noS3Draft.name);
    connect(wf, noS3Draft.name, noS3AI.name);
    connect(wf, noS3AI.name,    noS3Val.name);
    connect(wf, noS3Val.name,   noS3Run.name);
    connect(wf, noS3Run.name,   noS3Rec.name);

    // Done
    wf.staticData.__design = {
      notes: [
        'Core nodes only. Visible AI Agent blocks per step (simulated).',
        'Node names include scenario id/name slug to make each workflow visibly unique.',
        'YES/NO lanes with 3 steps each; each step: Draft -> AI Agent -> Validate -> Run -> Record.'
      ]
    };

    return wf;
  }

  // Expose globally
  window.Builder = { buildWorkflowJSON: buildWorkflowJSON };
})();
