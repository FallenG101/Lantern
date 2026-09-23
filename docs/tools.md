# Tools

Tool calling, the two network paths, and the capability traps.

Part of Lantern's notes — see [`NOTES.md`](../NOTES.md) for where things stand and what is still open.

---

## The thinking-capability trap (important)

Ollama under-reports which models can reason, in **both** directions:

- `/api/tags` claimed `qwen3.5-9b` was `["completion"]` only.
- `/api/show` correctly reports `['tools','thinking','completion']` for it.
- `gemma-4` reports only `["completion","vision"]` — yet honours `think`
  completely (verified: 997 characters of reasoning).

So Lantern does three things, all deliberate:

1. Reads capabilities from `/api/show`, never `/api/tags`.
2. For a model that does **not** advertise thinking, it **omits** the `think`
   field entirely rather than sending `think:false`. Sending `false` suppresses
   the very output needed to discover the model can reason.
3. When such a model emits `thinking` anyway, the name is recorded in
   `settings.observed_thinking` and the toggle appears from then on. Those
   models show `THINK*` instead of `THINK`.

Reasoning **effort** levels (low/medium/high) cannot be detected per model —
Ollama exposes nothing. They are offered for every thinking-capable model;
models built for it honour the string, others treat any level as plain "on".
This is stated in the in-app guide. Don't try to "fix" it with detection.

## Tool calling

`current_datetime`, `search_chats`, `calculate` and `read_url` ship. Adding one
is a single entry in `TOOLS` — the loop, the UI and the round cap need no
changes. A tool may carry a `gate` naming a setting, in which case it is invisible
until that setting is on; `read_url` is the only one so far, and *The URL reader*
below is why.

**The calculator is the one tool where a mistake is arbitrary code execution**,
because it evaluates a string the *model* wrote. Three rules hold it:

1. **Never `eval()`, and never `compile()` the parsed tree either.** `ast.parse`
   produces the tree; `_calc_eval` walks it by hand. There is no path from input
   to the interpreter at all.
2. **Whitelist node types.** Attributes, subscripts, lambdas, comprehensions and
   anything else are refused by default, so a future Python syntax feature cannot
   quietly become reachable. `(1).__class__` and
   `().__class__.__bases__[0].__subclasses__()` both die on the Attribute check.
3. **Bound the work.** Arbitrary-precision ints make `9**9**9` a hang rather than
   an error, so exponents are capped at 256 and nesting depth at 25.

Tested: 14 correctness cases and 19 hostile ones — `__import__`, `open`,
`__subclasses__` traversal, `exec`, `eval`, `globals`, comprehensions, lambdas,
huge powers, bare names, statements. Zero leaks. **Re-run those if the evaluator
is ever touched.**

**A verified tool does not make the model's prose true.** Asked for
`4871 × 3928 ÷ 7`, qwen called `calculate` with the whole expression, got the
right answer — and then stated the intermediate product as 19,135,088 when it is
19,133,288, a figure it never asked for and which contradicts its own tool
result. Adding "call it for every number you intend to state, including
intermediate steps" to the description improved the framing but did **not** stop
it. Tuning prompt text further against one model is not worth it; the real
mitigation is already in the design — every call is rendered with its exact
arguments and result, so a wrong claim is checkable against what actually ran.
Say so in the README rather than implying tools make answers trustworthy.

**`search_chats` needed different search semantics from the UI, and only an
end-to-end model test showed it.** The tool reuses `search_chats()`, which
matches the query as a **literal substring** — correct for ⌘⇧F, whose
highlighting depends on exact spans. But models ask in phrases. Given "what did
I conclude about ingress versus LoadBalancer", qwen searched
`"ingress LoadBalancer conclusion decision comparison"`, got nothing, retried
`"ingress LoadBalancer"`, got nothing, and told the user they had never discussed
it — while "ingress" alone matched two chats. A human adapts after one miss; a
model gives up and states a falsehood confidently.

The fix lives in the **tool**, not in `search_chats()`: try the phrase first,
then fall back to per-term search ranked by how many terms each chat hit, and
report `matched_on` so the model knows it got term matches rather than the phrase
it asked for. Stopwords are dropped or they would match everything and flatten
the ranking. Output is capped hard — 8 chats, 2 excerpts, 200 characters each —
because a tool result is replayed in the prompt on **every later turn**, so a
generous result quietly eats the context window it was meant to help with.

**Privacy shape worth keeping in mind:** this gives the model read access to
every saved chat, not just the open one. It is gated on tools being on, every
call is visible in the thread with its arguments, and nothing leaves the machine.
Any future tool touching stored data should hold that line.

