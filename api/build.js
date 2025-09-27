// api/build.js
// Deep per-scenario builder (server-side).
// - Reads one scenario row from Google Sheets
// - Uses LLM to propose schema (triggers / branches / channels / errors) and messaging
// - Builds two lanes: PROD (real trigger, external tools present) + DEMO (manual trigger + seeded contacts + fake tools)
// - Safe import sanitization (no undefined types or dangling connections)
// Env vars: SHEET_ID, GOOGLE_API_KEY, SHEET_TAB?=Scenarios, OPENAI_API_KEY

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

const DEMO = {
  to: "+34613030526",
  emailTo: "kevanm.spain@gmail.com",
  waFrom: "+14155238886",
  smsFrom: "+13412184164",
  callFrom: "+13412184164",
};

const DEFAULT_HTTP = {
  pms_upcoming: "https://example.com/pms/upcoming",
  pms_update: "https://example.com/pms/update",
  waitlist_fill: "https://example.com/waitlist/fill",
  kb_search: "https://example.com/kb/search",
  ticket_create: "https://example.com/ticket/create",
  nps_create: "https://example.com/nps/create",
  bi_nps: "https://example.com/bi/nps",
  crm_log: "https://example.com/crm/log",
  crm_upsert: "https://example.com/crm/upsert",
  calendar_book: "https://example.com/calendar/book",
  dispatch_assign: "https://example.com/dispatch/assign",
  erp_po: "https://example.com/erp/po",
  wms_levels: "https://example.com/wms/levels",
  wms_update: "https://example.com/wms/update",
  accounting_aging: "https://example.com/accounting/aging",
  ar_dispute: "https://example.com/ar/dispute",
  compliance_list: "https://example.com/compliance/list",
  compliance_report: "https://example.com/compliance/report",
  legal_notify: "https://example.com/legal/notify",
  alert: "https://example.com/alert",
  metrics: "https://example.com/metrics",
  dash_export: "https://example.com/dash/export",
  iam_provision: "https://example.com/iam/provision",
  iam_log: "https://example.com/iam/log",
  privacy_collect: "https://example.com/privacy/collect",
  privacy_respond: "https://example.com/privacy/respond",
  privacy_attest: "https://example.com/privacy/attest",
  kyc: "https://example.com/kyc",
};

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
  APPOINTMENT_SCHEDULING: 'cron',
  CUSTOMER_SUPPORT_INTAKE: 'webhook',
  FEEDBACK_NPS: 'cron',
  KNOWLEDGEBASE_FAQ: 'webhook',
  SALES_OUTREACH: 'manual',
  LEAD_QUAL_INBOUND: 'webhook',
  CHURN_WINBACK: 'cron',
  RENEWALS_CSM: 'cron',
  AR_FOLLOWUP: 'cron',
  AP_AUTOMATION: 'webhook',
  INVENTORY_MONITOR: 'cron',
  REPLENISHMENT_PO: 'webhook',
  FIELD_SERVICE_DISPATCH: 'webhook',
  COMPLIANCE_AUDIT: 'cron',
  INCIDENT_MGMT: 'webhook',
  DATA_PIPELINE_ETL: 'cron',
  REPORTING_KPI_DASH: 'cron',
  ACCESS_GOVERNANCE: 'webhook',
  PRIVACY_DSR: 'webhook',
  RECRUITING_INTAKE: 'webhook',
};

const CHANNEL_NORMALIZE = [
  { k: 'whatsapp', rx: /whatsapp/i },
  { k: 'sms', rx: /(sms|text)/i },
  { k: 'call', rx: /(voice|call)/i },
  { k: 'email', rx: /email/i },
];

function toObj(header, row) {
  return Object.fromEntries(header.map((h, i) => [h, (row[i] ?? "").toString().trim()]));
}
const listify = (v) => Array.isArray(v)
  ? v.map(x => String(x).trim()).filter(Boolean)
  : String(v || '').split(/[;,/|\n]+/).map(x => x.trim()).filter(Boolean);

