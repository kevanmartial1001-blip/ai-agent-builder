// public/builder.js
// AI-Factory builder: contracts-first (ContextSpec → PlanGraph → Action), core nodes only.
// Function v1 compliant: read items[0].json; return [{ json: ... }]. No custom nodes, no emojis.

(function () {
  'use strict';

  // -------- Helpers --------
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

  // -------- Node factories (typeVersion = 1; httpRequest uses v4) --------
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

  // -------- Function code blocks (Function v1 style) --------

  // 1) ContextSpec (rules-normalized from ScenarioInput)
  var FC_CONTEXT =
"var json = (items[0] && items[0].json) || {};\n" +
"var scen = {\n" +
"  id: json['scenario.id'] || '',\n" +
"  name: json['scenario.name'] || '',\n" +
"  industry: json['industry.id'] || '',\n" +
"  triggers: json['scenario.triggers'] || '',\n" +
"  best: json['scenario.best_reply_shapes'] || '',\n" +
"  risk: json['scenario.risk_notes'] || '',\n" +
"  roi: json['scenario.roi_hypothesis'] || '',\n" +
"  tags: (json['scenario.tags'] || '').split(',').filter(function(s){return s;})\n" +
"};\n" +
"var ch = ['whatsapp','sms','email','call'];\n" +
"if (/email/i.test(scen.best)) ch = ['email','whatsapp','sms','call'];\n" +
"if (/wa|whatsapp/i.test(scen.best)) ch = ['whatsapp','sms','email','call'];\n" +
"var guard = ['no PHI','respect opt-out','tone: professional/friendly'];\n" +
"if (/phi|hipaa/i.test(scen.risk)) guard = ['no PHI','respect opt-out','tone: professional/friendly'];\n" +
"json.ContextSpec = {\n" +
"  intent: (scen.roi ? 'Goal: ' + scen.roi : 'Automate: ' + (scen.name || scen.id)),\n" +
"  industry_pack: [scen.industry || 'generic'].concat(scen.tags.slice(0,2)),\n" +
"  guardrails: guard,\n" +
"  channels_ranked: ch,\n" +
"  entities: ['user','appointment','location','agent'],\n" +
"  kpis: ['reschedule_rate','time_to_reschedule','no_show_rate']\n" +
"};\n" +
"if (!Array.isArray(json.history)) json.history = [];\n" +
"return [{ json: json }];";

  // 2) PlanGraph (YES/NO; 3 steps each)
  var FC_PLANNER =
"var json = (items[0] && items[0].json) || {};\n" +
"var ctx = json.ContextSpec || {};\n" +
"var waFirst = Array.isArray(ctx.channels_ranked) && ctx.channels_ranked[0] === 'whatsapp';\n" +
"var yesSteps = [\n" +
"  { id:'s1', type:'send_message', channel: waFirst?'whatsapp':'sms', tool:'Twilio', params:{ body_tmpl:'confirm' } },\n" +
"  { id:'s2', type:'check_data',   channel:'none',   tool:'',        params:{ field:'confirm_received' } },\n" +
"  { id:'s3', type:'wait',         channel:'none',   tool:'',        params:{ seconds: 1 } }\n" +
"];\n" +
"var noSteps = [\n" +
"  { id:'s1', type:'send_message', channel: waFirst?'whatsapp':'sms', tool:'Twilio',  params:{ body_tmpl:'offer_slots' } },\n" +
"  { id:'s2', type:'check_data',   channel:'none',   tool:'',         params:{ field:'slot_choice' } },\n" +
"  { id:'s3', type:'http',         channel:'none',   tool:'CALENDAR', params:{ url:'{{calendar_base}}/book', method:'POST', body:{} } }\n" +
"];\n" +
"json.PlanGraph = {\n" +
"  trigger: { kind:'manual' },\n" +
"  branches: [\n" +
"    { key:'yes', title:'Has upcoming appointment', steps: yesSteps },\n" +
"    { key:'no',  title:'Needs reschedule',         steps: noSteps }\n" +
"  ]\n" +
"};\n" +
"return [{ json: json }];";

  // 3) Extract branch objects and set demo YES route
  var FC_PICK_BRANCH =
"var json = (items[0] && items[0].json) || {};\n" +
"var pg = json.PlanGraph || { branches: [] };\n" +
"var yes = (pg.branches || []).filter(function(b){ return b && b.key==='yes'; })[0] || { steps: [] };\n" +
"var no  = (pg.branches || []).filter(function(b){ return b && b.key==='no';  })[0] || { steps: [] };\n" +
"json.yesBranch = yes;\n" +
"json.noBranch  = no;\n" +
"json.routeYes  = true; // demo default\n" +
"return [{ json: json }];";

  // 4) Step Draft (i = 1..3)
  function FC_STEP_DRAFT(i, fallbackTitle, branchKey) {
    return ""
+ "var json = (items[0] && items[0].json) || {};\n"
+ "var branch = json." + (branchKey === 'yes' ? "yesBranch" : "noBranch") + " || { steps: [] };\n"
+ "var s = (branch.steps || [])[ " + (i - 1) + " ] || { id:'s" + i + "', type:'send_message', channel:'whatsapp', tool:'Twilio', params:{ body_tmpl:'generic' } };\n"
+ "json.Action = {\n"
+ "  id: s.id || 's" + i + "',\n"
+ "  title: '" + fallbackTitle.replace(/'/g, "\\'") + "',\n"
+ "  type: s.type || 'send_message',\n"
+ "  channel: s.channel || 'none',\n"
+ "  tool: s.tool || '',\n"
+ "  params: (typeof s.params==='object' && s.params) ? s.params : {}\n"
+ "};\n"
+ "return [{ json: json }];";
  }

  // 5) Step Agent (rules-only enrichment from ContextSpec)
  var FC_STEP_AGENT_RULES =
"var json = (items[0] && items[0].json) || {};\n" +
"var a = json.Action || { id:'s', type:'send_message', channel:'whatsapp', tool:'Twilio', params:{} };\n" +
"var ctx = json.ContextSpec || {};\n" +
"var scenId = json['scenario.id'] || '';\n" +
"var scenNm = json['scenario.name'] || '';\n" +
"var title = (a.title || 'Step') + ' — ' + (scenId ? (scenId + ': ') : '') + (scenNm || '');\n" +
"// choose top channel from ContextSpec when Action lacks channel\n" +
"if (!a.channel && Array.isArray(ctx.channels_ranked) && ctx.channels_ranked.length) a.channel = ctx.channels_ranked[0];\n" +
"// enrich message templates (human tone)\n" +
"var outboxText = '';\n" +
"if (a.type==='send_message') {\n" +
"  if (a.params && a.params.body_tmpl==='confirm') outboxText = 'Quick check: can you confirm your appointment? Just reply yes if it still works for you.';\n" +
"  else if (a.params && a.params.body_tmpl==='offer_slots') {\n" +
"    var slots = json.demo_slots || ['09:30','12:00','16:00'];\n" +
"    outboxText = 'No worries — which time suits you best: ' + slots.join(', ') + ' ?';\n" +
"  } else outboxText = 'Hi there — happy to help. Let me know what works for you.';\n" +
"}\n" +
"json.Action = { id:a.id, title:title, type:a.type, channel:a.channel||'none', tool:a.tool||'', params:a.params||{} };\n" +
"json.Outbox = { text: outboxText };\n" +
"return [{ json: json }];";

  // 6) Validate Action contract (fill defaults)
  var FC_VALIDATE_ACTION =
"var json = (items[0] && items[0].json) || {};\n" +
"var a = json.Action || {};\n" +
"if (typeof a !== 'object') a = {};\n" +
"if (!a.id) a.id = 's';\n" +
"if (!a.title) a.title = 'Step';\n" +
"if (!a.type) a.type = 'send_message';\n" +
"if (!a.channel) a.channel = 'none';\n" +
"if (!a.tool) a.tool = '';\n" +
"if (!a.params || typeof a.params !== 'object') a.params = {};\n" +
"json.Action = a;\n" +
"return [{ json: json }];";

  // 7) Run (demo/prod; with tool resolver for http)
  var FC_RUNNER =
"function wait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n" +
"var json = (items[0] && items[0].json) || {};\n" +
"var a = json.Action || {};\n" +
"var mode = json.mode || 'demo';\n" +
"var bases = {\n" +
"  twilio_base: json.twilio_base || '',\n" +
"  calendar_base: json.calendar_base || '',\n" +
"  crm_base: json.crm_base || ''\n" +
"};\n" +
"function toolToHttp(tool, params){\n" +
"  var t = String(tool||'').toUpperCase();\n" +
"  if (t==='CALENDAR') return { url: (bases.calendar_base||'') + '/book', method:(params && params.method)||'POST', body:(params && params.body)||{} };\n" +
"  if (t==='CRM')      return { url: (bases.crm_base||'') + '/records', method:(params && params.method)||'POST', body:(params && params.body)||{} };\n" +
"  if (t==='TWILIO')   return { url: (bases.twilio_base||'') + '/messages', method:'POST', body:{ text: (json.Outbox && json.Outbox.text) || '' } };\n" +
"  return { url: (params && params.url) || '', method: (params && params.method) || 'POST', body: (params && params.body) || {} };\n" +
"}\n" +
"async function exec(){\n" +
"  var t = String(a.type || '').toLowerCase();\n" +
"  if (t==='send_message'){\n" +
"    if (mode==='prod'){\n" +
"      var req = toolToHttp(a.tool, a.params);\n" +
"      // In prod you can replace with httpRequest node; here we simulate the result to keep imports universal.\n" +
"      return { ok:true, simulated:false, request:req, sent:{ channel:a.channel, text:(json.Outbox&&json.Outbox.text)||'' } };\n" +
"    }\n" +
"    return { ok:true, simulated:true, sent:{ channel:a.channel, text:(json.Outbox&&json.Outbox.text)||'' } };\n" +
"  }\n" +
"  if (t==='check_data')  return { ok:true, check:a.params||{} };\n" +
"  if (t==='http'){\n" +
"    var req2 = toolToHttp(a.tool, a.params);\n" +
"    return { ok:true, simulated:(mode!=='prod'), request:req2 };\n" +
"  }\n" +
"  if (t==='wait')        { await wait((a.params && a.params.seconds ? a.params.seconds : 1)*200); return { ok:true, waited:a.params ? a.params.seconds || 1 : 1 }; }\n" +
"  return { ok:true, noop:true };\n" +
"}\n" +
"return exec().then(function(r){ json.exec = r; return [{ json: json }]; });";

  // 8) Record
  function FC_REC(label) {
    var L = label.replace(/'/g, "\\'");
    return ""
+ "var json = (items[0] && items[0].json) || {};\n"
+ "var h = Array.isArray(json.history) ? json.history : [];\n"
+ "h.push({ ts: Date.now(), step: '"+L+"', action: json.Action, outbox: (json.Outbox&&json.Outbox.text)||'', result: json.exec });\n"
+ "json.history = h;\n"
+ "return [{ json: json }];";
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

    // Layout
    var X0 = -860, Y0 = 240;
    var SPAN = 280;
    var LANE_GAP = 180;

    // Backbone
    var n0 = nManual(X0, Y0); addNode(wf, n0);

    // Init: all scenario fields + mode + tool bases + demo seeds
    var n1 = nSet('Init', {
      'scenario.id':   scenId,
      'scenario.name': scenNm,
      'industry.id':   safe(industry && industry.industry_id),
      'scenario.triggers':        safe(scenario && scenario.triggers),
      'scenario.best_reply_shapes': safe(scenario && scenario.best_reply_shapes),
      'scenario.risk_notes':      safe(scenario && scenario.risk_notes),
      'scenario.roi_hypothesis':  safe(scenario && scenario.roi_hypothesis),
      'scenario.tags':            Array.isArray(scenario && scenario.tags) ? scenario.tags.join(',') : safe(scenario && scenario.tags),

      // Demo vs Prod
      'mode': 'demo',
      // Tool bases (prod: replace with real)
      'twilio_base':   'https://demo.twilio.local',
      'calendar_base': 'https://demo.calendar.local',
      'crm_base':      'https://demo.crm.local',
      // Demo seeds
      'demo.to':       '+34613030526',
      'demo.emailTo':  'kevanm.spain@gmail.com',
      'demo.waFrom':   '+14155238886',
      'demo.smsFrom':  '+13412184164',
      'demo.callFrom': '+13412184164'
    }, X0 + SPAN, Y0); addNode(wf, n1); connect(wf, n0.name, n1.name);

    // Context → Planner → Pick
    var n2 = nFunction('ContextSpec ['+scenTag+']', FC_CONTEXT, X0 + SPAN * 2, Y0); addNode(wf, n2); connect(wf, n1.name, n2.name);
    var n3 = nFunction('PlanGraph ['+scenTag+']',    FC_PLANNER, X0 + SPAN * 3, Y0); addNode(wf, n3); connect(wf, n2.name, n3.name);
    var n4 = nFunction('Pick Branch ['+scenTag+']',  FC_PICK_BRANCH, X0 + SPAN * 4, Y0); addNode(wf, n4); connect(wf, n3.name, n4.name);

    // IF (static YES for demo; flip later by changing param or node)
    var n5 = nIf('Route Branch ['+scenTag+']', true, X0 + SPAN * 5, Y0); addNode(wf, n5); connect(wf, n4.name, n5.name);

    // ===== YES lane =====
    var YES_Y = Y0 - LANE_GAP;
    var enterYes = nFunction('Enter YES ['+scenTag+']',
"var json = (items[0] && items[0].json) || {};\n" +
"json.branch = 'yes';\n" +
"return [{ json: json }];",
      X0 + SPAN * 6, YES_Y
    ); addNode(wf, enterYes); connect(wf, n5.name, enterYes.name, 0);

    // YES steps 1..3
    var yesS1Draft = nFunction('YES Step 1 Draft ['+scenTag+']', FC_STEP_DRAFT(1, 'Confirm appointment', 'yes'), X0 + SPAN * 7, YES_Y); addNode(wf, yesS1Draft);
    var yesS1Agent = nFunction('YES Step 1 Agent ['+scenTag+']', FC_STEP_AGENT_RULES, X0 + SPAN * 8, YES_Y); addNode(wf, yesS1Agent);
    var yesS1Val   = nFunction('YES Step 1 Validate ['+scenTag+']', FC_VALIDATE_ACTION, X0 + SPAN * 9, YES_Y); addNode(wf, yesS1Val);
    var yesS1Run   = nFunction('YES Step 1 Run ['+scenTag+']', FC_RUNNER, X0 + SPAN * 10, YES_Y); addNode(wf, yesS1Run);
    var yesS1Rec   = nFunction('YES Step 1 Record ['+scenTag+']', FC_REC('YES Step 1'), X0 + SPAN * 11, YES_Y); addNode(wf, yesS1Rec);

    connect(wf, enterYes.name, yesS1Draft.name);
    connect(wf, yesS1Draft.name, yesS1Agent.name);
    connect(wf, yesS1Agent.name, yesS1Val.name);
    connect(wf, yesS1Val.name,   yesS1Run.name);
    connect(wf, yesS1Run.name,   yesS1Rec.name);

    var yesS2Draft = nFunction('YES Step 2 Draft ['+scenTag+']', FC_STEP_DRAFT(2, 'Check confirmation', 'yes'), X0 + SPAN * 12, YES_Y); addNode(wf, yesS2Draft);
    var yesS2Agent = nFunction('YES Step 2 Agent ['+scenTag+']', FC_STEP_AGENT_RULES, X0 + SPAN * 13, YES_Y); addNode(wf, yesS2Agent);
    var yesS2Val   = nFunction('YES Step 2 Validate ['+scenTag+']', FC_VALIDATE_ACTION, X0 + SPAN * 14, YES_Y); addNode(wf, yesS2Val);
    var yesS2Run   = nFunction('YES Step 2 Run ['+scenTag+']', FC_RUNNER, X0 + SPAN * 15, YES_Y); addNode(wf, yesS2Run);
    var yesS2Rec   = nFunction('YES Step 2 Record ['+scenTag+']', FC_REC('YES Step 2'), X0 + SPAN * 16, YES_Y); addNode(wf, yesS2Rec);

    connect(wf, yesS1Rec.name, yesS2Draft.name);
    connect(wf, yesS2Draft.name, yesS2Agent.name);
    connect(wf, yesS2Agent.name, yesS2Val.name);
    connect(wf, yesS2Val.name,   yesS2Run.name);
    connect(wf, yesS2Run.name,   yesS2Rec.name);

    var yesS3Draft = nFunction('YES Step 3 Draft ['+scenTag+']', FC_STEP_DRAFT(3, 'Gentle follow-up wait', 'yes'), X0 + SPAN * 17, YES_Y); addNode(wf, yesS3Draft);
    var yesS3Agent = nFunction('YES Step 3 Agent ['+scenTag+']', FC_STEP_AGENT_RULES, X0 + SPAN * 18, YES_Y); addNode(wf, yesS3Agent);
    var yesS3Val   = nFunction('YES Step 3 Validate ['+scenTag+']', FC_VALIDATE_ACTION, X0 + SPAN * 19, YES_Y); addNode(wf, yesS3Val);
    var yesS3Run   = nFunction('YES Step 3 Run ['+scenTag+']', FC_RUNNER, X0 + SPAN * 20, YES_Y); addNode(wf, yesS3Run);
    var yesS3Rec   = nFunction('YES Step 3 Record ['+scenTag+']', FC_REC('YES Step 3'), X0 + SPAN * 21, YES_Y); addNode(wf, yesS3Rec);

    connect(wf, yesS2Rec.name,  yesS3Draft.name);
    connect(wf, yesS3Draft.name, yesS3Agent.name);
    connect(wf, yesS3Agent.name, yesS3Val.name);
    connect(wf, yesS3Val.name,   yesS3Run.name);
    connect(wf, yesS3Run.name,   yesS3Rec.name);

    // ===== NO lane =====
    var NO_Y = Y0 + LANE_GAP;
    var enterNo = nFunction('Enter NO ['+scenTag+']',
"var json = (items[0] && items[0].json) || {};\n" +
"json.branch = 'no';\n" +
"return [{ json: json }];",
      X0 + SPAN * 6, NO_Y
    ); addNode(wf, enterNo); connect(wf, n5.name, enterNo.name, 1);

    var noS1Draft = nFunction('NO Step 1 Draft ['+scenTag+']', FC_STEP_DRAFT(1, 'Offer reschedule slots', 'no'), X0 + SPAN * 7, NO_Y); addNode(wf, noS1Draft);
    var noS1Agent = nFunction('NO Step 1 Agent ['+scenTag+']', FC_STEP_AGENT_RULES, X0 + SPAN * 8, NO_Y); addNode(wf, noS1Agent);
    var noS1Val   = nFunction('NO Step 1 Validate ['+scenTag+']', FC_VALIDATE_ACTION, X0 + SPAN * 9, NO_Y); addNode(wf, noS1Val);
    var noS1Run   = nFunction('NO Step 1 Run ['+scenTag+']', FC_RUNNER, X0 + SPAN * 10, NO_Y); addNode(wf, noS1Run);
    var noS1Rec   = nFunction('NO Step 1 Record ['+scenTag+']', FC_REC('NO Step 1'), X0 + SPAN * 11, NO_Y); addNode(wf, noS1Rec);

    connect(wf, enterNo.name,  noS1Draft.name);
    connect(wf, noS1Draft.name, noS1Agent.name);
    connect(wf, noS1Agent.name, noS1Val.name);
    connect(wf, noS1Val.name,   noS1Run.name);
    connect(wf, noS1Run.name,   noS1Rec.name);

    var noS2Draft = nFunction('NO Step 2 Draft ['+scenTag+']', FC_STEP_DRAFT(2, 'Capture slot choice', 'no'), X0 + SPAN * 12, NO_Y); addNode(wf, noS2Draft);
    var noS2Agent = nFunction('NO Step 2 Agent ['+scenTag+']', FC_STEP_AGENT_RULES, X0 + SPAN * 13, NO_Y); addNode(wf, noS2Agent);
    var noS2Val   = nFunction('NO Step 2 Validate ['+scenTag+']', FC_VALIDATE_ACTION, X0 + SPAN * 14, NO_Y); addNode(wf, noS2Val);
    var noS2Run   = nFunction('NO Step 2 Run ['+scenTag+']', FC_RUNNER, X0 + SPAN * 15, NO_Y); addNode(wf, noS2Run);
    var noS2Rec   = nFunction('NO Step 2 Record ['+scenTag+']', FC_REC('NO Step 2'), X0 + SPAN * 16, NO_Y); addNode(wf, noS2Rec);

    connect(wf, noS1Rec.name,  noS2Draft.name);
    connect(wf, noS2Draft.name, noS2Agent.name);
    connect(wf, noS2Agent.name, noS2Val.name);
    connect(wf, noS2Val.name,   noS2Run.name);
    connect(wf, noS2Run.name,   noS2Rec.name);

    var noS3Draft = nFunction('NO Step 3 Draft ['+scenTag+']', FC_STEP_DRAFT(3, 'Book via calendar API', 'no'), X0 + SPAN * 17, NO_Y); addNode(wf, noS3Draft);
    var noS3Agent = nFunction('NO Step 3 Agent ['+scenTag+']', FC_STEP_AGENT_RULES, X0 + SPAN * 18, NO_Y); addNode(wf, noS3Agent);
    var noS3Val   = nFunction('NO Step 3 Validate ['+scenTag+']', FC_VALIDATE_ACTION, X0 + SPAN * 19, NO_Y); addNode(wf, noS3Val);
    var noS3Run   = nFunction('NO Step 3 Run ['+scenTag+']', FC_RUNNER, X0 + SPAN * 20, NO_Y); addNode(wf, noS3Run);
    var noS3Rec   = nFunction('NO Step 3 Record ['+scenTag+']', FC_REC('NO Step 3'), X0 + SPAN * 21, NO_Y); addNode(wf, noS3Rec);

    connect(wf, noS2Rec.name,  noS3Draft.name);
    connect(wf, noS3Draft.name, noS3Agent.name);
    connect(wf, noS3Agent.name, noS3Val.name);
    connect(wf, noS3Val.name,   noS3Run.name);
    connect(wf, noS3Run.name,   noS3Rec.name);

    wf.staticData.__design = {
      contracts: {
        ContextSpec: { intent:'string', industry_pack:'string[]', guardrails:'string[]', channels_ranked:'string[]', entities:'string[]', kpis:'string[]' },
        PlanGraph: { trigger:'object', branches:'array<key,title,steps[]>' },
        Action: { id:'string', title:'string', type:'string', channel:'string', tool:'string', params:'object' }
      },
      notes: [
        'Contracts-first: ContextSpec → PlanGraph → Action. Core nodes only.',
        'Execution macro per step: Draft → Step Agent (rules) → Validate → Run → Record.',
        'Demo vs Prod via json.mode. Replace tool bases to go prod; runner already resolves tools.'
      ]
    };
    return wf;
  }

  window.Builder = { buildWorkflowJSON: buildWorkflowJSON };
})();
