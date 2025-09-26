// Dual-source: CSV (SCENARIOS_CSV_URL) or Google Sheets (SHEET_ID + GOOGLE_API_KEY)
// Optional query params: ?q=search&cursor=0&max=25

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

const toObj = (header, row) =>
  Object.fromEntries(header.map((h, i) => [h, (row[i] ?? "").toString().trim()]));

const normalizeTags = (s) =>
  s ? s.split(/[;,]/).map((t) => t.trim()).filter(Boolean) : [];

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
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
    if (c === '"') { inQ = !inQ; continue; }
    if (c === "," && !inQ) { out.push(cur); cur = ""; continue; }
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

function projectScenario(x) {
  return {
    scenario_id: x["scenario_id"] || "",
    name: x["name"] || "",
    triggers: x["triggers"] || "",
    best_reply_shapes: (x["best_reply_shapes"] || "")
      .split(/[,/]/).map((s) => s.trim()).filter(Boolean),
    risk_notes: x["risk_notes"] || "",
    agent_name: x["agent_name"] || "",
    how_it_works: x["how_it_works"] || "",
    tool_stack_dev: x["tool_stack_dev"] || "",
    tool_stack_autonomous: x["tool_stack_autonomous"] || "",
    tags: normalizeTags(x["tags (;)"] || x["tags"] || ""),
    roi_hypothesis: x["roi_hypothesis"] || "",
  };
}

export default async function handler(req, res) {
  Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const { q = "", cursor = "0", max = "25" } = req.query;
    const CUR = parseInt(cursor, 10) || 0;
    const MAX = Math.min(100, parseInt(max, 10) || 25);

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

    let items = rows.map(projectScenario);

    const ql = q.toString().toLowerCase();
    if (ql) {
      items = items.filter(
        (it) =>
          it.scenario_id.toLowerCase().includes(ql) ||
          it.name.toLowerCase().includes(ql)
      );
    }

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
