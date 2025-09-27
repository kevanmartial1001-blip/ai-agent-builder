// Plain script (NOT a module). Must attach a global for index.html to call.
// Final line exposes: window.Builder = { buildWorkflowJSON }.

(function () {
  "use strict";

  // Small helpers
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const toPos = (x, y) => [x, y];
  const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;

  // n8n requires: { name, nodes: [], connections: {} } at minimum.
  // We'll add a few standard fields for nicer importing.
  function baseWorkflowMeta(name) {
    return {
      name: name || "AI Agent Workflow",
      nodes: [],
      connections: {},
      active: false,
      settings: {
        saveExecutionProgress: true,
      },
      staticData: {},
      meta: {
        templateCredsSetup: true,
      },
    };
  }

  // Convenience to push a node and return its name (key for connections)
  function addNode(wf, node) {
    wf.nodes.push(node);
    return node.name;
  }

  // Connect: fromNode --(outputIndex=0)--> toNode
  function connect(wf, from, to, outputIndex = 0) {
    wf.connections[from] ??= {};
    wf.connections[from].main ??= [];
    // Ensure there is an array slot for this output index
    for (let i = wf.connections[from].main.length; i <= outputIndex; i++) {
      wf.connections[from].main[i] = [];
    }
    wf.connections[from].main[outputIndex].push({ node: to, type: "main", index: 0 });
  }

  // Build the message text inside a Function node
  function composeMessageFunctionBody() {
    return `// Build a message based on scenario + industry + channel
const s = $json.scenario || {};
const ind = $json.industry || {};
const channel = ($json.recommendedChannel || 'email').toLowerCase();

const headline = s.agent_name ? \`\${s.agent_name} — \${s.scenario_id || ''}\` : (s.title || 'Scenario');
const body = [
  'Industry: ' + (ind.name || ind.industry_id || 'N/A'),
  'Problem: ' + (s.problem || 'N/A'),
  'Narrative: ' + (s.narrative || 'N/A'),
  'How it works: ' + (s.how_it_works || 'N/A')
].join('\\n');

const channelPrefix = {
  email: '📧 Email',
  sms: '📱 SMS',
  whatsapp: '🟢 WhatsApp',
  call: '📞 Call'
}[channel] || 'Message';

const text = \`\${channelPrefix} — \${headline}\\n\\n\${body}\`;

return [{ message: text, channel }];`;
  }

  // The main builder
  function buildWorkflowJSON(scenario, industry, opts = {}) {
    const recommendedChannel = (opts.recommendedChannel || 'email').toLowerCase();

    const name =
      (scenario?.scenario_id || scenario?.title || "AI Agent Workflow")
      + " — "
      + (industry?.name || industry?.industry_id || "Industry");

    const wf = baseWorkflowMeta(name);

    // 1) Manual Trigger
    const nManual = addNode(wf, {
      id: uid("manual"),
      name: "Manual Trigger",
      type: "n8n-nodes-base.manualTrigger",
      typeVersion: 1,
      position: toPos(-420, 300),
      parameters: {},
    });

    // 2) Set Config (inject scenario/industry/channel into the JSON)
    const nSet = addNode(wf, {
      id: uid("set"),
      name: "Set Config",
      type: "n8n-nodes-base.set",
      typeVersion: 2,
      position: toPos(-160, 300),
      parameters: {
        keepOnlySet: true,
        values: {
          string: [
            { name: "recommendedChannel", value: recommendedChannel },
            { name: "scenario_id", value: scenario?.scenario_id || "" },
            { name: "industry_id", value: industry?.industry_id || "" },
          ],
          json: [
            { name: "scenario", value: scenario || {} },
            { name: "industry", value: industry || {} },
          ],
        },
        options: {},
      },
    });

    // 3) Compose Message (Function)
    const nCompose = addNode(wf, {
      id: uid("func"),
      name: "Compose Message",
      type: "n8n-nodes-base.function",
      typeVersion: 2,
      position: toPos(120, 300),
      parameters: {
        functionCode: composeMessageFunctionBody(),
      },
    });

    // 4) Switch by channel
    const nSwitch = addNode(wf, {
      id: uid("switch"),
      name: "Choose Channel",
      type: "n8n-nodes-base.switch",
      typeVersion: 2,
      position: toPos(420, 300),
      parameters: {
        value1: "={{$json.channel}}",
        rules: [
          { operation: "equal", value2: "email" },
          { operation: "equal", value2: "sms" },
          { operation: "equal", value2: "whatsapp" },
          { operation: "equal", value2: "call" },
        ],
      },
    });

    // 5) Email
    const nEmail = addNode(wf, {
      id: uid("email"),
      name: "Send Email",
      type: "n8n-nodes-base.emailSend",
      typeVersion: 3,
      position: toPos(720, 140),
      parameters: {
        subject: "={{$json.scenario?.agent_name || 'AI Outreach'}}",
        toList: "={{$json.to || 'recipient@example.com'}}",
        text: "={{$json.message}}",
      },
      // credentials will be set in n8n UI
      credentials: {},
    });

    // 6) SMS (Twilio)
    const nSMS = addNode(wf, {
      id: uid("sms"),
      name: "Send SMS",
      type: "n8n-nodes-base.twilio",
      typeVersion: 3,
      position: toPos(720, 300),
      parameters: {
        resource: "message",
        operation: "create",
        from: "={{$json.from || '+10000000000'}}",
        to: "={{$json.to || '+10000000001'}}",
        message: "={{$json.message}}",
      },
      credentials: {},
    });

    // 7) WhatsApp (Twilio)
    const nWA = addNode(wf, {
      id: uid("wa"),
      name: "Send WhatsApp (Twilio)",
      type: "n8n-nodes-base.twilio",
      typeVersion: 3,
      position: toPos(720, 460),
      parameters: {
        resource: "message",
        operation: "create",
        from: "={{$json.from || 'whatsapp:+10000000000'}}",
        to: "={{$json.to || 'whatsapp:+10000000001'}}",
        message: "={{$json.message}}",
      },
      credentials: {},
    });

    // 8) Call (placeholder via HTTP Request)
    const nCall = addNode(wf, {
      id: uid("call"),
      name: "Place Call (Webhook/Provider)",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4,
      position: toPos(720, 620),
      parameters: {
        url: "={{$json.callWebhook || 'https://example.com/call'}}",
        options: {},
        sendBody: true,
        jsonParameters: true,
        bodyParametersJson: "={{ { to: $json.to || '+10000000001', text: $json.message } }}",
      },
    });

    // 9) Wait for Reply
    const nWait = addNode(wf, {
      id: uid("wait"),
      name: "Wait for Reply",
      type: "n8n-nodes-base.wait",
      typeVersion: 1,
      position: toPos(1020, 300),
      parameters: {
        options: {
          // Basic fixed wait; adapt later to webhook/resume if you wish
          waitTill: "timeInterval",
          timeUnit: "minutes",
          value: 30,
        },
      },
    });

    // Wire connections
    connect(wf, nManual, nSet);
    connect(wf, nSet, nCompose);
    connect(wf, nCompose, nSwitch);

    // Switch outputs: 0=email, 1=sms, 2=whatsapp, 3=call
    connect(wf, nSwitch, nEmail, 0);
    connect(wf, nSwitch, nSMS, 1);
    connect(wf, nSwitch, nWA, 2);
    connect(wf, nSwitch, nCall, 3);

    // Route all channels to Wait for Reply (each from its own output 0)
    connect(wf, nEmail, nWait, 0);
    connect(wf, nSMS, nWait, 0);
    connect(wf, nWA, nWait, 0);
    connect(wf, nCall, nWait, 0);

    return wf;
  }

  // EXPOSE GLOBAL (critical for non-module script usage)
  // Do this synchronously so index.html can call it right away after the <script> tag.
  window.Builder = { buildWorkflowJSON };
})();
