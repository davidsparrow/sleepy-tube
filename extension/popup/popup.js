/*
 * SleepyTube popup: set up the night, then show its status and controls.
 *
 * The service worker owns the session and writes it to chrome.storage.local;
 * the popup renders from storage and recomputes countdowns every second from
 * the stored timestamps, so it is correct whenever it is reopened.
 */
'use strict';

const core = globalThis.SleepyCore;
const { STATE, FADE, WAKE } = core;
const $ = (id) => document.getElementById(id);

const STEP_ORDER = [STATE.ARMED, STATE.FADING, STATE.WHISPER, STATE.MUTED];
const ERROR_IDS = { setup: 'setup-error', armed: 'armed-error', waking: 'waking-error', done: 'done-error' };

let session = null;
let settings = { ...core.DEFAULT_SETTINGS };
let activeTab = { id: null, onYouTube: false, hasVideo: false, paused: false, checked: false };

const ui = {
  view: null,
  newNight: false, // "New night…" chosen while a night exists
  confirmReplace: false,
  editingWake: false,
  wakeSnapshot: null, // settings before the wake editor opened
  testing: false,
  testTimer: null,
  busy: false,
  announced: '',
};

// --- Plumbing ------------------------------------------------------------------

function send(type, payload = {}) {
  return chrome.runtime
    .sendMessage({ type, ...payload })
    .then((response) => response || { ok: false, message: 'SleepyTube did not respond. Please try again.' })
    .catch((error) => ({ ok: false, message: String((error && error.message) || error) }));
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ settings });
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function showError(id, message) {
  const el = $(id);
  setText(el, message || '');
  el.hidden = !message;
}

function clearErrors() {
  for (const id of Object.values(ERROR_IDS)) showError(id, '');
}

function currentErrorId() {
  return ERROR_IDS[ui.view] || ERROR_IDS.setup;
}

function announce(text) {
  if (!text || text === ui.announced) return;
  ui.announced = text;
  $('live').textContent = text;
}

async function withBusy(fn) {
  if (ui.busy) return;
  ui.busy = true;
  document.body.setAttribute('aria-busy', 'true');
  try {
    await fn();
  } finally {
    ui.busy = false;
    document.body.removeAttribute('aria-busy');
    render();
  }
}

/** Runs a service-worker action and shows its error, if any. */
function act(type, payload, onOk) {
  return withBusy(async () => {
    clearErrors();
    const res = await send(type, payload);
    if (!res.ok) {
      showError(currentErrorId(), res.message || 'Something went wrong. Please try again.');
      return;
    }
    if ('session' in res) session = res.session;
    if (onOk) await onOk(res);
  });
}

const clock = (ms) => core.formatClock(ms);

// --- Fade slider -----------------------------------------------------------------

function fadeText(minutes) {
  return `${minutes} minutes`;
}

function fadeIndex(minutes) {
  const i = core.FADE_START_OPTIONS.indexOf(Number(minutes));
  return i >= 0 ? i : core.FADE_START_OPTIONS.indexOf(core.DEFAULT_FADE_START_MINUTES);
}

function buildTicks() {
  core.FADE_START_OPTIONS.forEach((minutes, i) => {
    const tick = document.createElement('button');
    tick.type = 'button';
    tick.tabIndex = -1;
    tick.textContent = String(minutes);
    tick.style.setProperty('--i', String(i));
    tick.addEventListener('click', () => {
      setFadeMinutes(minutes, true);
      $('fade-slider').focus();
    });
    $('fade-ticks').appendChild(tick);
  });
}

function showFadeValue(minutes) {
  const slider = $('fade-slider');
  slider.value = String(fadeIndex(minutes));
  slider.setAttribute('aria-valuetext', fadeText(minutes));
  $('fade-value').textContent = fadeText(minutes);
  $('fade-ticks')
    .querySelectorAll('button')
    .forEach((tick) => tick.setAttribute('aria-current', String(Number(tick.textContent) === minutes)));
}

