const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const toObj = (header,row)=>Object.fromEntries(header.map((h,i)=>[h, (row[i]??"").toString().trim()]));
const normalizeTags = s => (s? s.split(";").map(t=>t.trim()).filter(Boolean): []);

module.exports = async (req, res) => {
  Object.entries(HEADERS).forEach(([k,v])=>res.setHeader(k,v));
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const SHEET_ID = process.env.SHEET_ID;
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    const TAB = process.env.SHEET_TAB || "Scenarios";
    const MAX = parseInt(process.env.MAX_RESULTS || "50", 10);
    if (!SHEET_ID || !GOOGLE_API_KEY) return res.status(500).json({ok:false,error:"Missing SHEET_ID or GOOGLE_API_KEY"});

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}?key=${GOOGLE_API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Sheets API error: ${r.status} ${r.statusText}`);
    const data = await r.json();
    const rows = data.values || [];
    if (!rows.length) return res.json({ ok:true, items: [] });

    const header = rows[0].map(h=>h.trim());
    const body = rows.slice(1).map(rw => toObj(header, rw));

    const q = (req.query.q || "").toString().toLowerCase();
    let items = body.map(x => ({
      scenario_id: x["scenario_id"] || "",
      name: x["name"] || "",
      triggers: x["triggers"] || "",
      best_reply_shapes: (x["best_reply_shapes"] || "").split(",").map(s=>s.trim()).filter(Boolean),
      risk_notes: x["risk_notes"] || "",
      agent_name: x["agent_name"] || "",
      how_it_works: x["how_it_works"] || "",
      tool_stack_dev: x["tool_stack_dev"] || "",
      tool_stack_autonomous: x["tool_stack_autonomous"] || "",
      tags: normalizeTags(x["tags (;)"] || x["tags"] || ""),
      roi_hypothesis: x["roi_hypothesis"] || ""
    }));

    if (q) items = items.filter(it =>
      it.scenario_id.toLowerCase().includes(q) || it.name.toLowerCase().includes(q)
    );

    const cursor = parseInt((req.query.cursor || "0"), 10) || 0;
    const page = items.slice(cursor, cursor + MAX);
    const next = (cursor + MAX < items.length) ? (cursor + MAX) : null;

    res.status(200).json({ ok: true, items: page, next_cursor: next });
  } catch (err) {
    res.status(500).json({ ok:false, error: String(err?.message || err) });
  }
};
