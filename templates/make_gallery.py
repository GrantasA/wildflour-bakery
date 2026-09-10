#!/usr/bin/env python3
"""Compose Fiverr gig gallery images (1280x769) from the demo site screenshots."""

import asyncio
import base64
import pathlib

from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent
SHOTS = ROOT / "previews"
OUT = ROOT / "gallery"
CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"


def b64(name: str) -> str:
    data = base64.b64encode((SHOTS / name).read_bytes()).decode()
    return f"data:image/png;base64,{data}"


BASE = """
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { width: 1280px; height: 769px; overflow: hidden;
         font-family: Inter, system-ui, sans-serif; background: #10141c; color: #fff; }
  .wrap { width: 100%; height: 100%; padding: 54px 60px; display: flex;
          flex-direction: column; position: relative; }
  .glow { position: absolute; inset: 0;
          background: radial-gradient(900px 420px at 78% 12%, rgba(31,111,235,.28), transparent 70%); }
  h1 { font-size: 50px; line-height: 1.06; font-weight: 800; letter-spacing: -0.025em;
       position: relative; max-width: 17ch; }
  h1 em { font-style: normal; color: #6ea8ff; }
  .sub { margin-top: 16px; font-size: 21px; color: #9fb0c9; position: relative; max-width: 40ch; }
  .pills { display: flex; gap: 10px; margin-top: 22px; position: relative; flex-wrap: wrap; }
  .pill { background: rgba(255,255,255,.09); border: 1px solid rgba(255,255,255,.16);
          padding: 8px 16px; border-radius: 999px; font-size: 15px; font-weight: 600; }
  .stage { flex: 1; position: relative; margin-top: 26px; }
  .browser { position: absolute; border-radius: 12px; overflow: hidden;
             box-shadow: 0 30px 70px rgba(0,0,0,.55); background: #fff; }
  .bar { height: 26px; background: #e8ecf2; display: flex; align-items: center; gap: 6px; padding: 0 11px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #c3ccd8; }
  .shot { overflow: hidden; }
  .shot img { width: 100%; display: block; }
  .phone { position: absolute; border-radius: 26px; overflow: hidden; border: 7px solid #202836;
           box-shadow: 0 26px 60px rgba(0,0,0,.6); background: #fff; }
  .phone img { width: 100%; display: block; }
</style>
"""


def layout_hero() -> str:
    return BASE + f"""
<div class="wrap">
  <div class="glow"></div>
  <h1>A one page website your customers <em>can actually find</em></h1>
  <p class="sub">Hand-designed, mobile-first, and delivered in 48 hours.</p>
  <div class="pills">
    <span class="pill">Google schema included</span>
    <span class="pill">No monthly fees</span>
    <span class="pill">You own the files</span>
  </div>
  <div class="stage">
    <div class="browser" style="left:0; top:6px; width:716px;">
      <div class="bar"><i class="dot"></i><i class="dot"></i><i class="dot"></i></div>
      <div class="shot" style="height:346px"><img src="{b64('kirpykla-rasa-desktop.png')}" /></div>
    </div>
    <div class="phone" style="right:30px; top:-56px; width:232px;">
      <div style="height:392px; overflow:hidden">
        <img src="{b64('autoservisas-vektoras-mobile.png')}" />
      </div>
    </div>
  </div>
</div>"""


def layout_detail() -> str:
    return BASE + f"""
<div class="wrap">
  <div class="glow"></div>
  <h1>Your services, prices and <em>opening hours</em></h1>
  <p class="sub">Today's hours highlight automatically. Click-to-call, contact form and map included.</p>
  <div class="stage">
    <div class="browser" style="left:0; top:26px; width:1160px;">
      <div class="bar"><i class="dot"></i><i class="dot"></i><i class="dot"></i></div>
      <div class="shot" style="height:340px">
        <img style="margin-top:-1250px" src="{b64('kirpykla-rasa-desktop.png')}" />
      </div>
    </div>
  </div>
</div>"""


def layout_schema() -> str:
    return BASE + """
<div class="wrap">
  <div class="glow"></div>
  <h1>Most cheap sites skip <em>the part Google reads</em></h1>
  <p class="sub">Every site I build ships valid LocalBusiness structured data.</p>
  <div class="stage">
    <div style="position:absolute; inset:16px 0 0 0; display:grid;
                grid-template-columns:1fr 1fr; gap:26px;">
      <div style="background:#0d1117; border:1px solid #2a3444; border-radius:12px;
                  padding:20px 22px; font-family:ui-monospace,Menlo,monospace;
                  font-size:14px; line-height:1.65; color:#a7c5ff; overflow:hidden">
<div style="color:#5f6f85">&lt;script type="application/ld+json"&gt;</div>
<div>{ "@type": <span style="color:#7ee787">"HairSalon"</span>,</div>
<div>&nbsp;&nbsp;"name": <span style="color:#7ee787">"Kirpykla Rasa"</span>,</div>
<div>&nbsp;&nbsp;"telephone": <span style="color:#7ee787">"+370 600 11222"</span>,</div>
<div>&nbsp;&nbsp;"address": { ... },</div>
<div>&nbsp;&nbsp;"openingHoursSpecification": [</div>
<div>&nbsp;&nbsp;&nbsp;&nbsp;{ "opens": <span style="color:#7ee787">"09:00"</span>,</div>
<div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"closes": <span style="color:#7ee787">"18:00"</span> } ] }</div>
      </div>
      <div style="display:flex; flex-direction:column; gap:16px; justify-content:center">
        <div style="background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.14);
                    border-radius:12px; padding:18px 20px">
          <div style="font-size:19px; font-weight:700; margin-bottom:5px">Hours in search results</div>
          <div style="color:#9fb0c9; font-size:16px">Google can show when you are open.</div>
        </div>
        <div style="background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.14);
                    border-radius:12px; padding:18px 20px">
          <div style="font-size:19px; font-weight:700; margin-bottom:5px">Address and phone</div>
          <div style="color:#9fb0c9; font-size:16px">Read correctly by maps and search.</div>
        </div>
        <div style="background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.14);
                    border-radius:12px; padding:18px 20px">
          <div style="font-size:19px; font-weight:700; margin-bottom:5px">Eligible for rich results</div>
          <div style="color:#9fb0c9; font-size:16px">Passes Google's Rich Results Test.</div>
        </div>
      </div>
    </div>
  </div>
</div>"""


async def main() -> None:
    OUT.mkdir(exist_ok=True)
    pages = {
        "gig-1-hero.png": layout_hero(),
        "gig-2-detail.png": layout_detail(),
        "gig-3-schema.png": layout_schema(),
    }

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=CHROME)

        for name, markup in pages.items():
            page = await browser.new_page(viewport={"width": 1280, "height": 769})
            await page.set_content(markup, wait_until="load")
            await page.wait_for_timeout(900)
            await page.screenshot(path=str(OUT / name))
            print(f"{name}  {(OUT / name).stat().st_size // 1024}KB")
            await page.close()

        await browser.close()


asyncio.run(main())