function chooseArchetype(row) {
  const hay = [
    row["scenario_id"], row["name"], row["tags"], row["triggers"], row["how_it_works"], row["tool_stack_dev"]
  ].map(x => String(x || '')).join(' ');
  for (const r of ARCH_RULES) if (r.rx.test(hay)) return r.a;
  return 'SALES_OUTREACH';
}

async function fetchSheetRowByScenarioId(scenarioId) {
  const SHEET_ID = process.env.SHEET_ID;
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  const TAB = process.env.SHEET_TAB || "Scenarios";
  if (!SHEET_ID || !GOOGLE_API_KEY) throw new Error("Missing SHEET_ID or GOOGLE_API_KEY");

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}?key=${GOOGLE_API_KEY}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Sheets API error: ${r.status} ${r.statusText}`);
  const data = await r.json();
  const rows = data.values || [];
  if (!rows.length) throw new Error("Sheet has no rows");
  const header = rows[0].map((h) => h.trim());
  const objRows = rows.slice(1).map((rw) => toObj(header, rw));
  return objRows.find(x => (x["scenario_id"] || "").toString().trim().toLowerCase() === scenarioId.toLowerCase());
}

async function openaiJSON(prompt, schemaHint) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null; // allow fallback when not configured
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are an expert workflow designer for n8n. Always return concise, valid JSON objects only." },
          { role: "user", content: prompt + (schemaHint ? ("\n\nSchema:\n" + schemaHint) : "") }
        ]
      })
    });
    const j = await r.json();
    const txt = j.choices?.[0]?.message?.content?.trim();
    if (!txt) return null;
    try { return JSON.parse(txt); } catch { return null; }
  } catch {
    return null;
  }
}

/* ---------- LLM prompts (from your spec) ---------- */
function makeDesignerPrompt(row) {
  const ctx = [
    `SCENARIO_ID: ${row.scenario_id || ''}`,
    `AGENT_NAME: ${row.agent_name || ''}`,
    `INDUSTRY (name field): ${row.name || ''}`,
    `TRIGGERS: ${row.triggers || ''}`,
    `BEST_REPLY_SHAPES: ${row.best_reply_shapes || ''}`,
    `HOW_IT_WORKS: ${row.how_it_works || ''}`,
    `ROI_HYPOTHESIS: ${row.roi_hypothesis || ''}`,
    `RISK_NOTES: ${row.risk_notes || ''}`,
    `TAGS: ${row["tags (;)"] || row.tags || ''}`,
  ].join("\n");

  return `
Based on the context below, design a bullet-proof workflow shape for n8n with:
- "trigger": one of ["cron","webhook","imap","manual"] (what should start PROD lane)
- "channels": array subset of ["email","sms","whatsapp","call"] in recommended order
- "branches": an array of conditional situations users may choose or that may occur (max 6). Each branch has:
   { "name": string, "condition": string (plain language), "steps": [ { "name": string, "kind": string } ] }
- "errors": most likely error cases and the auto-handling (2–4 items)
- "systems": list of external systems to involve (e.g. ["pms","crm","calendar","slack","wms","erp","accounting","kb","bi","iam","privacy","ats"])
- "archetype": choose the closest of these 20 and allow customizing it:
  [APPOINTMENT_SCHEDULING, CUSTOMER_SUPPORT_INTAKE, FEEDBACK_NPS, KNOWLEDGEBASE_FAQ, SALES_OUTREACH,
   LEAD_QUAL_INBOUND, CHURN_WINBACK, RENEWALS_CSM, AR_FOLLOWUP, AP_AUTOMATION, INVENTORY_MONITOR,
   REPLENISHMENT_PO, FIELD_SERVICE_DISPATCH, COMPLIANCE_AUDIT, INCIDENT_MGMT, DATA_PIPELINE_ETL,
   REPORTING_KPI_DASH, ACCESS_GOVERNANCE, PRIVACY_DSR, RECRUITING_INTAKE]
Return JSON:
{
  "archetype": "...",
  "trigger": "cron|webhook|imap|manual",
  "channels": ["email","sms",...],
  "branches": [{ "name": "...", "condition": "...", "steps": [{ "name":"...", "kind":"compose|http|update|route|wait|score|lookup|book|ticket|notify|store|decision" }] }],
  "errors": [{ "name":"...", "mitigation":"..." }],
  "systems": ["pms","crm",...]
}

