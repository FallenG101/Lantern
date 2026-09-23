// Thread rendering and the generation loop.

import {
  S, emit, on, msgId, queueSaveChat, queueSaveFor, saveNow, currentModel, currentPersona,
  effectiveSystem, effectiveParams, effectiveThink, effectiveTools, modelInfo, newChat,
  noteThinkingObserved, isStreaming, beginRun, endRun, abortRun, thinkingSupported,
  toolsSupported,
} from './store.js';
import { api, chatStream } from './api.js';
import { openModal, closeModal } from './modals.js';
import { renderMarkdown, wireCodeBlocks } from './markdown.js';
import {
  $, el, svg, ICON, escapeHtml, copyText, toast, dur, num,
  shortModel, estTokens, download, autosize,
} from './util.js';

const scrollBox = () => $('#scroll');
const threadBox = () => $('#thread');

let stickToBottom = true;

/* ─────────────────────────── rendering ─────────────────────────── */

/**
 * @param {boolean} force  jump to the bottom regardless of where the user is.
 *   Chat switches force; a finishing reply must not — scrolling up to re-read
 *   while a reply streamed used to snap you back the instant it ended.
 */
export function renderThread(force = false) {
  const thread = threadBox();
  const empty = $('#empty');
  thread.textContent = '';

  const messages = S.chat?.messages || [];
  if (!messages.length) {
    empty.hidden = false;
    updateEmptyState();
    updateFoot();
    return;
  }
  empty.hidden = true;

  messages.forEach((message, index) => {
    thread.append(buildMessage(message, index));
  });
  wireCodeBlocks(thread);
  updateFoot();
  if (force || stickToBottom) scrollToBottom(true);
}

/**
 * Append messages the DOM doesn't have yet instead of rebuilding the thread.
 *
 * renderThread() is O(thread) and re-runs wireCodeBlocks over every code block
 * in the conversation. A tool round adds messages two or three times per reply,
 * which would pay that cost each time on a long chat. Falls back to a full
 * render whenever the DOM is not exactly the messages before `from` — the
 * append path is an optimisation, never the thing correctness rests on, and
 * runAssistant does a full render when the turn ends regardless.
 */
function appendMessagesFrom(chat, from) {
  const thread = threadBox();
  const messages = chat.messages || [];
  if (!thread || from <= 0 || thread.children.length !== from) {
    renderThread();
    return;
  }
  for (let i = from; i < messages.length; i++) {
    const node = buildMessage(messages[i], i);
    thread.append(node);
    wireCodeBlocks(node);
  }
  updateFoot();
  if (stickToBottom) scrollToBottom(true);
}

/**
 * Rebuild one message node whose *shape* changed rather than its text — an
 * assistant turn that turns out to be a tool call loses its bubble and its
 * header, which the streaming painter cannot express.
 *
 * Returns whether it did the swap, so a caller that needs the screen to be
 * right can fall back to a full render.
 */
function replaceMessageNode(chat, index) {
  const thread = threadBox();
  const message = chat.messages?.[index];
  const old = thread?.children[index];
  // Only touch it when the DOM really is this message; the full render at the
  // end of the turn is what guarantees correctness.
  if (!message || !old || old.dataset.id !== message.id) return false;
  const node = buildMessage(message, index);
  thread.replaceChild(node, old);
  wireCodeBlocks(node);
  return true;
}

function updateEmptyState() {
  const persona = currentPersona();
  const model = currentModel();
  const info = modelInfo(model);
  const bits = [];
  if (model) bits.push(shortModel(model));
  if (persona && persona.prompt) bits.push(`${persona.emoji} ${persona.name}`);
  if (info?.supports_vision) bits.push('vision');
  if (info?.supports_tools) bits.push('tools');
  $('#empty-sub').textContent = bits.length
    ? bits.join('  ·  ')
    : 'Local chat with your selected model server.';

  const starters = $('#starters');
  starters.textContent = '';
  const suggestions = [
    ['Explain a concept', 'Explain how HTTP keep-alive works, with a diagram.'],
    ['Write code', 'Write a Python function that debounces another function.'],
    ['Review my text', 'Tighten this paragraph without changing my voice:\n\n'],
    ['Think it through', 'Three servers, one flaky. How would you find the bad one?'],
  ];
  for (const [label, prompt] of suggestions) {
    starters.append(el('button', {
      class: 'starter',
      onclick: () => {
        const input = $('#input');
        input.value = prompt;
        input.focus();
        input.setSelectionRange(prompt.length, prompt.length);
        autosize(input);
      },
    }, el('b', { text: label }), el('span', { text: prompt.split('\n')[0].slice(0, 62) })));
  }

  // Tools default to off, and nothing on this screen said they existed — a new
  // user had no way to discover the headline feature of 0.8. Offer it here, but
  // only when the model can actually use it, and turn it on as part of asking so
  // the answer is real rather than the model guessing at today's date.
  const hint = $('#empty-tools');
  if (!hint) return;
  const offer = toolsSupported() && !S.chat?.tools;
  hint.hidden = !offer;
  if (!offer) return;
  hint.textContent = '';
  hint.append(
    el('span', { html: svg(ICON.tool, 'ic ic-sm') }),
    el('span', { text: 'This model can use tools. ' }),
    el('button', {
      class: 'link-btn',
      text: 'Try "what time is it in Tokyo?"',
      onclick: () => {
        window.__lantern?.setTools?.(true);
        const input = $('#input');
        input.value = 'What time is it in Tokyo right now?';
        input.focus();
        autosize(input);
      },
    }),
  );
}

