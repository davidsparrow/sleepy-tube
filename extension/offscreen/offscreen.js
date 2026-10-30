/*
 * SleepyTube offscreen audio player.
 *
 * Plays the bundled wake chime on its own audio element, independent of the
 * YouTube tab and of the network (PRD R4). The volume follows timestamps, so
 * a ring resumed after this document was recreated picks up mid-ramp.
 */
'use strict';

const core = globalThis.SleepyCore;
const STEP_MS = 200;
const TEST_EDGE_MS = 800;

const audio = new Audio('../sounds/wake-chime.ogg');
audio.loop = true;
audio.preload = 'auto';

// { mode: 'wake' | 'test', ringId, startedAt, endAt, maxVolume }
let current = null;
let timer = null;

function levelNow() {
  const now = Date.now();
  if (current.mode === 'wake') return core.wakeRampVolume(now - current.startedAt, current.maxVolume);
  // Test: a short fade in/out at the chosen peak level.
  const edge = Math.min((now - current.startedAt) / TEST_EDGE_MS, (current.endAt - now) / TEST_EDGE_MS, 1);
  return current.maxVolume * core.clamp(edge, 0, 1);
}

function stop() {
  clearInterval(timer);
  timer = null;
  current = null;
  audio.pause();
  audio.currentTime = 0;
}

function step() {
  if (!current) return;
  if (Date.now() >= current.endAt) {
    const ended = current;
    stop();
    chrome.runtime.sendMessage({ type: 'offscreen-ended', mode: ended.mode, ringId: ended.ringId }).catch(() => {});
    return;
  }
  audio.volume = levelNow();
}

async function start(next) {
  stop();
  current = next;
  audio.volume = levelNow();
  try {
    await audio.play();
  } catch (error) {
    current = null;
    return { ok: false, error: (error && error.name) || 'PlaybackFailed' };
  }
  timer = setInterval(step, STEP_MS);
  return { ok: true };
}

async function handle(message) {
  switch (message.type) {
    case 'ring':
      if (current && current.mode === 'wake' && current.ringId === message.ringId && !audio.paused) {
        return { ok: true, alreadyPlaying: true };
      }
      return start({
        mode: 'wake',
        ringId: message.ringId,
        startedAt: message.startedAt,
        endAt: message.autoStopAt, // safety net; the service worker stops it first
        maxVolume: message.volume,
      });
    case 'test':
      if (current && current.mode === 'wake') return { ok: false, error: 'AlarmRinging' };
      return start({
        mode: 'test',
        startedAt: Date.now(),
        endAt: Date.now() + message.durationMs,
        maxVolume: message.volume,
      });
    case 'stop':
      stop();
      return { ok: true };
    case 'status':
      return {
        ok: true,
        playing: !audio.paused,
        mode: current && current.mode,
        ringId: current && current.ringId,
        volume: audio.volume,
      };
    default:
      return { ok: false, error: 'UnknownMessage' };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return;
  handle(message).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});
