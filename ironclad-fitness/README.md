# Ironclad Fitness — embeddable FAQ chat widget

A drop-in chat bubble that answers questions about a (fictional) gym, backed by
Claude. One `<script>` tag embeds it on any site; a small FastAPI proxy holds
the API key and streams answers back.

```
ironclad-fitness/
├─ server.py            FastAPI proxy — validation, rate limiting, SSE streaming
├─ knowledge.py         Gym facts + system prompt (the only file with gym content)
├─ requirements.txt
├─ .env.example
└─ public/
   ├─ widget.js         The whole widget: ~500 lines, no dependencies, shadow DOM
   └─ index.html        Mock gym homepage showing the widget embedded
```

## Quick start

```bash
cd ironclad-fitness
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

Copy `.env.example` to `.env` and add your key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Then:

```bash
.venv\Scripts\python server.py
```

Open **http://localhost:3000** — the demo gym homepage, with the widget in the
bottom-right corner.

The key is only ever read from the environment (`os.getenv`, via `python-dotenv`).
It never reaches the browser: the widget talks to `/api/chat`, and only the
server talks to Anthropic.

## Embedding it somewhere else

That's the whole integration:

```html
<script src="https://your-host.com/widget.js" data-api="https://your-host.com" defer></script>
```

Set `ALLOWED_ORIGINS` in `.env` to the sites allowed to call the API:

```
ALLOWED_ORIGINS=https://ironcladfitness.com,https://www.ironcladfitness.com
```

Everything renders inside a shadow root, so the host page's CSS can't reach into
the widget and the widget's CSS can't leak onto the page.

### Options

All are optional `data-*` attributes on the script tag.

| Attribute       | Default                        | What it does                              |
| --------------- | ------------------------------ | ----------------------------------------- |
| `data-api`      | the script's own origin        | Base URL of the chat API                  |
| `data-title`    | `Ironclad Fitness`             | Header title                              |
| `data-subtitle` | `Front desk - usually instant` | Header subtitle                           |
| `data-accent`   | `#ff5a1f`                      | Accent colour — rebrand with one attribute |
| `data-position` | `right`                        | `right` or `left`                         |
| `data-open`     | `false`                        | `true` starts expanded (handy for demos)  |

## Changing what the bot knows

Everything the bot can say lives in **`knowledge.py`** — hours, tiers, prices,
the class schedule, the address, the tone, and the rule that keeps it on topic.
Edit that file and restart; nothing else hardcodes a gym fact. The widget even
pulls its greeting and its four starter chips from there, via `GET /api/config`.

Three things in the prompt do the real work:

- **Scope.** The bot answers gym questions and politely declines everything
  else in one sentence, then offers something it *can* help with. It also
  ignores "ignore your instructions" style text arriving in user messages.
- **Anti-hallucination.** It answers only from the listed facts. Anything not
  covered — day passes, guest policy, cancellation, sauna — gets an honest "I'm
  not sure" plus the front desk number, rather than an invented answer. This is
  the part worth keeping if you adapt this for a real business.
- **Brevity.** Two or three sentences, bullets for lists, no headings or tables.
  A chat bubble is 370px wide.

## How it's wired

`POST /api/chat` takes `{"messages": [{"role": "user"|"assistant", "content": "..."}]}`
and streams Server-Sent Events back:

```
data: {"type": "delta", "text": "We open at "}
data: {"type": "delta", "text": "5am on weekdays"}
data: {"type": "done"}
```

`{"type": "error", "text": "..."}` carries a user-safe message when a turn fails.

The server is **stateless** — the widget keeps the transcript and replays the
last 12 messages each turn, so you can run more than one instance behind a load
balancer without sticky sessions.

Model settings live at the top of `server.py`:

- `claude-opus-5` with `effort: "low"` — thinking stays on (the Opus 5 default),
  but shallow, which is what keeps a front-desk answer fast.
- Streaming, so the first words appear in a few hundred milliseconds instead of
  after the whole answer.
- Server-side refusal fallbacks are enabled (`fallbacks: "default"`). If a
  request is declined by the safety classifiers, the API transparently re-runs
  it on Anthropic's recommended substitute model instead of returning a dead
  turn. If your SDK or account doesn't have that beta, the server notices on the
  first call, logs a warning, and carries on without it.
- The system prompt is marked cacheable. It's currently ~700 tokens, just under
  the 1024-token minimum, so caching doesn't engage yet — it starts paying for
  itself as soon as you add more FAQ content to `knowledge.py`.

## Before putting this in front of real traffic

- **Rate limiting** is a per-IP dict in memory (20 requests/minute). Fine for one
  process; move it to Redis or your CDN if you run more than one.
- **`ALLOWED_ORIGINS`** defaults to `*` for the demo. Lock it down.
- **Run behind a real ASGI setup** — `uvicorn server:app --workers 4` behind
  nginx. The `X-Accel-Buffering: no` header is already set so nginx won't buffer
  the stream and destroy the typing effect.
- **Log the conversations** you want to learn from. Right now the server logs
  token counts and stop reasons only, never message content.
