'use strict';

// Fix the zone so date maths (including DST) is deterministic.
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/lib/core.js');

const { MINUTE, STATE, FADE, WAKE } = core;
const at = (y, mo, d, h, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const db = (v) => 20 * Math.log10(v);
const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) <= tol, `${label}: expected ≈${b}, got ${a}`);

const NIGHT = at(2026, 10, 30, 23, 0);
const DEFAULTS = { delayMinutes: 20, fadeMinutes: 10, whisperMinutes: 10 };
const plan = (choices = DEFAULTS, from = NIGHT) => ({ ...core.planFadeTimes(from, choices), startVolume: 0.8, status: FADE.ACTIVE });

test('choices and constants', () => {
  assert.deepEqual([...core.DELAY_OPTIONS], [10, 15, 20, 30, 45, 60, 90]);
  assert.deepEqual([...core.FADE_OPTIONS], [10, 15, 20, 30]);
  assert.deepEqual([...core.WHISPER_OPTIONS], [10, 15, 20, 30]);
  assert.deepEqual([...core.EXTEND_OPTIONS], [10, 20]);
  assert.equal(core.DEFAULT_SETTINGS.delayMinutes, 20);
  assert.ok(core.WHISPER_RATIO >= 0.03 && core.WHISPER_RATIO <= 0.05);
  assert.equal(core.SNOOZE_MS, 9 * MINUTE);
  assert.equal(core.WAKE_RAMP_MS, 90 * 1000);
  assert.equal(core.WAKE_AUTO_STOP_MS, 15 * MINUTE);
  assert.equal(core.WAKE_LATE_LIMIT_MS, 10 * MINUTE);
});

test('fadeChoices keeps only allowed values', () => {
  assert.deepEqual(core.fadeChoices({ delayMinutes: 45, fadeMinutes: 30, whisperMinutes: 15 }), {
    delayMinutes: 45,
    fadeMinutes: 30,
    whisperMinutes: 15,
  });
  assert.deepEqual(core.fadeChoices({ delayMinutes: 5, fadeMinutes: 11, whisperMinutes: 'x' }), DEFAULTS);
});

test('planFadeTimes: countdown, fade, whisper, silence', () => {
  const t = core.planFadeTimes(NIGHT, { delayMinutes: 20, fadeMinutes: 15, whisperMinutes: 10 });
  assert.equal(t.fadeStartAt, at(2026, 10, 30, 23, 20));
  assert.equal(t.fadeEndAt, at(2026, 10, 30, 23, 35));
  assert.equal(t.muteAt, at(2026, 10, 30, 23, 45));
  assert.equal(t.delayStartedAt, NIGHT);
  assert.equal(t.fadeFromAt, t.fadeStartAt);
  assert.equal(t.fadeFromGain, 1);
});

test('planFadeFromNow starts the fade immediately', () => {
  const t = core.planFadeFromNow(NIGHT, { delayMinutes: 90, fadeMinutes: 20, whisperMinutes: 15 });
  assert.equal(t.fadeStartAt, NIGHT);
  assert.equal(t.fadeEndAt, NIGHT + 20 * MINUTE);
  assert.equal(t.muteAt, NIGHT + 35 * MINUTE);
  assert.equal(t.delayMinutes, 90, 'keeps the chosen countdown for a later Restart');
});

test('phases follow the timeline', () => {
  const f = plan();
  assert.equal(core.fadePhaseAt(f, f.fadeStartAt - 1), STATE.ARMED);
  assert.equal(core.fadePhaseAt(f, f.fadeStartAt), STATE.FADING);
  assert.equal(core.fadePhaseAt(f, f.fadeEndAt), STATE.WHISPER);
  assert.equal(core.fadePhaseAt(f, f.muteAt), STATE.MUTED);
});

