// api/scenarios.js
// Flexible scenarios loader: CSV (SCENARIOS_CSV_URL) OR Sheets API (SHEET_ID + GOOGLE_API_KEY + optional SHEET_TAB).

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ACCENT_MAP = { 'à':'a','á':'a','â':'a','ä':'a','ç':'c','é':'e','è':'e','ê':'e','ë':'e','î':'i','ï':'i','ô':'o','ö':'o','ù':'u','û':'u','ü':'u','ÿ':'y','ñ':'n' };
const deaccent = (s) => s.replace(/[^\u0000-\u007E]/g, ch => ACCENT_MAP[ch] || ch);

// Normalize a header key: lowercase, remove accents, strip spaces/punct like "()"
const normKey = (s) => deaccent((s || ""))
  .toLowerCase()
  .replace(/\s+/g, '')
  .replace(/[()\-_/\\.,:;'"`]/g, '');

const pick = (obj, ...candidates) => {
  for (const c of candidates) if (obj[c] != null && obj[c] !== '') return obj[c];
  return '';
};

const splitList = (s) =>
  (s || '').toString().split(/[;,|\s]+/).map(v => v.trim()).filter(Boolean);

const parseCsv = (csvText) => {
  const lines = csvText.split(/\r?\n/).filter(l => l.length);
  if (!lines.length) return { headers: [], rows: [] };

  // raw headers
  const rawHeaders = lines.shift().split(',').map(h => h.replace(/^"|"$/g, '').trim());
  const headers = rawHeaders.map(h => normKey(h));

  const rows = [];
  for (const line of lines) {
    let cur = '', inQ = false;
    const out = [];
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    rows.push(out.map(c => c.replace(/^"|"$/g, '')));
  }
  return { headers, rows, rawHeaders };
};

const toObj = (headers, row) =>
  Object.fromEntries(headers.map((h, i) => [h, (row[i] ?? '').toString().trim()]));

const mapRow = (rowNorm) => {
  // accept many header variants thanks to normKey
  const scenario_id = pick(rowNorm, 'scenarioid', 'id', 'scenariocode');
  const name       = pick(rowNorm, 'name', 'title');
  const triggers   = pick(rowNorm, 'triggers', 'pain');
  const brs        = pick(rowNorm, 'bestreplyshapes', 'channel', 'channels');
  const risk_notes = pick(rowNorm, 'risknotes');
  const agent_name = pick(rowNorm, 'agentname', 'agent');
  const how_it     = pick(rowNorm, 'howitworks', 'howitwork', 'how');
  const tool_dev   = pick(rowNorm, 'toolstackdev', 'tools', 'stack');
  const tool_auto  = pick(rowNorm, 'toolstackautonomous', 'toolstackauto');
  const tagsRaw    = pick(rowNorm, 'tags', 'tags;', 'tags;');
  const roi        = pick(rowNorm, 'roihypothesis', 'roi');

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

module.exports = async (req, res) => {
  Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const { q = '', cursor = '0', max, debug } = req.query || {};
    const qLC = q.toString().toLowerCase();
    const start = parseInt(cursor, 10) || 0;
    const MAX = Math.min(parseInt(max || process.env.MAX_RESULTS || '10000', 10) || 10000, 10000);

    const CSV_URL = process.env.SCENARIOS_CSV_URL || '';
    let items = [];
    let source = '';

    if (CSV_URL) {
      // Published CSV mode
      const r = await fetch(CSV_URL);
      if (!r.ok) throw new Error(`CSV fetch error: ${r.status} ${r.statusText}`);
      const text = await r.text();
      const { headers, rows, rawHeaders } = parseCsv(text);
      const body = rows.map((rw) => {
        const objRaw = toObj(rawHeaders.map(normKey), rw);
        return objRaw;
      });
      items = body.map(mapRow).filter(x => x.scenario_id && x.name);
      source = 'csv';
      if (debug) return res.status(200).json({ ok:true, source, normalizedHeaders: rawHeaders.map(normKey), sample: body.slice(0,3) });
    } else {
      // Sheets API v4 mode
      const SHEET_ID = process.env.SHEET_ID;
      const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
      const TAB = process.env.SHEET_TAB || 'Scenarios';
      if (!SHEET_ID || !GOOGLE_API_KEY)
        return res.status(500).json({ ok:false, error: 'Missing SCENARIOS_CSV_URL or (SHEET_ID + GOOGLE_API_KEY)' });

      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}?key=${GOOGLE_API_KEY}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Sheets API error: ${r.status} ${r.statusText}`);
      const data = await r.json();
      const rows = data.values || [];
      if (!rows.length) return res.json({ ok:true, source:'sheets', count:0, items:[] });

      const headerRaw = rows[0].map(h => h.trim());
      const headerNorm = headerRaw.map(normKey);
      const body = rows.slice(1).map(rw => toObj(headerNorm, rw));
      items = body.map(mapRow).filter(x => x.scenario_id && x.name);
      source = 'sheets';
      if (debug) return res.status(200).json({ ok:true, source, normalizedHeaders: headerNorm, sample: body.slice(0,3) });
    }

    if (qLC) {
      items = items.filter(
        it => (it.scenario_id || '').toLowerCase().includes(qLC) ||
              (it.name || '').toLowerCase().includes(qLC)
      );
    }

    const page = items.slice(start, start + MAX);
    const next = (start + MAX < items.length) ? start + MAX : null;

    res.setHeader('Cache-Control', 'public, max-age=120');
    return res.status(200).json({
      ok: true, source, count: items.length, page_count: page.length, next_cursor: next, items: page
    });
  } catch (err) {
    return res.status(500).json({ ok:false, error: String(err?.message || err) });
  }
};
