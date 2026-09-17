# Features

Comparison, folders, first run, reset — and the traps inside each.

Part of Lantern's notes — see [`NOTES.md`](../NOTES.md) for where things stand and what is still open.

---

## Comparing models

### Comparison — built

Variants, the pager, sequential generation, per-variant metrics, and the
side-by-side compare view. The compare view is static text in columns with each
answer's tok/s, TTFT, output tokens and thinking time — showing *speed beside
quality* is the whole differentiator, since Msty and Open WebUI show only the
text. On the first real comparison qwen thought for 65s and emitted 926 tokens to
gemma's 32s and 428, for near-identical answers. That is the trade nobody else
surfaces.

**It reuses `runAssistant` rather than forking it.** Comparing streams *over* the
existing turn — the old answer is snapshotted into `variants[0]`, the message is
cleared and re-answered in place with the whole normal pipeline (painter, tool
loop, round cap), and the result is appended as another variant. Keeping the
message id means the DOM node, the painter's per-frame lookup and any open
find-marks all stay attached. Two things had to change for it:

- **`buildPayloadMessages(chat, limit)`** — the turn being re-answered sits
  *inside* the array, not at the end, so everything from it onward is cut. Without
  that the model is shown its own later replies.
- **The abort path must not splice.** Stopping a normal run deletes an empty
  placeholder; stopping a comparison must instead put the previous answer back,
  or the turn is left blank.

**The selected variant is mirrored onto the message.** `content`, `model`,
`stats` and the rest are copied up from `variants[variant]`, so saving, export,
search, and `buildPayloadMessages()` need no knowledge of variants at all. The
alternative — reading through an index everywhere — would have touched every
consumer.

**Verified:** two models answering one turn stores two variants and *does not*
append a message; the pager switches text, model, metrics and thinking together;
the choice survives a reload. Gemma-4 produced 1,854 characters of reasoning to
qwen's 4,027, and each stayed with its own variant — a useful accident, since it
re-confirms that gemma reasons despite not advertising it.

### The bug pass over it — five real ones, all from the same mistake

Every one of them came from a single unstated assumption: **`runAssistant` was
written for a run whose message is at the *end* of the array, and comparison put
one in the middle.** They were found by operating the app against a scratch
`LANTERN_DATA` seeded with a four-message chat, not by reading — the code reads
fine.

- **Stop during a comparison deleted the rest of the conversation.** The abort
  path ran `chat.messages.length = at + 1` to drop tool results whose call was
  never recorded. Correct when the turn is last; catastrophic when it is turn two
  of six. Observed: two messages left of four, saved to disk. It is now guarded on
  `placeholder !== target`.
- **A comparison in a chat with tools on corrupted the history.** Tool results are
  `push`ed to the end of the array while the compared turn sits in the middle, and
  the payload is cut at the compared turn — so the model never saw its own tool
  result, called `current_datetime` four times, hit the round limit and answered
  "I do not have access to a real-time clock". The chat went from 4 messages to
  12, the compared turn was left **blank**, and its original answer survived only
  inside `variants[0]` with no pager to reach it. Observed exactly as described.
- **Stopping a comparison before the first token duplicated the answer.** The
  restore put the old answer back on the message, and the `finally` block then
  snapshotted that same message into a *second* variant — a pager reading `2/2`
  with the identical text on both sides.
- **A comparison that failed lost the answer it was supposed to keep.** The
  restore lived in `catch`, so it only ran for something that *threw*. An empty
  reply and a round that ends in `placeholder.error` fail without throwing, and
  left the turn showing an error with the previous answer unreachable.
- **The pager was live while a further comparison streamed into the same turn.**
  Clicking ‹ mid-stream ran `applyVariant()` on the message the painter was
  appending to.

