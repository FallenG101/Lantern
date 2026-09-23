# Contributing to Lantern

Standing constraints and working notes for anyone changing this project,
including future-you.

A local chat interface for Ollama or an OpenAI-compatible local server: Python 3 stdlib server, vanilla ES modules, no
build step. **`NOTES.md` has where things stand and what is still open; `docs/` holds the
reasoning and the traps — read those before changing anything structural.**
`README.md` is the user-facing manual and is kept accurate against the code.

## Hard constraints

- **Zero dependencies.** Python 3 standard library on the server, plain ES
  modules on the front end. No npm, no build step, no CDN, no libraries.
- **`server.py` stays Python 3.9-compatible**, so the app can fall back to the
  `/usr/bin/python3` that ships with macOS. No `match`, no `X | Y` at runtime.
- **Local-first, which is about inference and data — not about never opening a
  socket.** Conversations, models and files stay on the machine. That is the
  promise; "makes no network call" is not, and stopped being true in 1.2.2.

  Two off-machine outbound paths exist, both gated **on the server** so the switch is the
  only thing that can produce a request:

  - `read_url` — **ships enabled.** Pasting a link and asking about it is an
    unambiguous request, and refusing until the user finds a setting is the wrong
    default.
  - the update check (1.0.3) — **ships disabled.**

  **The fence on `read_url` is the invariant, not its default.** Public http(s)
  only, checked on the *resolved IP* so names that resolve to loopback are
  caught, re-checked at every redirect, bounded in time and size. Don't loosen
  any of that. Note the model picks the address and is only *instructed* to use
  links the user gave it.

  See `docs/tools.md` → *The URL reader* and *The update check*. The local model
  backend is a separate loopback-only path, not an off-machine exception; its
  URL and redirect fence is in [`docs/backends.md`](docs/backends.md). **Any new
  off-machine path still gets raised before it is built.**
- **The same-origin guard in `server.py` stays.** Don't loosen it.

## Data safety

Real chats are plain JSON in `~/Library/Application Support/Lantern/chats/`.
They have gone missing twice.

- Back up before touching anything storage-related:
  `cp -R ~/Library/Application\ Support/Lantern ~/lantern-backup-$(date +%F)`
- Never run a cleanup that deletes by `message_count == 0` without showing what
  it matched first.
- `POST /api/restore` defaults to merge, which never overwrites. Keep it that way.

## How to work here

- **Verify by running things, not from memory.** If a measurement looks absurd,
  check the measurement before reporting it.
- **Verify the trigger, not just the mechanism.** If it has a button, click the
  button. Three bugs shipped because the code was read and the app was never
  operated — the abort path was traced and correct while the Stop button that
  called it had never once been clicked.
- Small, always-shippable increments: build, verify, install, then move on.
- Say plainly when something didn't work, or is reasoned rather than observed.
- **Every feature or major change includes a docs pass.** Re-read `README.md`,
  `NOTES.md`, the relevant file in `docs/`, and this one, and update whatever
  the change made untrue — it is part
  of the change, not follow-up work. `README.md` is a promise to users and has
  been wrong before (a stale model name, a line count off by 750, a claim that
  tools were never sent). If a change adds a trap or a rejected approach, it goes
  in the right file under `docs/` while the reasoning is still fresh.
- Prefer fewer, better-targeted checks over exhaustive ones — but never fewer
  *verified* claims. One decisive test beats five exploratory ones.

## Before finishing

Both run automatically on every commit, once per clone:

```bash
git config core.hooksPath tools/hooks
```

To run them by hand:

```bash
python3 tools/lint.py                      # traps that have bitten us, plus
                                           # doc claims checked against the code
/usr/bin/python3 -m py_compile server.py   # the 3.9 fallback must keep working
```

### Countable things — the README names them, it never counts them

Every one of the six times README shipped wrong was a **number restating
something the code already enumerates**: a tool count, an accent count, the line
count three times, a stale model name. Checking each count against its source
worked but only for the ones someone thought to check, and the line count still
escaped by being reworded into a shape the check could not see.

So the counts are **gone from the README**, and `tools/lint.py` fails if one comes
back. Where the README lists the things, the list *is* the count. A number that
is never written cannot go stale, and unlike a value check this cannot be beaten
by rephrasing, because the number itself is what is banned.

- **Don't write** "three tools ship", "twelve accents", "under N lines". Name
  them, or say nothing.
- **Do write** specs a reader acts on — the port, `num_ctx`, macOS 11, keyboard
  keys. Those are not "how many X" claims; rule 2 in the linter checks the ones
  that mirror code.
- **Names are encouraged and checked for presence**: every registered tool and
  every theme label must appear in the README, so a rename is caught.

`tools/lint.py` also verifies quoted defaults equal the real ones, that doc links
resolve, that no source file is missing from the Layout block, and that first-run
detection happens before seed backfill can create `settings.json`.

Then the click-through list in `docs/shipping.md` → **Before you ship**. It is two
minutes and it catches the class of bug that reading code does not.

## Picking the project back up

`NOTES.md` → **Where things stand** has the current version, what shipped, and
the next release with its design already worked out. `NOTES.md` → **Still open**
is the ranked backlog, and **Decisions that were considered and rejected** exists
so nobody re-proposes something that was already ruled out — check it before
suggesting a feature.

## Running it

`./build-app.sh` then `open dist/Lantern.app`, or `python3 server.py --open` for
a browser at <http://127.0.0.1:8777>.
