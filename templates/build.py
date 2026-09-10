#!/usr/bin/env python3
"""Turn a small JSON config into a finished, self-contained one-page website.

Usage:
    python3 build.py clients/kirpykla.json
    python3 build.py --all

Each config describes one business. The output is a single index.html with no
build step, no framework and no external assets except Google Fonts, so it can
be dropped onto any host (GitHub Pages, Netlify, a client's own hosting).
"""

from __future__ import annotations

import html
import json
import shutil
import sys
from pathlib import Path
from string import Template

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"

# Sensible fallbacks so a minimal config still produces a complete page.
DEFAULTS = {
    "lang": "lt",
    "fonts": {"display": "Playfair Display", "body": "Inter", "display_fallback": "Georgia, serif"},
    "palette": {
        "bg": "#faf5ec",
        "bg_alt": "#f2ead9",
        "panel": "#fffdf8",
        "ink": "#3a3128",
        "ink_soft": "#6b5f52",
        "accent": "#c1663b",
        "accent_dark": "#a5502a",
        "accent_tint": "#f3ddce",
        "border": "#e5d9c3",
    },
    "sections": ["hero", "about", "services", "hours", "contact"],
    "labels": {
        "services": "Paslaugos",
        "about": "Apie mus",
        "hours": "Darbo laikas",
        "contact": "Kontaktai",
        "closed": "Nedirbame",
        "cta": "Susisiekti",
        "address": "Adresas",
        "phone": "Telefonas",
        "email": "El. paštas",
        "name_field": "Vardas",
        "message_field": "Žinutė",
        "send": "Siųsti",
        "sent": "Dėkojame! Susisieksime su jumis.",
        "error": "Nepavyko išsiųsti. Parašykite mums el. paštu.",
    },
    "days": {
        "mon": "Pirmadienis",
        "tue": "Antradienis",
        "wed": "Trečiadienis",
        "thu": "Ketvirtadienis",
        "fri": "Penktadienis",
        "sat": "Šeštadienis",
        "sun": "Sekmadienis",
    },
}

DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

# schema.org types, so each generated site ships valid LocalBusiness markup.
SCHEMA_TYPES = {
    "bakery": "Bakery",
    "cafe": "CafeOrCoffeeShop",
    "restaurant": "Restaurant",
    "salon": "BeautySalon",
    "barber": "HairSalon",
    "auto": "AutoRepair",
    "clinic": "Dentist",
    "gym": "SportsActivityLocation",
    "florist": "Florist",
    "other": "LocalBusiness",
}


def merge(base: dict, extra: dict) -> dict:
    """Deep-merge extra into a copy of base, so configs only state differences."""
    out = dict(base)
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = merge(out[key], value)
        else:
            out[key] = value
    return out


def e(value) -> str:
    """Escape a value for use in HTML text or an attribute."""
    return html.escape(str(value if value is not None else ""), quote=True)


