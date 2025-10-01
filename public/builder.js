// public/builder.js
// Ultra-compatible builder for n8n: ONLY core nodes (manualTrigger v1, set v1, function v1, if v1).
// ASCII names, no credentials, no custom nodes, no emojis, no HTTP. Imports on any n8n.

(function () {
  'use strict';

  // -------- Helpers (ES5 style) --------
  function safe(v) {
    return (v === null || v === undefined) ? '' : String(v);
  }

  function addNode(wf, node) {
    wf.nodes.push(node);
    return node.name; // n8n connections key by node name
  }

  function connect(wf, fromName, toName, outputIndex) {
    var idx = typeof outputIndex === 'number' ? outputIndex : 0;
    if (!wf.connections[fromName]) wf.connections[fromName] = {};
    if (!wf.connections[fromName].main) wf.connections[fromName].main = [];
    while (wf.connections[fromName].main.length <= idx) {
      wf.connections[fromName].main.push([]);
    }
    wf.connections[fromName].main[idx].push({ node: toName, type: 'main', index: 0 });
  }

  // -------- Node factories (typeVersion = 1 everywhere) --------
  function nManual(x, y) {
    return {
      id: 'n_' + Math.random().toString(36).slice(2, 10),
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [x, y],
      parameters: {}
    };
  }

  function nSet(name, fields, x, y) {
    var stringVals = [];
    for (var k in (fields || {})) {
      if (Object.prototype.hasOwnProperty.call(fields, k)) {
        stringVals.push({ name: k, value: safe(fields[k]) });
      }
    }
    return {
      id: 'n_' + Math.random().toString(36).slice(2, 10),
      name: name,
      type: 'n8n-nodes-base.set',
      typeVersion: 1,
      position: [x, y],
      parameters: {
        keepOnlySet: false,
        values: { string: stringVals }
      }
    };
  }

  function nFunction(name, code, x, y) {
    return {
      id: 'n_' + Math.random().toString(36).slice(2, 10),
      name: name,
      type: 'n8n-nodes-base.function',
      typeVersion: 1,
      position: [x, y],
      parameters: { functionCode: code }
    };
  }

  function nIf(name, exprAsBoolean, x, y) {
    // The classic IF node checks boolean conditions on "value1".
    return {
      id: 'n_' + Math.random().toString(36).slice(2, 10),
      name: name,
      type: 'n8n-nodes-base.if',
      typeVersion: 1,
      position: [x, y],
      parameters: {
        conditions: {
          boolean: [
            { value1: exprAsBoolean === true, value2: true }
          ]
        }
      }
    };
  }

  // -------- Function code blocks (legacy-friendly JS) --------
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

  function FC_STEP_DRAFT(i, label, branchKey) {
    return ""
+ "// Select step " + i + " from branch steps or provide a default draft\\n"
+ "var steps = ($json." + (branchKey === 'yes' ? "yesBranch" : "noBranch") + " || {}).steps || [];\\n"
+ "var s = steps[" + (i - 1) + "] || { id:'s" + i + "', title:'" + label + "', type:'send_message', channel:'email', tool:'MAILING', params:{} };\\n"
+ "return [{ action: s }];";
  }

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
+ "hist.push({ step: '" + label.replace(/'/g, "\\'") + "', action: $json.action, result: $json.exec });\\n"
+ "return [{ history: hist }];";
  }

  // -------- Builder --------
  function buildWorkflowJSON(scenario, industry) {
    var titleLeft  = safe(scenario && scenario.scenario_id ? scenario.scenario_id : 'Scenario');
    var titleRight = safe(scenario && scenario.name ? scenario.name : '');
    var title = (titleLeft + ' — ' + titleRight).replace(/\s+—\s+$/, '').replace(/^—\s+/, '');

    var wf = {
      name: title || 'Scenario',
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
      'scenario.id':   safe(scenario && scenario.scenario_id),
      'scenario.name': safe(scenario && scenario.name),
      'industry.id':   safe(industry && industry.industry_id)
    }, X0 + SPAN, Y0); addNode(wf, n1); connect(wf, n0.name, n1.name);

    // Put raw scenario/industry for Function nodes to read if needed
    var n1b = nSet('Init Data', {
      'scenario': JSON.stringify({
        id: safe(scenario && scenario.scenario_id),
        name: safe(scenario && scenario.name)
      }),
      'industry': JSON.stringify({ id: safe(industry && industry.industry_id) })
    }, X0 + SPAN, Y0 + 120); addNode(wf, n1b); connect(wf, n0.name, n1b.name);

    var n2 = nFunction('Context Agent', FC_CONTEXT, X0 + SPAN * 2, Y0); addNode(wf, n2); connect(wf, n1.name, n2.name);

    var n3 = nFunction('Schema Planner', FC_PLANNER, X0 + SPAN * 3, Y0); addNode(wf, n3); connect(wf, n2.name, n3.name);

    var n4 = nFunction('Pick Branch', FC_PICK_BRANCH, X0 + SPAN * 4, Y0); addNode(wf, n4); connect(wf, n3.name, n4.name);

    // IF: output 0 (true) -> YES; output 1 (false) -> NO
    var n5 = nIf('Route Branch', true, X0 + SPAN * 5, Y0); addNode(wf, n5); connect(wf, n4.name, n5.name);

    // YES lane (top)
    var YES_Y = Y0 - LANE_GAP;
    var enterYes = nFunction('Enter YES',
      "return [{ yesBranch: $json.yesBranch || { steps: [] } }];",
      X0 + SPAN * 6, YES_Y
    ); addNode(wf, enterYes);

    // Step groups (3) for YES
    var yesS1Draft = nFunction('YES Step 1 Draft', FC_STEP_DRAFT(1, 'Compose / Reach out', 'yes'), X0 + SPAN * 7, YES_Y); addNode(wf, yesS1Draft);
    var yesS1Run   = nFunction('YES Run Step 1', FC_RUNNER, X0 + SPAN * 8, YES_Y); addNode(wf, yesS1Run);
    var yesS1Rec   = nFunction('YES Record Step 1', FC_REC('YES Step 1'), X0 + SPAN * 9, YES_Y); addNode(wf, yesS1Rec);

    var yesS2Draft = nFunction('YES Step 2 Draft', FC_STEP_DRAFT(2, 'Check / Decision', 'yes'), X0 + SPAN * 10, YES_Y); addNode(wf, yesS2Draft);
    var yesS2Run   = nFunction('YES Run Step 2', FC_RUNNER, X0 + SPAN * 11, YES_Y); addNode(wf, yesS2Run);
    var yesS2Rec   = nFunction('YES Record Step 2', FC_REC('YES Step 2'), X0 + SPAN * 12, YES_Y); addNode(wf, yesS2Rec);

    var yesS3Draft = nFunction('YES Step 3 Draft', FC_STEP_DRAFT(3, 'Execute', 'yes'), X0 + SPAN * 13, YES_Y); addNode(wf, yesS3Draft);
    var yesS3Run   = nFunction('YES Run Step 3', FC_RUNNER, X0 + SPAN * 14, YES_Y); addNode(wf, yesS3Run);
    var yesS3Rec   = nFunction('YES Record Step 3', FC_REC('YES Step 3'), X0 + SPAN * 15, YES_Y); addNode(wf, yesS3Rec);

    // Wire YES lane
    connect(wf, n5.name, enterYes.name, 0);
    connect(wf, enterYes.name, yesS1Draft.name);
    connect(wf, yesS1Draft.name, yesS1Run.name);
    connect(wf, yesS1Run.name, yesS1Rec.name);
    connect(wf, yesS1Rec.name, yesS2Draft.name);
    connect(wf, yesS2Draft.name, yesS2Run.name);
    connect(wf, yesS2Run.name, yesS2Rec.name);
    connect(wf, yesS2Rec.name, yesS3Draft.name);
    connect(wf, yesS3Draft.name, yesS3Run.name);
    connect(wf, yesS3Run.name, yesS3Rec.name);

    // NO lane (bottom)
    var NO_Y = Y0 + LANE_GAP;
    var enterNo = nFunction('Enter NO',
      "return [{ noBranch: $json.noBranch || { steps: [] } }];",
      X0 + SPAN * 6, NO_Y
    ); addNode(wf, enterNo);

    var noS1Draft = nFunction('NO Step 1 Draft', FC_STEP_DRAFT(1, 'Compose Fallback', 'no'), X0 + SPAN * 7, NO_Y); addNode(wf, noS1Draft);
    var noS1Run   = nFunction('NO Run Step 1', FC_RUNNER, X0 + SPAN * 8, NO_Y); addNode(wf, noS1Run);
    var noS1Rec   = nFunction('NO Record Step 1', FC_REC('NO Step 1'), X0 + SPAN * 9, NO_Y); addNode(wf, noS1Rec);

    var noS2Draft = nFunction('NO Step 2 Draft', FC_STEP_DRAFT(2, 'Check / Decision', 'no'), X0 + SPAN * 10, NO_Y); addNode(wf, noS2Draft);
    var noS2Run   = nFunction('NO Run Step 2', FC_RUNNER, X0 + SPAN * 11, NO_Y); addNode(wf, noS2Run);
    var noS2Rec   = nFunction('NO Record Step 2', FC_REC('NO Step 2'), X0 + SPAN * 12, NO_Y); addNode(wf, noS2Rec);

    var noS3Draft = nFunction('NO Step 3 Draft', FC_STEP_DRAFT(3, 'Execute', 'no'), X0 + SPAN * 13, NO_Y); addNode(wf, noS3Draft);
    var noS3Run   = nFunction('NO Run Step 3', FC_RUNNER, X0 + SPAN * 14, NO_Y); addNode(wf, noS3Run);
    var noS3Rec   = nFunction('NO Record Step 3', FC_REC('NO Step 3'), X0 + SPAN * 15, NO_Y); addNode(wf, noS3Rec);

    // Wire NO lane
    connect(wf, n5.name, enterNo.name, 1);
    connect(wf, enterNo.name, noS1Draft.name);
    connect(wf, noS1Draft.name, noS1Run.name);
    connect(wf, noS1Run.name, noS1Rec.name);
    connect(wf, noS1Rec.name, noS2Draft.name);
    connect(wf, noS2Draft.name, noS2Run.name);
    connect(wf, noS2Run.name, noS2Rec.name);
    connect(wf, noS2Rec.name, noS3Draft.name);
    connect(wf, noS3Draft.name, noS3Run.name);
    connect(wf, noS3Run.name, noS3Rec.name);

    // Done
    wf.staticData.__design = {
      notes: [
        'Only core nodes: manualTrigger v1, set v1, function v1, if v1.',
        'ASCII names only. No HTTP. No custom nodes. No credentials.',
        'Backbone + YES/NO lanes with three simple step blocks.'
      ]
    };

    return wf;
  }

  // Expose globally
  window.Builder = { buildWorkflowJSON: buildWorkflowJSON };
})();
