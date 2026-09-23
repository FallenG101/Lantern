// Bootstrap and wiring.

import {
  S, on, emit, loadBootstrap, refreshModels, refreshChatList, patchSettings,
  newChat, openChat, removeChat, queueSaveChat, flushChat, flushBeacon,
  currentModel, currentPersona, thinkingSupported, visionSupported, toolsSupported,
  isStreaming, anyStreaming, thinkingAdvertised, refreshUpdate,
  refreshFolders, createFolder, renameFolder, deleteFolder, setChatFolder,
} from './store.js';
import { api } from './api.js';
import {
  renderThread, sendMessage, stopGeneration, wireScroll, updateFoot, exportChat,
} from './chat.js';
import {
  openSettings, openPersonas, openModels, openParams, openShortcuts, openGuide,
  closeModal, modalOpen, applyPersona, pickModel, applyVisual, openPrompts,
  insertPrompt,
} from './modals.js';
import {
  openPalette, closePalette, paletteOpen, registerCommands, wirePalette,
} from './palette.js';
import { applyTheme, resolvedTheme } from './theme.js';
import { onboardingNeeded, startOnboarding, wireOnboarding } from './onboard.js';
import {
  $, $$, el, svg, ICON, toast, dayBucket, shortModel, bytes, num,
  autosize, debounce, copyText, MOD, isMac,
} from './util.js';

const LAST_CHAT_KEY = 'lantern.lastChat';
window.__lantern = { MOD };

/* ═══════════════════════════ sidebar ═══════════════════════════ */

/**
 * Which folders are rolled up. Kept in localStorage rather than on the folder
 * itself: it is a property of this window, not of the data, and writing it to
 * the folder file would mean a disk write on every disclosure triangle.
 */
const COLLAPSED_KEY = 'lantern.folders.collapsed';
const collapsedFolders = new Set((() => {
  try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || []; } catch { return []; }
})());
const saveCollapsed = () =>
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedFolders]));

function renderSidebar() {
  const list = $('#chat-list');
  list.textContent = '';

  if (S.searchResults) {
    if (!S.searchResults.length) {
      list.append(el('div', { class: 'list-empty', text: 'No matches.' }));
      return;
    }
    list.append(el('div', { class: 'list-label', text: `${S.searchResults.length} result${S.searchResults.length === 1 ? '' : 's'}` }));
    for (const hit of S.searchResults) {
      list.append(chatRow(hit, hit.matches?.[0]?.snippet));
    }
    requestAnimationFrame(moveLens);
    return;
  }

  const archived = S.chats.filter((c) => c.archived);
  const visible = S.chats.filter((c) => !c.archived);
  if (!visible.length && !archived.length) {
    list.append(el('div', { class: 'list-empty', text: 'No chats yet.' }));
    return;
  }

  const pinned = visible.filter((c) => c.pinned);
  if (pinned.length) {
    list.append(el('div', { class: 'list-label', text: 'Pinned' }));
    pinned.forEach((chat) => list.append(chatRow(chat)));
  }

  // Pinning already pulls a chat out of its date group, and it keeps doing that
  // here — so a chat appears exactly once no matter how it is filed, and the
  // whole list stays a single flat pass.
  const unpinned = visible.filter((c) => !c.pinned);
  const folders = [...S.folders].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const known = new Set(folders.map((f) => f.id));

  for (const folder of folders) {
    const inside = unpinned.filter((c) => c.folder_id === folder.id);
    const open = !collapsedFolders.has(folder.id);
    list.append(el('button', {
      class: `folder-head${open ? ' open' : ''}`,
      onclick: () => {
        if (collapsedFolders.has(folder.id)) collapsedFolders.delete(folder.id);
        else collapsedFolders.add(folder.id);
        saveCollapsed();
        renderSidebar();
      },
      oncontextmenu: (event) => { event.preventDefault(); openFolderMenu(folder, event); },
    },
      el('span', { class: 'caret', html: svg(ICON.caret, 'ic ic-sm') }),
      el('span', { class: 'folder-name', text: folder.name }),
      el('span', { class: 'folder-count', text: inside.length ? String(inside.length) : '' })));
    if (!open) continue;
    if (!inside.length) {
      list.append(el('div', { class: 'folder-empty', text: 'Empty' }));
      continue;
    }
    inside.forEach((chat) => {
      const row = chatRow(chat);
      row.classList.add('in-folder');
      list.append(row);
    });
  }

  // Unfiled, under the date buckets they have always used. A chat whose folder
  // was deleted out from under it lands here rather than disappearing.
  let bucket = null;
  for (const chat of unpinned.filter((c) => !c.folder_id || !known.has(c.folder_id))) {
    const label = dayBucket(chat.updated);
    if (label !== bucket) {
      bucket = label;
      list.append(el('div', { class: 'list-label', text: label }));
    }
    list.append(chatRow(chat));
  }

  if (archived.length) {
    list.append(el('button', {
      class: 'archive-toggle',
      onclick: () => { S.showArchived = !S.showArchived; renderSidebar(); },
    },
      el('span', { html: svg(S.showArchived ? ICON.caret : ICON.caret, 'ic ic-sm'),
        style: S.showArchived ? 'transform:rotate(90deg);display:inline-flex' : 'display:inline-flex' }),
      el('span', { text: `Archived (${archived.length})` })));
    if (S.showArchived) archived.forEach((chat) => list.append(chatRow(chat)));
  }
  requestAnimationFrame(moveLens);
}

function chatRow(chat, snippet) {
  const row = el('button', {
    class: `chat-row${S.chat?.id === chat.id ? ' on' : ''}${isStreaming(chat.id) ? ' running' : ''}`,
    onclick: () => openChat(chat.id),
    oncontextmenu: (event) => { event.preventDefault(); openChatMenuFor(chat, event); },
  },
    isStreaming(chat.id)
      ? el('span', { class: 'run-dot', title: 'Replying…' })
      : (chat.pinned ? el('span', { class: 'pin', html: svg(ICON.pin, 'ic ic-sm') }) : null),
    el('span', { class: 'cr-body' },
      el('span', { class: 'cr-title', text: chat.title || 'New chat' }),
      snippet ? el('span', { class: 'cr-snip', text: snippet }) : null),
    el('span', {
      class: 'row-x',
      html: svg(ICON.trash, 'ic ic-sm'),
      title: 'Delete chat',
      onclick: async (event) => {
        event.stopPropagation();
        if (!confirm(`Delete "${chat.title || 'New chat'}"?`)) return;
        await removeChat(chat.id);
        toast('Chat deleted');
      },
    }),
  );
  return row;
}

/**
 * Slide the glass lens onto the active chat row.
 *
 * One element, moved with a transform — not a background on each row — so the
 * blur is composited once and the travel is GPU-cheap no matter how long the
 * list gets.
 */
