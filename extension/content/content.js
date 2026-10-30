/*
 * SleepyTube content script for www.youtube.com.
 *
 * Applies the fade plan sent by the service worker to the page's main video
 * element. Progress is derived from absolute timestamps, so throttled timers in
 * a background tab only make the steps coarser, never the schedule wrong.
 *
 * It never pauses, seeks, changes playback speed or switches videos, and it
 * never reads the video's title, URL or audio (PRD R3, R9).
 */
(() => {
  'use strict';

  const core = globalThis.SleepyCore;
  const { FADE, STATE } = core;

  // Replace an earlier copy of this script (e.g. one orphaned by an extension
  // update, or a duplicate programmatic injection).
  const previous = globalThis.__sleepyTubeContent;
  if (previous && typeof previous.dispose === 'function') previous.dispose();

  const TICK_MS = 250;
  const VOLUME_EPSILON = 0.002;
  const BASELINE_DEBOUNCE_MS = 400;
  const USER_INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];

  let plan = null; // { sessionId, fadeStartAt, fadeFromAt, fadeFromGain, fadeEndAt, muteAt, startVolume, startMuted, status }
  let video = null; // the <video> currently being steered
  let lastWritten = null; // { volume, muted } as last written (or accepted) by us
  let lastUserInputAt = 0;
  // Set while the video is muted because of SleepyTube. YouTube's own mute
  // button doesn't know about it, so the user's next volume change unmutes.
  let mutedByUs = false;
  let timer = null;
  let baselineTimer = null;
  let disposed = false;

  function contextAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function send(message) {
    if (!contextAlive()) {
      dispose();
      return Promise.resolve(null);
    }
    return chrome.runtime.sendMessage(message).catch(() => null);
  }

  /** The main YouTube player's video, ignoring hover previews on feeds. */
  function findPlayerVideo() {
    const selectors = ['#movie_player video', '#shorts-player video', 'video.html5-main-video'];
    for (const selector of selectors) {
      for (const candidate of document.querySelectorAll(selector)) {
        if (candidate.closest('#inline-preview-player, ytd-video-preview')) continue;
        if (!candidate.currentSrc && !candidate.src) continue;
        return candidate;
      }
    }
    return null;
  }

  function probe() {
    const v = findPlayerVideo();
    if (!v) return { ok: true, hasVideo: false };
    return { ok: true, hasVideo: true, paused: v.paused, volume: v.volume, muted: v.muted };
  }

  function steering() {
    return !!plan && plan.status === FADE.ACTIVE;
  }

  function attach(next) {
    if (video === next) return;
    if (video) {
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('loadedmetadata', tick);
    }
    video = next;
    lastWritten = null;
    if (video) {
      video.addEventListener('volumechange', onVolumeChange);
      video.addEventListener('loadedmetadata', tick);
    }
  }

  function write(target) {
    if (target.volume != null) {
      const volume = core.clamp(target.volume, 0, 1);
      if (Math.abs(video.volume - volume) > 0.0005) video.volume = volume;
    }
    if (target.muted != null && video.muted !== target.muted) {
      video.muted = target.muted;
      if (target.muted && !plan.startMuted) mutedByUs = true;
    }
    lastWritten = { volume: video.volume, muted: video.muted };
  }

  /** Not steering any more, but the user turned the volume up: let them hear it. */
  function releaseMute(current) {
    if (!mutedByUs || !current.muted || !lastWritten) return current;
    if (Math.abs(current.volume - lastWritten.volume) < VOLUME_EPSILON) return current;
    mutedByUs = false;
    video.muted = false;
    return { volume: video.volume, muted: false };
  }

  function tick() {
    if (disposed) return;
    if (!contextAlive()) {
      dispose();
      return;
    }
    if (!steering()) return;
    attach(findPlayerVideo());
    if (!video) return;
    const target = core.fadeTargetAt(plan, Date.now());
    if (target.phase === STATE.ARMED) {
      // Before the fade begins the volume is the user's; just keep track of it.
      lastWritten = { volume: video.volume, muted: video.muted };
      return;
    }
    write(target);
  }

  function onVolumeChange() {
    if (!video) return;
    const current = { volume: video.volume, muted: video.muted };
    if (
      lastWritten &&
      Math.abs(current.volume - lastWritten.volume) < VOLUME_EPSILON &&
      current.muted === lastWritten.muted
    ) {
      return; // our own write
    }
    const now = Date.now();
    const userDriven = now - lastUserInputAt < core.USER_INPUT_WINDOW_MS;
    if (!steering()) {
      lastWritten = userDriven ? releaseMute(current) : current;
      if (!current.muted) mutedByUs = false;
      return;
    }
    const target = core.fadeTargetAt(plan, now);
    if (target.phase === STATE.ARMED) {
      lastWritten = current;
      if (userDriven) updateBaseline(current, now);
      return;
    }
    if (userDriven) {
      override(current);
      return;
    }
    // YouTube itself changed the volume (new video, ad, etc.): quietly put
    // the planned level back.
    write(target);
  }

  /** The user picked a new volume before the fade began: fade from that. */
  function updateBaseline(current, at) {
    plan = { ...plan, startVolume: current.volume, startMuted: current.muted };
    clearTimeout(baselineTimer);
    const sessionId = plan.sessionId;
    baselineTimer = setTimeout(() => {
      send({ type: 'st-baseline', sessionId, volume: current.volume, muted: current.muted, at });
    }, BASELINE_DEBOUNCE_MS);
  }

  /** The user changed the volume mid-fade: stop steering and ask what to do. */
  function override(current) {
    // If SleepyTube muted the video and the user turned it up, make that audible.
    current = releaseMute(current);
    lastWritten = current;
    plan = { ...plan, status: FADE.OVERRIDDEN };
    stopTimer();
    send({ type: 'st-override', sessionId: plan.sessionId, volume: current.volume, muted: current.muted });
  }

  function startTimer() {
    if (!timer) timer = setInterval(tick, TICK_MS);
  }

  function stopTimer() {
    clearInterval(timer);
    timer = null;
  }

  function sameTimeline(a, b) {
    return ['fadeStartAt', 'fadeFromAt', 'fadeFromGain', 'fadeEndAt', 'muteAt'].every((k) => a[k] === b[k]);
  }

  function setPlan(next) {
    if (
      next &&
      plan &&
      next.sessionId === plan.sessionId &&
      plan.status === FADE.OVERRIDDEN &&
      next.status === FADE.ACTIVE &&
      sameTimeline(plan, next)
    ) {
      // A plan sent before our override report arrived: keep the override
      // (never fight the user) and report it again. Resume/Restart send a new timeline.
      send({ type: 'st-override', sessionId: plan.sessionId, volume: video ? video.volume : 0, muted: !!(video && video.muted) });
      return;
    }
    if (!next || !plan || next.sessionId !== plan.sessionId) clearTimeout(baselineTimer);
    plan = next ? { ...next } : null;
    if (steering()) {
      startTimer();
      tick();
    } else {
      stopTimer();
    }
  }

  function restore(volume, muted) {
    setPlan(null);
    const v = findPlayerVideo();
    attach(v);
    if (!v) return false;
    v.volume = core.clamp(Number(volume), 0, 1);
    v.muted = !!muted;
    mutedByUs = false;
    lastWritten = { volume: v.volume, muted: v.muted };
    return true;
  }

  function onUserInput(event) {
    if (event.isTrusted) lastUserInputAt = Date.now();
  }

  function onMessage(message, _sender, sendResponse) {
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'st-probe':
        sendResponse(probe());
        return;
      case 'st-plan':
        setPlan(message.plan);
        sendResponse({ ...probe(), steering: steering() });
        return;
      case 'st-restore':
        sendResponse({ ok: restore(message.volume, message.muted) });
        return;
      case 'st-clear':
        setPlan(null);
        sendResponse({ ok: true });
        return;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopTimer();
    clearTimeout(baselineTimer);
    attach(null);
    for (const type of USER_INPUT_EVENTS) window.removeEventListener(type, onUserInput, true);
    document.removeEventListener('yt-navigate-finish', tick);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // The extension context is already gone.
    }
    if (globalThis.__sleepyTubeContent === api) delete globalThis.__sleepyTubeContent;
  }

  const api = { dispose };
  globalThis.__sleepyTubeContent = api;

  for (const type of USER_INPUT_EVENTS) {
    window.addEventListener(type, onUserInput, { capture: true, passive: true });
  }
  // YouTube is a single-page app; re-find the player after in-app navigation.
  document.addEventListener('yt-navigate-finish', tick);
  chrome.runtime.onMessage.addListener(onMessage);

  // Pick up a fade already in progress for this tab (e.g. after a reload).
  send({ type: 'st-content-ready' }).then((response) => {
    if (!disposed && response && response.plan) setPlan(response.plan);
  });
})();
