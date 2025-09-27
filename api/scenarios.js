// Dual-source: CSV (SCENARIOS_CSV_URL) or Google Sheets (SHEET_ID + GOOGLE_API_KEY)
// Optional query params:
//   ?q=search&cursor=0&max=25
//   &tags=tag1;tag2          (includes if ANY tag matches)
//   &stats=1                 (returns top tag counts instead of rows)

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

const toObj = (header, row) =>
  Object.fromEntries(header.map((h, i) => [h, (row[i] ?? "").toString().trim()]));

const normalizeTags = (s) =>
  s
    ? s
        .split(/[;,|]/)
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

// --- CSV helpers ---
async function fetchCSV(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`CSV fetch error: ${r.status} ${r.statusText}`);
  const text = await r.text();

  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const header = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map(parseCSVLine);
  return rows.map((rw) => toObj(header, rw));
}

function parseCSVLine(line) {
  const out = [];
  let cur = "",
    inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i + 1] === '"') {
      cur += '"';
      i++;
      continue;
    }
    if (c === '"') {
      inQ = !inQ;
      continue;
    }
    if (c === "," && !inQ) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

// --- Google Sheets helpers ---
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

// --------- Enrichment: archetype + tools ---------
const TAG_RULES = [
  { archetype: "APPOINTMENT_SCHEDULING", include: [/appointment|scheduling|no[-_ ]?show|calendar/i] },
  { archetype: "CUSTOMER_SUPPORT_INTAKE", include: [/support|ticket|helpdesk|complaint|csat|sla/i] },
  { archetype: "FEEDBACK_NPS", include: [/nps|survey|feedback|csat|ces/i] },
  { archetype: "KNOWLEDGEBASE_FAQ", include: [/faq|kb|knowledge[-_ ]?base|deflection/i], exclude: [/ticket|escalation/i] },
  { archetype: "SALES_OUTREACH", include: [/sales|outreach|prospect|sequence|cadence|cold[-_ ]?email/i] },
  { archetype: "LEAD_QUAL_INBOUND", include: [/lead[-_ ]?qual|mql|inbound|webform|router/i] },
  { archetype: "CHURN_WINBACK", include: [/churn|win[-_ ]?back|reactivation|lapsed/i] },
  { archetype: "AR_FOLLOWUP", include: [/a\/?r|accounts?\s*receivable|invoice|collections?|dso/i] },
  { archetype: "QUOTE_ORDER_TO_CASH", include: [/quote|proposal|order|e[-_ ]?sign|contract|to[-_ ]?cash/i] },
  { archetype: "INVENTORY_MONITOR", include: [/inventory|stock|sku|levels?|threshold|backorder/i] },
  { archetype: "REPLENISHMENT_PO", include: [/replenish|purchase[-_ ]?order|po|supplier|procure/i] },
  { archetype: "FIELD_SERVICE_DISPATCH", include: [/dispatch|work[-_ ]?order|field|technician|route|geo/i] },
  { archetype: "COMPLIANCE_AUDIT", include: [/compliance|audit|policy|gdpr|hipaa|sox|iso/i] },
  { archetype: "INCIDENT_MGMT", include: [/incident|sev[: ]?(high|p[12])|major|postmortem|rca/i] },
  { archetype: "DATA_PIPELINE_ETL", include: [/etl|sync|pipeline|ingest|transform|load|csv|s3|gcs/i] },
  { archetype: "REPORTING_KPI_DASH", include: [/dashboard|kpi|weekly|monthly|report|scorecard/i] },
  { archetype: "RECRUITING_INTAKE", include: [/recruit|cv|resume|candidate|ats|hiring/i] },
  { archetype: "ONBOARDING_PLAYBOOK", include: [/onboarding|joiner|provision|checklist|day\s*1/i] },
];

