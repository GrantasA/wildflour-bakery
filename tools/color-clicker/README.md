# Color Clicker

Clicks an icon on your screen when it turns a particular color.

It can watch:

- **a single point**: the icon is always in the same place, or
- **an area**: the icon can show up anywhere inside a box you choose, and it clicks wherever the color appears.

## Setup (once)

```
pip install pyautogui pillow numpy
```

- **Mac:** give your terminal (Terminal, iTerm, VS Code…) permission under
  System Settings → Privacy & Security → **Accessibility** and **Screen Recording**,
  then restart the terminal.
- **Linux:** you also need tkinter (`sudo apt install python3-tk`); pyautogui quits on startup without it.
- **Windows:** nothing extra.

## Use it

```
python color_clicker.py
```

1. Choose `p` (single point) or `a` (area).
2. **Point:** hover over the icon and press Enter.
   **Area:** hover over the top-left corner of the area and press Enter, then over the bottom-right corner and press Enter.
3. Type the target hex color (e.g. `#00ff00`). You can also hover over something that already has the color and press Enter to sample it.

At the end of setup it prints a command you can reuse to skip setup next time:

```
python color_clicker.py --x 812 --y 440 --color "#3ec46d"
python color_clicker.py --area 600 300 1000 600 --color "#3ec46d"
```

**To stop it:** press Ctrl+C, or move the mouse into the top-left corner of the screen.

## Options

| Option | Default | What it does |
|---|---|---|
| `--tolerance N` | 25 | How close the color has to be (0–255 per channel). Raise it if it never clicks, lower it if it clicks on the wrong color. |
| `--min-pixels N` | 1 for a point, 5 for an area | How many pixels must match before it clicks, so stray specks of the color are ignored. |
| `--radius N` | 2 | Point mode: also check pixels this far around the point. |
| `--repeat` | off | Keep clicking while the color stays. By default it clicks once each time the color appears. |
| `--cooldown S` | 1.0 | Minimum seconds between clicks. |
| `--interval S` | 0.1 | Seconds between checks. |
| `--max-clicks N` | 0 (no limit) | Stop after N clicks. |
| `--return-mouse` | off | Put the cursor back where it was after each click. |

Note: some games with anti-cheat block or ban simulated clicks. Check the rules first.
