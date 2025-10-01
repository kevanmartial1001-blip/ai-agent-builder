// public/builder.js
// AI-Factory builder (functional): Contracts-first + per-step prompts + tool execution.
// Core nodes only. Function v1 style. Demo/Prod + LLM toggle, Twilio/Calendar/CRM via httpRequest v4.

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

  // -------- Node factories --------
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
  function nHttp(name, x, y, urlExpr, methodExpr, bodyJsonExpr, headersJsonExpr) {
    // v4 httpRequest; json parameters; expressions kept simple (read from json in a Function before this node)
    return {
      id:'n_'+Math.random().toString(36).slice(2,10),
      name:name,
      type:'n8n-nodes-base.httpRequest',
      typeVersion:4,
      position:[x,y],
      parameters:{
        url: urlExpr || '={{$json.__http.url}}',
        method: methodExpr || '={{$json.__http.method}}',
        sendBody: true,
        jsonParameters: true,
        options: { fullResponse: false },
        bodyParametersJson: bodyJsonExpr || '={{$json.__http.body}}',
        headerParametersJson: headersJsonExpr || '={{$json.__http.headers}}'
      }
    };
  }

  // -------- Function code blocks (Function v1 style) --------

  // 1) ContextSpec
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
"json.ContextSpec = {\n" +
"  intent: (scen.roi ? 'Goal: ' + scen.roi : 'Automate: ' + (scen.name || scen.id)),\n" +
"  industry_pack: [scen.industry || 'generic'].concat(scen.tags.slice(0,2)),\n" +
"  guardrails: ['no PHI','respect opt-out','tone: professional/friendly'],\n" +
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
"  { id:'s1', type:'send_message', channel: waFirst?'whatsapp':'sms', tool:'TWILIO',  params:{ body_tmpl:'confirm' } },\n" +
"  { id:'s2', type:'check_data',   channel:'none',   tool:'',        params:{ field:'confirm_received' } },\n" +
"  { id:'s3', type:'wait',         channel:'none',   tool:'',        params:{ seconds: 1 } }\n" +
"];\n" +
"var noSteps = [\n" +
"  { id:'s1', type:'send_message', channel: waFirst?'whatsapp':'sms', tool:'TWILIO',   params:{ body_tmpl:'offer_slots' } },\n" +
"  { id:'s2', type:'check_data',   channel:'none',   tool:'',         params:{ field:'slot_choice' } },\n" +
"  { id:'s3', type:'http',         channel:'none',   tool:'CALENDAR', params:{ method:'POST', body:{} } }\n" +
"];\n" +
"json.PlanGraph = {\n" +
"  trigger: { kind:'manual' },\n" +
"  branches: [\n" +
"    { key:'yes', title:'Has upcoming appointment', steps: yesSteps },\n" +
"    { key:'no',  title:'Needs reschedule',         steps: noSteps }\n" +
"  ]\n" +
"};\n" +
"return [{ json: json }];";

  // 3) Extract branches; default to YES
  var FC_PICK_BRANCH =
