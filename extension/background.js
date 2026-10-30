/*
 * SleepyTube service worker.
 *
 * Owns the single night (PRD R8): the Fade to Sleep and Alarm switches are
 * two independent parts of one session in chrome.storage.local. Transitions
 * are scheduled with chrome.alarms, the wake chime plays from an offscreen
 * document, and everything is reconciled whenever the worker starts.
 * In-memory state is never trusted to survive a restart (PRD R6), and every
 * handler is idempotent, so duplicate alarm events cannot double-ring.
 */
importScripts('lib/core.js');

const core = self.SleepyCore;
const { FADE, WAKE, STATE, MINUTE } = core;

const KEY_SESSION = 'session';
const KEY_SETTINGS = 'settings';
const KEY_NOTICES = 'notices';
const MAX_NOTICES = 4;
// Times-only record of recent alarm events, read back during overnight QA.
const KEY_ALARM_LOG = 'alarmLog';
const MAX_ALARM_LOG = 20;

const ALARM_PREFIX = 'st:';
const ALARM_FADE = { start: 'st:fade-start', whisper: 'st:fade-whisper', mute: 'st:fade-mute' };
const ALARM_WAKE = 'st:wake';
const ALARM_WAKE_STOP = 'st:wake-stop';

const NOTIFY_WAKE = 'st-wake';
const NOTIFY_INFO = 'st-info';

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const WAKE_PAGE_URL = 'wake/wake.html';
const CONTENT_FILES = ['lib/core.js', 'content/content.js'];
const ICON_URL = 'icons/icon-128.png';
// A frozen or hung YouTube tab must never stall the queue (e.g. Snooze).
const TAB_CALL_TIMEOUT_MS = 3000;

const BADGE = {
  armed: { text: '☾', color: '#4b3f9e', title: 'SleepyTube: night is set' },
  waking: { text: '☀', color: '#b86200', title: 'SleepyTube: wake alarm' },
  attention: { text: '!', color: '#b3261e', title: 'SleepyTube: needs your attention' },
  idle: { text: '', color: '#4b3f9e', title: 'SleepyTube' },
};

// --- Small helpers -----------------------------------------------------------

/** Runs state-changing work one task at a time so events cannot interleave. */
let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn);
  queue = run.catch((error) => console.error('SleepyTube:', error));
  return run;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves to `fallback` if `promise` takes longer than `ms`. */
function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, delay(ms).then(() => fallback)]);
}

function fail(code, message) {
  return { ok: false, code, message };
}

const newId = () => crypto.randomUUID();
const clock = (ms) => core.formatClockShort(ms);

async function loadSession() {
  const { [KEY_SESSION]: session = null } = await chrome.storage.local.get(KEY_SESSION);
  if (session && session.v !== core.SESSION_VERSION) return null; // from an older build
  return session;
}

async function saveSession(session) {
  await chrome.storage.local.set({ [KEY_SESSION]: session });
  await updateBadge(session);
}

async function clearSession() {
  await chrome.storage.local.remove(KEY_SESSION);
  await updateBadge(null);
}

function newSession(now) {
  return { v: core.SESSION_VERSION, id: newId(), armedAt: now, fade: null, wake: null };
}

/** Saves the session, or drops it once both switches are off. */
async function commit(session) {
  if (!session || (!core.fadeIsOn(session.fade) && !core.wakeIsOn(session.wake))) {
    await clearSession();
    session = null;
  } else {
    await saveSession(session);
  }
  await syncAlarms(session);
  await syncKeepAwake(session);
  return session;
}

async function loadSettings() {
  const { [KEY_SETTINGS]: stored = {} } = await chrome.storage.local.get(KEY_SETTINGS);
  return { ...core.DEFAULT_SETTINGS, ...stored };
}

async function loadNotices() {
  const { [KEY_NOTICES]: notices = [] } = await chrome.storage.local.get(KEY_NOTICES);
  return notices;
}

/** Notices outlive the session: "tab closed", "alarm missed", and so on. */
async function addNotice(text) {
  const notices = (await loadNotices()).filter((n) => n.text !== text);
  notices.push({ id: newId(), text, at: Date.now() });
  await chrome.storage.local.set({ [KEY_NOTICES]: notices.slice(-MAX_NOTICES) });
}

/** Appends to the alarm log: what happened, when it was due, and when it happened. */
async function logAlarm(event, wake, extra = {}) {
  const { [KEY_ALARM_LOG]: log = [] } = await chrome.storage.local.get(KEY_ALARM_LOG);
  log.push({ event, dueAt: wake.nextRingAt, at: Date.now(), snoozes: wake.snoozeCount || 0, ...extra });
  await chrome.storage.local.set({ [KEY_ALARM_LOG]: log.slice(-MAX_ALARM_LOG) });
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

function sendToTab(tabId, message) {
  const sent = chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => null);
  return withTimeout(sent, TAB_CALL_TIMEOUT_MS, null);
}

