#!/usr/bin/env python3
"""
Color Clicker - a small window app that clicks an icon when it turns a given color.

Setup (once):
    pip install pyautogui pillow numpy

Run:
    double-click "Color Clicker.bat" (Windows), or: python color_clicker_app.py

1. "Select area..." and drag a box around where the icon shows up.
2. "Pick color..." and click on the color you're waiting for (or type a hex code).
3. Press Start (or F6). Press Pause (or F6 again) to stop.

The live view shows what it sees: pixels that match are highlighted, and it tells
you how close the nearest color is, so you can tell why it isn't clicking.
"""

import json
import os
import queue
import sys
import threading
import time
import tkinter as tk
from tkinter import messagebox, ttk

# Make screen pixels, mouse coordinates and window coordinates all the same
# on Windows with display scaling (125%, 150%...). Must happen before any window opens.
if sys.platform == "win32":
    import ctypes
    import ctypes.wintypes
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

try:
    import numpy as np
    import pyautogui
    from PIL import Image, ImageGrab, ImageTk
except ImportError:
    root = tk.Tk()
    root.withdraw()
    messagebox.showerror("Color Clicker", "Missing packages. In a terminal run:\n\n"
                                          "pip install pyautogui pillow numpy")
    sys.exit(1)

pyautogui.FAILSAFE = True  # slamming the mouse into the top-left corner pauses
pyautogui.PAUSE = 0

SETTINGS_FILE = os.path.join(os.path.expanduser("~"), ".color_clicker.json")
PREVIEW_W, PREVIEW_H = 380, 220


# ---------------------------------------------------------------- screen helpers

def parse_hex(text):
    text = text.strip().lstrip("#")
    if len(text) != 6:
        raise ValueError("expected 6 hex digits")
    return tuple(int(text[i:i + 2], 16) for i in (0, 2, 4))


def to_hex(rgb):
    return "#{:02x}{:02x}{:02x}".format(*(int(c) for c in rgb))


def capture():
    """
    Screenshot of the screen(s), plus the mouse position of its top-left pixel
    and how many screenshot pixels there are per mouse unit.
    """
    if sys.platform == "win32":
        # Every monitor. The desktop can start at negative coordinates when a
        # monitor sits left of / above the main one.
        metric = ctypes.windll.user32.GetSystemMetrics
        return ImageGrab.grab(all_screens=True), (metric(76), metric(77)), 1.0
    # macOS screenshots are bigger than mouse coordinates on Retina displays.
    shot = ImageGrab.grab()
    return shot, (0, 0), shot.width / pyautogui.size().width


def grab(left, top, right, bottom):
    """
    RGB pixels of a box given in mouse coordinates (inclusive), as a numpy array,
    plus a function that turns a pixel (column, row) back into mouse coordinates.
    """
    shot, (ox, oy), scale = capture()
    box = (
        max(int((left - ox) * scale), 0),
        max(int((top - oy) * scale), 0),
        min(int((right + 1 - ox) * scale), shot.width),
        min(int((bottom + 1 - oy) * scale), shot.height),
    )
    if box[0] >= box[2] or box[1] >= box[3]:
        raise ValueError("The area is off-screen. Select it again.")

    def to_mouse(col, row):
        return int(ox + (box[0] + col) / scale), int(oy + (box[1] + row) / scale)

    return np.asarray(shot.crop(box).convert("RGB"), dtype=np.int16), to_mouse


def do_click(x, y, hold, return_mouse):
    before = pyautogui.position()
    pyautogui.moveTo(x, y)
    time.sleep(0.03)
    # A short hold: many games ignore a click whose press and release arrive together.
    pyautogui.mouseDown()
    time.sleep(hold)
    pyautogui.mouseUp()
    if return_mouse:
        pyautogui.moveTo(*before)


# ---------------------------------------------------------------- full-screen picker

