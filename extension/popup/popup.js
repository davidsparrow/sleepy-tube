/*
 * SleepyTube popup: two switches, Fade to Sleep and Alarm.
 *
 * The service worker owns the session and writes it to chrome.storage.local;
 * the popup renders from storage and recomputes countdowns every second from
 * the stored timestamps, so it is correct whenever it is reopened.
 */
'use strict';

const core = globalThis.SleepyCore;
const { STATE, FADE } = core;
const $ = (id) => document.getElementById(id);

const STEP_ORDER = [STATE.ARMED, STATE.FADING, STATE.WHISPER, STATE.MUTED];
const CHIP_OPTIONS = {
  delayMinutes: core.DELAY_OPTIONS,
  fadeMinutes: core.FADE_OPTIONS,
  whisperMinutes: core.WHISPER_OPTIONS,
};
// A row's chips stop working once its step has started.
const ROW_STEP = { delayMinutes: 0, fadeMinutes: 1, whisperMinutes: 2 };

let session = null;
let notices = [];
let settings = { ...core.DEFAULT_SETTINGS };
let activeTab = { id: null, hasVideo: false, paused: false, checked: false };

const ui = {
  busy: false,
  testing: false,
  testTimer: null,
  announced: '',
  lastState: null,
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
  for (const id of ['fade-error', 'alarm-error', 'limits-error']) showError(id, '');
}

function announce(text) {
  if (!text || text === ui.announced) return;
  ui.announced = text;
  $('live').textContent = text;
}

let inflight = Promise.resolve();

/**
 * Runs a service-worker action; shows its error in `errorId` if it fails.
 * A click while another action is running is ignored (so a double-click can't
 * flip a switch back), unless `queue` is set: chip choices wait their turn.
 */
function act(type, payload, errorId, onOk, { queue = false } = {}) {
  if (ui.busy && !queue) return Promise.resolve(null);
  const run = inflight.then(() => runAction(type, payload, errorId, onOk));
  inflight = run.catch(() => {});
  return run;
}

async function runAction(type, payload, errorId, onOk) {
  ui.busy = true;
  clearErrors();
  try {
    const res = await send(type, payload);
    if (!res.ok) {
      showError(errorId, res.message || 'Something went wrong. Please try again.');
      return res;
    }
    if ('session' in res) session = res.session;
    if (onOk) await onOk(res);
    return res;
  } finally {
    ui.busy = false;
    render();
  }
}

const clock = (ms) => core.formatClockShort(ms);

function fadeOn() {
  return !!session && core.fadeIsOn(session.fade);
}

function wakeOn() {
  return !!session && core.wakeIsOn(session.wake);
}

// --- Chips ---------------------------------------------------------------------

function buildChips() {
  for (const group of document.querySelectorAll('.chips')) {
    const key = group.dataset.key;
    for (const minutes of CHIP_OPTIONS[key]) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-label', `${minutes} minutes`);
      chip.dataset.value = String(minutes);
      chip.textContent = String(minutes);
      chip.addEventListener('click', () => chooseChip(key, minutes));
      group.appendChild(chip);
    }
    group.addEventListener('keydown', (event) => onChipKey(event, key));
  }
}

function onChipKey(event, key) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if (!step && event.key !== 'Home' && event.key !== 'End') return;
  event.preventDefault();
  const options = CHIP_OPTIONS[key];
  const current = options.indexOf(currentChoices()[key]);
  let next = current + (step || 0);
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = options.length - 1;
  next = Math.max(0, Math.min(options.length - 1, next));
  if (next !== current) chooseChip(key, options[next], { focus: true });
}

function currentChoices() {
  return core.fadeChoices(fadeOn() ? session.fade : settings);
}

function chipsLocked(key, now) {
  const fade = fadeOn() ? session.fade : null;
  if (!fade || fade.status !== FADE.ACTIVE) return false;
  return STEP_ORDER.indexOf(core.fadePhaseAt(fade, now)) > ROW_STEP[key];
}