**The fix that mattered most was a design decision, not a patch: a comparison
runs with no tools.** A variant is one answer on one message; a tool exchange is
an assistant turn plus a `tool` row per result. There is nowhere inside a variant
to put them, and appending them beside a mid-thread turn is what corrupted the
history. Making it work would mean variants that own a message *list* — a format
change and a real feature, not a bug fix. The honest version is to refuse, and to
say so with a toast rather than quietly compare a tool-using answer against one
written without them.

**The restore rule now lives in one place, `finally`, and reads as one sentence:**
gained an answer → keep it beside the old one and select it; gained nothing → put
the turn back exactly as it was and toast why. Splitting it across `catch` and
`finally` is what let the non-throwing failures through. It also removes the
single-entry `variants` array it would otherwise leave behind, so a comparison
that produced nothing leaves no trace at all.

**`effectiveThink()` and `effectiveTools()` take the model being asked.** They
read `currentModel(chat)`, and a comparison deliberately does *not* change the
chat's model — so the request was built from the capabilities of a model that was
not the one answering. `regenerateWith` never hit this because it sets
`chat.model` first.

**Two optimisations, both small and both real.** `selectVariant()` rebuilt the
whole thread to change one message; it now uses `replaceMessageNode()` (which
returns a boolean and falls back to a full render), which also stops a long chat
jumping to the bottom when you page between answers. And the tok/s arithmetic was
written out twice, in the message footer and the compare columns — one `tokRate()`
now, because two copies of a formula drift.

**Left alone, deliberately:** a reply that is *entirely* thinking with no content
renders as an empty bubble. Seen with qwen3.5-9b answering a tool result inside
its reasoning — 26 tokens out, all of them thinking. It predates comparison and is
not part of it.

### The original design, kept as the record of why

**All of this shipped** — it is here because the reasoning is the useful part,
not because anything is outstanding. The one idea below that was never built is
the thumbs-up leaderboard, and it stays unbuilt until there is a reason to want
it. Generation is **sequential**, and the rejected-approaches table above has the
memory arithmetic for why parallel cannot work here. The rest:

- **Variants live on the assistant message**, not in a message tree. Open WebUI
  uses a tree (`groupedMessageIds` keyed by model index, `groupedMessageIdsIdx`
  for the visible one per model) because it runs many models at once. Lantern
  deliberately does not, so the flat `messages` array stays: the assistant
  message grows `variants: [{model, content, stats, ttftMs, …}]` plus a selected
  index, and top-level `content` mirrors the selection — so
  `buildPayloadMessages()` and history replay need no changes at all.
- **"Compare with…"** on a reply, shaped like the existing *Regenerate with
  another model*, **appends** a variant instead of replacing the answer.
  `S.runs` already allows only one run per chat, so sequencing is free.
- **A pager on the message** (`‹ 2/2 › gemma-4-12B`) switches which variant is
  live in the conversation.
- **A compare view** lays variants out in columns — static text, no streaming,
  so it costs nothing to render.
- **Show the metrics.** Lantern already measures TTFT, tok/s and token counts.
  Msty and Open WebUI show text side by side; showing *speed and length beside
  quality* is the differentiator, and on local models that trade is the actual
  decision. Open WebUI's thumbs-up leaderboard idea becomes nearly free once
  variants exist.

## Option chips, and the shape a model actually emits

A model can offer clickable choices by ending a reply with a fence tagged
`options`, one per line. They render as buttons that **fill the composer rather
than send** — the model can suggest, never act, so it cannot put words in your
mouth and press return.

**It rides on the fence parser deliberately.** A bespoke `::: options` container
would be something models guess at; fenced blocks are something they emit
constantly and get right. It also inherits the unclosed-while-streaming handling
for free, so chips appear as they arrive.

**The label is text the model wrote, so it never reaches a markup sink.** Each
goes through `escapeHtml()` and is read back with `textContent`. Verified with a
reply containing `<img src=x onerror=alert(1)>` and a `<script>` tag: both render
as literal text, and the thread gains no `script` or `img` nodes.