function setFadeMinutes(minutes, persist) {
  settings.fadeMinutes = minutes;
  showFadeValue(minutes);
  renderWakeWhen();
  if (persist) saveSettings({ fadeMinutes: minutes });
}

// --- Wake controls (shared by setup and the armed view's editor) ----------------

function placeWakeSection(slotId) {
  const section = $('wake-section');
  if (section.parentElement !== $(slotId)) $(slotId).appendChild(section);
}

function applyWakeControls(values) {
  $('wake-enabled').checked = !!values.wakeEnabled;
  $('wake-time').value = values.wakeTime;
  $('wake-volume').value = String(Math.round(values.wakeVolume * 100));
  $('keep-awake').checked = !!values.keepAwake;
  $('wake-details').hidden = !values.wakeEnabled;
  renderWakeWhen();
}

function renderWakeWhen() {
  const el = $('wake-when');
  if (!el) return;
  if (!settings.wakeEnabled) {
    setText(el, '');
    return;
  }
  const now = Date.now();
  const wakeAt = core.nextOccurrence(settings.wakeTime, now);
  let message;
  let problem = null;
  if (wakeAt == null) {
    message = 'Choose a wake time.';
  } else {
    let muteAt = null;
    if (!ui.editingWake) muteAt = core.planFadeTimes(now, settings.fadeMinutes * core.MINUTE).muteAt;
    else if (session && core.fadeIsPending(session.fade, now)) muteAt = session.fade.muteAt;
    problem = core.validateSchedule({ muteAt, wakeAt });
    message = problem ? problem.message : `Rings at ${core.formatWakeWhen(wakeAt, now)}.`;
  }
  setText(el, message);
  el.classList.toggle('bad', !!problem || wakeAt == null);
}

function setWakeEnabled(enabled) {
  $('wake-enabled').checked = enabled;
  $('wake-details').hidden = !enabled;
  saveSettings({ wakeEnabled: enabled });
  renderWakeWhen();
}

async function onKeepAwakeChange(event) {
  const box = event.target;
  if (!box.checked) {
    await saveSettings({ keepAwake: false });
    return;
  }
  let granted = false;
  try {
    granted = await chrome.permissions.request({ permissions: ['power'] });
  } catch {
    granted = false;
  }
  box.checked = granted;
  await saveSettings({ keepAwake: granted });
  if (!granted) showError(currentErrorId(), 'SleepyTube needs your permission to keep the computer awake.');
}

function updateTestButton() {
  const button = $('test-sound');
  button.textContent = ui.testing ? '■ Stop test sound' : '▶ Test wake sound';
  button.setAttribute('aria-pressed', String(ui.testing));
}

function endTest() {
  clearTimeout(ui.testTimer);
  ui.testing = false;
  updateTestButton();
}

async function onTestSound() {
  clearErrors();
  if (ui.testing) {
    await send('stop-test');
    endTest();
    return;
  }
  const res = await send('test-sound', { volume: settings.wakeVolume });
  if (!res.ok) {
    showError(currentErrorId(), res.message);
    return;
  }
  ui.testing = true;
  updateTestButton();
  ui.testTimer = setTimeout(endTest, res.durationMs + 300);
}

function bindWakeControls() {
  $('wake-enabled').addEventListener('change', (e) => setWakeEnabled(e.target.checked));
  $('wake-time').addEventListener('input', (e) => {
    if (!e.target.value) return;
    settings.wakeTime = e.target.value;
    if (!settings.wakeEnabled) setWakeEnabled(true);
    renderWakeWhen();
  });
  $('wake-time').addEventListener('change', (e) => {
    if (e.target.value) saveSettings({ wakeTime: e.target.value });
  });
  $('wake-volume').addEventListener('change', (e) => saveSettings({ wakeVolume: Number(e.target.value) / 100 }));
  $('keep-awake').addEventListener('change', onKeepAwakeChange);
  $('test-sound').addEventListener('click', onTestSound);
}

