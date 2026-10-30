/*
 * SleepyTube wake screen: a conspicuous window with large Snooze / I'm awake
 * buttons. It renders from the stored session, so it stays correct across
 * snoozes and service worker restarts.
 *
 * If the offscreen player reported that it could not play the chime, this
 * page plays it instead as a backup.
 */
'use strict';

const core = globalThis.SleepyCore;
const { STATE, FADE, WAKE } = core;
const $ = (id) => document.getElementById(id);

let session = null;
let busy = false;
let backup = null; // { audio, timer, ringId } while this page plays the chime
let announced = '';

function send(type) {
  return chrome.runtime
    .sendMessage({ type })
    .then((response) => response || { ok: false, message: 'SleepyTube did not respond. Please try again.' })
    .catch((error) => ({ ok: false, message: String((error && error.message) || error) }));
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function announce(text) {
  if (text && text !== announced) {
    announced = text;
    $('live').textContent = text;
  }
}

function startBackupAudio(wake, ringId) {
  if (backup && backup.ringId === ringId) return;
  stopBackupAudio();
  const audio = new Audio('../sounds/wake-chime.ogg');
  audio.loop = true;
  const level = () => core.wakeRampVolume(Date.now() - wake.ringStartedAt, wake.volume);
  audio.volume = level();
  audio.play().catch(() => {});
  backup = { audio, ringId, timer: setInterval(() => (audio.volume = level()), 250) };
}

function stopBackupAudio() {
  if (!backup) return;
  clearInterval(backup.timer);
  backup.audio.pause();
  backup = null;
}

/** Keeps keyboard focus on the main control after the buttons change. */
function refocus() {
  const target = ['snooze', 'awake', 'restore', 'close'].map($).find((b) => !b.hidden);
  if (target && (document.activeElement === document.body || document.activeElement.hidden)) target.focus();
}

async function act(type) {
  if (busy) return;
  busy = true;
  render();
  const res = await send(type);
  busy = false;
  const error = $('error');
  error.hidden = res.ok;
  setText(error, res.ok ? '' : res.message || 'Something went wrong.');
  if (res.ok && 'session' in res) session = res.session;
  render();
  refocus();
}

function render() {
  const now = Date.now();
  setText($('clock'), core.formatClock(now));
  const d = core.describeSession(session, now);
  const wake = session && session.wake;
  const fade = session && session.fade;
  const ringing = d.state === STATE.WAKING;
  const snoozed = d.state === STATE.SNOOZED;

  let title;
  let sub;
  if (ringing) {
    title = 'Good morning';
    sub = `Your ${core.formatClock(wake.wakeAt)} SleepyTube alarm`;
  } else if (snoozed) {
    title = 'Snoozing';
    sub = `Rings again at ${core.formatClock(wake.nextRingAt)} (in ${core.formatDuration(wake.nextRingAt - now)}).`;
  } else if (wake && wake.status === WAKE.DISMISSED) {
    title = 'Have a lovely day ☀️';
    sub = 'Your wake alarm is off.';
  } else if (wake && wake.status === WAKE.EXPIRED) {
    title = 'Alarm stopped';
    sub = 'It rang for 15 minutes and turned itself off.';
  } else if (wake && wake.status === WAKE.MISSED) {
    title = 'Wake alarm missed';
    sub = 'It could not ring on time, so it was skipped rather than sounding late.';
  } else if (wake && core.isWakePending(wake)) {
    title = 'Wake alarm set';
    sub = `Rings at ${core.formatWakeWhen(wake.nextRingAt, now)}.`;
  } else {
    title = 'No wake alarm';
    sub = 'Nothing is ringing.';
  }
  setText($('title'), title);
  setText($('sub'), sub);
  document.title = ringing ? '⏰ Wake up · SleepyTube' : 'SleepyTube';
  announce(ringing ? 'Wake alarm ringing.' : snoozed ? 'Alarm snoozed.' : '');

  const audioError = $('audio-error');
  audioError.hidden = !(ringing && wake.audioError);
  setText(audioError, ringing && wake.audioError ? `The alarm player failed (${wake.audioError}); playing here instead.` : '');
  // Never longer than the alarm's own 15-minute limit, even after a long sleep.
  const withinLimit = ringing && now - wake.ringStartedAt < core.WAKE_AUTO_STOP_MS;
  if (withinLimit && wake.audioError) startBackupAudio(wake, `${session.id}:${wake.ringStartedAt}`);
  else stopBackupAudio();

  const canRestore = !!fade && fade.status === FADE.ACTIVE && now >= fade.fadeStartAt;
  const after = !ringing && !snoozed;
  $('snooze').hidden = !ringing;
  $('awake').hidden = after;
  $('awake').classList.toggle('btn-primary', snoozed);
  setText($('awake'), snoozed ? "I'm awake · turn off alarm" : "I'm awake");
  $('restore').hidden = !(after && canRestore);
  $('close').hidden = !after;
  $('note').hidden = after && !canRestore;
  for (const id of ['snooze', 'awake', 'restore']) $(id).disabled = busy;
}

$('snooze').addEventListener('click', () => act('snooze'));
$('awake').addEventListener('click', () => act('dismiss'));
$('restore').addEventListener('click', () => act('restore-sound'));
$('close').addEventListener('click', () => window.close());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.session) return;
  session = changes.session.newValue || null;
  render();
});

chrome.storage.local.get('session').then(({ session: stored }) => {
  session = stored || null;
  render();
  // Safer default for a sleepy key press: Snooze, not dismiss.
  if (!$('snooze').hidden) $('snooze').focus();
});
setInterval(render, 1000);