async function chooseChip(key, minutes, { focus } = {}) {
  if (chipsLocked(key, Date.now())) {
    showError('fade-error', 'That part of the fade has already started.');
    return;
  }
  await saveSettings({ [key]: minutes });
  if (fadeOn()) await act('fade-retime', { [key]: minutes }, 'fade-error', null, { queue: true });
  else render();
  if (focus) document.querySelector(`.chips[data-key="${key}"] [aria-checked="true"]`)?.focus();
}

function renderChips(now) {
  const choices = currentChoices();
  for (const group of document.querySelectorAll('.chips')) {
    const key = group.dataset.key;
    const locked = chipsLocked(key, now);
    group.setAttribute('aria-disabled', String(locked));
    for (const chip of group.children) {
      const checked = Number(chip.dataset.value) === choices[key];
      chip.setAttribute('aria-checked', String(checked));
      chip.tabIndex = checked && !locked ? 0 : -1;
    }
  }
}

// --- Fade to Sleep ----------------------------------------------------------------

async function toggleFade() {
  if (fadeOn()) {
    await act('fade-off', {}, 'fade-error', () => announce('Fade to Sleep is off.'));
    return;
  }
  if (!activeTab.hasVideo) {
    showError('fade-error', 'Open a YouTube video first, then switch this on.');
    return;
  }
  const choices = core.fadeChoices(settings);
  await act('fade-on', { tabId: activeTab.id, ...choices }, 'fade-error', () =>
    announce(`Fade to Sleep is on. The fade begins in ${choices.delayMinutes} minutes.`),
  );
}

function renderFade(d, now) {
  const fade = d.fadeOn ? session.fade : null;
  $('fader').classList.toggle('on', !!fade);
  const sw = $('fade-switch');
  sw.setAttribute('aria-checked', String(!!fade));
  sw.setAttribute('aria-disabled', String(!fade && !activeTab.hasVideo));

  // Hint line under the heading.
  let hint = '';
  let warn = false;
  if (!fade) {
    if (!activeTab.checked) hint = 'Looking for a YouTube video…';
    else if (!activeTab.hasVideo) {
      hint = 'Open a YouTube video first';
      warn = true;
    } else if (activeTab.paused) hint = 'Your video is paused. It will fade while it plays.';
  } else if (d.fadePhase === STATE.MUTED && !d.fadeOverridden) {
    hint = `Silent since ${clock(fade.muteAt)}. Switch off to bring the sound back.`;
  } else if (fade.tabId !== activeTab.id) {
    hint = 'Fading the video in another tab.';
  }
  setText($('fade-hint'), hint);
  $('fade-hint').classList.toggle('warn', warn);

  renderChips(now);

  // Times next to each row: a preview when off, the actual plan when on.
  const times = fade || core.planFadeTimes(now, settings);
  const phaseIndex = fade ? STEP_ORDER.indexOf(d.fadePhase) : -1;
  const steps = [
    ['delay', `fade begins @ ${clock(times.fadeStartAt)}`, times.fadeStartAt],
    ['fade', `fade ends @ ${clock(times.fadeEndAt)}`, times.fadeEndAt],
    ['whisper', `silence @ ${clock(times.muteAt)}`, times.muteAt],
  ];
  steps.forEach(([row, label, endsAt], i) => {
    const el = $(`row-${row}`);
    const current = !!fade && !d.fadeOverridden && i === phaseIndex;
    setText($(`${row}-meta`), label);
    const left = el.querySelector('.left');
    left.hidden = !current;
    if (current) setText(left.querySelector('.left-time'), core.formatDuration(endsAt - now));
    el.classList.toggle('current', current);
    el.classList.toggle('done', !!fade && !d.fadeOverridden && i < phaseIndex);
  });
  $('row-fade').hidden = $('row-whisper').hidden = !fade;
  $('silence-preview').hidden = !!fade;
  setText($('silence-preview'), `silence @ ${clock(times.muteAt)}`);

  $('override').hidden = !d.fadeOverridden;
  $('fade-actions').hidden = !fade;
  const silent = d.fadePhase === STATE.MUTED;
  for (const button of document.querySelectorAll('[data-extend]')) {
    button.disabled = ui.busy || silent || d.fadeOverridden;
  }
  $('restart').disabled = $('fade-cancel').disabled = $('resume').disabled = ui.busy;
}

