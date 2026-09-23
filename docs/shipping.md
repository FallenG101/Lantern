# Shipping

Before you ship, and the rules that protect the data

Part of Lantern's notes — see [`NOTES.md`](../NOTES.md) for where things stand and what is still open.

---

## Security model

Everything is same-origin-guarded in `Handler.guard()`. This was added after
proving a real hole: a cross-origin `POST` with `Content-Type: text/plain` needs
no CORS preflight and went **straight through** — any website you visited while
Lantern ran could have deleted your Ollama models or pulled huge ones.

The guard rejects: a non-loopback `Host` (DNS rebinding), `Sec-Fetch-Site:
cross-site` or `same-site`, and a non-loopback `Origin`. Requests with **no**
Origin still pass, so curl and scripts keep working. `OPTIONS` returns 403 with
no CORS headers, so preflights correctly fail.

Also in place: a 64 MB request-body cap, an allow-list on the options forwarded
to Ollama (it used to pass anything through to the runner), `observed_thinking`
bounded to 64 entries, and type-checked settings writes.

The optional OpenAI-compatible backend has a different fence: its URL must be
loopback HTTP with an explicit port and `/v1` suffix. The opener ignores proxy
environment variables and refuses redirects, so a local server cannot forward
Lantern's prompts or optional local API key to a remote endpoint by redirecting.
See [`backends.md`](backends.md) for the protocol adapter and limitations.

**That last one was a real outage.** `PUT /api/settings` accepted any type;
writing `default_params: "nope"` made the *next read* throw, so `/api/bootstrap`
500'd and the app would not start until the file was repaired by hand. Writes
now type-check against the defaults and reads ignore a malformed value.

**`safeUrl()` had a real XSS.** It tested the scheme against the raw text, but
`escapeHtml()` has already turned `&` into `&amp;` — so
`[x](java&#9;script:alert(1))` did not read as `javascript:`, passed, and went
into the `href` intact. The HTML parser then decoded `&#9;` to a tab, and the URL
parser **strips** ASCII tab and newline before deciding the scheme:
`java<TAB>script:` becomes `javascript:`, running in Lantern's own origin, which
can read every chat through the API.

It now decodes one level of character references and drops what a URL parser
ignores *before* testing. One level is the right depth — it matches the HTML
parser, so `&amp;#9;` stays inert on both sides (verified: resolves as a relative
`http:` path). Tested against decimal, hex and named tab/newline entities, a
leading control character, mixed case, `data:` in an image, and double encoding;
query strings, relative paths and `mailto:` pass through untouched.

**The lesson: sanitise against the string the browser will act on, not the one
you are holding.**

**Every `innerHTML` sink was audited before going public**, since a public repo
raises the cost of a hole. The result, and the shape to preserve:

- Message bodies go through `renderMarkdown()` or `escapeHtml()` — both paths
  sanitise, neither can be reached with raw text.
- Icon assignments are module constants (`svg(ICON.x)`), never data.
- **Every name a user or model controls is rendered with `text:`, not `html:`** —
  chat titles, persona names, tool names, and the prompt-library names added in
  0.9.5. `el()`'s `html:` option is only ever handed static markup.
- The one exception was the bootstrap failure screen, which interpolated
  `err.message` into `innerHTML`. Not realistically attacker-controlled, but it
  was the single place a dynamic string reached a sink unescaped, so it is built
  from nodes now.

**If you add a sink, the rule is: `text:` for anything a person or a model can
influence.**

**Micro-optimising the renderer is not worth it — measured.** `highlight()` now
caches its keyword `Set` and compiled regex per language, worth **0.009 ms per
code block (~0.27 ms on a 30-block thread)**. A single-pass `escapeHtml()` is
2.18× faster but saves **0.23 ms per 3,000 tokens**, so it was left alone — it is
the XSS boundary, and that is a bad trade for a fifth of a millisecond. The costs
that actually mattered (re-parsing the buffer while streaming, re-rendering per
tool round) are handled elsewhere. Don't come back here looking for speed.

**Frame callbacks do not fire on an occluded window, and that broke the sliding
lens.** The segmented controls in Settings place their indicator by measuring the
active button, which cannot happen before the control is in the document. The
first attempt deferred that to `requestAnimationFrame`, retrying until widths
existed — which on a window producing no frames is an unbounded loop that never
succeeds. The Density control opened with no indicator at all; Message width only
looked right because it had been clicked. A `ResizeObserver` fails the same way,
being equally frame-driven. `openModal()` now calls `placeLens()` once the dialog
is on screen: a synchronous layout read at the one moment the answer is knowable.
**If placement depends on layout, do it when you know layout exists — not on a
callback that assumes the window is visible.**

**`content-visibility: auto` on `.msg`** skips layout and paint for messages
scrolled out of view, with `contain-intrinsic-size` holding a placeholder height
so the scrollbar does not jump. The last message is exempted — it is the one
streaming, and skipping its paint would stall the tokens.

**It also makes `innerText` return empty for skipped messages**, which will
mislead anyone testing through the DOM: a thread of real messages reports 0
characters each. Nothing in the app is affected, because every consumer reads
`message.content` rather than the DOM — find-in-chat walks *text nodes*, which
are unaffected. But assert against the data model, not `innerText`, or you will
diagnose a bug that does not exist.

