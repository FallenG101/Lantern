# Local model backends

Lantern 1.3 adds an OpenAI-compatible local connection alongside Ollama. This
is one adapter for servers such as LM Studio, llama.cpp, and Jan, not a cloud API
integration. The selected backend is a global setting; chats keep their model
name, so an older chat may need a model selected again after switching servers.
An empty chat is retargeted automatically. No chat JSON is migrated or deleted.
Switching endpoints clears the old model list immediately; if the new server is
unreachable, Lantern shows its new address (not the stale previous address) and
keeps an unsent draft until a valid model is available.

## Why this shape

Ollama's `/api/chat` streams NDJSON, while local OpenAI-compatible servers expose
`/v1/chat/completions` as SSE. `server.py` translates the latter into the NDJSON
shape the existing interface consumes. It also maps `/v1/models` into Lantern's
model list and routes automatic titles through the selected backend. Keeping the
translation in the server leaves the chat loop, persistence, and tool display
unchanged. Model management remains specific to Ollama; other runners manage
their own downloads and memory.

Lantern allows only `http://localhost:<port>/.../v1`, `127.0.0.1`, or `[::1]`
for this connection. It does not use a proxy or follow a redirect from that
endpoint. A key, if needed by the local runner, is stored in plain text in the
local settings file, just like the rest of Lantern's configuration. Do not use a
cloud API key here.

## Compatibility edges

- A `/v1/models` response has no portable tool, thinking, vision, or context
  capability fields. Lantern initially offers tools; if a model/server rejects
  a tool-enabled request with a tool-related error, the same turn is retried
  without tools and the user sees a warning. That model is treated as not
  tool-capable until Models is refreshed; the Tools pill updates immediately.
  Thinking is shown if the stream emits
  `reasoning_content` or `reasoning`; vision stays unavailable because accepting
  an image would be a guess about the model.
- Lantern forwards only common sampling fields to an OpenAI-compatible server:
  temperature, top-p, presence/frequency penalties, seed, stop, and a positive
  prediction limit as `max_tokens`. Ollama-only options (for example `num_ctx`
  and `keep_alive`) stay with Ollama. The Parameters panel still holds saved
  overrides, but unsupported fields have no effect on this backend.
- Tool calls arrive in streamed fragments. Lantern collects them, parses their
  JSON arguments, and emits a complete call for the existing tool loop. When a
  tool exchange is replayed, it synthesizes `tool_call_id` values for the
  OpenAI-compatible request and pairs each stored tool result with its call.
- The backend is chosen globally, not per conversation. Do not switch it while
  expecting an existing model name to work automatically; select a model from
  the new server. Launchers start Ollama only when it is selected.
- A server can implement the same endpoints yet differ in chat template,
  sampling, tools, or reasoning behavior. The mock-server integration suite
  covers protocol translation and failure paths; it is not a claim that every
  version of every runner has been tested live.

## Verification

`python3 -m unittest tools.test_openai_backend -v` starts two local servers with
a temporary data folder. It covers model listing, title generation, SSE text,
tool-call fragments and replay, tool rejection/retry, URL validation, and remote
redirect refusal. The UI smoke pass should also open Settings and Models, apply
a local connection, send/stop a reply, and verify an older chat after switching
backends. Use a scratch `LANTERN_DATA`, never a real history folder.

The first browser pass found a real release bug: both connection forms rejected
their own default `/v1` URL because the pattern required an extra slash before
`v1`. The switch pass then found that an unreachable new backend retained the
old server's host and model list, letting Send consume a draft for a model that
could not run. The forms now accept `/v1` directly, and Send checks model
availability before clearing the composer. These are the reasons the click
path belongs in the release checklist, not just the adapter test.