function moveLens() {
  const list = $('#chat-list');
  if (!list) return;
  // renderSidebar() clears the list wholesale, so re-create the lens rather
  // than assuming it survived.
  let lens = $('#chat-lens');
  if (!lens) {
    lens = el('div', { class: 'lens', id: 'chat-lens' });
    lens.hidden = true;
    list.prepend(lens);
  }
  const active = list.querySelector('.chat-row.on');
  if (!active) { lens.hidden = true; return; }
  const top = active.offsetTop;
  const h = active.offsetHeight;
  const first = lens.hidden;
  lens.hidden = false;
  // skip the slide on first paint so it does not fly in from nowhere
  if (first) lens.style.transition = 'none';
  lens.style.transform = `translateY(${top}px)`;
  lens.style.height = `${h}px`;
  if (first) requestAnimationFrame(() => { lens.style.transition = ''; });
}

const runSearch = debounce(async (query) => {
  if (!query.trim()) {
    S.searchResults = null;
    renderSidebar();
    return;
  }
  try {
    const { results } = await api.searchChats(query);
    S.searchResults = results;
  } catch {
    S.searchResults = [];
  }
  renderSidebar();
}, 220);

/* ═══════════════════════════ topbar ═══════════════════════════ */

function renderTopbar() {
  const model = currentModel();
  $('#model-name').textContent = model ? shortModel(model) : 'no model';
  $('#model-picker').title = model || 'No model selected';

  const persona = currentPersona();
  $('#persona-emoji').textContent = persona?.emoji || '○';
  $('#persona-name').textContent = persona?.name || 'No personas';

  const thinkBtn = $('#think-toggle');
  const supported = thinkingSupported();
  $('#think-wrap').hidden = !supported;
  if (supported) {
    const value = S.chat?.think;
    const on = !!value;
    thinkBtn.classList.toggle('on', on);
    const level = typeof value === 'string' ? value : null;
    $('#think-label').textContent = level ? `Think · ${level}` : 'Think';
    $('#think-caret').hidden = !on;
    thinkBtn.title = on
      ? `Extended thinking on${level ? ` (${level})` : ''} — click to turn off`
      : 'Extended thinking off — click to turn on';
    $('#think-caret').title = 'Reasoning effort';
  }

  const toolsBtn = $('#tools-toggle');
  const canTool = toolsSupported();
  $('#tools-wrap').hidden = !canTool;
  if (canTool) {
    const on = !!S.chat?.tools;
    toolsBtn.classList.toggle('on', on);
    const count = S.tools.length;
    $('#tools-label').textContent = on ? `Tools · auto` : 'Tools · off';
    toolsBtn.title = on
      ? `${count} tool${count === 1 ? '' : 's'} offered; the model decides whether to call them`
      : 'Tools off for this chat — click to offer them';
  }

  const dot = $('#status-dot');
  dot.className = `status-dot ${anyStreaming() ? 'busy' : (S.ollamaOk ? 'ok' : 'bad')}`;
  dot.title = S.ollamaOk ? `Model server connected · ${S.host}` : `Cannot reach ${S.host}`;

  const banner = $('#banner');
  if (!S.ollamaOk) {
    banner.hidden = false;
    banner.textContent = '';
    banner.append(
      el('span', {},
        "Can't reach model server at ", el('code', { text: S.host }),
        S.settings?.backend === 'openai' ? '. Start it in your local runner, or change the connection in Settings.'
          : '. Start it with ollama serve.'),
      el('span', { class: 'grow' }),
      el('button', {
        class: 'btn btn-ghost', text: 'Retry',
        onclick: async () => {
          await refreshModels();
          renderTopbar();
          if (S.ollamaOk) toast('Connected');
        },
      }),
    );
  } else {
    banner.hidden = true;
  }

  const attach = $('#btn-attach');
  attach.title = visionSupported()
    ? 'Attach image or text file'
    : 'Attach text file (this model has no vision support)';

  updateFoot();
}

/* dropdown plumbing ------------------------------------------------ */

let closeMenus = () => {};

/**
 * Open a dropdown, optionally at a cursor position instead of under its anchor.
 *
 * `at` exists because of a stacking-context trap, not a z-index one. The menus
 * live inside `.main` (z-index 1) and the sidebar is its sibling at z-index 2,
 * so a menu opened over the sidebar paints *behind* it no matter how high its
 * own z-index goes — a child cannot escape its parent's stacking context. The
 * fix is to leave that context entirely: reparent to <body>, position fixed, and
 * put the node back on close, because the same #chat-menu is also opened as a
 * normal anchored dropdown from the ⋮ button.
 */
function showMenu(menu, build, at) {
  closeMenus();
  menu.textContent = '';
  build(menu);

  const home = at ? { parent: menu.parentNode, next: menu.nextSibling } : null;
  if (at) {
    document.body.append(menu);
    menu.classList.add('floating-menu');
    menu.style.position = 'fixed';
    // #chat-menu is .menu-right, which pins right: 0. Left *and* right set would
    // stretch the box to the viewport edge instead of letting it size to content.
    menu.style.right = 'auto';
    menu.style.visibility = 'hidden';
  }
  menu.hidden = false;
  if (at) {
    // Measure first, then clamp: flip above the cursor when there is no room
    // below, and never let the right edge run off screen.
    const height = menu.offsetHeight;
    const width = menu.offsetWidth;
    const top = at.y + height > window.innerHeight ? at.y - height : at.y;
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.left = `${Math.min(at.x, window.innerWidth - width - 10)}px`;
    menu.style.visibility = '';
  }

  const restore = () => {
    menu.hidden = true;
    if (!home) return;
    menu.classList.remove('floating-menu');
    menu.style.position = '';
    menu.style.top = '';
    menu.style.left = '';
    menu.style.right = '';
    menu.style.visibility = '';
    home.parent.insertBefore(menu, home.next);
  };

  const dismiss = (event) => {
    if (menu.contains(event.target)) return;
    restore();
    document.removeEventListener('mousedown', dismiss, true);
    closeMenus = () => {};
  };
  setTimeout(() => document.addEventListener('mousedown', dismiss, true), 0);
  closeMenus = () => {
    restore();
    document.removeEventListener('mousedown', dismiss, true);
    closeMenus = () => {};
  };
}

function menuItem(opts) {
  return el('button', {
    class: `menu-item${opts.on ? ' on' : ''}${opts.danger ? ' danger' : ''}`,
    onclick: () => { closeMenus(); opts.run(); },
  },
    opts.icon ? el('span', { text: opts.icon, style: 'width:18px;text-align:center' })
      : (opts.iconHtml ? el('span', { html: opts.iconHtml }) : null),
    el('span', { class: 'mi-body' },
      el('span', { class: 'mi-title', text: opts.title }),
      opts.sub ? el('span', { class: 'mi-sub', text: opts.sub }) : null),
    ...(opts.tags || []).map((t) => el('span', { class: `tag ${t[1] || ''}`, text: t[0] })),
    opts.tag ? el('span', { class: `tag ${opts.tagClass || ''}`, text: opts.tag }) : null,
    opts.keys ? el('span', { class: 'kbd', text: opts.keys }) : null,
  );
}

