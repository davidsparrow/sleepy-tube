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
  const HOUR = 60 * MINUTE;

  // --- Fader choices -----------------------------------------------------
  const DELAY_OPTIONS = Object.freeze([10, 15, 20, 30, 45, 60, 90]);
  const FADE_OPTIONS = Object.freeze([10, 15, 20, 30]);
  const WHISPER_OPTIONS = Object.freeze([10, 15, 20, 30]);
  const EXTEND_OPTIONS = Object.freeze([10, 20]);
  // Whisper level as a fraction of the starting volume (~3–5%, PRD §5).
  const WHISPER_RATIO = 0.04;
  const WHISPER_DB = 20 * Math.log10(WHISPER_RATIO);
  // A fade shortened mid-way still takes at least this long to finish.
  const MIN_FADE_REMAINING_MS = MINUTE;

  // --- Alarm -------------------------------------------------------------
  const SNOOZE_MS = 9 * MINUTE;
  const WAKE_SHIFT_MS = 10 * MINUTE;
  const WAKE_MAX_AHEAD_MS = 24 * HOUR;
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
  // Sessions are forgotten after this long, whatever their state.
  const SESSION_MAX_AGE_MS = 36 * HOUR;
  const SESSION_VERSION = 2;

  const YOUTUBE_ORIGIN = 'https://www.youtube.com';
  const YOUTUBE_MATCH = YOUTUBE_ORIGIN + '/*';

  const DEFAULT_SETTINGS = Object.freeze({
    delayMinutes: 20,
    fadeMinutes: 10,
    whisperMinutes: 10,
    wakeTime: '07:00',
    keepAwake: false,
    wakeVolume: 0.7,
  });

  // Overall session states (PRD §8). Missed / dismissed / lost outcomes are
  // reported as notices, after which the relevant switch is simply off.
  const STATE = Object.freeze({
    IDLE: 'IDLE',
    ARMED: 'ARMED',
    FADING: 'FADING',
    WHISPER: 'WHISPER',
    MUTED: 'MUTED',
    WAKING: 'WAKING',
    SNOOZED: 'SNOOZED',
  });

  // fade.status while the Fade switch is on.
  const FADE = Object.freeze({
    ACTIVE: 'active',
    OVERRIDDEN: 'overridden', // the user changed the volume; waiting for Resume
  });

  // wake.status while the Alarm switch is on.
  const WAKE = Object.freeze({
    SCHEDULED: 'scheduled',
    RINGING: 'ringing',
    SNOOZED: 'snoozed',
  });

  function clamp(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
  }

  // --- Clock time --------------------------------------------------------

  /** Parses "HH:MM" (24-hour). */
  function parseClockTime(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return { hours, minutes };
  }

  /**
   * Next local occurrence of a clock time strictly after `now`. Built from
   * local calendar fields so DST transitions land on the wall-clock time.
   */
  function nextOccurrence(value, now) {
    const t = parseClockTime(value);
    if (!t) return null;
    const d = new Date(now);
    const candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.hours, t.minutes, 0, 0);
    if (candidate.getTime() > now) return candidate.getTime();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, t.hours, t.minutes, 0, 0).getTime();
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  /** "HH:MM" for a timestamp, e.g. to remember the last wake time used. */
  function clockTimeOf(ms) {
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /** Value for <input type="datetime-local">: "YYYY-MM-DDTHH:MM", local time. */
  function toDateTimeLocal(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${clockTimeOf(ms)}`;
  }

  function parseDateTimeLocal(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }

  // --- Fade timeline -----------------------------------------------------

  function sanitizeMinutes(value, options, fallback) {
    const n = Number(value);
    return options.includes(n) ? n : fallback;
  }

  /** The three fader choices, each forced onto its list of allowed values. */
  function fadeChoices(input) {
    const d = DEFAULT_SETTINGS;
    return {
      delayMinutes: sanitizeMinutes(input && input.delayMinutes, DELAY_OPTIONS, d.delayMinutes),
      fadeMinutes: sanitizeMinutes(input && input.fadeMinutes, FADE_OPTIONS, d.fadeMinutes),
      whisperMinutes: sanitizeMinutes(input && input.whisperMinutes, WHISPER_OPTIONS, d.whisperMinutes),
    };
  }

  /** A fresh timeline whose countdown starts at `from`. */
  function planFadeTimes(from, choices) {
    const c = fadeChoices(choices);
    const fadeStartAt = from + c.delayMinutes * MINUTE;
    const fadeEndAt = fadeStartAt + c.fadeMinutes * MINUTE;
    return {
      ...c,
      delayStartedAt: from,
      fadeStartAt,
      fadeFromAt: fadeStartAt,
      fadeFromGain: 1,
      fadeEndAt,
      muteAt: fadeEndAt + c.whisperMinutes * MINUTE,
    };
  }

  /** A timeline whose fade starts right now (Resume after an override). */
  function planFadeFromNow(now, choices) {
    const c = fadeChoices(choices);
    const fadeEndAt = now + c.fadeMinutes * MINUTE;
    return {
      ...c,
      delayStartedAt: now,
      fadeStartAt: now,
      fadeFromAt: now,
      fadeFromGain: 1,
      fadeEndAt,
      muteAt: fadeEndAt + c.whisperMinutes * MINUTE,
    };
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
   * Volume multiplier (relative to the starting volume) during the fade. The
   * fade is linear in decibels (perceptually even) with eased ends, from
   * `fadeFromGain` at `fadeFromAt` down to the whisper level at `fadeEndAt`.
   * `fadeFromAt`/`fadeFromGain` move when a fade is lengthened mid-way, so the
   * volume carries on from where it was instead of jumping back up.
   */
  function fadeGainAt(fade, now) {
    const fromAt = Math.max(fade.fadeFromAt != null ? fade.fadeFromAt : fade.fadeStartAt, fade.fadeStartAt);
    const fromGain = clamp(fade.fadeFromGain != null ? fade.fadeFromGain : 1, WHISPER_RATIO, 1);
    if (now <= fromAt) return fromGain;
    if (now >= fade.fadeEndAt) return WHISPER_RATIO;
    const fromDb = 20 * Math.log10(fromGain);
    const p = (now - fromAt) / (fade.fadeEndAt - fromAt);
    return Math.pow(10, (fromDb + (WHISPER_DB - fromDb) * easeInOutSine(p)) / 20);
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
      case STATE.FADING:
        return { phase, volume: start * fadeGainAt(fade, now), muted: null };
      case STATE.WHISPER:
        return { phase, volume: start * WHISPER_RATIO, muted: null };
      default:
        return { phase, volume: start * WHISPER_RATIO, muted: true };
    }
  }

  /** Re-anchors the fade at `now` so its curve can be changed without a jump. */
  function rebaseAt(fade, now) {
    return { fadeFromAt: now, fadeFromGain: fadeGainAt(fade, now) };
  }

  /**
   * "+10 / +20": keeps the current phase going `minutes` longer. Returns the
   * timeline fields to change, or { error } once the video is already silent.
   */
  function extendFade(fade, minutes, now) {
    const ms = Number(minutes) * MINUTE;
    switch (fadePhaseAt(fade, now)) {
      case STATE.ARMED:
        return {
          fadeStartAt: fade.fadeStartAt + ms,
          fadeFromAt: fade.fadeStartAt + ms,
          fadeFromGain: 1,
          fadeEndAt: fade.fadeEndAt + ms,
          muteAt: fade.muteAt + ms,
        };
      case STATE.FADING:
        return { ...rebaseAt(fade, now), fadeEndAt: fade.fadeEndAt + ms, muteAt: fade.muteAt + ms };
      case STATE.WHISPER:
        return { muteAt: fade.muteAt + ms };
      default:
        return { error: 'silent' };
    }
  }

  /**
   * A chip changed while the Fade switch is on. Phases that have already
   * started can't have their *start* moved, so: the countdown chip only works
   * before the fade, the fade-length chip until the whisper, and the whisper
   * chip until silence. Returns the fields to change, or { error: 'locked' }.
   */
  function retimeFade(fade, input, now) {
    const c = fadeChoices({ ...fade, ...input });
    const phase = fadePhaseAt(fade, now);
    const order = [STATE.ARMED, STATE.FADING, STATE.WHISPER, STATE.MUTED];
    const at = order.indexOf(phase);
    const changes = { ...c };
    if (input.delayMinutes != null && c.delayMinutes !== fade.delayMinutes) {
      if (at > 0) return { error: 'locked' };
      changes.fadeStartAt = Math.max(fade.delayStartedAt + c.delayMinutes * MINUTE, now);
      changes.fadeFromAt = changes.fadeStartAt;
      changes.fadeFromGain = 1;
    }
    const fadeStartAt = changes.fadeStartAt != null ? changes.fadeStartAt : fade.fadeStartAt;
    let fadeEndAt = fade.fadeEndAt;
    if ('fadeStartAt' in changes || (input.fadeMinutes != null && c.fadeMinutes !== fade.fadeMinutes)) {
      if (at > 1) return { error: 'locked' };
      fadeEndAt = fadeStartAt + c.fadeMinutes * MINUTE;
      if (phase === STATE.FADING) {
        fadeEndAt = Math.max(fadeEndAt, now + MIN_FADE_REMAINING_MS);
        Object.assign(changes, rebaseAt(fade, now));
      }
      changes.fadeEndAt = fadeEndAt;
    }
    if ('fadeEndAt' in changes || (input.whisperMinutes != null && c.whisperMinutes !== fade.whisperMinutes)) {
      if (at > 2) return { error: 'locked' };
      changes.muteAt = Math.max(fadeEndAt + c.whisperMinutes * MINUTE, now);
    }
    return changes;
  }

  // --- Wake --------------------------------------------------------------

  function formatClock(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  /** "11:12 am" — the lower-case style used in the popup. */
  function formatClockShort(ms) {
    return formatClock(ms).replace(/\s?([AP]M)$/i, (_m, ampm) => ' ' + ampm.toLowerCase());
  }

  /** "7:30 am, Fri Oct 30" */
  function formatWakeShort(ms) {
    const date = new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    return `${formatClockShort(ms)}, ${date.replace(/,/g, '')}`;
  }

  /**
   * Checks a wake time: it must be in the next 24 hours and, when a fade is
   * still running, after the video goes silent (PRD §5). Returns null when OK.
   */
  function validateWakeAt(at, now, muteAt) {
    if (at == null || Number.isNaN(at)) return { code: 'bad-input', message: 'Choose a wake time.' };
    if (at <= now + 30 * SECOND) return { code: 'past', message: 'That wake time has already passed.' };
    if (at > now + WAKE_MAX_AHEAD_MS) {
      return { code: 'too-far', message: 'Choose a wake time within the next 24 hours.' };
    }
    if (muteAt != null && at <= muteAt) {
      return {
        code: 'wake-before-fade-ends',
        message:
          `The alarm (${formatClockShort(at)}) would ring before the video goes silent ` +
          `(${formatClockShort(muteAt)}). Choose a later wake time or a shorter fade.`,
      };
    }
    return null;
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

  function fadeIsOn(fade) {
    return !!fade && (fade.status === FADE.ACTIVE || fade.status === FADE.OVERRIDDEN);
  }

  function wakeIsOn(wake) {
    return !!wake && (isWakePending(wake) || wake.status === WAKE.RINGING);
  }

  /** The fade still has a step ahead of it (it hasn't reached silence). */
  function fadeIsPending(fade, now) {
    return !!fade && fade.status === FADE.ACTIVE && now < fade.muteAt;
  }

  /** Derives the overall state (PRD §8) and what each switch is doing. */
  function describeSession(session, now) {
    const fade = session && fadeIsOn(session.fade) ? session.fade : null;
    const wake = session && wakeIsOn(session.wake) ? session.wake : null;
    const fadePhase = fade ? fadePhaseAt(fade, now) : null;
    let state = STATE.IDLE;
    if (wake && wake.status === WAKE.RINGING) state = STATE.WAKING;
    else if (wake && wake.status === WAKE.SNOOZED) state = STATE.SNOOZED;
    else if (fade) state = fadePhase;
    else if (wake) state = STATE.ARMED;
    return {
      state,
      fadeOn: !!fade,
      fadePhase,
      fadeOverridden: !!fade && fade.status === FADE.OVERRIDDEN,
      wakeOn: !!wake,
      wakeStatus: wake ? wake.status : null,
      // Something is still scheduled to happen (drives the ☾ badge).
      pending: fadeIsPending(fade, now) || isWakePending(wake),
    };
  }

  // --- Formatting --------------------------------------------------------

  /** "19m 42s", "1h 05m", "42s". */
  function formatDuration(ms) {
    const total = Math.max(0, Math.ceil(ms / SECOND));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${pad2(m)}m`;
    if (m > 0) return `${m}m ${pad2(s)}s`;
    return `${s}s`;
  }

  function isYouTubeUrl(url) {
    return typeof url === 'string' && (url === YOUTUBE_ORIGIN || url.startsWith(YOUTUBE_ORIGIN + '/'));
  }

  return Object.freeze({
    SECOND,
    MINUTE,
    HOUR,
    DELAY_OPTIONS,
    FADE_OPTIONS,
    WHISPER_OPTIONS,
    EXTEND_OPTIONS,
    WHISPER_RATIO,
    MIN_FADE_REMAINING_MS,
    SNOOZE_MS,
    WAKE_SHIFT_MS,
    WAKE_MAX_AHEAD_MS,
    WAKE_RAMP_MS,
    WAKE_RAMP_FLOOR_DB,
    WAKE_AUTO_STOP_MS,
    WAKE_LATE_LIMIT_MS,
    ALARM_EARLY_TOLERANCE_MS,
    TEST_SOUND_MS,
    USER_INPUT_WINDOW_MS,
    SESSION_MAX_AGE_MS,
    SESSION_VERSION,
    YOUTUBE_ORIGIN,
    YOUTUBE_MATCH,
    DEFAULT_SETTINGS,
    STATE,
    FADE,
    WAKE,
    clamp,
    parseClockTime,
    nextOccurrence,
    clockTimeOf,
    toDateTimeLocal,
    parseDateTimeLocal,
    fadeChoices,
    planFadeTimes,
    planFadeFromNow,
    fadePhaseAt,
    fadeGainAt,
    fadeTargetAt,
    extendFade,
    retimeFade,
    formatClock,
    formatClockShort,
    formatWakeShort,
    validateWakeAt,
    wakeRampVolume,
    isWakePending,
    wakeDueAction,
    fadeIsOn,
    wakeIsOn,
    fadeIsPending,
    describeSession,
    formatDuration,
    isYouTubeUrl,
  });
});
