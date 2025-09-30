// public/builder.js
// Per-scenario generator: simple visual structure, deep logic.
// Canvas = two rows: PROD (top) + DEMO (bottom). Each row:
// Manual → Init → 🧠 Context → 🗺️ Schema-Map → Switch → Branch lanes
// Each lane = [ StepAgent → JSON → Run → Record ] × N
//
// Fixed horizontal spacing; no overlaps. AI nodes validate JSON at every hop.
// DEMO row uses seeded numbers/emails + "fake tools" while keeping the same logic.

(function () {
  "use strict";

  // ===== Layout (fixed spacing, no overlaps) =====
  const L = {
    HEADER: { x: -900, y: 40 },
    ROW_PROD_Y: 240,
    ROW_DEMO_Y: 720,
    START_X: -860,
  };
  const H = {
    SPAN: 320,         // gap between nodes in a group
    GROUP: 4,          // nodes per step group (Agent, Validator, Run, Record)
    BLOCK: 4,          // GROUP size used to move x to next step
    BRANCH_GAP_Y: 240, // vertical gap between branch lanes within a row
    AFTER_BACKBONE_GAP: 2, // additional spans from schema map → first branch block
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
      node.position = [sX(node.position[0]), sY(node.position[1])];
    }
    wf.nodes.push(node); return node.name;
  }
  function connect(wf,from,to,idx=0){
    wf.connections[from]??={}; wf.connections[from].main??=[];
    for(let i=wf.connections[from].main.length;i<=idx;i++) wf.connections[from].main[i]=[];
    wf.connections[from].main[idx].push({ node: to, type:"main", index:0 });
  }

  // ===== Small palette =====
  const setNode = (wf,name,fields,x,y)=> addNode(wf,{ id:uid('set'), name, type:'n8n-nodes-base.set', typeVersion:2, position:pos(x,y),
    parameters:{ keepOnlySet:false, values:{ string:Object.entries(fields||{}).map(([k,v])=>({name:k,value:v})) } } });
  const label   = (wf,txt,x,y)=> setNode(wf,`=== ${txt} ===`,{ __zone:`={{'${txt}'}}` },x,y);
  const manual  = (wf,x,y)=> addNode(wf,{ id:uid('m'), name:'Manual Trigger', type:'n8n-nodes-base.manualTrigger', typeVersion:1, position:pos(x,y), parameters:{} });

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
  const swNode   = (wf,name,expr,rules,x,y)=> addNode(wf,{ id:uid('sw'), name, type:'n8n-nodes-base.switch', typeVersion:2, position:pos(x,y),
    parameters:{ value1:expr, rules:rules.map(v=>({operation:'equal', value2:String(v)})) } });

  // ===== Contracts =====
  // Context distilled from the 4 columns + industry
  const SCHEMA_CONTEXT = `{
    "intent":"string",
    "industry":"string",
    "constraints":["string"],
    "success":"string",
    "channels_ranked":["email","whatsapp","sms","call","chat"],
    "guardrails":["string"]
  }`;

  // Schema map: branches (scenarios) and steps
  const SCHEMA_PLAN = `{
    "trigger":{"kind":"manual|webhook|cron|imap","why":"string"},
    "archetype":{"name":"string","confidence":0.0},
    "branches":[
      {
        "key":"string","title":"string","why":"string",
        "steps":[
          {"id":"string","title":"string","type":"send_message|check_data|place_call|wait|http|END","channel":"email|whatsapp|sms|call|none","tool":"string","params":{}}
        ]
      }
    ],
    "errors":[{"code":"string","fix":"string"}],
    "tools_suggested":["string"]
  }`;

  // One step (per-agent) contract
  const SCHEMA_STEP = `{
    "action":{"id":"string","title":"string","type":"send_message|check_data|place_call|wait|http|END","channel":"email|whatsapp|sms|call|none","tool":"string","params":{}},
    "notes":["string"]
  }`;

  // ===== Prompts (embed your logic) =====
  const sysContext = `You are 🧠 Context Distiller. Input = a business scenario with 4 context columns:
- triggers, best_reply_shapes, risk_notes, roi_hypothesis, plus 'industry' and 'tags'.
Produce ${SCHEMA_CONTEXT}. Keep it grounded in the provided context; JSON only.`;

  const sysPlanner = `You are 🗺️ Schema-Map Architect.
From Context + (triggers/best_reply_shapes/risk_notes/roi_hypothesis + industry + tags), enumerate ALL likely user-facing situations (branches),
and propose a robust plan per branch (steps with type/channel/tool), plus trigger & error catalog.
- channel choices must be modern & effective for the audience.
- tool names can be placeholders (Salesforce, CRM, MAILING, Twilio WhatsApp/Voice, etc.).
- Return ${SCHEMA_PLAN}. JSON only.`;

  const sysStep = `You are a specialist Step Agent. For a specific branch step:
- read Context + the Planner's branch + previous memory (if any),
- produce exactly one actionable 'action' following ${SCHEMA_STEP}.
- When composing messages, be natural and human, not "press 1 / press 2".
- If the step is purely conditional, choose 'check_data' or 'http' with small params.
JSON only.`;

  const userContext = (s,i)=> `=Context input:
{
  "industry":"${i?.industry_id||''}",
  "triggers":"${(s.triggers||'').replace(/"/g,'\\"')}",
  "best_reply_shapes":"${(s.best_reply_shapes||'').replace(/"/g,'\\"')}",
  "risk_notes":"${(s.risk_notes||'').replace(/"/g,'\\"')}",
  "roi_hypothesis":"${(s.roi_hypothesis||'').replace(/"/g,'\\"')}",
  "tags":"${(s["tags (;)"]||s.tags||'')}"
}
Return ${SCHEMA_CONTEXT}.`;

  const userPlanner = `=Planner input:
{
  "context": {{$json}},
  "hints": "Use the 4 columns to build a bullet-proof map. Multiple-choice flows must enumerate all outcomes. Suggest best channels and tools. Add trigger and errors."
}
Return ${SCHEMA_PLAN}.`;

  const userStep = (branchObj, stepObj)=> `=Step Agent input:
{
  "context": {{$json.__context}},
  "branch": ${JSON.stringify(branchObj)},
  "step": ${JSON.stringify(stepObj)}
}
Return ${SCHEMA_STEP}.`;

  // ===== Runners =====
  function addRunner(wf, x, y, label, mode /* 'prod'|'demo' */, demoSeeds){
    const seeds = demoSeeds || {};
    return addNode(wf,{
      id:uid('run'), name:`Run · ${label} · ${mode.toUpperCase()}`, type:'n8n-nodes-base.code', typeVersion:2, position:pos(x,y),
      parameters:{ jsCode:
`const mode = ${JSON.stringify(mode)};
const demo = ${JSON.stringify(seeds)};
const a = $json.action || { type:'END', title:'END', channel:'none', tool:'', params:{} };
const ctx = $json.__context || {};

function withDemoDefaults(p){
  const ch = (a.channel||'').toLowerCase();
  const out = {...p};
  if(ch==='whatsapp' || ch==='sms'){ out.to = out.to || demo.to || '+34613030526'; out.from = out.from || (ch==='whatsapp'? demo.waFrom : demo.smsFrom); }
  if(ch==='email'){ out.to = out.to || demo.emailTo || 'kevanm.spain@gmail.com'; out.subject = out.subject || 'Demo'; }
  if(ch==='call'){ out.to = out.to || demo.to || '+34613030526'; out.from = out.from || demo.callFrom; }
  return out;
}

async function exec(){
  switch(a.type){
    case 'send_message': {
      const p = mode==='demo' ? withDemoDefaults(a.params||{}) : (a.params||{});
      // In PROD, these are placeholders to be wired to real nodes later; here we just echo.
      return { status:200, body:{ channel:a.channel, tool:a.tool, payload:p, demo: mode==='demo' } };
    }
    case 'place_call': {
      const p = mode==='demo' ? withDemoDefaults(a.params||{}) : (a.params||{});
      return { status:200, body:{ channel:'call', tool:a.tool, payload:p, demo: mode==='demo' } };
    }
    case 'check_data':  return { status:200, body:{ check:a.params||{} } };
    case 'wait':        await new Promise(r=>setTimeout(r,(a.params?.seconds||5)*1000)); return { status:200, body:{ waited:a.params?.seconds||5 } };
    case 'http': {
      // For DEMO, just simulate ok; for PROD we still do a real request if url exists (can be placeholder)
      if(mode==='demo') return { status:200, body:{ simulated:true, url:a.params?.url||'FAKE', payload:a.params?.body||{} } };
      if(!a.params?.url) return { status:200, body:{ skipped:true } };
      const res = await this.helpers.httpRequest({ url:a.params.url, method:a.params.method||'POST', json:true, body:a.params.body||{}, resolveWithFullResponse:true });
      return { status: res.statusCode, body: res.body };
    }
    default:            return { status:200, body:{ noop:true } };
  }
}
return exec().then(r => [{ ...$json, __exec:r }]);`
      }
    });
  }
  function addRecord(wf, x, y, label, scenario, laneKey, mode){
    return addNode(wf,{
      id:uid('rec'), name:`Record · ${scenario.scenario_id||'Scenario'} · ${laneKey} · ${label} · ${mode.toUpperCase()}`,
      type:'n8n-nodes-base.code', typeVersion:2, position:pos(x,y),
      parameters:{ jsCode:
`const ctx=$items(0,0)?.json||{}; const hist=Array.isArray(ctx.__history)?ctx.__history:[]; 
hist.push({ label:'${label}', lane:'${laneKey}', mode:'${mode}', action:ctx.action, status:$json.__exec?.status });
return [{ ...ctx, __history: hist }];`
      }
    });
  }

  // ===== Build one Step Agent group (Agent → JSON → Run → Record)
  function addStepGroup(wf, baseX, y, branchObj, stepObj, laneKey, idx, scenario, mode, demoSeeds){
    const role = `🧩 ${stepObj.title || stepObj.id} Agent`;
    const agentX = baseX + H.SPAN*0;
    const valX   = baseX + H.SPAN*1;
    const runX   = baseX + H.SPAN*2;
    const recX   = baseX + H.SPAN*3;

    const lm   = modelLm(wf, role, agentX, y);
    const prs  = parser(wf, role, agentX, y, SCHEMA_STEP);
    const ag   = agentNode(wf, role, agentX, y, sysStep, userStep(branchObj, stepObj));
    wf.connections[lm]  = { ai_languageModel: [[{ node: ag, type:"ai_languageModel", index:0 }]] };
    wf.connections[prs] = { ai_outputParser:  [[{ node: ag, type:"ai_outputParser",  index:0 }]] };

    const val  = validator(wf, role, valX, y);
    connect(wf, ag, val);

    const run  = addRunner(wf, runX, y, `${idx}. ${stepObj.title||stepObj.id}`, mode, demoSeeds);
    connect(wf, val, run);

    const rec  = addRecord(wf, recX, y, `${idx}. ${stepObj.title||stepObj.id}`, scenario, laneKey, mode);
    connect(wf, run, rec);

    return { in: ag, out: rec };
  }

  // ===== Helper: build Context + Planner backbone for a row (prod/demo) =====
  function addBackbone(wf, scenario, industry, y, rowLabel){
    const trig = manual(wf, L.START_X, y);
    const init = setNode(wf, `Init (${rowLabel})`, {
      'scenario.id': `={{'${scenario.scenario_id||''}'}}`,
      'scenario.name': `={{'${(scenario.name||'').replace(/'/g,"\\'")}'}}`,
      'industry.id': `={{'${industry?.industry_id||''}'}}`,
    }, L.START_X + H.SPAN, y);
    connect(wf, trig, init);

    // Context
    const ctxRole = `🧠 Context (${rowLabel})`;
    const ctxLm = modelLm(wf, ctxRole, L.START_X + H.SPAN*2, y);
    const ctxPr = parser (wf, ctxRole, L.START_X + H.SPAN*2, y, SCHEMA_CONTEXT);
    const ctxAg = agentNode(wf, ctxRole, L.START_X + H.SPAN*2, y, sysContext, userContext(scenario, industry));
    wf.connections[ctxLm] = { ai_languageModel: [[{ node: ctxAg, type:"ai_languageModel", index:0 }]] };
    wf.connections[ctxPr] = { ai_outputParser:  [[{ node: ctxAg, type:"ai_outputParser",  index:0 }]] };
    const ctxVal = validator(wf, ctxRole, L.START_X + H.SPAN*3, y);
    connect(wf, ctxAg, ctxVal);
    connect(wf, init, ctxAg);

    // Planner
    const plRole = `🗺️ Schema-Map (${rowLabel})`;
    const plLm = modelLm(wf, plRole, L.START_X + H.SPAN*4, y);
    const plPr = parser (wf, plRole, L.START_X + H.SPAN*4, y, SCHEMA_PLAN);
    const plAg = agentNode(wf, plRole, L.START_X + H.SPAN*4, y, sysPlanner, userPlanner);
    wf.connections[plLm] = { ai_languageModel: [[{ node: plAg, type:"ai_languageModel", index:0 }]] };
    wf.connections[plPr] = { ai_outputParser:  [[{ node: plAg, type:"ai_outputParser",  index:0 }]] };
    const plVal = validator(wf, plRole, L.START_X + H.SPAN*5, y);
    connect(wf, plAg, plVal);
    connect(wf, ctxVal, plAg);

    // Pack context for step agents
    const pack = addNode(wf,{ id:uid('pack'), name:`Pack Context (${rowLabel})`,
      type:'n8n-nodes-base.code', typeVersion:2, position:pos(L.START_X + H.SPAN*6, y),
      parameters:{ jsCode:`return [{ __context: $items(0,0).json }];` }
    });
    connect(wf, plVal, pack);

    // Branch switch (by branch.key)
    const sw = swNode(wf, `Route Branch (${rowLabel})`, "={{$json.branches && $json.branches[0] && $json.branches[0].key || 'main'}}",
      [], L.START_X + H.SPAN*7, y);
    // We don't know keys yet; we will connect after we create lanes.
    connect(wf, pack, sw);

    return { ctxVal, planVal: plVal, packOut: pack, switchName: sw };
  }

  // ===== Build a branch lane (sequence of step groups) =====
  function addBranchLane(wf, startX, baseY, branchObj, laneIndex, scenario, mode, demoSeeds){
    // lane Y offset
    const y = baseY + laneIndex * H.BRANCH_GAP_Y;
    // Show a tiny lane header
    label(wf, `${mode.toUpperCase()} · Branch: ${branchObj.title||branchObj.key}`, startX - H.SPAN, y - 100);

    let cursorName = null; // will connect from switch after we add the enter node
    // Enter node stamps the selected branch into the stream
    const enter = addNode(wf,{
      id:uid('enter'), name:`Enter · ${branchObj.key} (${mode})`,
      type:'n8n-nodes-base.code', typeVersion:2, position:pos(startX, y),
      parameters:{ jsCode: `return [{ ...$json, __branch: ${JSON.stringify(branchObj)} }];` }
    });
    cursorName = enter;

    // Steps
    const steps = Array.isArray(branchObj.steps) ? branchObj.steps : [];
    let baseX = startX + H.SPAN; // first step starts after enter

    steps.forEach((st, i)=>{
      const grp = addStepGroup(wf, baseX, y, branchObj, st, branchObj.key, i+1, scenario, mode, demoSeeds);
      connect(wf, cursorName, grp.in);
      cursorName = grp.out;
      baseX += H.SPAN * H.BLOCK;
    });

    // Tail summary
    const tail = setNode(wf, `Lane Done (${branchObj.key}, ${mode})`, { [`__lane_${branchObj.key}_${mode}`] : '={{true}}' }, baseX, y);
    connect(wf, cursorName, tail);

    return { enter, done: tail };
  }

  // ===== Main build =====
  function buildWorkflowJSON(scenario, industry, opts = {}){
    const title = `${scenario?.scenario_id||'Scenario'} — ${scenario?.name||''}`.trim();
    const wf = baseWorkflow(title);

    // Headers
    label(wf, 'FLOW · PRODUCTION', L.HEADER.x, L.HEADER.y);
    label(wf, 'FLOW · DEMO',       L.HEADER.x, L.HEADER.y + (L.ROW_DEMO_Y - L.ROW_PROD_Y));

    // DEMO seeds
    const demoSeeds = {
      to: "+34613030526",
      emailTo: "kevanm.spain@gmail.com",
      waFrom: "+14155238886",
      smsFrom: "+13412184164",
      callFrom: "+13412184164",
      ...(opts.demoSeeds||{})
    };

    // PROD backbone
    const prod = addBackbone(wf, scenario, industry, L.ROW_PROD_Y, 'PROD');
    // DEMO backbone
    const demo = addBackbone(wf, scenario, industry, L.ROW_DEMO_Y, 'DEMO');

    // Build lanes AFTER planner: we need planner output to know branches.
    // We emulate connections: switch node will have one output per branch key.
    function buildLanes(row, baseY, mode){
      const swName = row.switchName;
      // Put a tiny decoder that exposes branches array for wiring (pure JS, no runtime effect)
      const expose = addNode(wf,{
        id:uid('x'), name:`Expose Branches (${mode})`, type:'n8n-nodes-base.code', typeVersion:2, position:pos(L.START_X + H.SPAN*8, baseY),
        parameters:{ jsCode:`return [$items(0,0).json];` }
      });
      connect(wf, swName, expose, 0);

      // We don't know branches statically; to keep canvas readable we pre-create up to N lanes with placeholder keys,
      // and the actual keys still appear in node labels (from planner output) for visual clarity.
      const MAX_BRANCHES = Math.min(opts.maxBranches || 4, 8);
      const startX = L.START_X + H.SPAN*(8 + H.AFTER_BACKBONE_GAP); // a little gap after switch
      const branchesSample = [
        { key: 'yes', title: 'Yes path', steps: [] },
        { key: 'no',  title: 'No path',  steps: [] },
        { key: 'maybe', title: 'Maybe path', steps: [] },
      ];

      // At build-time, we can’t read LLM output; but we still lay the lanes cleanly.
      // The actual JSON at run-time will flow and the step agents will use it.
      const laneObjs = (opts.stubBranches || branchesSample).slice(0, MAX_BRANCHES);
      const lanes = laneObjs.map((b, i)=> addBranchLane(wf, startX, baseY, b, i, scenario, mode, demoSeeds));

      // Wire switch outputs to each lane enter in order (0..n-1)
      lanes.forEach((lane, i)=> connect(wf, swName, lane.enter, i));

      return lanes;
    }

    buildLanes(prod, L.ROW_PROD_Y, 'prod');
    buildLanes(demo, L.ROW_DEMO_Y, 'demo');

    wf.staticData.__design = {
      layout:{ span:H.SPAN, group:H.GROUP, block:H.BLOCK, branchGapY:H.BRANCH_GAP_Y, rows:{ prod:L.ROW_PROD_Y, demo:L.ROW_DEMO_Y } },
      notes:[
        'One scenario per workflow. Two rows: PROD + DEMO.',
        'Context → Schema-Map creates branches/steps; lanes are fixed in the canvas and AI fills content at run-time.',
        'Each step is an AI agent with JSON validator → runner → recorder.',
        'DEMO uses seeded contacts + fake tools; PROD keeps placeholders wired so you can hook real creds later.'
      ]
    };
    return wf;
  }

  window.Builder = { buildWorkflowJSON };
})();