CSS = Template("""
:root {
  --bg: $bg;
  --bg-alt: $bg_alt;
  --panel: $panel;
  --ink: $ink;
  --ink-soft: $ink_soft;
  --accent: $accent;
  --accent-dark: $accent_dark;
  --accent-tint: $accent_tint;
  --border: $border;
  --shadow-sm: 0 2px 10px rgba(20, 14, 8, 0.06);
  --shadow-md: 0 14px 34px rgba(20, 14, 8, 0.10);
  --radius: 14px;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }

body {
  font-family: '$body_font', system-ui, -apple-system, sans-serif;
  background: var(--bg);
  color: var(--ink);
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}

/* Faint paper grain, the same trick that makes flat palettes feel printed. */
body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  opacity: 0.045;
  mix-blend-mode: multiply;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}

h1, h2, h3 { font-family: '$display_font', $display_fallback; font-weight: 600; line-height: 1.2; }
h1 { font-size: clamp(2.1rem, 6vw, 3.6rem); }
h2 { font-size: clamp(1.6rem, 4vw, 2.3rem); }
a { color: inherit; }

.container { width: 100%; max-width: 1080px; margin: 0 auto; padding: 0 20px; }
section { padding: clamp(48px, 9vw, 96px) 0; }
.section-title { text-align: center; margin-bottom: 0.5em; }
.section-intro { text-align: center; color: var(--ink-soft); max-width: 44ch; margin: 0 auto clamp(28px, 5vw, 52px); }

/* Header */
.nav {
  position: sticky; top: 0; z-index: 50;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
}
.nav-inner { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 20px; max-width: 1080px; margin: 0 auto; }
.logo { font-family: '$display_font', $display_fallback; font-size: 1.25rem; font-weight: 600; text-decoration: none; }
.nav-links { display: flex; gap: 22px; list-style: none; }
.nav-links a { text-decoration: none; color: var(--ink-soft); font-size: 0.94rem; }
.nav-links a:hover { color: var(--accent); }
.nav-phone { display: inline-flex; align-items: center; gap: 7px; text-decoration: none; font-weight: 600; color: var(--accent-dark); white-space: nowrap; }
@media (max-width: 760px) { .nav-links { display: none; } }

/* Buttons */
.btn {
  display: inline-block; padding: 13px 26px; border-radius: 999px;
  background: var(--accent); color: #fff; text-decoration: none;
  font-weight: 600; border: 1px solid var(--accent);
  transition: background 0.18s ease, transform 0.18s ease;
}
.btn:hover { background: var(--accent-dark); transform: translateY(-1px); }
.btn-outline { background: transparent; color: var(--accent-dark); }
.btn-outline:hover { background: var(--accent-tint); }

/* Hero */
.hero { padding-top: clamp(40px, 7vw, 72px); }
.hero-grid { display: grid; grid-template-columns: 1.05fr 1fr; gap: clamp(28px, 5vw, 60px); align-items: center; }
.hero-eyebrow { text-transform: uppercase; letter-spacing: 0.16em; font-size: 0.76rem; color: var(--accent-dark); font-weight: 600; margin-bottom: 14px; }
.hero p.lead { color: var(--ink-soft); font-size: 1.08rem; margin: 18px 0 28px; max-width: 46ch; }
.hero-actions { display: flex; flex-wrap: wrap; gap: 12px; }
.hero-media { border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow-md); aspect-ratio: 4 / 5; }
.hero-media img { width: 100%; height: 100%; object-fit: cover; display: block; }
@media (max-width: 820px) { .hero-grid { grid-template-columns: 1fr; } .hero-media { aspect-ratio: 16 / 10; } }

/* Placeholder art, used until a real photo is dropped in. */
.ph { width: 100%; height: 100%; display: grid; place-items: center;
  background: linear-gradient(145deg, var(--accent-tint), var(--bg-alt));
  color: var(--accent-dark); font-family: '$display_font', $display_fallback; font-size: 2.4rem; }

/* About */
.about { background: var(--bg-alt); }
.about-grid { display: grid; grid-template-columns: 1fr 1fr; gap: clamp(28px, 5vw, 56px); align-items: center; }
.about-grid p + p { margin-top: 1em; }
.about-media { border-radius: var(--radius); overflow: hidden; aspect-ratio: 1 / 1; box-shadow: var(--shadow-sm); }
.about-media img { width: 100%; height: 100%; object-fit: cover; display: block; }
@media (max-width: 760px) { .about-grid { grid-template-columns: 1fr; } }

/* Services */
.services-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px; }
.service {
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 22px 24px; box-shadow: var(--shadow-sm); display: flex; flex-direction: column; gap: 8px;
}
.service-head { display: flex; justify-content: space-between; align-items: baseline; gap: 14px; }
.service-name { font-family: '$display_font', $display_fallback; font-size: 1.16rem; font-weight: 600; }
.service-price { font-weight: 700; color: var(--accent-dark); white-space: nowrap; }
.service-desc { color: var(--ink-soft); font-size: 0.95rem; }

/* Hours + contact */
.contact { background: var(--bg-alt); }
.contact-grid { display: grid; grid-template-columns: 1fr 1fr; gap: clamp(24px, 4vw, 44px); align-items: start; }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: clamp(22px, 3vw, 32px); box-shadow: var(--shadow-sm); }
.hours-row { display: flex; justify-content: space-between; gap: 16px; padding: 7px 0; border-bottom: 1px dashed var(--border); }
.hours-row:last-child { border-bottom: 0; }
.hours-row.today { font-weight: 700; color: var(--accent-dark); }
.info-block { margin-bottom: 18px; }
.info-block:last-child { margin-bottom: 0; }
.label { text-transform: uppercase; letter-spacing: 0.12em; font-size: 0.72rem; color: var(--ink-soft); font-weight: 600; display: block; margin-bottom: 3px; }
.info-block a { text-decoration: none; font-weight: 500; }
.info-block a:hover { color: var(--accent); }

form { display: flex; flex-direction: column; gap: 14px; }
.form-row { display: flex; flex-direction: column; gap: 6px; }
label { font-size: 0.88rem; font-weight: 600; }
input, textarea {
  font: inherit; padding: 11px 13px; border: 1px solid var(--border);
  border-radius: 10px; background: var(--bg); color: var(--ink); width: 100%;
}
input:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
textarea { resize: vertical; min-height: 110px; }
button[type="submit"] { font: inherit; cursor: pointer; }
.form-status { font-size: 0.9rem; min-height: 1.3em; }
.map-embed { margin-top: 20px; border-radius: var(--radius); overflow: hidden; border: 1px solid var(--border); }
.map-embed iframe { width: 100%; height: 220px; border: 0; display: block; }
@media (max-width: 760px) { .contact-grid { grid-template-columns: 1fr; } }

footer { padding: 34px 0; border-top: 1px solid var(--border); text-align: center; color: var(--ink-soft); font-size: 0.9rem; }
footer a { text-decoration: none; }

@media (prefers-reduced-motion: reduce) { * { transition: none !important; } html { scroll-behavior: auto; } }
""")


