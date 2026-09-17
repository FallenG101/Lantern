# Lantern — project notes

Where the project stands, what is still open, and what has already been decided.
The reasoning behind the code lives in three files beside this one:

| | |
|---|---|
| [`docs/design.md`](docs/design.md) | How Lantern is built and why: the stack, architecture, platforms, UI, the markdown and LaTeX renderers |
| [`docs/tools.md`](docs/tools.md) | Tool calling, the URL reader, the update check, and the capability traps |
| [`docs/features.md`](docs/features.md) | Comparison, folders, first run, reset — and the traps inside each |
| [`docs/shipping.md`](docs/shipping.md) | The security model, data safety rules, and the click-through list to run before a release |

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the standing constraints — read that
first if you are changing anything. [`README.md`](README.md) is the user-facing
manual and is kept accurate against the code.

---

## Where things stand

**Release candidate: `v1.2.8`. Latest public release: `v1.2.7`.**
<https://github.com/FallenFight/Lantern>

Everything below works and is documented. Tool calling, model comparison with the
side-by-side view, folders, a prompt library with fill-in blanks, an opt-in URL
reader, a first-run flow, and a full reset. `num_ctx` defaults to 32768. The
stranger path is verified: an anonymous clone with credentials stripped from the
environment builds and runs.

**1.0 meant "ready for strangers", not feature complete.** The compatibility
promise it carries is in [`docs/design.md`](docs/design.md) → *The 1.0
compatibility promise* — it is about the chat JSON on disk, not an API, and it
has held through every release since.

### Releases

| | |
|---|---|
| `1.0.0` | Public, source-only |
| `1.0.1` | Five comparison bugs, two of which lost messages |
| `1.0.2` | The `tool` icon, malformed since 0.9.0 |
| `1.0.3` | Version in the sidebar, opt-in update check — the first thing that reaches off the machine |
| `1.1.0` | Folders for chats |
| `1.2.0` | The `read_url` tool, opt-in, and the first place the *model* picks the address |
| `1.2.1` | A Windows/Linux browser path — audited, not tested |
| `1.2.2` | First-run flow; tools default to auto and the URL reader ships enabled |
| `1.2.3` | Full reset, a replayable setup flow, and these notes split into `docs/` |
| `1.2.4` | Three themes, the light-theme fix Mist had been shipping without, an appearance step |
| `1.2.5` | Option chips, `roll_dice`, `{{placeholders}}`, and Continue |
| `1.2.6` | Seeded personas and prompts reach existing installs, not just new ones |
| `1.2.7` | Game Master seed withdrawn — it needed behaviour small models lack |
| `1.2.8` | Restore first-run setup after seed backfill made fresh installs look used |

Everything remaining is optional — see *Still open* below, ranked.

## Still open

**Going public is done.** The repo is public, `v1.0.0` through `v1.0.3` are
tagged and released, and the stranger path is verified — an anonymous clone with
credentials stripped from the environment builds and runs. The README describes
today rather than promising a future.

Distribution is settled: **source-only**, because `build-app.sh` ad-hoc signs
(`codesign --sign -`), so a downloaded `.app` is quarantined and reads as
*"Lantern is damaged"* — the worst possible message for something that is fine.
Notarising needs a $99/yr Apple Developer account. Building locally sidesteps
quarantine entirely and fits the zero-dependency story. The consequence is that
updating is manual, which is what the update check in 1.0.3 exists to make
visible; the README has the pull/rebuild/replace steps under *Updating*.

Then, ranked by value, from the feature audit:

**Two of these are audit findings, not available work.** They describe real
gaps, and they are *also* in the rejected table above — which is the table that
exists so nobody re-proposes something already ruled out. Reading this list for
"what's next" walked straight into that once. They stay documented because
knowing your gaps is useful; they are not on the menu.

1. ~~RAG / document ingestion~~ — no PDF, DOCX, chunking, or vector store; text
   files are inlined verbatim as code fences. **Ruled out**: without a library it
   means hand-writing chunking and a vector store, which is where the
   zero-dependency rule stops paying. Reopen the decision before proposing it.
2. ~~Local embeddings~~ — `/api/embed` is never called. **Ruled out** with RAG,
   for the same reason; on its own it has nothing to feed.
3. **Web search** — the URL reader half is **built**; see *The URL reader* above
   for the fence around it. What remains is actual querying, and SearXNG on
   localhost still fits this project better than an API key. One `TOOLS` entry
   when it happens.
4. ~~Folders or tags for chats~~ — **built.** Folders, not tags; the reasoning
   and the traps are under *Folders* above. Tags are still possible as a separate
   additive field if per-chat labels ever earn their place.