**The same under-reporting trap as thinking, in the same direction.**
`/api/tags` reports `["completion"]` for `qwen3.5-9b` and
`["completion","vision"]` for both gemmas. `/api/show` reports **`tools` for all
three**, and `gemma-4-E4B` — which `/api/tags` says is completion+vision — called
the tool correctly on the first attempt. Lantern reads `/api/show`, so
`supports_tools` is already honest and no `observed_tools` list is needed:
unlike `think`, there is nothing to discover by guessing, because a model that
ignores a tools array just answers in prose.

**Protocol facts, measured against Ollama 0.32.5, not assumed:**

- `tool_calls` arrive **whole, on the final `done` chunk**, never as deltas.
  `mergeToolCalls()` merges by `function.index` anyway so a model that does
  stream them piecemeal still yields one entry per call.
- `arguments` is a real **object**, not a JSON string. Don't parse it.
- A result goes back as `{role:"tool", tool_name, content}`. The templates pair
  on `tool_name`, not on the `id` Ollama generates.
- A model will happily emit two calls in one round (verified: London and New
  York in a single turn, both executed, both fed back).

**The client sends tool *names*; the server owns the schemas.** `proxy_chat`
resolves them via `tool_specs()` and drops anything unknown, so a caller can never
describe a callable the server cannot run — the same reasoning as the options
allow-list. Tools are read-only, in-process, offline: no shell, no writes, no
network. `run_tool()` never raises; a failure returns as text the model can read
and correct from, because a 500 would kill an otherwise fine reply.

**The round cap is on rounds, not calls.** After `TOOL_ROUND_LIMIT` (4)
tool-executing rounds the loop asks **once more with no tools attached**, so the
turn ends in an answer instead of a dead stop. Verified by temporarily setting
the limit to 1.

**Two paths are reasoned, not observed.** Stop pressed *during* tool execution —
the signal is threaded into the tool fetch and the abort path truncates
unrecorded results, but the window is milliseconds wide and could not be hit
reliably. And the "model returned only calls we will not run" error, which needs
a model to emit structured `tool_calls` with no tools array present.

**Trap found doing that:** a model denied a tool it still wants writes the call
out as prose — qwen emitted a literal `<tool_call>` block into the answer text.
Lantern does **not** strip it. Chasing per-model call syntax is unwinnable, and
silently editing model output is worse than explaining it, so the round-limit
note says the syntax is literal text and nothing further ran.

**Storage.** A tool exchange is three messages: the assistant turn carrying
`tool_calls`, one `role:"tool"` message per result, then the answer. Each round
is its own assistant message with its own stats, which is why the thread shows
per-leg timings. Consequences that needed handling:

- `tool_calls` are recorded **only after** the results exist, so history can
  never hold a call with nothing under it. Stopping mid-execution truncates back
  to the assistant turn.
- Deleting an assistant turn takes its tool results with it, or the next request
  replays an answer to a call the model never made.
- Tool JSON is excluded from sidebar previews and from the auto-title
  transcript, in both `chat_summary()` and `summaryFor()`. It is left *in* search
  — matching a tool result is arguably useful.
- Anything that cuts history at a turn must keep a call and its results
  together. `toolTail()` is what **delete** and **branch** both use; without it,
  branching from a tool turn produced a chat whose first request replayed a call
  with no answer under it.

**Find-in-chat had to learn about collapsed panels.** `runFind()` walks every text
node under `#thread`, so it marked text inside collapsed tool bodies —
`display:none`, so the count was inflated and ⏎ scrolled to an invisible
highlight. It now rejects nodes inside a `.think-box`/`.tool-box` that is not
`.open`. **This was already broken for thinking panels** before tools existed.

**Rendering a tool round does not rebuild the thread.** `renderThread()` is
O(thread) and re-runs `wireCodeBlocks` over every code block, and a tool reply
adds messages two or three times. So the loop appends new nodes
(`appendMessagesFrom`) and rebuilds only the turn whose shape changed
(`replaceMessageNode` — it loses its bubble and header once it proves to be a
silent tool call). Both fall back to a full render unless the DOM holds exactly
the messages before the insertion point, and the turn still ends in one full
`renderThread()`: the fast path is never what correctness rests on.

## Tools: off and auto, with auto the default

"On" became **"Auto"**, and it is what new chats start with. The word is the
honest one: Lantern offers the tools and the *model* decides whether to call
anything. Nothing about the request changed — this is a rename plus a default
flip, not a new mode.

Two consequences worth knowing:

- **Existing installs flip too.** `get_settings()` merges stored values over the
  defaults, so anyone who never touched `tools_default` picks up the new default
  on upgrade. Their existing chats keep whatever `tools` value they were saved
  with; only new chats change. Settings → Behaviour turns it back off.
