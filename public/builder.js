// public/builder.js
// Plain script (NOT a module). Exposes: window.Builder = { buildWorkflowJSON }.
// Adds a 10-template registry so scenarios generate different n8n workflows.
// SAFE-first (imports on most n8n versions). Use ?compat=full to use real channel nodes.

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

  function getQS(name, fallback=null) {
    const v = new URLSearchParams(location.search).get(name);
    return v==null ? fallback : v;
  }
  function getCompatMode() {
    const v = (getQS("compat","safe")||"").toLowerCase();
    return v === "full" ? "full" : "safe";
  }

  // Core “compose message” function node (shared)
  function composeMessageFunctionBody() {
    return `// Compose message from scenario + industry + channel
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

const prefix = { email:'📧 Email', sms:'📱 SMS', whatsapp:'🟢 WhatsApp', call:'📞 Call' }[channel] || 'Message';
return [{ message: \`\${prefix} — \${headline}\\n\\n\${lines.join('\\n')}\`, channel }];`;
  }

  // SAFE leaf (Function) as a stand-in for channel actions
  function addNoOpLeaf(wf, label, x, y) {
    return addNode(wf, {
      id: uid("noop"), name: label, type: "n8n-nodes-base.function", typeVersion: 2,
      position: pos(x, y),
      parameters: { functionCode:
`// Placeholder leaf. Replace with real node(s) post-import if needed.
return [{ note: '${label}', channel: $json.channel, message: $json.message }];`
      }
    });
  }

  // FULL channel nodes (optional)
  function addEmailNode(wf, x, y) {
    return addNode(wf, {
      id: uid("email"), name: "Send Email", type: "n8n-nodes-base.emailSend", typeVersion: 3,
      position: pos(x, y),
      parameters: { to: "={{$json.to || 'recipient@example.com'}}", subject: "={{$json.scenario?.agent_name || 'AI Outreach'}}", text: "={{$json.message}}" },
      credentials: {}
    });
  }
  function addSMSNode(wf, x, y) {
    return addNode(wf, {
      id: uid("sms"), name: "Send SMS", type: "n8n-nodes-base.twilio", typeVersion: 3,
      position: pos(x, y),
      parameters: { resource: "message", operation: "create", from: "={{$json.from || '+10000000000'}}", to: "={{$json.to || '+10000000001'}}", message: "={{$json.message}}" },
      credentials: {}
    });
  }
  function addWANode(wf, x, y) {
    return addNode(wf, {
      id: uid("wa"), name: "Send WhatsApp (Twilio)", type: "n8n-nodes-base.twilio", typeVersion: 3,
      position: pos(x, y),
      parameters: { resource: "message", operation: "create", from: "={{'whatsapp:' + ($json.from || '+10000000000')}}", to: "={{'whatsapp:' + ($json.to || '+10000000001')}}", message: "={{$json.message}}" },
      credentials: {}
    });
  }
  function addCallNode(wf, x, y) {
    return addNode(wf, {
      id: uid("call"), name: "Place Call (Webhook/Provider)", type: "n8n-nodes-base.httpRequest", typeVersion: 4,
      position: pos(x, y),
      parameters: { url: "={{$json.callWebhook || 'https://example.com/call'}}", method: "POST", jsonParameters: true, sendBody: true,
        bodyParametersJson: "={{ { to: $json.to || '+10000000001', from: $json.from || '+10000000000', text: $json.message } }}" }
    });
  }

  // Common “Init Context” node (safer than Set across versions)
  function addInitNode(wf, scenario, industry, recommendedChannel, x, y) {
    return addNode(wf, {
      id: uid("init"), name: "Init Context", type: "n8n-nodes-base.function", typeVersion: 2,
      position: pos(x, y),
      parameters: {
        functionCode:
`const scenario = $json.scenario || ${JSON.stringify(scenario || {})};
const industry = $json.industry || ${JSON.stringify(industry || {})};
const recommendedChannel = ($json.recommendedChannel || ${JSON.stringify(recommendedChannel)});
const to = $json.to || 'recipient@example.com';
const from = $json.from || '+10000000000';
const callWebhook = $json.callWebhook || 'https://example.com/call';
return [{ scenario, industry, recommendedChannel, to, from, callWebhook }];`
      }
    });
  }

  // Shared “Compose” + “Switch channel”
  function addComposeNode(wf, x, y) {
    return addNode(wf, { id: uid("func"), name: "Compose Message", type: "n8n-nodes-base.function", typeVersion: 2, position: pos(x, y), parameters: { functionCode: composeMessageFunctionBody() } });
  }
  function addSwitchChannelNode(wf, x, y) {
    return addNode(wf, {
      id: uid("switch"), name: "Choose Channel", type: "n8n-nodes-base.switch", typeVersion: 2,
      position: pos(x, y),
      parameters: { value1: "={{$json.channel}}", rules: [
        { operation: "equal", value2: "email" },
        { operation: "equal", value2: "sms" },
        { operation: "equal", value2: "whatsapp" },
        { operation: "equal", value2: "call" },
      ] }
    });
  }

  // Simple If node helper
  function addIfNode(wf, name, leftExpr, operation, rightValue, x, y) {
    return addNode(wf, {
      id: uid("if"), name, type: "n8n-nodes-base.if", typeVersion: 2, position: pos(x, y),
      parameters: { conditions: { number: [], string: [{ value1: leftExpr, operation, value2: rightValue }] } }
    });
  }

  // Merge node helper (by position only, defaults work)
  function addMergeNode(wf, name, x, y) {
    return addNode(wf, { id: uid("merge"), name, type: "n8n-nodes-base.merge", typeVersion: 2, position: pos(x, y), parameters: { mode: "append" } });
  }

  // --------------- TEMPLATES (10) ---------------
  // Each template is a function(wf, ctx) that adds nodes + wiring.
  // ctx = { scenario, industry, channel, compat, addChannelLeaves(four nodes) }

  const TEMPLATES = {
    // 1) Scheduling / Appointments
    SCHEDULING(wf, ctx) {
      const nManual = addNode(wf, { id: uid("manual"), name: "Manual Trigger", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: pos(-680, 300), parameters: {} });
      const nInit   = addInitNode(wf, ctx.scenario, ctx.industry, ctx.channel, -500, 300);
      const nCompose= addComposeNode(wf, -260, 300);
      const nIf     = addIfNode(wf, "Has Appointment?", "={{$json.scenario?.tags || ''}}", "contains", "appointment", 0, 300);
      const nSwitch = addSwitchChannelNode(wf, 240, 300);

      connect(wf, nManual, nInit); connect(wf, nInit, nCompose); connect(wf, nCompose, nIf);
      // If true => channel send; false => compose anyway
      connect(wf, nIf, nSwitch, 0);
      connect(wf, nIf, nSwitch, 1);

      const leaves = ctx.addChannelLeaves(540, [160,300,440,580]);
      leaves.forEach((leaf, i)=> connect(wf, nSwitch, leaf, i));
    },

    // 2) Lead Capture & Enrichment
    LEAD_INTAKE(wf, ctx) {
      const nManual = addNode(wf, { id: uid("manual"), name: "Manual Trigger", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: pos(-680, 260), parameters: {} });
      const nInit   = addInitNode(wf, ctx.scenario, ctx.industry, ctx.channel, -500, 260);
      const nCompose= addComposeNode(wf, -260, 260);
      const nEnrich = addNode(wf, { id: uid("http"), name: "Enrich (HTTP)", type: "n8n-nodes-base.httpRequest", typeVersion: 4, position: pos(40, 260),
        parameters: { url: "={{$json.enrichUrl || 'https://example.com/enrich'}}", method: "POST", jsonParameters: true, sendBody: true, bodyParametersJson: "={{$json}}" }});
      const nSwitch = addSwitchChannelNode(wf, 320, 260);

      connect(wf, nManual, nInit); connect(wf, nInit, nCompose); connect(wf, nCompose, nEnrich); connect(wf, nEnrich, nSwitch);

      const leaves = ctx.addChannelLeaves(620, [120,260,400,540]);
      leaves.forEach((leaf, i)=> connect(wf, nSwitch, leaf, i));
    },

    // 3) Billing / AR follow-up
    BILLING(wf, ctx) {
      const nManual = addNode(wf, { id: uid("manual"), name: "Manual Trigger", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: pos(-680, 300), parameters: {} });
      const nInit   = addInitNode(wf, ctx.scenario, ctx.industry, ctx.channel, -500, 300);
      const nCompose= addComposeNode(wf, -260, 300);
      const nIfDue  = addIfNode(wf, "Is Overdue?", "={{$json.scenario?.tags || ''}}", "contains", "overdue", 40, 300);
      const nSwitch = addSwitchChannelNode(wf, 320, 300);

      connect(wf, nManual, nInit); connect(wf, nInit, nCompose); connect(wf, nCompose, nIfDue);
      connect(wf, nIfDue, nSwitch, 0); connect(wf, nIfDue, nSwitch, 1);

      const leaves = ctx.addChannelLeaves(620, [160,300,440,580]);
      leaves.forEach((leaf, i)=> connect(wf, nSwitch, leaf, i));
    },

    // 4) Customer Success / Onboarding nudges
    SUCCESS_ONBOARD(wf, ctx) {
      const nManual = addNode(wf, { id: uid("manual"), name: "Manual Trigger", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: pos(-680, 260), parameters: {} });
      const nInit   = addInitNode(wf, ctx.scenario, ctx.industry, ctx.channel, -500, 260);
      const nCompose= addComposeNode(wf, -260, 260);
      const nSwitch = addSwitchChannelNode(wf, 60, 260);
      const nMerge  = addMergeNode(wf, "Collect Acks", 900, 260);

      connect(wf, nManual, nInit); connect(wf, nInit, nCompose); connect(wf, nCompose, nSwitch);

      const leaves = ctx.addChannelLeaves(360, [120,260,400,540]);
      leaves.forEach((leaf, i)=> connect(wf, nSwitch, leaf, i));
      // simulate all → merge
      leaves.forEach(leaf => connect(wf, leaf, nMerge));
    },

    // 5) Escalation / Incident triage
    ESCALATION(wf, ctx) {
      const nManual = addNode(wf, { id: uid("manual"), name: "Manual Trigger", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: pos(-700, 280), parameters: {} });
      const nInit   = addInitNode(wf, ctx.scenario, ctx.industry, ctx.channel, -520, 280);
      const nCompose= addComposeNode(wf, -280, 280);
      const nIfSev  = addIfNode(wf, "Severity High?", "={{$json.scenario?.tags || ''}}", "contains", "sev:high", 0, 280);
      const nSwitch = addSwitchChannelNode(wf, 280, 280);

      connect(wf, nManual, nInit); connect(wf, nInit, nCompose); connect(wf, nCompose, nIfSev);
      connect(wf, nIfSev, nSwitch, 0); connect(wf, nIfSev, nSwitch, 1);

      const leaves = ctx.addChannelLeaves(580, [140,280,420,560]);
      leaves.forEach((leaf, i)=> connect(wf, nSwitch, leaf, i));
    },

    // 6) Renewal / Upsell
    RENEW_UPSELL(wf, ctx) {
      const nManual = addNode(wf, { id: uid("manual"), name: "Manual Trigger", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: pos(-700, 240), parameters: {} });
      const nInit   = addInitNode(wf, ctx.scenario, ctx.industry, ctx.channel, -520, 240);
      const nCompose= addComposeNode(wf, -280, 240);
      const nIfVip  = addIfNode(wf, "Is VIP?", "={{$json.scenario?.tags || ''}}", "contains", "vip", 0, 240);
      const nSwitch = addSwitchChannelNode(wf, 300, 240);

      connect(wf, nManual, nInit); connect(wf, nInit, nCompose); connect(wf, nCompose, nIfVip);
      connect(wf, nIfVip, nSwitch, 0); connect(wf, nIfVip, nSwitch, 1);

      const leaves = ctx.addChannelLeaves(600, [100,240,380,520]);
      leaves.forEach((leaf, i)=> connect(wf, nSwitch, leaf, i));
    },

    // 7) Reactivation / Winback
    WINBACK(wf, ctx) {
      const nManual = addNode(wf, { id: uid("manual"), name: "Manual Trigger", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: pos(-700, 300), parameters: {} });
      const nInit   = addInitNode(wf, ctx.scenario, ctx.industry, ctx.channel, -520, 300);
      const nCompose= addComposeNode(wf, -280, 300);
      const nSwitch = addSwitchChannelNode(wf, 40, 300);

      connect(wf, nManual, nInit); connect(wf, nInit, nCompose); connect(wf, nCompose, nSwitch);

      const leaves = ctx.addChannelLeaves(340, [160,300,440,580]);
      leaves.forEach((leaf, i)=> connect(wf, nSwitch, leaf, i));
    },

    // 8) Compliance / Notices
    COMPLIANCE(wf, ctx) {
      const nManual = addNode(wf, { id: uid("manual"), name: "Manual Trigger", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: pos(-720, 300), parameters: {} });
      const nInit   = addInitNode(wf, ctx.scenario, ctx.industry, ctx.channel, -540, 300);
      const nCompose= addComposeNode(wf, -300, 300);
      const nHttp   = addNode(wf, { id: uid("http"), name: "Log to DMS", type: "n8n-nodes-base.httpRequest", typeVersion: 4, position: pos(-20, 300),
        parameters: { url: "={{$json.dms || 'https://example.com/dms/log'}}", method: "POST", jsonParameters: true, sendBody: true, bodyParametersJson: "={{$json}}" }});
      const nSwitch = addSwitchChannelNode(wf, 260, 300);

      connect(wf, nManual, nInit); connect(wf, nInit, nCompose); connect(wf, nCompose, nHttp); connect(wf, nHttp, nSwitch);

      const leaves = ctx.addChannelLeaves(560, [160,300,440,580]);
      leaves.forEach((leaf, i)=> connect(wf, nSwitch, leaf, i));
    },

    // 9) VIP / White-glove
    VIP_CONCIERGE(wf, ctx) {
      const nManual = addNode(wf, { id: uid("manual"), name: "Manual Trigger", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: pos(-720, 260), parameters: {} });
      const nInit   = addInitNode(wf, ctx.scenario, ctx.industry, ctx.channel, -540, 260);
      const nCompose= addComposeNode(wf, -300, 260);
      const nIfHour = addIfNode(wf, "After-hours?", "={{$now.hour}}", "larger", "17", 0, 260);
      const nSwitch = addSwitchChannelNode(wf, 260, 260);

      connect(wf, nManual, nInit); connect(wf, nInit, nCompose); connect(wf, nCompose, nIfHour);
      connect(wf, nIfHour, nSwitch, 0); connect(wf, nIfHour, nSwitch, 1);

      const leaves = ctx.addChannelLeaves(560, [120,260,400,540]);
      leaves.forEach((leaf, i)=> connect(wf, nSwitch, leaf, i));
    },

    // 10) Feedback / NPS
    FEEDBACK_NPS(wf, ctx) {
      const nManual = addNode(wf, { id: uid("manual"), name: "Manual Trigger", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: pos(-720, 300), parameters: {} });
      const nInit   = addInitNode(wf, ctx.scenario, ctx.industry, ctx.channel, -540, 300);
      const nCompose= addComposeNode(wf, -300, 300);
      const nHttp   = addNode(wf, { id: uid("http"), name: "Create NPS Link", type: "n8n-nodes-base.httpRequest", typeVersion: 4, position: pos(-20, 300),
        parameters: { url: "={{$json.nps || 'https://example.com/nps/create'}}", method: "POST", jsonParameters: true, sendBody: true, bodyParametersJson: "={{$json}}" }});
      const nSwitch = addSwitchChannelNode(wf, 260, 300);

      connect(wf, nManual, nInit); connect(wf, nInit, nCompose); connect(wf, nCompose, nHttp); connect(wf, nHttp, nSwitch);

      const leaves = ctx.addChannelLeaves(560, [160,300,440,580]);
      leaves.forEach((leaf, i)=> connect(wf, nSwitch, leaf, i));
    },
  };

  // Template selection (URL → scenario tag → default by channel)
  function resolveTemplateName(scenario, recommendedChannel) {
    const fromQS = (getQS("tmpl","")||"").toUpperCase().trim();
    if (fromQS && TEMPLATES[fromQS]) return fromQS;

    const tags = []
      .concat(scenario?.tags || [])
      .concat(String(scenario?.tags_text || "").split(/[;,|]/))
      .map(t => String(t||"").trim().toUpperCase());
    const tagTmpl = tags.find(t => t.startsWith("TMPL:"));
    if (tagTmpl) {
      const name = tagTmpl.replace("TMPL:","").trim();
      if (TEMPLATES[name]) return name;
    }

    // default by channel
    switch ((recommendedChannel||"email").toLowerCase()) {
      case "sms": case "whatsapp": return "WINBACK";
      case "call": return "VIP_CONCIERGE";
      default: return "SCHEDULING";
    }
  }

  // ----------------- main builder -----------------
  function buildWorkflowJSON(scenario, industry, opts = {}) {
    const channel = String((opts.recommendedChannel || 'email')).toLowerCase();
    const wfName = `${scenario?.scenario_id || scenario?.title || 'AI Agent Workflow'} — ${industry?.name || industry?.industry_id || 'Industry'}`;
    const wf = baseWorkflow(wfName);
    const compat = getCompatMode();
    const tmplName = resolveTemplateName(scenario, channel);
    const tmpl = TEMPLATES[tmplName] || TEMPLATES.SCHEDULING;

    // Helper to drop appropriate leaves for channels
    const addChannelLeaves = (x, ys) => {
      if (compat === "full") {
        return [
          addEmailNode(wf, x, ys[0]),
          addSMSNode(wf,   x, ys[1]),
          addWANode(wf,    x, ys[2]),
          addCallNode(wf,  x, ys[3]),
        ];
      } else {
        return [
          addNoOpLeaf(wf, "Email Placeholder",   x, ys[0]),
          addNoOpLeaf(wf, "SMS Placeholder",     x, ys[1]),
          addNoOpLeaf(wf, "WhatsApp Placeholder",x, ys[2]),
          addNoOpLeaf(wf, "Call Placeholder",    x, ys[3]),
        ];
      }
    };

    const ctx = { scenario, industry, channel, compat, addChannelLeaves };
    tmpl(wf, ctx);
    return wf;
  }

  // Expose global
  window.Builder = { buildWorkflowJSON };
})();
