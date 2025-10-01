// public/builder.js
// AI-Team Scenario Builder for n8n (core nodes only).
// Function v1 style I/O (items[0].json). Demo/Prod + per-agent chain. LLM optional via httpRequest v4.

(function () {
  'use strict';

  // ------------ Helpers ------------
  function safe(v){ return (v===null||v===undefined)?'':String(v); }
  function slug(txt,n){ var s=safe(txt).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,''); if(n>0) s=s.slice(0,n); return s||'scenario'; }
  function addNode(wf,node){ wf.nodes.push(node); return node.name; }
  function connect(wf,fromName,toName,outIdx){
    var idx = typeof outIdx==='number'?outIdx:0;
    if(!wf.connections[fromName]) wf.connections[fromName]={};
    if(!wf.connections[fromName].main) wf.connections[fromName].main=[];
    while(wf.connections[fromName].main.length<=idx) wf.connections[fromName].main.push([]);
    wf.connections[fromName].main[idx].push({ node:toName, type:'main', index:0 });
  }

  // ------------ Node factories ------------
  function nManual(x,y){ return { id:'n_'+Math.random().toString(36).slice(2,10), name:'Manual Trigger', type:'n8n-nodes-base.manualTrigger', typeVersion:1, position:[x,y], parameters:{} }; }
  function nSet(name, fields, x, y){
    var stringVals=[]; for(var k in (fields||{})) if(Object.prototype.hasOwnProperty.call(fields,k)){ stringVals.push({name:k,value:safe(fields[k])}); }
    return { id:'n_'+Math.random().toString(36).slice(2,10), name:name, type:'n8n-nodes-base.set', typeVersion:1, position:[x,y],
      parameters:{ keepOnlySet:false, values:{ string:stringVals } } };
  }
  function nFunction(name, code, x, y){ return { id:'n_'+Math.random().toString(36).slice(2,10), name:name, type:'n8n-nodes-base.function', typeVersion:1, position:[x,y], parameters:{ functionCode:code } }; }
  function nIf(name, condBool, x, y){ return { id:'n_'+Math.random().toString(36).slice(2,10), name:name, type:'n8n-nodes-base.if', typeVersion:1, position:[x,y],
    parameters:{ conditions:{ boolean:[{ value1: condBool===true, value2:true }] } } }; }
  function nHttp(name,x,y,urlExpr,methodExpr,bodyExpr,headersExpr){
    return { id:'n_'+Math.random().toString(36).slice(2,10), name:name, type:'n8n-nodes-base.httpRequest', typeVersion:4, position:[x,y],
      parameters:{
        url: urlExpr || '={{$json.__http.url}}',
        method: methodExpr || '={{$json.__http.method}}',
        sendBody: true,
        jsonParameters: true,
        bodyParametersJson: bodyExpr || '={{$json.__http.body}}',
        headerParametersJson: headersExpr || '={{$json.__http.headers}}',
        options: { fullResponse:false }
      } };
  }

  // ------------ Function v1 code (TEAM AGENTS) ------------

  // Context Agent — read scenario fields → ContextSpec
  var FC_CONTEXT =
"var json=(items[0]&&items[0].json)||{};\n"+
"var scen={ id:json['scenario.id']||'', name:json['scenario.name']||'', industry:json['industry.id']||'',\n"+
"  triggers:json['scenario.triggers']||'', best:json['scenario.best_reply_shapes']||'',\n"+
"  risk:json['scenario.risk_notes']||'', roi:json['scenario.roi_hypothesis']||'', tags:(json['scenario.tags']||'').split(',').filter(function(t){return t;}) };\n"+
"var ch=['whatsapp','sms','email','call'];\n"+
"if(/email/i.test(scen.best)) ch=['email','whatsapp','sms','call'];\n"+
"if(/wa|whatsapp/i.test(scen.best)) ch=['whatsapp','sms','email','call'];\n"+
"json.ContextSpec={ intent: scen.roi?('Goal: '+scen.roi):('Automate: '+(scen.name||scen.id)), industry_pack:[scen.industry||'generic'].concat(scen.tags.slice(0,2)),\n"+
"  guardrails:['no PHI','respect opt-out','tone: professional/friendly'], channels_ranked:ch,\n"+
"  entities:['user','appointment','location','agent'], kpis:['reschedule_rate','time_to_reschedule','no_show_rate'] };\n"+
"if(!Array.isArray(json.history)) json.history=[];\n"+
"return [{ json: json }];";

  // Planner Agent — draw YES/NO plan (3 steps each)
  var FC_PLANNER =
"var json=(items[0]&&items[0].json)||{}; var ctx=json.ContextSpec||{}; var waFirst=(ctx.channels_ranked&&ctx.channels_ranked[0]==='whatsapp');\n"+
"var yes=[ {id:'s1',type:'send_message',channel:waFirst?'whatsapp':'sms',tool:'TWILIO',params:{body_tmpl:'confirm'}},\n"+
"          {id:'s2',type:'check_data',channel:'none',tool:'',params:{field:'confirm_received'}},\n"+
"          {id:'s3',type:'wait',channel:'none',tool:'',params:{seconds:1}} ];\n"+
"var no=[  {id:'s1',type:'send_message',channel:waFirst?'whatsapp':'sms',tool:'TWILIO',params:{body_tmpl:'offer_slots'}},\n"+
"          {id:'s2',type:'check_data',channel:'none',tool:'',params:{field:'slot_choice'}},\n"+
"          {id:'s3',type:'http',channel:'none',tool:'CALENDAR',params:{method:'POST',body:{}}} ];\n"+
"json.PlanGraph={ trigger:{kind:'manual'}, branches:[ {key:'yes',title:'Has upcoming appointment',steps:yes}, {key:'no',title:'Needs reschedule',steps:no} ] };\n"+
"return [{ json: json }];";

  // Toolsmith Agent — resolve abstract tools → base URLs, headers
  var FC_TOOLSMITH =
"var json=(items[0]&&items[0].json)||{}; json.ToolMap={\n"+
"  TWILIO:function(j){ return { url:(j.twilio_base||'')+'/messages', method:'POST', headers:{'Content-Type':'application/json'} } },\n"+
"  CALENDAR:function(j){ return { url:(j.calendar_base||'')+'/book',   method:'POST', headers:{'Content-Type':'application/json'} } },\n"+
"  CRM:function(j){ return { url:(j.crm_base||'')+'/records',          method:'POST', headers:{'Content-Type':'application/json'} } }\n"+
"}; return [{ json: json }];";

  // Policy Agent — tone/opt-out/compliance flags
  var FC_POLICY =
"var json=(items[0]&&items[0].json)||{}; var g=(json.ContextSpec&&json.ContextSpec.guardrails)||[];\n"+
"json.Policy={ tone: (g.join('|').indexOf('friendly')>-1)?'friendly-professional':'neutral', optout:'Reply STOP to opt out.', pii:'no PHI' };\n"+
"return [{ json: json }];";

  // Router (YES by default; make data-driven later if you want)
  var FC_PICK_BRANCH =
"var json=(items[0]&&items[0].json)||{}; var pg=json.PlanGraph||{branches:[]};\n"+
"var yes=(pg.branches||[]).filter(function(b){return b&&b.key==='yes';})[0]||{steps:[]};\n"+
"var no =(pg.branches||[]).filter(function(b){return b&&b.key==='no'; })[0]||{steps:[]};\n"+
"json.yesBranch=yes; json.noBranch=no; json.routeYes=true; return [{ json: json }];";

  // Step Draft (per branch)
  function FC_STEP_DRAFT(i,label,branch){
    return ""
+"var json=(items[0]&&items[0].json)||{};\n"
+"var branch=(json."+ (branch==='yes'?'yesBranch':'noBranch') +"||{steps:[]});\n"
+"var s=(branch.steps||[])["+ (i-1) +"]||{id:'s"+i+"',type:'send_message',channel:'whatsapp',tool:'TWILIO',params:{body_tmpl:'generic'}};\n"
+"json.Action={ id:s.id||'s"+i+"', title:'"+label.replace(/'/g,"\\'")+"', type:s.type||'send_message', channel:s.channel||'none', tool:s.tool||'', params:(typeof s.params==='object'&&s.params)||{} };\n"
+"return [{ json: json }];";
  }

  // Copywriter Agent — build conversational message (LLM optional)
  var FC_BUILD_PROMPT =
"var json=(items[0]&&items[0].json)||{}; var a=json.Action||{}; var ctx=json.ContextSpec||{}; var pol=json.Policy||{};\n"+
"var scen={ id:json['scenario.id']||'', name:json['scenario.name']||'', industry:json['industry.id']||'' };\n"+
"json.__llm_req={ system:'You are a senior CX copywriter. Return strict JSON {\"message\":\"...\"}. No preface. Human, concise, natural.' ,\n"+
"  user:{ goal:ctx.intent||'', guardrails:ctx.guardrails||[], tone:pol.tone||'friendly', channel:a.channel||'whatsapp', template:(a.params&&a.params.body_tmpl)||'generic', scenario:scen, optout:pol.optout } };\n"+
"return [{ json: json }];";

  var FC_LLM_HTTP_PREP =
"var json=(items[0]&&items[0].json)||{}; var base=json.llm_base||'https://api.openai.com/v1'; var key=json.llm_api_key||''; var model=json.llm_model||'gpt-4o-mini'; var r=json.__llm_req||{system:'',user:{}};\n"+
"json.__http={ url: base+'/chat/completions', method:'POST', headers: key?{'Authorization':'Bearer '+key,'Content-Type':'application/json'}:{'Content-Type':'application/json'},\n"+
"  body:{ model:model, messages:[ {role:'system',content:r.system||''},{role:'user',content:JSON.stringify(r.user||{})} ], response_format:{type:'json_object'}, temperature:0.2 } };\n"+
"return [{ json: json }];";

  var FC_LLM_PARSE =
"function S(v){ return (v===null||v===undefined)?'':String(v); }\n"+
"var json=(items[0]&&items[0].json)||{}; var body=json.data||items[0].json.data||items[0].json||{};\n"+
"var content=''; try{ content=body.choices&&body.choices[0]&&body.choices[0].message&&body.choices[0].message.content||''; }catch(e){ content=''; }\n"+
"var msg=''; try{ var obj=JSON.parse(content); msg=S(obj.message||''); }catch(e){ msg=''; }\n"+
"if(!json.Outbox) json.Outbox={}; if(!json.Outbox.text) json.Outbox.text=''; if(msg) json.Outbox.text=msg; return [{ json: json }];";

  // Rules fallback (if LLM disabled)
  var FC_COPYWRITER_RULES =
"var json=(items[0]&&items[0].json)||{}; var a=json.Action||{}; var pol=json.Policy||{}; var txt='';\n"+
"if(a.type==='send_message'){\n"+
"  if(a.params&&a.params.body_tmpl==='confirm') txt='Quick check: can you confirm your appointment? Just reply yes if it still works for you.';\n"+
"  else if(a.params&&a.params.body_tmpl==='offer_slots'){ var s=json.demo_slots||['09:30','12:00','16:00']; txt='Which time suits you best: '+s.join(', ')+' ?'; }\n"+
"  else txt='Hi there — happy to help. What works for you?';\n"+
"}\n"+
"json.Outbox={ text: txt+(pol.optout?(' '+pol.optout):'') };\n"+
"return [{ json: json }];";

  // QA Agent — minimal safety/length/tone patches
  var FC_QA =
"var json=(items[0]&&items[0].json)||{}; var t=(json.Outbox&&json.Outbox.text)||''; if(t.length>500) t=t.slice(0,480)+'…';\n"+
"t=t.replace(/\\s+/g,' ').trim(); json.Outbox={ text:t }; return [{ json: json }];";

  // Validate Action
  var FC_VALIDATE_ACTION =
"var json=(items[0]&&items[0].json)||{}; var a=json.Action||{}; if(typeof a!=='object') a={}; if(!a.id) a.id='s'; if(!a.title) a.title='Step';\n"+
"if(!a.type) a.type='send_message'; if(!a.channel) a.channel='none'; if(!a.tool) a.tool=''; if(!a.params||typeof a.params!=='object') a.params={}; json.Action=a; return [{ json: json }];";

  // Tool HTTP prep (use ToolMap + mode)
  var FC_TOOL_HTTP_PREP =
"var json=(items[0]&&items[0].json)||{}; var a=json.Action||{}; var mode=json.mode||'demo'; var map=json.ToolMap||{}; var r={url:'',method:'POST',headers:{'Content-Type':'application/json'},body:{}};\n"+
"if(mode==='prod'){\n"+
"  var t=String(a.tool||'').toUpperCase(); if(map[t]){ var m=map[t](json); r.url=m.url||''; r.method=m.method||'POST'; r.headers=m.headers||{'Content-Type':'application/json'}; }\n"+
"  if(t==='TWILIO'){ r.body={ to:json['demo.to']||'', from:(a.channel==='whatsapp'?json['demo.waFrom']:json['demo.smsFrom'])||'', channel:a.channel, text:(json.Outbox&&json.Outbox.text)||'' }; }\n"+
"  else if(t==='CALENDAR'){ r.body=a.params&&a.params.body?a.params.body:{ slot: json.slot_choice||'' }; }\n"+
"  else if(t==='CRM'){ r.body={ scenario:json['scenario.id']||'', event:a.title, payload:a.params||{} }; }\n"+
"  else if(!map[t]){ r.url=(a.params&&a.params.url)||''; r.method=(a.params&&a.params.method)||'POST'; r.body=(a.params&&a.params.body)||{}; }\n"+
"}\n"+
"json.__http=r; return [{ json: json }];";

  // Runner (demo simulate; prod lets httpRequest do side effects)
  var FC_RUNNER =
"function wait(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }\n"+
"var json=(items[0]&&items[0].json)||{}; var a=json.Action||{}; var mode=json.mode||'demo';\n"+
"async function exec(){ var t=String(a.type||'').toLowerCase(); if(mode==='prod'&&(t==='send_message'||t==='http')) return { ok:true,deferred_http:true };\n"+
" if(t==='send_message') return { ok:true,simulated:true,sent:{channel:a.channel,text:(json.Outbox&&json.Outbox.text)||''} };\n"+
" if(t==='check_data')  return { ok:true,check:a.params||{} };\n"+
" if(t==='wait'){ await wait((a.params&&a.params.seconds?a.params.seconds:1)*200); return { ok:true,waited:a.params?a.params.seconds||1:1 }; }\n"+
" if(t==='http')        return { ok:true,simulated:true,request:json.__http||{} };\n"+
" return { ok:true,noop:true }; }\n"+
"return exec().then(function(r){ json.exec=r; return [{ json: json }]; });";

  // Recorder
  function FC_REC(label){
    var L=label.replace(/'/g,"\\'");
    return ""
+"var json=(items[0]&&items[0].json)||{}; var h=Array.isArray(json.history)?json.history:[];\n"
+"h.push({ ts:Date.now(), step:'"+L+"', action:json.Action, outbox:(json.Outbox&&json.Outbox.text)||'', result:json.exec }); json.history=h; return [{ json: json }];";
  }

  // ------------ Builder ------------
  function buildWorkflowJSON(scenario, industry){
    var scenId  = safe(scenario&&scenario.scenario_id);
    var scenNm  = safe(scenario&&scenario.name);
    var scenTag = (scenId?scenId+' ':'')+slug(scenNm,24);
    var title   = (scenId||'Scenario')+' — '+(scenNm||'');

    var wf={ name:title.replace(/\s+—\s+$/,'').replace(/^—\s+/,'' )||'Scenario', nodes:[], connections:{}, active:false,
      settings:{ executionOrder:'v1', timezone:'Europe/Madrid' }, staticData:{}, tags:[], pinData:{} };

    // Layout
    var X0=-860, Y0=240, SPAN=280, GAP=220;

    // Trigger + Init (flags, tool bases, demo seeds, LLM config)
    var n0=nManual(X0,Y0); addNode(wf,n0);
    var n1=nSet('Init',{
      'scenario.id':scenId, 'scenario.name':scenNm, 'industry.id':safe(industry&&industry.industry_id),
      'scenario.triggers':safe(scenario&&scenario.triggers),
      'scenario.best_reply_shapes':safe(scenario&&scenario.best_reply_shapes),
      'scenario.risk_notes':safe(scenario&&scenario.risk_notes),
      'scenario.roi_hypothesis':safe(scenario&&scenario.roi_hypothesis),
      'scenario.tags': Array.isArray(scenario&&scenario.tags)?scenario.tags.join(','):safe(scenario&&scenario.tags),

      // Modes
      'mode':'demo',               // switch to 'prod' to hit real tools
      'llm.enabled':'false',       // 'true' to enable LLM copywriter
      'llm_base':'https://api.openai.com/v1',
      'llm_model':'gpt-4o-mini',
      'llm_api_key':'',

      // Tool bases (prod)
      'twilio_base':'https://api.twilio.com',
      'calendar_base':'https://calendar.example.com',
      'crm_base':'https://crm.example.com',

      // Demo seeds
      'demo.to':'+34613030526',
      'demo.emailTo':'kevanm.spain@gmail.com',
      'demo.waFrom':'+14155238886',
      'demo.smsFrom':'+13412184164',
      'demo.callFrom':'+13412184164'
    }, X0+SPAN, Y0); addNode(wf,n1); connect(wf,n0.name,n1.name);

    // Team: Context → Planner → Toolsmith → Policy → Router
    var n2=nFunction('Context Agent ['+scenTag+']', FC_CONTEXT, X0+SPAN*2, Y0); addNode(wf,n2); connect(wf,n1.name,n2.name);
    var n3=nFunction('Planner Agent ['+scenTag+']',  FC_PLANNER, X0+SPAN*3, Y0); addNode(wf,n3); connect(wf,n2.name,n3.name);
    var n3b=nFunction('Toolsmith Agent ['+scenTag+']', FC_TOOLSMITH, X0+SPAN*4, Y0); addNode(wf,n3b); connect(wf,n3.name,n3b.name);
    var n3c=nFunction('Policy Agent ['+scenTag+']', FC_POLICY, X0+SPAN*5, Y0); addNode(wf,n3c); connect(wf,n3b.name,n3c.name);
    var n4=nFunction('Pick Branch ['+scenTag+']',   FC_PICK_BRANCH, X0+SPAN*6, Y0); addNode(wf,n4); connect(wf,n3c.name,n4.name);

    var n5=nIf('Route Branch ['+scenTag+']', true, X0+SPAN*7, Y0); addNode(wf,n5); connect(wf,n4.name,n5.name);

    // Helper to add a step micro-team
    function addStepTeam(prefix, baseX, yRow, stepIdx, draftTitle){
      // Draft
      var sDraft=nFunction(prefix+' Step '+stepIdx+' Draft ['+scenTag+']', FC_STEP_DRAFT(stepIdx,draftTitle,(prefix==='YES'?'yes':'no')), baseX, yRow); addNode(wf,sDraft);

      // Copywriter: build prompt
      var bPrompt=nFunction(prefix+' Step '+stepIdx+' Copywriter Prompt ['+scenTag+']', FC_BUILD_PROMPT, baseX+SPAN, yRow); addNode(wf,bPrompt);
      connect(wf,sDraft.name,bPrompt.name);

      // If LLM?
      var ifLLM=nIf(prefix+' Step '+stepIdx+' Use LLM? ['+scenTag+']', false, baseX+SPAN*2, yRow); addNode(wf,ifLLM);
      connect(wf,bPrompt.name, ifLLM.name);

      // LLM path
      var prepLLM=nFunction(prefix+' Step '+stepIdx+' LLM HTTP Prep ['+scenTag+']', FC_LLM_HTTP_PREP, baseX+SPAN*3, yRow); addNode(wf,prepLLM);
      connect(wf, ifLLM.name, prepLLM.name, 0);
      var callLLM=nHttp(prefix+' Step '+stepIdx+' LLM HTTP', baseX+SPAN*4, yRow); addNode(wf,callLLM);
      connect(wf, prepLLM.name, callLLM.name);
      var parseLLM=nFunction(prefix+' Step '+stepIdx+' LLM Parse ['+scenTag+']', FC_LLM_PARSE, baseX+SPAN*5, yRow); addNode(wf,parseLLM);
      connect(wf, callLLM.name, parseLLM.name);

      // Rules path
      var rules=nFunction(prefix+' Step '+stepIdx+' Copywriter Rules ['+scenTag+']', FC_COPYWRITER_RULES, baseX+SPAN*3, yRow+120); addNode(wf,rules);
      connect(wf, ifLLM.name, rules.name, 1);

      // QA Agent
      var qa=nFunction(prefix+' Step '+stepIdx+' QA Agent ['+scenTag+']', FC_QA, baseX+SPAN*6, yRow); addNode(wf,qa);
      connect(wf, parseLLM.name, qa.name);
      connect(wf, rules.name,    qa.name);

      // Validate
      var val=nFunction(prefix+' Step '+stepIdx+' Validate Action ['+scenTag+']', FC_VALIDATE_ACTION, baseX+SPAN*7, yRow); addNode(wf,val);
      connect(wf, qa.name, val.name);

      // Tool HTTP Prep
      var prepTool=nFunction(prefix+' Step '+stepIdx+' Tool HTTP Prep ['+scenTag+']', FC_TOOL_HTTP_PREP, baseX+SPAN*8, yRow); addNode(wf,prepTool);
      connect(wf, val.name, prepTool.name);

      // Runner
      var run=nFunction(prefix+' Step '+stepIdx+' Run ['+scenTag+']', FC_RUNNER, baseX+SPAN*9, yRow); addNode(wf,run);
      connect(wf, prepTool.name, run.name);

      // HTTP execute (only matters in prod)
      var httpExec=nHttp(prefix+' Step '+stepIdx+' Execute HTTP', baseX+SPAN*10, yRow); addNode(wf,httpExec);
      connect(wf, run.name, httpExec.name);

      // Record
      var rec=nFunction(prefix+' Step '+stepIdx+' Record ['+scenTag+']', FC_REC(prefix+' Step '+stepIdx), baseX+SPAN*11, yRow); addNode(wf,rec);
      connect(wf, httpExec.name, rec.name);

      return rec.name;
    }

    // YES lane (top)
    var YES_Y=Y0+(-220);
    var enterYes=nFunction('Enter YES ['+scenTag+']',"var j=(items[0]&&items[0].json)||{}; j.branch='yes'; return [{ json:j }];", X0+SPAN*8, YES_Y); addNode(wf, enterYes); connect(wf, n5.name, enterYes, 0);
    var yes1=addStepTeam('YES', X0+SPAN*9,  YES_Y, 1, 'Confirm appointment'); connect(wf, enterYes, yes1);
    var yes2=addStepTeam('YES', X0+SPAN*15, YES_Y, 2, 'Check confirmation');  connect(wf, yes1, yes2);
    var yes3=addStepTeam('YES', X0+SPAN*21, YES_Y, 3, 'Gentle wait');         connect(wf, yes2, yes3);

    // NO lane (bottom)
    var NO_Y=Y0+220;
    var enterNo=nFunction('Enter NO ['+scenTag+']',"var j=(items[0]&&items[0].json)||{}; j.branch='no'; return [{ json:j }];", X0+SPAN*8, NO_Y); addNode(wf, enterNo); connect(wf, n5.name, enterNo, 1);
    var no1=addStepTeam('NO', X0+SPAN*9,  NO_Y, 1, 'Offer slots'); connect(wf, enterNo, no1);
    var no2=addStepTeam('NO', X0+SPAN*15, NO_Y, 2, 'Capture slot'); connect(wf, no1, no2);
    var no3=addStepTeam('NO', X0+SPAN*21, NO_Y, 3, 'Book calendar'); connect(wf, no2, no3);

    wf.staticData.__design={
      team:['Context Agent','Planner Agent','Toolsmith Agent','Policy Agent','Copywriter Agent (LLM/rules)','QA Agent','Runner','Recorder'],
      contracts:{ ContextSpec:'intent, channels_ranked, guardrails, ...', PlanGraph:'branches with steps', Action:'id,title,type,channel,tool,params' },
      flags:['mode demo|prod','llm.enabled true|false'],
      note:'All scenario strings are read from JSON, not embedded in code. Safe imports.'
    };
    return wf;
  }

  window.Builder={ buildWorkflowJSON: buildWorkflowJSON };
})();
