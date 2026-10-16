import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { asText, sessionIdFor, twilioSignature, validTwilioSignature } from './twilio.js';

test('twilio: signature is HMAC-SHA1 of URL + sorted fields, and tampering is caught', () => {
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const p = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
  // Built by hand the way Twilio documents it.
  const manual = createHmac('sha1', '12345').update(`${url}CallSidCA1234567890ABCDECaller+12349013030Digits1234From+12349013030To+18005551212`).digest('base64');
  assert.equal(twilioSignature('12345', url, p), manual);
  assert.ok(validTwilioSignature('12345', url, p, manual));
  assert.ok(!validTwilioSignature('12345', url, { ...p, Digits: '9999' }, manual));
  assert.ok(!validTwilioSignature('wrong', url, p, manual));
  assert.ok(!validTwilioSignature('12345', url, p, ''));
});

test('twilio: markdown becomes plain text; WhatsApp keeps bold', () => {
  const md = '## Your order\n**Status:** shipped\n- Tracking: [link](https://t.example/1)\n\n\n\nThanks';
  assert.equal(asText(md, 'sms'), 'Your order\nStatus: shipped\n• Tracking: link: https://t.example/1\n\nThanks');
  assert.match(asText(md, 'whatsapp'), /\*Status:\*/);
  assert.ok(asText('x'.repeat(5000), 'sms').length <= 1500);
});

test('twilio: one conversation per assistant and phone number', () => {
  const a = sessionIdFor('agent-1', '+14155550100');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, sessionIdFor('agent-1', '+14155550100'));
  assert.notEqual(a, sessionIdFor('agent-2', '+14155550100'));
});