function buildMessage(message, index) {
  if (message.role === 'tool') return buildToolMessage(message, index);
  const isUser = message.role === 'user';
  const wrap = el('div', {
    class: `msg msg-${message.role}`,
    dataset: { id: message.id, index: String(index) },
  });

  // A turn that only called a tool has no prose of its own. The tool rows that
  // follow it carry the detail, so a bubble here would just be an empty box —
  // and a second "Assistant" header above the answer that follows.
  const silentToolTurn = !isUser && !message.content && !message.error
    && !message.pending && !!message.tool_calls?.length;

  if (!isUser && !(silentToolTurn && !message.thinking)) {
    wrap.append(el('div', { class: 'msg-head' },
      el('span', { text: 'Assistant' }),
      message.model ? el('span', { class: 'mh-model', text: shortModel(message.model) }) : null,
      message.persona_name ? el('span', { text: `· ${message.persona_name}` }) : null,
    ));
  }

  if (message.images?.length) {
    const imgs = el('div', { class: 'msg-imgs' });
    for (const data of message.images) {
      imgs.append(el('img', { src: `data:image/*;base64,${data}`, alt: 'attachment' }));
    }
    wrap.append(imgs);
  }

  if (!isUser && (message.thinking || message.thinkingPending)) {
    wrap.append(buildThinkBox(message));
  }

  if (!silentToolTurn) {
    const bubble = el('div', { class: 'bubble' });
    if (isUser) {
      bubble.textContent = message.content || '';
    } else if (message.error) {
      bubble.append(el('div', { class: 'msg-err' },
        el('div', { text: message.error }),
        el('button', {
          class: 'btn btn-ghost', style: 'margin-top:9px',
          html: `${svg(ICON.redo, 'ic')}<span>Retry</span>`,
          onclick: () => regenerate(index),
        })));
    } else if (!message.content && message.pending) {
      bubble.append(el('div', { class: 'dots' }, el('i'), el('i'), el('i')));
    } else {
      const body = el('div', { class: 'md' });
      body.innerHTML = S.settings?.render_markdown === false
        ? `<p>${escapeHtml(message.content || '')}</p>`
        : renderMarkdown(message.content || '');
      bubble.append(body);
    }
    wrap.append(bubble);
  }
  if (!isUser && message.variants?.length > 1) {
    wrap.append(buildVariantPager(message, index));
  }
  if (message.toolLimit) {
    // A model denied a tool it still wants often writes the call out as prose
    // (qwen emits a literal <tool_call> block). Mangling the reply to hide that
    // would be worse than explaining it, so say what the text is.
    const leaked = /<\|?tool_call|\[TOOL_CALL/i.test(message.content || '');
    wrap.append(el('div', { class: 'tool-note', text:
      `Reached the ${S.toolRoundLimit}-round tool limit, so this reply was written with no tools offered.`
      + (leaked ? ' Any tool-call syntax above is literal text — nothing further was run.' : '') }));
  }
  wrap.append(buildActions(message, index));
  return wrap;
}

/**
 * One tool result: what was called, with what, and what came back.
 *
 * Collapsed by default — the point of the row is that you *can* audit the call,
 * not that you have to read JSON to follow the conversation.
 */
function buildToolMessage(message, index) {
  const wrap = el('div', {
    class: 'msg msg-tool',
    dataset: { id: message.id, index: String(index) },
  });
  const ok = message.ok !== false;
  const box = el('div', { class: `tool-box${ok ? '' : ' bad'}` });
  const head = el('button', { class: 'tool-head' },
    el('span', { class: 'caret', html: svg(ICON.caret, 'ic ic-sm') }),
    el('span', { html: svg(ICON.tool, 'ic ic-sm') }),
    el('span', { class: 'tool-name', text: message.tool_name || 'tool' }),
    el('span', { class: 'tool-display', text: message.display || (ok ? '' : 'failed') }),
    el('span', { class: 'dur', text: message.ms != null ? formatMs(message.ms) : '' }),
  );
  head.addEventListener('click', () => box.classList.toggle('open'));

  const body = el('div', { class: 'tool-body' });
  const args = message.arguments && Object.keys(message.arguments).length
    ? JSON.stringify(message.arguments, null, 1) : 'none';
  body.append(
    el('div', { class: 'tool-sub', text: 'Arguments' }),
    el('pre', { text: args }),
    el('div', { class: 'tool-sub', text: ok ? 'Returned' : 'Error' }),
    el('pre', { text: prettyJson(message.content || '') }),
  );
  box.append(head, body);
  wrap.append(box);
  return wrap;
}

/** Tool results are JSON strings; show them indented when they parse. */
function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 1);
  } catch {
    return text;
  }
}

function buildThinkBox(message) {
  const live = !!message.thinkingPending;
  const open = live ? (S.settings?.thinking_open ?? false) : false;
  const box = el('div', {
    class: `think-box${live ? ' live' : ''}${open ? ' open' : ''}`,
    dataset: { role: 'think' },
  });
  const head = el('button', { class: 'think-head' },
    el('span', { class: 'caret', html: svg(ICON.caret, 'ic ic-sm') }),
    el('span', { html: svg(ICON.brain, 'ic ic-sm') }),
    el('span', {
      class: live ? 'shimmer' : '',
      text: live ? 'Thinking…' : 'Thought process',
      dataset: { role: 'think-label' },
    }),
    el('span', {
      class: 'dur',
      dataset: { role: 'think-dur' },
      text: message.thinkMs ? formatMs(message.thinkMs) : '',
    }),
  );
  head.addEventListener('click', () => box.classList.toggle('open'));
  const body = el('div', { class: 'think-body', dataset: { role: 'think-body' } });
  body.textContent = message.thinking || '';
  box.append(head, body);
  return box;
}

const formatMs = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/**
 * tok/s from a stats block, or null when Ollama did not report the pair.
 *
 * One definition for both the message footer and the compare columns — the two
 * had the same arithmetic written out twice, which is the kind of duplication
 * that drifts.
 */
function tokRate(stats) {
  const { eval_count: tokens, eval_duration: ns } = stats || {};
  return tokens && ns ? (tokens / (ns / 1e9)).toFixed(1) : null;
}

function buildActions(message, index) {
  const acts = el('div', { class: 'msg-acts' });
  const add = (icon, label, title, fn) => {
    acts.append(el('button', { class: 'act', title, onclick: fn },
      el('span', { html: svg(icon, 'ic') }), label ? el('span', { text: label }) : null));
  };

  // A turn that only called a tool has nothing to copy; the button would toast
  // "Copied" over an empty clipboard.
  if (message.content) add(ICON.copy, '', 'Copy message', async (event) => {
    const ok = await copyText(message.content || '');
    const button = event.currentTarget;
    button.innerHTML = svg(ICON.check, 'ic');
    toast(ok ? 'Copied' : 'Copy failed', ok ? '' : 'bad');
    setTimeout(() => { button.innerHTML = svg(ICON.copy, 'ic'); }, 1200);
  });

  if (message.role === 'user') {
    add(ICON.edit, '', 'Edit and resend', () => startEdit(message, index));
  } else {
    add(ICON.redo, '', 'Regenerate', () => regenerate(index));
    add(ICON.swap, '', 'Regenerate with another model…',
      (event) => regenerateWith(index, event.currentTarget));
    if (comparable(message)) {
      add(ICON.compare, '', 'Answer again with another model, keeping this one…',
        (event) => compareWith(index, event.currentTarget));
    }
    // Only the last turn: continuing an older one would append text below
    // replies that already answered it.
    if (continuable(message) && index === (S.chat?.messages?.length ?? 0) - 1) {
      add(ICON.down, 'Continue', 'This reply hit the length limit — carry on from where it stopped',
        () => continueReply());
    }
    add(ICON.branch, '', 'Branch a new chat from here', () => branchFrom(index));
  }
  add(ICON.trash, '', 'Delete message', () => deleteMessage(index));

  if (message.stats && S.settings?.show_stats !== false) {
    const { eval_count: tokens, prompt_eval_count: promptTokens } = message.stats;
    const rate = tokRate(message.stats);
    const parts = [];
    if (rate) parts.push(`${rate} tok/s`);
    if (message.ttftMs != null) parts.push(`${formatMs(message.ttftMs)} to first token`);
    if (tokens) parts.push(`${num(tokens)} out`);
    if (promptTokens) parts.push(`${num(promptTokens)} in`);
    if (message.stats.total_duration) parts.push(dur(message.stats.total_duration));
    if (parts.length) acts.append(el('span', { class: 'msg-stats', text: parts.join(' · ') }));
  }
  return acts;
}