test('the volume is untouched before the fade, then falls smoothly to a whisper and mutes', () => {
  const f = plan();
  assert.deepEqual(core.fadeTargetAt(f, f.fadeStartAt - 1), { phase: STATE.ARMED, volume: null, muted: null });
  let previous = Infinity;
  for (let t = f.fadeStartAt; t <= f.fadeEndAt; t += 5000) {
    const { volume } = core.fadeTargetAt(f, t);
    assert.ok(volume <= previous + 1e-12);
    previous = volume;
  }
  near(core.fadeTargetAt(f, f.fadeStartAt).volume, 0.8, 1e-9, 'starts at the starting volume');
  const whisper = core.fadeTargetAt(f, f.fadeEndAt);
  near(whisper.volume, 0.8 * core.WHISPER_RATIO, 1e-9, 'whisper level');
  assert.equal(whisper.muted, null);
  const silent = core.fadeTargetAt(f, f.muteAt);
  assert.equal(silent.muted, true);
});

test('the fade is even in decibels with gentle ends', () => {
  const f = { ...plan({ delayMinutes: 10, fadeMinutes: 10, whisperMinutes: 10 }), startVolume: 1 };
  near(db(core.fadeGainAt(f, f.fadeStartAt + 1000)), 0, 0.05, 'first second');
  near(db(core.fadeGainAt(f, f.fadeEndAt - 1000)), db(core.WHISPER_RATIO), 0.05, 'last second');
  near(db(core.fadeGainAt(f, f.fadeStartAt + 5 * MINUTE)), db(core.WHISPER_RATIO) / 2, 0.01, 'midway');
});

test('+10 keeps the current phase going 10 minutes longer', () => {
  const f = plan();
  // Countdown: everything moves later.
  let c = core.extendFade(f, 10, f.fadeStartAt - 5 * MINUTE);
  assert.equal(c.fadeStartAt, f.fadeStartAt + 10 * MINUTE);
  assert.equal(c.fadeEndAt, f.fadeEndAt + 10 * MINUTE);
  assert.equal(c.muteAt, f.muteAt + 10 * MINUTE);
  // Whisper: only silence moves.
  c = core.extendFade(f, 20, f.fadeEndAt + MINUTE);
  assert.deepEqual(c, { muteAt: f.muteAt + 20 * MINUTE });
  // Silent: nothing to extend.
  assert.equal(core.extendFade(f, 10, f.muteAt + 1).error, 'silent');
});

test('+10 during the fade carries on from the current level, with no jump', () => {
  const f = plan();
  const now = f.fadeStartAt + 4 * MINUTE;
  const before = core.fadeTargetAt(f, now).volume;
  const extended = { ...f, ...core.extendFade(f, 10, now) };
  assert.equal(extended.fadeEndAt, f.fadeEndAt + 10 * MINUTE);
  assert.equal(extended.muteAt, f.muteAt + 10 * MINUTE);
  near(core.fadeTargetAt(extended, now).volume, before, 1e-9, 'same volume at the moment of extending');
  // It still keeps falling and reaches the whisper at the new end.
  assert.ok(core.fadeTargetAt(extended, now + MINUTE).volume < before);
  near(core.fadeTargetAt(extended, extended.fadeEndAt).volume, 0.8 * core.WHISPER_RATIO, 1e-9, 'whisper');
});

test('changing chips before the fade re-plans from when the countdown began', () => {
  const f = plan();
  const now = NIGHT + 5 * MINUTE;
  const c = core.retimeFade(f, { delayMinutes: 30 }, now);
  assert.equal(c.fadeStartAt, NIGHT + 30 * MINUTE);
  assert.equal(c.fadeEndAt, NIGHT + 40 * MINUTE);
  assert.equal(c.muteAt, NIGHT + 50 * MINUTE);
  // A countdown shorter than the time already passed starts the fade now.
  assert.equal(core.retimeFade(f, { delayMinutes: 10 }, NIGHT + 12 * MINUTE).fadeStartAt, NIGHT + 12 * MINUTE);
  // Fade length and whisper length chips.
  const g = core.retimeFade(f, { fadeMinutes: 30 }, now);
  assert.equal(g.fadeEndAt, f.fadeStartAt + 30 * MINUTE);
  assert.equal(g.muteAt, f.fadeStartAt + 40 * MINUTE);
  assert.equal(core.retimeFade(f, { whisperMinutes: 20 }, now).muteAt, f.fadeEndAt + 20 * MINUTE);
});