/**
 * Capability chips for a model. Thinking is shown when Ollama advertises it OR
 * when we have watched the model actually reason — gemma-4 reports only
 * ["completion","vision"] yet honours `think` fully, which is why relying on
 * the advertised list alone made the menu look wrong.
 */
function capabilityTags(model) {
  const tags = [];
  if (thinkingAdvertised(model.name)) tags.push(['THINK', 'think']);
  else if (thinkingSupported(model.name)) tags.push(['THINK*', 'think']);
  if (model.supports_vision) tags.push(['VISION', 'vision']);
  if (model.supports_tools) tags.push(['TOOLS', 'tools']);
  return tags;
}

function openModelMenu() {
  showMenu($('#model-menu'), (menu) => {
    menu.append(el('div', { class: 'menu-label', text: 'Model' }));
    if (!S.models.length) {
      menu.append(el('div', { class: 'p-none', text: 'No models installed.' }));
    }
    for (const model of S.models) {
      menu.append(menuItem({
        title: shortModel(model.name),
        sub: (() => {
          const live = S.running.find((r) => r.name === model.name);
          return [model.parameter_size, bytes(model.size),
            model.context_length ? `${num(model.context_length)} ctx` : null,
            live ? `in memory${live.size_vram ? ` · ${bytes(live.size_vram)}` : ''}` : null]
            .filter(Boolean).join(' · ');
        })(),
        on: model.name === currentModel(),
        tags: capabilityTags(model),
        run: () => pickModel(model.name),
      }));
    }
    if (S.models.some((m) => !thinkingAdvertised(m.name) && thinkingSupported(m.name))) {
      menu.append(el('div', { class: 'menu-label',
        text: 'THINK* = reasoning confirmed by use, not declared by the model server' }));
    }
    menu.append(el('div', { class: 'menu-sep' }));
    menu.append(menuItem({ title: 'Manage models…', keys: `${MOD}M`, run: openModels }));
    menu.append(menuItem({
      title: 'Refresh list',
      run: async () => { await refreshModels(); toast('Refreshed'); },
    }));
  });
}

function openPersonaMenu() {
  showMenu($('#persona-menu'), (menu) => {
    menu.append(el('div', { class: 'menu-label', text: 'Persona' }));
    for (const persona of S.personas) {
      menu.append(menuItem({
        title: persona.name,
        sub: persona.description || (persona.prompt ? 'Custom system prompt' : 'No system prompt'),
        icon: persona.emoji,
        on: persona.id === S.chat?.persona_id,
        run: () => applyPersona(persona.id),
      }));
    }
    menu.append(el('div', { class: 'menu-sep' }));
    menu.append(menuItem({ title: 'Manage personas…', keys: `${MOD}P`, run: openPersonas }));
    menu.append(menuItem({ title: 'Edit system prompt for this chat…', run: openParams }));
  });
}

function openThinkMenu() {
  showMenu($('#think-menu'), (menu) => {
    menu.append(el('div', { class: 'menu-label', text: 'Thinking effort' }));
    const current = S.chat?.think;
    const options = [
      [false, 'Off', 'Answer directly'],
      [true, 'On', 'Model default effort'],
      ['low', 'Low', 'Brief reasoning'],
      ['medium', 'Medium', 'Balanced'],
      ['high', 'High', 'Longest reasoning'],
    ];
    for (const [value, label, sub] of options) {
      menu.append(menuItem({
        title: label, sub,
        on: current === value || (value === false && !current),
        run: () => setThink(value),
      }));
    }
    menu.append(el('div', { class: 'menu-sep' }));
    menu.append(el('div', { class: 'menu-label',
      text: 'Levels only apply to models that accept them; others treat any level as on.' }));
  });
}

function setThink(value) {
  if (!S.chat) return;
  S.chat.think = value;
  queueSaveChat();
  renderTopbar();
  const label = value === false ? 'off' : (value === true ? 'on' : value);
  toast(`Thinking ${label}`);
}

function toggleThink() {
  if (!thinkingSupported()) {
    toast(`No thinking seen from ${shortModel(currentModel())} yet`, 'bad');
    return;
  }
  setThink(!S.chat?.think);
}

/* tools ------------------------------------------------------------ */

function setTools(value) {
  if (!S.chat) return;
  S.chat.tools = !!value;
  queueSaveChat();
  renderTopbar();
  // The empty state offers tools when they are off, so it has to re-evaluate —
  // otherwise the offer sits there after you have accepted it.
  emit('tools-changed');
  toast(`Tools ${value ? 'on' : 'off'}`);
}

function toggleTools() {
  if (!toolsSupported()) {
    toast(`${shortModel(currentModel())} does not advertise tool calling`, 'bad');
    return;
  }
  setTools(!S.chat?.tools);
}

/** What the model may call, and the honest caveats. */
function openToolsMenu() {
  showMenu($('#tools-menu'), (menu) => {
    menu.append(el('div', { class: 'menu-label', text: 'Tool calling' }));
    menu.append(menuItem({
      title: 'Off', sub: 'No tools sent with the request',
      on: !S.chat?.tools,
      run: () => setTools(false),
    }));
    menu.append(menuItem({
      // "Auto" rather than "On": the model decides whether to call anything,
      // and the tools are only offered to models that advertise support.
      title: 'Auto', sub: 'Offer the tools below; the model decides',
      on: !!S.chat?.tools,
      run: () => setTools(true),
    }));
    menu.append(el('div', { class: 'menu-sep' }));
    menu.append(el('div', { class: 'menu-label', text: 'Available' }));
    for (const tool of S.tools) {
      menu.append(el('div', { class: 'menu-static' },
        el('span', { class: 'mi-body' },
          el('span', { class: 'mi-title', text: tool.name }),
          el('span', { class: 'mi-sub', text: tool.summary || tool.description }))));
    }
    menu.append(el('div', { class: 'menu-sep' }));
    // The no-network half of this note stopped being true when read_url landed,
    // so it is written from what is actually in the list rather than asserted.
    const reader = S.tools.some((t) => t.name === 'read_url');
    menu.append(el('div', { class: 'menu-note',
      text: `Tools run on this machine, in the server process, read-only — no shell, `
        + `no file writes. ${reader
          ? 'read_url is the one exception: it fetches public web pages, never addresses on this machine or your network. '
          : 'None of them reach the network. '}`
        + `At most ${S.toolRoundLimit} rounds of calls per reply — after that the model has to answer.` }));
  });
}

