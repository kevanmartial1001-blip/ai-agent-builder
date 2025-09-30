// public/builder.js
// Ultra-simple n8n JSON generator — Clean backbone + YES/NO lanes (2–3 steps)
// Layout inspired by your minimal screenshot.
//
// Backbone (6 nodes total):
// Manual Trigger → Init → 🧠 Context Agent → { } JSON Validator → 🗺️ Plan/Execute Agent → { } JSON Validator
// Then: YES/NO switch → two short lanes with compact action slots (Pick → END? → Run → Record)

(function () {
  "use strict";

  // ===== Layout (tight & tidy) =====
  const L = {
    stepX: 320,
    header: { x: -900, y: 40 },
    start:  { x: -860, y: 240 },
    lanesY: { yes: -100, no: 100 }
  };
  const GRID = { cellH: 70, cellW: 80 };
  const FOOT = { w: 3, h: 3 };

  // ===== Utils =====
  const uid=(p)=>`${p}_${Math.random().toString(36).slice(2,10)}`;
  const pos=(x,y)=>[x,y];
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

  // ===== Palette (tiny) =====
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
    return addNode(wf,{ id:uid('sim'), name:`Init Source · ${String(kind||'CRON').toUpperCase()}`,
      type:'n8n-nodes-base.set', typeVersion:2, position:pos(x,y),
      parameters:{ keepOnlySet:false, values:{ string:[{ name:'__trigger', value:`={{'${String(kind||'cron').toUpperCase()}'}}` }] } }
    });
  }
  function addSet(wf,name,fields,x,y){
    const stringVals = Object.entries(fields||{}).map(([k,v])=>({ name:k, value:v }));
    return addNode(wf,{ id:uid('set'), name, type:'n8n-nodes-base.set', typeVersion:2, position:pos(x,y),
      parameters:{ keepOnlySet:false, values:{ string: stringVals } } });
  }
  function addSwitch(wf,name,valueExpr,rules,x,y){
    const safe=(rules||[]).map(r=>({ operation:r.operation||'equal', value2:String(r.value2??'') }));
    return addNode(wf,{ id:uid('switch'), name, type:'n8n-nodes-base.switch', typeVersion:2, position:pos(x,y),
      parameters:{ value1:valueExpr, rules:safe }});
  }

  // ===== Agents (only 2) =====
  const SCHEMA_CONTEXT = `{
    "intent":"string",
    "inputs":{"company":"string","industry":"string","channels":["email","whatsapp","sms","call"]},
    "constraints":["string"],
    "success":"string"
  }`;

  const SCHEMA_EXEC = `{
    "hypothesis":"yes|no",
    "actions":{
      "yes":[{"id":"string","title":"string","type":"send_message|check_data|place_call|wait|http|END","params":{}}],
      "no":[{"id":"string","title":"string","type":"send_message|check_data|place_call|wait|http|END","params":{}}]
    },
    "env":{"channel_bundle":{"email":{"subject":"string","body":"string"},"whatsapp":{"body":"string"},"call":{"script":"string"}}}
  }`;

  const SYS_CONTEXT = `You are 🧠 Context. Convert the scenario fields into a minimal contract ${SCHEMA_CONTEXT}. JSON only.`;
  const SYS_EXEC    = `You are 🗺️ Planner/Executor. From Context produce ${SCHEMA_EXEC}.
- Choose hypothesis yes|no to best reach 'success'.
- Provide up to 3 actions per lane with short, scenario-specific 'title'.
- Allowed types: send_message | check_data | place_call | wait | http | END.
- Use env.channel_bundle content for messages. JSON only.`;

  function addAgent(wf, cfg){
    const {
      role='Agent', x=0, y=0, systemPrompt='You are agent.', userPromptExpr='={{$json}}',
      schema=SCHEMA_CONTEXT, modelName='gpt-5-mini', temperature=0.2
    } = cfg;

    const lm = addNode(wf, {
      id: uid('lm'), name: `${role} · OpenAI Chat Model`,
      type: "@n8n/n8n-nodes-langchain.lmChatOpenAi", typeVersion: 1.2, position: pos(x, y+148),
      parameters: { model: { "__rl": true, "value": modelName, "mode": "list", "cachedResultName": modelName }, options: { temperature } },
      credentials: { openAiApi: { id: "OpenAI_Creds_Id", name: "OpenAi account" } }
    });
    const parser = addNode(wf, {
      id: uid('parser'), name: `${role} · Structured Parser`,
      type: "@n8n/n8n-nodes-langchain.outputParserStructured", typeVersion: 1.3, position: pos(x+144, y+260),
      parameters: { jsonSchemaExample: schema }
    });
    const agent = addNode(wf, {
      id: uid('agent'), name: `${role}`,
      type: "@n8n/n8n-nodes-langchain.agent", typeVersion: 2.2, position: pos(x, y),
      parameters: { promptType:"define", text: userPromptExpr, hasOutputParser:true, options:{ systemMessage:`=${systemPrompt}` } }
    });
    // Wire
    wf.connections[lm]     = { ai_languageModel: [[{ node: agent, type: "ai_languageModel", index: 0 }]] };
    wf.connections[parser] = { ai_outputParser:  [[{ node: agent, type: "ai_outputParser",  index: 0 }]] };

    const validator = addNode(wf, {
      id: uid('code'), name: `${role} · JSON Validator`,
      type: "n8n-nodes-base.code", typeVersion: 2, position: pos(x+300, y),
      parameters: { jsCode:
`const out = $json.output ?? $json;
if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error('Invalid JSON');
return [out];` }
    });
    connect(wf, agent, validator);

    return { in: agent, out: validator };
  }

  // ===== Compact runner with pretty icons in names =====
  function actionIcon(type){
    return ({
      send_message:'📨', check_data:'🔎', place_call:'☎️', wait:'⏳', http:'🔗', END:'⛳'
    })[type] || '⚙️';
  }
  function addUnifiedRunner(wf, x, y, label){
    return addNode(wf, {
      id: uid('code'), name: `Run ${label}`,
      type: 'n8n-nodes-base.code', typeVersion: 2, position: pos(x, y),
      parameters: { jsCode:
`const a = $json.__action || { type:'END', title:'END', params:{} };
async function run(){
  switch (a.type) {
    case 'send_message': return { statusCode:200, body:{ delivered:true, to:a.params?.to, text:a.params?.body } };
    case 'check_data':  return { statusCode:200, body:{ check:a.params||{} } };
    case 'place_call':  return { statusCode:200, body:{ called:a.params?.to, script:a.params?.script } };
    case 'wait':        await new Promise(r=>setTimeout(r,(a.params?.seconds||10)*1000)); return { statusCode:200, body:{ waited:a.params?.seconds||10 } };
    case 'http': {
      const res = await this.helpers.httpRequest({ url:a.params?.url, method:a.params?.method||'POST', json:true, body:a.params?.body||{} , resolveWithFullResponse:true });
      return { statusCode: res.statusCode, body: res.body };
    }
    case 'END':
    default:            return { statusCode:200, body:{ noop:true } };
  }
}
return run().then(r => [{ ...$json, ...r }]);`
      }
    });
  }
  function addRecord(wf, x, y, lane, idx, scenario){
    return addNode(wf, {
      id: uid('code'), name: `Record · ${scenario.scenario_id||'Scenario'} · ${lane.toUpperCase()} #${idx}`,
      type: 'n8n-nodes-base.code', typeVersion: 2, position: pos(x, y),
      parameters: { jsCode:
`const p = $items(0,0)?.json || {};
const arr = Array.isArray(p.__results)?p.__results:[];
arr.push({ lane:'${lane}', idx:${idx}, title:p.__action?.title, type:p.__action?.type, status:$json.statusCode });
return [{ ...p, __results: arr }];`
      }
    });
  }
  function addPick(wf, x, y, lane, idx, scenario){
    return addNode(wf, {
      id: uid('code'), name: `${lane==='yes'?'✅ YES':'❌ NO'} · Pick #${idx} — ${String(scenario.name||'').slice(0,48)}`,
      type: 'n8n-nodes-base.code', typeVersion: 2, position: pos(x, y),
      parameters: { jsCode:
`const lane='${lane}', i=${idx}-1, play=$json||{};
const list=(play.actions && Array.isArray(play.actions[lane]))?play.actions[lane]:[];
const a=list[i] || { id:'END', title:'END', type:'END', params:{} };
return [{ ...play, __action:a }];`
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

  function addActionSlot(wf, lane, idx, x, baseY, scenario){
    const y = baseY + (L.lanesY[lane]||0);
    const pick = addPick(wf, x, y, lane, idx, scenario);
    const endQ = addIfEnd(wf, x+180, y); connect(wf, pick, endQ);

    const labelExpr = `${lane.toUpperCase()} #${idx}`;
    const run  = addUnifiedRunner(wf, x+380, y, labelExpr); connect(wf, endQ, run, 1);
    const rec  = addRecord(wf, x+620, y, lane, idx, scenario); connect(wf, run, rec);

    const done = addSet(wf, `${lane==='yes'?'✅':'❌'} Lane ${lane.toUpperCase()} · Step ${idx} · END`, { [`__end_${lane}_${idx}`]:'={{true}}' }, x+360, y-100);
    connect(wf, endQ, done, 0);
    return { enter: pick, tail: rec, done };
  }

  function addLane(wf, execOut, lane, x, baseY, steps, scenario){
    const norm = addSet(wf, `Normalize (${lane})`, { env:'={{$json.env || {}}}' }, x-200, baseY+(L.lanesY[lane]||0));
    connect(wf, execOut, norm);

    let prev = norm, firstDone=null;
    for(let i=1;i<=steps;i++){
      const slot = addActionSlot(wf, lane, i, x + (i-1)*L.stepX, baseY, scenario);
      connect(wf, prev, slot.enter);
      prev = slot.tail;
      if(!firstDone) firstDone = slot.done;
    }
    const done = addSet(wf, `Lane ${lane.toUpperCase()} · Done`, { [`__lane_${lane}_done`]:'={{true}}' }, x + steps*L.stepX + 120, baseY+(L.lanesY[lane]||0));
    connect(wf, prev, done);
    if(firstDone) connect(wf, firstDone, done);
    return done;
  }

  // ===== Main build =====
  function buildWorkflowJSON(s, industry, opts={}){
    const title = `${s?.scenario_id||'Scenario'} — ${s?.name||''}`.trim();
    const wf = baseWorkflow(title);

    // Header + tiny intro row
    addHeader(wf, 'FLOW · SIMPLE', L.header.x, L.header.y);
    const trig = addManual(wf, L.start.x, L.start.y, 'Manual Trigger');
    const initSrc = addSimTrigger(wf, 'CRON', L.start.x + Math.floor(L.stepX*0.7), L.start.y);
    connect(wf, trig, initSrc);

    // Init (only the essentials shown in UI)
    const init = addSet(
      wf,
      'Init Context',
      {
        'scenario.id': `={{'${s.scenario_id||''}'}}`,
        'scenario.name': `={{'${(s.name||'').replace(/'/g,"\\'")}'}}`,
        'industry.id': `={{'${industry?.industry_id||''}'}}`,
        'channels': `={{${JSON.stringify(['email','whatsapp','sms','call'])}}}`
      },
      L.start.x + 2*L.stepX, L.start.y
    );
    connect(wf, initSrc, init);

    // 🧠 Context Agent
    const ctx = addAgent(wf, {
      role:'🧠 Pre-flight Context',
      x: L.start.x + 3*L.stepX, y: L.start.y,
      systemPrompt:`=${SYS_CONTEXT}`,
      userPromptExpr: `=Create ${SCHEMA_CONTEXT} from:\n${scenarioJSON(s,industry)}`,
      schema: SCHEMA_CONTEXT, temperature:0.2
    });
    connect(wf, init, ctx.in);

    // 🗺️ Planner/Executor
    const exec = addAgent(wf, {
      role:'🗺️ Plan / Execute',
      x: L.start.x + 4*L.stepX, y: L.start.y,
      systemPrompt:`=${SYS_EXEC}`,
      userPromptExpr:`=Build ${SCHEMA_EXEC} using Context + scenario inputs:\n{{$json}}`,
      schema: SCHEMA_EXEC, temperature:0.2
    });
    connect(wf, ctx.out, exec.in);

    // YES/NO switch
    const hyp = addSwitch(wf, 'Route · YES / NO', "={{$json.hypothesis}}",
      [{operation:'equal', value2:'yes'},{operation:'equal', value2:'no'}],
      L.start.x + 5*L.stepX, L.start.y
    );
    connect(wf, exec.out, hyp);

    // Two tiny lanes (2–3 steps)
    const baseX = L.start.x + 6*L.stepX;
    const baseY = L.start.y - 10;
    const steps = Math.max(2, Math.min(3, opts.maxActionsPerLane || 3));

    const yesDone = addLane(wf, exec.out, 'yes', baseX, baseY, steps, s);
    const noDone  = addLane(wf, exec.out, 'no',  baseX, baseY, steps, s);

    connect(wf, hyp, yesDone, 0);
    connect(wf, hyp, noDone,  1);

    // Tiny tail (optional)
    const tail = addSet(wf, 'Summarize (brief)', { '__stage':'={{"done"}}' }, L.start.x + 2*L.stepX, L.start.y + 200);
    connect(wf, yesDone, tail); connect(wf, noDone, tail);

    // Notes
    wf.staticData.__design = {
      layout:{ stepX:L.stepX, grid:GRID, footprint:FOOT, antiOverlap:'block' },
      notes:'Backbone: Trigger→Init→Context→Plan/Execute. Then a single YES/NO fork with up to 3 compact actions per lane.'
    };
    return wf;
  }

  function scenarioJSON(s, i){
    return `{
  "scenario_id":"${s?.scenario_id||''}",
  "name":"${(s?.name||'').replace(/"/g,'\\"')}",
  "triggers":"${(s?.triggers||'').replace(/"/g,'\\"')}",
  "aim":"${(s?.roi_hypothesis||'').replace(/"/g,'\\"')}",
  "risk_notes":"${(s?.risk_notes||'').replace(/"/g,'\\"')}",
  "industry":"${i?.industry_id||''}"
}`;
  }

  window.Builder = { buildWorkflowJSON };
})();