// --- Alarm ---------------------------------------------------------------------------

/** The wake time on show: the real one when on, the remembered one when off. */
function displayedWakeAt(now) {
  return wakeOn() ? session.wake.nextRingAt : core.nextOccurrence(settings.wakeTime, now);
}

async function toggleAlarm() {
  if (wakeOn()) {
    await act('alarm-off', {}, 'alarm-error', () => announce('Alarm is off.'));
    return;
  }
  const at = displayedWakeAt(Date.now());
  await act('alarm-on', { at }, 'alarm-error', () => announce(`Alarm set for ${core.formatWakeShort(at)}.`));
}

async function rememberWakeTime() {
  if (wakeOn()) await saveSettings({ wakeTime: core.clockTimeOf(session.wake.nextRingAt) });
}

function shiftAlarm(minutes) {
  return act('alarm-shift', { minutes }, 'alarm-error', async () => {
    await rememberWakeTime();
    announce(`Alarm moved to ${core.formatWakeShort(session.wake.nextRingAt)}.`);
  });
}

function openPicker() {
  if (!wakeOn()) return;
  const input = $('wake-input');
  const now = Date.now();
  input.min = core.toDateTimeLocal(now);
  input.max = core.toDateTimeLocal(now + core.WAKE_MAX_AHEAD_MS);
  input.value = core.toDateTimeLocal(session.wake.nextRingAt);
  try {
    input.showPicker();
  } catch {
    // No picker available: let the user type into the field instead.
    input.classList.remove('picker-input');
    input.removeAttribute('aria-hidden');
    input.tabIndex = 0;
    input.setAttribute('aria-label', 'Wake date and time');
    input.focus();
  }
}

function onPickerChange() {
  const at = core.parseDateTimeLocal($('wake-input').value);
  if (at == null) return null;
  return act('alarm-set', { at }, 'alarm-error', async () => {
    await rememberWakeTime();
    announce(`Alarm set for ${core.formatWakeShort(at)}.`);
  });
}

function renderAlarm(d, now) {
  const wake = d.wakeOn ? session.wake : null;
  $('alarm').classList.toggle('on', !!wake);
  $('alarm-switch').setAttribute('aria-checked', String(!!wake));

  const ringing = d.state === STATE.WAKING;
  const snoozed = d.state === STATE.SNOOZED;
  $('alarm-set').hidden = ringing || snoozed;
  $('alarm-ringing').hidden = !(ringing || snoozed);

  if (ringing || snoozed) {
    setText($('ring-title'), ringing ? 'Good morning ☀' : 'Snoozing');
    setText($('ring-time'), ringing ? clock(now) : core.formatDuration(wake.nextRingAt - now));
    let sub = `Rings again at ${clock(wake.nextRingAt)}`;
    if (ringing) {
      sub = wake.audioError
        ? `The chime couldn't play (${wake.audioError}). Check your sound.`
        : `Your ${clock(wake.wakeAt)} alarm`;
    }
    setText($('ring-sub'), sub);
    $('snooze').hidden = !ringing;
    setText($('awake'), ringing ? "I'm awake" : "I'm awake · turn off alarm");
    $('snooze').disabled = $('awake').disabled = ui.busy;
    return;
  }

  setText($('wake-display'), core.formatWakeShort(displayedWakeAt(now)));
  $('pick-time').disabled = !wake;
  $('pick-time').title = wake ? 'Choose the wake date and time' : 'Switch the alarm on to change the time';
  let meta = '';
  if (wake) {
    meta = `Rings in ${core.formatDuration(wake.nextRingAt - now)}. Chrome must stay open; computer must stay awake.`;
    if (wake.keepAwake) meta += ' Keeping the computer awake.';
    if (wake.audioError) meta += ` The last alarm sound failed (${wake.audioError}).`;
  }
  setText($('wake-meta'), meta);
  $('wake-meta').hidden = !meta;
  $('alarm-actions').hidden = !wake;
  for (const id of ['wake-plus', 'wake-minus', 'alarm-cancel']) $(id).disabled = ui.busy;
}

