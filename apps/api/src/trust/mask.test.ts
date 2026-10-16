import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ibanValid, luhn, Masker } from './mask.js';

test('mask: emails, phones, valid cards, SSNs and IBANs become placeholders; ids and invalid numbers stay', () => {
  const m = new Masker();
  const text = [
    'Customer jane.doe@acme.com called from +1 415-555-0132 about card 4111 1111 1111 1111.',
    'SSN 123-45-6789, IBAN GB82 WEST 1234 5698 7654 32.',
    'Case 00001042, record 500gL00001AbcdQAC, order 1234567890123456 (not a valid card), amount 675000.',
  ].join('\n');
  const out = m.maskText(text);
  assert.match(out, /\[EMAIL_1\] called from \[PHONE_1\] about card \[CARD_1\]/);
  assert.match(out, /SSN \[SSN_1\], IBAN \[IBAN_1\]/);
  assert.match(out, /Case 00001042, record 500gL00001AbcdQAC, order 1234567890123456 \(not a valid card\), amount 675000/);
  assert.equal(m.unmaskText(out), text);
  const m2 = new Masker();
  assert.equal(m2.maskText('Call +91 98450 12345 or (020) 7946 0958. Closed 2025-08-21, amount 675 000.'), 'Call [PHONE_1] or [PHONE_2]. Closed 2025-08-21, amount 675 000.');
});

test('mask: the same value always gets the same placeholder within a run', () => {
  const m = new Masker();
  assert.equal(m.maskText('a@b.co and a@b.co and c@d.io'), '[EMAIL_1] and [EMAIL_1] and [EMAIL_2]');
});

test('mask: admin-marked fields are masked by name in prompts and in records', () => {
  const m = new Masker({}, ['Salary__c', 'MailingStreet']);
  assert.equal(m.maskText('Name: Asha\nSalary__c: 95000\nMailingStreet: 12 MG Road'), 'Name: Asha\nSalary__c: [FIELD_1]\nMailingStreet: [FIELD_2]');
  const rec = m.maskValue({ Name: 'Asha', Salary__c: '95000', Contact: { Email: 'asha@x.in' } }) as any;
  assert.equal(rec.Salary__c, '[FIELD_1]');
  assert.equal(rec.Contact.Email, '[EMAIL_1]');
  assert.deepEqual(m.unmaskValue(rec), { Name: 'Asha', Salary__c: '95000', Contact: { Email: 'asha@x.in' } });
});

test('mask: the mapping survives a pause (rebuilt from the stored map)', () => {
  const stored: Record<string, string> = {};
  new Masker(stored).maskText('mail me at x@y.com');
  assert.equal(new Masker(stored).unmaskText('Reply to [EMAIL_1]'), 'Reply to x@y.com');
  assert.equal(new Masker(stored).unmaskText('Unknown [EMAIL_9] stays'), 'Unknown [EMAIL_9] stays');
});

test('checks: Luhn and IBAN mod-97', () => {
  assert.equal(luhn('4111111111111111'), true);
  assert.equal(luhn('4111111111111112'), false);
  assert.equal(ibanValid('GB82WEST12345698765432'), true);
  assert.equal(ibanValid('GB82WEST12345698765433'), false);
});
