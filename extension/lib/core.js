/*
 * SleepyTube shared core: product constants and pure timing/volume helpers.
 *
 * Loaded as a classic script everywhere (service worker via importScripts,
 * extension pages via <script>, the YouTube content script via the manifest)
 * and via require() in Node tests. Nothing in here touches Chrome APIs.
 */
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.SleepyCore = core;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SECOND = 1000;
  const MINUTE = 60 * SECOND;

  // --- Product decisions (PRD §13) ---------------------------------------
  const FADE_START_OPTIONS = Object.freeze([5, 10, 15, 20, 30, 45, 60, 90]);
  const DEFAULT_FADE_START_MINUTES = 20;
  const FADE_DURATION_MS = 10 * MINUTE;
  const WHISPER_HOLD_MS = 5 * MINUTE;
  // Whisper level as a fraction of the starting volume (~3–5%, PRD §5).
  const WHISPER_RATIO = 0.04;
  const EXTEND_MS = 15 * MINUTE;

  const SNOOZE_MS = 9 * MINUTE;
  const WAKE_RAMP_MS = 90 * SECOND;
  // The wake ramp starts this far below the chosen alarm volume.
  const WAKE_RAMP_FLOOR_DB = -35;
  const WAKE_AUTO_STOP_MS = 15 * MINUTE;
  // A wake alarm that fires this late (e.g. after the computer slept) is
  // reported as missed instead of sounding (PRD R6).
  const WAKE_LATE_LIMIT_MS = 10 * MINUTE;
  // Chrome may deliver an alarm a moment early; treat that as on time.
  const ALARM_EARLY_TOLERANCE_MS = 5 * SECOND;
  const TEST_SOUND_MS = 6 * SECOND;

  // A volume change within this window after a click/key/scroll in the page
  // is treated as the user's own change (an override) rather than YouTube's.
  const USER_INPUT_WINDOW_MS = 1500;
  // Finished sessions are forgotten after this long.
  const SESSION_MAX_AGE_MS = 36 * 60 * MINUTE;

  const YOUTUBE_ORIGIN = 'https://www.youtube.com';
  const YOUTUBE_MATCH = YOUTUBE_ORIGIN + '/*';

  const DEFAULT_SETTINGS = Object.freeze({
    fadeMinutes: DEFAULT_FADE_START_MINUTES,
    wakeEnabled: false,
    wakeTime: '07:00',
    keepAwake: false,
    wakeVolume: 0.7,
  });

  // Overall session states (PRD §8). CANCELLED returns to IDLE.
  const STATE = Object.freeze({
    IDLE: 'IDLE',
    ARMED: 'ARMED',
    FADING: 'FADING',
    WHISPER: 'WHISPER',
    MUTED: 'MUTED',
    WAKING: 'WAKING',
    SNOOZED: 'SNOOZED',
    DISMISSED: 'DISMISSED',
    MISSED_WAKE: 'MISSED_WAKE',
    ERROR: 'ERROR',
  });

  // fade.status: whether SleepyTube is still steering the video's volume.
  const FADE = Object.freeze({
    ACTIVE: 'active',
    OVERRIDDEN: 'overridden', // the user changed the volume; waiting for Resume/Cancel
    LOST: 'lost', // the tab closed or left YouTube
    CANCELLED: 'cancelled',
    RESTORED: 'restored',
  });

  // wake.status
  const WAKE = Object.freeze({
    SCHEDULED: 'scheduled',
    RINGING: 'ringing',
    SNOOZED: 'snoozed',
    DISMISSED: 'dismissed',
    EXPIRED: 'expired', // rang for WAKE_AUTO_STOP_MS without a response
    MISSED: 'missed',
  });

  function clamp(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
  }

  // --- Clock time --------------------------------------------------------

  /** Parses "HH:MM" (24-hour, as produced by <input type="time">). */
  function parseClockTime(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return { hours, minutes };
  }

  /**
   * Next local occurrence of a clock time strictly after `now`. A time equal to
   * or earlier than now rolls to the following day (PRD §5). Built from local
   * calendar fields so DST transitions land on the intended wall-clock time.
   */
  function nextOccurrence(value, now) {
    const t = parseClockTime(value);
    if (!t) return null;
    const d = new Date(now);
    const candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.hours, t.minutes, 0, 0);
    if (candidate.getTime() > now) return candidate.getTime();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, t.hours, t.minutes, 0, 0).getTime();
  }

  // --- Fade timeline -----------------------------------------------------

  function isValidFadeMinutes(minutes) {
    return FADE_START_OPTIONS.includes(Number(minutes));
  }

  /** Absolute timestamps for a fade whose countdown starts at `from`. */
  function planFadeTimes(from, countdownMs) {
    const fadeStartAt = from + countdownMs;
    const fadeEndAt = fadeStartAt + FADE_DURATION_MS;
    return { fadeStartAt, fadeEndAt, muteAt: fadeEndAt + WHISPER_HOLD_MS };
  }

  function fadePhaseAt(fade, now) {
    if (now < fade.fadeStartAt) return STATE.ARMED;
    if (now < fade.fadeEndAt) return STATE.FADING;
    if (now < fade.muteAt) return STATE.WHISPER;
    return STATE.MUTED;
  }

  function easeInOutSine(p) {
    return -(Math.cos(Math.PI * p) - 1) / 2;
  }

  /**
   * Volume multiplier at fade progress p ∈ [0, 1]. The fade is linear in
   * decibels (perceptually even) with eased ends, falling from 1 to
   * WHISPER_RATIO. Progress comes from timestamps, so the curve is the same
   * however often (or rarely) the page's timers run.
   */
  function fadeGain(p) {
    return Math.pow(WHISPER_RATIO, easeInOutSine(clamp(p, 0, 1)));
  }

  /**
   * What the video should sound like at `now`. `volume: null` means "leave the
   * volume alone" (before the fade begins); `muted: null` means "leave the
   * mute state alone".
   */
  function fadeTargetAt(fade, now) {
    const phase = fadePhaseAt(fade, now);
    const start = clamp(Number(fade.startVolume), 0, 1);
    switch (phase) {
      case STATE.ARMED:
        return { phase, volume: null, muted: null };
      case STATE.FADING: {
        const p = (now - fade.fadeStartAt) / (fade.fadeEndAt - fade.fadeStartAt);
        return { phase, volume: start * fadeGain(p), muted: null };
      }
      case STATE.WHISPER:
        return { phase, volume: start * WHISPER_RATIO, muted: null };
      default:
        return { phase, volume: start * WHISPER_RATIO, muted: true };
    }
  }

  // --- Wake --------------------------------------------------------------

  function formatClock(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  /**
   * Refuses schedules where the wake alarm would ring before the fade has
   * finished muting the video (PRD §5). Returns null when the schedule is fine.
   */
  function validateSchedule({ muteAt, wakeAt }) {
    if (muteAt == null || wakeAt == null || wakeAt > muteAt) return null;
    return {
      code: 'wake-before-fade-ends',
      message:
        `Your wake time (${formatClock(wakeAt)}) comes before the fade finishes ` +
        `(${formatClock(muteAt)}). Choose a later wake time or a shorter fade countdown.`,
    };
  }

  /** Alarm volume `elapsedMs` into a ring: a dB-linear rise over WAKE_RAMP_MS. */
  function wakeRampVolume(elapsedMs, maxVolume) {
    const p = clamp(elapsedMs / WAKE_RAMP_MS, 0, 1);
    const db = WAKE_RAMP_FLOOR_DB * (1 - p);
    return clamp(maxVolume, 0, 1) * Math.pow(10, db / 20);
  }

  function isWakePending(wake) {
    return !!wake && (wake.status === WAKE.SCHEDULED || wake.status === WAKE.SNOOZED);
  }

  /** How a due wake alarm should be handled at `now`. */
  function wakeDueAction(wake, now) {
    if (!isWakePending(wake)) return 'none';
    if (now < wake.nextRingAt - ALARM_EARLY_TOLERANCE_MS) return 'wait';
    if (now - wake.nextRingAt >= WAKE_LATE_LIMIT_MS) return 'missed';
    return 'ring';
  }

  // --- Session summary ---------------------------------------------------

  function fadeIsPending(fade, now) {
    return !!fade && fade.status === FADE.ACTIVE && now < fade.muteAt;
  }

  /**
   * True once nothing else is scheduled: the fade has muted (or is no longer
   * running) and any wake alarm has been dismissed, expired or missed.
   */
  function isSessionFinished(session, now) {
    if (!session) return true;
    const wake = session.wake;
    if (wake && (isWakePending(wake) || wake.status === WAKE.RINGING)) return false;
    return !fadeIsPending(session.fade, now) && !(session.fade && session.fade.status === FADE.OVERRIDDEN);
  }

  /** Derives the overall state (PRD §8) from the session's parts. */
  function describeSession(session, now) {
    if (!session) {
      return { state: STATE.IDLE, finished: true, fadePhase: null, wakePending: false, needsAttention: false };
    }
    const { fade, wake } = session;
    const fadePhase = fade ? fadePhaseAt(fade, now) : null;
    const wakePending = isWakePending(wake);
    let state;
    if (wake && wake.status === WAKE.RINGING) state = STATE.WAKING;
    else if (wake && wake.status === WAKE.SNOOZED) state = STATE.SNOOZED;
    else if (wake && wake.status === WAKE.MISSED) state = STATE.MISSED_WAKE;
    else if (wake && (wake.status === WAKE.DISMISSED || wake.status === WAKE.EXPIRED)) state = STATE.DISMISSED;
    else if (fade && (fade.status === FADE.ACTIVE || fade.status === FADE.OVERRIDDEN)) state = fadePhase;
    else if (wakePending) state = STATE.ARMED;
    else if (fade && fade.status === FADE.LOST) state = STATE.ERROR;
    else state = STATE.IDLE; // fade cancelled/restored and nothing else scheduled
    const needsAttention =
      (!!fade && fade.status === FADE.OVERRIDDEN) ||
      (session.notices || []).some((n) => n.level === 'warn');
    return {
      state,
      finished: isSessionFinished(session, now),
      fadePhase,
      wakePending,
      needsAttention,
    };
  }

  // --- Formatting --------------------------------------------------------

  /** "19m 42s", "1h 05m", "42s". */
  function formatDuration(ms) {
    const total = Math.max(0, Math.ceil(ms / SECOND));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
  }

  function startOfDay(ms) {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  /** "today", "tomorrow" or a short weekday date. */
  function formatDayLabel(ms, now) {
    const days = Math.round((startOfDay(ms) - startOfDay(now)) / (24 * 60 * MINUTE));
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    return new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }

  /** "7:00 AM tomorrow (Sat, Oct 31)" — always shows the actual date. */
  function formatWakeWhen(ms, now) {
    const date = new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const label = formatDayLabel(ms, now);
    if (label === 'today' || label === 'tomorrow') return `${formatClock(ms)} ${label} (${date})`;
    return `${formatClock(ms)} ${date}`;
  }

  function isYouTubeUrl(url) {
    return typeof url === 'string' && (url === YOUTUBE_ORIGIN || url.startsWith(YOUTUBE_ORIGIN + '/'));
  }

  return Object.freeze({
    SECOND,
    MINUTE,
    FADE_START_OPTIONS,
    DEFAULT_FADE_START_MINUTES,
    FADE_DURATION_MS,
    WHISPER_HOLD_MS,
    WHISPER_RATIO,
    EXTEND_MS,
    SNOOZE_MS,
    WAKE_RAMP_MS,
    WAKE_RAMP_FLOOR_DB,
    WAKE_AUTO_STOP_MS,
    WAKE_LATE_LIMIT_MS,
    ALARM_EARLY_TOLERANCE_MS,
    TEST_SOUND_MS,
    USER_INPUT_WINDOW_MS,
    SESSION_MAX_AGE_MS,
    YOUTUBE_ORIGIN,
    YOUTUBE_MATCH,
    DEFAULT_SETTINGS,
    STATE,
    FADE,
    WAKE,
    clamp,
    parseClockTime,
    nextOccurrence,
    isValidFadeMinutes,
    planFadeTimes,
    fadePhaseAt,
    fadeGain,
    fadeTargetAt,
    validateSchedule,
    wakeRampVolume,
    isWakePending,
    wakeDueAction,
    fadeIsPending,
    isSessionFinished,
    describeSession,
    formatDuration,
    formatClock,
    formatDayLabel,
    formatWakeWhen,
    isYouTubeUrl,
  });
});
