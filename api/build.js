// api/build.js
// Build a scenario-specific n8n workflow on the server (Prod + Demo lanes, clean layout).
// Works with your existing Google Sheets source. Optional AI enrichment if OPENAI_API_KEY is set.
// Returns JSON to the UI for preview; add ?download=1 to force file download.
//
// ENV required (same as /api/scenarios):
//   SHEET_ID, GOOGLE_API_KEY, (optional) SHEET_TAB (default "Scenarios")
// Optional:
//   OPENAI_API_KEY  -> enables AI plan enrichment (safe, compact)

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

const sstr = (v) => (v == null ? "" : String(v));
const listify = (v) =>
  Array.isArray(v)
    ? v.map((x) => String(x).trim()).filter(Boolean)
    : sstr(v)
        .split(/[;,/|\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);

/* ---------------- Data source (same shape as /api/scenarios) ---------------- */

function toObj(header, row) {
  return Object.fromEntries(header.map((h, i) => [h, (row[i] ?? "").toString().trim()]));
}
async function fetchSheets({ sheetId, tab, apiKey }) {
  const range = encodeURIComponent(tab || "Scenarios");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?key=${apiKey}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Sheets API error: ${r.status} ${r.statusText}`);
  const data = await r.json();
  const rows = data.values || [];
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((rw) => toObj(header, rw));
}

function projectScenario(x) {
  return {
    scenario_id: x["scenario_id"] || "",
    name: x["name"] || "",
    triggers: x["triggers"] || "",
    best_reply_shapes: listify(x["best_reply_shapes"] || ""),
    risk_notes: x["risk_notes"] || "",
    agent_name: x["agent_name"] || "",
    how_it_works: x["how_it_works"] || "",
    tool_stack_dev: x["tool_stack_dev"] || "",
    tool_stack_autonomous: x["tool_stack_autonomous"] || "",
    tags: listify(x["tags (;)"] || x["tags"] || ""),
    roi_hypothesis: x["roi_hypothesis"] || "",
    industry_id: x["industry_id"] || x["name"] || "",
    archetype: x["archetype"] || "",
  };
}

/* ---------------- Light rules (fallback when no AI) ---------------- */

function classifyFallback(s) {
  const hay = [s.scenario_id, s.name, ...(s.tags || [])].join(" ").toLowerCase();
  const rules = [
    { a: "APPOINTMENT_SCHEDULING", rx: /appointment|scheduling|no[-_ ]?show|calendar/ },
    { a: "CUSTOMER_SUPPORT_INTAKE", rx: /\b(cs|support|helpdesk|ticket|sla|triage|escalation|deflection|kb)\b/ },
    { a: "FEEDBACK_NPS", rx: /\b(nps|survey|feedback|csat|ces)\b/ },
    { a: "KNOWLEDGEBASE_FAQ", rx: /\b(kb|faq|knowledge|self-?service)\b/ },
    { a: "SALES_OUTREACH", rx: /\b(sales|outreach|cadence|sequence|abm|prospect)\b/ },
    { a: "LEAD_QUAL_INBOUND", rx: /\b(inbound|lead[-_ ]?qual|routing|form)\b/ },
    { a: "CHURN_WINBACK", rx: /\b(churn|win[-_ ]?back|reactivation|retention)\b/ },
    { a: "RENEWALS_CSM", rx: /\b(renewal|qbr|csm|upsell|cross-?sell)\b/ },
    { a: "AR_FOLLOWUP", rx: /\b(a\/?r|receivable|invoice|collections?|dso)\b/ },
    { a: "AP_AUTOMATION", rx: /\b(a\/?p|payable|invoice|3[-\s]?way|matching|approval)\b/ },
    { a: "INVENTORY_MONITOR", rx: /\b(inventory|stock|warehouse|3pl|wms|threshold)\b/ },
    { a: "REPLENISHMENT_PO", rx: /\b(replenish|purchase[-_ ]?order|po|procure|vendor|supplier)\b/ },
    { a: "FIELD_SERVICE_DISPATCH", rx: /\b(dispatch|work[-_ ]?order|technician|field|route|eta)\b/ },
    { a: "COMPLIANCE_AUDIT", rx: /\b(compliance|audit|policy|governance|sox|iso|hipaa|gdpr)\b/ },
    { a: "INCIDENT_MGMT", rx: /\b(incident|sev|major|rca|postmortem|downtime|slo)\b/ },
    { a: "DATA_PIPELINE_ETL", rx: /\b(etl|pipeline|ingest|transform|load|orchestrate)\b/ },
    { a: "REPORTING_KPI_DASH", rx: /\b(dashboard|kpi|scorecard|report)\b/ },
    { a: "ACCESS_GOVERNANCE", rx: /\b(access|rbac|sso|entitlements|identity|pii|dlp)\b/ },
    { a: "PRIVACY_DSR", rx: /\b(dsr|data subject|privacy|gdpr|ccpa)\b/ },
    { a: "RECRUITING_INTAKE", rx: /\b(recruit|ats|resume|candidate|interview)\b/ },
  ];
  for (const r of rules) if (r.rx.test(hay)) return r.a;
  return "SALES_OUTREACH";
}

function deriveSignals(s) {
  const txt = (k) => sstr(s[k]).toLowerCase();
  let trigger = "manual";
  if (/\b(daily|weekly|monthly|every\s+\d+\s*(min|hour|day)|cron)\b/i.test(txt("triggers"))) trigger = "cron";
  if (/webhook|callback|event|incoming/i.test(txt("triggers"))) trigger = "webhook";
  if (/email|inbox|imap/i.test(txt("triggers"))) trigger = "imap";

  const shapes = (s.best_reply_shapes || []).map((x) => String(x).toLowerCase());
  const ch = [
    ...new Set(
      shapes.map((v) =>
        v.includes("whatsapp") ? "whatsapp" : (v.includes("sms") || v.includes("text")) ? "sms" : v.includes("voice") || v.includes("call") ? "call" : v.includes("email") ? "email" : "email",
      ),
    ),
  ];
  return { trigger, channels: ch.length ? ch : ["email"] };
}

/* ---------------- Optional AI plan (compact & safe) ---------------- */

async function aiPlan(scenario) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const prompt = `Return only JSON. Design a scenario-specific workflow plan:
{
 "archetype": "...",
 "trigger": "cron|webhook|imap|manual",
 "channels": ["email","sms","whatsapp","call"],
 "branches": [{"name":"...", "condition":"..."}],
 "demoMessages": {"email":"...","sms":"...","whatsapp":"...","call":"..."}
}
Use this:
scenario_id: ${scenario.scenario_id}
name: ${scenario.name}
triggers: ${scenario.triggers}
how_it_works: ${scenario.how_it_works}
tool_stack_dev: ${scenario.tool_stack_dev}
best_reply_shapes: ${(scenario.best_reply_shapes||[]).join(', ')}
roi_hypothesis: ${scenario.roi_hypothesis}
tags: ${(scenario.tags||[]).join(', ')}`;

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Return only valid JSON. No explanations." },
          { role: "user", content: prompt },
        ],
      }),
    });
    const j = await r.json();
    const txt = j?.choices?.[0]?.message?.content || "{}";
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/* ---------------- n8n workflow builder (clean grid, two lanes) ---------------- */

const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const pos = (x, y) => [x, y];

function baseWorkflow(name) {
  return { name, nodes: [], connections: {}, active: false, settings: {}, staticData: {} };
}
function addNode(wf, node) {
  wf.nodes.push(node);
  return node.name;
}
function connect(wf, from, to, outputIndex = 0) {
  wf.connections[from] ??= { main: [] };
  wf.connections[from].main[outputIndex] ??= [];
  wf.connections[from].main[outputIndex].push({ node: to, type: "main", index: 0 });
}

function laneHeader(label, x, y) {
  return { id: uid("label"), name: `=== ${label} ===`, type: "n8n-nodes-base.function", typeVersion: 2, position: pos(x, y), parameters: { functionCode: "return [$json];" } };
}
function manual(x, y, label = "Manual Trigger") {
  return { id: uid("man"), name: label, type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: pos(x, y), parameters: {} };
}
function cron(x, y) {
  // using Function placeholder for safety (no creds needed). Change to real Cron if you want.
  return { id: uid("cron"), name: "Cron (Placeholder)", type: "n8n-nodes-base.function", typeVersion: 2, position: pos(x, y), parameters: { functionCode: "return [$json];" } };
}
function webhook(x, y) {
  return { id: uid("web"), name: "Webhook (Placeholder)", type: "n8n-nodes-base.function", typeVersion: 2, position: pos(x, y), parameters: { functionCode: "return [$json];" } };
}
function func(name, code, x, y) {
  return { id: uid("fn"), name, type: "n8n-nodes-base.function", typeVersion: 2, position: pos(x, y), parameters: { functionCode: code } };
}
function http(name, urlExpr, bodyExpr, x, y) {
  return {
    id: uid("http"),
    name,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4,
    position: pos(x, y),
    parameters: { url: urlExpr, method: "POST", jsonParameters: true, sendBody: true, bodyParametersJson: bodyExpr },
  };
}
function ifNode(name, leftExpr, op, rightVal, x, y) {
  // value2 must be a string to avoid n8n importer crash (toLowerCase on undefined/number)
  return {
    id: uid("if"),
    name,
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: pos(x, y),
    parameters: { conditions: { number: [], string: [{ value1: leftExpr, operation: op, value2: String(rightVal ?? "") }] } },
  };
}
function splitNode(x, y) {
  return { id: uid("split"), name: "Split In Batches", type: "n8n-nodes-base.splitInBatches", typeVersion: 1, position: pos(x, y), parameters: { batchSize: 20 } };
}

function composerNode(s, channel, x, y, demoMsgOverrides) {
  const override = demoMsgOverrides?.[channel] ? String(demoMsgOverrides[channel]).replace(/`/g, "\\`") : null;
  const code = `
const s = $json.scenario || {};
const ch = '${channel}';
const trim = (t,n=260)=>String(t||'').replace(/\\s+/g,' ').trim().slice(0,n);
const tailored = ${override ? "`" + override + "`" : "null"};
const base = \`[\${ch}] \${trim(s.triggers,180)}\\n\${trim(s.how_it_works,220)}\`;
return [{ message: tailored || base, subject: (s.agent_name||'Agent') + ' — ' + (s.scenario_id||'scenario') }];`;
  return func("Compose Message", code, x, y);
}
function channelLeaf(kind, x, y) {
  return func(
    `Demo Send ${kind}`,
    `
const d = $json;
return [{
  channel: '${kind}',
  to: d.to || "+34613030526",
  emailTo: d.emailTo || "kevanm.spain@gmail.com",
  waFrom: d.waFrom || "+14155238886",
  smsFrom: d.smsFrom || "+13412184164",
  callFrom: d.callFrom || "+13412184164",
  message: d.message || "(no message)"
}];`,
    x,
    y,
  );
}

