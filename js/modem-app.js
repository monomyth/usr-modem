/**
 * Main application — ties simulation core, audio, and UI via a shared tick loop.
 */
(function () {
  'use strict';

  var core = window.ModemSimCore;
  var audioApi = window.ModemAudio;
  var uiApi = window.ModemUI;

  var startBtn = document.getElementById('start-btn');

  var ui = uiApi.createFromDom();
  var audio = audioApi.createEngine();

  var CONNECT_LABEL = 'Connect at 14,400 bps';
  var DISCONNECT_LABEL = 'Disconnect';
  var READY_STATUS = 'Ready — click Connect to dial.';

  var running = false;
  var live = false;
  var session = 0;
  var startTime = 0;
  var lastPhase = null;
  var lastAudioMode = null;
  var rafId = null;

  function setLive(live) {
    startBtn.textContent = live ? DISCONNECT_LABEL : CONNECT_LABEL;
    startBtn.classList.toggle('is-live', live);
    startBtn.setAttribute('aria-pressed', live ? 'true' : 'false');
  }

  function onPhaseEnter(phase, durationMs) {
    try {
      audioApi.playPhaseEnter(audio, phase, durationMs);
    } catch (err) {
      ui.setStatus('Audio: ' + (err && err.message ? err.message : 'could not play'));
    }
  }

  function activityAudio(activity) {
    if (!activity) {
      if (lastAudioMode) {
        audio.stopDataCarrier();
        lastAudioMode = null;
      }
      return;
    }
    var mode = activity.transmitting ? 'tx' : activity.receiving ? 'rx' : null;
    if (mode && mode !== lastAudioMode) {
      audio.startDataCarrier(mode);
      lastAudioMode = mode;
    } else if (!mode && lastAudioMode) {
      audio.stopDataCarrier();
      lastAudioMode = null;
    }
  }

  function tick(now) {
    if (!running) return;
    var elapsed = now - startTime;
    var snap = core.getLedSnapshot(elapsed, now);

    if (snap.phase !== lastPhase) {
      var conn = core.getConnectionPhaseAt(elapsed);
      var step = core.CONNECTION_SEQUENCE[conn.index];
      onPhaseEnter(snap.phase, step ? step.durationMs : null);
      ui.logPhase(snap.phase, snap.negotiatedRate);
      lastPhase = snap.phase;
    }

    if (snap.activity) {
      ui.logActivity(snap.activity);
      activityAudio(snap.activity);
    } else {
      activityAudio(null);
    }

    ui.applyLeds(snap.leds);
    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (running || live) return;
    /* Safari only allows sound if resume() runs before this handler
       changes the button. pointerdown already called it; call it again first. */
    var pending = audio.resume();
    live = true;
    setLive(true);
    var token = ++session;
    function go() {
      if (token !== session) return;
      running = true;
      startTime = performance.now();
      lastPhase = null;
      lastAudioMode = null;
      ui.reset();
      ui.setStatus('Dialing...');
      rafId = requestAnimationFrame(tick);
    }
    if (pending && typeof pending.then === 'function') pending.then(go, go);
    else go();
  }

  function stop() {
    session++;
    live = false;
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    audio.stop();
    lastPhase = null;
    lastAudioMode = null;
    ui.reset();
    ui.setStatus(READY_STATUS);
    setLive(false);
  }

  startBtn.addEventListener('pointerdown', function () {
    audio.resume();
  });
  startBtn.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') audio.resume();
  });
  startBtn.addEventListener('click', function () {
    if (running || live) stop();
    else start();
  });

  window.USRModemApp = {
    start: start,
    stop: stop,
    isRunning: function () { return running; },
    getSnapshot: function () {
      if (!running) return core.getLedSnapshot(0, 0);
      return core.getLedSnapshot(performance.now() - startTime, performance.now());
    },
    getCore: function () { return core; },
    getUI: function () { return ui; },
    getAudio: function () { return audio; }
  };
})();