- **It does not enable the URL reader.** `read_url` is gated separately on
  `web_reader`, which stays off. Tools going auto by default must not quietly
  turn on the one tool that reaches off the machine, and it does not.

The cost this trades away is real and was the original reason for defaulting off:
tool schemas are sent on every turn, so auto costs prompt tokens even when no
tool is called. That is the trade the setting exists to let you undo.

## The URL reader ships enabled — and what "local-first" actually means

Changed in 1.2.2, deliberately, after shipping it off by default in 1.2.0.

The argument that won: **a user pasting a link and asking about it has already
said what they want.** Answering "I can't read that" until they hunt through
Settings is the wrong default — it fails the one case the feature exists for.

The argument it beat was the offline guarantee, and the honest version is that
the guarantee was drawn in the wrong place. Local-first here is about *inference
and data*: the model runs on your machine, the chats are files on your disk,
nothing is uploaded, there is no account and no telemetry. "Never resolves a
hostname" was a stricter promise that nobody actually needed, and it was
protecting against the wrong thing.

**What did not change is the part that matters.** The fence is identical: public
http(s) only, checked on the resolved IP so `localtest.me` and friends are
caught, re-checked at every redirect, bounded in time and size, refused for
anything on the machine or the private network. Turning it on by default does not
loosen a single one of those. **The fence is the invariant; its default is not.**

**The residual risk, stated rather than hidden:** the *model* picks the address.
It is told to use links the user provided, but that is prompt text, not an
enforced rule, so a model can in principle fetch something that was never pasted.
Every call is rendered in the thread with its exact URL, so it is visible, and
the tool can be switched off on its own. Enforcing it properly would mean
checking the requested URL against the conversation text, which the tool cannot
see today — `run_tool()` receives a name and arguments and nothing else. That is
the obvious next hardening if this ever feels too loose.

The update check stays **off** by default. It is not the same shape: nobody has
asked for it in the moment, so there is no request to honour.

## The URL reader

The second thing that can reach off this machine, and much sharper than the
update check, because **the model chooses the address**. That makes it a
server-side request forgery primitive unless it is fenced, and the fence is more
of the work than the feature.

The concrete danger is not abstract: Lantern's own API and Ollama's both listen
on localhost. `http://127.0.0.1:8777/api/chats` would put every saved
conversation into the model's context, and a page the user pasted is exactly the
sort of thing that could talk a model into fetching it.

So the fence, all of it on the server:

- **http(s) only**, and the check is on the **resolved IP**, not the hostname —
  `localtest.me` and friends resolve to 127.0.0.1, so a name blocklist waves them
  straight through. Loopback, private, link-local, multicast, reserved and
  unspecified are all refused.
- **Every redirect hop is re-checked.** A public URL redirecting to
  `169.254.169.254` is stopped at the redirect, verified against a local server
  that does exactly that.
- **Bounded everywhere**: a hard request timeout, a capped body read, a redirect
  limit, and a capped result — a tool result is replayed in the prompt on every
  later turn, the same reasoning as `search_chats`.
- **Gated in three places** — `tool_catalog()`, `tool_specs()` and `run_tool()`.
  The UI must not list it, the model must not be told it exists, and a direct API
  call must not reach it. Gating in one place leaves the other two as ways in.

**The tool contract was not what it looked like, and only testing found it.**
A tool's `run()` returns a *plain payload* that `run_tool()` JSON-encodes
wholesale; `_display` is popped for the row label; and `ok` means "the tool
executed", not "the outcome was good" — a `calculate` error is a normal result
with an `error` key. I wrote the first version returning `{"content": ...,
"ok": False}`, which was double-encoded into the payload and always marked
successful. Reading `run_tool` would have shown it; the SSRF suite showed it
instead, on case one. A fetch failure *should* read as failed in the thread, so
`_ok` now exists alongside `_display` — one line, and the only change to the
contract.

**Two bugs the hostile suite caught, both in the same place.** Testing for
`"://"` to decide whether to prepend a scheme mangled `data:text/html,...` into
`https://data:text/html,...`, whose "port" is not a number — and
`urllib.parse.SplitResult.port` *raises* on access rather than returning None.
So the tool raised instead of refusing. `run_tool` caught it, so nothing broke,
but a tool that raises is a tool whose failure text the model never sees. Match
a scheme properly, and never touch `.port` bare.

**Verified.** Seventeen hostile inputs — Lantern's own API, Ollama's, localhost
by name, private LAN, the cloud metadata address, IPv6 loopback, `0.0.0.0`,
`file:`/`ftp:`/`data:`/`mailto:`/`javascript:`, an invalid port, no host, garbage,
empty — all refused in under 30ms, none raising, none hanging. Then the fetch
path against a local server: a normal page extracts title and text with scripts
and styles stripped, plain text passes through, a 404 and a PDF and an oversized
page each come back as a readable message, a redirect is followed, a redirect to
the metadata IP is blocked, a redirect loop stops at the limit, and a host that
sleeps past the timeout returns "did not respond" at exactly the timeout.