/* Build a single lane in a clean left-to-right grid */
function buildLane(wf, label, scenario, signals, { yOffset = 0, forceTrigger = null, demoMessages = null }) {
  const X0 = -1280;
  const Y = 180 + yOffset;
  addNode(wf, laneHeader(label, X0, 40 + yOffset));

  // Trigger
  const trigType = forceTrigger || signals.trigger;
  const trig =
    trigType === "cron"
      ? cron(X0 + 140, Y)
      : trigType === "webhook"
      ? webhook(X0 + 140, Y)
      : manual(X0 + 140, Y, trigType === "manual" ? "Manual Trigger" : "Manual (Fallback)");
  const trigName = addNode(wf, trig);

  // Init context (seeds + scenario)
  const initName = addNode(
    wf,
    func(
      "Init Context",
      `
return [{
  demo: ${forceTrigger ? "true" : "false"},
  to: "+34613030526",
  emailTo: "kevanm.spain@gmail.com",
  smsFrom: "+13412184164",
  waFrom: "+14155238886",
  callFrom: "+13412184164",
  scenario: ${JSON.stringify(scenario)}
}];`,
      X0 + 360,
      Y,
    ),
  );
  connect(wf, trigName, initName);

  // Spine: Split -> Compose -> Channels (max 3)
  const splitName = addNode(wf, splitNode(X0 + 580, Y));
  connect(wf, initName, splitName);

  const primary = signals.channels[0] || "email";
  const compName = addNode(wf, composerNode(scenario, primary, X0 + 800, Y, demoMessages));
  connect(wf, splitName, compName);

  let prev = compName;
  let x = X0 + 1020;
  const useCh = signals.channels.length ? signals.channels.slice(0, 3) : ["email"];
  for (const ch of useCh) {
    const leaf = addNode(wf, channelLeaf(ch, x, Y));
    connect(wf, prev, leaf);
    prev = leaf;
    x += 220;
  }

  // Example decision + update: always connected, proper ordering
  const decision = addNode(wf, ifNode("Confirmed?", "={{$json.reply||''}}", "contains", "yes", x, Y - 20));
  connect(wf, prev, decision);
  const updYes = addNode(wf, http("Update System (Yes)", "={{'https://example.com/update'}}", "={{$json}}", x + 240, Y - 40));
  const updNo = addNode(wf, http("Update System (No)", "={{'https://example.com/update'}}", "={{$json}}", x + 240, Y + 60));
  connect(wf, decision, updYes, 0);
  connect(wf, decision, updNo, 1);

  const col = addNode(wf, func("Collector", "return [$json];", x + 480, Y));
  connect(wf, updYes, col);
  connect(wf, updNo, col);
}

