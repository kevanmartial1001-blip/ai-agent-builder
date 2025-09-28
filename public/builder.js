// public/builder.js
// Two lanes per workflow: PRODUCTION (top) + DEMO (bottom), no overlap.
// Demo lane uses Manual Trigger + seeded test contacts; Prod lane uses real signal trigger.
// Archetype-aware message composer (uses scenario.triggers/how_it_works/roi_hypothesis + risk_notes + LLM plan).
// Import-safe: all If/Switch rule values are stringified to avoid n8n "toLowerCase" errors.
// Adds LLM planning: uses 4 "context" columns to propose trigger, channels, branches, tools, and error paths.
// In compat="full" it will call a planning endpoint; in compat="safe" it synthesizes a plan locally.
// Attach global: window.Builder = { buildWorkflowJSON }

(function () {
  "use strict";

  // ---------------- basics ----------------
  const QS = new URLSearchParams(location.search);
  const compat = (QS.get("compat") || "safe").toLowerCase() === "full" ? "full" : "safe";
  const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
  const pos = (x, y) => [x, y];
  const listify = (v) =>
    Array.isArray(v)
      ? v.map((x) => String(x).trim()).filter(Boolean)
      : String(v || "")
          .split(/[;,\n|]+/).map((x) => x.trim()).filter(Boolean);

  function baseWorkflow(name) {
    return { name, nodes: [], connections: {}, active: false, settings: {}, staticData: {}, __yOffset: 0 };
  }

  function addNode(wf, node) {
    if (Array.isArray(node.position) && node.position.length === 2) {
      node.position = [node.position[0], node.position[1] + (wf.__yOffset || 0)];
    }
    wf.nodes.push(node);
    return node.name;
  }

  function connect(wf, from, to, outputIndex = 0) {
    wf.connections[from] ??= { main: [] };
    while (wf.connections[from].main.length <= outputIndex) {
      wf.connections[from].main.push([]);
    }
    wf.connections[from].main[outputIndex].push({ node: to, type: "main", index: 0 });
  }

  function withYOffset(wf, yOffset, fn) {
    const prev = wf.__yOffset || 0;
    wf.__yOffset = yOffset;
    try { fn(); } finally { wf.__yOffset = prev; }
  }

  // ---------------- shared nodes ----------------
  function addLaneHeader(wf, label, x = -1320, y = 40) {
    return addNode(wf, {
      id: uid("label"),
      name: `=== ${label} ===`,
      type: "n8n-nodes-base.function",
      typeVersion: 2,
      position: pos(x, y),
      parameters: { functionCode: "return [$json];" },
    });
  }

  function addManual(wf, x = -1180, y = 300, label = "Manual Trigger") {
    return addNode(wf, {
      id: uid("manual"),
      name: label,
      type: "n8n-nodes-base.manualTrigger",
      typeVersion: 1,
      position: pos(x, y),
      parameters: {},
    });
  }
  function addCron(wf, label = "Cron (15m)", x = -1180, y = 140) {
    if (compat === "full") {
      return addNode(wf, {
        id: uid("cron"),
        name: label,
        type: "n8n-nodes-base.cron",
        typeVersion: 1,
        position: pos(x, y),
        parameters: { triggerTimes: { item: [{ mode: "everyX", everyX: { hours: 0, minutes: 15 } }] } },
      });
    }
    return addNode(wf, {
      id: uid("cronph"),
      name: `${label} (Placeholder)`,
      type: "n8n-nodes-base.function",
      typeVersion: 2,
      position: pos(x, y),
      parameters: { functionCode: "return [$json];" },
    });
  }
  function addWebhook(wf, label = "Webhook (Incoming)", x = -1180, y = 300) {
    if (compat === "full") {
      return addNode(wf, {
        id: uid("webhook"),
        name: label,
        type: "n8n-nodes-base.webhook",
        typeVersion: 1,
        position: pos(x, y),
        parameters: { path: uid("hook"), methods: ["POST"], responseMode: "onReceived" },
      });
    }
    return addNode(wf, {
      id: uid("webph"),
      name: `${label} (Placeholder)`,
      type: "n8n-nodes-base.function",
      typeVersion: 2,
      position: pos(x, y),
      parameters: { functionCode: "return [$json];" },
    });
  }
  function addHTTP(wf, name, urlExpr, bodyExpr, x, y, method = "POST") {
    return addNode(wf, {
      id: uid("http"),
      name,
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4,
      position: pos(x, y),
      parameters: { url: urlExpr, method, jsonParameters: true, sendBody: true, bodyParametersJson: bodyExpr },
    });
  }
  function addFunction(wf, name, code, x, y) {
    return addNode(wf, {
      id: uid("func"),
      name,
      type: "n8n-nodes-base.function",
      typeVersion: 2,
      position: pos(x, y),
      parameters: { functionCode: code },
    });
  }
  function addIf(wf, name, left, op, right, x, y) {
    return addNode(wf, {
      id: uid("if"),
      name,
      type: "n8n-nodes-base.if",
      typeVersion: 2,
      position: pos(x, y),
      parameters: {
        conditions: {
          number: [],
          string: [{ value1: left, operation: op, value2: String(right ?? "") }],
        },
      },
    });
  }
  function addSwitch(wf, name, valueExpr, rules, x, y) {
    const safeRules = (rules || []).map((r) => ({
      operation: r.operation || "equal",
      value2: String(r.value2 ?? ""),
    }));
    return addNode(wf, {
      id: uid("switch"),
      name,
      type: "n8n-nodes-base.switch",
      typeVersion: 2,
      position: pos(x, y),
      parameters: { value1: valueExpr, rules: safeRules },
    });
  }
  function addMerge(wf, name, x, y, mode = "append") {
    return addNode(wf, {
      id: uid("merge"),
      name,
      type: "n8n-nodes-base.merge",
      typeVersion: 2,
      position: pos(x, y),
      parameters: { mode },
    });
  }
  function addSplit(wf, x, y, size = 20) {
    return addNode(wf, {
      id: uid("split"),
      name: "Split In Batches",
      type: "n8n-nodes-base.splitInBatches",
      typeVersion: 1,
      position: pos(x, y),
      parameters: { batchSize: size },
    });
  }

  // ---------------- context extractor ----------------
  function buildContextObj(s) {
    const out = {
      triggers: String(s?.triggers || "").trim(),
      best_reply_shapes: listify(s?.best_reply_shapes || []),
      risk_notes: String(s?.risk_notes || "").trim(),
      roi_hypothesis: String(s?.roi_hypothesis || "").trim(),
    };
    out.summary = [
      out.triggers && `Triggers: ${out.triggers}`,
      out.best_reply_shapes?.length && `Shapes: ${out.best_reply_shapes.join(", ")}`,
      out.risk_notes && `Risks: ${out.risk_notes}`,
      out.roi_hypothesis && `ROI: ${out.roi_hypothesis}`,
    ].filter(Boolean).join(" | ");
    return out;
  }

  // ---------------- demo/init/collector ----------------
  function addInit(wf, scenario, industry, primaryChannel, demoFlag = true, x = -920, y = 300, archetypeName = null) {
    const seed = {
      demo: !!demoFlag,
      to: "+34613030526",
      emailTo: "kevanm.spain@gmail.com",
      smsFrom: "+13412184164",
      waFrom: "+14155238886",
      callFrom: "+13412184164",
      callWebhook: "https://example.com/call",
      recommendedChannel: primaryChannel || "email",
      archetype: archetypeName || scenario?.archetype || "UNKNOWN",
      scenario,
      industry,
      context: buildContextObj(scenario),
      // Planning endpoint overridable at runtime:
      llmPlanUrl: "https://example.com/llm/plan"
    };
    return addNode(wf, {
      id: uid("init"),
      name: demoFlag ? "Init Context (Demo Seeds)" : "Init Context",
      type: "n8n-nodes-base.function",
      typeVersion: 2,
      position: pos(x, y),
      parameters: { functionCode: `const seed=${JSON.stringify(seed, null, 2)}; return [seed];` },
    });
  }

  function addCollector(wf, x = 1600, y = 300) {
    return addFunction(
      wf,
      "Collector (Inspect)",
      `
const now=new Date().toISOString();
const arr=Array.isArray(items)?items:[{json:$json}];
return arr.map((it,i)=>({json:{...it.json,__collected_at:now, index:i}}));`,
      x,
      y
    );
  }

  // ---------------- LLM planning (schema map) ----------------
  function addLLMPlan(wf, x = -700, y = 220) {
    if (compat === "full") {
      // Call your planning backend; expects { plan, messages? }
      return addHTTP(
        wf,
        "LLM Plan (Schema Map)",
        "={{$json.llmPlanUrl || 'https://example.com/llm/plan'}}",
        `={{{
  industry: $json.industry,
  scenario: $json.scenario,
  context: $json.context,
  want: {
    trigger: true,
    channels: true,
    branches: true,
    tools: true,
    errors: true,
    messages: true
  }
}}}`,
        x,
        y,
        "POST"
      );
    }
    // Safe-mode synthesizer (no external calls)
    return addFunction(
      wf,
      "LLM Plan (Synthesize)",
      `
const ctx = $json.context||{};
const scen = $json.scenario||{};
const text = (k)=>String(scen[k]||'').toLowerCase();
let trigger='manual';
if(/real[- ]?time|webhook|event|incoming/.test(ctx.triggers||'')) trigger='webhook';
else if(/daily|weekly|monthly|cron|every\\s+\\d+\\s*(min|hour|day)/.test(ctx.triggers||'')) trigger='cron';

const channelsGuess = (ctx.best_reply_shapes||[]).map(s=>String(s).toLowerCase()).map(s=>
  s.includes('whatsapp')?'whatsapp' : s.includes('sms')||s.includes('text')?'sms' :
  s.includes('voice')||s.includes('call')?'call' : 'email'
);
const uniq = (a)=>Array.from(new Set(a));
const channels = uniq(channelsGuess.length?channelsGuess:['email']);

const tools = { crm: 'CRM', messaging: 'MAILING', telephony: 'TELCO', kb: 'KB', bi: 'BI' };
const errors = [
  { code:'AUTH_MISSING', hint:'Credential not connected' },
  { code:'RATE_LIMIT', hint:'Backoff + retry with jitter' },
  { code:'INVALID_INPUT', hint:'Validate/normalize input fields' }
];

const messages = {
  defaults: { tone:'natural-professional', avoid:'robotic menus' }
};

const branches = [
  { id:'happy_path', title:'Happy Path', steps:['compose','send','update_crm'] },
  { id:'error_path', title:'Error Path', steps:['log_error','notify_ops'] }
];

return [{ plan:{ trigger, channels, tools, errors, branches }, messages }];
`,
      x,
      y
    );
  }

  function addAdoptPlan(wf, x = -460, y = 220) {
    return addFunction(
      wf,
      "Adopt Plan → JSON",
      `
const p = $json.plan || $json.body || $json.data || {};
const plan = p.plan || ($json.plan ? $json.plan : p);
const messages = p.messages || $json.messages || {};
let channels = Array.isArray(plan?.channels) && plan.channels.length ? plan.channels : ($json.channels||[]);
if (!channels || !channels.length) channels = ['email'];
const recommendedChannel = channels[0];

return [{
  ...$json,
  plan,
  messages,
  channels,
  recommendedChannel,
  // Honor plan trigger if present
  trigger: plan?.trigger || $json.trigger || 'manual'
}];
`,
      x,
      y
    );
  }

  // ---------------- channels (demo-aware) ----------------
  function demoLeaf(label) {
    return (wf, x, y) =>
      addFunction(
        wf,
        `Demo Send ${label}`,
        `
const d=$json;
const payload={
  channel: '${label.toLowerCase()}',
  to:d.to, emailTo:d.emailTo, smsFrom:d.smsFrom, waFrom:d.waFrom, callFrom:d.callFrom,
  message:d.message||'(no message)'
};
return [payload];`,
        x,
        y
      );
  }

  function addEmailNode(wf, x, y) {
    if (compat === "full")
      return addNode(wf, {
        id: uid("email"),
        name: "Send Email",
        type: "n8n-nodes-base.emailSend",
        typeVersion: 3,
        position: pos(x, y),
        parameters: {
          to: "={{$json.emailTo}}",
          subject: "={{$json.subject || $json.scenario?.agent_name || 'AI Outreach'}}",
          text: "={{$json.message}}"
        },
        credentials: {} // Select real or demo creds in n8n UI
      });
    return demoLeaf("Email")(wf, x, y);
  }
  function addSMSNode(wf, x, y) {
    if (compat === "full")
      return addNode(wf, {
        id: uid("sms"),
        name: "Send SMS (Twilio)",
        type: "n8n-nodes-base.twilio",
        typeVersion: 3,
        position: pos(x, y),
        parameters: { resource: "message", operation: "create", from: "={{$json.smsFrom}}", to: "={{$json.to}}", message: "={{$json.message}}" },
        credentials: {}
      });
    return demoLeaf("SMS")(wf, x, y);
  }
  function addWANode(wf, x, y) {
    if (compat === "full")
      return addNode(wf, {
        id: uid("wa"),
        name: "Send WhatsApp (Twilio)",
        type: "n8n-nodes-base.twilio",
        typeVersion: 3,
        position: pos(x, y),
        parameters: {
          resource: "message",
          operation: "create",
          from: "={{'whatsapp:' + ($json.waFrom)}}",
          to: "={{'whatsapp:' + ($json.to)}}",
          message: "={{$json.message}}",
        },
        credentials: {}
      });
    return demoLeaf("WhatsApp")(wf, x, y);
  }
  function addCallNode(wf, x, y) {
    if (compat === "full")
      return addNode(wf, {
        id: uid("call"),
        name: "Place Call (HTTP/Provider)",
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 4,
        position: pos(x, y),
        parameters: {
          url: "={{$json.callWebhook}}",
          method: "POST",
          jsonParameters: true,
          sendBody: true,
          bodyParametersJson: "={{ { to:$json.to, from:$json.callFrom, text:$json.message } }}"
        },
      });
    return demoLeaf("Call")(wf, x, y);
  }

  const CHANNEL_BUILDERS = { email: addEmailNode, sms: addSMSNode, whatsapp: addWANode, call: addCallNode };

  // ---------------- derive signals (static fallback) ----------------
  function deriveSignals(scenario) {
    const text = (k) => String(scenario[k] || "").toLowerCase();
    const inText = (k, ...rxs) => rxs.some((rx) => new RegExp(rx, "i").test(text(k)));

    let trigger = "manual";
    if (inText("triggers", "daily|weekly|monthly|cron|every \\d+ (min|hour|day)")) trigger = "cron";
    if (inText("triggers", "real[- ]?time|webhook|event|callback|incoming")) trigger = "webhook";
    if (inText("triggers", "email|inbox|imap")) trigger = "imap";

    const tools = (text("tool_stack_dev") + " " + text("how_it_works")).toLowerCase();
    const systems = {
      pms: /dentrix|opendental|eaglesoft|pms/.test(tools),
      crm: /crm|hubspot|salesforce|pipedrive/.test(tools),
      wms: /wms|warehouse|3pl/.test(tools),
      erp: /erp|netsuite|sap|oracle/.test(tools),
      accounting: /quickbooks|xero|stripe|billing/.test(tools),
      ats: /ats|greenhouse|lever/.test(tools),
      calendar: /calendar|google calendar|calendly|outlook/.test(tools),
      slack: /slack/.test(tools),
      kb: /kb|knowledge[- ]?base|confluence|notion/.test(tools),
      bi: /bi|dashboard|kpi|scorecard/.test(tools),
      iam: /iam|sso|rbac|entitlements?/.test(tools),
      privacy: /privacy|dsr|gdpr|ccpa|dlp/.test(tools),
    };
    const features = {
      waitlist: /waitlist|backfill|fill cancellations/.test(tools),
      dedupe: /dedup|dedupe/.test(tools),
      enrich: /enrich|enrichment|clearbit|apollo|zoominfo/.test(tools),
      score: /score|scoring|priority|risk/.test(tools),
      buckets_30_60_90: /30.?60.?90|aging/.test(tools),
      three_way_match: /3[- ]?way|three[- ]?way/.test(tools),
      approvals: /approval|sign[- ]?off|legal review|finance review/.test(tools),
      geo_route: /geo|route|eta|technician|dispatch/.test(tools),
      faq_search: /faq|kb search|deflection/.test(tools),
      survey: /nps|csat|survey/.test(tools),
      identity_verify: /kyc|identity|verify/.test(tools),
      severity: /sev|incident|outage|downtime|uptime|slo/.test(tools),
      kpi_calc: /kpi|metrics|scorecard|report/.test(tools),
    };

    const shapes = listify(scenario.best_reply_shapes || []);
    const norm = (s) => String(s || "").toLowerCase();
    const chan = shapes
      .map(norm)
      .map((s) =>
        s.includes("whatsapp")
          ? "whatsapp"
          : s.includes("sms") || s.includes("text")
          ? "sms"
          : s.includes("voice") || s.includes("call")
          ? "call"
          : s.includes("email")
          ? "email"
          : s
      )
      .filter(Boolean);
    const channels = [...new Set(chan)];
    const cadence = channels.length >= 3 ? "drip3" : channels.length === 2 ? "drip2" : "single";

    return { trigger, systems, features, channels, cadence };
  }

  // ---------------- triggers ----------------
  function addTriggerBySignals(wf, sig, x = -1180) {
    switch (sig.trigger) {
      case "cron":    return addCron(wf, "Cron (from triggers)", x, 140);
      case "webhook": return addWebhook(wf, "Webhook (from triggers)", x, 300);
      case "imap":    return addFunction(wf, "IMAP Intake (Placeholder)", "return [$json];", x, 300);
      default:        return addManual(wf, x, 300, "Manual Trigger");
    }
  }

  // ---------------- message composer (context + plan aware) ----------------
  function composeMessageFunctionBody() {
    return `
const s = $json.scenario || {};
const ind = $json.industry || {};
const archetype = String($json.archetype || '').toUpperCase();
const ch = String($json.recommendedChannel || 'email').toLowerCase();
const ctx = $json.context || {};
const plan = $json.plan || {};
const planMsgs = ($json.messages && $json.messages.bundles) || ($json.messages || {});
const trim = (t, n=240) => (String(t||'').replace(/\\s+/g,' ').trim()).slice(0,n);
const line = (lbl, v) => v ? \`\${lbl}: \${trim(v)}\\n\` : '';
const emoji = { email:'📧', sms:'📱', whatsapp:'🟢', call:'📞' }[ch] || '💬';
const industryLine = ind.name || ind.industry_id ? \`Industry: \${ind.name||ind.industry_id}\\n\` : '';

const triggers = trim(ctx.triggers || s.triggers, 200);
const how = trim(s.how_it_works, 260);
const roi = trim(ctx.roi_hypothesis || s.roi_hypothesis, 180);
const risks = trim(ctx.risk_notes, 160);

const openers = { email: 'Hi there — quick note:', sms: 'Quick update:', whatsapp: 'Heads up:', call: 'Talk track:' };
const cta = { email: 'Reply or click the link to confirm.', sms: 'Reply with 1 to confirm, 2 to reschedule.', whatsapp: 'Reply here to confirm or change.', call: 'Confirm during IVR or say “reschedule”.' };

function pickFromPlan(kind){
  try {
    const b = planMsgs[kind];
    if (!b) return null;
    const arr = Array.isArray(b) ? b : (Array.isArray(b?.[ch]) ? b[ch] : null);
    if (!arr || !arr.length) return null;
    return String(arr[0]);
  } catch(e){ return null; }
}

function msgScheduling(){
  const fromPlan = pickFromPlan('APPOINTMENT_SCHEDULING');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}\${line('Why now', triggers)}\${line('Plan', how)}\${roi?line('Impact', roi):''}\${risks?line('Keep in mind', risks):''}\\n\${cta[ch]}\`;
}
function msgSupport(){
  const fromPlan = pickFromPlan('CUSTOMER_SUPPORT_INTAKE');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}We received your request and created a ticket.\\n\${line('Context', triggers)}\${line('What happens next', how)}Priority auto-routed by SLA/VIP.\\n\${cta[ch]}\`;
}
function msgNps(){
  const fromPlan = pickFromPlan('FEEDBACK_NPS');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}We’d value your feedback after the recent interaction.\\n\${line('Context', triggers)}\${roi?line('Why this matters', roi):''}Please rate us 0–10: link enclosed.\\nThanks!\`;
}
function msgFaq(){
  const fromPlan = pickFromPlan('KNOWLEDGEBASE_FAQ');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}\${line('We found an answer', how || 'Your question matches our knowledge base.')}\${cta[ch]}\`;
}
function msgSales(){
  const fromPlan = pickFromPlan('SALES_OUTREACH');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}\${line('Problem we solve', triggers)}\${line('How it works', how)}\${roi?line('Expected ROI', roi):''}\\nInterested in a quick demo?\`;
}
function msgLeadQual(){
  const fromPlan = pickFromPlan('LEAD_QUAL_INBOUND');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}Got your details — qualifying now.\\n\${line('Form intent', triggers)}If you’re ready, grab a time on the calendar.\`;
}
function msgChurn(){
  const fromPlan = pickFromPlan('CHURN_WINBACK');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}\${line('We noticed inactivity', triggers)}\${line('What you’ll get back', roi)}Reply to re-activate or claim an offer.\`;
}
function msgRenewals(){
  const fromPlan = pickFromPlan('RENEWALS_CSM');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}Your renewal is coming up.\\n\${line('Usage summary', triggers)}\${line('Success plan', how)}\${roi?line('Outcomes', roi):''}Shall we book a QBR?\`;
}
function msgAR(){
  const fromPlan = pickFromPlan('AR_FOLLOWUP');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}Friendly reminder: an invoice is past due.\\n\${line('Context', triggers)}\${line('Resolution path', how)}If there’s a dispute, reply “dispute”.\`;
}
function msgAP(){
  const fromPlan = pickFromPlan('AP_AUTOMATION');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}We received an invoice.\\n\${line('Matching rules', how)}Exceptions go to approval.\\nYou’ll get a confirmation once paid.\`;
}
function msgInventory(){
  const fromPlan = pickFromPlan('INVENTORY_MONITOR');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}Low stock detected on key SKUs.\\n\${line('Signal', triggers)}\${line('Replenishment flow', how)}We can auto-raise a PO if approved.\`;
}
function msgReplenishment(){
  const fromPlan = pickFromPlan('REPLENISHMENT_PO');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}Low-stock event — preparing PO.\\n\${line('Selection logic', how)}Approve to release the order.\`;
}
function msgDispatch(){
  const fromPlan = pickFromPlan('FIELD_SERVICE_DISPATCH');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}We’re assigning a technician now.\\n\${line('Routing logic', how)}You’ll receive ETA + calendar invite.\`;
}
function msgCompliance(){
  const fromPlan = pickFromPlan('COMPLIANCE_AUDIT');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}Compliance sweep in progress.\\n\${line('Controls', how)}Issues will be reported with remediation steps.\`;
}
function msgIncident(){
  const fromPlan = pickFromPlan('INCIDENT_MGMT');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}Incident triage active.\\n\${line('Detection', triggers)}\${line('Runbook', how)}High severity routes to on-call.\`;
}
function msgETL(){
  const fromPlan = pickFromPlan('DATA_PIPELINE_ETL');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}Data pipeline execution.\\n\${line('Source → Transform', how || triggers)}You’ll get status + load confirmation.\`;
}
function msgReporting(){
  const fromPlan = pickFromPlan('REPORTING_KPI_DASH');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}Reporting job complete.\\n\${line('KPIs', triggers || how)}Dashboard export is attached/linked.\`;
}
function msgAccess(){
  const fromPlan = pickFromPlan('ACCESS_GOVERNANCE');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}Access request received.\\n\${line('Entitlements check', how)}Awaiting approval before provisioning.\`;
}
function msgPrivacy(){
  const fromPlan = pickFromPlan('PRIVACY_DSR');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}We received your data subject request.\\n\${line('Verification', how)}We’ll respond within the required window.\`;
}
function msgRecruiting(){
  const fromPlan = pickFromPlan('RECRUITING_INTAKE');
  if (fromPlan) return fromPlan;
  return \`\${emoji} \${openers[ch]}\\n\${industryLine}Thanks for applying — reviewing your details now.\\n\${line('Screening', how)}We’ll reach out to book an interview.\`;
}

let body;
switch(String($json.archetype||'').toUpperCase()){
  case 'APPOINTMENT_SCHEDULING': body = msgScheduling(); break;
  case 'CUSTOMER_SUPPORT_INTAKE': body = msgSupport(); break;
  case 'FEEDBACK_NPS': body = msgNps(); break;
  case 'KNOWLEDGEBASE_FAQ': body = msgFaq(); break;
  case 'SALES_OUTREACH': body = msgSales(); break;
  case 'LEAD_QUAL_INBOUND': body = msgLeadQual(); break;
  case 'CHURN_WINBACK': body = msgChurn(); break;
  case 'RENEWALS_CSM': body = msgRenewals(); break;
  case 'AR_FOLLOWUP': body = msgAR(); break;
  case 'AP_AUTOMATION': body = msgAP(); break;
  case 'INVENTORY_MONITOR': body = msgInventory(); break;
  case 'REPLENISHMENT_PO': body = msgReplenishment(); break;
  case 'FIELD_SERVICE_DISPATCH': body = msgDispatch(); break;
  case 'COMPLIANCE_AUDIT': body = msgCompliance(); break;
  case 'INCIDENT_MGMT': body = msgIncident(); break;
  case 'DATA_PIPELINE_ETL': body = msgETL(); break;
  case 'REPORTING_KPI_DASH': body = msgReporting(); break;
  case 'ACCESS_GOVERNANCE': body = msgAccess(); break;
  case 'PRIVACY_DSR': body = msgPrivacy(); break;
  case 'RECRUITING_INTAKE': body = msgRecruiting(); break;
  default: body = msgSales();
}
const subject = s.agent_name ? \`\${s.agent_name} — \${s.scenario_id||''}\` : (s.title||s.scenario_id||'AI Workflow');
return [{ message: body, subject }];
`;
  }

  function addCadence(wf, fromNodeName, channels, xStart = 300, y = 300) {
    let prev = fromNodeName;
    const dx = 260;
    (channels || []).forEach((ch, i) => {
      const builder = CHANNEL_BUILDERS[ch] || CHANNEL_BUILDERS.email;
      const node = builder(wf, xStart + dx * (i + 1), y);
      connect(wf, prev, node);
      prev = node;
    });
    return prev;
  }

  // ---------------- classifier fallback ----------------
  const RULES = [
    { a: "APPOINTMENT_SCHEDULING", inc: [/appointment|appointments|scheduling|no[-_ ]?show|calendar/i] },
    { a: "CUSTOMER_SUPPORT_INTAKE", inc: [/\b(cs|support|helpdesk|ticket|sla|triage|escalation|deflection|kb)\b/i] },
    { a: "FEEDBACK_NPS", inc: [/\b(nps|survey|surveys|feedback|csat|ces)\b/i] },
    { a: "KNOWLEDGEBASE_FAQ", inc: [/\b(kb|faq|knowledge|self-?service)\b/i], exc: [/ticket|escalation/i] },
    { a: "SALES_OUTREACH", inc: [/\b(sales|outreach|cadence|sequence|abm|prospect|cold[-_ ]?email)\b/i] },
    { a: "LEAD_QUAL_INBOUND", inc: [/\b(inbound|lead[-_ ]?qual|qualification|routing|router|forms?)\b/i] },
    { a: "CHURN_WINBACK", inc: [/\b(churn|win[-_ ]?back|reactivation|retention|loyalty)\b/i] },
    { a: "RENEWALS_CSM", inc: [/\b(renewal|qbr|success|csm|upsell|cross-?sell)\b/i] },
    { a: "AR_FOLLOWUP", inc: [/\b(a\/?r|accounts?\s*receivable|invoice|collections?|dso|reconciliation)\b/i] },
    { a: "AP_AUTOMATION", inc: [/\b(a\/?p|accounts?\s*payable|invoices?|3[-\s]?way|three[-\s]?way|matching|approvals?)\b/i] },
    { a: "INVENTORY_MONITOR", inc: [/\b(inventory|stock|sku|threshold|warehouse|3pl|wms|backorder)\b/i] },
    { a: "REPLENISHMENT_PO", inc: [/\b(replenishment|purchase[-_ ]?order|po|procure|procurement|vendors?|suppliers?)\b/i] },
    { a: "FIELD_SERVICE_DISPATCH", inc: [/\b(dispatch|work[-_ ]?orders?|technicians?|field|geo|eta|route|yard)\b/i] },
    { a: "COMPLIANCE_AUDIT", inc: [/\b(compliance|audit|audits|policy|governance|sox|iso|gdpr|hipaa|attestation)\b/i] },
    { a: "INCIDENT_MGMT", inc: [/\b(incident|sev[: ]?(high|p[12])|major|rca|postmortem|downtime|uptime|slo)\b/i] },
    { a: "DATA_PIPELINE_ETL", inc: [/\b(etl|pipeline|ingest|transform|load|csv|s3|gcs|orchestration)\b/i] },
    { a: "REPORTING_KPI_DASH", inc: [/\b(dashboard|dashboards|kpi|scorecard|report|reporting)\b/i] },
    { a: "ACCESS_GOVERNANCE", inc: [/\b(access|rbac|sso|entitlements|seats|identity|pii|dlp)\b/i] },
    { a: "PRIVACY_DSR", inc: [/\b(dsr|data\s*subject|privacy\s*request|gdpr|ccpa)\b/i] },
    { a: "RECRUITING_INTAKE", inc: [/\b(recruit(ing)?|ats|cv|resume|candidate|interviews?)\b/i] },
  ];
  function classifyFallback(s) {
    const hay = [String(s.scenario_id || ""), String(s.name || ""), ...(Array.isArray(s.tags) ? s.tags : listify(s.tags))]
      .join(" ").toLowerCase();
    for (const r of RULES) {
      const match = r.inc?.some((rx) => rx.test(hay));
      const blocked = r.exc?.some((rx) => rx.test(hay));
      if (match && !blocked) return r.a;
    }
    return "SALES_OUTREACH";
  }

  // ------------------- archetype templates -------------------
  const T = {};
  const addCompose = (wf, x, y) => addFunction(wf, "Compose Message", composeMessageFunctionBody(), x, y);

  // Helper: inject LLM planning early in each template
  function planChain(wf, entryName, x = -700, y = 220) {
    const plan = addLLMPlan(wf, x, y);
    connect(wf, entryName, plan);
    const adopt = addAdoptPlan(wf, x + 240, y);
    connect(wf, plan, adopt);
    return adopt; // downstream can use $json.plan, $json.channels, $json.recommendedChannel
  }

  // 1) APPOINTMENT_SCHEDULING
  T.APPOINTMENT_SCHEDULING = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "APPOINTMENT_SCHEDULING";
    if (forceTrigger) sig.trigger = forceTrigger;
    const trig = addTriggerBySignals(wf, sig, -1180);
    const init = addInit(wf, scenario, industry, sig.channels[0] || "sms", !!demo, -940, 300, arch);
    connect(wf, trig, init);

    const adopt = planChain(wf, init, -700, 220);

    const fetch = addHTTP(wf, "Fetch Upcoming (PMS)", "={{$json.pms_upcoming || 'https://example.com/pms/upcoming'}}", "={{$json}}", -700, 300);
    connect(wf, adopt, fetch);
    const split = addSplit(wf, -460, 300);
    connect(wf, fetch, split);
    const personalize = addCompose(wf, -220, 300);
    connect(wf, split, personalize);

    const ch = (sig.channels.length ? sig.channels : ["sms","email"]);
    const lastSend = addCadence(wf, personalize, ch, 20, 300);

    let post = lastSend;
    if (sig.features.waitlist) {
      const detectCancel = addIf(wf, "Canceled?", "={{$json.status}}", "equal", "canceled", 20, 140);
      connect(wf, lastSend, detectCancel);
      const backfill = addHTTP(wf, "Backfill from Waitlist", "={{$json.waitlist_url || 'https://example.com/waitlist/fill'}}", "={{$json}}", 280, 140);
      const confirm = addHTTP(wf, "Update PMS (Confirm)", "={{$json.pms_update || 'https://example.com/pms/update'}}", "={{$json}}", 540, 140);
      connect(wf, detectCancel, backfill, 0);
      connect(wf, backfill, confirm);
      const confirm2 = addHTTP(wf, "Update PMS (Confirm)", "={{$json.pms_update || 'https://example.com/pms/update'}}", "={{$json}}", 280, 300);
      connect(wf, detectCancel, confirm2, 1);
      post = confirm2;
    } else {
      post = addHTTP(wf, "Update PMS (Confirm)", "={{$json.pms_update || 'https://example.com/pms/update'}}", "={{$json}}", 280, 300);
      connect(wf, lastSend, post);
    }
    if (sig.systems.slack) {
      const sum = addHTTP(wf, "Slack Daily Summary", "={{'https://example.com/slack/summary'}}", "={{$json}}", 540, 300);
      connect(wf, post, sum);
      post = sum;
    }
    const col = addCollector(wf, 820, 300);
    connect(wf, post, col);
  };

  // 2) CUSTOMER_SUPPORT_INTAKE
  T.CUSTOMER_SUPPORT_INTAKE = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "CUSTOMER_SUPPORT_INTAKE";
    if (forceTrigger) sig.trigger = forceTrigger;
    const trig = addTriggerBySignals(wf, sig, -1180);
    const init = addInit(wf, scenario, industry, sig.channels[0] || "email", !!demo, -940, 300, arch);
    connect(wf, trig, init);

    const adopt = planChain(wf, init, -700, 220);

    let entry = adopt;
    if (sig.features.faq_search || sig.systems.kb) {
      const kb = addHTTP(wf, "KB Search", "={{'https://example.com/kb/search'}}", "={{$json}}", -700, 300);
      const found = addIf(wf, "Found Answer?", "={{$json.kbHit || $json.answer}}", "notEmpty", "", -460, 300);
      connect(wf, adopt, kb);
      connect(wf, kb, found);
      const defl = addCompose(wf, -220, 200);
      connect(wf, found, defl, 0);
      const deflSend = addCadence(wf, defl, sig.channels.slice(0,1).length ? sig.channels.slice(0,1) : ["email"], 20, 200);
      const merge = addMerge(wf, "Merge (Deflection/Ticket)", 260, 260, "append");
      connect(wf, deflSend, merge);
      entry = addFunction(wf, "No KB Hit → Ticket", "return [$json];", -220, 380);
      connect(wf, found, entry, 1);
      connect(wf, entry, merge);
      entry = merge;
    }

    const classify = addFunction(
      wf,
      "Classify SLA/VIP",
      `
const t=($json.message||$json.body||'').toLowerCase();
const vip=/vip|priority|enterprise/.test(t); const sla=/sev[ -:]?1|urgent|outage/.test(t)?'high':'normal';
return [{...$json,vip,sla}];`,
      520,
      300
    );
    connect(wf, entry, classify);
    const gate = addIf(wf, "High SLA / VIP?", "={{$json.sla}}", "equal", "high", 760, 300);
    connect(wf, classify, gate);
    const esc = addHTTP(wf, "Escalate (Slack/Pager)", "={{'https://example.com/escalate'}}", "={{$json}}", 1000, 200);
    connect(wf, gate, esc, 0);
    const create = addHTTP(wf, "Create Ticket", "={{'https://example.com/ticket/create'}}", "={{$json}}", 1000, 380);
    connect(wf, gate, create, 1);
    connect(wf, esc, create);
    const ack = addCadence(wf, create, sig.channels.slice(0,1).length ? sig.channels.slice(0,1) : ["email"], 1260, 300);
    const col = addCollector(wf, 1540, 300);
    connect(wf, ack, col);
  };

  // 3) FEEDBACK_NPS
  T.FEEDBACK_NPS = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "FEEDBACK_NPS";
    const cronOrTrig = addTriggerBySignals(wf, forceTrigger ? { trigger: forceTrigger } : { trigger: "cron" }, -1180);
    const init = addInit(wf, scenario, industry, sig.channels[0] || "email", !!demo, -940, 300, arch);
    connect(wf, cronOrTrig, init);

    const adopt = planChain(wf, init, -700, 220);

    const mk = addHTTP(wf, "Create NPS Link", "={{$json.nps || 'https://example.com/nps/create'}}", "={{$json}}", -700, 300);
    connect(wf, adopt, mk);
    const comp = addCompose(wf, -460, 300);
    connect(wf, mk, comp);
    const sendLast = addCadence(wf, comp, sig.channels.length ? sig.channels : ["email", "sms"], -200, 300);
    const hook = addWebhook(wf, "NPS Response (Webhook)", 60, 300);
    connect(wf, sendLast, hook);
    const agg = addFunction(wf, "Aggregate Scores", "const n=Number($json.score||$json.nps||0);return [{score:n||0}];", 320, 300);
    const rpt = addHTTP(wf, "Report to BI", "={{'https://example.com/bi/nps'}}", "={{$json}}", 580, 300);
    connect(wf, hook, agg);
    connect(wf, agg, rpt);
    const col = addCollector(wf, 860, 300);
    connect(wf, rpt, col);
  };

  // 4) KNOWLEDGEBASE_FAQ
  T.KNOWLEDGEBASE_FAQ = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "KNOWLEDGEBASE_FAQ";
    if (forceTrigger) sig.trigger = forceTrigger;
    const trig = addTriggerBySignals(wf, { trigger: "webhook" }, -1180);
    const init = addInit(wf, scenario, industry, sig.channels[0] || "email", !!demo, -940, 300, arch);
    connect(wf, trig, init);

    const adopt = planChain(wf, init, -700, 220);

    const search = addHTTP(wf, "KB Search", "={{'https://example.com/kb/search'}}", "={{$json}}", -700, 300);
    connect(wf, adopt, search);
    const found = addIf(wf, "Found Answer?", "={{$json.kbHit || $json.answer}}", "notEmpty", "", -460, 300);
    connect(wf, search, found);
    const comp = addCompose(wf, -220, 200);
    connect(wf, found, comp, 0);
    const send = addCadence(wf, comp, sig.channels.slice(0,1).length ? sig.channels.slice(0,1) : ["email"], 40, 200);
    const ticket = addHTTP(wf, "Create Ticket", "={{'https://example.com/ticket/create'}}", "={{$json}}", 40, 380);
    connect(wf, found, ticket, 1);
    const col = addCollector(wf, 320, 300);
    connect(wf, send, col);
    connect(wf, ticket, col);
  };

  // 5) SALES_OUTREACH
  T.SALES_OUTREACH = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "SALES_OUTREACH";
    if (forceTrigger) sig.trigger = forceTrigger;
    const trig = addTriggerBySignals(wf, sig, -1180);
    let init = addInit(wf, scenario, industry, sig.channels[0] || "email", !!demo, -940, 300, arch);
    connect(wf, trig, init);

    const adopt = planChain(wf, init, -700, 220);

    if (sig.features.enrich) {
      const n = addHTTP(wf, "Enrich Lead", "={{$json.enrichUrl || 'https://example.com/enrich'}}", "={{$json}}", -700, 300);
      connect(wf, adopt, n);
      init = n;
    } else {
      init = adopt;
    }
    if (sig.features.dedupe) {
      const n = addFunction(
        wf,
        "Deduplicate",
        `const seen=new Set(); const items=Array.isArray($json.leads)?$json.leads:[ $json ];
const out=[]; for(const it of items){const k=(it.email||it.company||'').toLowerCase(); if(!k||seen.has(k)) continue; seen.add(k); out.push(it);} return out.length?out:[$json];`,
        -460,
        300
      );
      connect(wf, init, n);
      init = n;
    }
    if (sig.features.score) {
      const n = addFunction(wf, "Score", `const it=$json; it.score=(it.score||0)+(/c[- ]?level|vp|director/i.test(it.title||'')?40:0); return [it];`, -220, 300);
      connect(wf, init, n);
      init = n;
    }
    const comp = addCompose(wf, 20, 300);
    connect(wf, init, comp);
    const seq = sig.channels.length ? sig.channels.slice(0, Math.min(3, sig.channels.length)) : ["email", "sms", "email"];
    const last = addCadence(wf, comp, seq, 280, 300);
    if (sig.systems.crm) {
      const log = addHTTP(wf, "CRM Log", "={{$json.crmUrl || 'https://example.com/crm/log'}}", "={{$json}}", 280 + 260 * (seq.length + 1), 300);
      connect(wf, last, log);
      const col = addCollector(wf, 280 + 260 * (seq.length + 2), 300);
      connect(wf, log, col);
    } else {
      const col = addCollector(wf, 280 + 260 * (seq.length + 1), 300);
      connect(wf, last, col);
    }
  };

  // 6) LEAD_QUAL_INBOUND
  T.LEAD_QUAL_INBOUND = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "LEAD_QUAL_INBOUND";
    const hook = addTriggerBySignals(wf, { trigger: "webhook" }, -1180);
    const init = addInit(wf, scenario, industry, sig.channels[0] || "email", !!demo, -940, 300, arch);
    connect(wf, hook, init);

    const adopt = planChain(wf, init, -700, 220);

    const score = addFunction(
      wf,
      "Score/Route",
      `const l=$json; l.score=(l.score||0)+(/director|vp|c[- ]?level/i.test(l.title||'')?40:0);
l.route = l.score>=60?'ae':'sdr'; return [l];`,
      -700,
      300
    );
    connect(wf, adopt, score);
    const ifAE = addIf(wf, "Route to AE?", "={{$json.route}}", "equal", "ae", -460, 300);
    const book = addHTTP(wf, "Book Calendar", "={{$json.calUrl || 'https://example.com/calendar/book'}}", "={{$json}}", -220, 300);
    const crm = addHTTP(wf, "Create/Update CRM", "={{$json.crmUrl || 'https://example.com/crm/upsert'}}", "={{$json}}", 40, 300);
    connect(wf, ifAE, book, 0);
    connect(wf, book, crm);
    connect(wf, ifAE, crm, 1);
    const col = addCollector(wf, 320, 300);
    connect(wf, crm, col);
  };

  // 7) CHURN_WINBACK
  T.CHURN_WINBACK = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "CHURN_WINBACK";
    if (forceTrigger) sig.trigger = forceTrigger;
    const trig = addTriggerBySignals(wf, sig, -1180);
    const init = addInit(wf, scenario, industry, sig.channels[0] || "email", !!demo, -940, 300, arch);
    connect(wf, trig, init);

    const adopt = planChain(wf, init, -700, 220);

    const seg = addFunction(wf, "Segment Lapsed", `const d=$json; d.segment=(d.days_lapsed||90)>180?'deep':'light'; return [d];`, -700, 300);
    connect(wf, adopt, seg);
    const comp = addCompose(wf, -460, 300);
    connect(wf, seg, comp);
    const last = addCadence(wf, comp, sig.channels.length ? sig.channels.slice(0, 2) : ["email", "sms"], -200, 300);
    const crm = addHTTP(wf, "Log Outcome", "={{'https://example.com/crm/winback'}}", "={{$json}}", 60, 300);
    connect(wf, last, crm);
    const col = addCollector(wf, 340, 300);
    connect(wf, crm, col);
  };

  // 8) RENEWALS_CSM
  T.RENEWALS_CSM = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "RENEWALS_CSM";
    const cron = addTriggerBySignals(wf, { trigger: "cron" }, -1180);
    const init = addInit(wf, scenario, industry, sig.channels[0] || "email", !!demo, -940, 300, arch);
    connect(wf, cron, init);

    const adopt = planChain(wf, init, -700, 220);

    const fetch = addHTTP(wf, "Fetch Renewals", "={{'https://example.com/crm/renewals'}}", "={{$json}}", -700, 300);
    connect(wf, adopt, fetch);
    const split = addSplit(wf, -460, 300);
    connect(wf, fetch, split);
    const risk = addFunction(wf, "Risk Score", `const r=$json;r.risk=(r.usage<0.5? 'high' : 'low'); return [r];`, -220, 300);
    connect(wf, split, risk);
    const sw = addSwitch(
      wf,
      "Play Selection",
      "={{$json.risk}}",
      [
        { operation: "equal", value2: "high" },
        { operation: "equal", value2: "low" },
      ],
      40,
      300
    );
    connect(wf, risk, sw);
    const high = addFunction(wf, "High-Risk Play", "return [$json];", 300, 200);
    const low = addFunction(wf, "Low-Risk Play", "return [$json];", 300, 380);
    connect(wf, sw, high, 0);
    connect(wf, sw, low, 1);
    const comp = addCompose(wf, 560, 300);
    connect(wf, high, comp);
    connect(wf, low, comp);
    const last = addCadence(wf, comp, sig.channels.length ? sig.channels.slice(0, 2) : ["email", "sms"], 820, 300);
    const qbr = addHTTP(wf, "Create QBR Doc", "={{'https://example.com/qbr/create'}}", "={{$json}}", 1080, 300);
    connect(wf, last, qbr);
    const col = addCollector(wf, 1360, 300);
    connect(wf, qbr, col);
  };

  // 9) AR_FOLLOWUP
  T.AR_FOLLOWUP = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "AR_FOLLOWUP";
    if (forceTrigger) sig.trigger = forceTrigger;
    const trig = addTriggerBySignals(wf, sig, -1180);
    const init = addInit(wf, scenario, industry, sig.channels[0] || "email", !!demo, -940, 300, arch);
    connect(wf, trig, init);

    const adopt = planChain(wf, init, -700, 220);

    const aging = addHTTP(wf, "Pull Aging", "={{'https://example.com/accounting/aging'}}", "={{$json}}", -700, 300);
    connect(wf, adopt, aging);
    const split = addSplit(wf, -460, 300);
    connect(wf, aging, split);
    const bucket = addFunction(wf, "Bucket 30/60/90", `const d=$json; const n=d.days_past_due||0; d.bucket= n>=90?'90': (n>=60?'60':'30'); return [d];`, -220, 300);
    connect(wf, split, bucket);
    const ladder = addSwitch(
      wf,
      "Nudge Ladder",
      "={{$json.bucket}}",
      [
        { operation: "equal", value2: "30" },
        { operation: "equal", value2: "60" },
        { operation: "equal", value2: "90" },
      ],
      40,
      300
    );
    connect(wf, bucket, ladder);
    const s30 = addFunction(wf, "30-day Nudge", "return [$json];", 300, 200);
    const s60 = addFunction(wf, "60-day Nudge", "return [$json];", 300, 300);
    const s90 = addFunction(wf, "90-day Escalation", "return [$json];", 300, 400);
    connect(wf, ladder, s30, 0);
    connect(wf, ladder, s60, 1);
    connect(wf, ladder, s90, 2);
    const comp = addCompose(wf, 560, 300);
    connect(wf, s30, comp);
    connect(wf, s60, comp);
    connect(wf, s90, comp);
    const last = addCadence(wf, comp, sig.channels.slice(0,2).length ? sig.channels.slice(0,2) : ["email", "sms"], 820, 300);

    if (/dispute|discrepanc|appeal/.test(String(scenario.how_it_works || "").toLowerCase())) {
      const ifDisp = addIf(wf, "Dispute Raised?", "={{$json.dispute}}", "notEmpty", "", 1080, 300);
      connect(wf, last, ifDisp);
      const resolve = addHTTP(wf, "Dispute Review", "={{'https://example.com/ar/dispute'}}", "={{$json}}", 1340, 300);
      connect(wf, ifDisp, resolve, 0);
      const col = addCollector(wf, 1620, 300);
      connect(wf, resolve, col);
    } else {
      const col = addCollector(wf, 1080, 300);
      connect(wf, last, col);
    }
  };

  // 10) AP_AUTOMATION
  T.AP_AUTOMATION = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "AP_AUTOMATION";
    const hook = addTriggerBySignals(wf, { trigger: "webhook" }, -1180);
    const init = addInit(wf, scenario, industry, "email", !!demo, -940, 300, arch);
    connect(wf, hook, init);

    const adopt = planChain(wf, init, -700, 220);

    const parse = addFunction(wf, "Parse/Extract", "return [$json];", -700, 300);
    connect(wf, adopt, parse);
    const match = addFunction(wf, "3-Way Match", sig.features.three_way_match ? "return [$json];" : "return [$json];", -460, 300);
    connect(wf, parse, match);
    const ifExc = addIf(wf, "Exception?", "={{$json.exception}}", "notEmpty", "", -220, 300);
    connect(wf, match, ifExc);
    const appr = addFunction(wf, "Approval Path", "return [$json];", 40, 300);
    const pay = addHTTP(wf, "Issue Payment", "={{'https://example.com/pay'}}", "={{$json}}", 300, 300);
    connect(wf, ifExc, appr, 0);
    connect(wf, appr, pay);
    connect(wf, ifExc, pay, 1);
    const col = addCollector(wf, 580, 300);
    connect(wf, pay, col);
  };

  // 11) INVENTORY_MONITOR
  T.INVENTORY_MONITOR = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "INVENTORY_MONITOR";
    const trig = addTriggerBySignals(wf, sig, -1180);
    const init = addInit(wf, scenario, industry, "email", !!demo, -940, 300, arch);
    connect(wf, trig, init);

    const adopt = planChain(wf, init, -700, 220);

    const fetch = addHTTP(wf, "Fetch Stock (WMS/ERP)", "={{'https://example.com/wms/levels'}}", "={{$json}}", -700, 300);
    connect(wf, adopt, fetch);
    const split = addSplit(wf, -460, 300);
    connect(wf, fetch, split);
    const thresh = addFunction(wf, "Threshold Check", "const i=$json; i.low=(i.qty||0) <= (i.min||10); return [i];", -220, 300);
    connect(wf, split, thresh);
    const gate = addIf(wf, "Low Stock?", "={{$json.low}}", "equal", "true", 40, 300);
    connect(wf, thresh, gate);
    const alert = addHTTP(wf, "Notify Ops", "={{'https://example.com/slack/inventory'}}", "={{$json}}", 300, 200);
    connect(wf, gate, alert, 1);
    let poStart = addFunction(wf, "Prepare PO", "return [$json];", 300, 380);
    connect(wf, gate, poStart, 0);
    if (sig.features.approvals) {
      const appr = addFunction(wf, "Approval", "return [$json];", 560, 380);
      connect(wf, poStart, appr);
      poStart = appr;
    }
    const createPO = addHTTP(wf, "Create PO (ERP)", "={{'https://example.com/erp/po'}}", "={{$json}}", 820, 380);
    connect(wf, poStart, createPO);
    const col = addCollector(wf, 1100, 300);
    connect(wf, alert, col);
    connect(wf, createPO, col);
  };

  // 12) REPLENISHMENT_PO
  T.REPLENISHMENT_PO = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "REPLENISHMENT_PO";
    const hook = addTriggerBySignals(wf, { trigger: "webhook" }, -1180);
    const init = addInit(wf, scenario, industry, "email", !!demo, -940, 300, arch);
    connect(wf, hook, init);

    const adopt = planChain(wf, init, -700, 220);

    const vendor = addFunction(wf, "Pick Supplier", "return [$json];", -700, 300);
    const create = addHTTP(wf, "Create PO (ERP)", "={{'https://example.com/erp/po'}}", "={{$json}}", -460, 300);
    const appr = addFunction(wf, "Approvals", "return [$json];", -220, 300);
    const update = addHTTP(wf, "Update WMS", "={{'https://example.com/wms/update'}}", "={{$json}}", 40, 300);
    connect(wf, adopt, vendor);
    connect(wf, vendor, create);
    connect(wf, create, appr);
    connect(wf, appr, update);
    const col = addCollector(wf, 320, 300);
    connect(wf, update, col);
  };

  // 13) FIELD_SERVICE_DISPATCH
  T.FIELD_SERVICE_DISPATCH = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "FIELD_SERVICE_DISPATCH";
    const trig = addTriggerBySignals(wf, { trigger: "webhook" }, -1180);
    const init = addInit(wf, scenario, industry, sig.channels[0] || "sms", !!demo, -940, 300, arch);
    connect(wf, trig, init);

    const adopt = planChain(wf, init, -700, 220);

    const match = addFunction(wf, "Geo/Skills Match", "return [$json];", -700, 300);
    const assign = addHTTP(wf, "Assign Technician", "={{'https://example.com/dispatch/assign'}}", "={{$json}}", -460, 300);
    connect(wf, adopt, match);
    connect(wf, match, assign);
    const notifyTech = addCadence(wf, assign, [sig.channels[0] || "sms"], -200, 260);
    const notifyCust = addCadence(wf, assign, [sig.channels[1] || "email"], -200, 340);
    const cal = addHTTP(wf, "Calendar Booking", "={{'https://example.com/calendar/book'}}", "={{$json}}", 60, 300);
    connect(wf, notifyTech, cal);
    connect(wf, notifyCust, cal);
    const col = addCollector(wf, 340, 300);
    connect(wf, cal, col);
  };

  // 14) COMPLIANCE_AUDIT
  T.COMPLIANCE_AUDIT = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "COMPLIANCE_AUDIT";
    const cron = addTriggerBySignals(wf, { trigger: "cron" }, -1180);
    const init = addInit(wf, scenario, industry, "email", !!demo, -940, 300, arch);
    connect(wf, cron, init);

    const adopt = planChain(wf, init, -700, 220);

    const fetch = addHTTP(wf, "Fetch Checklist", "={{'https://example.com/compliance/list'}}", "={{$json}}", -700, 300);
    const validate = addFunction(wf, "Validate Controls", "return [$json];", -460, 300);
    const issues = addIf(wf, "Any Issues?", "={{$json.issues}}", "notEmpty", "", -220, 300);
    const report = addHTTP(wf, "Generate Report", "={{'https://example.com/compliance/report'}}", "={{$json}}", 40, 300);
    const notify = addHTTP(wf, "Notify Legal", "={{'https://example.com/legal/notify'}}", "={{$json}}", 300, 300);
    connect(wf, adopt, fetch);
    connect(wf, fetch, validate);
    connect(wf, validate, issues);
    connect(wf, issues, report, 0);
    connect(wf, report, notify);
    connect(wf, issues, notify, 1);
    const col = addCollector(wf, 580, 300);
    connect(wf, notify, col);
  };

  // 15) INCIDENT_MGMT
  T.INCIDENT_MGMT = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "INCIDENT_MGMT";
    const hook = addTriggerBySignals(wf, { trigger: "webhook" }, -1180);
    const init = addInit(wf, scenario, industry, "email", !!demo, -940, 300, arch);
    connect(wf, hook, init);

    const adopt = planChain(wf, init, -700, 220);

    const sev = addFunction(
      wf,
      "Severity Detect",
      `const t=String($json.title||'').toLowerCase();$json.sev = /sev[ -:]?1|critical|major/.test(t)?'high':'normal';return [$json];`,
      -700,
      300
    );
    const ifHigh = addIf(wf, "High Severity?", "={{$json.sev}}", "equal", "high", -460, 300);
    const comms = addHTTP(wf, "Incident Comms", "={{'https://example.com/comms'}}", "={{$json}}", -220, 300);
    const ticket = addHTTP(wf, "Create Incident Ticket", "={{'https://example.com/itsm/ticket'}}", "={{$json}}", 40, 300);
    const pir = addHTTP(wf, "Prep PIR Doc", "={{'https://example.com/pir/create'}}", "={{$json}}", 300, 300);
    connect(wf, adopt, sev);
    connect(wf, sev, ifHigh);
    connect(wf, ifHigh, comms, 0);
    connect(wf, comms, ticket);
    connect(wf, ifHigh, ticket, 1);
    connect(wf, ticket, pir);
    const col = addCollector(wf, 580, 300);
    connect(wf, pir, col);
  };

  // 16) DATA_PIPELINE_ETL
  T.DATA_PIPELINE_ETL = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "DATA_PIPELINE_ETL";
    const cron = addTriggerBySignals(wf, { trigger: "cron" }, -1180);
    const init = addInit(wf, scenario, industry, "email", !!demo, -940, 300, arch);
    connect(wf, cron, init);

    const adopt = planChain(wf, init, -700, 220);

    const extract = addHTTP(wf, "Extract", "={{'https://example.com/extract'}}", "={{$json}}", -700, 300);
    const transform = addFunction(wf, "Transform", "return [$json];", -460, 300);
    const load = addHTTP(wf, "Load (DB/Sheets)", "={{'https://example.com/load'}}", "={{$json}}", -220, 300);
    const status = addHTTP(wf, "Status/Alert", "={{'https://example.com/alert'}}", "={{$json}}", 40, 300);
    connect(wf, adopt, extract);
    connect(wf, extract, transform);
    connect(wf, transform, load);
    connect(wf, load, status);
    const col = addCollector(wf, 320, 300);
    connect(wf, status, col);
  };

  // 17) REPORTING_KPI_DASH
  T.REPORTING_KPI_DASH = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "REPORTING_KPI_DASH";
    const cron = addTriggerBySignals(wf, { trigger: "cron" }, -1180);
    const init = addInit(wf, scenario, industry, "email", !!demo, -940, 300, arch);
    connect(wf, cron, init);

    const adopt = planChain(wf, init, -700, 220);

    const metrics = addHTTP(wf, "Calculate Metrics", "={{'https://example.com/metrics'}}", "={{$json}}", -700, 300);
    const dash = addHTTP(wf, "Render Dashboard", "={{'https://example.com/dash/export'}}", "={{$json}}", -460, 300);
    const email = addHTTP(wf, "Send Email/Slack", "={{'https://example.com/notify'}}", "={{$json}}", -220, 300);
    connect(wf, adopt, metrics);
    connect(wf, metrics, dash);
    connect(wf, dash, email);
    const col = addCollector(wf, 60, 300);
    connect(wf, email, col);
  };

  // 18) ACCESS_GOVERNANCE
  T.ACCESS_GOVERNANCE = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "ACCESS_GOVERNANCE";
    const hook = addTriggerBySignals(wf, { trigger: "webhook" }, -1180);
    const init = addInit(wf, scenario, industry, "email", !!demo, -940, 300, arch);
    connect(wf, hook, init);

    const adopt = planChain(wf, init, -700, 220);

    const ent = addFunction(wf, "Check Entitlements", "return [$json];", -700, 300);
    const appr = addFunction(wf, "Approval", "return [$json];", -460, 300);
    const prov = addHTTP(wf, "Provision/Deprovision", "={{'https://example.com/iam/provision'}}", "={{$json}}", -220, 300);
    const log = addHTTP(wf, "Log Decision", "={{'https://example.com/iam/log'}}", "={{$json}}", 40, 300);
    connect(wf, adopt, ent);
    connect(wf, ent, appr);
    connect(wf, appr, prov);
    connect(wf, prov, log);
    const col = addCollector(wf, 320, 300);
    connect(wf, log, col);
  };

  // 19) PRIVACY_DSR
  T.PRIVACY_DSR = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "PRIVACY_DSR";
    const hook = addTriggerBySignals(wf, { trigger: "webhook" }, -1180);
    const init = addInit(wf, scenario, industry, "email", !!demo, -940, 300, arch);
    connect(wf, hook, init);

    const adopt = planChain(wf, init, -700, 220);

    const idv = addHTTP(wf, "Identity Verify (KYC)", "={{'https://example.com/kyc'}}", "={{$json}}", -700, 300);
    const collect = addHTTP(wf, "Collect Data", "={{'https://example.com/privacy/collect'}}", "={{$json}}", -460, 300);
    const respond = addHTTP(wf, "Respond to Subject", "={{'https://example.com/privacy/respond'}}", "={{$json}}", -220, 300);
    const attest = addHTTP(wf, "Attest & Close", "={{'https://example.com/privacy/attest'}}", "={{$json}}", 40, 300);
    connect(wf, adopt, idv);
    connect(wf, idv, collect);
    connect(wf, collect, respond);
    connect(wf, respond, attest);
    const col = addCollector(wf, 320, 300);
    connect(wf, attest, col);
  };

  // 20) RECRUITING_INTAKE
  T.RECRUITING_INTAKE = (wf, ctx) => {
    const { scenario, industry, forceTrigger, demo } = ctx, sig = deriveSignals(scenario);
    const arch = "RECRUITING_INTAKE";
    const hook = addTriggerBySignals(wf, { trigger: "webhook" }, -1180);
    const init = addInit(wf, scenario, industry, "email", !!demo, -940, 300, arch);
    connect(wf, hook, init);

    const adopt = planChain(wf, init, -700, 220);

    const parse = addFunction(wf, "Parse Resume", "return [$json];", -700, 300);
    const score = addFunction(wf, "Score Candidate", "return [$json];", -460, 300);
    const stage = addSwitch(
      wf,
      "Stage Route",
      "={{$json.stage||'phone'}}",
      [
        { operation: "equal", value2: "phone" },
        { operation: "equal", value2: "onsite" },
      ],
      -220,
      300
    );
    const sched = addHTTP(wf, "Schedule Interview", "={{'https://example.com/calendar/book'}}", "={{$json}}", 40, 300);
    const ats = addHTTP(wf, "ATS Update", "={{'https://example.com/ats/update'}}", "={{$json}}", 300, 300);
    connect(wf, adopt, parse);
    connect(wf, parse, score);
    connect(wf, score, stage);
    connect(wf, stage, sched, 0);
    connect(wf, stage, ats, 1);
    connect(wf, sched, ats);
    const col = addCollector(wf, 580, 300);
    connect(wf, ats, col);
  };

  // ---------------- Demo tool mapping ----------------
  function addDemoToolMapper(wf, x = -1200, y = 80) {
    return addFunction(
      wf,
      "Demo Tool Mapper",
      `
const mapDemo = (name)=> name ? String(name).replace(/Salesforce|HubSpot|Mailchimp|Twilio|Slack|NetSuite|ServiceNow|Zendesk|Gmail|Outlook|Stripe|QuickBooks/gi, (m)=> m + ' (Demo)') : name;
const plan = $json.plan || {};
if (plan.tools){
  const t = {...plan.tools};
  for (const k of Object.keys(t)) t[k] = mapDemo(t[k]);
  plan.tools = t;
}
return [{...$json, plan}];`,
      x, y
    );
  }

  // ---------------- builder (two lanes) ----------------
  function buildWorkflowJSON(scenario, industry, opts = {}) {
    const archetype = scenario?.archetype || classifyFallback(scenario);
    const wfName = `${scenario?.scenario_id || scenario?.title || "AI Agent Workflow"} — ${industry?.name || industry?.industry_id || "Industry"}`;
    const wf = baseWorkflow(wfName);
    const tmpl = T[archetype] || T.SALES_OUTREACH;

    // LANE A: PRODUCTION (top). Use real trigger. demo=false
    withYOffset(wf, 0, () => {
      const hdr = addLaneHeader(wf, "PRODUCTION LANE", -1320, 40);
      tmpl(wf, { scenario, industry, demo: false, forceTrigger: null });
      // (Optional) Place a placeholder where you’ll select real creds in n8n
      // No-op node keeps lanes symmetric:
      const prodNote = addFunction(wf, "Prod Creds Placeholder", "return [$json];", -1320, 120);
      connect(wf, hdr, prodNote);
    });

    // LANE B: DEMO (bottom). Force manual trigger. demo=true. Offset to avoid overlap.
    withYOffset(wf, 900, () => {
      const hdr = addLaneHeader(wf, "DEMO LANE (Manual Trigger + Seeded Contacts)", -1320, 40);
      tmpl(wf, { scenario, industry, demo: true, forceTrigger: "manual" });
      // Map tools to (Demo) so you can visually test end-to-end
      const mapper = addDemoToolMapper(wf, -1320, 120);
      connect(wf, hdr, mapper);
    });

    return wf;
  }

  window.Builder = { buildWorkflowJSON };
})();