/* ─────────────────────────── message actions ─────────────────────────── */

/** Small menu anchored under a button. Used by "regenerate with another model". */
function popupMenu(anchor, items) {
  document.querySelectorAll('.floating-menu').forEach((m) => m.remove());
  const menu = el('div', { class: 'menu floating-menu' });
  // One close path for both routes. Removing the node without unbinding leaked
  // a document-level listener (and the menu it captured) on every use.
  let close = () => {};
  for (const item of items) {
    menu.append(el('button', {
      class: `menu-item${item.on ? ' on' : ''}`,
      onclick: () => { close(); item.run(); },
    },
      el('span', { class: 'mi-body' },
        el('span', { class: 'mi-title', text: item.title }),
        item.sub ? el('span', { class: 'mi-sub', text: item.sub }) : null)));
  }
  menu.style.position = 'fixed';
  menu.style.visibility = 'hidden';
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const height = menu.offsetHeight;
  // flip above the button when there is no room below
  const top = rect.bottom + 6 + height > window.innerHeight ? rect.top - height - 6 : rect.bottom + 6;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - menu.offsetWidth - 10)}px`;
  menu.style.visibility = '';
  const dismiss = (event) => { if (!menu.contains(event.target)) close(); };
  close = () => {
    menu.remove();
    document.removeEventListener('mousedown', dismiss, true);
    window.removeEventListener('resize', close);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', dismiss, true);
    window.addEventListener('resize', close);
  }, 0);
}

/** Re-run this turn on a different model. The chat keeps that model afterwards. */
function regenerateWith(index, anchor) {
  const chat = S.chat;
  if (!chat || isStreaming(chat.id)) return;
  const current = currentModel(chat);
  popupMenu(anchor, S.models.map((m) => ({
    title: shortModel(m.name),
    sub: m.name === current ? 'current model' : (m.parameter_size || ''),
    on: m.name === current,
    run: async () => {
      chat.model = m.name;
      if (!thinkingSupported(m.name)) chat.think = false;
      emit('model-changed');
      await regenerate(index);
    },
  })));
}

/**
 * Answer this turn again with another model, keeping the existing answer.
 *
 * Sequential by necessity — one run per chat, and two loaded models will not fit
 * in memory together on the machines this targets.
 */
function compareWith(index, anchor) {
  const chat = S.chat;
  if (!chat || isStreaming(chat.id)) return;
  const already = new Set((chat.messages[index]?.variants || []).map((v) => v.model));
  popupMenu(anchor, S.models.map((m) => ({
    title: shortModel(m.name),
    sub: already.has(m.name) ? 'already answered this' : (m.parameter_size || ''),
    on: already.has(m.name),
    run: () => {
      // Comparisons run with no tools — say so rather than letting the answer
      // quietly be a different kind of answer than the one it sits beside.
      if (effectiveTools(chat).length) toast('Comparing without tools — a variant holds one answer');
      runAssistant(chat, { compareAt: index, model: m.name });
    },
  })));
}

/** ‹ 2/3 › — switch which answer this turn shows, or see them together. */
function buildVariantPager(message, index) {
  const total = message.variants.length;
  const at = Math.min(message.variant ?? 0, total - 1);
  const step = (delta) => selectVariant(S.chat, index, (at + delta + total) % total);
  return el('div', { class: 'variant-pager' },
    el('button', { class: 'vp-arrow', title: 'Previous answer',
      html: svg(ICON.caret, 'ic ic-sm'), onclick: () => step(-1) }),
    el('span', { class: 'vp-count', text: `${at + 1}/${total}` }),
    el('button', { class: 'vp-arrow next', title: 'Next answer',
      html: svg(ICON.caret, 'ic ic-sm'), onclick: () => step(1) }),
    el('span', { class: 'vp-model', text: shortModel(message.model || '') }),
    el('button', { class: 'vp-open', title: 'See the answers side by side',
      html: `${svg(ICON.compare, 'ic ic-sm')}<span>Compare</span>`,
      onclick: () => openCompare(index) }),
  );
}

/** Per-variant figures. Speed is half the comparison on local models. */
function variantStats(variant) {
  const s = variant.stats || {};
  const rate = tokRate(s);
  const parts = [];
  if (rate) parts.push(`${rate} tok/s`);
  if (variant.ttftMs != null) parts.push(`${formatMs(variant.ttftMs)} to first token`);
  if (s.eval_count) parts.push(`${num(s.eval_count)} out`);
  if (variant.thinkMs) parts.push(`${formatMs(variant.thinkMs)} thinking`);
  return parts;
}

/**
 * The answers in columns.
 *
 * Static text — nothing streams here — so the cost is one render of content
 * that already exists. Showing the metrics beside each answer is the point:
 * on local models the real question is whether a slower model was worth it.
 */
function openCompare(index) {
  const chat = S.chat;
  const message = chat?.messages?.[index];
  if (!message?.variants?.length) return;
  const selected = Math.min(message.variant ?? 0, message.variants.length - 1);

  const grid = el('div', { class: 'cmp-grid' });
  message.variants.forEach((variant, i) => {
    const body = el('div', { class: 'md' });
    body.innerHTML = S.settings?.render_markdown === false
      ? `<p>${escapeHtml(variant.content || '')}</p>`
      : renderMarkdown(variant.content || '');
    const column = el('div', { class: `cmp-col${i === selected ? ' on' : ''}` },
      el('div', { class: 'cmp-head' },
        el('span', { class: 'cmp-model', text: shortModel(variant.model || '—') }),
        i === selected ? el('span', { class: 'cmp-badge', text: 'in use' }) : null),
      el('div', { class: 'cmp-stats', text: variantStats(variant).join('  ·  ') || '—' }),
      el('div', { class: 'cmp-body' }, body),
      el('button', {
        class: 'btn btn-ghost cmp-use',
        text: i === selected ? 'Currently used' : 'Use this answer',
        disabled: i === selected,
        onclick: async () => { await selectVariant(chat, index, i); closeModal(); },
      }));
    grid.append(column);
  });

  openModal(`Compare ${message.variants.length} answers`, grid, null, { wide: true });
  wireCodeBlocks(grid);
}

function startEdit(message, index) {
  const node = threadBox().querySelector(`.msg[data-id="${message.id}"]`);
  if (!node) return;
  const box = el('div', { class: 'msg-edit', style: 'width:100%' });
  const ta = el('textarea');
  ta.value = message.content || '';
  const acts = el('div', { class: 'edit-acts' },
    el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => renderThread() }),
    el('button', {
      class: 'btn btn-primary',
      text: 'Save & resend',
      onclick: async () => {
        const text = ta.value.trim();
        if (!text) return;
        const chat = S.chat;
        if (isStreaming(chat.id)) return;
        message.content = text;
        chat.messages.length = index + 1;
        await queueSaveFor(chat, true);
        renderThread();
        runAssistant(chat);
      },
    }),
  );
  box.append(ta, acts);
  node.textContent = '';
  node.append(box);
  ta.focus();
  ta.style.height = `${Math.min(ta.scrollHeight, 400)}px`;
  ta.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') renderThread();
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) acts.lastChild.click();
  });
}

/** Carry on a reply that stopped because it ran out of room. */
async function continueReply() {
  const chat = S.chat;
  if (!chat || isStreaming(chat.id)) return;
  await runAssistant(chat, { resume: true });
}

async function regenerate(index) {
  const chat = S.chat;
  if (!chat || isStreaming(chat.id)) return;
  chat.messages.length = index;   // drop this assistant turn and anything after
  await queueSaveFor(chat, true);
  renderThread();
  runAssistant(chat);
}

async function deleteMessage(index) {
  const chat = S.chat;
  // Removing a message while this chat streams would shift the indices the
  // in-flight run is writing against.
  if (!chat || isStreaming(chat.id)) {
    toast('Wait for the reply to finish', 'bad');
    return;
  }
  chat.messages.splice(index, 1 + toolTail(chat.messages, index));
  await queueSaveFor(chat, true);
  renderThread();
}

/**
 * How many `tool` messages sit directly under the call at `index`.
 *
 * A tool result belongs to the call above it, so anything that cuts the history
 * at a turn has to keep the pair together — otherwise the next request either
 * replays an answer to a call the model never made, or a call with no answer.
 */
function toolTail(messages, index) {
  if (!messages[index]?.tool_calls?.length) return 0;
  let n = 0;
  while (messages[index + 1 + n]?.role === 'tool') n += 1;
  return n;
}

async function branchFrom(index) {
  const source = S.chat;
  const end = index + 1 + toolTail(source.messages, index);
  const slice = source.messages.slice(0, end).map((m) => ({ ...m }));
  const chat = await newChat({ model: source.model, personaId: source.persona_id, focus: false });
  chat.messages = slice;
  chat.title = `${source.title || 'Chat'} ↗`;
  chat.think = source.think;
  chat.tools = !!source.tools;
  chat.params = { ...source.params };
  chat.system_override = source.system_override;
  await queueSaveChat(true);
  emit('chat', { focus: true });
  toast('Branched to a new chat');
}

/* ─────────────────────────── sending ─────────────────────────── */

export async function sendMessage(text) {
  const trimmed = (text || '').trim();
  const attachments = S.attachments.slice();
  if (!trimmed && !attachments.length) return;

  if (!S.chat) await newChat({ focus: false });
  const chat = S.chat;
  if (!S.models.some((model) => model.name === currentModel(chat))) {
    toast('Choose a model available on this server before sending', 'bad');
    return;
  }
  // Only this conversation being busy blocks a send; other chats may stream.
  if (isStreaming(chat.id)) {
    toast('This chat is still replying', 'bad');
    return;
  }

  let content = trimmed;
  const images = [];
  for (const att of attachments) {
    if (att.kind === 'image') images.push(att.data);
    else content += `\n\n${att.name}:\n\`\`\`${att.lang || ''}\n${att.text}\n\`\`\``;
  }

  const message = {
    id: msgId(),
    role: 'user',
    content: content.trim(),
    ts: Date.now() / 1000,
  };
  if (images.length) message.images = images;

  chat.messages.push(message);
  S.attachments = [];
  emit('attachments');
  renderThread();
  await queueSaveFor(chat);
  await runAssistant(chat);
}

