# Craft Copilot: OSRS craft profit tracker

A live dashboard, similar in spirit to the Flipping Copilot RuneLite plugin, but for crafts
instead of flips: oathplate armour, necklace of rupture, godswords, zenyte jewellery, spirit
shields, enchanted bolts, potions and more.

- **One goal: the best gp/h with the least work.** You choose only three things:
  - **Risk:** Low / Mid / High.
  - **Timeframe:** how long each buy or sell offer may take. 5m, 30m, 4h, 8h, or a custom
    value like `90m` or `1d`.
  - **Your GP.**

  Everything else is tuned automatically for risk-adjusted gp per hour of the whole
  buy → craft → sell cycle. Crafts needing more than 15 minutes of clicking per batch are
  left out.
- **Do this now: fill your GE slots.** The planner picks the combination of crafts that gives
  the highest total gp/h for your free GE slots and free GP, and it keeps working while you
  have trades running.
  - **GP management:** it tries each craft at smaller batch sizes too. A smaller batch buys
    faster and frees GP for another craft, and sometimes that earns more per hour overall.
  - **Faster buys when they pay:** buy prices are checked for 5m, 30m, 1h, 4h and longer
    windows, up to your timeframe. The planner takes a quicker, slightly dearer buy whenever
    that gives more gp/h.
- **Copilot picks.** The best single crafts right now by gp/h, skipping anything you can't
  afford or that clashes with your open trades. Each shows the exact buy and sell prices to
  offer.
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
   - You only capture part of that volume, because other players' offers queue ahead of
     yours. The app assumes you get a third of it.
   - When a 5-minute average matches your price, only part of that bucket's volume counts
     (about half at the average, all of it once your price is 1% better).
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
4. **The price AI (buy and sell prices).** This is in `src/ai.js`. It is a pattern-matching
   ("nearest neighbour") model that runs on your own PC, with no API key and no cost. It
   works in four steps:
   1. **Describe the chart.** It turns the item's current chart into numbers: the recent
      price shape, volatility, where the price sits in its recent range, the volume trend,
      the buy/sell spread, and the time of day.
   2. **Find similar moments.** It searches the history of every tracked item for the most
      similar moments.
   3. **Replay what happened next.** For each of those moments, it replays the following
      window. For selling: did buyers pay at least that price, with enough volume for your
      quantity? For buying: did sellers let it go at or below that price?
   4. **Pick the price.** For every candidate price it works out the chance of filling in
      time, plus what happens if it doesn't: you dump at the market to sell, or pay the
      market to buy. It picks the best expected result after GE tax, adjusted for your risk
      setting.

   Buy prices are checked across several windows (1h, 4h, 12h, 24h, 48h up to your max
   wait), so the plan can weigh "cheap but slow" against "quick". While offers are up, the
   Copilot re-checks every minute and says raise, lower, relist or keep. It only suggests a
   change for a real gain, because moving an offer loses your place in the queue.

   The "last buy/sell price" figures are the most recent trades, not guaranteed instant
   fills. The AI treats them as just another price with its own chance of filling.

   **Honest times.** If an offer doesn't fill in its window you have to trade at the market,
   and that takes time too, about as long as the market needs to move your quantity. That
   is included, so an estimate can be longer than your timeframe when that's the truth.

   **Learns your real fill times.** Each offer placed at a suggested price is recorded with its
   predicted time. When you click **Bought** or **Sold**, the real time is compared with the
   prediction. The typical ratio becomes a correction applied to every time estimate and to
   gp/h. It's pulled towards 1× while there are only a few fills, and the AI bar shows it.
   Click Bought and Sold promptly: late clicks make offers look slower than they were.

   **It checks itself and learns.** Every suggestion it makes is written to
   `data/ai-journal.jsonl`. Once the window has passed, it reads the real chart for that
   period and grades whether the offer would have filled. It grades the simple rule (1gp
   under or over the market) the same way, so you see its real edge. The graded record
   corrects its future fill chances: if its "80%" only came true 65% of the time, it adjusts.
   Every 10 minutes it also backtests (trains on the older 75% of history, tests on the
   newest 25%) and tunes how many similar charts to use. If it loses to the simple rule on
   either side, it switches that side off and the app uses the rule instead.

   **Risk.** The risk setting (**Careful / Balanced / Bold**) decides how much the bad case
   counts:
   - In the AI, the bad case is the worst 20% of outcomes.
   - For each craft, it's the product's price moving against you while you buy and craft,
     measured from how much that item's price has actually moved over the same length of
     time.
   - Each craft shows a **bad case** (worst 10%) and a **chance of a loss**.
   - Price spikes or crashes (possible manipulation) and very thinly traded items are
     flagged, and Copilot picks never include a spiked or crashed item.

   **Memory that grows.** Price history is saved to `data/` (`history-5m.jsonl`,
   `history-1h.jsonl`) and reloaded on start. The Wiki API only hands out about 30 hours of
   5-minute and 15 days of hourly data, but the app keeps up to **7 days of 5-minute** and
   **60 days of hourly** history while it runs. The AI learns from all of it.

   **Exact trade prices.** Every 10 seconds (`TICK_SECONDS`, 0 to turn off) the app checks
   the latest trades and saves every distinct price it sees to `data/ticks.jsonl`. Bucket
   averages hide peaks and dips, and these fill that gap. If a 5-minute average never
   reached your price but a captured trade did, that counts as at least one unit filled.
   This applies in the fill-time model, in the AI's replays and in its self-check grading.
   This only covers trades from when the app is running, and a 10-second poll can miss a
   price that changed twice in between.

   **Market and related-item signals.** Besides the item's own chart, the AI can compare:
   - how the whole market has moved over the last 30 minutes and 2 hours
   - how items in the same recipes have moved (ingredients and product)
   - whether the craft margin (product vs ingredient cost) is unusually wide or narrow

   The self-test runs the AI with and without these and only switches them on when they win
   by a real margin (0.02% of price). The dashboard shows whether they're in use. With little
   history they often aren't; they're retested as the saved history grows.

   The limit: the Wiki API has no live order book (the offers waiting on the GE), so the AI
   can't see those.
5. **Filling your GE slots.** The "Fill your GE slots" section plans the best mix of crafts
   for your free slots (the **GE slots** setting, default 8) and your **Capital**. It
   accounts for:
   - the slots and cash your open trades already use
   - one slot per ingredient while buying
   - never two crafts that trade the same item (they'd compete for the same sellers and buy
     limit)

   Crafts are picked by risk-adjusted profit per slot-hour. A craft that doesn't fit the cash
   left gets a smaller batch.
6. **Batch size.** A batch is as many crafts as the inputs' 4-hour buy limits allow, capped by
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
| `TICK_SECONDS` | `10` | How often to capture exact trade prices (0 = off) |
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