function injectContentScript(tabId) {
  const injected = chrome.scripting
    .executeScript({ target: { tabId }, files: CONTENT_FILES })
    .then(() => true, () => false);
  return withTimeout(injected, TAB_CALL_TIMEOUT_MS, false);
}

/** Asks the tab's content script about its video, injecting it if needed. */
async function probeTab(tabId) {
  const tab = await getTab(tabId);
  if (!tab || !core.isYouTubeUrl(tab.url)) return { ok: true, hasVideo: false, reason: 'not-youtube' };
  let response = await sendToTab(tabId, { type: 'st-probe' });
  if (!response && (await injectContentScript(tabId))) {
    response = await sendToTab(tabId, { type: 'st-probe' });
  }
  return response || { ok: true, hasVideo: false, reason: 'unreachable' };
}

/** Puts the video back to a given volume/mute state and stops steering it. */
async function setVideoSound(tabId, volume, muted) {
  const response = await sendToTab(tabId, { type: 'st-restore', volume, muted });
  return !!(response && response.ok);
}

function fadePlan(fade) {
  return {
    sessionId: fade.id,
    fadeStartAt: fade.fadeStartAt,
    fadeFromAt: fade.fadeFromAt,
    fadeFromGain: fade.fadeFromGain,
    fadeEndAt: fade.fadeEndAt,
    muteAt: fade.muteAt,
    startVolume: fade.startVolume,
    startMuted: fade.startMuted,
    status: fade.status,
  };
}

/** True once SleepyTube has started changing the video's volume. */
function fadeHasTouchedVolume(fade, now) {
  return !!fade && fade.status === FADE.ACTIVE && now >= fade.fadeStartAt;
}

async function pushPlan(session) {
  if (!session || !core.fadeIsOn(session.fade)) return null;
  return sendToTab(session.fade.tabId, { type: 'st-plan', plan: fadePlan(session.fade) });
}

/** The time the fade reaches silence, if that's still ahead. */
function pendingMuteAt(session, now) {
  return session && core.fadeIsPending(session.fade, now) ? session.fade.muteAt : null;
}

/** Refuses fade timelines that would still be running when the alarm rings. */
function checkAgainstWake(session, muteAt) {
  const wake = session && session.wake;
  if (!core.isWakePending(wake) || muteAt < wake.nextRingAt) return null;
  return fail(
    'wake-before-fade-ends',
    `That would keep the fade going until ${clock(muteAt)}, after your ${clock(wake.nextRingAt)} alarm. ` +
      'Choose a shorter fade or a later alarm.',
  );
}

// --- Badge -------------------------------------------------------------------

async function updateBadge(session) {
  const d = core.describeSession(session, Date.now());
  const notices = await loadNotices();
  let badge = BADGE.idle;
  if (d.state === STATE.WAKING || d.state === STATE.SNOOZED) badge = BADGE.waking;
  else if (d.fadeOverridden || notices.length) badge = BADGE.attention;
  else if (d.pending) badge = BADGE.armed;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: badge.color });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
    await chrome.action.setBadgeText({ text: badge.text });
    await chrome.action.setTitle({ title: badge.title });
  } catch {
    // Badge updates are cosmetic.
  }
}

// --- Alarms ------------------------------------------------------------------

/** Makes chrome.alarms match exactly what the session still needs. */
async function syncAlarms(session) {
  const now = Date.now();
  const wanted = new Map();
  const fade = session && session.fade;
  if (fade && fade.status === FADE.ACTIVE) {
    if (fade.fadeStartAt > now) wanted.set(ALARM_FADE.start, fade.fadeStartAt);
    if (fade.fadeEndAt > now) wanted.set(ALARM_FADE.whisper, fade.fadeEndAt);
    if (fade.muteAt > now) wanted.set(ALARM_FADE.mute, fade.muteAt);
  }
  const wake = session && session.wake;
  if (core.isWakePending(wake)) wanted.set(ALARM_WAKE, wake.nextRingAt);
  if (wake && wake.status === WAKE.RINGING) wanted.set(ALARM_WAKE_STOP, wake.ringStartedAt + core.WAKE_AUTO_STOP_MS);

  const existing = await chrome.alarms.getAll();
  for (const alarm of existing) {
    if (alarm.name.startsWith(ALARM_PREFIX) && !wanted.has(alarm.name)) await chrome.alarms.clear(alarm.name);
  }
  for (const [name, when] of wanted) {
    const found = existing.find((a) => a.name === name);
    if (!found || Math.abs(found.scheduledTime - when) > 1000) {
      await chrome.alarms.create(name, { when: Math.max(when, now + 500) });
    }
  }
}

