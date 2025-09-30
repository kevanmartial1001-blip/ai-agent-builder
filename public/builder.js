// public/builder.js
// Minimal, ultra-safe builder that always loads and imports.
// Nodes: Manual Trigger v1 + Set v1. No emojis, no custom nodes, no modern JS.

(function () {
  'use strict';

  function safe(v) {
    if (v === null || v === undefined) return '';
    return String(v);
  }

  function escSingleQuotes(s) {
    return safe(s).replace(/'/g, "\\'");
  }

  function buildWorkflowJSON(scenario, industry) {
    var titleLeft = safe(scenario && scenario.scenario_id ? scenario.scenario_id : 'Scenario');
    var titleRight = safe(scenario && scenario.name ? scenario.name : '');
    var title = (titleLeft + ' — ' + titleRight).replace(/\s+—\s+$/, '').replace(/^—\s+/, '');

    var wf = {
      name: title || 'Scenario',
      nodes: [],
      connections: {},
      active: false,
      settings: { executionOrder: 'v1', timezone: 'Europe/Madrid' },
      staticData: {},
      tags: [],
      pinData: {}
    };

    // Node 1: Manual Trigger (core, v1)
    var n1 = {
      id: 'n1',
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [-860, 240],
      parameters: {}
    };

    // Node 2: Init (core Set, v1)
    var n2 = {
      id: 'n2',
      name: 'Init',
      type: 'n8n-nodes-base.set',
      typeVersion: 1,
      position: [-580, 240],
      parameters: {
        keepOnlySet: false,
        values: {
          string: [
            { name: 'scenario.id',   value: "= {{ '" + escSingleQuotes(scenario && scenario.scenario_id) + "' }}" },
            { name: 'scenario.name', value: "= {{ '" + escSingleQuotes(scenario && scenario.name) + "' }}" },
            { name: 'industry.id',   value: "= {{ '" + escSingleQuotes(industry && industry.industry_id) + "' }}" }
          ]
        }
      }
    };

    wf.nodes.push(n1);
    wf.nodes.push(n2);

    // Connection: Manual Trigger -> Init
    wf.connections['Manual Trigger'] = {
      main: [
        [
          { node: 'Init', type: 'main', index: 0 }
        ]
      ]
    };

    return wf;
  }

  // Expose globally for your UI to call: Builder.buildWorkflowJSON(scenario, industry)
  window.Builder = { buildWorkflowJSON: buildWorkflowJSON };
})();