/**
 * Rename or delete a folder, from a right-click on its header.
 *
 * **Delete never touches a conversation.** The server unfiles every chat that
 * pointed at the folder and reports how many, and the toast says so — the one
 * thing a user needs to be sure of before clicking Delete on something that
 * visually contains their chats.
 */
function openFolderMenu(folder, event) {
  const at = event && event.clientX != null
    ? { x: event.clientX, y: event.clientY } : null;
  showMenu($('#chat-menu'), (menu) => {
    menu.append(menuItem({
      title: 'Rename folder', iconHtml: svg(ICON.edit, 'ic'),
      run: async () => {
        const name = prompt('Folder name', folder.name || '');
        if (name === null || !name.trim()) return;
        await renameFolder(folder.id, name.trim());
        renderSidebar();
      },
    }));
    menu.append(el('div', { class: 'menu-sep' }));
    menu.append(menuItem({
      title: 'Delete folder', iconHtml: svg(ICON.trash, 'ic'), danger: true,
      run: async () => {
        const inside = S.chats.filter((c) => c.folder_id === folder.id).length;
        const warning = inside
          ? `Delete the folder "${folder.name}"?\n\nThe ${inside} chat${inside === 1 ? '' : 's'} `
            + 'inside will be kept and moved out of the folder, not deleted.'
          : `Delete the empty folder "${folder.name}"?`;
        if (!confirm(warning)) return;
        const result = await deleteFolder(folder.id);
        renderSidebar();
        toast(result.unfiled
          ? `Folder deleted — ${result.unfiled} chat${result.unfiled === 1 ? '' : 's'} kept`
          : 'Folder deleted');
      },
    }));
  }, at);
}

/** The folder list for a chat, plus an escape hatch to make a new one. */
function openMoveToFolder(chat, event) {
  const at = event && event.clientX != null
    ? { x: event.clientX, y: event.clientY } : null;
  showMenu($('#chat-menu'), (menu) => {
    const folders = [...S.folders].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const folder of folders) {
      menu.append(menuItem({
        title: folder.name,
        on: chat.folder_id === folder.id,
        run: async () => {
          await setChatFolder(chat, folder.id);
          collapsedFolders.delete(folder.id);   // show where it went
          saveCollapsed();
          renderSidebar();
          toast(`Moved to ${folder.name}`);
        },
      }));
    }
    if (folders.length) menu.append(el('div', { class: 'menu-sep' }));
    menu.append(menuItem({
      title: 'New folder…', iconHtml: svg(ICON.plus, 'ic'),
      run: async () => {
        const name = prompt('Folder name', '');
        if (name === null || !name.trim()) return;
        const folder = await createFolder(name.trim());
        await setChatFolder(chat, folder.id);
        renderSidebar();
        toast(`Moved to ${folder.name}`);
      },
    }));
    if (chat.folder_id) {
      menu.append(menuItem({
        title: 'Remove from folder', iconHtml: svg(ICON.x, 'ic'),
        run: async () => {
          await setChatFolder(chat, null);
          renderSidebar();
          toast('Moved out of the folder');
        },
      }));
    }
  }, at);
}

function openChatMenuFor(chat, event) {
  const target = chat || S.chat;
  if (!target) return;
  // A right-click opens at the pointer; the ⋮ button keeps its anchored spot.
  const at = event && event.clientX != null
    ? { x: event.clientX, y: event.clientY } : null;
  showMenu($('#chat-menu'), (menu) => {
    menu.append(menuItem({
      title: 'Rename', iconHtml: svg(ICON.edit, 'ic'),
      run: async () => {
        const name = prompt('Chat title', target.title || '');
        if (name === null) return;
        if (S.chat?.id === target.id) {
          S.chat.title = name.trim();
          await queueSaveChat(true);
        } else {
          await api.updateChat(target.id, { title: name.trim() });
          await refreshChatList();
        }
        emit('chat-title');
      },
    }));
    menu.append(menuItem({
      title: target.archived ? 'Unarchive' : 'Archive',
      iconHtml: svg(ICON.archive, 'ic'),
      run: async () => {
        const next = !target.archived;
        if (S.chat?.id === target.id) S.chat.archived = next;
        await api.updateChat(target.id, { archived: next });
        await refreshChatList();
        if (next) S.showArchived = false;
        toast(next ? 'Archived' : 'Unarchived');
      },
    }));
    menu.append(menuItem({
      title: 'Duplicate', iconHtml: svg(ICON.copy, 'ic'),
      run: async () => {
        await openChat(target.id);
        const source = S.chat;
        const copy = await newChat({ model: source.model, personaId: source.persona_id, focus: false });
        copy.messages = source.messages.map((m) => ({ ...m }));
        copy.title = `${source.title || 'Chat'} (copy)`;
        copy.think = source.think;
        copy.tools = !!source.tools;
        copy.params = { ...source.params };
        copy.system_override = source.system_override;
        await queueSaveChat(true);
        emit('chat', { focus: true });
        toast('Duplicated');
      },
    }));
    menu.append(menuItem({
      title: 'Move to folder…', iconHtml: svg(ICON.folder, 'ic'),
      run: () => openMoveToFolder(target, event),
    }));
    menu.append(menuItem({
      title: target.pinned ? 'Unpin' : 'Pin to top', iconHtml: svg(ICON.pin, 'ic'),
      run: async () => {
        const next = !target.pinned;
        if (S.chat?.id === target.id) S.chat.pinned = next;
        await api.updateChat(target.id, { pinned: next });
        await refreshChatList();
      },
    }));
    menu.append(el('div', { class: 'menu-sep' }));
    menu.append(menuItem({
      title: 'Export as markdown', iconHtml: svg(ICON.download, 'ic'), keys: `${MOD}S`,
      run: async () => { await openChat(target.id); exportChat('md'); },
    }));
    menu.append(menuItem({
      title: 'Export as JSON', iconHtml: svg(ICON.download, 'ic'),
      run: async () => { await openChat(target.id); exportChat('json'); },
    }));
    menu.append(menuItem({
      title: 'Copy transcript',
      iconHtml: svg(ICON.copy, 'ic'),
      run: async () => {
        await openChat(target.id);
        const text = S.chat.messages
          .map((m) => `${m.role === 'user' ? 'You' : 'Assistant'}:\n${m.content}`).join('\n\n');
        toast(await copyText(text) ? 'Transcript copied' : 'Copy failed');
      },
    }));
    menu.append(el('div', { class: 'menu-sep' }));
    menu.append(menuItem({
      title: 'Parameters & system prompt', iconHtml: svg(ICON.caret, 'ic'), run: openParams,
    }));
    menu.append(menuItem({
      title: 'Clear messages', danger: true, iconHtml: svg(ICON.x, 'ic'),
      run: async () => {
        await openChat(target.id);
        if (!confirm('Remove every message in this chat?')) return;
        S.chat.messages = [];
        await queueSaveChat(true);
        renderThread();
      },
    }));
    menu.append(menuItem({
      title: 'Delete chat', danger: true, iconHtml: svg(ICON.trash, 'ic'),
      run: async () => {
        if (!confirm(`Delete "${target.title || 'New chat'}"?`)) return;
        await removeChat(target.id);
        toast('Chat deleted');
      },
    }));
  }, at);
}