/** Build the message array Ollama receives. */
function buildPayloadMessages(chat, limit) {
  const messages = [];
  const system = effectiveSystem(chat);
  if (system && system.trim()) messages.push({ role: 'system', content: system });
  // `limit` exists for comparison: the turn being re-answered sits *inside* the
  // array rather than at the end, so everything from it onward must be cut or
  // the model is shown the future.
  const history = Number.isInteger(limit) ? chat.messages.slice(0, limit) : chat.messages;
  for (const message of history) {
    if (message.error && !message.content) continue;
    if (message.role === 'tool') {
      // One message per call, named so the model can pair it with the call it
      // made. Ollama's chat templates key on tool_name, not on a call id.
      messages.push({
        role: 'tool',
        tool_name: message.tool_name || '',
        content: message.content || '',
      });
      continue;
    }
    // An assistant turn that only called a tool has no content, but it must
    // still be replayed or the tool result under it answers nothing.
    if (message.role === 'assistant' && !message.content && !message.tool_calls?.length) continue;
    const out = { role: message.role, content: message.content || '' };
    if (message.images?.length) out.images = message.images;
    if (message.tool_calls?.length) out.tool_calls = message.tool_calls;
    messages.push(out);
  }
  return messages;
}

/* ─────────────────────────── answer variants ─────────────────────────── */

