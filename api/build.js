#!/usr/bin/env node
/**
 * build.js
 * Universal workflow file generator (presentation style, per-scenario, per-channel)
 *
 * Usage examples:
 *   node build.js --scenarios=appointments,proposal --channel=whatsapp
 *   UI can call with process.env.BUILD_SCENARIOS and process.env.BUILD_CHANNEL
 * Outputs:
 *   ./dist/<Scenario>-<Channel>.json
 *
 * No external deps.
 */

const fs = require('fs');
const path = require('path');

/* --------------------------- ARG / ENV PARSING --------------------------- */

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (const a of args) {
    const [k, v] = a.split('=');
    const key = k.replace(/^--/, '').trim();
    out[key] = v ?? true;
  }
  return out;
}

const argv = parseArgs();
const SCENARIOS =
  (argv.scenarios || process.env.BUILD_SCENARIOS || 'appointments')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

const CHANNEL =
  (argv.channel || process.env.BUILD_CHANNEL || 'web').trim().toLowerCase();

const VALID_CHANNELS = new Set(['whatsapp', 'voice', 'web']);

if (!VALID_CHANNELS.has(CHANNEL)) {
  console.error(
    `[build] Invalid --channel="${CHANNEL}". Use one of: whatsapp | voice | web`
  );
  process.exit(1);
}

/* --------------------------- UTIL: N8N HELPERS --------------------------- */

let autoId = 0;
function nid() {
  // quick unique-ish id
  return `n${Date.now().toString(36)}_${(autoId++).toString(36)}`;
}

function sticky(content, { x, y, color = 7, w = 900, h = 200 }) {
  return {
    id: nid(),
    name: 'Sticky Note',
    type: 'n8n-nodes-base.stickyNote',
    position: [x, y],
    parameters: { color, width: w, height: h, content },
    typeVersion: 1,
  };
}

function webhookNode({ name, pathSuffix, x, y, respond = true }) {
  return {
    id: nid(),
    name,
    type: 'n8n-nodes-base.webhook',
    position: [x, y],
    parameters: {
      path: pathSuffix,
      httpMethod: 'POST',
      responseMode: respond ? 'responseNode' : 'onReceived',
      options: {},
    },
    typeVersion: 2,
  };
}

function setNode({ name, x, y, assignments = [] }) {
  return {
    id: nid(),
    name,
    type: 'n8n-nodes-base.set',
    position: [x, y],
    parameters: {
      options: {},
      assignments: { assignments },
    },
    typeVersion: 3.4,
  };
}

function codeNode({ name, x, y, js }) {
  return {
    id: nid(),
    name,
    type: 'n8n-nodes-base.code',
    position: [x, y],
    parameters: { jsCode: js, mode: 'runOnceForAllItems' },
    typeVersion: 2,
  };
}

function switchNode({ name, x, y, rules }) {
  return {
    id: nid(),
    name,
    type: 'n8n-nodes-base.switch',
    position: [x, y],
    parameters: {
      rules: { values: rules },
      options: {},
    },
    typeVersion: 3.2,
  };
}

function ifNode({ name, x, y, conditions }) {
  return {
    id: nid(),
    name,
    type: 'n8n-nodes-base.if',
    position: [x, y],
    parameters: {
      options: {},
      conditions,
      looseTypeValidation: false,
    },
    typeVersion: 2.2,
  };
}

function respondNode({ name, x, y, bodyExpr }) {
  return {
    id: nid(),
    name,
    type: 'n8n-nodes-base.respondToWebhook',
    position: [x, y],
    parameters: {
      options: {},
      respondWith: 'json',
      responseBody: bodyExpr,
    },
    typeVersion: 1.1,
  };
}

function gcalNode({ name, x, y, params }) {
  return {
    id: nid(),
    name,
    type: 'n8n-nodes-base.googleCalendar',
    position: [x, y],
    parameters: params,
    typeVersion: 1.3,
    credentials: {},
  };
}

function airtableNode({ name, x, y, params }) {
  return {
    id: nid(),
    name,
    type: 'n8n-nodes-base.airtable',
    position: [x, y],
    parameters: params,
    typeVersion: 2.1,
    credentials: {},
  };
}

