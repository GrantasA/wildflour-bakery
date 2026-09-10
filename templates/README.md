# Site generator

Turns a small JSON file into a finished, self-contained one-page website.
No framework, no build step, no dependencies — the output is a single
`index.html` that runs anywhere.

## Making a site

```bash
cp clients/kirpykla-rasa.json clients/naujas-klientas.json
# edit name, slug, phone, address, services, hours, palette
python3 build.py clients/naujas-klientas.json
# -> out/naujas-klientas/index.html
```

Rebuild everything with `python3 build.py --all`.

Realistic time per client: **~25 minutes** — fill the JSON, drop in photos,
build, deploy. That is the whole point: delivery stops being the bottleneck.

## What each site includes

- Sticky header with a click-to-call phone number
- Hero, about, services with prices, opening hours, contact form, map
- Opening-hours table that highlights the current day in the browser
- `LocalBusiness` JSON-LD (correct schema.org subtype per business kind),
  so the site is eligible for Google rich results
- Responsive down to 400px, `prefers-reduced-motion` respected
- Contact form posts to Formspree, so there is no backend to host or pay for

## Photos

Leave `photos` out and each slot renders as a monogram placeholder. Real
photos matter more than anything else for perceived quality, so before showing
a demo, put files in a folder and point the config at it:

```json
"assets": "photos/kirpykla",
"photos": { "hero": "images/hero.jpg", "about": "images/interior.jpg" }
```

Pexels and Unsplash are free for commercial use with no attribution required.
Do not reuse the bakery photos in `../images` until their licence is confirmed.

## Config reference

| Key | Notes |
| --- | --- |
| `slug` | Output folder name. Required. |
| `name` | Business name. Required. |
| `kind` | `bakery`, `cafe`, `restaurant`, `salon`, `barber`, `auto`, `clinic`, `gym`, `florist`, `other` — picks the schema.org type. |
| `palette` | 9 colours. Changing `accent` alone already reskins the site. |
| `fonts` | `display`, `body`, and `display_fallback` (match the fallback to the font's class — serif vs sans). |
| `sections` | Order of sections to render. |
| `services` | `name`, optional `price` and `desc`. |
| `hours` | `"09:00 - 18:00"` per day; omit a day to show it as closed. |
| `form_endpoint` | Formspree URL. Without it the form renders but does not submit. |
| `labels` | Every visible string, so the site can be built in any language. |

Defaults are Lithuanian; override `labels` and `days` for another language.

## Deploying

Each `out/<slug>/` folder is a complete static site. Drag it into Netlify
Drop, or push it to a GitHub Pages repo. Hosting cost is zero.