Context:
${ctx}
`;
}

function makeMessagingPrompt(row, archetype, channels) {
  const ctx = [
    `SCENARIO_ID: ${row.scenario_id || ''}`,
    `AGENT_NAME: ${row.agent_name || ''}`,
    `INDUSTRY (name field): ${row.name || ''}`,
    `TRIGGERS: ${row.triggers || ''}`,
    `HOW_IT_WORKS: ${row.how_it_works || ''}`,
    `ROI_HYPOTHESIS: ${row.roi_hypothesis || ''}`,
    `RISK_NOTES: ${row.risk_notes || ''}`,
  ].join("\n");
  return `
Compose human, natural, not robotic outreach content for channels ${JSON.stringify(channels)} for archetype ${archetype}.
No "press 1" UX. Conversational but professional. 3–6 short lines each.
Return JSON: { "email": { "subject":"...", "body":"..." }, "sms": {"body":"..."}, "whatsapp":{"body":"..."}, "call":{"script":"..."} }

Context:
${ctx}
`;
}

/* ---------- workflow builder primitives ---------- */
const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const pos = (x, y) => [x, y];

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
  wf.connections[from] ??= {}; wf.connections[from].main ??= [];
  for (let i = wf.connections[from].main.length; i <= outputIndex; i++) wf.connections[from].main[i] = [];
  wf.connections[from].main[outputIndex].push({ node: to, type: "main", index: 0 });
}
function withYOffset(wf, yOffset, fn) {
  const prev = wf.__yOffset || 0;
  wf.__yOffset = yOffset;
  try { fn(); } finally { wf.__yOffset = prev; }
}
function addHeader(wf, label, x=-1320, y=40) {
  return addNode(wf, {
    id: uid("label"),
    name: `=== ${label} ===`,
    type: "n8n-nodes-base.function",
    typeVersion: 2,
    position: pos(x, y),
    parameters: { functionCode: "return [$json];" }
  });
}
function addManual(wf, x=-1180, y=300, label="Manual Trigger") {
  return addNode(wf, { id: uid("manual"), name: label, type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: pos(x, y), parameters: {} });
}
function addCron(wf, label="Cron (15m)", x=-1180, y=140, compat='safe') {
  if (compat === "full") {
    return addNode(wf, { id: uid("cron"), name: label, type: "n8n-nodes-base.cron", typeVersion: 1, position: pos(x, y),
      parameters: { triggerTimes: { item: [{ mode: "everyX", everyX: { hours: 0, minutes: 15 } }] } } });
  }
  return addNode(wf, { id: uid("cronph"), name: `${label} (Placeholder)`, type: "n8n-nodes-base.function", typeVersion: 2, position: pos(x, y),
    parameters: { functionCode: "return [$json];" } });
}
function addWebhook(wf, label="Webhook (Incoming)", x=-1180, y=300, compat='safe') {
  if (compat === "full") {
    return addNode(wf, { id: uid("webhook"), name: label, type: "n8n-nodes-base.webhook", typeVersion: 1, position: pos(x, y),
      parameters: { path: uid("hook"), methods: ["POST"], responseMode: "onReceived" } });
  }
  return addNode(wf, { id: uid("webph"), name: `${label} (Placeholder)`, type: "n8n-nodes-base.function", typeVersion: 2, position: pos(x, y),
    parameters: { functionCode: "return [$json];" } });
}
function addHTTP(wf, name, urlExpr, bodyExpr, x, y, method="POST", compat='safe') {
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
function addSplit(wf, x, y, size=20) {
  return addNode(wf, { id: uid("split"), name: "Split In Batches", type: "n8n-nodes-base.splitInBatches", typeVersion: 1, position: pos(x, y),
    parameters: { batchSize: size } });
}
function addCollector(wf, x=1600, y=300) {
  return addFunction(wf, "Collector (Inspect)", `
