// api/scenarios.js
// Returns scenarios for the dropdown.
// Mode A (preferred): set SCENARIOS_CSV_URL to a published CSV of your sheet.
// Mode B: set SHEET_ID + GOOGLE_API_KEY (+ optional SHEET_TAB, default "Scenarios") to use the Sheets API v4.

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// --- tiny helpers ---------------------------------------------------------
const toObj = (header, row) =>
  Object.fromEntries(header.map((h, i) => [h, (row[i] ?? "").toString().trim()]));

const normTags = (s) =>
  (s ? s.split(/[;,\s]+/).map((t) => t.trim()).filter(Boolean) : []);

function parseCsv(csvText) {
  // handles quotes, doubles, commas
  const lines = csvText.split(/\r?\n/);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = (lines.shift() || "")
    .split(",")
    .map((h) => h.trim().replace(/^"|"$/g, ""));

  const rows = [];
  for (const line of lines) {
    if (!line) continue;
    const out = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    rows.push(out.map((c) => c.replace(/^"|"$/g, "")));
  }
  return { headers, rows };
}

function mapRow(x) {
  // Normalize to the fields the UI/builder expects
  return {
    scenario_id: x["scenario_id"] || x["id"] || "",
    name: x["name"] || x["title"] || "",
    triggers: x["triggers"] || "",
    best_reply_shapes: (x["best_reply_shapes"] || x["channel"] || "")
      .toString()
      .split(/[;, ]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    risk_notes: x["risk_notes"] || "",
    agent_name: x["agent_name"] || "",
    how_it_works: x["how_it_works"] || "",
    tool_stack_dev: x["tool_stack_dev"] || "",
    tool_stack_autonomous: x["tool_stack_autonomous"] || "",
    tags: normTags(x["tags (;)"] || x["tags"] || ""),
    roi_hypothesis: x["roi_hypothesis"] || "",
  };
}

// --- main handler ---------------------------------------------------------
module.exports = async (req, res) => {
  Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const { q = "", cursor = "0", max } = req.query || {};
    const qLC = q.toString().toLowerCase();
    const start = parseInt(cursor, 10) || 0;
    const MAX = Math.min(parseInt(max || process.env.MAX_RESULTS || "10000", 10) || 10000, 10000);

    const CSV_URL = process.env.SCENARIOS_CSV_URL || "";
    let items = [];

    if (CSV_URL) {
      // ----- Mode A: published CSV -----
      const r = await fetch(CSV_URL);
      if (!r.ok) throw new Error(`CSV fetch error: ${r.status} ${r.statusText}`);
      const text = await r.text();
      const { headers, rows } = parseCsv(text);
      const body = rows.map((rw) => toObj(headers, rw));
      items = body.map(mapRow).filter((x) => x.scenario_id && x.name);
    } else {
      // ----- Mode B: Google Sheets API v4 -----
      const SHEET_ID = process.env.SHEET_ID;
      const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
      const TAB = process.env.SHEET_TAB || "Scenarios";
      if (!SHEET_ID || !GOOGLE_API_KEY)
        return res.status(500).json({ ok: false, error: "Missing SCENARIOS_CSV_URL or (SHEET_ID + GOOGLE_API_KEY)" });

      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}?key=${GOOGLE_API_KEY}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Sheets API error: ${r.status} ${r.statusText}`);
      const data = await r.json();
      const rows = data.values || [];
      if (!rows.length) return res.json({ ok: true, items: [] });

      const header = rows[0].map((h) => h.trim());
      const body = rows.slice(1).map((rw) => toObj(header, rw));
      items = body.map(mapRow).filter((x) => x.scenario_id && x.name);
    }

    // optional query filter
    if (qLC) {
      items = items.filter(
        (it) =>
          (it.scenario_id || "").toLowerCase().includes(qLC) ||
          (it.name || "").toLowerCase().includes(qLC)
      );
    }

    // pagination
    const page = items.slice(start, start + MAX);
    const next = start + MAX < items.length ? start + MAX : null;

    res.setHeader("Cache-Control", "public, max-age=120");
    return res.status(200).json({
      ok: true,
      count: items.length,
      page_count: page.length,
      next_cursor: next,
      items: page,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
};
