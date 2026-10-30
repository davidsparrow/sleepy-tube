# SleepyTube QA guide

This covers the PRD's **Gate A** technical proof (§7, §11), the **QA matrix** (§10), and the tools that make both quicker.

## Tools

**Service worker console:** `chrome://extensions` → SleepyTube → *service worker*.

| Command | Use |
|---|---|
| `await sleepyDebug.session()` | Inspect the stored session (timestamps, `fade.status`, `wake.status`). |
| `await sleepyDebug.notices()` | Notices waiting in the popup (tab closed, alarm missed, alarm stopped). |
| `await sleepyDebug.fastForward(n)` | Move the whole night *n* minutes forward and reconcile. For example, `fastForward(20)` starts the fade now. |
| `await sleepyDebug.reset()` | Forget the session without touching the video. |
| `await chrome.alarms.getAll()` | See scheduled transitions (`st:fade-start`, `st:fade-whisper`, `st:fade-mute`, `st:wake`, `st:wake-stop`). |

**To restart the service worker**, use *Stop* on `chrome://serviceworker-internals`, or wait about 30 seconds idle. Reopen the popup afterwards: the countdown must still be right.

**Automated suites:** `npm test` (timing core) and `npm run test:e2e` (the whole extension in Chromium against a mock YouTube page). Run both before every manual pass.

## Gate A: overnight wake proof (required before shipping the wake alarm)

Goal: show that an MV3 service worker sounds the bundled chime from the offscreen document after hours of inactivity, on real **macOS** and **Windows** machines with current Chrome stable.

### Positive run (at least 8 hours)

1. Fresh Chrome profile with SleepyTube loaded. Speakers on, system volume about 30%.
2. Play a long YouTube video (e.g. a 10-hour ambient video).
3. In the popup, switch on **Fade to Sleep** and **Alarm**, and use the calendar button to set the alarm at least 8 hours away. Press **▶** and confirm it's audible. Under **limitations**, turn on **Keep computer awake until the alarm**.
4. Arm. Lid open, charger in. Don't touch the machine.
5. In the morning, record:
   - the scheduled wake time, and when the chime was first audible (watch, phone recording, or a nearby sound-level app);
   - from the service worker console, `(await sleepyDebug.session()).wake`, noting `ringStartedAt` minus `wakeAt` (alarm delivery delay) and `audioError` (must be `null`);
   - that the video was muted and still playing, the wake window appeared, and the notification was present;
   - that Snooze rang again about 9 minutes later and I'm awake stopped everything.

### Negative run (system sleep)

1. Same setup, but **without** Keep computer awake, and with the OS sleep timer set to 1–2 minutes (or close the lid).
2. Let the machine sleep through the wake time, then wake it at least 10 minutes later.
3. Expected: **no chime**. The Alarm switch is off, the popup shows a "missed your … alarm" notice, a "missed" notification appears, and the badge shows `!`.
4. Repeat, waking the machine less than 10 minutes after the wake time. Expected: it rings immediately with the normal ramp.

### Record each run

| Field | Value |
|---|---|
| OS / version | |
| Chrome version | |
| Hardware, power source | |
| Keep awake on? | |
| Scheduled wake | |
| `ringStartedAt − wakeAt` | |
| First audible sound | |
| `audioError` | |
| Snooze / dismiss OK? | |
| Notes / failures | |

Record failures as they happen; don't claim precision the platform doesn't guarantee. **Launch blockers:** a high wake failure rate, any `audioError` from autoplay restrictions, or warning text testers misread. If the run is unreliable, ship fade-only first, as the PRD recommends.

## QA matrix (PRD §10)

Run on current Chrome stable for macOS and Windows. Use `fastForward` to reach each phase quickly unless the case is about real elapsed time.

| Case | How | Expected |
|---|---|---|
| Regular video | Switch Fade to Sleep on with defaults, then `fastForward(20)`, `(5)`, `(5)`, `(10)` | Smooth fade, whisper, then muted; playback continues at normal speed |
| Chips and buttons | Change each chip before and during its step; +10/+20 in each step; Restart; Cancel | Times update; started steps lock; no volume jump; Cancel restores the volume |
| Long video / livestream | Same, on a 10h video and on a live stream | Same; nothing pauses or seeks |
| Playlist transition | Let a playlist advance during the fade or after mute | New item keeps the planned level or stays muted |
| YouTube internal navigation | Click to another video in the same tab mid-fade | Fade continues on the new video, on the original timeline |
| Tab in background / popup closed / browser minimized | Arm, switch tabs, minimize | Fade still happens on time |
| Screen off, system awake | Let the display sleep | Fade and alarm still happen |
| Offline mode | Disconnect the network after the video buffers | Alarm still sounds (bundled audio) |
| Service worker restart | Stop it, then reopen the popup | Countdown correct; alarms still listed |
| Manual volume change mid-fade | Use YouTube's volume control | Fade pauses; Resume fade offered; nothing fights you |
| After the night | Dismiss the alarm, then use YouTube's own volume control | The video becomes audible again; SleepyTube lets go |
| Alarm only | Alarm on with no YouTube tab open | Rings normally |
| Tab closure | Close the YouTube tab mid-fade | Warning notification and notice; wake alarm kept |
| Chrome shutdown / relaunch | Quit Chrome before the wake time, relaunch | Fade reported lost (tab IDs change); wake rings if still due, or reported missed if 10+ min late |
| OS sleep | See the Gate A negative run | Missed, not late |
| Headphones disconnected | Unplug before the wake time | Chime plays on the OS's current output device |
| System mute | Mute the OS, then press ▶ | Silent: the limitations panel tells users to check this |
| Battery laptop | Keep awake on, on battery | Keep-awake is held, then released after dismissal |
| DST change | Set the alarm the night before a DST change | Wake rings at the chosen wall-clock time; popup shows the date and am/pm |
| Time zone change | Change the OS time zone after arming | Wake rings at the originally scheduled moment; use Change wake time to follow the new zone |
| Other tabs | Second YouTube tab playing | Its volume is never changed |
| Popup size | Open the popup with both switches on, a notice, and the override banner | Nothing is cut off within Chrome's 800 × 600 limit |
| Accessibility | Keyboard only; screen reader (VoiceOver / NVDA) | Switches, chips (arrow keys), date-time picker and dialog work with keys; focus is always visible; states are announced |

**Known platform limits:** SleepyTube can't wake a sleeping computer, keep Chrome running after it's closed, or stop YouTube's own "Are you still watching?" pause.
