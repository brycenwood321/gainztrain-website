// LAST INBOUND REPLY, picked from GoHighLevel messages. Run: npm test
//
// The Summit missed-call script learned the hard way (memory ghl-call-messages-shape) that TYPE_ACTIVITY
// rows are GHL's own log lines and never a reply, and that automation emails read as outbound. The ops
// "Last reply" column must show what the customer SAID, so this pins the picker to hand-written fixtures.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pickLastInbound } from '../functions/_lib/ghl.js';

const msgs = [
  { direction: 'outbound', messageType: 'TYPE_SMS', body: 'Hey Zac, Jayson from Gainz Train. Saw you paused...', dateAdded: '2026-09-14T18:00:00.000Z' },
  { direction: 'inbound', messageType: 'TYPE_ACTIVITY_OPPORTUNITY', body: 'Opportunity created', dateAdded: '2026-09-14T19:00:00.000Z' },
  { direction: 'inbound', messageType: 'TYPE_SMS', body: '  It was the pickup time honestly,\n 10am is rough  ', dateAdded: '2026-09-14T18:20:00.000Z' },
  { direction: 'inbound', messageType: 'TYPE_EMAIL', body: 'older email reply', dateAdded: '2026-08-30T10:00:00.000Z' },
];

describe('pickLastInbound', () => {
  test('newest inbound SMS wins over an older email and over a later activity row', () => {
    const r = pickLastInbound(msgs);
    assert.equal(r.channel, 'sms');
    assert.equal(r.at, '2026-09-14T18:20:00.000Z');
    assert.equal(r.text, 'It was the pickup time honestly, 10am is rough');
  });
  test('an outbound-only or activity-only thread is no reply', () => {
    assert.equal(pickLastInbound([msgs[0], msgs[1]]), null);
    assert.equal(pickLastInbound([]), null);
    assert.equal(pickLastInbound(undefined), null);
  });
  test('text is capped at 280 characters', () => {
    const r = pickLastInbound([{ direction: 'inbound', messageType: 'TYPE_SMS', body: 'x'.repeat(1000), dateAdded: '2026-09-14T18:20:00.000Z' }]);
    assert.equal(r.text.length, 280);
  });
});
