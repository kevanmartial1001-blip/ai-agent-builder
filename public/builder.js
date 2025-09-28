// public/builder.js
// Minimal but expressive builder:
// - One clean lane, left→right chronology
// - "Communication (Stage)" before per-channel fan-out
// - Vertical per-channel rows; each row is fully chained A→Z (no junction nodes)
// - Personalization from scenario/industry fields with short, channel-aware copy
// - Safe client-side (HTTP placeholders), import-safe Switch/If values coerced to strings
// Exposes: window.Builder.buildWorkflowJSON(s, industry, { selectedChannel, forcePresentation, compat:'safe|full' })

(function(){
  "use strict";

  // ---------- Layout (spacious but compact numbers) ----------
  const LAYOUT = {
    stepX: 640,          // horizontal spacing between columns
    channelY: 460,       // spacing between channels (vertical rows)
    outcomeRowY: 340,    // spacing between decision outcomes
    header: { x: -1600, y: 40 },
    start:  { x: -1460, y: 300 },
    switchX: -820
  };

  // ---------- Simple guide ----------
  const GUIDE = { numberSteps: true };

  // ---------- Defaults for placeholder HTTP nodes ----------
  const DEFAULT_HTTP = {
    pms_upcoming: "https://example.com/pms/upcoming",
    ticket_create: "https://example.com/ticket/create",
    calendar_book: "https://example.com/calendar/book",
    step_generic: "https://example.com/step"
  };

  // ---------- Archetype rules (compact) ----------
  const ARCH_RULES = [
    { a:'APPOINTMENT_SCHEDULING', rx:/(appointment|appointments|scheduling|no[-_ ]?show|calendar)/i },
    { a:'CUSTOMER_SUPPORT_INTAKE', rx:/\b(cs|support|helpdesk|ticket|sla|triage|escalation|deflection|kb)\b/i },
    { a:'FEEDBACK_NPS', rx:/\b(nps|survey|surveys|feedback|csat|ces)\b/i },
    { a:'KNOWLEDGEBASE_FAQ', rx:/\b(kb|faq|knowledge|self-?service)\b/i },
    { a:'SALES_OUTREACH', rx:/\b(sales|outreach|cadence|sequence|abm|prospect|cold[-_ ]?email)\b/i },
    { a:'LEAD_QUAL_INBOUND', rx:/\b(inbound|lead[-_ ]?qual|qualification|routing|router|forms?)\b/i },
    { a:'CHURN_WINBACK', rx:/\b(churn|win[-_ ]?back|reactivation|retention|loyalty)\b/i },
    { a:'RENEWALS_CSM', rx:/\b(renewal|qbr|success|csm|upsell|cross-?sell)\b/i },
    { a:'AR_FOLLOWUP', rx:/\b(a\/?r|accounts?\s*receivable|invoice|collections?|dso|reconciliation)\b/i },
    { a:'AP_AUTOMATION', rx:/\b(a\/?p|accounts?\s*payable|invoices?|3[-\s]?way|three[-\s]?way|matching|approvals?)\b/i },
    { a:'INVENTORY_MONITOR', rx:/\b(inventory|stock|sku|threshold|warehouse|3pl|wms|backorder)\b/i },
    { a:'REPLENISHMENT_PO', rx:/\b(replenishment|purchase[-_ ]?order|po|procure|procurement|vendors?|suppliers?)\b/i },
    { a:'FIELD_SERVICE_DISPATCH', rx:/\b(dispatch|work[-_ ]?orders?|technicians?|field|geo|eta|route|yard)\b/i },
    { a:'COMPLIANCE_AUDIT', rx:/\b(compliance|audit|audits|policy|governance|sox|iso|gdpr|hipaa|attestation)\b/i },
    { a:'INCIDENT_MGMT', rx:/\b(incident|sev[: ]?(high|p[12])|major|rca|postmortem|downtime|uptime|slo)\b/i },
    { a:'DATA_PIPELINE_ETL', rx:/\b(etl|pipeline|ingest|transform|load|csv|s3|gcs|orchestration)\b/i },
    { a:'REPORTING_KPI_DASH', rx:/\b(dashboard|dashboards|kpi|scorecard|report|reporting)\b/i },
    { a:'ACCESS_GOVERNANCE', rx:/\b(access|rbac|sso|entitlements|seats|identity|pii|dlp)\b/i },
    { a:'PRIVACY_DSR', rx:/\b(dsr|data\s*subject|privacy\s*request|gdpr|ccpa)\b/i },
    { a:'RECRUITING_INTAKE', rx:/\b(recruit(ing)?|ats|cv|resume|candidate|interviews?)\b/i },
  ];

  // Preferred triggers per archetype (fallback)
  const TRIGGER_PREF = {
    APPOINTMENT_SCHEDULING: 'cron', CUSTOMER_SUPPORT_INTAKE: 'webhook', FEEDBACK_NPS: 'cron',
    KNOWLEDGEBASE_FAQ: 'webhook', SALES_OUTREACH: 'manual', LEAD_QUAL_INBOUND: 'webhook',
    CHURN_WINBACK: 'cron', RENEWALS_CSM: 'cron', AR_FOLLOWUP: 'cron', AP_AUTOMATION: 'webhook',
    INVENTORY_MONITOR: 'cron', REPLENISHMENT_PO: 'webhook', FIELD_SERVICE_DISPATCH: 'webhook',
    COMPLIANCE_AUDIT: 'cron', INCIDENT_MGMT: 'webhook', DATA_PIPELINE_ETL: 'cron',
    REPORTING_KPI_DASH: 'cron', ACCESS_GOVERNANCE: 'webhook', PRIVACY_DSR: 'webhook',
    RECRUITING_INTAKE: 'webhook',
  };

  // Channel normalization
  const CHANNEL_MAP = [
    { k:'whatsapp', rx:/whatsapp/i },
    { k:'sms',      rx:/(sms|text)/i },
    { k:'call',     rx:/(voice|call|phone)/i },
    { k:'email',    rx:/email/i },
  ];

  // ---------- Utils ----------
  const uid = (p)=>`${p}_${Math.random().toString(36).slice(2,10)}`;
  const pos = (x,y)=>[x,y];
  const listify = (v)=> Array.isArray(v) ? v.map(x=>String(x).trim()).filter(Boolean)
                  : String(v||'').split(/[;,/|\n]+/).map(x=>x.trim()).filter(Boolean);

  function chooseArchetype(s){
    const hay = [s.scenario_id, s.name, s.tags, s.triggers, s.how_it_works, s.tool_stack_dev]
      .map(x=>String(x||'')).join(' ');
    for(const r of ARCH_RULES) if(r.rx.test(hay)) return r.a;
    return 'SALES_OUTREACH';
  }

  function normalizeChannels(s, selected){
    const fromShapes = listify(s.best_reply_shapes||[])
      .map(t=>{
        for(const m of CHANNEL_MAP) if(m.rx.test(t)) return m.k;
        return null;
      })
      .filter(Boolean);
    let channels = Array.from(new Set(fromShapes));
    if(!channels.length) channels = ['email'];
    if(selected && channels.includes(selected)) {
      channels = [selected].concat(channels.filter(c=>c!==selected));
    } else if (selected && !channels.includes(selected)) {
      channels = [selected].concat(channels);
    }
    return channels;
  }

  function preferredTrigger(archetype, s){
    const t = String(s.triggers||'').toLowerCase();
    if (/webhook|callback|incoming|real[- ]?time/.test(t)) return 'webhook';
    if (/daily|weekly|cron|every\s+\d+\s*(min|hour|day)/.test(t)) return 'cron';
    if (/imap|inbox|email/.test(t)) return 'imap';
    return TRIGGER_PREF[archetype] || 'manual';
  }
  // ---------- n8n primitives (minimal, import-safe) ----------
  function baseWorkflow(name){ return { name, nodes:[], connections:{}, active:false, settings:{}, staticData:{} }; }

  function uniqueName(wf, base){
    const existing=new Set((wf.nodes||[]).map(n=>String(n.name||'').toLowerCase()));
    let name=base||'Node', i=1;
    while(existing.has(name.toLowerCase())){ i++; name = `${base} #${i}`; }
    return name;
  }

  // small anti-overlap
  function nudge(wf,x,y){
    const EPS=56, STEP=64;
    let yy=y;
    for(let i=0;i<60;i++){
      const hit=(wf.nodes||[]).some(n=>{
        const p=n.position||[]; return Math.abs((p[0]||0)-x)<EPS && Math.abs((p[1]||0)-yy)<EPS;
      });
      if(!hit) return yy;
      yy+=STEP;
    }
    return yy;
  }

  function addNode(wf,node){
    node.name = uniqueName(wf, node.name);
    if(Array.isArray(node.position)){
      node.position=[ node.position[0], nudge(wf, node.position[0], node.position[1]) ];
    }
    wf.nodes.push(node); return node.name;
  }

  function connect(wf, from, to, outputIndex=0){
    wf.connections[from]??={};
    wf.connections[from].main??=[];
    for(let i=wf.connections[from].main.length;i<=outputIndex;i++) wf.connections[from].main[i]=[];
    wf.connections[from].main[outputIndex].push({ node: to, type: "main", index: 0 });
  }

  // ---------- Small node set ----------
  function addHeader(wf,label,x,y){
    return addNode(wf,{ id:uid('label'), name:`=== ${label} ===`, type:'n8n-nodes-base.function', typeVersion:2,
      position:pos(x,y), parameters:{ functionCode:'return [$json];' }});
  }
  function addManual(wf,x,y,label='Manual Trigger'){
    return addNode(wf,{ id:uid('manual'), name:label, type:'n8n-nodes-base.manualTrigger', typeVersion:1, position:pos(x,y), parameters:{} });
  }
  function addCron(wf,label,x,y,compat){
    if(compat==='full') return addNode(wf,{ id:uid('cron'), name:label, type:'n8n-nodes-base.cron', typeVersion:1,
      position:pos(x,y), parameters:{ triggerTimes:{ item:[{ mode:'everyX', everyX:{ hours:0, minutes:15 } }] } }});
    return addNode(wf,{ id:uid('cronph'), name:`${label} (Placeholder)`, type:'n8n-nodes-base.function', typeVersion:2,
      position:pos(x,y), parameters:{ functionCode:'return [$json];' }});
  }
  function addWebhook(wf,label,x,y,compat){
    if(compat==='full') return addNode(wf,{ id:uid('webhook'), name:label, type:'n8n-nodes-base.webhook', typeVersion:1,
      position:pos(x,y), parameters:{ path:uid('hook'), methods:['POST'], responseMode:'onReceived' }});
    return addNode(wf,{ id:uid('webph'), name:`${label} (Placeholder)`, type:'n8n-nodes-base.function', typeVersion:2,
      position:pos(x,y), parameters:{ functionCode:'return [$json];' }});
  }
  function addHTTP(wf,name,urlExpr,bodyExpr,x,y,method='POST'){
    return addNode(wf,{ id:uid('http'), name, type:'n8n-nodes-base.httpRequest', typeVersion:4, position:pos(x,y),
      parameters:{ url:urlExpr, method, jsonParameters:true, sendBody:true, bodyParametersJson:bodyExpr } });
  }
  function addFunction(wf,name,code,x,y){
    return addNode(wf,{ id:uid('func'), name, type:'n8n-nodes-base.function', typeVersion:2, position:pos(x,y),
      parameters:{ functionCode:code }});
  }
  // import-safe IF / SWITCH: force string value2
  function addIf(wf,name,left,op,right,x,y){
    return addNode(wf,{ id:uid('if'), name, type:'n8n-nodes-base.if', typeVersion:2, position:pos(x,y),
      parameters:{ conditions:{ number:[], string:[{ value1:left, operation:op, value2:String(right??'') }] } }});
  }
  function addSwitch(wf,name,valueExpr,rules,x,y){
    const safe = (rules||[]).map(r=>({ operation:r.operation||'equal', value2:String(r.value2??'') }));
    return addNode(wf,{ id:uid('switch'), name, type:'n8n-nodes-base.switch', typeVersion:2, position:pos(x,y),
      parameters:{ value1:valueExpr, rules:safe }});
  }
  function addCollector(wf,x,y){
    return addFunction(wf,"Collector (Inspect)",
      `
const now=new Date().toISOString();
const arr=Array.isArray(items)?items:[{json:$json}];
return arr.map((it,i)=>({json:{...it.json,__collected_at:now,index:i}}));`, x, y);
  }

  // ---------- Channel sender (demo-safe) ----------
  function makeSender(wf, channel, x, y, compat){
    if(compat==='full'){
      if(channel==='email'){
        return addNode(wf,{ id:uid('email'), name:'Send Email', type:'n8n-nodes-base.emailSend', typeVersion:3, position:pos(x,y),
          parameters:{ to:"={{$json.emailTo||'user@example.com'}}", subject:"={{$json.subject||'Update'}}", text:"={{$json.message||'Hello!'}}" }, credentials:{} });
      }
      if(channel==='sms'){
        return addNode(wf,{ id:uid('sms'), name:'Send SMS (Twilio)', type:'n8n-nodes-base.twilio', typeVersion:3, position:pos(x,y),
          parameters:{ resource:'message', operation:'create', from:"={{$json.smsFrom||'+10000000000'}}", to:"={{$json.to||'+10000000001'}}", message:"={{$json.message||'Hello!'}}" }, credentials:{} });
      }
      if(channel==='whatsapp'){
        return addNode(wf,{ id:uid('wa'), name:'Send WhatsApp (Twilio)', type:'n8n-nodes-base.twilio', typeVersion:3, position:pos(x,y),
          parameters:{ resource:'message', operation:'create', from:"={{'whatsapp:' + ($json.waFrom||'+10000000002')}}", to:"={{'whatsapp:' + ($json.to||'+10000000003')}}", message:"={{$json.message||'Hello!'}}" }, credentials:{} });
      }
      if(channel==='call'){
        return addHTTP(wf, 'Place Call', "={{$json.callWebhook||'https://example.com/call'}}",
          "={{ { to:$json.to, from:$json.callFrom, text: ($json.message||'Hello!') } }}", x, y, 'POST');
      }
    }
    return addFunction(wf, `Demo Send ${channel.toUpperCase()}`, "return [$json];", x, y);
  }

  // ---------- Compact, channel-aware composer ----------
  function composeBody(archetype, channel, s, industry){
    const ctx = {
      trig: String(s.triggers||'').trim(),
      how: String(s.how_it_works||'').trim(),
      roi: String(s.roi_hypothesis||'').trim(),
      risk: String(s.risk_notes||'').trim(),
      tone: (industry?.agent_language_prompt || industry?.vocabulary || '').trim()
    };
    const opener = { email:'Hi — quick note:', sms:'Quick update:', whatsapp:'Heads up:', call:'Talk track:' }[channel] || 'Note:';
    const cta = { email:'Reply or click to confirm.', sms:'Reply 1=confirm, 2=change.', whatsapp:'Reply here to confirm/change.', call:'Say “confirm” or “reschedule”.' }[channel] || 'Reply to proceed.';

    function block(lines, max=5){ return lines.filter(Boolean).slice(0, max).join('\n'); }

    switch(archetype){
      case 'APPOINTMENT_SCHEDULING':
        return block([
          `${opener}`,
          ctx.trig && `Why now: ${ctx.trig}`,
          ctx.how && `Plan: ${ctx.how}`,
          ctx.roi && `Impact: ${ctx.roi}`,
          ctx.risk && `Note: ${ctx.risk}`,
          ctx.tone && ctx.tone,
          cta
        ]);
      case 'CUSTOMER_SUPPORT_INTAKE':
        return block([
          `${opener}`,
          `We received your request and opened a ticket.`,
          ctx.trig && `Context: ${ctx.trig}`,
          ctx.how && `Next: ${ctx.how}`,
          ctx.tone && ctx.tone,
          cta
        ]);
      default:
        return block([
          `${opener}`,
          ctx.trig && `Context: ${ctx.trig}`,
          ctx.how && `Plan: ${ctx.how}`,
          ctx.roi && `Value: ${ctx.roi}`,
          ctx.tone && ctx.tone,
          cta
        ]);
    }
  }
  // ---------- Tiny canonical branches ----------
  function canonicalScheduling(channels){
    // Minimal but complete; decisions inline; exhaustive outcomes; fits any channel row
    return [{
      name: 'Scheduling',
      steps: [
        { name:'Lookup: Upcoming Appointments (PMS/CRM)', kind:'lookup' },
        { name:'Decision: Do we have an upcoming appointment?', kind:'decision', outcomes:[
          { value:'yes_upcoming', steps:[
            { name:'Compose: Confirmation', kind:'compose' },
            { name:'Book: Confirm in Calendar', kind:'book' },
            { name:'Update: CRM visit → Confirmed', kind:'update' }
          ]},
          { value:'no_or_cannot_attend', steps:[
            { name:'Lookup: Next available time slots', kind:'lookup' },
            { name:'Compose: Offer 3 reschedule options', kind:'compose' },
            { name:'Decision: Client picked a slot?', kind:'decision', outcomes:[
              { value:'reschedule_yes', steps:[
                { name:'Book: New slot in Calendar', kind:'book' },
                { name:'Update: CRM visit → Rescheduled', kind:'update' }
              ]},
              { value:'reschedule_no', steps:[
                { name:'Store: Add to follow-up list', kind:'store' },
                { name:'Update: CRM visit → Follow-up', kind:'update' }
              ]}
            ]}
          ]}
        ]}
      ]
    }];
  }

  function canonicalGeneric(archetype){
    // Slim generic staircase used for most archetypes
    return [{
      name: 'Main',
      steps: [
        { name:'Score/Route (light)', kind:'score' },
        { name:'Compose: Personalized message', kind:'compose' },
        { name:'Lookup/HTTP (optional)', kind:'http' }
      ]
    }];
  }

  // ---------- Core builder (single lane) ----------
  function buildWorkflowJSON(scenario, industry, opts={}){
    const compat = (opts.compat||'safe').toLowerCase()==='full'?'full':'safe';
    const selectedChannel = (opts.selectedChannel||'').toLowerCase().trim();
    const archetype = (scenario?.archetype) ? String(scenario.archetype).toUpperCase() : chooseArchetype(scenario);
    const channels = normalizeChannels(scenario, selectedChannel);
    const trigger = preferredTrigger(archetype, scenario);

    const title = `${scenario?.scenario_id||'Scenario'} — ${scenario?.name||''}`.trim();
    const wf = baseWorkflow(title);

    // Header + Trigger
    addHeader(wf, 'FLOW AREA · PRODUCTION', LAYOUT.header.x, LAYOUT.header.y);
    let trig;
    if (trigger==='cron') trig = addCron(wf, 'Cron Trigger', LAYOUT.start.x, LAYOUT.start.y-160, compat);
    else if (trigger==='webhook') trig = addWebhook(wf, 'Webhook Trigger', LAYOUT.start.x, LAYOUT.start.y, compat);
    else if (trigger==='imap') trig = addFunction(wf, 'IMAP Intake (Placeholder)', 'return [$json];', LAYOUT.start.x, LAYOUT.start.y);
    else trig = addManual(wf, LAYOUT.start.x, LAYOUT.start.y, 'Manual Trigger');

    // Init context
    const init = addFunction(
      wf,
      'Init Context',
      `
const scenario=${JSON.stringify({
  scenario_id: scenario.scenario_id||'',
  agent_name: scenario.agent_name||'',
  name: scenario.name||'',
  triggers: scenario.triggers||'',
  best_reply_shapes: listify(scenario.best_reply_shapes),
  how_it_works: scenario.how_it_works||'',
  roi_hypothesis: scenario.roi_hypothesis||'',
  risk_notes: scenario.risk_notes||'',
  tags: listify(scenario["tags (;)"]||scenario.tags),
  archetype
})};
return [{...$json, scenario}];`,
      LAYOUT.start.x + LAYOUT.stepX,
      LAYOUT.start.y
    );
    connect(wf, trig, init);

    // Optional prefetch (tiny heuristic)
    let cursor = init;
    if (archetype==='APPOINTMENT_SCHEDULING') {
      const fetch = addHTTP(wf, 'Fetch Upcoming (PMS)', `={{'${DEFAULT_HTTP.pms_upcoming}'}}`, '={{$json}}', LAYOUT.start.x + 2*LAYOUT.stepX, LAYOUT.start.y);
      connect(wf, cursor, fetch); cursor = fetch;
    }

    // Branch selector (always present, even with 1 branch) — import-safe Switch
    const branches = (archetype==='APPOINTMENT_SCHEDULING') ? canonicalScheduling(channels) : canonicalGeneric(archetype);
    const sw = addSwitch(
      wf,
      'Branch',
      "={{$json.__branch || 'Main'}}",
      branches.map(b=>({ operation:'equal', value2:String(b.name||'Main').slice(0,64) })),
      LAYOUT.switchX,
      LAYOUT.start.y
    );
    connect(wf, cursor, sw);

    // Communication (Stage) before channels
    const commX = LAYOUT.start.x + Math.floor(3.5*LAYOUT.stepX);
    const branchBaseY = (bIdx, total)=> LAYOUT.start.y - Math.floor(LAYOUT.channelY * (Math.max(total,1)-1)/2) + bIdx*LAYOUT.channelY;

    let lastCollector = null;

    branches.forEach((b, bIdx)=>{
      const comm = addFunction(wf, 'Communication (Stage)', 'return [$json];', commX, branchBaseY(bIdx, branches.length));
      connect(wf, sw, comm, bIdx);

      // Vertical per-channel rows for this branch
      const chFirstY = (count)=> branchBaseY(bIdx, branches.length) - Math.floor(LAYOUT.channelY * (count-1)/2);

      let prevRowCollector = null;
      channels.forEach((ch, chIdx)=>{
        const rowY = chFirstY(channels.length) + chIdx*LAYOUT.channelY;

        // Enter row
        const enterName = GUIDE.numberSteps ? `[${1}] Enter · ${b.name || 'Main'} · ${ch.toUpperCase()}` : `Enter · ${b.name||'Main'} · ${ch.toUpperCase()}`;
        const enter = addFunction(wf, enterName, `return [{...$json,__branch:${JSON.stringify(b.name||'Main')},__channel:${JSON.stringify(ch)}}];`, commX + LAYOUT.stepX, rowY);
        if (chIdx===0) connect(wf, comm, enter);
        if (prevRowCollector) connect(wf, prevRowCollector, enter);

        // Walk steps for this branch on this channel
        let stepIndex = 1;
        let prev = enter;

        const runStep = (title, kind, x, y)=>{
          let node;
          if (kind==='compose'){
            node = addFunction(wf, title, `
const body=${JSON.stringify(composeBody(archetype, ch, scenario, industry))};
const subject=${JSON.stringify(scenario.agent_name ? `${scenario.agent_name} — ${scenario.scenario_id||''}` : (scenario.scenario_id||'Update'))};
return [{...$json, message: body, subject}];`, x, y);
          } else if (kind==='book'){
            node = addHTTP(wf, title, `={{'${DEFAULT_HTTP.calendar_book}'}}`, '={{$json}}', x, y);
          } else if (kind==='http' || kind==='lookup' || kind==='update' || kind==='store' || kind==='notify' || kind==='route' || kind==='score'){
            node = addHTTP(wf, title, `={{'${DEFAULT_HTTP.step_generic}'}}`, '={{$json}}', x, y);
          } else {
            node = addFunction(wf, title, 'return [$json];', x, y);
          }
          connect(wf, prev, node); prev = node;
        };

        const walkSteps = (steps, baseX, baseY)=>{
          for (let i=0; i<steps.length; i++){
            const st = steps[i];
            const title = GUIDE.numberSteps ? `[${++stepIndex}] ${st.name||'Step'}` : (st.name||'Step');
            const x = baseX + i*LAYOUT.stepX;

            if (String(st.kind||'').toLowerCase()==='decision' && Array.isArray(st.outcomes) && st.outcomes.length){
              const rulz = st.outcomes.map(o=>({ operation:'equal', value2:String(o.value||'path').slice(0,64) }));
              const dsw = addSwitch(wf, `${title} (Decision)`, "={{$json.__decision || 'default'}}", rulz, x, baseY);
              connect(wf, prev, dsw);

              let chain = null;
              st.outcomes.forEach((o, oIdx)=>{
                const oy = baseY - Math.floor((st.outcomes.length-1)/2)*LAYOUT.outcomeRowY + oIdx*LAYOUT.outcomeRowY;
                const oEnter = addFunction(wf, `[${stepIndex}.${oIdx+1}] Outcome: ${o.value||'path'}`, `return [{...$json,__decision:${JSON.stringify(String(o.value||'path'))}}];`, x + Math.floor(LAYOUT.stepX*0.6), oy);
                connect(wf, dsw, oEnter, oIdx);

                let prevO = oEnter;
                (Array.isArray(o.steps)?o.steps:[]).forEach((os, ok)=>{
                  const ox = x + Math.floor(LAYOUT.stepX*0.6) + (ok+1)*Math.floor(LAYOUT.stepX*1.05);
                  const ot = `[${stepIndex}.${oIdx+1}.${ok+1}] ${os.name||'Step'}`;
                  let node;
                  if (String(os.kind||'').toLowerCase()==='compose'){
                    node = addFunction(wf, ot, `
const body=${JSON.stringify(composeBody(archetype, ch, scenario, industry))};
const subject=${JSON.stringify(scenario.agent_name ? `${scenario.agent_name} — ${scenario.scenario_id||''}` : (scenario.scenario_id||'Update'))};
return [{...$json, message: body, subject}];`, ox, oy);
                  } else if (['book'].includes(String(os.kind||'').toLowerCase())){
                    node = addHTTP(wf, ot, `={{'${DEFAULT_HTTP.calendar_book}'}}`, '={{$json}}', ox, oy);
                  } else if (['http','update','store','notify','route','lookup','score'].includes(String(os.kind||'').toLowerCase())){
                    node = addHTTP(wf, ot, `={{'${DEFAULT_HTTP.step_generic}'}}`, '={{$json}}', ox, oy);
                  } else {
                    node = addFunction(wf, ot, 'return [$json];', ox, oy);
                  }
                  connect(wf, prevO, node); prevO = node;
                });

                const sendX = x + Math.floor(LAYOUT.stepX*0.6) + Math.max(2, (o.steps||[]).length+1)*Math.floor(LAYOUT.stepX*1.05);
                const sender = makeSender(wf, ch, sendX, oy, compat);
                try{ wf.nodes[wf.nodes.findIndex(n=>n.name===sender)].name = `[${stepIndex}.${oIdx+1}] Send: ${ch.toUpperCase()}`; }catch{}
                connect(wf, prevO, sender);
                const oCol = addCollector(wf, sendX + Math.floor(LAYOUT.stepX*0.9), oy);
                connect(wf, sender, oCol);

                if (chain) connect(wf, chain, oCol);
                chain = oCol;

                if (oIdx === st.outcomes.length-1){
                  prev = chain;
                }
              });
            } else {
              runStep(title, String(st.kind||'').toLowerCase(), x, baseY);
            }
          }
        };

        // Walk this branch steps
        walkSteps(Array.isArray(b.steps)?b.steps:[], commX + 2*LAYOUT.stepX, rowY);

        // If last wasn’t a decision, add send+collect here
        const lastIsDecision = (Array.isArray(b.steps) && b.steps.some(st=>String(st.kind||'').toLowerCase()==='decision'));
        if (!lastIsDecision){
          const sendX = commX + 2*LAYOUT.stepX + (Math.max(1, (b.steps||[]).length))*LAYOUT.stepX;
          const sendTitle = GUIDE.numberSteps ? `[${++stepIndex}] Send: ${ch.toUpperCase()}` : `Send: ${ch.toUpperCase()}`;
          const sender = makeSender(wf, ch, sendX, rowY, compat);
          try{ wf.nodes[wf.nodes.findIndex(n=>n.name===sender)].name = sendTitle; }catch{}
          connect(wf, prev, sender);
          const col = addCollector(wf, sendX + LAYOUT.stepX, rowY);
          connect(wf, sender, col);
          if (prevRowCollector) connect(wf, prevRowCollector, col);
          prevRowCollector = col;
        }

        // update lastCollector if this is the tail-most row
        if (bIdx === branches.length-1 && chIdx === channels.length-1) lastCollector = prevRowCollector;
      });
    });

    // Static metadata
    wf.staticData.__design = {
      archetype, trigger, channels,
      layout: { verticalChannels:true, commHub:true, stepX:LAYOUT.stepX, channelY:LAYOUT.channelY }
    };

    return wf;
  }
  // ---------- Export ----------
  window.Builder = { buildWorkflowJSON };

})();
