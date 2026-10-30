# SleepyTube — Product Requirements Document

**Version:** 1.0 (MVP specification)  
**Platform:** Google Chrome desktop, Manifest V3 extension  
**Status:** Proposed / ready for technical spike  
**Tagline:** Drift off gently. Wake up softly.

## 1. Product vision

SleepyTube is a deliberately tiny Chrome extension for people who fall asleep watching or listening to YouTube. It gradually fades a playing video's audio to silence, leaves playback untouched, and can optionally sound a separate, gentle wake-up alarm at a chosen time.

**The promise:** Set your fade and your wake-up time, tap **Have a good sleep**, and leave the rest to SleepyTube—as long as Chrome and the computer remain awake and audio output is available.

**Important qualification:** A browser extension cannot wake a sleeping computer. Its wake feature must never be marketed as a guaranteed primary alarm.

## 2. Problem and differentiation

- Standard sleep timers tend to stop playback abruptly rather than gently lowering the sound.
- Someone who falls asleep to a YouTube video may also want a simple, separate wake-up sound without installing a full sleep app.
- Existing extensions already offer some combinations of volume fading and wake scheduling (notably for YouTube Music), so the advantage is **frictionless UX for ordinary YouTube videos**, not an exclusive feature claim.

**Positioning:** A tiny bedtime companion, not a sleep tracker, medical product, or full alarm-clock replacement.

## 3. MVP scope

### Must have

1. Operates on a currently open YouTube video in Chrome desktop.
2. Allows a **fade-start countdown**: 5, 10, 15, 20, 30, 45, 60, or 90 minutes (default 20).
3. Preserves the video's initial volume, then performs a default **10-minute fade**, followed by **5 minutes at whisper level**, then mutes the video.
4. Leaves video playback and playback speed alone; never deliberately pauses or stops it.
5. Optional **Wake me at** time picker, set to the next occurrence of a local clock time (example 7:00 AM).
6. Wake alert uses **a bundled, offline-capable sound belonging to the extension**, not the YouTube video's audio.
7. Wake sound gradually ramps up over about 90 seconds to a user-tested maximum level, then repeats until dismissed, snoozed, or auto-stopped after 15 minutes.
8. **Test wake sound** button; clear setup guidance about computer sleep, browser closure, system volume, speaker routing, and laptop lid closure.
9. **Snooze 9 minutes**, **Dismiss**, and **Cancel night** controls available without keeping the popup open.
10. Stores the active night's timestamps and settings locally; restores/reconciles timers after extension service worker restarts.
11. Optional **Keep computer awake until alarm** control using the Chrome power API at the `system` level, with explicit permission, clear battery disclosure, and automatic release.
12. No account, cloud backend, analytics, tracking, or advertisement framework.

### Not in MVP

- iOS/Android support; native OS waking; mobile push notifications.
- Detecting real sleep onset, microphone listening, wearable integrations, or sleep analysis.
- Repeating weekday alarms, playlists, Spotify, Netflix, ambient sound libraries, AI features, or smart-home controls.
- Controlling system-wide master volume.
- Guarantees about when YouTube itself pauses playback or asks whether the viewer is still watching.

## 4. Core user experience

### Popup, idle

```
🌙 SleepyTube

Fade begins in
[ 5 — 10 — 15 — 20 — 30 — 45 — 60 — 90 min ]
                    20 minutes

○ Wake me at                 [ 7:00 AM ]
  (When enabled) [▶ Test wake sound]
  (When enabled) [ ] Keep computer awake for alarm

      [ Have a good sleep 🌙 ]

10-min fade · 5-min whisper · then silence
```

**Interaction details:** The fade slider has discrete stops and supports keyboard adjustment. Wake is opt-in, but its control is visible rather than buried in settings. The primary button changes to **Night is set** once armed. The extension should open even when the YouTube tab is no longer active, so the user can snooze, dismiss, or cancel.

### Popup, armed

- **Fade starts in 19m 42s** (relative display recalculated from stored target timestamp)
- **Wake alarm: 7:00 AM tomorrow** (only if enabled)
- Actions: **+15 minutes**, **Change wake time**, **Cancel night**
- Small moon indicator on extension toolbar while armed
- A compact **Wake reliability** line if wake is enabled (e.g. “Chrome must stay open; computer must stay awake”)

### At wake

- Bundled gentle chime starts quiet and gradually rises; playback is independent of the YouTube tab.
- A conspicuous wake screen/window, where supported, provides **Snooze 9 min** and **I'm awake**.
- A notification provides a secondary way to respond.
- Video remains muted; dismissing the alarm **must not automatically restore the video's original volume**. A separate **Restore video sound** action can do that later.

## 5. Timeline and timing semantics

Example: user arms at **11:00 PM**, selects **20 minutes**, and sets **7:00 AM**.

