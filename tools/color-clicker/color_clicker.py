#!/usr/bin/env python3
"""
color_clicker.py - click an icon when it turns a given color on the screen.

It can watch either
  * a single point  (the icon is always in the same place), or
  * an area         (the icon can show up anywhere inside a box you choose;
                     it clicks wherever the color appears).

Setup (once):
    pip install pyautogui pillow numpy

Interactive setup:
    python color_clicker.py

Or pass everything on the command line:
    python color_clicker.py --x 812 --y 440 --color "#3ec46d"
    python color_clicker.py --area 600 300 1000 600 --color "#3ec46d"

Stop it: press Ctrl+C, or slam the mouse into the top-left corner of the screen.
"""

import argparse
import sys
import time

try:
    import numpy as np
    import pyautogui
    from PIL import ImageGrab
except ImportError:
    sys.exit("Missing dependency. Run:  pip install pyautogui pillow numpy")

pyautogui.FAILSAFE = True  # mouse in the top-left corner aborts


def parse_hex(text):
    text = text.strip().lstrip("#")
    if len(text) != 6:
        raise ValueError(f"expected a 6-digit hex color like #ff8800, got {text!r}")
    return tuple(int(text[i:i + 2], 16) for i in (0, 2, 4))


def to_hex(rgb):
    return "#{:02x}{:02x}{:02x}".format(*(int(c) for c in rgb))


def screen_scale():
    """Screenshots can be bigger than mouse coordinates (Retina / HiDPI displays)."""
    return ImageGrab.grab().width / pyautogui.size().width


def grab(left, top, right, bottom, scale):
    """RGB pixels of a box given in mouse coordinates (inclusive), as a numpy array."""
    shot = ImageGrab.grab()
    box = (
        max(int(left * scale), 0),
        max(int(top * scale), 0),
        min(int((right + 1) * scale), shot.width),
        min(int((bottom + 1) * scale), shot.height),
    )
    return np.asarray(shot.crop(box).convert("RGB"), dtype=np.int16), box


def find_color(left, top, right, bottom, target, tolerance, min_pixels, scale):
    """
    Look for the target color inside the box.
    Returns (x, y, color_seen) in mouse coordinates, or None if not found.
    """
    pixels, box = grab(left, top, right, bottom, scale)
    # A pixel matches when every channel is within `tolerance` of the target.
    diff = np.abs(pixels - np.array(target, dtype=np.int16)).max(axis=2)
    ys, xs = np.nonzero(diff <= tolerance)
    if len(xs) < min_pixels:
        return None
    # Click the matching pixel closest to the middle of all matches,
    # so we hit the icon itself rather than a stray edge pixel.
    cx, cy = xs.mean(), ys.mean()
    i = int(np.argmin((xs - cx) ** 2 + (ys - cy) ** 2))
    seen = pixels[ys[i], xs[i]]
    x = int((box[0] + xs[i]) / scale)
    y = int((box[1] + ys[i]) / scale)
    return x, y, seen


def sample_under_mouse(scale):
    x, y = pyautogui.position()
    pixels, _ = grab(x, y, x, y, scale)
    return pixels.reshape(-1, 3).mean(axis=0).astype(int)


def interactive_setup(scale):
    mode = input("Watch a single [p]oint or an [a]rea? (p/a, default p): ").strip().lower()

    if mode.startswith("a"):
        input("Hover the mouse over the TOP-LEFT corner of the area, then press Enter... ")
        x1, y1 = pyautogui.position()
        input("Hover the mouse over the BOTTOM-RIGHT corner of the area, then press Enter... ")
        x2, y2 = pyautogui.position()
        left, right = sorted((x1, x2))
        top, bottom = sorted((y1, y2))
        print(f"  Area: ({left}, {top}) to ({right}, {bottom})  [{right - left + 1}x{bottom - top + 1}]")
        area_args = f"--area {left} {top} {right} {bottom}"
    else:
        input("Hover the mouse over the icon, then press Enter... ")
        left, top = pyautogui.position()
        right, bottom = left, top
        print(f"  Position: x={left}, y={top}")
        area_args = f"--x {left} --y {top}"

    answer = input(
        "Type the target hex color (e.g. #00ff00), or hover over something that already\n"
        "has that color and press Enter to sample it: "
    ).strip()
    color = parse_hex(answer) if answer else tuple(sample_under_mouse(scale))
    print(f"  Target color: {to_hex(color)}")
    print(f"\nTip: next time skip setup with:\n"
          f"  python {sys.argv[0]} {area_args} --color \"{to_hex(color)}\"\n")
    return (left, top, right, bottom), color