const now=new Date().toISOString();
const arr=Array.isArray(items)?items:[{json:$json}];
return arr.map((it,i)=>({json:{...it.json,__collected_at:now, index:i}}));`, x,y);
}
function sanitizeWorkflow(wf) {
  const REQUIRED_TYPE = "n8n-nodes-base.function";
  const nameCounts = {};
  const byName = new Map();

  wf.nodes = (wf.nodes || []).map((n, idx) => {
    if (!n.name || typeof n.name !== "string") n.name = `Node ${idx+1}`;
    const k = n.name.toLowerCase();
    if (nameCounts[k] == null) nameCounts[k] = 0; else nameCounts[k] += 1;
    if (nameCounts[k] > 0) n.name = `${n.name} #${nameCounts[k]}`;

    if (!n.type || typeof n.type !== "string" || !n.type.trim()) {
      n.type = REQUIRED_TYPE;
      n.typeVersion = typeof n.typeVersion === "number" ? n.typeVersion : 2;
      n.parameters ||= { functionCode: "return [$json];" };
    }
    if (typeof n.typeVersion !== "number") n.typeVersion = 1;

    if (!Array.isArray(n.position) || n.position.length !== 2) {
      n.position = [ -1000, 300 + (idx * 40) ];
    } else {
      n.position = [ Number(n.position[0]) || 0, Number(n.position[1]) || 0 ];
    }
    if (!n.parameters || typeof n.parameters !== "object") n.parameters = {};
    byName.set(n.name, n);
    return n;
  });

  const conns = wf.connections || {};
  for (const [from, m] of Object.entries(conns)) {
    if (!byName.has(from)) { delete conns[from]; continue; }
    if (!m || typeof m !== "object") { delete conns[from]; continue; }
    if (!Array.isArray(m.main)) m.main = [];
    m.main = m.main.map(arr => Array.isArray(arr) ? arr.filter(link => byName.has(link?.node)) : []);
  }
  wf.connections = conns;
  wf.name = String(wf.name || "AI Agent Workflow");
  return wf;
}

