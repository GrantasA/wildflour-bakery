/**
 * Ironclad Fitness chat widget.
 *
 * Drop this on any page:
 *   <script src="https://your-host/widget.js" data-api="https://your-host" defer></script>
 *
 * Everything lives inside a shadow root, so the host page's CSS can't reach in
 * and this file's CSS can't leak out. No dependencies, no build step.
 *
 * Options (all optional, set as data-* attributes on the script tag):
 *   data-api       Base URL of the chat API. Defaults to the script's own origin.
 *   data-title     Header title.        Default "Ironclad Fitness"
 *   data-subtitle  Header subtitle.     Default "Front desk - usually instant"
 *   data-accent    Accent colour.       Default "#ff5a1f"
 *   data-position  "right" or "left".   Default "right"
 *   data-open      "true" to start expanded (handy for screenshots).
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var cfg = {
    api: (script.dataset.api || new URL(script.src, location.href).origin).replace(/\/$/, ''),
    title: script.dataset.title || 'Ironclad Fitness',
    subtitle: script.dataset.subtitle || 'Front desk - usually instant',
    accent: script.dataset.accent || '#ff5a1f',
    position: script.dataset.position === 'left' ? 'left' : 'right',
    startOpen: script.dataset.open === 'true',
  };

  // Overwritten by GET /api/config so gym copy only lives in knowledge.py.
  var greeting = "Hey! I'm the front desk assistant for Ironclad Fitness. Ask me about hours, memberships, or classes.";
  var suggestions = [
    'What are your hours?',
    'How much is a membership?',
    'When are your classes?',
    'Where are you located?',
  ];

  /** Full conversation, replayed to the server on every turn (it is stateless). */
  var history = [];
  var busy = false;
  var open = false;

  // ------------------------------------------------------------------ styles

  var CSS = `
:host, * { box-sizing: border-box; }
:host {
  --accent: ${cfg.accent};
  --bg: #101216;
  --bg-raised: #191c22;
  --bg-input: #14171c;
  --line: rgba(255,255,255,.09);
  --text: #f3f5f7;
  --muted: #9198a5;
  --radius: 18px;
  all: initial;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 15px;
  line-height: 1.5;
  color: var(--text);
}
.wrap {
  position: fixed;
  bottom: 20px;
  ${cfg.position}: 20px;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  align-items: ${cfg.position === 'left' ? 'flex-start' : 'flex-end'};
  gap: 14px;
}

/* ---------- launcher ---------- */
.launcher {
  width: 60px; height: 60px;
  border: 0; border-radius: 50%;
  background: var(--accent);
  color: #12140f;
  cursor: pointer;
  display: grid; place-items: center;
  box-shadow: 0 10px 30px rgba(0,0,0,.45), 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent);
  transition: transform .18s cubic-bezier(.2,.9,.3,1.3), box-shadow .3s ease;
  -webkit-tap-highlight-color: transparent;
}
.launcher:hover { transform: scale(1.06); }
.launcher:active { transform: scale(.95); }
.launcher:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }
.launcher svg { width: 27px; height: 27px; display: block; }
.launcher .close-icon { display: none; }
.wrap.open .launcher .chat-icon { display: none; }
.wrap.open .launcher .close-icon { display: block; }
.launcher.pulse { animation: pulse 2.4s ease-out 3; }
@keyframes pulse {
  0%   { box-shadow: 0 10px 30px rgba(0,0,0,.45), 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); }
  70%  { box-shadow: 0 10px 30px rgba(0,0,0,.45), 0 0 0 18px transparent; }
  100% { box-shadow: 0 10px 30px rgba(0,0,0,.45), 0 0 0 0 transparent; }
}

/* ---------- panel ---------- */
.panel {
  width: min(384px, calc(100vw - 40px));
  height: min(600px, calc(100vh - 130px));
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: 0 28px 70px rgba(0,0,0,.55);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  opacity: 0;
  transform: translateY(14px) scale(.97);
  transform-origin: bottom ${cfg.position};
  pointer-events: none;
  transition: opacity .2s ease, transform .22s cubic-bezier(.2,.9,.3,1.15);
}
.wrap.open .panel { opacity: 1; transform: none; pointer-events: auto; }

.header {
  display: flex; align-items: center; gap: 12px;
  padding: 16px 16px 15px;
  background: linear-gradient(135deg, var(--bg-raised), #12141a);
  border-bottom: 1px solid var(--line);
  position: relative;
}
.header::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
  background: linear-gradient(90deg, var(--accent), transparent 70%);
}
.avatar {
  width: 38px; height: 38px; flex: 0 0 38px;
  border-radius: 11px;
  background: var(--accent);
  color: #12140f;
  display: grid; place-items: center;
  font-weight: 800; font-size: 15px; letter-spacing: -.02em;
}
.htext { min-width: 0; flex: 1; }
.htitle {
  font-weight: 700; font-size: 15px; letter-spacing: -.01em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hsub {
  font-size: 12px; color: var(--muted);
  display: flex; align-items: center; gap: 6px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dot { width: 7px; height: 7px; border-radius: 50%; background: #35d07f; flex: none; }
.x {
  border: 0; background: transparent; color: var(--muted);
  width: 32px; height: 32px; border-radius: 9px; cursor: pointer;
  display: grid; place-items: center; flex: none;
}
.x:hover { background: rgba(255,255,255,.07); color: var(--text); }
.x:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.x svg { width: 16px; height: 16px; }

.log {
  flex: 1; overflow-y: auto; overscroll-behavior: contain;
  padding: 18px 16px 6px;
  display: flex; flex-direction: column; gap: 12px;
  scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.16) transparent;
}
.log::-webkit-scrollbar { width: 8px; }
.log::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 99px; }

.msg {
  max-width: 86%;
  padding: 10px 13px;
  border-radius: 15px;
  font-size: 14.5px;
  word-wrap: break-word;
  overflow-wrap: anywhere;
  animation: rise .22s ease both;
}
@keyframes rise { from { opacity: 0; transform: translateY(6px); } }
.msg.bot  { align-self: flex-start; background: var(--bg-raised); border-bottom-left-radius: 5px; }
.msg.user {
  align-self: flex-end;
  background: var(--accent); color: #14150f;
  font-weight: 500; border-bottom-right-radius: 5px;
}
.msg.err { align-self: flex-start; background: #2b1618; color: #ffb4ad; border: 1px solid #4a2226; border-bottom-left-radius: 5px; }
.msg p { margin: 0 0 8px; }
.msg p:last-child { margin-bottom: 0; }
.msg ul { margin: 6px 0; padding-left: 18px; }
.msg li { margin: 3px 0; }
.msg strong { font-weight: 700; }
.msg.bot strong { color: var(--accent); }

.typing { display: flex; gap: 4px; padding: 4px 2px; }
.typing i {
  width: 6px; height: 6px; border-radius: 50%; background: var(--muted);
  animation: blink 1.3s infinite ease-in-out;
}
.typing i:nth-child(2) { animation-delay: .18s; }
.typing i:nth-child(3) { animation-delay: .36s; }
@keyframes blink { 0%, 60%, 100% { opacity: .25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }

.chips { display: flex; flex-wrap: wrap; gap: 7px; padding: 4px 16px 12px; }
.chip {
  border: 1px solid var(--line); background: rgba(255,255,255,.03);
  color: var(--text); font: inherit; font-size: 12.5px;
  padding: 7px 12px; border-radius: 99px; cursor: pointer;
  transition: border-color .15s, background .15s, color .15s;
}
.chip:hover { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.composer {
  display: flex; align-items: flex-end; gap: 8px;
  padding: 12px 12px 10px;
  border-top: 1px solid var(--line);
  background: #0d0f13;
}
textarea {
  flex: 1; resize: none;
  background: var(--bg-input); color: var(--text);
  border: 1px solid var(--line); border-radius: 12px;
  padding: 10px 12px;
  font: inherit; font-size: 14.5px; line-height: 1.45;
  max-height: 110px; min-height: 42px;
  transition: border-color .15s;
}
textarea::placeholder { color: #6e7683; }
textarea:focus { outline: none; border-color: var(--accent); }
.send {
  width: 42px; height: 42px; flex: none;
  border: 0; border-radius: 12px; cursor: pointer;
  background: var(--accent); color: #14150f;
  display: grid; place-items: center;
  transition: opacity .15s, transform .12s;
}
.send:hover:not(:disabled) { transform: translateY(-1px); }
.send:disabled { opacity: .35; cursor: not-allowed; }
.send:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.send svg { width: 18px; height: 18px; }

.foot { padding: 0 14px 10px; font-size: 10.5px; color: #5f6673; text-align: center; }

@media (max-width: 480px) {
  .wrap { bottom: 16px; ${cfg.position}: 16px; }
  .panel {
    position: fixed; inset: 0;
    width: 100vw; height: 100dvh;
    border-radius: 0; border: 0;
    transform-origin: center;
  }
  .wrap.open .launcher { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  *, .panel, .msg, .launcher { animation: none !important; transition: none !important; }
}
`;

  // ------------------------------------------------------------------ markup

  var ICON_CHAT = '<svg class="chat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.7-.7L3 21l1.9-5A8.2 8.2 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  var host = document.createElement('div');
  host.id = 'ironclad-chat';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' + CSS + '</style>' +
    '<div class="wrap" part="wrap">' +
      '<div class="panel" role="dialog" aria-modal="false" aria-label="' + esc(cfg.title) + ' chat">' +
        '<div class="header">' +
          '<div class="avatar" aria-hidden="true">IF</div>' +
          '<div class="htext">' +
            '<div class="htitle">' + esc(cfg.title) + '</div>' +
            '<div class="hsub"><span class="dot"></span>' + esc(cfg.subtitle) + '</div>' +
          '</div>' +
          '<button class="x" type="button" aria-label="Close chat">' + ICON_X + '</button>' +
        '</div>' +
        '<div class="log" role="log" aria-live="polite" aria-atomic="false"></div>' +
        '<div class="chips"></div>' +
        '<form class="composer">' +
          '<textarea rows="1" placeholder="Ask about hours, classes, pricing..." aria-label="Your question" maxlength="2000"></textarea>' +
          '<button class="send" type="submit" aria-label="Send message" disabled>' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12h14M12.5 5.5 19 12l-6.5 6.5"/></svg>' +
          '</button>' +
        '</form>' +
        '<div class="foot">Answers are AI-generated. Call the gym to confirm details.</div>' +
      '</div>' +
      '<button class="launcher pulse" type="button" aria-label="Open chat" aria-expanded="false">' + ICON_CHAT + ICON_X + '</button>' +
    '</div>';

  var $ = function (sel) { return root.querySelector(sel); };
  var wrap = $('.wrap');
  var panel = $('.panel');
  var launcher = $('.launcher');
  var log = $('.log');
  var chips = $('.chips');
  var form = $('.composer');
  var input = $('textarea');
  var sendBtn = $('.send');

  // ------------------------------------------------------------------ render

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * Escape first, then add the handful of tags we allow. The model is told to
   * emit plain text with * bullets and **bold**, so nothing richer is needed --
   * and anything it does emit can no longer become markup.
   */
  function render(text) {
    var out = '';
    var list = null;

    esc(text).split('\n').forEach(function (line) {
      var bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        list = (list || '') + '<li>' + inline(bullet[1]) + '</li>';
        return;
      }
      if (list) { out += '<ul>' + list + '</ul>'; list = null; }
      if (line.trim()) out += '<p>' + inline(line) + '</p>';
    });

    if (list) out += '<ul>' + list + '</ul>';
    return out || '<p></p>';
  }

  function inline(s) {
    return s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  function nearBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 90;
  }

  function scroll(force) {
    if (force || nearBottom()) log.scrollTop = log.scrollHeight;
  }

  function bubble(kind, html) {
    var el = document.createElement('div');
    el.className = 'msg ' + kind;
    el.innerHTML = html;
    log.appendChild(el);
    scroll(true);
    return el;
  }

  function showChips(items) {
    chips.innerHTML = '';
    if (!items || !items.length) return;
    items.forEach(function (q) {
      var b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.textContent = q;
      b.addEventListener('click', function () { send(q); });
      chips.appendChild(b);
    });
  }

  // ------------------------------------------------------------------- state

  function setOpen(next) {
    open = next;
    wrap.classList.toggle('open', open);
    launcher.classList.remove('pulse');
    launcher.setAttribute('aria-expanded', String(open));
    launcher.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');

    if (!open) return;
    if (!log.children.length) {
      bubble('bot', render(greeting));
      showChips(suggestions);
    }
    if (!matchMedia('(max-width: 480px)').matches) input.focus();
    scroll(true);
  }

  function setBusy(next) {
    busy = next;
    sendBtn.disabled = busy || !input.value.trim();
    input.disabled = busy;
  }

  // -------------------------------------------------------------------- chat

  async function send(text) {
    text = (text || '').trim();
    if (!text || busy) return;

    chips.innerHTML = '';
    input.value = '';
    input.style.height = 'auto';
    bubble('user', render(text));
    history.push({ role: 'user', content: text });
    setBusy(true);

    var holder = bubble('bot', '<div class="typing"><i></i><i></i><i></i></div>');
    var answer = '';
    var painting = false;

    function paint() {
      if (painting) return;
      painting = true;
      requestAnimationFrame(function () {
        painting = false;
        holder.innerHTML = render(answer);
        scroll();
      });
    }

    function fail(msg) {
      holder.className = 'msg err';
      holder.innerHTML = render(msg);
      scroll(true);
    }

    try {
      var res = await fetch(cfg.api + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Trim to the last 12 turns so a long session can't outgrow the
        // server's cap. The system prompt carries all the facts anyway.
        body: JSON.stringify({ messages: history.slice(-12) }),
      });

      if (!res.ok || !res.body) {
        fail(
          res.status === 429
            ? "You're asking faster than I can answer -- give me a few seconds."
            : "Sorry, I couldn't reach the front desk. Please try again in a moment."
        );
        history.pop();
        return;
      }

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var errored = false;

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        // SSE frames are separated by a blank line; a frame may straddle chunks.
        var frames = buffer.split('\n\n');
        buffer = frames.pop();

        frames.forEach(function (frame) {
          var line = frame.split('\n').find(function (l) { return l.indexOf('data:') === 0; });
          if (!line) return;

          var evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch (e) { return; }

          if (evt.type === 'delta') {
            answer += evt.text;
            paint();
          } else if (evt.type === 'error') {
            errored = true;
            fail(evt.text);
          }
        });
      }

      if (errored) {
        history.pop();
      } else if (answer.trim()) {
        holder.innerHTML = render(answer);
        history.push({ role: 'assistant', content: answer });
        scroll();
      } else {
        fail("Sorry, I didn't catch that. Mind asking again?");
        history.pop();
      }
    } catch (err) {
      fail("Sorry, I couldn't reach the front desk. Please try again in a moment.");
      history.pop();
    } finally {
      setBusy(false);
      if (!matchMedia('(max-width: 480px)').matches) input.focus();
    }
  }

  // ------------------------------------------------------------------ events

  launcher.addEventListener('click', function () { setOpen(!open); });
  $('.x').addEventListener('click', function () { setOpen(false); launcher.focus(); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    send(input.value);
  });

  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 110) + 'px';
    sendBtn.disabled = busy || !input.value.trim();
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input.value);
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && open) { setOpen(false); launcher.focus(); }
  });

  // Pull the greeting and starter questions from the server when it offers
  // them; the hardcoded defaults above cover the case where it doesn't.
  fetch(cfg.api + '/api/config')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data) return;
      if (data.greeting) greeting = data.greeting;
      if (Array.isArray(data.suggestions) && data.suggestions.length) suggestions = data.suggestions;
    })
    .catch(function () { /* defaults are fine */ });

  document.body.appendChild(host);
  if (cfg.startOpen) setOpen(true);
})();