**The first real model got the syntax wrong, which is the useful part.** Told to
end with "a fenced block tagged `options`", qwen3.5 wrote an *untagged* fence
with `{options}` as its first line. Two fixes, and both were needed:

- The persona now shows the literal shape instead of describing it. A worked
  example beats a description for this class of instruction.
- The parser accepts a first-line marker on an **untagged** fence — `options`,
  `{options}`, `[options]`. Bounded on purpose: the line must be exactly the
  marker, so a code block that merely mentions options is unaffected. This is not
  the unwinnable per-model syntax chase that tool-call leakage was; the variants
  are few and unambiguous.

After both, the same model produced a correct block first time.

## Continue a cut-off reply

A reply that stops because it hit `num_predict` grows a **Continue** action.
Pressing it streams into the *same message*, so the answer becomes one
continuous block rather than a reply split across two turns.

**`done_reason` is the honest signal.** Ollama reports `"length"` when a turn
ran out of room and `"stop"` when it finished, and it has been recorded in every
message's stats since 0.8 — nothing read it until now. The alternative, guessing
from whether the text ends in punctuation, is wrong for code, lists and tables.
Verified both ways: a capped reply offers the button, a normal one does not.

**Only ever the last message.** Continuing an older turn would append text below
replies that already answered it, and it is also what lets the tool loop stay
untouched — anything a continued turn appends still lands at the end of the
array, where the loop already expects it.

**The nudge is never stored.** The request carries the history *including* the
half-finished reply plus a transient "carry straight on" user turn. Writing that
into the chat would leave a "continue" message sitting in the transcript for
ever, and replaying it on later turns would be worse.

**Trap, and the same one twice.** `streamRound()` pushed the placeholder unless
it was the *comparison* target — so a resumed reply, whose target is a different
variable, was pushed a second time and the thread grew a duplicate instead of the
answer growing. The guard asks "is this already in the thread?" now, covering
both. Two features stream into an existing message; a test for one of them by
name will miss the other.

**Known limitation, left alone deliberately.** If the cut lands mid-word the seam
is rough: one reply ended `...known as **Cong` and the continuation began
`control mechanism`, giving `**Congcontrol`. Trimming the partial word before
resuming would fix that case and break the commoner one, because a reply cut at a
*word boundary* is indistinguishable from one cut mid-word without token-level
information the client does not have — the heuristic would delete real words.
Rough joins are rarer and cheaper than lost ones. A raw completion endpoint would
solve it properly and is a much larger change.

## Seeds only ever reached new installs

`get_personas()` seeded when the file was missing or empty and returned exactly
what was stored otherwise. That reads as obviously right and is quietly wrong the
first time a *later* release adds a seed: **Game Master shipped in 1.2.5 and
appeared for nobody who had used Lantern before.** The reporter had updated, had
the new build, and simply did not have the persona. Same latent bug in
`get_prompts()`.

The fix is to record which seeds have been *offered*, in
`settings.seeded_personas` and `seeded_prompts`, rather than inferring it from
whether the file is empty. Absent from that list means "never offered", not
"deleted", so:

- An existing install picks up a newly seeded persona once, on the next launch.
- Deleting it sticks. The name stays recorded as offered, so it does not come
  back on the next start — which is the behaviour a value check would have got
  wrong in the other direction.
- An install that predates the tracking has its **current names** treated as
  already offered, or every persona it already has would be duplicated once.

Verified against a copy of a real `personas.json`: Game Master is added exactly
once, a second read does not duplicate it, and deleting it then restarting leaves
it gone. (That persona was itself withdrawn in 1.2.7 — see *Roleplay* below —
but it is what the fix was tested with.)

**The general shape is worth remembering.** Any "seed on first run" is really
"seed the things this install has never been offered", and the difference only
shows up on the release *after* you add one — which is the worst time to find
out.

## Roleplay: tried, and the seed withdrawn

