'use strict';

// Shared Playwright harness: loads the unpacked extension into Chromium and
// serves a stand-in www.youtube.com watch page (no network access needed).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const EXTENSION_DIR = path.resolve(__dirname, '..', '..', 'extension');
const MINUTE = 60 * 1000;

/** A quiet 220 Hz tone as a WAV file, so the mock video has real audio. */
function toneWav(seconds = 4, rate = 8000) {
  const samples = seconds * rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 3000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const WATCH_PAGE = `<!doctype html>
<html><head><title>Mock YouTube</title></head>
<body>
  <div id="movie_player" class="html5-video-player">
    <video class="html5-main-video" src="/media.wav" loop></video>
  </div>
  <button id="play" onclick="document.querySelector('#movie_player video').play()">play</button>
  <button id="louder" onclick="document.querySelector('#movie_player video').volume = 0.9">louder</button>
  <script>
    // Stand-ins for YouTube's player API that SleepyTube keeps in sync.
    window.__yt = { mute: 0, unmute: 0 };
    const player = document.getElementById('movie_player');
    player.mute = () => { window.__yt.mute++; player.querySelector('video').muted = true; };
    player.unMute = () => { window.__yt.unmute++; player.querySelector('video').muted = false; };
  </script>
</body></html>`;

const HOME_PAGE = `<!doctype html><html><head><title>Mock YouTube home</title></head><body>No video here.</body></html>`;

async function launch() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleepytube-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  const media = toneWav();
  await context.route('https://www.youtube.com/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/media.wav') {
      return route.fulfill({ status: 200, contentType: 'audio/wav', body: media });
    }
    if (url.pathname === '/watch') return route.fulfill({ status: 200, contentType: 'text/html', body: WATCH_PAGE });
    return route.fulfill({ status: 200, contentType: 'text/html', body: HOME_PAGE });
  });
  // Collect errors from every worker instance and extension page.
  const errors = [];
  const watchWorker = (worker) =>
    worker.on('console', (msg) => {
      if (msg.type() === 'error' && !/browser is shutting down/.test(msg.text())) errors.push(`[sw] ${msg.text()}`);
    });
  context.serviceWorkers().forEach(watchWorker);
  context.on('serviceworker', watchWorker);
  context.on('page', (page) => page.on('pageerror', (e) => errors.push(`[${page.url()}] ${e.message}`)));

  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(sw.url()).host;
  return {
    context,
    extensionId,
    errors,
    async cleanup() {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/** The current extension service worker (it may have been restarted). */
async function serviceWorker(context) {
  const live = context.serviceWorkers().filter((w) => w.url().endsWith('/background.js'));
  return live[live.length - 1] || context.waitForEvent('serviceworker');
}

/** Opens a mock watch page and starts the video with a real (trusted) click. */
async function openVideo(context, { volume = 0.8, id = 'abc' } = {}) {
  const page = await context.newPage();
  await page.goto(`https://www.youtube.com/watch?v=${id}`);
  await page.click('#play');
  await page.evaluate((v) => (document.querySelector('#movie_player video').volume = v), volume);
  await page.waitForFunction(() => !document.querySelector('#movie_player video').paused);
  // Let the user-input window from the click lapse so later changes count as YouTube's.
  await page.waitForTimeout(1600);
  return page;
}

function videoState(page) {
  return page.evaluate(() => {
    const v = document.querySelector('#movie_player video');
    return {
      volume: v.volume,
      muted: v.muted,
      paused: v.paused,
      rate: v.playbackRate,
      yt: { ...window.__yt },
    };
  });
}

async function tabIdOf(context, page) {
  const sw = await serviceWorker(context);
  const url = page.url();
  return sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, url);
}

/**
 * Opens the popup as a tab. chrome.tabs.query is pointed at `targetPage`'s tab
 * so the popup behaves as if it had been opened over that tab.
 */
async function openPopup(context, extensionId, target) {
  let tabId = -1;
  if (typeof target === 'number') tabId = target;
  else if (target) tabId = await tabIdOf(context, target);
  const popup = await context.newPage();
  await popup.addInitScript((id) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => {
      if (q && q.active && q.currentWindow) {
        if (id < 0) return [];
        return [await chrome.tabs.get(id)];
      }
      return query(q);
    };
  }, tabId);
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.waitForFunction(() => document.body.getAttribute('aria-busy') == null);
  return popup;
}

async function swEval(context, fn, arg) {
  const sw = await serviceWorker(context);
  return sw.evaluate(fn, arg);
}

const session = (context) => swEval(context, () => self.sleepyDebug.session());
const notices = (context) => swEval(context, () => self.sleepyDebug.notices());
const fastForward = (context, minutes) => swEval(context, (m) => self.sleepyDebug.fastForward(m), minutes);
const alarms = (context) =>
  swEval(context, async () => Object.fromEntries((await chrome.alarms.getAll()).map((a) => [a.name, a.scheduledTime])));
const offscreenStatus = (context) =>
  swEval(context, async () => {
    const docs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!docs.length) return null;
    // The document may be closing between the two calls.
    return chrome.runtime.sendMessage({ target: 'offscreen', type: 'status' }).catch(() => null);
  });

/** Resets the extension to IDLE between tests. */
async function resetNight(context) {
  await swEval(context, async () => {
    await self.sleepyDebug.reset();
    await chrome.storage.local.remove('settings');
    await chrome.notifications.clear('st-info');
  });
}

/** Sets the alarm time through the popup's date-time picker field. */
function pickWakeTime(popup, at) {
  return popup.evaluate((ms) => {
    const input = document.getElementById('wake-input');
    input.value = globalThis.SleepyCore.toDateTimeLocal(ms);
    input.dispatchEvent(new Event('change'));
  }, at);
}

/** A whole-minute time `minutes` from now. */
function minutesFromNow(minutes) {
  return Math.ceil((Date.now() + minutes * MINUTE) / MINUTE) * MINUTE;
}

async function waitFor(fn, { timeout = 5000, interval = 100, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${message} (last: ${JSON.stringify(last)})`);
}

module.exports = {
  MINUTE,
  launch,
  serviceWorker,
  openVideo,
  videoState,
  tabIdOf,
  openPopup,
  swEval,
  session,
  notices,
  fastForward,
  alarms,
  offscreenStatus,
  resetNight,
  pickWakeTime,
  minutesFromNow,
  waitFor,
};