5. **A native Windows window** — unbuilt on purpose. The browser path works
   (see *Windows and Linux* above); a WebView2 host is a second native surface to
   maintain, and unsigned Windows binaries hit SmartScreen exactly as unsigned
   Mac ones hit quarantine. Build-it-yourself answers both. Waiting for demand.
6. Speech-to-text / TTS.
7. ~~Documentation cleanup~~ — **done.** `NOTES.md` was 1,346 lines read
   front-to-back; it is an index now, with the reasoning split into `docs/` by
   when you need it. The README was cut to size in 1.2.2.
8. Context compaction when the window fills. The cheap half is done — the default
   `num_ctx` went from 8192 to **32768** in 0.9.0, measured at **+0.83 GB
   resident on a 9B model, about 34 MB per 1k tokens**, for 4× the usable
   conversation. 65536 would have cost ~2 GB for headroom almost nobody reaches.
   What remains is the hard half: deciding what to drop when even 32k fills.
   **Note this only affects new installs** — `get_settings()` merges stored
   values over the defaults, so anyone with `num_ctx` already saved keeps 8192
   until they change it. That is deliberate; a silent memory jump on upgrade
   would be worse.
9. **A chat statistics panel** — tokens, models used, tok/s over time, busiest
   days. Everything it needs is already on disk in the chat files, so it is a
   read-only view over data that exists: no new storage, no new dependency, no
   network. Proposed and not yet wanted; cheap whenever it is.
10. **Self-contained HTML export** — one styled file that opens anywhere, built
   with the existing renderer so nothing is fetched. Fits the source-only
   distribution story better than a screenshot does. Also proposed and deferred.

## Decisions that were considered and rejected

| Idea | Why not |
|---|---|
| Electron / Tauri | 150 MB+ and a toolchain, against the whole point |
| Bundling Python (PyInstaller) | ~20 MB vs 800 KB; macOS always has a usable python3 |
| Encrypted local storage | FileVault already encrypts the disk. App-level encryption means a password every launch and destroys "everything is a readable file" — which is exactly what allowed hand-recovery of chats twice |
| RAG / embeddings / vector store | A real subsystem. Without a library it means hand-writing chunking and a vector store, which is where the zero-dependency rule stops paying |
| Chunked digest of an oversized document | The **non-retrieval** variant of the row above — split the text, have the model note each piece, then answer from the notes. No embeddings, no vector store, no query-time search, so it dodges most of that objection. Raised for a 300k-token transcript, which no setting reaches: the largest installed models train to 262144, and a window that size would be ~15 GB resident on a 16 GB machine anyway. Measured on `qwen3.5-9b`, thinking off and `num_predict` capped: ~3 min per ~25k-token chunk, ~35 min for the map phase, a digest of ~2,800 tokens. So it *works* — and was declined as a long batch job serving a rare input. **Two findings worth keeping.** Capping the per-chunk note is load-bearing rather than tuning: uncapped, the model spent ~5,000 reasoning tokens a chunk and the digest reached ~67,000 tokens, larger than the context it exists to escape. And given synthetic text with **no narrative arc at all**, it confidently reported a tone shift "around 9:06" and named it — it will narrate a story out of noise, which is disqualifying for the "what went wrong" questions that motivated it |
| MCP | Still rejected. A client means a subprocess transport, a handshake, and arbitrary third-party servers — the opposite of "one file you can read". Tool calling itself now ships; see below |
| Global hotkey to summon the window | Cut from the roadmap. It is Swift in the native host, macOS-only, and Spotlight and ⌘Tab already summon the app — a new native surface to maintain for something the OS does |
| **Parallel** multi-model comparison (the Msty / Open WebUI approach) | Not implementable on the target hardware. Measured: `qwen3.5-9b` is 7.29 GB resident at the 32k default, so two loaded models is ~14.6 GB on a 16 GB M4 — under 1.5 GB left for macOS and the app. Ollama would evict one mid-generation or the machine would swap. Comparison runs **sequentially** instead, which is a better fit, not a compromise |
| MLX / Vulkan backends | Ollama's domain, not ours |
| README screenshots | Owner's call: not happening for the foreseeable future. They would help a UI project on a public repo, and that argument has been made and declined. **Don't raise it again** — the rejected table is where things go so nobody re-proposes them |
| A seeded roleplay persona | Shipped as Game Master in 1.2.5, withdrawn in 1.2.7. It depends on the model ending every turn with an `options` block, which smaller local models do not do reliably — so the seed set an expectation the app could not keep. The chips and `roll_dice` remain; anyone wanting the behaviour can write the instruction into a persona of their own |
| Browser `--app` window | Was the original approach. Replaced by the native host; it cost a 112 MB Brave profile for a cosmetic window |
