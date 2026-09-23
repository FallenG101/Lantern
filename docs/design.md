# Design

How Lantern is built, and why

Part of Lantern's notes — see [`NOTES.md`](../NOTES.md) for where things stand and what is still open.

---

## Why the stack is what it is

**Python stdlib + vanilla ES modules, no dependencies, no build step.**

Node was not available in the OG enviroment

Consequences worth knowing:

- The markdown renderer, syntax highlighter, and LaTeX subset are all written
  from scratch in `static/js/markdown.js`. No CDN, no library. If you add one,
  you break the offline guarantee.
- `server.py` is deliberately kept **Python 3.9-compatible** so the app can fall
  back to the `/usr/bin/python3` that ships with macOS. Check with
  `/usr/bin/python3 -m py_compile server.py` before committing. No `match`,
  no `X | Y` at runtime (annotations are fine — `from __future__ import
  annotations` is on).
- The app icon is rendered procedurally by `tools/make_icon.py` — no Pillow.
  It is a cool ring around a warm core: the lantern reduced to light held in a
  housing. The earlier drawing had a handle, caps, tapered posts and a foot, and
  below ~48px those collapsed into a grey smudge — verified by rendering at 32px
  and magnifying, not by guessing. **Two shapes survive any size; seven do not.**
  The mark exists in three places that must change together — `make_icon.py`, the
  favicon data URI in `index.html`, and the empty-state `.empty-mark` SVG.
  Smooth gradients compress worse than flat black, so the `.icns` went from
  380 KB to 503 KB and is now half the bundle. That is the price of the glow;
  the alternative is banding.
- **The `tool` icon shipped broken from 0.9.0 to 1.0.1** and nobody noticed,
  because at 18px a wrong path still reads as *some* small grey mark. Magnified
  it was a blob with a stick out of one side and a slash floating beside it. Two
  causes, both worth knowing: `M14.5 6.5 17 4` is a moveto followed by an
  **implicit lineto** — a bare coordinate pair after `M` draws a line, it does
  not move again — and `M4 8l3 3` was simply a leftover subpath. It is one closed
  outline now. Like the app mark, it lives in **two** places that must change
  together: `ICON.tool` in `util.js`, and a hardcoded copy in the Tools pill in
  `index.html`. **Check an icon by rendering it at 48px, not by reading the
  path** — small marks hide their own defects.

## Naming

Named **Lantern** (was "Slate" for the first day). The rename touched the bundle
id, data folder, env vars, localStorage keys, and the icon. `LANTERN_DATA` falls
back to `SLATE_DATA`, and `migrate_legacy()` in `server.py` moves an old
`~/Library/Application Support/Slate` folder across on first run.

**Trap:** `build-app.sh` used to seed the data folder from `./data` on first
run, which created an empty `Lantern` folder *before* the app could migrate the
old one — orphaning the real history. The seed step is now guarded on the legacy
folder not existing. Don't remove that guard.

## Architecture notes

**Runs are bound to a chat object, never to the on-screen chat.** `S.runs` is a
`Map` keyed by chat id. This was a bug fix, not a design flourish: the original
code used a global `S.streaming` flag plus `S.chat`, so starting a reply in one
chat and then sending in another silently dropped the second message *and* wrote
the first chat's tokens and auto-title into the second. Anything touching
`runAssistant`, saving, or auto-titling must take an explicit `chat` argument.

**The streaming painter resolves its DOM node per frame** rather than capturing
it. Switching chats re-renders the thread, so a captured node goes stale and the
message stops updating. It also polls at 400 ms instead of every frame when its
chat is off-screen.

**Streaming markdown renders incrementally.** Re-parsing the whole buffer every
55 ms was O(n²) — a 20k-character reply did ~16M character operations. The
prefix up to the last blank line outside a code fence is cached; only the tail
is re-parsed. Measured 75.9% fewer character ops on a realistic 5.1k reply.
`renderThread()` does a full single-pass render with highlighting at the end,
which corrects any block a split happened to interrupt.