function listify(val) {
  if (Array.isArray(val)) return val.map((v) => String(v).trim()).filter(Boolean);
  return String(val || "")
    .split(/[;,\n|]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function classifyFromTags(s) {
  const hay = [
    String(s.scenario_id || ""),
    String(s.name || ""),
    ...(Array.isArray(s.tags) ? s.tags : listify(s.tags)),
  ]
    .join(" ")
    .toLowerCase();

  for (const rule of TAG_RULES) {
    const match = rule.include?.some((rx) => rx.test(hay));
    const blocked = rule.exclude?.some((rx) => rx.test(hay));
    if (match && !blocked) return rule.archetype;
  }
  return "SALES_OUTREACH"; // safe default
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
      accounting: has("quickbooks") || has("xero") || has("stripe"),
    },
  };
}

function projectScenario(x) {
  const row = {
    scenario_id: x["scenario_id"] || "",
    name: x["name"] || "",
    triggers: x["triggers"] || "",
    best_reply_shapes: (x["best_reply_shapes"] || "")
      .split(/[,/]/)
      .map((s) => s.trim())
      .filter(Boolean),
    risk_notes: x["risk_notes"] || "",
    agent_name: x["agent_name"] || "",
    how_it_works: x["how_it_works"] || "",
    tool_stack_dev: x["tool_stack_dev"] || "",
    tool_stack_autonomous: x["tool_stack_autonomous"] || "",
    tags: normalizeTags(x["tags (;)"] || x["tags"] || ""),
    roi_hypothesis: x["roi_hypothesis"] || "",
    industry_id: x["industry_id"] || x["name"] || "",
  };

  // Enrich
  const archetype = classifyFromTags(row);
  const tools = extractTools(row.tool_stack_dev);

  return { ...row, archetype, tools };
}

export default async function handler(req, res) {
  Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const { q = "", cursor = "0", max = "25", tags = "", stats = "0" } = req.query;
    const CUR = parseInt(cursor, 10) || 0;
    const MAX = Math.min(100, parseInt(max, 10) || 25);
    const WANT_STATS = stats === "1";

    const CSV = process.env.SCENARIOS_CSV_URL;
    const SHEET_ID = process.env.SHEET_ID;
    const SHEET_TAB = process.env.SHEET_TAB || "Scenarios";
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

    let rows = [];
    if (CSV) {
      rows = await fetchCSV(CSV);
    } else if (SHEET_ID && GOOGLE_API_KEY) {
      rows = await fetchSheets({ sheetId: SHEET_ID, tab: SHEET_TAB, apiKey: GOOGLE_API_KEY });
    } else {
      throw new Error("Missing data source. Set SCENARIOS_CSV_URL or (SHEET_ID + GOOGLE_API_KEY).");
    }

    // Project + enrich
    let items = rows.map(projectScenario);

    // Free-text filter
    const ql = q.toString().toLowerCase();
    if (ql) {
      items = items.filter(
        (it) =>
          it.scenario_id.toLowerCase().includes(ql) ||
          it.name.toLowerCase().includes(ql)
      );
    }

    // Tag filter (OR across provided tags)
    const tagList = normalizeTags(tags);
    if (tagList.length) {
      const set = new Set(tagList.map((t) => t.toLowerCase()));
      items = items.filter((it) => it.tags.some((t) => set.has(t.toLowerCase())));
    }

    // Stats mode
    if (WANT_STATS) {
      const tagCount = new Map();
      for (const it of items) for (const t of it.tags) {
        const k = t.toLowerCase();
        tagCount.set(k, (tagCount.get(k) || 0) + 1);
      }
      const topTags = [...tagCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 500)
        .map(([tag, count]) => ({ tag, count }));

      return res.status(200).json({
        ok: true,
        source: CSV ? "csv" : "sheets",
        count: items.length,
        topTags,
      });
    }

    // Pagination
    const page = items.slice(CUR, CUR + MAX);
    const next = CUR + MAX < items.length ? CUR + MAX : null;

    res.status(200).json({
      ok: true,
      source: CSV ? "csv" : "sheets",
      count: items.length,
      page_count: page.length,
      next_cursor: next,
      items: page,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
