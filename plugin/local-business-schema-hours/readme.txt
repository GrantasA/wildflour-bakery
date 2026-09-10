=== Local Business Schema & Hours ===
Contributors: wildflour
Tags: business hours, opening hours, local seo, schema, structured data
Requires at least: 6.0
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Show your opening hours and an accurate "open now" badge, and publish valid LocalBusiness schema so Google can display your hours.

== Description ==

Local Business Schema & Hours does two jobs that usually need two plugins: it **displays** your opening hours to visitors, and it **publishes** them as LocalBusiness structured data that Google, Bing and other search engines can read.

Enter your address and weekly hours once. The plugin then outputs valid schema.org JSON-LD in your page head, and gives you a shortcode and a block for an hours table and a live open/closed badge.

= Display features =

* **Opening hours table** via `[business_hours]` or the *Business hours* block, with today's row highlighted.
* **Open now badge** via `[business_status]` or the *Open now badge* block, showing the next opening or closing time.
* **Conditional content** with `[business_open]` and `[business_closed]`, so you can show an order button only while you are actually open.
* **Split hours** for businesses that close over lunch, and **overnight hours** for bars and late kitchens that close after midnight.
* **Time zone aware**, so the badge is correct for your customers rather than for your server.

= Structured data =

* Valid `LocalBusiness` JSON-LD, with a specific type such as `Bakery`, `Restaurant`, `CafeOrCoffeeShop`, `Store` or `ProfessionalService`.
* `openingHoursSpecification` generated from your weekly hours.
* Address, geo coordinates, phone, price range and social profile links.
* Empty fields are omitted rather than published blank, which avoids structured data warnings in Google Search Console.

= REST endpoint =

Full page caching normally freezes an "open now" badge at whatever state it had when the page was cached. This plugin exposes `/wp-json/lbsh/v1/status` so a cached page can fetch the live state instead.

= Premium edition =

The free plugin covers a single location completely. The premium edition adds:

* Unlimited locations, each with its own address, hours and time zone.
* Holiday and seasonal closing dates, including dates that repeat every year, published as `specialOpeningHoursSpecification`.
* A store locator for multi-location businesses.

== Installation ==

1. Install and activate the plugin.
2. Go to **Settings → Business Hours**.
3. Fill in your business details and weekly opening hours, then save.
4. Add `[business_hours]` or `[business_status]` to any page, or insert the matching block.

Structured data is published automatically on your front page and on single posts and pages. You can check it with Google's Rich Results Test.

== Frequently Asked Questions ==

= Does this work with Yoast SEO or Rank Math? =

Yes. Those plugins output article and site level markup; this one adds the LocalBusiness node with your hours. If you already publish LocalBusiness markup from another plugin, turn that off in one place to avoid duplicate markup.

= How do I mark a day closed? =

Leave both time boxes empty for that day.

= How do I enter hours that run past midnight? =

Enter a closing time earlier than the opening time, for example 20:00 to 03:00. The plugin treats it as running into the next day.

= My site is cached and the badge is wrong. =

Fetch `/wp-json/lbsh/v1/status` from the front end and update the badge from the response, or exclude the page from caching.

= Will this guarantee rich results in Google? =

No. Valid structured data makes your business eligible for rich results, but Google decides what it shows. Any plugin that promises rankings is guessing.

== Screenshots ==

1. The settings screen, with business details and weekly opening hours.
2. The opening hours table and open now badge on the front end.

== Changelog ==

= 1.0.0 =
* Initial release.