**Saves are debounced per chat id and the pending map holds the chat object.**
Resolving the chat later from `S.chat`/`liveChat` dropped writes for any chat
that was neither on screen nor streaming. Page teardown uses `sendBeacon` to
`POST /api/chats/{id}/save` — an async fetch cannot complete during unload.

**`route()`'s except clauses do not cover every connection error.** A client
hanging up mid-request raises `ConnectionResetError` inside
`handle_one_request` — while reading the request line, *before* the handler runs —
so socketserver's default `handle_error` printed a full traceback. The webview
drops keep-alive connections constantly, so `lantern.log` filled with stacks that
made a healthy app look like it was crashing. The `Server` subclass swallows
disconnect errors only; everything else still gets reported. Verified: ten abrupt
disconnects, zero tracebacks, server still serving.

**`VERSION` in `server.py` is the single source of truth.** `build-app.sh` `sed`s
it out to stamp `Info.plist`, and it is served by `/api/ping` and
`/api/bootstrap` for the About panel. It used to live only in `build-app.sh`,
which meant the shipped app could not tell you what version it was.

**The server caches parsed chat files** keyed by `(mtime_ns, size)`.
`list_chats()` and `search_chats()` walk every file and run on bootstrap, on
every save, and on every search keystroke. ~7× faster warm.

## There is no "no persona"

The picker used to offer `○ No persona — Raw model behaviour` *and* a seeded
`✨ Default` persona described as "No system prompt. Raw model behaviour." They
did exactly the same thing: both resolved to an empty system prompt, and
`buildPayloadMessages()` skips the system message when it is empty, so the
request was byte-identical. Two entries, same subtitle, same behaviour — someone
was going to ask which was which, and someone did.

`Default` survived because it is the more useful of the two: a persona is an
object that can also pin a model, a thinking setting and sampling overrides, so a
blank persona is something you can fill in. A null was something you could only
leave empty.

**Nothing on disk changed, which is the point.** `currentPersona()` treats an
unset *or dangling* `persona_id` as "use the default", falling through to the
global default persona, then to the first one, then to null only when every
persona has been deleted — where no system prompt is sent, exactly as before.
Chats keep `persona_id: null` in their files and open unchanged in an older
Lantern. A dangling id used to show "No persona"; it now resolves, which is a
small fix that came free.

Verified: a chat written with `persona_id: null` and one pointing at a deleted
persona both show `Default`, the file still reads `null`, and the request sent to
Ollama contains no system message.

## The 1.0 compatibility promise

1.0 is not "feature complete" — it is **"ready for strangers"**. The thing a
version number now commits to is not an API, because there is no public API. It
is **the chat JSON on disk**:

- **Add fields, never repurpose or remove them.** `tools`, `variants` and
  `variant` were all added after chats already existed, and old files keep
  loading because every consumer defaults when a field is absent. That is the
  pattern to keep.
- **Never require a migration for something a user could lose.** Chats have gone
  missing twice. A format change that needs a rewrite pass is a format change
  that can destroy history halfway through.
- A file written by a newer Lantern should still open in an older one, degraded
  rather than broken. Unknown fields are ignored, not fatal.

Everything else — the HTTP endpoints, the module layout, the CSS — is internal
and may change freely.

## Windows and Linux — audited, not tested

**The app was already portable and nobody had noticed.** `server.py` is 2,200
lines with no macOS in it at all: no POSIX-only imports, no POSIX-only `os`
calls, no hardcoded Unix paths, every filesystem path through `pathlib`, and it
does not start either model server — it only reports whether the selected one is
reachable. The front
end has had `MOD = isMac ? '⌘' : 'Ctrl+'` since the beginning.

Everything macOS-only is **packaging**, about 785 lines of it: `main.swift`,
`build-app.sh` and the `lantern` bash launcher. None of it is the app.

So the browser path costs almost nothing, and `lantern.cmd` mirrors the bash
launcher — `%APPDATA%\Lantern` for history, start Ollama if it is selected and
nothing answers. OpenAI-compatible local servers are started in their own runner.

Two things the audit turned up:

