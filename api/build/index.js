// inside your POST handler
const { blueprint, options } = await req.json();
const bp = typeof blueprint === 'string' ? yamlOrJsonToObject(blueprint) : blueprint;

// defaults for safe testing
const opts = {
  channel: (options?.channel || 'email').toLowerCase(),        // email|sms|whatsapp|call
  reply_mode: (options?.reply_mode || 'none').toLowerCase(),   // none|imap|webhook
  demoMode: options?.demoMode ?? false,
  overrideTo: options?.overrideTo || 'kevanm.spain@gmail.com',
  overrideToPhone: options?.overrideToPhone || '+34YOURMOBILE',
  twilio: {
    fromSms: options?.twilio?.fromSms || '+13412184164',
    fromWhatsApp: options?.twilio?.fromWhatsApp || 'whatsapp:+14155238886',
    fromVoice: options?.twilio?.fromVoice || '+13412184164',
  }
};

// when rendering EJS
const rendered = ejs.render(templateStr, { ...bp, ...opts }, { rmWhitespace: true });
