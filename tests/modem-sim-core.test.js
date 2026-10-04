'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../js/modem-sim-core.js');

describe('connection phase machine', () => {
  it('phase order includes dial through connected_14400', () => {
    const order = core.getPhaseOrder();
    assert.deepEqual(order, [
      'dialing',
      'ringing',
      'answering',
      'negotiating',
      'connected_14400'
    ]);
  });

  it('final negotiated rate is 14400', () => {
    assert.equal(core.getFinalNegotiatedRate(), 14400);
  });

  it('transitions through phases over elapsed time', () => {
    const t0 = core.getConnectionPhaseAt(0);
    assert.equal(t0.phase, 'dialing');

    const tDialEnd = core.getConnectionPhaseAt(2799);
    assert.equal(tDialEnd.phase, 'dialing');

    const tRing = core.getConnectionPhaseAt(3000);
    assert.equal(tRing.phase, 'ringing');

    const tAnswer = core.getConnectionPhaseAt(6200);
    assert.equal(tAnswer.phase, 'answering');

    const tNeg = core.getConnectionPhaseAt(7000);
    assert.equal(tNeg.phase, 'negotiating');

    const connectAt = core.getConnectionDurationMs();
    const tConnected = core.getConnectionPhaseAt(connectAt);
    assert.equal(tConnected.phase, 'connected_14400');
    assert.equal(tConnected.negotiatedRate, 14400);

    const tLater = core.getConnectionPhaseAt(connectAt + 50000);
    assert.equal(tLater.phase, 'connected_14400');
    assert.equal(tLater.negotiatedRate, 14400);
  });
});

describe('LED mapping', () => {
  it('AA off while originating (dialing)', () => {
    const leds = core.mapPhaseToLeds('dialing', null, 0);
    assert.equal(leds.aa, false);
    assert.equal(leds.tr, true);
  });

  it('CD off before carrier established (answering and negotiating)', () => {
    const answering = core.mapPhaseToLeds('answering', null, 0);
    const negotiating = core.mapPhaseToLeds('negotiating', null, 500);
    assert.equal(answering.cd, false);
    assert.equal(negotiating.cd, false);
  });

  it('CD solid after connect', () => {
    const snap = core.getLedSnapshot(core.getConnectionDurationMs() + 100, 100);
    assert.equal(snap.phase, 'connected_14400');
    assert.equal(snap.leds.cd, true);
    assert.equal(snap.leds.arq, true);
  });

  it('SD active during transmit activity step', () => {
    const connectMs = core.getConnectionDurationMs();
    const smtp = core.getAllActivities().find((a) => a.id === 'smtp_connect');
    const elapsed = connectMs + 50;
    const snap = core.getLedSnapshot(elapsed, elapsed);
    assert.equal(snap.activity.action, 'tx');
    assert.equal(snap.leds.sd, true);
    assert.equal(snap.leds.cd, true);
  });

  it('RD flashes during receive-heavy email step', () => {
    const connectMs = core.getConnectionDurationMs();
    let popDownloadOffset = 0;
    for (const act of core.getAllActivities()) {
      if (act.id === 'pop_download') break;
      popDownloadOffset += act.durationMs;
    }
    const elapsed = connectMs + popDownloadOffset + 200;
    const snapOn = core.getLedSnapshot(elapsed, 0);
    const snapOff = core.getLedSnapshot(elapsed, 120);
    assert.equal(snapOn.activity.id, 'pop_download');
    assert.equal(snapOn.activity.action, 'rx');
    assert.equal(snapOn.leds.rd, true);
    assert.equal(snapOff.leds.rd, false);
  });

  it('SD marks each dialed digit and ringback leaves the data lamps off', () => {
    const digit = core.mapPhaseToLeds('dialing', null, 0, 530);
    assert.equal(digit.sd, true);
    assert.equal(digit.aa, false);
    assert.equal(digit.tr, true);
    assert.equal(digit.cd, false);
    const gap = core.mapPhaseToLeds('dialing', null, 0, 660);
    assert.equal(gap.sd, false);
    const ring = core.mapPhaseToLeds('ringing', null, 0, 200);
    assert.equal(ring.rd, false);
    assert.equal(ring.sd, false);
    assert.equal(ring.tr, true);
    assert.equal(ring.cd, false);
  });

  it('handshake lamps follow the side that is on the line and hold CD off', () => {
    const ans = core.mapPhaseToLeds('answering', null, 0, 100);
    assert.equal(ans.cd, false);
    assert.equal(ans.rd, true);
    assert.equal(ans.sd, false);
    assert.equal(ans.arq, false);

    const aa = core.mapPhaseToLeds('negotiating', null, 0, 2760 - 900);
    assert.equal(aa.cd, false);
    assert.equal(aa.sd, true);
    assert.equal(aa.rd, false);

    const ac = core.mapPhaseToLeds('negotiating', null, 0, 3500 - 900);
    assert.equal(ac.sd, false);
    assert.equal(ac.rd, true);
    assert.equal(ac.cd, false);

    const rate = core.mapPhaseToLeds('negotiating', null, 0, 8000 - 900);
    assert.equal(rate.cd, false);
    assert.equal(rate.sd, true);
    assert.equal(rate.rd, false);
    assert.equal(rate.arq, true);
  });

  it('web browsing produces TX then RX LED patterns', () => {
    const connectMs = core.getConnectionDurationMs();
    let httpGetOffset = 0;
    for (const act of core.getAllActivities()) {
      if (act.id === 'http_get') break;
      httpGetOffset += act.durationMs;
    }
    const txSnap = core.getLedSnapshot(connectMs + httpGetOffset + 100, 100);
    assert.equal(txSnap.activity.type, 'web');
    assert.equal(txSnap.activity.action, 'tx');
    assert.equal(txSnap.leds.sd, true);

    let httpRespOffset = 0;
    for (const act of core.getAllActivities()) {
      if (act.id === 'http_response') break;
      httpRespOffset += act.durationMs;
    }
    const rxSnap = core.getLedSnapshot(connectMs + httpRespOffset + 500, 0);
    assert.equal(rxSnap.activity.type, 'web');
    assert.equal(rxSnap.activity.action, 'rx');
    assert.equal(rxSnap.leds.rd, true);
  });
});

describe('email then web activity script', () => {
  it('includes email steps before web steps', () => {
    const acts = core.getAllActivities();
    const firstWeb = acts.findIndex((a) => a.type === 'web');
    const lastEmail = acts.map((a, i) => (a.type === 'email' ? i : -1)).reduce((a, b) => Math.max(a, b));
    assert.ok(lastEmail < firstWeb, 'email activities precede web activities');
  });

  it('alternates short TX and longer RX bursts typical of dialup', () => {
    const acts = core.getAllActivities();
    const popDl = acts.find((a) => a.id === 'pop_download');
    const httpResp = acts.find((a) => a.id === 'http_response');
    const smtpAuth = acts.find((a) => a.id === 'smtp_auth');
    assert.ok(popDl.durationMs > smtpAuth.durationMs * 5);
    assert.ok(httpResp.durationMs > smtpAuth.durationMs * 4);
  });
});