**Visual settings apply optimistically.** `patchSettings()` awaits the server
before updating `S.settings`, so calling `applyTheme()` straight after it
repainted with the *previous* value — every theme/accent/size pick appeared to
need a second click. `applyVisual()` in `modals.js` mutates the local copy
first, repaints, then persists. Use it for anything that changes appearance.

## Data safety — read this

Chats are plain JSON in `~/Library/Application Support/Lantern/chats/`. Writes
are atomic (temp file + `os.replace`).

**During development the chat folder was found empty once and had to be restored
from a backup.** The cause was never identified. Two separate incidents also
required hand-repair: the settings corruption above, and a probe that renamed a
real chat. Treat the data folder as precious:

- Take a backup before any session that touches storage — Settings →
  *Back up everything*, or `GET /api/backup`.
- `POST /api/restore` defaults to **merge**, which never overwrites an existing
  chat. `mode: "replace"` deletes everything first. Keep merge the default.
- Never run a cleanup that deletes by `message_count == 0` against real data
  without checking what it matched first.

## Before you ship — click everything

Three bugs survived a code review *and* a targeted bug pass because every check
was aimed at newly-written code and nobody operated the app. All three are
visible within seconds of *using* it, and none look wrong when read:

- **Stop never worked; Esc always did.** Wired as `addEventListener('click',
  stopGeneration)`, and `stopGeneration(chatId = S.chat?.id)` takes a chat id — a
  listener passes the click Event, so the Event *was* the argument (a default only
  applies to `undefined`) and `S.runs.get(MouseEvent)` missed. Esc calls it with
  no arguments. **Never hand a function with optional parameters to
  `addEventListener`.**
- **The theme button was the one place bypassing `applyVisual()`**, so it
  repainted before `S.settings` updated: dark → light did nothing, and light
  arrived one click late, on the click selecting `system`.
- **A menu over the sidebar is a stacking-context problem, not a z-index one.**
  `.menu` had `z-index: 60`, but it lives in `.main` (`z-index: 1`) and
  `.sidebar` is a sibling at `2` — a child cannot escape its parent's stacking
  context, so no value would have worked. It now reparents to `<body>` while open
  (as `popupMenu()` in `chat.js` already did) and returns home on close, since the
  ⋮ button opens the same node as an anchored dropdown. Measure before clamping,
  and clear `right`: `#chat-menu` is `.menu-right`, so `left` *and* `right: 0`
  stretches it to the viewport edge.

So: before a build or a release, actually click these. Two minutes.

- [ ] **Send** a message; **Stop** mid-reply (button *and* Esc — they take
      different code paths)
- [ ] Theme button three times: dark → light → system, each changing immediately
- [ ] Right-click a chat row — menu appears **at the cursor and above** the
      sidebar
- [ ] ⋮ chat menu still opens anchored under the button
- [ ] Model and persona pickers in the topbar; Think and Tools **under the
      composer** — each opens, and both caret menus open *upward* and stay on
      screen. A bottom-anchored menu that opens downward is invisible
- [ ] On a scratch data folder, select an OpenAI-compatible local runner in
      first run and in Settings; verify model refresh, a streamed reply, a tool
      round, title generation, and switching back to Ollama. A runner that
      rejects tools must still answer without them and show a warning
- [ ] A chat whose model exists only on the previous backend is retained but
      clearly asks for a new model before sending; a new/empty chat picks an
      available model. Reject non-loopback endpoints and remote redirects
- [ ] Tools on: ask the time in another timezone; expand the tool row
- [ ] **URL reader** (Settings → Behaviour → *Let the model read web pages*):
      paste a real link and ask about it, then ask it to read a URL that does
      not resolve. The failure must end the turn with an answer, not a spinner
- [ ] ⌘K palette, ⌘F find (step with ⏎), ⌘⇧F search all chats
- [ ] New chat, rename, pin, archive, duplicate, branch, delete
- [ ] Regenerate, edit-and-resend, delete a message
- [ ] **Compare a reply that is *not* the last one**, page between the answers,
      open the side-by-side view — then compare it again and **Stop** before the
      first token. The turn must come back unchanged and the messages after it
      must still be there. Every comparison bug hid behind "compare the last
      reply", which is the only case anyone tests by hand
- [ ] Settings: an accent, a theme, text size — each applies on the first click
- [ ] Export markdown + JSON, and **back up everything**
- [ ] **Full reset**, against a scratch `LANTERN_DATA` and never your own:
      the counts are right, the button stays dead until the word is typed,
      and the reload lands on the first-run flow
- [ ] `/usr/bin/python3 -m py_compile server.py`
- [ ] `python3 -m unittest tools.test_openai_backend -v`
- [ ] **Check `lantern.log` is empty.** A shipped app writing tracebacks looks
      broken even when it is fine — that is how the disconnect noise was found