def photo(cfg: dict, key: str, fallback_letter: str) -> str:
    """An <img> when a photo is configured, otherwise tasteful placeholder art."""
    src = (cfg.get("photos") or {}).get(key)

    if src:
        return f'<img src="{e(src)}" alt="{e(cfg["name"])}" loading="lazy" />'

    return f'<div class="ph" aria-hidden="true">{e(fallback_letter)}</div>'


def nav(cfg: dict) -> str:
    labels, links = cfg["labels"], []

    for name in cfg["sections"]:
        if name in ("about", "services", "hours", "contact") and labels.get(name):
            links.append(f'<li><a href="#{name}">{e(labels[name])}</a></li>')

    phone = cfg.get("phone", "")
    phone_link = (
        f'<a class="nav-phone" href="tel:{e(phone.replace(" ", ""))}">{e(phone)}</a>'
        if phone else ""
    )

    return f"""<header class="nav">
  <div class="nav-inner">
    <a class="logo" href="#">{e(cfg['name'])}</a>
    <nav aria-label="Pagrindinis meniu"><ul class="nav-links">{''.join(links)}</ul></nav>
    {phone_link}
  </div>
</header>"""


def hero(cfg: dict) -> str:
    actions = [f'<a class="btn" href="#contact">{e(cfg["labels"]["cta"])}</a>']

    if "services" in cfg["sections"]:
        actions.append(
            f'<a class="btn btn-outline" href="#services">{e(cfg["labels"]["services"])}</a>'
        )

    eyebrow = (
        f'<p class="hero-eyebrow">{e(cfg["eyebrow"])}</p>' if cfg.get("eyebrow") else ""
    )

    return f"""<section class="hero">
  <div class="container hero-grid">
    <div>
      {eyebrow}
      <h1>{e(cfg.get('headline', cfg['name']))}</h1>
      <p class="lead">{e(cfg.get('tagline', ''))}</p>
      <div class="hero-actions">{''.join(actions)}</div>
    </div>
    <div class="hero-media">{photo(cfg, 'hero', cfg['name'][:1])}</div>
  </div>
</section>"""


def about(cfg: dict) -> str:
    paragraphs = "".join(f"<p>{e(p)}</p>" for p in cfg.get("about", []))

    return f"""<section class="about" id="about">
  <div class="container about-grid">
    <div>
      <h2>{e(cfg['labels']['about'])}</h2>
      {paragraphs}
    </div>
    <div class="about-media">{photo(cfg, 'about', cfg['name'][:1])}</div>
  </div>
</section>"""