A Game Master persona shipped in 1.2.5 and was removed in 1.2.7 after actually
being used. It narrated well enough, but the feature it leaned on — a model
ending every turn with an `options` block — is **not something smaller local
models do reliably**. Seeding a persona that only works on the larger ones sets
an expectation the app cannot keep, and a half-working example in everybody's
persona list is worse than no example.

What that leaves, deliberately:

- **Option chips stay.** They cost nothing when unused: a model that ignores the
  convention just writes prose, and no affordance appears. Anyone who wants the
  behaviour can write the instruction into their own persona, which is exactly
  what the removed seed was.
- **`roll_dice` stays.** It is useful outside roleplay — picking at random,
  settling a coin toss — and it is the only tool whose result cannot be faked
  convincingly, since it returns every die.

**The lesson is about seeding, not about roleplay.** A seeded persona is a
promise that something works out of the box. Ship one that depends on behaviour
only some models have, and the app looks broken to everyone else. Features that
degrade quietly, like the chips themselves, are safe to ship; examples that
depend on them are not.

## Folders

Chosen over tags, and the reason is the sidebar rather than taste. It is ~260px
wide: tags want chips on every row and a filter bar above them, folders want one
label per group. And **one chat belongs to one folder**, which keeps
`renderSidebar()` a single flat pass where every chat is rendered exactly once.
Tags remain possible later — they would be a separate additive field, not a
replacement.

Single level. Nesting means a tree, drag-and-drop, and path rendering in a narrow
column, and the value falls off fast.

**A folder owns nothing.** Membership is `folder_id` on the chat; `folders.json`
is a list of `{id, name, order}` and no more. Losing or hand-editing that file
costs the grouping and never a conversation — the same instinct as keeping chats
as readable JSON, which is what allowed hand-recovery twice.

**Deleting a folder unfiles its chats, never deletes them.** The server clears
`folder_id` on each and reports how many, the confirm text says the chats will be
kept before you click, and the toast repeats it afterwards. A cascade here is
precisely the shape of the accident this data folder has already had twice.

Consequences that needed handling:

- **Pinned still wins.** A pinned chat appears under *Pinned* even when filed, so
  no chat is ever drawn twice. That is the existing behaviour with date groups,
  left alone rather than made clever.
- **An unknown `folder_id` falls back to unfiled** rather than vanishing. The
  sidebar filters on folders it knows about, so a chat pointing at a folder that
  no longer exists still appears — a row that silently disappears reads exactly
  like data loss.
- **Collapse state lives in `localStorage`, not on the folder.** It is a property
  of this window, and writing it to the folder file would mean a disk write on
  every disclosure triangle.
- **Backup and restore carry folders**, or the grouping would survive the backup
  and be lost by the restore. Restore *merges* the folder list, matching the rule
  that restore never destroys what is already there.
- Indentation for rows in a folder is a class on the row, not
  `.folder-head + .chat-row ~ .chat-row` — the sibling combinator also catches
  every unfiled row further down the list.

**Trap found doing this:** the writable-field whitelist for a chat was spelled
out twice, in the PUT route and in the `sendBeacon` `/save` route. Adding
`folder_id` to one and not the other would have made filing work everywhere
except page teardown — a bug that only shows up when you close the window. It is
one `CHAT_WRITABLE` constant now.

**Verified:** folders created, renamed, filed into and collapsed; collapse state
survives a reload; deleting a folder holding a chat leaves all chats present with
their messages, unfiled. And the compatibility promise both ways — **v1.0.3 run
against a data folder written by this build** lists every chat, opens a filed one
with its messages, and *preserves* `folder_id` through its own save, because it
round-trips the whole chat dict. Degraded, not broken, exactly as promised.

## The first-run flow

Three steps, because a new user has exactly three questions: is Ollama working,
which model, and what is this allowed to do. Skippable at every point — an
onboarding flow you cannot escape is worse than none, and skipping leaves every
default exactly as it ships.

