// api/scenarios.js
// Google Sheets API v4 ONLY version.
// Env required: SHEET_ID, GOOGLE_API_KEY
// Optional: SHEET_TAB (default "Scenarios"), MAX_RESULTS (default 10000)

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// --- helpers ---------------------------------------------------------------
const ACCENT_MAP = { 'à':'a','á':'a','â':'a','ä':'a','ç':'c','é':'e','è':'e','ê':'e','ë':'e','î':'i','ï':'i','ô':'o','ö':'o','ù':'u','û':'u','ü':'u','ÿ':'y','ñ':'n' };
const deaccent = (s) => (s || "").replace(/[^\u0000-\u007E]/g, ch => ACCENT_MAP[ch] || ch);

// normalize header keys: lowercase, strip spaces/punct/accents
const normKey = (s) => deaccent(String(s || ""))
  .toLowerCase()
  .replace(/\s+/g, "")
  .replace(/[()\-_/\\.,:;'"`]/g, "");

const toObj = (headers, row) =>
  Object.fromEntries(headers.map((h, i) => [h, (row[i] ?? "").toString().trim()]));

const pick = (obj, ...candidates) => {
  for (const c of candidates) if (obj[c] != null && obj[c] !== "") return obj[c];
  return "";
};

const splitList = (s) =>
  (s || "").toString().split(/[;,|\s]+/).map(v => v.trim()).filter(Boolean);

const mapRow = (rowNorm) => {
  // Accept common header variants thanks to normKey()
  const scenario_id = pick(rowNorm, "scenarioid", "id", "scenariocode");
  const name        = pick(rowNorm, "name", "title");
  const triggers    = pick(rowNorm, "triggers", "pain");
  const brs         = pick(rowNorm, "bestreplyshapes", "channel", "channels");
  const risk_notes  = pick(rowNorm, "risknotes");
  const agent_name  = pick(rowNorm, "agentname", "agent");
  const how_it      = pick(rowNorm, "howitworks", "howitwork", "how");
  const tool_dev    = pick(rowNorm, "toolstackdev", "tools", "stack");
  const tool_auto   = pick(rowNorm, "toolstackautonomous", "toolstackauto");
  const tagsRaw     = pick(rowNorm, "tags", "tags;", "tags;");
  const roi         = pick(rowNorm, "roihypothesis", "roi");

  return {
    scenario_id,
    name,
    triggers,
    best_reply_shapes: splitList(brs),
    risk_notes,
    agent_name,
    how_it_works: how_it,
    tool_stack_dev: tool_dev,
    tool_stack_autonomous: tool_auto,
    tags: splitList(tagsRaw),
    roi_hypothesis: roi,
  };
};

// --- handler ---------------------------------------------------------------
module.exports = async (req, res) => {
  Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const SHEET_ID = process.env.SHEET_ID;
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    const TAB = process.env.SHEET_TAB || "Scenarios";

    if (!SHEET_ID || !GOOGLE_API_KEY) {
      return res.status(500).json({ ok:false, error:"Missing SHEET_ID or GOOGLE_API_KEY" });
    }

    const { q = "", cursor = "0", max, debug } = req.query || {};
    const qLC = q.toString().toLowerCase();
    const start = parseInt(cursor, 10) || 0;
    const MAX = Math.min(parseInt(max || process.env.MAX_RESULTS || "10000", 10) || 10000, 10000);

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}?key=${GOOGLE_API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Sheets API error: ${r.status} ${r.statusText}`);

    const data = await r.json();
    const rows = data.values || [];
    if (!rows.length) return res.status(200).json({ ok:true, source:"sheets", count:0, items:[] });

    // header normalization
    const headerRaw = rows[0].map(h => h.trim());
    const headerNorm = headerRaw.map(normKey);

    // build normalized row objects
    const body = rows.slice(1).map(rw => toObj(headerNorm, rw));
    let items = body.map(mapRow).filter(x => x.scenario_id && x.name);

    if (debug) {
      return res.status(200).json({
        ok: true,
        source: "sheets",
        normalizedHeaders: headerNorm,
        sample: body.slice(0, 3),
        parsedSample: items.slice(0, 3)
      });
    }

    // optional filter
    if (qLC) {
      items = items.filter(
        it =>
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
      source: "sheets",
      count: items.length,
      page_count: page.length,
      next_cursor: next,
      items: page
    });
  } catch (err) {
    return res.status(500).json({ ok:false, error: String(err?.message || err) });
  }
};