// --- Keep awake (optional `power` permission) --------------------------------

async function hasPowerPermission() {
  return chrome.permissions.contains({ permissions: ['power'] });
}

/** Holds a `system` keep-awake only while an alarm is pending or ringing. */
async function syncKeepAwake(session) {
  if (!chrome.power) return; // permission not granted: nothing is held
  const wake = session && session.wake;
  if (core.wakeIsOn(wake) && wake.keepAwake) chrome.power.requestKeepAwake('system');
  else chrome.power.releaseKeepAwake();
}

// --- Offscreen wake audio ----------------------------------------------------

let creatingOffscreen = null;

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Plays the bundled SleepyTube wake-up chime.',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function closeOffscreen() {
  try {
    if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
  } catch {
    // Already closed.
  }
}

async function toOffscreen(message) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
      if (response) return response;
    } catch {
      // The document may still be loading.
    }
    await delay(100 * (attempt + 1));
  }
  return null;
}

function ringId(session) {
  return `${session.id}:${session.wake.ringStartedAt}`;
}

/** Makes sure the chime for the current ring is playing (idempotent). */
async function ensureWakeAudio(session) {
  const wake = session.wake;
  let response;
  try {
    await ensureOffscreen();
    response = await toOffscreen({
      type: 'ring',
      ringId: ringId(session),
      startedAt: wake.ringStartedAt,
      volume: wake.volume,
      autoStopAt: wake.ringStartedAt + core.WAKE_AUTO_STOP_MS,
    });
  } catch (error) {
    response = { ok: false, error: String((error && error.message) || error) };
  }
  const audioError = response && response.ok ? null : (response && response.error) || 'No response from the audio player';
  if (wake.audioError !== audioError) {
    wake.audioError = audioError;
    await saveSession(session);
  }
  return !audioError;
}

async function stopWakeAudio() {
  if (!(await hasOffscreenDocument())) return;
  await toOffscreen({ type: 'stop' });
  await closeOffscreen();
}

// --- Wake UI: window + notification ------------------------------------------

async function showWakeNotification(session, { audible }) {
  const at = clock(session.wake.wakeAt);
  try {
    await chrome.notifications.create(NOTIFY_WAKE, {
      type: 'basic',
      iconUrl: ICON_URL,
      title: 'Good morning',
      message: session.wake.audioError
        ? `It's your ${at} SleepyTube alarm. (The chime could not play: check your sound.)`
        : `It's your ${at} SleepyTube wake alarm.`,
      buttons: [{ title: 'Snooze 9 min' }, { title: "I'm awake" }],
      requireInteraction: true,
      priority: 2,
      silent: !audible,
    });
  } catch {
    // Notifications are a secondary channel.
  }
}

async function showInfoNotification(title, message) {
  try {
    await chrome.notifications.create(NOTIFY_INFO, { type: 'basic', iconUrl: ICON_URL, title, message, priority: 1 });
  } catch {
    // Notifications are a secondary channel.
  }
}

async function clearWakeNotification() {
  try {
    await chrome.notifications.clear(NOTIFY_WAKE);
  } catch {
    // Nothing to clear.
  }
}

/** Shows (or re-focuses) the large Snooze / I'm awake window. */
async function openWakeWindow(session) {
  const wake = session.wake;
  if (wake.windowId != null) {
    try {
      await chrome.windows.update(wake.windowId, { focused: true, drawAttention: true });
      return;
    } catch {
      wake.windowId = null; // it was closed
    }
  }
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(WAKE_PAGE_URL),
      type: 'popup',
      width: 460,
      height: 640,
      focused: true,
    });
    wake.windowId = win.id;
  } catch {
    // Windows may be unavailable (e.g. no display); the notification remains.
  }
  await saveSession(session);
}

async function focusWakeUi() {
  const session = await loadSession();
  if (session && core.wakeIsOn(session.wake)) await openWakeWindow(session);
}

// --- Transitions ---------------------------------------------------------------

/** A fade the user paused (by changing the volume) is moot once it's morning. */
function settlePausedFade(session) {
  if (session.fade && session.fade.status === FADE.OVERRIDDEN) session.fade = null;
}

