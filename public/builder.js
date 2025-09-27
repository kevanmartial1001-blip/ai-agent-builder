// public/builder.js
// Plain script (NOT a module). Exposes: window.Builder = { buildWorkflowJSON }.
// Ultra-compatible export for n8n import (avoids brittle params).
// Switch presets by URL: ?compat=full | ?compat=safe  (default: safe)

(function () {
  "use strict";

  // ----------------- helpers -----------------
  const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
  const pos = (x, y) => [x, y];

  function baseWorkflow(name) {
    return {
      name: name || "AI Agent Workflow",
      nodes: [],
      connections: {},
      active: false,
      settings: {},
      staticData: {},
    };
  }

  function addNode(wf, node) {
    wf.nodes.push(node);
    return node.name; // connection key
  }

  function connect(wf, from, to, outputIndex = 0) {
    wf.connections[from] ??= {};
    wf.connections[from].main ??= [];
    for (let i = wf.connections[from].main.length; i <= outputIndex; i++) {
      wf.connections[from].main[i] = [];
    }
    wf.connections[from].main[outputIndex].push({ node: to, type: "main", index: 0 });
  }

  function getCompatMode() {
    const params = new URLSearchParams(location.search);
    const v = (params.get("compat") || "safe").toLowerCase();
    return v === "full" ? "full" : "safe";
  }

  // Message composer logic kept in a Function node (most stable)
  function composeMessageFunctionBody() {
    return `// Build outreach message from scenario + industry + channel (n8n Function node)
const s = $json.scenario || {};
const ind = $json.industry || {};
const channel = String($json.recommendedChannel || 'email').toLowerCase();

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

  // ----------------- minimal but useful nodes -----------------
  function addManual(wf) {
    return addNode(wf, {
      id: uid("manual"),
      name: "Manual Trigger",
      type: "n8n-nodes-base.manualTrigger",
      typeVersion: 1,
      position: pos(-520, 300),
      parameters: {},
    });
  }

  function addFunctionCompose(wf) {
    return addNode(wf, {
      id: uid("func"),
      name: "Compose Message",
      type: "n8n-nodes-base.function",
      typeVersion: 2,
      position: pos(-160, 300),
      parameters: { functionCode: composeMessageFunctionBody() },
    });
  }

  function addSwitchChannel(wf) {
    return addNode(wf, {
      id: uid("switch"),
      name: "Choose Channel",
      type: "n8n-nodes-base.switch",
      typeVersion: 2,
      position: pos(160, 300),
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
  }

  // FULL preset nodes (may vary across versions; we keep them simple)
  function addEmailNode(wf) {
    return addNode(wf, {
      id: uid("email"),
      name: "Send Email",
      type: "n8n-nodes-base.emailSend",
      typeVersion: 3, // widely used; if your n8n is older try 2
      position: pos(460, 160),
      parameters: {
        // many versions accept "to" OR "toList"; we use "to" for simplicity
        to: "={{$json.to || 'recipient@example.com'}}",
        subject: "={{$json.scenario?.agent_name || 'AI Outreach'}}",
        text: "={{$json.message}}",
      },
      credentials: {}, // set in n8n after import
    });
  }

  function addSMSNode(wf) {
    return addNode(wf, {
      id: uid("sms"),
      name: "Send SMS",
      type: "n8n-nodes-base.twilio",
      typeVersion: 3,
      position: pos(460, 300),
      parameters: {
        resource: "message",
        operation: "create",
        from: "={{$json.from || '+10000000000'}}",
        to: "={{$json.to || '+10000000001'}}",
        message: "={{$json.message}}",
      },
      credentials: {},
    });
  }

  function addWhatsAppNode(wf) {
    return addNode(wf, {
      id: uid("wa"),
      name: "Send WhatsApp (Twilio)",
      type: "n8n-nodes-base.twilio",
      typeVersion: 3,
      position: pos(460, 440),
      parameters: {
        resource: "message",
        operation: "create",
        from: "={{'whatsapp:' + ($json.from || '+10000000000')}}",
        to: "={{'whatsapp:' + ($json.to || '+10000000001')}}",
        message: "={{$json.message}}",
      },
      credentials: {},
    });
  }

  function addCallNode(wf) {
    return addNode(wf, {
      id: uid("call"),
      name: "Place Call (Webhook/Provider)",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4,
      position: pos(460, 580),
      parameters: {
        url: "={{$json.callWebhook || 'https://example.com/call'}}",
        method: "POST",
        jsonParameters: true,
        sendBody: true,
        bodyParametersJson: "={{ { to: $json.to || '+10000000001', from: $json.from || '+10000000000', text: $json.message } }}",
      },
    });
  }

  // SAFE preset leaf node = generic **NoOp** Function
  function addNoOpLeaf(wf, label, y) {
    return addNode(wf, {
      id: uid("noop"),
      name: label,
      type: "n8n-nodes-base.function",
      typeVersion: 2,
      position: pos(460, y),
      parameters: {
        functionCode:
`// SAFE leaf - replace with real node after import
const out = {
  channel: $json.channel,
  message: $json.message,
  note: '${label} placeholder',
};
return [out];`,
      },
    });
  }

  // ----------------- builder -----------------
  function buildWorkflowJSON(scenario, industry, opts = {}) {
    const recommendedChannel = String((opts.recommendedChannel || "email")).toLowerCase();
    const wfName =
      (scenario?.scenario_id || scenario?.title || "AI Agent Workflow") +
      " — " +
      (industry?.name || industry?.industry_id || "Industry");

    const wf = baseWorkflow(wfName);
    const compatMode = getCompatMode(); // 'safe' (default) or 'full'

    // Nodes common to both modes
    const nManual = addManual(wf);

    // Instead of a Set node (schema varies), inject base fields via an initial Function
    const nInit = addNode(wf, {
      id: uid("init"),
      name: "Init Context",
      type: "n8n-nodes-base.function",
      typeVersion: 2,
      position: pos(-340, 300),
      parameters: {
        functionCode:
`// Initialize JSON payload (safer than Set node across versions)
const scenario = $json.scenario || ${JSON.stringify(scenario || {})};
const industry = $json.industry || ${JSON.stringify(industry || {})};
const recommendedChannel = ($json.recommendedChannel || ${JSON.stringify(recommendedChannel)});
const to = $json.to || 'recipient@example.com';
const from = $json.from || '+10000000000';
const callWebhook = $json.callWebhook || 'https://example.com/call';

return [{
  scenario, industry, recommendedChannel, to, from, callWebhook
}];`,
      },
    });

    const nCompose = addFunctionCompose(wf);
    const nSwitch  = addSwitchChannel(wf);

    // Wire the common path
    connect(wf, nManual, nInit);
    connect(wf, nInit, nCompose);
    connect(wf, nCompose, nSwitch);

    if (compatMode === "full") {
      // FULL: real channel nodes (may vary by version)
      const nEmail = addEmailNode(wf);
      const nSMS   = addSMSNode(wf);
      const nWA    = addWhatsAppNode(wf);
      const nCall  = addCallNode(wf);

      // switch outputs: 0=email, 1=sms, 2=whatsapp, 3=call
      connect(wf, nSwitch, nEmail, 0);
      connect(wf, nSwitch, nSMS, 1);
      connect(wf, nSwitch, nWA, 2);
      connect(wf, nSwitch, nCall, 3);
    } else {
      // SAFE: placeholder leaves (always import)
      const nLeafEmail = addNoOpLeaf(wf, "Email Placeholder", 160);
      const nLeafSMS   = addNoOpLeaf(wf, "SMS Placeholder", 300);
      const nLeafWA    = addNoOpLeaf(wf, "WhatsApp Placeholder", 440);
      const nLeafCall  = addNoOpLeaf(wf, "Call Placeholder", 580);

      connect(wf, nSwitch, nLeafEmail, 0);
      connect(wf, nSwitch, nLeafSMS, 1);
      connect(wf, nSwitch, nLeafWA, 2);
      connect(wf, nSwitch, nLeafCall, 3);
    }

    return wf;
  }

  // Expose global
  window.Builder = { buildWorkflowJSON };
})();