// --- Test sound and limitations ------------------------------------------------------

function updateTestButtons() {
  $('test-icon').setAttribute('d', ui.testing ? 'M7 6h10v12H7z' : 'M8 5.5v13l11-6.5z');
  for (const id of ['test-sound', 'limits-test']) $(id).setAttribute('aria-pressed', String(ui.testing));
  $('test-sound').setAttribute('aria-label', ui.testing ? 'Stop test sound' : 'Test wake sound');
  setText($('limits-test'), ui.testing ? '■ Stop' : '▶ Test');
}

function endTest() {
  clearTimeout(ui.testTimer);
  ui.testing = false;
  updateTestButtons();
}

async function toggleTest(errorId) {
  clearErrors();
  if (ui.testing) {
    await send('stop-test');
    endTest();
    return;
  }
  const res = await send('test-sound', { volume: settings.wakeVolume });
  if (!res.ok) {
    showError(errorId, res.message);
    return;
  }
  ui.testing = true;
  updateTestButtons();
  ui.testTimer = setTimeout(endTest, res.durationMs + 300);
}

function renderLimits() {
  $('keep-awake').setAttribute('aria-checked', String(!!settings.keepAwake));
  $('wake-volume').value = String(Math.round(settings.wakeVolume * 100));
}

async function toggleKeepAwake() {
  clearErrors();
  const on = !settings.keepAwake;
  let granted = !on;
  if (on) {
    try {
      granted = await chrome.permissions.request({ permissions: ['power'] });
    } catch {
      granted = false;
    }
    if (!granted) showError('limits-error', 'SleepyTube needs your permission to keep the computer awake.');
  }
  await saveSettings({ keepAwake: on && granted });
  renderLimits();
  if (wakeOn()) await act('alarm-options', { keepAwake: settings.keepAwake }, 'limits-error');
}

async function onVolumeChange(event) {
  await saveSettings({ wakeVolume: Number(event.target.value) / 100 });
  if (wakeOn()) await act('alarm-options', { volume: settings.wakeVolume }, 'limits-error');
}

function openInfo() {
  chrome.tabs.create({ url: chrome.runtime.getURL('info/info.html') });
  window.close();
}

// --- Notices ---------------------------------------------------------------------------

function renderNotices() {
  const list = $('notices');
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
      close.addEventListener('click', async () => {
        await send('dismiss-notice', { id: notice.id });
        notices = notices.filter((n) => n.id !== notice.id);
        render();
      });
      item.append(text, close);
      return item;
    }),
  );
}

// --- Rendering ---------------------------------------------------------------------

function describeForAnnouncement(d) {
  if (d.state === STATE.WAKING) return 'Wake alarm ringing.';
  if (d.state === STATE.SNOOZED) return 'Alarm snoozed.';
  if (d.fadeOverridden) return 'You changed the volume, so the fade is paused.';
  return '';
}

function render() {
  const now = Date.now();
  const d = core.describeSession(session, now);
  document.body.classList.toggle('is-on', d.fadeOn || d.wakeOn);
  document.body.classList.toggle('has-notices', notices.length > 0);
  renderNotices();
  renderFade(d, now);
  renderAlarm(d, now);
  const key = `${d.state}:${d.fadeOverridden}`;
  if (key !== ui.lastState) {
    ui.lastState = key;
    announce(describeForAnnouncement(d));
    if (d.state === STATE.WAKING) $('ring-title').focus();
  }
}