- **An em-dash in a `print()`.** Only reachable with `--host` off loopback, but a
  legacy Windows code page can raise `UnicodeEncodeError` on it when stdout is
  redirected. That line is ASCII now.
- **`watch_parent()` is opt-in** via `LANTERN_WATCH_PARENT`, set only by the
  native host, so the reparenting watchdog never starts elsewhere. Just as well:
  Windows does not reparent orphans, so it would never fire anyway.

**The one real platform difference, and it is tested.** `static()` builds a
filesystem path from a URL path, and on Windows `pathlib` treats a **backslash**
as a separator — so `/..\..\..\Windows\win.ini` is a traversal shape that simply
does not exist on macOS, where a backslash is an ordinary filename character.

That did not need a Windows machine to check: `ntpath` and `PureWindowsPath`
import fine on macOS, so the whole of `static()`'s path handling was replayed
under Windows semantics. Backslash traversal, mixed traversal and a
`static\..\..` escape all resolve outside `STATIC` and are refused by the
existing `is_relative_to()` guard; normal assets still resolve inside. The guard
holds because it compares resolved path *objects* rather than strings.

**Simulating the semantics is not the same as running the platform**, and the
distinction is worth keeping straight: the traversal guard is verified, the app
launching on Windows is not.

**Why it says "untested" in the README rather than "supported".** The whole
discipline here is verify-by-running, and three bugs shipped because code was
read and the app was never operated. Claiming a platform nobody has launched
would be that failure at its largest — a promise to strangers on a machine we
have never seen. The README already carried an unqualified "On Linux and Windows,
`Ctrl` replaces `⌘`", written long before any of this; it is qualified now.

**There is nothing to separate, and that is the design.** Source-only
distribution means a release ships **zero binaries** — it is a git tag, and every
platform clones the same tree. So there is no "Windows build" sitting beside a
"Mac build" that could drift apart. There is one app, and per-platform *starting*:

| | how it starts | history lives in |
|---|---|---|
| macOS | `build-app.sh` → `Lantern.app`, or `./lantern` | `~/Library/Application Support/Lantern` |
| Linux | `./lantern` | `${XDG_DATA_HOME:-~/.local/share}/lantern` |
| Windows | `lantern.cmd` | `%APPDATA%\Lantern` |
| anywhere | `python3 server.py --open` | `./data` |

The asymmetry is the point: macOS has a *build*, everywhere else has no build
step at all. Resisting the urge to add one — a `platform/` directory, a
cross-platform build script, per-OS release assets — is what keeps this from
becoming a packaging project. Three launchers named after their platforms is
enough separation for three platforms; revisit it at ten.

**Trap found doing this:** `lantern` hardcoded
`$HOME/Library/Application Support/Lantern`. It is a *bash* script, so Linux
reaches it too, and it would have silently created a `~/Library` tree on a Linux
box — the sort of thing nobody notices until their chats are in two places. It
picks by `uname` now, and the macOS branch is byte-identical so no existing data
moves.

A native Windows window stays unbuilt until someone asks. It is a second native
surface to maintain — the reasoning that cut the global hotkey — and unsigned
Windows binaries hit SmartScreen, which is the same problem as macOS quarantine
and has the same answer: build it yourself.

## UI notes

The refresh is expressive shape and motion with **translucency limited to the
chrome**. Every `backdrop-filter` target (sidebar, topbar, composer, menus,
modals, toasts) sits *outside* the scrolling thread in normal flow, so nothing
moves behind them and the blur never recomposites while scrolling. The message
list is deliberately flat. Keep it that way.

### The send-button saga — four separate causes

Worth reading before touching the composer, because each looked like the same
symptom:

1. **Asymmetric padding** — `5px` right vs `5px + 2px margin` bottom.
2. **Height mismatch** — a 38px textarea against a 34px button meant their
   centres could never align when bottom-aligned. Both now derive from
   `--composer-line: calc(1.6 * var(--fs) + 10px)` so they track the text size.
3. **Non-concentric radii** — a 20px composer corner with a 7px button corner
   makes the gap swell from 7px at the edges to 10px on the diagonal. Inner
   radius must be `outer - gap`; that's `--composer-r`.