def main():
    ap = argparse.ArgumentParser(description="Click an icon when it turns a given color.")
    ap.add_argument("--x", type=int, help="X position of the icon (single-point mode)")
    ap.add_argument("--y", type=int, help="Y position of the icon (single-point mode)")
    ap.add_argument("--area", type=int, nargs=4, metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"),
                    help="Watch this box instead of a single point; clicks wherever the color shows up")
    ap.add_argument("--color", help="Target color as hex, e.g. #00ff00")
    ap.add_argument("--tolerance", type=int, default=25,
                    help="How close the color must be, 0-255 per channel (default 25)")
    ap.add_argument("--radius", type=int, default=2,
                    help="Single-point mode: also check this many pixels around the point (default 2)")
    ap.add_argument("--min-pixels", type=int, default=0,
                    help="How many pixels must match before clicking "
                         "(default: 1 for a point, 5 for an area, to ignore specks)")
    ap.add_argument("--interval", type=float, default=0.1,
                    help="Seconds between checks (default 0.1)")
    ap.add_argument("--cooldown", type=float, default=1.0,
                    help="Minimum seconds between clicks (default 1.0)")
    ap.add_argument("--repeat", action="store_true",
                    help="Keep clicking while the color stays. Default: click once each time it appears")
    ap.add_argument("--max-clicks", type=int, default=0, help="Stop after this many clicks (0 = no limit)")
    ap.add_argument("--return-mouse", action="store_true",
                    help="Move the mouse back to where it was after clicking")
    args = ap.parse_args()

    scale = screen_scale()

    if args.color and args.area:
        left, top, right, bottom = args.area
        left, right = sorted((left, right))
        top, bottom = sorted((top, bottom))
        target = parse_hex(args.color)
    elif args.color and args.x is not None and args.y is not None:
        left = right = args.x
        top = bottom = args.y
        target = parse_hex(args.color)
    else:
        (left, top, right, bottom), target = interactive_setup(scale)

    is_area = (left, top) != (right, bottom)
    if not is_area:
        # Check a small square around the point so tiny misalignments don't matter.
        left, top = left - args.radius, top - args.radius
        right, bottom = right + args.radius, bottom + args.radius
        click_at = (args.x, args.y) if args.x is not None else ((left + right) // 2, (top + bottom) // 2)
    min_pixels = args.min_pixels or (5 if is_area else 1)

    where = f"area ({left}, {top})-({right}, {bottom})" if is_area else f"point {click_at}"
    print(f"Watching {where} for {to_hex(target)} ±{args.tolerance}. "
          f"Ctrl+C or move the mouse to the top-left corner to stop.")

    clicks = 0
    last_click = 0.0
    was_matching = False
    try:
        while True:
            found = find_color(left, top, right, bottom, target, args.tolerance, min_pixels, scale)
            matching = found is not None
            should_click = matching and (args.repeat or not was_matching)

            if should_click and time.time() - last_click >= args.cooldown:
                x, y, seen = found
                if not is_area:
                    x, y = click_at
                before = pyautogui.position()
                pyautogui.click(x, y)
                if args.return_mouse:
                    pyautogui.moveTo(*before)
                clicks += 1
                last_click = time.time()
                print(f"[{time.strftime('%H:%M:%S')}] Click #{clicks} at ({x}, {y}) (saw {to_hex(seen)})")
                if args.max_clicks and clicks >= args.max_clicks:
                    print("Reached max clicks, stopping.")
                    break

            was_matching = matching
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nStopped.")
    except pyautogui.FailSafeException:
        print("\nFail-safe triggered (mouse in corner). Stopped.")


if __name__ == "__main__":
    main()
