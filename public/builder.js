// public/builder.js
// Core-only builder with per-step AI Agent blocks (approved n8n nodes only):
// manualTrigger v1, set v1, function v1, if v1, httpRequest v4.
// ASCII names only, no custom nodes, no credentials objects.
// If OPENAI_API_KEY isn't set, steps fall back to stub outputs (still runs).

(function () {
  'use strict';

  // -------- Helpers (ES5) --------
  function safe(v) { return (v === null || v === undefined) ? '' : String(v); }

  function addNode(wf, node) { wf.nodes.push(node); return node.name; }

  function connect(wf, fromName, toName, outputIndex) {
    var idx = typeof outputIndex === 'number' ? outputIndex : 0;
    if (!wf.connections[fromName]) wf.connections[fromName] = {};
    if (!wf.connections[fromName].main) wf.connections[fromName].main = [];
    while (wf.connections[fromName].main.length <= idx) wf.connections[fromName].main.push([]);
    wf.connections[fromName].main[idx].push({ node: toName, type: 'main', index: 0 });
  }

  // -------- Node factories (legacy-safe) --------
  function nManual(x, y) {
    return { id: 'n_'+Math.random().toString(36).slice(2,10), name:'Manual Trigger',
      type:'n8n-nodes-base.manualTrigger', typeVersion:1, position:[x,y], parameters:{} };
  }
  function nSet(name, fields, x, y) {
    var stringVals=[], k;
    for(k in (fields||{})) if(Object.prototype.hasOwnProperty.call(fields,k)){
      stringVals.push({ name:k, value:safe(fields[k]) });
    }
    return { id:'n_'+Math.random().toString(36).slice(2,10), name:name,
      type:'n8n-nodes-base.set', typeVersion:1, position:[x,y],
      parameters:{ keepOnlySet:false, values:{ string:stringVals } } };
  }
  function nFunction(name, code, x, y) {
    return { id:'n_'+Math.random().toString(36).slice(2,10), name:name,
      type:'n8n-nodes-base.function', typeVersion:1, position:[x,y],
      parameters:{ functionCode:code } };
  }
  function nIf(name, boolValue, x, y) {
    return { id:'n_'+Math.random().toString(36).slice(2,10), name:name,
      type:'n8n-nodes-base.if', typeVersion:1, position:[x,y],
      parameters:{ conditions:{ boolean:[ { value1: !!boolValue, value2: true } ] } } };
  }
  function nHTTP(name, bodyExpr, x, y) {
    // Core HTTP Request node (v4). We use simple expressions only for header + body.
    return { id:'n_'+Math.random().toString(36).slice(2,10), name:name,
      type:'n8n-nodes-base.httpRequest', typeVersion:4, position:[x,y],
      parameters:{
        url: "={{$json.llm_base || $env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions'}}",
        method: "POST",
        authentication: "none",
        jsonParameters: true,
        sendHeaders: true,
        options: {},
        headerParametersJson: "={{ { 'Content-Type':'application/json', 'Authorization': 'Bearer ' + ($json.llm_key || $env.OPENAI_API_KEY || '') } }}",
        bodyParametersJson: bodyExpr
      }
    };
  }

  // -------- Function code blocks --------
  var FC_CONTEXT =
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
"var plan = {\\n" +
"  trigger: { kind: 'manual', why: 'auto layout' },\\n" +
"  archetype: { name: 'custom', confidence: 0.6 },\\n" +
"  branches: [\\n" +
"    { key: 'yes', title: 'Yes path', steps: [\\n" +
"      { id:'s1', title:'Step 1 Compose', type:'send_message', channel:'whatsapp', tool:'Twilio', params:{ body:'Hello on WhatsApp' } },\\n" +
"      { id:'s2', title:'Step 2 Check',   type:'check_data',  channel:'none',     tool:'',        params:{ check:'profile' } },\\n" +
"      { id:'s3', title:'Step 3 Execute', type:'http',        channel:'none',     tool:'HTTP',    params:{ url:'', method:'POST', body:{ok:true} } }\\n" +
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
"var plan = $json.plan || {};\\n" +
"var yesB = (plan.branches||[]).find(function(b){return b.key==='yes';}) || { steps:[] };\\n" +
"var noB  = (plan.branches||[]).find(function(b){return b.key==='no';})  || { steps:[] };\\n" +
"return [{ isYes:true, yesBranch:yesB, noBranch:noB }];";

  function FC_STEP_DRAFT(i, label, branchKey) {
    return ""
+ "var steps = ($json." + (branchKey==='yes'?'yesBranch':'noBranch') + "||{}).steps || [];\\n"
+ "var s = steps[" + (i-1) + "] || { id:'s"+i+"', title:'"+label+"', type:'send_message', channel:'email', tool:'MAILING', params:{} };\\n"
+ "return [{ draft: s }];";
  }

  var FC_BUILD_PROMPT =
"// Build OpenAI-style chat body. If no API key, mark simulate.\\n" +
"var simulate = !($json.llm_key || $env.OPENAI_API_KEY);\\n" +
"var ctx = $json.context || {};\\n" +
"var br  = $json.__branch || {};\\n" +
"var step= $json.draft || {};\\n" +
"var schema = { action:{ id:'', title:'', type:'send_message|check_data|http|wait|place_call', channel:'email|whatsapp|sms|call|none', tool:'string', params:{} }, notes:[] };\\n" +
"var sys = 'You are a Step Agent. Return ONLY valid JSON matching schema.';\\n" +
"var usr = 'Context: ' + JSON.stringify(ctx) + '\\nBranch: ' + JSON.stringify(br) + '\\nStepDraft: ' + JSON.stringify(step) + '\\nSchema: ' + JSON.stringify(schema);\\n" +
"return [{ __simulate: simulate, prompt: { model: ($json.llm_model||$env.OPENAI_MODEL||'gpt-5-mini'), temperature: 0.2, response_format:{type:'json_object'}, messages:[{role:'system',content:sys},{role:'user',content:usr}] } }];";

  var FC_PARSE_LLM =
"// If simulate, emit stub; else parse HTTP response\\n" +
"if ($json.__simulate) {\\n" +
"  var d = $json.draft || {};\\n" +
"  return [{ action: d, notes: ['simulated'] }];\\n" +
"}\\n" +
"var raw = $json.choices && $json.choices[0] && $json.choices[0].message && $json.choices[0].message.content;\\n" +
"var out;\\n" +
"try { out = typeof raw==='string' ? JSON.parse(raw) : (raw||{}); } catch(e){ throw new Error('LLM JSON invalid'); }\\n" +
"if (!out || !out.action) throw new Error('Missing action');\\n" +
"return [ out ];";

  var FC_MERGE_TO_ACTION =
"var act = $json.action || {};\\n" +
"return [{ action: act }];";

  var FC_RUNNER =
"function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\\n" +
"var a = $json.action || {};\\n" +
"async function exec(){\\n" +
"  var t = String(a.type||'').toLowerCase();\\n" +
"  if (t==='send_message') return { ok:true, channel:a.channel||'none', tool:a.tool||'', payload:a.params||{} };\\n" +
"  if (t==='check_data')  return { ok:true, check:a.params||{} };\\n" +
"  if (t==='wait')        { await sleep((a.params && a.params.seconds? a.params.seconds:1)*250); return { ok:true, waited:a.params?a.params.seconds||1:1 }; }\\n" +
"  if (t==='http')        return { ok:true, simulated:true, url:(a.params&&a.params.url)||'', body:(a.params&&a.params.body)||{} };\\n" +
"  if (t==='place_call')  return { ok:true, channel:'call', tool:a.tool||'', payload:a.params||{} };\\n" +
"  return { ok:true, noop:true };\\n" +
"}\\n" +
"return exec().then(function(r){ return [{ __exec:r }]; });";

  function FC_REC(label) {
    return ""
+ "var hist = Array.isArray($json.history)?$json.history:[];\\n"
+ "hist.push({ step:'" + label.replace(/'/g,"\\'") + "', action:$json.action, result:$json.__exec });\\n"
+ "return [{ history: hist }];";
  }

  // -------- Build one AI Step block --------
  function addAIStep(wf, baseX, y, idx, branchLabel) {
    var prefix = branchLabel.toUpperCase() + " Step " + idx;

    var draft = nFunction(prefix + " Draft", FC_STEP_DRAFT(idx, idx===1 ? (branchLabel==='yes'?'Compose / Reach out':'Compose Fallback') : (idx===2?'Check / Decision':'Execute'), branchLabel), baseX + 0, y);
    addNode(wf, draft);

    var prompt = nFunction(prefix + " Build Prompt", FC_BUILD_PROMPT, baseX + 70, y); addNode(wf, prompt);
    connect(wf, draft.name, prompt.name);

    var http = nHTTP(prefix + " AI Agent",
      "={{ $json.prompt }}",
      baseX + 140, y); addNode(wf, http);

    var parse = nFunction(prefix + " Parse LLM", FC_PARSE_LLM, baseX + 210, y); addNode(wf, parse);
    connect(wf, http.name, parse.name);

    var merge = nFunction(prefix + " Merge Action", FC_MERGE_TO_ACTION, baseX + 280, y); addNode(wf, merge);
    connect(wf, parse.name, merge.name);

    var run = nFunction(prefix + " Run", FC_RUNNER, baseX + 350, y); addNode(wf, run);
    connect(wf, merge.name, run.name);

    var rec = nFunction(prefix + " Record", FC_REC(prefix), baseX + 420, y); addNode(wf, rec);
    connect(wf, run.name, rec.name);

    return { in: draft, out: rec };
  }

  // -------- Backbone per row --------
  function addBackbone(wf, scenario, industry, y, modeLabel) {
    var X0 = -860, SPAN = 280, LANE_GAP = 180;

    var n0 = nManual(X0, y); addNode(wf, n0);

    var n1 = nSet("Init ("+modeLabel+")", {
      "scenario.id": safe(scenario && scenario.scenario_id),
      "scenario.name": safe(scenario && scenario.name),
      "industry.id": safe(industry && industry.industry_id),
      // LLM config (can also be set via env OPENAI_API_KEY / OPENAI_MODEL / OPENAI_BASE_URL)
      "llm_key": "",                      // optional; leave empty to simulate
      "llm_model": "gpt-5-mini",
      "llm_base": ""
    }, X0 + SPAN, y); addNode(wf, n1); connect(wf, n0.name, n1.name);

    var putRaw = nSet("Init Data ("+modeLabel+")", {
      "scenario": JSON.stringify({ id:safe(scenario && scenario.scenario_id), name:safe(scenario && scenario.name) }),
      "industry": JSON.stringify({ id:safe(industry && industry.industry_id) })
    }, X0 + SPAN, y + 120); addNode(wf, putRaw); connect(wf, n0.name, putRaw.name);

    var ctx = nFunction("Context Agent ("+modeLabel+")", FC_CONTEXT, X0 + SPAN*2, y); addNode(wf, ctx); connect(wf, n1.name, ctx.name);

    var plan = nFunction("Schema Planner ("+modeLabel+")", FC_PLANNER, X0 + SPAN*3, y); addNode(wf, plan); connect(wf, ctx.name, plan.name);

    var pick = nFunction("Pick Branch ("+modeLabel+")", FC_PICK, X0 + SPAN*4, y); addNode(wf, pick); connect(wf, plan.name, pick.name);

    var route = nIf("Route Branch ("+modeLabel+")", true, X0 + SPAN*5, y); addNode(wf, route); connect(wf, pick.name, route.name);

    // YES lane (top)
    var YES_Y = y - LANE_GAP;
    var enterYes = nFunction("Enter YES ("+modeLabel+")",
      "return [{ context:$items(2,0).json.context, __branch: $items(3,0).json.plan && ($items(3,0).json.plan.branches||[]).find(function(b){return b.key==='yes';}) || {key:'yes',steps:[]}, llm_key:$items(1,0).json.llm_key, llm_model:$items(1,0).json.llm_model, llm_base:$items(1,0).json.llm_base }];",
      X0 + SPAN*6, YES_Y
    ); addNode(wf, enterYes);
    connect(wf, route.name, enterYes.name, 0);

    var baseYesX = X0 + SPAN*7;
    var y1s = addAIStep(wf, baseYesX + SPAN*0, YES_Y, 1, 'yes');
    var y2s = addAIStep(wf, baseYesX + SPAN*4, YES_Y, 2, 'yes');
    var y3s = addAIStep(wf, baseYesX + SPAN*8, YES_Y, 3, 'yes');
    connect(wf, enterYes.name, y1s.in);
    connect(wf, y1s.out, y2s.in);
    connect(wf, y2s.out, y3s.in);

    // NO lane (bottom)
    var NO_Y = y + LANE_GAP;
    var enterNo = nFunction("Enter NO ("+modeLabel+")",
      "return [{ context:$items(2,0).json.context, __branch: $items(3,0).json.plan && ($items(3,0).json.plan.branches||[]).find(function(b){return b.key==='no';}) || {key:'no',steps:[]}, llm_key:$items(1,0).json.llm_key, llm_model:$items(1,0).json.llm_model, llm_base:$items(1,0).json.llm_base }];",
      X0 + SPAN*6, NO_Y
    ); addNode(wf, enterNo);
    connect(wf, route.name, enterNo.name, 1);

    var baseNoX = X0 + SPAN*7;
    var n1s = addAIStep(wf, baseNoX + SPAN*0, NO_Y, 1, 'no');
    var n2s = addAIStep(wf, baseNoX + SPAN*4, NO_Y, 2, 'no');
    var n3s = addAIStep(wf, baseNoX + SPAN*8, NO_Y, 3, 'no');
    connect(wf, enterNo.name, n1s.in);
    connect(wf, n1s.out, n2s.in);
    connect(wf, n2s.out, n3s.in);
  }

  // -------- Main builder --------
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

    // Two rows: PROD and DEMO (identical skeleton; DEMO can later seed fake tools)
    addBackbone(wf, scenario, industry, 240, 'PROD');
    addBackbone(wf, scenario, industry, 620, 'DEMO');

    wf.staticData.__design = {
      notes: [
        'Core-only nodes with per-step AI Agent: Function→HTTP→Function merge→Function run→Function record.',
        'Set OPENAI_API_KEY (and optionally OPENAI_MODEL/OPENAI_BASE_URL) in environment or Init node fields.',
        'If no API key is set, steps simulate (still producing valid actions).'
      ]
    };

    return wf;
  }

  // Expose
  window.Builder = { buildWorkflowJSON: buildWorkflowJSON };
})();