function buildWorkflowServer(s, plan /* may be null */) {
  const archetype = plan?.archetype || s.archetype || classifyFallback(s);
  const signals = {
    trigger: plan?.trigger || deriveSignals(s).trigger,
    channels: (Array.isArray(plan?.channels) && plan.channels.length ? plan.channels : deriveSignals(s).channels).slice(0, 4),
  };

  const wf = baseWorkflow(`${s.scenario_id || "Scenario"} — ${archetype}`);

  // Production lane (top)
  buildLane(wf, "PRODUCTION LANE", s, signals, {
    yOffset: 0,
    forceTrigger: null,
    demoMessages: null,
  });

  // Demo lane (bottom, forced manual, seeded contacts, optional AI demo message overrides)
  buildLane(wf, "DEMO LANE (Manual + Seeded Contacts)", s, signals, {
    yOffset: 900,
    forceTrigger: "manual",
    demoMessages: plan?.demoMessages || null,
  });

  return wf;
}

/* ---------------- Handler ---------------- */

module.exports = async (req, res) => {
  try {
    Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    if (req.method === "OPTIONS") return res.status(204).end();

    // Accept GET or POST
    let scenarioId = "";
    if (req.method === "GET") {
      scenarioId = sstr((req.query && req.query.scenario_id) || "");
    } else if (req.method === "POST") {
      const body = await new Promise((resolve) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            resolve({});
          }
        });
      });
      scenarioId = sstr(body.scenario_id || body?.scenario?.scenario_id || "");
    } else {
      return res.status(200).json({ ok: true, usage: 'GET/POST ?scenario_id=... -> returns { ok, workflow, plan }' });
    }

    const SHEET_ID = process.env.SHEET_ID;
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    const TAB = process.env.SHEET_TAB || "Scenarios";
    if (!SHEET_ID || !GOOGLE_API_KEY) throw new Error("Missing SHEET_ID or GOOGLE_API_KEY");

    if (!scenarioId) throw new Error("Missing scenario_id");

    const rows = await fetchSheets({ sheetId: SHEET_ID, tab: TAB, apiKey: GOOGLE_API_KEY });
    if (!rows.length) throw new Error("Sheet has no rows");

    const hit = rows.find((r) => sstr(r.scenario_id).trim().toLowerCase() === scenarioId.trim().toLowerCase());
    if (!hit) return res.status(404).json({ ok: false, error: `scenario_id not found: ${scenarioId}` });

    const scenario = projectScenario(hit);

    // Optional AI enrichment
    const plan = await aiPlan(scenario);

    // Build workflow (server-side, clean lanes)
    const workflow = buildWorkflowServer(scenario, plan);

    // Download or JSON preview
    const shouldDownload = String(req.query?.download || "0") === "1";
    if (shouldDownload) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${scenario.scenario_id}.workflow.n8n.json"`);
      return res.status(200).end(JSON.stringify(workflow, null, 2));
    }

    return res.status(200).json({ ok: true, usedAI: !!plan, plan: plan || null, workflow });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
};
