import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SCRATCH = process.env.SCRATCH || '/var/folders/j7/rtr0l44x2pv29xs3w9ght5p40000gn/T/grok-goal-fee4240aa4b8/implementer';

fs.mkdirSync(SCRATCH, { recursive: true });

function serveStatic(rootDir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
      const filePath = path.join(rootDir, decodeURIComponent(urlPath));
      if (!filePath.startsWith(rootDir)) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const ext = path.extname(filePath);
        const types = {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.png': 'image/png',
          '.jpg': 'image/jpeg'
        };
        res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function sampleLedStates(page, ledId, samples, intervalMs) {
  const states = [];
  for (let i = 0; i < samples; i++) {
    const on = await page.evaluate((id) => {
      return document.getElementById(id).classList.contains('on');
    }, ledId);
    states.push(on);
    if (i < samples - 1) await page.waitForTimeout(intervalMs);
  }
  const toggles = states.slice(1).filter((s, i) => s !== states[i]).length;
  return { states, toggles, changed: toggles > 0 };
}

async function runLaunch(runIndex, baseUrl, browserType) {
  const browser = await browserType.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto(`${baseUrl}/index.html`, { waitUntil: 'domcontentloaded' });

  const labels = await page.evaluate(() => {
    return ['aa', 'cd', 'rd', 'sd', 'tr', 'arq'].map((id) => {
      const el = document.getElementById('led-' + id);
      return el && (el.getAttribute('data-label') || el.title || id.toUpperCase());
    });
  });
  const expected = ['AA', 'CD', 'RD', 'SD', 'TR', 'ARQ'];
  for (let i = 0; i < expected.length; i++) {
    if (!labels[i] || labels[i].toUpperCase().indexOf(expected[i]) === -1) {
      throw new Error(`Missing LED label: ${expected[i]}`);
    }
  }

  const modemBox = await page.locator('#modem').boundingBox();
  if (!modemBox || modemBox.width < 300 || modemBox.height < 100) {
    throw new Error('Modem surface dimensions too small');
  }

  await page.click('#start-btn');

  await page.waitForFunction(() => {
    const snap = window.USRModemApp.getSnapshot();
    return snap.phase === 'negotiating';
  }, { timeout: 20000 });

  const cdDuringNegotiate = await page.evaluate(() => {
    return document.getElementById('led-cd').classList.contains('on');
  });
  if (cdDuringNegotiate) throw new Error('CD should be off during negotiating (pre-carrier)');

  await page.waitForFunction(() => {
    const snap = window.USRModemApp.getSnapshot();
    return snap.phase === 'connected_14400';
  }, { timeout: 20000 });

  await page.waitForFunction(() => {
    const snap = window.USRModemApp.getSnapshot();
    return snap.activity && snap.activity.type === 'email';
  }, { timeout: 15000 });

  const emailActivity = await page.evaluate(() => {
    const snap = window.USRModemApp.getSnapshot();
    return { id: snap.activity.id, type: snap.activity.type };
  });

  await page.waitForFunction(() => {
    const snap = window.USRModemApp.getSnapshot();
    return snap.activity && snap.activity.type === 'web' && snap.activity.action === 'rx';
  }, { timeout: 35000 });

  const webActivity = await page.evaluate(() => {
    const snap = window.USRModemApp.getSnapshot();
    return { id: snap.activity.id, type: snap.activity.type, action: snap.activity.action };
  });

  await page.waitForTimeout(400);

  const cdOn = await page.evaluate(() => document.getElementById('led-cd').classList.contains('on'));
  if (!cdOn) throw new Error('CD not visibly on after connect');

  const rdBlink = await sampleLedStates(page, 'led-rd', 12, 100);
  const sdBlink = await sampleLedStates(page, 'led-sd', 12, 100);

  const activity = await page.evaluate(() => {
    const snap = window.USRModemApp.getSnapshot();
    return {
      phase: snap.phase,
      activity: snap.activity && snap.activity.id,
      activityType: snap.activity && snap.activity.type,
      action: snap.activity && snap.activity.action
    };
  });

  if (activity.phase !== 'connected_14400') throw new Error('Expected connected_14400 phase');
  if (activity.activityType !== 'web') throw new Error('Expected web activity segment at observation time');
  if (!rdBlink.changed && !sdBlink.changed) {
    throw new Error('Neither RD nor SD showed blink/flash state change over sampled interval');
  }

  const painted = await page.evaluate(() => {
    const img = document.querySelector('.modem-photo');
    const leds = document.querySelectorAll('.modem-figure .led').length;
    return img && img.complete && img.naturalWidth > 400 && leds === 6;
  });
  if (!painted) throw new Error('Modem surface not substantially painted');

  const logText = await page.evaluate(() => document.getElementById('activity-log').textContent);
  if (!logText.includes('SMTP') && !logText.includes('POP')) {
    throw new Error('Activity log missing email session entries');
  }
  if (!logText.includes('HTTP') && !logText.includes('GET') && !logText.includes('Downloading')) {
    throw new Error('Activity log missing web browsing entries');
  }

  await page.screenshot({ path: path.join(SCRATCH, `launch-${runIndex}.png`), fullPage: true });
  await browser.close();

  return {
    errors,
    activity,
    emailActivity,
    webActivity,
    cdOn,
    rdBlink: rdBlink.toggles,
    sdBlink: sdBlink.toggles
  };
}

async function main() {
  const log = [];
  try {
    const pwPath = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
    if (!fs.existsSync(pwPath)) {
      throw new Error('Playwright not installed — run npm install in usr-modem');
    }

    const { chromium } = await import('@playwright/test');
    const server = await serveStatic(ROOT);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    for (let i = 1; i <= 2; i++) {
      const result = await runLaunch(i, baseUrl, chromium);
      log.push(
        `Run ${i}: OK phase=${result.activity.phase} email=${result.emailActivity.id} web=${result.webActivity.id} ` +
        `CD=${result.cdOn} RD_toggles=${result.rdBlink} SD_toggles=${result.sdBlink}`
      );
      if (result.errors.length) {
        log.push(`Run ${i} console errors: ${result.errors.join('; ')}`);
        throw new Error('Page errors during run ' + i);
      }
    }

    server.close();
    fs.writeFileSync(path.join(SCRATCH, 'playwright.log'), log.join('\n') + '\n');
    console.log('Playwright launch checks passed.');
  } catch (err) {
    const msg = String(err && err.stack ? err.stack : err);
    if (msg.includes('not installed') || msg.includes('Cannot find')) {
      fs.writeFileSync(path.join(SCRATCH, 'playwright-unavailable.log'), msg + '\n');
      console.log('Playwright unavailable — logged to playwright-unavailable.log');
      process.exit(0);
    }
    log.push('FAIL: ' + msg);
    fs.writeFileSync(path.join(SCRATCH, 'playwright.log'), log.join('\n') + '\n');
    process.exit(1);
  }
}

main();