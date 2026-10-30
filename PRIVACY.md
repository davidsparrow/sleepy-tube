# SleepyTube privacy policy

SleepyTube is designed to collect nothing.

**What it stores, and where.** Tonight's schedule (fade and wake timestamps), the video's volume and mute state before the fade, the ID of the browser tab it's fading, short notices (such as "alarm missed") until you dismiss them, and your preferences (countdown, fade and whisper lengths, wake time, alarm volume, keep-awake choice). These are kept only in `chrome.storage.local` on your device. A night's record is deleted once both switches are off, and forgotten automatically after 36 hours.

**What it never collects.** Video titles, URLs, viewing history, account details, or any audio. SleepyTube checks whether a tab is on `www.youtube.com` so it knows it can work there, but it never records the address.

**No network activity.** SleepyTube has no server, account, analytics, telemetry, tracking or advertising. Its own pages block outgoing connections (`connect-src 'none'`). The wake chime and icons are bundled inside the extension.

**Permissions.** SleepyTube only runs on `www.youtube.com`, and only changes the volume of the one tab you armed it on. It never changes your computer's system volume. The optional `power` permission is requested only if you turn on "Keep computer awake", and the keep-awake request is released after the alarm.

**Sync.** Nothing is synced between devices.
