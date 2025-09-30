// public/builder.js
// COMPAT build: only core n8n nodes (Manual, Set, Code, HTTP Request, Switch).
// No LangChain nodes. Safe to import on any n8n.
// Layout: two rows (PROD, DEMO). Branches: YES and NO.
// Backbone: Manual → Init → Context (LLM via HTTP) → Schema-Map (LLM via HTTP) → Switch → Lanes
// Each step: Step Agent (LLM via HTTP) → JSON Validator → Runner → Recorder

(function () {
  "use strict";

  // ===== Layout (fixed rails) =====
  const L = { HEADER: { x: -900, y: 40 }, ROW_PROD_Y: 240, ROW_DEMO_Y: 720, START_X: -860 };
  const H = { SPAN: 320, GROUP: 4, BLOCK: 4, LANE_GAP_Y: 240, AFTER_SWITCH_SPANS: 2 };

  // ===== Utils =====
  const uid  = (p)=>`${p}_${Math.random().toString(36).slice(2,10)}`;
  const pos  = (x,y)=>[x,y];
  const oneLine = (v)=> v == null ? "" : Array.isArray(v) ? v.map(oneLine).filter(Boolean).join(" | ") : (typeof v==="object" ? JSON.stringify(v) : String(v));
  const esc = (s)=> oneLine(s).replace(/"/g,'\\"');

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
    const ex=new Set((wf.nodes||[]).map(n=>String(n.name||'').toLowerCase()));
    let nm=base||'Node', i=1; while(ex.has(nm.toLowerCase())){ i++; nm=`${base} #${i}`;} return nm;
  }
  function addNode(wf,node){ node.name=uniqueName(wf,node.name); wf.nodes.push(node); return node.name; }
  function connect(wf,from,to,idx=0){
    wf.connections[from]??={}; wf.connections[from].main??=[];
    for(let i=wf.connections[from].main.length;i<=idx;i++) wf.connections[from].main[i]=[];
    wf.connections[from].main[idx].push({ node: to, type:"main", index:0 });
  }

  // ===== Core palette =====
  const label = (wf, txt, x, y)=> addNode(wf,{
    id:uid('lbl'), name:`=== ${txt} ===`, type:'n8n-nodes-base.set', typeVersion:2, position:pos(x,y),
    parameters:{ keepOnlySet:false, values:{ string:[{ name:'__zone', value:`={{'${txt}'}}` }] } }
  });
  const manual = (wf,x,y)=> addNode(wf,{ id:uid('m'), name:'Manual Trigger', type:'n8n-nodes-base.manualTrigger', typeVersion:1, position:pos(x,y), parameters:{} });
  const setNode = (wf,name,fields,x,y)=> addNode(wf,{ id:uid('set'), name, type:'n8n-nodes-base.set', typeVersion:2, position:pos(x,y),
    parameters:{ keepOnlySet:false, values:{ string:Object.entries(fields||{}).map(([k,v])=>({name:k, value:v})) } } });
  const codeNode = (wf,name,js,x,y)=> addNode(wf,{ id:uid('code'), name, type:'n8n-nodes-base.code', typeVersion:2, position:pos(x,y),
    parameters:{ jsCode: js } });
  const httpNode = (wf,name,bodyJson,x,y)=> addNode(wf,{ id:uid('http'), name, type:'n8n-nodes-base.httpRequest', typeVersion:4, position:pos(x,y),
    parameters:{
      url: "={{$json.__llm_base || $env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions'}}",
      method: "POST",
      authentication: "none",
      jsonParameters: true,
      options: {},
      sendHeaders: true,
      headerParametersJson: "={{ { 'Content-Type':'application/json', 'Authorization': 'Bearer ' + ($json.__llm_key || $env.OPENAI_API_KEY || '') } }}",
      bodyParametersJson: bodyJson
    }
  });
  const switchNode = (wf,name,expr,values,x,y)=> addNode(wf,{ id:uid('sw'), name, type:'n8n-nodes-base.switch', typeVersion:2, position:pos(x,y),
    parameters:{ value1: expr, rules: values.map(v=>({ operation:'equal', value2:v })) }
  });

  // ===== Contracts (schemas the validators enforce) =====
  const SCHEMA_CONTEXT = { intent:"", industry:"", constraints:[], success:"", channels_ranked:[], guardrails:[] };
  const SCHEMA_PLAN = {
    trigger:{ kind:"", why:"" },
    archetype:{ name:"", confidence:0 },
    branches:[
      { key:"yes", title:"Yes path", why:"", steps:[{ id:"s1", title:"Action 1", type:"send_message", channel:"whatsapp", tool:"Twilio", params:{} }] },
      { key:"no",  title:"No path",  why:"", steps:[{ id:"s1", title:"Action 1", type:"send_message", channel:"email",    tool:"MAILING", params:{} }] }
    ],
    errors:[],
    tools_suggested:[]
  };
  const SCHEMA_STEP = { action:{ id:"", title:"", type:"send_message", channel:"email", tool:"", params:{} }, notes:[] };

  // ===== Prompt text (system/user) =====
  const SYS_CONTEXT =
`You are 🧠 Context Distiller. Input = 4 columns (triggers, best_reply_shapes, risk_notes, roi_hypothesis) + industry + tags.
Return a SMALL JSON:
${JSON.stringify(SCHEMA_CONTEXT, null, 2)}
- channels_ranked must be a subset of ["email","whatsapp","sms","call","chat"].`;

  const SYS_PLANNER =
`You are 🗺️ Schema-Map Architect. Build trigger, archetype, and exactly 2 branches: "yes" and "no".
Each branch.steps is a list of actionable steps with {id,title,type,channel,tool,params}.
Keep channels/tools modern and realistic. Return strictly:
${JSON.stringify(SCHEMA_PLAN, null, 2)}`;

  const SYS_STEP =
`You are a specialist Step Agent. Given the Context + a Branch + a Step draft, output exactly:
${JSON.stringify(SCHEMA_STEP, null, 2)}
- When type is send_message/place_call, write natural, human copy in params (subject/body or script), no IVR "press 1".`;

  // Helper to build Chat Completions request body (OpenAI-compatible)
  const bodyLLM = (systemText, userText)=>
`={{ {
  model: $json.__llm_model || 'gpt-5-mini',
  temperature: 0.2,
  response_format: { type: 'json_object' },
  messages: [
    { role: 'system', content: ${JSON.stringify(systemText)} },
    { role: 'user',   content: ${JSON.stringify(userText)} }
  ]
} }}`;

  // ===== JSON validator code (strict but small) =====
  const VALIDATE_JSON =
`function isObj(o){return o && typeof o==='object' && !Array.isArray(o);}
const raw = $json.choices?.[0]?.message?.content || $json.output || $json;
let parsed;
try{ parsed = typeof raw==='string' ? JSON.parse(raw) : raw; }catch(e){ throw new Error('LLM did not return valid JSON'); }
return [parsed];`;

  // ===== Runner (simulate tools; do real HTTP only if url provided and PROD) =====
  const RUNNER =
`const mode = $json.__mode || 'prod';
const a = $json.action || {};
const demo = $json.__demo || {};
function fillDemo(p){
  const ch = (a.channel||'').toLowerCase();
  const out = {...(p||{})};
  if(ch==='whatsapp' || ch==='sms'){ out.to = out.to || demo.to || '+34613030526'; out.from = out.from || (ch==='whatsapp'? demo.waFrom : demo.smsFrom); }
  if(ch==='email'){ out.to = out.to || demo.emailTo || 'kevanm.spain@gmail.com'; out.subject = out.subject || 'Demo'; }
  if(ch==='call'){ out.to = out.to || demo.to || '+34613030526'; out.from = out.from || demo.callFrom; }
  return out;
}
async function exec(){
  switch(String(a.type||'').toLowerCase()){
    case 'send_message': return { ok:true, channel:a.channel, tool:a.tool, sent: mode==='demo'? fillDemo(a.params): (a.params||{}) };
    case 'place_call':   return { ok:true, channel:'call', tool:a.tool,  placed: mode==='demo'? fillDemo(a.params): (a.params||{}) };
    case 'check_data':   return { ok:true, check:a.params||{} };
    case 'wait':         await new Promise(r=>setTimeout(r,(a.params?.seconds||5)*1000)); return { ok:true, waited:a.params?.seconds||5 };
    case 'http': {
      if(mode==='demo') return { ok:true, simulated:true, url:a.params?.url||'FAKE', payload:a.params?.body||{} };
      if(!a.params?.url) return { ok:true, skipped:true };
      const res = await this.helpers.httpRequest({ url:a.params.url, method:a.params.method||'POST', json:true, body:a.params.body||{}, resolveWithFullResponse:true });
      return { ok: res.statusCode>=200 && res.statusCode<300, status: res.statusCode, body: res.body };
    }
    default: return { ok:true, noop:true };
  }
}
return exec().then(r => [{ ...$json, __exec:r }]);`;

  const RECORDER = (label, lane, mode)=>
`const hist=Array.isArray($json.__history)?$json.__history:[]; 
hist.push({ step:'${label}', lane:'${lane}', mode:'${mode}', action: $json.action, result:$json.__exec });
return [{ ...$json, __history: hist }];`;

  // ===== Backbone per row =====
  function addBackbone(wf, scenario, industry, y, mode, demoSeeds){
    const trig = manual(wf, L.START_X, y);
    const init = setNode(wf, `Init (${mode.toUpperCase()})`, {
      'scenario.id':     `={{'${esc(scenario?.scenario_id)}'}}`,
      'scenario.name':   `={{'${esc(scenario?.name)}'}}`,
      'industry.id':     `={{'${esc(industry?.industry_id)}'}}`,
      '__mode':          `={{'${mode}'}}`,
      // you can set these in n8n Settings → Environment Variables
      '__llm_key':       "={{$env.OPENAI_API_KEY || ''}}",
      '__llm_model':     "={{$env.OPENAI_MODEL || 'gpt-5-mini'}}",
      '__llm_base':      "={{$env.OPENAI_BASE_URL || ''}}",
      '__demo':          JSON.stringify(demoSeeds||{})
    }, L.START_X + H.SPAN, y);
    connect(wf, trig, init);

    // Context (HTTP LLM) → Validator
    const ctxUser =
`=Context input:
{
  "industry":"${esc(industry?.industry_id)}",
  "triggers":"${esc(scenario?.triggers)}",
  "best_reply_shapes":"${esc(scenario?.best_reply_shapes)}",
  "risk_notes":"${esc(scenario?.risk_notes)}",
  "roi_hypothesis":"${esc(scenario?.roi_hypothesis)}",
  "tags":"${esc(scenario?.['tags (;)'] ?? scenario?.tags)}"
}
Return strictly a JSON matching this shape, nothing else.`;
    const ctxReq = httpNode(wf, `🧠 Context (HTTP) · ${mode}`, bodyLLM(SYS_CONTEXT, ctxUser), L.START_X + H.SPAN*2, y);
    const ctxVal = codeNode(wf, `🧠 Context · JSON Validator · ${mode}`, VALIDATE_JSON, L.START_X + H.SPAN*3, y);
    connect(wf, init, ctxReq); connect(wf, ctxReq, ctxVal);

    // Schema-Map (HTTP LLM) → Validator
    const plUser =
`=Planner input:
{
  "context": {{$json}},
  "hints": "Build a bullet-proof map for this scenario; choose best channels/tools; include a short error catalog."
}
Return strictly the required JSON with exactly two branches: yes and no.`;
    const plReq = httpNode(wf, `🗺️ Schema-Map (HTTP) · ${mode}`, bodyLLM(SYS_PLANNER, plUser), L.START_X + H.SPAN*4, y);
    const plVal = codeNode(wf, `🗺️ Schema-Map · JSON Validator · ${mode}`, VALIDATE_JSON, L.START_X + H.SPAN*5, y);
    connect(wf, ctxVal, plReq); connect(wf, plReq, plVal);

    // Pack context for step agents
    const pack = codeNode(wf, `Pack Context · ${mode}`,
      `return [{ __context: $items(0,0).json }];`,
      L.START_X + H.SPAN*6, y);
    connect(wf, plVal, pack);

    // Switch (routes by a provided key; we keep outputs in order: yes = 0, no = 1)
    const sw = switchNode(wf, `Route Branch (${mode.toUpperCase()})`, "={{$json.branches && $json.branches[0] && $json.branches[0].key || 'yes'}}", ["yes","no"], L.START_X + H.SPAN*7, y);
    connect(wf, pack, sw);

    return { switchName: sw };
  }

  // ===== Build a lane with N steps =====
  function addLane(wf, startX, baseY, branchKey, scenario, mode){
    const title = branchKey === 'yes' ? 'YES path' : 'NO path';
    label(wf, `${mode.toUpperCase()} · Branch: ${title}`, startX - H.SPAN, baseY - 100);

    // Start node injects the chosen branch skeleton
    const enter = codeNode(wf, `Enter · ${branchKey} · ${mode}`,
      // from planner result at runtime; here we keep the shape and let agents fill fields
      `const ctx = $json.__context || {};
const plan = $items(1,0)?.json || {}; // upstream planner validator output in parallel path
const branch = (Array.isArray(plan.branches)?plan.branches:[]).find(b=>String(b.key||'')==='${branchKey}') || { key:'${branchKey}', title:'${title}', steps:[] };
return [{ __context: ctx, __branch: branch, __mode: '${mode}', __demo: ${ JSON.stringify(mode==='demo' ? {
        to:"+34613030526", emailTo:"kevanm.spain@gmail.com", waFrom:"+14155238886", smsFrom:"+13412184164", callFrom:"+13412184164"
      } : {}) }];`,
      startX, baseY
    );

    return { enter };
  }

  // ===== One Step Agent group (LLM HTTP → Validator → Runner → Recorder) =====
  function addStepGroup(wf, baseX, y, labelPrefix, scenario, branchKey, mode){
    const stepTitle = `${labelPrefix}`;
    const stepDraft = { id: labelPrefix.toLowerCase().replace(/\s+/g,'_'), title: stepTitle, type: "send_message", channel: (branchKey==='yes'?'whatsapp':'email'), tool: (branchKey==='yes'?'Twilio':'MAILING'), params: {} };

    const user =
`=Step Agent input:
{
  "context": {{$json.__context}},
  "branch": {{$json.__branch}},
  "step": ${JSON.stringify(stepDraft)}
}
Return strictly the required JSON.`;

    const req = httpNode(wf, `🧩 ${stepTitle} · Agent (HTTP) · ${mode}`, bodyLLM(SYS_STEP, user), baseX + H.SPAN*0, y);
    const val = codeNode(wf, `🧩 ${stepTitle} · JSON Validator · ${mode}`, VALIDATE_JSON, baseX + H.SPAN*1, y);
    const run = codeNode(wf, `Run · ${stepTitle} · ${mode}`, RUNNER, baseX + H.SPAN*2, y);
    const rec = codeNode(wf, `Record · ${stepTitle} · ${mode}`, RECORDER(stepTitle, branchKey, mode), baseX + H.SPAN*3, y);

    connect(wf, req, val); connect(wf, val, run); connect(wf, run, rec);
    return { in: req, out: rec };
  }

  // ===== Build the whole workflow =====
  function buildWorkflowJSON(scenario, industry, opts = {}){
    const title = `${oneLine(scenario?.scenario_id)||'Scenario'} — ${oneLine(scenario?.name)||''}`.trim();
    const wf = baseWorkflow(title);

    label(wf, 'FLOW · PRODUCTION', L.HEADER.x, L.HEADER.y);
    label(wf, 'FLOW · DEMO',       L.HEADER.x, L.HEADER.y + (L.ROW_DEMO_Y - L.ROW_PROD_Y));

    // DEMO seeds (used in Init)
    const demoSeeds = {
      to: "+34613030526",
      emailTo: "kevanm.spain@gmail.com",
      waFrom: "+14155238886",
      smsFrom: "+13412184164",
      callFrom: "+13412184164",
      ...(opts.demoSeeds||{})
    };

    // Backbones
    const prod = addBackbone(wf, scenario, industry, L.ROW_PROD_Y, 'prod', {});
    const demo = addBackbone(wf, scenario, industry, L.ROW_DEMO_Y, 'demo', demoSeeds);

    // Lanes: YES and NO for each row
    function buildRow(rowY, switchName, mode){
      const lanes = {
        yes: addLane(wf, L.START_X + H.SPAN*(7 + H.AFTER_SWITCH_SPANS), rowY + 0*H.LANE_GAP_Y, 'yes', scenario, mode),
        no:  addLane(wf, L.START_X + H.SPAN*(7 + H.AFTER_SWITCH_SPANS), rowY + 1*H.LANE_GAP_Y, 'no',  scenario, mode)
      };
      // Wire switch outputs: 0 → yes, 1 → no
      connect(wf, switchName, lanes.yes.enter, 0);
      connect(wf, switchName, lanes.no.enter,  1);

      // Step groups per lane (keep it simple and visible: 3 steps per lane)
      ['yes','no'].forEach((k)=>{
        const baseX0 = L.START_X + H.SPAN*(8 + H.AFTER_SWITCH_SPANS);
        const y = k==='yes' ? rowY + 0*H.LANE_GAP_Y : rowY + 1*H.LANE_GAP_Y;

        const g1 = addStepGroup(wf, baseX0 + H.SPAN*0, y, 'Step 1 — Gather/Compose', scenario, k, mode);
        const g2 = addStepGroup(wf, baseX0 + H.SPAN*H.BLOCK, y, 'Step 2 — Check/Decide', scenario, k, mode);
        const g3 = addStepGroup(wf, baseX0 + H.SPAN*H.BLOCK*2, y, 'Step 3 — Execute', scenario, k, mode);

        connect(wf, lanes[k].enter, g1.in);
        connect(wf, g1.out, g2.in);
        connect(wf, g2.out, g3.in);

        const done = setNode(wf, `Lane Done (${k.toUpperCase()}, ${mode.toUpperCase()})`, { [`__lane_${k}_${mode}`]:'={{true}}' }, baseX0 + H.SPAN*H.BLOCK*3 + H.SPAN, y);
        connect(wf, g3.out, done);
      });
    }

    buildRow(L.ROW_PROD_Y, prod.switchName, 'prod');
    buildRow(L.ROW_DEMO_Y, demo.switchName, 'demo');

    // Design note
    wf.staticData.__design = {
      layout:{ span:H.SPAN, block:H.BLOCK, lanes:['yes','no'], rows:{prod:L.ROW_PROD_Y, demo:L.ROW_DEMO_Y} },
      notes:[
        'Uses only core nodes; no LangChain. Safe import.',
        'LLM via HTTP to OpenAI; set OPENAI_API_KEY/OPENAI_MODEL/OPENAI_BASE_URL in env.',
        'Two rows (PROD/DEMO). Branches: YES and NO.',
        'Each step = Agent(HTTP) → Validator(Code) → Runner(Code) → Recorder(Code).'
      ]
    };

    return wf;
  }

  window.Builder = { buildWorkflowJSON };
})();