- [ ] **Docs pass.** Does `README.md` still describe what the app does? Does this
      file have the new traps? Is anything in `CONTRIBUTING.md` now untrue? Every
      feature or major change owns its documentation — README has shipped wrong
      **six** times: a stale model name, a claim that Lantern never sent tools
      which survived a whole release, the line count **three** times, and an
      accent count that said nine when there have been twelve for months.
      **The pattern is countable things.** Vague wording does not fix it — the
      line count was softened to "under N lines" and was wrong again at the next
      release, because nobody re-counts prose. Anything of the form *"N of X"* in
      the README either needs a check in `tools/lint.py` or should not be a
      number at all
- [ ] **First run**, against an empty `LANTERN_DATA`: the flow appears, the
      model you pick is the one the open chat uses, and it does *not* appear
      again on reload. Then point at a folder with chats and confirm it stays
      away — greeting an existing user is the failure that matters
- [ ] Tools on: ask a model to roll dice. The row must show every die, and the
      reply must not state a number the tool did not return
- [ ] A saved prompt with `{{blanks}}` asks for them; one without goes
      straight into the composer as it always did
- [ ] **Continue**: set `num_predict` low enough to truncate a reply, press
      Continue, and check the answer *grows in one message* rather than the
      thread gaining a second one. Then a normal reply: no button at all
- [ ] Reload with a reply in flight; switch chats mid-reply

Also run:

```bash
python3 tools/lint.py
```

**The lesson worth generalising:** verify the *trigger*, not just the mechanism.
The Stop abort path was traced and found correct; the button that called it was
never clicked. And this file already held the answer to the theme bug — a rule
written here is worth nothing if nothing checks the code against it. That is what
`tools/lint.py` is for: stdlib only, and every check in it maps to a bug that
really shipped. Run against the commit before those fixes it flags **both** the
Stop button and the theme button; run against `v1.0.3` it flags the "nine
accents" claim, five theme names the README never mentioned, and a line count
that was over its own stated bound. Add a check whenever a new trap costs real
time.

A first attempt at this was a plain `grep` for bare listeners. It matched all 20
of them, nearly all harmless, because a grep cannot see the target function's
signature — a check that cries wolf gets ignored, which is worse than no check.
The script correlates the listener with the function's parameter list instead.

**The best check for a fact is not writing it down twice.** This took two goes to
learn properly.

First attempt: check each count against its source. That caught the real "nine
accents" bug, but it had two holes. The line-count claim had been guarded since
0.9.5 and *still* went stale a third time, because the wording was softened from
"under 10,000 lines" to "about 10,000 lines of source" — which matched neither
pattern the check looked for, so it passed on a sentence it could not see. **A
check that matches one phrasing is a check you can edit your way out of by
accident.** And the count itself was wrong: `COUNTED_SOURCES` omitted
`build-app.sh` and `lantern`, hiding ~280 lines, so the README could claim "under
10,000" while `wc` said 10,044.

**It happened a third time, after that rule was written down.** The Layout-block
check required the code fence to sit immediately under `## Layout`. The README
rewrite put a sentence in between, the pattern stopped matching, and the check
went *silent* — taking a newly added `onboard.js` with it, which is exactly what
it exists to catch. Lint reported clean on a README missing a source file. It now
finds the fence anywhere in the section **and treats not finding it as a
failure**, the same fix as the line count. **When you write a check, ask what it
does when it matches nothing.** Twice now the answer has been "passes quietly".

Second attempt, and the one that ends it: **the README names things and never
counts them.** Every one of the six failures was a number restating something the
code already enumerates. Where the README lists the things, the list *is* the
count, so the number was pure redundancy carrying all of the risk. They are gone,
and `lint.py` now fails if one comes back — the ban is on the *number*, so unlike
a value check it cannot be beaten by rephrasing.

What stays: specs a reader acts on — the port, `num_ctx`, macOS 11, keyboard
keys. Those are not "how many X" claims, and the ones mirroring code are still
checked. Measurements stay too (the ~6s reload, the 14.6 GB two-model figure);
they are observations about a machine, not restatements of the source.

Names are the opposite case and are *encouraged*: every registered tool and every
theme label must appear in the README, checked for presence, so a rename is
caught. Naming is what a reader wanted from the number anyway.

Verified by reintroducing each retired claim against an extracted tree — accent,
theme, line, tool and persona counts all fail, the current README is clean, and
renaming a theme in `theme.js` is still caught. That is what the
`python3 tools/lint.py <dir>` argument is for. Deleting the count checks also
left `source_line_count()` and two constants dead, which were removed with them:
a lint script carrying code that can no longer fire is the same disease.

## Testing notes

- The in-app browser pane frequently reports `viewport 0x0`, which makes every
  layout measurement meaningless (a message once measured 164,514px tall).
  **Open a fresh tab and call `resize_window` before measuring**, and sanity-check
  `window.innerWidth` first.
- Screenshots render at a real size even when JS reports 0×0, so a screenshot is
  a valid cross-check when measurements look absurd.
- The headless browser uses overlay scrollbars and will not produce a
  space-taking one even when forced — scrollbar-related layout can't be tested
  here.
- `sendMessage()` awaits the whole stream. Don't `await` it in a test unless you
  want to block.
