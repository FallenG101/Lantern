// Central app state.
//
// A generation is bound to a *chat object*, never to the globally-active chat.
// S.runs tracks one in-flight run per chat id, so you can start a reply in one
// conversation, switch away, and start another — each writes only to its own
// chat and saves under its own id.

import { api } from './api.js';

export const S = {
  settings: null,
  personas: [],
  prompts: [],        // reusable user prompts (the library)
  folders: [],        // chat folders; membership is folder_id on each chat
  models: [],
  running: [],
  chats: [],           // summaries for the sidebar
  chat: null,          // the chat currently on screen
  version: '',         // reported by the server, shown in Settings → About
  update: null,        // {latest, outdated, url, error} once checked, else null
  firstRun: false,     // server says this data folder is brand new
  tools: [],           // registry from the server: [{name, description, summary}]
  toolRoundLimit: 4,   // server-advertised cap on tool rounds per reply
  ollamaOk: true,
  ollamaError: '',
  dataDir: '',
  host: '',
  ollamaHost: '',

  runs: new Map(),     // chatId -> { abort, chat, messageId }
  attachments: [],
  searchQuery: '',
  searchResults: null,
  showArchived: false,
};

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, detail) {
  (listeners.get(event) || []).forEach((fn) => {
    try { fn(detail); } catch (err) { console.error(`[${event}]`, err); }
  });
}

/* ── runs ────────────────────────────────────────────────────────── */

export function isStreaming(chatId = S.chat?.id) {
  return !!chatId && S.runs.has(chatId);
}

export const anyStreaming = () => S.runs.size > 0;

export function beginRun(chat, messageId, abort) {
  S.runs.set(chat.id, { abort, chat, messageId });
  emit('runs');
  emit('streaming', isStreaming());
}

export function endRun(chatId) {
  S.runs.delete(chatId);
  emit('runs');
  emit('streaming', isStreaming());
}

export function abortRun(chatId = S.chat?.id) {
  const run = S.runs.get(chatId);
  if (run) run.abort.abort();
  return !!run;
}

/** The live object for a chat with a run in flight, if any. */
export function liveChat(id) {
  return S.runs.get(id)?.chat || null;
}

/* ── lookups ─────────────────────────────────────────────────────── */

export function modelInfo(name) {
  return S.models.find((m) => m.name === name) || null;
}

export function currentModel(chat = S.chat) {
  return chat?.model || S.settings?.default_model || S.models[0]?.name || null;
}

export function currentPersona(chat = S.chat) {
  const id = chat ? chat.persona_id : S.settings?.default_persona;
  const found = S.personas.find((p) => p.id === id);
  if (found) return found;
  // There is no "no persona" state any more — an unset or dangling persona_id
  // means "use the default". Nothing on disk is rewritten: chats written before
  // this still carry `persona_id: null` and simply resolve differently, so an
  // older Lantern opens them exactly as it always did.
  //
  // Falls through to the first persona so a chat always resolves, and to null
  // only when every persona has been deleted — in which case no system prompt is
  // sent, which is the same thing "no persona" used to do.
  return S.personas.find((q) => q.id === S.settings?.default_persona)
      || S.personas[0] || null;
}

export function personaById(id) {
  return S.personas.find((p) => p.id === id) || null;
}

/** The system prompt actually sent: chat override beats persona. */
export function effectiveSystem(chat = S.chat) {
  if (chat?.system_override != null) return chat.system_override;
  return currentPersona(chat)?.prompt || '';
}

/** Merged sampling options: defaults < persona < chat. */
export function effectiveParams(chat = S.chat) {
  const merged = { ...(S.settings?.default_params || {}) };
  const persona = currentPersona(chat);
  if (persona?.params) {
    for (const [k, v] of Object.entries(persona.params)) {
      if (v !== null && v !== '' && v !== undefined) merged[k] = v;
    }
  }
  if (chat?.params) {
    for (const [k, v] of Object.entries(chat.params)) {
      if (v !== null && v !== '' && v !== undefined) merged[k] = v;
    }
  }
  const clean = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v === null || v === '' || v === undefined) continue;
    clean[k] = v;
  }
  return clean;
}

