# Craft Copilot: OSRS craft profit tracker

A live dashboard, similar in spirit to the Flipping Copilot RuneLite plugin, but for crafts
instead of flips: oathplate armour, necklace of rupture, godswords, zenyte jewellery, spirit
shields, enchanted bolts, potions and more.

- **Copilot picks.** The best all-round craft right now, with the exact buy and sell prices to
  offer. The score blends profit, profit for your time, return, speed, how reliably offers fill,
  and market liquidity.
- **Your trades.** Start a craft and the app tells you, every minute:
  - when to **raise** or **lower** a buy offer, or **cancel** it if the craft stops being
    profitable
  - what to list at once you've bought everything, with your break-even price
  - when to relist a slow sale
- **Log a trade you've already made.** Tick "I've already bought the ingredients", enter what
  you paid, and you get a sell price suggestion straight away.
- **Profit tracking.** Every completed trade goes into your history, with total profit, GE tax
  paid and a cumulative profit chart. Trades are saved in `data/positions.json`.
- **No crafts that eat your time.** Anything needing more hands-on time than your limit
  (15 minutes per batch by default) is hidden, as are crafts involving untradeable items.
- Includes the **GE tax** (2% per item, rounded down, capped at 5M) and **GE buy limits**.
- Live prices from the [OSRS Wiki real-time prices API](https://oldschool.runescape.wiki/w/RuneScape:Real-time_Prices),
  **refreshed every minute**. No dependencies; needs Node.js 18 or newer.

## Run it

```bash
cd osrs-craft-tracker
OSRS_USER_AGENT="craft-tracker - yourname#1234" npm start
# open http://localhost:3000
```

The Wiki asks every API client to send a descriptive User-Agent, so put your Discord or email in
`OSRS_USER_AGENT`. On the first start the app downloads roughly 30 hours of 5-minute history and
15 days of hourly history for every tracked item. This takes a minute or two, and the status bar
shows progress.

`npm run mock` starts the app on random offline data, for trying out the UI. Don't trade off those numbers.
`npm test` runs the unit tests.

## How the "sweet spot" is found

The API reports each trade as one of two kinds, per 5-minute or 1-hour bucket:

- **instant-buy**: someone paid a seller's asking price
- **instant-sell**: someone dumped into a buy offer

The app treats these as follows:

1. **Fill time for any offer price.** A buy offer at price P fills from sellers who were willing
   to sell at P or less. The app replays the recent history, starting a hypothetical offer at
   every point in the window, and measures how long it takes to collect the full quantity. It
   reports the **median** and the **p90** (slow case) of those times.
   - You only capture part of that volume, because other players compete for it. The
     **Market share** setting controls how much. Lower values give more conservative waits.
   - Thinly traded items (for example an etched elder venator fang, or oathplate shards in
     large quantities) switch to hourly history, and the row is flagged.
   - History is shifted onto today's price level, so a week-old dip doesn't show up as a
     "cheap" price today.
2. **Price ladder.** For each input and for the output, the app builds the list of price and
   median-wait pairs where getting a better price means waiting longer. You can see these
   ladders by clicking a row.
3. **Optimisation.** Inputs are bought in parallel GE slots, so the buy phase lasts as long as
   the slowest input. The app tries every buy-time budget, takes the cheapest price per input
   that fills within it, and pairs that with every sell option. Cycle time is buy time, plus
   craft time, plus sell time. It then picks the plan according to the **Optimise for**
   setting:
   - **Profit per hour**: the most profit per hour of the whole cycle, GE waiting included.
     This favours fast flips.
   - **Profit per active hour**: the most profit for your hands-on time (crafting plus about
     15 seconds per GE offer). GE waiting is free here, so the app takes the cheapest buys
     that still fit in **Max wait**. Use this to find crafts that are slow to buy but quick to
     make. The **Max active time** filter hides crafts that need more of your time than you
     want to give.
   - **Total profit**: the most profit per batch that fits in **Max wait**.

   Plans longer than **Max wait** are flagged, greyed out and listed after the ones that fit.
4. **Batch size.** A batch is as many crafts as the inputs' 4-hour buy limits allow, capped by
   your **Capital** setting.

Each row also shows the instant plan (buy at the current asking price, sell into the current
bid) for comparison.

## Adding crafts

Edit `src/recipes.json`. The server picks up changes on the next refresh.

```json
{ "id": "my-craft", "category": "Smithing", "skills": "80 Smithing",
  "inputs": [{ "item": "Godsword shard 1", "qty": 1 }],
  "output": { "item": "Godsword blade", "qty": 1 },
  "coins": 0, "craftSeconds": 3, "batch": 5 }
```

- Item names must match the Wiki's item names, ignoring case. Unknown names appear in the table
  so you can fix them.
- `coins` is a flat per-craft fee, such as a tanner's fee.
- `batch` is optional. Use it to override the automatic batch size.

## Settings (environment variables)

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `OSRS_USER_AGENT` | generic | User-Agent sent to the Wiki API |
| `RECIPES_FILE` | `src/recipes.json` | Alternative recipe file |
| `POSITIONS_FILE` | `data/positions.json` | Where your trades are saved |
| `HOST` | `127.0.0.1` | Interface to listen on. Only this PC by default, since the page can edit your trades. |

## Limits of the model

- Wait times are estimates based on recent history. They assume the market behaves the way it
  did over the last day (5-minute data) or two weeks (hourly data). Game updates and item
  crashes break that assumption.
- The API only provides average prices per bucket, so the ladders are approximate within about
  1% of price.
- Only crafts whose ingredients and product are all tradeable are included. If a recipe
  mentions an item the GE doesn't list, that craft is hidden, and a note under the table says
  which item caused it. For example, the amulet of
  rancour needs an untradeable araxyte fang, so it isn't listed.
