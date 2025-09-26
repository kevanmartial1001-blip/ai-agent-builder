// api/scenarios.js
// Reads the "scenarios" sheet using Google Sheets API v4 with your exact headers.
// Env: SHEET_ID, GOOGLE_API_KEY
// Optional: SHEET_TAB (default "scenarios"), MAX_RESULTS (default 10000)

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const toObj = (header, row) =>
  Object.fromEntries(header.map((h, i) => [h, (row[i] ?? "").toString().trim()]));

module.exports = async (req, res) => {
  Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const SHEET_ID = process.env.SHEET_ID;
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    const TAB = process.env.SHEET_TAB || "scenarios"; // << your sheet name
    if (!SHEET_ID || !GOOGLE_API_KEY) {
      return res.status(500).json({ ok: false, error: "Missing SHEET_ID or GOOGLE_API_KEY" });
    }

    const { q = "", cursor = "0", max } = req.query || {};
    const qLC = q.toString().toLowerCase();
    const start = parseInt(cursor, 10) || 0;
    const MAX = Math.min(parseInt(max || process.env.MAX_RESULTS || "10000", 10) || 10000, 10000);

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}?key=${GOOGLE_API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Sheets API error: ${r.status} ${r.statusText}`);

    const data = await r.json();
    const rows = data.values || [];
    if (!rows.length) return res.status(200).json({ ok: true, source: "sheets", count: 0, items: [] });

    // Expect your exact headers in row 1
    const header = rows[0].map(h => h.trim());
    // Minimal hard checks (these must exist)
    const must = ["scenario_id", "name"];
    for (const key of must) if (!header.includes(key)) {
      return res.status(500).json({ ok: false, error: `Missing required column: ${key}` });
    }

    const body = rows.slice(1).map(rw => toObj(header, rw));
    let items = body.map(x => ({
      // exact columns from your note
      scenario_id: x["scenario_id"] || "",
      name: x["name"] || "",
      triggers: x["triggers"] || "",
      best_reply_shapes: (x["best_reply_shapes"] || "").split(/[;,|\s]+/).filter(Boolean),
      risk_notes: x["risk_notes"] || "",
      agent_name: x["agent_name"] || "",
      how_it_works: x["how_it_works"] || "",
      tool_stack_dev: x["tool_stack_dev"] || "",
      tool_stack_autonomous: x["tool_stack_autonomous"] || "",
      tags: (x["tags (;)"] || "").split(";").map(s => s.trim()).filter(Boolean),
      roi_hypothesis: x["roi_hypothesis"] || "",
    })).filter(x => x.scenario_id && x.name);

    if (qLC) {
      items = items.filter(
        it => (it.scenario_id || "").toLowerCase().includes(qLC) ||
              (it.name || "").toLowerCase().includes(qLC)
      );
    }

    const page = items.slice(start, start + MAX);
    const next = start + MAX < items.length ? start + MAX : null;

    res.setHeader("Cache-Control", "public, max-age=120");
    return res.status(200).json({
      ok: true, source: "sheets", count: items.length, page_count: page.length, next_cursor: next, items: page
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
};
