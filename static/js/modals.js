// Settings / Personas / Models / Parameters dialogs.

import {
  S, emit, patchSettings, refreshModels, refreshPrompts, effectiveParams,
  effectiveSystem, queueSaveChat, currentModel, currentPersona, modelInfo,
  thinkingSupported, thinkingAdvertised, refreshUpdate,
} from './store.js';
import { api, pullStream } from './api.js';
import {
  $, $$, el, svg, ICON, bytes, num, relTime, shortModel, toast, copyText,
} from './util.js';
import { applyTheme, ACCENTS, THEMES } from './theme.js';

export function openModal(title, body, foot = null, { wide = false } = {}) {
  $('#modal-title').textContent = title;
  const box = $('#modal-body');
  box.textContent = '';
  box.append(body);
  const footBox = $('#modal-foot');
  footBox.textContent = '';
  if (foot) { footBox.append(foot); footBox.hidden = false; } else { footBox.hidden = true; }
  $('#modal-box').classList.toggle('wide', wide);
  $('#modal').hidden = false;
  $('#overlay').hidden = false;
  box.scrollTop = 0;
  // Now that the dialog has a size, put every sliding lens where it belongs.
  // See segmented(): deferring this to a frame callback fails on an occluded
  // window, which produces no frames.
  $$('.seg', box).forEach((seg) => seg.placeLens?.());
}

export function closeModal() {
  $('#modal').hidden = true;
  $('#overlay').hidden = true;
}

export const modalOpen = () => !$('#modal').hidden;

/* helpers ------------------------------------------------------- */

function srow(title, sub, control) {
  return el('div', { class: 'srow' },
    el('div', { class: 'sr-body' },
      el('div', { class: 'sr-title', text: title }),
      sub ? el('div', { class: 'sr-sub', text: sub }) : null),
    el('div', { class: 'sr-ctl' }, control));
}

function toggle(checked, onchange) {
  const input = el('input', { type: 'checkbox', onchange: (e) => onchange(e.target.checked) });
  input.checked = !!checked;
  return el('label', { class: 'sw' }, input, el('i'));
}

/**
 * The update check, and the one place in the app that can reach the internet.
 *
 * It says so in the row rather than burying it, because "offline unless you say
 * otherwise" is a promise the README makes and this is the only thing that can
 * break it. Off by default; nothing is contacted until the switch is on.
 *
 * The status line is rebuilt in place rather than by reopening Settings, so the
 * result of a check appears under the switch that started it.
 */
function updateRow() {
  const status = el('div', { class: 'sr-sub', style: 'margin-top:5px' });

  const paint = () => {
    status.textContent = '';
    if (!S.settings?.update_check) {
      status.append(el('span', { text: 'Off — nothing leaves this machine.' }));
      return;
    }
    const u = S.update;
    if (!u) { status.append(el('span', { text: 'Checking…' })); return; }
    if (u.error) {
      // Server-worded and already generic; still rendered as text, never markup.
      status.append(el('span', { text: u.error }));
      return;
    }
    if (u.outdated) {
      status.append(el('span', { text: `Lantern ${u.latest} is available. ` }));
      // The href is built by the server from three integers it parsed itself,
      // never taken from the release payload.
      status.append(el('a', { href: u.url, target: '_blank', rel: 'noreferrer noopener',
        text: 'Release notes' }));
      status.append(el('span', { text: ' · update with ' }));
      status.append(el('code', { text: 'git pull && ./build-app.sh' }));
    } else {
      status.append(el('span', { text: `Up to date — ${u.latest || S.version} is the newest release.` }));
    }
  };

  const recheck = el('button', {
    class: 'btn btn-ghost', text: 'Check now',
    onclick: async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      S.update = null;
      paint();
      await refreshUpdate(true);
      paint();
      button.disabled = false;
    },
  });
  const sync = () => { recheck.hidden = !S.settings?.update_check; };

  const row = srow('Check for updates',
    'Asks GitHub once per launch whether a newer release exists. This is the only '
    + 'request Lantern makes that is not to your selected local model server.',
    el('div', { style: 'display:flex;align-items:center;gap:8px' },
      recheck,
      toggle(S.settings?.update_check, async (on) => {
        await patchSettings({ update_check: on });
        sync();
        S.update = null;
        paint();
        await refreshUpdate();
        paint();
      })));
  row.querySelector('.sr-body').append(status);
  sync();
  paint();
  return row;
}

/**
 * Segmented control with a sliding indicator, matching the sidebar's lens.
 *
 * One element moved by transform rather than a background on each button, so
 * the travel is composited rather than repainted — the same reasoning as
 * moveLens() in main.js. The buttons keep an `.on` class for their text weight;
 * only the surface underneath moves.
 */
function segmented(options, value, onpick) {
  const box = el('div', { class: 'seg' });
  const lens = el('i', { class: 'seg-lens' });
  box.append(lens);

  const move = (button, animate = true) => {
    if (!button || !button.offsetWidth) return false;   // not laid out yet
    if (!animate) lens.style.transition = 'none';
    lens.style.width = `${button.offsetWidth}px`;
    lens.style.transform = `translateX(${button.offsetLeft - 3}px)`;
    lens.style.opacity = '1';
    // setTimeout, not rAF: rAF does not run while the window is occluded, which
    // would leave the transition permanently disabled.
    if (!animate) setTimeout(() => { lens.style.transition = ''; }, 0);
    return true;
  };

  for (const [val, label] of options) {
    const button = el('button', {
      class: val === value ? 'on' : '',
      text: label,
      onclick: () => {
        $$('button', box).forEach((b) => b.classList.remove('on'));
        button.classList.add('on');
        move(button);
        onpick(val);
      },
    });
    box.append(button);
  }

  // The control is built before it is in the document, so widths are 0 here and
  // the lens cannot be positioned yet.
  //
  // Placement is deliberately **not** deferred to requestAnimationFrame or a
  // ResizeObserver. Both are frame-driven, and a window that is occluded or
  // backgrounded produces no frames — the lens then never appears at all, which
  // is exactly what happened: Density opened bare while Message width looked
  // fine only because it had been clicked. openModal() calls this once the
  // dialog is on screen, which is a synchronous layout read at the one moment
  // the answer is knowable.
  box.placeLens = () => move(box.querySelector('button.on'), false);
  // Keep the lens right if the dialog reflows later; harmless when it never fires.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => box.placeLens()).observe(box);
  }
  return box;
}

function slider(value, min, max, step, format, onchange) {
  const out = el('span', { class: 'val', text: format(value) });
  const input = el('input', {
    type: 'range', min, max, step, value,
    oninput: (e) => {
      const v = parseFloat(e.target.value);
      out.textContent = format(v);
      onchange(v);
    },
  });
  return el('div', { class: 'slider', style: 'min-width:190px' }, input, out);
}

function sectionTitle(text) {
  return el('div', { class: 'sec-title', text });
}

/**
 * Change a visual setting and repaint immediately.
 *
 * patchSettings() awaits the server before it updates S.settings, so calling
 * applyTheme() straight after it repainted with the PREVIOUS value — every
 * pick appeared to need a second click. Update the local copy first so the UI
 * reacts at once, then persist in the background.
 */
