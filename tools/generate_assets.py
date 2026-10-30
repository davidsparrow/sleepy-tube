#!/usr/bin/env python3
"""Generate SleepyTube's bundled assets: the wake chime and the toolbar icons.

Everything here is synthesised from scratch, so the output is original and
royalty-free. Re-run after tweaking to regenerate:

    python3 tools/generate_assets.py

Requires numpy and Pillow; ffmpeg (with libopus) is used to encode the chime.
"""

import os
import subprocess
import tempfile
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTENSION = os.path.join(ROOT, "extension")
SOUND_PATH = os.path.join(EXTENSION, "sounds", "wake-chime.ogg")
ICON_DIR = os.path.join(EXTENSION, "icons")

SAMPLE_RATE = 48000
LOOP_SECONDS = 7.0


# --- Wake chime ------------------------------------------------------------

def note(freq, duration, sr=SAMPLE_RATE):
    """A soft vibraphone-like tone: mostly harmonic partials, slow decay."""
    t = np.arange(int(duration * sr)) / sr
    partials = [(1.0, 1.0, 1.6), (2.0, 0.28, 0.9), (3.0, 0.08, 0.5), (4.2, 0.03, 0.3)]
    tone = np.zeros_like(t)
    for ratio, amp, decay in partials:
        tone += amp * np.sin(2 * np.pi * freq * ratio * t) * np.exp(-t / decay)
    attack = np.clip(t / 0.02, 0, 1)  # 20 ms attack: no click, no "ding"
    tremolo = 1 - 0.12 * (1 - np.cos(2 * np.pi * 4.5 * t)) / 2
    return tone * attack * tremolo


def simple_reverb(signal, sr=SAMPLE_RATE, seconds=1.2, mix=0.22, seed=7):
    rng = np.random.default_rng(seed)
    n = int(seconds * sr)
    t = np.arange(n) / sr
    ir = rng.standard_normal(n) * np.exp(-t / 0.35)
    # Gentle low-pass on the impulse response keeps the tail warm.
    kernel = np.ones(24) / 24
    ir = np.convolve(ir, kernel, mode="same")
    ir /= np.sqrt(np.sum(ir ** 2))
    wet = np.convolve(signal, ir)[: len(signal)]
    return (1 - mix) * signal + mix * wet


def build_chime():
    total = np.zeros(int(LOOP_SECONDS * SAMPLE_RATE))
    # G major pentatonic phrase: G4 B4 D5 B4 G5, then a soft resolving dyad.
    phrase = [
        (0.00, 392.00, 0.85),
        (0.42, 493.88, 0.75),
        (0.84, 587.33, 0.75),
        (1.26, 493.88, 0.65),
        (1.68, 783.99, 0.70),
        (2.50, 587.33, 0.45),
        (2.50, 392.00, 0.45),
    ]
    for start, freq, gain in phrase:
        tone = note(freq, LOOP_SECONDS - start) * gain
        i = int(start * SAMPLE_RATE)
        total[i:i + len(tone)] += tone[: len(total) - i]
    total = simple_reverb(total)
    # Fade the last half-second to true silence so the loop point is seamless.
    fade_len = int(0.5 * SAMPLE_RATE)
    total[-fade_len:] *= np.linspace(1, 0, fade_len)
    peak = np.max(np.abs(total))
    total *= 10 ** (-3 / 20) / peak  # normalise to -3 dBFS
    return total


def write_chime():
    samples = build_chime()
    pcm = (samples * 32767).astype("<i2")
    os.makedirs(os.path.dirname(SOUND_PATH), exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        wav_path = os.path.join(tmp, "chime.wav")
        with wave.open(wav_path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(pcm.tobytes())
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", wav_path,
             "-c:a", "libopus", "-b:a", "64k", "-map_metadata", "-1", SOUND_PATH],
            check=True,
        )
    print("wrote", os.path.relpath(SOUND_PATH, ROOT), os.path.getsize(SOUND_PATH), "bytes")


# --- Icons -----------------------------------------------------------------

BG_TOP = (36, 34, 92)
BG_BOTTOM = (18, 19, 46)
MOON = (255, 226, 150)


def draw_icon(size):
    s = 8  # supersampling factor
    big = size * s
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))

    gradient = Image.new("RGBA", (big, big))
    gd = ImageDraw.Draw(gradient)
    for y in range(big):
        f = y / (big - 1)
        colour = tuple(int(BG_TOP[i] * (1 - f) + BG_BOTTOM[i] * f) for i in range(3)) + (255,)
        gd.line([(0, y), (big, y)], fill=colour)
    mask = Image.new("L", (big, big), 0)
    radius = int(big * 0.22)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=255)
    img.paste(gradient, (0, 0), mask)

    # Crescent: a full disc with an offset disc cut away.
    cx, cy, r = big * 0.47, big * 0.53, big * 0.30
    moon = Image.new("L", (big, big), 0)
    md = ImageDraw.Draw(moon)
    md.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    ox, oy, orr = cx + r * 0.55, cy - r * 0.38, r * 0.86
    md.ellipse([ox - orr, oy - orr, ox + orr, oy + orr], fill=0)

    if size >= 32:
        glow = moon.filter(ImageFilter.GaussianBlur(big * 0.05))
        glow_layer = Image.new("RGBA", (big, big), MOON + (0,))
        glow_layer.putalpha(glow.point(lambda v: int(v * 0.45)))
        img.alpha_composite(glow_layer)

    moon_layer = Image.new("RGBA", (big, big), MOON + (255,))
    moon_layer.putalpha(moon)
    img.alpha_composite(moon_layer)

    if size >= 32:
        sd = ImageDraw.Draw(img)
        for (sx, sy, sr) in [(0.74, 0.27, 0.035), (0.80, 0.50, 0.022), (0.62, 0.17, 0.018)]:
            px, py, pr = sx * big, sy * big, sr * big
            sd.ellipse([px - pr, py - pr, px + pr, py + pr], fill=(255, 246, 220, 255))

    return img.resize((size, size), Image.LANCZOS)


def write_icons():
    os.makedirs(ICON_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(ICON_DIR, f"icon-{size}.png")
        draw_icon(size).save(path, optimize=True)
        print("wrote", os.path.relpath(path, ROOT))


if __name__ == "__main__":
    write_chime()
    write_icons()