/* ---------- Main build function ---------- */
async function buildWorkflowFromRow(row, opts) {
  const compat = (opts.compat || 'safe') === 'full' ? 'full' : 'safe';
  const includeDemo = opts.includeDemo !== false;

  // Normalize shapes → channels
  const channels = [];
  const shapes = listify(row.best_reply_shapes);
  for (const sh of shapes) {
    for (const norm of CHANNEL_NORMALIZE) {
      if (norm.rx.test(sh) && !channels.includes(norm.k)) channels.push(norm.k);
    }
  }
  if (!channels.length) channels.push('email');

  // Initial archetype guess (then LLM may refine)
  let archetype = chooseArchetype(row);
  let prodTrigger = TRIGGER_PREF[archetype] || 'manual';

  // Ask the LLM for schema + systems + refined archetype
  const designer = await openaiJSON(
    makeDesignerPrompt(row),
    `{"archetype":string,"trigger":"cron|webhook|imap|manual","channels":string[],"branches":[{"name":string,"condition":string,"steps":[{"name":string,"kind":string}]}],"errors":[{"name":string,"mitigation":string}],"systems":string[]}`
  );

  const design = designer || {};
  if (Array.isArray(design.channels) && design.channels.length) {
    // trust LLM order but keep only known
    const allowed = ['email','sms','whatsapp','call'];
    const llmCh = design.channels.filter(c => allowed.includes(String(c).toLowerCase()));
    if (llmCh.length) { channels.splice(0, channels.length, ...llmCh); }
  }
  if (typeof design.trigger === 'string') {
    const v = design.trigger.toLowerCase();
    if (['cron','webhook','imap','manual'].includes(v)) prodTrigger = v;
  }
  if (typeof design.archetype === 'string' && design.archetype.trim()) {
    archetype = design.archetype.trim().toUpperCase();
  }
  const systems = Array.isArray(design.systems) ? design.systems.map(s=>String(s).toLowerCase()) : [];

  // Ask the LLM for bespoke messaging
  const msg = await openaiJSON(
    makeMessagingPrompt(row, archetype, channels),
    `{"email":{"subject":string,"body":string},"sms":{"body":string},"whatsapp":{"body":string},"call":{"script":string}}`
  ) || {};

  const title = `${row.scenario_id || 'Scenario'} — ${row.name || ''}`.trim();
  const wf = baseWorkflow(title);

  // --------- Lane A: PROD ----------
  withYOffset(wf, 0, () => {
    addHeader(wf, "PRODUCTION LANE", -1320, 40);
    // trigger
    let startName;
    if (prodTrigger === 'cron') startName = addCron(wf, "Cron (from LLM)", -1180, 140, compat);
    else if (prodTrigger === 'webhook') startName = addWebhook(wf, "Webhook (from LLM)", -1180, 300, compat);
    else if (prodTrigger === 'imap') startName = addFunction(wf, "IMAP Intake (Placeholder)", "return [$json];", -1180, 300);
    else startName = addManual(wf, -1180, 300, "Manual Trigger");

    // init context
    const init = addFunction(wf, "Init Context (PROD)", `
const scenario=${JSON.stringify({
      scenario_id: row.scenario_id || '',
      agent_name: row.agent_name || '',
      name: row.name || '',
      triggers: row.triggers || '',
      how_it_works: row.how_it_works || '',
      roi_hypothesis: row.roi_hypothesis || '',
      risk_notes: row.risk_notes || '',
      tags: listify(row["tags (;)"] || row.tags),
      archetype,
    })};
const channels=${JSON.stringify(channels)};
const systems=${JSON.stringify(systems)};
const msg=${JSON.stringify(msg)};
return [{...$json, scenario, channels, systems, msg}];
`, -940, 300);
    connect(wf, startName, init);

    // optional fetch lists for certain archetypes/systems
    let cursor = init;
    if (systems.includes('pms')) {
      const fetch = addHTTP(wf, "Fetch Upcoming (PMS)", `={{'${DEFAULT_HTTP.pms_upcoming}'}}`, "={{$json}}", -700, 300, "POST", compat);
      connect(wf, cursor, fetch); cursor = fetch;
    }
    if (['RENEWALS_CSM','AR_FOLLOWUP','REPORTING_KPI_DASH','DATA_PIPELINE_ETL'].includes(archetype)) {
      const split = addSplit(wf, -460, 300, 25); connect(wf, cursor, split); cursor = split;
    }

    // branch switch (from LLM)
    const branches = Array.isArray(design.branches) ? design.branches : [];
    let afterBranch = cursor;
    if (branches.length) {
      const sw = addSwitch(wf, "Branch (LLM)", "={{$json.__branch || 'main'}}",
        branches.map(b => ({ operation: 'equal', value2: String(b.name || 'case').slice(0,48) })), -220, 300);
      connect(wf, cursor, sw);

      // For each branch, add its steps
      branches.forEach((b, idx) => {
        let prev = addFunction(wf, `Enter: ${b.name || 'Case'}`, `return [{...$json,__branch:${JSON.stringify(b.name||'case')},__cond:${JSON.stringify(b.condition||'')}}];`,
          40, 180 + (idx * 120));
        connect(wf, sw, prev, idx);
        (Array.isArray(b.steps) ? b.steps : []).forEach((st, k) => {
          const kind = String(st.kind || '').toLowerCase();
          let nodeName;
          if (kind === 'compose') {
            nodeName = addFunction(wf, `Compose — ${st.name || 'Message'}`, `
const ch=($json.channels && $json.channels[0]) || 'email';
const m=$json.msg||{};
const bodies={ email:(m.email?.body)||'', sms:(m.sms?.body)||'', whatsapp:(m.whatsapp?.body)||'', call:(m.call?.script)||''};
return [{...$json, message:bodies[ch] || bodies.email || 'Hello!'}];`, 300 + (k*260), 180 + (idx*120));
          } else if (kind === 'http' || kind === 'update' || kind === 'store') {
            nodeName = addHTTP(wf, st.name || 'HTTP', "={{'https://example.com/step'}}", "={{$json}}", 300 + (k*260), 180 + (idx*120), "POST", compat);
          } else if (kind === 'book') {
            nodeName = addHTTP(wf, st.name || 'Book Calendar', `={{'${DEFAULT_HTTP.calendar_book}'}}`, "={{$json}}", 300 + (k*260), 180 + (idx*120), "POST", compat);
          } else if (kind === 'ticket') {
            nodeName = addHTTP(wf, st.name || 'Create Ticket', `={{'${DEFAULT_HTTP.ticket_create}'}}`, "={{$json}}", 300 + (k*260), 180 + (idx*120), "POST", compat);
          } else if (kind === 'lookup' || kind === 'score' || kind === 'decision' || kind === 'route' || kind === 'wait') {
            nodeName = addFunction(wf, `${st.name || 'Logic'}`, "return [$json];", 300 + (k*260), 180 + (idx*120));
          } else {
            nodeName = addFunction(wf, `${st.name || 'Step'}`, "return [$json];", 300 + (k*260), 180 + (idx*120));
          }
          connect(wf, prev, nodeName);
          prev = nodeName;
        });
        // After each branch path, send on channels (drip)
        let last = prev;
        channels.forEach((ch, i) => {
          const sender = makeSenderNode(wf, ch, 300 + ( ( (Array.isArray(b.steps)?b.steps.length:0) + 1 + i) * 260), 180 + (idx*120), compat, false);
          connect(wf, last, sender);
          last = sender;
        });
        const merge = addCollector(wf, 300 + ( ((Array.isArray(b.steps)?b.steps.length:0) + channels.length + 2) * 260), 180 + (idx*120));
        connect(wf, last, merge);
        afterBranch = merge; // last merge becomes cursor
      });
    }

    // errors handling
    const errors = Array.isArray(design.errors) ? design.errors : [];
    if (errors.length) {
      const errGate = addFunction(wf, "Error Monitor (LLM List)", `return [$json];`, 40, 520);
      connect(wf, afterBranch, errGate);
      let prev = errGate;
      errors.forEach((e, idx) => {
        const fix = addFunction(wf, `Mitigate: ${e.name || 'Error'}`, `// ${e.mitigation || ''}\nreturn [$json];`, 300 + idx*260, 520);
        connect(wf, prev, fix);
        prev = fix;
      });
      const fin = addCollector(wf, 300 + errors.length*260 + 260, 520);
      connect(wf, prev, fin);
    }
  });

  // --------- Lane B: DEMO ----------
  if (includeDemo) {
    withYOffset(wf, 900, () => {
      addHeader(wf, "DEMO LANE (Manual Trigger + Seeded Contacts)", -1320, 40);
      const man = addManual(wf, -1180, 300, "Demo Manual Trigger");
      const init = addFunction(wf, "Init Demo Context", `
const seed=${JSON.stringify(DEMO)};
const scenario=${JSON.stringify({
        scenario_id: row.scenario_id || '',
        agent_name: row.agent_name || '',
        name: row.name || '',
        triggers: row.triggers || '',
        how_it_works: row.how_it_works || '',
        roi_hypothesis: row.roi_hypothesis || '',
        risk_notes: row.risk_notes || '',
        tags: listify(row["tags (;)"] || row.tags),
        archetype,
      })};
const channels=${JSON.stringify(channels)};
const msg=${JSON.stringify(msg)};
return [{...seed, scenario, channels, msg, demo:true}];
`, -940, 300);
      connect(wf, man, init);

      // Simple straight-line copy of production shape: compose -> send on each channel -> collector
      const comp = addFunction(wf, "Compose (Demo)", `
const m=$json.msg||{};
const chs=$json.channels||['email'];
const pick=(c)=> c==='sms'?(m.sms?.body||''): c==='whatsapp'?(m.whatsapp?.body||'') : c==='call'?(m.call?.script||'') : (m.email?.body||'');
return [{...$json, message: pick(chs[0])||'Hello!'}];`, -700, 300);
      connect(wf, init, comp);

      let prev = comp;
      channels.forEach((ch, i) => {
        const s = makeSenderNode(wf, ch, -460 + i*260, 300, compat, true);
        connect(wf, prev, s);
        prev = s;
      });
      const fin = addCollector(wf, -460 + channels.length*260 + 260, 300);
      connect(wf, prev, fin);
    });
  }

  return sanitizeWorkflow(wf);
}

