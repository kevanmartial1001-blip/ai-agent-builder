// /api/scenarios/[id].js
// Vercel file-name routing isn't available in plain folders, so name it:
// /api/scenarios.getById.js  and call with /api/scenarios.getById?id=...

const { URL } = require('url');

// Reuse the helpers from /api/scenarios.js if you want. Minimal inline versions here:
function ok(res, body, status = 200) {
  res.statusCode = status; res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store'); res.end(JSON.stringify(body));
}
function bad(res, msg, status = 400) { ok(res, { ok:false, error: msg }, status); }
function listify(v){ return Array.isArray(v)?v.map(x=>String(x).trim()).filter(Boolean):String(v||'').split(/[;,\n|]+/).map(s=>s.trim()).filter(Boolean); }

const TAG_RULES = [
  { archetype:'APPOINTMENT_SCHEDULING', include:[/appointment|scheduling|no[-_ ]?show|calendar/i] },
  { archetype:'CUSTOMER_SUPPORT_INTAKE', include:[/support|ticket|helpdesk|complaint|csat|sla/i] },
  { archetype:'SALES_OUTREACH', include:[/sales|outreach|prospect|sequence|cadence|cold[-_ ]?email/i] },
  // ... (trim for brevity, keep full list if you like)
];
function classifyFromTags(s) {
  const hay = [String(s.scenario_id||''), String(s.name||''), ...(Array.isArray(s.tags)?s.tags:listify(s.tags))].join(' ').toLowerCase();
  for (const r of TAG_RULES) if (r.include?.some(rx=>rx.test(hay))) return r.archetype;
  return 'SALES_OUTREACH';
}
function extractTools(toolStackDev) {
  const t = String(toolStackDev || '').toLowerCase();
  const has = (kw)=>t.includes(kw);
  return {
    channels:{ sms: has('twilio')||t.includes('sms'), whatsapp: has('whatsapp')||(has('twilio')&&t.includes('whatsapp')), email: has('email')||has('smtp')||has('sendgrid'), call: has('voice')||has('call') },
    systems:{ pms: has('dentrix')||has('opendental')||has('eaglesoft')||has('pms'), wms: has('wms')||has('warehouse'), erp: has('erp')||has('netsuite')||has('sap')||has('oracle'), crm: has('crm')||has('hubspot')||has('salesforce'), calendar: has('google calendar')||has('calendar'), slack: has('slack'), airtable: has('airtable'), notion: has('notion') }
  };
}

async function fetchOne(id) {
  const url = new URL(process.env.SHEETS_API_BASE);
  url.searchParams.set('fn','scenarioById');
  url.searchParams.set('spreadsheetId', process.env.SHEETS_SPREADSHEET_ID);
  url.searchParams.set('sheet', process.env.SCENARIOS_SHEET || 'scenarios');
  url.searchParams.set('id', id);
  const res = await fetch(url.toString(), { headers: { 'Authorization': `Bearer ${process.env.SHEETS_API_TOKEN}` }, cache: 'no-store' });
  if (!res.ok) throw new Error(`Sheets fetch failed: ${res.status}`);
  return res.json(); // expect a single row object
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') return bad(res, 'Use GET');
    const url = new URL(req.url, 'http://localhost');
    const id = (url.searchParams.get('id') || '').trim();
    if (!id) return bad(res, 'Missing id');

    const it = await fetchOne(id);
    if (!it || !it.scenario_id) return bad(res, 'Not found', 404);

    const row = {
      scenario_id: it.scenario_id || it.id || '',
      name: it.name || it.industry_id || '',
      triggers: it.triggers || '',
      best_reply_shapes: listify(it.best_reply_shapes || it['best_reply_shapes (;)'] || ''),
      risk_notes: it.risk_notes || '',
      agent_name: it.agent_name || '',
      how_it_works: it.how_it_works || '',
      tool_stack_dev: it.tool_stack_dev || '',
      tool_stack_autonomous: it.tool_stack_autonomous || '',
      tags: listify(it.tags || it['tags (;)'] || ''),
      roi_hypothesis: it.roi_hypothesis || '',
      industry_id: it.industry_id || it.name || '',
    };
    const archetype = classifyFromTags(row);
    const tools = extractTools(row.tool_stack_dev);

    ok(res, { ok:true, item: { ...row, archetype, tools } });
  } catch (e) {
    console.error(e);
    bad(res, e.message || 'Server error', 500);
  }
};
