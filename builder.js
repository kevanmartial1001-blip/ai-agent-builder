/* builder.js — n8n workflow generator (10 archetypes)
   Exposes: window.Builder.buildWorkflowJSON(scenario, industry) */

// ---------- tiny graph helpers ----------
function wfSkeleton(name){ return { name, nodes:[], connections:{}, active:false, settings:{}, staticData:null, pinData:{} }; }
function node(nodes, name, type, pos, params={}, extra={}){ nodes.push({ name, type, typeVersion:(/manualTrigger|wait$/.test(type)?1:2), position:pos, parameters:params, ...extra }); }
function link(conns, from, to){ conns[from] ||= { main:[[]] }; conns[from].main[0].push({ node:to, type:"main", index:0 }); }

// ---------- channel + config ----------
function cfgNode(channel){
  return {
    name:"Set Config",
    type:"n8n-nodes-base.function",
    typeVersion:2,
    position:[-1180,-20],
    parameters:{ functionCode:
`return [{ json: {
  demoMode: true,
  channel: "${channel}",
  // safety allowlists for your tests:
  allowedRecipients: ["kevanm.spain@gmail.com"],
  allowedPhones: ["+34XXXXXXXXX"],
  overrideTo: "kevanm.spain@gmail.com",
  overrideToPhone: "+34XXXXXXXXX",
  // Twilio sender defaults (you can change here once and all flows inherit):
  twilioFromSms: "+13412184164",
  twilioFromWhatsApp: "whatsapp:+14155238886",
  twilioFromVoice: "+13412184164",
  // Email sender:
  fromEmail: "kevanm.spain@gmail.com"
}}];` }
  };
}

function recommendedChannel(s){
  const shapes = Array.isArray(s.best_reply_shapes) ? s.best_reply_shapes : String(s.best_reply_shapes||'').split(/[;,/ ]+/);
  const t = shapes.join(' ').toLowerCase();
  if (/\bwhatsapp\b/.test(t)) return "whatsapp";
  if (/\bsms\b|\btext\b/.test(t)) return "sms";
  if (/\bcall\b|\bvoice\b/.test(t)) return "call";
  return "email";
}

