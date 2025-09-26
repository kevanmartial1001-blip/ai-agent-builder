// Dual-source: CSV (INDUSTRIES_CSV_URL) or Google Sheets (SHEET_ID + GOOGLE_API_KEY, tab "industries")

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

const toObj = (header, row) =>
  Object.fromEntries(header.map((h, i) => [h, (row[i] ?? "").toString().trim()]));

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

async function fetchSheets({ sheetId, tab, apiKey }) {
  const range = encodeURIComponent(tab || "industries");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?key=${apiKey}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Sheets API error: ${r.status} ${r.statusText}`);
  const data = await r.json();
  const rows = data.values || [];
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((rw) => toObj(header, rw));
}

function projectIndustry(x) {
  return {
    industry_id: x["industry_id"] || (x["name"] || "").toLowerCase(),
    playbook_name: x["playbook_name"] || "",
    core_pains: x["core_pains"] || "",
    usecases: x["usecases"] || "",
    kpi_examples: x["kpi_examples"] || "",
    success_metrics: x["success_metrics"] || "",
    qualifying_questions: x["qualifying_questions (;)"] || x["qualifying_questions"] || "",
    discovery_questions: x["discovery_questions (;)"] || x["discovery_questions"] || "",
    agent_language_prompt: x["agent_language_prompt"] || "",
  };
}

export default async function handler(req, res) {
  Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const CSV = process.env.INDUSTRIES_CSV_URL;
    const SHEET_ID = process.env.SHEET_ID;
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

    let rows = [];
    if (CSV) {
      rows = await fetchCSV(CSV);
    } else if (SHEET_ID && GOOGLE_API_KEY) {
      rows = await fetchSheets({ sheetId: SHEET_ID, tab: "industries", apiKey: GOOGLE_API_KEY });
    } else {
      throw new Error("Missing data source. Set INDUSTRIES_CSV_URL or (SHEET_ID + GOOGLE_API_KEY).");
    }

    const items = rows.map(projectIndustry);
    res.status(200).json({ ok: true, count: items.length, items });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