| Local time | Required behavior |
|---|---|
| 11:00 PM | Store current YouTube volume; arm countdown and optional wake alarm |
| 11:20 PM | Begin smooth fade from stored starting volume |
| 11:30 PM | Reach whisper level (~3–5% of original, subject to listening tests) |
| 11:35 PM | Mute YouTube video; leave it playing |
| 7:00 AM | Sound separate bundled wake alarm with a ~90-second gradual ramp |
| 7:09 AM (if snoozed at 7:00) | Sound the alarm again, with another gentle ramp |

The countdown means **time until the fade begins**, not predicted time of sleep onset; the app does not claim to know when the user actually sleeps.

Use absolute timestamps for scheduled events, not a long-running background `setTimeout`. If the chosen wake clock time is earlier than or equal to the current time, schedule its next occurrence on the following day. Show the actual date and AM/PM in the armed confirmation. Refuse contradictory schedules where wake occurs before fade/mute has finished; explain how to fix them.

## 6. Requirements and behavior details

**R1 — YouTube binding:** Arm the fade on exactly one YouTube tab. Target that tab's media player by tab ID; if the user navigates to a new YouTube video within the same tab, reattach to the new video element and continue according to the original timestamps. Do not alter unrelated tabs or OS audio.

**R2 — Volume:** Read and save the video element's initial volume and mute state. During the fade use a smooth perceptual curve and timestamp-derived progress, not a fixed decrement dependent on timer execution frequency. At the end, set the video muted state. User changes to volume during the session should be treated as an intentional override: provide a clear **Resume fade** or **Cancel fade** choice rather than fighting the user.

**R3 — Playback:** Never deliberately pause, stop, rewind, change playback speed, or switch videos. Note that YouTube itself may pause because of its own behavior and SleepyTube cannot promise uninterrupted playback.

**R4 — Alarm audio:** Ship a small, original, royalty-cleared sound asset inside the extension. Do not make alarm success contingent on the YouTube tab, the Internet, or the original video being audible. Do not route alarm audio through the muted YouTube player. Let the user preview and adjust its perceived volume, but recognize that the OS can still be muted.

**R5 — Reliability disclosure:** Wake setup must state: **“SleepyTube cannot wake your computer from sleep. Keep Chrome open and the computer awake, or use a separate alarm as backup.”** When chosen, the keep-awake option requests the Chrome `system` power level, allowing the display to turn off while resisting inactivity sleep. It cannot override every OS policy or laptop-lid sleep. Release the keep-awake request after dismissal, cancellation, expiry, or completion.

**R6 — Lifecycle:** Persist active session, wake time, original volume, and state in `chrome.storage.local`. Schedule transitions with `chrome.alarms`. On service worker startup, reconcile state and reschedule missing alarms; do not assume in-memory timers survive. If the Chrome wake alarm runs late due to suspension, sound only when it is less than 10 minutes late; otherwise mark the alarm missed and show a notice when possible, not a surprise alarm hours later.

**R7 — Errors:** If there is no playing YouTube video, show **“Open a YouTube video first”** and disable the sleep-fade action. If the tab closes or becomes inaccessible, cancel only the fade and visibly warn; an independently scheduled wake alarm can remain armed. If Chrome is closed or the device sleeps, an alarm cannot be guaranteed.

**R8 — One active night:** Only one active sleep/wake session per Chrome profile. Arming again asks whether to replace the earlier session. No synced schedules across devices.

**R9 — Privacy:** Save settings and timestamps on the device. Never collect video title, URL, viewing history, account details, or audio content. Use the narrowest YouTube host access and permissions feasible. All sound assets are bundled.

**R10 — Accessibility:** Keyboard-operable slider/time selection; screen-reader labels; visible focus outlines; high-contrast text; reduced-motion-friendly UI; large Snooze/Dismiss targets.

## 7. Suggested architecture

| Component | Responsibility |
|---|---|
| Manifest V3 popup | Slider, wake time, alarm test, night-status and controls |
| YouTube content script | Find current player, snapshot volume, apply smooth audio fade, track player replacement/navigation |
| Extension service worker | Store timestamps/state, schedule transitions and alarm through `chrome.alarms`, handle cancel/snooze and state reconciliation |
| Offscreen audio document | Play bundled wake-up audio via `chrome.offscreen` with an audio playback reason; close when finished |
| `chrome.storage.local` | Settings, one active session, original volume/mute state, scheduled times and recovery state |
| Optional `chrome.power` | Request/release `system` keep-awake when expressly enabled |
| Optional `chrome.notifications` | Wake/missed-alarm fallback notification |

**Technical spike required before committing to the wake feature:** Demonstrate that an MV3 service worker can trigger audible bundled audio from an offscreen document after several hours of inactivity, respecting Chrome autoplay restrictions; confirm Snooze/Dismiss behavior and correct audio routing on macOS and Windows. Chrome's APIs support much of the structure, but a production-grade wake alarm must be demonstrated end to end rather than assumed. If the test is unreliable, ship a **sleep-fade-only** Chrome extension first, and treat dependable waking as a future native or mobile companion.

### Requested permissions (minimum practical set)