/* ═══════════════════════════ composer ═══════════════════════════ */

function renderAttachments() {
  const box = $('#attachments');
  box.textContent = '';
  box.hidden = !S.attachments.length;
  S.attachments.forEach((att, index) => {
    box.append(el('div', { class: 'att' },
      att.kind === 'image'
        ? el('img', { src: `data:${att.mime};base64,${att.data}`, alt: att.name })
        : el('span', { html: svg(ICON.msg, 'ic ic-sm') }),
      el('span', { text: att.name }),
      el('button', {
        html: '&times;', title: 'Remove',
        onclick: () => { S.attachments.splice(index, 1); renderAttachments(); },
      })));
  });
}

const TEXT_EXT = /\.(txt|md|markdown|json|csv|tsv|ya?ml|toml|ini|log|py|js|mjs|cjs|ts|tsx|jsx|html?|css|scss|sh|bash|zsh|rs|go|java|kt|c|h|cpp|hpp|cs|rb|php|sql|xml|swift|lua|r|jl|dart|vue|svelte|gradle|dockerfile|env|conf)$/i;

async function addFiles(files) {
  for (const file of files) {
    if (file.size > 12 * 1024 * 1024) {
      toast(`${file.name} is too large (max 12 MB)`, 'bad');
      continue;
    }
    if (file.type.startsWith('image/')) {
      if (!visionSupported()) {
        toast(`${shortModel(currentModel())} can't read images`, 'bad');
        continue;
      }
      const data = await fileToBase64(file);
      S.attachments.push({ kind: 'image', name: file.name || 'image', mime: file.type, data });
    } else if (TEXT_EXT.test(file.name) || file.type.startsWith('text/') || !file.type) {
      const text = await file.text();
      const ext = (file.name.match(/\.(\w+)$/) || [, ''])[1].toLowerCase();
      S.attachments.push({ kind: 'text', name: file.name, text, lang: ext });
    } else {
      toast(`Unsupported file: ${file.name}`, 'bad');
    }
  }
  renderAttachments();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function wireComposer() {
  const input = $('#input');
  const send = $('#btn-send');

  const sync = () => {
    autosize(input);
    send.disabled = !input.value.trim() && !S.attachments.length;
    localStorage.setItem(`lantern.draft.${S.chat?.id || 'none'}`, input.value);
  };

  input.addEventListener('input', sync);
  on('attachments', () => { renderAttachments(); sync(); });

  input.addEventListener('keydown', (event) => {
    const enterSends = S.settings?.send_on_enter !== false;
    const wantsSend = event.key === 'Enter'
      && ((enterSends && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey)
        || ((event.metaKey || event.ctrlKey) && !event.shiftKey));
    if (wantsSend) {
      event.preventDefault();
      submit();
    }
  });

  input.addEventListener('paste', async (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) {
      event.preventDefault();
      await addFiles(files);
      sync();
    }
  });

  const composer = $('#composer');
  ['dragenter', 'dragover'].forEach((type) => composer.addEventListener(type, (event) => {
    event.preventDefault();
    composer.classList.add('drop');
  }));
  ['dragleave', 'drop'].forEach((type) => composer.addEventListener(type, (event) => {
    event.preventDefault();
    if (type === 'dragleave' && composer.contains(event.relatedTarget)) return;
    composer.classList.remove('drop');
  }));
  composer.addEventListener('drop', async (event) => {
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) { await addFiles(files); sync(); }
  });

  // autosize caps the composer at 44% of the window height, so a resize can
  // leave a tall draft stuck at its old height until the next keystroke
  window.addEventListener('resize', debounce(() => autosize(input), 120));

  $('#btn-attach').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async (event) => {
    await addFiles([...event.target.files]);
    event.target.value = '';
    sync();
  });

  async function submit() {
    const text = input.value;
    if (!text.trim() && !S.attachments.length) return;
    if (!S.models.some((model) => model.name === currentModel())) {
      toast('Choose a model available on this server before sending', 'bad');
      return;
    }
    input.value = '';
    localStorage.removeItem(`lantern.draft.${S.chat?.id || 'none'}`);
    sync();
    await sendMessage(text);
  }

  send.addEventListener('click', submit);
  // Must be wrapped, not passed by reference: stopGeneration's first parameter
  // is a chat id with a default, and a listener is called with the click Event
  // — which then *is* the argument, so the default never applies and
  // S.runs.get(MouseEvent) misses. The button silently did nothing while Esc,
  // which calls it with no arguments, worked fine.
  $('#btn-stop').addEventListener('click', () => stopGeneration());
  sync();
}

function restoreDraft() {
  const input = $('#input');
  input.value = localStorage.getItem(`lantern.draft.${S.chat?.id || 'none'}`) || '';
  autosize(input);
  $('#btn-send').disabled = !input.value.trim() && !S.attachments.length;
}

/* ═══════════════════════════ shortcuts ═══════════════════════════ */

function wireKeys() {
  document.addEventListener('keydown', (event) => {
    const mod = isMac ? event.metaKey : event.ctrlKey;
    const target = event.target;
    // Guarded: a keydown whose target is the document rather than an element
    // has no .matches(), and the throw would take every shortcut down with it.
    const typing = target instanceof Element
      && target.matches('input, textarea, [contenteditable]');

    if (event.key === 'Escape') {
      if (paletteOpen()) { closePalette(); return; }
      if (findOpen()) { closeFind(); return; }
      if (modalOpen()) { closeModal(); return; }
      if (isStreaming()) { stopGeneration(); return; }
      if ($('#chat-search') === target) { target.blur(); return; }
      return;
    }

    if (!mod && !typing && event.key === '/') {
      event.preventDefault();
      $('#input').focus();
      return;
    }

    if (!mod) return;

    const key = event.key.toLowerCase();
    if (key === 'k') { event.preventDefault(); openPalette(); }
    else if (key === 'n') { event.preventDefault(); startNewChat(); }
    else if (key === 'f' && event.shiftKey) {
      event.preventDefault(); $('#chat-search').focus(); $('#chat-search').select();
    } else if (key === 'f') { event.preventDefault(); openFind(); }
    else if (key === 'b') { event.preventDefault(); toggleSidebar(); }
    else if (key === 'p' && event.shiftKey) { event.preventDefault(); openPalette('persona '); }
    else if (key === 'p') { event.preventDefault(); openPersonas(); }
    else if (key === 'm') { event.preventDefault(); openModels(); }
    else if (key === ',') { event.preventDefault(); openSettings(); }
    else if (key === 'l' && event.shiftKey) { event.preventDefault(); cycleTheme(); }
    else if (key === 't' && event.shiftKey) { event.preventDefault(); toggleThink(); }
    else if (key === 'r' && !event.shiftKey) {
      event.preventDefault();
      regenerateLast();
    } else if (key === 'e' && event.shiftKey) {
      event.preventDefault();
      editLastUser();
    } else if (key === 's') { event.preventDefault(); exportChat('md'); }
    else if (key === '/') { event.preventDefault(); openShortcuts(); }
  });
}

