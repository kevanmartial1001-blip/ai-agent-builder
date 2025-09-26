// API: /api/industries
// Reads industries from the Industries tab in the same Google Sheet.

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const toObj = (header, row) =>
  Object.fromEntries(header.map((h, i) => [h, (row[i] ?? "").toString().trim()]));

async function fetchFromSheets(sheetId, tab, apiKey) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(
    tab
  )}?key=${apiKey}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Sheets API error: ${r.status} ${r.statusText}`);
  const data = await r.json();
  const rows = data.values || [];
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((rw) => toObj(header, rw));
}

module.exports = async (req, res) => {
  try {
    Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    if (req.method === "OPTIONS") return res.status(204).end();

    const SHEET_ID = process.env.SHEET_ID;
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    const TAB = process.env.INDUSTRIES_TAB || "industries";
    if (!SHEET_ID || !GOOGLE_API_KEY)
      throw new Error("Missing SHEET_ID or GOOGLE_API_KEY");

    const body = await fetchFromSheets(SHEET_ID, TAB, GOOGLE_API_KEY);

    // normalize minimal fields but preserve all
    const items = body.map((x) => ({
      industry_id: x["industry_id"] || x["id"] || "",
      playbook_name: x["playbook_name"] || x["name"] || "",
      core_pains: x["core_pains"] || x["pains"] || "",
      kpi_examples: x["kpi_examples"] || x["kpis"] || "",
      success_metrics: x["success_metrics"] || "",
      agent_language_prompt: x["agent_language_prompt"] || "",
      ...x
    }));

    res.status(200).json({ ok: true, count: items.length, items });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
};
