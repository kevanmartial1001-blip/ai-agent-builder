// api/compile.js — always returns an n8n importable workflow JSON
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const ejs  = require("ejs");

function parseBlueprint(str) {
  if (!str || typeof str !== "string") throw new Error("empty blueprint");
  try { return JSON.parse(str); } catch (_) {}
  return yaml.load(str);
}

module.exports = async (req, res) => {
  // CORS for browser usage
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  try {
    if (req.method !== "POST") {
      res.setHeader("Content-Type", "text/plain");
      res.status(200).send('POST JSON { blueprint: "<yaml or json>" } to download an n8n workflow JSON.');
      return;
    }

    // Read body JSON
    const body = await new Promise(resolve => {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { resolve({}); }
      });
    });

    const bp = parseBlueprint(body.blueprint);
    ["scenario_id","name","agent_name","triggers","how_it_works","roi_hypothesis"].forEach(k=>{
      if (!bp[k]) throw new Error(`Blueprint missing '${k}'`);
    });

    // Render importable n8n workflow JSON from template
    const tplStr = fs.readFileSync(path.join(process.cwd(), "templates", "n8n.json.ejs"), "utf8");
    const workflowJson = ejs.render(tplStr, bp);

    res.status(200);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${bp.scenario_id}.workflow.json"`);
    res.end(workflowJson);
  } catch (err) {
    res.status(500).json({ ok:false, error: String(err && err.message || err) });
  }
};
