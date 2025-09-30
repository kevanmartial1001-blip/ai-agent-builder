// public/builder.js
// n8n JSON generator — Chain-of-Experts edition.
// Team of agents (each boxed as Agent→Parser→Validator), strictly sequenced so each consumes the previous agent’s JSON.
// Layout rules preserved: anti-overlap grid, Switch→Outcome-only wiring, channel fan-out after Composer/QA.

(function () {
  "use strict";

  // ---------- Layout ----------
  const LAYOUT = { stepX: 380, channelY: 420, outcomeRowY: 380, header:{x:-900,y:40}, start:{x:-860,y:240}, switchX:-560 };
  const GRID = { cellH: 70, cellW: 80 };
  const FOOTPRINT = { w: 3, h: 3 };

  // ---------- Demo endpoints ----------
  const DEFAULT_HTTP = {
    pms_upcoming:"https://example.com/pms/upcoming",
    pms_update:"https://example.com/pms/update",
    ticket_create:"https://example.com/ticket/create",
    calendar_book:"https://example.com/calendar/book",
    step_generic:"https://example.com/step",
    ops_alert:"https://example.com/ops/alert",
    pay_link:"https://example.com/pay",
    dispute:"https://example.com/ar/dispute",
    kyc:"https://example.com/kyc",
    inspect:"https://example.com/inspect"
  };

  // ---------- Archetypes & triggers ----------
  const ARCH_RULES = [
    { a:'APPOINTMENT_SCHEDULING', rx:/(appointment|scheduling|no[-_ ]?show|calendar)/i },
    { a:'CUSTOMER_SUPPORT_INTAKE', rx:/\b(cs|support|helpdesk|ticket|sla|triage|kb)\b/i },
    { a:'AR_FOLLOWUP', rx:/\b(a\/?r|accounts?\s*receivable|invoice|collections?)\b/i },
    { a:'RECRUITING_INTAKE', rx:/\b(recruit(ing)?|ats|candidate|interview)\b/i },
    { a:'SALES_OUTREACH', rx:/\b(sales|outreach|sequence|prospect)\b/i }
  ];
  const TRIGGER_PREF = {
    APPOINTMENT_SCHEDULING:'cron', CUSTOMER_SUPPORT_INTAKE:'webhook', AR_FOLLOWUP:'cron',
    RECRUITING_INTAKE:'webhook', SALES_OUTREACH:'manual'
  };

  // ---------- Utils ----------
  const uid = (p)=>`${p}_${Math.random().toString(36).slice(2,10)}`;
  const pos = (x,y)=>[x,y];
  const listify = (v)=> Array.isArray(v) ? v.map(x=>String(x).trim()).filter(Boolean)
                  : String(v||'').split(/[;,/|\n]+/).map(x=>x.trim()).filter(Boolean);
  const snapX = (x)=> Math.round(x / GRID.cellW) * GRID.cellW;
  const snapY = (y)=> Math.round(y / GRID.cellH) * GRID.cellH;

  function chooseArchetype(s){
    const hay = [s.scenario_id, s.name, s.tags, s.triggers, s.how_it_works, s.tool_stack_dev]
      .map(x=>String(x||'')).join(' ');
    for(const r of ARCH_RULES) if(r.rx.test(hay)) return r.a;
    return 'SALES_OUTREACH';
  }
  function preferredTrigger(archetype, s){
    const t = String(s.triggers||'').toLowerCase();
    if (/webhook|callback|incoming|real[- ]?time/.test(t)) return 'webhook';
    if (/daily|weekly|cron|every\s+\d+\s*(min|hour|day)/.test(t)) return 'cron';
    if (/imap|inbox|email/.test(t)) return 'imap';
    return TRIGGER_PREF[archetype] || 'manual';
  }
  function hash32(s){ let h=2166136261>>>0; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return (h>>>0); }
  function scenarioSeed(scenario){
    const s = [scenario?.scenario_id||'', scenario?.name||'', String(scenario?.tags||scenario?.["tags (;)"]||'')].join('|');
    const h = hash32(s);
    return { idx: h%3, flip: !!(h&0x8), deep: !!(h&0x20), approvals: !!(h&0x40) };
  }
  function deriveFeatures(s){
    const t = (k)=>String(s[k]||'').toLowerCase();
    const txt = [t('triggers'),t('how_it_works'),t('tool_stack_dev'),t('roi_hypothesis'),t('risk_notes'),String(s.tags||s['tags (;)']||'').toLowerCase()].join('|');
    const f=new Set();
    if(/pms|dentrix|opendental|eaglesoft/.test(txt)) f.add('pms');
    if(/crm|hubspot|salesforce|pipedrive/.test(txt)) f.add('crm');
    if(/kb|knowledge[- ]?base|confluence|notion/.test(txt)) f.add('kb');
    if(/payment|payable|invoice|collections?/.test(txt)) f.add('payment');
    if(/dispute|appeal/.test(txt)) f.add('dispute_flow');
    if(/calendar|calendly|outlook|google calendar/.test(txt)) f.add('calendar');
    if(/compliance|gdpr|hipaa|pii|privacy|security|risk|audit/.test(txt)) f.add('compliance_guard');
    if(/ats|greenhouse|lever/.test(txt)) f.add('ats');
    return f;
  }

  // ---------- Base workflow + occupancy ----------
  function baseWorkflow(name){ return { name, nodes:[], connections:{}, active:false, settings:{ executionOrder:"v1", timezone:"Europe/Madrid" }, staticData:{}, __occ:new Set() }; }
  function uniqueName(wf, base){ const ex=new Set((wf.nodes||[]).map(n=>String(n.name||'').toLowerCase())); let nm=base||'Node',i=1; while(ex.has(nm.toLowerCase())){ i++; nm=`${base} #${i}`;} return nm; }
  const key=(x,y)=>`${x}:${y}`;
  function blockCells(x,y,w=FOOTPRINT.w,h=FOOTPRINT.h){ const sx=snapX(x), sy=snapY(y); const cells=[]; for(let dx=0;dx<w;dx++) for(let dy=0;dy<h;dy++) cells.push(key(sx+dx*GRID.cellW, sy+dy*GRID.cellH)); return cells; }
  function blockFree(wf,x,y,w=FOOTPRINT.w,h=FOOTPRINT.h){ return blockCells(x,y,w,h).every(c=>!wf.__occ.has(c)); }
  function reserveBlock(wf,x,y,w=FOOTPRINT.w,h=FOOTPRINT.h){ blockCells(x,y,w,h).forEach(c=>wf.__occ.add(c)); return [snapX(x),snapY(y)]; }
  function findFreeY(wf,x,desiredY,w=FOOTPRINT.w,h=FOOTPRINT.h){ const sx=snapX(x); let y=snapY(desiredY); const step=GRID.cellH; while(!blockFree(wf,sx,y,w,h)){ y+=step; } return y; }
  function addNode(wf,node){
    node.name = uniqueName(wf, node.name);
    if(Array.isArray(node.position)){
      const x=snapX(node.position[0]);
      const y=findFreeY(wf,x,node.position[1],FOOTPRINT.w,FOOTPRINT.h);
      node.position=[x,y];
      reserveBlock(wf,x,y,FOOTPRINT.w,FOOTPRINT.h);
    }
    wf.nodes.push(node); return node.name;
  }
  function connect(wf,from,to,outputIndex=0){
    wf.connections[from]??={};
    wf.connections[from].main??=[];
    for(let i=wf.connections[from].main.length;i<=outputIndex;i++) wf.connections[from].main[i]=[];
    wf.connections[from].main[outputIndex].push({ node: to, type: "main", index: 0 });
  }

  // ---------- Palette ----------
  function addHeader(wf,label,x,y){
    return addNode(wf,{ id:uid('label'), name:`=== ${label} ===`, type:'n8n-nodes-base.set', typeVersion:2, position:pos(x,y),
      parameters:{ keepOnlySet:false, values:{ string:[{ name:'__zone', value:`={{'${label}'}}`}] } }});
  }
  function addManual(wf,x,y,label='Manual Trigger'){ return addNode(wf,{ id:uid('manual'), name:label, type:'n8n-nodes-base.manualTrigger', typeVersion:1, position:pos(x,y), parameters:{} }); }
  function addSimTrigger(wf, kind, x, y){
    return addNode(wf,{ id:uid('sim'), name:`Simulated Trigger · ${String(kind||'manual').toUpperCase()}`, type:'n8n-nodes-base.set', typeVersion:2, position:pos(x,y),
      parameters:{ keepOnlySet:false, values:{ string:[{name:'__trigger', value:`={{'${String(kind||'manual').toUpperCase()}'}}`}] } }});
  }
  function addHTTP(wf,name,urlExpr,bodyExpr,x,y,method='POST'){
    return addNode(wf,{ id:uid('http'), name, type:'n8n-nodes-base.httpRequest', typeVersion:4, position:pos(x,y),
      parameters:{ url:urlExpr, method, jsonParameters:true, sendBody:true, bodyParametersJson:bodyExpr } });
  }
  function addSet(wf,name,fields,x,y){
    const stringVals = Object.entries(fields||{}).map(([k,v])=>({ name:k, value:v }));
    return addNode(wf,{ id:uid('set'), name, type:'n8n-nodes-base.set', typeVersion:2, position:pos(x,y),
      parameters:{ keepOnlySet:false, values:{ string: stringVals } }});
  }
  function addSwitch(wf,name,valueExpr,rules,x,y){
    const safe = (rules||[]).map(r=>({ operation:r.operation||'equal', value2:String(r.value2??'') }));
    return addNode(wf,{ id:uid('switch'), name, type:'n8n-nodes-base.switch', typeVersion:2, position:pos(x,y),
      parameters:{ value1:valueExpr, rules:safe }});
  }
  function addWait(wf,name,x,y,seconds=90){ return addNode(wf,{ id:uid('wait'), name, type:'n8n-nodes-base.wait', typeVersion:1, position:pos(x,y), parameters:{ amount: seconds, unit:'seconds', options:{} }}); }
  function addCollector(wf,x,y){ return addHTTP(wf,'Collector (Inspect)', `={{'${DEFAULT_HTTP.inspect}'}}`, '={{$json}}', x, y); }
  function makeSender(wf, channel, x, y){
    if(channel==='whatsapp'){
      return addNode(wf,{ id:uid('wa'), name:'Send WhatsApp (Twilio)', type:'n8n-nodes-base.twilio', typeVersion:3, position:pos(x,y),
        parameters:{ resource:'message', operation:'create',
          from:"={{'whatsapp:' + ($json.waFrom||'+10000000002')}}",
          to:"={{'whatsapp:' + ($json.to||'+10000000003')}}",
          message:"={{$json.message||'Hello!'}}" }, credentials:{} });
    }
    if(channel==='call'){
      return addHTTP(wf,'Place Call', "={{$json.callWebhook||'https://example.com/call'}}",
        "={{ { to:$json.to, from:$json.callFrom, text: ($json.message||'Hello!') } }}", x, y, 'POST');
    }
    return addSet(wf, `Send ${channel.toUpperCase()}`, { sent:`={{true}}` }, x, y);
  }

  // ---------- Agent contracts ----------
  const SCHEMA_PREFLIGHT = `{"intent":"string","user_state_hypotheses":["string"],"risks":["string"],"kpis":["string"],"channels_ranked":["email","whatsapp","sms","call"],"guardrails":["string"]}`;
  const SCHEMA_RESEARCH  = `{"company":{"name":"string","domain":"string","geo":"string","stack":["string"]},"personas":["string"],"intel":["string"]}`;
  const SCHEMA_PLANNER   = `{"branches":[{"name":"string"}],"decisions":[{"step":"number","name":"string"}],"steps":["string"],"error_catalog":[{"code":"string","hint":"string"}]}`;
  const SCHEMA_ORCH      = `{"tool_calls":[{"name":"string","url":"string","payload":{"_":"any"},"on_success_next":"string","on_error_next":"string"}]}`;
  const SCHEMA_COMPOSER  = `{"email":{"subject":"string","body":"string"},"whatsapp":{"body":"string"},"sms":{"body":"string"},"call":{"script":"string"}}`;
  const SCHEMA_QA        = `{"ok":true,"reasons":["string"],"fixups":[{"field":"string","value":"string"}]}`;
  const SCHEMA_SUMMARY   = `{"highlights":["string"],"decisions_taken":["string"],"next_actions":["string"]}`;

  const SYS_PREFLIGHT = `You are PreFlight. Distill messy scenario fields into a clean JSON context. Output strict JSON.`;
  const SYS_RESEARCH  = `You are Researcher. Enrich with light company/stack/persona intel using only provided inputs. JSON only.`;
  const SYS_PLANNER   = `You are Planner. Produce a numbered decision plan for this archetype. JSON only.`;
  const SYS_ORCH      = `You are Orchestrator. Turn the plan into concrete tool calls/steps. JSON only.`;
  const SYS_COMPOSER  = `You are Composer. Produce channel-specific copy/scripts grounded in context. JSON only.`;
  const SYS_QA        = `You are QA. Validate the bundle & propose minimal fixups. JSON only.`;
  const SYS_SUMMARY   = `You are Summarizer. Output concise highlights for BI/Slack. JSON only.`;

  // ---------- Agent helper ----------
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
    wf.connections[lm] = { ai_languageModel: [[{ node: agent, type: "ai_languageModel", index: 0 }]] };
    wf.connections[parser] = { ai_outputParser: [[{ node: agent, type: "ai_outputParser", index: 0 }]] };

    const validator = addNode(wf, {
      id: uid('code'), name: `${role} · JSON Validator`,
      type: "n8n-nodes-base.code", typeVersion: 2, position: pos(x+300, y),
      parameters: { jsCode:
`const out = $json.output ?? $json;
if (typeof out !== 'object' || Array.isArray(out) || out === null) throw new Error('Agent did not return an object');
return [out];` }
    });
    connect(wf, agent, validator);
    return { in: agent, out: validator, lm, parser };
  }

  // ---------- Team factory (what agents we insert, in order) ----------
  function makeTeam(archetype, features){
    // Minimal default team
    const team = [
      { key:'preflight',  role:'Pre-flight Context Agent', schema:SCHEMA_PREFLIGHT, sys:SYS_PREFLIGHT,  user:(s,i)=>`=Distill scenario into ${SCHEMA_PREFLIGHT}:\n${baseScenarioJSON(s,i)}` },
      // research only when helpful
      ...( (features.has('crm') || features.has('kb') || features.has('ats')) ? [
        { key:'research', role:'Research Agent',           schema:SCHEMA_RESEARCH,  sys:SYS_RESEARCH,   user:(s,i)=>`=Light research from inputs only into ${SCHEMA_RESEARCH} (no web calls):\n${baseScenarioJSON(s,i)}` }
      ] : []),
      { key:'planner',   role:'Planner / Schema-Map Agent',schema:SCHEMA_PLANNER,  sys:SYS_PLANNER,    user:(s,i)=>`=Plan for archetype "${archetype}" into ${SCHEMA_PLANNER}. PREFLIGHT/RESEARCH:\n{{$json}}` },
      ...( (features.has('payment') || features.has('dispute_flow') || features.has('calendar') || features.has('crm')) ? [
        { key:'orch',    role:'Ops / Tool Orchestrator',   schema:SCHEMA_ORCH,      sys:SYS_ORCH,       user:(s,i)=>`=Turn the plan into concrete tool calls ${SCHEMA_ORCH}. Input:\n{{$json}}` }
      ] : []),
      { key:'composer',  role:'Channel Composer',          schema:SCHEMA_COMPOSER,  sys:SYS_COMPOSER,   user:(s,i)=>`=Compose channel bundle ${SCHEMA_COMPOSER} using context & plan:\n{{$json}}` },
      { key:'qa',        role:'QA / Validator',            schema:SCHEMA_QA,        sys:SYS_QA,         user:(s,i)=>`=Validate and return ${SCHEMA_QA}. Fixups only if trivial. Input:\n{{$json}}` },
      { key:'summary',   role:'Summarizer / Logger',       schema:SCHEMA_SUMMARY,   sys:SYS_SUMMARY,    user:(s,i)=>`=Summarize action into ${SCHEMA_SUMMARY} from:\n{{$json}}` },
    ];
    return team;
  }

  function baseScenarioJSON(s, industry){
    const tags = JSON.stringify(listify(s["tags (;)"]||s.tags));
    return `{
  "industry":"${industry?.industry_id||''}",
  "scenario_id":"${s.scenario_id||''}",
  "name":"${(s.name||'').replace(/"/g,'\\"')}",
  "triggers":"${(s.triggers||'').replace(/"/g,'\\"')}",
  "how_it_works":"${(s.how_it_works||'').replace(/"/g,'\\"')}",
  "roi_hypothesis":"${(s.roi_hypothesis||'').replace(/"/g,'\\"')}",
  "risk_notes":"${(s.risk_notes||'').replace(/"/g,'\\"')}",
  "tags": ${tags}
}`;
  }

  // Build a linear chain of agents; each validator feeds the next agent.
  function addTeamChain(wf, team, originNodeName, baseX, baseY){
    let cursor = originNodeName;
    let x = baseX, y = baseY - 120;
    const outNodes = {};
    team.forEach((t, idx)=>{
      const agent = addAgent(wf, {
        role: t.role, x, y, systemPrompt:`=${t.sys}`, userPromptExpr:t.user,
        schema:t.schema, modelName:'gpt-5-mini', temperature: (t.key==='composer'?0.5:0.2)
      });
      connect(wf, cursor, agent.in);
      cursor = agent.out; // validator out becomes next input
      outNodes[t.key] = agent; // keep references if needed later
      x += 320;
    });
    return { tail: cursor, outNodes };
  }

  // ---------- Messaging fallback (used only when Composer is absent) ----------
  function composeBody(archetype, channel, s, industry){
    const ctx = {
      trig: String(s.triggers||'').trim(),
      how: String(s.how_it_works||'').trim(),
      roi: String(s.roi_hypothesis||'').trim(),
      tone: (industry?.agent_language_prompt || industry?.vocabulary || '').trim()
    };
    const opener = { whatsapp:'Heads up:', call:'Talk track:' }[channel] || 'Note:';
    const cta = { whatsapp:'Reply to confirm or change.', call:'Say “confirm” or “reschedule”.' }[channel] || 'Reply to proceed.';
    const lines = (...xs)=> xs.filter(Boolean).slice(0,6).join('\n');
    switch(archetype){
      case 'APPOINTMENT_SCHEDULING': return lines(opener, ctx.trig && `Why now: ${ctx.trig}`, `Plan: ${ctx.how||'Confirm or reschedule.'}`, ctx.roi && `Impact: ${ctx.roi}`, ctx.tone, cta);
      case 'CUSTOMER_SUPPORT_INTAKE': return lines(opener, 'We received your request and opened a ticket.', ctx.how && `Next: ${ctx.how}`, ctx.tone, cta);
      case 'AR_FOLLOWUP': return lines(opener, 'Your invoice appears past due.', ctx.trig && `Context: ${ctx.trig}`, ctx.how && `Resolution: ${ctx.how}`, 'Reply “dispute” if you disagree.', cta);
      default: return lines(opener, ctx.trig && `Context: ${ctx.trig}`, ctx.how && `Plan: ${ctx.how}`, ctx.roi && `Value: ${ctx.roi}`, ctx.tone, cta);
    }
  }

  // ---------- Plays (same as before; trimmed) ----------
  const amplify = (branches)=> (branches||[]).map(b=>{ const extra = { name:'Store · Audit trail', kind:'store' }; const dup = JSON.parse(JSON.stringify(b)); dup.steps = (dup.steps||[]).concat([extra]); return dup; });

  function playsScheduling(features){
    return [{
      name:'Scheduling',
      steps:[
        features.has('compliance_guard') ? { name:'Guard · Consent/PII mask', kind:'update' } : null,
        features.has('pms') ? { name:'Lookup · Upcoming appointments (PMS/CRM)', kind:'lookup' } : null,
        { name:'Decision · Have upcoming appointment', kind:'decision', outcomes:[
          { value:'yes_upcoming', steps:[
            { name:'Compose · Confirmation incl. address/reason', kind:'compose' },
            { name:'Book · Confirm in calendar', kind:'book' },
            { name:'Notify · Reminder T-2h', kind:'notify' }
          ].filter(Boolean)},
          { value:'no_or_cannot_attend', steps:[
            { name:'Lookup · Next available slots (3)', kind:'lookup' },
            { name:'Compose · Offer reschedule options', kind:'compose' },
            { name:'Decision · Client picked a slot', kind:'decision', outcomes:[
              { value:'reschedule_yes', steps:[ { name:'Book · New slot in calendar', kind:'book' }, { name:'Notify · Reminder T-2h', kind:'notify' } ]},
              { value:'reschedule_no', steps:[ { name:'Store · Follow-up list', kind:'store' } ]}
            ]}
          ]}
        ]}
      ].filter(Boolean)
    }];
  }
  function playsSupport(features){
    return [{
      name:'Support',
      steps:[
        features.has('kb') ? { name:'KB · Semantic search', kind:'lookup' } : null,
        { name:'Decision · KB match', kind:'decision', outcomes:[
          { value:'hit', steps:[ { name:'Compose · Natural answer + link', kind:'compose' } ]},
          { value:'miss', steps:[ { name:'Ticket · Create', kind:'ticket' } ]}
        ]}
      ].filter(Boolean)
    }];
  }
  function playsAR(features){
    return [{
      name:'AR Follow-up',
      steps:[
        { name:'Lookup · Aging', kind:'lookup' },
        features.has('payment') ? { name:'HTTP · Generate payment link', kind:'http' } : null,
        { name:'Decision · Bucket 30/60/90', kind:'decision', outcomes:[
          { value:'30', steps:[ { name:'Compose · Friendly reminder', kind:'compose' } ]},
          { value:'60', steps:[ { name:'Compose · Firm reminder', kind:'compose' } ]},
          { value:'90', steps:[ { name:'Notify · Finance', kind:'notify' }, features.has('dispute_flow')?{ name:'Compose · Final w/ dispute option', kind:'compose' }:{ name:'Compose · Final notice', kind:'compose' } ]}
        ]}
      ].filter(Boolean)
    }];
  }
  function playsRecruiting(features){
    return [{
      name:'Recruiting',
      steps:[
        features.has('ats') ? { name:'Parse · Resume', kind:'lookup' } : null,
        { name:'Decision · Route', kind:'decision', outcomes:[
          { value:'ae',  steps:[ { name:'Calendar · Phone screen', kind:'book' } ]},
          { value:'sdr', steps:[ { name:'Calendar · Screening',   kind:'book' } ]}
        ]}
      ].filter(Boolean)
    }];
  }
  function playsGeneric(){ return [{ name:'Main', steps:[ {name:'Compose · Outreach',kind:'compose'} ] }]; }

  // ---------- Build ----------
  function buildWorkflowJSON(scenario, industry, opts = {}){
    const seed = scenarioSeed(scenario);
    const archetype = (scenario?.archetype) ? String(scenario.archetype).toUpperCase() : chooseArchetype(scenario);
    const triggerKind = preferredTrigger(archetype, scenario);
    const features = deriveFeatures(scenario);

    let plays;
    if (archetype==='APPOINTMENT_SCHEDULING') plays = playsScheduling(features);
    else if (archetype==='CUSTOMER_SUPPORT_INTAKE') plays = playsSupport(features);
    else if (archetype==='AR_FOLLOWUP') plays = playsAR(features);
    else if (archetype==='RECRUITING_INTAKE') plays = playsRecruiting(features);
    else plays = playsGeneric();

    const picked = plays[0];
    const title = `${scenario?.scenario_id||'Scenario'} — ${scenario?.name||''}`.trim();
    const wf = baseWorkflow(title);

    // Headers + triggers
    addHeader(wf, 'FLOW AREA · PRODUCTION', LAYOUT.header.x, LAYOUT.header.y);
    const manual = addManual(wf, LAYOUT.start.x, LAYOUT.start.y, 'Manual Trigger');
    const simTrig = addSimTrigger(wf, triggerKind, LAYOUT.start.x + Math.floor(LAYOUT.stepX*0.7), LAYOUT.start.y);
    connect(wf, manual, simTrig);

    // Init
    const init = addSet(wf,'Init Context',{
      'scenario.scenario_id': `={{'${scenario.scenario_id||''}'}}`,
      'scenario.agent_name':  `={{'${scenario.agent_name||''}'}}`,
      'scenario.name':        `={{'${scenario.name||''}'}}`,
      'scenario.triggers':    `={{'${(scenario.triggers||'').replace(/'/g,"\\'")}'}}`,
      'scenario.how_it_works':`={{'${(scenario.how_it_works||'').replace(/'/g,"\\'")}'}}`,
      'scenario.roi_hypothesis':`={{'${(scenario.roi_hypothesis||'').replace(/'/g,"\\'")}'}}`,
      'scenario.risk_notes':  `={{'${(scenario.risk_notes||'').replace(/'/g,"\\'")}'}}`,
      'scenario.tags':        `={{${JSON.stringify(listify(scenario["tags (;)"]||scenario.tags))}}}`,
      'scenario.archetype':   `={{'${archetype}'}}`
    }, LAYOUT.start.x + 2*LAYOUT.stepX, LAYOUT.start.y);
    connect(wf, simTrig, init);

    // TEAM: chain-of-experts (one after another)
    const team = makeTeam(archetype, features);
    const { tail: teamTail } = addTeamChain(wf, team, init, LAYOUT.start.x + 3*LAYOUT.stepX, LAYOUT.start.y);

    // Communication stage (after QA/Summary)
    const commX = LAYOUT.start.x + Math.floor(2.0*LAYOUT.stepX);
    const comm = addSet(wf, 'Communication (Stage)', { '__stage':'={{\"communication\"}}' }, commX, LAYOUT.start.y);
    connect(wf, teamTail, comm);

    // Branch choose (single branch here; keeps your Switch rule)
    const sw = addSwitch(wf,'Branch',"={{$json.__branch || 'Main'}}",
      [{operation:'equal', value2:'Main'}], LAYOUT.switchX, LAYOUT.start.y);
    connect(wf, comm, sw);

    // Channels (Composer already produced bundle; use it)
    const channels = ['whatsapp','call'];
    let lastCollector=null;
    channels.forEach((ch, chIdx)=>{
      const rowY = LAYOUT.start.y - Math.floor(LAYOUT.channelY*(channels.length-1)/2) + chIdx*LAYOUT.channelY;

      const enter = addSet(wf, `[1] Enter · ${picked.name} · ${ch.toUpperCase()}`, { '__branch':"={{'Main'}}", '__channel':`={{'${ch}'}}` }, commX + 2*LAYOUT.stepX, rowY);
      connect(wf, sw, enter, 0);

      // If Composer exists, message comes from its JSON; otherwise fallback body
      const subject = scenario.agent_name ? `${scenario.agent_name} — ${scenario.scenario_id||''}` : (scenario.scenario_id||'Update');
      const msgExpr = ch==='call' ? "={{$json.call?.script || $json.whatsapp?.body || $json.email?.body || 'Hello!'}}"
                                  : ch==='whatsapp' ? "={{$json.whatsapp?.body || $json.email?.body || 'Hello!'}}"
                                  : "={{$json.email?.body || $json.whatsapp?.body || 'Hello!'}}";
      const composeSet = addSet(wf, '[2] Compose (from Composer JSON)', { 'message': msgExpr, 'subject':`={{'${subject}'}}` }, commX + 3*LAYOUT.stepX, rowY);
      connect(wf, enter, composeSet);

      // Optional decision walk from picked (kept minimal here)
      const sender = makeSender(wf, ch, commX + 4*LAYOUT.stepX, rowY);
      connect(wf, composeSet, sender);
      const col = addCollector(wf, commX + 5*LAYOUT.stepX, rowY);
      connect(wf, sender, col);
      lastCollector = col;
    });

    // Error lane
    if (lastCollector){
      const errY = LAYOUT.start.y + LAYOUT.channelY + 420;
      addHeader(wf, 'ERROR AREA', LAYOUT.start.x + 3*LAYOUT.stepX, errY - 90);
      let e = addSet(wf, 'Error Monitor', { '__err':'={{true}}' }, LAYOUT.start.x + 4*LAYOUT.stepX, errY);
      connect(wf, lastCollector, e);
      const retry = addSet(wf, 'Retry Policy', { '__retry':'={{true}}' }, LAYOUT.start.x + 5*LAYOUT.stepX, errY);
      connect(wf, e, retry); e = retry;
      const notify = addHTTP(wf, 'Notify · Ops', `={{'${DEFAULT_HTTP.ops_alert}'}}`, '={{$json}}', LAYOUT.start.x + 6*LAYOUT.stepX, errY);
      connect(wf, e, notify);
    }

    wf.staticData.__design = {
      layout:{ stepX:LAYOUT.stepX, channelY:LAYOUT.channelY, outcomeRowY:LAYOUT.outcomeRowY, grid:GRID, footprint:FOOTPRINT, antiOverlap:'block' },
      notes:'Agents form a strict chain (validator→next agent). Composer emits bundle used by channel senders; Switch kept for visual parity.'
    };
    return wf;
  }

  // Public API
  window.Builder = { buildWorkflowJSON };
})();
