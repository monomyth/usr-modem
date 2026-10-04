/**
 * US Robotics 14400 dial-up simulation core — phase machine, LED rules, activity script.
 * Dual-environment: Node (tests) and browser (IIFE global).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ModemSimCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CONNECTION_SEQUENCE = [
    { phase: 'dialing', durationMs: 2800 },
    { phase: 'ringing', durationMs: 3200 },
    { phase: 'answering', durationMs: 900 },
    { phase: 'negotiating', durationMs: 9000 },
    { phase: 'connected_14400', durationMs: null }
  ];

  /**
   * V.32bis train measured from the start of the answering phase.
   * Answering is the first 900 ms; negotiating continues through 9900 ms.
   * tx/rx are which side is on the line (SD/RD follow that).
   * CD stays off until connected_14400 — carrier is not "up" for the DTE yet.
   * arqFlash is the V.42 LAPM exchange at the end of training.
   * Keep this table identical to HANDSHAKE_SEGMENTS in modem-audio.js.
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

  var EMAIL_WEB_ACTIVITIES = [
    { id: 'smtp_connect', type: 'email', action: 'tx', durationMs: 420, label: 'SMTP CONNECT' },
    { id: 'smtp_ehlo', type: 'email', action: 'tx', durationMs: 380, label: 'EHLO' },
    { id: 'smtp_auth', type: 'email', action: 'tx', durationMs: 520, label: 'AUTH LOGIN' },
    { id: 'smtp_auth_reply', type: 'email', action: 'rx', durationMs: 680, label: '235 OK' },
    { id: 'smtp_mail', type: 'email', action: 'tx', durationMs: 320, label: 'MAIL FROM' },
    { id: 'smtp_rcpt', type: 'email', action: 'tx', durationMs: 280, label: 'RCPT TO' },
    { id: 'smtp_data', type: 'email', action: 'tx', durationMs: 900, label: 'DATA' },
    { id: 'smtp_send_reply', type: 'email', action: 'rx', durationMs: 450, label: '250 Sent' },
    { id: 'pop_connect', type: 'email', action: 'tx', durationMs: 400, label: 'POP3 CONNECT' },
    { id: 'pop_user', type: 'email', action: 'tx', durationMs: 360, label: 'USER' },
    { id: 'pop_pass', type: 'email', action: 'tx', durationMs: 300, label: 'PASS' },
    { id: 'pop_stat', type: 'email', action: 'tx', durationMs: 220, label: 'STAT' },
    { id: 'pop_list', type: 'email', action: 'tx', durationMs: 260, label: 'LIST' },
    { id: 'pop_retr', type: 'email', action: 'tx', durationMs: 320, label: 'RETR 1' },
    { id: 'pop_download', type: 'email', action: 'rx', durationMs: 3800, label: 'Retrieving mail' },
    { id: 'pop_quit', type: 'email', action: 'tx', durationMs: 200, label: 'QUIT' },
    { id: 'http_dns', type: 'web', action: 'tx', durationMs: 320, label: 'DNS lookup' },
    { id: 'http_connect', type: 'web', action: 'tx', durationMs: 480, label: 'TCP connect' },
    { id: 'http_get', type: 'web', action: 'tx', durationMs: 650, label: 'HTTP GET' },
    { id: 'http_response', type: 'web', action: 'rx', durationMs: 3200, label: 'Downloading page' },
    { id: 'http_img1_req', type: 'web', action: 'tx', durationMs: 420, label: 'GET image.gif' },
    { id: 'http_img1_dl', type: 'web', action: 'rx', durationMs: 1600, label: 'image.gif' },
    { id: 'http_img2_req', type: 'web', action: 'tx', durationMs: 380, label: 'GET logo.jpg' },
    { id: 'http_img2_dl', type: 'web', action: 'rx', durationMs: 1400, label: 'logo.jpg' }
  ];

  function getConnectionDurationMs() {
    var total = 0;
    for (var i = 0; i < CONNECTION_SEQUENCE.length; i++) {
      if (CONNECTION_SEQUENCE[i].durationMs != null) {
        total += CONNECTION_SEQUENCE[i].durationMs;
      }
    }
    return total;
  }

  function getConnectionPhaseAt(elapsedMs) {
    var t = Math.max(0, elapsedMs);
    for (var i = 0; i < CONNECTION_SEQUENCE.length; i++) {
      var step = CONNECTION_SEQUENCE[i];
      if (step.durationMs == null || t < step.durationMs) {
        return {
          phase: step.phase,
          offsetMs: t,
          negotiatedRate: step.phase === 'connected_14400' ? 14400 : null,
          index: i
        };
      }
      t -= step.durationMs;
    }
    return { phase: 'connected_14400', offsetMs: t, negotiatedRate: 14400, index: CONNECTION_SEQUENCE.length - 1 };
  }

  function getPhaseOrder() {
    return CONNECTION_SEQUENCE.map(function (s) { return s.phase; });
  }

  function getFinalNegotiatedRate() {
    return 14400;
  }

  function getActivityTotalDurationMs() {
    return EMAIL_WEB_ACTIVITIES.reduce(function (sum, a) { return sum + a.durationMs; }, 0);
  }

  function getActivityAt(elapsedSinceConnectMs) {
    var total = getActivityTotalDurationMs();
    var t = ((elapsedSinceConnectMs % total) + total) % total;
    for (var i = 0; i < EMAIL_WEB_ACTIVITIES.length; i++) {
      var act = EMAIL_WEB_ACTIVITIES[i];
      if (t < act.durationMs) {
        return Object.assign({}, act, { offsetMs: t, index: i });
      }
      t -= act.durationMs;
    }
    return Object.assign({}, EMAIL_WEB_ACTIVITIES[0], { offsetMs: 0, index: 0 });
  }

  function getActivityState(elapsedSinceConnectMs, nowMs) {
    var act = getActivityAt(elapsedSinceConnectMs);
    var tick = typeof nowMs === 'number' ? nowMs : elapsedSinceConnectMs;
    var transmitting = act.action === 'tx';
    var receiving = act.action === 'rx';
    var receiveFlash = receiving && Math.floor(tick / 120) % 2 === 0;
    return {
      id: act.id,
      type: act.type,
      action: act.action,
      label: act.label,
      durationMs: act.durationMs,
      offsetMs: act.offsetMs,
      index: act.index,
      transmitting: transmitting,
      receiving: receiving,
      receiveFlash: receiveFlash
    };
  }

  function phaseDurationMs(name) {
    var i;
    for (i = 0; i < CONNECTION_SEQUENCE.length; i++) {
      if (CONNECTION_SEQUENCE[i].phase === name) {
        return CONNECTION_SEQUENCE[i].durationMs || 0;
      }
    }
    return 0;
  }

  function segmentAt(handshakeMs) {
    var i;
    var s;
    for (i = 0; i < HANDSHAKE_SEGMENTS.length; i++) {
      s = HANDSHAKE_SEGMENTS[i];
      if (handshakeMs >= s.fromMs && handshakeMs < s.toMs) return s;
    }
    return null;
  }

  function halfOn(pulse, period) {
    var t = pulse < 0 ? 0 : pulse;
    return Math.floor(t / period) % 2 === 0;
  }

  /**
   * USR Sportster LED semantics (originating a call):
   * AA  — Auto Answer. Off while originating.
   * CD  — Carrier Detect. Solid only once data transmission is possible.
   * RD  — Receive Data. Flashes when the modem passes received bits or a result code.
   * SD  — Send Data. On while the computer is sending bits (dial command, then TX bursts).
   * TR  — Terminal Ready. On for the whole session (DTR).
   * ARQ — Solid when LAPM/V.42 is up. Flashes while error control is still negotiating.
   * During the train, SD/RD follow whichever side is actually transmitting.
   */
  function mapPhaseToLeds(phase, activityState, pulseMs, phaseOffsetMs) {
    var pulse = typeof pulseMs === 'number' ? pulseMs : 0;
    var offset = typeof phaseOffsetMs === 'number' ? phaseOffsetMs : 0;
    var leds = { aa: false, cd: false, rd: false, sd: false, tr: false, arq: false };
    var seg;

    if (phase === 'idle') {
      leds.tr = true;
      return leds;
    }

    leds.tr = true;

    if (phase === 'dialing') {
      /* Dial tone, then seven DTMF digits at the same 170 ms slot the audio uses. */
      if (offset >= 520 && offset < 1710) {
        leds.sd = ((offset - 520) % 170) < 100;
      }
      return leds;
    }

    if (phase === 'ringing') {
      return leds;
    }

    if (phase === 'answering' || phase === 'negotiating') {
      var hs = offset;
      if (phase === 'negotiating') hs += phaseDurationMs('answering');
      seg = segmentAt(hs);
      if (seg) {
        if (seg.tx && seg.rx) {
          leds.sd = halfOn(pulse, 90);
          leds.rd = !leds.sd;
        } else if (seg.tx) {
          leds.sd = halfOn(pulse, 80);
        } else if (seg.rx) {
          leds.rd = halfOn(pulse, seg.id === 'ans' ? 160 : 80);
        }
        if (seg.arqFlash) leds.arq = halfOn(pulse, 140);
      }
      return leds;
    }

    if (phase === 'connected_14400') {
      leds.cd = true;
      leds.arq = true;
      if (activityState) {
        if (activityState.transmitting) leds.sd = true;
        if (activityState.receiving) leds.rd = !!activityState.receiveFlash;
      }
      /* CONNECT 14400 result code flashes RD as it is written to the DTE. */
      if (offset < 450 && !(activityState && activityState.receiving)) {
        leds.rd = halfOn(pulse, 90);
      }
      return leds;
    }

    return leds;
  }

  function getLedSnapshot(elapsedMs, nowMs) {
    var conn = getConnectionPhaseAt(elapsedMs);
    var activity = null;
    if (conn.phase === 'connected_14400') {
      var sinceConnect = elapsedMs - getConnectionDurationMs();
      activity = getActivityState(Math.max(0, sinceConnect), nowMs);
    }
    return {
      phase: conn.phase,
      negotiatedRate: conn.negotiatedRate,
      activity: activity,
      leds: mapPhaseToLeds(
        conn.phase,
        activity,
        nowMs != null ? nowMs : elapsedMs,
        conn.offsetMs
      )
    };
  }

  function getAllActivities() {
    return EMAIL_WEB_ACTIVITIES.slice();
  }

  return {
    CONNECTION_SEQUENCE: CONNECTION_SEQUENCE,
    HANDSHAKE_SEGMENTS: HANDSHAKE_SEGMENTS,
    EMAIL_WEB_ACTIVITIES: EMAIL_WEB_ACTIVITIES,
    getConnectionDurationMs: getConnectionDurationMs,
    getConnectionPhaseAt: getConnectionPhaseAt,
    getPhaseOrder: getPhaseOrder,
    getFinalNegotiatedRate: getFinalNegotiatedRate,
    getActivityTotalDurationMs: getActivityTotalDurationMs,
    getActivityAt: getActivityAt,
    getActivityState: getActivityState,
    mapPhaseToLeds: mapPhaseToLeds,
    getLedSnapshot: getLedSnapshot,
    getAllActivities: getAllActivities
  };
});