async function startRinging(session, now) {
  const wake = session.wake;
  settlePausedFade(session);
  wake.status = WAKE.RINGING;
  wake.ringStartedAt = now;
  wake.firstRangAt = wake.firstRangAt || now;
  wake.audioError = null;
  // Persist first: a duplicate alarm event now sees RINGING and stays quiet.
  await saveSession(session);
  await syncAlarms(session);
  const playing = await ensureWakeAudio(session);
  await logAlarm('rang', wake, { audioError: wake.audioError });
  await showWakeNotification(session, { audible: !playing });
  await openWakeWindow(session);
}

/** Ends the alarm part of the night: dismissed, expired, missed or switched off. */
async function endWake(session, outcome) {
  if (outcome) await logAlarm(outcome, session.wake);
  settlePausedFade(session);
  session.wake = null;
  const remaining = await commit(session);
  await stopWakeAudio();
  await clearWakeNotification();
  return remaining;
}

async function markMissed(session) {
  const at = clock(session.wake.nextRingAt);
  await addNotice(
    `SleepyTube missed your ${at} alarm because Chrome or the computer was asleep. ` +
      'It never rings late, so keep a separate alarm as backup.',
  );
  await showInfoNotification('Wake alarm missed', `Your ${at} alarm could not ring on time, so it was skipped.`);
  return endWake(session, 'missed');
}

async function expireRinging(session) {
  await addNotice('Your wake alarm rang for 15 minutes and turned itself off.');
  await showInfoNotification('Wake alarm stopped', 'The alarm rang for 15 minutes and has been turned off.');
  return endWake(session, 'stopped after 15 min');
}

/** The fade's tab closed or left YouTube: switch only the fade off (PRD R7). */
async function markFadeLost(session, reason, now) {
  const fade = session.fade;
  const wasPending = fade.status === FADE.OVERRIDDEN || now < fade.muteAt;
  session.fade = null;
  if (wasPending) {
    const where = reason === 'closed' ? 'The YouTube tab was closed' : 'The YouTube tab left YouTube';
    const wakeNote = core.wakeIsOn(session.wake) ? ' Your alarm is still set.' : '';
    await addNotice(`${where}, so the fade stopped.${wakeNote}`);
    await showInfoNotification('Fade stopped', `${where}, so the fade stopped.${wakeNote}`);
  }
  // Closing the tab after the video went silent is normal: nothing to report.
  return commit(session);
}

/**
 * Brings storage, alarms, audio, keep-awake and the content script in line
 * with the persisted session. Safe to run any number of times.
 */
async function reconcile() {
  const now = Date.now();
  let session = await loadSession();
  if (!session) {
    await syncAlarms(null);
    await syncKeepAwake(null);
    await updateBadge(null);
    return null;
  }

  if (now - session.armedAt > core.SESSION_MAX_AGE_MS) {
    // No night lasts this long; forget it without touching the video.
    await endSession(session, { restore: false });
    return null;
  }

  const wake = session.wake;
  const due = core.wakeDueAction(wake, now);
  if (due === 'missed') session = await markMissed(session);
  else if (due === 'ring') await startRinging(session, now);
  else if (wake && wake.status === WAKE.RINGING) {
    if (now - wake.ringStartedAt >= core.WAKE_AUTO_STOP_MS) session = await expireRinging(session);
    else await ensureWakeAudio(session);
  }

  if (session && core.fadeIsOn(session.fade)) {
    const tab = await getTab(session.fade.tabId);
    if (!tab || !core.isYouTubeUrl(tab.url)) session = await markFadeLost(session, tab ? 'left' : 'closed', now);
  }

  await updateBadge(session);
  await syncAlarms(session);
  await syncKeepAwake(session);
  if (session) await pushPlan(session);
  return session;
}

/** Ends the night entirely (cleanup, expiry). */
async function endSession(session, { restore }) {
  await clearSession();
  await syncAlarms(null);
  await syncKeepAwake(null);
  await stopWakeAudio();
  await clearWakeNotification();
  const fade = session && session.fade;
  if (core.fadeIsOn(fade)) {
    const restored = restore && (await setVideoSound(fade.tabId, fade.originalVolume, fade.originalMuted));
    if (!restored) await sendToTab(fade.tabId, { type: 'st-clear' });
  }
}

// --- Fade to Sleep -----------------------------------------------------------------