export function applyVisual(patch) {
  Object.assign(S.settings, patch);
  applyTheme();
  patchSettings(patch).catch(() => toast('Could not save that setting', 'bad'));
}

/* ═══════════════════════════ prompt library ═══════════════════════════ */

/**
 * Reusable *user* prompts — the thing you type, as opposed to a persona, which
 * is the system prompt and applies to the whole conversation.
 */
export function openPrompts() {
  const body = el('div');

  const render = () => {
    body.textContent = '';
    body.append(el('div', { class: 'sr-sub', style: 'margin-bottom:12px' },
      'Saved prompts you reuse. Insert one from the command palette (⌘K) or here.'));

    if (!S.prompts.length) {
      body.append(el('div', { class: 'p-none', text: 'No saved prompts yet.' }));
    }

    for (const prompt of S.prompts) {
      const name = el('input', { class: 'inp', value: prompt.name });
      const text = el('textarea', { class: 'inp', rows: 3, style: 'margin-top:7px' });
      text.value = prompt.text || '';
      const row = el('div', { class: 'card', style: 'padding:12px 14px;margin-bottom:10px' },
        name, text,
        el('div', { style: 'display:flex;gap:7px;margin-top:9px' },
          el('button', {
            class: 'btn btn-ghost', text: 'Insert',
            onclick: () => { insertPrompt(prompt.text || ''); closeModal(); },
          }),
          el('button', {
            class: 'btn btn-ghost', text: 'Save',
            onclick: async () => {
              await api.updatePrompt(prompt.id, { name: name.value.trim() || 'Untitled', text: text.value });
              await refreshPrompts();
              toast('Prompt saved');
              render();
            },
          }),
          el('button', {
            class: 'btn btn-ghost danger', text: 'Delete',
            onclick: async () => {
              if (!confirm(`Delete "${prompt.name}"?`)) return;
              await api.deletePrompt(prompt.id);
              await refreshPrompts();
              render();
            },
          })));
      body.append(row);
    }

    body.append(el('button', {
      class: 'btn btn-primary', text: 'New prompt',
      onclick: async () => {
        await api.createPrompt({ name: 'Untitled', text: '' });
        await refreshPrompts();
        render();
      },
    }));
  };

  render();
  openModal('Prompt library', body);
}

/** Drop a saved prompt into the composer at the cursor. */
/** `{{name}}` placeholders in a saved prompt, in order, without duplicates. */
export function promptSlots(text) {
  const names = [];
  for (const m of String(text || '').matchAll(/\{\{\s*([^{}]{1,40}?)\s*\}\}/g)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/**
 * Insert a saved prompt, asking for its blanks first.
 *
 * A template with no placeholders behaves exactly as before, so nothing about
 * the existing library changes until someone writes a `{{...}}` into one.
 */
export function insertPrompt(text) {
  const slots = promptSlots(text);
  if (!slots.length) return insertRaw(text);

  const fields = new Map();
  const body = el('div', {},
    el('p', { class: 'reset-lead', text:
      'Fill the blanks. Anything left empty stays as-is so you can finish it in '
      + 'the composer.' }));
  for (const name of slots) {
    const field = el('input', { class: 'inp', placeholder: name, autocomplete: 'off' });
    fields.set(name, field);
    body.append(el('div', { class: 'slot-row' },
      el('label', { class: 'slot-label', text: name }), field));
  }

  const fill = () => {
    const filled = text.replace(/\{\{\s*([^{}]{1,40}?)\s*\}\}/g, (whole, name) => {
      const value = fields.get(name)?.value.trim();
      return value || whole;      // leave the placeholder visible if unanswered
    });
    closeModal();
    insertRaw(filled);
  };

  body.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); fill(); }
  });

  openModal('Fill in the prompt', body,
    el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;width:100%' },
      el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: closeModal }),
      el('button', { class: 'btn btn-primary', text: 'Insert', onclick: fill })));
  setTimeout(() => fields.get(slots[0])?.focus(), 50);
}