/**
 * One assistant turn can hold several answers — the same question put to
 * different models — and the thread shows whichever is selected.
 *
 * The selected variant is mirrored onto the message itself rather than read
 * through an index, so `buildPayloadMessages()`, saving, export and search all
 * carry on working untouched. `variants` and `variant` are the only new fields.
 *
 * Generation is sequential by necessity, not preference: two loaded models is
 * roughly 14.6 GB on a 16 GB machine. See the rejected-approaches table in
 * NOTES.md.
 */
const VARIANT_FIELDS = ['content', 'thinking', 'thinkMs', 'model', 'persona_name',
  'stats', 'ttftMs', 'error', 'stopped', 'toolLimit'];

function snapshotVariant(message) {
  const out = {};
  for (const key of VARIANT_FIELDS) {
    if (message[key] !== undefined) out[key] = message[key];
  }
  return out;
}

function applyVariant(message, variant) {
  for (const key of VARIANT_FIELDS) delete message[key];
  Object.assign(message, variant);
}

/** Show variant `index` of the turn at `at`, and remember the choice. */
async function selectVariant(chat, at, index) {
  const message = chat.messages[at];
  if (!message?.variants?.[index]) return;
  // The pager is on screen while a *further* comparison streams into this same
  // turn. Swapping the answer under a live stream leaves the painter appending
  // new tokens onto the old text.
  if (isStreaming(chat.id)) {
    toast('Wait for the reply to finish', 'bad');
    return;
  }
  if (message.variant === index) return;
  applyVariant(message, message.variants[index]);
  message.variant = index;
  await queueSaveFor(chat, true);
  // One message changed, not the thread. renderThread() would also rebuild
  // every code block and can pull a long chat back to the bottom.
  if (chat.id !== S.chat?.id || !replaceMessageNode(chat, at)) renderThread();
}

/**
 * Whether a reply was cut off mid-thought rather than finishing.
 *
 * Ollama reports `done_reason: "length"` when a turn hits `num_predict`, which
 * is the honest signal — the alternative is guessing from whether the text ends
 * in punctuation, which is wrong for code, lists and tables. The field has been
 * recorded in every message's stats since 0.8; nothing read it until now.
 */
const continuable = (message) => message?.role === 'assistant'
  && !message.pending
  && !!message.content
  && !message.tool_calls?.length
  && message.stats?.done_reason === 'length';

/**
 * A turn that called tools cannot be compared: its results live in separate
 * `tool` messages after it, so swapping the answer would leave the wrong rows
 * underneath. A failed turn is excluded too — Retry is the action there, and an
 * error is not an answer worth keeping beside a real one.
 */
const comparable = (message) => message?.role === 'assistant'
  && !message.pending && !message.error && !message.tool_calls?.length;

/**
 * Run every tool call from one assistant turn and append a `tool` message for
 * each result.
 *
 * Returns the calls that actually produced a result. Only those are recorded on
 * the assistant message, so history can never contain a call with no answer
 * under it — which is what an aborted round would otherwise leave behind.
 */
async function runToolCalls(chat, calls, signal) {
  const done = [];
  for (const call of calls) {
    const fn = call.function || {};
    const name = fn.name || '';
    const args = (fn.arguments && typeof fn.arguments === 'object') ? fn.arguments : {};
    let result;
    try {
      result = await api.callTool(name, args, signal);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      // Reaching our own server failed, which the model can still act on.
      result = {
        ok: false, name, arguments: args, ms: null,
        content: `Error: the tool could not be run (${err.message}).`,
        display: 'could not run',
      };
    }
    chat.messages.push({
      id: msgId(),
      role: 'tool',
      tool_name: result.name || name,
      content: result.content || '',
      arguments: result.arguments || args,
      display: result.display || '',
      ok: result.ok !== false,
      ms: result.ms,
      ts: Date.now() / 1000,
    });
    done.push(call);
  }
  return done;
}

/** No model gets to fire an unbounded number of tools in a single turn. */
const MAX_CALLS_PER_ROUND = 8;

/**
 * Ollama sends tool calls whole, on the final chunk. Merging by index anyway
 * means a model that emits them piecemeal still ends up with one entry per call
 * rather than one per fragment.
 */
function mergeToolCalls(into, incoming) {
  for (const call of incoming) {
    if (!call || typeof call !== 'object') continue;
    const index = (call.function || {}).index;
    const at = index == null ? -1
      : into.findIndex((c) => (c.function || {}).index === index);
    if (at >= 0) into[at] = call;
    else into.push(call);
  }
}

/**
 * Generate a reply, running any tools the model asks for and feeding the results
 * back until it answers in prose.
 *
 * Each round is its own assistant message with its own stats, so the thread
 * shows what was called and how long each leg took. The cap is on *rounds*, not
 * on total calls: past it we ask once more with no tools attached, which makes
 * the model answer from what it already has instead of leaving the turn dead.
 */
