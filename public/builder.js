// public/builder.js
// Compact, fully-linked builder (two channels: WhatsApp + Call)
// - Tight spacing so the graph isn't huge
// - Manual Trigger → Simulated Trigger so you can run locally
// - Communication (Stage) before per-channel fan-out
// - Vertical per-channel rows (whatsapp, call) with explicit chaining
// - Import-safe Switch/If (string value2); no "?" in labels
// Exposes: window.Builder.buildWorkflowJSON(s, industry, { selectedChannel, compat:'safe'|'full' })

(function(){
  "use strict";

  // ---------- Compact layout (pulled-in distances) ----------
  const LAYOUT = {
    stepX: 420,         // (was 640)
    channelY: 300,      // (was 460)
    outcomeRowY: 220,   // (was 340)
    header: { x: -1200, y: 40 }, // bring closer to center
    start:  { x: -1080, y: 260 },
    switchX: -520
  };

  const GUIDE = { numberSteps: true };

  const DEFAULT_HTTP = {
    pms_upcoming: "https://example.com/pms/upcoming",
    ticket_create: "https://example.com/ticket/create",
    calendar_book: "https://example.com/calendar/book",
    step_generic: "https://example.com/step"
  };

  // ---------- Archetype rules (same as before, compact) ----------
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

  const TRIGGER_PREF = {
    APPOINTMENT_SCHEDULING: 'cron', CUSTOMER_SUPPORT_INTAKE: 'webhook', FEEDBACK_NPS: 'cron',
    KNOWLEDGEBASE_FAQ: 'webhook', SALES_OUTREACH: 'manual', LEAD_QUAL_INBOUND: 'webhook',
    CHURN_WINBACK: 'cron', RENEWALS_CSM: 'cron', AR_FOLLOWUP: 'cron', AP_AUTOMATION: 'webhook',
    INVENTORY_MONITOR: 'cron', REPLENISHMENT_PO: 'webhook', FIELD_SERVICE_DISPATCH: 'webhook',
    COMPLIANCE_AUDIT: 'cron', INCIDENT_MGMT: 'webhook', DATA_PIPELINE_ETL: 'cron',
    REPORTING_KPI_DASH: 'cron', ACCESS_GOVERNANCE: 'webhook', PRIVACY_DSR: 'webhook',
    RECRUITING_INTAKE: 'webhook',
  };

  // Only these 2 channels are permitted in the rendered graph
  const TWO_CHANNELS = ['whatsapp', 'call'];

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

  // Force exactly two channels: whatsapp (sms/sms-like) + call
  function normalizeChannels(_s, selected){
    const pick = (v)=>{
      if(!v) return null;
      const t = String(v).toLowerCase();
      if (/whatsapp|sms|text/.test(t)) return 'whatsapp';
      if (/call|voice|phone/.test(t)) return 'call';
      return null;
    };

    const chosen = new Set();
    // honor selected first
    const sel = pick(selected);
    if (sel) chosen.add(sel);

    // always ensure both exist in order whatsapp → call
    if (!chosen.has('whatsapp')) chosen.add('whatsapp');
    if (!chosen.has('call')) chosen.add('call');

    return Array.from(chosen);
  }

  function preferredTrigger(archetype, s){
    const t = String(s.triggers||'').toLowerCase();
    if (/webhook|callback|incoming|real[- ]?time/.test(t)) return 'webhook';
    if (/daily|weekly|cron|every\s+\d+\s*(min|hour|day)/.test(t)) return 'cron';
    if (/imap|inbox|email/.test(t)) return 'imap';
    return TRIGGER_PREF[archetype] || 'manual';
  }
  // ---------- n8n primitives with compact anti-overlap ----------
  function baseWorkflow(name){ return { name, nodes:[], connections:{}, active:false, settings:{}, staticData:{} }; }

  function uniqueName(wf, base){
    const existing=new Set((wf.nodes||[]).map(n=>String(n.name||'').toLowerCase()));
    let name=base||'Node', i=1;
    while(existing.has(name.toLowerCase())){ i++; name = `${base} #${i}`; }
    return name;
  }

  // grid tuned to compact layout
  const GRID = { cellH: 64, cellW: 420 }; // cellW = stepX
  function snapRow(y){ return Math.round(y / GRID.cellH); }

  function nudge(wf,x,y){
    const col = Math.round(x / GRID.cellW);
    const used = new Set((wf.nodes||[]).map(n=>{
      const p=n.position||[]; return `${col}:${snapRow(p[1]||0)}`;
    }));
    let r = snapRow(y);
    for(let k=0;k<160;k++){
      const key = `${col}:${r}`;
      if(!used.has(key)) return r*GRID.cellH;
      r += 1;
    }
    return y + 160; // extreme fallback
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

  // ---------- Node palette ----------
  function addHeader(wf,label,x,y){
    return addNode(wf,{ id:uid('label'), name:`=== ${label} ===`, type:'n8n-nodes-base.function', typeVersion:2,
      position:pos(x,y), parameters:{ functionCode:'return [$json];' }});
  }
  function addManual(wf,x,y,label='Manual Trigger'){
    return addNode(wf,{ id:uid('manual'), name:label, type:'n8n-nodes-base.manualTrigger', typeVersion:1, position:pos(x,y), parameters:{} });
  }
  function addSimTrigger(wf, kind, x, y){
    return addFunction(wf, `Simulated Trigger · ${String(kind||'manual').toUpperCase()}`, 'return [$json];', x, y);
  }
  function addHTTP(wf,name,urlExpr,bodyExpr,x,y,method='POST'){
    return addNode(wf,{ id:uid('http'), name, type:'n8n-nodes-base.httpRequest', typeVersion:4, position:pos(x,y),
      parameters:{ url:urlExpr, method, jsonParameters:true, sendBody:true, bodyParametersJson:bodyExpr } });
  }
  function addFunction(wf,name,code,x,y){
    return addNode(wf,{ id:uid('func'), name, type:'n8n-nodes-base.function', typeVersion:2, position:pos(x,y),
      parameters:{ functionCode:code }});
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

  // Channel senders (Twilio/email placeholders still linkable)
  function makeSender(wf, channel, x, y){
    if(channel==='whatsapp'){
      return addNode(wf,{ id:uid('wa'), name:'Send WhatsApp (Twilio)', type:'n8n-nodes-base.twilio', typeVersion:3, position:pos(x,y),
        parameters:{ resource:'message', operation:'create', from:"={{'whatsapp:' + ($json.waFrom||'+10000000002')}}", to:"={{'whatsapp:' + ($json.to||'+10000000003')}}", message:"={{$json.message||'Hello!'}}" }, credentials:{} });
    }
    if(channel==='call'){
      return addHTTP(wf, 'Place Call', "={{$json.callWebhook||'https://example.com/call'}}",
        "={{ { to:$json.to, from:$json.callFrom, text: ($json.message||'Hello!') } }}", x, y, 'POST');
    }
    // fallback (shouldn't hit)
    return addFunction(wf, `Demo Send ${channel.toUpperCase()}`, "return [$json];", x, y);
  }

  // ---------- Short, channel-aware composer (no '?') ----------
  function composeBody(archetype, channel, s, industry){
    const ctx = {
      trig: String(s.triggers||'').trim(),
      how: String(s.how_it_works||'').trim(),
      roi: String(s.roi_hypothesis||'').trim(),
      risk: String(s.risk_notes||'').trim(),
      tone: (industry?.agent_language_prompt || industry?.vocabulary || '').trim()
    };
    const opener = { whatsapp:'Heads up:', call:'Talk track:' }[channel] || 'Note:';
    const cta = { whatsapp:'Reply to confirm or change.', call:'Say “confirm” or “reschedule”.' }[channel] || 'Reply to proceed.';

    function block(lines, max=5){ return lines.filter(Boolean).slice(0, max).join('\n'); }

    switch(archetype){
      case 'APPOINTMENT_SCHEDULING':
        return block([
          `${opener}`,
          ctx.trig && `Why now: ${ctx.trig}`,
          ctx.how && `Plan: ${ctx.how}`,
          ctx.roi && `Impact: ${ctx.roi}`,
          ctx.tone && ctx.tone,
          cta
        ]);
      case 'CUSTOMER_SUPPORT_INTAKE':
        return block([
          `${opener}`,
          `We received your request and opened a ticket.`,
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
  // ---------- Canonical branches (clean labels) ----------
  function canonicalScheduling(){
    return [{
      name: 'Scheduling',
      steps: [
        { name:'Lookup · Upcoming appointments (PMS/CRM)', kind:'lookup' },
        { name:'Decision · Have upcoming appointment', kind:'decision', outcomes:[
          { value:'yes_upcoming', steps:[
            { name:'Compose · Confirmation', kind:'compose' },
            { name:'Book · Confirm in calendar', kind:'book' },
            { name:'Update · CRM visit → Confirmed', kind:'update' }
          ]},
          { value:'no_or_cannot_attend', steps:[
            { name:'Lookup · Next available slots', kind:'lookup' },
            { name:'Compose · Offer three reschedule options', kind:'compose' },
            { name:'Decision · Client picked a slot', kind:'decision', outcomes:[
              { value:'reschedule_yes', steps:[
                { name:'Book · New slot in calendar', kind:'book' },
                { name:'Update · CRM visit → Rescheduled', kind:'update' }
              ]},
              { value:'reschedule_no', steps:[
                { name:'Store · Add to follow-up list', kind:'store' },
                { name:'Update · CRM visit → Follow-up', kind:'update' }
              ]}
            ]}
          ]}
        ]}
      ]
    }];
  }

  function canonicalGeneric(){
    return [{
      name: 'Main',
      steps: [
        { name:'Score/Route · lightweight', kind:'score' },
        { name:'Compose · Personalized message', kind:'compose' },
        { name:'HTTP · Business logic step', kind:'http' }
      ]
    }];
  }

  // ---------- Core builder (two channels only: whatsapp + call) ----------
  function buildWorkflowJSON(scenario, industry, opts={}){
    const selectedChannel = (opts.selectedChannel||'').toLowerCase().trim();
    const archetype = (scenario?.archetype) ? String(scenario.archetype).toUpperCase() : chooseArchetype(scenario);
    const channels = normalizeChannels(scenario, selectedChannel); // guaranteed ['whatsapp','call'] order
    const intendedTrigger = preferredTrigger(archetype, scenario);

    const title = `${scenario?.scenario_id||'Scenario'} — ${scenario?.name||''}`.trim();
    const wf = baseWorkflow(title);

    // Header + Manual + Simulated Trigger (compact spacing)
    addHeader(wf, 'FLOW AREA · PRODUCTION', LAYOUT.header.x, LAYOUT.header.y);
    const manual = addManual(wf, LAYOUT.start.x, LAYOUT.start.y, 'Manual Trigger');
    const simTrig = addSimTrigger(wf, intendedTrigger, LAYOUT.start.x + Math.floor(LAYOUT.stepX*0.7), LAYOUT.start.y);
    connect(wf, manual, simTrig);

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
      LAYOUT.start.x + 2*LAYOUT.stepX,
      LAYOUT.start.y
    );
    connect(wf, simTrig, init);

    // Optional prefetch (less distance)
    let cursor = init;
    if (archetype==='APPOINTMENT_SCHEDULING') {
      const fetch = addHTTP(wf, 'Fetch · Upcoming (PMS)', `={{'${DEFAULT_HTTP.pms_upcoming}'}}`, '={{$json}}', LAYOUT.start.x + 3*LAYOUT.stepX, LAYOUT.start.y);
      connect(wf, cursor, fetch); cursor = fetch;
    }

    // Branch selector
    const branches = (archetype==='APPOINTMENT_SCHEDULING') ? canonicalScheduling() : canonicalGeneric();
    const sw = addSwitch(
      wf,
      'Branch',
      "={{$json.__branch || 'Main'}}",
      branches.map(b=>({ operation:'equal', value2:String(b.name||'Main').slice(0,64) })),
      LAYOUT.switchX,
      LAYOUT.start.y
    );
    connect(wf, cursor, sw);

    // Communication hub nearer (2.4 * stepX from start)
    const commX = LAYOUT.start.x + Math.floor(2.4*LAYOUT.stepX);
    const branchBaseY = (bIdx, total)=> LAYOUT.start.y - Math.floor(LAYOUT.channelY * (Math.max(total,1)-1)/2) + bIdx*LAYOUT.channelY;

    let lastCollector = null;

    branches.forEach((b, bIdx)=>{
      const comm = addFunction(wf, 'Communication (Stage)', 'return [$json];', commX, branchBaseY(bIdx, branches.length));
      connect(wf, sw, comm, bIdx);

      // Per-branch vertical rows (whatsapp, call)
      const chFirstY = (count)=> branchBaseY(bIdx, branches.length) - Math.floor(LAYOUT.channelY * (count-1)/2);
      let prevRowCollector = null;

      channels.forEach((ch, chIdx)=>{
        const rowY = chFirstY(channels.length) + chIdx*LAYOUT.channelY;

        // Enter row
        const enterName = GUIDE.numberSteps ? `[1] Enter · ${b.name || 'Main'} · ${ch.toUpperCase()}` : `Enter · ${b.name||'Main'} · ${ch.toUpperCase()}`;
        const enter = addFunction(wf, enterName, `return [{...$json,__branch:${JSON.stringify(b.name||'Main')},__channel:${JSON.stringify(ch)}}];`, commX + LAYOUT.stepX, rowY);
        if (chIdx===0) connect(wf, comm, enter);
        if (prevRowCollector) connect(wf, prevRowCollector, enter);

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
          } else if (['http','lookup','update','store','notify','route','score'].includes(kind)){
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
            const kind = String(st.kind||'').toLowerCase();

            if (kind==='decision' && Array.isArray(st.outcomes) && st.outcomes.length){
              const rulz = st.outcomes.map(o=>({ operation:'equal', value2:String(o.value||'path').slice(0,64) }));
              const dsw = addSwitch(wf, `${title} (Decision)`, "={{$json.__decision || 'default'}}", rulz, x, baseY);
              connect(wf, prev, dsw);

              let chain = null;
              st.outcomes.forEach((o, oIdx)=>{
                const oy = baseY - Math.floor((st.outcomes.length-1)/2)*LAYOUT.outcomeRowY + oIdx*LAYOUT.outcomeRowY;
                const oEnter = addFunction(wf, `[${stepIndex}.${oIdx+1}] Outcome · ${o.value||'path'}`, `return [{...$json,__decision:${JSON.stringify(String(o.value||'path'))}}];`, x + Math.floor(LAYOUT.stepX*0.6), oy);
                connect(wf, dsw, oEnter, oIdx);

                let prevO = oEnter;
                (Array.isArray(o.steps)?o.steps:[]).forEach((os, ok)=>{
                  const ox = x + Math.floor(LAYOUT.stepX*0.6) + (ok+1)*Math.floor(LAYOUT.stepX*1.05);
                  const ot = `[${stepIndex}.${oIdx+1}.${ok+1}] ${os.name||'Step'}`;
                  const okind = String(os.kind||'').toLowerCase();
                  let node;
                  if (okind==='compose'){
                    node = addFunction(wf, ot, `
const body=${JSON.stringify(composeBody(archetype, ch, scenario, industry))};
const subject=${JSON.stringify(scenario.agent_name ? `${scenario.agent_name} — ${scenario.scenario_id||''}` : (scenario.scenario_id||'Update'))};
return [{...$json, message: body, subject}];`, ox, oy);
                  } else if (okind==='book'){
                    node = addHTTP(wf, ot, `={{'${DEFAULT_HTTP.calendar_book}'}}`, '={{$json}}', ox, oy);
                  } else if (['http','update','store','notify','route','lookup','score'].includes(okind)){
                    node = addHTTP(wf, ot, `={{'${DEFAULT_HTTP.step_generic}'}}`, '={{$json}}', ox, oy);
                  } else {
                    node = addFunction(wf, ot, 'return [$json];', ox, oy);
                  }
                  connect(wf, prevO, node); prevO = node;
                });

                const sendX = x + Math.floor(LAYOUT.stepX*0.6) + Math.max(2, (o.steps||[]).length+1)*Math.floor(LAYOUT.stepX*1.05);
                const sender = makeSender(wf, ch, sendX, oy);
                try{ wf.nodes[wf.nodes.findIndex(n=>n.name===sender)].name = `[${stepIndex}.${oIdx+1}] Send · ${ch.toUpperCase()}`; }catch{}
                connect(wf, prevO, sender);
                const oCol = addCollector(wf, sendX + Math.floor(LAYOUT.stepX*0.8), oy);
                connect(wf, sender, oCol);

                if (chain) connect(wf, chain, oCol);
                chain = oCol;

                if (oIdx === st.outcomes.length-1){
                  prev = chain;
                }
              });
            } else {
              runStep(title, kind, x, baseY);
            }
          }
        };

        // Walk branch
        walkSteps(Array.isArray(b.steps)?b.steps:[], commX + 2*LAYOUT.stepX, rowY);

        // Add send+collect if last step wasn't a decision
        const lastIsDecision = (Array.isArray(b.steps) && b.steps.some(st=>String(st.kind||'').toLowerCase()==='decision'));
        if (!lastIsDecision){
          const sendX = commX + 2*LAYOUT.stepX + (Math.max(1, (b.steps||[]).length))*LAYOUT.stepX;
          const sendTitle = GUIDE.numberSteps ? `[${++stepIndex}] Send · ${ch.toUpperCase()}` : `Send · ${ch.toUpperCase()}`;
          const sender = makeSender(wf, ch, sendX, rowY);
          try{ wf.nodes[wf.nodes.findIndex(n=>n.name===sender)].name = sendTitle; }catch{}
          connect(wf, prev, sender);
          const col = addCollector(wf, sendX + Math.floor(LAYOUT.stepX*0.9), rowY);
          connect(wf, sender, col);
          if (prevRowCollector) connect(wf, prevRowCollector, col);
          prevRowCollector = col;
        }

        if (bIdx === branches.length-1 && chIdx === channels.length-1) lastCollector = prevRowCollector;
      });
    });

    // Meta
    wf.staticData.__design = {
      archetype, trigger:intendedTrigger, channels, layout:{ stepX:LAYOUT.stepX, channelY:LAYOUT.channelY, outcomeRowY:LAYOUT.outcomeRowY, commHub:true, antiOverlap:'grid' }
    };

    return wf;
  }
  // ---------- Export ----------
  window.Builder = { buildWorkflowJSON };

})();
