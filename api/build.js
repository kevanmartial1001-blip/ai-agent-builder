const fs = require("fs");
const path = require("path");
const ejs  = require("ejs");

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const toObj = (header,row)=>Object.fromEntries(header.map((h,i)=>[h, (row[i]??"").toString().trim()]));
const normalizeTags = s => (s? s.split(";").map(t=>t.trim()).filter(Boolean): []);
const rowToBlueprint = row => ({
  version: "0.1",
  scenario_id: row["scenario_id"] || "unknown_scenario",
  name: row["name"] || (row["scenario_id"] || "Scenario"),
  agent_name: row["agent_name"] || "Agent",
  tags: normalizeTags(row["tags (;)"] || row["tags"] || ""),
  triggers: row["triggers"] || "",
  best_reply_shapes: (row["best_reply_shapes"] || "").split(",").map(s=>s.trim()).filter(Boolean),
  risk_notes: row["risk_notes"] || "",
  how_it_works: row["how_it_works"] || "",
  tool_stack_dev: row["tool_stack_dev"] || "",
  tool_stack_autonomous: row["tool_stack_autonomous"] || "",
  roi_hypothesis: row["roi_hypothesis"] || ""
});

module.exports = async (req, res) => {
  Object.entries(HEADERS).forEach(([k,v])=>res.setHeader(k,v));
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.method !== "POST") return res.status(200).json({ ok:true, usage:'POST {"scenario_id": "<id>"}' });

    const body = await new Promise(resolve => {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { resolve({}); }
      });
    });
    const wanted = (body.scenario_id || "").toString().trim();
    if (!wanted) throw new Error("Missing scenario_id");

    const SHEET_ID = process.env.SHEET_ID;
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    const TAB = process.env.SHEET_TAB || "Scenarios";
    if (!SHEET_ID || !GOOGLE_API_KEY) throw new Error("Missing SHEET_ID or GOOGLE_API_KEY");

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}?key=${GOOGLE_API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Sheets API error: ${r.status} ${r.statusText}`);
    const data = await r.json();
    const rows = data.values || [];
    if (!rows.length) throw new Error("Sheet has no rows");

    const header = rows[0].map(h=>h.trim());
    const matchRow = rows.slice(1).map(rw => toObj(header, rw))
      .find(x => (x["scenario_id"] || "").toString().trim().toLowerCase() === wanted.toLowerCase());
    if (!matchRow) return res.status(404).json({ ok:false, error:`scenario_id not found: ${wanted}` });

    const bp = rowToBlueprint(matchRow);
    const tplStr = fs.readFileSync(path.join(process.cwd(), "templates", "n8n.json.ejs"), "utf8");
    const workflowJson = ejs.render(tplStr, bp);

    res.status(200);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${bp.scenario_id}.workflow.json"`);
    res.end(workflowJson);
  } catch (err) {
    res.status(500).json({ ok:false, error: String(err?.message || err) });
  }
};
