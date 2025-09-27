// public/builder.js
// Plain script (NOT a module). Exposes: window.Builder = { buildWorkflowJSON }.
// n8n-compat version: avoids brittle params and uses Delay instead of Wait.

(function () {
  "use strict";

  // --- helpers ---------------------------------------------------------------
  const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
  const pos = (x, y) => [x, y];

  function baseWorkflow(name) {
    return {
      name: name || "AI Agent Workflow",
      nodes: [],
      connections: {},
      active: false,
      settings: {},          // keep minimal for version compatibility
      staticData: {},        // optional, harmless
    };
  }

  function addNode(wf, node) {
    wf.nodes.push(node);
    return node.name; // return key used in connections
  }

  function connect(wf, from, to, outputIndex = 0) {
    wf.connections[from] ??= {};
    wf.connections[from].main ??= [];
    for (let i = wf.connections[from].main.length; i <= outputIndex; i++) {
      wf.connections[from].main[i] = [];
    }
    wf.connections[from].main[outputIndex].push({ node: to, type: "main", index: 0 });
  }

  function composeMessageFunctionBody() {
    return `// Compose outreach text from scenario + industry + channel
const s = $json.scenario || {};
const ind = $json.industry || {};
const channel = ($json.recommendedChannel || 'email').toLowerCase();

const headline = s.agent_name ? \`\${s.agent_name} — \${s.scenario_id || ''}\` : (s.title || s.scenario_id || 'Scenario');
const lines = [];
if (ind.industry_id || ind.name) lines.push('Industry: ' + (ind.name || ind.industry_id));
if (s.problem)         lines.push('Problem: ' + s.problem);
if (s.narrative)       lines.push('Narrative: ' + s.narrative);
if (s.how_it_works)    lines.push('How it works: ' + s.how_it_works);
if (s.roi_hypothesis)  lines.push('ROI: ' + s.roi_hypothesis);

const channelPrefix = {
  email: '📧 Email',
  sms: '📱 SMS',
  whatsapp: '🟢 WhatsApp',
  call: '📞 Call'
}[channel] || 'Message';

const text = \`\${channelPrefix} — \${headline}\\n\\n\${lines.join('\\n')}\`;

return [{ message: text, channel }];`;
  }

  // --- main builder ----------------------------------------------------------
  function buildWorkflowJSON(scenario, industry, opts = {}) {
    const channel = String((opts.recommendedChannel || 'email')).toLowerCase();

    const wfName =
      (scenario?.scenario_id || scenario?.title || "AI Agent Workflow") +
      " — " +
      (industry?.name || industry?.industry_id || "Industry");

    const wf = baseWorkflow(wfName);

    // 1) Manual Trigger
    const nManual = addNode(wf, {
      id: uid("manual"),
      name: "Manual Trigger",
      type: "n8n-nodes-base.manualTrigger",
      typeVersion: 1,
      position: pos(-520, 300),
      parameters: {},
    });

    // 2) Set Config (inject scenario/industry/channel)
    const nSet = addNode(wf, {
      id: uid("set"),
      name: "Set Config",
      type: "n8n-nodes-base.set",
      typeVersion: 2,
      position: pos(-260, 300),
      parameters: {
        keepOnlySet: true,
        values: {
          string: [
            { name: "recommendedChannel", value: channel },
            { name: "scenario_id", value: scenario?.scenario_id || "" },
            { name: "industry_id", value: industry?.industry_id || "" },
            { name: "to", value: "recipient@example.com" },
            { name: "from", value: "+10000000000" },
            { name: "callWebhook", value: "https://example.com/call" },
          ],
          json: [
            { name: "scenario", value: scenario || {} },
            { name: "industry", value: industry || {} },
          ],
        },
      },
    });

    // 3) Compose Message (Function)
    const nCompose = addNode(wf, {
      id: uid("func"),
      name: "Compose Message",
      type: "n8n-nodes-base.function",
      typeVersion: 2,
      position: pos(20, 300),
      parameters: { functionCode: composeMessageFunctionBody() },
    });

    // 4) Choose Channel (Switch)
    const nSwitch = addNode(wf, {
      id: uid("switch"),
      name: "Choose Channel",
      type: "n8n-nodes-base.switch",
      typeVersion: 2,
      position: pos(300, 300),
      parameters: {
        // evaluate: $json.channel from Compose Message
        value1: "={{$json.channel}}",
        rules: [
          { operation: "equal", value2: "email" },
          { operation: "equal", value2: "sms" },
          { operation: "equal", value2: "whatsapp" },
          { operation: "equal", value2: "call" },
        ],
      },
    });

    // 5) Send Email (use simple, widely-compatible fields)
    const nEmail = addNode(wf, {
      id: uid("email"),
      name: "Send Email",
      type: "n8n-nodes-base.emailSend",
      typeVersion: 3,
      position: pos(620, 160),
      parameters: {
        to: "={{$json.to}}",
        subject: "={{$json.scenario?.agent_name || 'AI Outreach'}}",
        text: "={{$json.message}}",
      },
      // credentials configured in n8n after import
      credentials: {},
    });

    // 6) Send SMS (Twilio)
    const nSMS = addNode(wf, {
      id: uid("sms"),
      name: "Send SMS",
      type: "n8n-nodes-base.twilio",
      typeVersion: 3,
      position: pos(620, 300),
      parameters: {
        resource: "message",
        operation: "create",
        from: "={{$json.from}}",
        to: "={{$json.to}}",
        message: "={{$json.message}}",
      },
      credentials: {},
    });

    // 7) Send WhatsApp (Twilio)
    const nWA = addNode(wf, {
      id: uid("wa"),
      name: "Send WhatsApp (Twilio)",
      type: "n8n-nodes-base.twilio",
      typeVersion: 3,
      position: pos(620, 440),
      parameters: {
        resource: "message",
        operation: "create",
        from: "={{'whatsapp:' + ($json.from || '+10000000000')}}",
        to: "={{'whatsapp:' + ($json.to || '+10000000001')}}",
        message: "={{$json.message}}",
      },
      credentials: {},
    });

    // 8) Place Call (HTTP Request placeholder, simple POST body)
    const nCall = addNode(wf, {
      id: uid("call"),
      name: "Place Call (Webhook/Provider)",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4,
      position: pos(620, 580),
      parameters: {
        url: "={{$json.callWebhook}}",
        method: "POST",
        jsonParameters: true,
        sendBody: true,
        // Build a tiny body without exotic features
        bodyParametersJson: "={{ { to: $json.to, from: $json.from, text: $json.message } }}",
      },
    });

    // 9) Delay (compat instead of Wait)
    const nDelay = addNode(wf, {
      id: uid("delay"),
      name: "Delay",
      type: "n8n-nodes-base.delay",
      typeVersion: 1,
      position: pos(920, 300),
      parameters: {
        amount: 30,
        unit: "minutes",
      },
    });

    // wiring
    connect(wf, nManual, nSet);
    connect(wf, nSet, nCompose);
    connect(wf, nCompose, nSwitch);

    // switch outputs: 0=email, 1=sms, 2=whatsapp, 3=call
    connect(wf, nSwitch, nEmail, 0);
    connect(wf, nSwitch, nSMS, 1);
    connect(wf, nSwitch, nWA, 2);
    connect(wf, nSwitch, nCall, 3);

    // each channel → Delay
    connect(wf, nEmail, nDelay);
    connect(wf, nSMS, nDelay);
    connect(wf, nWA, nDelay);
    connect(wf, nCall, nDelay);

    return wf;
  }

  // Expose global
  window.Builder = { buildWorkflowJSON };
})();