**End to end with a real model**, which is the trigger rather than the mechanism:
asked to read an unreachable URL, qwen called `read_url`, got `unreachable`, and
told the user it could not access the page — the turn finished in 13 seconds with
the tool row styled as failed. Asked to read `http://127.0.0.1:.../api/chats` it
declined from the tool description alone without even calling it, which is a
pleasant second layer but not the control; the server block is.

**Two more bugs, found by a robustness pass *after* the first suite passed —
both of them ways to hang the reply, which is the one thing this must not do:**

- **`timeout=` is per socket operation, not per transfer.** A server dripping one
  byte a second resets it forever. Reproduced: it ran past 12 seconds against a
  2-second timeout. There is now a wall-clock `WEB_TOTAL_TIMEOUT` for the whole
  call, redirects included — which also stops three slow hops stacking to 24s.
- **`HTTPResponse.read(n)` blocks until it has all n bytes**, so the first
  attempt at a deadline never got a turn — the check sat in a loop that could not
  reach it. `read1()` returns whatever has arrived and keeps the clock alive.
  **A deadline is worthless if the call you are timing cannot yield.**

Also fixed there: undecoded **gzip** reached the model as mojibake and it read
that as the page, so `Accept-Encoding: identity` is requested *and* the body is
decompressed anyway (servers send it regardless). Decompression is bounded by
`max_length` — 200 KB of gzip expands to 200 MB otherwise, in the server process.
Verified: bomb bounded in 33ms, drip-feed ends at the deadline, and a connection
cut mid-body still yields the partial text.

**Known limitation, deliberately left: DNS rebinding.** The address is resolved
to check it, then urllib resolves again to connect, so a hostile name with a
one-second TTL could answer public for the check and `127.0.0.1` for the fetch.
Closing it means connecting to the checked IP by hand and carrying the original
host through TLS SNI and certificate validation — a real amount of socket code
for a threat that needs an attacker-controlled domain *and* the user pasting it.
It is written down rather than pretended away; if this ever guards something
sharper, that is the gap to close first.

**What it is not.** One page you point it at. No search engine, no crawling, no
following links found on the page. Search is a later conversation, and SearXNG on
localhost fits this project better than an API key.

## The update check — an opt-in call that leaves the machine

Added in 1.0.3. **Off by default**, because "offline unless you say otherwise" is
a promise in `CONTRIBUTING.md` and in the README. The URL reader is the other
off-machine path; unlike the update check, it ships enabled. The check was
raised before it was built rather than after.

Why it exists at all: distribution is source-only, so there is no Sparkle-style
updater and no `.app` that refreshes itself. Nothing told you a release had
happened — you had to remember to look. The version now sits under the sidebar
buttons, and with the check on it says `v1.0.2 → v1.1.0` with an accent dot when
you are behind.

Decisions in it worth keeping:

- **The switch is enforced on the server, not the client.** `GET /api/update`
  returns `{"enabled": false}` and makes no outbound request when the setting is
  off. Gating it only in the front end would mean the guarantee held for the UI
  and not for anything driving the API — the same reasoning as the tool registry
  and the options allow-list.
- **It is not part of `/api/bootstrap`.** Folding it in would make a launch with
  no internet sit on a network timeout before the window appeared. It runs after
  the UI is up, and a failure is a line of text in Settings, never a dialog.
- **Nothing in GitHub's reply is trusted past three integers.** The tag is
  matched against `v?\d+\.\d+\.\d+` and the link is *rebuilt* from those numbers.
  The response's own `html_url` is ignored on purpose — it is attacker-shaped
  data in the sense that matters (it decides where a user's click goes), and a
  release can be named anything. Tested against a tag containing
  `javascript:alert(1)`, a tag that is itself a URL, a missing tag, and a
  non-JSON body: all four fall back to the hardcoded releases page, and an
  `html_url` pointing at `evil.example` is dropped.
- **Only a successful check is cached** (6 hours). Caching a failure would pin
  "could not reach GitHub" onto the rest of the session after one flaky moment.
- `check_update()` never raises. Being offline is the *normal* state for this
  app, so it is a message, not an error page.

**The README claim had to change and that is the point.** It said "The only
network call is to your local Ollama", flatly. That went from true to
conditionally false the moment this landed, and README has shipped wrong four
times before. It now says what is actually true — nothing reaches out until you
switch this on — and the Security section names the one call, where the gate is,
and what is not trusted in the reply. **If you ever add a second outbound call,
that section is the thing to update first.**
