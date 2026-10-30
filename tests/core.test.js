'use strict';

// Fix the zone so date maths (including DST) is deterministic.
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/lib/core.js');

const { MINUTE, STATE, FADE, WAKE } = core;
const at = (y, mo, d, h, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

test('product constants match the PRD', () => {
  assert.deepEqual([...core.FADE_START_OPTIONS], [5, 10, 15, 20, 30, 45, 60, 90]);
  assert.equal(core.DEFAULT_FADE_START_MINUTES, 20);
  assert.equal(core.FADE_DURATION_MS, 10 * MINUTE);
  assert.equal(core.WHISPER_HOLD_MS, 5 * MINUTE);
  assert.ok(core.WHISPER_RATIO >= 0.03 && core.WHISPER_RATIO <= 0.05);
  assert.equal(core.SNOOZE_MS, 9 * MINUTE);
  assert.equal(core.WAKE_RAMP_MS, 90 * 1000);
  assert.equal(core.WAKE_AUTO_STOP_MS, 15 * MINUTE);
  assert.equal(core.WAKE_LATE_LIMIT_MS, 10 * MINUTE);
});

test('parseClockTime accepts HH:MM and rejects junk', () => {
  assert.deepEqual(core.parseClockTime('07:00'), { hours: 7, minutes: 0 });
  assert.deepEqual(core.parseClockTime('23:59'), { hours: 23, minutes: 59 });
  assert.equal(core.parseClockTime('24:00'), null);
  assert.equal(core.parseClockTime('7am'), null);
  assert.equal(core.parseClockTime(''), null);
});

test('nextOccurrence picks the next local clock time', () => {
  const now = at(2026, 10, 30, 23, 0);
  assert.equal(core.nextOccurrence('07:00', now), at(2026, 10, 31, 7, 0));
  assert.equal(core.nextOccurrence('23:30', now), at(2026, 10, 30, 23, 30));
});

test('nextOccurrence rolls a time equal to now to tomorrow', () => {
  const now = at(2026, 10, 30, 7, 0);
  assert.equal(core.nextOccurrence('07:00', now), at(2026, 10, 31, 7, 0));
});

test('nextOccurrence lands on the wall-clock time across a DST change', () => {
  // US DST ends 2026-11-01 at 2:00 AM: the night is 25 hours long.
  const now = at(2026, 10, 31, 23, 0);
  const wake = core.nextOccurrence('07:00', now);
  assert.equal(new Date(wake).getHours(), 7);
  assert.equal(wake - now, 9 * 60 * MINUTE); // 8 wall-clock hours + the repeated hour
});

test('planFadeTimes: 20 min countdown, 10 min fade, 5 min whisper', () => {
  const now = at(2026, 10, 30, 23, 0);
  const t = core.planFadeTimes(now, 20 * MINUTE);
  assert.equal(t.fadeStartAt, at(2026, 10, 30, 23, 20));
  assert.equal(t.fadeEndAt, at(2026, 10, 30, 23, 30));
  assert.equal(t.muteAt, at(2026, 10, 30, 23, 35));
});

test('fade phases follow the PRD timeline', () => {
  const fade = { ...core.planFadeTimes(at(2026, 10, 30, 23, 0), 20 * MINUTE), startVolume: 0.8 };
  assert.equal(core.fadePhaseAt(fade, at(2026, 10, 30, 23, 19, 59)), STATE.ARMED);
  assert.equal(core.fadePhaseAt(fade, at(2026, 10, 30, 23, 20)), STATE.FADING);
  assert.equal(core.fadePhaseAt(fade, at(2026, 10, 30, 23, 30)), STATE.WHISPER);
  assert.equal(core.fadePhaseAt(fade, at(2026, 10, 30, 23, 35)), STATE.MUTED);
});

test('fadeTargetAt leaves the volume alone before the fade', () => {
  const fade = { ...core.planFadeTimes(0, 20 * MINUTE), startVolume: 0.8 };
  assert.deepEqual(core.fadeTargetAt(fade, 10 * MINUTE), { phase: STATE.ARMED, volume: null, muted: null });
});

test('fade volume falls smoothly and monotonically to the whisper level', () => {
  const fade = { ...core.planFadeTimes(0, 20 * MINUTE), startVolume: 0.8 };
  let previous = Infinity;
  for (let t = fade.fadeStartAt; t <= fade.fadeEndAt; t += 5000) {
    const { volume } = core.fadeTargetAt(fade, t);
    assert.ok(volume <= previous + 1e-12, `volume rose at ${t}`);
    previous = volume;
  }
  const start = core.fadeTargetAt(fade, fade.fadeStartAt).volume;
  assert.ok(Math.abs(start - 0.8) < 1e-9);
  const whisper = core.fadeTargetAt(fade, fade.fadeEndAt);
  assert.equal(whisper.phase, STATE.WHISPER);
  assert.ok(Math.abs(whisper.volume - 0.8 * core.WHISPER_RATIO) < 1e-9);
  assert.equal(whisper.muted, null);
});

test('fade has no audible jump at either end (eased in dB)', () => {
  const fade = { ...core.planFadeTimes(0, 0), startVolume: 1 };
  const db = (v) => 20 * Math.log10(v);
  const first = db(core.fadeTargetAt(fade, 1000).volume);
  const last = db(core.fadeTargetAt(fade, fade.fadeEndAt - 1000).volume) - db(core.WHISPER_RATIO);
  assert.ok(Math.abs(first) < 0.05, `first second drops ${first} dB`);
  assert.ok(Math.abs(last) < 0.05, `last second is ${last} dB above whisper`);
  // Midway is half-way in decibels: perceptually even.
  const mid = db(core.fadeTargetAt(fade, core.FADE_DURATION_MS / 2).volume);
  assert.ok(Math.abs(mid - db(core.WHISPER_RATIO) / 2) < 0.01);
});

test('fade depends only on timestamps, not on how often it is sampled', () => {
  const fade = { ...core.planFadeTimes(0, 0), startVolume: 0.5 };
  const t = 4 * MINUTE + 321;
  assert.equal(core.fadeTargetAt(fade, t).volume, core.fadeTargetAt({ ...fade }, t).volume);
});

test('muted phase mutes and keeps the whisper volume', () => {
  const fade = { ...core.planFadeTimes(0, 0), startVolume: 0.5 };
  const target = core.fadeTargetAt(fade, fade.muteAt + 1);
  assert.equal(target.phase, STATE.MUTED);
  assert.equal(target.muted, true);
  assert.ok(Math.abs(target.volume - 0.5 * core.WHISPER_RATIO) < 1e-9);
});

test('validateSchedule refuses a wake before the fade has muted', () => {
  const now = at(2026, 10, 30, 23, 0);
  const { muteAt } = core.planFadeTimes(now, 20 * MINUTE); // 11:35 PM
  const early = core.validateSchedule({ muteAt, wakeAt: at(2026, 10, 30, 23, 30) });
  assert.equal(early.code, 'wake-before-fade-ends');
  assert.match(early.message, /later wake time or a shorter fade countdown/);
  assert.equal(core.validateSchedule({ muteAt, wakeAt: muteAt }).code, 'wake-before-fade-ends');
  assert.equal(core.validateSchedule({ muteAt, wakeAt: at(2026, 10, 31, 7, 0) }), null);
  assert.equal(core.validateSchedule({ muteAt: null, wakeAt: at(2026, 10, 31, 7, 0) }), null);
});

test('wake ramp rises from quiet to the chosen level over 90 seconds', () => {
  const start = core.wakeRampVolume(0, 0.8);
  assert.ok(start > 0 && start < 0.8 * 0.05);
  let previous = 0;
  for (let t = 0; t <= core.WAKE_RAMP_MS; t += 1000) {
    const v = core.wakeRampVolume(t, 0.8);
    assert.ok(v >= previous);
    previous = v;
  }
  assert.ok(Math.abs(core.wakeRampVolume(core.WAKE_RAMP_MS, 0.8) - 0.8) < 1e-9);
  assert.ok(Math.abs(core.wakeRampVolume(10 * MINUTE, 0.8) - 0.8) < 1e-9);
});

test('wakeDueAction rings on time, waits when early, and never rings 10+ minutes late', () => {
  const wake = { status: WAKE.SCHEDULED, nextRingAt: at(2026, 10, 31, 7, 0) };
  assert.equal(core.wakeDueAction(wake, at(2026, 10, 31, 6, 59)), 'wait');
  assert.equal(core.wakeDueAction(wake, wake.nextRingAt - 2000), 'ring'); // alarm a hair early
  assert.equal(core.wakeDueAction(wake, wake.nextRingAt), 'ring');
  assert.equal(core.wakeDueAction(wake, wake.nextRingAt + 9 * MINUTE + 59000), 'ring');
  assert.equal(core.wakeDueAction(wake, wake.nextRingAt + 10 * MINUTE), 'missed');
  assert.equal(core.wakeDueAction(wake, at(2026, 10, 31, 11, 0)), 'missed');
  assert.equal(core.wakeDueAction({ ...wake, status: WAKE.SNOOZED }, wake.nextRingAt), 'ring');
  assert.equal(core.wakeDueAction({ ...wake, status: WAKE.RINGING }, wake.nextRingAt), 'none');
  assert.equal(core.wakeDueAction({ ...wake, status: WAKE.DISMISSED }, wake.nextRingAt), 'none');
  assert.equal(core.wakeDueAction(null, 0), 'none');
});

function sampleSession(overrides = {}) {
  const now = at(2026, 10, 30, 23, 0);
  return {
    id: 's1',
    armedAt: now,
    fade: { ...core.planFadeTimes(now, 20 * MINUTE), startVolume: 0.7, status: FADE.ACTIVE, tabId: 1 },
    wake: { status: WAKE.SCHEDULED, wakeAt: at(2026, 10, 31, 7, 0), nextRingAt: at(2026, 10, 31, 7, 0) },
    notices: [],
    ...overrides,
  };
}

test('describeSession walks the state machine', () => {
  const s = sampleSession();
  assert.equal(core.describeSession(null, 0).state, STATE.IDLE);
  assert.equal(core.describeSession(s, at(2026, 10, 30, 23, 5)).state, STATE.ARMED);
  assert.equal(core.describeSession(s, at(2026, 10, 30, 23, 25)).state, STATE.FADING);
  assert.equal(core.describeSession(s, at(2026, 10, 30, 23, 32)).state, STATE.WHISPER);
  const muted = core.describeSession(s, at(2026, 10, 31, 2, 0));
  assert.equal(muted.state, STATE.MUTED);
  assert.equal(muted.finished, false, 'wake still pending');

  const ringing = { ...s, wake: { ...s.wake, status: WAKE.RINGING } };
  assert.equal(core.describeSession(ringing, at(2026, 10, 31, 7, 0)).state, STATE.WAKING);
  const snoozed = { ...s, wake: { ...s.wake, status: WAKE.SNOOZED } };
  assert.equal(core.describeSession(snoozed, at(2026, 10, 31, 7, 1)).state, STATE.SNOOZED);
  const dismissed = { ...s, wake: { ...s.wake, status: WAKE.DISMISSED } };
  const d = core.describeSession(dismissed, at(2026, 10, 31, 7, 2));
  assert.equal(d.state, STATE.DISMISSED);
  assert.equal(d.finished, true);
  const missed = { ...s, wake: { ...s.wake, status: WAKE.MISSED } };
  assert.equal(core.describeSession(missed, at(2026, 10, 31, 9, 0)).state, STATE.MISSED_WAKE);
});

test('a fade-only night finishes once muted', () => {
  const s = sampleSession({ wake: null });
  assert.equal(core.isSessionFinished(s, at(2026, 10, 30, 23, 34)), false);
  assert.equal(core.isSessionFinished(s, at(2026, 10, 30, 23, 35)), true);
  assert.equal(core.describeSession(s, at(2026, 10, 30, 23, 40)).state, STATE.MUTED);
});

test('a user override keeps the night open and needs attention', () => {
  const s = sampleSession({ wake: null });
  s.fade.status = FADE.OVERRIDDEN;
  const d = core.describeSession(s, at(2026, 10, 30, 23, 25));
  assert.equal(d.needsAttention, true);
  assert.equal(d.finished, false);
});

test('a lost tab cancels only the fade; the wake stays armed', () => {
  const s = sampleSession();
  s.fade.status = FADE.LOST;
  const d = core.describeSession(s, at(2026, 10, 30, 23, 25));
  assert.equal(d.state, STATE.ARMED);
  assert.equal(d.wakePending, true);
  const fadeOnly = sampleSession({ wake: null });
  fadeOnly.fade.status = FADE.LOST;
  assert.equal(core.describeSession(fadeOnly, at(2026, 10, 30, 23, 25)).state, STATE.ERROR);
});

test('formatDuration', () => {
  assert.equal(core.formatDuration(19 * MINUTE + 42000), '19m 42s');
  assert.equal(core.formatDuration(42000), '42s');
  assert.equal(core.formatDuration(65 * MINUTE), '1h 05m');
  assert.equal(core.formatDuration(-5), '0s');
  assert.equal(core.formatDuration(1), '1s'); // rounds up so it never shows 0 early
});

test('formatWakeWhen always includes the date and AM/PM', () => {
  const now = at(2026, 10, 30, 23, 0);
  const text = core.formatWakeWhen(at(2026, 10, 31, 7, 0), now);
  assert.match(text, /7:00\sAM tomorrow \(Sat, Oct 31\)/);
  assert.match(core.formatWakeWhen(at(2026, 10, 30, 23, 50), now), /11:50\sPM today/);
});

test('isYouTubeUrl only matches www.youtube.com', () => {
  assert.equal(core.isYouTubeUrl('https://www.youtube.com/watch?v=abc'), true);
  assert.equal(core.isYouTubeUrl('https://www.youtube.com'), true);
  assert.equal(core.isYouTubeUrl('https://www.youtube.com.evil.example/'), false);
  assert.equal(core.isYouTubeUrl('https://music.youtube.com/'), false);
  assert.equal(core.isYouTubeUrl(undefined), false);
});