export async function runAssistant(chat = S.chat, opts = {}) {
  if (!chat || isStreaming(chat.id)) return;
  // Comparison re-answers a turn that already exists, in place: the old answer
  // is snapshotted first, the message is cleared and streamed into with the
  // whole normal pipeline, and the result is appended as another variant. That
  // reuses the painter, the tool loop and the round cap rather than forking them.
  const compareAt = Number.isInteger(opts.compareAt) ? opts.compareAt : null;
  const target = compareAt === null ? null : chat.messages[compareAt];
  if (compareAt !== null && !comparable(target)) return;

  // Continue picks up a reply the model stopped mid-sentence because it hit
  // num_predict. It only ever applies to the *last* message, which is both the
  // only place it means anything and the reason it can leave the tool loop
  // alone: anything a continued turn appends still lands at the end of the
  // array, where the loop already expects it.
  const resume = !!opts.resume && continuable(chat.messages[chat.messages.length - 1]);
  const resumeTarget = resume ? chat.messages[chat.messages.length - 1] : null;

  const model = opts.model || currentModel(chat);
  if (!model) {
    toast('No model selected — choose one from the Models panel', 'bad');
    return;
  }
  if (!S.models.some((item) => item.name === model)) {
    toast('This model is not available on the selected server. Choose one from Models.', 'bad');
    return;
  }
  const visible = () => S.chat?.id === chat.id;

  const persona = currentPersona(chat);
  // Both answer for the model actually being asked, which in a comparison is
  // not the chat's model.
  const think = effectiveThink(chat, model);
  // A comparison runs with no tools. A variant is one answer on one message,
  // and a tool exchange is an assistant turn plus a `tool` row per result —
  // there is nowhere inside a variant to keep them, and appending them beside a
  // turn in the middle of the thread corrupts the history. See NOTES.md.
  const toolNames = compareAt === null ? effectiveTools(chat, model) : [];

  // Keep what is on screen now, so a comparison that produces nothing usable
  // can put it back exactly as it was.
  const restore = target ? snapshotVariant(target) : null;
  const freshVariants = !!target && !Array.isArray(target.variants);
  let restoreAt = 0;
  if (target) {
    if (freshVariants) {
      target.variants = [restore];
      target.variant = 0;
    } else {
      restoreAt = Math.min(Math.max(target.variant ?? 0, 0), target.variants.length - 1);
    }
  }

  const abort = new AbortController();
  let placeholder = null;
  let painter = { stop() {}, body() {}, think() {}, finishThink() {} };
  let rounds = 0;

  /** One request and its stream. Returns the tool calls the model asked for. */
  async function streamRound(withTools) {
    painter.stop();
    if (resumeTarget && rounds === 0) {
      // Stream *into* the existing reply. Nothing is cleared, so the painter
      // appends to the text already there and the message grows rather than
      // being replaced — which is the whole point: one continuous answer.
      placeholder = resumeTarget;
      placeholder.pending = false;
      delete placeholder.stopped;
    } else if (target && rounds === 0) {
      // Stream over the turn being compared, keeping its id so the painter, its
      // DOM node and any open find-marks stay attached to it.
      placeholder = target;
      for (const key of VARIANT_FIELDS) delete placeholder[key];
      Object.assign(placeholder, {
        content: '', thinking: '', model,
        persona_name: persona && persona.prompt ? persona.name : null,
        pending: true,
      });
    } else {
      placeholder = {
        id: msgId(),
        role: 'assistant',
        content: '',
        thinking: '',
        ts: Date.now() / 1000,
        model,
        persona_name: persona && persona.prompt ? persona.name : null,
        pending: true,
      };
    }
    if (think) placeholder.thinkingPending = true;

    const body = {
      model,
      // Cut the history at the turn being re-answered, or the model is shown
      // its own later replies.
      // A resume sends the history *including* the half-finished reply, then a
      // nudge that is never stored — writing it into the chat would leave a
      // "carry on" turn sitting in the transcript for ever.
      messages: resume
        ? buildPayloadMessages(chat, chat.messages.length).concat([{
          role: 'user',
          content: 'Continue your previous message from exactly where it stopped. '
            + 'Do not repeat anything you have already written, do not restate the '
            + 'question, and do not start again — carry straight on, mid-sentence '
            + 'if that is where it ended.',
        }])
        : buildPayloadMessages(chat, compareAt),
      options: effectiveParams(chat),
    };
    if (S.settings?.keep_alive) body.keep_alive = S.settings.keep_alive;
    // null means "don't send the field at all" — see effectiveThink().
    if (think !== null) body.think = think;
    // Names only. server.py resolves them against its own registry, so the
    // front end can never describe a callable the server cannot run.
    if (withTools) body.tools = toolNames;

    // Compare and resume both stream into a message that is *already* in the
    // array. Testing only against the compare target pushed a resumed reply in a
    // second time, so the thread grew a duplicate instead of the answer growing.
    const alreadyInThread = placeholder === target || placeholder === resumeTarget;
    if (!alreadyInThread) {
      chat.messages.push(placeholder);
      if (visible()) appendMessagesFrom(chat, chat.messages.length - 1);
    } else if (visible()) {
      replaceMessageNode(chat, chat.messages.indexOf(placeholder));
    }
    if (rounds === 0) beginRun(chat, placeholder.id, abort);
    painter = makePainter(chat, placeholder);
    rounds += 1;

    const started = performance.now();
    let firstTokenAt = null;      // real TTFT: request sent -> first output of any kind
    let firstThinkAt = null;
    let lastThinkAt = null;
    let stats = null;
    let sawContent = false;
    const calls = [];

    for await (const chunk of chatStream(body, abort.signal)) {
      if (chunk.error) throw new Error(chunk.error);
      if (chunk.warning) toast(chunk.warning, 'bad');
      if (chunk.tools_unavailable) {
        const info = modelInfo(model);
        if (info) info.supports_tools = false;
        emit('models');
      }
      const part = chunk.message || {};

      if ((part.thinking || part.content) && firstTokenAt === null) {
        firstTokenAt = performance.now();
        placeholder.ttftMs = Math.round(firstTokenAt - started);
      }
      if (part.thinking) {
        if (firstThinkAt === null) {
          firstThinkAt = performance.now();
          // First time we have seen this model reason: remember it so the
          // toggle appears, and keep it on so behaviour stays consistent.
          if (noteThinkingObserved(model)) {
            chat.think = true;
            queueSaveFor(chat);
            if (visible()) emit('model-changed');
          }
        }
        lastThinkAt = performance.now();
        placeholder.thinking += part.thinking;
        placeholder.thinkingPending = true;
        painter.think();
      }
      if (part.content) {
        if (!sawContent) {
          sawContent = true;
          placeholder.pending = false;
          if (placeholder.thinkingPending) {
            placeholder.thinkingPending = false;
            placeholder.thinkMs = firstThinkAt !== null
              ? Math.round((lastThinkAt || performance.now()) - firstThinkAt) : 0;
            painter.finishThink();
          }
        }
        placeholder.content += part.content;
        painter.body();
      }
      if (part.tool_calls?.length) mergeToolCalls(calls, part.tool_calls);
      if (chunk.done) {
        stats = {
          eval_count: chunk.eval_count,
          eval_duration: chunk.eval_duration,
          prompt_eval_count: chunk.prompt_eval_count,
          prompt_eval_duration: chunk.prompt_eval_duration,
          total_duration: chunk.total_duration,
          done_reason: chunk.done_reason,
        };
      }
    }

    placeholder.pending = false;
    placeholder.thinkingPending = false;
    if (placeholder.thinking && !placeholder.thinkMs) {
      placeholder.thinkMs = firstThinkAt !== null
        ? Math.round((lastThinkAt || performance.now()) - firstThinkAt) : 0;
    }
    placeholder.stats = stats || { total_duration: (performance.now() - started) * 1e6 };
    // A turn that only called a tool is not empty — the tool rows under it are
    // the content. But a turn of nothing *but* calls we are not going to run
    // would render as a blank bubble, so say what happened instead.
    if (!placeholder.content && !placeholder.thinking) {
      if (!calls.length) {
        placeholder.error = 'The model returned an empty response.';
      } else if (!withTools) {
        if (toolNames.length) {
          placeholder.error = `The model asked for another tool after the ${S.toolRoundLimit}-round limit, `
            + 'and wrote no answer of its own.';
        } else if (compareAt !== null) {
          placeholder.error = 'The model tried to call a tool. Comparisons run without tools, '
            + 'so nothing was called.';
        } else {
          placeholder.error = 'The model tried to call a tool, but tools are off for this chat.';
        }
      }
    }
    return calls.slice(0, MAX_CALLS_PER_ROUND);
  }

  try {
    let capped = false;      // the previous round wanted tools we would not run
    for (;;) {
      const withTools = toolNames.length > 0 && rounds < S.toolRoundLimit;
      const calls = await streamRound(withTools);
      if (capped) placeholder.toolLimit = true;
      if (!calls.length || !withTools) break;

      const firstResult = chat.messages.length;
      const executed = await runToolCalls(chat, calls, abort.signal);
      // Record only the calls that produced a result, so history never holds a
      // call with nothing under it.
      if (executed.length) placeholder.tool_calls = executed;
      if (visible()) {
        // The assistant turn above just lost its bubble (it is a silent tool
        // turn now), so rebuild that one node and append the results.
        replaceMessageNode(chat, chat.messages.indexOf(placeholder));
        appendMessagesFrom(chat, firstResult);
      } else {
        emit('chats');
      }
      // Debounced, not immediate: the turn saves in full when it ends, and an
      // immediate write here means a complete rewrite of the chat per round.
      queueSaveFor(chat);
      if (!executed.length) break;
      capped = rounds >= S.toolRoundLimit;
    }
  } catch (err) {
    if (placeholder) {
      placeholder.pending = false;
      placeholder.thinkingPending = false;
    }
    if (err.name === 'AbortError') {
      if (placeholder) {
        placeholder.stopped = true;
        const at = chat.messages.indexOf(placeholder);
        // Stopped part-way through executing tools: drop the results whose call
        // was never recorded, or history answers a question it doesn't contain.
        // Only ever this run's own rows — a comparison streams into a turn in
        // the *middle* of the thread, where truncating to `at + 1` deleted every
        // message after it. Verified: it really did.
        if (at >= 0 && placeholder !== target && !placeholder.tool_calls?.length) {
          chat.messages.length = at + 1;
        }
        if (!placeholder.content && !placeholder.thinking) {
          // splice in place — other code holds a reference to this array
          if (at >= 0 && placeholder !== target) chat.messages.splice(at, 1);
        }
      }
    } else if (placeholder) {
      placeholder.error = err.hint ? `${err.message} — ${err.hint}` : err.message;
      console.error(err);
    }
  } finally {
    // A comparison either gained an answer or it did not, and both outcomes are
    // decided here — the restore used to live in `catch`, which missed the paths
    // that fail without throwing: an empty reply, or a round that ends in an
    // error. Those left the turn showing nothing with the previous answer
    // reachable only by reading the JSON on disk.
    if (target && Array.isArray(target.variants)) {
      if (target.content) {
        // Keep the new answer beside the old one, and select it.
        target.variants.push(snapshotVariant(target));
        target.variant = target.variants.length - 1;
      } else {
        // Nothing usable — stopped before a token, an error, an empty reply.
        // Put the turn back exactly as it was rather than blanking it or
        // pushing a second copy of the answer that is already there.
        const failed = target.error;
        applyVariant(target, restore);
        target.variant = restoreAt;
        target.pending = false;
        target.thinkingPending = false;
        if (freshVariants) {
          delete target.variants;
          delete target.variant;
        }
        if (failed) toast(failed, 'bad');
      }
    }
    painter.stop();
    endRun(chat.id);
    if (visible()) renderThread();
    else emit('chats');
    await saveNow(chat);
    maybeAutoTitle(chat);
  }
}