function insertRaw(text) {
  const input = $('#input');
  if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const caret = start + text.length;
  input.focus();
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/* ═══════════════════════════ settings ═══════════════════════════ */

export function openSettings() {
  const st = S.settings;
  const body = el('div');

  body.append(sectionTitle('Local model server'));
  const backend = el('select', { class: 'inp' },
    el('option', { value: 'ollama', text: 'Ollama' }),
    el('option', { value: 'openai', text: 'OpenAI-compatible (LM Studio, llama.cpp, Jan)' }));
  backend.value = st.backend || 'ollama';
  const endpoint = el('input', { class: 'inp', value: st.openai_base_url || 'http://127.0.0.1:1234/v1',
    placeholder: 'http://127.0.0.1:1234/v1' });
  const key = el('input', { class: 'inp', type: 'password', value: st.openai_api_key || '',
    placeholder: 'Optional local server key' });
  const connection = el('div', { class: 'field' }, endpoint, key);
  const syncConnection = () => { connection.hidden = backend.value !== 'openai'; };
  backend.addEventListener('change', syncConnection);
  syncConnection();
  body.append(srow('Backend', 'Choose where Lantern runs your chats. Ollama stays available.', backend));
  body.append(srow('Connection', 'Local HTTP only. LM Studio usually uses port 1234; llama.cpp uses 8080; Jan uses its configured port. The optional key is saved in your local settings file.', connection));
  body.append(el('button', { class: 'btn btn-primary', text: 'Apply connection', onclick: async () => {
    const url = endpoint.value.trim().replace(/\/+$/, '');
    if (backend.value === 'openai' && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+(?:\/[^/?#]+)*\/v1$/.test(url)) {
      toast('Use a local URL ending in /v1, including its port', 'bad'); return;
    }
    try {
      const switching = backend.value !== st.backend
        || (backend.value === 'openai' && url !== st.openai_base_url);
      await patchSettings({ backend: backend.value, openai_base_url: url,
        openai_api_key: key.value, default_model: switching ? null : st.default_model });
      await refreshModels();
      if (S.models.length && !S.models.some((model) => model.name === S.settings.default_model)) {
        await patchSettings({ default_model: S.models[0].name });
      }
      if (S.chat && !S.chat.messages?.length && S.models.length
          && !S.models.some((model) => model.name === S.chat.model)) {
        S.chat.model = S.settings.default_model;
        queueSaveChat();
        emit('model-changed');
      }
      openSettings();
      toast(S.ollamaOk ? 'Connected' : 'Saved. Start the local server and refresh models', S.ollamaOk ? '' : 'bad');
    } catch (err) { toast(err.message, 'bad'); }
  } }));

  body.append(sectionTitle('Appearance'));
  const themeGrid = el('div', { class: 'theme-grid' });
  const paint = () => $$('.theme-chip', themeGrid).forEach((c) =>
    c.classList.toggle('on', c.dataset.theme === (S.settings.theme || 'dark')));
  for (const t of [...THEMES, { id: 'system', label: 'System', swatch: 'linear-gradient(135deg,#0e0d11 50%,#fdfcfb 50%)' }]) {
    themeGrid.append(el('button', {
      class: 'theme-chip', dataset: { theme: t.id }, title: t.label,
      onclick: () => { applyVisual({ theme: t.id }); paint(); },
    },
      el('span', { class: 'theme-swatch',
        style: t.swatch.startsWith('linear') ? `background:${t.swatch}` : `background:${t.swatch}` }),
      el('span', { text: t.label })));
  }
  paint();
  body.append(srow('Theme', 'Pick a surface. Every accent works on all of them.', themeGrid));

  const swatches = el('div', { class: 'swatches' });
  for (const name of ACCENTS) {
    const dot = el('button', {
      class: `swatch${st.accent === name ? ' on' : ''}`,
      title: name,
      style: `background:${accentHex(name)}`,
      onclick: () => {
        $$('.swatch', swatches).forEach((s) => s.classList.remove('on'));
        dot.classList.add('on');
        applyVisual({ accent: name });
      },
    });
    swatches.append(dot);
  }
  body.append(srow('Accent', 'Highlight colour.', swatches));

  body.append(srow('Text size', 'Base font size for the whole app.',
    slider(st.font_size, 12, 20, 1, (v) => `${v}px`,
      (v) => applyVisual({ font_size: v }))));

  body.append(srow('Message width', 'How wide the conversation column runs.',
    segmented([['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide'], ['full', 'Full']],
      st.bubble_width, (v) => applyVisual({ bubble_width: v }))));

  body.append(srow('Density', 'Spacing between messages.',
    segmented([['comfortable', 'Comfortable'], ['compact', 'Compact']], st.density,
      (v) => applyVisual({ density: v }))));

  body.append(sectionTitle('Behaviour'));
  body.append(srow('Enter sends the message', 'Off means Enter adds a newline and ⌘⏎ sends.',
    toggle(st.send_on_enter, (v) => patchSettings({ send_on_enter: v }))));
  body.append(srow('Auto-name new chats', 'Uses the active model to write a short title.',
    toggle(st.auto_title, (v) => patchSettings({ auto_title: v }))));
  body.append(srow('Render markdown', 'Off shows raw text exactly as the model wrote it.',
    toggle(st.render_markdown, (v) => { patchSettings({ render_markdown: v }); emit('chat', {}); })));
  body.append(srow('Show generation stats', 'Tokens per second and counts under each reply.',
    toggle(st.show_stats, (v) => { patchSettings({ show_stats: v }); emit('chat', {}); })));
  body.append(srow('Auto-expand thinking', 'Open the thought panel while the model reasons.',
    toggle(st.thinking_open, (v) => patchSettings({ thinking_open: v }))));
  body.append(srow('Start new chats with tools on auto',
    'The model may call Lantern\'s local tools and decides when to. Turn this off '
    + 'to start every chat with tools disabled — the schemas cost prompt tokens on '
    + 'every turn. Does not affect the web page reader below, which is separate.',
    toggle(st.tools_default, (v) => patchSettings({ tools_default: v }))));
  // The tools registry is served by the server, so switching this refreshes it:
  // with the setting off the model is never told read_url exists.
  body.append(srow('Let the model read web pages',
    'Adds a read_url tool, so pasting a link and asking about it works. This is the '
    + 'only part of Lantern that reaches the internet — turn it off and only '
    + 'your selected local model server is contacted. Pages on this machine or your private '
    + 'network are always refused, switched on or not.',
    toggle(st.web_reader, async (v) => {
      await patchSettings({ web_reader: v });
      S.tools = (await api.tools()).tools || [];
      emit('models');      // the Tools pill and its caret list re-read S.tools
    })));

  if (st.backend !== 'openai') {
  body.append(sectionTitle('Performance'));
  const ka = el('select', { class: 'inp', onchange: (e) => patchSettings({ keep_alive: e.target.value }) });
  for (const [value, label] of [['', "Ollama's default (5 min)"], ['30m', '30 minutes'],
    ['1h', '1 hour'], ['-1', 'Until I quit'], ['0', 'Unload immediately']]) {
    const opt = el('option', { value, text: label });
    if ((st.keep_alive || '') === value) opt.selected = true;
    ka.append(opt);
  }
  body.append(srow('Keep models loaded',
    'Ollama evicts a model after a few idle minutes, and the next message pays a full reload. '
    + 'Longer holds it in memory.', ka));
  body.append(srow('Preload on launch',
    'Load the default model at startup so the first message is instant.',
    toggle(st.preload_default, (v) => patchSettings({ preload_default: v }))));
  }

  body.append(sectionTitle('Defaults'));
  const modelSel = el('select', { class: 'inp', onchange: (e) => patchSettings({ default_model: e.target.value }) });
  for (const m of S.models) {
    const opt = el('option', { value: m.name, text: shortModel(m.name) });
    if (m.name === st.default_model) opt.selected = true;
    modelSel.append(opt);
  }
  if (!S.models.length) modelSel.append(el('option', { text: 'no models' }));
  body.append(srow('Default model', 'Used for new chats.', modelSel));

  const personaSel = el('select', {
    class: 'inp',
    onchange: (e) => patchSettings({ default_persona: e.target.value || null }),
  });
  // No "None": every chat resolves to a persona now, and Default is the blank
  // one. Pre-select whatever currentPersona() would actually fall back to, so
  // the dropdown never disagrees with the pill.
  const fallback = S.personas.find((p) => p.id === st.default_persona) || S.personas[0];
  for (const p of S.personas) {
    const opt = el('option', { value: p.id, text: `${p.emoji} ${p.name}` });
    if (p.id === (fallback?.id)) opt.selected = true;
    personaSel.append(opt);
  }
  if (!S.personas.length) personaSel.append(el('option', { text: 'no personas' }));
  body.append(srow('Default persona', 'Applied to new chats.', personaSel));

  body.append(el('div', { class: 'sec-row' },
    sectionTitle('Sampling defaults'), helpBtn()));
  body.append(el('div', { class: 'sr-sub', style: 'margin-bottom:4px',
    text: 'Starting point for every chat. Personas and individual chats can override these.' }));
  body.append(paramFields(st.default_params, (patch) => patchSettings({ default_params: patch })));

  body.append(sectionTitle('About'));
  body.append(srow('Version', 'A lean local chat interface.',
    el('span', { class: 'mono-sm', text: S.version ? `v${S.version}` : '—' })));
  body.append(updateRow());
  body.append(srow('Model server', S.host, el('span', {
    class: 'mono-sm', text: S.ollamaOk ? 'connected' : 'unreachable' })));
  body.append(srow('Data folder', S.dataDir,
    el('button', {
      class: 'btn btn-ghost', text: 'Copy path',
      onclick: async () => toast(await copyText(S.dataDir) ? 'Path copied' : 'Copy failed'),
    })));
  body.append(srow('Back up everything',
    'Every chat, persona and setting in one JSON file.',
    el('div', { style: 'display:flex;gap:7px' },
      el('button', { class: 'btn btn-ghost', text: 'Back up',
        onclick: () => window.__lantern?.backupAll?.() }),
      el('button', { class: 'btn btn-ghost', text: 'Restore…',
        onclick: () => { closeModal(); window.__lantern?.restoreAll?.(); } }))));
  body.append(srow('Settings guide', 'What each sampling value does, in plain terms.',
    el('button', { class: 'btn btn-ghost', text: 'Open guide', onclick: openGuide })));
  body.append(srow('Full reset',
    'Deletes every chat, folder, persona, saved prompt and setting, and starts the '
    + 'first-run setup again. There is no undo other than a backup.',
    el('button', { class: 'btn btn-ghost danger', text: 'Reset…', onclick: openReset })));
  body.append(srow('Chats stored', `${S.chats.length} conversation${S.chats.length === 1 ? '' : 's'} on disk`,
    el('span', { class: 'mono-sm', text: 'JSON' })));

  openModal('Settings', body);
}

function accentHex(name) {
  const map = {
    indigo: '#6366f1', lantern: '#f0a83c', neon: '#fcee0a', cyan: '#00e5ff', magenta: '#ff2e88',
    blue: '#3b82f6', teal: '#14b8a6', green: '#22c55e',
    amber: '#f59e0b', rose: '#f43f5e', violet: '#a855f7', slate: '#64748b',
  };
  return map[name] || '#6366f1';
}


/* ═══════════════════════════ settings guide ═══════════════════════════ */

const GUIDE_SECTIONS = [
  {
    title: 'Sampling — how the next word gets picked',
    blurb: 'At every step the model produces a probability for every possible '
         + 'next token. These four settings decide how that list is turned into '
         + 'one choice.',
    items: [
      ['Temperature', '0 – 2', 'default 0.7',
       'Flattens or sharpens the probability curve. Low means it almost always '
       + 'takes the single likeliest token, so answers are consistent and a bit '
       + 'flat. High spreads the odds, so it takes more risks and repeats itself '
       + 'less — but drifts and invents more.',
       'The one setting genuinely worth changing. 0.2–0.3 for code, facts and '
       + 'extraction. 0.7–1.0 for writing and brainstorming.'],
      ['Top P', '0 – 1', 'default 0.9',
       'Also called nucleus sampling. Sorts tokens by probability and keeps only '
       + 'the smallest group whose odds add up to P, discarding the tail. At 0.9 '
       + 'the unlikeliest 10% of probability mass is thrown away before sampling.',
       'Leave it at 0.9. Tune temperature OR top-p, not both — they pull the same '
       + 'lever from opposite ends and fighting them makes output hard to predict.'],
      ['Top K', '0 – 200', 'default 40',
       'A hard cap on the number of candidates: only the K likeliest tokens can '
       + 'be chosen, regardless of their probabilities. Cruder than top-p, since '
       + 'K is fixed whether the model is confident or not.',
       'Rarely useful once top-p is set. 40 is a safe default; 0 disables it.'],
      ['Repeat penalty', '0.5 – 2', 'default 1.1',
       'Reduces the probability of tokens that already appeared, which is what '
       + 'stops the model looping the same phrase forever.',
       'Above ~1.2 prose starts sounding stilted because ordinary words get '
       + 'penalised. Lower it to about 1.05 for code, where repetition is normal '
       + 'and correct.'],
    ],
  },
  {
    title: 'Limits — memory, length and repeatability',
    items: [
      ['Context window (num_ctx)', 'tokens', 'default 32768',
       'How much of the conversation the model can see at once: system prompt, '
       + 'every earlier message, and the reply being written. Past the limit the '
       + 'oldest turns fall out of view. Costs memory roughly in proportion — '
       + 'measured on a 9B model, about 34 MB per 1k tokens.',
       'Worth setting per model. Most models here support far more than the '
       + '32768 default — check the model picker, which shows each one\'s trained '
       + 'context, or use Max. The gauge under the composer estimates how full '
       + 'you are.'],
      ['Max output tokens (num_predict)', '-1 or n', 'default -1',
       'A ceiling on the length of one reply. -1 means no limit beyond the '
       + 'context window.',
       'Only worth setting to stop a model that rambles. Careful with reasoning '
       + 'models: thinking counts toward it, so a low cap can consume the whole '
       + 'budget on reasoning and leave no room for the answer.'],
      ['Seed', 'blank or n', 'default blank',
       'Fixes the random number generator. The same seed, prompt and settings '
       + 'produce the same reply every time.',
       'Useful when comparing two prompts and you want the randomness held still. '
       + 'Leave blank for normal use.'],
    ],
  },
  {
    title: 'Thinking',
    items: [
      ['Think toggle', 'off / on', '',
       'Reasoning models can work through a problem in a separate channel before '
       + 'answering. Lantern streams that into the collapsible panel above the '
       + 'reply and times it. It is never sent back to the model on later turns.',
       'Helps on multi-step problems: maths, logic, debugging. Pure cost on '
       + 'simple lookups and rewrites, since you wait for reasoning you will not read.'],
      ['Effort (low / medium / high)', '', '',
       'Asks for proportionally more reasoning before answering.',
       'Ollama exposes no way to detect which models accept a level, so it is '
       + 'offered for all of them. Models built for it honour the level; the rest '
       + 'treat any level as plain "on". Nothing breaks either way.'],
      ['THINK vs THINK*', '', '',
       'THINK means Ollama declares the capability. THINK* means Lantern watched '
       + 'the model actually reason even though Ollama did not declare it.',
       'gemma-4 is the example: it reports only vision, yet reasons fully. Rather '
       + 'than trust the declaration, Lantern omits the think field for unknown '
       + 'models — sending think:false would suppress the very output needed to '
       + 'find out — and remembers what it observes.'],
    ],
  },
  {
    title: 'Where a setting comes from',
    blurb: 'Three layers, each overriding the one before: '
         + 'Settings defaults → the active persona → this chat. '
         + 'So a persona can carry its own temperature, and one chat can override '
         + 'that without disturbing either. "Reset overrides" in Parameters drops '
         + 'back to the persona.',
    items: [],
  },
];

const GUIDE_PRESETS = [
  ['Code & debugging', '0.2', '0.9', '1.05', 'Repetition is correct in code, so keep the penalty low.'],
  ['Facts & extraction', '0.2', '0.9', '1.1', 'Lowest drift. Pair with a seed if you need repeatability.'],
  ['General chat', '0.7', '0.9', '1.1', 'The shipped default.'],
  ['Creative writing', '0.9', '0.95', '1.15', 'More variety; slightly stronger anti-repetition.'],
  ['Reasoning models', '0.6', '0.95', '1.1', 'Reasoning models want some heat — cranking temperature down makes them loop.'],
];

export function openGuide() {
  const body = el('div', { class: 'guide' });

  body.append(el('p', { class: 'guide-lede',
    text: 'What every setting actually does, and whether it is worth changing.' }));

  for (const section of GUIDE_SECTIONS) {
    body.append(sectionTitle(section.title));
    if (section.blurb) body.append(el('p', { class: 'guide-blurb', text: section.blurb }));
    for (const [name, range, dflt, what, advice] of section.items) {
      body.append(el('div', { class: 'guide-item' },
        el('div', { class: 'guide-head' },
          el('span', { class: 'guide-name', text: name }),
          range ? el('span', { class: 'tag', text: range }) : null,
          dflt ? el('span', { class: 'guide-default', text: dflt }) : null),
        el('p', { class: 'guide-what', text: what }),
        el('p', { class: 'guide-advice', text: advice })));
    }
  }

  body.append(sectionTitle('Starting points'));
  const table = el('table', { class: 'guide-table' },
    el('thead', {}, el('tr', {},
      el('th', { text: 'For' }), el('th', { text: 'Temp' }),
      el('th', { text: 'Top P' }), el('th', { text: 'Repeat' }),
      el('th', { text: 'Why' }))),
    el('tbody', {}, ...GUIDE_PRESETS.map(([label, t, tp, rp, why]) => el('tr', {},
      el('td', { text: label }),
      el('td', { class: 'mono-sm', text: t }),
      el('td', { class: 'mono-sm', text: tp }),
      el('td', { class: 'mono-sm', text: rp }),
      el('td', { class: 'guide-why', text: why })))));
  body.append(table);
  body.append(el('p', { class: 'guide-blurb',
    text: 'Save these as personas rather than switching the global defaults back '
        + 'and forth — a persona carries its own sampling settings.' }));

  const foot = el('div', { style: 'display:flex;gap:8px;width:100%' },
    el('button', { class: 'btn btn-ghost', text: 'Open settings', onclick: openSettings }),
    el('button', { class: 'btn btn-ghost', text: 'This chat\'s parameters', onclick: openParams }),
    el('span', { class: 'grow' }),
    el('button', { class: 'btn btn-primary', text: 'Done', onclick: closeModal }));

  openModal('Settings guide', body, foot, { wide: true });
}

/** A small "?" that opens the guide, for placing beside a section heading. */
function helpBtn() {
  return el('button', {
    class: 'help-btn', title: 'What do these mean?', text: '?',
    onclick: openGuide,
  });
}

/* ═══════════════════════════ parameters ═══════════════════════════ */

const PARAM_DEFS = [
  ['temperature', 'Temperature', 'Higher is more random.', 0, 2, 0.05, (v) => v.toFixed(2)],
  ['top_p', 'Top P', 'Nucleus sampling cutoff.', 0, 1, 0.01, (v) => v.toFixed(2)],
  ['top_k', 'Top K', 'Consider only the K most likely tokens.', 0, 200, 1, (v) => String(v)],
  ['min_p', 'Min P', 'Drop tokens below this share of the best one. 0 disables.',
    0, 0.5, 0.005, (v) => v.toFixed(3)],
  ['repeat_penalty', 'Repeat penalty', 'Higher discourages repetition.', 0.5, 2, 0.01, (v) => v.toFixed(2)],
];

function paramFields(params, onpatch) {
  const box = el('div');
  const compatible = S.settings?.backend === 'openai';
  if (compatible) box.append(el('div', { class: 'hint',
    text: 'This backend uses common sampling options only. Model memory and context are managed in your runner.' }));
  for (const [key, label, sub, min, max, step, fmt] of PARAM_DEFS) {
    if (compatible && key !== 'temperature' && key !== 'top_p') continue;
    const value = params[key] ?? 0;
    box.append(srow(label, sub, slider(value, min, max, step, fmt, (v) => onpatch({ [key]: v }))));
  }

  const ctx = el('input', {
    class: 'inp', type: 'number', min: 512, max: 1048576, step: 512,
    value: params.num_ctx ?? 32768,
    onchange: (e) => onpatch({ num_ctx: parseInt(e.target.value, 10) || 32768 }),
  });
  const trained = modelInfo(currentModel())?.context_length;
  const ctxCtl = el('div', { style: 'display:flex;gap:7px;align-items:center' }, ctx,
    trained ? el('button', {
      class: 'btn btn-ghost', style: 'flex:none',
      text: 'Max', title: `Use this model's trained context (${num(trained)})`,
      onclick: () => { ctx.value = trained; onpatch({ num_ctx: trained }); },
    }) : null);
  if (!compatible) box.append(srow('Context window',
    `num_ctx — larger uses more memory.${trained ? ` This model supports ${num(trained)}.` : ''}`,
    ctxCtl));

  const predict = el('input', {
    class: 'inp', type: 'number', min: -2, max: 131072, step: 64,
    value: params.num_predict ?? -1,
    onchange: (e) => onpatch({ num_predict: parseInt(e.target.value, 10) }),
  });
  box.append(srow('Max output tokens', compatible
    ? 'Positive values are sent as max_tokens; -1 leaves the runner default.'
    : 'num_predict — -1 means unlimited.', predict));

  const seed = el('input', {
    class: 'inp', type: 'number', placeholder: 'random',
    value: params.seed ?? '',
    onchange: (e) => onpatch({ seed: e.target.value === '' ? null : parseInt(e.target.value, 10) }),
  });
  box.append(srow('Seed', 'Fix for reproducible output. Blank is random.', seed));

  const stop = el('input', {
    class: 'inp', placeholder: 'e.g.  ###, END',
    value: (params.stop || []).join(', '),
    onchange: (e) => onpatch({
      stop: e.target.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 8),
    }),
  });
  box.append(srow('Stop sequences',
    'Comma-separated. Generation halts as soon as one appears.', stop));

  // Escape hatches. Ollama picks these itself and gets it right almost always;
  // blank means "leave it alone" rather than "use zero".
  if (!compatible) box.append(sectionTitle('Advanced — leave blank unless you know why'));
  const hw = [
    ['num_gpu', 'GPU layers', 'Layers offloaded to the GPU. Blank = auto-detect.'],
    ['num_thread', 'CPU threads', 'Blank = auto.'],
    ['num_batch', 'Batch size', 'Prompt tokens processed per pass. Blank = auto.'],
  ];
  for (const [key, label, sub] of compatible ? [] : hw) {
    box.append(srow(label, sub, el('input', {
      class: 'inp', type: 'number', min: 0, placeholder: 'auto',
      value: params[key] ?? '',
      onchange: (e) => onpatch({ [key]: e.target.value === '' ? null : parseInt(e.target.value, 10) }),
    })));
  }
  return box;
}

export function openParams() {
  if (!S.chat) return;
  const body = el('div');
  const info = modelInfo(currentModel());

  body.append(el('div', { class: 'sec-row' }, sectionTitle('This chat'), helpBtn()));
  body.append(el('div', { class: 'sr-sub', style: 'margin-bottom:6px' },
    `Overrides for ${shortModel(currentModel())}`
    + (info?.context_length ? ` · trained context ${num(info.context_length)}` : '')));

  const chatParams = { ...effectiveParams(), ...(S.chat.params || {}) };
  body.append(paramFields(chatParams, (patch) => {
    S.chat.params = { ...(S.chat.params || {}), ...patch };
    queueSaveChat();
    emit('foot');
  }));

  body.append(sectionTitle('System prompt'));
  const usingPersona = S.chat.system_override == null;
  const persona = currentPersona();
  const ta = el('textarea', {
    class: 'inp', rows: 7,
    placeholder: 'Instructions the model sees before every message…',
  });
  ta.value = effectiveSystem();
  ta.addEventListener('input', () => {
    S.chat.system_override = ta.value;
    queueSaveChat();
    emit('persona-changed');
  });
  body.append(el('div', { class: 'sr-sub', style: 'margin:2px 0 6px' },
    usingPersona
      ? `Inherited from ${persona ? `${persona.emoji} ${persona.name}` : 'no persona'}. Editing here overrides it for this chat only.`
      : 'Overridden for this chat.'));
  body.append(ta);

  const foot = el('div', { style: 'display:flex;gap:8px;width:100%' },
    el('button', {
      class: 'btn btn-ghost', text: 'Reset overrides',
      onclick: () => {
        S.chat.params = {};
        S.chat.system_override = null;
        queueSaveChat(true);
        emit('persona-changed');
        openParams();
        toast('Reset to persona defaults');
      },
    }),
    el('span', { class: 'grow' }),
    el('button', { class: 'btn btn-primary', text: 'Done', onclick: closeModal }),
  );
  openModal('Parameters', body, foot);
}

/* ═══════════════════════════ personas ═══════════════════════════ */

export function openPersonas() {
  const body = el('div');
  const list = el('div', { class: 'cards' });
  const activeId = S.chat?.persona_id;

  for (const persona of S.personas) {
    const card = el('div', { class: `card${persona.id === activeId ? ' on' : ''}` },
      el('div', { class: 'card-emoji', text: persona.emoji || '💬' }),
      el('div', { class: 'card-body' },
        el('div', { class: 'card-title' },
          el('span', { text: persona.name }),
          persona.id === S.settings.default_persona
            ? el('span', { class: 'tag', text: 'DEFAULT' }) : null,
          persona.model ? el('span', { class: 'tag', text: shortModel(persona.model) }) : null),
        el('div', { class: 'card-sub',
          text: persona.description || (persona.prompt
            ? persona.prompt.replace(/\s+/g, ' ').slice(0, 90)
            : 'No system prompt') })),
      el('div', { class: 'card-acts' },
        el('button', {
          class: 'btn btn-icon', title: 'Use in this chat',
          html: svg(ICON.check, 'ic'),
          onclick: () => { applyPersona(persona.id); closeModal(); },
        }),
        el('button', {
          class: 'btn btn-icon', title: 'Edit',
          html: svg(ICON.edit, 'ic'),
          onclick: () => editPersona(persona),
        }),
        el('button', {
          class: 'btn btn-icon btn-danger', title: 'Delete',
          html: svg(ICON.trash, 'ic'),
          onclick: async () => {
            if (!confirm(`Delete the "${persona.name}" persona?`)) return;
            await api.deletePersona(persona.id);
            S.personas = S.personas.filter((p) => p.id !== persona.id);
            if (S.chat?.persona_id === persona.id) {
              S.chat.persona_id = null;
              queueSaveChat();
            }
            emit('personas');
            emit('persona-changed');
            openPersonas();
            toast('Persona deleted');
          },
        })),
    );
    list.append(card);
  }
  if (!S.personas.length) {
    list.append(el('div', { class: 'p-none', text: 'No personas yet.' }));
  }
  body.append(list);

  const foot = el('div', { style: 'display:flex;gap:8px;width:100%' },
    el('button', { class: 'btn btn-ghost', text: 'Import JSON', onclick: importPersonas }),
    el('button', {
      class: 'btn btn-ghost', text: 'Export',
      onclick: async () => {
        const { download } = await import('./util.js');
        download('personas.json', JSON.stringify(S.personas, null, 2), 'application/json');
      },
    }),
    el('span', { class: 'grow' }),
    el('button', {
      class: 'btn btn-primary', html: `${svg(ICON.plus, 'ic')}<span>New persona</span>`,
      onclick: () => editPersona(null),
    }),
  );
  openModal('Personas', body, foot, { wide: true });
}

export function applyPersona(id) {
  if (!S.chat) return;
  S.chat.persona_id = id || null;
  S.chat.system_override = null;   // a fresh persona replaces any per-chat override
  const persona = S.personas.find((p) => p.id === id);
  if (persona?.model && S.models.some((m) => m.name === persona.model)) {
    S.chat.model = persona.model;
  }
  if (persona?.think !== null && persona?.think !== undefined) {
    S.chat.think = persona.think;
  }
  queueSaveChat();
  emit('persona-changed');
  emit('chat', { focus: false });
}

const EMOJI_CHOICES = ['✨', '⚡', '🧮', '🎓', '✍️', '🔬', '🧠', '🛠️', '📊', '🗺️', '🎭', '🧑‍⚖️',
  '💡', '🩺', '📚', '🐍', '🦀', '🌐', '🎨', '🔍', '💬', '🚀'];

function editPersona(persona) {
  const isNew = !persona;
  const draft = persona
    ? { ...persona, params: { ...(persona.params || {}) } }
    : { name: '', emoji: '✨', prompt: '', description: '', model: null, params: {}, think: null };

  const body = el('div');

  const emojiRow = el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px' });
  for (const choice of EMOJI_CHOICES) {
    const button = el('button', {
      class: 'btn btn-icon',
      text: choice,
      style: `font-size:1.05rem;${draft.emoji === choice ? 'background:var(--accent-soft)' : ''}`,
      onclick: () => {
        draft.emoji = choice;
        $$('button', emojiRow).forEach((b) => { b.style.background = ''; });
        button.style.background = 'var(--accent-soft)';
      },
    });
    emojiRow.append(button);
  }

  const nameInput = el('input', { class: 'inp', placeholder: 'Rust reviewer', value: draft.name });
  const descInput = el('input', { class: 'inp', placeholder: 'One line about what this persona is for', value: draft.description || '' });
  const promptInput = el('textarea', { class: 'inp', rows: 9,
    placeholder: 'You are a…\n\nBe specific about tone, format, and what to avoid.' });
  promptInput.value = draft.prompt || '';

  body.append(
    el('div', { class: 'row' },
      el('div', { class: 'field' },
        el('label', { text: 'Name' }), nameInput)),
    el('div', { class: 'field' }, el('label', { text: 'Icon' }), emojiRow),
    el('div', { class: 'field' }, el('label', { text: 'Description' }), descInput),
    el('div', { class: 'field' },
      el('label', { text: 'System prompt' }), promptInput,
      el('div', { class: 'hint', text: 'Leave empty for raw model behaviour.' })),
  );

  const modelSel = el('select', { class: 'inp' });
  modelSel.append(el('option', { value: '', text: 'Keep current model' }));
  for (const m of S.models) {
    const opt = el('option', { value: m.name, text: shortModel(m.name) });
    if (m.name === draft.model) opt.selected = true;
    modelSel.append(opt);
  }

  const thinkSel = el('select', { class: 'inp' });
  for (const [value, label] of [['', 'Leave as is'], ['off', 'Off'], ['on', 'On'],
    ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]) {
    const opt = el('option', { value, text: label });
    const current = draft.think === null || draft.think === undefined ? ''
      : (draft.think === true ? 'on' : (draft.think === false ? 'off' : draft.think));
    if (value === current) opt.selected = true;
    thinkSel.append(opt);
  }

  body.append(
    el('div', { class: 'row' },
      el('div', { class: 'field' }, el('label', { text: 'Preferred model' }), modelSel),
      el('div', { class: 'field' }, el('label', { text: 'Thinking' }), thinkSel)),
  );

  body.append(sectionTitle('Sampling overrides'));
  body.append(el('div', { class: 'sr-sub', style: 'margin-bottom:4px',
    text: 'Only what you change here overrides the global defaults.' }));
  const merged = { ...S.settings.default_params, ...draft.params };
  body.append(paramFields(merged, (patch) => Object.assign(draft.params, patch)));

  const foot = el('div', { style: 'display:flex;gap:8px;width:100%' },
    el('button', { class: 'btn btn-ghost', text: 'Back', onclick: openPersonas }),
    el('span', { class: 'grow' }),
    el('button', {
      class: 'btn btn-primary', text: isNew ? 'Create' : 'Save',
      onclick: async () => {
        const payload = {
          name: nameInput.value.trim() || 'Untitled',
          emoji: draft.emoji,
          description: descInput.value.trim(),
          prompt: promptInput.value,
          model: modelSel.value || null,
          params: draft.params,
          think: thinkSel.value === '' ? null
            : (thinkSel.value === 'on' ? true : (thinkSel.value === 'off' ? false : thinkSel.value)),
        };
        if (isNew) {
          const created = await api.createPersona(payload);
          S.personas.push(created);
          toast('Persona created');
        } else {
          const updated = await api.updatePersona(persona.id, payload);
          const index = S.personas.findIndex((p) => p.id === persona.id);
          S.personas[index] = updated;
          toast('Persona saved');
        }
        emit('personas');
        emit('persona-changed');
        openPersonas();
      },
    }),
  );
  openModal(isNew ? 'New persona' : `Edit ${persona.name}`, body, foot, { wide: true });
  nameInput.focus();
}

function importPersonas() {
  const input = el('input', { type: 'file', accept: '.json', style: 'display:none' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const items = Array.isArray(parsed) ? parsed : (parsed.personas || []);
      let count = 0;
      for (const item of items) {
        if (!item || typeof item.prompt !== 'string') continue;
        const created = await api.createPersona({
          name: item.name || 'Imported',
          emoji: item.emoji || '💬',
          description: item.description || '',
          prompt: item.prompt,
          model: item.model || null,
          params: item.params || {},
          think: item.think ?? null,
        });
        S.personas.push(created);
        count++;
      }
      emit('personas');
      openPersonas();
      toast(`Imported ${count} persona${count === 1 ? '' : 's'}`);
    } catch (err) {
      toast(`Import failed: ${err.message}`, 'bad');
    }
  });
  document.body.append(input);
  input.click();
  setTimeout(() => input.remove(), 1000);
}

/* ═══════════════════════════ models ═══════════════════════════ */

export function openModels() {
  const body = el('div');

  if (S.settings?.backend === 'openai') {
    body.append(el('div', { class: 'hint', text: 'Add, download, and load models in your local runner. Then refresh this list in Lantern.' }));
    body.append(sectionTitle(`Available (${S.models.length})`));
    const list = el('div', { class: 'cards' });
    for (const model of S.models) {
      list.append(el('div', { class: 'card' },
        el('div', { class: 'card-body' }, el('div', { class: 'card-title', text: model.name })),
        el('div', { class: 'card-acts' }, el('button', {
          class: 'btn btn-ghost', text: 'Use', onclick: () => { pickModel(model.name); closeModal(); },
        }))));
    }
    if (!S.models.length) list.append(el('div', { class: 'p-none', text: `No models reported by ${S.host}.` }));
    body.append(list);
    return openModal('Models', body, el('div', { class: 'row' },
      el('button', { class: 'btn btn-ghost', text: 'Refresh', onclick: async () => { await refreshModels(); openModels(); } }),
      el('button', { class: 'btn btn-primary', text: 'Done', onclick: closeModal })), { wide: true });
  }

  const pullRow = el('div', { class: 'field' },
    el('label', { text: 'Pull a model' }),
    el('div', { class: 'row' },
      el('input', { class: 'inp', id: 'pull-name', placeholder: 'llama3.2  ·  qwen3:8b  ·  hf.co/user/repo:Q4_K_M' }),
      el('button', { class: 'btn btn-primary', text: 'Pull', style: 'flex:none', onclick: startPull })),
    el('div', { class: 'hint', text: 'Downloads through your local Ollama. Names come from ollama.com/library.' }),
    el('div', { id: 'pull-status' }),
  );
  body.append(pullRow);

  body.append(sectionTitle(`Installed (${S.models.length})`));
  const list = el('div', { class: 'cards' });
  const vram = new Map(S.running.map((r) => [r.name, r.size_vram]));
  const runningNames = new Set(vram.keys());

  for (const model of S.models) {
    const loaded = runningNames.has(model.name);
    const card = el('div', { class: `card${model.name === currentModel() ? ' on' : ''}` },
      el('div', { class: 'card-body' },
        el('div', { class: 'card-title' },
          el('span', { class: 'mono-sm', style: 'font-size:.85rem', text: shortModel(model.name) }),
          thinkingAdvertised(model.name)
            ? el('span', { class: 'tag think', text: 'THINK' })
            : (thinkingSupported(model.name)
                ? el('span', { class: 'tag think', title: 'Reasoning confirmed by use; the model server does not declare it', text: 'THINK*' })
                : null),
          model.supports_vision ? el('span', { class: 'tag vision', text: 'VISION' }) : null,
          model.supports_tools ? el('span', {
            class: 'tag tools', text: 'TOOLS',
            title: 'The model can call tools. Switch Tools on in the toolbar to offer it Lantern\'s.',
          }) : null,
          loaded ? el('span', {
            class: 'tag',
            text: vram.get(model.name) ? `IN MEMORY · ${bytes(vram.get(model.name))}` : 'IN MEMORY',
          }) : null),
        el('div', { class: 'card-sub', text: [
          model.parameter_size,
          model.quantization && model.quantization !== 'unknown' ? model.quantization : null,
          bytes(model.size),
          model.context_length ? `${num(model.context_length)} ctx` : null,
          model.modified_at ? relTime(Date.parse(model.modified_at) / 1000) : null,
        ].filter(Boolean).join('  ·  ') })),
      el('div', { class: 'card-acts' },
        el('button', {
          class: 'btn btn-icon', title: 'Use in this chat', html: svg(ICON.check, 'ic'),
          onclick: () => { pickModel(model.name); closeModal(); },
        }),
        loaded ? el('button', {
          class: 'btn btn-icon', title: 'Unload from memory', html: svg(ICON.down, 'ic'),
          onclick: async () => {
            try {
              await api.unloadModel(model.name);
              toast('Unloaded');
              await refreshModels();
              openModels();
            } catch (err) { toast(err.message, 'bad'); }
          },
        }) : null,
        el('button', {
          class: 'btn btn-icon btn-danger', title: 'Delete from disk', html: svg(ICON.trash, 'ic'),
          onclick: async () => {
            if (!confirm(`Delete ${model.name} from disk? This frees ${bytes(model.size)}.`)) return;
            try {
              await api.deleteModel(model.name);
              toast('Model deleted');
              await refreshModels();
              openModels();
            } catch (err) { toast(err.message, 'bad'); }
          },
        })),
    );
    list.append(card);
  }
  if (!S.models.length) {
    list.append(el('div', { class: 'p-none' },
      S.ollamaOk ? 'No models installed. Pull one above.' : `Cannot reach Ollama at ${S.host}.`));
  }
  body.append(list);

  const foot = el('div', { style: 'display:flex;gap:8px;width:100%' },
    el('span', { class: 'mono-sm', style: 'color:var(--fg-3)', text: S.host }),
    el('span', { class: 'grow' }),
    el('button', {
      class: 'btn btn-ghost', text: 'Refresh',
      onclick: async () => { await refreshModels(); openModels(); toast('Refreshed'); },
    }),
    el('button', { class: 'btn btn-primary', text: 'Done', onclick: closeModal }),
  );
  openModal('Models', body, foot, { wide: true });
}

export function pickModel(name) {
  if (S.chat) {
    S.chat.model = name;
    // Thinking is per-model; drop the flag if the new model can't do it.
    if (!thinkingSupported(name)) S.chat.think = false;
    queueSaveChat();
  }
  emit('model-changed');
  emit('foot');
}

async function startPull() {
  const input = $('#pull-name');
  const name = input.value.trim();
  if (!name) { toast('Enter a model name', 'bad'); return; }
  const status = $('#pull-status');
  status.textContent = '';
  const label = el('div', { class: 'sr-sub', style: 'margin-top:8px', text: 'Starting…' });
  const bar = el('div', { class: 'progress' }, el('i', { style: 'width:0%' }));
  status.append(label, bar);

  const controller = new AbortController();
  const cancel = el('button', { class: 'btn btn-ghost', style: 'margin-top:8px', text: 'Cancel',
    onclick: () => controller.abort() });
  status.append(cancel);

  try {
    for await (const chunk of pullStream(name, controller.signal)) {
      if (chunk.error) throw new Error(chunk.error);
      const done = chunk.completed || 0;
      const total = chunk.total || 0;
      const pct = total ? Math.round((done / total) * 100) : null;
      label.textContent = pct !== null
        ? `${chunk.status} — ${bytes(done)} / ${bytes(total)} (${pct}%)`
        : (chunk.status || 'working…');
      bar.firstChild.style.width = `${pct ?? 4}%`;
    }
    label.textContent = 'Done.';
    bar.firstChild.style.width = '100%';
    cancel.remove();
    await refreshModels();
    toast(`Pulled ${name}`);
    openModels();
  } catch (err) {
    if (err.name === 'AbortError') {
      label.textContent = 'Cancelled.';
      toast('Pull cancelled');
    } else {
      label.textContent = `Failed: ${err.message}`;
      label.style.color = '#f87171';
      toast(`Pull failed: ${err.message}`, 'bad');
    }
    cancel.remove();
  }
}

/* ═══════════════════════════ keyboard help ═══════════════════════════ */

export function openShortcuts() {
  const { MOD } = window.__lantern || { MOD: '⌘' };
  const rows = [
    ['New chat', `${MOD}N`],
    ['Command palette', `${MOD}K`],
    ['Find in this chat', `${MOD}F`],
    ['Search all chats', `${MOD}⇧F`],
    ['Toggle sidebar', `${MOD}B`],
    ['Personas', `${MOD}P`],
    ['Switch persona', `${MOD}⇧P`],
    ['Models', `${MOD}M`],
    ['Settings', `${MOD},`],
    ['Toggle theme', `${MOD}⇧L`],
    ['Toggle thinking', `${MOD}⇧T`],
    ['Regenerate last reply', `${MOD}R`],
    ['Edit last message', `${MOD}⇧E`],
    ['Export chat as markdown', `${MOD}S`],
    ['Stop generating', 'Esc'],
    ['Send', 'Enter'],
    ['Newline', '⇧Enter'],
    ['Focus composer', '/'],
  ];
  const body = el('div');
  for (const [label, keys] of rows) {
    body.append(el('div', { class: 'srow' },
      el('div', { class: 'sr-body' }, el('div', { class: 'sr-title', text: label })),
      el('div', { class: 'sr-ctl' }, el('span', { class: 'kbd', text: keys }))));
  }
  openModal('Keyboard shortcuts', body);
}


/**
 * Full reset, guarded like the loaded gun it is.
 *
 * This data folder has lost chats twice, so the flow is deliberately slow: it
 * says exactly what will go, offers the backup first, and will not enable the
 * button until the word is typed. The server refuses without that word too, so
 * the dialog is a courtesy rather than the actual lock.
 */
export function openReset() {
  const counts = el('ul', { class: 'reset-list' });
  const chats = S.chats.length;
  const items = [
    [chats, `chat${chats === 1 ? '' : 's'}`],
    [S.folders.length, `folder${S.folders.length === 1 ? '' : 's'}`],
    [S.personas.length, `persona${S.personas.length === 1 ? '' : 's'}`],
    [S.prompts.length, `saved prompt${S.prompts.length === 1 ? '' : 's'}`],
  ];
  for (const [n, label] of items) {
    counts.append(el('li', { text: `${n} ${label}` }));
  }
  counts.append(el('li', { text: 'every setting, including your model and theme' }));

  const field = el('input', { class: 'inp', placeholder: 'reset', autocomplete: 'off' });
  const go = el('button', { class: 'btn btn-primary danger', text: 'Delete everything' });
  go.disabled = true;
  field.addEventListener('input', () => {
    go.disabled = field.value.trim().toLowerCase() !== 'reset';
  });

  go.addEventListener('click', async () => {
    go.disabled = true;
    go.textContent = 'Deleting…';
    try {
      const result = await api.reset();
      // Reload rather than repainting: every module holds state that no longer
      // has anything behind it, and the first-run flow keys off a fresh
      // bootstrap. A reload is the honest way back to a blank slate.
      localStorage.clear();
      toast(`Deleted ${result.chats_removed} chat${result.chats_removed === 1 ? '' : 's'}`);
      setTimeout(() => window.location.reload(), 400);
    } catch (err) {
      go.disabled = false;
      go.textContent = 'Delete everything';
      toast(`Reset failed: ${err.message}`, 'bad');
    }
  });

  const body = el('div', {},
    el('p', { class: 'reset-lead', text: 'This permanently deletes:' }),
    counts,
    el('p', { class: 'reset-lead', text:
      'Back up first. The file downloads to this machine and can be restored from '
      + 'Settings afterwards.' }),
    el('button', { class: 'btn btn-ghost', text: 'Download a backup',
      onclick: () => window.__lantern?.backupAll?.() }),
    el('p', { class: 'reset-lead', style: 'margin-top:18px', text:
      'Type reset below to confirm.' }),
    field);

  openModal('Full reset', body,
    el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;width:100%' },
      el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: closeModal }),
      go));
  setTimeout(() => field.focus(), 50);
}