// --- Startup ---------------------------------------------------------------------

async function checkActiveTab() {
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    tab = null;
  }
  activeTab = { id: tab ? tab.id : null, hasVideo: false, paused: false, checked: false };
  if (tab && core.isYouTubeUrl(tab.url)) {
    const probe = await send('probe-tab', { tabId: tab.id });
    activeTab.hasVideo = !!(probe && probe.hasVideo);
    activeTab.paused = !!(probe && probe.paused);
  }
  activeTab.checked = true;
}

function bindEvents() {
  $('fade-switch').addEventListener('click', toggleFade);
  $('fade-title').addEventListener('click', toggleFade);
  $('fade-cancel').addEventListener('click', () =>
    act('fade-off', {}, 'fade-error', () => announce('Fade to Sleep is off.')),
  );
  $('restart').addEventListener('click', () =>
    act('fade-restart', {}, 'fade-error', () => announce('Countdown restarted.')),
  );
  $('resume').addEventListener('click', () => act('fade-resume', {}, 'fade-error', () => announce('Fade resumed.')));
  for (const button of document.querySelectorAll('[data-extend]')) {
    const minutes = Number(button.dataset.extend);
    button.addEventListener('click', () =>
      act('fade-extend', { minutes }, 'fade-error', () => announce(`Added ${minutes} minutes.`)),
    );
  }

  $('alarm-switch').addEventListener('click', toggleAlarm);
  $('alarm-title').addEventListener('click', toggleAlarm);
  $('alarm-cancel').addEventListener('click', () => act('alarm-off', {}, 'alarm-error', () => announce('Alarm is off.')));
  $('wake-plus').addEventListener('click', () => shiftAlarm(10));
  $('wake-minus').addEventListener('click', () => shiftAlarm(-10));
  $('pick-time').addEventListener('click', openPicker);
  $('wake-input').addEventListener('change', onPickerChange);
  $('test-sound').addEventListener('click', () => toggleTest('alarm-error'));
  $('snooze').addEventListener('click', () =>
    act('snooze', {}, 'alarm-error', () => {
      announce('Snoozed for 9 minutes.');
      setTimeout(() => $('awake').focus());
    }),
  );
  $('awake').addEventListener('click', () =>
    act('dismiss', {}, 'alarm-error', () => {
      announce('Alarm off. Good morning!');
      setTimeout(() => $('alarm-switch').focus());
    }),
  );

  $('limits-link').addEventListener('click', () => {
    renderLimits();
    $('limits').showModal();
  });
  $('limits-close').addEventListener('click', () => $('limits').close());
  $('keep-awake').addEventListener('click', toggleKeepAwake);
  $('wake-volume').addEventListener('change', onVolumeChange);
  $('limits-test').addEventListener('click', () => toggleTest('limits-error'));
  $('limits-info').addEventListener('click', openInfo);
  $('info-link').addEventListener('click', openInfo);
}

async function init() {
  buildChips();
  bindEvents();

  const stored = await chrome.storage.local.get(['settings', 'session', 'notices']);
  const saved = stored.settings || {};
  settings = { ...core.DEFAULT_SETTINGS, ...saved, ...core.fadeChoices(saved) };
  if (!core.parseClockTime(settings.wakeTime)) settings.wakeTime = core.DEFAULT_SETTINGS.wakeTime;
  session = stored.session && stored.session.v === core.SESSION_VERSION ? stored.session : null;
  notices = stored.notices || [];
  render();

  const [status] = await Promise.all([send('get-status'), checkActiveTab()]);
  if (status.ok) {
    session = status.session;
    notices = status.notices || [];
  }
  if (settings.keepAwake && !(await chrome.permissions.contains({ permissions: ['power'] }))) {
    await saveSettings({ keepAwake: false });
  }
  render();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.session) session = changes.session.newValue || null;
    if (changes.notices) notices = changes.notices.newValue || [];
    if (changes.session || changes.notices) render();
  });
  setInterval(render, 1000);
}

init();
