// public/builder.js
// n8n JSON generator — Digital Team + YES/NO Execution (compact, scenario-named actions)

(function () {
  "use strict";

  // ========= Layout =========
  const L = {
    stepX: 320,
    header: { x: -900, y: 40 },
    start:  { x: -860, y: 240 },
    lanesY: { yes: -110, no: 110 }
  };
  const GRID = { cellH: 70, cellW: 80 };
  const FOOT = { w: 3, h: 3 };

  // ========= Demo endpoints (replace in prod) =========
  const DEMO = {
    callWebhook: 'https://example.com/call',
    opsAlert:    'https://example.com/ops/alert'
  };

  // ========= Utils =========
  const uid = (p)=>`${p}_${Math.random().toString(36).slice(2,10)}`;
  const pos = (x,y)=>[x,y];
  const snapX=(x)=> Math.round(x/GRID.cellW)*GRID.cellW;
  const snapY=(y)=> Math.round(y/GRID.cellH)*GRID.cellH;

  function baseWorkflow(name){
    return {
      name, nodes:[], connections:{}, active:false,
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

  // ========= Palette =========
  function addHeader(wf,label,x,y){
    return addNode(wf,{ id:uid('label'), name:`=== ${label} ===`,
      type:'n8n-nodes-base.set', typeVersion:2, position:pos(x,y),
      parameters:{ keepOnlySet:false, values:{ string:[{ name:'__zone', value:`={{'${label}'}}` }] } }
    });
  }
  function addTitle(wf,text,x,y){
    return addNode(wf,{ id:uid('note'), name:`🧭 ${text}`,
      type:'n8n-nodes-base.set', typeVersion:2, position:pos(x,y),
      parameters:{ keepOnlySet:false, values:{ string:[{ name:'__title', value:`={{'${text.replace(/'/g,"\\'")}'}}` }] } }
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
  function addSwitch(wf,name,valueExpr,rules,x,y){
    const safe=(rules||[]).map(r=>({ operation:r.operation||'equal', value2:String(r.value2??'') }));
    return addNode(wf,{ id:uid('switch'), name, type:'n8n-nodes-base.switch', typeVersion:2, position:pos(x,y),
      parameters:{ value1:valueExpr, rules:safe }});
  }

  // ========= Agent contracts =========
  const SCHEMA_PREFLIGHT = `{"intent":"string","user_state_hypotheses":["string"],"risks":["string"],"kpis":["string"],"channels_ranked":["email","whatsapp","sms","call"],"guardrails":["string"]}`;
  const SCHEMA_RESEARCH  = `{"company":{"name":"string","domain":"string","geo":"string","stack":["string"]},"personas":["string"],"intel":["string"]}`;
  const SCHEMA_PLANNER   = `{"steps":["string"],"decisions":[{"step":"number","name":"string","outcomes":["string"]}],"error_catalog":[{"code":"string","hint":"string"}]}`;
  const SCHEMA_ORCH      = `{"tool_calls":[{"name":"string","url":"string","payload":{"_":"any"},"on_success_next":"string","on_error_next":"string"}]}`;
  const SCHEMA_COMPOSER  = `{"email":{"subject":"string","body":"string"},"whatsapp":{"body":"string"},"sms":{"body":"string"},"call":{"script":"string"}}`;
  const SCHEMA_QA        = `{"ok":true,"reasons":["string"],"fixups":[{"field":"string","value":"string"}]}`;
  const SCHEMA_SUMMARY   = `{"highlights":["string"],"decisions_taken":["string"],"next_actions":["string"]}`;

  // ==== Execution (YES/NO only) ====
  const SCHEMA_EXECUTION = `{
    "hypothesis":"yes|no",
    "actions": {
      "yes":[{"id":"string","type":"http|send_whatsapp|place_call|wait|set|log|END","title":"string","params":{}}],
      "no":[{"id":"string","type":"http|send_whatsapp|place_call|wait|set|log|END","title":"string","params":{}}]
    },
    "env": { "channel_bundle": {"email":{"subject":"string","body":"string"},"whatsapp":{"body":"string"},"call":{"script":"string"}} }
  }`;

  const SYS_PREFLIGHT = `You are PreFlight. Distill messy scenario fields into a clean JSON context. Output strict JSON only.`;
  const SYS_RESEARCH  = `You are Researcher. Enrich with light company/stack/persona intel using only provided inputs. No web calls. JSON only.`;
  const SYS_PLANNER   = `You are Planner. Produce a numbered decision plan for this scenario. JSON only.`;
  const SYS_ORCH      = `You are Orchestrator. Turn the plan into concrete tool calls/steps. JSON only.`;
  const SYS_COMPOSER  = `You are Composer. Produce channel-specific copy/scripts grounded in context. JSON only.`;
  const SYS_QA        = `You are QA. Validate the bundle & propose minimal fixups. JSON only.`;
  const SYS_SUMMARY   = `You are Summarizer. Output concise highlights for BI/Slack. JSON only.`;

  const SYS_EXECUTION = `You are Execution.
Using validated JSON from Preflight, Research, Planner, Orchestrator, Composer, QA:
- Choose the best "hypothesis": yes OR no (to reach the scenario goal).
- For BOTH lanes provide up to 3 ordered actions, each with a short human-readable "title" specific to THIS scenario.
- Allowed action types: http | send_whatsapp | place_call | wait | set | log | END.
- Reuse Orchestrator URLs; reuse Composer content via env.channel_bundle.
- Be concise, deterministic and safe. JSON only.`;

  // ========= Agent helper (Agent → Parser → Validator) =========
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
    // wire
    wf.connections[lm]     = { ai_languageModel: [[{ node: agent, type: "ai_languageModel", index: 0 }]] };
    wf.connections[parser] = { ai_outputParser:  [[{ node: agent, type: "ai_outputParser",  index: 0 }]] };

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

  // ========= Digital team =========
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
      cursor = a.out; outNodes[t.key]=a; x += 300;
    });
    return { tail: cursor, outNodes };
  }

  // ========= Fan-in =========
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

  // ========= Execution Agent =========
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

  // ========= Unified runner =========
  function addUnifiedRunner(wf, x, y){
    return addNode(wf, {
      id: uid('code'), name: 'Run Action',
      type: 'n8n-nodes-base.code', typeVersion: 2, position: pos(x, y),
      parameters: { jsCode:
`const a = $json.__action || {};
const env = $json.env || {};
async function run(){
  switch (a.type) {
    case 'http': {
      const url = a.params?.url;
      const method = a.params?.method || 'POST';
      const body = a.params?.body || {};
      if (!url) return { statusCode: 400, body:{ error:'missing url' } };
      const res = await this.helpers.httpRequest({
        url, method, json: true, body, resolveWithFullResponse: true,
      });
      return { statusCode: res.statusCode, body: res.body };
    }
    case 'send_whatsapp': {
      return { statusCode: 200, body: { to:a.params?.to, text:a.params?.body || env.channel_bundle?.whatsapp?.body || 'Hi' } };
    }
    case 'place_call': {
      return { statusCode: 200, body: { to:a.params?.to, script: a.params?.script || env.channel_bundle?.call?.script || 'Hello' } };
    }
    case 'wait': {
      const ms = Math.max(0, (a.params?.seconds||30) * 1000);
      await new Promise(r => setTimeout(r, ms));
      return { statusCode: 200, body: { waitedMs: ms } };
    }
    case 'set':  return { statusCode: 200, body: { set: a.params || {} } };
    case 'log':  return { statusCode: 200, body: { log: a.params || {} } };
    case 'END':
    default:     return { statusCode: 200, body: { noop:true } };
  }
}
return run().then(r => [ { ...$json, ...r } ]);`
      }
    });
  }

  // ========= Record node (includes scenario-aware title) =========
  function addRecordResult(wf, idx, lane, x, y, scenario){
    const label = `[${lane.toUpperCase()} ${idx}] Record — ${scenario.scenario_id||'Scenario'}`;
    return addNode(wf, { id: uid('code'), name: label,
      type:'n8n-nodes-base.code', typeVersion:2, position:pos(x,y),
      parameters:{ jsCode:
`const prev = $items(0,0)?.json || {};
const recs = Array.isArray(prev.__results) ? prev.__results : [];
const status = $json.statusCode ?? 200;
recs.push({ lane:'${lane}', i:${idx}, action: prev.__action?.id, title: prev.__action?.title, type: prev.__action?.type, status });
return [{ ...prev, __results: recs }];` }});
  }

  // ========= Pick & END? =========
  function addPickAction(wf, idx, lane, x, y, scenario){
    const pretty = (s)=> String(s||'').slice(0,60);
    return addNode(wf, {
      id: uid('code'),
      name: `[${lane.toUpperCase()} ${idx}] Pick — ${pretty(scenario.name)}`,
      type: 'n8n-nodes-base.code', typeVersion: 2, position: pos(x, y),
      parameters: { jsCode:
`const lane = '${lane}';
const i = ${idx} - 1;
const play = $json || {};
const list = (play.actions && Array.isArray(play.actions[lane])) ? play.actions[lane] : [];
const a = list[i] || { id:'END', type:'END', title:'END', params:{} };
return [{ ...play, __lane: lane, __i:${idx}, __action: a }];`
      }
    });
  }
  function addIfEnd(wf, x, y){
    return addNode(wf,{
      id: uid('if'), name:'END?',
      type:'n8n-nodes-base.if', typeVersion:2, position:pos(x,y),
      parameters:{ conditions:{ string:[{ value1:"={{$json.__action.type}}", operation:'equal', value2:'END' }] } }
    });
  }

  // ========= One compact action slot =========
  function addActionSlot(wf, idx, lane, x, baseY, scenario){
    const y = baseY + (L.lanesY[lane]||0);
    const pick  = addPickAction(wf, idx, lane, x, y, scenario);
    const ifEnd = addIfEnd(wf, x+200, y);             connect(wf, pick, ifEnd);

    // Name the runner node with scenario + action title at runtime (title visible in Record)
    const run   = addUnifiedRunner(wf, x+420, y);     connect(wf, ifEnd, run, 1);
    const rec   = addRecordResult(wf, idx, lane, x+660, y, scenario); connect(wf, run, rec);

    const done  = addSet(wf, `[${lane.toUpperCase()} ${idx}] END`, { [`__end_${lane}_${idx}`]:"={{true}}" }, x+420, y-110);
    connect(wf, ifEnd, done, 0);

    return { enter: pick, tail: rec, done };
  }

  // ========= Build a YES/NO lane =========
  function addLane(wf, execOut, lane, x, baseY, steps, scenario){
    const norm = addNode(wf, { id: uid('set'), name:`Normalize (${lane})`,
      type:'n8n-nodes-base.set', typeVersion:2, position:pos(x-200, baseY+(L.lanesY[lane]||0)),
      parameters:{ keepOnlySet:false, values:{ string:[ { name:'env', value:"={{$json.env || {}}}" } ] }}});
    connect(wf, execOut, norm);

    let prev = norm;
    let firstDone=null;

    for(let i=1;i<=steps;i++){
      const slot = addActionSlot(wf, i, lane, x + (i-1)*L.stepX, baseY, scenario);
      connect(wf, prev, slot.enter);
      prev = slot.tail;
      if(!firstDone) firstDone = slot.done;
    }
    const done = addSet(wf, `Lane ${lane.toUpperCase()} · Done`, { [`__lane_${lane}_done`]:'={{true}}' }, x + steps*L.stepX + 120, baseY+(L.lanesY[lane]||0));
    connect(wf, prev, done);
    if(firstDone) connect(wf, firstDone, done);
    return done;
  }

  // ========= Build main workflow =========
  function buildWorkflowJSON(scenario, industry, opts = {}){
    const title = `${scenario?.scenario_id||'Scenario'} — ${scenario?.name||''}`.trim();
    const wf = baseWorkflow(title);

    // Title & header
    addHeader(wf, 'FLOW AREA · PRODUCTION', L.header.x, L.header.y);
    addTitle(wf, `${scenario?.scenario_id||''} · ${scenario?.name||''}`, L.header.x + 260, L.header.y + 10);

    // Trigger row
    const manual = addManual(wf, L.start.x, L.start.y, 'Manual Trigger');
    const simTrig = addSimTrigger(wf, 'CRON', L.start.x + Math.floor(L.stepX*0.7), L.start.y);
    connect(wf, manual, simTrig);

    // Init
    const init = addSet(wf,'Init Context',{
      'scenario.scenario_id': `={{'${scenario.scenario_id||''}'}}`,
      'scenario.agent_name':  `={{'${scenario.agent_name||''}'}}`,
      'scenario.name':        `={{'${(scenario.name||'').replace(/'/g,"\\'")}'}}`,
      'scenario.triggers':    `={{'${(scenario.triggers||'').replace(/'/g,"\\'")}'}}`,
      'scenario.how_it_works':`={{'${(scenario.how_it_works||'').replace(/'/g,"\\'")}'}}`,
      'scenario.roi_hypothesis':`={{'${(scenario.roi_hypothesis||'').replace(/'/g,"\\'")}'}}`,
      'scenario.risk_notes':  `={{'${(scenario.risk_notes||'').replace(/'/g,"\\'")}'}}`,
      'scenario.tags':        `={{${JSON.stringify((scenario["tags (;)"]||scenario.tags||'').toString().split(/[;,/|\n]+/).map(x=>x.trim()).filter(Boolean))}}}`
    }, L.start.x + 2*L.stepX, L.start.y);
    connect(wf, simTrig, init);

    // Digital Team
    const team = makeTeam();
    const { outNodes } = addTeamChain(wf, team, init, L.start.x + 3*L.stepX, L.start.y, scenario, industry);

    // Fan-in validators
    const fanIn = addFanInAgents(wf, ['preflight','research','planner','orchestrator','composer','qa'], L.start.x + 5*L.stepX + 40, L.start.y - 160);
    if (outNodes.preflight) connect(wf, outNodes.preflight.out, fanIn);
    if (outNodes.research)  connect(wf, outNodes.research.out,  fanIn);
    if (outNodes.planner)   connect(wf, outNodes.planner.out,   fanIn);
    if (outNodes.orch)      connect(wf, outNodes.orch.out,      fanIn);
    if (outNodes.composer)  connect(wf, outNodes.composer.out,  fanIn);
    if (outNodes.qa)        connect(wf, outNodes.qa.out,        fanIn);

    // Execution Agent
    const exec = addExecutionAgent(wf, L.start.x + 6*L.stepX + 40, L.start.y - 160);
    connect(wf, fanIn, exec.in);

    // Route by hypothesis YES / NO
    const hypSwitch = addSwitch(wf, 'Route by Hypothesis', "={{$json.hypothesis}}",
      [{operation:'equal', value2:'yes'}, {operation:'equal', value2:'no'}],
      L.start.x + 6*L.stepX + 320, L.start.y - 160
    );
    connect(wf, exec.out, hypSwitch);

    // Lanes with scenario-aware labels (3 actions max)
    const baseX = L.start.x + 7*L.stepX;
    const baseY = L.start.y - 30;
    const stepsPerLane = Math.max(1, Math.min(3, opts.maxActionsPerLane || 3));

    const laneYesDone = addLane(wf, exec.out, 'yes', baseX, baseY, stepsPerLane, scenario);
    const laneNoDone  = addLane(wf, exec.out, 'no',  baseX, baseY, stepsPerLane, scenario);

    connect(wf, hypSwitch, laneYesDone, 0);
    connect(wf, hypSwitch, laneNoDone,  1);

    // Post-exec & simple error area
    const stage = addSet(wf, 'Post-Execution Stage', { '__stage':'={{"post-exec"}}' }, L.start.x + 2*L.stepX, L.start.y + 220);
    connect(wf, laneYesDone, stage); connect(wf, laneNoDone, stage);

    addHeader(wf, 'ERROR AREA', L.start.x + 3*L.stepX, L.start.y + 400);
    const ops = addHTTP(wf, 'Notify · Ops', `={{'${DEMO.opsAlert}'}}`, '={{$json}}', L.start.x + 4*L.stepX, L.start.y + 460);
    connect(wf, stage, ops);

    // Design notes
    wf.staticData.__design = {
      layout:{ stepX:L.stepX, grid:GRID, footprint:FOOT, antiOverlap:'block' },
      notes:'Digital team → Execution (yes/no) → compact visual lanes (scenario-named actions).'
    };
    return wf;
  }

  // Public API
  window.Builder = { buildWorkflowJSON };
})();