test('chips for phases that have started are locked', () => {
  const f = plan();
  assert.equal(core.retimeFade(f, { delayMinutes: 30 }, f.fadeStartAt + 1).error, 'locked');
  assert.equal(core.retimeFade(f, { fadeMinutes: 20 }, f.fadeEndAt + 1).error, 'locked');
  assert.equal(core.retimeFade(f, { whisperMinutes: 20 }, f.muteAt + 1).error, 'locked');
  // Choosing the value that's already set is never an error.
  assert.equal(core.retimeFade(f, { delayMinutes: 20 }, f.muteAt + 1).error, undefined);
});

test('changing the fade length mid-fade rebases without a jump', () => {
  const f = plan({ delayMinutes: 20, fadeMinutes: 30, whisperMinutes: 10 });
  const now = f.fadeStartAt + 12 * MINUTE;
  const before = core.fadeTargetAt(f, now).volume;
  const shorter = { ...f, ...core.retimeFade(f, { fadeMinutes: 15 }, now) };
  assert.equal(shorter.fadeEndAt, f.fadeStartAt + 15 * MINUTE);
  near(core.fadeTargetAt(shorter, now).volume, before, 1e-9, 'no jump');
  // Shorter than the time already faded: finish over the next minute instead.
  const tooShort = { ...f, ...core.retimeFade(f, { fadeMinutes: 10 }, now) };
  assert.equal(tooShort.fadeEndAt, now + core.MIN_FADE_REMAINING_MS);
  assert.equal(tooShort.muteAt, now + core.MIN_FADE_REMAINING_MS + 10 * MINUTE);
});

test('a shorter whisper chosen mid-whisper mutes now rather than in the past', () => {
  const f = plan({ delayMinutes: 20, fadeMinutes: 10, whisperMinutes: 30 });
  const now = f.fadeEndAt + 20 * MINUTE;
  assert.equal(core.retimeFade(f, { whisperMinutes: 10 }, now).muteAt, now);
});

test('nextOccurrence picks the next local clock time, across DST', () => {
  assert.equal(core.nextOccurrence('07:00', NIGHT), at(2026, 10, 31, 7, 0));
  assert.equal(core.nextOccurrence('23:30', NIGHT), at(2026, 10, 30, 23, 30));
  assert.equal(core.nextOccurrence('23:00', NIGHT), at(2026, 10, 31, 23, 0), 'equal to now rolls over');
  const beforeDst = at(2026, 10, 31, 23, 0); // US DST ends 2026-11-01 02:00
  const wake = core.nextOccurrence('07:00', beforeDst);
  assert.equal(new Date(wake).getHours(), 7);
  assert.equal(wake - beforeDst, 9 * 60 * MINUTE);
});

test('datetime-local values round-trip in local time', () => {
  const t = at(2026, 10, 31, 7, 30);
  assert.equal(core.toDateTimeLocal(t), '2026-10-31T07:30');
  assert.equal(core.parseDateTimeLocal('2026-10-31T07:30'), t);
  assert.equal(core.parseDateTimeLocal('nope'), null);
  assert.equal(core.clockTimeOf(t), '07:30');
});

test('validateWakeAt: within 24 hours and after the video goes silent', () => {
  const muteAt = NIGHT + 40 * MINUTE;
  assert.equal(core.validateWakeAt(at(2026, 10, 31, 7, 0), NIGHT, muteAt), null);
  assert.equal(core.validateWakeAt(NIGHT - MINUTE, NIGHT, null).code, 'past');
  assert.equal(core.validateWakeAt(NIGHT + 25 * 60 * MINUTE, NIGHT, null).code, 'too-far');
  assert.equal(core.validateWakeAt(NIGHT + 24 * 60 * MINUTE, NIGHT, null), null, 'exactly 24 hours is fine');
  const early = core.validateWakeAt(NIGHT + 30 * MINUTE, NIGHT, muteAt);
  assert.equal(early.code, 'wake-before-fade-ends');
  assert.match(early.message, /later wake time or a shorter fade/);
  assert.equal(core.validateWakeAt(NIGHT + 30 * MINUTE, NIGHT, null), null, 'no fade, no conflict');
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
  near(core.wakeRampVolume(core.WAKE_RAMP_MS, 0.8), 0.8, 1e-9, 'full');
  near(core.wakeRampVolume(10 * MINUTE, 0.8), 0.8, 1e-9, 'holds');
});

