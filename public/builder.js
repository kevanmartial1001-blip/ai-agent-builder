// public/builder.js
// Compact, aligned builder with per-scenario variety and strict, no-overlap placement.
// - Column-aware placement: preserves vertical order and enforces spacing; no superposition.
// - Two channels (WhatsApp + Call) rendered in aligned rows.
// - Deeper, context-aware steps per archetype (guards, KYC, approvals, dispute, etc.).
// - Deterministic variety per scenario (variant hashing).
// Exposes: window.Builder.buildWorkflowJSON(scenario, industry, { selectedChannel })

(function () {
  "use strict";

  // ---------- Layout (aligned, compact) ----------
  const LAYOUT = {
    stepX: 340,        // ~2–3 cm between columns on typical screens
    channelY: 260,     // space between channel rows
    outcomeRowY: 220,  // space between decision outcomes
    header: { x: -940, y: 40 },
    start:  { x: -860, y: 240 },
    switchX: -520
  };
  const GRID = { cellH: 56 }; // vertical grid step (baseline)

  const GUIDE = { numberSteps: true };

  const DEFAULT_HTTP = {
    pms_upcoming: "https://example.com/pms/upcoming",
    ticket_create: "https://example.com/ticket/create",
    calendar_book: "https://example.com/calendar/book",
    step_generic: "https://example.com/step",
    ops_alert: "https://example.com/ops/alert",
    pay_link: "https://example.com/pay",
    dispute: "https://example.com/ar/dispute",
    kyc: "https://example.com/kyc",
  };

  // ---------- Archetype rules ----------
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

  function normalizeChannels(_scenario, selected){
    const sel = String(selected||'').toLowerCase();
    const first = sel==='voice' ? 'call' : (sel==='whatsapp' ? 'whatsapp' : 'whatsapp');
    return first==='whatsapp' ? ['whatsapp','call'] : ['call','whatsapp'];
  }

  function preferredTrigger(archetype, s){
    const t = String(s.triggers||'').toLowerCase();
    if (/webhook|callback|incoming|real[- ]?time/.test(t)) return 'webhook';
    if (/daily|weekly|cron|every\s+\d+\s*(min|hour|day)/.test(t)) return 'cron';
    if (/imap|inbox|email/.test(t)) return 'imap';
    return TRIGGER_PREF[archetype] || 'manual';
  }

  // Deterministic scenario variant
  function hash32(s){
    let h=2166136261>>>0;
    for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); }
    return (h>>>0);
  }
  function pickVariant(scenario, max=3){
    const s = [
      scenario?.scenario_id||'',
      scenario?.name||'',
      String(scenario?.tags||scenario?.["tags (;)"]||'')
    ].join('|');
    return hash32(s) % Math.max(1,max); // 0..max-1
  }

  // Extract scenario features from context columns
  function deriveFeatures(s){
    const t = (k)=>String(s[k]||'').toLowerCase();
    const txt = [
      t('triggers'), t('how_it_works'), t('tool_stack_dev'),
      t('roi_hypothesis'), t('risk_notes'), String(s.tags||s['tags (;)']||'').toLowerCase()
    ].join(' | ');

    const f = new Set();
    // systems
    if(/pms|dentrix|opendental|eaglesoft/.test(txt)) f.add('pms');
    if(/crm|hubspot|salesforce|pipedrive/.test(txt)) f.add('crm');
    if(/ats|greenhouse|lever/.test(txt)) f.add('ats');
    if(/wms|warehouse|3pl/.test(txt)) f.add('wms');
    if(/erp|netsuite|sap|oracle/.test(txt)) f.add('erp');
    if(/kb|knowledge[- ]?base|confluence|notion/.test(txt)) f.add('kb');
    if(/bi|kpi|dashboard|scorecard|report/.test(txt)) f.add('bi');
    if(/calendar|calendly|outlook|google calendar/.test(txt)) f.add('calendar');
    if(/twilio|sms|whatsapp|voice|call/.test(txt)) f.add('twilio');

    // patterns
    if(/dedup|dedupe/.test(txt)) f.add('dedupe');
    if(/enrich|clearbit|apollo|zoominfo/.test(txt)) f.add('enrich');
    if(/approval|sign[- ]?off|legal review|finance review/.test(txt)) f.add('approvals');
    if(/3[- ]?way|three[- ]?way/.test(txt)) f.add('3_way_match');
    if(/dispute|discrepanc|appeal/.test(txt)) f.add('dispute_flow');
    if(/nps|csat|survey|feedback/.test(txt)) f.add('survey');
    if(/incident|sev[ -:]?1|critical/.test(txt)) f.add('incident_high');
    if(/kyc|verify|identity/.test(txt)) f.add('kyc');
    if(/aging|30.?60.?90/.test(txt)) f.add('aging_ladder');
    if(/waitlist|backfill/.test(txt)) f.add('waitlist');
    if(/geo|dispatch|route|eta/.test(txt)) f.add('dispatch');
    if(/privacy|dsr|gdpr|ccpa/.test(txt)) f.add('privacy');
    if(/payment|payable|invoice|collections?/.test(txt)) f.add('payment');

    // risk-based
    if(/compliance|gdpr|hipaa|pii|privacy|security|risk|audit/.test(txt)) f.add('compliance_guard');

    return f; // Set of strings
  }

  // ---------- Workflow primitives with strict column ordering ----------
  function baseWorkflow(name){
    return {
      name, nodes:[], connections:{}, active:false, settings:{}, staticData:{},
      __columns: new Map() // x => lastPlacedY
    };
  }

  function uniqueName(wf, base){
    const existing=new Set((wf.nodes||[]).map(n=>String(n.name||'').toLowerCase()));
    let name=base||'Node', i=1;
    while(existing.has(name.toLowerCase())){ i++; name = `${base} #${i}`; }
    return name;
  }

  // Always place at y >= desiredY AND strictly below the last node in this column
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
      const x = node.position[0];
      const y = placeOnColumn(wf, x, node.position[1]);
      node.position=[ x, y ];
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

  // Channel senders (concrete, linkable)
  function makeSender(wf, channel, x, y){
    if(channel==='whatsapp'){
      return addNode(wf,{ id:uid('wa'), name:'Send WhatsApp (Twilio)', type:'n8n-nodes-base.twilio', typeVersion:3, position:pos(x,y),
        parameters:{ resource:'message', operation:'create', from:"={{'whatsapp:' + ($json.waFrom||'+10000000002')}}", to:"={{'whatsapp:' + ($json.to||'+10000000003')}}", message:"={{$json.message||'Hello!'}}" }, credentials:{} });
    }
    if(channel==='call'){
      return addHTTP(wf, 'Place Call', "={{$json.callWebhook||'https://example.com/call'}}",
        "={{ { to:$json.to, from:$json.callFrom, text: ($json.message||'Hello!') } }}", x, y, 'POST');
    }
    return addFunction(wf, `Send ${channel.toUpperCase()}`, "return [$json];", x, y);
  }

  // System adapters (all connectable)
  function injectSystem(wf, sys, x, y){
    switch(sys){
      case 'crm':     return addHTTP(wf, 'CRM · Upsert/Log', "={{'https://example.com/crm/upsert'}}", '={{$json}}', x, y);
      case 'pms':     return addHTTP(wf, 'PMS · Update/Confirm', "={{'https://example.com/pms/update'}}", '={{$json}}', x, y);
      case 'ats':     return addHTTP(wf, 'ATS · Update Stage', "={{'https://example.com/ats/update'}}", '={{$json}}', x, y);
      case 'kb':      return addHTTP(wf, 'KB · Search', "={{'https://example.com/kb/search'}}", '={{$json}}', x, y);
      case 'wms':     return addHTTP(wf, 'WMS · Levels/Reservation', "={{'https://example.com/wms/levels'}}", '={{$json}}', x, y);
      case 'erp':     return addHTTP(wf, 'ERP · PO/Invoice', "={{'https://example.com/erp/op'}}", '={{$json}}', x, y);
      case 'bi':      return addHTTP(wf, 'BI · Push Metrics', "={{'https://example.com/bi/push'}}", '={{$json}}', x, y);
      case 'calendar':return addHTTP(wf, 'Calendar · Book', "={{'https://example.com/calendar/book'}}", '={{$json}}', x, y);
      default:        return addFunction(wf, `System · ${sys}`, 'return [$json];', x, y);
    }
  }

  // Channel-aware composer (short, natural)
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
    const block = (lines, max=6)=> lines.filter(Boolean).slice(0,max).join('\n');

    switch(archetype){
      case 'APPOINTMENT_SCHEDULING':
        return block([ `${opener}`, ctx.trig && `Why now: ${ctx.trig}`, `Plan: ${ctx.how||'Confirm or reschedule.'}`, ctx.roi && `Impact: ${ctx.roi}`, ctx.tone, cta ]);
      case 'CUSTOMER_SUPPORT_INTAKE':
        return block([ `${opener}`, `We received your request and opened a ticket.`, ctx.how && `Next: ${ctx.how}`, ctx.risk && `Note: ${ctx.risk}`, ctx.tone, cta ]);
      case 'AR_FOLLOWUP':
        return block([ `${opener}`, `Your invoice appears past due.`, ctx.trig && `Context: ${ctx.trig}`, ctx.how && `Resolution: ${ctx.how}`, `Reply “dispute” if you disagree.`, cta ]);
      default:
        return block([ `${opener}`, ctx.trig && `Context: ${ctx.trig}`, ctx.how && `Plan: ${ctx.how}`, ctx.roi && `Value: ${ctx.roi}`, ctx.tone, cta ]);
    }
  }

  // ---------- Archetype branch factories (deeper plays) ----------
  function branchesForScheduling(features, variant){
    const guards = [];
    if (features.has('compliance_guard')) guards.push({ name:'Guard · Consent/PII mask', kind:'update' });
    if (features.has('kyc')) guards.push({ name:'KYC · Verify identity', kind:'http' });

    const plays = [
      [{
        name:'Scheduling',
        steps:[
          ...guards,
          { name:'Lookup · Upcoming appointments (PMS/CRM)', kind:'lookup' },
          { name:'Decision · Have upcoming appointment', kind:'decision', outcomes:[
            { value:'yes_upcoming', steps:[
              { name:'Compose · Confirmation incl. address/reason', kind:'compose' },
              { name:'Book · Confirm in calendar', kind:'book' },
              ...(features.has('crm') ? [{ name:'CRM · Visit → Confirmed', kind:'update' }] : []),
              { name:'Notify · Reminder T-2h', kind:'notify' }
            ]},
            { value:'no_or_cannot_attend', steps:[
              { name:'Lookup · Next available slots (3)', kind:'lookup' },
              { name:'Compose · Offer reschedule options', kind:'compose' },
              { name:'Decision · Client picked a slot', kind:'decision', outcomes:[
                { value:'reschedule_yes', steps:[
                  { name:'Book · New slot in calendar', kind:'book' },
                  ...(features.has('pms') ? [{ name:'PMS · Update appointment', kind:'update' }] : []),
                  { name:'Notify · Reminder T-2h', kind:'notify' }
                ]},
                { value:'reschedule_no', steps:[
                  ...(features.has('waitlist') ? [{ name:'Waitlist · Add', kind:'store' }] : [{ name:'Store · Follow-up list', kind:'store' }])
                ]}
              ]}
            ]}
          ]}
        ]
      }],
      [{
        name:'Scheduling',
        steps:[
          ...guards,
          { name:'Lookup · Next available slots', kind:'lookup' },
          { name:'Compose · Offer reschedule options', kind:'compose' },
          ...(features.has('approvals') ? [{ name:'Approval · Staff confirm slot', kind:'update' }] : []),
          { name:'Decision · Client picked a slot', kind:'decision', outcomes:[
            { value:'yes', steps:[
              { name:'Book · Calendar', kind:'book' },
              ...(features.has('crm') ? [{ name:'CRM · Visit → Rescheduled', kind:'update' }] : [])
            ]},
            { value:'no', steps:[ { name:'Store · Follow-up', kind:'store' } ]}
          ]}
        ]
      }],
      [{
        name:'Scheduling',
        steps:[
          ...guards,
          { name:'Lookup · Upcoming appointments (PMS/CRM)', kind:'lookup' },
          { name:'Decision · Canceled/No-show', kind:'decision', outcomes:[
            { value:'canceled', steps:[
              ...(features.has('waitlist') ? [{ name:'Waitlist · Backfill slot', kind:'http' }] : [{ name:'Notify · Ops', kind:'notify' }]),
              { name:'Lookup · Next available slots', kind:'lookup' },
              { name:'Compose · Offer reschedule options', kind:'compose' }
            ]},
            { value:'active', steps:[ { name:'Compose · Confirmation', kind:'compose' } ]}
          ]}
        ]
      }]
    ];
    return plays[variant % plays.length];
  }

  function branchesForSupport(features, variant){
    const guards = [];
    if (features.has('compliance_guard')) guards.push({ name:'Guard · PII mask & consent', kind:'update' });

    const plays = [
      [{
        name:'Support',
        steps:[
          ...guards,
          ...(features.has('kb') ? [{ name:'KB · Semantic search', kind:'lookup' }] : []),
          { name:'Decision · KB match', kind:'decision', outcomes:[
            { value:'hit', steps:[ { name:'Compose · Natural answer + link', kind:'compose' } ]},
            { value:'miss', steps:[
              { name:'Ticket · Create', kind:'ticket' },
              ...(features.has('approvals') ? [{ name:'Approval · Route to L2', kind:'update' }] : []),
              ...(features.has('bi') ? [{ name:'BI · Deflection metric', kind:'update' }] : [])
            ]}
          ]}
        ]
      }],
      [{
        name:'Support',
        steps:[
          ...guards,
          { name:'Ticket · Create', kind:'ticket' },
          { name:'Score · SLA/VIP', kind:'score' },
          { name:'Decision · High SLA', kind:'decision', outcomes:[
            { value:'high', steps:[ { name:'Notify · Pager/Slack', kind:'notify' }, { name:'Compose · Rapid ack', kind:'compose' } ]},
            { value:'normal', steps:[ { name:'Compose · Acknowledgement', kind:'compose' } ]}
          ]}
        ]
      }],
      [{
        name:'Support',
        steps:[
          ...guards,
          { name:'Score · VIP intent', kind:'score' },
          { name:'Decision · VIP', kind:'decision', outcomes:[
            { value:'vip', steps:[ { name:'Notify · On-call', kind:'notify' }, { name:'Ticket · Create', kind:'ticket' } ]},
            { value:'regular', steps:[ ...(features.has('kb') ? [{ name:'KB · Search', kind:'lookup' }] : []), { name:'Ticket · Create', kind:'ticket' } ]}
          ]}
        ]
      }]
    ];
    return plays[variant % plays.length];
  }

  function branchesForAR(features, variant){
    const guards = [];
    if (features.has('compliance_guard')) guards.push({ name:'Guard · Dunning policy check', kind:'update' });

    const plays = [
      [{
        name:'AR Follow-up',
        steps:[
          ...guards,
          { name:'Lookup · Aging', kind:'lookup' },
          ...(features.has('payment') ? [{ name:'HTTP · Generate payment link', kind:'http' }] : []),
          { name:'Decision · Bucket 30/60/90', kind:'decision', outcomes:[
            { value:'30', steps:[ { name:'Compose · Friendly reminder', kind:'compose' } ]},
            { value:'60', steps:[ { name:'Compose · Firm reminder', kind:'compose' } ]},
            { value:'90', steps:[
              { name:'Notify · Finance', kind:'notify' },
              ...(features.has('dispute_flow') ? [{ name:'Decision · Dispute raised', kind:'decision', outcomes:[
                { value:'yes', steps:[ { name:'HTTP · Dispute desk', kind:'http' }, { name:'Update · Case', kind:'update' } ]},
                { value:'no',  steps:[ { name:'Compose · Final notice', kind:'compose' } ]}
              ]}] : [{ name:'Compose · Final notice', kind:'compose' }])
            ]}
          ]}
        ]
      }],
      [{
        name:'AR Follow-up',
        steps:[
          ...guards,
          { name:'Decision · Dispute present', kind:'decision', outcomes:[
            { value:'yes', steps:[ { name:'HTTP · Dispute review', kind:'http' }, { name:'Update · Pause dunning', kind:'update' } ]},
            { value:'no', steps:[ { name:'Lookup · Aging', kind:'lookup' }, { name:'Compose · Reminder', kind:'compose' } ]}
          ]}
        ]
      }],
      [{
        name:'AR Follow-up',
        steps:[
          ...guards,
          { name:'Score · Risk', kind:'score' },
          { name:'Decision · High risk', kind:'decision', outcomes:[
            { value:'high', steps:[ { name:'Notify · Collections', kind:'notify' }, ...(features.has('payment')?[{name:'HTTP · Payment link', kind:'http'}]:[]) ]},
            { value:'low',  steps:[ { name:'Compose · Soft nudge', kind:'compose' } ]}
          ]}
        ]
      }]
    ];
    return plays[variant % plays.length];
  }

  function branchesForRecruiting(features, variant){
    const guards = [];
    if (features.has('compliance_guard')) guards.push({ name:'Guard · EEOC/redaction', kind:'update' });

    const plays = [
      [{
        name:'Recruiting',
        steps:[
          ...guards,
          { name:'Parse · Resume', kind:'lookup' },
          { name:'Score · Candidate', kind:'score' },
          { name:'Decision · Route', kind:'decision', outcomes:[
            { value:'ae',  steps:[ { name:'Calendar · Phone screen', kind:'book' }, { name:'ATS · Stage: Phone', kind:'update' } ]},
            { value:'sdr', steps:[ { name:'Calendar · Screening', kind:'book' }, { name:'ATS · Stage: Screen', kind:'update' } ]}
          ]}
        ]
      }],
      [{
        name:'Recruiting',
        steps:[
          ...guards,
          { name:'Score · Candidate', kind:'score' },
          { name:'Compose · Next steps', kind:'compose' },
          { name:'Calendar · Schedule', kind:'book' },
          { name:'ATS · Update stage', kind:'update' }
        ]
      }],
      [{
        name:'Recruiting',
        steps:[
          ...guards,
          { name:'Decision · Stage', kind:'decision', outcomes:[
            { value:'phone',  steps:[ { name:'Calendar · Phone screen', kind:'book' }, { name:'ATS · Move → Phone', kind:'update' } ]},
            { value:'onsite', steps:[ { name:'ATS · Move → Onsite', kind:'update' }, { name:'Compose · Directions/Prep', kind:'compose' } ]}
          ]}
        ]
      }]
    ];
    return plays[variant % plays.length];
  }

  function branchesForGeneric(features, variant){
    const guards = [];
    if (features.has('compliance_guard')) guards.push({ name:'Guard · Compliance/consent', kind:'update' });

    const plays = [
      [{ name:'Main', steps:[ ...guards, {name:'Enrich · Lead', kind: features.has('enrich')?'http':'score'}, {name:'Compose · Outreach', kind:'compose'}, ...(features.has('bi')?[{name:'BI · Push KPI',kind:'update'}]:[]) ]}],
      [{ name:'Main', steps:[ ...guards, {name:'Deduplicate', kind: features.has('dedupe')?'store':'score'}, {name:'HTTP · Process', kind:'http'}, {name:'Notify · Team', kind:'notify'} ]}],
      [{ name:'Main', steps:[ ...guards, {name:'Score · Priority', kind:'score'}, {name:'Decision · Priority', kind:'decision', outcomes:[
        { value:'high', steps:[ {name:'Notify · Team', kind:'notify'}, {name:'HTTP · Fast-track', kind:'http'} ]},
        { value:'normal', steps:[ {name:'Compose · Standard', kind:'compose'} ]}
      ]} ]}]
    ];
    return plays[variant % plays.length];
  }

  // ---------- Core builder (two channels: WhatsApp + Call) ----------
  function buildWorkflowJSON(scenario, industry, opts = {}){
    const selectedChannel = (opts.selectedChannel||'').toLowerCase().trim();
    const archetype = (scenario?.archetype) ? String(scenario.archetype).toUpperCase() : chooseArchetype(scenario);
    const channels = normalizeChannels(scenario, selectedChannel);
    const intendedTrigger = preferredTrigger(archetype, scenario);
    const features = deriveFeatures(scenario);
    const variant  = pickVariant(scenario, 3); // 0..2

    const title = `${scenario?.scenario_id||'Scenario'} — ${scenario?.name||''}`.trim();
    const wf = baseWorkflow(title);

    // Header + Trigger
    addHeader(wf, 'FLOW AREA · PRODUCTION', LAYOUT.header.x, LAYOUT.header.y);
    const manual = addManual(wf, LAYOUT.start.x, LAYOUT.start.y, 'Manual Trigger');
    const simTrig = addSimTrigger(wf, intendedTrigger, LAYOUT.start.x + Math.floor(LAYOUT.stepX*0.8), LAYOUT.start.y);
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

    // Optional prefetch for some archetypes
    let cursor = init;
    if (archetype==='APPOINTMENT_SCHEDULING') {
      const fetch = addHTTP(wf, 'Fetch · Upcoming (PMS)', `={{'${DEFAULT_HTTP.pms_upcoming}'}}`, '={{$json}}', LAYOUT.start.x + 3*LAYOUT.stepX, LAYOUT.start.y);
      connect(wf, cursor, fetch); cursor = fetch;
    }

    // Compute branches
    let branches;
    switch(archetype){
      case 'APPOINTMENT_SCHEDULING': branches = branchesForScheduling(features, variant); break;
      case 'CUSTOMER_SUPPORT_INTAKE': branches = branchesForSupport(features, variant); break;
      case 'AR_FOLLOWUP':            branches = branchesForAR(features, variant); break;
      case 'RECRUITING_INTAKE':      branches = branchesForRecruiting(features, variant); break;
      default:                       branches = branchesForGeneric(features, variant); break;
    }
    const BR = Array.isArray(branches)?branches:[branches];

    // Branch selector
    const sw = addSwitch(
      wf,
      'Branch',
      "={{$json.__branch || 'Main'}}",
      BR.map(b=>({ operation:'equal', value2:String(b.name||'Main').slice(0,64) })),
      LAYOUT.switchX,
      LAYOUT.start.y
    );
    connect(wf, cursor, sw);

    // Communication hub
    const commX = LAYOUT.start.x + Math.floor(2.2*LAYOUT.stepX);
    const branchBaseY = (bIdx, total)=> LAYOUT.start.y - Math.floor(LAYOUT.channelY * (Math.max(total,1)-1)/2) + bIdx*LAYOUT.channelY;

    let lastCollector = null;

    BR.forEach((b, bIdx)=>{
      const baseY = branchBaseY(bIdx, BR.length);
      const comm = addFunction(wf, 'Communication (Stage)', 'return [$json];', commX, baseY);
      connect(wf, sw, comm, bIdx);

      // Pre-systems injections (consistent X; column order enforces no overlap)
      let sysCursor = comm;
      const sysList = ['kb','crm','calendar','pms','ats','wms','erp','bi'].filter(s=>features.has(s));
      const howMany = Math.min(sysList.length, (variant===0?1:(variant===1?2:1)));
      for(let si=0; si<howMany; si++){
        const x = commX + Math.floor(0.6*LAYOUT.stepX) + si*Math.floor(0.7*LAYOUT.stepX);
        const sysNode = injectSystem(wf, sysList[si], x, baseY);
        connect(wf, sysCursor, sysNode);
        sysCursor = sysNode;
      }

      const chFirstY = (count)=> baseY - Math.floor(LAYOUT.channelY * (count-1)/2);
      let prevRowCollector = null;

      channels.forEach((ch, chIdx)=>{
        const rowY = chFirstY(channels.length) + chIdx*LAYOUT.channelY;

        // Enter row
        const enterName = GUIDE.numberSteps ? `[1] Enter · ${b.name || 'Main'} · ${ch.toUpperCase()}` : `Enter · ${b.name||'Main'} · ${ch.toUpperCase()}`;
        const enter = addFunction(wf, enterName, `return [{...$json,__branch:${JSON.stringify(b.name||'Main')},__channel:${JSON.stringify(ch)}}];`, commX + LAYOUT.stepX, rowY);
        if (chIdx===0) connect(wf, sysCursor, enter);
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
          } else if (kind==='ticket'){
            node = addHTTP(wf, title, `={{'${DEFAULT_HTTP.ticket_create}'}}`, '={{$json}}', x, y);
          } else if (kind==='http' && /kyc/i.test(title)){
            node = addHTTP(wf, title, `={{'${DEFAULT_HTTP.kyc}'}}`, '={{$json}}', x, y);
          } else if (kind==='http' && /payment/i.test(title)){
            node = addHTTP(wf, title, `={{'${DEFAULT_HTTP.pay_link}'}}`, '={{$json}}', x, y);
          } else if (kind==='http' && /dispute/i.test(title)){
            node = addHTTP(wf, title, `={{'${DEFAULT_HTTP.dispute}'}}`, '={{$json}}', x, y);
          } else if (['http','lookup','update','store','notify','route','score'].includes(kind)){
            node = addHTTP(wf, title, `={{'${DEFAULT_HTTP.step_generic}'}}`, '={{$json}}', x, y);
          } else {
            node = addFunction(wf, title, 'return [$json];', x, y);
          }
          connect(wf, prev, node); prev = node;
        };

        const walkSteps = (steps, baseX, baseY)=>{
          for (let i=0; i<steps.length; i++){
            const st = steps[i] || {};
            const kind = String(st.kind||'').toLowerCase();
            const title = GUIDE.numberSteps ? `[${++stepIndex}] ${st.name||'Step'}` : (st.name||'Step');
            const x = baseX + i*LAYOUT.stepX;

            if (kind==='decision' && Array.isArray(st.outcomes) && st.outcomes.length){
              // Decision switch at (x, baseY)
              const rulz = st.outcomes.map(o=>({ operation:'equal', value2:String(o.value||'path').slice(0,64) }));
              const dsw = addSwitch(wf, `${title} (Decision)`, "={{$json.__decision || 'default'}}", rulz, x, baseY);
              connect(wf, prev, dsw);

              // Outcomes: preserve vertical order by explicit computed rows
              let chain = null;
              st.outcomes.forEach((o, oIdx)=>{
                const oyDesired = baseY - Math.floor((st.outcomes.length-1)/2)*LAYOUT.outcomeRowY + oIdx*LAYOUT.outcomeRowY;
                const oy = oyDesired; // desired row; column placer ensures it stays >= previous in this column
                const oEnter = addFunction(wf, `[${stepIndex}.${oIdx+1}] Outcome · ${o.value||'path'}`, `return [{...$json,__decision:${JSON.stringify(String(o.value||'path'))}}];`, x + Math.floor(LAYOUT.stepX*0.6), oy);
                connect(wf, dsw, oEnter, oIdx);

                let prevO = oEnter;
                (Array.isArray(o.steps)?o.steps:[]).forEach((os, ok)=>{
                  const ox = x + Math.floor(LAYOUT.stepX*0.6) + (ok+1)*Math.floor(LAYOUT.stepX*1.0);
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
                  } else if (okind==='ticket'){
                    node = addHTTP(wf, ot, `={{'${DEFAULT_HTTP.ticket_create}'}}`, '={{$json}}', ox, oy);
                  } else if (okind==='http' && /payment/i.test(ot)){
                    node = addHTTP(wf, ot, `={{'${DEFAULT_HTTP.pay_link}'}}`, '={{$json}}', ox, oy);
                  } else if (okind==='http' && /dispute/i.test(ot)){
                    node = addHTTP(wf, ot, `={{'${DEFAULT_HTTP.dispute}'}}`, '={{$json}}', ox, oy);
                  } else if (['http','update','store','notify','route','lookup','score'].includes(okind)){
                    node = addHTTP(wf, ot, `={{'${DEFAULT_HTTP.step_generic}'}}`, '={{$json}}', ox, oy);
                  } else {
                    node = addFunction(wf, ot, 'return [$json];', ox, oy);
                  }
                  connect(wf, prevO, node); prevO = node;
                });

                const sendX = x + Math.floor(LAYOUT.stepX*0.6) + Math.max(2, (o.steps||[]).length+1)*Math.floor(LAYOUT.stepX*1.0);
                const sender = makeSender(wf, ch, sendX, oy);
                try{ wf.nodes[wf.nodes.findIndex(n=>n.name===sender)].name = `[${stepIndex}.${oIdx+1}] Send · ${ch.toUpperCase()}`; }catch{}
                connect(wf, prevO, sender);
                const oCol = addCollector(wf, sendX + Math.floor(LAYOUT.stepX*0.8), oy);
                connect(wf, sender, oCol);

                if (chain) connect(wf, chain, oCol);
                chain = oCol;

                if (oIdx === st.outcomes.length-1){
                  prev = chain; // continue chain forward
                }
              });
            } else {
              runStep(title, kind, x, baseY);
            }
          }
        };

        const steps = Array.isArray(b.steps)?b.steps:[];
        walkSteps(steps, commX + 2*LAYOUT.stepX, rowY);

        // Send + collect if last step wasn't a decision
        const lastIsDecision = steps.some(st=>String(st.kind||'').toLowerCase()==='decision');
        if (!lastIsDecision){
          const sendX = commX + 2*LAYOUT.stepX + Math.max(1, steps.length)*LAYOUT.stepX;
          const sender = makeSender(wf, ch, sendX, rowY);
          const sendTitle = GUIDE.numberSteps ? `[${++stepIndex}] Send · ${ch.toUpperCase()}` : `Send · ${ch.toUpperCase()}`;
          try{ wf.nodes[wf.nodes.findIndex(n=>n.name===sender)].name = sendTitle; }catch{}
          connect(wf, prev, sender);
          const col = addCollector(wf, sendX + Math.floor(LAYOUT.stepX*0.9), rowY);
          connect(wf, sender, col);
          if (prevRowCollector) connect(wf, prevRowCollector, col);
          prevRowCollector = col;
        }

        if (bIdx === BR.length-1 && chIdx === channels.length-1) lastCollector = prevRowCollector;
      });
    });

    // Error handling lane (varies by variant)
    if (lastCollector){
      if (variant===0){
        const errY = LAYOUT.start.y + 2*LAYOUT.channelY + 220;
        addHeader(wf, 'ERROR AREA · Sweep', LAYOUT.start.x + 3*LAYOUT.stepX, errY - 80);
        let prevE = addFunction(wf, 'Error Monitor', 'return [$json];', LAYOUT.start.x + 4*LAYOUT.stepX, errY);
        connect(wf, lastCollector, prevE);
        const retry = addFunction(wf, 'Retry Policy', 'return [$json];', LAYOUT.start.x + 5*LAYOUT.stepX, errY);
        connect(wf, prevE, retry);
        const notify = addHTTP(wf, 'Notify · Ops', `={{'${DEFAULT_HTTP.ops_alert}'}}`, '={{$json}}', LAYOUT.start.x + 6*LAYOUT.stepX, errY);
        connect(wf, retry, notify);
      } else if (variant===1){
        const e1 = addFunction(wf, 'Mitigate · transient', 'return [$json];', LAYOUT.start.x + 4*LAYOUT.stepX, LAYOUT.start.y + LAYOUT.channelY);
        connect(wf, lastCollector, e1);
        const e2 = addHTTP(wf, 'Notify · Ops', `={{'${DEFAULT_HTTP.ops_alert}'}}`, '={{$json}}', LAYOUT.start.x + 5*LAYOUT.stepX, LAYOUT.start.y + LAYOUT.channelY);
        connect(wf, e1, e2);
      } else {
        const e2 = addHTTP(wf, 'Notify · Ops', `={{'${DEFAULT_HTTP.ops_alert}'}}`, '={{$json}}', LAYOUT.start.x + 4*LAYOUT.stepX, LAYOUT.start.y + Math.floor(LAYOUT.channelY*1.5));
        connect(wf, lastCollector, e2);
      }
    }

    // Meta (useful for debugging / UI badges)
    wf.staticData.__design = {
      archetype, trigger:intendedTrigger, channels,
      features: Array.from(features.values()),
      variant,
      layout:{ stepX:LAYOUT.stepX, channelY:LAYOUT.channelY, outcomeRowY:LAYOUT.outcomeRowY, grid:GRID.cellH, commHub:true, align:'strict-grid', antiOverlap:true },
      notes: 'Placement preserves vertical order within each column; no overlaps.'
    };

    return wf;
  }

  // ---------- Export ----------
  window.Builder = { buildWorkflowJSON };
})();