"var json = (items[0] && items[0].json) || {};\n" +
"var pg = json.PlanGraph || { branches: [] };\n" +
"var yes = (pg.branches || []).filter(function(b){ return b && b.key==='yes'; })[0] || { steps: [] };\n" +
"var no  = (pg.branches || []).filter(function(b){ return b && b.key==='no';  })[0] || { steps: [] };\n" +
"json.yesBranch = yes;\n" +
"json.noBranch  = no;\n" +
"json.routeYes  = true;\n" +
"return [{ json: json }];";

  // 4) Step Draft (i = 1..3)
  function FC_STEP_DRAFT(i, fallbackTitle, branchKey) {
    return ""
+ "var json = (items[0] && items[0].json) || {};\n"
+ "var branch = json." + (branchKey === 'yes' ? "yesBranch" : "noBranch") + " || { steps: [] };\n"
+ "var s = (branch.steps || [])[ " + (i - 1) + " ] || { id:'s" + i + "', type:'send_message', channel:'whatsapp', tool:'TWILIO', params:{ body_tmpl:'generic' } };\n"
+ "json.Action = { id: s.id || 's" + i + "', title: '" + fallbackTitle.replace(/'/g, "\\'") + "', type: s.type||'send_message', channel: s.channel||'none', tool: s.tool||'', params: (typeof s.params==='object'&&s.params)||{} };\n"
+ "return [{ json: json }];";
  }

  // 5) Build Prompt for LLM (per-step). If llm.enabled=false, we’ll skip LLM and use rules.
  var FC_BUILD_PROMPT =
"var json = (items[0] && items[0].json) || {};\n" +
"var a = json.Action || {};\n" +
"var ctx = json.ContextSpec || {};\n" +
"var scen = { id: json['scenario.id']||'', name: json['scenario.name']||'', industry: json['industry.id']||'' };\n" +
"// Simple instruction for conversational, human tone output.\n" +
"var system = 'You are a senior automation copywriter. Return strict JSON: {\"message\": \"...\"}. Keep it natural, friendly, concise.';\n" +
"var user = {\n" +
"  goal: ctx.intent || '',\n" +
"  guardrails: ctx.guardrails || [],\n" +
"  channel: a.channel || 'whatsapp',\n" +
"  template: a.params && a.params.body_tmpl || 'generic',\n" +
"  scenario: scen\n" +
"};\n" +
"json.__llm_req = {\n" +
"  system: system,\n" +
"  user: user\n" +
"};\n" +
"return [{ json: json }];";

  // 6) Prepare HTTP call to LLM (OpenAI-compatible body). Uses init llm fields.
  var FC_LLM_HTTP_PREP =
"var json = (items[0] && items[0].json) || {};\n" +
"var base = json.llm_base || '';\n" +
"var key  = json.llm_api_key || '';\n" +
"var model= json.llm_model || 'gpt-4o-mini';\n" +
"var r = json.__llm_req || { system:'', user:{} };\n" +
"var body = {\n" +
"  model: model,\n" +
"  messages: [\n" +
"    { role:'system', content: r.system || '' },\n" +
"    { role:'user',   content: JSON.stringify(r.user || {}) }\n" +
"  ],\n" +
"  response_format: { type: 'json_object' },\n" +
"  temperature: 0.2\n" +
"};\n" +
"json.__http = {\n" +
"  url: base ? (base + '/chat/completions') : 'https://api.openai.com/v1/chat/completions',\n" +
"  method: 'POST',\n" +
"  headers: key ? { 'Authorization':'Bearer ' + key, 'Content-Type':'application/json' } : { 'Content-Type':'application/json' },\n" +
"  body: body\n" +
"};\n" +
"return [{ json: json }];";

  // 7) Parse LLM response JSON content -> Outbox.message (strict)
  var FC_LLM_PARSE =
"var json = (items[0] && items[0].json) || {};\n" +
"var resp = (items[0] && items[0].json && items[0].json.data) || (json.data) || {};\n" +
"// n8n httpRequest by default returns the parsed body into items[0].json\n" +
"var content = '';\n" +
"try {\n" +
"  var c = resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;\n" +
"  content = typeof c === 'string' ? c : '';\n" +
"} catch (e) { content = ''; }\n" +
"var msg = '';\n" +
"try { var obj = JSON.parse(content); msg = safe(obj.message || ''); } catch(e){ msg = ''; }\n" +
"var existing = json.Outbox && json.Outbox.text || '';\n" +
"json.Outbox = { text: msg || existing }; // fallback to previous rules text if LLM failed\n" +
"return [{ json: json }];";

  // 8) Rule Step-Agent (enrich + natural default message)
  var FC_STEP_AGENT_RULES =
"var json = (items[0] && items[0].json) || {};\n" +
"var a = json.Action || { id:'s', type:'send_message', channel:'whatsapp', tool:'TWILIO', params:{} };\n" +
"var ctx = json.ContextSpec || {};\n" +
"var scenId = json['scenario.id'] || '';\n" +
"var scenNm = json['scenario.name'] || '';\n" +
"var title = (a.title || 'Step') + ' — ' + (scenId ? (scenId + ': ') : '') + (scenNm || '');\n" +
"if (!a.channel && Array.isArray(ctx.channels_ranked) && ctx.channels_ranked.length) a.channel = ctx.channels_ranked[0];\n" +
"var outboxText = '';\n" +
"if (a.type==='send_message') {\n" +
"  if (a.params && a.params.body_tmpl==='confirm') outboxText = 'Quick check: can you confirm your appointment? Just reply yes if it still works for you.';\n" +
"  else if (a.params && a.params.body_tmpl==='offer_slots') {\n" +
"    var slots = json.demo_slots || ['09:30','12:00','16:00'];\n" +
"    outboxText = 'No worries — which time suits you best: ' + slots.join(', ') + ' ?';\n" +
"  } else outboxText = 'Hi there — happy to help. Let me know what works for you.';\n" +
"}\n" +
"json.Action = { id:a.id, title:title, type:a.type, channel:a.channel||'none', tool:String(a.tool||'') , params:a.params||{} };\n" +
"json.Outbox = { text: outboxText };\n" +
"return [{ json: json }];";

  // 9) Validate Action
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

  // 10) Prepare HTTP for tools (TWILIO/CALENDAR/CRM) when prod
  var FC_TOOL_HTTP_PREP =
"var json = (items[0] && items[0].json) || {};\n" +
"var a = json.Action || {};\n" +
"var mode = json.mode || 'demo';\n" +
"var bases = { twilio: json.twilio_base||'', calendar: json.calendar_base||'', crm: json.crm_base||'' };\n" +
"var result = { url:'', method:'POST', headers:{'Content-Type':'application/json'}, body:{} };\n" +
"if (mode==='prod'){\n" +
"  var t = String(a.tool||'').toUpperCase();\n" +
"  if (t==='TWILIO'){\n" +
"    result.url = bases.twilio ? (bases.twilio + '/messages') : '';\n" +
"    result.body = { to: json['demo.to'] || '', from: json['demo.waFrom'] || '', channel: a.channel, text: (json.Outbox && json.Outbox.text) || '' };\n" +
"  } else if (t==='CALENDAR'){\n" +
"    result.url = bases.calendar ? (bases.calendar + '/book') : '';\n" +
"    result.body = a.params && a.params.body ? a.params.body : { slot: (json.slot_choice||'') };\n" +
"  } else if (t==='CRM'){\n" +
"    result.url = bases.crm ? (bases.crm + '/records') : '';\n" +
"    result.body = { scenario: json['scenario.id']||'', event: a.title, payload: a.params||{} };\n" +
"  } else {\n" +
"    // generic http\n" +
"    result.url = (a.params && a.params.url) || '';\n" +
"    result.method = (a.params && a.params.method) || 'POST';\n" +
"    result.body = (a.params && a.params.body) || {};\n" +
"  }\n" +
"}\n" +
"json.__http = result;\n" +
"return [{ json: json }];";

  // 11) Run (simulate demo; http in prod is done by httpRequest node placed next)
  var FC_RUNNER =
"var json = (items[0] && items[0].json) || {};\n" +
"var a = json.Action || {};\n" +
"var mode = json.mode || 'demo';\n" +
"function wait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n" +
"async function exec(){\n" +
"  var t = String(a.type || '').toLowerCase();\n" +
"  if (mode==='prod' && (t==='send_message' || t==='http')){\n" +
"    // In prod, httpRequest node right after this will run; we just pass through\n" +
"    return { ok:true, deferred_http:true };\n" +
"  }\n" +
"  if (t==='send_message'){\n" +
"    return { ok:true, simulated:true, sent:{ channel:a.channel, text:(json.Outbox&&json.Outbox.text)||'' } };\n" +
"  }\n" +
"  if (t==='check_data')  return { ok:true, check:a.params||{} };\n" +
"  if (t==='wait')        { await wait((a.params && a.params.seconds ? a.params.seconds : 1)*200); return { ok:true, waited:a.params ? a.params.seconds || 1 : 1 }; }\n" +
"  if (t==='http')        return { ok:true, simulated:true, request: json.__http||{} };\n" +
"  return { ok:true, noop:true };\n" +
"}\n" +
"return exec().then(function(r){ json.exec = r; return [{ json: json }]; });";

  // 12) Record
  function FC_REC(label) {
    var L = label.replace(/'/g, "\\'");
    return ""
+ "var json = (items[0] && items[0].json) || {};\n"
+ "var h = Array.isArray(json.history) ? json.history : [];\n"
+ "h.push({ ts: Date.now(), step: '"+L+"', action: json.Action, outbox: (json.Outbox&&json.Outbox.text)||'', result: json.exec });\n"
+ "json.history = h;\n"
+ "return [{ json: json }];";
  }

  // ===== Build =====
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
    var LANE_GAP = 220;

    // Backbone
    var n0 = nManual(X0, Y0); addNode(wf, n0);

    // Init: scenario + flags + tool bases + demo seeds + LLM config
    var n1 = nSet('Init', {
      'scenario.id':   scenId,
      'scenario.name': scenNm,
      'industry.id':   safe(industry && industry.industry_id),

      'scenario.triggers':         safe(scenario && scenario.triggers),
      'scenario.best_reply_shapes':safe(scenario && scenario.best_reply_shapes),
      'scenario.risk_notes':       safe(scenario && scenario.risk_notes),
      'scenario.roi_hypothesis':   safe(scenario && scenario.roi_hypothesis),
      'scenario.tags':             Array.isArray(scenario && scenario.tags) ? scenario.tags.join(',') : safe(scenario && scenario.tags),

      // Modes
      'mode':          'demo',             // set to 'prod' to call real tools
      'llm.enabled':   'false',            // 'true' to call LLM via HTTP
      'llm_base':      'https://api.openai.com/v1',
      'llm_model':     'gpt-4o-mini',
      'llm_api_key':   '',                 // fill in n8n env/cred at runtime

      // Tool bases (prod)
      'twilio_base':   'https://api.twilio.com',   // or your gateway
      'calendar_base': 'https://calendar.example.com',
      'crm_base':      'https://crm.example.com',

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

    // IF
    var n5 = nIf('Route Branch ['+scenTag+']', true, X0 + SPAN * 5, Y0); addNode(wf, n5); connect(wf, n4.name, n5.name);

    // Helper: add a Step Macro (LLM optional)
    function addStepMacro(prefix, baseX, yRow, stepIdx, draftTitle){
      var sDraft = nFunction(prefix+' Step '+stepIdx+' Draft ['+scenTag+']', FC_STEP_DRAFT(stepIdx, draftTitle, (prefix==='YES'?'yes':'no')), baseX, yRow); addNode(wf, sDraft);

      // Build prompt from Action+Context
      var buildPrompt = nFunction(prefix+' Step '+stepIdx+' Build Prompt ['+scenTag+']', FC_BUILD_PROMPT, baseX+SPAN, yRow); addNode(wf, buildPrompt);
      connect(wf, sDraft, buildPrompt);

      // Decide LLM usage (IF on llm.enabled)
      var ifLLM = nIf(prefix+' Step '+stepIdx+' Use LLM? ['+scenTag+']', false, baseX + SPAN*2, yRow); addNode(wf, ifLLM);
      connect(wf, buildPrompt, ifLLM);

      // True path (index 0): LLM flow
      var prepLLM = nFunction(prefix+' Step '+stepIdx+' LLM HTTP Prep ['+scenTag+']', FC_LLM_HTTP_PREP, baseX + SPAN*3, yRow); addNode(wf, prepLLM);
      connect(wf, ifLLM, prepLLM, 0);

      var callLLM = nHttp(prefix+' Step '+stepIdx+' LLM HTTP', baseX + SPAN*4, yRow); addNode(wf, callLLM);
      connect(wf, prepLLM, callLLM);

      var parseLLM = nFunction(prefix+' Step '+stepIdx+' LLM Parse ['+scenTag+']', FC_LLM_PARSE, baseX + SPAN*5, yRow); addNode(wf, parseLLM);
      connect(wf, callLLM.name, parseLLM);

      // False path (index 1): Rules agent
      var rulesAgent = nFunction(prefix+' Step '+stepIdx+' Rules Agent ['+scenTag+']', FC_STEP_AGENT_RULES, baseX + SPAN*3, yRow+120); addNode(wf, rulesAgent);
      connect(wf, ifLLM, rulesAgent, 1);

      // Merge (both go to Validate)
      var validate = nFunction(prefix+' Step '+stepIdx+' Validate ['+scenTag+']', FC_VALIDATE_ACTION, baseX + SPAN*6, yRow); addNode(wf, validate);
      connect(wf, parseLLM, validate);
      connect(wf, rulesAgent, validate);

      // Prepare tool HTTP (prod), then run
      var prepTool = nFunction(prefix+' Step '+stepIdx+' Tool HTTP Prep ['+scenTag+']', FC_TOOL_HTTP_PREP, baseX + SPAN*7, yRow); addNode(wf, prepTool);
      connect(wf, validate, prepTool);

      var run = nFunction(prefix+' Step '+stepIdx+' Run ['+scenTag+']', FC_RUNNER, baseX + SPAN*8, yRow); addNode(wf, run);
      connect(wf, prepTool, run);

      // httpRequest (only meaningful in prod for send_message/http)
      var execHttp = nHttp(prefix+' Step '+stepIdx+' Execute HTTP', baseX + SPAN*9, yRow); addNode(wf, execHttp);
      connect(wf, run, execHttp);

      // Record
      var rec = nFunction(prefix+' Step '+stepIdx+' Record ['+scenTag+']', FC_REC(prefix+' Step '+stepIdx), baseX + SPAN*10, yRow); addNode(wf, rec);
      connect(wf, execHttp, rec);

      return rec;
    }

    // YES lane
    var YES_Y = Y0 - LANE_GAP;
    var enterYes = nFunction('Enter YES ['+scenTag+']',
"var json = (items[0] && items[0].json) || {};\njson.branch='yes'; return [{ json: json }];",
      X0 + SPAN * 6, YES_Y
    ); addNode(wf, enterYes); connect(wf, n5.name, enterYes.name, 0);

    var yes1 = addStepMacro('YES', X0 + SPAN * 7, YES_Y, 1, 'Confirm appointment');
    connect(wf, enterYes.name, yes1);
    var yes2 = addStepMacro('YES', X0 + SPAN * 13, YES_Y, 2, 'Check confirmation');
    connect(wf, yes1, yes2);
    var yes3 = addStepMacro('YES', X0 + SPAN * 19, YES_Y, 3, 'Gentle follow-up wait');
    connect(wf, yes2, yes3);

    // NO lane
    var NO_Y = Y0 + LANE_GAP;
    var enterNo = nFunction('Enter NO ['+scenTag+']',
"var json = (items[0] && items[0].json) || {};\njson.branch='no'; return [{ json: json }];",
      X0 + SPAN * 6, NO_Y
    ); addNode(wf, enterNo); connect(wf, n5.name, enterNo.name, 1);

    var no1 = addStepMacro('NO', X0 + SPAN * 7, NO_Y, 1, 'Offer reschedule slots');
    connect(wf, enterNo.name, no1);
    var no2 = addStepMacro('NO', X0 + SPAN * 13, NO_Y, 2, 'Capture slot choice');
    connect(wf, no1, no2);
    var no3 = addStepMacro('NO', X0 + SPAN * 19, NO_Y, 3, 'Book via calendar API');
    connect(wf, no2, no3);

    // Finish (optional summary node can be added here)

    wf.staticData.__design = {
      contracts: {
        ContextSpec: { intent:'string', industry_pack:'string[]', guardrails:'string[]', channels_ranked:'string[]', entities:'string[]', kpis:'string[]' },
        PlanGraph: { trigger:'object', branches:'array<key,title,steps[]>' },
        Action: { id:'string', title:'string', type:'string', channel:'string', tool:'string', params:'object' }
      },
      flags: ['mode demo|prod', 'llm.enabled true|false'],
      notes: [
        'Per-step LLM: set llm.enabled=true and llm_api_key/llm_base in Init.',
        'Prod tools: set mode=prod and fill twilio_base/calendar_base/crm_base; httpRequest nodes execute.',
        'Demo mode: all side effects simulated; http nodes still receive well-formed __http payloads.'
      ]
    };
    return wf;
  }

  window.Builder = { buildWorkflowJSON: buildWorkflowJSON };
})();