export function stopGeneration(chatId = S.chat?.id) {
  if (abortRun(chatId)) toast('Stopped');
}

/**
 * Throttled incremental DOM updates. Markdown is re-rendered without syntax
 * highlighting while tokens stream (highlighting the whole buffer on every
 * chunk gets expensive fast); the final pass in renderThread() adds it back.
 */
function makePainter(chat, message) {
  let raf = null;
  let lastPaint = 0;
  let bodyDirty = false;
  let thinkDirty = false;
  const INTERVAL = 55;

  // Re-rendering the whole buffer each frame is O(n) per paint and so O(n²)
  // over a reply — a 20k-character answer was ~16M character operations. The
  // prefix up to the last blank line outside a code fence is stable, so render
  // it once, cache the HTML, and re-parse only the tail. renderThread() does a
  // full single-pass render with highlighting at the end, which corrects any
  // block that a split happened to interrupt.
  let prefixLen = 0;
  let prefixHtml = '';

  function fenceParityEven(text, upto) {
    let count = 0;
    for (let i = text.indexOf('```'); i >= 0 && i < upto; i = text.indexOf('```', i + 3)) count++;
    return count % 2 === 0;
  }

  function renderStreaming(content) {
    if (S.settings?.render_markdown === false) return `<p>${escapeHtml(content)}</p>`;
    const cut = content.lastIndexOf('\n\n', content.length - 1);
    if (cut > prefixLen && fenceParityEven(content, cut)) {
      const end = cut + 2;
      prefixHtml = renderMarkdown(content.slice(0, end), { highlight: false });
      prefixLen = end;
    }
    // join with a newline so the concatenation matches a single-pass render
    return prefixLen
      ? `${prefixHtml}\n${renderMarkdown(content.slice(prefixLen), { highlight: false })}`
      : renderMarkdown(content, { highlight: false });
  }

  // Resolved per paint, not captured: the thread is re-rendered on chat switch,
  // so a captured node would go stale and the message would stop updating.
  const findNode = () => (S.chat?.id === chat.id
    ? threadBox().querySelector(`.msg[data-id="${message.id}"]`) : null);

  function paint(now) {
    raf = null;
    const node = findNode();
    if (!node) { schedule(); return; }   // off-screen: keep polling cheaply
    const bubble = () => node.querySelector('.bubble');
    if (now - lastPaint < INTERVAL) { schedule(); return; }
    lastPaint = now;

    if (thinkDirty) {
      thinkDirty = false;
      let box = node.querySelector('[data-role="think"]');
      if (!box) {
        box = buildThinkBox(message);
        node.insertBefore(box, bubble());
      }
      const body = box.querySelector('[data-role="think-body"]');
      if (body) {
        const pinned = box.classList.contains('open');
        body.textContent = message.thinking;
        if (pinned) body.scrollTop = body.scrollHeight;
      }
    }

    if (bodyDirty) {
      bodyDirty = false;
      const target = bubble();
      if (target) {
        let md = target.querySelector('.md');
        if (!md) {
          target.textContent = '';
          md = el('div', { class: 'md' });
          target.append(md);
        }
        md.innerHTML = renderStreaming(message.content);
      }
    }
    autoScroll();
    updateLiveStats(message);
  }

  function schedule() {
    if (raf !== null) return;
    if (S.chat?.id !== chat.id) {
      // not on screen — check back occasionally instead of every frame
      raf = -1;
      setTimeout(() => { raf = null; schedule(); }, 400);
      return;
    }
    raf = requestAnimationFrame(paint);
  }

  return {
    body() { bodyDirty = true; schedule(); },
    think() { thinkDirty = true; schedule(); },
    finishThink() {
      const box = findNode()?.querySelector('[data-role="think"]');
      if (!box) return;
      box.classList.remove('live');
      const label = box.querySelector('[data-role="think-label"]');
      if (label) { label.classList.remove('shimmer'); label.textContent = 'Thought process'; }
      const stamp = box.querySelector('[data-role="think-dur"]');
      if (stamp && message.thinkMs) stamp.textContent = formatMs(message.thinkMs);
      if (!S.settings?.thinking_open) box.classList.remove('open');
    },
    stop() { if (raf !== null && raf !== -1) cancelAnimationFrame(raf); raf = null; },
  };
}