function regenerateLast() {
  if (isStreaming() || !S.chat?.messages?.length) return;
  const index = [...S.chat.messages].reverse().findIndex((m) => m.role === 'assistant');
  if (index < 0) return;
  const realIndex = S.chat.messages.length - 1 - index;
  const node = $(`#thread .msg[data-index="${realIndex}"] .act[title="Regenerate"]`);
  if (node) node.click();
}

function editLastUser() {
  const messages = S.chat?.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const node = $(`#thread .msg[data-index="${i}"] .act[title="Edit and resend"]`);
      if (node) { node.click(); }
      return;
    }
  }
}

function cycleTheme() {
  const order = ['dark', 'light', 'system'];
  const next = order[(order.indexOf(S.settings.theme) + 1) % order.length];
  // applyVisual, not patchSettings + applyTheme: patchSettings only updates
  // S.settings *after* the server answers, so repainting straight afterwards
  // painted the previous theme. Cycling dark -> light appeared to do nothing,
  // and light only showed up on the next click, the one that selects `system`.
  applyVisual({ theme: next });
  toast(`Theme: ${next}${next === 'system' ? ` (${resolvedTheme()})` : ''}`);
}

function toggleSidebar() {
  const collapsed = !$('#app').classList.contains('collapsed');
  $('#app').classList.toggle('collapsed', collapsed);
  $('#btn-expand').hidden = !collapsed;
  patchSettings({ sidebar_collapsed: collapsed });
}

async function startNewChat() {
  // Already sitting in an untouched chat — just focus it.
  if (S.chat && !S.chat.messages.length) {
    $('#input').focus();
    return;
  }
  await newChat();
  restoreDraft();
  $('#input').focus();
}

/* ═══════════════════════════ find in chat ═══════════════════════════ */

let findHits = [];
let findAt = 0;

function clearFindMarks() {
  for (const mark of [...document.querySelectorAll('#thread mark.find-hit')]) {
    const parent = mark.parentNode;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  }
  findHits = [];
  findAt = 0;
}

function runFind(query) {
  clearFindMarks();
  const needle = (query || '').trim().toLowerCase();
  const countEl = $('#find-count');
  if (needle.length < 1) { countEl.textContent = ''; return; }

  // Walk text nodes so the markdown DOM is preserved; skip anything inside a
  // <script> (the code blocks stash their raw source there for copying) and
  // anything inside a *collapsed* thinking or tool panel. Those are
  // display:none, so marking them inflates the hit count and ⏎ steps to a
  // highlight nobody can see.
  const walker = document.createTreeWalker($('#thread'), NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue.toLowerCase().includes(needle)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest('script')) return NodeFilter.FILTER_REJECT;
      const panel = parent.closest('.think-box, .tool-box');
      if (panel && !panel.classList.contains('open')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n);

  for (const node of targets) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let i = 0;
    let at = text.toLowerCase().indexOf(needle);
    while (at >= 0) {
      if (at > i) frag.append(text.slice(i, at));
      const mark = el('mark', { class: 'find-hit', text: text.slice(at, at + needle.length) });
      frag.append(mark);
      findHits.push(mark);
      i = at + needle.length;
      at = text.toLowerCase().indexOf(needle, i);
    }
    if (i < text.length) frag.append(text.slice(i));
    node.parentNode.replaceChild(frag, node);
  }
  countEl.textContent = findHits.length ? `1/${findHits.length}` : 'none';
  if (findHits.length) { findAt = 0; focusHit(); }
}

function focusHit() {
  findHits.forEach((m, i) => m.classList.toggle('on', i === findAt));
  const hit = findHits[findAt];
  if (hit) hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('#find-count').textContent = findHits.length ? `${findAt + 1}/${findHits.length}` : 'none';
}

function stepFind(delta) {
  if (!findHits.length) return;
  findAt = (findAt + delta + findHits.length) % findHits.length;
  focusHit();
}

function openFind() {
  if (!S.chat?.messages?.length) { toast('Nothing to search in this chat'); return; }
  $('#find-bar').hidden = false;
  const input = $('#find-input');
  input.focus();
  input.select();
  if (input.value) runFind(input.value);
}

function closeFind() {
  $('#find-bar').hidden = true;
  clearFindMarks();
  $('#input').focus();
}

const findOpen = () => !$('#find-bar').hidden;

function wireFind() {
  const input = $('#find-input');
  input.addEventListener('input', debounce(() => runFind(input.value), 140));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); stepFind(event.shiftKey ? -1 : 1); }
    else if (event.key === 'Escape') { event.preventDefault(); closeFind(); }
  });
  $('#find-next').addEventListener('click', () => stepFind(1));
  $('#find-prev').addEventListener('click', () => stepFind(-1));
  $('#find-close').addEventListener('click', closeFind);
  // Marks live in the thread, so any re-render wipes them. A finishing reply
  // re-renders too, which used to leave the counter claiming hits that were
  // no longer in the DOM.
  const reapply = () => { if (findOpen()) runFind($('#find-input').value); };
  on('chat', reapply);
  on('runs', reapply);
}

/* ═══════════════════════════ backup ═══════════════════════════ */

async function backupAll() {
  try {
    const data = await api.backup();
    const stamp = new Date().toISOString().slice(0, 10);
    const { download } = await import('./util.js');
    download(`lantern-backup-${stamp}.json`, JSON.stringify(data, null, 1), 'application/json');
    toast(`Backed up ${data.chats.length} chat${data.chats.length === 1 ? '' : 's'}`);
  } catch (err) {
    toast(`Backup failed: ${err.message}`, 'bad');
  }
}

function restoreAll() {
  const input = el('input', { type: 'file', accept: '.json', style: 'display:none' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      if (payload.lantern_backup !== 1) {
        toast('That is not a Lantern backup', 'bad');
        return;
      }
      const n = (payload.chats || []).length;
      // merge never overwrites an existing chat, so the safe option is default
      const replace = confirm(
        `Restore ${n} chat${n === 1 ? '' : 's'}?\n\n`
        + 'OK = REPLACE: delete every current chat first.\n'
        + 'Cancel = MERGE: keep what you have and add anything missing.');
      const res = await api.restore({ ...payload, mode: replace ? 'replace' : 'merge' });
      await loadBootstrap();
      applyTheme();
      const blank = S.chats.find((c) => !c.message_count);
      await (blank ? openChat(blank.id, { focus: false })
                   : (S.chats[0] ? openChat(S.chats[0].id, { focus: false }) : newChat({ focus: false })));
      toast(`Restored ${res.added} chat${res.added === 1 ? '' : 's'}`
            + (res.skipped ? `, skipped ${res.skipped}` : ''));
    } catch (err) {
      toast(`Restore failed: ${err.message}`, 'bad');
    }
  });
  document.body.append(input);
  input.click();
  setTimeout(() => input.remove(), 1000);
}