async function fadeOn({ tabId, delayMinutes, fadeMinutes, whisperMinutes }) {
  const now = Date.now();
  const session = (await loadSession()) || newSession(now);
  if (core.fadeIsOn(session.fade)) {
    if (session.fade.tabId === tabId) return { ok: true, session };
    return fail('fade-elsewhere', 'Fade to Sleep is already on for another tab. Switch it off there first.');
  }
  const times = core.planFadeTimes(now, { delayMinutes, fadeMinutes, whisperMinutes });
  const conflict = checkAgainstWake(session, times.muteAt);
  if (conflict) return conflict;

  const snapshot = await probeTab(tabId);
  if (!snapshot.hasVideo) return fail('no-video', 'Open a YouTube video first');

  session.fade = {
    id: newId(),
    tabId,
    ...times,
    startVolume: snapshot.volume,
    startMuted: snapshot.muted,
    originalVolume: snapshot.volume,
    originalMuted: snapshot.muted,
    status: FADE.ACTIVE,
  };
  const saved = await commit(session);
  await pushPlan(saved);
  return { ok: true, session: saved };
}

/**
 * Switching the fade off (or its Cancel button) is a deliberate act, so the
 * video's original sound comes back — unless the user already set their own
 * volume, which is left alone.
 */
async function fadeOff() {
  const session = await loadSession();
  const fade = session && session.fade;
  if (!core.fadeIsOn(fade)) return { ok: true, session };
  if (fadeHasTouchedVolume(fade, Date.now())) {
    const restored = await setVideoSound(fade.tabId, fade.originalVolume, fade.originalMuted);
    if (!restored) await sendToTab(fade.tabId, { type: 'st-clear' });
  } else {
    await sendToTab(fade.tabId, { type: 'st-clear' });
  }
  session.fade = null;
  return { ok: true, session: await commit(session) };
}

/** Applies timeline changes after checking them against the alarm. */
async function applyFadeChanges(session, changes) {
  const fade = session.fade;
  const muteAt = changes.muteAt != null ? changes.muteAt : fade.muteAt;
  if (fade.status === FADE.ACTIVE && muteAt !== fade.muteAt) {
    const conflict = checkAgainstWake(session, muteAt);
    if (conflict) return conflict;
  }
  Object.assign(fade, changes);
  const saved = await commit(session);
  await pushPlan(saved);
  return { ok: true, session: saved };
}

async function fadeRetime(input) {
  const session = await loadSession();
  const fade = session && session.fade;
  if (!core.fadeIsOn(fade)) return fail('fade-off', 'Fade to Sleep is off.');
  if (fade.status === FADE.OVERRIDDEN) {
    // Paused: just remember the choice for when the fade resumes.
    return applyFadeChanges(session, core.fadeChoices({ ...fade, ...input }));
  }
  const changes = core.retimeFade(fade, input, Date.now());
  if (changes.error) return fail('locked', 'That part of the fade has already started.');
  return applyFadeChanges(session, changes);
}

async function fadeExtend({ minutes }) {
  if (!core.EXTEND_OPTIONS.includes(Number(minutes))) return fail('bad-input', 'Choose +10 or +20.');
  const session = await loadSession();
  const fade = session && session.fade;
  if (!core.fadeIsOn(fade)) return fail('fade-off', 'Fade to Sleep is off.');
  if (fade.status === FADE.OVERRIDDEN) return fail('paused', 'Resume the fade first.');
  const changes = core.extendFade(fade, minutes, Date.now());
  if (changes.error) return fail('silent', 'The video is already silent. Use Restart to start over.');
  return applyFadeChanges(session, changes);
}

/** Restart: bring the starting volume back and count down again from now. */
async function fadeRestart() {
  const session = await loadSession();
  const fade = session && session.fade;
  if (!core.fadeIsOn(fade)) return fail('fade-off', 'Fade to Sleep is off.');
  const now = Date.now();
  const times = core.planFadeTimes(now, fade);
  const conflict = checkAgainstWake(session, times.muteAt);
  if (conflict) return conflict;
  if (fade.status === FADE.OVERRIDDEN) {
    const current = await probeTab(fade.tabId);
    if (!current.hasVideo) return fail('no-video', 'SleepyTube cannot reach the YouTube video right now.');
    fade.startVolume = current.volume;
    fade.startMuted = current.muted;
  } else if (fadeHasTouchedVolume(fade, now)) {
    await setVideoSound(fade.tabId, fade.startVolume, fade.startMuted);
  }
  Object.assign(fade, times, { status: FADE.ACTIVE });
  const saved = await commit(session);
  await pushPlan(saved);
  return { ok: true, session: saved };
}