function branchChannels(wf){
  node(wf.nodes,"Channel = Email?","n8n-nodes-base.if",[-520,-160],{conditions:{string:[{value1:"={{$items('Set Config',0,0).json.channel}}",operation:"equal",value2:"email"}]} );
  node(wf.nodes,"Channel = SMS?","n8n-nodes-base.if",[-520,-40], {conditions:{string:[{value1:"={{$items('Set Config',0,0).json.channel}}",operation:"equal",value2:"sms"}]} );
  node(wf.nodes,"Channel = WhatsApp?","n8n-nodes-base.if",[-520,80], {conditions:{string:[{value1:"={{$items('Set Config',0,0).json.channel}}",operation:"equal",value2:"whatsapp"}]} );
  node(wf.nodes,"Channel = Call?","n8n-nodes-base.if",[-520,200], {conditions:{string:[{value1:"={{$items('Set Config',0,0).json.channel}}",operation:"equal",value2:"call"}]} );

  link(wf.connections,"Compose Message","Channel = Email?");
  link(wf.connections,"Compose Message","Channel = SMS?");
  link(wf.connections,"Compose Message","Channel = WhatsApp?");
  link(wf.connections,"Compose Message","Channel = Call?");

  // EMAIL
  node(wf.nodes,"Email Allowlist","n8n-nodes-base.function",[-340,-240],{functionCode:"const cfg=$items('Set Config',0,0).json;const to=$json.to||'';return [{json:{ok:(cfg.allowedRecipients||[]).includes(to)}}];"});
  node(wf.nodes,"Email Allowed?","n8n-nodes-base.if",[-180,-240],{conditions:{boolean:[{value1:"={{$item(0).$node['Email Allowlist'].json.ok}}"}]} );
  node(wf.nodes,"Email Send","n8n-nodes-base.emailSend",[0,-240],{
    fromEmail:"={{$items('Set Config',0,0).json.fromEmail}}",
    toEmail:"={{$json['to']}}",
    subject:"={{$json['subject']}}",
    text:"={{$json['text']}}",
    options:{ senderName:"Agent" }
  },{ credentials:{ smtp:{ name:"SMTP account" } }});
  link(wf.connections,"Channel = Email?","Email Allowlist"); wf.connections["Channel = Email?"].main[1]=[];
  link(wf.connections,"Email Allowlist","Email Allowed?");
  link(wf.connections,"Email Allowed?","Email Send");

  // SMS
  node(wf.nodes,"Phone Allowlist","n8n-nodes-base.function",[-340,-40],{functionCode:"const cfg=$items('Set Config',0,0).json;const p=$json.toPhone||'';return [{json:{ok:(cfg.allowedPhones||[]).includes(p)}}];"});
  node(wf.nodes,"Phone Allowed?","n8n-nodes-base.if",[-180,-40],{conditions:{boolean:[{value1:"={{$item(0).$node['Phone Allowlist'].json.ok}}"}]} );
  node(wf.nodes,"Twilio SMS","n8n-nodes-base.twilio",[0,-40],{
    resource:"message",operation:"send",
    from:"={{$items('Set Config',0,0).json.twilioFromSms}}",
    to:"={{$json['toPhone']}}",
    message:"={{$json['text']}}"
  },{ disabled:true, credentials:{ twilioApi:{ name:"twilio-default" } }});
  link(wf.connections,"Channel = SMS?","Phone Allowlist"); wf.connections["Channel = SMS?"].main[1]=[];
  link(wf.connections,"Phone Allowlist","Phone Allowed?"); link(wf.connections,"Phone Allowed?","Twilio SMS");

  // WHATSAPP
  node(wf.nodes,"WA Allowlist","n8n-nodes-base.function",[-340,80],{functionCode:"const cfg=$items('Set Config',0,0).json;const p=$json.toPhone||'';return [{json:{ok:(cfg.allowedPhones||[]).includes(p)}}];"});
  node(wf.nodes,"WA Allowed?","n8n-nodes-base.if",[-180,80],{conditions:{boolean:[{value1:"={{$item(0).$node['WA Allowlist'].json.ok}}"}]} );
  node(wf.nodes,"Twilio WhatsApp","n8n-nodes-base.twilio",[0,80],{
    resource:"message",operation:"send",
    from:"={{$items('Set Config',0,0).json.twilioFromWhatsApp}}",
    to:"={{'whatsapp:' + $json['toPhone']}}",
    message:"={{$json['text']}}"
  },{ disabled:true, credentials:{ twilioApi:{ name:"twilio-default" } }});
  link(wf.connections,"Channel = WhatsApp?","WA Allowlist"); wf.connections["Channel = WhatsApp?"].main[1]=[];
  link(wf.connections,"WA Allowlist","WA Allowed?"); link(wf.connections,"WA Allowed?","Twilio WhatsApp");

  // CALL
  node(wf.nodes,"Call Allowlist","n8n-nodes-base.function",[-340,200],{functionCode:"const cfg=$items('Set Config',0,0).json;const p=$json.toPhone||'';return [{json:{ok:(cfg.allowedPhones||[]).includes(p)}}];"});
  node(wf.nodes,"Call Allowed?","n8n-nodes-base.if",[-180,200],{conditions:{boolean:[{value1:"={{$item(0).$node['Call Allowlist'].json.ok}}"}]} );
  node(wf.nodes,"Twilio Call (TTS)","n8n-nodes-base.twilio",[0,200],{
    resource:"call",operation:"create",
    from:"={{$items('Set Config',0,0).json.twilioFromVoice}}",
    to:"={{$json['toPhone']}}",
    text:"={{$json['tts'] || 'Hello!'}}", sayOrPlay:"say"
  },{ disabled:true, credentials:{ twilioApi:{ name:"twilio-default" } }});
  link(wf.connections,"Channel = Call?","Call Allowlist"); wf.connections["Channel = Call?"].main[1]=[];
  link(wf.connections,"Call Allowlist","Call Allowed?"); link(wf.connections,"Call Allowed?","Twilio Call (TTS)");
}

function connectToWait(wf){
  ["Email Send","Twilio SMS","Twilio WhatsApp","Twilio Call (TTS)"].forEach(n=>{
    link(wf.connections,n,"Wait for Reply");
  });
}

// ---------- LLM (disabled for now) ----------
function llmNodes(wf, prompt){
  node(wf.nodes,"LLM Prompt","n8n-nodes-base.function",[-720,-200],{functionCode:`return [{ json:{ prompt:\`${prompt.replace(/`/g,'\\`')}\` } }];`});
  node(wf.nodes,"OpenAI Chat (disabled)","n8n-nodes-base.openAi",[-480,-200],{
    operation:"chat",model:"gpt-4o-mini",additionalFields:{systemMessage:"={{$json.prompt}}"}
  },{disabled:true,credentials:{openAiApi:{name:"openai-default"}}});
  link(wf.connections,"LLM Prompt","OpenAI Chat (disabled)");
}

function buildLLMPrompt(s, industry, key){
  const role = (s.agent_name || 'Agent').trim();
  const sector = industry?.industry_id || (s.name || 'industry');
  const how = (s.how_it_works || '').trim();
  const roi = (s.roi_hypothesis || '').trim();
  const pains = industry?.painpoints || '';
  const kpis = industry?.kpis || '';
  const goals = {
    scheduling:['reduce no-shows','maximize utilization'],
    billing:['collect faster','reduce DSO'],
    lead:['qualify quickly','book demos'],
    support:['triage & resolve','deflect to self-serve'],
    status:['proactive status','reduce WISMO/WISMR'],
    upsell:['activate add-ons','increase LTV'],
    onboarding:['collect docs','complete tasks'],
    internal:['notify & approve','summarize'],
    survey:['increase response','improve NPS'],
    knowledge:['accurate answers','short texts']
  }[key] || [];
  return [
`You are a ${role} for ${sector}.`,
`How it works: ${how || 'N/A'}`,
`ROI: ${roi || 'N/A'}`,
industry ? `Painpoints: ${pains}` : null,
industry ? `KPIs: ${kpis}` : null,
`Objectives: ${goals.join(', ')}.`,
`Tone: concise, friendly, compliant. For SMS/WA keep ≤320 chars. For voice, short TTS sentences.`,
`Always honor STOP/opt-out.`
  ].filter(Boolean).join('\n');
}

// ---------- 10 archetype composers ----------
function composeScheduling(s, industry){
  const wf = wfSkeleton(`${s.scenario_id} – ${s.agent_name || 'Scheduling Agent'} (Demo)`);
  node(wf.nodes,"Manual Trigger","n8n-nodes-base.manualTrigger",[-1460,-20],{});
  wf.nodes.push(cfgNode(recommendedChannel(s)));
  node(wf.nodes,"Load","n8n-nodes-base.function",[-940,-20],{functionCode:`return [{ json:{ appt:{ first:"Sara", email:"kevanm.spain@gmail.com", phone:"+34XXXXXXXXX", time:"2025-10-02T10:00", doctor:"Dr. Lee"} } }];`});
  const HOW=(s.how_it_works||'').replace(/`/g,'\\`'), ROI=(s.roi_hypothesis||'').replace(/`/g,'\\`'), PAI=(industry?.painpoints||'').replace(/`/g,'\\`');
  node(wf.nodes,"Compose Message","n8n-nodes-base.function",[-720,-20],{functionCode:
`const a=$json.appt; const d=new Date(a.time);
const ctx=[\`${HOW}\`,\`${ROI}\`,\`${PAI}\`].filter(Boolean).join(' ');
return [{ json:{
  to:a.email, toPhone:a.phone,
  subject:"Appointment reminder — "+a.doctor,
  text:\`Hi \${a.first}, your appointment is on \${d.toLocaleDateString()} at \${d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}.\${ctx?' '+ctx:''} Reply 1 CONFIRM, 2 RESCHEDULE, 3 CANCEL.\`,
  tts:"Appointment reminder."
}}];`});
  branchChannels(wf); connectToWait(wf);
  node(wf.nodes,"Wait for Reply","n8n-nodes-base.wait",[260,-20],{});
  node(wf.nodes,"Parse Intent","n8n-nodes-base.function",[520,-20],{functionCode:
`const t=($json.Body||$json.text||"1").toLowerCase(); let intent='HUMAN';
if (t==='1'||/\\bconfirm|yes\\b/.test(t)) intent='CONFIRM';
else if (t==='2'||/resched|move|change/.test(t)) intent='RESCHEDULE';
else if (t==='3'||/cancel/.test(t)) intent='CANCEL';
else if (/late/.test(t)) intent='LATE';
return [{ json:{ intent } }];`});
  node(wf.nodes,"Update PMS (Mock)","n8n-nodes-base.function",[760,-20],{functionCode:`console.log('[PMS] schedule →', $json.intent); return items;`});
  node(wf.nodes,"Fill Slot (Mock)","n8n-nodes-base.function",[1000,-20],{functionCode:`if ($json.intent==='CANCEL'||$json.intent==='RESCHEDULE') console.log('[WAITLIST] backfill'); return items;`});
  link(wf.connections,"Manual Trigger","Set Config");
  link(wf.connections,"Set Config","Load");
  link(wf.connections,"Load","Compose Message");
  link(wf.connections,"Wait for Reply","Parse Intent");
  link(wf.connections,"Parse Intent","Update PMS (Mock)");
  link(wf.connections,"Update PMS (Mock)","Fill Slot (Mock)");
  llmNodes(wf, buildLLMPrompt(s, industry, 'scheduling'));
  return wf;
}

function composeBilling(s, industry){
  const wf = wfSkeleton(`${s.scenario_id} – ${s.agent_name || 'Billing Agent'} (Demo)`);
  node(wf.nodes,"Manual Trigger","n8n-nodes-base.manualTrigger",[-1460,-20],{});
  wf.nodes.push(cfgNode(recommendedChannel(s)));
  node(wf.nodes,"Load","n8n-nodes-base.function",[-940,-20],{functionCode:`return [{ json:{ invoice:{ id:"INV-1047", amount:120.00, currency:"USD", due:"2025-10-03"}, debtor:{ name:"Alex", email:"kevanm.spain@gmail.com", phone:"+34XXXXXXXXX"} } }];`});
  node(wf.nodes,"Compose Message","n8n-nodes-base.function",[-720,-20],{functionCode:
`const inv=$json.invoice, d=$json.debtor;
return [{ json:{
  to:d.email, toPhone:d.phone,
  subject:\`Invoice \${inv.id} due \${inv.due}\`,
  text:\`Hi \${d.name}, friendly reminder: invoice \${inv.id} for \${inv.amount} \${inv.currency} is due \${inv.due}. Reply 1 PAID, 2 PLAN, 3 DISPUTE.\`,
  tts:"Invoice reminder."
}}];`});
  branchChannels(wf); connectToWait(wf);
  node(wf.nodes,"Wait for Reply","n8n-nodes-base.wait",[260,-20],{});
  node(wf.nodes,"Parse Intent","n8n-nodes-base.function",[520,-20],{functionCode:
`const t=($json.Body||$json.text||"1").toLowerCase(); let intent='HUMAN';
if (t==='1'||/\\bpaid|settled|done\\b/.test(t)) intent='PAID';
else if (t==='2'||/plan|installment/.test(t)) intent='PLAN';
else if (t==='3'||/dispute|error/.test(t)) intent='DISPUTE';
return [{ json:{ intent } }];`});
  node(wf.nodes,"Update AR (Mock)","n8n-nodes-base.function",[760,-20],{functionCode:`console.log('[AR] update →',$json.intent); return items;`});
  node(wf.nodes,"Follow-up (Mock)","n8n-nodes-base.function",[1000,-20],{functionCode:`if ($json.intent==='PLAN') console.log('send plan options'); if ($json.intent==='DISPUTE') console.log('create ticket'); return items;`});
  link(wf.connections,"Manual Trigger","Set Config");
  link(wf.connections,"Set Config","Load");
  link(wf.connections,"Load","Compose Message");
  link(wf.connections,"Wait for Reply","Parse Intent");
  link(wf.connections,"Parse Intent","Update AR (Mock)");
  link(wf.connections,"Update AR (Mock)","Follow-up (Mock)");
  llmNodes(wf, buildLLMPrompt(s, industry, 'billing'));
  return wf;
}

function composeLead(s, industry){
  const wf = wfSkeleton(`${s.scenario_id} – ${s.agent_name || 'Lead Agent'} (Demo)`);
  node(wf.nodes,"Manual Trigger","n8n-nodes-base.manualTrigger",[-1460,-20],{});
  wf.nodes.push(cfgNode(recommendedChannel(s)));
  node(wf.nodes,"Load","n8n-nodes-base.function",[-940,-20],{functionCode:`return [{ json:{ lead:{ name:"Jamie", email:"kevanm.spain@gmail.com", phone:"+34XXXXXXXXX", interest:"Consult"} } }];`});
  node(wf.nodes,"Compose Message","n8n-nodes-base.function",[-720,-20],{functionCode:
`const L=$json.lead;
return [{ json:{
  to:L.email, toPhone:L.phone,
  subject:\`Thanks \${L.name} — quick questions\`,
  text:\`Hi \${L.name}, are you available this week? Reply 1 THIS WEEK, 2 NEXT WEEK, 3 HUMAN.\`,
  tts:"Lead follow-up."
}}];`});
  branchChannels(wf); connectToWait(wf);
  node(wf.nodes,"Wait for Reply","n8n-nodes-base.wait",[260,-20],{});
  node(wf.nodes,"Parse Intent","n8n-nodes-base.function",[520,-20],{functionCode:
`const t=($json.Body||$json.text||"1").toLowerCase(); let intent='THIS_WEEK';
if (t==='2'||/next/.test(t)) intent='NEXT_WEEK';
else if (t==='3'||/human|agent/.test(t)) intent='HUMAN';
return [{ json:{ intent } }];`});
  node(wf.nodes,"Route (Mock)","n8n-nodes-base.function",[760,-20],{functionCode:`console.log('[CRM] route →',$json.intent); return items;`});
  link(wf.connections,"Manual Trigger","Set Config");
  link(wf.connections,"Set Config","Load");
  link(wf.connections,"Load","Compose Message");
  link(wf.connections,"Wait for Reply","Parse Intent");
  link(wf.connections,"Parse Intent","Route (Mock)");
  llmNodes(wf, buildLLMPrompt(s, industry, 'lead'));
  return wf;
}

function composeSupport(s, industry){
  const wf = wfSkeleton(`${s.scenario_id} – ${s.agent_name || 'Support Agent'} (Demo)`);
  node(wf.nodes,"Manual Trigger","n8n-nodes-base.manualTrigger",[-1460,-20],{});
  wf.nodes.push(cfgNode(recommendedChannel(s)));
  node(wf.nodes,"Load","n8n-nodes-base.function",[-940,-20],{functionCode:`return [{ json:{ ticket:{ id:"TCK-22", topic:"Login issue", email:"kevanm.spain@gmail.com", phone:"+34XXXXXXXXX"} } }];`});
  node(wf.nodes,"Compose Message","n8n-nodes-base.function",[-720,-20],{functionCode:
`const t=$json.ticket;
return [{ json:{
  to:t.email, toPhone:t.phone,
  subject:\`Re: \${t.topic}\`,
  text:\`Hi there — quick triage questions. Reply 1 RESOLVED, 2 STILL ISSUE, 3 HUMAN.\`,
  tts:"Support assistance."
}}];`});
  branchChannels(wf); connectToWait(wf);
  node(wf.nodes,"Wait for Reply","n8n-nodes-base.wait",[260,-20],{});
  node(wf.nodes,"Parse Intent","n8n-nodes-base.function",[520,-20],{functionCode:
`const t=($json.Body||$json.text||"1").toLowerCase(); let intent='RESOLVED';
if (t==='2'||/still|not/.test(t)) intent='STILL_ISSUE';
else if (t==='3'||/human|agent/.test(t)) intent='HUMAN';
return [{ json:{ intent } }];`});
  node(wf.nodes,"Update Ticket (Mock)","n8n-nodes-base.function",[760,-20],{functionCode:`console.log('[TICKET] update →',$json.intent); return items;`});
  link(wf.connections,"Manual Trigger","Set Config");
  link(wf.connections,"Set Config","Load");
  link(wf.connections,"Load","Compose Message");
  link(wf.connections,"Wait for Reply","Parse Intent");
  link(wf.connections,"Parse Intent","Update Ticket (Mock)");
  llmNodes(wf, buildLLMPrompt(s, industry, 'support'));
  return wf;
}

function composeStatus(s, industry){
  const wf = wfSkeleton(`${s.scenario_id} – ${s.agent_name || 'Status Agent'} (Demo)`);
  node(wf.nodes,"Manual Trigger","n8n-nodes-base.manualTrigger",[-1460,-20],{});
  wf.nodes.push(cfgNode(recommendedChannel(s)));
  node(wf.nodes,"Load","n8n-nodes-base.function",[-940,-20],{functionCode:`return [{ json:{ case:{ id:"ORD-5012", stage:"Out for delivery", email:"kevanm.spain@gmail.com", phone:"+34XXXXXXXXX"} } }];`});
  node(wf.nodes,"Compose Message","n8n-nodes-base.function",[-720,-20],{functionCode:
`const c=$json.case;
return [{ json:{
  to:c.email, toPhone:c.phone,
  subject:\`Update on \${c.id}\`,
  text:\`\${c.id} — current status: \${c.stage}. Reply 1 OK, 2 QUESTION, 3 HUMAN.\`,
  tts:"Order status update."
}}];`});
  branchChannels(wf); connectToWait(wf);
  node(wf.nodes,"Wait for Reply","n8n-nodes-base.wait",[260,-20],{});
  node(wf.nodes,"Parse Intent","n8n-nodes-base.function",[520,-20],{functionCode:
`const t=($json.Body||$json.text||"1").toLowerCase(); let intent='ACK';
if (t==='2'||/question|help/.test(t)) intent='QUESTION';
else if (t==='3'||/human/.test(t)) intent='HUMAN';
return [{ json:{ intent } }];`});
  node(wf.nodes,"Log (Mock)","n8n-nodes-base.function",[760,-20],{functionCode:`console.log('[STATUS] reply →',$json.intent); return items;`});
  link(wf.connections,"Manual Trigger","Set Config");
  link(wf.connections,"Set Config","Load");
  link(wf.connections,"Load","Compose Message");
  link(wf.connections,"Wait for Reply","Parse Intent");
  link(wf.connections,"Parse Intent","Log (Mock)");
  llmNodes(wf, buildLLMPrompt(s, industry, 'status'));
  return wf;
}

function composeUpsell(s, industry){
  const wf = wfSkeleton(`${s.scenario_id} – ${s.agent_name || 'Upsell Agent'} (Demo)`);
  node(wf.nodes,"Manual Trigger","n8n-nodes-base.manualTrigger",[-1460,-20],{});
  wf.nodes.push(cfgNode(recommendedChannel(s)));
  node(wf.nodes,"Load","n8n-nodes-base.function",[-940,-20],{functionCode:`return [{ json:{ customer:{ name:"Taylor", email:"kevanm.spain@gmail.com", phone:"+34XXXXXXXXX"} } }];`});
  node(wf.nodes,"Compose Message","n8n-nodes-base.function",[-720,-20],{functionCode:
`const c=$json.customer;
return [{ json:{
  to:c.email, toPhone:c.phone,
  subject:"Quick upgrade?",
  text:\`Hi \${c.name}, we noticed you could benefit from our Plus plan. Reply 1 INTERESTED, 2 LATER, 3 NO.\`,
  tts:"Offer available."
}}];`});
  branchChannels(wf); connectToWait(wf);
  node(wf.nodes,"Wait for Reply","n8n-nodes-base.wait",[260,-20],{});
  node(wf.nodes,"Parse Intent","n8n-nodes-base.function",[520,-20],{functionCode:
`const t=($json.Body||$json.text||"1").toLowerCase(); let intent='INTERESTED';
if (t==='2'||/later/.test(t)) intent='LATER';
else if (t==='3'||/no|stop/.test(t)) intent='NO';
return [{ json:{ intent } }];`});
  node(wf.nodes,"CRM Update (Mock)","n8n-nodes-base.function",[760,-20],{functionCode:`console.log('[CRM] upsell →',$json.intent); return items;`});
  link(wf.connections,"Manual Trigger","Set Config");
  link(wf.connections,"Set Config","Load");
  link(wf.connections,"Load","Compose Message");
  link(wf.connections,"Wait for Reply","Parse Intent");
  link(wf.connections,"Parse Intent","CRM Update (Mock)");
  llmNodes(wf, buildLLMPrompt(s, industry, 'upsell'));
  return wf;
}

function composeOnboarding(s, industry){
  const wf = wfSkeleton(`${s.scenario_id} – ${s.agent_name || 'Onboarding Agent'} (Demo)`);
  node(wf.nodes,"Manual Trigger","n8n-nodes-base.manualTrigger",[-1460,-20],{});
  wf.nodes.push(cfgNode(recommendedChannel(s)));
  node(wf.nodes,"Load","n8n-nodes-base.function",[-940,-20],{functionCode:`return [{ json:{ user:{ name:"Casey", email:"kevanm.spain@gmail.com", phone:"+34XXXXXXXXX"} } }];`});
  node(wf.nodes,"Compose Message","n8n-nodes-base.function",[-720,-20],{functionCode:
`const u=$json.user;
return [{ json:{
  to:u.email, toPhone:u.phone,
  subject:"Finish onboarding",
  text:\`Hi \${u.name}, could you upload your ID and sign the agreement? Reply 1 DONE, 2 NEED HELP, 3 LATER.\`,
  tts:"Finish onboarding."
}}];`});
  branchChannels(wf); connectToWait(wf);
  node(wf.nodes,"Wait for Reply","n8n-nodes-base.wait",[260,-20],{});
  node(wf.nodes,"Parse Intent","n8n-nodes-base.function",[520,-20],{functionCode:
`const t=($json.Body||$json.text||"1").toLowerCase(); let intent='DONE';
if (t==='2'||/help/.test(t)) intent='HELP';
else if (t==='3'||/later/.test(t)) intent='LATER';
return [{ json:{ intent } }];`});
  node(wf.nodes,"Checklist Update (Mock)","n8n-nodes-base.function",[760,-20],{functionCode:`console.log('[ONBOARD] →',$json.intent); return items;`});
  link(wf.connections,"Manual Trigger","Set Config");
  link(wf.connections,"Set Config","Load");
  link(wf.connections,"Load","Compose Message");
  link(wf.connections,"Wait for Reply","Parse Intent");
  link(wf.connections,"Parse Intent","Checklist Update (Mock)");
  llmNodes(wf, buildLLMPrompt(s, industry, 'onboarding'));
  return wf;
}

function composeInternal(s, industry){
  const wf = wfSkeleton(`${s.scenario_id} – ${s.agent_name || 'Internal Ops Bot'} (Demo)`);
  node(wf.nodes,"Manual Trigger","n8n-nodes-base.manualTrigger",[-1460,-20],{});
  wf.nodes.push(cfgNode('email')); // prefer email for internal
  node(wf.nodes,"Load","n8n-nodes-base.function",[-940,-20],{functionCode:`return [{ json:{ alert:{ title:"Daily Summary", to:"kevanm.spain@gmail.com" } } }];`});
  node(wf.nodes,"Compose Message","n8n-nodes-base.function",[-720,-20],{functionCode:
`const a=$json.alert;
return [{ json:{ to:a.to, subject:a.title, text:"KPIs stable. Reply 1 ACK, 2 ESCALATE.", tts:"Alert." } }];`});
  branchChannels(wf); connectToWait(wf);
  node(wf.nodes,"Wait for Reply","n8n-nodes-base.wait",[260,-20],{});
  node(wf.nodes,"Parse Intent","n8n-nodes-base.function",[520,-20],{functionCode:
`const t=($json.Body||$json.text||"1").toLowerCase(); let intent='ACK';
if (t==='2'||/escalate/.test(t)) intent='ESCALATE';
return [{ json:{ intent } }];`});
  node(wf.nodes,"Ops Action (Mock)","n8n-nodes-base.function",[760,-20],{functionCode:`console.log('[OPS] →',$json.intent); return items;`});
  link(wf.connections,"Manual Trigger","Set Config");
  link(wf.connections,"Set Config","Load");
  link(wf.connections,"Load","Compose Message");
  link(wf.connections,"Wait for Reply","Parse Intent");
  link(wf.connections,"Parse Intent","Ops Action (Mock)");
  llmNodes(wf, buildLLMPrompt(s, industry, 'internal'));
  return wf;
}

function composeSurvey(s, industry){
  const wf = wfSkeleton(`${s.scenario_id} – ${s.agent_name || 'Survey Agent'} (Demo)`);
  node(wf.nodes,"Manual Trigger","n8n-nodes-base.manualTrigger",[-1460,-20],{});
  wf.nodes.push(cfgNode(recommendedChannel(s)));
  node(wf.nodes,"Load","n8n-nodes-base.function",[-940,-20],{functionCode:`return [{ json:{ person:{ name:"Riley", email:"kevanm.spain@gmail.com", phone:"+34XXXXXXXXX"} } }];`});
  node(wf.nodes,"Compose Message","n8n-nodes-base.function",[-720,-20],{functionCode:
`const p=$json.person;
return [{ json:{
  to:p.email, toPhone:p.phone,
  subject:"1-question NPS",
  text:\`Hi \${p.name}, from 0–10 how likely are you to recommend us? Reply with a number.\`,
  tts:"One question survey."
}}];`});
  branchChannels(wf); connectToWait(wf);
  node(wf.nodes,"Wait for Reply","n8n-nodes-base.wait",[260,-20],{});
  node(wf.nodes,"Parse Score","n8n-nodes-base.function",[520,-20],{functionCode:
`const n=parseInt(($json.Body||$json.text||'0').match(/\\d+/)?.[0]||'0',10);
const bucket = n>=9?'PROMOTER':(n>=7?'PASSIVE':'DETRACTOR');
return [{ json:{ nps:n, bucket } }];`});
  node(wf.nodes,"Log Score (Mock)","n8n-nodes-base.function",[760,-20],{functionCode:`console.log('[NPS]',$json.nps,$json.bucket); return items;`});
  link(wf.connections,"Manual Trigger","Set Config");
  link(wf.connections,"Set Config","Load");
  link(wf.connections,"Load","Compose Message");
  link(wf.connections,"Wait for Reply","Parse Score");
  link(wf.connections,"Parse Score","Log Score (Mock)");
  llmNodes(wf, buildLLMPrompt(s, industry, 'survey'));
  return wf;
}

function composeKnowledge(s, industry){
  const wf = wfSkeleton(`${s.scenario_id} – ${s.agent_name || 'Knowledge Agent'} (Demo)`);
  node(wf.nodes,"Manual Trigger","n8n-nodes-base.manualTrigger",[-1460,-20],{});
  wf.nodes.push(cfgNode(recommendedChannel(s)));
  node(wf.nodes,"Load","n8n-nodes-base.function",[-940,-20],{functionCode:`return [{ json:{ user:{ email:"kevanm.spain@gmail.com", phone:"+34XXXXXXXXX"}, question:"What are your hours?" } }];`});
  node(wf.nodes,"Compose Message","n8n-nodes-base.function",[-720,-20],{functionCode:
`const q=$json.question;
const answer="We’re open Mon–Fri 9–18 local time.";
return [{ json:{
  to:$json.user.email, toPhone:$json.user.phone,
  subject:"Answer",
  text:\`\${answer} Reply 1 RESOLVED, 2 MORE.\`,
  tts:"Answer provided."
}}];`});
  branchChannels(wf); connectToWait(wf);
  node(wf.nodes,"Wait for Reply","n8n-nodes-base.wait",[260,-20],{});
  node(wf.nodes,"Parse Intent","n8n-nodes-base.function",[520,-20],{functionCode:
`const t=($json.Body||$json.text||"1").toLowerCase(); let intent='RESOLVED';
if (t==='2'||/more|question/.test(t)) intent='MORE';
return [{ json:{ intent } }];`});
  node(wf.nodes,"KB Log (Mock)","n8n-nodes-base.function",[760,-20],{functionCode:`console.log('[KB] follow-up →',$json.intent); return items;`});
  link(wf.connections,"Manual Trigger","Set Config");
  link(wf.connections,"Set Config","Load");
  link(wf.connections,"Load","Compose Message");
  link(wf.connections,"Wait for Reply","Parse Intent");
  link(wf.connections,"Parse Intent","KB Log (Mock)");
  llmNodes(wf, buildLLMPrompt(s, industry, 'knowledge'));
  return wf;
}

// ---------- main builder ----------
function pickArchetype(s, industry){
  const text = [
    s.scenario_id, s.name, s.triggers, s.how_it_works, s.roi_hypothesis,
    (Array.isArray(s.tags)?s.tags.join(' '):s.tags||''),
    industry?.painpoints, industry?.kpis
  ].filter(Boolean).join(' ').toLowerCase();

  const has = (rx) => (new RegExp(`\\b(${rx})\\b`)).test(text);

  if (has('bill|invoice|collection|ar|overdue|payment')) return 'billing';
  if (has('lead|prospect|inbound|qualification|demo|signup')) return 'lead';
  if (has('support|ticket|helpdesk|triage|csat')) return 'support';
  if (has('status|tracking|order|shipment|case|wismo|wismr')) return 'status';
  if (has('upsell|cross|reactivation|winback|renewal')) return 'upsell';
  if (has('onboard|document|verification|kyc|compliance')) return 'onboarding';
  if (has('internal|approval|summary|digest|alert|notify')) return 'internal';
  if (has('survey|nps|csat|feedback|review')) return 'survey';
  if (has('faq|knowledge|kb|self-serve|deflection')) return 'knowledge';
  return 'scheduling';
}

function buildWorkflowJSON(s, industry){
  const key = pickArchetype(s, industry);
  const map = {
    scheduling: composeScheduling,
    billing: composeBilling,
    lead: composeLead,
    support: composeSupport,
    status: composeStatus,
    upsell: composeUpsell,
    onboarding: composeOnboarding,
    internal: composeInternal,
    survey: composeSurvey,
    knowledge: composeKnowledge
  };
  return map[key](s, industry);
}

// export to window for the UI to call
window.Builder = { buildWorkflowJSON };