function makeSenderNode(wf, channel, x, y, compat, demo) {
  const friendly = channel.toUpperCase();
  // For compat='full' we place actual nodes; else, function placeholders that echo payload
  if (compat === 'full') {
    if (channel === 'email') {
      return addNode(wf, {
        id: uid("email"),
        name: demo ? "Send Email (Demo)" : "Send Email",
        type: "n8n-nodes-base.emailSend",
        typeVersion: 3,
        position: pos(x, y),
        parameters: {
          to: demo ? "={{$json.emailTo}}" : "={{$json.emailTo || 'user@example.com'}}",
          subject: "={{$json.msg?.email?.subject || $json.scenario?.agent_name || 'Update'}}",
          text: "={{$json.message || $json.msg?.email?.body || 'Hello!'}}"
        },
        credentials: {}
      });
    }
    if (channel === 'sms') {
      return addNode(wf, {
        id: uid("sms"),
        name: demo ? "Send SMS (Twilio Demo)" : "Send SMS (Twilio)",
        type: "n8n-nodes-base.twilio",
        typeVersion: 3,
        position: pos(x, y),
        parameters: {
          resource: "message",
          operation: "create",
          from: "={{$json.smsFrom || '+10000000000'}}",
          to: "={{$json.to || '+10000000001'}}",
          message: "={{$json.message || $json.msg?.sms?.body || 'Hello!'}}"
        },
        credentials: {}
      });
    }
    if (channel === 'whatsapp') {
      return addNode(wf, {
        id: uid("wa"),
        name: demo ? "Send WhatsApp (Twilio Demo)" : "Send WhatsApp (Twilio)",
        type: "n8n-nodes-base.twilio",
        typeVersion: 3,
        position: pos(x, y),
        parameters: {
          resource: "message",
          operation: "create",
          from: "={{'whatsapp:' + ($json.waFrom || '+10000000002')}}",
          to: "={{'whatsapp:' + ($json.to || '+10000000003')}}",
          message: "={{$json.message || $json.msg?.whatsapp?.body || 'Hello!'}}"
        },
        credentials: {}
      });
    }
    if (channel === 'call') {
      return addHTTP(wf, demo ? "Place Call (Demo)" : "Place Call", "={{$json.callWebhook || 'https://example.com/call'}}",
        "={{ { to:$json.to, from:$json.callFrom, text: ($json.message || $json.msg?.call?.script || 'Hello!') } }}",
        x, y, "POST", 'full');
    }
  }
  // safe mode demo placeholder
  return addFunction(wf, `Demo Send ${friendly}`, `
const d=$json;
return [{channel:${JSON.stringify(channel)}, to:d.to, emailTo:d.emailTo, smsFrom:d.smsFrom, waFrom:d.waFrom, callFrom:d.callFrom, message:d.message || '(no message)'}];`, x, y);
}

/* ------------------- HTTP handler ------------------- */
module.exports = async (req, res) => {
  Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.method !== "POST") {
      return res.status(200).json({ ok: true, usage: 'POST {"scenario_id": "<id>", "compat":"safe|full", "includeDemo": true }' });
    }

    const body = await new Promise(resolve => {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { resolve({}); }
      });
    });

    const wanted = (body.scenario_id || "").toString().trim();
    if (!wanted) throw new Error("Missing scenario_id");

    const compat = (body.compat || 'safe').toLowerCase() === 'full' ? 'full' : 'safe';
    const includeDemo = body.includeDemo !== false;

    const row = await fetchSheetRowByScenarioId(wanted);
    if (!row) return res.status(404).json({ ok:false, error:`scenario_id not found: ${wanted}` });

    const wf = await buildWorkflowFromRow(row, { compat, includeDemo });

    // Return inline JSON (UI reads it) and also allow attachment download if called directly
    res.status(200);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${(row.scenario_id || 'workflow')}.n8n.json"`);
    res.end(JSON.stringify(wf, null, 2));
  } catch (err) {
    res.status(500).json({ ok:false, error: String(err?.message || err) });
  }
};