**Detecting "first run" is the part that can go wrong.** The obvious signal is
`settings.onboarded`, and it is the wrong one: an existing install that has never
opened Settings has no `settings.json`, so it reads as un-onboarded and gets
greeted on upgrade. That is the "new code greets an old user" failure that makes
an update feel broken. `first_run()` requires **no settings file *and* no chats**
— someone who has used Lantern has history, whatever their settings look like.
Verified both ways: a fresh folder reports true, a folder with one chat reports
false.

**That check must run before the seeded collections are read.** Seed backfill
records the persona and prompt names it has offered in `settings.json`; from
in 1.2.6 and 1.2.7, server startup eagerly seeded personas and bootstrap read both
collections before calling `first_run()`, so the act of preparing a fresh
install made it look used and the flow never appeared. Startup no longer seeds
anything, bootstrap captures the first-run state before it reads the seeded
collections, and the project linter enforces both rules. Verified against an
empty scratch data folder: the first bootstrap reports true, finishing or
skipping setup makes later ones report false.

**Two things the flow had to fix about itself**, both found by clicking it:

- Boot creates a blank chat *before* the flow runs, and that chat captured
  whichever model was default at the time. So picking a model in onboarding left
  the chat in front of you showing a different one. The flow now retargets the
  open chat when it is still empty; a chat with history keeps the model it was
  answered with.
- Turning *off* "read web pages" changed the setting but not the tool registry
  the front end holds, so the pill still counted `read_url` until a reload. It
  re-fetches now, the same way the Settings row does.

The permissions step is where a future web-search switch belongs, alongside the
reader — it is the one place a user is already being asked what this may reach.

## Full reset

The most destructive thing in the app, in a project whose data folder has lost
chats twice. Three guards, and the ordering matters:

1. **The word is checked on the server.** The dialog asks the user to type
   `reset`, but `POST /api/reset` refuses without `{"confirm": "reset"}` in the
   body — so the dialog is a courtesy and the server is the actual lock. A stray
   or replayed POST cannot wipe a folder.
2. **It says what it will delete, counted, before it will run** — chats,
   folders, personas, prompts, settings — and offers the backup in the same
   dialog. Guessing is what makes destructive buttons frightening.
3. **It only removes files Lantern writes.** Chats, `settings.json`,
   `personas.json`, `prompts.json`, `folders.json`. Anything else in the data
   folder is left alone; verified with a file parked there by hand.

Afterwards the page **reloads** rather than repainting. Every module holds state
with nothing behind it any more, and the first-run flow keys off a fresh
bootstrap — a reload is the honest way back to a blank slate. `localStorage` is
cleared too, or the sidebar would try to reopen a chat that no longer exists.

`personas.json` and `prompts.json` reappear immediately, because `get_personas()`
and `get_prompts()` re-seed on read. That is correct: the reset removes *your*
edits, and a fresh install has the seeds.

## Think and Tools live under the composer

Moved there in 1.2.2. They change the **next message**; model and persona are
settings for the whole chat. Grouping by what a control affects rather than by
what it looks like puts the send-time controls with the box you type in, and
leaves the topbar holding chat-level state.

**The trap is the dropdown direction.** `.menu` is `position: absolute; top:
calc(100% + 8px)`, which opens downward — fine in a topbar, useless eight pixels
from the bottom of the window, where the menu would render off-screen entirely.
Both menus carry `.menu-up`, which flips to `bottom: calc(100% + 8px)` and moves
`transform-origin` so the open animation still grows from the anchored edge.
Verified by measuring: the menu's bottom sits above the pill's top and the whole
box is inside the viewport.

**Also caught by looking rather than reasoning:** `.pill-label` truncates with an
ellipsis, which exists for long model names in the topbar. At a narrow window
that rendered `Tools · a…`. The composer row opts out; its labels are short and
fixed.
