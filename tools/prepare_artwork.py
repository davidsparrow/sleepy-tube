#!/usr/bin/env python3
"""Prepare the supplied artwork for the extension's night-sky UI.

    python3 tools/prepare_artwork.py path/to/sleepytube-logo.svg path/to/sleepytube-bg.webp

Logo (designer's SVG, drawn for a white page):
  - recolours the wordmark for a dark sky: "SleepyTube" green, "Sweet Dreams" white
    (the first ten #434043 glyph groups spell "SleepyTube", the rest "Sweet Dreams");
  - removes the full-page white backdrop;
  - trims coordinate precision (visually identical, about a third smaller);
  - crops the canvas to the artwork (pass --viewbox if the artwork moves).

Background: resized to 900 px wide WebP; the 50% dark overlay is applied in CSS.

Requires Pillow (with WebP support).
"""

import argparse
import os
import re

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGES = os.path.join(ROOT, "extension", "images")

WORDMARK_INK = '<g fill="#434043" fill-opacity="1">'
GREEN = "#b8dc4c"
# Bounding box of the artwork inside the designer's 612 × 792 page.
DEFAULT_VIEWBOX = "149.0 261.0 333.0 274.0"


def prepare_logo(src, viewbox):
    svg = open(src, encoding="utf-8").read()
    count = 0

    def recolour(_match):
        nonlocal count
        count += 1
        return '<g fill="%s" fill-opacity="1">' % (GREEN if count <= 10 else "#ffffff")

    svg = svg.replace(WORDMARK_INK, "\0")
    svg = re.sub("\0", recolour, svg)
    svg = re.sub(r'<rect [^>]*fill="#ffffff"[^>]*/>', "", svg)  # page backdrop
    svg = re.sub(r"(\d+\.\d{2})\d+", r"\1", svg)
    _x, _y, w, h = (float(v) for v in viewbox.split())
    head = (
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        'viewBox="%s" width="%d" height="%d" version="1.0">' % (viewbox, round(w), round(h))
    )
    svg = re.sub(r"^<svg[^>]*>", head, svg, count=1)
    out = os.path.join(IMAGES, "logo.svg")
    with open(out, "w", encoding="utf-8") as f:
        f.write(svg)
    print("wrote", os.path.relpath(out, ROOT), "(%d glyph groups recoloured)" % count)


def prepare_background(src, width=900):
    img = Image.open(src).convert("RGB")
    img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    out = os.path.join(IMAGES, "night-sky.webp")
    img.save(out, "WEBP", quality=70, method=6)
    print("wrote", os.path.relpath(out, ROOT), img.size)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("logo_svg")
    parser.add_argument("background")
    parser.add_argument("--viewbox", default=DEFAULT_VIEWBOX)
    args = parser.parse_args()
    os.makedirs(IMAGES, exist_ok=True)
    prepare_logo(args.logo_svg, args.viewbox)
    prepare_background(args.background)
