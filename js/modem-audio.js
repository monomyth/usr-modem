/**
 * V.32bis 14400 dial-up audio.
 * Dial tone, DTMF, and US ringback are unchanged.
 * After answer: V.25 2100 Hz with phase reversals, AA (1800 Hz),
 * AC (600+3000 Hz screech), scrambled training, then a steady 14400 carrier.
 * No siren sweeps — those are not what this modem does.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ModemAudio = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DTMF = {
    '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
    '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
    '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
    '*': [941, 1209], '0': [941, 1336], '#': [941, 1477]
  };

  /** Answering phase length. Negotiating audio is scheduled after this. */
  var HANDSHAKE_ORIGIN_MS = 900;

  /**
   * Same timeline as ModemSimCore.HANDSHAKE_SEGMENTS.
   * Times are milliseconds from the start of the answering phase.
   */
  var HANDSHAKE_SEGMENTS = [
    { id: 'ans', fromMs: 0, toMs: 2600, tx: false, rx: true, arqFlash: false },
    { id: 'guard', fromMs: 2600, toMs: 2750, tx: false, rx: false, arqFlash: false },
    { id: 'aa', fromMs: 2750, toMs: 3450, tx: true, rx: false, arqFlash: false },
    { id: 'ac', fromMs: 3450, toMs: 4350, tx: false, rx: true, arqFlash: false },
    { id: 'trn_rx', fromMs: 4350, toMs: 5600, tx: false, rx: true, arqFlash: false },
    { id: 's1', fromMs: 5600, toMs: 5950, tx: true, rx: true, arqFlash: false },
    { id: 'trn_tx', fromMs: 5950, toMs: 7200, tx: true, rx: false, arqFlash: false },
    { id: 's2', fromMs: 7200, toMs: 7500, tx: true, rx: true, arqFlash: false },
    { id: 'rate', fromMs: 7500, toMs: 9000, tx: true, rx: true, arqFlash: true },
    { id: 'b1', fromMs: 9000, toMs: 9900, tx: true, rx: true, arqFlash: true }
  ];

  var TWO_PI = Math.PI * 2;

  function synthPhaseTone(sampleRate, durationSec, freq, reversalSec, amp) {
    var n = Math.max(1, Math.floor(sampleRate * durationSec));
    var data = new Float32Array(n);
    var dp = TWO_PI * freq / sampleRate;
    var phase = 0;
    var sign = 1;
    var revEvery = reversalSec > 0 ? Math.floor(reversalSec * sampleRate) : 0;
    var i;
    for (i = 0; i < n; i++) {
      if (revEvery && i > 0 && (i % revEvery) === 0) sign = -sign;
      data[i] = sign * Math.sin(phase) * amp;
      phase += dp;
      if (phase > TWO_PI) phase -= TWO_PI;
    }
    return data;
  }

  /**
   * AC/CA: 1800 Hz carrier with a phase flip every symbol (2400 baud).
   * That lands the energy at 600 Hz and 3000 Hz — the V.32 screech.
   */
  function synthAlternatingCarrier(sampleRate, durationSec, amp) {
    var n = Math.max(1, Math.floor(sampleRate * durationSec));
    var data = new Float32Array(n);
    var sps = sampleRate / 2400;
    var dp = TWO_PI * 1800 / sampleRate;
    var phase = 0;
    var acc = 0;
    var sign = 1;
    var i;
    for (i = 0; i < n; i++) {
      acc += 1;
      if (acc >= sps) {
        acc -= sps;
        sign = -sign;
      }
      data[i] = amp * sign * Math.sin(phase);
      phase += dp;
      if (phase > TWO_PI) phase -= TWO_PI;
    }
    return data;
  }

  function nextScrambleBit(lfsr) {
    var bit = ((lfsr >>> 18) ^ (lfsr >>> 23)) & 1;
    return ((lfsr << 1) | bit) >>> 0 & 0xFFFFFF;
  }

  /**
   * Scrambled QAM on an 1800 Hz carrier at 2400 baud.
   * levels 2 is QPSK training (gritty). levels 8 is the denser 14.4 hiss.
   */
  function synthScrambled(sampleRate, durationSec, opts) {
    var o = opts || {};
    var n = Math.max(1, Math.floor(sampleRate * durationSec));
    var data = new Float32Array(n);
    var baud = 2400;
    var sps = sampleRate / baud;
    var levels = o.levels || 2;
    if (levels < 2) levels = 2;
    var dp = TWO_PI * (o.carrier || 1800) / sampleRate;
    var phase = o.phase || 0;
    var lfsr = (o.seed || 1) >>> 0;
    var iHold = 0;
    var qHold = 0;
    var iSm = 0;
    var qSm = 0;
    var acc = sps;
    /* Fast edges. The phone-line filter, not this smoother, sets the bandwidth.
       Heavy smoothing collapses the train into a whistle. */
    var smooth = 1 - Math.exp(-5.5 / sps);
    var denom = levels - 1;
    var i;
    for (i = 0; i < n; i++) {
      acc += 1;
      if (acc >= sps) {
        acc -= sps;
        lfsr = nextScrambleBit(lfsr);
        var bits = lfsr & 0xFF;
        var iv = (bits % levels) / denom * 2 - 1;
        var qv = (Math.floor(bits / levels) % levels) / denom * 2 - 1;
        iHold = iv;
        qHold = qv;
      }
      iSm += (iHold - iSm) * smooth;
      qSm += (qHold - qSm) * smooth;
      var c = Math.cos(phase);
      var s = Math.sin(phase);
      data[i] = iSm * c - qSm * s;
      phase += dp;
      if (phase > TWO_PI) phase -= TWO_PI;
    }
    return data;
  }

  /** S/S' sync: ABAB at symbol rate. Tonal, shorter, and rougher than TRN. */
  function synthSync(sampleRate, durationSec, amp) {
    var n = Math.max(1, Math.floor(sampleRate * durationSec));
    var data = new Float32Array(n);
    var sps = sampleRate / 2400;
    var dp = TWO_PI * 1800 / sampleRate;
    var phase = 0.4;
    var acc = sps;
    var iHold = 1;
    var qHold = 0.3;
    var iSm = 0;
    var qSm = 0;
    var toggle = false;
    var smooth = 1 - Math.exp(-3.2 / sps);
    var i;
    for (i = 0; i < n; i++) {
      acc += 1;
      if (acc >= sps) {
        acc -= sps;
        toggle = !toggle;
        iHold = toggle ? 1 : -1;
        qHold = toggle ? 0.35 : -0.35;
      }
      iSm += (iHold - iSm) * smooth;
      qSm += (qHold - qSm) * smooth;
      data[i] = amp * (iSm * Math.cos(phase) - qSm * Math.sin(phase));
      phase += dp;
      if (phase > TWO_PI) phase -= TWO_PI;
    }
    return data;
  }

  function scaleToRms(data, rms) {
    var i;
    var s = 0;
    for (i = 0; i < data.length; i++) s += data[i] * data[i];
    var cur = Math.sqrt(s / data.length) || 1;
    var g = rms / cur;
    for (i = 0; i < data.length; i++) {
      var v = data[i] * g;
      if (v > 0.98) v = 0.98;
      else if (v < -0.98) v = -0.98;
      data[i] = v;
    }
    return data;
  }

  function mix(a, b, gainA, gainB) {
    var n = Math.min(a.length, b.length);
    var out = new Float32Array(n);
    var i;
    for (i = 0; i < n; i++) out[i] = a[i] * gainA + b[i] * gainB;
    return out;
  }

  function concat(parts) {
    var n = 0;
    var i;
    var k = 0;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Float32Array(n);
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], k);
      k += parts[i].length;
    }
    return out;
  }

  function synthClick(sampleRate) {
    var n = Math.max(1, Math.floor(sampleRate * 0.01));
    var data = new Float32Array(n);
    var i;
    for (i = 0; i < n; i++) {
      var env = 1 - i / n;
      data[i] = (Math.random() * 2 - 1) * env * 0.3;
    }
    return data;
  }

  function buildTrain(sampleRate) {
    var sr = sampleRate;
    var rateParts = [];
    var levelList = [2, 4, 8];
    var li;
    for (li = 0; li < levelList.length; li++) {
      var lv = levelList[li];
      rateParts.push(mix(
        synthScrambled(sr, 0.5, { levels: lv, seed: 0x51A0 + lv, phase: 0.1 }),
        synthScrambled(sr, 0.5, { levels: lv, seed: 0xA073 + lv * 17, phase: 1.3 }),
        0.7,
        0.7
      ));
    }
    var b1 = mix(
      synthScrambled(sr, 0.9, { levels: 8, seed: 0x14400, phase: 0.2 }),
      synthScrambled(sr, 0.9, { levels: 8, seed: 0x32B15, phase: 2.1 }),
      0.72,
      0.72
    );
    var clips = [
      { id: 'ans', fromMs: 0, toMs: 2600, pcm: synthPhaseTone(sr, 2.6, 2100, 0.45, 0.16) },
      { id: 'aa', fromMs: 2750, toMs: 3450, pcm: synthPhaseTone(sr, 0.7, 1800, 0.35, 0.15) },
      { id: 'ac', fromMs: 3450, toMs: 4350, pcm: synthAlternatingCarrier(sr, 0.9, 0.2) },
      {
        id: 'trn_rx',
        fromMs: 4350,
        toMs: 5600,
        pcm: scaleToRms(synthScrambled(sr, 1.25, { levels: 2, seed: 0x13579, phase: 0.2 }), 0.09)
      },
      { id: 's1', fromMs: 5600, toMs: 5950, pcm: synthSync(sr, 0.35, 0.16) },
      {
        id: 'trn_tx',
        fromMs: 5950,
        toMs: 7200,
        pcm: scaleToRms(synthScrambled(sr, 1.25, { levels: 2, seed: 0x2468A, phase: 1.1 }), 0.09)
      },
      { id: 's2', fromMs: 7200, toMs: 7500, pcm: synthSync(sr, 0.3, 0.15) },
      { id: 'rate', fromMs: 7500, toMs: 9000, pcm: scaleToRms(concat(rateParts), 0.1) },
      { id: 'b1', fromMs: 9000, toMs: 9900, pcm: scaleToRms(b1, 0.1) }
    ];
    return {
      sr: sr,
      click: synthClick(sr),
      clips: clips,
      txLoop: scaleToRms(synthScrambled(sr, 2, { levels: 8, seed: 0x71C0, phase: 0.4 }), 0.2),
      rxLoop: scaleToRms(synthScrambled(sr, 2, { levels: 8, seed: 0x0E11, phase: 2.4 }), 0.2)
    };
  }

  function ModemAudioEngine() {
    this.ctx = null;
    this.master = null;
    this.phoneLine = null;
    this.activeNodes = [];
    this.dataNodes = [];
    this.dataInterval = null;
    this._train = null;
    this._carrierGen = 0;
    this._carrierOn = false;
    this._txGain = null;
    this._rxGain = null;
    this._carrierStopTimer = null;
  }

  ModemAudioEngine.prototype.init = function () {
    if (this.ctx) return this.ctx;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();

    /* Straight to the speakers. A filter in this path was dropping the
       whole call on some browsers. */
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(this.ctx.destination);
    this.phoneLine = this.master;
    return this.ctx;
  };

  function writeBuffer(ctx, data) {
    var buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
    /* Safari's getChannelData() returns a copy, so .set() never reaches the buffer. */
    if (typeof buf.copyToChannel === 'function') buf.copyToChannel(data, 0, 0);
    else buf.getChannelData(0).set(data);
    return buf;
  }

  function safeStart(node, when, offset) {
    if (typeof node.start === 'function') {
      if (offset > 0) node.start(when, offset);
      else node.start(when);
    } else if (typeof node.noteOn === 'function') {
      node.noteOn(when || 0);
    }
  }

  function safeStop(node, when) {
    try {
      if (typeof node.stop === 'function') node.stop(when);
      else if (typeof node.noteOff === 'function') node.noteOff(when || 0);
    } catch (err) { /* already stopped */ }
  }

  ModemAudioEngine.prototype.resume = function () {
    var ctx = this.init();
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      var pending = ctx.resume();
      if (pending && typeof pending.catch === 'function') pending.catch(function () {});
      return pending || Promise.resolve();
    }
    return Promise.resolve();
  };

  ModemAudioEngine.prototype._out = function () {
    return this.master || this.ctx.destination;
  };

  ModemAudioEngine.prototype._track = function (node) {
    this.activeNodes.push(node);
    return node;
  };

  ModemAudioEngine.prototype._stopAll = function () {
    var i;
    for (i = 0; i < this.activeNodes.length; i++) {
      try { this.activeNodes[i].stop(); } catch (e) { /* stopped */ }
      try { this.activeNodes[i].disconnect(); } catch (e2) { /* noop */ }
    }
    this.activeNodes = [];
    this._stopDataCarrier();
  };

  ModemAudioEngine.prototype._tone = function (freq, start, dur, peak, type, dest) {
    var osc = this.ctx.createOscillator();
    var g = this.ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    /* Constant gain. Safari drops tones whose gain is only a scheduled ramp. */
    g.gain.value = peak;
    osc.connect(g);
    g.connect(dest || this._out());
    var now = this.ctx.currentTime;
    var t0 = start > now + 0.02 ? start : now + 0.03;
    safeStart(osc, t0);
    safeStop(osc, t0 + Math.max(0.05, dur));
    this._track(osc);
    return osc;
  };

  ModemAudioEngine.prototype._dtmfDigit = function (digit, start) {
    var f = DTMF[digit];
    if (!f) return start;
    this._tone(f[0], start, 0.1, 0.22);
    this._tone(f[1], start, 0.1, 0.22);
    return start + 0.1 + 0.07;
  };

  ModemAudioEngine.prototype.playDialing = function () {
    var t = this.ctx.currentTime + 0.04;
    this._tone(350, t, 0.45, 0.2);
    this._tone(440, t, 0.45, 0.2);
    t += 0.5;
    var digits = ['5', '5', '5', '1', '2', '1', '2'];
    var i;
    for (i = 0; i < digits.length; i++) {
      t = this._dtmfDigit(digits[i], t);
    }
    var self = this;
    setTimeout(function () { self._ensureTrain(); }, 0);
  };

  ModemAudioEngine.prototype.playRinging = function (durationMs) {
    var start = this.ctx.currentTime;
    var end = start + durationMs / 1000;
    var t = start;
    while (t < end - 0.1) {
      this._tone(440, t, 2.0, 0.11);
      this._tone(480, t, 2.0, 0.11);
      t += 6.0;
      if (t >= end) break;
    }
  };

  ModemAudioEngine.prototype._ensureTrain = function () {
    var sr = this.ctx.sampleRate || 48000;
    if (this._train && this._train.sr === sr) return this._train;
    this._train = buildTrain(sr);
    return this._train;
  };

  ModemAudioEngine.prototype._schedulePcm = function (data, when, fadeMs, offsetSec, durSec) {
    var sr = this.ctx.sampleRate;
    var buf = writeBuffer(this.ctx, data);
    var src = this.ctx.createBufferSource();
    src.buffer = buf;
    var g = this.ctx.createGain();
    var offset = offsetSec || 0;
    var available = data.length / sr - offset;
    var dur = durSec == null ? available : durSec;
    if (dur > available) dur = available;
    if (dur <= 0.005) return;
    g.gain.value = 1;
    var t0 = Math.max(when, this.ctx.currentTime + 0.03);
    src.connect(g);
    g.connect(this._out());
    /* Safari's 3-argument start(when, offset, duration) stays silent. */
    if (offset > 0.001) safeStart(src, t0, offset);
    else safeStart(src, t0);
    safeStop(src, t0 + dur);
    this._track(src);
  };

  ModemAudioEngine.prototype._clipById = function (id) {
    var clips = this._ensureTrain().clips;
    var i;
    for (i = 0; i < clips.length; i++) {
      if (clips[i].id === id) return clips[i];
    }
    return null;
  };

  ModemAudioEngine.prototype.playAnswering = function () {
    var train = this._ensureTrain();
    var t = this.ctx.currentTime + 0.02;
    var ans = this._clipById('ans');
    this._schedulePcm(train.click, t, 2);
    if (ans) this._schedulePcm(ans.pcm, t + 0.012, 6, 0, 0.9);
  };


  ModemAudioEngine.prototype.playNegotiating = function (durationMs) {
    var train = this._ensureTrain();
    var t0 = this.ctx.currentTime + 0.03;
    var durMs = durationMs == null ? 9000 : durationMs;
    var windowStart = HANDSHAKE_ORIGIN_MS;
    var windowEnd = HANDSHAKE_ORIGIN_MS + durMs;
    var i;
    for (i = 0; i < train.clips.length; i++) {
      var clip = train.clips[i];
      if (clip.toMs <= windowStart || clip.fromMs >= windowEnd) continue;
      var playFrom = Math.max(clip.fromMs, windowStart);
      var playTo = Math.min(clip.toMs, windowEnd);
      var when = t0 + (playFrom - windowStart) / 1000;
      var offsetSec = (playFrom - clip.fromMs) / 1000;
      var durSec = (playTo - playFrom) / 1000;
      this._schedulePcm(clip.pcm, when, 8, offsetSec, durSec);
    }
  };

  ModemAudioEngine.prototype.playConnectChirp = function () {
    /* V.32bis has no connect beep. The steady carrier takes over. */
    this.startDataCarrier('rx');
  };

  ModemAudioEngine.prototype._balanceCarrier = function (mode) {
    if (!this._txGain || !this._rxGain || !this.ctx) return;
    this._txGain.gain.value = mode === 'tx' ? 0.42 : 0.18;
    this._rxGain.gain.value = mode === 'rx' ? 0.46 : 0.2;
  };

  ModemAudioEngine.prototype._stopDataCarrier = function () {
    if (this._carrierStopTimer) {
      clearTimeout(this._carrierStopTimer);
      this._carrierStopTimer = null;
    }
    if (this.dataInterval) {
      clearInterval(this.dataInterval);
      this.dataInterval = null;
    }
    var i;
    for (i = 0; i < this.dataNodes.length; i++) {
      try { this.dataNodes[i].stop(); } catch (e) { /* stopped */ }
      try { this.dataNodes[i].disconnect(); } catch (e2) { /* noop */ }
    }
    this.dataNodes = [];
    this._txGain = null;
    this._rxGain = null;
    this._carrierOn = false;
  };

  ModemAudioEngine.prototype.startDataCarrier = function (mode) {
    var useMode = mode === 'tx' ? 'tx' : 'rx';
    this._carrierGen += 1;
    if (this._carrierStopTimer) {
      clearTimeout(this._carrierStopTimer);
      this._carrierStopTimer = null;
    }
    if (!this.ctx) return;
    var train = this._ensureTrain();
    if (this._carrierOn && this._txGain && this._rxGain) {
      this._balanceCarrier(useMode);
      return;
    }
    this._stopDataCarrier();
    this._carrierGen += 1;
    var t = this.ctx.currentTime + 0.03;
    var self = this;

    function loopSource(pcm) {
      var src = self.ctx.createBufferSource();
      src.buffer = writeBuffer(self.ctx, pcm);
      src.loop = true;
      return src;
    }

    var txSrc = loopSource(train.txLoop);
    var rxSrc = loopSource(train.rxLoop);
    this._txGain = this.ctx.createGain();
    this._rxGain = this.ctx.createGain();
    this._txGain.gain.value = 0.0001;
    this._rxGain.gain.value = 0.0001;
    txSrc.connect(this._txGain);
    rxSrc.connect(this._rxGain);
    this._txGain.connect(this._out());
    this._rxGain.connect(this._out());
    safeStart(txSrc, t);
    safeStart(rxSrc, t);
    this.dataNodes.push(txSrc, rxSrc, this._txGain, this._rxGain);
    this._carrierOn = true;
    this._balanceCarrier(useMode);
  };

  ModemAudioEngine.prototype.stopDataCarrier = function () {
    var self = this;
    var gen = this._carrierGen;
    if (!this._carrierOn) {
      this._stopDataCarrier();
      return;
    }
    if (this._txGain && this._rxGain) {
      this._txGain.gain.value = 0.0001;
      this._rxGain.gain.value = 0.0001;
    }
    this._carrierStopTimer = setTimeout(function () {
      if (self._carrierGen === gen) self._stopDataCarrier();
    }, 120);
  };

  ModemAudioEngine.prototype.stop = function () {
    this._carrierGen += 1;
    this._stopAll();
  };

  function createEngine() {
    return new ModemAudioEngine();
  }

  var PHASE_DURATIONS = {
    dialing: 2800,
    ringing: 3200,
    answering: 900,
    negotiating: 9000
  };

  function playPhaseEnter(engine, phase, durationMs) {
    if (!engine || !phase) return;
    var dur = durationMs != null ? durationMs : PHASE_DURATIONS[phase];
    switch (phase) {
      case 'dialing':
        engine.playDialing();
        break;
      case 'ringing':
        engine.playRinging(dur);
        break;
      case 'answering':
        engine.playAnswering();
        break;
      case 'negotiating':
        engine.playNegotiating(dur);
        break;
      case 'connected_14400':
        engine.playConnectChirp();
        break;
    }
  }

  return {
    ModemAudioEngine: ModemAudioEngine,
    createEngine: createEngine,
    playPhaseEnter: playPhaseEnter,
    PHASE_DURATIONS: PHASE_DURATIONS,
    HANDSHAKE_SEGMENTS: HANDSHAKE_SEGMENTS,
    HANDSHAKE_ORIGIN_MS: HANDSHAKE_ORIGIN_MS,
    synthPhaseTone: synthPhaseTone,
    synthAlternatingCarrier: synthAlternatingCarrier,
    synthScrambled: synthScrambled,
    synthSync: synthSync,
    buildTrain: buildTrain
  };
});
