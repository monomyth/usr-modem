'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const audioApi = require('../js/modem-audio.js');

describe('transition-driven phase audio', () => {
  it('playPhaseEnter invokes correct handler per phase on transition', () => {
    const calls = [];
    const engine = {
      playDialing: () => calls.push(['dialing']),
      playRinging: (d) => calls.push(['ringing', d]),
      playAnswering: () => calls.push(['answering']),
      playNegotiating: (d) => calls.push(['negotiating', d]),
      playConnectChirp: () => calls.push(['connected_14400'])
    };

    const phases = ['dialing', 'ringing', 'answering', 'negotiating', 'connected_14400'];
    for (const phase of phases) {
      audioApi.playPhaseEnter(engine, phase, 1000);
    }

    assert.deepEqual(calls, [
      ['dialing'],
      ['ringing', 1000],
      ['answering'],
      ['negotiating', 1000],
      ['connected_14400']
    ]);
  });

  it('each connection phase triggers exactly one sound on enter', () => {
    const engine = {
      playDialing: () => {},
      playRinging: () => {},
      playAnswering: () => {},
      playNegotiating: () => {},
      playConnectChirp: () => {}
    };
    let count = 0;
    const wrap = (fn) => () => { count++; return fn(); };
    engine.playDialing = wrap(engine.playDialing);
    engine.playRinging = wrap(engine.playRinging);
    engine.playAnswering = wrap(engine.playAnswering);
    engine.playNegotiating = wrap(engine.playNegotiating);
    engine.playConnectChirp = wrap(engine.playConnectChirp);

    audioApi.playPhaseEnter(engine, 'negotiating', 9000);
    assert.equal(count, 1);
  });

  it('shares the V.32bis timeline with the LED map', () => {
    const core = require('../js/modem-sim-core.js');
    assert.deepEqual(audioApi.HANDSHAKE_SEGMENTS, core.HANDSHAKE_SEGMENTS);
    assert.equal(audioApi.HANDSHAKE_ORIGIN_MS, 900);
    const answering = core.CONNECTION_SEQUENCE.find((s) => s.phase === 'answering');
    assert.equal(answering.durationMs, audioApi.HANDSHAKE_ORIGIN_MS);
  });

  it('answer tone is 2100 Hz and the screech is the 600/3000 pair, not a sweep', () => {
    const sr = 8000;
    const ans = audioApi.synthPhaseTone(sr, 0.2, 2100, 0, 0.2);
    assert.ok(Math.abs(estimateFreq(ans, sr) - 2100) < 40);

    const ac = audioApi.synthAlternatingCarrier(sr, 0.25, 0.2);
    const p600 = goertzel(ac, sr, 600);
    const p1800 = goertzel(ac, sr, 1800);
    const p3000 = goertzel(ac, sr, 3000);
    assert.ok(p600 > p1800, 'AC energy sits at 600 Hz');
    assert.ok(p3000 > p1800, 'AC energy sits at 3000 Hz');

    const trn = audioApi.synthScrambled(sr, 0.25, { levels: 8, seed: 0x13579 });
    const zc = estimateFreq(trn, sr);
    assert.ok(zc > 900 && zc < 4500, 'scrambled carrier is a hash, not a siren');
    let energy = 0;
    for (let i = 0; i < trn.length; i++) energy += trn[i] * trn[i];
    assert.ok(energy / trn.length > 0.05);
  });
});

function estimateFreq(data, sr) {
  let crossings = 0;
  for (let i = 1; i < data.length; i++) {
    if ((data[i - 1] <= 0 && data[i] > 0) || (data[i - 1] >= 0 && data[i] < 0)) crossings++;
  }
  return (crossings / 2) / (data.length / sr);
}

function goertzel(data, sr, freq) {
  const k = Math.round((freq * data.length) / sr);
  const w = (2 * Math.PI * k) / data.length;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < data.length; i++) {
    const s0 = data[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}