function whatsappSendNode({ name, x, y }) {
  return {
    id: nid(),
    name,
    type: 'n8n-nodes-base.whatsApp',
    position: [x, y],
    parameters: {
      operation: 'send',
      messageType: 'text',
      recipientPhoneNumber: "={{ $json.payload.customer_number || 'REPLACE_ME' }}",
      phoneNumberId: "={{ $json.whatsapp_phone_number_id || 'REPLACE_ME' }}",
      text:
        "={{ $json.message + ($json.alternatives ? '\\n' + ($json.alternatives.map(a => '- ' + a.start).join('\\n')) : '') }}",
    },
    typeVersion: 1,
    credentials: { whatsAppApi: { id: 'REPLACE_ME', name: 'WhatsApp Creds' } },
  };
}

/* --------------------------- APPOINTMENTS SCENARIO --------------------------- */

function buildAppointmentsWorkflow(selectedChannel) {
  // NODES
  const nodes = [];

  // Overview sticky
  nodes.push(
    sticky(
      `## Universal Channel Appointments (Collectors First)
**Channel:** ${selectedChannel}
**Intents:** book | update | cancel

**Collectors:** Contact → Time | Reschedule | Cancel

**Terminal Actions:** GCal create/update/delete + Airtable log + Channel-specific response`,
      { x: -1060, y: -160, color: 7, w: 1400, h: 220 }
    )
  );

  // Trigger
  const nTrigger = webhookNode({
    name: 'Universal Trigger (UI/Server)',
    pathSuffix: 'universal-channel',
    x: -820,
    y: 140,
    respond: true,
  });
  nodes.push(nTrigger);

  // Normalize
  const nNormalize = setNode({
    name: 'Normalize & Defaults',
    x: -580,
    y: 140,
    assignments: [
      { id: 'a1', name: 'selected_channel', type: 'string', value: `=${JSON.stringify(selectedChannel)}` },
      { id: 'a2', name: 'intent', type: 'string', value: "={{ ($json.intent || '').toLowerCase() }}" },
      { id: 'a3', name: 'payload', type: 'object', value: '={{ $json.payload || {} }}' },
      { id: 'a4', name: 'timezone', type: 'string', value: '=America/Chicago' },
      { id: 'a5', name: 'business_hours', type: 'string', value: "={{ 'Mon-Fri 08:00-17:00' }}" },
    ],
  });
  nodes.push(nNormalize);

  // Intent switch
  const nIntent = switchNode({
    name: 'Switch: Intent (book/update/cancel)',
    x: -300,
    y: 140,
    rules: [
      {
        outputKey: 'book',
        conditions: {
          combinator: 'and',
          options: { version: 2, typeValidation: 'strict' },
          conditions: [
            {
              id: 'i1',
              operator: { type: 'string', operation: 'equals' },
              leftValue: '={{ $json.intent }}',
              rightValue: 'book',
            },
          ],
        },
      },
      {
        outputKey: 'update',
        conditions: {
          combinator: 'and',
          options: { version: 2, typeValidation: 'strict' },
          conditions: [
            {
              id: 'i2',
              operator: { type: 'string', operation: 'equals' },
              leftValue: '={{ $json.intent }}',
              rightValue: 'update',
            },
          ],
        },
      },
      {
        outputKey: 'cancel',
        conditions: {
          combinator: 'and',
          options: { version: 2, typeValidation: 'strict' },
          conditions: [
            {
              id: 'i3',
              operator: { type: 'string', operation: 'equals' },
              leftValue: '={{ $json.intent }}',
              rightValue: 'cancel',
            },
          ],
        },
      },
    ],
  });
  nodes.push(nIntent);

  // Collectors
  const nContact = codeNode({
    name: 'Collector: Contact Info',
    x: 60,
    y: -40,
    js: `
const p = $json.payload || {};
const missing = [];
if (!p.name) missing.push('name');
if (!p.email || !(p.email + '').includes('@')) missing.push('email');
return { json: { ...$json, collectDone: missing.length===0, missing, prompt: missing.length ? \`I need \${missing.join(' & ')}.\` : '' } };
`.trim(),
  });
  nodes.push(nContact);

  const nTime = codeNode({
    name: 'Collector: Time Window',
    x: 60,
    y: 120,
    js: `
const p = $json.payload || {};
const missing = [];
if (!p.starttime) missing.push('starttime');
if (!p.endtime) missing.push('endtime');
return { json: { ...$json, collectDone: missing.length===0, missing, prompt: missing.length ? \`I need \${missing.join(' & ')} (ISO).\` : '' } };
`.trim(),
  });
  nodes.push(nTime);

  const nReschedule = codeNode({
    name: 'Collector: Reschedule Window',
    x: 60,
    y: 300,
    js: `
const p = $json.payload || {};
const missing = [];
if (!p.starttime) missing.push('starttime');
if (!p.rescheduled_starttime) missing.push('rescheduled_starttime');
if (!p.rescheduled_endtime) missing.push('rescheduled_endtime');
return { json: { ...$json, collectDone: missing.length===0, missing, prompt: missing.length ? \`I need \${missing.join(' & ')} (ISO).\` : '' } };
`.trim(),
  });
  nodes.push(nReschedule);

  const nCancel = codeNode({
    name: 'Collector: Cancel Info',
    x: 60,
    y: 480,
    js: `
const p = $json.payload || {};
const missing = [];
if (!p.starttime) missing.push('starttime');
return { json: { ...$json, collectDone: missing.length===0, missing, prompt: missing.length ? \`I need \${missing.join(' & ')} (ISO).\` : '' } };
`.trim(),
  });
  nodes.push(nCancel);

  // Sticky: Book
  nodes.push(
    sticky(
      '## Book Flow\n1) Contact → Time\n2) GCal freebusy\n3) If free → Create + Airtable + Respond\n4) Else → Alternatives + Respond',
      { x: -40, y: -200, color: 4, w: 520, h: 160 }
    )
  );

  // GCal freebusy
  const nFreebusy = gcalNode({
    name: 'Check Availability (GCal)',
    x: 360,
    y: 120,
    params: {
      resource: 'calendar',
      timeMin: '={{ $json.payload.starttime }}',
      timeMax: '={{ $json.payload.endtime }}',
      operation: 'getAvailability',
      options: {},
      calendar: {
        '__rl': true,
        mode: 'list',
        value: 'your-calendar@example.com',
        cachedResultName: 'your-calendar@example.com',
      },
    },
  });
  nodes.push(nFreebusy);

  const nAvailBool = codeNode({
    name: 'Freebusy → Available?',
    x: 580,
    y: 120,
    js: `
const busy = ($json.busy || []).length;
return { json: { ...$json, available: busy === 0 } };
`.trim(),
  });
  nodes.push(nAvailBool);

  const nIfAvail = ifNode({
    name: 'If available == true',
    x: 800,
    y: 120,
    conditions: {
      combinator: 'and',
      options: { version: 2 },
      conditions: [
        {
          id: 'av',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          leftValue: '={{ $json.available }}',
        },
      ],
    },
  });
  nodes.push(nIfAvail);

  const nCreate = gcalNode({
    name: 'Create Event (GCal)',
    x: 1020,
    y: 60,
    params: {
      operation: 'create',
      start: '={{ $json.payload.starttime }}',
      end: '={{ $json.payload.endtime }}',
      calendar: { '__rl': true, mode: 'list', value: 'your-calendar@example.com' },
      additionalFields: {
        summary: "={{ $json.payload.Title || 'Service Appointment' }}",
        description: '={{ $json.payload.notes || "" }}',
        allday: 'no',
        attendees: ['={{ $json.payload.email }}'],
      },
    },
  });
  nodes.push(nCreate);

  const nAirLog = airtableNode({
    name: 'Airtable: Log Booking',
    x: 1240,
    y: 60,
    params: {
      base: { '__rl': true, mode: 'list', value: 'appXXXXXXXXXXXXXX' },
      table: { '__rl': true, mode: 'list', value: 'tblXXXXXXXXXXXXXX' },
      operation: 'create',
      columns: {
        value: {
          Name: '={{ $json.payload.name }}',
          Email: '={{ $json.payload.email }}',
          'Phone Number': '={{ $json.payload.customer_number || "" }}',
          starttime: '={{ $json.payload.starttime }}',
          endtime: '={{ $json.payload.endtime }}',
          'Booking Status': 'confirmed',
          meetdescription: '={{ $json.payload.notes || "" }}',
          eventId: '={{ $json.id }}',
        },
        mappingMode: 'defineBelow',
        matchingColumns: ['eventId'],
      },
    },
  });
  nodes.push(nAirLog);

  const nBuildSuccess = setNode({
    name: 'Build Success Payload',
    x: 1460,
    y: 60,
    assignments: [
      { id: 's1', name: 'status', type: 'string', value: '=ok' },
      {
        id: 's2',
        name: 'message',
        type: 'string',
        value: '=Appointment confirmed.',
      },
    ],
  });
  nodes.push(nBuildSuccess);

  // Alternatives branch
  const nAlt = codeNode({
    name: 'Build Alternatives (next 5 slots)',
    x: 1020,
    y: 180,
    js: `
const start = new Date($json.payload.starttime);
const slots = [];
for (let i=1;i<=5;i++){
  const d=new Date(start);
  d.setMinutes(d.getMinutes()+30*i);
  const e=new Date(d);
  e.setMinutes(e.getMinutes()+30);
  slots.push({start:d.toISOString(), end:e.toISOString()});
}
return { json: { ...$json, alternatives: slots } };
`.trim(),
  });
  nodes.push(nAlt);

  const nBuildAltPayload = setNode({
    name: 'Build Alternatives Payload',
    x: 1240,
    y: 180,
    assignments: [
      { id: 'a10', name: 'status', type: 'string', value: '=not_available' },
      {
        id: 'a11',
        name: 'message',
        type: 'string',
        value: '=The requested time is not available. Here are options:',
      },
      {
        id: 'a12',
        name: 'alternatives',
        type: 'array',
        value: '={{ $json.alternatives || [] }}',
      },
    ],
  });
  nodes.push(nBuildAltPayload);

  // Sticky: Update
  nodes.push(
    sticky(
      '## Update Flow\n1) Contact → Reschedule\n2) Find Airtable by phone → Update GCal → Update Airtable\n3) Respond (channel)',
      { x: -40, y: 240, color: 5, w: 520, h: 140 }
    )
  );

  const nFindByPhone = airtableNode({
    name: 'Airtable: Find Event by Phone',
    x: 360,
    y: 300,
    params: {
      base: { '__rl': true, mode: 'list', value: 'appXXXXXXXXXXXXXX' },
      table: { '__rl': true, mode: 'list', value: 'tblXXXXXXXXXXXXXX' },
      operation: 'search',
      filterByFormula: '={Phone Number} = ("{{ $json.payload.customer_number }}")',
      options: { fields: ['eventId', 'Email', 'Name', 'starttime'] },
    },
  });
  nodes.push(nFindByPhone);

  const nSetEventId = setNode({
    name: 'Set eventId from Airtable',
    x: 580,
    y: 300,
    assignments: [
      { id: 'e1', name: 'eventId', type: 'string', value: '={{ $json.eventId }}' },
    ],
  });
  nodes.push(nSetEventId);

  const nUpdate = gcalNode({
    name: 'Update Event (GCal)',
    x: 800,
    y: 300,
    params: {
      operation: 'update',
      eventId: '={{ $json.eventId }}',
      calendar: { '__rl': true, mode: 'list', value: 'your-calendar@example.com' },
      updateFields: {
        start: '={{ $json.payload.rescheduled_starttime }}',
        end: '={{ $json.payload.rescheduled_endtime }}',
        allday: 'no',
      },
    },
  });
  nodes.push(nUpdate);

  const nAirUpdate = airtableNode({
    name: 'Airtable: Update Row',
    x: 1020,
    y: 300,
    params: {
      base: { '__rl': true, mode: 'list', value: 'appXXXXXXXXXXXXXX' },
      table: { '__rl': true, mode: 'list', value: 'tblXXXXXXXXXXXXXX' },
      operation: 'update',
      columns: {
        value: {
          eventId: '={{ $json.eventId }}',
          starttime:
            '={{ $json.start?.dateTime || $json.payload.rescheduled_starttime }}',
          endtime:
            '={{ $json.end?.dateTime || $json.payload.rescheduled_endtime }}',
          'Booking Status': 'Updated/Rescheduled',
        },
        mappingMode: 'defineBelow',
        matchingColumns: ['eventId'],
      },
    },
  });
  nodes.push(nAirUpdate);

  const nBuildSuccess2 = setNode({
    name: 'Build Success Payload (Update)',
    x: 1240,
    y: 300,
    assignments: [
      { id: 'su1', name: 'status', type: 'string', value: '=ok' },
      {
        id: 'su2',
        name: 'message',
        type: 'string',
        value: '=Appointment rescheduled.',
      },
    ],
  });
  nodes.push(nBuildSuccess2);

  // Sticky: Cancel
  nodes.push(
    sticky(
      '## Cancel Flow\n1) Contact → Cancel info\n2) Find Airtable → Delete GCal → Update Airtable\n3) Respond (channel)',
      { x: -40, y: 420, color: 3, w: 520, h: 140 }
    )
  );

  const nFindCancel = airtableNode({
    name: 'Airtable: Find for Cancel',
    x: 360,
    y: 480,
    params: {
      base: { '__rl': true, mode: 'list', value: 'appXXXXXXXXXXXXXX' },
      table: { '__rl': true, mode: 'list', value: 'tblXXXXXXXXXXXXXX' },
      operation: 'search',
      filterByFormula: '={Phone Number} = ("{{ $json.payload.customer_number }}")',
      options: { fields: ['eventId', 'Email', 'Name', 'starttime'] },
    },
  });
  nodes.push(nFindCancel);

  const nDelete = gcalNode({
    name: 'Delete Event (GCal)',
    x: 580,
    y: 480,
    params: {
      operation: 'delete',
      eventId: '={{ $json.eventId }}',
      calendar: { '__rl': true, mode: 'list', value: 'your-calendar@example.com' },
      options: { sendUpdates: 'all' },
    },
  });
  nodes.push(nDelete);

  const nAirCancel = airtableNode({
    name: 'Airtable: Mark Canceled',
    x: 800,
    y: 480,
    params: {
      base: { '__rl': true, mode: 'list', value: 'appXXXXXXXXXXXXXX' },
      table: { '__rl': true, mode: 'list', value: 'tblXXXXXXXXXXXXXX' },
      operation: 'update',
      columns: {
        value: {
          eventId: '={{ $json.eventId }}',
          'Booking Status': 'Canceled',
        },
        mappingMode: 'defineBelow',
        matchingColumns: ['eventId'],
      },
    },
  });
  nodes.push(nAirCancel);

  const nBuildSuccess3 = setNode({
    name: 'Build Success Payload (Cancel)',
    x: 1020,
    y: 480,
    assignments: [
      { id: 'sc1', name: 'status', type: 'string', value: '=ok' },
      { id: 'sc2', name: 'message', type: 'string', value: '=Appointment canceled.' },
    ],
  });
  nodes.push(nBuildSuccess3);

  // Channel responders (gates + respond)
  const gateExpr = (want) => ({
    combinator: 'and',
    options: { version: 2 },
    conditions: [
      {
        id: 'cg1',
        operator: { type: 'string', operation: 'equals' },
        leftValue: '={{ $json.selected_channel }}',
        rightValue: want,
      },
    ],
  });

  const nGateWhatsApp = ifNode({
    name: 'Gate: Only WhatsApp',
    x: 1240,
    y: 140,
    conditions: gateExpr('whatsapp'),
  });
  nodes.push(nGateWhatsApp);

  const nGateVoice = ifNode({
    name: 'Gate: Only Voice',
    x: 1240,
    y: 220,
    conditions: gateExpr('voice'),
  });
  nodes.push(nGateVoice);

  const nGateWeb = ifNode({
    name: 'Gate: Only Web',
    x: 1240,
    y: 300,
    conditions: gateExpr('web'),
  });
  nodes.push(nGateWeb);

  const nWA = whatsappSendNode({ name: 'WhatsApp • Send', x: 1460, y: 140 });
  nodes.push(nWA);

  const nVoice = respondNode({
    name: 'Voice (Vapi) • Tool Response',
    x: 1460,
    y: 220,
    bodyExpr:
      '={ "results":[{ "toolCallId": "{{ $json.toolCallId || \\"voice-tool\\" }}", "result": "{{ $json.message }}{{ $json.alternatives ? \' \' + $json.alternatives.map(a => a.start).join(\', \') : \'\' }}" }] }',
  });
  nodes.push(nVoice);

  const nWeb = respondNode({
    name: 'Web • HTTP Response',
    x: 1460,
    y: 300,
    bodyExpr:
      '={{ { status: $json.status, message: $json.message, alternatives: $json.alternatives || [] } }}',
  });
  nodes.push(nWeb);

  // CONNECTIONS
  const connections = {};

  function link(fromName, toName) {
    const from = nodes.find((n) => n.name === fromName);
    const to = nodes.find((n) => n.name === toName);
    if (!from || !to) return;
    connections[fromName] = connections[fromName] || { main: [[]] };
    connections[fromName].main[0].push({ node: toName, type: 'main', index: 0 });
  }

  // Flow wiring
  link('Universal Trigger (UI/Server)', 'Normalize & Defaults');
  link('Normalize & Defaults', 'Switch: Intent (book/update/cancel)');

  // Each intent first → Contact collector
  link('Switch: Intent (book/update/cancel)', 'Collector: Contact Info');

  // Book branch
  link('Collector: Contact Info', 'Collector: Time Window');
  link('Collector: Time Window', 'Check Availability (GCal)');
  link('Check Availability (GCal)', 'Freebusy → Available?');
  link('Freebusy → Available?', 'If available == true');
  link('If available == true', 'Create Event (GCal)'); // true
  link('Create Event (GCal)', 'Airtable: Log Booking');
  link('Airtable: Log Booking', 'Build Success Payload');

  // not-available path:
  // In n8n, IF node sends "true" to output 0 and "false" to output 1.
  // We already wired true path above. For the false path we emulate by linking again (editor merges).
  // When importing, you can re-attach to output 1 visually if desired.
  link('If available == true', 'Build Alternatives (next 5 slots)');
  link('Build Alternatives (next 5 slots)', 'Build Alternatives Payload');

  // Update branch
  link('Collector: Contact Info', 'Collector: Reschedule Window');
  link('Collector: Reschedule Window', 'Airtable: Find Event by Phone');
  link('Airtable: Find Event by Phone', 'Set eventId from Airtable');
  link('Set eventId from Airtable', 'Update Event (GCal)');
  link('Update Event (GCal)', 'Airtable: Update Row');
  link('Airtable: Update Row', 'Build Success Payload (Update)');

  // Cancel branch
  link('Collector: Contact Info', 'Collector: Cancel Info');
  link('Collector: Cancel Info', 'Airtable: Find for Cancel');
  link('Airtable: Find for Cancel', 'Delete Event (GCal)');
  link('Delete Event (GCal)', 'Airtable: Mark Canceled');
  link('Airtable: Mark Canceled', 'Build Success Payload (Cancel)');

  // Responder gates: success/alt payloads feed gates, then responders
  link('Build Success Payload', 'Gate: Only WhatsApp');
  link('Build Success Payload', 'Gate: Only Voice');
  link('Build Success Payload', 'Gate: Only Web');
  link('Build Alternatives Payload', 'Gate: Only WhatsApp');
  link('Build Alternatives Payload', 'Gate: Only Voice');
  link('Build Alternatives Payload', 'Gate: Only Web');

  link('Gate: Only WhatsApp', 'WhatsApp • Send');
  link('Gate: Only Voice', 'Voice (Vapi) • Tool Response');
  link('Gate: Only Web', 'Web • HTTP Response');

  // Return assembled workflow
  return {
    id: 'UniChannel-Collectors-Template',
    name: 'Universal Channel Appointments (Collectors First)',
    meta: { instanceId: 'autogen' },
    nodes,
    connections,
    active: false,
    pinData: {},
    settings: {},
    versionId: 'v1',
  };
}

