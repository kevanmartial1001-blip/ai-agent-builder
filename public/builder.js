// public/builder.js
// Exposes: window.Builder = { buildWorkflowJSON }
// SAFE-first (imports on most n8n versions). Use ?compat=full to enable real Cron/Webhook/Email/Twilio.

(function () {
  "use strict";

  // ---------------- basic helpers ----------------
  const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
  const pos = (x, y) => [x, y];
  const QS = new URLSearchParams(location.search);
  const compat = (QS.get("compat") || "safe").toLowerCase() === "full" ? "full" : "safe";

  function baseWorkflow(name) {
    return { name, nodes: [], connections: {}, active: false, settings: {}, staticData: {} };
  }
  function addNode(wf, node) { wf.nodes.push(node); return node.name; }
  function connect(wf, from, to, outputIndex = 0) {
    wf.connections[from] ??= {}; wf.connections[from].main ??= [];
    for (let i = wf.connections[from].main.length; i <= outputIndex; i++) wf.connections[from].main[i] = [];
    wf.connections[from].main[outputIndex].push({ node: to, type: "main", index: 0 });
  }
  function listify(v){
    if (Array.isArray(v)) return v.map(x=>String(x).trim()).filter(Boolean);
    return String(v||'').split(/[;,\n|]+/).map(x=>x.trim()).filter(Boolean);
  }
  function toWords(s){ return (String(s||"").toLowerCase().match(/[a-z0-9_+-]+/g) || []); }

  // ---------------- shared building blocks ----------------
  function addManual(wf, x=-1100, y=300) {
    return addNode(wf, { id: uid("manual"), name: "Manual Trigger", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: pos(x, y), parameters: {} });
  }
  function addCron(wf, label="Cron (15m)", x=-1100, y=140) {
    if (compat === "full") {
      return addNode(wf, { id: uid("cron"), name: label, type: "n8n-nodes-base.cron", typeVersion: 1, position: pos(x, y),
        parameters: { triggerTimes: { item: [{ mode: "everyX", everyX: { hours: 0, minutes: 15 } }] } } });
    }
    return addNode(wf, { id: uid("cronph"), name: `${label} (Placeholder)`, type: "n8n-nodes-base.function", typeVersion: 2, position: pos(x, y),
      parameters: { functionCode: "return [$json];" } });
  }
  function addWebhook(wf, label="Webhook (Incoming)", x=-1100, y=460) {
    if (compat === "full") {
      return addNode(wf, { id: uid("webhook"), name: label, type: "n8n-nodes-base.webhook", typeVersion: 1, position: pos(x, y),
        parameters: { path: uid("hook"), methods: ["POST"], responseMode: "onReceived" } });
    }
    return addNode(wf, { id: uid("webph"), name: `${label} (Placeholder)`, type: "n8n-nodes-base.function", typeVersion: 2, position: pos(x, y),
      parameters: { functionCode: "return [$json];" } });
  }
  function addInit(wf, scenario, industry, channel, x=-860, y=300) {
    return addNode(wf, {
      id: uid("init"), name: "Init Context", type: "n8n-nodes-base.function", typeVersion: 2, position: pos(x, y),
      parameters: { functionCode:
`const scenario = $json.scenario || ${JSON.stringify(scenario||{})};
const industry = $json.industry || ${JSON.stringify(industry||{})};
const recommendedChannel = ($json.recommendedChannel || ${JSON.stringify(channel)});
const to = $json.to || 'recipient@example.com';
const from = $json.from || '+10000000000';
const callWebhook = $json.callWebhook || 'https://example.com/call';
return [{ scenario, industry, recommendedChannel, to, from, callWebhook }];` }
    });
  }
  function addHTTP(wf, name, urlExpr, bodyExpr, x, y, method="POST") {
    return addNode(wf, { id: uid("http"), name, type: "n8n-nodes-base.httpRequest", typeVersion: 4, position: pos(x, y),
      parameters: { url: urlExpr, method, jsonParameters: true, sendBody: true, bodyParametersJson: bodyExpr } });
  }
  function addFunction(wf, name, code, x, y) {
    return addNode(wf, { id: uid("func"), name, type: "n8n-nodes-base.function", typeVersion: 2, position: pos(x, y),
      parameters: { functionCode: code } });
  }
  function addIf(wf, name, left, op, right, x, y) {
    return addNode(wf, { id: uid("if"), name, type: "n8n-nodes-base.if", typeVersion: 2, position: pos(x, y),
      parameters: { conditions: { number: [], string: [{ value1: left, operation: op, value2: right }] } } });
  }
  function addSwitch(wf, name, valueExpr, rules, x, y) {
    return addNode(wf, { id: uid("switch"), name, type: "n8n-nodes-base.switch", typeVersion: 2, position: pos(x, y),
      parameters: { value1: valueExpr, rules } });
  }
  function addMerge(wf, name, x, y) {
    return addNode(wf, { id: uid("merge"), name, type: "n8n-nodes-base.merge", typeVersion: 2, position: pos(x, y),
      parameters: { mode: "append" } });
  }
  function addSplit(wf, x, y) {
    return addNode(wf, { id: uid("split"), name: "Split In Batches", type: "n8n-nodes-base.splitInBatches", typeVersion: 1, position: pos(x, y),
      parameters: { batchSize: 20 } });
  }

  // ---------- channel leaves (SAFE vs FULL) ----------
  function addEmailNode(wf, x, y) {
    return addNode(wf, { id: uid("email"), name: "Send Email", type: "n8n-nodes-base.emailSend", typeVersion: 3, position: pos(x, y),
      parameters: { to: "={{$json.to}}", subject: "={{$json.scenario?.agent_name || 'AI Outreach'}}", text: "={{$json.message}}" }, credentials: {} });
  }
  function addSMSNode(wf, x, y) {
    return addNode(wf, { id: uid("sms"), name: "Send SMS", type: "n8n-nodes-base.twilio", typeVersion: 3, position: pos(x, y),
      parameters: { resource: "message", operation: "create", from: "={{$json.from}}", to: "={{$json.to}}", message: "={{$json.message}}" }, credentials: {} });
  }
  function addWANode(wf, x, y) {
    return addNode(wf, { id: uid("wa"), name: "Send WhatsApp (Twilio)", type: "n8n-nodes-base.twilio", typeVersion: 3, position: pos(x, y),
      parameters: { resource: "message", operation: "create", from: "={{'whatsapp:' + ($json.from || '+10000000000')}}", to: "={{'whatsapp:' + ($json.to || '+10000000001')}}", message: "={{$json.message}}" }, credentials: {} });
  }
  function addCallNode(wf, x, y) {
    return addNode(wf, { id: uid("call"), name: "Place Call (Webhook/Provider)", type: "n8n-nodes-base.httpRequest", typeVersion: 4, position: pos(x, y),
      parameters: { url: "={{$json.callWebhook}}", method: "POST", jsonParameters: true, sendBody: true,
        bodyParametersJson: "={{ { to: $json.to, from: $json.from, text: $json.message } }}" } });
  }
  function addChannelLeaf(wf, label, x, y) {
    return addFunction(wf, label, `return [{ note: '${label}', channel: $json.channel, message: $json.message }];`, x, y);
  }
  function makeChannelLeaves(wf, x, ys) {
    if (compat === "full") return [ addEmailNode(wf,x,ys[0]), addSMSNode(wf,x,ys[1]), addWANode(wf,x,ys[2]), addCallNode(wf,x,ys[3]) ];
    return [ addChannelLeaf(wf,"Email Placeholder",x,ys[0]), addChannelLeaf(wf,"SMS Placeholder",x,ys[1]), addChannelLeaf(wf,"WhatsApp Placeholder",x,ys[2]), addChannelLeaf(wf,"Call Placeholder",x,ys[3]) ];
  }

  // ---------- composer ----------
  function composeMessageFunctionBody() {
    return `const s=$json.scenario||{}; const ind=$json.industry||{}; const channel=String($json.recommendedChannel||'email').toLowerCase();
const headline = s.agent_name ? \`\${s.agent_name} — \${s.scenario_id||''}\` : (s.title||s.scenario_id||'Scenario');
const lines=[]; if(ind.industry_id||ind.name) lines.push('Industry: '+(ind.name||ind.industry_id));
if(s.problem) lines.push('Problem: '+s.problem);
if(s.narrative) lines.push('Narrative: '+s.narrative);
if(s.how_it_works) lines.push('How it works: '+s.how_it_works);
if(s.roi_hypothesis) lines.push('ROI: '+s.roi_hypothesis);
const prefix={email:'📧 Email',sms:'📱 SMS',whatsapp:'🟢 WhatsApp',call:'📞 Call'}[channel]||'Message';
return [{ message:\`\${prefix} — \${headline}\\n\\n\${lines.join('\\n')}\`, channel }];`;
  }

  // ---------------- classifier fallback (if API didn't provide archetype) ----------------
  const RULES = [
    { a:'APPOINTMENT_SCHEDULING', inc:[/appointment|appointments|scheduling|no[-_ ]?show|calendar/i] },
    { a:'CUSTOMER_SUPPORT_INTAKE', inc:[/\b(cs|support|helpdesk|ticket|sla|triage|escalation|deflection|kb)\b/i] },
    { a:'FEEDBACK_NPS', inc:[/\b(nps|survey|surveys|feedback|csat|ces)\b/i] },
    { a:'KNOWLEDGEBASE_FAQ', inc:[/\b(kb|faq|knowledge|self-?service)\b/i], exc:[/ticket|escalation/i] },
    { a:'SALES_OUTREACH', inc:[/\b(sales|outreach|cadence|sequence|abm|prospect|cold[-_ ]?email)\b/i] },
    { a:'LEAD_QUAL_INBOUND', inc:[/\b(inbound|lead[-_ ]?qual|qualification|routing|router|forms?)\b/i] },
    { a:'CHURN_WINBACK', inc:[/\b(churn|win[-_ ]?back|reactivation|retention|loyalty)\b/i] },
    { a:'RENEWALS_CSM', inc:[/\b(renewal|qbr|success|csm|upsell|cross-?sell)\b/i] },
    { a:'AR_FOLLOWUP', inc:[/\b(a\/?r|accounts?\s*receivable|invoice|collections?|dso|reconciliation)\b/i] },
    { a:'AP_AUTOMATION', inc:[/\b(a\/?p|accounts?\s*payable|invoices?|3[-\s]?way|three[-\s]?way|matching|approvals?)\b/i] },
    { a:'INVENTORY_MONITOR', inc:[/\b(inventory|stock|sku|threshold|warehouse|3pl|wms|backorder)\b/i] },
    { a:'REPLENISHMENT_PO', inc:[/\b(replenishment|purchase[-_ ]?order|po|procure|procurement|vendors?|suppliers?)\b/i] },
    { a:'FIELD_SERVICE_DISPATCH', inc:[/\b(dispatch|work[-_ ]?orders?|technicians?|field|geo|eta|route|yard)\b/i] },
    { a:'COMPLIANCE_AUDIT', inc:[/\b(compliance|audit|audits|policy|governance|sox|iso|gdpr|hipaa|attestation)\b/i] },
    { a:'INCIDENT_MGMT', inc:[/\b(incident|sev[: ]?(high|p[12])|major|rca|postmortem|downtime|uptime|slo)\b/i] },
    { a:'DATA_PIPELINE_ETL', inc:[/\b(etl|pipeline|ingest|transform|load|csv|s3|gcs|orchestration)\b/i] },
    { a:'REPORTING_KPI_DASH', inc:[/\b(dashboard|dashboards|kpi|scorecard|report|reporting)\b/i] },
    { a:'ACCESS_GOVERNANCE', inc:[/\b(access|rbac|sso|entitlements|seats|identity|pii|dlp)\b/i] },
    { a:'PRIVACY_DSR', inc:[/\b(dsr|data\s*subject|privacy\s*request|gdpr|ccpa)\b/i] },
    { a:'RECRUITING_INTAKE', inc:[/\b(recruit(ing)?|ats|cv|resume|candidate|interviews?)\b/i] },
  ];
  function classifyFallback(s) {
    const hay = [
      String(s.scenario_id||''), String(s.name||''), ...(Array.isArray(s.tags)?s.tags:listify(s.tags))
    ].join(' ').toLowerCase();
    for (const r of RULES) {
      const match = r.inc?.some(rx => rx.test(hay));
      const blocked = r.exc?.some(rx => rx.test(hay));
      if (match && !blocked) return r.a;
    }
    return 'SALES_OUTREACH';
  }

  // ------------------- 20 ARCHETYPES -------------------
  const T = {};

  // 1) APPOINTMENT_SCHEDULING
  T.APPOINTMENT_SCHEDULING = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const nCron = addCron(wf, "Cron (Upcoming Appointments)", -1100, 140);
    const nInit = addInit(wf, scenario, industry, channel, -860, 300);
    const nFetch = addHTTP(wf, "Fetch Upcoming (PMS)", "={{$json.pms_upcoming || 'https://example.com/pms/upcoming'}}", "={{$json}}", -620, 300);
    const nSplit = addSplit(wf, -380, 300);
    const nCompose = addFunction(wf, "Compose Reminder", composeMessageFunctionBody(), -140, 300);
    const nSwitch = addSwitch(wf, "Choose Channel", "={{$json.channel}}",
      [{operation:"equal",value2:"email"}, {operation:"equal",value2:"sms"}, {operation:"equal",value2:"whatsapp"}, {operation:"equal",value2:"call"}],
      120,300);
    const [nEmail,nSMS,nWA,nCall] = makeChannelLeaves(wf, 420, [160,300,440,580]);
    const nUpdate = addHTTP(wf, "Update PMS (Confirm/Reschedule)", "={{$json.pms_update || 'https://example.com/pms/update'}}", "={{$json}}", 720, 300);
    const nSummary = addHTTP(wf, "Slack Daily Summary", "={{'https://example.com/slack/summary'}}", "={{$json}}", 980, 300);
    connect(wf,nCron,nInit); connect(wf,nInit,nFetch); connect(wf,nFetch,nSplit); connect(wf,nSplit,nCompose); connect(wf,nCompose,nSwitch);
    connect(wf,nSwitch,nEmail,0); connect(wf,nSwitch,nSMS,1); connect(wf,nSwitch,nWA,2); connect(wf,nSwitch,nCall,3);
    connect(wf,nEmail,nUpdate); connect(wf,nSMS,nUpdate); connect(wf,nWA,nUpdate); connect(wf,nCall,nUpdate);
    connect(wf,nUpdate,nSummary);
    const nManual = addManual(wf, -1100, 300); connect(wf, nManual, nInit);
  };

  // 2) CUSTOMER_SUPPORT_INTAKE
  T.CUSTOMER_SUPPORT_INTAKE = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const nWebhook = addWebhook(wf, "Support Intake (Incoming)", -1120, 300);
    const nInit = addInit(wf, scenario, industry, channel, -880, 300);
    const nClassify = addFunction(wf, "Classify Intent/Priority", `
const text=($json.message||$json.body||'').toLowerCase();
const vip=String($json.tags||'').toLowerCase().includes('vip')||/vip|priority/.test(text);
const severity = /urgent|critical|sev[-: ]?1/.test(text) ? 'high':'normal';
return [{...$json,intent:(/refund|billing/.test(text)?'billing':'support'),vip,severity}];`, -640,300);
    const nIf = addIf(wf, "VIP / High Severity?", "={{$json.severity}}", "equal", "high", -400,300);
    const nCreate = addHTTP(wf, "Create Ticket", "={{$json.ticket_url || 'https://example.com/ticket/create'}}", "={{$json}}", -140,300);
    const nSwitch = addSwitch(wf, "Choose Channel", "={{$json.channel}}",
      [{operation:"equal",value2:"email"}, {operation:"equal",value2:"sms"}, {operation:"equal",value2:"whatsapp"}, {operation:"equal",value2:"call"}],
      120,300);
    const [e,s,w,c] = makeChannelLeaves(wf, 420, [160,300,440,580]);
    const nEsc = addHTTP(wf, "Escalation Alert", "={{'https://example.com/slack/alert'}}", "={{$json}}", 120, 140);
    connect(wf,nWebhook,nInit); connect(wf,nInit,nClassify); connect(wf,nClassify,nIf);
    connect(wf,nIf,nEsc,0); connect(wf,nEsc,nCreate);
    connect(wf,nIf,nCreate,1);
    connect(wf,nCreate,nSwitch);
    connect(wf,nSwitch,e,0); connect(wf,nSwitch,s,1); connect(wf,nSwitch,w,2); connect(wf,nSwitch,c,3);
    const m = addManual(wf,-1120,140); connect(wf,m,nInit);
  };

  // 3) FEEDBACK_NPS
  T.FEEDBACK_NPS = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const cron = addCron(wf, "Cron (Post-Event)", -1100, 140);
    const init = addInit(wf, scenario, industry, channel, -860, 300);
    const mk = addHTTP(wf, "Create NPS Link", "={{$json.nps || 'https://example.com/nps/create'}}", "={{$json}}", -620, 300);
    const comp = addFunction(wf, "Compose NPS Invite", composeMessageFunctionBody(), -380, 300);
    const sw = addSwitch(wf, "Choose Channel", "={{$json.channel}}",
      [{operation:"equal",value2:"email"},{operation:"equal",value2:"sms"},{operation:"equal",value2:"whatsapp"},{operation:"equal",value2:"call"}], -120,300);
    const [e,s,w,c] = makeChannelLeaves(wf, 180, [160,300,440,580]);
    const hook = addWebhook(wf, "NPS Response (Webhook)", 420, 300);
    const agg = addFunction(wf, "Aggregate Scores", `const n=Number($json.score||$json.nps||0);return [{score:n||0}];`, 660, 300);
    const rpt = addHTTP(wf, "Report to BI", "={{'https://example.com/bi/nps'}}", "={{$json}}", 900, 300);
    connect(wf,cron,init); connect(wf,init,mk); connect(wf,mk,comp); connect(wf,comp,sw);
    connect(wf,sw,e,0); connect(wf,sw,s,1); connect(wf,sw,w,2); connect(wf,sw,c,3);
    connect(wf,e,hook); connect(wf,s,hook); connect(wf,w,hook); connect(wf,c,hook);
    connect(wf,hook,agg); connect(wf,agg,rpt);
    const m = addManual(wf,-1100,300); connect(wf,m,init);
  };

  // 4) KNOWLEDGEBASE_FAQ
  T.KNOWLEDGEBASE_FAQ = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const hook = addWebhook(wf, "FAQ Intake", -1120, 300);
    const init = addInit(wf, scenario, industry, channel, -880, 300);
    const search = addHTTP(wf, "KB Search", "={{'https://example.com/kb/search'}}", "={{$json}}", -640, 300);
    const ifFound = addIf(wf, "Found Answer?", "={{$json.kbHit || $json.answer}}", "notEmpty", "", -400, 300);
    const compose = addFunction(wf, "Compose Reply", composeMessageFunctionBody(), -160, 300);
    const sw = addSwitch(wf, "Choose Channel", "={{$json.channel}}",
      [{operation:"equal",value2:"email"},{operation:"equal",value2:"sms"},{operation:"equal",value2:"whatsapp"},{operation:"equal",value2:"call"}], 100,300);
    const [e,s,w,c] = makeChannelLeaves(wf, 400, [160,300,440,580]);
    const ticket = addHTTP(wf, "Create Ticket", "={{'https://example.com/ticket/create'}}", "={{$json}}", 400, 140);
    connect(wf,hook,init); connect(wf,init,search); connect(wf,search,ifFound);
    connect(wf,ifFound,compose,0); connect(wf,ifFound,ticket,1);
    connect(wf,compose,sw);
    connect(wf,sw,e,0); connect(wf,sw,s,1); connect(wf,sw,w,2); connect(wf,sw,c,3);
  };

  // 5) SALES_OUTREACH
  T.SALES_OUTREACH = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const man = addManual(wf,-1100,260);
    const init = addInit(wf, scenario, industry, channel, -880, 260);
    const enrich = addHTTP(wf, "Enrich Lead", "={{$json.enrichUrl || 'https://example.com/enrich'}}", "={{$json}}", -640, 260);
    const dedupe = addFunction(wf, "Deduplicate/Score", `
const seen=new Set(); const items=Array.isArray($json.leads)?$json.leads:[ $json ];
const out=[]; for(const it of items){ const key=(it.email||it.domain||it.company||'').toLowerCase();
 if(!key||seen.has(key)) continue; seen.add(key); it.score=(it.score||0)+(/cto|ceo|founder/i.test(it.title||'')?30:0); out.push(it); }
return out.length?out:[$json];`, -400,260);
    const comp = addFunction(wf, "Compose Message", composeMessageFunctionBody(), -160,260);
    const sw = addSwitch(wf,"Choose Channel","={{$json.channel}}",
      [{operation:"equal",value2:"email"},{operation:"equal",value2:"sms"},{operation:"equal",value2:"whatsapp"},{operation:"equal",value2:"call"}], 100,260);
    const [e,s,w,c] = makeChannelLeaves(wf,400,[120,260,400,540]);
    const crm = addHTTP(wf,"Log to CRM","={{$json.crmUrl || 'https://example.com/crm/log'}}","={{$json}}",700,260);
    connect(wf,man,init); connect(wf,init,enrich); connect(wf,enrich,dedupe); connect(wf,dedupe,comp); connect(wf,comp,sw);
    connect(wf,sw,e,0); connect(wf,sw,s,1); connect(wf,sw,w,2); connect(wf,sw,c,3);
    connect(wf,e,crm); connect(wf,s,crm); connect(wf,w,crm); connect(wf,c,crm);
  };

  // 6) LEAD_QUAL_INBOUND
  T.LEAD_QUAL_INBOUND = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const hook = addWebhook(wf, "Lead Form (Webhook)", -1120, 300);
    const init = addInit(wf, scenario, industry, channel, -880, 300);
    const score = addFunction(wf, "Score/Route", `
const l=$json; l.score=(l.score||0)+(/director|vp|c[- ]?level/i.test(l.title||'')?40:0);
l.route = l.score>=60?'ae':'sdr'; return [l];`, -640,300);
    const ifAE = addIf(wf,"Route to AE?","={{$json.route}}","equal","ae",-400,300);
    const book = addHTTP(wf,"Book Calendar","={{$json.calUrl || 'https://example.com/calendar/book'}}","={{$json}}",-160,300);
    const crm = addHTTP(wf,"Create/Update CRM","={{$json.crmUrl || 'https://example.com/crm/upsert'}}","={{$json}}",100,300);
    connect(wf,hook,init); connect(wf,init,score); connect(wf,score,ifAE);
    connect(wf,ifAE,book,0); connect(wf,book,crm); connect(wf,ifAE,crm,1);
  };

  // 7) CHURN_WINBACK
  T.CHURN_WINBACK = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const man = addManual(wf,-1100,260);
    const init = addInit(wf, scenario, industry, channel, -880, 260);
    const seg = addFunction(wf,"Segment Lapsed",`const d=$json; d.segment = (d.days_lapsed||90)>180?'deep':'light'; return [d];`,-640,260);
    const comp = addFunction(wf,"Compose Offer",composeMessageFunctionBody(),-400,260);
    const sw = addSwitch(wf,"Choose Channel","={{$json.channel}}",
      [{operation:"equal",value2:"email"},{operation:"equal",value2:"sms"},{operation:"equal",value2:"whatsapp"},{operation:"equal",value2:"call"}], -160,260);
    const [e,s,w,c]=makeChannelLeaves(wf,140,[120,260,400,540]);
    const crm = addHTTP(wf,"Log Outcome","={{'https://example.com/crm/winback'}}","={{$json}}",420,260);
    connect(wf,man,init); connect(wf,init,seg); connect(wf,seg,comp); connect(wf,comp,sw);
    connect(wf,sw,e,0); connect(wf,sw,s,1); connect(wf,sw,w,2); connect(wf,sw,c,3);
    connect(wf,e,crm); connect(wf,s,crm); connect(wf,w,crm); connect(wf,c,crm);
  };

  // 8) RENEWALS_CSM
  T.RENEWALS_CSM = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const cron = addCron(wf,"Cron (Renewals)",-1100,140);
    const init = addInit(wf, scenario, industry, channel, -860, 300);
    const fetch = addHTTP(wf,"Fetch Renewals","={{'https://example.com/crm/renewals'}}","={{$json}}",-620,300);
    const split = addSplit(wf,-380,300);
    const risk = addFunction(wf,"Risk Score",`const r=$json;r.risk=(r.usage<0.5? 'high' : 'low'); return [r];`,-140,300);
    const sw = addSwitch(wf,"Play Selection","={{$json.risk}}",[ {operation:"equal",value2:"high"},{operation:"equal",value2:"low"} ],120,300);
    const high = addFunction(wf,"High-Risk Play", "return [$json];", 380, 200);
    const low  = addFunction(wf,"Low-Risk Play", "return [$json];", 380, 380);
    const comp = addFunction(wf,"Compose Outreach",composeMessageFunctionBody(),640,300);
    const ch = addSwitch(wf,"Choose Channel","={{$json.channel}}",
      [{operation:"equal",value2:"email"},{operation:"equal",value2:"sms"},{operation:"equal",value2:"whatsapp"},{operation:"equal",value2:"call"}],900,300);
    const [e,s,w,c]=makeChannelLeaves(wf,1200,[160,300,440,580]);
    const qbr = addHTTP(wf,"Create QBR Doc","={{'https://example.com/qbr/create'}}","={{$json}}",1500,300);
    connect(wf,cron,init); connect(wf,init,fetch); connect(wf,fetch,split); connect(wf,split,risk);
    connect(wf,risk,sw); connect(wf,sw,high,0); connect(wf,sw,low,1);
    connect(wf,high,comp); connect(wf,low,comp); connect(wf,comp,ch);
    connect(wf,ch,e,0); connect(wf,ch,s,1); connect(wf,ch,w,2); connect(wf,ch,c,3);
    connect(wf,e,qbr); connect(wf,s,qbr); connect(wf,w,qbr); connect(wf,c,qbr);
  };

  // 9) AR_FOLLOWUP
  T.AR_FOLLOWUP = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const cron = addCron(wf,"Cron (Aging Report)",-1100,140);
    const init = addInit(wf, scenario, industry, channel, -860, 300);
    const aging = addHTTP(wf,"Pull Aging","={{'https://example.com/accounting/aging'}}","={{$json}}",-620,300);
    const split = addSplit(wf,-380,300);
    const tier = addFunction(wf,"Bucket 30/60/90",`
const d=$json; const dpd=d.days_past_due||0; d.bucket = dpd>=90?'90':(dpd>=60?'60':'30'); return [d];`,-140,300);
    const sw = addSwitch(wf,"Nudge Ladder","={{$json.bucket}}",[ {operation:"equal",value2:"30"},{operation:"equal",value2:"60"},{operation:"equal",value2:"90"} ],120,300);
    const step30=addFunction(wf,"30-day Nudge","return [$json];",380,200);
    const step60=addFunction(wf,"60-day Nudge","return [$json];",380,300);
    const step90=addFunction(wf,"90-day Escalation","return [$json];",380,400);
    const comp = addFunction(wf,"Compose Message",composeMessageFunctionBody(),640,300);
    const ch = addSwitch(wf,"Choose Channel","={{$json.channel}}",
      [{operation:"equal",value2:"email"},{operation:"equal",value2:"sms"},{operation:"equal",value2:"whatsapp"},{operation:"equal",value2:"call"}],900,300);
    const [e,s,w,c]=makeChannelLeaves(wf,1200,[160,300,440,580]);
    connect(wf,cron,init); connect(wf,init,aging); connect(wf,aging,split); connect(wf,split,tier); connect(wf,tier,sw);
    connect(wf,sw,step30,0); connect(wf,sw,step60,1); connect(wf,sw,step90,2);
    connect(wf,step30,comp); connect(wf,step60,comp); connect(wf,step90,comp); connect(wf,comp,ch);
    connect(wf,ch,e,0); connect(wf,ch,s,1); connect(wf,ch,w,2); connect(wf,ch,c,3);
  };

  // 10) AP_AUTOMATION
  T.AP_AUTOMATION = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const hook = addWebhook(wf,"Invoice Ingest", -1120, 300);
    const init = addInit(wf, scenario, industry, channel, -880, 300);
    const parse = addFunction(wf,"Parse/Extract","return [$json];",-640,300);
    const match = addFunction(wf,"3-Way Match","return [$json];",-400,300);
    const ifExc = addIf(wf,"Exception?","={{$json.exception}}","notEmpty","",-160,300);
    const appr = addFunction(wf,"Approval Path","return [$json];",100,300);
    const pay  = addHTTP(wf,"Issue Payment","={{'https://example.com/pay'}}","={{$json}}",360,300);
    connect(wf,hook,init); connect(wf,init,parse); connect(wf,parse,match); connect(wf,match,ifExc);
    connect(wf,ifExc,appr,0); connect(wf,appr,pay); connect(wf,ifExc,pay,1);
  };

  // 11) INVENTORY_MONITOR
  T.INVENTORY_MONITOR = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const cron = addCron(wf,"Cron (Stock Levels)",-1100,140);
    const init = addInit(wf, scenario, industry, channel, -860,300);
    const fetch = addHTTP(wf,"Fetch Stock (WMS/ERP)","={{'https://example.com/wms/levels'}}","={{$json}}",-620,300);
    const split = addSplit(wf,-380,300);
    const thresh= addFunction(wf,"Threshold Check",`const i=$json;i.low = (i.qty||0) <= (i.min||10);return [i];`,-140,300);
    const ifLow = addIf(wf,"Low Stock?","={{$json.low}}","equal","true",120,300);
    const alert = addHTTP(wf,"Notify Ops","={{'https://example.com/slack/inventory'}}","={{$json}}",380,200);
    const po    = addFunction(wf,"Prepare PO","return [$json];",380,380);
    connect(wf,cron,init); connect(wf,init,fetch); connect(wf,fetch,split); connect(wf,split,thresh); connect(wf,thresh,ifLow);
    connect(wf,ifLow,po,0); connect(wf,ifLow,alert,1);
  };

  // 12) REPLENISHMENT_PO
  T.REPLENISHMENT_PO = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const hook = addWebhook(wf,"Low-Stock Webhook",-1120,300);
    const init = addInit(wf, scenario, industry, channel, -880,300);
    const vendor= addFunction(wf,"Pick Supplier","return [$json];",-640,300);
    const create= addHTTP(wf,"Create PO (ERP)","={{'https://example.com/erp/po'}}","={{$json}}",-400,300);
    const appr  = addFunction(wf,"Approvals","return [$json];",-160,300);
    const update= addHTTP(wf,"Update WMS","={{'https://example.com/wms/update'}}","={{$json}}",100,300);
    connect(wf,hook,init); connect(wf,init,vendor); connect(wf,vendor,create); connect(wf,create,appr); connect(wf,appr,update);
  };

  // 13) FIELD_SERVICE_DISPATCH
  T.FIELD_SERVICE_DISPATCH = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const hook = addWebhook(wf,"Issue Intake",-1120,300);
    const init = addInit(wf, scenario, industry, channel, -880,300);
    const geo  = addFunction(wf,"Geo/Skills Match","return [$json];",-640,300);
    const assign=addHTTP(wf,"Assign Technician","={{'https://example.com/dispatch/assign'}}","={{$json}}",-400,300);
    const notify=addHTTP(wf,"Notify Tech & Customer","={{'https://example.com/notify'}}","={{$json}}",-160,300);
    const cal  = addHTTP(wf,"Calendar Booking","={{'https://example.com/calendar/book'}}","={{$json}}",100,300);
    connect(wf,hook,init); connect(wf,init,geo); connect(wf,geo,assign); connect(wf,assign,notify); connect(wf,notify,cal);
  };

  // 14) COMPLIANCE_AUDIT
  T.COMPLIANCE_AUDIT = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const cron = addCron(wf,"Cron (Audit Sweep)",-1100,140);
    const init = addInit(wf, scenario, industry, channel, -860,300);
    const fetch= addHTTP(wf,"Fetch Checklist","={{'https://example.com/compliance/list'}}","={{$json}}",-620,300);
    const validate=addFunction(wf,"Validate Controls","return [$json];",-380,300);
    const issues= addIf(wf,"Any Issues?","={{$json.issues}}","notEmpty","",-140,300);
    const report= addHTTP(wf,"Generate Report","={{'https://example.com/compliance/report'}}","={{$json}}",120,300);
    const notify= addHTTP(wf,"Notify Legal","={{'https://example.com/legal/notify'}}","={{$json}}",380,300);
    connect(wf,cron,init); connect(wf,init,fetch); connect(wf,fetch,validate); connect(wf,validate,issues);
    connect(wf,issues,report,0); connect(wf,report,notify); connect(wf,issues,notify,1);
  };

  // 15) INCIDENT_MGMT
  T.INCIDENT_MGMT = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const hook = addWebhook(wf,"Incident (Webhook)",-1120,300);
    const init = addInit(wf, scenario, industry, channel, -880,300);
    const sev  = addFunction(wf,"Severity Detect",`const t=String($json.title||'').toLowerCase();$json.sev = /sev[ -:]?1|critical|major/.test(t)?'high':'normal';return [$json];`,-640,300);
    const ifHigh = addIf(wf,"High Severity?","={{$json.sev}}","equal","high",-400,300);
    const comms= addHTTP(wf,"Incident Comms","={{'https://example.com/comms'}}","={{$json}}",-160,300);
    const ticket=addHTTP(wf,"Create Incident Ticket","={{'https://example.com/itsm/ticket'}}","={{$json}}",100,300);
    const pir  = addHTTP(wf,"Prep PIR Doc","={{'https://example.com/pir/create'}}","={{$json}}",360,300);
    connect(wf,hook,init); connect(wf,init,sev); connect(wf,sev,ifHigh);
    connect(wf,ifHigh,comms,0); connect(wf,comms,ticket); connect(wf,ifHigh,ticket,1);
    connect(wf,ticket,pir);
  };

  // 16) DATA_PIPELINE_ETL
  T.DATA_PIPELINE_ETL = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const cron = addCron(wf,"Cron (ETL)",-1100,140);
    const init = addInit(wf, scenario, industry, channel, -860,300);
    const extract = addHTTP(wf,"Extract","={{'https://example.com/extract'}}","={{$json}}",-620,300);
    const transform = addFunction(wf,"Transform","return [$json];",-380,300);
    const load = addHTTP(wf,"Load (DB/Sheets)","={{'https://example.com/load'}}","={{$json}}",-140,300);
    const status = addHTTP(wf,"Status/Alert","={{'https://example.com/alert'}}","={{$json}}",120,300);
    connect(wf,cron,init); connect(wf,init,extract); connect(wf,extract,transform); connect(wf,transform,load); connect(wf,load,status);
  };

  // 17) REPORTING_KPI_DASH
  T.REPORTING_KPI_DASH = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const cron = addCron(wf,"Cron (Reports)",-1100,140);
    const init = addInit(wf, scenario, industry, channel, -860,300);
    const metrics = addHTTP(wf,"Calculate Metrics","={{'https://example.com/metrics'}}","={{$json}}",-620,300);
    const dash = addHTTP(wf,"Render Dashboard","={{'https://example.com/dash/export'}}","={{$json}}",-380,300);
    const email = addHTTP(wf,"Send Email/Slack","={{'https://example.com/notify'}}","={{$json}}",-140,300);
    connect(wf,cron,init); connect(wf,init,metrics); connect(wf,metrics,dash); connect(wf,dash,email);
  };

  // 18) ACCESS_GOVERNANCE
  T.ACCESS_GOVERNANCE = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const hook = addWebhook(wf,"Access Request",-1120,300);
    const init = addInit(wf, scenario, industry, channel, -880,300);
    const ent = addFunction(wf,"Check Entitlements","return [$json];",-640,300);
    const appr = addFunction(wf,"Approval","return [$json];",-400,300);
    const prov = addHTTP(wf,"Provision/Deprovision","={{'https://example.com/iam/provision'}}","={{$json}}",-160,300);
    const log = addHTTP(wf,"Log Decision","={{'https://example.com/iam/log'}}","={{$json}}",100,300);
    connect(wf,hook,init); connect(wf,init,ent); connect(wf,ent,appr); connect(wf,appr,prov); connect(wf,prov,log);
  };

  // 19) PRIVACY_DSR
  T.PRIVACY_DSR = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const hook = addWebhook(wf,"DSR Intake",-1120,300);
    const init = addInit(wf, scenario, industry, channel, -880,300);
    const idv = addHTTP(wf,"Identity Verify (KYC)","={{'https://example.com/kyc'}}","={{$json}}",-640,300);
    const collect = addHTTP(wf,"Collect Data","={{'https://example.com/privacy/collect'}}","={{$json}}",-400,300);
    const respond = addHTTP(wf,"Respond to Subject","={{'https://example.com/privacy/respond'}}","={{$json}}",-160,300);
    const attest = addHTTP(wf,"Attest & Close","={{'https://example.com/privacy/attest'}}","={{$json}}",100,300);
    connect(wf,hook,init); connect(wf,init,idv); connect(wf,idv,collect); connect(wf,collect,respond); connect(wf,respond,attest);
  };

  // 20) RECRUITING_INTAKE
  T.RECRUITING_INTAKE = (wf, ctx) => {
    const { scenario, industry, channel } = ctx;
    const hook = addWebhook(wf,"Resume Intake",-1120,300);
    const init = addInit(wf, scenario, industry, channel, -880,300);
    const parse = addFunction(wf,"Parse Resume","return [$json];",-640,300);
    const score = addFunction(wf,"Score Candidate","return [$json];",-400,300);
    const stage = addSwitch(wf,"Stage Route","={{$json.stage||'phone'}}",[ {operation:"equal",value2:"phone"},{operation:"equal",value2:"onsite"} ],-160,300);
    const sched = addHTTP(wf,"Schedule Interview","={{'https://example.com/calendar/book'}}","={{$json}}",120,300);
    const ats = addHTTP(wf,"ATS Update","={{'https://example.com/ats/update'}}","={{$json}}",380,300);
    connect(wf,hook,init); connect(wf,init,parse); connect(wf,parse,score); connect(wf,score,stage);
    connect(wf,stage,sched,0); connect(wf,stage,ats,1); connect(wf,sched,ats);
  };

  // ---------------- builder ----------------
  function buildWorkflowJSON(scenario, industry, opts = {}) {
    const channel = String((opts.recommendedChannel || 'email')).toLowerCase();
    const wfName = `${scenario?.scenario_id || scenario?.title || 'AI Agent Workflow'} — ${industry?.name || industry?.industry_id || 'Industry'}`;
    const wf = baseWorkflow(wfName);

    // pick archetype: prefer API-provided, else fallback
    const archetype = scenario?.archetype || classifyFallback(scenario);
    const tmpl = T[archetype] || T.SALES_OUTREACH;

    const ctx = { scenario, industry, channel };
    tmpl(wf, ctx);
    return wf;
  }

  window.Builder = { buildWorkflowJSON };
})();