def services(cfg: dict) -> str:
    cards = []

    for item in cfg.get("services", []):
        price = (
            f'<span class="service-price">{e(item["price"])}</span>'
            if item.get("price") else ""
        )
        desc = (
            f'<p class="service-desc">{e(item["desc"])}</p>' if item.get("desc") else ""
        )
        cards.append(
            f'<article class="service"><div class="service-head">'
            f'<span class="service-name">{e(item["name"])}</span>{price}</div>{desc}</article>'
        )

    intro = (
        f'<p class="section-intro">{e(cfg["services_intro"])}</p>'
        if cfg.get("services_intro") else ""
    )

    return f"""<section id="services">
  <div class="container">
    <h2 class="section-title">{e(cfg['labels']['services'])}</h2>
    {intro}
    <div class="services-grid">{''.join(cards)}</div>
  </div>
</section>"""


def hours_rows(cfg: dict) -> str:
    rows = []

    for day in DAY_ORDER:
        value = (cfg.get("hours") or {}).get(day)
        text = value if value else cfg["labels"]["closed"]
        rows.append(
            f'<div class="hours-row" data-day="{day}">'
            f'<span>{e(cfg["days"][day])}</span><span>{e(text)}</span></div>'
        )

    return "".join(rows)


def contact(cfg: dict) -> str:
    info = []

    if cfg.get("address"):
        info.append(
            f'<div class="info-block"><span class="label">{e(cfg["labels"]["address"])}</span>'
            f'{e(cfg["address"])}</div>'
        )

    if cfg.get("phone"):
        info.append(
            f'<div class="info-block"><span class="label">{e(cfg["labels"]["phone"])}</span>'
            f'<a href="tel:{e(cfg["phone"].replace(" ", ""))}">{e(cfg["phone"])}</a></div>'
        )

    if cfg.get("email"):
        info.append(
            f'<div class="info-block"><span class="label">{e(cfg["labels"]["email"])}</span>'
            f'<a href="mailto:{e(cfg["email"])}">{e(cfg["email"])}</a></div>'
        )

    map_embed = ""

    if cfg.get("map_query"):
        query = cfg["map_query"].replace(" ", "+")
        map_embed = (
            f'<div class="map-embed"><iframe title="Žemėlapis" loading="lazy" '
            f'referrerpolicy="no-referrer-when-downgrade" '
            f'src="https://maps.google.com/maps?q={e(query)}&output=embed"></iframe></div>'
        )

    # Formspree needs no backend; swap the id once the client has an inbox.
    endpoint = cfg.get("form_endpoint", "")
    form_attrs = f'action="{e(endpoint)}" method="POST"' if endpoint else ""

    return f"""<section class="contact" id="contact">
  <div class="container">
    <h2 class="section-title">{e(cfg['labels']['contact'])}</h2>
    <div class="contact-grid">
      <div class="panel">
        <h3 style="margin-bottom:14px">{e(cfg['labels']['hours'])}</h3>
        {hours_rows(cfg)}
        <div style="margin-top:22px">{''.join(info)}</div>
        {map_embed}
      </div>
      <div class="panel">
        <form id="contactForm" {form_attrs}>
          <div class="form-row">
            <label for="cf-name">{e(cfg['labels']['name_field'])}</label>
            <input id="cf-name" name="name" type="text" required autocomplete="name" />
          </div>
          <div class="form-row">
            <label for="cf-email">{e(cfg['labels']['email'])}</label>
            <input id="cf-email" name="email" type="email" required autocomplete="email" />
          </div>
          <div class="form-row">
            <label for="cf-msg">{e(cfg['labels']['message_field'])}</label>
            <textarea id="cf-msg" name="message" required></textarea>
          </div>
          <button class="btn" type="submit">{e(cfg['labels']['send'])}</button>
          <p class="form-status" role="status" aria-live="polite"></p>
        </form>
      </div>
    </div>
  </div>
</section>"""


