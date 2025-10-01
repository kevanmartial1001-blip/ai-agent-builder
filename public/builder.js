// public/builder.js
// Linear, one-line builder with per-step AI Agents using ONLY core n8n nodes.
// Nodes used: manualTrigger v1, set v1, function v1, httpRequest v4.
// ASCII names only. Integer typeVersion only. Unique names. Main-connections only.

(function () {
  'use strict';

  // ------- Layout -------
  var X0 = -860, Y = 240;
  var SPAN = 300;        // horizontal gap between sequential nodes
  var GROUP = 4;         // nodes per "step group" (Draft -> Prompt -> AI -> Parse) then Run+Record (+2*SPAN)

  // ------- Helpers -------
  function safe(v){ return (v===null || v===undefined) ? '' : String(v); }

  function wfBase(title){
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

  function uniqName(wf, base){
    var names = new Set((wf.nodes||[]).map(function(n){ return String(n.name||''); }));
    var n = base, i = 2;
    while (names.has(n)) { n = base + ' #' + i; i++; }
    return n;
  }

  function addNode(wf, node){
    node.name = uniqName(wf, node.name);
    wf.nodes.push(node);
    return node.name;
  }

  function connect(wf, from, to, idx){
    var out = (typeof idx === 'number') ? idx : 0;
    if (!wf.connections[from]) wf.connections[from] = {};
    if (!wf.connections[from].main) wf.connections[from].main = [];
    while (wf.connections[from].main.length <= out) wf.connections[from].main.push([]);
    wf.connections[from].main[out].push({ node: to, type: 'main', index: 0 });
  }

  // ------- Node factories (core only) -------
  function nManual(name, x, y){
    return { id:'n_'+Math.random().toString(36).slice(2,10), name:name,
      type:'n8n-nodes-base.manualTrigger', typeVersion:1, position:[x,y], parameters:{} };
  }
  function nSet(name, kv, x, y){
    var strings=[], k;
    for (k in (kv||{})) if (Object.prototype.hasOwnProperty.call(kv, k)) {
      strings.push({ name:k, value: safe(kv[k]) });
    }
    return { id:'n_'+Math.random().toString(36).slice(2,10), name:name,
      type:'n8n-nodes-base.set', typeVersion:1, position:[x,y],
      parameters:{ keepOnlySet:false, values:{ string: strings } } };
  }
  function nFn(name, code, x, y){
    return { id:'n_'+Math.random().toString(36).slice(2,10), name:name,
      type:'n8n-nodes-base.function', typeVersion:1, position:[x,y],
      parameters:{ functionCode: code } };
  }
  function nHTTP(name, bodyExpr, x, y){
    // Simple, robust HTTP: Authorization uses env var OPENAI_API_KEY or Init field llm_key.
    return { id:'n_'+Math.random().toString(36).slice(2,10), name:name,
      type:'n8n-nodes-base.httpRequest', typeVersion:4, position:[x,y],
      parameters:{
        url: "={{ $json.llm_base || $env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions' }}",
        method: "POST",
        authentication: "none",
        jsonParameters: true,
        sendHeaders: true,
        headerParametersJson: "={{ { 'Content-Type':'application/json', 'Authorization': 'Bearer ' + ($json.llm_key || $env.OPENAI_API_KEY || '') } }}",
        bodyParametersJson: bodyExpr,
        options: {}
      }
    };
  }

  // ------- Function code blocks -------
  var FC_CONTEXT_DRAFT =
"// Build minimal context from Init values\\n" +
"var scenario = $json.scenario || {};\\n" +
"var industry = $json.industry || {};\\n" +
"var ctx = {\\n" +
"  intent: 'Automate: ' + (scenario.name || scenario.id || 'Scenario'),\\n" +
"  industry: industry.id || 'generic',\\n" +
"  guardrails: ['no spam','respect opt-out'],\\n" +
"  channels_ranked: ['whatsapp','email','sms','call']\\n" +
"};\\n" +
"return [{ context: ctx }];";

  var FC_CONTEXT_PROMPT =
"// Build OpenAI chat prompt for Context Agent\\n" +
"var schema = { intent:'string', industry:'string', guardrails:['string'], channels_ranked:['string'] };\\n" +
"var sys = 'You are Context Agent. Return ONLY JSON matching schema.';\\n" +
"var usr = 'Input: ' + JSON.stringify($json.context || {});\\n" +
"var model = $json.llm_model || $env.OPENAI_MODEL || 'gpt-5-mini';\\n" +
"var simulate = !($json.llm_key || $env.OPENAI_API_KEY);\\n" +
"return [{ __simulate: simulate, chat:{ model:model, temperature:0.2, response_format:{type:'json_object'}, messages:[{role:'system',content:sys},{role:'user',content:usr}] } }];";

  var FC_STEP_PROMPT =
"// Build per-step OpenAI chat prompt\\n" +
"var step = $json.draft || {};\\n" +
"var ctx  = $json.context || {};\\n" +
"var schema = { action:{ id:'', title:'', type:'send_message|check_data|http|wait|place_call|END', channel:'email|whatsapp|sms|call|none', tool:'', params:{} } };\\n" +
"var sys = 'You are Step Agent. Return ONLY JSON matching schema.';\\n" +
"var usr = 'Context: ' + JSON.stringify(ctx) + '\\nStepDraft: ' + JSON.stringify(step) + '\\nSchema: ' + JSON.stringify(schema);\\n" +
"var model = $json.llm_model || $env.OPENAI_MODEL || 'gpt-5-mini';\\n" +
"var simulate = !($json.llm_key || $env.OPENAI_API_KEY);\\n" +
"return [{ __simulate: simulate, chat:{ model:model, temperature:0.2, response_format:{type:'json_object'}, messages:[{role:'system',content:sys},{role:'user',content:usr}] } }];";

  var FC_PARSE_LLM =
"// Parse OpenAI response or simulate if key missing\\n" +
"if ($json.__simulate) {\\n" +
"  // Simulate by echoing draft or a minimal object\\n" +
"  if ($json.draft) return [{ action: $json.draft }];\\n" +
"  return [{ intent: ($json.context && $json.context.intent) || 'Automate', industry: ($json.context && $json.context.industry) || 'generic', guardrails:['no spam'], channels_ranked:['whatsapp','email'] }];\\n" +
"}\\n" +
"var raw = $json.choices && $json.choices[0] && $json.choices[0].message && $json.choices[0].message.content;\\n" +
"var obj;\\n" +
"try { obj = (typeof raw === 'string') ? JSON.parse(raw) : (raw || {}); } catch(e){ throw new Error('LLM JSON invalid'); }\\n" +
"if (!obj || (Object.keys(obj).length===0)) throw new Error('Empty JSON from LLM');\\n" +
"return [ obj ];";

  function FC_STEP_DRAFT(i, defaultTitle, branch) {
    // Simple draft selection (replace with real planner indexing later)
    return ""
+ "var step = ($json.plan && $json.plan.branches ? ($json.plan.branches.find(function(b){return b.key==='"+branch+"';})||{}).steps||[] : [] )["+(i-1)+"]\\n"
+ "         || { id:'s"+i+"', title:'"+defaultTitle+"', type:'send_message', channel:'email', tool:'MAILING', params:{ body:'Hello' } };\\n"
+ "return [{ draft: step }];";
  }

  var FC_RUNNER =
"function wait(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }\\n" +
"var a = $json.action || {};\\n" +
"async function exec(){\\n" +
"  var t = String(a.type || '').toLowerCase();\\n" +
"  if (t==='send_message') return { ok:true, channel:a.channel||'none', tool:a.tool||'', payload:a.params||{} };\\n" +
"  if (t==='check_data')  return { ok:true, check:a.params||{} };\\n" +
"  if (t==='http')        return { ok:true, simulated:true, request: a.params||{} };\\n" +
"  if (t==='wait')        { await wait((a.params && a.params.seconds ? a.params.seconds : 1)*200); return { ok:true, waited:a.params?a.params.seconds||1:1 }; }\\n" +
"  if (t==='place_call')  return { ok:true, channel:'call', script:a.params&&a.params.script||'' };\\n" +
"  return { ok:true, noop:true };\\n" +
"}\\n" +
"return exec().then(function(r){ return [{ exec:r }]; });";

  function FC_RECORD(label){
    return ""
+ "var h = Array.isArray($json.history) ? $json.history : [];\\n"
+ "h.push({ step: '"+label.replace(/'/g,'\\\'')+"', action: $json.action, result: $json.exec });\\n"
+ "return [{ history: h }];";
  }

  // ------- Context Agent block -------
  function addContextBlock(wf, x, y){
    var nDraft = nFn('Context Draft', FC_CONTEXT_DRAFT, x + SPAN*0, y); addNode(wf, nDraft);
    var nPrompt = nFn('Context Build Prompt', FC_CONTEXT_PROMPT, x + SPAN*1, y); addNode(wf, nPrompt); connect(wf, nDraft.name, nPrompt.name);
    var nAI = nHTTP('Context AI Agent', "={{ $json.chat }}", x + SPAN*2, y); addNode(wf, nAI); connect(wf, nPrompt.name, nAI.name);
    var nParse = nFn('Context Parse', FC_PARSE_LLM, x + SPAN*3, y); addNode(wf, nParse); connect(wf, nAI.name, nParse.name);
    return { in: nDraft.name, out: nParse.name };
  }

  // ------- Per-step AI block -------
  function addStepBlock(wf, x, y, idx, branchKey){
    var defTitle = (idx===1 ? (branchKey==='yes' ? 'Compose Primary' : 'Compose Fallback')
                   : idx===2 ? 'Check Decision'
                   : 'Execute');
    var nDraft = nFn('Step '+idx+' Draft ('+branchKey.toUpperCase()+')', FC_STEP_DRAFT(idx, defTitle, branchKey), x + SPAN*0, y); addNode(wf, nDraft);
    var nPrompt = nFn('Step '+idx+' Build Prompt ('+branchKey.toUpperCase()+')', FC_STEP_PROMPT, x + SPAN*1, y); addNode(wf, nPrompt); connect(wf, nDraft.name, nPrompt.name);
    var nAI = nHTTP('Step '+idx+' AI Agent ('+branchKey.toUpperCase()+')', "={{ $json.chat }}", x + SPAN*2, y); addNode(wf, nAI); connect(wf, nPrompt.name, nAI.name);
    var nParse = nFn('Step '+idx+' Parse ('+branchKey.toUpperCase()+')', FC_PARSE_LLM, x + SPAN*3, y); addNode(wf, nParse); connect(wf, nAI.name, nParse.name);
    var nRun = nFn('Step '+idx+' Run ('+branchKey.toUpperCase()+')', FC_RUNNER, x + SPAN*4, y); addNode(wf, nRun); connect(wf, nParse.name, nRun.name);
    var nRec = nFn('Step '+idx+' Record ('+branchKey.toUpperCase()+')', FC_RECORD('Step '+idx+' '+branchKey.toUpperCase()), x + SPAN*5, y); addNode(wf, nRec); connect(wf, nRun.name, nRec.name);
    return { in: nDraft.name, out: nRec.name };
  }

  // ------- Main builder -------
  function buildWorkflowJSON(scenario, industry, opts){
    opts = opts || {};
    var steps = (opts.steps && opts.steps.length ? opts.steps : ['Step1','Step2','Step3']).slice(0,3);

    var titleLeft  = safe(scenario && scenario.scenario_id ? scenario.scenario_id : 'Scenario');
    var titleRight = safe(scenario && scenario.name ? scenario.name : '');
    var title = (titleLeft + ' — ' + titleRight).replace(/\s+—\s+$/, '').replace(/^—\s+/, '');

    var wf = wfBase(title);

    // Manual trigger
    var nTrig = nManual('Manual Trigger', X0 + SPAN*0, Y); addNode(wf, nTrig);

    // Init (also carries LLM config; keep empty to simulate)
    var nInit = nSet('Init', {
      'scenario.id': safe(scenario && scenario.scenario_id),
      'scenario.name': safe(scenario && scenario.name),
      'industry.id': safe(industry && industry.industry_id),
      'llm_key': '',                 // optional; or use env OPENAI_API_KEY
      'llm_model': 'gpt-5-mini',     // optional; or env OPENAI_MODEL
      'llm_base': ''                 // optional; or env OPENAI_BASE_URL
    }, X0 + SPAN*1, Y); addNode(wf, nInit); connect(wf, nTrig.name, nInit.name);

    // Seed objects for downstream Function nodes
    var nInitData = nSet('Init Data', {
      'scenario': JSON.stringify({ id: safe(scenario && scenario.scenario_id), name: safe(scenario && scenario.name) }),
      'industry': JSON.stringify({ id: safe(industry && industry.industry_id) })
    }, X0 + SPAN*1, Y + 120); addNode(wf, nInitData); connect(wf, nTrig.name, nInitData.name);

    // Context Agent block
    var ctx = addContextBlock(wf, X0 + SPAN*2, Y);
    connect(wf, nInit.name, ctx.in);

    // Simple internal plan (yes/no) for drafts — you can replace later via LLM
    var nPlan = nFn('Planner Draft',
"var p = { branches:[\\n" +
" { key:'yes', steps:[ {id:'s1',title:'Compose Primary',type:'send_message',channel:'whatsapp',tool:'Twilio',params:{body:'Hello!'}}, {id:'s2',title:'Check Decision',type:'check_data',channel:'none',tool:'',params:{check:'profile'}}, {id:'s3',title:'Execute',type:'wait',channel:'none',tool:'',params:{seconds:1}} ]},\\n" +
" { key:'no',  steps:[ {id:'s1',title:'Compose Fallback',type:'send_message',channel:'email',tool:'MAILING',params:{subject:'Hi',body:'We are here'}}, {id:'s2',title:'Check Decision',type:'check_data',channel:'none',tool:'',params:{check:'reason'}}, {id:'s3',title:'Execute',type:'wait',channel:'none',tool:'',params:{seconds:1}} ]}\\n" +
"] };\\n" +
"return [{ plan: p, context: $items(0,0).json.context }];",
      X0 + SPAN*6, Y
    ); addNode(wf, nPlan); connect(wf, ctx.out, nPlan.name);

    // Chain YES lane (top-of-line: keep single line; conceptually YES)
    var baseYesX = X0 + SPAN*7;
    var y1 = addStepBlock(wf, baseYesX + SPAN*(GROUP*0), Y, 1, 'yes');
    var y2 = addStepBlock(wf, baseYesX + SPAN*(GROUP*1), Y, 2, 'yes');
    var y3 = addStepBlock(wf, baseYesX + SPAN*(GROUP*2), Y, 3, 'yes');
    connect(wf, nPlan.name, y1.in);
    connect(wf, y1.out, y2.in);
    connect(wf, y2.out, y3.in);

    // Summary
    var nSum = nSet('Summary', { status: 'done' }, baseYesX + SPAN*(GROUP*3), Y); addNode(wf, nSum);
    connect(wf, y3.out, nSum.name);

    // Design metadata
    wf.staticData.__design = {
      layout: { mode: 'one-line', span: SPAN, group: GROUP },
      notes: [
        'Per-step AI Agents via core httpRequest.',
        'If OPENAI_API_KEY is unset, AI nodes simulate but preserve JSON shape.',
        'Everything ASCII, integer typeVersion, unique names.'
      ]
    };

    return wf;
  }

  window.Builder = { buildWorkflowJSON: buildWorkflowJSON };
})();
