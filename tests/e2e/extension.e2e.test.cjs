'use strict';

// End-to-end tests: the real extension in Chromium against a mock YouTube page.
// Time is moved forward with the service worker's sleepyDebug.fastForward().
// Run with: npm run test:e2e

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness.cjs');

const { MINUTE } = h;
let env;

test.before(async () => {
  env = await h.launch();
});

test.after(async () => {
  if (env) await env.cleanup();
});

test.afterEach(() => {
  const errors = env.errors.splice(0);
  assert.deepEqual(errors, [], 'no errors from the service worker or extension pages');
});

test.beforeEach(async () => {
  await h.resetNight(env.context);
  for (const page of env.context.pages()) {
    if (!page.url().startsWith('about:')) await page.close();
  }
});

function near(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ≈${expected}, got ${actual}`);
}

async function armFromPopup(popup) {
  await popup.click('#arm');
  await popup.waitForSelector('#view-armed:not([hidden])');
}

test('popup without a YouTube video says so and disables the fade', async () => {
  const popup = await h.openPopup(env.context, env.extensionId, null);
  await popup.waitForSelector('#tab-note:not([hidden])');
  assert.equal(await popup.textContent('#tab-note'), 'Open a YouTube video first');
  assert.equal(await popup.isDisabled('#arm'), true);

  const home = await env.context.newPage();
  await home.goto('https://www.youtube.com/');
  const popup2 = await h.openPopup(env.context, env.extensionId, home);
  await popup2.waitForFunction(() => document.querySelector('#tab-note').textContent === 'Open a YouTube video first');
  assert.equal(await popup2.isDisabled('#arm'), true);
});

test('one click arms the default night; the fade, whisper and mute follow the timeline', async () => {
  const video = await h.openVideo(env.context, { volume: 0.8 });
  const other = await h.openVideo(env.context, { volume: 0.6, id: 'other' });
  const popup = await h.openPopup(env.context, env.extensionId, video);

  assert.equal(await popup.textContent('#fade-value'), '20 minutes');
  assert.equal(await popup.getAttribute('#fade-slider', 'aria-valuetext'), '20 minutes');
  await armFromPopup(popup); // a single interaction after opening the popup

  const s = await h.session(env.context);
  assert.equal(s.fade.originalVolume, 0.8);
  assert.equal(s.fade.originalMuted, false);
  near(s.fade.fadeStartAt - s.armedAt, 20 * MINUTE, 0, 'countdown');
  near(s.fade.fadeEndAt - s.fade.fadeStartAt, 10 * MINUTE, 0, 'fade');
  near(s.fade.muteAt - s.fade.fadeEndAt, 5 * MINUTE, 0, 'whisper');
  assert.equal(s.wake, null);
  const alarms = await h.alarms(env.context);
  assert.deepEqual(Object.keys(alarms).sort(), ['st:fade-mute', 'st:fade-start', 'st:fade-whisper']);
  assert.match(await popup.textContent('#armed-label'), /Fade starts in/);
  assert.match(await popup.textContent('#armed-big'), /^(19m|20m) \d\ds$/);
  assert.match(await popup.textContent('#view-armed .is-set'), /Night is set/);

  // Countdown: the volume is untouched.
  await h.fastForward(env.context, 10);
  await video.waitForTimeout(400);
  assert.equal((await h.videoState(video)).volume, 0.8);

  // Halfway through the fade: half-way down in decibels.
  await h.fastForward(env.context, 15);
  await video.waitForTimeout(600);
  let state = await h.videoState(video);
  near(state.volume, 0.8 * Math.sqrt(0.04), 0.01, 'mid-fade volume');
  assert.equal(state.muted, false);
  await popup.waitForFunction(() => /Fading gently/.test(document.querySelector('#armed-label').textContent));

  // Whisper.
  await h.fastForward(env.context, 5);
  await video.waitForTimeout(600);
  state = await h.videoState(video);
  near(state.volume, 0.8 * 0.04, 0.001, 'whisper volume');
  assert.equal(state.muted, false);

  // Silence: muted, still playing, speed untouched. YouTube's own player (and
  // the mute preference it saves for future tabs) is never touched.
  await h.fastForward(env.context, 5);
  state = await h.waitFor(async () => {
    const st = await h.videoState(video);
    return st.muted && st;
  }, { message: 'video muted' });
  assert.equal(state.paused, false);
  assert.equal(state.rate, 1);
  assert.deepEqual(state.yt, { mute: 0, unmute: 0 });

  // The other YouTube tab is never touched.
  const untouched = await h.videoState(other);
  assert.equal(untouched.volume, 0.6);
  assert.equal(untouched.muted, false);

  // Fade-only night is complete; the badge clears; Restore brings the sound back.
  await popup.waitForSelector('#view-done:not([hidden])');
  assert.match(await popup.textContent('#done-label'), /Night complete/);
  assert.equal(await h.swEval(env.context, () => chrome.action.getBadgeText({})), '');
  await popup.click('#restore');
  await popup.waitForSelector('#view-setup:not([hidden])');
  state = await h.videoState(video);
  assert.equal(state.volume, 0.8);
  assert.equal(state.muted, false);
  assert.equal(await h.session(env.context), null);
});

test('YouTube resetting the volume, or swapping the player, does not undo the fade', async () => {
  const video = await h.openVideo(env.context, { volume: 0.8 });
  const popup = await h.openPopup(env.context, env.extensionId, video);
  await armFromPopup(popup);
  await h.fastForward(env.context, 36);
  await h.waitFor(async () => (await h.videoState(video)).muted, { message: 'muted' });

  // A new playlist item: YouTube unmutes at full volume with no user input.
  await video.evaluate(() => {
    const v = document.querySelector('#movie_player video');
    v.muted = false;
    v.volume = 1;
  });
  await h.waitFor(async () => (await h.videoState(video)).muted, { message: 're-muted' });

  // The player's video element is replaced (e.g. a different player layout).
  await video.evaluate(() => {
    const old = document.querySelector('#movie_player video');
    const fresh = document.createElement('video');
    fresh.className = 'html5-main-video';
    fresh.src = '/media.wav?next';
    fresh.loop = true;
    old.replaceWith(fresh);
    fresh.play();
  });
  await h.waitFor(async () => (await h.videoState(video)).muted, { message: 'new element muted' });
  assert.equal(await h.session(env.context).then((s) => s.fade.status), 'active');
});

test('a reload mid-fade reattaches to the new page and keeps the original timeline', async () => {
  const video = await h.openVideo(env.context, { volume: 0.8 });
  const popup = await h.openPopup(env.context, env.extensionId, video);
  await armFromPopup(popup);
  await h.fastForward(env.context, 25); // halfway through the fade
  await video.reload();
  await video.click('#play');
  await video.waitForTimeout(800);
  near((await h.videoState(video)).volume, 0.8 * Math.sqrt(0.04), 0.01, 'volume after reload');
});

test('a user volume change pauses the fade; Resume fades again from the new volume', async () => {
  const video = await h.openVideo(env.context, { volume: 0.8 });
  const popup = await h.openPopup(env.context, env.extensionId, video);
  await armFromPopup(popup);
  await h.fastForward(env.context, 25);
  await video.waitForTimeout(500);

  await video.click('#louder'); // a real click: the user's own change
  await h.waitFor(async () => (await h.session(env.context)).fade.status === 'overridden', { message: 'override' });
  await popup.waitForSelector('#override-banner:not([hidden])');
  await video.waitForTimeout(700);
  assert.equal((await h.videoState(video)).volume, 0.9, 'SleepyTube does not fight the user');
  assert.equal(await h.swEval(env.context, () => chrome.action.getBadgeText({})), '!');

  await popup.click('#resume-fade');
  const s = await h.waitFor(async () => {
    const cur = await h.session(env.context);
    return cur.fade.status === 'active' && cur;
  });
  assert.equal(s.fade.startVolume, 0.9);
  near(s.fade.fadeStartAt, Date.now(), 3000, 'fade restarts now');
  assert.equal(s.fade.originalVolume, 0.8, 'restore target is still the original volume');
  await h.fastForward(env.context, 15);
  await h.waitFor(async () => (await h.videoState(video)).muted, { message: 'muted after resume' });
});

test('a volume change before the fade becomes the new starting volume', async () => {
  const video = await h.openVideo(env.context, { volume: 0.5 });
  const popup = await h.openPopup(env.context, env.extensionId, video);
  await armFromPopup(popup);
  await video.click('#louder');
  const s = await h.waitFor(async () => {
    const cur = await h.session(env.context);
    return cur.fade.startVolume === 0.9 && cur;
  }, { message: 'baseline update' });
  assert.equal(s.fade.status, 'active');
  assert.equal(s.fade.originalVolume, 0.9);
});

test('+15 minutes extends the countdown; Cancel night restores the volume', async () => {
  const video = await h.openVideo(env.context, { volume: 0.8 });
  const popup = await h.openPopup(env.context, env.extensionId, video);
  await armFromPopup(popup);
  const before = await h.session(env.context);
  await popup.click('#extend');
  const after = await h.waitFor(async () => {
    const cur = await h.session(env.context);
    return cur.fade.fadeStartAt !== before.fade.fadeStartAt && cur;
  });
  assert.equal(after.fade.fadeStartAt - before.fade.fadeStartAt, 15 * MINUTE);

  await h.fastForward(env.context, 40); // into the fade
  await video.waitForTimeout(600);
  assert.ok((await h.videoState(video)).volume < 0.5);
  await popup.click('#cancel-night');
  await popup.waitForSelector('#view-setup:not([hidden])');
  const state = await h.videoState(video);
  assert.equal(state.volume, 0.8);
  assert.equal(state.muted, false);
  assert.deepEqual(await h.alarms(env.context), {});
});

test('a wake time before the fade finishes is refused with a fix', async () => {
  const video = await h.openVideo(env.context);
  const popup = await h.openPopup(env.context, env.extensionId, video);
  await popup.click('#wake-section .switch');
  await popup.fill('#wake-time', h.clockIn(10)); // fade needs 35 minutes
  await popup.click('#arm');
  await popup.waitForSelector('#setup-error:not([hidden])');
  assert.match(await popup.textContent('#setup-error'), /later wake time or a shorter fade countdown/);
  assert.equal(await h.session(env.context), null);
});

test('wake alarm: rings from bundled audio, snoozes 9 minutes, and dismisses', async () => {
  const video = await h.openVideo(env.context, { volume: 0.8 });
  const popup = await h.openPopup(env.context, env.extensionId, video);
  await popup.click('#wake-section .switch');
  await popup.fill('#wake-time', h.clockIn(120));
  assert.match(await popup.textContent('#wake-when'), /Rings at \d{1,2}:\d\d\s[AP]M (today|tomorrow) \(/);
  assert.equal(await popup.isVisible('#test-sound'), true);
  assert.match(await popup.textContent('#wake-section .disclosure'), /cannot wake your computer from sleep/);
  await armFromPopup(popup);

  const armed = await h.session(env.context);
  assert.equal(armed.wake.status, 'scheduled');
  assert.ok((await h.alarms(env.context))['st:wake']);
  assert.match(await popup.textContent('#armed-wake-when'), /Wake alarm: .*\(/);
  assert.equal(await h.swEval(env.context, () => chrome.action.getBadgeText({})), '☾');

  const minutesToWake = Math.ceil((armed.wake.nextRingAt - Date.now()) / MINUTE);
  await h.fastForward(env.context, minutesToWake);
  const ringing = await h.waitFor(async () => {
    const s = await h.session(env.context);
    return s.wake.status === 'ringing' && s;
  }, { message: 'ringing' });
  assert.equal(ringing.wake.audioError, null);

  // The chime plays from the offscreen document, starting quiet.
  const audio = await h.waitFor(() => h.offscreenStatus(env.context), { message: 'offscreen audio' });
  assert.equal(audio.playing, true);
  assert.equal(audio.mode, 'wake');
  assert.ok(audio.volume < 0.05, `starts quiet (${audio.volume})`);
  assert.equal((await h.videoState(video)).muted, true, 'the video stays muted');

  // Wake window, notification and badge.
  const wakePage = await h.waitFor(
    () => env.context.pages().find((p) => p.url().endsWith('/wake/wake.html')),
    { message: 'wake window' },
  );
  await wakePage.waitForSelector('#snooze:not([hidden])');
  const notifications = await h.swEval(env.context, () => chrome.notifications.getAll());
  assert.ok(notifications['st-wake']);
  assert.equal(await h.swEval(env.context, () => chrome.action.getBadgeText({})), '☀');
  await popup.waitForSelector('#view-waking:not([hidden])');

  // A duplicate alarm event / worker restart must not start a second ring.
  await h.swEval(env.context, () => self.sleepyDebug.reconcile());
  const again = await h.session(env.context);
  assert.equal(again.wake.ringStartedAt, ringing.wake.ringStartedAt);
  assert.equal(
    await h.swEval(env.context, async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length),
    1,
  );

  // Snooze from the wake window.
  await wakePage.click('#snooze');
  const snoozed = await h.waitFor(async () => {
    const s = await h.session(env.context);
    return s.wake.status === 'snoozed' && s;
  });
  near(snoozed.wake.nextRingAt - Date.now(), 9 * MINUTE, 3000, 'snooze length');
  const wakeAlarm = await h.waitFor(async () => (await h.alarms(env.context))['st:wake'], { message: 'wake alarm' });
  near(wakeAlarm, snoozed.wake.nextRingAt, 1000, 'one new wake alarm');
  await h.waitFor(async () => (await h.offscreenStatus(env.context)) === null, { message: 'audio stopped' });
  await wakePage.waitForFunction(() => document.querySelector('#title').textContent === 'Snoozing');

  // Rings again after the snooze, with a fresh gentle ramp.
  await h.fastForward(env.context, 9);
  await h.waitFor(async () => (await h.session(env.context)).wake.status === 'ringing', { message: 're-ring' });
  const ramp = await h.waitFor(() => h.offscreenStatus(env.context));
  assert.ok(ramp.volume < 0.05);

  // "I'm awake" from the popup: audio stops, the video stays muted.
  await popup.click('#awake');
  const dismissed = await h.waitFor(async () => {
    const s = await h.session(env.context);
    return s.wake.status === 'dismissed' && s;
  });
  assert.equal(dismissed.wake.snoozeCount, 1);
  await h.waitFor(async () => (await h.offscreenStatus(env.context)) === null, { message: 'audio closed' });
  assert.deepEqual(await h.alarms(env.context), {});
  assert.equal((await h.videoState(video)).muted, true);
  assert.equal(
    (await h.swEval(env.context, () => chrome.notifications.getAll()))['st-wake'],
    undefined,
    'notification cleared',
  );
  await popup.waitForSelector('#view-done:not([hidden])');
  assert.equal(await popup.isVisible('#restore'), true);
  await wakePage.waitForSelector('#restore:not([hidden])');
  await wakePage.click('#restore');
  await h.waitFor(async () => !(await h.videoState(video)).muted, { message: 'sound restored' });
  assert.equal((await h.videoState(video)).volume, 0.8);
});

test('the wake alarm auto-stops after 15 minutes of ringing', async () => {
  const video = await h.openVideo(env.context);
  const popup = await h.openPopup(env.context, env.extensionId, video);
  await popup.click('#wake-section .switch');
  await popup.fill('#wake-time', h.clockIn(60));
  await armFromPopup(popup);
  const s = await h.session(env.context);
  await h.fastForward(env.context, Math.ceil((s.wake.nextRingAt - Date.now()) / MINUTE));
  await h.waitFor(async () => (await h.session(env.context)).wake.status === 'ringing', { message: 'ringing' });
  await h.fastForward(env.context, 15);
  await h.waitFor(async () => (await h.session(env.context)).wake.status === 'expired', { message: 'expired' });
  await h.waitFor(async () => (await h.offscreenStatus(env.context)) === null, { message: 'audio closed' });
});

test('an alarm that would ring 10+ minutes late is reported missed, never sounded', async () => {
  const video = await h.openVideo(env.context);
  const popup = await h.openPopup(env.context, env.extensionId, video);
  await popup.click('#wake-section .switch');
  await popup.fill('#wake-time', h.clockIn(90));
  await armFromPopup(popup);
  const s = await h.session(env.context);
  // As if the computer slept straight through the alarm.
  await h.fastForward(env.context, Math.ceil((s.wake.nextRingAt - Date.now()) / MINUTE) + 45);
  const missed = await h.session(env.context);
  assert.equal(missed.wake.status, 'missed');
  assert.equal(await h.offscreenStatus(env.context), null);
  assert.ok(missed.notices.some((n) => /missed your/.test(n.text)));
  await popup.waitForSelector('#view-done:not([hidden])');
  assert.equal(await popup.textContent('#done-label'), 'Wake alarm missed');
  assert.equal(await h.swEval(env.context, () => chrome.action.getBadgeText({})), '!');
});

test('closing the tab cancels only the fade and keeps the wake alarm', async () => {
  const video = await h.openVideo(env.context);
  const popup = await h.openPopup(env.context, env.extensionId, video);
  await popup.click('#wake-section .switch');
  await popup.fill('#wake-time', h.clockIn(120));
  await armFromPopup(popup);
  await video.close();
  const s = await h.waitFor(async () => {
    const cur = await h.session(env.context);
    return cur.fade.status === 'lost' && cur;
  }, { message: 'fade lost' });
  assert.equal(s.wake.status, 'scheduled');
  assert.ok(s.notices.some((n) => /tab was closed/.test(n.text)));
  const alarms = await h.alarms(env.context);
  assert.deepEqual(Object.keys(alarms), ['st:wake']);
  await popup.waitForSelector('#armed-notices li');
  assert.match(await popup.textContent('#armed-label'), /Wake alarm in/);
});

test('arming again asks before replacing the current night', async () => {
  const video = await h.openVideo(env.context);
  const popup = await h.openPopup(env.context, env.extensionId, video);
  await armFromPopup(popup);
  const first = await h.session(env.context);
  await popup.click('#new-night');
  await popup.waitForSelector('#replace-note:not([hidden])');
  await popup.click('#arm');
  await popup.waitForSelector('#replace-confirm:not([hidden])');
  assert.equal((await h.session(env.context)).id, first.id, 'not replaced without confirmation');
  await popup.click('#replace-yes');
  await popup.waitForSelector('#view-armed:not([hidden])');
  assert.notEqual((await h.session(env.context)).id, first.id);
});

test('popup shows the right countdown after a service worker restart', async () => {
  const video = await h.openVideo(env.context);
  const popup = await h.openPopup(env.context, env.extensionId, video);
  await popup.click('#wake-section .switch');
  await popup.fill('#wake-time', h.clockIn(120));
  await armFromPopup(popup);
  await popup.close();
  const tabId = await h.tabIdOf(env.context, video);
  const oldWorker = await h.serviceWorker(env.context);
  await oldWorker.evaluate(() => (self.__oldWorker = true));

  // Stop the service worker, as Chrome does when it is idle.
  const cdpPage = await env.context.newPage();
  const cdp = await env.context.newCDPSession(cdpPage);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'));
  await cdp.send('Target.closeTarget', { targetId: worker.targetId });
  await cdpPage.close();

  // Reopening the popup wakes a fresh worker, which reconciles from storage.
  const reopened = await h.openPopup(env.context, env.extensionId, tabId);
  await reopened.waitForSelector('#view-armed:not([hidden])');
  assert.equal(await h.swEval(env.context, () => self.__oldWorker === undefined), true, 'a fresh worker instance');
  assert.match(await reopened.textContent('#armed-big'), /^(19m|20m) \d\ds$/);
  const alarms = await h.alarms(env.context);
  assert.ok(alarms['st:fade-start'] && alarms['st:wake'], 'alarms survive');
});

test('Test wake sound plays the bundled chime and then stops by itself', async () => {
  const video = await h.openVideo(env.context);
  const popup = await h.openPopup(env.context, env.extensionId, video);
  await popup.click('#wake-section .switch');
  await popup.click('#test-sound');
  const status = await h.waitFor(() => h.offscreenStatus(env.context), { message: 'test audio' });
  assert.equal(status.playing, true);
  assert.equal(status.mode, 'test');
  assert.equal(await popup.getAttribute('#test-sound', 'aria-pressed'), 'true');
  await h.waitFor(async () => (await h.offscreenStatus(env.context)) === null, { timeout: 9000, message: 'test end' });
});

test('keep-awake holds the system awake until the alarm is dismissed', async () => {
  const video = await h.openVideo(env.context);
  const popup = await h.openPopup(env.context, env.extensionId, video);
  await popup.click('#wake-section .switch');
  await popup.fill('#wake-time', h.clockIn(120));
  await popup.check('#keep-awake'); // asks for the optional `power` permission
  await popup.waitForFunction(() => document.querySelector('#keep-awake').checked);
  assert.equal(await h.swEval(env.context, () => chrome.permissions.contains({ permissions: ['power'] })), true);

  // Record what SleepyTube asks of chrome.power.
  await h.swEval(env.context, () => {
    self.__power = [];
    const power = chrome.power;
    const request = power.requestKeepAwake.bind(power);
    const release = power.releaseKeepAwake.bind(power);
    power.requestKeepAwake = (level) => (self.__power.push(`request:${level}`), request(level));
    power.releaseKeepAwake = () => (self.__power.push('release'), release());
  });
  await armFromPopup(popup);
  assert.equal(await popup.isVisible('#armed-keep-awake'), true);
  assert.deepEqual(await h.swEval(env.context, () => self.__power), ['request:system']);

  const s = await h.session(env.context);
  await h.fastForward(env.context, Math.ceil((s.wake.nextRingAt - Date.now()) / MINUTE));
  await h.waitFor(async () => (await h.session(env.context)).wake.status === 'ringing', { message: 'ringing' });
  assert.equal(await h.swEval(env.context, () => self.__power.at(-1)), 'request:system', 'held while ringing');
  await popup.click('#awake');
  await h.waitFor(() => h.swEval(env.context, () => self.__power.at(-1) === 'release'), { message: 'released' });
});

test('the wake time can be changed from the armed view', async () => {
  const video = await h.openVideo(env.context);
  const popup = await h.openPopup(env.context, env.extensionId, video);
  await popup.click('#wake-section .switch');
  await popup.fill('#wake-time', h.clockIn(120));
  await armFromPopup(popup);
  await popup.click('#change-wake');
  await popup.waitForSelector('#wake-editor:not([hidden])');
  assert.equal(await popup.isVisible('#armed-actions'), false);
  const newTime = h.clockIn(180);
  await popup.fill('#wake-time', newTime);
  await popup.click('#editor-save');
  const s = await h.waitFor(async () => {
    const cur = await h.session(env.context);
    return cur.wake.time === newTime && cur;
  }, { message: 'wake updated' });
  await h.waitFor(
    async () => Math.abs((await h.alarms(env.context))['st:wake'] - s.wake.nextRingAt) <= 1000,
    { message: 'alarm rescheduled' },
  );
  await popup.waitForSelector('#wake-editor', { state: 'hidden' });

  // A wake time inside the fade is refused here too.
  await popup.click('#change-wake');
  await popup.fill('#wake-time', h.clockIn(5));
  await popup.click('#editor-save');
  await popup.waitForSelector('#armed-error:not([hidden])');
  assert.match(await popup.textContent('#armed-error'), /before the fade finishes/);
  assert.equal((await h.session(env.context)).wake.time, newTime);
});

async function armWithWake(popup, minutesAhead) {
  await popup.click('#wake-section .switch');
  await popup.fill('#wake-time', h.clockIn(minutesAhead));
  await armFromPopup(popup);
}

test('+15 minutes after the video is muted brings the sound back and keeps it', async () => {
  const video = await h.openVideo(env.context, { volume: 0.8 });
  const popup = await h.openPopup(env.context, env.extensionId, video);
  await armWithWake(popup, 180);
  await h.fastForward(env.context, 36);
  await h.waitFor(async () => (await h.videoState(video)).muted, { message: 'muted' });
  await popup.click('#extend');
  await h.waitFor(async () => !(await h.videoState(video)).muted, { message: 'unmuted' });
  await video.waitForTimeout(1500); // nothing may mute it again
  const state = await h.videoState(video);
  assert.equal(state.muted, false);
  assert.equal(state.volume, 0.8);
  const s = await h.session(env.context);
  near(s.fade.fadeStartAt - Date.now(), 15 * MINUTE, 3000, 'new countdown');
});

test('after the night, turning the volume up unmutes the video', async () => {
  const video = await h.openVideo(env.context, { volume: 0.8 });
  const popup = await h.openPopup(env.context, env.extensionId, video);
  await armFromPopup(popup);
  await h.fastForward(env.context, 36);
  await popup.waitForSelector('#view-done:not([hidden])');
  await popup.click('#done'); // leaves the video muted
  await popup.waitForSelector('#view-setup:not([hidden])');
  assert.equal((await h.videoState(video)).muted, true);
  await video.click('#louder'); // YouTube's slider doesn't know the video is muted
  await h.waitFor(async () => !(await h.videoState(video)).muted, { message: 'audible again' });
  assert.equal((await h.videoState(video)).volume, 0.9);
});

test('a missed alarm stays reported even when the YouTube tab is gone', async () => {
  const video = await h.openVideo(env.context);
  const popup = await h.openPopup(env.context, env.extensionId, video);
  await armWithWake(popup, 90);
  // As after a browser restart: the stored tab no longer exists.
  await h.swEval(env.context, async () => {
    const { session } = await chrome.storage.local.get('session');
    session.fade.tabId = 987654;
    session.fade.fadeStartAt -= 40 * 60000;
    session.fade.fadeEndAt -= 40 * 60000;
    session.fade.muteAt -= 40 * 60000;
    await chrome.storage.local.set({ session });
  });
  const s = await h.session(env.context);
  await h.fastForward(env.context, Math.ceil((s.wake.nextRingAt - Date.now()) / MINUTE) + 45);
  const after = await h.session(env.context);
  assert.ok(after, 'the night is kept so the miss can be reported');
  assert.equal(after.wake.status, 'missed');
  await popup.waitForSelector('#view-done:not([hidden])');
  assert.equal(await popup.textContent('#done-label'), 'Wake alarm missed');
});

test('replacing the night from another tab leaves the first video as it is', async () => {
  const first = await h.openVideo(env.context, { volume: 0.8 });
  const popup = await h.openPopup(env.context, env.extensionId, first);
  await armFromPopup(popup);
  await h.fastForward(env.context, 26);
  await first.waitForTimeout(600);
  const faded = (await h.videoState(first)).volume;
  assert.ok(faded < 0.5);

  const second = await h.openVideo(env.context, { volume: 0.7, id: 'second' });
  const popup2 = await h.openPopup(env.context, env.extensionId, second);
  await popup2.click('#new-night');
  await popup2.click('#arm');
  await popup2.click('#replace-yes');
  await popup2.waitForSelector('#view-armed:not([hidden])');
  await first.waitForTimeout(800);
  near((await h.videoState(first)).volume, faded, 0.02, 'first tab not turned back up');
  assert.equal((await h.session(env.context)).fade.originalVolume, 0.7);
});

test('turning the sound up once the alarm rings ends the fade instead of asking to resume', async () => {
  const video = await h.openVideo(env.context, { volume: 0.8 });
  const popup = await h.openPopup(env.context, env.extensionId, video);
  await armWithWake(popup, 60);
  const s = await h.session(env.context);
  await h.fastForward(env.context, Math.ceil((s.wake.nextRingAt - Date.now()) / MINUTE));
  await h.waitFor(async () => (await h.session(env.context)).wake.status === 'ringing', { message: 'ringing' });
  await video.click('#louder');
  await h.waitFor(async () => (await h.session(env.context)).fade.status === 'restored', { message: 'fade ended' });
  assert.equal((await h.videoState(video)).muted, false);
  await popup.click('#awake');
  await popup.waitForSelector('#view-done:not([hidden])');
  assert.equal(await popup.isVisible('#restore'), false);
  await popup.waitForFunction(() => document.activeElement.id === 'done-label'); // focus follows the result
});
