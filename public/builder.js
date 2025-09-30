// public/builder.js
// Chain-of-Agents — ONE LINE layout with fixed horizontal spacing (no overlaps)

(function () {
  "use strict";

  // ===== Layout (fixed spans) =====
  const L = {
    ROW_Y: 240,
    HEADER: { x: -900, y: 40 },
    START_X: -860
  };
  // Horizontal spacing config (tune SPAN to taste)
  const H = {
    SPAN: 320,                  // base horizontal gap between nodes
    OFF_AGENT: 0,               // Agent at baseX + 0
    OFF_VALIDATOR: 1,           // +1×SPAN
    OFF_RUN: 2,                 // +2×SPAN
    OFF_RECORD: 3,              // +3×SPAN
    GROUP_GAP: 4                // next group starts at +4×SPAN
  };

  const GRID = { cellH: 70, cellW: 80 };

  // ===== Utils =====
  const uid  = (p)=>`${p}_${Math.random().toString(36).slice(2,10)}`;
  const pos  = (x,y)=>[x,y];
  const sX   = (x)=> Math.round(x/GRID.cellW)*GRID.cellW;
  const sY   = (y)=> Math.round(y/GRID.cellH)*GRID.cellH;

  function baseWorkflow(name){
    return { name, nodes:[], connections:{}, active:false,
      settings:{ executionOrder:"v1", timezone:"Europe/Madrid" },
      staticData:{}, __occ:new Set()
    };
  }
  function uniqueName(wf, base){
    const ex=new Set((wf.nodes||[]).map(n=>String(n.name||'').toLowerCase()));
    let nm=base||'Node', i=1; while(ex.has(nm.toLowerCase())){ i++; nm=`${base} #${i}`;} return nm;
  }
  function addNode(wf,node){
    node.name = uniqueName(wf,node.name);
    if (Array.isArray(node.position)){
      // force same row; never bump vertically
      const x = sX(node.position[0]);
      const y = sY(node.position[1]);
      node.position = [x, y];
    }
    wf.nodes.push(node); return node.name;
  }
  function connect(wf,from,to,idx=0){
    wf.connections[from]??={}; wf.connections[from].main??=[];
    for(let i=wf.connections[from].main.length;i<=idx;i++) wf.connections[from].main[i]=[];
    wf.connections[from].main[idx].push({ node: to, type:"main", index:0 });
  }

  // ===== Tiny palette =====
  const setNode = (wf,name,fields,x,y)=> addNode(wf,{ id:uid('set'), name, type:'n8n-nodes-base.set', typeVersion:2, position:pos(x,y),
    parameters:{ keepOnlySet:false, values:{ string:Object.entries(fields||{}).map(([k,v])=>({name:k,value:v})) } } });
  const header   = (wf,txt,x,y)=> setNode(wf,`=== ${txt} ===`,{ __zone:`={{'${txt}'}}` },x,y);
  const manual   = (wf,x,y)=> addNode(wf,{ id:uid('m'), name:'Manual Trigger', type:'n8n-nodes-base.manualTrigger', typeVersion:1, position:pos(x,y), parameters:{} });

  const modelLm  = (wf, role, x, y)=> addNode(wf,{ id:uid('lm'), name:`${role} · OpenAI Chat Model`,
    type:"@n8n/n8n-nodes-langchain.lmChatOpenAi", typeVersion:1.2, position:pos(x, y+148),
    parameters:{ model:{ "__rl":true,"value":"gpt-5-mini","mode":"list","cachedResultName":"gpt-5-mini"}, options:{ temperature:0.2 } },
    credentials:{ openAiApi:{ id:"OpenAI_Creds_Id", name:"OpenAi account" } }});
  const parser   = (wf, role, x, y, schema)=> addNode(wf,{ id:uid('op'), name:`${role} · Structured Parser`,
    type:"@n8n/n8n-nodes-langchain.outputParserStructured", typeVersion:1.3, position:pos(x+144, y+260),
    parameters:{ jsonSchemaExample:schema }});
  const agentNode= (wf, role, x, y, sys, user)=> addNode(wf,{ id:uid('ag'), name:role,
    type:"@n8n/n8n-nodes-langchain.agent", typeVersion:2.2, position:pos(x,y),
    parameters:{ promptType:"define", text:user, hasOutputParser:true, options:{ systemMessage:`=${sys}` } }});
  const validator= (wf,name,x,y)=> addNode(wf,{ id:uid('code'), name:`${name} · JSON Validator`,
    type:"n8n-nodes-base.code", typeVersion:2, position:pos(x,y),
    parameters:{ jsCode:`const out=$json.output??$json; if(!out||typeof out!=='object'||Array.isArray(out)) throw new Error('Invalid JSON'); return [out];` }});

  // ===== Contracts =====
  const SCHEMA_CONTEXT = `{"intent":"string","inputs":{"company":"string","industry":"string"},"success":"string","guardrails":["string"],"channel_bundle":{"email":{"subject":"string","body":"string"},"whatsapp":{"body":"string"},"call":{"script":"string"}}}`;
  const SCHEMA_STEP    = `{"action":{"id":"string","title":"string","type":"send_message|check_data|place_call|wait|http|END","params":{}},"memory":{"notes":["string"]}}`;

  // ===== Prompts =====
  const sysContext = `You are 🧠 Context. Convert scenario into ${SCHEMA_CONTEXT}. JSON only.`;
  const sysStep    = `You are a specialist step agent. Return ${SCHEMA_STEP}. Keep 'title' short & scenario-specific. Use channel_bundle for messages. JSON only.`;

  const userContext = (s,i)=> `=Make ${SCHEMA_CONTEXT} from:\n${JSON.stringify({
    scenario_id: s.scenario_id||'', name: s.name||'', triggers:s.triggers||'',
    aim: s.roi_hypothesis||'', risk_notes:s.risk_notes||'',
    industry: i?.industry_id||'', tags: (s["tags (;)"]||s.tags||'').toString()
  },null,2)}`;
  const userStep = (name)=> `=Step "${name}". Input:\n{{$json}}\nReturn ${SCHEMA_STEP}.`;

  // ===== Runner / Record =====
  function addRunner(wf, x, y, label){
    return addNode(wf,{
      id:uid('run'), name:`Run · ${label}`, type:'n8n-nodes-base.code', typeVersion:2, position:pos(x,y),
      parameters:{ jsCode:
`const a=$json.action||{type:'END',title:'END',params:{}}; async function go(){
  switch(a.type){
    case 'send_message': return { status:200, body:{ to:a.params?.to, text:a.params?.body } };
    case 'check_data':  return { status:200, body:{ check:a.params||{} } };
    case 'place_call':  return { status:200, body:{ to:a.params?.to, script:a.params?.script } };
    case 'wait':        await new Promise(r=>setTimeout(r,(a.params?.seconds||10)*1000)); return { status:200, body:{ waited:a.params?.seconds||10 } };
    case 'http': {
      const res=await this.helpers.httpRequest({ url:a.params?.url, method:a.params?.method||'POST', json:true, body:a.params?.body||{}, resolveWithFullResponse:true });
      return { status:res.statusCode, body:res.body };
    }
    default:            return { status:200, body:{ noop:true } };
  }
}
return go().then(r=>[{...$json,__exec:r}]);`
      }
    });
  }
  function addRecord(wf, x, y, stepLabel, scenario){
    return addNode(wf,{
      id:uid('rec'), name:`Record · ${scenario.scenario_id||'Scenario'} · ${stepLabel}`, type:'n8n-nodes-base.code', typeVersion:2, position:pos(x,y),
      parameters:{ jsCode:`const ctx=$items(0,0)?.json||{}; const hist=Array.isArray(ctx.__history)?ctx.__history:[]; hist.push({step:'${stepLabel}', action:ctx.action, status:$json.__exec?.status}); return [{...ctx,__history:hist}];` }
    });
  }

  // ===== Build one step agent at baseX =====
  function addStepGroup(wf, baseX, y, stepName){
    // Agent (with model/parser below automatically)
    const role = `🧩 ${stepName} Agent`;
    const agentX = baseX + H.SPAN * H.OFF_AGENT;
    const valX   = baseX + H.SPAN * H.OFF_VALIDATOR;
    const runX   = baseX + H.SPAN * H.OFF_RUN;
    const recX   = baseX + H.SPAN * H.OFF_RECORD;

    const lm   = modelLm(wf, role, agentX, y);
    const prs  = parser(wf, role, agentX, y, SCHEMA_STEP);
    const ag   = agentNode(wf, role, agentX, y, sysStep, userStep(stepName));
    wf.connections[lm]  = { ai_languageModel: [[{ node: ag, type:"ai_languageModel", index:0 }]] };
    wf.connections[prs] = { ai_outputParser:  [[{ node: ag, type:"ai_outputParser",  index:0 }]] };
    const val  = validator(wf, role, valX, y);
    connect(wf, ag, val);

    const run  = addRunner(wf, runX, y, stepName);
    connect(wf, val, run);

    const rec  = addRecord(wf, recX, y, stepName, { scenario_id:'' });
    connect(wf, run, rec);

    return { agentIn: ag, out: rec };
  }

  // ===== Main build (single row, fixed spacing) =====
  function buildWorkflowJSON(scenario, industry, opts={}){
    const steps = (opts.steps?.length ? opts.steps : ['Research','Compose Message','Dispatch']).slice(0,6);

    const title = `${scenario?.scenario_id||'Scenario'} — ${scenario?.name||''}`.trim();
    const wf = baseWorkflow(title);

    // Header
    header(wf, 'FLOW · ONE LINE · FIXED SPACING', L.HEADER.x, L.HEADER.y);

    const y = L.ROW_Y;
    let x = L.START_X;

    // Trigger
    const trig = manual(wf, x, y);
    x += H.SPAN; // spacing to next
    const init = setNode(wf,'Init',{
      'scenario.id': `={{'${scenario.scenario_id||''}'}}`,
      'scenario.name': `={{'${(scenario.name||'').replace(/'/g,"\\'")}'}}`,
      'industry.id': `={{'${industry?.industry_id||''}'}}`
    }, x, y);
    connect(wf, trig, init);

    // Context group (Agent + Validator)
    x += H.SPAN;
    const ctxRole = '🧠 Context';
    const ctxLm  = modelLm(wf, ctxRole, x + H.SPAN*H.OFF_AGENT, y);
    const ctxPr  = parser(wf, ctxRole, x + H.SPAN*H.OFF_AGENT, y, SCHEMA_CONTEXT);
    const ctxAg  = agentNode(wf, ctxRole, x + H.SPAN*H.OFF_AGENT, y, sysContext, userContext(scenario, industry));
    wf.connections[ctxLm] = { ai_languageModel: [[{ node: ctxAg, type:"ai_languageModel", index:0 }]] };
    wf.connections[ctxPr] = { ai_outputParser:  [[{ node: ctxAg, type:"ai_outputParser",  index:0 }]] };
    const ctxVal = validator(wf, ctxRole, x + H.SPAN*H.OFF_VALIDATOR, y);
    connect(wf, ctxAg, ctxVal);
    connect(wf, init, ctxAg);

    // Chain steps — each block uses fixed offsets so nothing overlaps
    x += H.SPAN * H.GROUP_GAP;
    let cursor = ctxVal;

    steps.forEach((name, i)=>{
      // build the group
      const baseX = x;
      // step group returns nodes, but we need scenario name in Record label—simplify by setting later
      const role = `🧩 ${name} Agent`;
      const agentX = baseX + H.SPAN * H.OFF_AGENT;
      const valX   = baseX + H.SPAN * H.OFF_VALIDATOR;
      const runX   = baseX + H.SPAN * H.OFF_RUN;
      const recX   = baseX + H.SPAN * H.OFF_RECORD;

      const lm   = modelLm(wf, role, agentX, y);
      const prs  = parser(wf, role, agentX, y, SCHEMA_STEP);
      const ag   = agentNode(wf, role, agentX, y, sysStep, userStep(name));
      wf.connections[lm]  = { ai_languageModel: [[{ node: ag, type:"ai_languageModel", index:0 }]] };
      wf.connections[prs] = { ai_outputParser:  [[{ node: ag, type:"ai_outputParser",  index:0 }]] };
      const val  = validator(wf, role, valX, y);
      connect(wf, ag, val);

      connect(wf, cursor, ag);

      const run  = addRunner(wf, runX, y, `${i+1}. ${name}`);
      connect(wf, val, run);

      const rec  = addRecord(wf, recX, y, `${i+1}. ${name}`, scenario);
      connect(wf, run, rec);

      cursor = rec;
      x += H.SPAN * H.GROUP_GAP;
    });

    // Summary
    const summary = setNode(wf,'🧾 Summary',{ '__stage':'={{"done"}}' }, x, y);
    connect(wf, cursor, summary);

    wf.staticData.__design = {
      layout:{ mode:'one-line-fixed', span:H.SPAN, groupGap:H.GROUP_GAP },
      notes:'All main nodes placed at fixed horizontal offsets; no vertical bumps; no overlap.'
    };
    return wf;
  }

  window.Builder = { buildWorkflowJSON };
})();