class ScreenPicker:
    """
    Covers every monitor with a frozen screenshot so you can drag an area
    (mode="area") or click a pixel (mode="color"). Esc cancels.
    """

    def __init__(self, root, mode, on_done):
        self.mode, self.on_done = mode, on_done
        self.shot, (self.ox, self.oy), self.scale = capture()
        w, h = int(self.shot.width / self.scale), int(self.shot.height / self.scale)
        shown = self.shot.convert("RGB").resize((w, h)) if self.scale != 1 else self.shot.convert("RGB")
        if mode == "area":
            shown = Image.blend(shown, Image.new("RGB", shown.size), 0.45)  # dim it

        self.top = tk.Toplevel(root)
        self.top.overrideredirect(True)
        self.top.attributes("-topmost", True)
        self.top.geometry(f"{w}x{h}+{self.ox}+{self.oy}")
        self.canvas = tk.Canvas(self.top, width=w, height=h, highlightthickness=0,
                                cursor="crosshair")
        self.canvas.pack()
        self.photo = ImageTk.PhotoImage(shown)
        self.canvas.create_image(0, 0, image=self.photo, anchor="nw")

        hint = ("Drag a box around where the icon appears.  Esc = cancel" if mode == "area"
                else "Click the color you want to wait for.  Esc = cancel")
        self.canvas.create_rectangle(10, 10, 20 + 8 * len(hint), 42, fill="black", outline="")
        self.canvas.create_text(18, 26, text=hint, fill="white", anchor="w", font=("Segoe UI", 12))

        self.start = None
        self.rect = self.label = self.loupe = None
        self.canvas.bind("<ButtonPress-1>", self.press)
        self.canvas.bind("<B1-Motion>", self.drag)
        self.canvas.bind("<ButtonRelease-1>", self.release)
        self.canvas.bind("<Motion>", self.motion)
        self.top.bind("<Escape>", lambda e: self.finish(None))
        self.top.focus_force()
        self.top.grab_set()

    def pixel(self, cx, cy):
        px = min(max(int(cx * self.scale), 0), self.shot.width - 1)
        py = min(max(int(cy * self.scale), 0), self.shot.height - 1)
        return self.shot.getpixel((px, py))[:3]

    def motion(self, e):
        if self.mode != "color":
            return
        # Magnifier next to the cursor so you can hit the exact pixel.
        r, zoom = 6, 10
        px, py = int(e.x * self.scale), int(e.y * self.scale)
        crop = self.shot.convert("RGB").crop((px - r, py - r, px + r + 1, py + r + 1))
        crop = crop.resize(((2 * r + 1) * zoom,) * 2, Image.NEAREST)
        self.loupe_photo = ImageTk.PhotoImage(crop)
        self.canvas.delete("loupe")
        x, y = e.x + 20, e.y + 20
        size = (2 * r + 1) * zoom
        self.canvas.create_image(x, y, image=self.loupe_photo, anchor="nw", tags="loupe")
        self.canvas.create_rectangle(x, y, x + size, y + size, outline="white", tags="loupe")
        c = x + r * zoom
        self.canvas.create_rectangle(c, y + r * zoom, c + zoom, y + (r + 1) * zoom,
                                     outline="red", width=2, tags="loupe")
        self.canvas.create_rectangle(x, y + size, x + size, y + size + 24, fill="black", tags="loupe")
        self.canvas.create_text(x + 6, y + size + 12, text=to_hex(self.pixel(e.x, e.y)),
                                fill="white", anchor="w", tags="loupe", font=("Consolas", 11))

    def press(self, e):
        if self.mode == "color":
            self.finish(self.pixel(e.x, e.y))
            return
        self.start = (e.x, e.y)
        self.rect = self.canvas.create_rectangle(e.x, e.y, e.x, e.y, outline="#00ff66", width=2)
        self.label = self.canvas.create_text(e.x, e.y - 12, fill="#00ff66", anchor="w",
                                             font=("Segoe UI", 11, "bold"))

    def drag(self, e):
        if self.mode == "area" and self.start:
            self.canvas.coords(self.rect, *self.start, e.x, e.y)
            w, h = abs(e.x - self.start[0]) + 1, abs(e.y - self.start[1]) + 1
            self.canvas.coords(self.label, min(e.x, self.start[0]), min(e.y, self.start[1]) - 12)
            self.canvas.itemconfigure(self.label, text=f"{w} x {h}")

    def release(self, e):
        if self.mode != "area" or not self.start:
            return
        (x1, y1), (x2, y2) = self.start, (e.x, e.y)
        if abs(x2 - x1) < 3 or abs(y2 - y1) < 3:
            self.start = None  # too small, probably a stray click; let them try again
            self.canvas.delete(self.rect, self.label)
            return
        left, right = sorted((x1, x2))
        top, bottom = sorted((y1, y2))
        self.finish((self.ox + left, self.oy + top, self.ox + right, self.oy + bottom))

    def finish(self, result):
        self.top.grab_release()
        self.top.destroy()
        self.on_done(result)


