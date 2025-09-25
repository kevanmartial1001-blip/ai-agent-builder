// POST /api/compile  with JSON body: { blueprint: "<yaml or json string>" }
// Returns application/zip containing n8n.json, prompts, policies, tests, synthetic data.

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const ejs  = require("ejs");
const archiver = require("archiver");

// helper: parse YAML or JSON string
function parseBlueprint(str) {
  try {
    if (!str || typeof str !== "string") throw new Error("empty blueprint");
    // try JSON first, then YAML
    try { return JSON.parse(str); } catch (_) {}
    return yaml.load(str);
  } catch (e) {
    throw new Error("Invalid blueprint: " + e.message);
  }
}

function renderN8n(bp, tplStr) {
  return ejs.render(tplStr, bp);
}

function defaultFiles(bp, n8nJson) {
  const files = {};
  const base = `${bp.scenario_id}/`;

  files[base + "workflows/n8n.json"] = n8nJson;

  files[base + "prompts/intent_classifier.md"] = `Return one of: CONFIRM | CANCEL | RESCHEDULE | LATE | HUMAN.
Examples:
- "Yes I'll be there" -> CONFIRM
- "I need to cancel" -> CANCEL
- "Can we do next week?" -> RESCHEDULE
- "Running 20 min late" -> LATE
`;

  files[base + "prompts/channel_email.md"] = `Subject: Appointment reminder

Hi {first_name},
Your appointment is on {date_short} at {time_short} with {doctor}.
Reply:
- "1" to CONFIRM
- "2" to RESCHEDULE
- "3" to CANCEL
`;

  files[base + "policies/hipaa_gdpr.md"] = `- PHI minimization: first name + last initial only in messages.
- TCPA: store consent source+timestamp; honor STOP keyword.
- Quiet hours: 21:00–08:00 local.
- Retention: logs 365 days; message bodies redacted after 30 days.
`;

  files[base + "data/synthetic/appointments.csv"] =
"appointment_id,patient_first,patient_last,email,appt_time,doctor,confirmed\nA1001,Sara,L.,sara@example.com,2025-10-02T10:00,Dr. Lee,false\nA1002,Marco,T.,marco@example.com,2025-10-02T11:30,Dr. Chen,false\n";

  files[base + "tests/uat.json"] = JSON.stringify([
    { case:"confirm",    in:"Yes I'll be there",    out:"CONFIRM"    },
    { case:"cancel",     in:"I need to cancel",     out:"CANCEL"     },
    { case:"reschedule", in:"Can we do next week?", out:"RESCHEDULE" },
    { case:"late",       in:"Running 20 min late",  out:"LATE"       }
  ], null, 2);

  files[base + "README.md"] = `# ${bp.name}

**Agent:** ${bp.agent_name}

## Triggers
${bp.triggers}

## How it works
${bp.how_it_works}

## ROI
${bp.roi_hypothesis}
`;

  return files;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Content-Type", "text/plain");
      res.status(200).send("POST a JSON body { blueprint: \"<yaml or json>\" } to get a ZIP.");
      return;
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try { body = JSON.parse(raw); } catch (_) {}

    const blueprintStr = body.blueprint;
    if (!blueprintStr) {
      res.status(400).json({ ok:false, error:"Missing 'blueprint' in JSON body" });
      return;
    }

    const bp = parseBlueprint(blueprintStr);

    // minimal required fields
    ["scenario_id","name","agent_name","triggers","how_it_works","roi_hypothesis"].forEach(k=>{
      if (!bp[k]) throw new Error(`Blueprint missing '${k}'`);
    });

    // load template from repo
    const tplPath = path.join(process.cwd(), "templates", "n8n.json.ejs");
    const tplStr = fs.readFileSync(tplPath, "utf8");
    const n8nJson = renderN8n(bp, tplStr);

    // assemble files
    const files = defaultFiles(bp, n8nJson);

    // stream zip
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${bp.scenario_id}.zip"`);

    const archive = archiver("zip", { zlib: { level: 8 } });
    archive.on("error", err => { throw err; });
    archive.pipe(res);

    for (const [p, content] of Object.entries(files)) {
      archive.append(content, { name: p });
    }

    await archive.finalize();
  } catch (err) {
    res.status(500).json({ ok:false, error: String(err && err.message || err) });
  }
};
