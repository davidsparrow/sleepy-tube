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
const { STATE, FADE } = core;
const $ = (id) => document.getElementById(id);

let session = null;
let busy = false;
let wasRinging = false; // this window has seen the alarm ring or snooze
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
  $('error').hidden = res.ok;
  setText($('error'), res.ok ? '' : res.message || 'Something went wrong.');
  if (res.ok && 'session' in res) session = res.session;
  render();
  refocus();
}

function render() {
  const now = Date.now();
  setText($('clock'), core.formatClockShort(now));
  const d = core.describeSession(session, now);
  const wake = d.wakeOn ? session.wake : null;
  const fade = d.fadeOn ? session.fade : null;
  const ringing = d.state === STATE.WAKING;
  const snoozed = d.state === STATE.SNOOZED;
  if (ringing || snoozed) wasRinging = true;

  let title;
  let sub;
  if (ringing) {
    title = 'Good morning';
    sub = `Your ${core.formatClockShort(wake.wakeAt)} SleepyTube alarm`;
  } else if (snoozed) {
    title = 'Snoozing';
    sub = `Rings again at ${core.formatClockShort(wake.nextRingAt)} (in ${core.formatDuration(wake.nextRingAt - now)}).`;
  } else if (wasRinging) {
    title = 'Have a lovely day ☀️';
    sub = 'Your wake alarm is off.';
  } else if (wake) {
    title = 'Alarm set';
    sub = `Rings at ${core.formatWakeShort(wake.nextRingAt)}.`;
  } else {
    title = 'No alarm is ringing';
    sub = 'Nothing to do here.';
  }
  setText($('title'), title);
  setText($('sub'), sub);
  document.title = ringing ? '⏰ Wake up · SleepyTube' : 'SleepyTube';
  announce(ringing ? 'Wake alarm ringing.' : snoozed ? 'Alarm snoozed.' : '');

  // Never longer than the alarm's own 15-minute limit, even after a long sleep.
  const withinLimit = ringing && now - wake.ringStartedAt < core.WAKE_AUTO_STOP_MS;
  const audioError = $('audio-error');
  audioError.hidden = !(withinLimit && wake.audioError);
  setText(audioError, withinLimit && wake.audioError ? `The alarm player failed (${wake.audioError}); playing here instead.` : '');
  if (withinLimit && wake.audioError) startBackupAudio(wake, `${session.id}:${wake.ringStartedAt}`);
  else stopBackupAudio();

  const canRestore = !!fade && fade.status === FADE.ACTIVE && now >= fade.fadeStartAt;
  const after = !ringing && !snoozed;
  $('snooze').hidden = !ringing;
  $('awake').hidden = after;
  setText($('awake'), snoozed ? "I'm awake · turn off alarm" : "I'm awake");
  $('restore').hidden = !(after && canRestore);
  $('close').hidden = !after;
  $('note').hidden = !canRestore;
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
