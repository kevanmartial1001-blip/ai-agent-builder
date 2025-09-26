// api/scenarios.js
// Reads the "scenarios" Google Sheet and returns normalized rows.
// Env vars required: SHEET_ID, GOOGLE_API_KEY
// Optional: SHEET_TAB (default "scenarios"), MAX_RESULTS (default 10000)

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const toObj = (header, row) =>
  Object.fromEntries(header.map((h, i) => [h, (row[i] ?? "").toString().trim()]));

const splitList = (s) =>
  (Array.isArray(s) ? s : (s || ""))
    .toString()
    .split(/[;,|\n]/)
    .map((t) => t.trim())
    .filter(Boolean);

module.exports = async (req, res) => {
  // CORS
  Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const SHEET_ID = process.env.SHEET_ID;
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    const TAB = process.env.SHEET_TAB || "scenarios";
    const MAX =
      Math.min(parseInt(process.env.MAX_RESULTS || "10000", 10) || 10000, 10000);

    if (!SHEET_ID || !GOOGLE_API_KEY) {
      return res
        .status(500)
        .json({ ok: false, error: "Missing SHEET_ID or GOOGLE_API_KEY" });
    }

    // Fetch sheet
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(
      TAB
    )}?key=${GOOGLE_API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Sheets API error: ${r.status} ${r.statusText}`);
    const data = await r.json();

    const rows = data.values || [];
    if (!rows.length) {
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.status(200).json({ ok: true, source: "sheets", count: 0, items: [] });
    }

    // Normalize header names as-is (your sheet uses exact labels)
    const header = rows[0].map((h) => h.trim());

    // Required columns
    const required = ["scenario_id", "name"];
    for (const key of required) {
      if (!header.includes(key)) {
        return res
          .status(500)
          .json({ ok: false, error: `Missing required column: ${key}` });
      }
    }

    // Map body
    const body = rows.slice(1).map((rw) => toObj(header, rw));

    // Normalize/shape each item to your schema
    let items = body
      .map((x) => {
        // prefer "tags (;)" but also accept "tags"
        const rawTags = x["tags (;)"] ?? x["tags"] ?? "";
        return {
          scenario_id: x["scenario_id"] || "",
          name: x["name"] || "",
          triggers: x["triggers"] || "",
          best_reply_shapes: splitList(x["best_reply_shapes"] || ""),
          risk_notes: x["risk_notes"] || "",
          agent_name: x["agent_name"] || "",
          how_it_works: x["how_it_works"] || "",
          tool_stack_dev: x["tool_stack_dev"] || "",
          tool_stack_autonomous: x["tool_stack_autonomous"] || "",
          tags: splitList(rawTags),
          roi_hypothesis: x["roi_hypothesis"] || "",
        };
      })
      .filter((it) => it.scenario_id && it.name);

    // Query params
    const q = (req.query.q || "").toString().toLowerCase().trim();
    const cursor = parseInt((req.query.cursor || "0").toString(), 10) || 0;
    const limit = Math.min(
      parseInt((req.query.max || "").toString(), 10) || MAX,
      MAX
    );

    // Optional exact filter by scenario_id
    const eq = (req.query.eq || "").toString().trim();
    if (eq) {
      items = items.filter((it) => it.scenario_id === eq);
    }

    // Fuzzy search on scenario_id or name
    if (q) {
      items = items.filter(
        (it) =>
          (it.scenario_id || "").toLowerCase().includes(q) ||
          (it.name || "").toLowerCase().includes(q)
      );
    }

    const total = items.length;
    const page = items.slice(cursor, cursor + limit);
    const next = cursor + limit < total ? cursor + limit : null;

    res.setHeader("Cache-Control", "public, max-age=120");
    return res.status(200).json({
      ok: true,
      source: "sheets",
      count: total,
      page_count: page.length,
      next_cursor: next,
      items: page,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
};
