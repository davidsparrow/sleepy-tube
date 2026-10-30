# SleepyTube QA guide

This guide is for testers. **You won't need Terminal, the command line or any coding.** Everything happens inside Google Chrome, by clicking and sometimes typing a short command into a box.

**Words used in this guide**

- **Address bar**: the long box at the top of Chrome where you type web addresses.
- **Popup**: the SleepyTube window that opens when you click its moon icon next to the address bar.
- **Debug console**: a window inside Chrome where you can type test commands, such as "jump 20 minutes ahead" (Part 2).
- **Service worker**: SleepyTube's hidden "engine" that runs in the background inside Chrome.

Contents:

1. [Install SleepyTube](#part-1-install-sleepytube-about-10-minutes)
2. [The debug console](#part-2-the-debug-console-your-time-machine)
3. [Restarting the service worker](#part-3-restarting-the-service-worker)
4. [Test cases](#part-4-test-cases)
5. [Overnight alarm test (Gate A)](#part-5-overnight-alarm-test-gate-a)
6. [Reporting a problem](#part-6-reporting-a-problem)
7. [For developers only](#part-7-for-developers-only)

---

## Part 1: Install SleepyTube (about 10 minutes)

### What you need

- A Mac or Windows computer with **Google Chrome**, up to date. To check: click the **⋮** menu (top right of Chrome) → **Help** → **About Google Chrome**. Chrome updates itself on that page; if asked, click **Relaunch**.
- Access to the SleepyTube project on GitHub. If the link below says "404" or "Page not found", sign in to GitHub; if it still fails, ask the project owner to give your GitHub account access.

### Step 1: Download SleepyTube

1. In Chrome, open <https://github.com/davidsparrow/sleepy-tube>.
2. **Only if you were asked to test a particular branch:** click the button above the file list that says **main**, then click the branch name you were given. Otherwise, leave it on **main**.
3. Click the green **Code** button (top right of the file list).
4. Click **Download ZIP**.
5. A ZIP file downloads to your **Downloads** folder. Its name starts with `sleepy-tube` (for example `sleepy-tube-main.zip`).

### Step 2: Unzip it into your Documents folder

**On a Mac**

1. Open **Finder**, then click **Downloads** in the left sidebar.
2. Double-click the `sleepy-tube…zip` file. A folder with the same name (without `.zip`) appears next to it.
3. Drag that **folder** onto **Documents** in the left sidebar.

**On Windows**

1. Open **File Explorer**, then click **Downloads** on the left.
2. Right-click the `sleepy-tube…zip` file → **Extract All…**.
3. Click **Browse…**, choose **Documents**, click **Select Folder**, then click **Extract**.

> ⚠️ **Don't move, rename or delete this folder while you're testing.** Chrome runs SleepyTube straight from it.

### Step 3: Turn on Developer mode in Chrome

1. Click in the address bar, type `chrome://extensions` and press **Enter**.
2. In the **top-right corner** of that page, click the **Developer mode** switch so it turns **on** (blue).
3. Three new buttons appear near the top left: **Load unpacked**, **Pack extension** and **Update**.

If the switch is greyed out and says *"managed by your administrator"*, this computer is controlled by an organisation. Use a personal computer or Chrome profile instead.

### Step 4: Load SleepyTube into Chrome

1. Click **Load unpacked**. A window for choosing a folder opens.
2. Go to **Documents** → open the **`sleepy-tube…`** folder you unzipped.
3. Inside it, click **once** on the folder called **`extension`**. Don't open it; just select it.
4. Click **Select** (Mac) or **Select Folder** (Windows).
5. A card called **SleepyTube** with the version number (for example **1.1.0**) appears on the extensions page. 🎉

**If Chrome says "Manifest file is missing or unreadable":** you picked the wrong folder. Try again and choose the folder named exactly `extension` (it's inside the `sleepy-tube…` folder).

### Step 5: Pin the moon icon to the toolbar

1. Click the **puzzle-piece icon** 🧩 to the right of the address bar.
2. Find **SleepyTube** in the list and click the **pin** 📌 next to it.
3. A small **moon icon** now sits next to the address bar. Click it: the SleepyTube popup opens (a koala on a starry sky).

### Step 6: Two-minute check that it works

1. Go to <https://www.youtube.com> and start playing any video.
2. Click the **moon icon**. The **Fade to Sleep** switch should look normal, not faded, with no yellow "Open a YouTube video first" message.
3. Click the **Alarm** switch to turn it on, then click the round **▶** button to the right of the wake-up time. You should hear a soft chime for about 6 seconds.
4. Click both switches off again.

If all of that worked, you're ready to test.

### Getting a newer version later

1. Go to `chrome://extensions`, find the **SleepyTube** card and click **Remove** → **Remove**.
2. Delete the old `sleepy-tube…` folder from Documents.
3. Repeat Steps 1, 2 and 4 above (and Step 5 if the icon disappears).

### Things you may see (all normal)

- On some computers, Chrome shows a box saying **"Disable developer mode extensions"** when it starts. Click the **X** or **Cancel**, *not* "Disable".
- On the SleepyTube card, Chrome may show an **ID** (a long string of letters). You'll only need it in Part 3.

### Removing SleepyTube completely

Go to `chrome://extensions` → SleepyTube card → **Remove** → **Remove**, then delete the folder from Documents.

---

## Part 2: The debug console (your "time machine")

SleepyTube's steps take 20 minutes or more, and the alarm may be hours away. The debug console lets you tell SleepyTube to **jump ahead in time** so you can test in seconds. It only affects SleepyTube's own schedule; your computer's clock doesn't change.

### Open the debug console

1. Go to `chrome://extensions` (Developer mode must be on; see Part 1, Step 3).
2. On the **SleepyTube** card, find the words **Inspect views** and click the blue link **service worker** next to them. If it also says "inactive", click it anyway.
3. A new window opens. Its title includes **DevTools** and **background.js**.
4. Near the top of that window, click the tab called **Console**.
5. At the bottom of the Console there's a **`>`** symbol. That's where you type.

### Type a command

1. Click just to the right of the **`>`**.
2. Type the command exactly as written in the table below, for example `await sleepyDebug.fastForward(20)`, and press **Enter**.
3. A reply appears underneath. Usually you can ignore it; a step will tell you if you need to read it.

**If you paste a command instead of typing it**, Chrome may show a yellow warning ("Warning: Don't paste code…") and ask you to type **`allow pasting`**. Type `allow pasting`, press **Enter**, then paste the command again. This only happens the first time.

**Red text in the Console means something went wrong.** Take a screenshot and report it (Part 6).

### Commands

| Type this | What it does |
|---|---|
| `await sleepyDebug.fastForward(20)` | Jumps SleepyTube **20 minutes** ahead. Change the number for other amounts, such as `fastForward(5)`. The whole night moves, so the alarm time shown in the popup moves earlier too. That's expected. |
| `await sleepyDebug.skipToAlarm()` | Makes the alarm ring **now**. Replies "Ringing now." (or "The alarm is not set."). |
| `await sleepyDebug.alarmLog()` | Shows a table of recent alarm events: when each was **due**, when it **happened**, how many **seconds late** it rang, and any **sound problem**. |
| `await sleepyDebug.session()` | Shows tonight's full plan (useful in bug reports). |
| `await sleepyDebug.notices()` | Shows the messages waiting in the popup (tab closed, alarm missed, and so on). |
| `await sleepyDebug.reset()` | Clears tonight completely so you can start a fresh test. It doesn't change the video's volume. |

### ⚠️ Close the debug console before "real-life" tests

While the debug console window is open, Chrome keeps SleepyTube's engine awake. That's fine for most tests, but **close the DevTools window** (click its red ● on Mac, or **X** on Windows) before:

- the restart test (Part 3), and
- the overnight test (Part 5).

---

## Part 3: Restarting the service worker

**Why:** Chrome puts SleepyTube's engine to sleep after about 30 seconds of quiet, and may stop it at other times. When it wakes up, SleepyTube must remember everything (the countdown, the alarm, the switches). This test checks that.

You need two Chrome tabs and no Terminal. Here's how:

1. **Set up a night:** play a YouTube video, open the popup, and turn on **Fade to Sleep** and **Alarm**. Write down the countdown shown in green next to **Countdown** (for example "19m 40s") and the alarm time.
2. Click anywhere on the YouTube page to close the popup. **Close the debug console** window if it's open.
3. Open a **new tab** (Ctrl+T on Windows, ⌘+T on Mac). In the address bar type `chrome://serviceworker-internals` and press **Enter**. A plain page full of text opens.
4. Press **Ctrl+F** (Windows) or **⌘+F** (Mac) and search for `background.js`. Look for the block whose **Script** line ends in `/background.js`. That's SleepyTube.
   - If several extensions match, compare the long ID in that block's **Scope** line (`chrome-extension://ID/`) with the **ID** on the SleepyTube card at `chrome://extensions`.
5. In that block, check it says **Running Status: RUNNING**. Then click the **Stop** button in the same block.
6. ⚠️ **Never click Unregister.** It breaks SleepyTube until you remove it and load it again (Part 1, Steps 3–4).
7. Within a few seconds the block shows **Running Status: STOPPED**. If it doesn't change, refresh the page (F5 on Windows, ⌘+R on Mac).
8. Click the **moon icon** to open the popup.

**Expected:**

- Both switches are still on.
- The countdown has carried on. It's a little lower than what you wrote down, *not* reset to 20 minutes.
- The alarm time is unchanged.
- Back on the `serviceworker-internals` tab, after a refresh, SleepyTube shows **RUNNING** again (opening the popup woke it).

**Lazy alternative:** close the popup and any SleepyTube windows, don't touch Chrome for **at least 1 minute**, then open the popup and check the same things. This version is less certain, because you can't see that the engine actually stopped.

---

## Part 4: Test cases

Run these on a current Chrome on **Mac** and on **Windows**. Unless a test says otherwise:

- start each test with a YouTube video **playing** and YouTube's own volume at about **half**;
- start fresh by typing `await sleepyDebug.reset()` in the debug console;
- "open the popup" means click the moon icon.

Default timings: **Countdown 20 min → Fade 10 min → Whisper 10 min → Silence**.

### Fade to Sleep

**T1. A normal night**

1. Open the popup and turn on **Fade to Sleep**.
   *Expect:* the switch turns green, three rows appear (Countdown, Fade duration, Whisper duration), each row shows a time ("fade begins @ …", "fade ends @ …", "silence @ …"), and a green box next to **Countdown** shows the time left. A small ☾ appears on the moon icon.
2. Console: `await sleepyDebug.fastForward(20)`.
   *Expect:* within a few seconds the sound starts getting quieter, and the green box moves to **Fade duration**.
3. Console: `await sleepyDebug.fastForward(5)`. *Expect:* clearly quieter, and no sudden jumps.
4. Console: `await sleepyDebug.fastForward(5)`. *Expect:* a very quiet whisper.
5. Console: `await sleepyDebug.fastForward(10)`. *Expect:* silent, but the video **keeps playing** (its time counter keeps moving). The popup says "Silent since …", and the ☾ disappears from the icon.
6. Click the **Fade to Sleep** switch off. *Expect:* the sound comes back at the original volume.

**T2. Changing the chips while it's on**

1. Turn on **Fade to Sleep**. Click **30** in Countdown, **20** in Fade duration and **15** in Whisper duration.
   *Expect:* each click turns green and the times next to the rows update straight away.
2. Console: `await sleepyDebug.fastForward(31)` (the fade has now started).
3. Click a different Countdown chip. *Expect:* nothing changes, and a message says that part has already started.
4. Close and reopen the popup. *Expect:* your choices are still selected.

**T3. +10 and +20**

1. Turn on **Fade to Sleep**, note the "fade begins @" time, then click **+10**. *Expect:* every time moves 10 minutes later.
2. Console: `await sleepyDebug.fastForward(34)` (now fading). Click **+20**. *Expect:* "fade ends @" moves 20 minutes later and the volume **does not jump up**.
3. Console: `await sleepyDebug.fastForward(30)` (now whispering). Click **+10**. *Expect:* only "silence @" moves.
4. Console: `await sleepyDebug.fastForward(30)` (now silent). *Expect:* **+10** and **+20** are greyed out.

**T4. Restart**

1. Turn on **Fade to Sleep**, then Console: `await sleepyDebug.fastForward(41)`. *Expect:* silent.
2. Click **Restart**. *Expect:* the sound comes back at the original volume, and the countdown starts again from 20 minutes.

**T5. Cancel**

1. Turn on **Fade to Sleep**, then Console: `await sleepyDebug.fastForward(25)` (half-faded).
2. Click the red **Cancel** under the fade. *Expect:* the switch turns off and the sound returns to the original volume.

**T6. Changing the volume yourself during the fade**

1. Turn on **Fade to Sleep**, then Console: `await sleepyDebug.fastForward(25)`.
2. On the YouTube video, drag YouTube's own volume slider up.
   *Expect:* SleepyTube **does not** pull it back down. The popup shows "You changed the volume, so the fade is paused" with a **Resume fade** button, and the moon icon shows a red **!**.
3. Click **Resume fade**. *Expect:* the fade starts again from your new volume and takes 10 minutes.

**T7. Changing the volume before the fade starts**

1. Turn on **Fade to Sleep** (don't fast-forward). Change YouTube's volume.
   *Expect:* no message. The fade will start from your new volume.
2. Console: `await sleepyDebug.fastForward(20)`. *Expect:* it fades from the volume you just chose.

**T8. Going to another video in the same tab**

1. Turn on **Fade to Sleep**, then Console: `await sleepyDebug.fastForward(25)`.
2. On YouTube, click a different video in the same tab. *Expect:* the new video plays at the same quiet level and keeps fading on the same schedule.

**T9. Playlists**

1. Start a playlist. Turn on **Fade to Sleep**, then Console: `await sleepyDebug.fastForward(41)` (silent).
2. Skip to the next video in the playlist (or let it advance). *Expect:* the next video is silent too.

**T10. Closing the YouTube tab**

1. Turn on **Fade to Sleep** and **Alarm**. Close the YouTube tab.
   *Expect:* a notification says the fade stopped. In the popup, **Fade to Sleep** is off, a yellow message explains why, the **Alarm** is still on, and the icon shows **!**.
2. Click the **×** on the yellow message. *Expect:* it disappears.

**T11. In the background**

1. Turn on **Fade to Sleep**, switch to another tab and minimize Chrome. Wait for the real fade time (or fast-forward from the console). *Expect:* the fade still happens.

**T12. After the night, YouTube's own controls still work**

1. Turn on both switches, then Console: `await sleepyDebug.skipToAlarm()`. Click **I'm awake**.
2. The video is still silent. Drag YouTube's volume slider. *Expect:* the sound comes back, and SleepyTube's **Fade to Sleep** turns off by itself.

**T13. Other tabs**

1. Play a second YouTube video in another tab. Run T1 in the first tab. *Expect:* the second tab's volume never changes.

### Alarm

**T14. Setting the time**

1. Turn on **Alarm**. *Expect:* the time and calendar icon turn yellow, and "Rings in …" appears.
2. Click **+10**, then **−10**. *Expect:* the time moves 10 minutes later, then back.
3. Click the **calendar icon**. *Expect:* a date-and-time picker opens. Pick a time within the next 24 hours. *Expect:* the alarm shows the new time.
4. With the picker, choose a time **more than 24 hours** away. *Expect:* it's refused, with a message.
5. Turn on **Fade to Sleep** too, then use **−10** or the picker to set the alarm *before* "silence @". *Expect:* it's refused, with a message about the video not being silent yet.
6. Close and reopen the popup. *Expect:* the alarm time is the same. When you turn the alarm on again on another day, it remembers this time.

**T15. The alarm rings**

1. Turn on **Fade to Sleep** and **Alarm**. Console: `await sleepyDebug.fastForward(41)` (video silent), then `await sleepyDebug.skipToAlarm()`.
2. *Expect:*
   - the chime starts **very quietly** and gets louder over about 90 seconds;
   - a **wake window** opens with big **Snooze 9 min** and **I'm awake** buttons;
   - a notification appears with the same two buttons;
   - the moon icon shows **☀**;
   - the YouTube video **stays silent**.

**T16. Snooze**

1. While it rings, click **Snooze 9 min** (in the wake window, the popup or the notification).
   *Expect:* the sound stops, and it shows "Snoozing" with the time it will ring again.
2. Console: `await sleepyDebug.skipToAlarm()`. *Expect:* it rings again, starting quiet again.

**T17. I'm awake**

1. While it rings, click **I'm awake**.
   *Expect:* the sound stops, the Alarm switch turns off, and the video **stays silent**.
2. In the wake window, click **Restore video sound**. *Expect:* the video's sound comes back.

**T18. Alarm with no YouTube tab**

1. Close all YouTube tabs. Open the popup. *Expect:* the Fade side says "Open a YouTube video first".
2. Turn on **Alarm**, then Console: `await sleepyDebug.skipToAlarm()`. *Expect:* it rings normally.

**T19. Nobody answers**

1. Turn on **Alarm**, then Console: `await sleepyDebug.skipToAlarm()`, then `await sleepyDebug.fastForward(15)`.
   *Expect:* the sound stops by itself, a message says it rang for 15 minutes, and the Alarm switch turns off.

**T20. Missed alarm (simulated)**

1. Turn on **Alarm** and use the picker to set it about **30 minutes** from now.
2. Console: `await sleepyDebug.fastForward(45)` (this pretends the computer slept through the alarm).
   *Expect:* **no sound**. A message says SleepyTube missed your alarm, the Alarm switch is off, and the icon shows **!**.

**T21. Test sound**

1. Turn the computer's volume **all the way down**, then press **▶**. *Expect:* silence. The **limitations** panel tells people to check this.
2. Plug in headphones and press **▶**. *Expect:* the chime plays in the headphones.
3. Turn off Wi-Fi and press **▶**. *Expect:* it still plays (the sound is built in).

**T22. Limitations and Keep computer awake**

1. Click **limitations**. *Expect:* a panel opens with the warning "SleepyTube cannot wake your computer from sleep…", a **Keep computer awake** switch, an **Alarm volume** slider and a **▶ Test** button.
2. Turn on **Keep computer awake**. *Expect:* it stays on. Chrome may briefly ask for permission; allow it.
3. Click **Done**. Turn on **Alarm**. *Expect:* the alarm line says "Keeping the computer awake."
4. Move the **Alarm volume** slider and press **▶ Test**. *Expect:* the chime plays at the new level.

**T23. Info page**

1. Click **How it works** (top right of the popup). *Expect:* a page opens in a new tab explaining everything, with no buttons or switches.

### Robustness

**T24. Service worker restart.** Follow Part 3.

**T25. Quitting Chrome**

1. Turn on both switches. Quit Chrome completely (Mac: ⌘+Q; Windows: close every Chrome window). Reopen Chrome.
2. Open the popup. *Expect:* the Alarm is still on with the same time. Fade to Sleep is off, with a yellow message saying the YouTube tab was closed. That's expected: when Chrome restarts, it treats reopened tabs as new tabs.

**T26. Screen off, computer awake**

1. Turn on **Keep computer awake** (T22) and **Alarm**, set for about 15 minutes away. Let the screen turn itself off. *Expect:* the alarm still rings on time.

### Accessibility

**T27. Keyboard only**

1. Open the popup and use only **Tab**, **Shift+Tab**, **Space**, **Enter** and the **arrow keys**.
   *Expect:* you can reach and use every switch, chip, button and link. A white outline always shows where you are. In a row of chips, the left and right arrows choose the previous or next value.
2. When the alarm rings, the wake window starts with **Snooze** selected, so pressing Space or Enter snoozes rather than dismisses.

**T28. Screen reader** (VoiceOver on Mac: ⌘+F5; Narrator on Windows: Ctrl+Windows+Enter)

1. *Expect:* the switches are read as "Fade to Sleep, switch, on/off". Chips are read as "20 minutes, radio button, selected". Changes like "Alarm set for 7:30 am…" and "Wake alarm ringing" are announced.

**T29. Popup size**

1. Create the busiest popup you can: both switches on, a yellow message showing (do T10 step 1), and the "You changed the volume" message (T6 step 2). *Expect:* nothing is cut off and there's no scroll bar.

---

## Part 5: Overnight alarm test (Gate A)

This is the most important test. The PRD says the alarm can't be released until it **reliably rings after a whole night** on real Macs and Windows PCs. Don't use the debug console's time commands for this test.

### Overnight: the alarm should ring

**Evening**

1. Plug the laptop into power and **keep the lid open** all night.
2. Set the computer's volume to about **30%**, and unplug headphones.
3. Play a long YouTube video (for example, search "10 hour rain sounds").
4. Open the popup and turn on **Fade to Sleep** and **Alarm**.
5. Click the **calendar icon** and choose a wake-up time at least **8 hours** away.
6. Press **▶** and check you can hear the chime.
7. Click **limitations** → turn on **Keep computer awake until the alarm** → **Done**.
8. Make sure the debug console is **closed**. Leave the computer alone.

**Morning**

1. Write down **when you first heard the chime** (a phone voice memo running overnight helps).
2. Check: did the wake window appear? Was there a notification? Was the video silent but still playing?
3. Click **Snooze 9 min**. Check that it rings again about 9 minutes later. Then click **I'm awake**.
4. Open the debug console (Part 2) and type `await sleepyDebug.alarmLog()`. Take a **screenshot** of the table. The important columns are:
   - **seconds late**: how late the alarm rang (a few seconds is fine);
   - **sound problem**: must be empty.

### Sleep test: the alarm should NOT ring late (about 30 minutes)

This checks that an alarm the computer slept through is skipped, rather than going off hours later.

1. Close all SleepyTube windows. In the popup, make sure **Keep computer awake** (under **limitations**) is **off**.
2. Turn on **Alarm** and click the **calendar icon**. Set the alarm about **10 minutes** from now, and write the time down.
3. Put the computer to sleep **from the menu**:
   - Mac: click the  **Apple menu** (top-left corner) → **Sleep**.
   - Windows: click **Start** → the **power** button → **Sleep**.
4. Wait until it's **at least 15 minutes after** the alarm time, then wake the computer (press a key or open the lid) and log in.
5. *Expect:* **no chime**. Within about a minute the popup shows a yellow "SleepyTube missed your … alarm" message, a notification says it was missed, the Alarm switch is off, and the icon shows **!**.
6. **Repeat with a short sleep:** set a new alarm about 5 minutes away, put the computer to sleep, and wake it **about 3 minutes after** the alarm time. *Expect:* within about a minute of waking, it **rings**, starting quietly (it's less than 10 minutes late, so it still counts).
7. Open the debug console and type `await sleepyDebug.alarmLog()`. Take a screenshot: you should see a **missed** row for step 5 and a **rang** row for step 6.

### Record each night

Fill in one copy for the overnight test and one for the sleep test.

| Field | Value |
|---|---|
| Mac or Windows, and version | |
| Chrome version (⋮ → Help → About Google Chrome) | |
| Computer model; plugged in or on battery | |
| Keep computer awake on? | |
| Alarm time set | |
| When you first heard it | |
| "seconds late" from the alarm log | |
| "sound problem" from the alarm log | |
| Snooze and I'm awake worked? | |
| Anything odd | |

**Stop and report immediately if:** the alarm didn't ring on an awake computer, it rang more than a minute late, the log shows a sound problem, or any wording confused you.

---

## Part 6: Reporting a problem

Please include:

1. **The test number** (for example "T16, step 2") and what you expected.
2. **What actually happened.**
3. **A screenshot.** Mac: ⇧+⌘+4, then drag over the area. Windows: Windows key+Shift+S, then drag.
4. **Mac or Windows, and the Chrome version** (⋮ → Help → About Google Chrome).
5. **SleepyTube's error list:** go to `chrome://extensions`. If the SleepyTube card has a red **Errors** button, click it and take a screenshot.
6. **Tonight's plan:** in the debug console, type `await sleepyDebug.session()` and `await sleepyDebug.alarmLog()`, then take a screenshot.

**Known limits (not bugs):** SleepyTube can't wake a sleeping computer, keep working after Chrome is closed, or stop YouTube's own "Video paused. Continue watching?" message.

---

## Part 7: For developers only

Testers can skip this part. It needs Terminal, Node.js 18+ and Git.

```sh
git clone https://github.com/davidsparrow/sleepy-tube.git
cd sleepy-tube                       # every command below runs from this folder
# To test a branch under review: git checkout <branch-name>

npm test                             # unit tests for the timing logic
npm install                          # once: installs Playwright
npx playwright install chromium      # once: downloads the test browser
npm run test:e2e                     # end-to-end tests: real extension, mock YouTube page
npm run package                      # zips extension/ into dist/ for the Chrome Web Store
```

Run `npm test` and `npm run test:e2e` before every manual QA pass. Then load the `extension/` folder as in Part 1, Step 4.