- `storage`, `alarms`, `offscreen`
- YouTube host permission/content-script match (start with `https://www.youtube.com/*`)
- `power` only if the user enables the optional system keep-awake feature
- `notifications` only if used for secondary wake alerts

No remote APIs or external services are required.

## 8. State machine

`IDLE → ARMED → FADING → WHISPER → MUTED → WAKING → (SNOOZED ↔ WAKING) → DISMISSED`

Transitions from applicable states: `CANCELLED`, `ERROR`, or `MISSED_WAKE`. A **fade-only** session completes after muting. All transitions should be idempotent; service worker restarts and duplicate alarm events must not create two wake sounds.

## 9. Acceptance criteria

1. User can arm a fade in three interactions or fewer after opening the popup on YouTube.
2. Default session starts fading after 20 minutes, completes its 10-minute fade, holds 5 minutes at whisper, then mutes without intentionally pausing the video.
3. Video audio never changes in another tab and system master volume never changes.
4. Reopening popup shows correct remaining time even after popup closure and service worker restart.
5. Player replacement within the same YouTube tab is handled; tab closure is handled gracefully.
6. When wake is enabled, the user sees its exact next date/time and a **Test wake sound** control.
7. On a test machine with Chrome running and the OS awake, wake audio begins after the scheduled Chrome alarm event without requiring the popup or YouTube tab to be in front.
8. Wake audio is audible even when the target YouTube video is muted, provided the system output is audible and browser playback is permitted.
9. Snooze schedules one new wake event, and Dismiss stops audio and releases keep-awake.
10. Cancel clears timers, stops alarms, releases keep-awake, and restores original video volume only as a deliberate cancel/restore action.
11. Late/missed alarm handling never unexpectedly sounds hours after the intended wake time.
12. No network activity, analytics events, accounts, or server storage are introduced by the extension itself.

## 10. QA matrix

Test on current Chrome stable for macOS and Windows: regular video, long video, playlist transition, livestream, YouTube internal navigation, tab in background, popup closed, browser minimized, screen turned off while system awake, offline mode, service-worker termination/restart, manual changes to player volume, tab closure, Chrome shutdown/relaunch, OS sleeping, headphone disconnection, system mute, battery-powered laptop, time-zone/DST rollover, and daylight-saving date changes.

Critical experiment: overnight (at least 8-hour) wake delivery with the user selecting **Keep computer awake**, lid open, audio tested, Chrome open, then a negative test with system sleep to verify warning/late handling. Measure delivery time relative to Chrome's scheduled alarm event and time-to-first-audible-sound, and record failures rather than claiming precision the platform does not guarantee.

## 11. Build gates and release plan

**Gate A: 1-day technical proof of concept.** Verify YouTube volume fade and standalone wake audio in Chrome MV3, including autoplay and service-worker issues. If independent wake audio is unreliable, do not release the wake feature as an alarm.

**Gate B: MVP.** Ship polished popup, fade, optional wake, snooze/dismiss, permissions and reliability disclosures, local state recovery, and internal testing.

**Gate C: Limited beta.** Collect opt-in qualitative feedback, particularly about overnight wake failures, laptop/desktop setup, and whether the interface remains understandable in under ten seconds. Do not add telemetry without explicit product decision and disclosure.

**Success signals:** Fade completes consistently, beta users can arm a night without instructions, and wake-up tests succeed on awake computers with verified audio. A high wake failure rate, unclear warning language, or offscreen audio blocked by autoplay is a launch blocker for the wake feature.

## 12. Future opportunities (explicitly out of scope)

- **Nap mode:** “Wake in 25 / 45 / 90 minutes,” no clock-time entry.
- **Morning ambience:** wake to birdsong or soft bells, locally bundled.
- **Native/macOS companion:** stronger OS integration and alarm reliability (subject to OS policies).
- **More sources:** YouTube Music, podcasts, local media players.
- **Recurring schedules:** only after dependable one-night alarms are established.

## 13. Product decisions

- Default fade-start: **20 minutes**.
- Fade length: **10 minutes**; whisper hold: **5 minutes**.
- Wake is **optional** and clearly labeled as browser-dependent.
- Alarm uses **its own sound**, not YouTube playback.
- Wake sound ramps gently; Snooze = **9 minutes**.
- No accounts, backend, analytics, ads, sleep metrics, or system-wide volume control.
- **Never imply SleepyTube wakes a sleeping laptop or replaces a reliable phone alarm.**

---

### Technical references (reviewed October 2026)

- Chrome alarms API: https://developer.chrome.com/docs/extensions/reference/api/alarms
- Chrome power API: https://developer.chrome.com/docs/extensions/reference/api/power
- Chrome offscreen API: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- Chrome service worker lifecycle: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- Chrome autoplay policy: https://developer.chrome.com/blog/autoplay
- YouTube's native sleep timer: https://support.google.com/youtube/answer/15397997
- Existing adjacent extension, YTM Scheduler: https://chromewebstore.google.com/detail/ytm-scheduler/gphckibimggkgbapkphchhngcdnafnog
