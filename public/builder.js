// public/builder.js
// Plain script (NOT a module). Exposes: window.Builder = { buildWorkflowJSON }.
// Classifier + tools extractor + 3 archetypes (SAFE by default, FULL via ?compat=full)

(function () {
  "use strict";

  // ----------------- helpers -----------------
  const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
  const pos = (x, y) => [x, y];

  function baseWorkflow(name) {
    return { name, nodes: [], connections: {}, active: false, settings: {}, staticData: {} };
  }
  function addNode(wf, node) { wf.nodes.push(node); return node.name; }
  function connect(wf, from, to, outputIndex = 0) {
    wf.connections[from] ??= {}; wf.connections[from].main ??= [];
    for (let i = wf.connections[from].main.length; i <= outputIndex; i++) wf.connections[from].main[i] = [];
    wf.connections[from].main[outputIndex].push({ node: to, type: "main", index: 0 });
  }

  const QS = new URLSearchParams(location.search);
  const compat = (QS.get("compat") || "safe").toLowerCase() === "full" ? "full" : "safe";

  // --------------- parsing ---------------
  function toWords(s) { return (String(s||"").toLowerCase().match(/[a-z0-9_+-]+/g) || []); }
  function listify(val) {
    if (Array.isArray(val)) return val.map(v=>String(v).trim()).filter(Boolean);
    return String(val||"").split(/[;,\n|]+/).map(v=>v.trim()).filter(Boolean);
  }

  function classifyScenario(s) {
    const hay = [
      ...(toWords(s.scenario_id)),
      ...(toWords(s.name)),
      ...listify(s.tags).map(x=>x.toLowerCase())
    ].join(" ");

    const has = (...kws) => kws.some(k => hay.includes(k));
    if (has("schedule","scheduling","appointment","no-show","no_shows")) return "APPOINTMENT_SCHEDULING";
    if (has("support","ticket","complaint","cs","helpdesk","customer_service")) return "CUSTOMER_SUPPORT_INTAKE";
    if (has("sales","outreach","prospect","lead","cadence")) return "SALES_OUTREACH";
    // fallback by channel bias
    return "SALES_OUTREACH";
  }

  function extractTools(toolStackDev) {
    const t = String(toolStackDev || "").toLowerCase();
    const has = (kw) => t.includes(kw);
    return {
      channels: {
        sms: has("twilio") || t.includes("sms"),
        whatsapp: has("whatsapp") || (has("twilio") && t.includes("whatsapp")),
        email: has("email") || has("smtp") || has("sendgrid"),
        call: has("voice") || has("call"),
      },
      systems: {
        pms: has("dentrix") || has("opendental") || has("eaglesoft") || has("pms"),
        wms: has("wms") || has("warehouse"),
        erp: has("erp") || has("netsuite") || has("sap") || has("oracle"),
        crm: has("crm") || has("hubspot") || has("salesforce"),
        calendar: has("google calendar") || has("calendar"),
        slack: has("slack"),
        airtable: has("airtable"),
        notion: has("notion"),
      }
    };
  }

  // --------------- shared nodes ---------------
  function addManual(wf, x=-820, y=300) {
    return addNode(wf, { id: uid("manual"), name: "Manual Trigger", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: pos(x, y), parameters: {} });
  }
  function addCron(wf, x=-820, y=140) {
    if (compat === "full") {
      // conservative Cron config (every 15 minutes)
      return addNode(wf, {
        id: uid("cron"), name: "Cron (every 15m)",
        type: "n8n-nodes-base.cron", typeVersion: 1, position: pos(x, y),
        parameters: { triggerTimes: { item: [{ mode: "everyX", everyX: { hours: 0, minutes: 15 } }] } }
      });
    }
    // SAFE placeholder
    return addNode(wf, {
      id: uid("cronph"), name: "CRON (Placeholder)",
      type: "n8n-nodes-base.function", typeVersion: 2, position: pos(x, y),
      parameters: { functionCode: "return [$json];" }
    });
  }
  function addWebhook(wf, name="Webhook (Incoming)", x=-820, y=460) {
    if (compat === "full") {
      return addNode(wf, {
        id: uid("webhook"), name, type: "n8n-nodes-base.webhook", typeVersion: 1, position: pos(x, y),
        parameters: { path: uid("hook"), methods: ["POST"], responseMode: "onReceived" }
      });
    }
    return addNode(wf, {
      id: uid("webph"), name: `${name} (Placeholder)`,
      type: "n8n-nodes-base.function", typeVersion: 2, position: pos(x, y),
      parameters: { functionCode: "return [$json];" }
    });
  }
  function addInit(wf, scenario, industry, channel, x=-600, y=300) {
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
  function addHTTP(wf, name, urlExpr, bodyExpr, x, y) {
    return addNode(wf, {
      id: uid("http"), name, type: "n8n-nodes-base.httpRequest", typeVersion: 4, position: pos(x, y),
      parameters: { url: urlExpr, method: "POST", jsonParameters: true, sendBody: true, bodyParametersJson: bodyExpr }
    });
  }
  function addFunction(wf, name, code, x, y) {
    return addNode(wf, { id: uid("func"), name, type: "n8n-nodes-base.function", typeVersion: 2, position: pos(x, y), parameters: { functionCode: code } });
  }
  function addSwitchChannel(wf, x, y) {
    return addNode(wf, {
      id: uid("switch"), name: "Choose Channel", type: "n8n-nodes-base.switch", typeVersion: 2, position: pos(x, y),
      parameters: { value1: "={{$json.channel}}", rules: [
        { operation: "equal", value2: "email" },
        { operation: "equal", value2: "sms" },
        { operation: "equal", value2: "whatsapp" },
        { operation: "equal", value2: "call" },
      ] }
    });
  }
  function addIf(wf, name, left, op, right, x, y) {
    return addNode(wf, { id: uid("if"), name, type: "n8n-nodes-base.if", typeVersion: 2, position: pos(x, y),
      parameters: { conditions: { number: [], string: [{ value1: left, operation: op, value2: right }] } } });
  }
  function addMerge(wf, name, x, y) {
    return addNode(wf, { id: uid("merge"), name, type: "n8n-nodes-base.merge", typeVersion: 2, position: pos(x, y), parameters: { mode: "append" } });
  }
  function addSplit(wf, x, y) {
    return addNode(wf, { id: uid("split"), name: "Split In Batches", type: "n8n-nodes-base.splitInBatches", typeVersion: 1, position: pos(x, y),
      parameters: { batchSize: 20 } });
  }

  // Channel leaves
  function addEmailNode(wf, x, y) {
    return addNode(wf, {
      id: uid("email"), name: "Send Email", type: "n8n-nodes-base.emailSend", typeVersion: 3, position: pos(x, y),
      parameters: { to: "={{$json.to}}", subject: "={{$json.scenario?.agent_name || 'AI Outreach'}}", text: "={{$json.message}}" },
      credentials: {}
    });
  }
  function addSMSNode(wf, x, y) {
    return addNode(wf, {
      id: uid("sms"), name: "Send SMS", type: "n8n-nodes-base.twilio", typeVersion: 3, position: pos(x, y),
      parameters: { resource: "message", operation: "create", from: "={{$json.from}}", to: "={{$json.to}}", message: "={{$json.message}}" },
      credentials: {}
    });
  }
  function addWANode(wf, x, y) {
    return addNode(wf, {
      id: uid("wa"), name: "Send WhatsApp (Twilio)", type: "n8n-nodes-base.twilio", typeVersion: 3, position: pos(x, y),
      parameters: { resource: "message", operation: "create", from: "={{'whatsapp:' + ($json.from || '+10000000000')}}", to: "={{'whatsapp:' + ($json.to || '+10000000001')}}", message: "={{$json.message}}" },
      credentials: {}
    });
  }
  function addCallNode(wf, x, y) {
    return addNode(wf, {
      id: uid("call"), name: "Place Call (Webhook/Provider)", type: "n8n-nodes-base.httpRequest", typeVersion: 4, position: pos(x, y),
      parameters: { url: "={{$json.callWebhook}}", method: "POST", jsonParameters: true, sendBody: true, bodyParametersJson: "={{ { to: $json.to, from: $json.from, text: $json.message } }}" }
    });
  }
  function addChannelLeaf(wf, label, x, y) {
    return addFunction(wf, label, `return [{ note: '${label}', channel: $json.channel, message: $json.message }];`, x, y);
  }
  function makeChannelLeaves(wf, x, ys) {
    if (compat === "full") {
      return [ addEmailNode(wf, x, ys[0]), addSMSNode(wf, x, ys[1]), addWANode(wf, x, ys[2]), addCallNode(wf, x, ys[3]) ];
    }
    return [ addChannelLeaf(wf,"Email Placeholder",x,ys[0]), addChannelLeaf(wf,"SMS Placeholder",x,ys[1]), addChannelLeaf(wf,"WhatsApp Placeholder",x,ys[2]), addChannelLeaf(wf,"Call Placeholder",x,ys[3]) ];
  }

  // Shared composer
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

  // ----------------- ARCHETYPES -----------------

  // 1) APPOINTMENT_SCHEDULING (DSO no-shows)
  function tmpl_APPOINTMENT_SCHEDULING(wf, ctx) {
    const { scenario, industry, channel, tools } = ctx;

    // Triggers (Cron + optional PMS Webhook)
    const nCron = addCron(wf, -900, 140);
    const nWebhook = tools.systems.pms ? addWebhook(wf, "PMS Event (Incoming)", -900, 460) : null;

    const nInit = addInit(wf, scenario, industry, channel, -650, 300);
    const nFetch = addHTTP(wf, "Fetch Upcoming (PMS)", "={{$json.pms_upcoming || 'https://example.com/pms/upcoming'}}", "={{$json}}", -420, 300);
    const nSplit = addSplit(wf, -180, 300);
    const nCompose = addFunction(wf, "Compose Reminder", composeMessageFunctionBody(), 60, 300);
    const nSwitch = addSwitchChannel(wf, 300, 300);

    // Channel leaves
    const [nEmail, nSMS, nWA, nCall] = makeChannelLeaves(wf, 600, [160,300,440,580]);

    // Post actions
    const nUpdate = addHTTP(wf, "Update PMS (Confirm/Reschedule)", "={{$json.pms_update || 'https://example.com/pms/update'}}", "={{$json}}", 900, 300);
    const nSummary = tools.systems.slack ? addHTTP(wf, "Slack Daily Summary", "={{'https://example.com/slack/summary'}}", "={{$json}}", 1140, 300) : null;

    // Wiring
    connect(wf, nCron, nInit);
    if (nWebhook) connect(wf, nWebhook, nInit);
    connect(wf, nInit, nFetch);
    connect(wf, nFetch, nSplit);
    connect(wf, nSplit, nCompose);
    connect(wf, nCompose, nSwitch);

    connect(wf, nSwitch, nEmail, 0);
    connect(wf, nSwitch, nSMS, 1);
    connect(wf, nSwitch, nWA, 2);
    connect(wf, nSwitch, nCall, 3);

    connect(wf, nEmail, nUpdate);
    connect(wf, nSMS, nUpdate);
    connect(wf, nWA, nUpdate);
    connect(wf, nCall, nUpdate);

    if (nSummary) connect(wf, nUpdate, nSummary);

    // Also provide manual trigger for ad-hoc run
    const nManual = addManual(wf, -900, 300);
    connect(wf, nManual, nInit);
  }

  // 2) CUSTOMER_SUPPORT_INTAKE
  function tmpl_CUSTOMER_SUPPORT_INTAKE(wf, ctx) {
    const { scenario, industry, channel, tools } = ctx;

    const nWebhook = addWebhook(wf, "Support Intake (Incoming)", -940, 300);
    const nInit = addInit(wf, scenario, industry, channel, -700, 300);

    const nClassify = addFunction(wf, "Classify Intent/Priority", `
const text = ($json.message || $json.body || '').toLowerCase();
const vip = (String($json.tags||'').toLowerCase().includes('vip')) || (text.includes('vip'));
const severity = text.includes('urgent') || text.includes('critical') ? 'high' : 'normal';
return [{ ...$json, intent: (text.includes('refund')?'billing':'support'), vip, severity }];`, -460, 300);

    const nIfVIP = addIf(wf, "VIP or High Severity?", "={{$json.severity}}", "equal", "high", -220, 300);
    const nCreate = addHTTP(wf, "Create Ticket (Helpdesk/DMS)", "={{$json.ticket_url || 'https://example.com/ticket/create'}}", "={{$json}}", 60, 300);
    const nSwitch = addSwitchChannel(wf, 320, 300);

    const [nEmail, nSMS, nWA, nCall] = makeChannelLeaves(wf, 620, [160,300,440,580]);
    const nEscalate = tools.systems.slack ? addHTTP(wf, "Notify Escalation (Slack)", "={{'https://example.com/slack/alert'}}", "={{$json}}", 900, 160) : addFunction(wf, "Escalate Placeholder", "return [$json];", 900, 160);

    // Wiring
    connect(wf, nWebhook, nInit);
    connect(wf, nInit, nClassify);
    connect(wf, nClassify, nIfVIP);

    // true path (index 0) -> escalate first, then create ticket
    connect(wf, nIfVIP, nEscalate, 0);
    connect(wf, nEscalate, nCreate);

    // false path (index 1) -> create ticket directly
    connect(wf, nIfVIP, nCreate, 1);

    connect(wf, nCreate, nSwitch);
    connect(wf, nSwitch, nEmail, 0);
    connect(wf, nSwitch, nSMS, 1);
    connect(wf, nSwitch, nWA, 2);
    connect(wf, nSwitch, nCall, 3);

    // manual trigger too
    const nManual = addManual(wf, -940, 140);
    connect(wf, nManual, nInit);
  }

  // 3) SALES_OUTREACH
  function tmpl_SALES_OUTREACH(wf, ctx) {
    const { scenario, industry, channel, tools } = ctx;

    const nManual = addManual(wf, -920, 260);
    const nInit = addInit(wf, scenario, industry, channel, -700, 260);

    const nEnrich = addHTTP(wf, "Enrich Lead (HTTP)", "={{$json.enrichUrl || 'https://example.com/enrich'}}", "={{$json}}", -460, 260);

    // Deduplicate/score in Function (stable vs Item Lists across versions)
    const nDedupe = addFunction(wf, "Deduplicate/Score", `
const seen=new Set(); const items=Array.isArray($json.leads)?$json.leads:[ $json ];
const out=[]; for (const it of items){ const key=(it.email||it.domain||it.company||'').toLowerCase();
 if(!key || seen.has(key)) continue; seen.add(key); it.score= (it.score||0)+ (it.title&&/cto|ceo|founder/i.test(it.title)?30:0);
 out.push(it);
}
return out.length?out:[$json];`, -220, 260);

    const nCompose = addFunction(wf, "Compose Message", composeMessageFunctionBody(), 40, 260);
    const nSwitch = addSwitchChannel(wf, 300, 260);

    const [nEmail, nSMS, nWA, nCall] = makeChannelLeaves(wf, 600, [120,260,400,540]);

    const nCRM = tools.systems.crm ? addHTTP(wf, "Log to CRM", "={{$json.crmUrl || 'https://example.com/crm/log'}}", "={{$json}}", 900, 260) : addFunction(wf, "CRM Log (Placeholder)", "return [$json];", 900, 260);

    // Wiring
    connect(wf, nManual, nInit);
    connect(wf, nInit, nEnrich);
    connect(wf, nEnrich, nDedupe);
    connect(wf, nDedupe, nCompose);
    connect(wf, nCompose, nSwitch);

    connect(wf, nSwitch, nEmail, 0);
    connect(wf, nSwitch, nSMS, 1);
    connect(wf, nSwitch, nWA, 2);
    connect(wf, nSwitch, nCall, 3);

    connect(wf, nEmail, nCRM);
    connect(wf, nSMS, nCRM);
    connect(wf, nWA, nCRM);
    connect(wf, nCall, nCRM);
  }

  const TEMPLATE_IMPL = {
    APPOINTMENT_SCHEDULING: tmpl_APPOINTMENT_SCHEDULING,
    CUSTOMER_SUPPORT_INTAKE: tmpl_CUSTOMER_SUPPORT_INTAKE,
    SALES_OUTREACH: tmpl_SALES_OUTREACH,
  };

  // ----------------- main builder -----------------
  function buildWorkflowJSON(scenario, industry, opts = {}) {
    const channel = String((opts.recommendedChannel || 'email')).toLowerCase();
    const wfName = `${scenario?.scenario_id || scenario?.title || 'AI Agent Workflow'} — ${industry?.name || industry?.industry_id || 'Industry'}`;
    const wf = baseWorkflow(wfName);

    const archetype = classifyScenario(scenario);
    const tools = extractTools(scenario?.tool_stack_dev || "");

    const ctx = { scenario, industry, channel, tools };
    (TEMPLATE_IMPL[archetype] || tmpl_SALES_OUTREACH)(wf, ctx);
    return wf;
  }

  // Expose global
  window.Builder = { buildWorkflowJSON };
})();