/** Resume after an override: fade again from the user's volume, starting now. */
async function fadeResume() {
  const session = await loadSession();
  const fade = session && session.fade;
  if (!fade || fade.status !== FADE.OVERRIDDEN) return { ok: true, session };
  const times = core.planFadeFromNow(Date.now(), fade);
  const conflict = checkAgainstWake(session, times.muteAt);
  if (conflict) return conflict;
  const current = await probeTab(fade.tabId);
  if (!current.hasVideo) return fail('no-video', 'SleepyTube cannot reach the YouTube video right now.');
  Object.assign(fade, times, { startVolume: current.volume, startMuted: current.muted, status: FADE.ACTIVE });
  const saved = await commit(session);
  await pushPlan(saved);
  return { ok: true, session: saved };
}

// --- Alarm -----------------------------------------------------------------------

function newWake(at, { keepAwake, volume }) {
  return {
    wakeAt: at,
    nextRingAt: at,
    status: WAKE.SCHEDULED,
    keepAwake: !!keepAwake,
    volume: core.clamp(Number(volume) || core.DEFAULT_SETTINGS.wakeVolume, 0.05, 1),
    snoozeCount: 0,
    ringStartedAt: null,
    firstRangAt: null,
    windowId: null,
    audioError: null,
  };
}

async function alarmOn({ at }) {
  const now = Date.now();
  const settings = await loadSettings();
  const wakeAt = at != null ? Number(at) : core.nextOccurrence(settings.wakeTime, now);
  const session = (await loadSession()) || newSession(now);
  if (core.wakeIsOn(session.wake)) return { ok: true, session };
  const problem = core.validateWakeAt(wakeAt, now, pendingMuteAt(session, now));
  if (problem) return fail(problem.code, problem.message);
  const keepAwake = settings.keepAwake && (await hasPowerPermission());
  session.wake = newWake(wakeAt, { keepAwake, volume: settings.wakeVolume });
  return { ok: true, session: await commit(session) };
}

/** Switching the alarm off (or its Cancel button); while ringing, = I'm awake. */
async function alarmOff() {
  const session = await loadSession();
  if (!session || !core.wakeIsOn(session.wake)) return { ok: true, session };
  const rang = session.wake.status !== WAKE.SCHEDULED;
  return { ok: true, session: await endWake(session, rang ? 'dismissed' : null) };
}

async function setWakeTime(session, at) {
  const wake = session && session.wake;
  if (!core.wakeIsOn(wake)) return fail('alarm-off', 'The alarm is off.');
  if (wake.status !== WAKE.SCHEDULED) return fail('ringing', "Use Snooze or I'm awake first.");
  const now = Date.now();
  const problem = core.validateWakeAt(at, now, pendingMuteAt(session, now));
  if (problem) return fail(problem.code, problem.message);
  wake.wakeAt = wake.nextRingAt = at;
  return { ok: true, session: await commit(session) };
}

async function alarmSet({ at }) {
  return setWakeTime(await loadSession(), Number(at));
}

async function alarmShift({ minutes }) {
  const session = await loadSession();
  if (!session || !core.wakeIsOn(session.wake)) return fail('alarm-off', 'The alarm is off.');
  return setWakeTime(session, session.wake.nextRingAt + Number(minutes) * MINUTE);
}

/** Keep-awake and alarm volume, from the Limitations panel. */
async function alarmOptions({ keepAwake, volume }) {
  const session = await loadSession();
  const wake = session && session.wake;
  if (!core.wakeIsOn(wake)) return { ok: true, session };
  if (keepAwake != null) wake.keepAwake = !!keepAwake && (await hasPowerPermission());
  if (volume != null) wake.volume = core.clamp(Number(volume), 0.05, 1);
  return { ok: true, session: await commit(session) };
}

async function snooze() {
  const session = await loadSession();
  const wake = session && session.wake;
  if (!wake || wake.status !== WAKE.RINGING) return { ok: true, session };
  wake.status = WAKE.SNOOZED;
  wake.nextRingAt = Date.now() + core.SNOOZE_MS;
  wake.snoozeCount = (wake.snoozeCount || 0) + 1;
  wake.ringStartedAt = null;
  await saveSession(session);
  await syncAlarms(session);
  await stopWakeAudio();
  await clearWakeNotification();
  await logAlarm('snoozed', wake);
  return { ok: true, session };
}

/** I'm awake: the alarm stops. The video's sound is never restored here (PRD §4). */
async function dismiss() {
  const session = await loadSession();
  const wake = session && session.wake;
  if (!wake || !(wake.status === WAKE.RINGING || wake.status === WAKE.SNOOZED)) return { ok: true, session };
  return { ok: true, session: await endWake(session, 'dismissed') };
}

// --- Test sound, notices ------------------------------------------------------------

