/**
 * DOM rendering for modem LEDs, status bar, and activity log.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ModemUI = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var LED_IDS = ['aa', 'cd', 'rd', 'sd', 'tr', 'arq'];

  function ModemUIRenderer(options) {
    this.ledEls = options.ledEls || {};
    this.statusEl = options.statusEl || null;
    this.logEl = options.logEl || null;
    this.lastActivityId = null;
    this.maxLogLines = 40;
  }

  ModemUIRenderer.prototype.applyLeds = function (leds) {
    for (var i = 0; i < LED_IDS.length; i++) {
      var id = LED_IDS[i];
      var el = this.ledEls[id];
      if (!el) continue;
      el.classList.toggle('on', !!leds[id]);
    }
  };

  ModemUIRenderer.prototype.setStatus = function (text) {
    if (this.statusEl) {
      this.statusEl.textContent = text;
    }
  };

  ModemUIRenderer.prototype.logPhase = function (phase, negotiatedRate) {
    var msg = '';
    switch (phase) {
      case 'dialing':
        msg = 'ATDT 555-1212';
        break;
      case 'ringing':
        msg = 'RING...';
        break;
      case 'answering':
        msg = 'Remote modem answered';
        break;
      case 'negotiating':
        msg = 'Negotiating V.32bis...';
        break;
      case 'connected_14400':
        msg = 'CONNECT 14400/ARQ/V42bis/LAPM';
        break;
      default:
        msg = phase;
    }
    this._appendLog('sys', msg);
    if (negotiatedRate === 14400) {
      this.setStatus('CONNECT 14400');
    }
  };

  ModemUIRenderer.prototype.logActivity = function (activity) {
    if (!activity || activity.id === this.lastActivityId) return;
    this.lastActivityId = activity.id;
    var prefix = activity.action === 'tx' ? '>>>' : '<<<';
    var cls = activity.action === 'tx' ? 'tx' : 'rx';
    this._appendLog(cls, prefix + ' ' + activity.label);
  };

  ModemUIRenderer.prototype._appendLog = function (cls, text) {
    if (!this.logEl) return;
    var p = document.createElement('p');
    p.className = 'line ' + cls;
    p.textContent = text;
    this.logEl.appendChild(p);
    while (this.logEl.children.length > this.maxLogLines) {
      this.logEl.removeChild(this.logEl.firstChild);
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
  };

  ModemUIRenderer.prototype.reset = function () {
    this.lastActivityId = null;
    if (this.logEl) this.logEl.innerHTML = '';
    this.setStatus('Ready.');
    var off = { aa: false, cd: false, rd: false, sd: false, tr: true, arq: false };
    this.applyLeds(off);
  };

  function createFromDom() {
    var ledEls = {};
    LED_IDS.forEach(function (id) {
      ledEls[id] = document.getElementById('led-' + id);
    });
    return new ModemUIRenderer({
      ledEls: ledEls,
      statusEl: document.getElementById('status-bar'),
      logEl: document.getElementById('activity-log')
    });
  }

  return {
    LED_IDS: LED_IDS,
    ModemUIRenderer: ModemUIRenderer,
    createFromDom: createFromDom
  };
});