// public/builder.js
// Chain-of-Agents: each step is its own AI agent (+validator) then executed.
// Simple, readable pipeline: Trigger → Init → Context → [ StepAgent → JSON → Run → Record ] × N → Summary

(function () {
  "use strict";

  // ===== Layout (clean & compact) =====
  const L = { stepX: 320, header: { x: -900, y: 40 }, start: { x: -860, y: 240 } };
  const GRID = { cellH: 70, cellW: 80 }, FOOT = { w: 3, h: 3 };

  // ===== Utils =====
  const uid = (p)=>`${p}_${Math.random().toString(36).slice(2,10)}`;
  const pos = (x,y)=>[x,y];
  const snapX=(x)=> Math.round(x/GRID.cellW)*GRID.cellW;
  const snapY=(y)=> Math.round(y/GRID.cellH)*GRID.cellH;
  function baseWorkflow(name){ return { name, nodes:[], connections:{}, active:false, settings:{ executionOrder:"v1" }, staticData:{}, __occ:new Set() }; }
  function uniqueName(wf, base){ const ex=new Set((wf.nodes||[]).map(n=>String(n.name||'').toLowerCase())); let nm=base||'Node', i=1; while(ex.has(nm.toLowerCase())){ i++; nm=`${base} #${i}`;} return nm; }
  function blockCells(x,y,w=FOOT.w,h=FOOT.h){ const sx=snapX(x), sy=snapY(y), out=[]; for(let dx=0;dx<w;dx++) for(let dy=0;dy<h;dy++) out.push(`${sx+dx*GRID.cellW}:${sy+dy*GRID.cellH}`); return out; }
  function reserve(wf,x,y,w=FOOT.w,h=FOOT.h){ blockCells(x,y,w,h).forEach(c=>wf.__occ.add(c)); return [snapX(x), snapY(y)]; }
  function freeY(wf,x,y,w=FOOT.w,h=FOOT.h){ const sx=snapX(x); let cy=snapY(y); while(blockCells(sx,cy,w,h).some(c=>wf.__occ.has(c))) cy+=GRID.cellH; return cy; }
  function addNode(wf,node){ node.name=uniqueName(wf,node.name); if(Array.isArray(node.position)){ const x=snapX(node.position[0]); const y=freeY(wf,x,node.position[1]); node.position=[x,y]; reserve(wf,x,y);} wf.nodes.push(node); return node.name; }
  function connect(wf,from,to,idx=0){ wf.connections[from]??={}; wf.connections[from].main??=[]; for(let i=wf.connections[from].main.length;i<=idx;i++) wf.connections[from].main[i]=[]; wf.connections[from].main[idx].push({ node: to, type:"main", index:0 }); }

  // ===== Small palette =====
  const setNode = (wf,name,fields,x,y)=> addNode(wf,{ id:uid('set'), name, type:'n8n-nodes-base.set', typeVersion:2, position:pos(x,y),
    parameters:{ keepOnlySet:false, values:{ string:Object.entries(fields||{}).map(([k,v])=>({name:k,value:v})) } } });
  const header   = (wf,txt,x,y)=> setNode(wf,`=== ${txt} ===`,{ __zone:`={{'${txt}'}}` },x,y);
  const manual   = (wf,x,y)=> addNode(wf,{ id:uid('m'), name:'Manual Trigger', type:'n8n-nodes-base.manualTrigger', typeVersion:1, position:pos(x,y), parameters:{} });
  const modelLm  = (role,x,y)=> addNode(wf,{ id:uid('lm'), name:`${role} · OpenAI Chat Model`, type:"@n8n/n8n-nodes-langchain.lmChatOpenAi", typeVersion:1.2, position:pos(x,y),
    parameters:{ model:{ "__rl":true,"value":"gpt-5-mini","mode":"list","cachedResultName":"gpt-5-mini"}, options:{ temperature:0.2 } },
    credentials:{ openAiApi:{ id:"OpenAI_Creds_Id", name:"OpenAi account" } }});
  const parser   = (role,x,y,schema)=> addNode(wf,{ id:uid('op'), name:`${role} · Structured Parser`, type:"@n8n/n8n-nodes-langchain.outputParserStructured",
    typeVersion:1.3, position:pos(x,y), parameters:{ jsonSchemaExample:schema }});
  const agentNode= (role,x,y,sys,user)=> addNode(wf,{ id:uid('ag'), name:role, type:"@n8n/n8n-nodes-langchain.agent", typeVersion:2.2, position:pos(x,y),
    parameters:{ promptType:"define", text:user, hasOutputParser:true, options:{ systemMessage:`=${sys}` } }});
  const validator= (wf,name,x,y)=> addNode(wf,{ id:uid('code'), name:`${name} · JSON Validator`, type:"n8n-nodes-base.code", typeVersion:2, position:pos(x,y),
    parameters:{ jsCode:`const out = $json.output ?? $json; if(!out || typeof out!=='object' || Array.isArray(out)) throw new Error('Invalid JSON'); return [out];` }});

  // ===== Contracts =====
  const SCHEMA_CONTEXT = `{"intent":"string","inputs":{"company":"string","industry":"string"},"success":"string","guardrails":["string"],"channel_bundle":{"email":{"subject":"string","body":"string"},"whatsapp":{"body":"string"},"call":{"script":"string"}}}`;
  const SCHEMA_STEP    = `{"action":{"id":"string","title":"string","type":"send_message|check_data|place_call|wait|http|END","params":{}},"memory":{"notes":["string"]}}`;

  // ===== Prompt generators (edit these to customize per industry/step) =====
  const sysContext = `You are 🧠 Context. Convert scenario into ${SCHEMA_CONTEXT}. JSON only.`;
  const sysStep    = `You are a specialist agent. For the given step, output ${SCHEMA_STEP}.\n- 'title' must be short & specific to this scenario.\n- Use channel_bundle when composing messages.\n- Choose 'END' when nothing else is needed.\nJSON only.`;

  function userContext(s, i){
    return `=Make ${SCHEMA_CONTEXT} from:\n${JSON.stringify({
      scenario_id: s.scenario_id||'',
      name: s.name||'',
      triggers: s.triggers||'',
      aim: s.roi_hypothesis||'',
      risk_notes: s.risk_notes||'',
      industry: i?.industry_id||'',
      tags: (s["tags (;)"]||s.tags||'').toString()
    }, null, 2)}`;
  }
  function userStep(stepName){
    // You can make this much richer (per industry, per company…).
    return `=Step "${stepName}". Input:\n{{$json}}\nReturn ${SCHEMA_STEP}.`;
  }

  // ===== Unified runner (executes whatever the step agent emits) =====
  function addRunner(wf, x, y, label){
    return addNode(wf,{
      id:uid('run'), name:`Run · ${label}`, type:'n8n-nodes-base.code', typeVersion:2, position:pos(x,y),
      parameters:{ jsCode:
`const a = $json.action || { type:'END', title:'END', params:{} };
async function exec(){
  switch(a.type){
    case 'send_message': return { status:200, body:{ to:a.params?.to, text:a.params?.body } };
    case 'check_data':  return { status:200, body:{ check:a.params||{} } };
    case 'place_call':  return { status:200, body:{ to:a.params?.to, script:a.params?.script } };
    case 'wait':        await new Promise(r=>setTimeout(r, (a.params?.seconds||10)*1000)); return { status:200, body:{ waited:a.params?.seconds||10 } };
    case 'http': {
      const res = await this.helpers.httpRequest({ url:a.params?.url, method:a.params?.method||'POST', json:true, body:a.params?.body||{}, resolveWithFullResponse:true });
      return { status: res.statusCode, body: res.body };
    }
    case 'END':
    default:            return { status:200, body:{ noop:true } };
  }
}
return exec().then(r => [{ ...$json, __exec:r }]);`
      }
    });
  }
  const addRecord = (wf, x, y, stepLabel, scenario)=> addNode(wf,{
    id:uid('rec'), name:`Record · ${scenario.scenario_id||'Scenario'} · ${stepLabel}`, type:'n8n-nodes-base.code', typeVersion:2, position:pos(x,y),
    parameters:{ jsCode:`const ctx=$items(0,0)?.json||{}; const hist=Array.isArray(ctx.__history)?ctx.__history:[]; hist.push({ step:'${stepLabel}', action:ctx.action, status:$json.__exec?.status }); return [{ ...ctx, __history:hist }];` }
  });

  // ===== Agent builder (single step) =====
  function addStepAgent(wf, x, y, stepName){
    const role = `🧩 ${stepName} Agent`;
    const lm   = modelLm(role, x, y+152);
    const prs  = parser(role, x+144, y+260, SCHEMA_STEP);
    const ag   = agentNode(role, x, y, sysStep, userStep(stepName));
    wf.connections[lm]     = { ai_languageModel: [[{ node: ag, type:"ai_languageModel", index:0 }]] };
    wf.connections[prs]    = { ai_outputParser:  [[{ node: ag, type:"ai_outputParser",  index:0 }]] };
    const val  = validator(wf, role, x+300, y);
    connect(wf, ag, val);
    return { in: ag, out: val };
  }

  // ===== Build main workflow =====
  function buildWorkflowJSON(scenario, industry, opts={}){
    // you can pass your own steps; default keeps it very short & readable
    const steps = (opts.steps && opts.steps.length ? opts.steps : [
      'Research',          // e.g., enrich / fetch ids / compute flags
      'Compose Message',   // e.g., prepare WhatsApp/email/call script
      'Dispatch'           // e.g., send / call / http
    ]).slice(0, 6); // hard cap to keep the canvas small

    const title = `${scenario?.scenario_id||'Scenario'} — ${scenario?.name||''}`.trim();
    const wf = baseWorkflow(title);

    // Header & first row
    header(wf, 'FLOW · CHAIN OF AGENTS', L.header.x, L.header.y);
    const trig = addNode(wf,{ id:uid('man'), name:'Manual Trigger', type:'n8n-nodes-base.manualTrigger', typeVersion:1, position:pos(L.start.x,L.start.y), parameters:{} });

    const init = setNode(wf,'Init',{
      'scenario.id': `={{'${scenario.scenario_id||''}'}}`,
      'scenario.name': `={{'${(scenario.name||'').replace(/'/g,"\\'")}'}}`,
      'industry.id': `={{'${industry?.industry_id||''}'}}`
    }, L.start.x + L.stepX, L.start.y);
    connect(wf, trig, init);

    // 🧠 Context agent
    const ctxLm  = modelLm('🧠 Context', L.start.x + 2*L.stepX, L.start.y+152);
    const ctxPr  = parser('🧠 Context',  L.start.x + 2*L.stepX + 144, L.start.y+260, SCHEMA_CONTEXT);
    const ctxAg  = agentNode('🧠 Context', L.start.x + 2*L.stepX, L.start.y, sysContext, userContext(scenario, industry));
    wf.connections[ctxLm] = { ai_languageModel: [[{ node: ctxAg, type:"ai_languageModel", index:0 }]] };
    wf.connections[ctxPr] = { ai_outputParser:  [[{ node: ctxAg, type:"ai_outputParser",  index:0 }]] };
    const ctxVal = validator(wf,'🧠 Context', L.start.x + 2*L.stepX + 300, L.start.y);
    connect(wf, ctxAg, ctxVal);
    connect(wf, init, ctxAg);

    // Chain step agents: [Agent → JSON] → Run → Record
    let cursor = ctxVal;
    let x = L.start.x + 3*L.stepX, y = L.start.y;

    steps.forEach((stepName, i)=>{
      const step = addStepAgent(wf, x, y, stepName);
      connect(wf, cursor, step.in);

      const run  = addRunner(wf, x+300, y, `${i+1}. ${stepName}`);
      connect(wf, step.out, run);

      const rec  = addRecord(wf, x+540, y, `${i+1}. ${stepName}`, scenario);
      connect(wf, run, rec);

      cursor = rec; x += L.stepX;
    });

    // Tiny summary tail
    const summary = setNode(wf,'🧾 Summary',{ '__stage':'={{"done"}}' }, x, y);
    connect(wf, cursor, summary);

    wf.staticData.__design = {
      layout:{ stepX:L.stepX, grid:GRID, footprint:FOOT, mode:'chain-of-agents' },
      notes:'Each step is an AI Agent with a tiny JSON contract → validated → executed. Keep steps short; customize prompts in userStep().'
    };
    return wf;
  }

  window.Builder = { buildWorkflowJSON };
})();
