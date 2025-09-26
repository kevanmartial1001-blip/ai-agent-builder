// api/industries.js
// Env: SHEET_ID, GOOGLE_API_KEY
// Optional: SHEET_TAB_INDUSTRIES (default "industries"), MAX_RESULTS (default 10000)

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const toObj = (header, row) =>
  Object.fromEntries(header.map((h, i) => [h, (row[i] ?? "").toString().trim()]));

const splitList = (s, sep = /[;,|\n]/) =>
  (s ? s.split(sep).map(t => t.trim()).filter(Boolean) : []);

module.exports = async (req, res) => {
  Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const SHEET_ID = process.env.SHEET_ID;
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    const TAB = process.env.SHEET_TAB_INDUSTRIES || "industries";
    const MAX = Math.min(parseInt(process.env.MAX_RESULTS || "10000", 10), 10000);

    if (!SHEET_ID || !GOOGLE_API_KEY) {
      return res.status(500).json({ ok: false, error: "Missing SHEET_ID or GOOGLE_API_KEY" });
    }

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}?key=${GOOGLE_API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Sheets API error: ${r.status} ${r.statusText}`);

    const data = await r.json();
    const rows = data.values || [];
    if (!rows.length) return res.status(200).json({ ok: true, count: 0, items: [] });

    const header = rows[0].map(h => h.trim());
    if (!header.includes("industry_id")) {
      return res.status(500).json({ ok: false, error: "Missing required column: industry_id" });
    }

    const body = rows.slice(1).map(rw => toObj(header, rw));
    const items = body.slice(0, MAX).map(x => {
      // keep all columns, and normalize a few common ones to arrays if present
      const obj = { ...x };
      // optional conventional columns we often see
      if (obj.painpoints) obj.painpoints_list = splitList(obj.painpoints);
      if (obj.channels) obj.channels_list = splitList(obj.channels);
      if (obj.kpis) obj.kpis_list = splitList(obj.kpis);
      if (obj.personas) obj.personas_list = splitList(obj.personas);
      if (obj.tools) obj.tools_list = splitList(obj.tools);
      if (obj.vocabulary) obj.vocabulary_list = splitList(obj.vocabulary);
      return obj;
    });

    res.setHeader("Cache-Control", "public, max-age=120");
    return res.status(200).json({ ok: true, count: items.length, items });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
};