function updateLiveStats(message) {
  const box = $('#live-stats');
  if (!box) return;
  const chars = (message.content || '').length;
  const secs = (Date.now() / 1000) - message.ts;
  const approx = estTokens(message.content);
  box.textContent = secs > 0.4 && approx
    ? `~${(approx / secs).toFixed(1)} tok/s · ${chars} chars`
    : '';
}

async function maybeAutoTitle(chat) {
  if (!S.settings?.auto_title || !chat) return;
  if (chat.title && chat.title !== 'New chat') return;
  // Tool results are JSON and say nothing about what the chat is about.
  const messages = chat.messages.filter((m) => m.content && m.role !== 'tool');
  if (messages.length < 2) return;

  // Fall back to a trimmed first line if the model can't produce a title.
  const first = messages[0].content.replace(/\s+/g, ' ').trim();
  const fallback = first.length > 52 ? `${first.slice(0, 52).trimEnd()}…` : first;

  const transcript = messages.slice(0, 2)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 700)}`)
    .join('\n\n');
  try {
    const { title } = await api.title(chat.model || currentModel(chat), transcript);
    chat.title = (title && title.length > 2 ? title : fallback) || fallback;
  } catch {
    chat.title = fallback;
  }
  emit('chat-title');
  await saveNow(chat);
}

/* ─────────────────────────── scroll & footer ─────────────────────────── */

function autoScroll() {
  if (!stickToBottom) return;
  const box = scrollBox();
  box.scrollTop = box.scrollHeight;
}

export function scrollToBottom(instant = false) {
  const box = scrollBox();
  stickToBottom = true;
  if (instant) {
    const previous = box.style.scrollBehavior;
    box.style.scrollBehavior = 'auto';
    box.scrollTop = box.scrollHeight;
    box.style.scrollBehavior = previous;
  } else {
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  }
  $('#jump-btn').hidden = true;
}

export function wireScroll() {
  const box = scrollBox();
  box.addEventListener('scroll', () => {
    const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
    stickToBottom = distance < 90;
    $('#jump-btn').hidden = distance < 220;
  }, { passive: true });
  $('#jump-btn').addEventListener('click', () => scrollToBottom());
}

/** Context-usage hint under the composer. */
export function updateFoot() {
  const hint = $('#ctx-hint');
  if (!hint) return;
  const info = modelInfo(currentModel());
  const limit = effectiveParams().num_ctx || info?.context_length || 0;
  if (!S.chat) { hint.textContent = ''; return; }

  let used = estTokens(effectiveSystem());
  for (const message of S.chat.messages) used += estTokens(message.content) + 4;
  const parts = [`~${num(used)} tok`];
  if (limit) {
    const pct = Math.min(100, Math.round((used / limit) * 100));
    parts.push(`${pct}% of ${num(limit)}`);
    hint.style.color = pct > 90 ? '#f87171' : '';
  } else {
    hint.style.color = '';
  }
  const count = S.chat.messages.length;
  if (count) parts.push(`${count} msg`);
  hint.textContent = parts.join(' · ');
}

export function exportChat(format = 'md') {
  const chat = S.chat;
  if (!chat) return;
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = (chat.title || 'chat').replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 50) || 'chat';

  if (format === 'json') {
    download(`${slug}-${stamp}.json`, JSON.stringify(chat, null, 2), 'application/json');
    return;
  }
  const lines = [
    `# ${chat.title || 'Chat'}`,
    '',
    `- Model: \`${chat.model || '—'}\``,
    `- Exported: ${new Date().toLocaleString()}`,
  ];
  const system = effectiveSystem();
  if (system) lines.push('', '## System prompt', '', '```', system, '```');
  lines.push('', '---', '');
  for (const message of chat.messages) {
    if (message.role === 'tool') {
      lines.push(`### Tool · ${message.tool_name || 'tool'}`, '',
        '```json', message.content || '', '```', '');
      continue;
    }
    if (!message.content && message.tool_calls?.length) {
      const named = message.tool_calls
        .map((c) => (c.function || {}).name).filter(Boolean).join(', ');
      lines.push(`## Assistant`, '', `_Called: ${named}_`, '');
      continue;
    }
    lines.push(`## ${message.role === 'user' ? 'You' : 'Assistant'}`, '');
    if (message.thinking) {
      lines.push('<details><summary>Thinking</summary>', '', '```', message.thinking, '```', '', '</details>', '');
    }
    lines.push(message.content || '', '');
  }
  download(`${slug}-${stamp}.md`, lines.join('\n'), 'text/markdown');
  toast('Exported');
}

/* ─────────────────────────── wiring ─────────────────────────── */

on('chat', () => renderThread(true));
on('models', () => { if (!S.chat?.messages?.length) updateEmptyState(); updateFoot(); });
on('tools-changed', () => { if (!S.chat?.messages?.length) updateEmptyState(); });
on('streaming', (busy) => {
  $('#btn-send').hidden = busy;
  $('#btn-stop').hidden = !busy;
  $('#status-dot').classList.toggle('busy', busy);
  if (!busy) $('#live-stats').textContent = '';
});