4. **The actual complaint** — the arrow sat 5px right of centre *inside its own
   square*. `.btn-send` inherited `padding: 9px 13px` from `.btn` and never
   reset it; with `box-sizing: border-box` that left an 8px content box for an
   18px icon, and **an overflowing grid item clamps to the start edge instead of
   centring**. `.btn-attach` had `padding: 0` all along, which is why it looked
   fine and the send button didn't.

Lesson: when a control uses `display: grid; place-items: center`, always reset
padding explicitly. And measure the *child inside the button*, not just the
button inside its parent.

Also fixed: `scrollbar-gutter: stable both-edges` on `.scroll`. Styling
`::-webkit-scrollbar` opts out of macOS overlay scrollbars, so on a Mac set to
"Show scroll bars: Always" the bar takes real width and shifts the centred
thread 5.5px against the composer. Not reproducible on this machine
(`AppleShowScrollBars = WhenScrolling`), so it is reasoned, not verified.

## UI redesign — landed, with optional polish left

A second visual pass, driven by two references the user supplied: an iOS "Liquid
Glass" tab bar and the Gemini app. The substance of it shipped in 0.9.5; what is
left is polish nothing depends on.

Landed:

- **Ambient wash** (`.app::before`) — accent-hued colour bleeding from the top
  and falling to near-black, Gemini-style. Three static radials, painted once,
  no animation, no repaint cost.
- **The lens** (`.lens` + `moveLens()` in `main.js`) — a refractive slug that
  slides onto the active chat row instead of each row carrying its own
  background. `backdrop-filter` with raised brightness/saturation, plus paired
  cyan/magenta edge glows for the chromatic fringing, and inset highlights for
  the bevel. One blurred surface for the whole list, moved by transform.
  **Trap:** `renderSidebar()` clears the list with `textContent = ''`, which
  destroys the lens — `moveLens()` re-creates it if missing. Don't "optimise"
  that away.
- **Pill group + satellite** — toolbar controls ride in one capsule with the
  overflow menu detached as its own circle, mirroring the tab bar reference.
  The topbar itself is now transparent so the wash shows through.
- **The segmented controls in Settings take the same lens** — one indicator moved
  by transform rather than a background on each button, so the travel is
  composited instead of repainted. `box.placeLens()` in `modals.js`, called by
  `openModal()` once the dialog is on screen; the frame-callback trap that cost
  real time getting there is under *Architecture notes*.

Themes: `dark` (Lantern), `midnight`, `cyber`, `carbon` are dark; `light`
(Paper) and `mist` are light; plus `system`. Defined in `THEMES` in `theme.js`
and as `[data-theme=...]` blocks in the CSS. **A theme block must only set the
surface palette, never `--accent`** — that is what keeps all 12 accents working
on every theme. Verified: neon accent resolves on top of cyber.

Menus, modals, palette and toasts use `--panel` (97-98% opaque), not
`--glass-deep`. Blur alone did not make them readable over a busy thread, and
raising opacity let the blur drop from 28-34px to 14px, which is cheaper.

All three of the remaining polish items landed in 1.2.4: the wash is bolder near
the top, the send button took the lens treatment, and the light themes were fixed
properly — see below.

**A light theme is more than a palette, and Mist proved it.** The syntax colours,
the lens, the modal overlay and a couple of tag colours all have to flip, and
those overrides were keyed on `[data-theme="light"]`. So Paper got them and
**Mist — the other light theme — silently inherited dark syntax highlighting on a
near-white background**. Measured rather than guessed: its keyword colour was
`rgb(192,132,252)`, a pale lavender meant for a dark surface, against Paper's
`rgb(124,58,237)`.

`applyTheme()` now sets `data-light` from `isDarkTheme()`, and the fourteen
overrides are keyed on that. Mist is fixed, and every future light theme is
correct by construction rather than by remembering. That mattered immediately:
Sepia was added in the same pass and needed nothing.

**Three themes joined in 1.2.4** — Ember (warm dark), Void (true black, so an
OLED panel actually switches pixels off), and Sepia (warm light). Each sets only
the surface palette, never `--accent`, which is what keeps every accent working
on every theme.