def json_ld(cfg: dict) -> str:
    """LocalBusiness markup, so the site is eligible for Google rich results."""
    node = {
        "@context": "https://schema.org",
        "@type": SCHEMA_TYPES.get(cfg.get("kind", "other"), "LocalBusiness"),
        "name": cfg["name"],
    }

    for key, prop in (("phone", "telephone"), ("email", "email"), ("url", "url")):
        if cfg.get(key):
            node[prop] = cfg[key]

    if cfg.get("address"):
        node["address"] = {"@type": "PostalAddress", "streetAddress": cfg["address"]}

    spec = []
    names = {
        "mon": "Monday", "tue": "Tuesday", "wed": "Wednesday", "thu": "Thursday",
        "fri": "Friday", "sat": "Saturday", "sun": "Sunday",
    }

    for day, value in (cfg.get("hours") or {}).items():
        if not value or "-" not in value:
            continue

        opens, closes = [part.strip() for part in value.split("-", 1)]
        spec.append({
            "@type": "OpeningHoursSpecification",
            "dayOfWeek": f"https://schema.org/{names[day]}",
            "opens": opens,
            "closes": closes,
        })

    if spec:
        node["openingHoursSpecification"] = spec

    return json.dumps(node, ensure_ascii=False, separators=(",", ":"))


SCRIPT = """
// Highlight today's row in the opening hours.
(function () {
  var keys = ['sun','mon','tue','wed','thu','fri','sat'];
  var row = document.querySelector('[data-day="' + keys[new Date().getDay()] + '"]');
  if (row) { row.classList.add('today'); }
})();

// Submit the contact form without leaving the page.
(function () {
  var form = document.getElementById('contactForm');
  if (!form) { return; }
  var status = form.querySelector('.form-status');
  form.addEventListener('submit', function (event) {
    if (!form.getAttribute('action')) { return; }
    event.preventDefault();
    status.textContent = '...';
    fetch(form.action, {
      method: 'POST',
      body: new FormData(form),
      headers: { Accept: 'application/json' }
    }).then(function (response) {
      if (!response.ok) { throw new Error('bad status'); }
      form.reset();
      status.textContent = form.dataset.sent;
    }).catch(function () {
      status.textContent = form.dataset.error;
    });
  });
})();
"""

RENDERERS = {
    "hero": hero,
    "about": about,
    "services": services,
    "contact": contact,
    "hours": lambda cfg: "",  # Hours render inside the contact panel.
}


def build(config_path: Path) -> Path:
    cfg = merge(DEFAULTS, json.loads(config_path.read_text(encoding="utf-8")))

    for required in ("name", "slug"):
        if not cfg.get(required):
            raise SystemExit(f"{config_path.name}: missing required field '{required}'")

    body = "".join(RENDERERS[name](cfg) for name in cfg["sections"] if name in RENDERERS)
    css = CSS.substitute(
        **cfg["palette"],
        display_font=cfg["fonts"]["display"],
        display_fallback=cfg["fonts"].get("display_fallback", "Georgia, serif"),
        body_font=cfg["fonts"]["body"],
    )

    fonts = "&family=".join(
        f.replace(" ", "+") + ":wght@400;500;600;700"
        for f in (cfg["fonts"]["display"], cfg["fonts"]["body"])
    )

    page = f"""<!DOCTYPE html>
<html lang="{e(cfg['lang'])}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{e(cfg['name'])}{' — ' + e(cfg['tagline']) if cfg.get('tagline') else ''}</title>
<meta name="description" content="{e(cfg.get('tagline', cfg['name']))}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family={fonts}&display=swap" rel="stylesheet">
<script type="application/ld+json">{json_ld(cfg)}</script>
<style>{css}</style>
</head>
<body>
{nav(cfg)}
<main>
{body}
</main>
<footer>
  <div class="container">
    &copy; <span id="yr"></span> {e(cfg['name'])}
  </div>
</footer>
<script>document.getElementById('yr').textContent = new Date().getFullYear();{SCRIPT}</script>
</body>
</html>
"""

    target = OUT / cfg["slug"]
    target.mkdir(parents=True, exist_ok=True)
    (target / "index.html").write_text(page, encoding="utf-8")

    # Carry the configured photo directory across, when there is one.
    assets = config_path.parent / cfg.get("assets", "")

    if cfg.get("assets") and assets.is_dir():
        shutil.copytree(assets, target / "images", dirs_exist_ok=True)

    return target / "index.html"


def main(argv: list[str]) -> int:
    configs = (
        sorted((ROOT / "clients").glob("*.json"))
        if argv[:1] == ["--all"]
        else [Path(a) for a in argv]
    )

    if not configs:
        print(__doc__)
        return 1

    for config in configs:
        print(f"built {build(config).relative_to(ROOT)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