test('wakeDueAction rings on time and never rings 10+ minutes late', () => {
  const wake = { status: WAKE.SCHEDULED, nextRingAt: at(2026, 10, 31, 7, 0) };
  assert.equal(core.wakeDueAction(wake, wake.nextRingAt - MINUTE), 'wait');
  assert.equal(core.wakeDueAction(wake, wake.nextRingAt - 2000), 'ring');
  assert.equal(core.wakeDueAction(wake, wake.nextRingAt + 9 * MINUTE + 59000), 'ring');
  assert.equal(core.wakeDueAction(wake, wake.nextRingAt + 10 * MINUTE), 'missed');
  assert.equal(core.wakeDueAction({ ...wake, status: WAKE.SNOOZED }, wake.nextRingAt), 'ring');
  assert.equal(core.wakeDueAction({ ...wake, status: WAKE.RINGING }, wake.nextRingAt), 'none');
  assert.equal(core.wakeDueAction(null, 0), 'none');
});

test('describeSession: the two switches are independent', () => {
  const fade = plan();
  const wake = { status: WAKE.SCHEDULED, wakeAt: at(2026, 10, 31, 7, 0), nextRingAt: at(2026, 10, 31, 7, 0) };
  assert.equal(core.describeSession(null, NIGHT).state, STATE.IDLE);

  const both = { fade, wake };
  assert.equal(core.describeSession(both, NIGHT).state, STATE.ARMED);
  assert.equal(core.describeSession(both, fade.fadeStartAt + 1).state, STATE.FADING);
  assert.equal(core.describeSession(both, fade.fadeEndAt + 1).state, STATE.WHISPER);
  const muted = core.describeSession(both, fade.muteAt + 1);
  assert.equal(muted.state, STATE.MUTED);
  assert.equal(muted.pending, true, 'the alarm is still ahead');

  const alarmOnly = core.describeSession({ fade: null, wake }, NIGHT);
  assert.deepEqual([alarmOnly.state, alarmOnly.fadeOn, alarmOnly.wakeOn], [STATE.ARMED, false, true]);

  const fadeOnly = core.describeSession({ fade, wake: null }, fade.muteAt + 1);
  assert.deepEqual([fadeOnly.fadeOn, fadeOnly.pending], [true, false], 'silent: still on, nothing pending');

  assert.equal(core.describeSession({ fade, wake: { ...wake, status: WAKE.RINGING } }, NIGHT).state, STATE.WAKING);
  assert.equal(core.describeSession({ fade, wake: { ...wake, status: WAKE.SNOOZED } }, NIGHT).state, STATE.SNOOZED);
  const paused = core.describeSession({ fade: { ...fade, status: FADE.OVERRIDDEN }, wake: null }, NIGHT);
  assert.equal(paused.fadeOverridden, true);
});

test('formatting', () => {
  assert.equal(core.formatDuration(19 * MINUTE + 42000), '19m 42s');
  assert.equal(core.formatDuration(42000), '42s');
  assert.equal(core.formatDuration(65 * MINUTE), '1h 05m');
  assert.equal(core.formatDuration(-5), '0s');
  assert.match(core.formatClockShort(at(2026, 10, 30, 23, 12)), /^11:12\spm$/);
  assert.match(core.formatWakeShort(at(2026, 10, 31, 7, 30)), /^7:30\sam, Sat Oct 31$/);
});

test('isYouTubeUrl only matches www.youtube.com', () => {
  assert.equal(core.isYouTubeUrl('https://www.youtube.com/watch?v=abc'), true);
  assert.equal(core.isYouTubeUrl('https://www.youtube.com.evil.example/'), false);
  assert.equal(core.isYouTubeUrl('https://music.youtube.com/'), false);
  assert.equal(core.isYouTubeUrl(undefined), false);
});