function openWakeEditor() {
  clearErrors();
  ui.wakeSnapshot = { ...settings };
  const wake = session && session.wake;
  const values = wake
    ? { wakeEnabled: true, wakeTime: wake.time, keepAwake: wake.keepAwake, wakeVolume: wake.volume }
    : { ...settings, wakeEnabled: true };
  settings = { ...settings, ...values };
  ui.editingWake = true;
  applyWakeControls(settings);
  render();
  $('wake-time').focus();
}

async function closeWakeEditor({ revert }) {
  if (revert && ui.wakeSnapshot) await saveSettings(ui.wakeSnapshot);
  ui.editingWake = false;
  ui.wakeSnapshot = null;
  applyWakeControls(settings);
  render();
  $('change-wake').focus();
}

function saveWakeEditor() {
  const payload = {
    enabled: settings.wakeEnabled,
    time: settings.wakeTime,
    keepAwake: settings.keepAwake,
    volume: settings.wakeVolume,
  };
  return act('update-wake', payload, () => {
    ui.editingWake = false;
    ui.wakeSnapshot = null;
    announce(payload.enabled ? `Wake alarm set for ${core.formatWakeWhen(session.wake.nextRingAt, Date.now())}.` : 'Wake alarm removed.');
  });
}

// --- Actions ---------------------------------------------------------------------

function onArm() {
  if (!activeTab.hasVideo) {
    showError('setup-error', 'Open a YouTube video first');
    return;
  }
  const payload = {
    tabId: activeTab.id,
    fadeMinutes: settings.fadeMinutes,
    wake: {
      enabled: settings.wakeEnabled,
      time: settings.wakeTime,
      keepAwake: settings.keepAwake,
      volume: settings.wakeVolume,
    },
    replace: ui.confirmReplace,
  };
  return withBusy(async () => {
    clearErrors();
    const res = await send('arm', payload);
    if (res.ok) {
      session = res.session;
      ui.newNight = false;
      ui.confirmReplace = false;
      $('replace-confirm').hidden = true;
      announce(`Night is set. The fade begins in ${fadeText(settings.fadeMinutes)}.`);
      requestAnimationFrame(() => $('armed-label').focus());
      return;
    }
    if (res.code === 'needs-replace') {
      $('replace-confirm').hidden = false;
      $('replace-yes').focus();
      return;
    }
    showError('setup-error', res.message || 'Something went wrong. Please try again.');
  });
}