async function testSound({ volume }) {
  const session = await loadSession();
  if (session && session.wake && session.wake.status === WAKE.RINGING) {
    return fail('ringing', 'The wake alarm is already ringing.');
  }
  try {
    await ensureOffscreen();
  } catch (error) {
    return fail('offscreen', String((error && error.message) || error));
  }
  const response = await toOffscreen({
    type: 'test',
    volume: core.clamp(Number(volume) || core.DEFAULT_SETTINGS.wakeVolume, 0.05, 1),
    durationMs: core.TEST_SOUND_MS,
  });
  if (!response || !response.ok) {
    await closeOffscreen();
    return fail('audio', `The test sound could not play (${(response && response.error) || 'no response'}).`);
  }
  return { ok: true, durationMs: core.TEST_SOUND_MS };
}

async function stopTest() {
  const session = await loadSession();
  if (session && session.wake && session.wake.status === WAKE.RINGING) return { ok: true };
  await stopWakeAudio();
  return { ok: true };
}

async function onOffscreenEnded({ mode }) {
  if (mode === 'test') return stopTest();
  return reconcile(); // a ring hit its safety cap; reconcile expires it
}

async function dismissNotice({ id }) {
  const notices = (await loadNotices()).filter((n) => n.id !== id);
  await chrome.storage.local.set({ [KEY_NOTICES]: notices });
  await updateBadge(await loadSession());
  return { ok: true };
}

async function getStatus() {
  const session = await reconcile();
  return { ok: true, session, notices: await loadNotices(), settings: await loadSettings() };
}

// --- Content script reports --------------------------------------------------

function fadeFor(session, sender, sessionId) {
  const fade = session && session.fade;
  if (!core.fadeIsOn(fade) || !sender.tab || sender.tab.id !== fade.tabId) return null;
  if (sessionId && sessionId !== fade.id) return null;
  return fade;
}

async function onContentReady(sender) {
  const session = await loadSession();
  const fade = fadeFor(session, sender);
  if (!fade || sender.frameId !== 0) return { plan: null };
  return { plan: fadePlan(fade) };
}

async function onOverride(message, sender) {
  const session = await loadSession();
  const fade = fadeFor(session, sender, message.sessionId);
  if (!fade || fade.status !== FADE.ACTIVE) return { ok: true };
  const now = Date.now();
  const wake = session.wake;
  if (now >= fade.muteAt && (!core.wakeIsOn(wake) || wake.firstRangAt)) {
    // The video was already silent and nothing else is coming, or the alarm
    // has rung: the user turning the sound up is them taking over.
    session.fade = null;
    await commit(session);
    return { ok: true };
  }
  fade.status = FADE.OVERRIDDEN;
  fade.overriddenAt = now;
  await commit(session);
  return { ok: true };
}

async function onBaseline(message, sender) {
  const session = await loadSession();
  const fade = fadeFor(session, sender, message.sessionId);
  const changedAt = Number(message.at) || Date.now();
  if (!fade || fade.status !== FADE.ACTIVE || changedAt >= fade.fadeStartAt) return { ok: true };
  // The user set a new listening volume before the fade began: fade from it,
  // and treat it as the volume to restore later.
  fade.startVolume = fade.originalVolume = core.clamp(Number(message.volume), 0, 1);
  fade.startMuted = fade.originalMuted = !!message.muted;
  await saveSession(session);
  await pushPlan(session); // replaces any older plan the page received meanwhile
  return { ok: true };
}

// --- Event wiring --------------------------------------------------------------

const handlers = {
  'get-status': () => getStatus(),
  'probe-tab': (m) => probeTab(m.tabId),
  'fade-on': (m) => fadeOn(m),
  'fade-off': () => fadeOff(),
  'fade-retime': (m) => fadeRetime(m),
  'fade-extend': (m) => fadeExtend(m),
  'fade-restart': () => fadeRestart(),
  'fade-resume': () => fadeResume(),
  'restore-sound': () => fadeOff(),
  'alarm-on': (m) => alarmOn(m),
  'alarm-off': () => alarmOff(),
  'alarm-set': (m) => alarmSet(m),
  'alarm-shift': (m) => alarmShift(m),
  'alarm-options': (m) => alarmOptions(m),
  snooze: () => snooze(),
  dismiss: () => dismiss(),
  'dismiss-notice': (m) => dismissNotice(m),
  'test-sound': (m) => testSound(m),
  'stop-test': () => stopTest(),
  'offscreen-ended': (m) => onOffscreenEnded(m),
  'st-content-ready': (_m, sender) => onContentReady(sender),
  'st-override': (m, sender) => onOverride(m, sender),
  'st-baseline': (m, sender) => onBaseline(m, sender),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === 'offscreen' || sender.id !== chrome.runtime.id) return;
  const handler = handlers[message.type];
  if (!handler) return;
  serialized(() => handler(message, sender)).then(sendResponse, (error) =>
    sendResponse(fail('internal', String((error && error.message) || error))),
  );
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(ALARM_PREFIX)) serialized(reconcile);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serialized(async () => {
    const session = await loadSession();
    if (session && core.fadeIsOn(session.fade) && session.fade.tabId === tabId) {
      await markFadeLost(session, 'closed', Date.now());
    }
  });
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  serialized(async () => {
    const session = await loadSession();
    if (session && session.fade && session.fade.tabId === removedTabId) {
      session.fade.tabId = addedTabId;
      await saveSession(session);
      await pushPlan(session);
    }
  });
});

