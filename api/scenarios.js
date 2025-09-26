// API: /api/scenarios
// Returns paginated scenarios from Google Sheets OR a published CSV.
// Query: ?q=<text>&cursor=<n>&max=<n>

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const normalizeTags = (s) =>
  s ? s.split(/[;|,]/).map((t) => t.trim()).filter(Boolean) : [];

const toObj = (header, row) =>
  Object.fromEntries(header.map((h, i) => [h, (row[i] ?? "").toString().trim()]));

function csvParse(text) {
  // super-light CSV: handles quotes and commas; good for Google "publish to web" CSV
  const rows = [];
  let i = 0, cur = "", inq = false, row = [];
  while (i < text.length) {
    const c = text[i];
    if (inq) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inq = false;
      } else cur += c;
    } else {
      if (c === '"') inq = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") {
        if (cur || row.length) { row.push(cur); rows.push(row); row = []; cur = ""; }
        // swallow CRLF pairs
        if (c === "\r" && text[i + 1] === "\n") i++;
      } else cur += c;
    }
    i++;
  }
  if (cur || row.length) row.push(cur), rows.push(row);
  return rows;
}

async function fetchFromCSV(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`CSV fetch failed ${r.status}`);
  const rows = csvParse(await r.text());
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((rw) => toObj(header, rw));
}

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

    const q = (req.query.q || "").toString().toLowerCase();
    const cursor = parseInt((req.query.cursor || "0"), 10) || 0;
    const MAX = Math.min(
      parseInt((req.query.max || process.env.MAX_RESULTS || "25"), 10) || 25,
      200
    );

    let body = [];
    const CSV = process.env.SCENARIOS_CSV_URL;

    if (CSV) {
      body = await fetchFromCSV(CSV);
    } else {
      const SHEET_ID = process.env.SHEET_ID;
      const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
      const TAB = process.env.SHEET_TAB || "Scenarios";
      if (!SHEET_ID || !GOOGLE_API_KEY)
        throw new Error("Missing SHEET_ID or GOOGLE_API_KEY");
      body = await fetchFromSheets(SHEET_ID, TAB, GOOGLE_API_KEY);
    }

    // normalize
    let items = body.map((x) => ({
      scenario_id: x["scenario_id"] || "",
      name: x["name"] || "",
      triggers: x["triggers"] || "",
      best_reply_shapes:
        (x["best_reply_shapes"] || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      risk_notes: x["risk_notes"] || "",
      agent_name: x["agent_name"] || "",
      how_it_works: x["how_it_works"] || "",
      tool_stack_dev: x["tool_stack_dev"] || "",
      tool_stack_autonomous: x["tool_stack_autonomous"] || "",
      tags: normalizeTags(x["tags (;)"] || x["tags"] || ""),
      roi_hypothesis: x["roi_hypothesis"] || "",
    }));

    if (q) {
      items = items.filter(
        (it) =>
          it.scenario_id.toLowerCase().includes(q) ||
          it.name.toLowerCase().includes(q) ||
          it.triggers.toLowerCase().includes(q)
      );
    }

    const page = items.slice(cursor, cursor + MAX);
    const next = cursor + MAX < items.length ? cursor + MAX : null;

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
};
