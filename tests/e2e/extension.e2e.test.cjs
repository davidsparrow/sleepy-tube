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

test.beforeEach(async () => {
  await h.resetNight(env.context);
  for (const page of env.context.pages()) {
    if (!page.url().startsWith('about:')) await page.close();
  }
});

test.afterEach(() => {
  const errors = env.errors.splice(0);
  assert.deepEqual(errors, [], 'no errors from the service worker or extension pages');
});

function near(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ≈${expected}, got ${actual}`);
}

const badge = () => h.swEval(env.context, () => chrome.action.getBadgeText({}));

async function fadeOn(popup) {
  await popup.click('#fade-switch');
  await popup.waitForSelector('#fader.on');
}

/** Switches the alarm on and moves it `minutesAhead` from now via the picker. */
async function alarmOn(popup, minutesAhead) {
  await popup.click('#alarm-switch');
  await popup.waitForSelector('#alarm.on');
  if (minutesAhead != null) {
    const at = h.minutesFromNow(minutesAhead);
    await h.pickWakeTime(popup, at);
    await h.waitFor(async () => (await h.session(env.context)).wake.nextRingAt === at, { message: 'alarm time' });
  }
  return (await h.session(env.context)).wake;
}

async function ringNow() {
  const s = await h.session(env.context);
  await h.fastForward(env.context, Math.ceil((s.wake.nextRingAt - Date.now()) / MINUTE));
  return h.waitFor(async () => {
    const cur = await h.session(env.context);
    return cur.wake && cur.wake.status === 'ringing' && cur;
  }, { message: 'ringing' });
}

async function setup({ volume = 0.8 } = {}) {
  const video = await h.openVideo(env.context, { volume });
  const popup = await h.openPopup(env.context, env.extensionId, video);
  return { video, popup };
}

// --- Fade to Sleep -----------------------------------------------------------------

test('without a YouTube video, Fade to Sleep is unavailable but the alarm works', async () => {
  const popup = await h.openPopup(env.context, env.extensionId, null);
  await popup.waitForFunction(() => document.querySelector('#fade-hint').textContent === 'Open a YouTube video first');
  assert.equal(await popup.getAttribute('#fade-switch', 'aria-disabled'), 'true');
  await popup.click('#fade-switch', { force: true }); // aria-disabled: explains instead of acting
  await popup.waitForSelector('#fade-error:not([hidden])');
  assert.equal(await h.session(env.context), null);
  // The alarm doesn't need a video.
  await alarmOn(popup);
  const s = await h.session(env.context);
  assert.equal(s.fade, null);
  assert.equal(s.wake.status, 'scheduled');
});

test('one click starts the default night: countdown, fade, whisper, silence', async () => {
  const { video, popup } = await setup();
  const other = await h.openVideo(env.context, { volume: 0.6, id: 'other' });
  assert.equal(await popup.isVisible('#row-fade'), false, 'off: only the countdown row');
  assert.match(await popup.textContent('#delay-meta'), /^fade begins @ \d{1,2}:\d\d\s[ap]m$/);
  assert.match(await popup.textContent('#silence-preview'), /^silence @/);

  await fadeOn(popup); // a single interaction after opening the popup
  const s = await h.session(env.context);
  assert.equal(s.fade.originalVolume, 0.8);
  assert.equal(s.fade.fadeStartAt - s.fade.delayStartedAt, 20 * MINUTE);
  assert.equal(s.fade.fadeEndAt - s.fade.fadeStartAt, 10 * MINUTE);
  assert.equal(s.fade.muteAt - s.fade.fadeEndAt, 10 * MINUTE);
  assert.deepEqual(Object.keys(await h.alarms(env.context)).sort(), ['st:fade-mute', 'st:fade-start', 'st:fade-whisper']);
  assert.equal(await popup.isVisible('#row-whisper'), true);
  assert.equal(await popup.isVisible('#fade-actions'), true);
  assert.match(await popup.textContent('#row-delay .left-time'), /^(19m|20m) \d\ds$/);
  assert.equal(await badge(), '☾');

  await h.fastForward(env.context, 10);
  await video.waitForTimeout(400);
  assert.equal((await h.videoState(video)).volume, 0.8, 'countdown leaves the volume alone');

  await h.fastForward(env.context, 15); // halfway through the fade
  await video.waitForTimeout(600);
  near((await h.videoState(video)).volume, 0.8 * Math.sqrt(0.04), 0.01, 'mid-fade volume');
  await popup.waitForSelector('#row-fade.current');
  assert.equal(await popup.getAttribute('#row-delay .chips', 'aria-disabled'), 'true', 'countdown chips locked');

  await h.fastForward(env.context, 5); // whisper
  await video.waitForTimeout(600);
  let state = await h.videoState(video);
  near(state.volume, 0.8 * 0.04, 0.001, 'whisper volume');
  assert.equal(state.muted, false);

  await h.fastForward(env.context, 10); // silence
  state = await h.waitFor(async () => {
    const st = await h.videoState(video);
    return st.muted && st;
  }, { message: 'muted' });
  assert.equal(state.paused, false);
  assert.equal(state.rate, 1);
  assert.deepEqual(state.yt, { mute: 0, unmute: 0 }, "YouTube's own player settings untouched");
  const untouched = await h.videoState(other);
  assert.deepEqual([untouched.volume, untouched.muted], [0.6, false], 'other tab untouched');
  await popup.waitForFunction(() => /^Silent since/.test(document.querySelector('#fade-hint').textContent));
  assert.equal(await popup.getAttribute('#fade-switch', 'aria-checked'), 'true', 'still on while silent');
  assert.equal(await popup.isDisabled('[data-extend="10"]'), true, '+10 is off once silent');
  assert.equal(await badge(), '');

  // Switching it off brings the sound back.
  await popup.click('#fade-switch');
  await popup.waitForSelector('#fader:not(.on)');
  state = await h.videoState(video);
  assert.deepEqual([state.volume, state.muted], [0.8, false]);
  assert.equal(await h.session(env.context), null);
});

test('chips re-plan the night while on; started steps are locked', async () => {
  const { popup } = await setup();
  await fadeOn(popup);
  const before = await h.session(env.context);
  await popup.click('#row-delay .chips [data-value="30"]');
  let s = await h.waitFor(async () => {
    const cur = await h.session(env.context);
    return cur.fade.delayMinutes === 30 && cur;
  });
  assert.equal(s.fade.fadeStartAt, before.fade.delayStartedAt + 30 * MINUTE);
  await popup.click('#row-fade .chips [data-value="20"]');
  await popup.click('#row-whisper .chips [data-value="15"]');
  s = await h.waitFor(async () => {
    const cur = await h.session(env.context);
    return cur.fade.whisperMinutes === 15 && cur;
  });
  assert.equal(s.fade.fadeEndAt - s.fade.fadeStartAt, 20 * MINUTE);
  assert.equal(s.fade.muteAt - s.fade.fadeEndAt, 15 * MINUTE);
  await h.waitFor(async () => Math.abs((await h.alarms(env.context))['st:fade-mute'] - s.fade.muteAt) <= 1000, {
    message: 'mute alarm moved',
  });
  const stored = await h.swEval(env.context, async () => (await chrome.storage.local.get('settings')).settings);
  assert.deepEqual([stored.delayMinutes, stored.fadeMinutes, stored.whisperMinutes], [30, 20, 15], 'remembered');

  // Quick successive clicks are queued, not dropped: the last one wins.
  await popup.click('#row-fade .chips [data-value="15"]');
  await popup.click('#row-fade .chips [data-value="30"]');
  await h.waitFor(async () => (await h.session(env.context)).fade.fadeMinutes === 30, { message: 'last click wins' });

  // Keyboard: arrows move along a chip row.
  await popup.focus('#row-whisper .chips [aria-checked="true"]');
  await popup.keyboard.press('ArrowRight');
  await h.waitFor(async () => (await h.session(env.context)).fade.whisperMinutes === 20, { message: 'arrow key' });

  await h.fastForward(env.context, 31); // fading
  await popup.click('#row-delay .chips [data-value="10"]', { force: true });
  await popup.waitForSelector('#fade-error:not([hidden])');
  assert.equal((await h.session(env.context)).fade.delayMinutes, 30, 'countdown locked once fading');
});

test('+10 keeps the current step going: countdown, fade (no jump), whisper', async () => {
  const { video, popup } = await setup();
  await fadeOn(popup);
  let s = await h.session(env.context);
  await popup.click('[data-extend="10"]');
  let t = await h.waitFor(async () => {
    const cur = await h.session(env.context);
    return cur.fade.fadeStartAt !== s.fade.fadeStartAt && cur;
  });
  assert.equal(t.fade.fadeStartAt - s.fade.fadeStartAt, 10 * MINUTE);
  assert.equal(t.fade.muteAt - s.fade.muteAt, 10 * MINUTE);

  await h.fastForward(env.context, 34); // 4 minutes into the fade
  await video.waitForTimeout(600);
  const before = (await h.videoState(video)).volume;
  s = await h.session(env.context);
  await popup.click('[data-extend="20"]');
  t = await h.waitFor(async () => {
    const cur = await h.session(env.context);
    return cur.fade.fadeEndAt !== s.fade.fadeEndAt && cur;
  });
  assert.equal(t.fade.fadeEndAt - s.fade.fadeEndAt, 20 * MINUTE);
  await video.waitForTimeout(600);
  near((await h.videoState(video)).volume, before, 0.01, 'no jump in volume');

  await h.fastForward(env.context, 27); // whisper
  s = await h.session(env.context);
  await popup.click('[data-extend="10"]');
  t = await h.waitFor(async () => {
    const cur = await h.session(env.context);
    return cur.fade.muteAt !== s.fade.muteAt && cur;
  });
  assert.equal(t.fade.muteAt - s.fade.muteAt, 10 * MINUTE);
  assert.equal(t.fade.fadeEndAt, s.fade.fadeEndAt);
});

test('Restart brings the volume back and counts down again from now', async () => {
  const { video, popup } = await setup();
  await fadeOn(popup);
  await h.fastForward(env.context, 41); // silent
  await h.waitFor(async () => (await h.videoState(video)).muted, { message: 'muted' });
  await popup.click('#restart');
  await h.waitFor(async () => !(await h.videoState(video)).muted, { message: 'sound back' });
  await video.waitForTimeout(1500); // nothing may mute it again
  const state = await h.videoState(video);
  assert.deepEqual([state.volume, state.muted], [0.8, false]);
  const s = await h.session(env.context);
  near(s.fade.fadeStartAt - Date.now(), 20 * MINUTE, 3000, 'new countdown');
});

test('Cancel stops the fade and restores the volume', async () => {
  const { video, popup } = await setup();
  await fadeOn(popup);
  await h.fastForward(env.context, 25);
  await video.waitForTimeout(600);
  assert.ok((await h.videoState(video)).volume < 0.5);
  await popup.click('#fade-cancel');
  await popup.waitForSelector('#fader:not(.on)');
  assert.deepEqual(await h.videoState(video).then((s) => [s.volume, s.muted]), [0.8, false]);
  assert.deepEqual(await h.alarms(env.context), {});
});

test('YouTube resetting the volume, or swapping the player, does not undo the fade', async () => {
  const { video, popup } = await setup();
  await fadeOn(popup);
  await h.fastForward(env.context, 41);
  await h.waitFor(async () => (await h.videoState(video)).muted, { message: 'muted' });
  await video.evaluate(() => {
    const v = document.querySelector('#movie_player video');
    v.muted = false;
    v.volume = 1;
  });
  await h.waitFor(async () => (await h.videoState(video)).muted, { message: 're-muted' });
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
});

test('a reload mid-fade reattaches and keeps the original timeline', async () => {
  const { video, popup } = await setup();
  await fadeOn(popup);
  await h.fastForward(env.context, 25);
  await video.reload();
  await video.click('#play');
  await video.waitForTimeout(800);
  near((await h.videoState(video)).volume, 0.8 * Math.sqrt(0.04), 0.01, 'volume after reload');
});

test('a user volume change pauses the fade; Resume fades from the new volume', async () => {
  const { video, popup } = await setup();
  await fadeOn(popup);
  await h.fastForward(env.context, 25);
  await video.waitForTimeout(500);
  await video.click('#louder'); // a real click: the user's own change
  await popup.waitForSelector('#override:not([hidden])');
  await video.waitForTimeout(700);
  assert.equal((await h.videoState(video)).volume, 0.9, 'SleepyTube does not fight the user');
  assert.equal(await badge(), '!');
  assert.equal(await popup.isDisabled('[data-extend="10"]'), true);
  await popup.click('#resume');
  const s = await h.waitFor(async () => {
    const cur = await h.session(env.context);
    return cur.fade.status === 'active' && cur;
  });
  assert.equal(s.fade.startVolume, 0.9);
  near(s.fade.fadeStartAt, Date.now(), 3000, 'fade restarts now');
  assert.equal(s.fade.fadeEndAt - s.fade.fadeStartAt, 10 * MINUTE);
  assert.equal(s.fade.originalVolume, 0.8, 'switching off still restores the original volume');
});

test('a volume change before the fade becomes the new starting volume', async () => {
  const { video, popup } = await setup({ volume: 0.5 });
  await fadeOn(popup);
  await video.click('#louder');
  const s = await h.waitFor(async () => {
    const cur = await h.session(env.context);
    return cur.fade.startVolume === 0.9 && cur;
  }, { message: 'baseline update' });
  assert.equal(s.fade.status, 'active');
  assert.equal(s.fade.originalVolume, 0.9);
});

test('closing the tab switches off only the fade, with a notice', async () => {
  const { video, popup } = await setup();
  await alarmOn(popup, 180);
  await fadeOn(popup);
  await video.close();
  const s = await h.waitFor(async () => {
    const cur = await h.session(env.context);
    return cur && cur.fade === null && cur;
  }, { message: 'fade off' });
  assert.equal(s.wake.status, 'scheduled');
  assert.ok((await h.notices(env.context)).some((n) => /tab was closed/.test(n.text)));
  assert.deepEqual(Object.keys(await h.alarms(env.context)), ['st:wake']);
  await popup.waitForSelector('#notices li');
  await popup.waitForSelector('#fader:not(.on)');
  assert.equal(await badge(), '!');
  await popup.click('#notices li button');
  await h.waitFor(async () => (await h.notices(env.context)).length === 0, { message: 'notice dismissed' });
});

test('popup shows the right countdown after a service worker restart', async () => {
  const { video, popup } = await setup();
  await alarmOn(popup, 300);
  await fadeOn(popup);
  await popup.close();
  const tabId = await h.tabIdOf(env.context, video);
  const oldWorker = await h.serviceWorker(env.context);
  await oldWorker.evaluate(() => (self.__oldWorker = true));
  const cdpPage = await env.context.newPage();
  const cdp = await env.context.newCDPSession(cdpPage);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'));
  await cdp.send('Target.closeTarget', { targetId: worker.targetId });
  await cdpPage.close();

  const reopened = await h.openPopup(env.context, env.extensionId, tabId);
  await reopened.waitForSelector('#fader.on');
  assert.equal(await h.swEval(env.context, () => self.__oldWorker === undefined), true, 'a fresh worker');
  assert.match(await reopened.textContent('#row-delay .left-time'), /^(19m|20m) \d\ds$/);
  const alarms = await h.alarms(env.context);
  assert.ok(alarms['st:fade-start'] && alarms['st:wake'], 'alarms survive');
});

// --- Alarm ---------------------------------------------------------------------------

test('alarm time: ±10, the picker, 24-hour limit, and after silence', async () => {
  const { popup } = await setup();
  const wake = await alarmOn(popup, 120);
  assert.match(await popup.textContent('#wake-display'), /^\d{1,2}:\d\d\s[ap]m, \w{3} \w{3} \d{1,2}$/);
  assert.equal(await popup.isEnabled('#pick-time'), true);
  await popup.click('#wake-plus');
  await h.waitFor(async () => (await h.session(env.context)).wake.nextRingAt === wake.nextRingAt + 10 * MINUTE);
  await popup.click('#wake-minus');
  await popup.click('#wake-minus');
  const s = await h.waitFor(async () => {
    const cur = await h.session(env.context);
    return cur.wake.nextRingAt === wake.nextRingAt - 10 * MINUTE && cur;
  });
  near((await h.alarms(env.context))['st:wake'], s.wake.nextRingAt, 1000, 'alarm rescheduled');
  const remembered = await h.swEval(env.context, async () => (await chrome.storage.local.get('settings')).settings.wakeTime);
  assert.match(remembered, /^\d\d:\d\d$/);

  await h.pickWakeTime(popup, Date.now() + 26 * 60 * MINUTE);
  await popup.waitForSelector('#alarm-error:not([hidden])');
  assert.match(await popup.textContent('#alarm-error'), /next 24 hours/);

  // With the fade on, the alarm must be after silence (20 + 10 + 10 minutes).
  await fadeOn(popup);
  await h.pickWakeTime(popup, h.minutesFromNow(30));
  await popup.waitForSelector('#alarm-error:not([hidden])');
  assert.match(await popup.textContent('#alarm-error'), /before the video goes silent/);
  // ...and the fade can't be stretched past the alarm.
  await h.pickWakeTime(popup, h.minutesFromNow(45));
  await h.waitFor(async () => !(await popup.isVisible('#alarm-error')), { message: 'accepted' });
  await popup.click('[data-extend="20"]');
  await popup.waitForSelector('#fade-error:not([hidden])');
  assert.match(await popup.textContent('#fade-error'), /after your .* alarm/);
});

test('alarm: rings from bundled audio, snoozes 9 minutes, and dismisses', async () => {
  const { video, popup } = await setup();
  await alarmOn(popup, 120);
  await fadeOn(popup);
  assert.match(await popup.textContent('#wake-meta'), /Chrome must stay open; computer must stay awake/);
  const ringing = await ringNow();
  assert.equal(ringing.wake.audioError, null);

  const audio = await h.waitFor(() => h.offscreenStatus(env.context), { message: 'offscreen audio' });
  assert.equal(audio.playing, true);
  assert.equal(audio.mode, 'wake');
  assert.ok(audio.volume < 0.05, `starts quiet (${audio.volume})`);
  assert.equal((await h.videoState(video)).muted, true, 'the video stays muted');
  const wakePage = await h.waitFor(() => env.context.pages().find((p) => p.url().endsWith('/wake/wake.html')), {
    message: 'wake window',
  });
  await wakePage.waitForSelector('#snooze:not([hidden])');
  assert.ok((await h.swEval(env.context, () => chrome.notifications.getAll()))['st-wake']);
  assert.equal(await badge(), '☀');
  await popup.waitForSelector('#alarm-ringing:not([hidden])');

  // A duplicate alarm event / worker restart must not start a second ring.
  await h.swEval(env.context, () => self.sleepyDebug.reconcile());
  assert.equal((await h.session(env.context)).wake.ringStartedAt, ringing.wake.ringStartedAt);

  await wakePage.click('#snooze');
  const snoozed = await h.waitFor(async () => {
    const s = await h.session(env.context);
    return s.wake.status === 'snoozed' && s;
  });
  near(snoozed.wake.nextRingAt - Date.now(), 9 * MINUTE, 3000, 'snooze length');
  await h.waitFor(async () => (await h.offscreenStatus(env.context)) === null, { message: 'audio stopped' });
  await popup.waitForFunction(() => document.querySelector('#ring-title').textContent === 'Snoozing');

  await h.fastForward(env.context, 9);
  await h.waitFor(async () => (await h.session(env.context)).wake.status === 'ringing', { message: 're-ring' });
  assert.ok((await h.waitFor(() => h.offscreenStatus(env.context))).volume < 0.05, 'fresh gentle ramp');

  await popup.click('#awake');
  await h.waitFor(async () => (await h.session(env.context)).wake === null, { message: 'alarm off' });
  await h.waitFor(async () => (await h.offscreenStatus(env.context)) === null, { message: 'audio closed' });
  assert.deepEqual(await h.alarms(env.context), {});
  assert.equal((await h.videoState(video)).muted, true, 'dismissing never restores the sound');
  assert.equal((await h.swEval(env.context, () => chrome.notifications.getAll()))['st-wake'], undefined);
  await popup.waitForSelector('#alarm:not(.on)');
  await popup.waitForFunction(() => document.activeElement.id === 'alarm-switch', null, { timeout: 3000 });

  await wakePage.waitForSelector('#restore:not([hidden])');
  await wakePage.click('#restore');
  await h.waitFor(async () => !(await h.videoState(video)).muted, { message: 'sound restored' });
  assert.equal((await h.videoState(video)).volume, 0.8);
});

test('an alarm-only night rings without any YouTube tab', async () => {
  const popup = await h.openPopup(env.context, env.extensionId, null);
  await alarmOn(popup, 60);
  await ringNow();
  const audio = await h.waitFor(() => h.offscreenStatus(env.context), { message: 'offscreen audio' });
  assert.equal(audio.playing, true);
  await popup.click('#alarm-switch'); // switching off while ringing = I'm awake
  await h.waitFor(async () => (await h.session(env.context)) === null, { message: 'night over' });
  await h.waitFor(async () => (await h.offscreenStatus(env.context)) === null, { message: 'audio closed' });
});

test('the alarm stops by itself after 15 minutes of ringing', async () => {
  const popup = await h.openPopup(env.context, env.extensionId, null);
  await alarmOn(popup, 60);
  await ringNow();
  await h.fastForward(env.context, 15);
  await h.waitFor(async () => (await h.session(env.context)) === null, { message: 'expired' });
  await h.waitFor(async () => (await h.offscreenStatus(env.context)) === null, { message: 'audio closed' });
  assert.ok((await h.notices(env.context)).some((n) => /15 minutes/.test(n.text)));
});

test('an alarm 10+ minutes late is reported missed, never sounded', async () => {
  const { popup } = await setup();
  await alarmOn(popup, 90);
  await fadeOn(popup);
  // As if the computer slept straight through it, and the tab is gone too.
  await h.swEval(env.context, async () => {
    const { session } = await chrome.storage.local.get('session');
    session.fade.tabId = 987654;
    await chrome.storage.local.set({ session });
  });
  const s = await h.session(env.context);
  await h.fastForward(env.context, Math.ceil((s.wake.nextRingAt - Date.now()) / MINUTE) + 45);
  assert.equal(await h.offscreenStatus(env.context), null);
  assert.equal(await h.session(env.context), null);
  const notices = await h.notices(env.context);
  assert.ok(notices.some((n) => /missed your/.test(n.text)), 'missed alarm reported');
  await popup.waitForFunction(() => /missed your/.test(document.querySelector('#notices').textContent));
  await popup.waitForSelector('#alarm:not(.on)');
  assert.equal(await badge(), '!');
});

test('turning the sound up after the alarm ends the fade instead of asking to resume', async () => {
  const { video, popup } = await setup();
  await alarmOn(popup, 60);
  await fadeOn(popup);
  await ringNow();
  await video.click('#louder');
  await h.waitFor(async () => (await h.session(env.context)).fade === null, { message: 'fade off' });
  assert.equal((await h.videoState(video)).muted, false);
  await popup.waitForSelector('#fader:not(.on)');
  assert.equal(await popup.isVisible('#override'), false);
});

test('after the night, YouTube controls still bring the sound back', async () => {
  const { video, popup } = await setup();
  await alarmOn(popup, 60);
  await fadeOn(popup);
  await ringNow();
  await popup.click('#awake');
  await h.waitFor(async () => (await h.session(env.context)).wake === null, { message: 'dismissed' });
  assert.equal((await h.videoState(video)).muted, true);
  await video.click('#louder'); // YouTube's slider doesn't know the video is muted
  await h.waitFor(async () => !(await h.videoState(video)).muted, { message: 'audible again' });
  assert.equal((await h.videoState(video)).volume, 0.9);
  await h.waitFor(async () => (await h.session(env.context)) === null, { message: 'night over' });
});

test('Test ▶ plays the bundled chime and then stops by itself', async () => {
  const popup = await h.openPopup(env.context, env.extensionId, null);
  await popup.click('#test-sound');
  const status = await h.waitFor(() => h.offscreenStatus(env.context), { message: 'test audio' });
  assert.equal(status.playing, true);
  assert.equal(status.mode, 'test');
  assert.equal(await popup.getAttribute('#test-sound', 'aria-pressed'), 'true');
  await h.waitFor(async () => (await h.offscreenStatus(env.context)) === null, { timeout: 9000, message: 'test end' });
});

test('limitations: keep-awake holds the system awake until the alarm is dismissed', async () => {
  const popup = await h.openPopup(env.context, env.extensionId, null);
  await popup.click('#limits-link');
  await popup.waitForSelector('#limits[open]');
  assert.match(await popup.textContent('#limits .disclosure'), /cannot wake your computer from sleep/);
  await popup.click('#keep-awake'); // asks for the optional `power` permission
  await popup.waitForSelector('#keep-awake[aria-checked="true"]');
  assert.equal(await h.swEval(env.context, () => chrome.permissions.contains({ permissions: ['power'] })), true);
  await popup.click('#limits-close');

  await h.swEval(env.context, () => {
    self.__power = [];
    const power = chrome.power;
    const request = power.requestKeepAwake.bind(power);
    const release = power.releaseKeepAwake.bind(power);
    power.requestKeepAwake = (level) => (self.__power.push(`request:${level}`), request(level));
    power.releaseKeepAwake = () => (self.__power.push('release'), release());
  });
  await alarmOn(popup, 60);
  assert.equal(await h.swEval(env.context, () => self.__power.at(-1)), 'request:system');
  assert.match(await popup.textContent('#wake-meta'), /Keeping the computer awake/);
  await ringNow();
  assert.equal(await h.swEval(env.context, () => self.__power.at(-1)), 'request:system', 'held while ringing');
  await popup.click('#awake');
  await h.waitFor(() => h.swEval(env.context, () => self.__power.at(-1) === 'release'), { message: 'released' });
});

test('How it works opens the info page', async () => {
  const popup = await h.openPopup(env.context, env.extensionId, null);
  const [info] = await Promise.all([env.context.waitForEvent('page'), popup.click('#info-link')]);
  await info.waitForLoadState();
  assert.match(info.url(), /\/info\/info\.html$/);
  assert.equal(await info.textContent('h1'), 'How SleepyTube works');
  assert.equal(await info.locator('button, input').count(), 0, 'no controls on the info page');
});
