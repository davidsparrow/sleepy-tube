/*
 * SleepyTube service worker.
 *
 * Owns the single active night (PRD R8): persists it in chrome.storage.local,
 * schedules transitions with chrome.alarms, plays the wake chime through an
 * offscreen document and reconciles everything whenever the worker starts.
 * In-memory state is never trusted to survive a restart (PRD R6), and every
 * handler is idempotent, so duplicate alarm events cannot double-ring.
 */
importScripts('lib/core.js');

const core = self.SleepyCore;
const { FADE, WAKE, STATE, MINUTE } = core;

const KEY_SESSION = 'session';
const KEY_SETTINGS = 'settings';

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

function newId() {
  return crypto.randomUUID();
}

async function loadSession() {
  const { [KEY_SESSION]: session = null } = await chrome.storage.local.get(KEY_SESSION);
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

async function loadSettings() {
  const { [KEY_SETTINGS]: stored = {} } = await chrome.storage.local.get(KEY_SETTINGS);
  return { ...core.DEFAULT_SETTINGS, ...stored };
}

function addNotice(session, level, text) {
  session.notices = (session.notices || []).filter((n) => n.text !== text);
  session.notices.push({ id: newId(), level, text, at: Date.now() });
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

function fadePlan(session) {
  const f = session.fade;
  return {
    sessionId: session.id,
    fadeStartAt: f.fadeStartAt,
    fadeEndAt: f.fadeEndAt,
    muteAt: f.muteAt,
    startVolume: f.startVolume,
    startMuted: f.startMuted,
    status: f.status,
  };
}

function fadeIsLive(fade) {
  return !!fade && (fade.status === FADE.ACTIVE || fade.status === FADE.OVERRIDDEN);
}

/** True once SleepyTube has started changing the video's volume. */
function fadeHasTouchedVolume(fade, now) {
  return !!fade && fade.status === FADE.ACTIVE && now >= fade.fadeStartAt;
}

async function pushPlan(session) {
  if (!session || !fadeIsLive(session.fade)) return null;
  return sendToTab(session.fade.tabId, { type: 'st-plan', plan: fadePlan(session) });
}

// --- Badge -------------------------------------------------------------------

async function updateBadge(session) {
  const now = Date.now();
  const d = core.describeSession(session, now);
  let badge = BADGE.idle;
  if (d.state === STATE.WAKING || d.state === STATE.SNOOZED) badge = BADGE.waking;
  else if (d.needsAttention || d.state === STATE.MISSED_WAKE || d.state === STATE.ERROR) badge = BADGE.attention;
  else if (session && !d.finished) badge = BADGE.armed;
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

function keepAwakeWanted(session) {
  const wake = session && session.wake;
  return !!wake && wake.keepAwake && (core.isWakePending(wake) || wake.status === WAKE.RINGING);
}

/** Holds a `system` keep-awake only while a wake alarm is pending or ringing. */
async function syncKeepAwake(session) {
  if (!chrome.power) return; // permission not granted: nothing is held
  if (keepAwakeWanted(session)) chrome.power.requestKeepAwake('system');
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
  const at = core.formatClock(session.wake.wakeAt);
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
      height: 600,
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
  if (session && session.wake) await openWakeWindow(session);
}

// --- Transitions ---------------------------------------------------------------

async function startRinging(session, now) {
  const wake = session.wake;
  settlePausedFade(session); // a fade paused overnight is moot once it's morning
  wake.status = WAKE.RINGING;
  wake.ringStartedAt = now;
  wake.firstRangAt = wake.firstRangAt || now;
  wake.audioError = null;
  // Persist first: a duplicate alarm event now sees RINGING and stays quiet.
  await saveSession(session);
  await syncAlarms(session);
  const playing = await ensureWakeAudio(session);
  await showWakeNotification(session, { audible: !playing });
  await openWakeWindow(session);
}

async function markMissed(session, now) {
  const wake = session.wake;
  const at = core.formatClock(wake.nextRingAt);
  wake.status = WAKE.MISSED;
  wake.missedAt = now;
  addNotice(
    session,
    'warn',
    `SleepyTube missed your ${at} wake alarm because Chrome or the computer was asleep. ` +
      'It does not ring late. Keep a separate alarm as backup.',
  );
  await saveSession(session);
  await showInfoNotification('Wake alarm missed', `Your ${at} alarm could not ring on time, so it was skipped.`);
}

/** Once the alarm is over, a fade the user paused has nothing left to resume. */
function settlePausedFade(session) {
  if (session.fade && session.fade.status === FADE.OVERRIDDEN) session.fade.status = FADE.CANCELLED;
}

async function expireRinging(session, now) {
  settlePausedFade(session);
  session.wake.status = WAKE.EXPIRED;
  session.wake.endedAt = now;
  await saveSession(session);
  await stopWakeAudio();
  await clearWakeNotification();
  await showInfoNotification('Wake alarm stopped', 'The alarm rang for 15 minutes and has been turned off.');
}

/** The fade's tab closed or left YouTube: cancel only the fade (PRD R7). */
async function markFadeLost(session, reason, now) {
  const fade = session.fade;
  const wasPending = fade.status === FADE.OVERRIDDEN || now < fade.muteAt;
  fade.status = FADE.LOST;
  fade.lostAt = now;
  if (!wasPending) {
    // The fade had already finished; closing the tab afterwards is normal.
    // Keep the night if it still has something to tell the user (e.g. a missed alarm).
    const hasWarning = (session.notices || []).some((n) => n.level === 'warn');
    if (core.isSessionFinished(session, now) && !hasWarning) {
      await clearSession();
      return null;
    }
    await saveSession(session);
    return session;
  }
  const where = reason === 'closed' ? 'The YouTube tab was closed' : 'The YouTube tab left YouTube';
  const wakeNote = core.isWakePending(session.wake) ? ' Your wake alarm is still set.' : '';
  addNotice(session, 'warn', `${where}, so tonight's fade was cancelled.${wakeNote}`);
  await saveSession(session);
  await showInfoNotification('Fade cancelled', `${where}, so the fade stopped.${wakeNote}`);
  return session;
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
  if (due === 'missed') await markMissed(session, now);
  else if (due === 'ring') await startRinging(session, now);
  else if (wake && wake.status === WAKE.RINGING) {
    if (now - wake.ringStartedAt >= core.WAKE_AUTO_STOP_MS) await expireRinging(session, now);
    else await ensureWakeAudio(session);
  }

  if (fadeIsLive(session.fade)) {
    const tab = await getTab(session.fade.tabId);
    if (!tab || !core.isYouTubeUrl(tab.url)) {
      session = await markFadeLost(session, tab ? 'left' : 'closed', now);
    }
  }

  if (session) await updateBadge(session);
  await syncAlarms(session);
  await syncKeepAwake(session);
  if (session) await pushPlan(session);
  return session;
}

/** Ends the night entirely (Cancel night / Done / replacement). */
async function endSession(session, { restore }) {
  await clearSession();
  await syncAlarms(null);
  await syncKeepAwake(null);
  await stopWakeAudio();
  await clearWakeNotification();
  const fade = session && session.fade;
  if (fadeIsLive(fade)) {
    const restored = restore && (await setVideoSound(fade.tabId, fade.originalVolume, fade.originalMuted));
    if (!restored) await sendToTab(fade.tabId, { type: 'st-clear' });
  }
}

// --- Actions (popup, wake page, notifications) -------------------------------

async function getStatus() {
  const session = await reconcile();
  return { ok: true, session, settings: await loadSettings() };
}

async function arm({ tabId, fadeMinutes, wake, replace }) {
  const now = Date.now();
  fadeMinutes = Number(fadeMinutes);
  if (!core.isValidFadeMinutes(fadeMinutes)) return fail('bad-input', 'Choose when the fade should begin.');

  const times = core.planFadeTimes(now, fadeMinutes * MINUTE);
  let wakeAt = null;
  if (wake && wake.enabled) {
    wakeAt = core.nextOccurrence(wake.time, now);
    if (wakeAt == null) return fail('bad-input', 'Choose a wake time.');
    const problem = core.validateSchedule({ muteAt: times.muteAt, wakeAt });
    if (problem) return fail(problem.code, problem.message);
    if (wake.keepAwake && !(await hasPowerPermission())) {
      return fail('needs-power', 'Allow SleepyTube to keep the computer awake, or turn that option off.');
    }
  }

  const existing = await loadSession();
  if (existing && !core.isSessionFinished(existing, now) && !replace) {
    return fail('needs-replace', 'A night is already set. Replace it?');
  }

  const check = await probeTab(tabId);
  if (!check.hasVideo) return fail('no-video', 'Open a YouTube video first');

  if (existing) {
    // Replacing on the same tab: put its sound back before snapshotting. A
    // video in another tab is left as it is rather than turned up at night.
    const restore =
      fadeHasTouchedVolume(existing.fade, now) &&
      existing.fade.tabId === tabId &&
      !(existing.wake && existing.wake.firstRangAt);
    await endSession(existing, { restore });
  }
  const snapshot = await probeTab(tabId);
  if (!snapshot.hasVideo) return fail('no-video', 'Open a YouTube video first');

  const session = {
    id: newId(),
    armedAt: now,
    fade: {
      tabId,
      fadeMinutes,
      ...times,
      startVolume: snapshot.volume,
      startMuted: snapshot.muted,
      originalVolume: snapshot.volume,
      originalMuted: snapshot.muted,
      status: FADE.ACTIVE,
    },
    wake: wakeAt == null ? null : newWake(wake, wakeAt),
    notices: [],
  };
  await saveSession(session);
  await syncAlarms(session);
  await syncKeepAwake(session);
  await pushPlan(session);
  return { ok: true, session };
}

function newWake(input, wakeAt) {
  return {
    time: input.time,
    wakeAt,
    nextRingAt: wakeAt,
    status: WAKE.SCHEDULED,
    keepAwake: !!input.keepAwake,
    volume: core.clamp(Number(input.volume) || core.DEFAULT_SETTINGS.wakeVolume, 0.05, 1),
    snoozeCount: 0,
    ringStartedAt: null,
    firstRangAt: null,
    windowId: null,
    audioError: null,
  };
}

async function cancelNight() {
  const session = await loadSession();
  if (!session) return { ok: true, session: null };
  const now = Date.now();
  // Cancelling is a deliberate act, so the video's sound comes back — unless
  // the wake alarm has already rung (then "Restore video sound" is separate).
  const restore = fadeHasTouchedVolume(session.fade, now) && !(session.wake && session.wake.firstRangAt);
  await endSession(session, { restore });
  await closeWakeWindow(session);
  return { ok: true, session: null };
}

async function closeWakeWindow(session) {
  const id = session && session.wake && session.wake.windowId;
  if (id == null) return;
  try {
    await chrome.windows.remove(id);
  } catch {
    // Already closed.
  }
}

/** "Done": forget a finished night, leaving the video exactly as it is. */
async function finishNight() {
  const session = await loadSession();
  if (session) {
    await endSession(session, { restore: false });
    await closeWakeWindow(session);
  }
  return { ok: true, session: null };
}

async function extendFade() {
  const session = await loadSession();
  const now = Date.now();
  const fade = session && session.fade;
  if (!fadeIsLive(fade)) return fail('no-fade', 'There is no fade to extend.');

  const beforeFade = fade.status === FADE.ACTIVE && now < fade.fadeStartAt;
  const times = beforeFade
    ? {
        fadeStartAt: fade.fadeStartAt + core.EXTEND_MS,
        fadeEndAt: fade.fadeEndAt + core.EXTEND_MS,
        muteAt: fade.muteAt + core.EXTEND_MS,
      }
    : core.planFadeTimes(now, core.EXTEND_MS);
  if (core.isWakePending(session.wake)) {
    const problem = core.validateSchedule({ muteAt: times.muteAt, wakeAt: session.wake.nextRingAt });
    if (problem) return fail(problem.code, 'Adding 15 minutes would finish the fade after your wake alarm.');
  }

  if (!beforeFade) {
    // Fading (or paused by the user): bring the listening volume back and
    // count down again from there.
    if (fade.status === FADE.ACTIVE) {
      await setVideoSound(fade.tabId, fade.startVolume, fade.startMuted);
    } else {
      const current = await probeTab(fade.tabId);
      if (!current.hasVideo) return fail('no-video', 'SleepyTube cannot reach the YouTube video right now.');
      fade.startVolume = current.volume;
      fade.startMuted = current.muted;
    }
  }
  Object.assign(fade, times, { status: FADE.ACTIVE });
  await saveSession(session);
  await syncAlarms(session);
  await pushPlan(session);
  return { ok: true, session };
}

async function resumeFade() {
  const session = await loadSession();
  const fade = session && session.fade;
  if (!fade || fade.status !== FADE.OVERRIDDEN) return { ok: true, session };
  const times = core.planFadeTimes(Date.now(), 0);
  if (core.isWakePending(session.wake)) {
    const problem = core.validateSchedule({ muteAt: times.muteAt, wakeAt: session.wake.nextRingAt });
    if (problem) return fail(problem.code, 'Fading again takes 15 minutes, which would run past your wake alarm. Cancel the fade instead.');
  }
  const current = await probeTab(fade.tabId);
  if (!current.hasVideo) return fail('no-video', 'SleepyTube cannot reach the YouTube video right now.');
  // Fade again from the volume the user chose, starting now.
  Object.assign(fade, times, {
    startVolume: current.volume,
    startMuted: current.muted,
    status: FADE.ACTIVE,
  });
  await saveSession(session);
  await syncAlarms(session);
  await pushPlan(session);
  return { ok: true, session };
}

async function cancelFade() {
  const session = await loadSession();
  const fade = session && session.fade;
  if (!fadeIsLive(fade)) return { ok: true, session };
  fade.status = FADE.CANCELLED;
  await sendToTab(fade.tabId, { type: 'st-clear' });
  const wake = session.wake;
  if (!wake || !(core.isWakePending(wake) || wake.status === WAKE.RINGING)) {
    await endSession(session, { restore: false });
    return { ok: true, session: null };
  }
  await saveSession(session);
  await syncAlarms(session);
  return { ok: true, session };
}

async function updateWake({ enabled, time, keepAwake, volume }) {
  const session = await loadSession();
  if (!session) return fail('no-session', 'No night is set.');
  const now = Date.now();
  const wake = session.wake;
  if (wake && (wake.status === WAKE.RINGING || wake.status === WAKE.SNOOZED)) {
    return fail('ringing', "Use Snooze or I'm awake first.");
  }
  if (!enabled) {
    session.wake = null;
  } else {
    const wakeAt = core.nextOccurrence(time, now);
    if (wakeAt == null) return fail('bad-input', 'Choose a wake time.');
    if (core.fadeIsPending(session.fade, now)) {
      const problem = core.validateSchedule({ muteAt: session.fade.muteAt, wakeAt });
      if (problem) return fail(problem.code, problem.message);
    }
    if (keepAwake && !(await hasPowerPermission())) {
      return fail('needs-power', 'Allow SleepyTube to keep the computer awake, or turn that option off.');
    }
    session.wake = { ...newWake({ time, keepAwake, volume }, wakeAt), windowId: wake ? wake.windowId : null };
  }
  await saveSession(session);
  await syncAlarms(session);
  await syncKeepAwake(session);
  return { ok: true, session };
}

async function snooze() {
  const session = await loadSession();
  const wake = session && session.wake;
  if (!wake || wake.status !== WAKE.RINGING) return { ok: true, session };
  const now = Date.now();
  wake.status = WAKE.SNOOZED;
  wake.nextRingAt = now + core.SNOOZE_MS;
  wake.snoozeCount = (wake.snoozeCount || 0) + 1;
  wake.ringStartedAt = null;
  await saveSession(session);
  await syncAlarms(session);
  await stopWakeAudio();
  await clearWakeNotification();
  return { ok: true, session };
}

async function dismiss() {
  const session = await loadSession();
  const wake = session && session.wake;
  if (!wake || !(wake.status === WAKE.RINGING || wake.status === WAKE.SNOOZED)) return { ok: true, session };
  settlePausedFade(session);
  wake.status = WAKE.DISMISSED;
  wake.endedAt = Date.now();
  // Dismissing never restores the video's sound (PRD §4).
  await saveSession(session);
  await syncAlarms(session);
  await syncKeepAwake(session);
  await stopWakeAudio();
  await clearWakeNotification();
  return { ok: true, session };
}

async function restoreSound() {
  const session = await loadSession();
  const fade = session && session.fade;
  if (!fadeIsLive(fade)) return fail('nothing-to-restore', 'There is no video sound to restore.');
  const ok = await setVideoSound(fade.tabId, fade.originalVolume, fade.originalMuted);
  if (!ok) return fail('unreachable', 'SleepyTube cannot reach the YouTube video. Is the tab still open?');
  fade.status = FADE.RESTORED;
  if (core.isSessionFinished(session, Date.now())) {
    await endSession(session, { restore: false });
    return { ok: true, session: null };
  }
  await saveSession(session);
  await syncAlarms(session);
  return { ok: true, session };
}

async function dismissNotice({ id }) {
  const session = await loadSession();
  if (!session) return { ok: true, session: null };
  session.notices = (session.notices || []).filter((n) => n.id !== id);
  const d = core.describeSession(session, Date.now());
  if (d.finished && (d.state === STATE.ERROR || d.state === STATE.IDLE) && session.notices.length === 0) {
    await endSession(session, { restore: false });
    return { ok: true, session: null };
  }
  await saveSession(session);
  return { ok: true, session };
}

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

// --- Content script reports --------------------------------------------------

function fadeFor(session, sender, sessionId) {
  const fade = session && session.fade;
  if (!fade || !sender.tab || sender.tab.id !== fade.tabId) return null;
  if (sessionId && sessionId !== session.id) return null;
  return fade;
}

async function onContentReady(sender) {
  const session = await loadSession();
  const fade = fadeFor(session, sender);
  if (!fadeIsLive(fade) || sender.frameId !== 0) return { plan: null };
  return { plan: fadePlan(session) };
}

async function onOverride(message, sender) {
  const session = await loadSession();
  const fade = fadeFor(session, sender, message.sessionId);
  if (!fade || fade.status !== FADE.ACTIVE) return { ok: true };
  const now = Date.now();
  const wake = session.wake;
  const wakeAhead = !!wake && (core.isWakePending(wake) || wake.status === WAKE.RINGING);
  if (now >= fade.muteAt && (!wakeAhead || wake.firstRangAt)) {
    // The fade finished and either nothing else is scheduled or the alarm has
    // already rung: the user turning the sound back up is them taking over.
    fade.status = FADE.RESTORED;
    if (!wakeAhead) {
      await endSession(session, { restore: false });
      return { ok: true };
    }
    await saveSession(session);
    return { ok: true };
  }
  fade.status = FADE.OVERRIDDEN;
  fade.overriddenAt = now;
  await saveSession(session);
  await syncAlarms(session);
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
  arm: (m) => arm(m),
  'cancel-night': () => cancelNight(),
  'finish-night': () => finishNight(),
  'extend-fade': () => extendFade(),
  'resume-fade': () => resumeFade(),
  'cancel-fade': () => cancelFade(),
  'update-wake': (m) => updateWake(m),
  snooze: () => snooze(),
  dismiss: () => dismiss(),
  'restore-sound': () => restoreSound(),
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
    if (session && fadeIsLive(session.fade) && session.fade.tabId === tabId) {
      const remaining = await markFadeLost(session, 'closed', Date.now());
      await syncAlarms(remaining);
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

// --- QA helper (service worker console) ----------------------------------------
// sleepyDebug.fastForward(20) moves the active night 20 minutes forward in time,
// e.g. to reach the fade or the wake alarm without waiting.
self.sleepyDebug = {
  session: loadSession,
  reconcile: () => serialized(reconcile),
  // Forget tonight's session without touching the video.
  reset: () =>
    serialized(async () => {
      const session = await loadSession();
      if (!session) return;
      await endSession(session, { restore: false });
      await closeWakeWindow(session);
    }),
  fastForward: (minutes) =>
    serialized(async () => {
      const session = await loadSession();
      if (!session) return null;
      const ms = minutes * MINUTE;
      session.armedAt -= ms;
      const fade = session.fade;
      if (fade) for (const k of ['fadeStartAt', 'fadeEndAt', 'muteAt']) fade[k] -= ms;
      const wake = session.wake;
      if (wake) {
        for (const k of ['wakeAt', 'nextRingAt', 'ringStartedAt', 'firstRangAt']) {
          if (wake[k] != null) wake[k] -= ms;
        }
      }
      await chrome.storage.local.set({ [KEY_SESSION]: session });
      return reconcile();
    }),
};