/* ═══════════════════════════ commands ═══════════════════════════ */

function setupCommands() {
  registerCommands([
    { title: 'New chat', keywords: 'create start fresh', keys: `${MOD}N`, iconHtml: svg(ICON.plus, 'ic'), run: startNewChat },
    { title: 'Toggle thinking', keywords: 'reason think cot', keys: `${MOD}⇧T`, iconHtml: svg(ICON.brain, 'ic'), when: () => thinkingSupported(), run: toggleThink },
    { title: 'Thinking: off', keywords: 'think effort', when: () => thinkingSupported(), run: () => setThink(false) },
    { title: 'Thinking: on', keywords: 'think effort', when: () => thinkingSupported(), run: () => setThink(true) },
    { title: 'Thinking: low', keywords: 'think effort', when: () => thinkingSupported(), run: () => setThink('low') },
    { title: 'Thinking: medium', keywords: 'think effort', when: () => thinkingSupported(), run: () => setThink('medium') },
    { title: 'Thinking: high', keywords: 'think effort', when: () => thinkingSupported(), run: () => setThink('high') },
    { title: 'Toggle tools', keywords: 'tool calling function date time', iconHtml: svg(ICON.tool, 'ic'), when: () => toolsSupported(), run: toggleTools },
    { title: 'Tools: off', keywords: 'tool calling function', when: () => toolsSupported(), run: () => setTools(false) },
    { title: 'Tools: auto', keywords: 'tool calling function on', when: () => toolsSupported(), run: () => setTools(true) },
    { title: 'New folder', keywords: 'folder group organise organize sort', iconHtml: svg(ICON.folder, 'ic'), run: async () => {
      const name = prompt('Folder name', '');
      if (name === null || !name.trim()) return;
      await createFolder(name.trim());
      renderSidebar();
      toast('Folder created');
    } },
    { title: 'Manage personas', keywords: 'system prompt character', keys: `${MOD}P`, run: openPersonas },
    { title: 'Prompt library', keywords: 'saved prompts snippets reuse template', run: openPrompts },
    { title: 'Manage models', keywords: 'pull download delete ollama', keys: `${MOD}M`, run: openModels },
    { title: 'Parameters & system prompt', keywords: 'temperature top_p seed context', run: openParams },
    { title: 'Settings', keywords: 'preferences options config', keys: `${MOD},`, run: openSettings },
    // The first-run flow only appears on an empty data folder, so without this
    // there is no way to see it again short of deleting your own chats.
    { title: 'Run setup again', keywords: 'onboarding first run welcome setup wizard',
      run: startOnboarding },
    { title: 'Back up everything', keywords: 'backup export all save archive json', run: backupAll },
    { title: 'Restore from a backup', keywords: 'restore import load backup', run: restoreAll },
    { title: 'Archive this chat', keywords: 'hide archive', when: () => S.chat && !S.chat.archived, run: async () => {
      S.chat.archived = true;
      await api.updateChat(S.chat.id, { archived: true });
      await refreshChatList();
      toast('Archived');
    } },
    { title: 'Find in this chat', keywords: 'search find text', keys: `${MOD}F`, run: () => openFind() },
    { title: 'Settings guide', keywords: 'help explain temperature top p top k repeat penalty context seed meaning what does', run: openGuide },
    { title: 'Keyboard shortcuts', keywords: 'help keys bindings', keys: `${MOD}/`, run: openShortcuts },
    { title: 'Toggle theme', keywords: 'dark light appearance', keys: `${MOD}⇧L`, run: cycleTheme },
    { title: 'Toggle sidebar', keywords: 'hide show collapse', keys: `${MOD}B`, run: toggleSidebar },
    { title: 'Export chat as markdown', keywords: 'save download md', keys: `${MOD}S`, run: () => exportChat('md') },
    { title: 'Export chat as JSON', keywords: 'save download json', run: () => exportChat('json') },
    { title: 'Rename this chat', keywords: 'title', run: () => openChatMenuFor(S.chat) },
    { title: 'Pin this chat', keywords: 'favourite favorite', when: () => S.chat && !S.chat.pinned, run: async () => {
      S.chat.pinned = true;
      await api.updateChat(S.chat.id, { pinned: true });
      await refreshChatList();
      toast('Pinned');
    } },
    { title: 'Clear messages in this chat', keywords: 'empty reset', run: async () => {
      if (!S.chat || !confirm('Remove every message in this chat?')) return;
      S.chat.messages = [];
      await queueSaveChat(true);
      renderThread();
    } },
    { title: 'Delete this chat', keywords: 'remove trash', run: async () => {
      if (!S.chat || !confirm(`Delete "${S.chat.title || 'New chat'}"?`)) return;
      await removeChat(S.chat.id);
      toast('Chat deleted');
    } },
    { title: 'Refresh models from local server', keywords: 'reload sync', run: async () => {
      await refreshModels();
      toast('Models refreshed');
    } },
    { title: 'Copy data folder path', keywords: 'where stored files', run: async () => {
      toast(await copyText(S.dataDir) ? 'Path copied' : 'Copy failed');
    } },
    // Saved prompts are commands too, so ⌘K then a few letters inserts one.
    // registerCommands replaces the list wholesale, so this re-runs whenever the
    // library changes — see on('prompts') below.
    ...S.prompts.map((prompt) => ({
      title: `Prompt: ${prompt.name}`,
      keywords: `prompt library insert snippet ${prompt.text || ''}`.slice(0, 200),
      iconHtml: svg(ICON.edit, 'ic'),
      run: () => insertPrompt(prompt.text || ''),
    })),
  ]);
}

/* ═══════════════════════════ init ═══════════════════════════ */

/**
 * The version, under the sidebar buttons.
 *
 * Silent unless there is something to say: it reads `v1.0.2` normally, and gains
 * an accent dot and "update available" only once a check has actually come back
 * saying so. Nothing here runs a check — that is `refreshUpdate()`, and it does
 * nothing at all unless the setting is on.
 */
function renderVersionLine() {
  const node = $('#foot-version');
  if (!node) return;
  if (!S.version) { node.hidden = true; return; }
  node.hidden = false;
  const stale = !!S.update?.outdated;
  node.classList.toggle('stale', stale);
  node.textContent = '';
  if (stale) node.append(el('span', { class: 'vdot' }));
  // Every one of these strings is server-derived; `text:` keeps it that way.
  node.append(el('span', { text: stale ? `v${S.version} → v${S.update.latest}` : `v${S.version}` }));
  node.title = stale
    ? `Lantern ${S.update.latest} is out. You have ${S.version}. Click for the release notes.`
    : 'Lantern version — click for Settings';
}