chrome.notifications.onButtonClicked.addListener((id, index) => {
  if (id === NOTIFY_WAKE) serialized(index === 0 ? snooze : dismiss);
});

chrome.notifications.onClicked.addListener((id) => {
  if (id === NOTIFY_WAKE) serialized(focusWakeUi);
  else chrome.notifications.clear(id);
});

chrome.windows.onRemoved.addListener((windowId) => {
  serialized(async () => {
    const session = await loadSession();
    if (session && session.wake && session.wake.windowId === windowId) {
      session.wake.windowId = null;
      await saveSession(session);
    }
  });
});

chrome.runtime.onInstalled.addListener(() => {
  serialized(async () => {
    // Declared content scripts only reach tabs opened after install/update.
    const tabs = await chrome.tabs.query({ url: core.YOUTUBE_MATCH });
    await Promise.all(tabs.map((tab) => injectContentScript(tab.id)));
    await reconcile();
  });
});

chrome.runtime.onStartup.addListener(() => serialized(reconcile));

// Every time the worker starts: recover from whatever happened while it slept.
serialized(reconcile);

// --- QA helpers (service worker console; see docs/QA.md) -------------------------
// sleepyDebug.fastForward(20) moves the night 20 minutes forward in time, e.g.
// to reach the fade without waiting; skipToAlarm() jumps to the alarm.

function fastForwardSession(session, ms) {
  session.armedAt -= ms;
  const fade = session.fade;
  if (fade) {
    for (const k of ['delayStartedAt', 'fadeStartAt', 'fadeFromAt', 'fadeEndAt', 'muteAt']) {
      if (fade[k] != null) fade[k] -= ms;
    }
  }
  const wake = session.wake;
  if (wake) {
    for (const k of ['wakeAt', 'nextRingAt', 'ringStartedAt', 'firstRangAt']) {
      if (wake[k] != null) wake[k] -= ms;
    }
  }
}

self.sleepyDebug = {
  session: loadSession,
  notices: loadNotices,
  // Prints recent alarm events as a table: when each was due and when it happened.
  alarmLog: async () => {
    const { [KEY_ALARM_LOG]: log = [] } = await chrome.storage.local.get(KEY_ALARM_LOG);
    const rows = log.map((e) => ({
      event: e.event,
      due: new Date(e.dueAt).toLocaleString(),
      happened: new Date(e.at).toLocaleString(),
      'seconds late': e.event === 'rang' || e.event === 'missed' ? Math.round((e.at - e.dueAt) / 1000) : '',
      snoozes: e.snoozes,
      'sound problem': e.audioError || '',
    }));
    console.table(rows);
    return rows.length ? `${rows.length} alarm events (newest last)` : 'No alarm events yet';
  },
  reconcile: () => serialized(reconcile),
  // Forget tonight's session (and notices) without touching the video.
  reset: () =>
    serialized(async () => {
      await chrome.storage.local.remove(KEY_NOTICES);
      const session = await loadSession();
      if (!session) {
        await updateBadge(null);
        return;
      }
      await endSession(session, { restore: false });
      const id = session.wake && session.wake.windowId;
      if (id != null) await chrome.windows.remove(id).catch(() => {});
    }),
  fastForward: (minutes) =>
    serialized(async () => {
      const session = await loadSession();
      if (!session) return null;
      fastForwardSession(session, minutes * MINUTE);
      await chrome.storage.local.set({ [KEY_SESSION]: session });
      return reconcile();
    }),
  // Jumps straight to the alarm time, so it rings now.
  skipToAlarm: () =>
    serialized(async () => {
      const session = await loadSession();
      if (!session || !core.isWakePending(session.wake)) return 'The alarm is not set.';
      fastForwardSession(session, Math.max(0, session.wake.nextRingAt - Date.now()));
      await chrome.storage.local.set({ [KEY_SESSION]: session });
      await reconcile();
      return 'Ringing now.';
    }),
};