# ---------------------------------------------------------------- the app

class App:
    def __init__(self, root):
        self.root = root
        root.title("Color Clicker")
        root.resizable(False, False)

        self.area = None
        self.color = None
        self.running = False
        self.picking = False
        self.closing = False
        self.clicks = 0
        self.run_token = 0
        self.frame = None
        self.shown_frame = None
        self.hotkey_pressed = False
        self.logs = queue.Queue()

        self.tolerance = tk.IntVar(value=25)
        self.min_pixels = tk.IntVar(value=5)
        self.cooldown = tk.DoubleVar(value=1.0)
        self.interval = tk.DoubleVar(value=0.1)
        self.hold_ms = tk.IntVar(value=50)
        self.repeat = tk.BooleanVar(value=False)
        self.return_mouse = tk.BooleanVar(value=False)
        self.on_top = tk.BooleanVar(value=False)
        self.load_settings()

        self.build_ui()
        self.update_cfg()
        threading.Thread(target=self.worker, daemon=True).start()
        self.start_hotkey()
        root.protocol("WM_DELETE_WINDOW", self.close)
        self.log("Ready. Select an area and a color, then press Start (or F6).")
        self.tick()

    # ---- layout

    def build_ui(self):
        pad = {"padx": 8, "pady": 4}
        main = ttk.Frame(self.root, padding=10)
        main.grid()

        setup = ttk.LabelFrame(main, text="What to watch", padding=8)
        setup.grid(row=0, column=0, sticky="nsew", **pad)

        ttk.Button(setup, text="Select area...", command=lambda: self.pick("area")).grid(row=0, column=0, sticky="ew")
        self.area_label = ttk.Label(setup, width=34)
        self.area_label.grid(row=0, column=1, columnspan=2, sticky="w", padx=8)

        ttk.Button(setup, text="Pick color...", command=lambda: self.pick("color")).grid(row=1, column=0, sticky="ew", pady=(6, 0))
        self.swatch = tk.Label(setup, width=4, relief="solid", bd=1)
        self.swatch.grid(row=1, column=1, sticky="w", padx=8, pady=(6, 0))
        self.hex_entry = ttk.Entry(setup, width=10)
        self.hex_entry.grid(row=1, column=2, sticky="w", pady=(6, 0))
        self.hex_entry.bind("<Return>", self.hex_typed)
        self.hex_entry.bind("<FocusOut>", self.hex_typed)

        opts = ttk.LabelFrame(main, text="Settings", padding=8)
        opts.grid(row=1, column=0, sticky="nsew", **pad)
        ttk.Label(opts, text="Color tolerance").grid(row=0, column=0, sticky="w")
        self.tol_label = ttk.Label(opts, width=4)
        ttk.Scale(opts, from_=0, to=120, variable=self.tolerance, length=170,
                  command=lambda v: self.tolerance.set(round(float(v)))).grid(row=0, column=1, columnspan=2, sticky="w")
        self.tol_label.grid(row=0, column=3, sticky="w")

        rows = [("Min matching pixels", self.min_pixels, 1, 10000, 1),
                ("Seconds between clicks", self.cooldown, 0, 60, 0.1),
                ("Seconds between checks", self.interval, 0.02, 5, 0.05),
                ("Click hold (ms)", self.hold_ms, 0, 1000, 10)]
        for i, (text, var, lo, hi, step) in enumerate(rows, start=1):
            ttk.Label(opts, text=text).grid(row=i, column=0, sticky="w", pady=2)
            ttk.Spinbox(opts, from_=lo, to=hi, increment=step, textvariable=var, width=8).grid(row=i, column=1, sticky="w")
        ttk.Checkbutton(opts, text="Keep clicking while the color stays", variable=self.repeat).grid(row=5, column=0, columnspan=4, sticky="w")
        ttk.Checkbutton(opts, text="Put the mouse back after each click", variable=self.return_mouse).grid(row=6, column=0, columnspan=4, sticky="w")
        ttk.Checkbutton(opts, text="Keep this window on top", variable=self.on_top,
                        command=lambda: self.root.attributes("-topmost", self.on_top.get())).grid(row=7, column=0, columnspan=4, sticky="w")

        controls = ttk.Frame(main)
        controls.grid(row=2, column=0, sticky="ew", **pad)
        style = ttk.Style()
        style.configure("Big.TButton", font=("Segoe UI", 13, "bold"), padding=8)
        self.start_btn = ttk.Button(controls, text="Start  (F6)", style="Big.TButton", command=self.toggle)
        self.start_btn.pack(side="left", fill="x", expand=True)
        ttk.Button(controls, text="Test click", command=self.test_click).pack(side="left", padx=(8, 0), ipady=8)

        view = ttk.LabelFrame(main, text="Live view", padding=8)
        view.grid(row=0, column=1, rowspan=3, sticky="nsew", **pad)
        self.state_label = tk.Label(view, font=("Segoe UI", 14, "bold"), anchor="w")
        self.state_label.pack(fill="x")
        self.canvas = tk.Canvas(view, width=PREVIEW_W, height=PREVIEW_H, bg="#222", highlightthickness=0)
        self.canvas.pack(pady=6)
        self.found_label = ttk.Label(view, anchor="w", font=("Segoe UI", 10, "bold"))
        self.found_label.pack(fill="x")
        self.detail_label = ttk.Label(view, anchor="w", justify="left", wraplength=PREVIEW_W)
        self.detail_label.pack(fill="x")

        logf = ttk.LabelFrame(main, text="Log", padding=8)
        logf.grid(row=3, column=0, columnspan=2, sticky="nsew", **pad)
        self.log_text = tk.Text(logf, height=8, width=90, state="disabled", font=("Consolas", 9))
        self.log_text.pack(fill="both")

        self.root.bind("<F6>", lambda e: self.toggle())
        self.refresh_setup_labels()

    def refresh_setup_labels(self):
        if self.area:
            l, t, r, b = self.area
            self.area_label.configure(text=f"({l}, {t}) to ({r}, {b})   {r - l + 1} x {b - t + 1}")
        else:
            self.area_label.configure(text="not set")
        if self.color:
            self.swatch.configure(bg=to_hex(self.color))
            self.hex_entry.delete(0, "end")
            self.hex_entry.insert(0, to_hex(self.color))
        else:
            self.swatch.configure(bg=self.root.cget("bg"))

    # ---- actions

    def pick(self, mode):
        if self.picking:
            return
        was_running = self.running
        self.set_running(False)
        self.picking = True
        self.root.withdraw()
        self.root.update()
        time.sleep(0.25)  # let the window actually disappear before the screenshot

        def done(result):
            self.picking = False
            self.root.deiconify()
            if result is not None:
                if mode == "area":
                    self.area = result
                    self.log(f"Area set to {result}.")
                else:
                    self.color = result
                    self.log(f"Color set to {to_hex(result)}.")
                self.refresh_setup_labels()
                self.save_settings()
            if was_running:
                self.set_running(True)

        try:
            ScreenPicker(self.root, mode, done)
        except Exception as e:
            done(None)
            self.log(f"Couldn't take a screenshot: {e}")

    def hex_typed(self, _event=None):
        text = self.hex_entry.get()
        try:
            color = parse_hex(text)
        except ValueError:
            if text.strip():
                self.log(f"'{text}' isn't a hex color like #3ec46d.")
            self.refresh_setup_labels()
            return
        if color != self.color:
            self.color = color
            self.log(f"Color set to {to_hex(color)}.")
            self.save_settings()
        self.refresh_setup_labels()

    def toggle(self):
        self.set_running(not self.running)

    def set_running(self, on):
        if on and (not self.area or not self.color):
            messagebox.showinfo("Color Clicker", "Select an area and a color first.")
            return
        if on and not self.running:
            self.run_token += 1  # so it clicks right away if the color is already showing
            self.log("Started.")
            self.save_settings()
        elif not on and self.running:
            self.log("Paused.")
        self.running = on
        self.start_btn.configure(text="Pause  (F6)" if on else "Start  (F6)")

    def test_click(self):
        if not self.area:
            messagebox.showinfo("Color Clicker", "Select an area first.")
            return
        frame = self.frame
        if frame and frame.get("target"):
            x, y = frame["target"]
        else:
            l, t, r, b = self.area
            x, y = (l + r) // 2, (t + b) // 2
        try:
            do_click(x, y, self.cfg["hold"], self.cfg["return_mouse"])
            self.log(f"Test click at ({x}, {y}). If nothing happened there, see the README's troubleshooting.")
        except pyautogui.FailSafeException:
            self.log("Fail-safe: mouse is in the top-left corner.")

    def log(self, msg):
        self.logs.put(f"[{time.strftime('%H:%M:%S')}] {msg}")

    # ---- background watcher

    def update_cfg(self):
        def num(var, default):
            try:
                return var.get()
            except (tk.TclError, ValueError):
                return default  # half-typed number in a spinbox
        self.cfg = {
            "area": self.area,
            "color": self.color,
            "tolerance": num(self.tolerance, 25),
            "min_pixels": max(1, num(self.min_pixels, 5)),
            "cooldown": max(0.0, num(self.cooldown, 1.0)),
            "interval": max(0.02, num(self.interval, 0.1)),
            "hold": max(0, num(self.hold_ms, 50)) / 1000,
            "repeat": self.repeat.get(),
            "return_mouse": self.return_mouse.get(),
        }

    def worker(self):
        was_matching = False
        last_click = 0.0
        seen_token = None
        while not self.closing:
            cfg = self.cfg
            if not cfg["area"] or not cfg["color"] or self.picking:
                time.sleep(0.2)
                continue
            try:
                pixels, to_mouse = grab(*cfg["area"])
            except Exception as e:
                self.frame = {"error": str(e)}
                time.sleep(1)
                continue

            target_color = np.array(cfg["color"], dtype=np.int16)
            diff = np.abs(pixels - target_color).max(axis=2)
            mask = diff <= cfg["tolerance"]
            ys, xs = np.nonzero(mask)
            found = len(xs) >= cfg["min_pixels"]
            best = np.unravel_index(int(np.argmin(diff)), diff.shape)

            pick = None
            if found:
                # The matching pixel closest to the middle of all matches.
                cx, cy = xs.mean(), ys.mean()
                i = int(np.argmin((xs - cx) ** 2 + (ys - cy) ** 2))
                pick = (int(xs[i]), int(ys[i]))

            if seen_token != self.run_token:
                seen_token, was_matching = self.run_token, False

            if (self.running and found and (cfg["repeat"] or not was_matching)
                    and time.time() - last_click >= cfg["cooldown"]):
                x, y = to_mouse(*pick)
                try:
                    do_click(x, y, cfg["hold"], cfg["return_mouse"])
                    self.clicks += 1
                    last_click = time.time()
                    self.log(f"Click #{self.clicks} at ({x}, {y}) - saw {to_hex(pixels[pick[1], pick[0]])}")
                except pyautogui.FailSafeException:
                    self.running = False
                    self.log("Fail-safe: mouse hit the top-left corner, paused.")
            was_matching = found

            # Picture for the live view: matching pixels painted bright.
            h, w = diff.shape
            shown = pixels.astype(np.uint8).copy()
            paint = (255, 0, 255) if np.abs(target_color - (255, 0, 255)).max() > 80 else (0, 255, 255)
            shown[mask] = paint
            f = min(PREVIEW_W / w, PREVIEW_H / h)
            if f >= 1:
                f = int(f)
            img = Image.fromarray(shown).resize((max(1, int(w * f)), max(1, int(h * f))), Image.NEAREST)

            self.frame = {
                "image": img, "scale": f, "pick": pick, "found": found,
                "count": len(xs), "best_color": pixels[best], "best_dist": int(diff[best]),
                "target": to_mouse(*pick) if pick else None, "paint": paint,
            }
            time.sleep(cfg["interval"])

    # ---- UI refresh (main thread)

    def tick(self):
        if self.closing:
            return
        self.update_cfg()
        self.tol_label.configure(text=str(self.tolerance.get()))

        while not self.logs.empty():
            line = self.logs.get()
            self.log_text.configure(state="normal")
            self.log_text.insert("end", line + "\n")
            self.log_text.see("end")
            self.log_text.configure(state="disabled")

        if self.hotkey_pressed:
            self.hotkey_pressed = False
            self.toggle()
        if self.start_btn.cget("text").startswith("Pause") != self.running:  # paused by fail-safe
            self.start_btn.configure(text="Pause  (F6)" if self.running else "Start  (F6)")

        clicks = f"{self.clicks} click" + ("" if self.clicks == 1 else "s")
        self.state_label.configure(
            text=f"RUNNING   -   {clicks}" if self.running else f"PAUSED   -   {clicks}",
            fg="#1a8f3c" if self.running else "#b03030")

        frame = self.frame
        if frame is not self.shown_frame:
            self.shown_frame = frame
            self.draw_frame(frame)
        self.root.after(100, self.tick)

    def draw_frame(self, frame):
        self.canvas.delete("all")
        if frame is None:
            self.canvas.create_text(PREVIEW_W // 2, PREVIEW_H // 2, fill="#aaa",
                                    text="Select an area and a color")
            self.found_label.configure(text="")
            self.detail_label.configure(text="")
            return
        if "error" in frame:
            self.found_label.configure(text=frame["error"], foreground="#b03030")
            self.detail_label.configure(text="")
            return

        self.preview_photo = ImageTk.PhotoImage(frame["image"])
        iw, ih = frame["image"].size
        ox, oy = (PREVIEW_W - iw) // 2, (PREVIEW_H - ih) // 2
        self.canvas.create_image(ox, oy, image=self.preview_photo, anchor="nw")
        if frame["pick"]:
            f = frame["scale"]
            x = ox + (frame["pick"][0] + 0.5) * f
            y = oy + (frame["pick"][1] + 0.5) * f
            for color, width in (("black", 4), ("white", 2)):
                self.canvas.create_line(x - 12, y, x + 12, y, fill=color, width=width)
                self.canvas.create_line(x, y - 12, x, y + 12, fill=color, width=width)

        tol = self.cfg["tolerance"]
        if frame["found"]:
            self.found_label.configure(text=f"COLOR FOUND  ({frame['count']} matching pixels)",
                                       foreground="#1a8f3c")
            self.detail_label.configure(text=f"It clicks at the crosshair: {frame['target']}. "
                                             f"{'Matching pixels are painted bright.' if frame['count'] else ''}")
        else:
            dist = frame["best_dist"]
            if frame["count"]:
                why = (f"Only {frame['count']} pixels match, it needs {self.cfg['min_pixels']}. "
                       f"Lower 'Min matching pixels' or select a tighter area.")
            elif dist <= tol + 40:
                why = (f"Closest color here is {to_hex(frame['best_color'])}, off by {dist} "
                       f"(tolerance is {tol}). If the icon is showing the color right now, "
                       f"raise tolerance to about {dist + 5}.")
            else:
                why = (f"Closest color here is {to_hex(frame['best_color'])}, off by {dist} "
                       f"(tolerance is {tol}). Nothing close to the target is in the area.")
            self.found_label.configure(text="Color not found", foreground="#666")
            self.detail_label.configure(text=why)

    # ---- F6 works even while a game has focus (Windows)

    def start_hotkey(self):
        if sys.platform != "win32":
            return

        def listen():
            user32 = ctypes.windll.user32
            if not user32.RegisterHotKey(None, 1, 0x4000, 0x75):  # MOD_NOREPEAT, F6
                self.log("F6 is taken by another app, so it only works while this window is focused.")
                return
            msg = ctypes.wintypes.MSG()
            while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
                if msg.message == 0x0312:  # WM_HOTKEY
                    self.hotkey_pressed = True

        threading.Thread(target=listen, daemon=True).start()
        self.root.unbind("<F6>")  # the global hotkey already covers the window

    # ---- settings

    def load_settings(self):
        try:
            with open(SETTINGS_FILE) as fh:
                s = json.load(fh)
        except (OSError, ValueError):
            return
        self.area = tuple(s["area"]) if s.get("area") else None
        self.color = tuple(s["color"]) if s.get("color") else None
        for key, var in self.setting_vars().items():
            if key in s:
                try:
                    var.set(s[key])
                except (tk.TclError, ValueError):
                    pass

    def save_settings(self):
        s = {"area": self.area, "color": self.color}
        for key, var in self.setting_vars().items():
            try:
                s[key] = var.get()
            except (tk.TclError, ValueError):
                pass
        try:
            with open(SETTINGS_FILE, "w") as fh:
                json.dump(s, fh)
        except OSError:
            pass

    def setting_vars(self):
        return {"tolerance": self.tolerance, "min_pixels": self.min_pixels,
                "cooldown": self.cooldown, "interval": self.interval, "hold_ms": self.hold_ms,
                "repeat": self.repeat, "return_mouse": self.return_mouse}

    def close(self):
        self.closing = True
        self.save_settings()
        self.root.destroy()


def main():
    root = tk.Tk()

    # Started by double-click there's no console, so show errors in a popup instead.
    def report(*exc):
        import traceback
        messagebox.showerror("Color Clicker - error", "".join(traceback.format_exception(*exc))[-1500:])
    root.report_callback_exception = report
    try:
        App(root)
    except Exception:
        report(*sys.exc_info())
        raise
    root.mainloop()


if __name__ == "__main__":
    main()
