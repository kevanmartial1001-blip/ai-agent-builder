// public/builder.js
// Aligned, compact, per-scenario-diverse n8n workflow builder.
// - No "?" icons: prefers Set/HTTP/Wait/Switch nodes for all steps.
// - Deterministic variety per scenario (hash-tuned guards, depth, branches, channels, systems).
// - Strict grid layout with column stacking to avoid any overlap; vertical order preserved.
// Exposes window.Builder.buildWorkflowJSON(scenario, industry, { selectedChannel })

(function () {
  "use strict";

  // ---------- Layout ----------
  const LAYOUT = {
    stepX: 280,        // tighter columns (~2–3cm)
    channelY: 220,     // space between channels
    outcomeRowY: 200,  // space between decision outcomes
    header: { x: -860, y: 40 },
    start:  { x: -820, y: 220 },
    switchX: -520
  };
  const GRID = { cellH: 54 }; // baseline

  const DEFAULT_HTTP = {
    pms_upcoming: "https://example.com/pms/upcoming",
    pms_update:   "https://example.com/pms/update",
    ticket_create:"https://example.com/ticket/create",
    calendar_book:"https://example.com/calendar/book",
    step_generic: "https://example.com/step",
    ops_alert:    "https://example.com/ops/alert",
    pay_link:     "https://example.com/pay",
    dispute:      "https://example.com/ar/dispute",
    kyc:          "https://example.com/kyc",
    inspect:      "https://example.com/inspect"
  };

  // ---------- Rules ----------
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

  // ---------- Utils ----------
  const uid = (p)=>`${p}_${Math.random().toString(36).slice(2,10)}`;
  const pos = (x,y)=>[x,y];
  const listify = (v)=> Array.isArray(v) ? v.map(x=>String(x).trim()).filter(Boolean)
                  : String(v||'').split(/[;,/|\n]+/).map(x=>x.trim()).filter(Boolean);
  const gridY = (y)=> Math.round(y / GRID.cellH) * GRID.cellH;

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

  function normalizeChannels(selected, seedFlip){
    // Two channels only: WhatsApp + Call; order depends on seed
    const a = seedFlip ? ['call','whatsapp'] : ['whatsapp','call'];
    if(String(selected||'').toLowerCase()==='voice') return ['call','whatsapp'];
    if(String(selected||'').toLowerCase()==='whatsapp') return ['whatsapp','call'];
    return a;
  }

  function hash32(s){
    let h=2166136261>>>0;
    for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); }
    return (h>>>0);
  }
  function scenarioSeed(scenario){
    const s = [
      scenario?.scenario_id||'',
      scenario?.name||'',
      String(scenario?.tags||scenario?.["tags (;)"]||'')
    ].join('|');
    const h = hash32(s);
    return {
      idx: h % 3,                 // 0..2 variant
      flip: !!(h & 0x8),          // channel order
      deep: !!(h & 0x20),         // add extra steps
      approvals: !!(h & 0x40),    // add approvals when available
      wait: !!(h & 0x100),        // insert wait nodes occasionally
    };
  }

  function deriveFeatures(s){
    const t = (k)=>String(s[k]||'').toLowerCase();
    const txt = [
      t('triggers'), t('how_it_works'), t('tool_stack_dev'),
      t('roi_hypothesis'), t('risk_notes'), String(s.tags||s['tags (;)']||'').toLowerCase()
    ].join(' | ');
    const f = new Set();
    if(/pms|dentrix|opendental|eaglesoft/.test(txt)) f.add('pms');
    if(/crm|hubspot|salesforce|pipedrive/.test(txt)) f.add('crm');
    if(/ats|greenhouse|lever/.test(txt)) f.add('ats');
    if(/wms|warehouse|3pl/.test(txt)) f.add('wms');
    if(/erp|netsuite|sap|oracle/.test(txt)) f.add('erp');
    if(/kb|knowledge[- ]?base|confluence|notion/.test(txt)) f.add('kb');
    if(/bi|kpi|dashboard|scorecard|report/.test(txt)) f.add('bi');
    if(/calendar|calendly|outlook|google calendar/.test(txt)) f.add('calendar');
    if(/twilio|sms|whatsapp|voice|call/.test(txt)) f.add('twilio');
    if(/approval|sign[- ]?off|review/.test(txt)) f.add('approvals');
    if(/3[- ]?way|three[- ]?way/.test(txt)) f.add('3_way_match');
    if(/dispute|discrepanc|appeal/.test(txt)) f.add('dispute_flow');
    if(/nps|csat|survey|feedback/.test(txt)) f.add('survey');
    if(/incident|sev[ -:]?1|critical/.test(txt)) f.add('incident_high');
    if(/kyc|verify|identity/.test(txt)) f.add('kyc');
    if(/aging|30.?60.?90/.test(txt)) f.add('aging_ladder');
    if(/waitlist|backfill/.test(txt)) f.add('waitlist');
    if(/privacy|dsr|gdpr|ccpa/.test(txt)) f.add('privacy');
    if(/payment|payable|invoice|collections?/.test(txt)) f.add('payment');
    if(/compliance|gdpr|hipaa|pii|privacy|security|risk|audit/.test(txt)) f.add('compliance_guard');
    return f;
  }

  // ---------- Core graph machinery (no overlap) ----------
  function baseWorkflow(name){
    return { name, nodes:[], connections:{}, active:false, settings:{}, staticData:{}, __columns:new Map() };
  }
  function uniqueName(wf, base){
    const existing=new Set((wf.nodes||[]).map(n=>String(n.name||'').toLowerCase()));
    let name=base||'Node', i=1;
    while(existing.has(name.toLowerCase())){ i++; name = `${base} #${i}`; }
    return name;
  }
  function placeOnColumn(wf, x, desiredY){
    const d = gridY(desiredY);
    const last = wf.__columns.has(x) ? wf.__columns.get(x) : -Infinity;
    const y = (last > -Infinity) ? Math.max(d, last + GRID.cellH) : d;
    wf.__columns.set(x, y);
    return y;
  }
  function addNode(wf,node){
    node.name = uniqueName(wf, node.name);
    if(Array.isArray(node.position)){
      const x=node.position[0], y=placeOnColumn(wf,x,node.position[1]);
      node.position=[x,y];
    }
    wf.nodes.push(node); return node.name;
  }
  function connect(wf, from, to, outputIndex=0){
    wf.connections[from]??={};
    wf.connections[from].main??=[];
    for(let i=wf.connections[from].main.length;i<=outputIndex;i++) wf.connections[from].main[i]=[];
    wf.connections[from].main[outputIndex].push({ node: to, type: "main", index: 0 });
  }

  // ---------- Palette (no “?” icons) ----------
  function addHeader(wf,label,x,y){
    // Use Set node for visible label (no ? icon) and pass-through
    return addNode(wf,{
      id:uid('label'),
      name:`=== ${label} ===`,
      type:'n8n-nodes-base.set',
      typeVersion:2,
      position:pos(x,y),
      parameters:{ keepOnlySet:false, values:{ string:[{ name:'__zone', value:`={{'${label}'}}`}] } }
    });
  }
  function addManual(wf,x,y,label='Manual Trigger'){
    return addNode(wf,{ id:uid('manual'), name:label, type:'n8n-nodes-base.manualTrigger', typeVersion:1, position:pos(x,y), parameters:{} });
  }
  function addSimTrigger(wf, kind, x, y){
    return addNode(wf,{
      id:uid('sim'),
      name:`Simulated Trigger · ${String(kind||'manual').toUpperCase()}`,
      type:'n8n-nodes-base.set',
      typeVersion:2,
      position:pos(x,y),
      parameters:{ keepOnlySet:false, values:{ string:[{name:'__trigger', value:`={{'${String(kind||'manual').toUpperCase()}'}}`}] } }
    });
  }
  function addHTTP(wf,name,urlExpr,bodyExpr,x,y,method='POST'){
    return addNode(wf,{ id:uid('http'), name, type:'n8n-nodes-base.httpRequest', typeVersion:4, position:pos(x,y),
      parameters:{ url:urlExpr, method, jsonParameters:true, sendBody:true, bodyParametersJson:bodyExpr } });
  }
  function addSet(wf,name,fields,x,y){
    // fields: { key: exprString }
    const stringVals = Object.entries(fields||{}).map(([k,v])=>({ name:k, value:v }));
    return addNode(wf,{
      id:uid('set'),
      name, type:'n8n-nodes-base.set', typeVersion:2, position:pos(x,y),
      parameters:{ keepOnlySet:false, values:{ string: stringVals } }
    });
  }
  function addSwitch(wf,name,valueExpr,rules,x,y){
    const safe = (rules||[]).map(r=>({ operation:r.operation||'equal', value2:String(r.value2??'') }));
    return addNode(wf,{ id:uid('switch'), name, type:'n8n-nodes-base.switch', typeVersion:2, position:pos(x,y),
      parameters:{ value1:valueExpr, rules:safe }});
  }
  function addWait(wf,name,x,y,seconds=60){
    return addNode(wf,{ id:uid('wait'), name, type:'n8n-nodes-base.wait', typeVersion:1, position:pos(x,y),
      parameters:{ amount: seconds, unit:'seconds', options:{} }});
  }
  function addCollector(wf,x,y){
    // Use HTTP to /inspect instead of Function so icon ≠ "?"
    return addHTTP(wf,'Collector (Inspect)', `={{'${DEFAULT_HTTP.inspect}'}}`, '={{$json}}', x, y);
  }
  function makeSender(wf, channel, x, y){
    if(channel==='whatsapp'){
      return addNode(wf,{ id:uid('wa'), name:'Send WhatsApp (Twilio)', type:'n8n-nodes-base.twilio', typeVersion:3, position:pos(x,y),
        parameters:{ resource:'message', operation:'create', from:"={{'whatsapp:' + ($json.waFrom||'+10000000002')}}", to:"={{'whatsapp:' + ($json.to||'+10000000003')}}", message:"={{$json.message||'Hello!'}}" }, credentials:{} });
    }
    if(channel==='call'){
      return addHTTP(wf,'Place Call', "={{$json.callWebhook||'https://example.com/call'}}",
        "={{ { to:$json.to, from:$json.callFrom, text: ($json.message||'Hello!') } }}", x, y, 'POST');
    }
    return addSet(wf, `Send ${channel.toUpperCase()}`, { sent:`={{true}}` }, x, y);
  }

  // ---------- Messaging (precomputed; Set node will inject) ----------
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
    const lines = (...xs)=> xs.filter(Boolean).slice(0,6).join('\\n');

    switch(archetype){
      case 'APPOINTMENT_SCHEDULING':
        return lines(opener, ctx.trig && `Why now: ${ctx.trig}`, `Plan: ${ctx.how||'Confirm or reschedule.'}`, ctx.roi && `Impact: ${ctx.roi}`, ctx.tone, cta);
      case 'CUSTOMER_SUPPORT_INTAKE':
        return lines(opener, 'We received your request and opened a ticket.', ctx.how && `Next: ${ctx.how}`, ctx.risk && `Note: ${ctx.risk}`, ctx.tone, cta);
      case 'AR_FOLLOWUP':
        return lines(opener, 'Your invoice appears past due.', ctx.trig && `Context: ${ctx.trig}`, ctx.how && `Resolution: ${ctx.how}`, 'Reply “dispute” if you disagree.', cta);
      default:
        return lines(opener, ctx.trig && `Context: ${ctx.trig}`, ctx.how && `Plan: ${ctx.how}`, ctx.roi && `Value: ${ctx.roi}`, ctx.tone, cta);
    }
  }

  // ---------- Archetype templates (3 variants each; hash drives choice) ----------
  function playsScheduling(features, deep, approvals){
    const base = [{
      name:'Scheduling',
      steps:[
        features.has('compliance_guard') ? { name:'Guard · Consent/PII mask', kind:'update' } : null,
        features.has('kyc') ? { name:'KYC · Verify identity', kind:'http' } : null,
        { name:'Lookup · Upcoming appointments (PMS/CRM)', kind:'lookup' },
        { name:'Decision · Have upcoming appointment', kind:'decision', outcomes:[
          { value:'yes_upcoming', steps:[
            { name:'Compose · Confirmation incl. address/reason', kind:'compose' },
            { name:'Book · Confirm in calendar', kind:'book' },
            features.has('crm') ? { name:'CRM · Visit → Confirmed', kind:'update' } : null,
            { name:'Notify · Reminder T-2h', kind:'notify' }
          ].filter(Boolean)},
          { value:'no_or_cannot_attend', steps:[
            { name:'Lookup · Next available slots (3)', kind:'lookup' },
            { name:'Compose · Offer reschedule options', kind:'compose' },
            { name:'Decision · Client picked a slot', kind:'decision', outcomes:[
              { value:'reschedule_yes', steps:[
                { name:'Book · New slot in calendar', kind:'book' },
                features.has('pms') ? { name:'PMS · Update appointment', kind:'update' } : null,
                { name:'Notify · Reminder T-2h', kind:'notify' }
              ].filter(Boolean)},
              { value:'reschedule_no', steps:[ features.has('waitlist') ? { name:'Waitlist · Add', kind:'store' } : { name:'Store · Follow-up list', kind:'store' } ]}
            ]}
          ]}
        ]}
      ].filter(Boolean)
    }];

    const alt = [{
      name:'Scheduling',
      steps:[
        features.has('compliance_guard') ? { name:'Guard · Consent', kind:'update' } : null,
        { name:'Lookup · Next available slots', kind:'lookup' },
        approvals ? { name:'Approval · Staff confirm slot', kind:'update' } : null,
        { name:'Compose · Offer reschedule options', kind:'compose' },
        { name:'Decision · Client picked a slot', kind:'decision', outcomes:[
          { value:'yes', steps:[ { name:'Book · Calendar', kind:'book' }, features.has('crm')?{ name:'CRM · Visit → Rescheduled', kind:'update' }:null ].filter(Boolean)},
          { value:'no', steps:[ { name:'Store · Follow-up', kind:'store' } ]}
        ]}
      ].filter(Boolean)
    }];

    const noshow = [{
      name:'Scheduling',
      steps:[
        { name:'Lookup · Upcoming appointments (PMS/CRM)', kind:'lookup' },
        { name:'Decision · Canceled/No-show', kind:'decision', outcomes:[
          { value:'canceled', steps:[
            features.has('waitlist') ? { name:'Waitlist · Backfill slot', kind:'http' } : { name:'Notify · Ops', kind:'notify' },
            { name:'Lookup · Next available slots', kind:'lookup' },
            { name:'Compose · Offer reschedule options', kind:'compose' }
          ]},
          { value:'active', steps:[ { name:'Compose · Confirmation', kind:'compose' } ]}
        ]}
      ]
    }];

    const plays = [base, alt, noshow];
    const picked = plays.map(p=>deep ? amplify(p) : p);
    return picked;
  }

  function playsSupport(features, deep, approvals){
    const deflect = [{
      name:'Support',
      steps:[
        features.has('compliance_guard') ? { name:'Guard · PII mask & consent', kind:'update' } : null,
        features.has('kb') ? { name:'KB · Semantic search', kind:'lookup' } : null,
        { name:'Decision · KB match', kind:'decision', outcomes:[
          { value:'hit', steps:[ { name:'Compose · Natural answer + link', kind:'compose' } ]},
          { value:'miss', steps:[ { name:'Ticket · Create', kind:'ticket' }, approvals?{ name:'Approval · Route to L2', kind:'update' }:null ].filter(Boolean)}
        ]}
      ].filter(Boolean)
    }];
    const sla = [{
      name:'Support',
      steps:[
        { name:'Ticket · Create', kind:'ticket' },
        { name:'Score · SLA/VIP', kind:'score' },
        { name:'Decision · High SLA', kind:'decision', outcomes:[
          { value:'high', steps:[ { name:'Notify · Pager/Slack', kind:'notify' }, { name:'Compose · Rapid ack', kind:'compose' } ]},
          { value:'normal', steps:[ { name:'Compose · Acknowledgement', kind:'compose' } ]}
        ]}
      ]
    }];
    const vip = [{
      name:'Support',
      steps:[
        { name:'Score · VIP intent', kind:'score' },
        { name:'Decision · VIP', kind:'decision', outcomes:[
          { value:'vip', steps:[ { name:'Notify · On-call', kind:'notify' }, { name:'Ticket · Create', kind:'ticket' } ]},
          { value:'regular', steps:[ features.has('kb') ? { name:'KB · Search', kind:'lookup' } : { name:'Ticket · Create', kind:'ticket' } ]}
        ]}
      ]
    }];
    const plays = [deflect, sla, vip];
    return deep ? plays.map(amplify) : plays;
  }

  function playsAR(features, deep){
    const ladder = [{
      name:'AR Follow-up',
      steps:[
        { name:'Lookup · Aging', kind:'lookup' },
        features.has('payment') ? { name:'HTTP · Generate payment link', kind:'http' } : null,
        { name:'Decision · Bucket 30/60/90', kind:'decision', outcomes:[
          { value:'30', steps:[ { name:'Compose · Friendly reminder', kind:'compose' } ]},
          { value:'60', steps:[ { name:'Compose · Firm reminder', kind:'compose' } ]},
          { value:'90', steps:[
            { name:'Notify · Finance', kind:'notify' },
            features.has('dispute_flow') ? { name:'Decision · Dispute raised', kind:'decision', outcomes:[
              { value:'yes', steps:[ { name:'HTTP · Dispute desk', kind:'http' }, { name:'Update · Case', kind:'update' } ]},
              { value:'no',  steps:[ { name:'Compose · Final notice', kind:'compose' } ]}
            ]} : { name:'Compose · Final notice', kind:'compose' }
          ]}
        ]}
      ].filter(Boolean)
    }];
    const disputeFirst = [{
      name:'AR Follow-up',
      steps:[
        { name:'Decision · Dispute present', kind:'decision', outcomes:[
          { value:'yes', steps:[ { name:'HTTP · Dispute review', kind:'http' }, { name:'Update · Pause dunning', kind:'update' } ]},
          { value:'no', steps:[ { name:'Lookup · Aging', kind:'lookup' }, { name:'Compose · Reminder', kind:'compose' } ]}
        ]}
      ]
    }];
    const risk = [{
      name:'AR Follow-up',
      steps:[
        { name:'Score · Risk', kind:'score' },
        { name:'Decision · High risk', kind:'decision', outcomes:[
          { value:'high', steps:[ { name:'Notify · Collections', kind:'notify' }, features.has('payment')?{name:'HTTP · Payment link', kind:'http'}:null ].filter(Boolean)},
          { value:'low',  steps:[ { name:'Compose · Soft nudge', kind:'compose' } ]}
        ]}
      ]
    }];
    const plays = [ladder, disputeFirst, risk];
    return deep ? plays.map(amplify) : plays;
  }

  function playsRecruiting(features, deep){
    const route = [{
      name:'Recruiting',
      steps:[
        { name:'Parse · Resume', kind:'lookup' },
        { name:'Score · Candidate', kind:'score' },
        { name:'Decision · Route', kind:'decision', outcomes:[
          { value:'ae',  steps:[ { name:'Calendar · Phone screen', kind:'book' }, { name:'ATS · Stage: Phone', kind:'update' } ]},
          { value:'sdr', steps:[ { name:'Calendar · Screening',   kind:'book' }, { name:'ATS · Stage: Screen', kind:'update' } ]}
        ]}
      ]
    }];
    const announce = [{
      name:'Recruiting',
      steps:[
        { name:'Score · Candidate', kind:'score' },
        { name:'Compose · Next steps', kind:'compose' },
        { name:'Calendar · Schedule', kind:'book' },
        { name:'ATS · Update stage', kind:'update' }
      ]
    }];
    const stage = [{
      name:'Recruiting',
      steps:[
        { name:'Decision · Stage', kind:'decision', outcomes:[
          { value:'phone',  steps:[ { name:'Calendar · Phone screen', kind:'book' }, { name:'ATS · Move → Phone',  kind:'update' } ]},
          { value:'onsite', steps:[ { name:'ATS · Move → Onsite',     kind:'update' }, { name:'Compose · Prep',     kind:'compose' } ]}
        ]}
      ]
    }];
    const plays = [route, announce, stage];
    return deep ? plays.map(amplify) : plays;
  }

  function playsGeneric(features, deep){
    const a = [{ name:'Main', steps:[ features.has('enrich')?{name:'HTTP · Enrich',kind:'http'}:{name:'Score · Priority',kind:'score'}, {name:'Compose · Outreach',kind:'compose'}, features.has('bi')?{name:'BI · Push KPI',kind:'update'}:null ].filter(Boolean)}];
    const b = [{ name:'Main', steps:[ features.has('dedupe')?{name:'Store · Deduplicate',kind:'store'}:{name:'Score · Rank',kind:'score'}, {name:'HTTP · Process',kind:'http'}, {name:'Notify · Team',kind:'notify'} ]}];
    const c = [{ name:'Main', steps:[ {name:'Score · Priority',kind:'score'}, {name:'Decision · Priority',kind:'decision', outcomes:[ {value:'high',steps:[{name:'Notify · Team',kind:'notify'},{name:'HTTP · Fast-track',kind:'http'}]}, {value:'normal',steps:[{name:'Compose · Standard',kind:'compose'}]} ]} ]}];
    const plays = [a,b,c];
    return deep ? plays.map(amplify) : plays;
  }

  // Adds one extra step to each branch for "deep" scenarios
  function amplify(branches){
    return (branches||[]).map(b=>{
      const extra = { name:'Store · Audit trail', kind:'store' };
      const dup = JSON.parse(JSON.stringify(b));
      dup.steps = (dup.steps||[]).concat([extra]);
      return dup;
    });
  }

  // ---------- Build ----------
  function buildWorkflowJSON(scenario, industry, opts = {}){
    const seed = scenarioSeed(scenario);
    const archetype = (scenario?.archetype) ? String(scenario.archetype).toUpperCase() : chooseArchetype(scenario);
    const channels = normalizeChannels(opts.selectedChannel, seed.flip);
    const triggerKind = preferredTrigger(archetype, scenario);
    const features = deriveFeatures(scenario);

    // choose plays
    let plays;
    if (archetype==='APPOINTMENT_SCHEDULING') plays = playsScheduling(features, seed.deep, seed.approvals);
    else if (archetype==='CUSTOMER_SUPPORT_INTAKE') plays = playsSupport(features, seed.deep, seed.approvals);
    else if (archetype==='AR_FOLLOWUP') plays = playsAR(features, seed.deep);
    else if (archetype==='RECRUITING_INTAKE') plays = playsRecruiting(features, seed.deep);
    else plays = playsGeneric(features, seed.deep);

    const picked = plays[seed.idx % plays.length]; // one scenario → one variant

    const title = `${scenario?.scenario_id||'Scenario'} — ${scenario?.name||''}`.trim();
    const wf = baseWorkflow(title);

    // Header + Trigger
    addHeader(wf, 'FLOW AREA · PRODUCTION', LAYOUT.header.x, LAYOUT.header.y);
    const manual = addManual(wf, LAYOUT.start.x, LAYOUT.start.y, 'Manual Trigger');
    const simTrig = addSimTrigger(wf, triggerKind, LAYOUT.start.x + Math.floor(LAYOUT.stepX*0.7), LAYOUT.start.y);
    connect(wf, manual, simTrig);

    // Init (Set; no "?")
    const init = addSet(
      wf,
      'Init Context',
      {
        'scenario.scenario_id': `={{'${scenario.scenario_id||''}'}}`,
        'scenario.agent_name':  `={{'${scenario.agent_name||''}'}}`,
        'scenario.name':        `={{'${scenario.name||''}'}}`,
        'scenario.triggers':    `={{'${(scenario.triggers||'').replace(/'/g,"\\'")}'}}`,
        'scenario.how_it_works':`={{'${(scenario.how_it_works||'').replace(/'/g,"\\'")}'}}`,
        'scenario.roi_hypothesis':`={{'${(scenario.roi_hypothesis||'').replace(/'/g,"\\'")}'}}`,
        'scenario.risk_notes':  `={{'${(scenario.risk_notes||'').replace(/'/g,"\\'")}'}}`,
        'scenario.tags':        `={{${JSON.stringify(listify(scenario["tags (;)"]||scenario.tags))}}}`,
        'scenario.archetype':   `={{'${archetype}'}}`
      },
      LAYOUT.start.x + 2*LAYOUT.stepX, LAYOUT.start.y
    );
    connect(wf, simTrig, init);

    // Optional prefetch
    let cursor = init;
    if (archetype==='APPOINTMENT_SCHEDULING' && features.has('pms')){
      const fetch = addHTTP(wf, 'Fetch · Upcoming (PMS)', `={{'${DEFAULT_HTTP.pms_upcoming}'}}`, '={{$json}}', LAYOUT.start.x + 3*LAYOUT.stepX, LAYOUT.start.y);
      connect(wf, cursor, fetch); cursor = fetch;
    }

    // Branch switch
    const sw = addSwitch(
      wf,
      'Branch',
      "={{$json.__branch || 'Main'}}",
      (picked||[{name:'Main'}]).map(b=>({operation:'equal', value2:String(b.name||'Main').slice(0,64)})),
      LAYOUT.switchX,
      LAYOUT.start.y
    );
    connect(wf, cursor, sw);

    // Communication stage
    const commX = LAYOUT.start.x + Math.floor(2.0*LAYOUT.stepX);
    const commStage = (y)=> addSet(wf, 'Communication (Stage)', { '__stage':'={{"communication"}}' }, commX, y);

    const baseY = (i, total)=> LAYOUT.start.y - Math.floor(LAYOUT.channelY * (Math.max(total,1)-1)/2) + i*LAYOUT.channelY;
    let lastCollector=null;

    (Array.isArray(picked)?picked:[picked]).forEach((branch, bIdx)=>{
      const bY = baseY(bIdx, 1); // one visible branch per variant
      const comm = commStage(bY);
      connect(wf, sw, comm, bIdx);

      // pre-systems sprinkle (deterministic)
      let pre = comm;
      const sysList = ['kb','crm','calendar','pms','ats','wms','erp','bi'].filter(s=>features.has(s));
      const sysCount = Math.min(sysList.length, seed.idx===0?1:(seed.idx===1?2:1));
      for(let i=0;i<sysCount;i++){
        const sx = commX + Math.floor(0.6*LAYOUT.stepX) + i*Math.floor(0.6*LAYOUT.stepX);
        const sys = sysList[i];
        const node = ({
          'crm': ()=> addHTTP(wf,'CRM · Upsert/Log', `={{'https://example.com/crm/upsert'}}`, '={{$json}}', sx, bY),
          'pms': ()=> addHTTP(wf,'PMS · Update/Confirm', `={{'${DEFAULT_HTTP.pms_update}'}}`, '={{$json}}', sx, bY),
          'calendar': ()=> addHTTP(wf,'Calendar · Book', `={{'${DEFAULT_HTTP.calendar_book}'}}`, '={{$json}}', sx, bY),
          'kb': ()=> addHTTP(wf,'KB · Search', `={{'https://example.com/kb/search'}}`, '={{$json}}', sx, bY),
          'ats': ()=> addHTTP(wf,'ATS · Update', `={{'https://example.com/ats/update'}}`, '={{$json}}', sx, bY),
          'wms': ()=> addHTTP(wf,'WMS · Levels', `={{'https://example.com/wms/levels'}}`, '={{$json}}', sx, bY),
          'erp': ()=> addHTTP(wf,'ERP · PO/Invoice', `={{'https://example.com/erp/op'}}`, '={{$json}}', sx, bY),
          'bi': ()=> addHTTP(wf,'BI · Push', `={{'https://example.com/bi/push'}}`, '={{$json}}', sx, bY)
        }[sys]||(()=>addSet(wf,`System · ${sys}`,{'__sys':`={{'${sys}'}}`},sx,bY)))();
        connect(wf, pre, node); pre=node;
      }

      const chFirstY = (count)=> bY - Math.floor(LAYOUT.channelY * (count-1)/2);
      let prevRowCollector=null;

      channels.forEach((ch, chIdx)=>{
        const rowY = chFirstY(channels.length) + chIdx*LAYOUT.channelY;

        // Enter row (Set)
        const enter = addSet(
          wf,
          `[1] Enter · ${branch.name||'Main'} · ${ch.toUpperCase()}`,
          { '__branch':`={{'${String(branch.name||'Main')}'}}`, '__channel':`={{'${ch}'}}` },
          commX + LAYOUT.stepX,
          rowY
        );
        if (chIdx===0) connect(wf, pre, enter);
        if (prevRowCollector) connect(wf, prevRowCollector, enter);

        let stepIndex=1;
        let prev=enter;

        const runStep = (st, x, y)=>{
          const kind = String(st.kind||'').toLowerCase();
          const title = `[${++stepIndex}] ${st.name||'Step'}`;

          if (kind==='compose'){
            const body = composeBody(archetype, ch, scenario, industry).replace(/"/g,'\\"');
            const subject = scenario.agent_name ? `${scenario.agent_name} — ${scenario.scenario_id||''}` : (scenario.scenario_id||'Update');
            const node = addSet(wf, title, { 'message':`={{"${body}"}}`, 'subject':`={{'${subject}'}}` }, x, y);
            connect(wf, prev, node); prev=node; return;
          }
          if (kind==='book'){
            const node = addHTTP(wf, title, `={{'${DEFAULT_HTTP.calendar_book}'}}`, '={{$json}}', x, y);
            connect(wf, prev, node); prev=node; return;
          }
          if (kind==='ticket'){
            const node = addHTTP(wf, title, `={{'${DEFAULT_HTTP.ticket_create}'}}`, '={{$json}}', x, y);
            connect(wf, prev, node); prev=node; return;
          }
          if (kind==='http'){
            // specialize when possible
            let url = DEFAULT_HTTP.step_generic;
            if (/kyc/i.test(st.name||'')) url = DEFAULT_HTTP.kyc;
            if (/payment/i.test(st.name||'')) url = DEFAULT_HTTP.pay_link;
            if (/dispute/i.test(st.name||'')) url = DEFAULT_HTTP.dispute;
            const node = addHTTP(wf, title, `={{'${url}'}}`, '={{$json}}', x, y);
            connect(wf, prev, node); prev=node; return;
          }
          if (['lookup','update','store','notify','route','score'].includes(kind)){
            const node = addHTTP(wf, title, `={{'${DEFAULT_HTTP.step_generic}'}}`, '={{$json}}', x, y);
            connect(wf, prev, node); prev=node; return;
          }
          if (kind==='wait'){
            const node = addWait(wf, title, x, y, 90);
            connect(wf, prev, node); prev=node; return;
          }
          // fallback
          const node = addSet(wf, title, { '__note':`={{'pass'}}` }, x, y);
          connect(wf, prev, node); prev=node;
        };

        const walk = (steps, baseX, baseY)=>{
          for (let i=0;i<steps.length;i++){
            const st = steps[i] || {};
            const x = baseX + i*LAYOUT.stepX;
            const kind = String(st.kind||'').toLowerCase();

            if (kind==='decision' && Array.isArray(st.outcomes) && st.outcomes.length){
              const title = `[${++stepIndex}] ${st.name||'Decision'} (Decision)`;
              const rules = st.outcomes.map(o=>({operation:'equal', value2:String(o.value||'path').slice(0,64)}));
              const dsw = addSwitch(wf, title, "={{$json.__decision || 'default'}}", rules, x, baseY);
              connect(wf, prev, dsw);

              let chain=null;
              st.outcomes.forEach((o, oi)=>{
                const oyWanted = baseY - Math.floor((st.outcomes.length-1)/2)*LAYOUT.outcomeRowY + oi*LAYOUT.outcomeRowY;
                const oEnter = addSet(wf, `[${stepIndex}.${oi+1}] Outcome · ${o.value||'path'}`, { '__decision':`={{'${String(o.value||'path')}'}}` }, x + Math.floor(LAYOUT.stepX*0.55), oyWanted);
                connect(wf, dsw, oEnter, oi);

                let prevO = oEnter;
                (Array.isArray(o.steps)?o.steps:[]).forEach((os, ok)=>{
                  const ox = x + Math.floor(LAYOUT.stepX*0.55) + (ok+1)*Math.floor(LAYOUT.stepX*1.0);
                  const oy = oyWanted;
                  runStep({ ...os, name:`${os.name||'Step'}`.replace(/^\[\d+\].\s*/,'') }, ox, oy);
                  prevO = prev; // runStep updates outer 'prev', keep per-outcome local
                });

                // Sender after each outcome
                const sendX = x + Math.floor(LAYOUT.stepX*0.55) + Math.max(2,(o.steps||[]).length+1)*Math.floor(LAYOUT.stepX*1.0);
                const sender = makeSender(wf, ch, sendX, oyWanted);
                try {
                  const idx = wf.nodes.findIndex(n=>n.name===sender);
                  if (idx>=0) wf.nodes[idx].name = `[${stepIndex}.${oi+1}] Send · ${ch.toUpperCase()}`;
                } catch {}
                connect(wf, prev, sender);
                let oCol = addCollector(wf, sendX + Math.floor(LAYOUT.stepX*0.8), oyWanted);
                connect(wf, sender, oCol);

                if (chain) connect(wf, chain, oCol);
                chain = oCol;
                if (oi === st.outcomes.length-1){ prev = chain; }
              });
            } else {
              runStep(st, x, baseY);
              if (seed.wait && i===0) { // tiny delay early in row for realism
                const wait = addWait(wf,'[pause] jitter', x + Math.floor(LAYOUT.stepX*0.5), baseY, 45);
                connect(wf, prev, wait); prev = wait;
              }
            }
          }
        };

        const steps = Array.isArray(branch.steps)?branch.steps:[];
        walk(steps, commX + 2*LAYOUT.stepX, rowY);

        // Final send+collect when last step wasn't a decision
        const lastIsDecision = steps.some(st=>String(st.kind||'').toLowerCase()==='decision');
        if (!lastIsDecision){
          const sendX = commX + 2*LAYOUT.stepX + Math.max(1, steps.length)*LAYOUT.stepX;
          const sender = makeSender(wf, ch, sendX, rowY);
          try{
            const idx = wf.nodes.findIndex(n=>n.name===sender);
            if(idx>=0) wf.nodes[idx].name = `[${++stepIndex}] Send · ${ch.toUpperCase()}`;
          }catch{}
          connect(wf, prev, sender);
          const col = addCollector(wf, sendX + Math.floor(LAYOUT.stepX*0.85), rowY);
          connect(wf, sender, col);
          if (prevRowCollector) connect(wf, prevRowCollector, col);
          prevRowCollector = col;
        }

        if (chIdx===channels.length-1) lastCollector = prevRowCollector;
      });
    });

    // Simple error lane (varies by seed)
    if (lastCollector){
      const errY = LAYOUT.start.y + LAYOUT.channelY + 220;
      addHeader(wf, 'ERROR AREA', LAYOUT.start.x + 3*LAYOUT.stepX, errY - 80);
      let e = addSet(wf, 'Error Monitor', { '__err':'={{true}}' }, LAYOUT.start.x + 4*LAYOUT.stepX, errY);
      connect(wf, lastCollector, e);
      if (seed.idx!==2){
        const retry = addSet(wf, 'Retry Policy', { '__retry':'={{true}}' }, LAYOUT.start.x + 5*LAYOUT.stepX, errY);
        connect(wf, e, retry); e = retry;
      }
      const notify = addHTTP(wf, 'Notify · Ops', `={{'${DEFAULT_HTTP.ops_alert}'}}`, '={{$json}}', LAYOUT.start.x + 6*LAYOUT.stepX, errY);
      connect(wf, e, notify);
    }

    wf.staticData.__design = {
      archetype, trigger: triggerKind, channels,
      features: Array.from(features.values()),
      seed,
      layout:{ stepX:LAYOUT.stepX, channelY:LAYOUT.channelY, outcomeRowY:LAYOUT.outcomeRowY, grid:GRID.cellH, align:'strict-grid', antiOverlap:true },
      notes:'No Function nodes (except none); Set/HTTP/Wait/Switch only → no "?" icons.'
    };
    return wf;
  }

  window.Builder = { buildWorkflowJSON };
})();