/** True when Ollama's /api/show advertises the thinking capability. */
export function thinkingAdvertised(name = currentModel()) {
  return !!modelInfo(name)?.supports_thinking;
}

/**
 * Whether to offer the thinking control. Advertised capability is authoritative
 * when present, but it under-reports: gemma-4 honours `think` completely while
 * reporting only ["completion","vision"]. So a model we have actually watched
 * emit thinking counts too.
 */
export function thinkingSupported(name = currentModel()) {
  if (thinkingAdvertised(name)) return true;
  return (S.settings?.observed_thinking || []).includes(name);
}

/** Record that `name` produced thinking, so the toggle shows up from now on. */
export function noteThinkingObserved(name) {
  if (!name || thinkingSupported(name)) return false;
  const seen = [...(S.settings?.observed_thinking || []), name];
  patchSettings({ observed_thinking: seen });
  return true;
}

export function visionSupported(name = currentModel()) {
  return !!modelInfo(name)?.supports_vision;
}

/**
 * Whether to offer the Tools pill for a model.
 *
 * Same trap as thinking: /api/tags reports only ["completion"] (or
 * completion+vision) for every model here, while /api/show declares `tools` for
 * all three — and gemma-4-E4B, which /api/tags says is completion+vision, calls
 * tools correctly. server.py reads /api/show, so supports_tools is the honest
 * answer. Unlike `think` there is nothing to discover by guessing: a model that
 * ignores a tools array simply answers in prose, so there is no observed_* list.
 */
export function toolsSupported(name = currentModel()) {
  return !!modelInfo(name)?.supports_tools && S.tools.length > 0;
}

/**
 * Tool names to send with a request, or [] to send no tools array at all.
 *
 * `model` is a parameter because a comparison asks a model that is *not* the
 * chat's: reading the chat's model here answered for the wrong one, so a
 * tools-capable model could be asked with no tools, or the reverse.
 */
export function effectiveTools(chat = S.chat, model = currentModel(chat)) {
  if (!chat?.tools || !toolsSupported(model)) return [];
  return S.tools.map((t) => t.name);
}

/**
 * Think value for the request: false | true | 'low' | 'medium' | 'high',
 * or null meaning "omit the field entirely".
 *
 * For a model we know nothing about, omitting is deliberate: sending
 * `think:false` would suppress the very output we need to see in order to
 * discover that the model can think at all.
 *
 * `model` is a parameter for the same reason as effectiveTools(): a comparison
 * runs a model the chat is not set to.
 */
export function effectiveThink(chat = S.chat, model = currentModel(chat)) {
  if (!thinkingSupported(model)) return null;
  const value = chat?.think;
  if (value === undefined || value === null) return false;
  return value;
}

/* ── mutations ───────────────────────────────────────────────────── */

export async function loadBootstrap() {
  const data = await api.bootstrap();
  S.settings = data.settings;
  S.personas = data.personas || [];
  S.prompts = data.prompts || [];
  S.folders = data.folders || [];
  S.firstRun = !!data.first_run;
  S.chats = data.chats || [];
  S.models = data.models || [];
  S.running = data.running || [];
  S.version = data.version || '';
  S.tools = data.tools || [];
  if (data.tool_round_limit) S.toolRoundLimit = data.tool_round_limit;
  S.ollamaOk = data.ollama_ok !== false;
  S.ollamaError = data.ollama_error || '';
  S.dataDir = data.data_dir || '';
  S.host = data.host || '';
  S.ollamaHost = data.ollama_host || S.host;
  if (!S.settings.default_model && S.models.length) {
    S.settings.default_model = S.models[0].name;
  }
  emit('settings');
  emit('personas');
  emit('prompts');
  emit('folders');
  emit('models');
  emit('chats');
}