**The interface copy counts things too.** Settings described the palette as "Four
dark, two light" while there were six and three. `tools/lint.py` now bans palette
counts in `modals.js` as well as the README — scoped to the palette nouns, because
applying the README's full list flagged "comparing two prompts" in the seed help
text, which is prose about a workflow rather than a count. A check that cries
wolf gets ignored.

## `writingsuggestions="off"` on the composer

macOS Writing Tools puts an Apple Intelligence glyph inside editable fields, and
it appeared in the composer — the system drawing into our textarea, not anything
Lantern renders. The composer is the only `<textarea>` and the only field with
`spellcheck="true"`; search, find and the palette are single-line inputs with
spellcheck off, and were never affected.

The attribute suppresses it (WebKit, Safari 18+). **Don't delete it wondering
what it does.** The trade is deliberate: no Siri glyph and no inline prediction
ghosting over the prompt you are composing, at the cost of losing Writing Tools
inside Lantern. Anyone who wants it back has it system-wide in System Settings →
Apple Intelligence & Siri.

## LaTeX subset

Deliberately not a TeX engine. Covers what chat models actually emit:
variables, `\frac`, `^`/`_`, `\sqrt`, `\text`, and ~90 symbols. Unknown commands
render as their own literal text rather than vanishing, so a miss degrades to
"readable" instead of silent data loss.

**Blockquote lazy continuation — fixed in 1.0.** `renderMarkdown()` absorbed any
non-blank line after a `>` line, so a fence, heading or list written directly
under a quote rendered *inside* it. GFM ends the quote there, because lazy
continuation carries **paragraph text only**. `opensBlock()` is the guard.

It was deferred four times because it changes how existing chats render, so it
was landed with a test covering both directions: fence, heading and list under a
quote now render as siblings, while lazy paragraph continuation and multi-line
quotes are byte-for-byte unchanged. **Re-run those six cases if the blockquote
branch is ever touched** — the risk is not breaking the fix, it is silently
breaking continuation.

**Orphan closing tags are stripped at display time.** `gemma-4-E4B` at Q4_0 ended
a reply with a bare `</blockquote>`, which renders as visible literal text and
reads like a Lantern bug. It is not: reproduced against Ollama **directly**, with
none of this code in the path, appearing on one sample and not the next from an
identical prompt. Small heavily-quantised models emit junk tokens.

Two things worth keeping straight. The model, asked about it, confidently
explained it as "an artifact from the underlying templating process" — a
confabulation, since it cannot introspect its own sampling. **A model's account
of its own behaviour is not evidence**; the reproduction was. And the stripping
is display-only, deliberately narrow:

- It runs inside `inline()` *after* inline code is placeholdered, and fenced
  blocks never reach `inline()` at all — so `</div>` in code survives, which is
  where anyone legitimately discussing HTML puts it.
- A closer with a matching opener anywhere in the block is left alone.
- Stored content is never modified. Turning off *Render markdown* shows exactly
  what the model wrote.

Tested both directions: the stray closer goes; inline code, fenced code, balanced
markup, `a < b and b > c`, and a mixed case keeping `<b>bold</b>` while dropping a
lone `</em>` all behave. **Re-run those if this is touched** — the risk is not
failing to strip, it is eating something real.

### Known divergences, found by review and deliberately left

- Python decorators are not highlighted: the `\b` in `\b([A-Za-z_$@#][\w$]*)\b`
  cannot match before `@` at the start of a line.
- `codeBlock()` emits `data-code-id` and burns a `codeSeq` counter that nothing
  reads — copying uses `.code-raw`.
- `inline()` ends with a no-op `.replace(/\n/g, '\n')`, and its step comments
  number 1,2,3,4,3,4,5,6.

`$...$` detection has a heuristic guard so `"It costs $5 and $10"` is not eaten
as maths: the body must contain a maths signal (`\ ^ _ { } = < >`) or be ≤3
characters. Escaped `\$` never reaches it — the backslash-escape pass runs
first.