async function goToVideoTab() {
  const fade = session && session.fade;
  if (!fade) return;
  try {
    const tab = await chrome.tabs.update(fade.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    window.close();
  } catch {
    showError(currentErrorId(), 'That tab is no longer open.');
  }
}

function bindEvents() {
  $('fade-slider').addEventListener('input', (e) => setFadeMinutes(core.FADE_START_OPTIONS[Number(e.target.value)], false));
  $('fade-slider').addEventListener('change', (e) => setFadeMinutes(core.FADE_START_OPTIONS[Number(e.target.value)], true));
  $('arm').addEventListener('click', onArm);
  $('replace-yes').addEventListener('click', () => {
    ui.confirmReplace = true;
    onArm();
  });
  $('replace-no').addEventListener('click', () => {
    ui.newNight = false;
    ui.confirmReplace = false;
    $('replace-confirm').hidden = true;
    render();
  });
  $('back-to-night').addEventListener('click', () => {
    ui.newNight = false;
    $('replace-confirm').hidden = true;
    render();
  });

  $('extend').addEventListener('click', () => act('extend-fade', {}, () => announce('Added 15 minutes.')));
  $('change-wake').addEventListener('click', openWakeEditor);
  $('editor-save').addEventListener('click', saveWakeEditor);
  $('editor-cancel').addEventListener('click', () => closeWakeEditor({ revert: true }));
  $('cancel-night').addEventListener('click', () => act('cancel-night', {}, () => announce('Night cancelled.')));
  $('resume-fade').addEventListener('click', () => act('resume-fade', {}, () => announce('Fade resumed.')));
  $('cancel-fade').addEventListener('click', () => act('cancel-fade', {}, () => announce('Fade cancelled.')));
  $('goto-tab').addEventListener('click', goToVideoTab);
  $('new-night').addEventListener('click', () => {
    ui.newNight = true;
    render();
    $('fade-slider').focus();
  });

  $('snooze').addEventListener('click', () => act('snooze', {}, () => announce('Snoozed for 9 minutes.')));
  $('awake').addEventListener('click', () => act('dismiss', {}, () => announce('Alarm off. Good morning!')));

  $('restore').addEventListener('click', () => act('restore-sound', {}, () => announce('Video sound restored.')));
  $('done').addEventListener('click', () => act('finish-night', {}));

  bindWakeControls();
}

// --- Rendering -------------------------------------------------------------------

function chooseView(d) {
  if (!session || ui.newNight) return 'setup';
  if (d.state === STATE.WAKING || d.state === STATE.SNOOZED) return 'waking';
  if (d.finished) return 'done';
  return 'armed';
}

function renderNotices(listId) {
  const list = $(listId);
  const notices = (session && session.notices) || [];
  const key = notices.map((n) => n.id).join(',');
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.replaceChildren(
    ...notices.map((notice) => {
      const item = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = notice.text;
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = '×';
      close.setAttribute('aria-label', 'Dismiss this notice');
      close.addEventListener('click', () => act('dismiss-notice', { id: notice.id }));
      item.append(text, close);
      return item;
    }),
  );
}

function renderSetup(now) {
  placeWakeSection('setup-wake-slot');
  const replacing = !!session && !core.isSessionFinished(session, now);
  $('replace-note').hidden = !replacing;
  $('back-to-night').hidden = !(ui.newNight && session);

  let note = '';
  if (!activeTab.checked) note = 'Looking for a YouTube video…';
  else if (!activeTab.hasVideo) note = 'Open a YouTube video first';
  else if (activeTab.paused) note = 'Your video is paused. SleepyTube will fade it while it plays.';
  const tabNote = $('tab-note');
  setText(tabNote, note);
  tabNote.hidden = !note;
  tabNote.classList.toggle('warn', activeTab.checked && !activeTab.hasVideo);

  $('arm').disabled = ui.busy || !activeTab.hasVideo;
  renderWakeWhen();
}

function renderArmed(d, now) {
  const { fade, wake } = session;
  const fadeLive = !!fade && (fade.status === FADE.ACTIVE || fade.status === FADE.OVERRIDDEN);
  const overridden = !!fade && fade.status === FADE.OVERRIDDEN;
  const wakePending = core.isWakePending(wake);

  let label = '';
  let big = '';
  let sub = '';
  if (overridden) {
    label = 'Fade paused';
    big = 'Your volume';
    sub = 'Resume to fade again from the volume you chose, over 10 minutes.';
  } else if (fadeLive) {
    switch (d.fadePhase) {
      case STATE.ARMED:
        label = 'Fade starts in';
        big = core.formatDuration(fade.fadeStartAt - now);
        sub = `Then a 10-minute fade and 5 minutes of whisper. Silent by ${clock(fade.muteAt)}.`;
        break;
      case STATE.FADING:
        label = 'Fading gently · whisper in';
        big = core.formatDuration(fade.fadeEndAt - now);
        sub = `Silent by ${clock(fade.muteAt)}. Playback continues.`;
        break;
      case STATE.WHISPER:
        label = 'Whispering · silence in';
        big = core.formatDuration(fade.muteAt - now);
        sub = `Muted at ${clock(fade.muteAt)}. Playback continues.`;
        break;
      default:
        label = wakePending ? 'Video muted · wake alarm in' : 'Video muted';
        big = wakePending ? core.formatDuration(wake.nextRingAt - now) : clock(fade.muteAt);
        sub = `Muted at ${clock(fade.muteAt)}. The video keeps playing silently.`;
    }
  } else if (wakePending) {
    label = 'Wake alarm in';
    big = core.formatDuration(wake.nextRingAt - now);
    sub = fade && fade.status === FADE.LOST ? 'The fade was cancelled.' : 'The fade is off.';
  }
  setText($('armed-label'), label);
  setText($('armed-big'), big);
  setText($('armed-sub'), sub);

  const steps = document.querySelector('#view-armed .steps');
  steps.hidden = !fadeLive;
  steps.classList.toggle('paused', overridden);
  const currentIndex = STEP_ORDER.indexOf(d.fadePhase);
  steps.querySelectorAll('li').forEach((item, i) => {
    item.classList.toggle('done', i < currentIndex);
    if (i === currentIndex) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });

  $('override-banner').hidden = !overridden;
  renderNotices('armed-notices');

  $('armed-wake').hidden = !wake || !wakePending || ui.editingWake;
  if (wake && wakePending) {
    const when = $('armed-wake-when');
    const text = `Wake alarm: ${core.formatWakeWhen(wake.nextRingAt, now)}`;
    if (when.dataset.text !== text) {
      when.dataset.text = text;
      const strong = document.createElement('strong');
      strong.textContent = 'Wake alarm: ';
      when.replaceChildren(strong, core.formatWakeWhen(wake.nextRingAt, now));
    }
    $('armed-keep-awake').hidden = !wake.keepAwake;
    const audioError = $('armed-audio-error');
    audioError.hidden = !wake.audioError;
    setText(audioError, wake.audioError ? `The last alarm sound failed to play (${wake.audioError}).` : '');
  }

  $('armed-actions').hidden = ui.editingWake;
  $('extend').hidden = !fadeLive;
  setText($('change-wake'), wakePending ? 'Change wake time' : 'Add wake alarm');
  $('wake-editor').hidden = !ui.editingWake;
  if (ui.editingWake) placeWakeSection('editor-wake-slot');
  $('goto-tab').hidden = !fadeLive || fade.tabId === activeTab.id;
  for (const id of ['extend', 'change-wake', 'cancel-night', 'resume-fade', 'cancel-fade', 'editor-save']) {
    $(id).disabled = ui.busy;
  }
}

function renderWaking(d, now) {
  const wake = session.wake;
  const ringing = d.state === STATE.WAKING;
  setText($('waking-label'), ringing ? 'Good morning' : 'Snoozing');
  setText($('waking-big'), ringing ? clock(now) : core.formatDuration(wake.nextRingAt - now));
  setText(
    $('waking-sub'),
    ringing
      ? `Your ${clock(wake.wakeAt)} SleepyTube alarm${wake.snoozeCount ? ` · snoozed ${wake.snoozeCount}×` : ''}`
      : `Rings again at ${clock(wake.nextRingAt)}.`,
  );
  const audioError = $('waking-audio-error');
  audioError.hidden = !(ringing && wake.audioError);
  setText(audioError, wake.audioError ? `The chime could not play (${wake.audioError}). Check your sound.` : '');
  $('snooze').hidden = !ringing;
  setText($('awake'), ringing ? "I'm awake" : "I'm awake · turn off alarm");
  $('awake').classList.toggle('btn-primary', !ringing);
  $('snooze').disabled = $('awake').disabled = ui.busy;
}

function renderDone(d, now) {
  const { fade, wake } = session;
  const videoMuted = !!fade && fade.status === FADE.ACTIVE && now >= fade.muteAt;
  let label;
  let text;
  switch (d.state) {
    case STATE.DISMISSED:
      label = wake.status === WAKE.EXPIRED ? 'Alarm stopped' : 'Good morning ☀️';
      text =
        wake.status === WAKE.EXPIRED
          ? 'The wake alarm rang for 15 minutes and turned itself off.'
          : 'Your wake alarm is off. Have a lovely day.';
      break;
    case STATE.MISSED_WAKE:
      label = 'Wake alarm missed';
      text = 'The alarm could not ring on time, so it was skipped rather than sounding late.';
      break;
    case STATE.ERROR:
      label = 'Fade cancelled';
      text = 'SleepyTube lost the YouTube tab, so the fade stopped.';
      break;
    default:
      label = 'Night complete 🌙';
      text = videoMuted ? `The video was muted at ${clock(fade.muteAt)}.` : 'Nothing else is scheduled.';
  }
  if (videoMuted && d.state !== STATE.MUTED) text += ' Your video is still muted.';
  setText($('done-label'), label);
  setText($('done-text'), text);
  renderNotices('done-notices');
  const canRestore = !!fade && fade.status === FADE.ACTIVE && now >= fade.fadeStartAt;
  $('restore').hidden = !canRestore;
  $('restore').disabled = $('done').disabled = ui.busy;
}

function describeForAnnouncement(view, d) {
  if (view === 'waking') return d.state === STATE.WAKING ? 'Wake alarm ringing.' : 'Alarm snoozed.';
  if (view === 'done') return $('done-label').textContent;
  if (view === 'armed' && session.fade && session.fade.status === FADE.OVERRIDDEN) {
    return 'You changed the volume, so the fade is paused.';
  }
  return '';
}

function render() {
  const now = Date.now();
  const d = core.describeSession(session, now);
  const view = chooseView(d);
  if (view !== 'armed' && ui.editingWake) {
    ui.editingWake = false;
    ui.wakeSnapshot = null;
  }
  for (const name of ['setup', 'armed', 'waking', 'done']) $(`view-${name}`).hidden = name !== view;
  const changed = view !== ui.view;
  ui.view = view;
  if (view === 'setup') renderSetup(now);
  else if (view === 'armed') renderArmed(d, now);
  else if (view === 'waking') renderWaking(d, now);
  else renderDone(d, now);
  if (changed) announce(describeForAnnouncement(view, d));
  else if (view === 'armed' && !$('override-banner').hidden) announce(describeForAnnouncement(view, d));
}

// --- Startup ---------------------------------------------------------------------

async function checkActiveTab() {
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    tab = null;
  }
  activeTab = { id: tab ? tab.id : null, onYouTube: !!tab && core.isYouTubeUrl(tab.url), hasVideo: false, paused: false };
  if (activeTab.onYouTube) {
    const probe = await send('probe-tab', { tabId: activeTab.id });
    activeTab.hasVideo = !!(probe && probe.hasVideo);
    activeTab.paused = !!(probe && probe.paused);
  }
  activeTab.checked = true;
}

async function init() {
  $('setup-wake-slot').appendChild($('wake-template').content.cloneNode(true));
  buildTicks();
  bindEvents();

  const stored = await chrome.storage.local.get(['settings', 'session']);
  settings = { ...core.DEFAULT_SETTINGS, ...(stored.settings || {}) };
  if (!core.isValidFadeMinutes(settings.fadeMinutes)) settings.fadeMinutes = core.DEFAULT_FADE_START_MINUTES;
  session = stored.session || null;
  showFadeValue(settings.fadeMinutes);
  applyWakeControls(settings);
  render();

  const [status] = await Promise.all([send('get-status'), checkActiveTab()]);
  if (status.ok) session = status.session;
  if (settings.keepAwake && !(await chrome.permissions.contains({ permissions: ['power'] }))) {
    await saveSettings({ keepAwake: false });
    applyWakeControls(settings);
  }
  render();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.session) return;
    session = changes.session.newValue || null;
    render();
  });
  setInterval(render, 1000);
}

init();