/**
 * Ask the server whether a newer release exists.
 *
 * Deliberately *not* part of bootstrap: this is the one call that leaves the
 * machine, and folding it into startup would make a launch with no internet
 * wait on a timeout before the app appeared. It runs after the UI is up, and a
 * failure is a line in Settings rather than anything the user has to dismiss.
 */
export async function refreshUpdate(force = false) {
  if (!force && !S.settings?.update_check) { S.update = null; emit('update'); return null; }
  try {
    const data = await api.checkUpdate(force);
    S.update = data.enabled === false ? null : data;
  } catch (err) {
    S.update = { error: err.message, current: S.version };
  }
  emit('update');
  return S.update;
}

export async function refreshModels() {
  try {
    const data = await api.refreshModels();
    S.models = data.models || [];
    S.running = data.running || [];
    S.host = data.host || S.host;
    S.ollamaOk = true;
    S.ollamaError = '';
  } catch (err) {
    S.ollamaOk = false;
    S.ollamaError = err.message;
  }
  emit('models');
  return S.models;
}

export async function refreshChatList() {
  const data = await api.chats();
  S.chats = data.chats || [];
  emit('chats');
}

/**
 * Chat folders.
 *
 * A folder owns nothing: membership is `folder_id` on the chat, so the folder
 * list is presentation and the conversations are the data. Losing folders.json
 * costs you the grouping and never a chat.
 */
export async function refreshFolders() {
  const data = await api.folders();
  S.folders = data.folders || [];
  emit('folders');
  return S.folders;
}

export async function createFolder(name) {
  const folder = await api.createFolder({ name });
  await refreshFolders();
  return folder;
}

export async function renameFolder(id, name) {
  await api.updateFolder(id, { name });
  return refreshFolders();
}

/**
 * Delete a folder. Its chats are unfiled, never removed — the server does the
 * unfiling, and this refreshes the list so rows move rather than vanish.
 */
export async function deleteFolder(id) {
  const result = await api.deleteFolder(id);
  await refreshFolders();
  await refreshChatList();
  return result;
}

/** Move a chat into a folder, or out of one with `null`. */
export async function setChatFolder(chat, folderId) {
  chat.folder_id = folderId;
  await api.updateChat(chat.id, { folder_id: folderId });
  const summary = S.chats.find((c) => c.id === chat.id);
  if (summary) summary.folder_id = folderId;
  emit('chats');
}

/** Re-read the prompt library after an edit. */
export async function refreshPrompts() {
  const data = await api.prompts();
  S.prompts = data.prompts || [];
  emit('prompts');
  return S.prompts;
}

export async function patchSettings(patch) {
  const previousBackend = S.settings?.backend;
  const previousEndpoint = S.settings?.openai_base_url;
  S.settings = await api.saveSettings(patch);
  S.host = S.settings.backend === 'openai'
    ? S.settings.openai_base_url : S.ollamaHost;
  if (previousBackend !== S.settings.backend
      || (S.settings.backend === 'openai' && previousEndpoint !== S.settings.openai_base_url)) {
    S.models = [];
    S.running = [];
    emit('models');
  }
  emit('settings');
  return S.settings;
}

/* ── persistence, keyed per chat ─────────────────────────────────── */

const pending = new Map();   // chatId -> { timer, chat }

function summaryFor(chat) {
  // A tool result is raw JSON; it must never become the sidebar preview.
  const last = [...chat.messages].reverse().find((m) => m.content && m.role !== 'tool');
  return {
    title: chat.title || 'New chat',
    updated: Date.now() / 1000,
    message_count: chat.messages.length,
    model: chat.model,
    pinned: !!chat.pinned,
    preview: last ? last.content.replace(/\s+/g, ' ').slice(0, 180) : '',
  };
}

