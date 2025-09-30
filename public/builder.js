// public/builder.js
// Chain-of-Agents in ONE LINE (main row): Trigger → Init → Context → [StepAgent → JSON → Run → Record] × N → Summary

(function () {
  "use strict";

  // ===== Layout =====
  const L = { stepX: 320, header: { x: -900, y: 40 }, start: { x: -860, y: 240 } };
  const GRID = { cellH: 70, cellW: 80 };

  // ===== Internal line-mode switch (set per build) =====
  let __lineMode = true;

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

  // Occupancy helpers (kept minimal; ignored in line mode)
  function key(x,y){ return `${x}:${y}`; }
  function reserve(wf,x,y){ wf.__occ.add(key(x,y)); }
  function nextFreeY(wf,x,y){
    if (__lineMode) return y; // <-- stay on the same row
    let cy = y; while (wf.__occ.has(key(x,cy))) cy += GRID.cellH; return cy;
  }

  function addNode(wf,node){
    node.name = uniqueName(wf,node.name);
    if (Array.isArray(node.position)){
      const x = sX(node.position[0]);
      const desiredY = sY(node.position[1]);
      const y = nextFreeY(wf, x, desiredY);
      node.position = [x, y];
      reserve(wf, x, y);
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
    type:"n8n-nodes-base.code", typeVersion:2, position:pos(x+300,y),
    parameters:{ jsCode:`const out=$json.output??$json; if(!out||typeof out!=='object'||Array.isArray(out)) throw new Error('Invalid JSON'); return [out];` }});

  // ===== Contracts =====
  const SCHEMA_CONTEXT = `{"intent":"string","inputs":{"company":"string","industry":"string"},"success":"string","guardrails":["string"],"channel_bundle":{"email":{"subject":"string","body":"string"},"whatsapp":{"body":"string"},"call":{"script":"string"}}}`;
  const SCHEMA_STEP    = `{"action":{"id":"string","title":"string","type":"send_message|check_data|place_call|wait|http|END","params":{}},"memory":{"notes":["string"]}}`;

  // ===== Prompts =====
  const sysContext = `You are 🧠 Context. Convert scenario into ${SCHEMA_CONTEXT}. JSON only.`;
  const sysStep    = `You are a specialist agent for this step. Return ${SCHEMA_STEP}. Keep 'title' short & scenario-specific. Use channel_bundle for messages. JSON only.`;

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

  // ===== One step agent (Agent → JSON) =====
  function addStepAgent(wf, x, y, stepName){
    const role = `🧩 ${stepName} Agent`;
    const lm   = modelLm(wf, role, x, y);
    const prs  = parser(wf, role, x, y, SCHEMA_STEP);
    const ag   = agentNode(wf, role, x, y, sysStep, userStep(stepName));
    wf.connections[lm]  = { ai_languageModel: [[{ node: ag, type:"ai_languageModel", index:0 }]] };
    wf.connections[prs] = { ai_outputParser:  [[{ node: ag, type:"ai_outputParser",  index:0 }]] };
    const val  = validator(wf, role, x, y);
    connect(wf, ag, val);
    return { in: ag, out: val };
  }

  // ===== Build main (single line) =====
  function buildWorkflowJSON(scenario, industry, opts={}){
    __lineMode = (opts.layout ?? 'line') === 'line'; // force one line by default

    const steps = (opts.steps?.length ? opts.steps : ['Research','Compose Message','Dispatch']).slice(0,6);

    const title = `${scenario?.scenario_id||'Scenario'} — ${scenario?.name||''}`.trim();
    const wf = baseWorkflow(title);

    // Header
    header(wf, 'FLOW · ONE LINE', L.header.x, L.header.y);

    // Row Y fixed
    const ROW_Y = L.start.y;

    // Trigger + Init
    const trig = manual(wf, L.start.x, ROW_Y);
    const init = setNode(wf,'Init',{
      'scenario.id': `={{'${scenario.scenario_id||''}'}}`,
      'scenario.name': `={{'${(scenario.name||'').replace(/'/g,"\\'")}'}}`,
      'industry.id': `={{'${industry?.industry_id||''}'}}`
    }, L.start.x + L.stepX, ROW_Y);
    connect(wf, trig, init);

    // 🧠 Context (main box stays on the line; model/parser render below automatically)
    const ctxLm  = modelLm(wf,'🧠 Context', L.start.x + 2*L.stepX, ROW_Y);
    const ctxPr  = parser(wf,'🧠 Context',  L.start.x + 2*L.stepX, ROW_Y, SCHEMA_CONTEXT);
    const ctxAg  = agentNode(wf,'🧠 Context', L.start.x + 2*L.stepX, ROW_Y, sysContext, userContext(scenario, industry));
    wf.connections[ctxLm] = { ai_languageModel: [[{ node: ctxAg, type:"ai_languageModel", index:0 }]] };
    wf.connections[ctxPr] = { ai_outputParser:  [[{ node: ctxAg, type:"ai_outputParser",  index:0 }]] };
    const ctxVal = validator(wf,'🧠 Context', L.start.x + 2*L.stepX, ROW_Y);
    connect(wf, ctxAg, ctxVal);
    connect(wf, init, ctxAg);

    // Steps in a straight line
    let x = L.start.x + 3*L.stepX;
    let cursor = ctxVal;

    steps.forEach((name, i)=>{
      const step = addStepAgent(wf, x, ROW_Y, name);
      connect(wf, cursor, step.in);

      const run = addRunner(wf, x + L.stepX*0.95, ROW_Y, `${i+1}. ${name}`);
      connect(wf, step.out, run);

      const rec = addRecord(wf, x + L.stepX*1.85, ROW_Y, `${i+1}. ${name}`, scenario);
      connect(wf, run, rec);

      cursor = rec;
      x += L.stepX*2.2; // widen spacing so all boxes line up and breathe
    });

    // Summary (still on the same row)
    const summary = setNode(wf,'🧾 Summary',{ '__stage':'={{"done"}}' }, x, ROW_Y);
    connect(wf, cursor, summary);

    wf.staticData.__design = {
      layout:{ mode:'one-line', rowY: ROW_Y, stepX: L.stepX },
      notes:'Main chain kept on a single horizontal row. AI sub-nodes (model/parser) render beneath their agent automatically.'
    };
    return wf;
  }

  window.Builder = { buildWorkflowJSON };
})();
