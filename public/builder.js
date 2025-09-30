// public/builder.js
// n8n JSON generator — Digital Team + Visual Action Rail
// - Team of agents (Preflight → Research → Planner → Orchestrator → Composer → QA → Summarizer)
// - Fan-in of all validators → Execution Agent → Visible Action Rail (node-per-action)
// - Minimal, readable canvas with anti-overlap grid

(function () {
  "use strict";

  // ========== Layout & Grid ==========
  const LAYOUT = { stepX: 360, header:{x:-900,y:40}, start:{x:-860,y:240} };
  const GRID   = { cellH: 70, cellW: 80 };
  const FOOT   = { w: 3, h: 3 };

  // ========== Minimal Demo Endpoints (safe defaults) ==========
  const DEMO = {
    callWebhook: 'https://example.com/call',
    opsAlert:    'https://example.com/ops/alert'
  };

  // ========== Utils ==========
  const uid=(p)=>`${p}_${Math.random().toString(36).slice(2,10)}`;
  const pos=(x,y)=>[x,y];
  const snapX=(x)=> Math.round(x/GRID.cellW)*GRID.cellW;
  const snapY=(y)=> Math.round(y/GRID.cellH)*GRID.cellH;

  function baseWorkflow(name){
    return { name, nodes:[], connections:{}, active:false,
      settings:{ executionOrder:"v1", timezone:"Europe/Madrid" },
      staticData:{}, __occ:new Set()
    };
  }
  function uniqueName(wf, base){
    const ex=new Set((wf.nodes||[]).map(n=>String(n.name||'').toLowerCase()));
    let nm=base||'Node', i=1; while(ex.has(nm.toLowerCase())){ i++; nm=`${base} #${i}`; } return nm;
  }
  function blockCells(x,y,w=FOOT.w,h=FOOT.h){
    const sx=snapX(x), sy=snapY(y), cells=[];
    for(let dx=0;dx<w;dx++) for(let dy=0;dy<h;dy++) cells.push(`${sx+dx*GRID.cellW}:${sy+dy*GRID.cellH}`);
    return cells;
  }
  function blockFree(wf,x,y,w=FOOT.w,h=FOOT.h){ return blockCells(x,y,w,h).every(c=>!wf.__occ.has(c)); }
  function reserveBlock(wf,x,y,w=FOOT.w,h=FOOT.h){ blockCells(x,y,w,h).forEach(c=>wf.__occ.add(c)); return [snapX(x), snapY(y)]; }
  function findFreeY(wf,x,desiredY,w=FOOT.w,h=FOOT.h){
    const sx=snapX(x); let y=snapY(desiredY); const step=GRID.cellH; while(!blockFree(wf,sx,y,w,h)){ y+=step; } return y;
  }
  function addNode(wf,node){
    node.name = uniqueName(wf, node.name);
    if (Array.isArray(node.position)){
      const x=snapX(node.position[0]); const y=findFreeY(wf,x,node.position[1],FOOT.w,FOOT.h);
      node.position=[x,y]; reserveBlock(wf,x,y,FOOT.w,FOOT.h);
    }
    wf.nodes.push(node); return node.name;
  }
  function connect(wf,from,to,outputIndex=0){
    wf.connections[from]??={}; wf.connections[from].main??=[];
    for(let i=wf.connections[from].main.length;i<=outputIndex;i++) wf.connections[from].main[i]=[];
    wf.connections[from].main[outputIndex].push({ node: to, type:"main", index:0 });
  }

  // ========== Basic Palette ==========
  function addHeader(wf,label,x,y){
    return addNode(wf,{ id:uid('label'), name:`=== ${label} ===`,
      type:'n8n-nodes-base.set', typeVersion:2, position:pos(x,y),
      parameters:{ keepOnlySet:false, values:{ string:[{ name:'__zone', value:`={{'${label}'}}` }] } }
    });
  }
  function addManual(wf,x,y,label='Manual Trigger'){
    return addNode(wf,{ id:uid('manual'), name:label, type:'n8n-nodes-base.manualTrigger', typeVersion:1, position:pos(x,y), parameters:{} });
  }
  function addSimTrigger(wf, kind, x, y){
    return addNode(wf,{ id:uid('sim'), name:`Simulated Trigger · ${String(kind||'CRON').toUpperCase()}`,
      type:'n8n-nodes-base.set', typeVersion:2, position:pos(x,y),
      parameters:{ keepOnlySet:false, values:{ string:[{ name:'__trigger', value:`={{'${String(kind||'cron').toUpperCase()}'}}` }] } }
    });
  }
  function addSet(wf,name,fields,x,y){
    const stringVals = Object.entries(fields||{}).map(([k,v])=>({ name:k, value:v }));
    return addNode(wf,{ id:uid('set'), name, type:'n8n-nodes-base.set', typeVersion:2, position:pos(x,y),
      parameters:{ keepOnlySet:false, values:{ string: stringVals } } });
  }
  function addHTTP(wf,name,urlExpr,bodyExpr,x,y,method='POST'){
    return addNode(wf,{ id:uid('http'), name, type:'n8n-nodes-base.httpRequest', typeVersion:4, position:pos(x,y),
      parameters:{ url:urlExpr, method, jsonParameters:true, sendBody:true, bodyParametersJson:bodyExpr, options:{ fullResponse:true } }
    });
  }
  function addIf(wf,name,expr,value,x,y){
    return addNode(wf,{ id:uid('if'), name, type:'n8n-nodes-base.if', typeVersion:2, position:pos(x,y),
      parameters:{ conditions:{ string:[{ value1:expr, operation:'equal', value2:value }] } }});
  }

  // ========== Agent Contracts ==========
  const SCHEMA_PREFLIGHT = `{"intent":"string","user_state_hypotheses":["string"],"risks":["string"],"kpis":["string"],"channels_ranked":["email","whatsapp","sms","call"],"guardrails":["string"]}`;
  const SCHEMA_RESEARCH  = `{"company":{"name":"string","domain":"string","geo":"string","stack":["string"]},"personas":["string"],"intel":["string"]}`;
  const SCHEMA_PLANNER   = `{"steps":["string"],"decisions":[{"step":"number","name":"string","outcomes":["string"]}],"error_catalog":[{"code":"string","hint":"string"}]}`;
  const SCHEMA_ORCH      = `{"tool_calls":[{"name":"string","url":"string","payload":{"_":"any"},"on_success_next":"string","on_error_next":"string"}]}`;
  const SCHEMA_COMPOSER  = `{"email":{"subject":"string","body":"string"},"whatsapp":{"body":"string"},"sms":{"body":"string"},"call":{"script":"string"}}`;
  const SCHEMA_QA        = `{"ok":true,"reasons":["string"],"fixups":[{"field":"string","value":"string"}]}`;
  const SCHEMA_SUMMARY   = `{"highlights":["string"],"decisions_taken":["string"],"next_actions":["string"]}`;
  const SCHEMA_EXECUTION = `{"actions":[{"id":"string","type":"http|send_whatsapp|place_call|wait|set|log|END","when":"now|after_prev|if(decision=value)","params":{},"on_success":"string","on_error":"string"}],"entrypoint":"string","env":{"channel_bundle":{"email":{"subject":"string","body":"string"},"whatsapp":{"body":"string"},"call":{"script":"string"}}}}`;

  const SYS_PREFLIGHT = `You are PreFlight. Distill messy scenario fields into a clean JSON context. Output strict JSON only.`;
  const SYS_RESEARCH  = `You are Researcher. Enrich with light company/stack/persona intel using only provided inputs. No web calls. JSON only.`;
  const SYS_PLANNER   = `You are Planner. Produce a numbered decision plan for this scenario. JSON only.`;
  const SYS_ORCH      = `You are Orchestrator. Turn the plan into concrete tool calls/steps. JSON only.`;
  const SYS_COMPOSER  = `You are Composer. Produce channel-specific copy/scripts grounded in context. JSON only.`;
  const SYS_QA        = `You are QA. Validate the bundle & propose minimal fixups. JSON only.`;
  const SYS_SUMMARY   = `You are Summarizer. Output concise highlights for BI/Slack. JSON only.`;
  const SYS_EXECUTION = `You are Execution. From all prior agents (Preflight, Research, Planner, Orchestrator, Composer, QA), emit a STRICT JSON playbook per SCHEMA_EXECUTION. ≤20 actions. Use Composer content; use Orchestrator URLs when present.`;

  // ========== Agent Helper (Agent → Parser → Validator) ==========
  function addAgent(wf, cfg){
    const {
      role='Agent', x=0, y=0, systemPrompt='You are an agent.', userPromptExpr='={{$json}}',
      schema=SCHEMA_PREFLIGHT, modelName='gpt-5-mini', temperature=0.2, credsName='OpenAi account'
    } = cfg;

    const lm = addNode(wf, {
      id: uid('lm'), name: `${role} · OpenAI Chat Model`,
      type: "@n8n/n8n-nodes-langchain.lmChatOpenAi", typeVersion: 1.2, position: pos(x, y+152),
      parameters: { model: { "__rl": true, "value": modelName, "mode": "list", "cachedResultName": modelName }, options: { temperature } },
      credentials: { openAiApi: { id: "OpenAI_Creds_Id", name: credsName } }
    });
    const parser = addNode(wf, {
      id: uid('parser'), name: `${role} · Structured Parser`,
      type: "@n8n/n8n-nodes-langchain.outputParserStructured", typeVersion: 1.3, position: pos(x+144, y+268),
      parameters: { jsonSchemaExample: schema }
    });
    const agent = addNode(wf, {
      id: uid('agent'), name: `${role}`,
      type: "@n8n/n8n-nodes-langchain.agent", typeVersion: 2.2, position: pos(x, y),
      parameters: { promptType:"define", text: userPromptExpr, hasOutputParser:true, options:{ systemMessage:`=${systemPrompt}` } }
    });
    // Wire LM + Parser into Agent
    wf.connections[lm]     = { ai_languageModel: [[{ node: agent, type: "ai_languageModel", index: 0 }]] };
    wf.connections[parser] = { ai_outputParser:  [[{ node: agent, type: "ai_outputParser",  index: 0 }]] };

    // JSON Validator
    const validator = addNode(wf, {
      id: uid('code'), name: `${role} · JSON Validator`,
      type: "n8n-nodes-base.code", typeVersion: 2, position: pos(x+300, y),
      parameters: { jsCode:
`const out = $json.output ?? $json;
if (typeof out !== 'object' || out === null || Array.isArray(out)) throw new Error('Agent did not return an object');
return [out];` }
    });
    connect(wf, agent, validator);

    return { in: agent, out: validator, lm, parser };
  }

  // ========== Digital Team (fixed) ==========
  function makeTeam(){
    return [
      { key:'preflight',  role:'Pre-flight Context Agent', schema:SCHEMA_PREFLIGHT, sys:SYS_PREFLIGHT,
        user:(s,i)=>`=Distill scenario into ${SCHEMA_PREFLIGHT}:\n${scenarioJSON(s,i)}` },
      { key:'research',   role:'Research Agent',           schema:SCHEMA_RESEARCH,  sys:SYS_RESEARCH,
        user:(s,i)=>`=Light research from inputs only into ${SCHEMA_RESEARCH}:\n${scenarioJSON(s,i)}` },
      { key:'planner',    role:'Planner / Schema-Map Agent',schema:SCHEMA_PLANNER,  sys:SYS_PLANNER,
        user:(s,i)=>`=Plan into ${SCHEMA_PLANNER}. Context:\n{{$json}}` },
      { key:'orch',       role:'Ops / Tool Orchestrator',  schema:SCHEMA_ORCH,      sys:SYS_ORCH,
        user:(s,i)=>`=Turn the plan into concrete tool calls ${SCHEMA_ORCH}. Input:\n{{$json}}` },
      { key:'composer',   role:'Channel Composer',         schema:SCHEMA_COMPOSER,  sys:SYS_COMPOSER,
        user:(s,i)=>`=Compose channel bundle ${SCHEMA_COMPOSER} using context & plan:\n{{$json}}` },
      { key:'qa',         role:'QA / Validator',           schema:SCHEMA_QA,        sys:SYS_QA,
        user:(s,i)=>`=Validate and return ${SCHEMA_QA}. Fixups only if trivial. Input:\n{{$json}}` },
      { key:'summary',    role:'Summarizer / Logger',      schema:SCHEMA_SUMMARY,   sys:SYS_SUMMARY,
        user:(s,i)=>`=Summarize into ${SCHEMA_SUMMARY} from:\n{{$json}}` },
    ];
  }
  function scenarioJSON(s, industry){
    return `{
  "industry":"${industry?.industry_id||''}",
  "scenario_id":"${s.scenario_id||''}",
  "name":"${(s.name||'').replace(/"/g,'\\"')}",
  "triggers":"${(s.triggers||'').replace(/"/g,'\\"')}",
  "how_it_works":"${(s.how_it_works||'').replace(/"/g,'\\"')}",
  "roi_hypothesis":"${(s.roi_hypothesis||'').replace(/"/g,'\\"')}",
  "risk_notes":"${(s.risk_notes||'').replace(/"/g,'\\"')}",
  "tags": ${JSON.stringify((s["tags (;)"]||s.tags||'').toString().split(/[;,/|\n]+/).map(x=>x.trim()).filter(Boolean))}
}`;
  }
  function addTeamChain(wf, team, originNodeName, baseX, baseY, s, i){
    let cursor = originNodeName;
    let x = baseX, y = baseY - 120;
    const outNodes = {};
    team.forEach(t=>{
      const a = addAgent(wf, {
        role:t.role, x, y, systemPrompt:`=${t.sys}`, userPromptExpr: t.user(s,i),
        schema:t.schema, modelName:'gpt-5-mini', temperature:(t.key==='composer'?0.5:0.2)
      });
      connect(wf, cursor, a.in);
      cursor = a.out; outNodes[t.key]=a; x += 320;
    });
    return { tail: cursor, outNodes };
  }

  // ========== Fan-in of all agent JSONs ==========
  function addFanInAgents(wf, labels, x, y){
    return addNode(wf, {
      id: uid('code'), name: 'Fan-in · Consolidate Agent Outputs',
      type: 'n8n-nodes-base.code', typeVersion: 2, position: pos(x, y),
      parameters: { jsCode:
`const out = {};
(${JSON.stringify(labels)}).forEach((label, i) => {
  const it = $items(i) || [];
  const last = it.length ? it[it.length-1].json : {};
  out[label] = last;
});
return [out];`
      }
    });
  }

  // ========== Execution Agent ==========
  function addExecutionAgent(wf, x, y){
    return addAgent(wf, {
      role: 'Execution Agent',
      x, y,
      systemPrompt: `=${SYS_EXECUTION}`,
      userPromptExpr: `=Build the playbook ${SCHEMA_EXECUTION} from all prior agent JSON:\n{{$json}}`,
      schema: SCHEMA_EXECUTION,
      modelName: 'gpt-5-mini',
      temperature: 0.2
    });
  }

  // ========== Visual Action Rail ==========
  function addPickAction(wf, i, x, y){
    return addNode(wf, {
      id: uid('code'), name: `[${i}] Pick Action`,
      type: 'n8n-nodes-base.code', typeVersion: 2, position: pos(x, y),
      parameters: { jsCode:
`const i = ${i} - 1;
const play = $json || {};
const actions = Array.isArray(play.actions) ? play.actions : [];
const a = actions[i] || { id: 'END', type: 'END', params: {} };
return [{ ...play, __i: ${i}, __action: a }];`
      }
    });
  }
  function addIfEnd(wf, x, y){ return addIf(wf,'END?',"={{$json.__action.type}}",'END',x,y); }
  function addRouteType(wf, x, y){
    return addNode(wf, {
      id: uid('switch'), name: 'Route by Type',
      type: 'n8n-nodes-base.switch', typeVersion: 2, position: pos(x, y),
      parameters: { value1: "={{$json.__action.type}}", rules: [
        { operation:'equal', value2:'http' },
        { operation:'equal', value2:'send_whatsapp' },
        { operation:'equal', value2:'place_call' },
        { operation:'equal', value2:'wait' },
        { operation:'equal', value2:'set' },
        { operation:'equal', value2:'log' }
      ]}
    });
  }
  function addHttpRunner(wf, x, y){
    return addNode(wf, { id: uid('http'), name: 'HTTP',
      type:'n8n-nodes-base.httpRequest', typeVersion:4, position:pos(x,y),
      parameters:{ url:"={{$json.__action.params.url}}", method:"={{$json.__action.params.method || 'POST'}}",
        jsonParameters:true, sendBody:true, bodyParametersJson:"={{$json.__action.params.body || {}}}", options:{ fullResponse:true } }
    });
  }
  function addWhatsAppRunner(wf, x, y){
    return addNode(wf, { id: uid('wa'), name:'WhatsApp',
      type:'n8n-nodes-base.twilio', typeVersion:3, position:pos(x,y),
      parameters:{ resource:'message', operation:'create',
        from:"={{'whatsapp:' + ($json.__action.params.from || '+10000000002')}}",
        to:"={{'whatsapp:' + $json.__action.params.to}}",
        message:"={{$json.__action.params.body || $json.env?.channel_bundle?.whatsapp?.body || 'Hi'}}" },
      credentials:{} });
  }
  function addCallRunner(wf, x, y){
    return addHTTP(wf,'Call',
      "={{$json.__action.params.webhook || '"+DEMO.callWebhook+"'}}",
      "={{ { to:$json.__action.params.to, from:$json.__action.params.from, text: ($json.__action.params.script || $json.env?.channel_bundle?.call?.script || 'Hello') } }}",
      x, y, 'POST');
  }
  function addWaitRunner(wf, x, y){ return addNode(wf, { id: uid('wait'), name:'Wait', type:'n8n-nodes-base.wait', typeVersion:1, position:pos(x,y), parameters:{ amount:"={{$json.__action.params.seconds || 30}}", unit:'seconds' } }); }
  function addSetRunner(wf, x, y){
    return addNode(wf, { id: uid('set'), name:'Set Vars', type:'n8n-nodes-base.set', typeVersion:2, position:pos(x,y),
      parameters:{ keepOnlySet:false, values:{ string:[ {name:'__set', value:"={{JSON.stringify($json.__action.params || {})}}"} ] }} });
  }
  function addLogRunner(wf, x, y){
    return addNode(wf, { id: uid('code'), name:'Log', type:'n8n-nodes-base.code', typeVersion:2, position:pos(x,y),
      parameters:{ jsCode:
`const prev = $items(0,0)?.json || {};
const log = Array.isArray(prev.__exec_log) ? prev.__exec_log : [];
log.push({ at: Date.now(), action: $json.__action?.id, type:$json.__action?.type, params:$json.__action?.params });
return [{ ...prev, __exec_log: log }];` }});
  }
  function addRecordResult(wf, i, x, y){
    return addNode(wf, { id: uid('code'), name:`[${i}] Record Result`, type:'n8n-nodes-base.code', typeVersion:2, position:pos(x,y),
      parameters:{ jsCode:
`const prev = $items(0,0)?.json || {};
const recs = Array.isArray(prev.__results) ? prev.__results : [];
const status = $json.statusCode ?? 200;
recs.push({ i:${i}, action: prev.__action?.id, type: prev.__action?.type, status });
return [{ ...prev, __results: recs }];` }});
  }
  function addActionSlot(wf, i, x, y){
    const pick = addPickAction(wf, i, x, y);
    const ifEnd = addIfEnd(wf, x+220, y);                 connect(wf, pick, ifEnd);

    const route = addRouteType(wf, x+460, y);             connect(wf, ifEnd, route, 1); // not END

    const rHttp = addHttpRunner(wf, x+720, y-140);        connect(wf, route, rHttp, 0);
    const rWa   = addWhatsAppRunner(wf, x+720, y-20);     connect(wf, route, rWa,   1);
    const rCall = addCallRunner(wf, x+720, y+100);        connect(wf, route, rCall, 2);
    const rWait = addWaitRunner(wf, x+720, y+220);        connect(wf, route, rWait, 3);
    const rSet  = addSetRunner(wf, x+720, y+340);         connect(wf, route, rSet,  4);
    const rLog  = addLogRunner(wf, x+720, y+460);         connect(wf, route, rLog,  5);

    const rec   = addRecordResult(wf, i, x+980, y);       [rHttp, rWa, rCall, rWait, rSet, rLog].forEach(n => connect(wf, n, rec));

    const done  = addSet(wf, `[${i}] END Pass-through`, { [`__end_${i}`]:"={{true}}" }, x+460, y-140);
    connect(wf, ifEnd, done, 0);

    return { enter: pick, tail: rec, done };
  }
  function addActionRail(wf, execOut, x, y, maxSteps=12){
    // normalize env availability
    const normalize = addNode(wf, { id: uid('set'), name:'Normalize Playbook', type:'n8n-nodes-base.set', typeVersion:2, position:pos(x-220,y),
      parameters:{ keepOnlySet:false, values:{ string:[ { name:'env', value:"={{$json.env || {}}}" } ] }}});
    connect(wf, execOut, normalize);

    let prev = normalize;
    let firstDone=null;

    for(let i=1;i<=maxSteps;i++){
      const slot = addActionSlot(wf, i, x + (i-1)*LAYOUT.stepX, y);
      connect(wf, prev, slot.enter);
      prev = slot.tail;
      if(!firstDone) firstDone = slot.done;
    }
    const done = addSet(wf, 'Execution · Done', { '__exec_done':'={{true}}' }, x + maxSteps*LAYOUT.stepX + 120, y);
    connect(wf, prev, done);
    if(firstDone) connect(wf, firstDone, done);
    return done;
  }

  // ========== Build ==========
  function buildWorkflowJSON(scenario, industry, opts = {}){
    const title = `${scenario?.scenario_id||'Scenario'} — ${scenario?.name||''}`.trim();
    const wf = baseWorkflow(title);

    // Header & triggers
    addHeader(wf, 'FLOW AREA · PRODUCTION', LAYOUT.header.x, LAYOUT.header.y);
    const manual = addManual(wf, LAYOUT.start.x, LAYOUT.start.y, 'Manual Trigger');
    const simTrig = addSimTrigger(wf, 'CRON', LAYOUT.start.x + Math.floor(LAYOUT.stepX*0.7), LAYOUT.start.y);
    connect(wf, manual, simTrig);

    // Init Context (sheet → normalized fields)
    const init = addSet(wf,'Init Context',{
      'scenario.scenario_id': `={{'${scenario.scenario_id||''}'}}`,
      'scenario.agent_name':  `={{'${scenario.agent_name||''}'}}`,
      'scenario.name':        `={{'${(scenario.name||'').replace(/'/g,"\\'")}'}}`,
      'scenario.triggers':    `={{'${(scenario.triggers||'').replace(/'/g,"\\'")}'}}`,
      'scenario.how_it_works':`={{'${(scenario.how_it_works||'').replace(/'/g,"\\'")}'}}`,
      'scenario.roi_hypothesis':`={{'${(scenario.roi_hypothesis||'').replace(/'/g,"\\'")}'}}`,
      'scenario.risk_notes':  `={{'${(scenario.risk_notes||'').replace(/'/g,"\\'")}'}}`,
      'scenario.tags':        `={{${JSON.stringify((scenario["tags (;)"]||scenario.tags||'').toString().split(/[;,/|\n]+/).map(x=>x.trim()).filter(Boolean))}}}`
    }, LAYOUT.start.x + 2*LAYOUT.stepX, LAYOUT.start.y);
    connect(wf, simTrig, init);

    // Digital Team
    const team = makeTeam();
    const { outNodes, tail: teamTail } = addTeamChain(wf, team, init, LAYOUT.start.x + 3*LAYOUT.stepX, LAYOUT.start.y, scenario, industry);

    // Fan-in of all validators (order matters for $items(i))
    const fanIn = addFanInAgents(wf, ['preflight','research','planner','orchestrator','composer','qa'], LAYOUT.start.x + 5*LAYOUT.stepX + 40, LAYOUT.start.y - 160);
    if (outNodes.preflight) connect(wf, outNodes.preflight.out, fanIn);
    if (outNodes.research)  connect(wf, outNodes.research.out,  fanIn);
    if (outNodes.planner)   connect(wf, outNodes.planner.out,   fanIn);
    if (outNodes.orch)      connect(wf, outNodes.orch.out,      fanIn);
    if (outNodes.composer)  connect(wf, outNodes.composer.out,  fanIn);
    if (outNodes.qa)        connect(wf, outNodes.qa.out,        fanIn);

    // Execution Agent
    const exec = addExecutionAgent(wf, LAYOUT.start.x + 6*LAYOUT.stepX + 40, LAYOUT.start.y - 160);
    connect(wf, fanIn, exec.in);

    // Visual Action Rail (node-per-action)
    const execDone = addActionRail(wf, exec.out, LAYOUT.start.x + 7*LAYOUT.stepX + 40, LAYOUT.start.y - 120, opts.maxVisibleActions || 12);

    // Post-exec stage
    const stage = addSet(wf, 'Post-Execution Stage', { '__stage':'={{"post-exec"}}' }, LAYOUT.start.x + 2*LAYOUT.stepX, LAYOUT.start.y + 240);
    connect(wf, execDone, stage);

    // Minimal error lane (notify ops)
    const errHdr = addHeader(wf, 'ERROR AREA', LAYOUT.start.x + 3*LAYOUT.stepX, LAYOUT.start.y + 420);
    const ops    = addHTTP(wf, 'Notify · Ops', `={{'${DEMO.opsAlert}'}}`, '={{$json}}', LAYOUT.start.x + 4*LAYOUT.stepX, LAYOUT.start.y + 480);
    connect(wf, stage, ops);

    // Design notes
    wf.staticData.__design = {
      layout:{ stepX:LAYOUT.stepX, grid:GRID, footprint:FOOT, antiOverlap:'block' },
      notes:'Digital team (agents) feed Execution. Action Rail renders up to N actions visually; stops on END.'
    };

    return wf;
  }

  // Public API
  window.Builder = { buildWorkflowJSON };
})();