/** Write one specific chat. Safe to call while other chats are streaming. */
export async function saveNow(chat) {
  if (!chat) return;
  clearTimeout(pending.get(chat.id)?.timer);
  pending.delete(chat.id);
  try {
    await api.updateChat(chat.id, {
      title: chat.title,
      pinned: chat.pinned,
      archived: chat.archived,
      model: chat.model,
      persona_id: chat.persona_id,
      system_override: chat.system_override,
      think: chat.think,
      tools: chat.tools,
      params: chat.params,
      messages: chat.messages,
    });
    const row = S.chats.find((c) => c.id === chat.id);
    if (row) {
      Object.assign(row, summaryFor(chat));
      S.chats.sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
      emit('chats');
    }
  } catch (err) {
    console.error('save failed', chat.id, err);
  }
}

/** Debounced write for a specific chat. */
export function queueSaveFor(chat, immediate = false) {
  if (!chat) return Promise.resolve();
  if (immediate) return saveNow(chat);
  clearTimeout(pending.get(chat.id)?.timer);
  // Hold the chat object itself: resolving it later from S.chat/liveChat
  // dropped the write for any chat that was neither on screen nor streaming.
  pending.set(chat.id, { chat, timer: setTimeout(() => saveNow(chat), 900) });
  return Promise.resolve();
}

/** Convenience for UI code acting on whatever is on screen. */
export function queueSaveChat(immediate = false) {
  return queueSaveFor(S.chat, immediate);
}

/** Flush every chat with a pending write (page unload, chat switch). */
export async function flushChat() {
  const chats = [...pending.values()].map((entry) => entry.chat);
  await Promise.all(chats.map((chat) => saveNow(chat)));
}

/**
 * Last-ditch synchronous flush for page teardown. An async fetch cannot finish
 * during unload, so anything still in the debounce window was being lost;
 * sendBeacon is queued by the browser and survives.
 */
export function flushBeacon() {
  if (!navigator.sendBeacon) return;
  for (const { chat } of pending.values()) {
    try {
      navigator.sendBeacon(`/api/chats/${chat.id}/save`, new Blob([JSON.stringify({
        title: chat.title, pinned: chat.pinned, archived: chat.archived,
        model: chat.model, persona_id: chat.persona_id,
        system_override: chat.system_override, think: chat.think,
        tools: chat.tools, params: chat.params, messages: chat.messages,
      })], { type: 'application/json' }));
    } catch { /* nothing more we can do at unload */ }
  }
}

/* ── chat lifecycle ──────────────────────────────────────────────── */

export async function newChat({ model, personaId, focus = true } = {}) {
  await flushChat();
  const chat = await api.createChat({
    model: model || (S.models.some((m) => m.name === currentModel())
      ? currentModel() : (S.settings?.default_model || S.models[0]?.name || null)),
    persona_id: personaId !== undefined ? personaId : (S.settings?.default_persona ?? null),
    think: false,
    tools: !!S.settings?.tools_default,
    params: {},
  });
  S.chat = chat;
  S.chats.unshift({
    id: chat.id, title: 'New chat', created: chat.created, updated: chat.updated,
    pinned: false, archived: false, model: chat.model, persona_id: chat.persona_id,
    message_count: 0, preview: '',
  });
  emit('chats');
  emit('chat', { focus });
  return chat;
}

export async function openChat(id, { focus = true } = {}) {
  if (S.chat?.id === id) return S.chat;
  await flushChat();
  // A chat mid-generation must keep its live object — refetching would drop the
  // tokens arriving right now and detach the run from what is on screen.
  const chat = liveChat(id) || await api.getChat(id);
  S.chat = chat;
  emit('chats');
  emit('chat', { focus });
  emit('streaming', isStreaming());
  return chat;
}

export async function removeChat(id) {
  abortRun(id);
  endRun(id);
  await api.deleteChat(id);
  S.chats = S.chats.filter((c) => c.id !== id);
  if (S.chat?.id === id) {
    S.chat = null;
    const next = S.chats[0];
    if (next) await openChat(next.id, { focus: false });
    else await newChat({ focus: false });
  }
  emit('chats');
}

export function msgId() {
  return `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