function wireButtons() {
  $('#foot-version').addEventListener('click', () => {
    // Outdated: straight to the notes for the release you'd be moving to.
    // Otherwise Settings, where the check lives.
    if (S.update?.outdated && S.update.url) window.open(S.update.url, '_blank');
    else openSettings();
  });
  $('#btn-new-chat').addEventListener('click', startNewChat);
  $('#btn-collapse').addEventListener('click', toggleSidebar);
  $('#btn-expand').addEventListener('click', toggleSidebar);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-personas').addEventListener('click', openPersonas);
  $('#btn-models').addEventListener('click', openModels);
  $('#btn-params').addEventListener('click', openParams);
  $('#btn-theme').addEventListener('click', cycleTheme);
  $('#btn-chat-menu').addEventListener('click', () => openChatMenuFor(S.chat));
  $('#model-picker').addEventListener('click', openModelMenu);
  $('#persona-picker').addEventListener('click', openPersonaMenu);

  const think = $('#think-toggle');
  think.addEventListener('click', toggleThink);
  think.addEventListener('contextmenu', (event) => { event.preventDefault(); openThinkMenu(); });
  $('#think-caret').addEventListener('click', (event) => {
    event.stopPropagation();
    openThinkMenu();
  });

  const tools = $('#tools-toggle');
  tools.addEventListener('click', toggleTools);
  tools.addEventListener('contextmenu', (event) => { event.preventDefault(); openToolsMenu(); });
  $('#tools-caret').addEventListener('click', (event) => {
    event.stopPropagation();
    openToolsMenu();
  });

  const search = $('#chat-search');
  search.addEventListener('input', () => {
    S.searchQuery = search.value;
    $('#clear-search').hidden = !search.value;
    runSearch(search.value);
  });
  $('#clear-search').addEventListener('click', () => {
    search.value = '';
    S.searchQuery = '';
    S.searchResults = null;
    $('#clear-search').hidden = true;
    renderSidebar();
    search.focus();
  });

  $('#modal-close').addEventListener('click', closeModal);
  $('#overlay').addEventListener('click', () => {
    if (paletteOpen()) closePalette();
    else closeModal();
  });

  // pagehide fires where beforeunload sometimes does not (webviews, bfcache)
  window.addEventListener('beforeunload', flushBeacon);
  window.addEventListener('pagehide', flushBeacon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushChat();
  });
}

async function init() {
  try {
    await loadBootstrap();
  } catch (err) {
    // Built as nodes rather than interpolated into innerHTML: err.message is the
    // only dynamic string on this path, and a failure screen is a bad place to
    // discover that an error text contained markup.
    document.body.textContent = '';
    document.body.append(el('div', { style: 'padding:40px;font-family:system-ui;line-height:1.6' },
      el('h2', { text: "Lantern can't reach its own server" }),
      el('p', { style: 'color:#888', text: err.message || 'Unknown error' }),
      el('p', {}, 'Restart it with ', el('code', { text: 'python3 server.py' }), '.'),
    ));
    return;
  }

  applyTheme();
  if (S.settings.sidebar_collapsed) {
    $('#app').classList.add('collapsed');
    $('#btn-expand').hidden = false;
  }

  // Reopen whatever was last in view. Reuse an existing blank chat rather than
  // piling up a new one on every reload.
  const lastId = localStorage.getItem(LAST_CHAT_KEY);
  const blank = S.chats.find((c) => !c.message_count);
  if (lastId && S.chats.some((c) => c.id === lastId)) await openChat(lastId, { focus: false });
  else if (blank) await openChat(blank.id, { focus: false });
  else if (S.chats.length) await openChat(S.chats[0].id, { focus: false });
  else await newChat({ focus: false });

  window.__lantern.backupAll = backupAll;
  window.__lantern.restoreAll = restoreAll;
  window.__lantern.openFind = openFind;
  window.__lantern.setTools = setTools;   // the empty-state tools hint calls this
  setupCommands();
  wireButtons();
  wireComposer();
  wirePalette();
  wireFind();
  wireScroll();
  wireKeys();

  on('chats', renderSidebar);
  on('runs', renderSidebar);
  window.addEventListener('resize', debounce(moveLens, 120));
  on('chat', ({ focus } = {}) => {
    localStorage.setItem(LAST_CHAT_KEY, S.chat?.id || '');
    renderSidebar();
    renderTopbar();
    restoreDraft();
    if (focus) $('#input').focus();
  });
  on('chat-title', () => { renderSidebar(); });
  on('settings', () => { renderTopbar(); });
  on('models', renderTopbar);
  on('personas', renderTopbar);
  on('prompts', setupCommands);   // the palette lists saved prompts by name
  on('folders', renderSidebar);
  on('persona-changed', () => { renderTopbar(); renderThread(); });
  on('model-changed', () => { renderTopbar(); });
  on('foot', updateFoot);
  on('streaming', () => renderTopbar());
  on('update', renderVersionLine);
  on('settings', renderVersionLine);   // the toggle can clear a stale badge

  renderSidebar();
  renderTopbar();
  renderThread();
  renderVersionLine();
  restoreDraft();

  // A brand-new data folder gets the welcome flow instead of a focused composer.
  wireOnboarding();
  if (onboardingNeeded()) startOnboarding();
  else $('#input').focus();

  // After the UI is up, never as part of it: a launch with no internet must not
  // wait on a network timeout before the app appears.
  refreshUpdate();

  // Preload so the first message does not pay a cold model load.
  if (S.settings.backend !== 'openai' && S.settings.preload_default && S.settings.default_model && S.ollamaOk) {
    api.loadModel(S.settings.default_model, S.settings.keep_alive || undefined)
      .then(() => refreshModels())
      .catch(() => { /* not fatal — the first message just loads it instead */ });
  }

  // Keep the model list and loaded-model indicator current without polling hard.
  setInterval(async () => {
    if (anyStreaming() || !document.hasFocus()) return;
    const source = `${S.settings.backend}|${S.host}`;
    try {
      const data = await api.models();
      if (source !== `${S.settings.backend}|${S.host}`) return;
      S.running = data.running || [];
      S.host = data.host || S.host;
      const changed = data.models.length !== S.models.length
        || data.models.some((model, index) => model.name !== S.models[index]?.name
          || model.supports_tools !== S.models[index]?.supports_tools);
      S.models = data.models;
      if (!S.ollamaOk) { S.ollamaOk = true; renderTopbar(); }
      if (changed) emit('models');
    } catch {
      if (S.ollamaOk) { S.ollamaOk = false; renderTopbar(); }
    }
  }, 20000);
}

init();
