'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function makeBrowserContext(extra) {
  const logs = [];
  const globals = {
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push('ERR:' + a.join(' ')) },
    setTimeout: (fn) => { fn(); return 0; },
    setInterval: () => 0,
    clearInterval: () => {},
    clearTimeout: () => {},
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    document: {
      getElementById: (id) => {
        if (id && id.indexOf('led-') === 0) {
          return {
            id: id,
            classList: { add() {}, remove() {}, toggle() {} }
          };
        }
        return {
          id: id,
          classList: { add() {}, remove() {}, toggle() {} },
          textContent: '',
          innerHTML: '',
          appendChild() {},
          removeChild() {},
          addEventListener() {},
          children: [],
          scrollTop: 0
        };
      },
      createElement: () => ({ className: '', textContent: '' })
    },
    AudioContext: class {
      constructor() {
        this.state = 'running';
        this.currentTime = 0;
        this.destination = {};
      }
      createGain() {
        return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} }, connect() {} };
      }
      createOscillator() {
        return { type: 'sine', frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} };
      }
      createBiquadFilter() {
        return { type: 'lowpass', frequency: { value: 0 }, Q: { value: 0 }, connect() {} };
      }
      createBuffer() {
        return { getChannelData: () => new Float32Array(8) };
      }
      createBufferSource() {
        return { buffer: null, connect() {}, start() {}, stop() {} };
      }
      resume() { return Promise.resolve(); }
    },
    window: null
  };
  globals.window = globals;
  Object.assign(globals, extra || {});
  return { ctx: vm.createContext(globals), globals, logs };
}

function loadScript(filename, context) {
  const src = fs.readFileSync(path.join(ROOT, 'js', filename), 'utf8');
  vm.runInContext(src, context, { filename });
}

describe('browser script loading', () => {
  it('modem-sim-core registers ModemSimCore global', () => {
    const { ctx, globals } = makeBrowserContext();
    loadScript('modem-sim-core.js', ctx);
    assert.ok(globals.ModemSimCore);
    assert.equal(typeof globals.ModemSimCore.getPhaseOrder, 'function');
    assert.equal(globals.ModemSimCore.getFinalNegotiatedRate(), 14400);
  });

  it('modem-audio registers ModemAudio global', () => {
    const { ctx, globals } = makeBrowserContext();
    loadScript('modem-audio.js', ctx);
    assert.ok(globals.ModemAudio);
    assert.equal(typeof globals.ModemAudio.createEngine, 'function');
    assert.equal(typeof globals.ModemAudio.playPhaseEnter, 'function');
    const engine = globals.ModemAudio.createEngine();
    assert.ok(engine.init);
    assert.ok(engine.playNegotiating);
  });

  it('modem-ui registers ModemUI global', () => {
    const { ctx, globals } = makeBrowserContext();
    loadScript('modem-ui.js', ctx);
    assert.ok(globals.ModemUI);
    const ui = globals.ModemUI.createFromDom();
    assert.ok(ui.applyLeds);
    ui.applyLeds({ aa: false, cd: true, rd: false, sd: false, tr: true, arq: true }, null);
  });

  it('modem-app registers USRModemApp after dependencies', () => {
    const { ctx, globals } = makeBrowserContext();
    loadScript('modem-sim-core.js', ctx);
    loadScript('modem-audio.js', ctx);
    loadScript('modem-ui.js', ctx);
    loadScript('modem-app.js', ctx);
    assert.ok(globals.USRModemApp);
    assert.equal(typeof globals.USRModemApp.start, 'function');
    assert.equal(typeof globals.USRModemApp.getSnapshot, 'function');
  });
});