/* --------------------------- PROPOSAL SCENARIO (presentation style) --------------------------- */

function buildProposalWorkflow(selectedChannel) {
  // This mirrors the “Voice2Propal” style: WhatsApp Trigger/Transcribe/Agent/Render/Send
  // but collapses to one selected channel (e.g., whatsapp). For other channels we return a webhook JSON.
  const nodes = [];

  nodes.push(
    sticky(
      `## Voice2Propal – Presentation Build
**Channel:** ${selectedChannel}

Part 1: Intake (voice or text)
Part 2: AI Pack Selection (Airtable)
Part 3: PDF Generation & Delivery`,
      { x: -680, y: -120, color: 6, w: 1200, h: 200 }
    )
  );

  const nTrigger = webhookNode({
    name: 'UI/Server Trigger (Proposal)',
    pathSuffix: 'proposal',
    x: -640,
    y: 120,
    respond: true,
  });
  nodes.push(nTrigger);

  const nNormalize = setNode({
    name: 'Normalize Payload',
    x: -420,
    y: 120,
    assignments: [
      { id: 'c1', name: 'selected_channel', type: 'string', value: `=${JSON.stringify(selectedChannel)}` },
      { id: 't1', name: 'text', type: 'string', value: "={{ $json.text || '' }}" },
      { id: 'v1', name: 'voice_url', type: 'string', value: "={{ $json.voice_url || '' }}" },
      { id: 'p1', name: 'phone', type: 'string', value: "={{ $json.phone || '' }}" },
    ],
  });
  nodes.push(nNormalize);

  // Simple "text vs voice" gate (if you want to keep parity with WA flow)
  const nIfVoice = ifNode({
    name: 'If voice_url exists',
    x: -200,
    y: 120,
    conditions: {
      combinator: 'and',
      options: { version: 2 },
      conditions: [
        {
          id: 'v',
          operator: { type: 'string', operation: 'notEmpty' },
          leftValue: '={{ $json.voice_url }}',
          rightValue: '',
        },
      ],
    },
  });
  nodes.push(nIfVoice);

  // (Placeholders) Download + Transcribe
  const nDownload = codeNode({
    name: 'HTTP Download (placeholder)',
    x: 20,
    y: 60,
    js: `return { json: { ...$json, audio: $json.voice_url, transcript: $json.text || 'Transcribed text placeholder' } };`,
  });
  nodes.push(nDownload);

  const nUseText = setNode({
    name: 'Use Provided Text',
    x: 20,
    y: 180,
    assignments: [
      { id: 't2', name: 'transcript', type: 'string', value: '={{ $json.text }}' },
    ],
  });
  nodes.push(nUseText);

  // Agent output (JSON contract)
  const nAgent = codeNode({
    name: 'Agent (pack selection mock)',
    x: 240,
    y: 120,
    js: `
const now = new Date().toISOString().slice(0,10);
const out = {
  date_actuel: now,
  nom_entreprise: "Company Name [sample]",
  nom: "First Last [sample]",
  date: now,
  situation_lead: "Brief need based on transcript",
  pack_nom: "Pack FULL SYSTEM™",
  pack_objectif: "Scale operations with automation",
  pack_services: "- Service A\\n- Service B\\n- Service C",
  duree_estimee: "2 to 4 weeks",
  prix: "€4,200 HT",
  lien_reservation: "https://your-booking-link.com"
};
return { json: { ...$json, output: out } };
`.trim(),
  });
  nodes.push(nAgent);

  // Render PDF (placeholder node to keep presentation style)
  const nRender = codeNode({
    name: 'Render PDF (placeholder)',
    x: 460,
    y: 120,
    js: `
return { json: { ...$json, download_url: "https://example.com/proposal.pdf" } };
`.trim(),
  });
  nodes.push(nRender);

  // Channel respond
  const nGateWA = ifNode({
    name: 'Gate: Only WhatsApp',
    x: 680,
    y: 80,
    conditions: {
      combinator: 'and',
      options: { version: 2 },
      conditions: [
        {
          id: 'gw',
          operator: { type: 'string', operation: 'equals' },
          leftValue: '={{ $json.selected_channel }}',
          rightValue: 'whatsapp',
        },
      ],
    },
  });
  nodes.push(nGateWA);

  const nGateVoice = ifNode({
    name: 'Gate: Only Voice',
    x: 680,
    y: 120,
    conditions: {
      combinator: 'and',
      options: { version: 2 },
      conditions: [
        {
          id: 'gv',
          operator: { type: 'string', operation: 'equals' },
          leftValue: '={{ $json.selected_channel }}',
          rightValue: 'voice',
        },
      ],
    },
  });
  nodes.push(nGateVoice);

  const nGateWeb = ifNode({
    name: 'Gate: Only Web',
    x: 680,
    y: 160,
    conditions: {
      combinator: 'and',
      options: { version: 2 },
      conditions: [
        {
          id: 'gweb',
          operator: { type: 'string', operation: 'equals' },
          leftValue: '={{ $json.selected_channel }}',
          rightValue: 'web',
        },
      ],
    },
  });
  nodes.push(nGateWeb);

  const nWA = whatsappSendNode({ name: 'WhatsApp • Send (proposal)', x: 900, y: 80 });
  nodes.push(nWA);

  const nVoiceRespond = respondNode({
    name: 'Voice (Vapi) • Tool Response (proposal)',
    x: 900,
    y: 120,
    bodyExpr:
      '={ "results":[{ "toolCallId": "{{ $json.toolCallId || \\"voice-tool\\" }}", "result": "Proposal ready. {{ $json.download_url }}" }] }',
  });
  nodes.push(nVoiceRespond);

  const nWebRespond = respondNode({
    name: 'Web • HTTP Response (proposal)',
    x: 900,
    y: 160,
    bodyExpr: '={{ { status: "ok", download_url: $json.download_url } }}',
  });
  nodes.push(nWebRespond);

  // Connections
  const connections = {};
  function link(fromName, toName) {
    const from = nodes.find((n) => n.name === fromName);
    const to = nodes.find((n) => n.name === toName);
    if (!from || !to) return;
    connections[fromName] = connections[fromName] || { main: [[]] };
    connections[fromName].main[0].push({ node: toName, type: 'main', index: 0 });
  }

  link('UI/Server Trigger (Proposal)', 'Normalize Payload');
  link('Normalize Payload', 'If voice_url exists');
  link('If voice_url exists', 'HTTP Download (placeholder)'); // true
  link('If voice_url exists', 'Use Provided Text'); // false
  link('HTTP Download (placeholder)', 'Agent (pack selection mock)');
  link('Use Provided Text', 'Agent (pack selection mock)');
  link('Agent (pack selection mock)', 'Render PDF (placeholder)');

  link('Render PDF (placeholder)', 'Gate: Only WhatsApp');
  link('Render PDF (placeholder)', 'Gate: Only Voice');
  link('Render PDF (placeholder)', 'Gate: Only Web');

  link('Gate: Only WhatsApp', 'WhatsApp • Send (proposal)');
  link('Gate: Only Voice', 'Voice (Vapi) • Tool Response (proposal)');
  link('Gate: Only Web', 'Web • HTTP Response (proposal)');

  return {
    id: 'Voice2Propal-Presentation',
    meta: { instanceId: 'autogen' },
    name: 'Voice2Propal – Presentation Build (Single Channel)',
    nodes,
    connections,
    active: false,
    pinData: {},
    settings: {},
    versionId: 'v1',
  };
}

/* --------------------------- SCENARIO REGISTRY --------------------------- */

const SCENARIO_BUILDERS = {
  appointments: buildAppointmentsWorkflow,
  proposal: buildProposalWorkflow,
  // add more scenarios here: 'support': buildSupportWorkflow, etc.
};

/* --------------------------- BUILD ALL REQUESTED --------------------------- */

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function build() {
  const outDir = path.resolve(process.cwd(), 'dist');
  ensureDir(outDir);

  for (const s of SCENARIOS) {
    const fn = SCENARIO_BUILDERS[s];
    if (!fn) {
      console.warn(`[build] Unknown scenario "${s}" — skipping.`);
      continue;
    }
    const json = fn(CHANNEL);
    const file = path.join(outDir, `${s}-${CHANNEL}.json`);
    fs.writeFileSync(file, JSON.stringify(json, null, 2), 'utf8');
    console.log(`[build] Wrote ${file}`);
  }
}

build();
