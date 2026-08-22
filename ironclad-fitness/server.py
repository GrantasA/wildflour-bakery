"""
Ironclad Fitness FAQ chatbot -- API proxy.

The widget never talks to Anthropic directly (that would leak the API key to
every visitor). It POSTs the conversation here; this server adds the system
prompt, calls Claude, and streams the answer back as Server-Sent Events.

Run:
    pip install -r requirements.txt
    set ANTHROPIC_API_KEY=...        # or put it in .env
    python server.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import AsyncIterator, Literal

import anthropic
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from knowledge import GREETING, GYM, SUGGESTED_QUESTIONS, SYSTEM_PROMPT

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-7s %(message)s")
log = logging.getLogger("ironclad")

MODEL = "claude-opus-5"

# A front-desk answer is two or three sentences. The ceiling is only here so a
# runaway generation cannot bill forever -- it leaves room for adaptive
# thinking plus a comfortably long answer.
MAX_TOKENS = 2048

# Low effort keeps replies snappy. Thinking stays on (the default on Opus 5);
# turning it off is what causes stray thinking tags to leak into output.
EFFORT = "low"

# How much conversation the widget may send back. Enough for a real back and
# forth, small enough that one visitor cannot mail us a novel.
MAX_HISTORY_MESSAGES = 24
MAX_CHARS_PER_MESSAGE = 2000

# Crude per-IP throttle. Fine for a demo or one small site; swap for Redis (or
# your CDN's rate limiting) before putting this in front of real traffic.
RATE_LIMIT_REQUESTS = 20
RATE_LIMIT_WINDOW_SECONDS = 60

ALLOWED_ORIGINS = [
    o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()
]

# Server-side refusal fallback: if Opus 5's safety classifiers decline a
# request, the API re-runs it on Anthropic's recommended substitute inside the
# same call instead of handing us a dead turn. Flipped off automatically if the
# installed SDK or the account does not know the beta yet -- see _stream_reply.
_fallbacks_enabled = True

client = anthropic.AsyncAnthropic()  # reads ANTHROPIC_API_KEY from the environment

_request_log: dict[str, deque[float]] = defaultdict(deque)


# --------------------------------------------------------------------------- #
# Request models
# --------------------------------------------------------------------------- #


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=MAX_CHARS_PER_MESSAGE)


class ChatRequest(BaseModel):
    messages: list[Message] = Field(min_length=1, max_length=MAX_HISTORY_MESSAGES)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def sse(event_type: str, **payload) -> str:
    """Encode one Server-Sent Event frame."""
    return "data: " + json.dumps({"type": event_type, **payload}) + "\n\n"


def rate_limited(ip: str) -> bool:
    now = time.monotonic()
    hits = _request_log[ip]
    while hits and now - hits[0] > RATE_LIMIT_WINDOW_SECONDS:
        hits.popleft()
    if len(hits) >= RATE_LIMIT_REQUESTS:
        return True
    hits.append(now)
    return False


def _is_fallback_unsupported(exc: Exception) -> bool:
    """True if the request failed because of the refusal-fallback beta itself."""
    if isinstance(exc, TypeError):
        return "fallbacks" in str(exc)
    return "fallback" in str(exc).lower()


def _stream_kwargs(messages: list[Message], with_fallbacks: bool) -> dict:
    kwargs: dict = {
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": [
            {
                "type": "text",
                "text": SYSTEM_PROMPT,
                # Caching engages once the prefix passes ~1024 tokens. Today's
                # prompt is under that, so this is a no-op that starts paying
                # off the moment someone adds more FAQ content to knowledge.py.
                "cache_control": {"type": "ephemeral"},
            }
        ],
        "output_config": {"effort": EFFORT},
        "messages": [m.model_dump() for m in messages],
    }
    if with_fallbacks:
        kwargs["betas"] = ["server-side-fallback-2026-07-01"]
        kwargs["fallbacks"] = "default"
    return kwargs


REFUSAL_TEXT = (
    "Sorry, I can't help with that one. Ask me about hours, memberships or "
    "classes, or call the front desk at " + GYM["phone"] + "."
)

ERROR_TEXT = (
    "Sorry, I'm having trouble reaching the front desk right now. Try again in "
    "a moment, or call us at " + GYM["phone"] + "."
)


async def _stream_reply(messages: list[Message]) -> AsyncIterator[str]:
    """Yield SSE frames for one assistant turn."""
    global _fallbacks_enabled

    for attempt in range(2):
        emitted = False
        try:
            async with client.beta.messages.stream(
                **_stream_kwargs(messages, _fallbacks_enabled)
            ) as stream:
                async for text in stream.text_stream:
                    emitted = True
                    yield sse("delta", text=text)

                final = await stream.get_final_message()

            # Check stop_reason before trusting the content: a refusal comes
            # back as a normal 200 with little or no text in it.
            if final.stop_reason == "refusal":
                category = getattr(final.stop_details, "category", None)
                log.warning("Request refused (category=%s)", category)
                if not emitted:
                    yield sse("delta", text=REFUSAL_TEXT)

            log.info(
                "turn ok  in=%s out=%s cache_read=%s stop=%s",
                final.usage.input_tokens,
                final.usage.output_tokens,
                getattr(final.usage, "cache_read_input_tokens", 0),
                final.stop_reason,
            )
            yield sse("done")
            return

        except (TypeError, anthropic.BadRequestError) as exc:
            # Retry once without the beta, but only while we have not already
            # sent the visitor half an answer.
            if (
                attempt == 0
                and _fallbacks_enabled
                and not emitted
                and _is_fallback_unsupported(exc)
            ):
                log.warning("Refusal fallbacks unsupported here, disabling: %s", exc)
                _fallbacks_enabled = False
                continue

            # A missing key surfaces as a TypeError from the SDK before any
            # request goes out. It's the first thing anyone hits, so say so
            # plainly instead of burying it in a stack trace.
            if isinstance(exc, TypeError) and "authentication" in str(exc).lower():
                log.error(
                    "No API key. Copy .env.example to .env and set "
                    "ANTHROPIC_API_KEY, then restart."
                )
            else:
                log.exception("Bad request to the Claude API")
            yield sse("error", text=ERROR_TEXT)
            return

        except anthropic.AuthenticationError:
            log.error("ANTHROPIC_API_KEY was rejected. Check the key in .env.")
            yield sse("error", text=ERROR_TEXT)
            return

        except anthropic.RateLimitError:
            log.warning("Rate limited by the Claude API")
            yield sse(
                "error",
                text="We're getting a lot of questions right now -- give me a few "
                "seconds and try again.",
            )
            return

        except anthropic.APIConnectionError:
            log.exception("Could not reach the Claude API")
            yield sse("error", text=ERROR_TEXT)
            return

        except anthropic.APIStatusError:
            log.exception("Claude API returned an error status")
            yield sse("error", text=ERROR_TEXT)
            return

        except asyncio.CancelledError:
            # Visitor closed the tab or hit stop. Nothing to report.
            raise


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not (os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN")):
        log.warning(
            "ANTHROPIC_API_KEY is not set. The page will load but every answer "
            "will fail. Copy .env.example to .env and add your key."
        )
    yield


app = FastAPI(title=GYM["name"] + " FAQ bot", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "model": MODEL,
        "key_configured": bool(os.getenv("ANTHROPIC_API_KEY")),
    }


@app.get("/api/config")
async def config():
    """Lets the widget pull its greeting and starter chips from the same file
    the system prompt lives in, so gym facts only ever change in one place."""
    return {
        "name": GYM["name"],
        "greeting": GREETING,
        "suggestions": SUGGESTED_QUESTIONS,
    }


@app.post("/api/chat")
async def chat(body: ChatRequest, request: Request):
    ip = (request.client.host if request.client else None) or "unknown"
    if rate_limited(ip):
        raise HTTPException(status_code=429, detail="Too many questions, slow down a moment.")

    if body.messages[-1].role != "user":
        raise HTTPException(status_code=400, detail="The last message must be from the user.")

    return StreamingResponse(
        _stream_reply(body.messages),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",  # tells nginx not to buffer the stream
            "Connection": "keep-alive",
        },
    )


# Serve the demo page and the widget itself. Mounted last so /api/* wins.
app.mount("/", StaticFiles(directory=os.path.join(os.path.dirname(os.path.abspath(__file__)), "public"), html=True), name="public")


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "3000"))
    log.info("Ironclad Fitness demo -> http://localhost:%s", port)
    uvicorn.run(app, host="127.0.0.1", port=port)
