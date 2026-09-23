// The first-run flow.
//
// Shown once, on a data folder with no settings and no history. Three steps,
// each answering a question a new user actually has: is a server working, which
// model should this use, and what is this thing allowed to do. Skippable at
// every point, because an onboarding flow you cannot escape is worse than none.
//
// Nothing here is required for Lantern to work. Skipping leaves every default
// exactly as it ships.

import { S, emit, patchSettings, refreshModels, queueSaveChat } from './store.js';
import { api } from './api.js';
import { $, el, svg, ICON, shortModel, toast } from './util.js';
import { applyVisual } from './modals.js';
import { THEMES, ACCENTS } from './theme.js';

let step = 0;
let picked = null;

const STEPS = [stepWelcome, stepModel, stepLook, stepPermissions];

export function onboardingNeeded() {
  return !!S.firstRun;
}

/** Open the flow. Resolves when the user finishes or skips. */
export function startOnboarding() {
  step = 0;
  picked = S.settings?.default_model || S.models[0]?.name || null;
  $('#onboard').hidden = false;
  $('#overlay').hidden = false;
  render();
}

async function finish(skipped) {
  $('#onboard').hidden = true;
  $('#overlay').hidden = true;
  // Remember either way. Skipping is an answer, and asking again next launch
  // would be the same nag with a different name.
  await patchSettings({ onboarded: true });
  S.firstRun = false;
  if (!skipped && picked && picked !== S.settings?.default_model) {
    await patchSettings({ default_model: picked });
  }
  // Boot creates a blank chat before this runs, and it captured whatever the
  // default was *then* — so picking a model here left the chat in front of you
  // still showing the old one. Safe to retarget while it is empty; a chat with
  // history keeps the model it was answered with.
  if (!skipped && picked && S.chat && !S.chat.messages?.length && S.chat.model !== picked) {
    S.chat.model = picked;
    await queueSaveChat(true);
    emit('model-changed');
  }
  $('#input')?.focus();
}

function render() {
  const box = $('#onboard-body');
  box.textContent = '';
  box.append(STEPS[step]());

  const dots = $('#onboard-dots');
  dots.textContent = '';
  STEPS.forEach((_, i) => dots.append(el('i', { class: i === step ? 'on' : '' })));

  const back = $('#onboard-back');
  back.hidden = step === 0;
  $('#onboard-next').textContent = step === STEPS.length - 1 ? 'Start chatting' : 'Next';
}

function go(delta) {
  const next = step + delta;
  if (next < 0) return;
  if (next >= STEPS.length) { finish(false); return; }
  step = next;
  render();
}

/* ── step 1: is the local server working ─────────────────────────── */

function stepWelcome() {
  const wrap = el('div', { class: 'ob-step' });
  wrap.append(
    el('h3', { text: 'Welcome to Lantern' }),
    el('p', { class: 'ob-lead', text:
      'A chat interface for the models you run yourself. Everything you type and '
      + 'everything it replies stays on this machine, as plain files you can read.' }),
  );

  const backend = el('select', { class: 'inp' },
    el('option', { value: 'ollama', text: 'Ollama' }),
    el('option', { value: 'openai', text: 'Local OpenAI-compatible server' }));
  backend.value = S.settings?.backend || 'ollama';
  const endpoint = el('input', { class: 'inp',
    value: S.settings?.openai_base_url || 'http://127.0.0.1:1234/v1',
    placeholder: 'http://127.0.0.1:1234/v1' });
  const apply = el('button', { class: 'btn btn-ghost', text: 'Connect', onclick: async () => {
    const url = endpoint.value.trim().replace(/\/+$/, '');
    if (backend.value === 'openai' && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+(?:\/[^/?#]+)*\/v1$/.test(url)) {
      toast('Use a local URL ending in /v1, including its port', 'bad'); return;
    }
    try {
      await patchSettings({ backend: backend.value, openai_base_url: url, default_model: null });
      await refreshModels();
      picked = S.models[0]?.name || null;
      render();
    } catch (err) { toast(err.message, 'bad'); }
  } });
  const connection = el('div', { class: 'row' }, endpoint, apply);
  const sync = () => { endpoint.hidden = backend.value !== 'openai'; };
  backend.addEventListener('change', sync);
  sync();
  wrap.append(el('div', { class: 'field' }, el('label', { text: 'Model server' }), backend,
    connection, el('div', { class: 'hint', text: 'LM Studio: port 1234 · llama.cpp: port 8080 · Jan: your configured port' })));

  const ok = S.ollamaOk;
  const models = S.models.length;
  const isOllama = S.settings?.backend !== 'openai';
  const status = el('div', { class: `ob-check${ok && models ? ' good' : ' warn'}` });

  if (!ok) {
    status.append(
      el('div', { class: 'ob-check-title', text: 'Model server isn\'t responding' }),
      el('div', { class: 'ob-check-sub', text:
        `Lantern talks to ${S.host}. Start it in your runner${isOllama ? ' with "ollama serve"' : ''}, then check again.` }),
    );
  } else if (!models) {
    status.append(
      el('div', { class: 'ob-check-title', text: 'Server is running, but there are no models' }),
      el('div', { class: 'ob-check-sub', text:
        isOllama ? 'Pull one with "ollama pull qwen3" or from the Models panel, then check again.'
          : 'Load a model in your local runner, then check again.' }),
    );
  } else {
    status.append(
      el('div', { class: 'ob-check-title', text: 'Model server is connected' }),
      el('div', { class: 'ob-check-sub', text:
        `Ready at ${S.host}. Pick a model on the next step.` }),
    );
  }

  status.append(el('button', {
    class: 'btn btn-ghost', style: 'margin-top:10px',
    html: `${svg(ICON.redo, 'ic')}<span>Check again</span>`,
    onclick: async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      await refreshModels();
      picked = picked || S.models[0]?.name || null;
      render();
    },
  }));
  wrap.append(status);
  return wrap;
}

/* ── step 2: which model ────────────────────────────────────────── */

function stepModel() {
  const wrap = el('div', { class: 'ob-step' });
  wrap.append(
    el('h3', { text: 'Pick a default model' }),
    el('p', { class: 'ob-lead', text:
      'Used for new chats. You can change it per chat from the picker at the top, '
      + 'and add more any time from the Models panel.' }),
  );

  if (!S.models.length) {
    wrap.append(el('div', { class: 'ob-check warn' },
      el('div', { class: 'ob-check-title', text: 'No models installed yet' }),
      el('div', { class: 'ob-check-sub', text:
        'Skip this for now — Lantern will work as soon as you load one.' })));
    return wrap;
  }

  const list = el('div', { class: 'ob-models' });
  for (const model of S.models) {
    const chips = [];
    if (model.supports_tools) chips.push('tools');
    if (model.supports_thinking) chips.push('thinking');
    if (model.supports_vision) chips.push('vision');
    const row = el('button', {
      class: `ob-model${model.name === picked ? ' on' : ''}`,
      onclick: () => { picked = model.name; render(); },
    },
      el('span', { class: 'ob-model-body' },
        el('span', { class: 'ob-model-name', text: shortModel(model.name) }),
        el('span', { class: 'ob-model-sub',
          text: [model.parameter_size, ...chips].filter(Boolean).join(' · ') || '' })),
      model.name === picked ? el('span', { html: svg(ICON.check, 'ic') }) : null);
    list.append(row);
  }
  wrap.append(list);
  return wrap;
}

/* ── step 3: how it looks ───────────────────────────────────────── */

/**
 * Theme and accent, on the way in.
 *
 * Uses applyVisual() rather than patchSettings(), so the choice repaints
 * immediately — patchSettings awaits the server and a repaint straight after it
 * paints the previous value. That bug cost a release once.
 */
function stepLook() {
  const st = S.settings || {};
  const wrap = el('div', { class: 'ob-step' });
  wrap.append(
    el('h3', { text: 'Make it yours' }),
    el('p', { class: 'ob-lead', text:
      'Pick a look. Every accent works on every theme, and you can change both '
      + 'any time in Settings.' }),
  );

  const themes = el('div', { class: 'ob-themes' });
  const paintThemes = () => {
    themes.textContent = '';
    for (const t of THEMES) {
      themes.append(el('button', {
        class: `ob-theme${(S.settings?.theme || 'dark') === t.id ? ' on' : ''}`,
        title: t.label,
        onclick: () => { applyVisual({ theme: t.id }); paintThemes(); },
      },
        el('span', { class: 'ob-swatch', style: `background:${t.swatch}` }),
        el('span', { class: 'ob-theme-name', text: t.label })));
    }
  };
  paintThemes();
  wrap.append(themes);

  const accents = el('div', { class: 'ob-accents' });
  const paintAccents = () => {
    accents.textContent = '';
    for (const name of ACCENTS) {
      accents.append(el('button', {
        class: `ob-accent${(S.settings?.accent || 'indigo') === name ? ' on' : ''}`,
        title: name,
        dataset: { accent: name },
        onclick: () => { applyVisual({ accent: name }); paintAccents(); },
      }));
    }
  };
  paintAccents();
  wrap.append(el('div', { class: 'ob-sub', text: 'Accent' }), accents);
  return wrap;
}

/* ── step 4: what it may do ─────────────────────────────────────── */

function permRow(title, sub, key, value) {
  const input = el('input', { type: 'checkbox' });
  input.checked = !!value;
  input.addEventListener('change', async () => {
    await patchSettings({ [key]: input.checked });
    // web_reader gates read_url on the server, so the registry the UI holds is
    // stale the moment it changes — the same refresh the Settings row does.
    if (key === 'web_reader') {
      S.tools = (await api.tools()).tools || [];
      emit('models');
    }
  });
  return el('div', { class: 'ob-perm' },
    el('div', { class: 'ob-perm-body' },
      el('div', { class: 'ob-perm-title', text: title }),
      el('div', { class: 'ob-perm-sub', text: sub })),
    el('label', { class: 'sw' }, input, el('i')));
}

function stepPermissions() {
  const st = S.settings || {};
  const wrap = el('div', { class: 'ob-step' });
  wrap.append(
    el('h3', { text: 'What Lantern may do' }),
    el('p', { class: 'ob-lead', text:
      'Your chats and models never leave this machine. These are the only things '
      + 'that reach further, and you can change them any time in Settings.' }),
    permRow('Let the model use tools',
      'Read the clock, do exact arithmetic, and search your own saved chats. '
      + 'The model decides when to; every call is shown in the thread.',
      'tools_default', st.tools_default),
    permRow('Let the model read web pages',
      'So pasting a link and asking about it works. Only public addresses — '
      + 'anything on this machine or your network is refused.',
      'web_reader', st.web_reader),
    permRow('Check for updates',
      'Asks GitHub once per launch whether a newer release exists. Nothing about '
      + 'you or your chats is sent.',
      'update_check', st.update_check),
  );
  return wrap;
}

/* ── wiring ─────────────────────────────────────────────────────── */

export function wireOnboarding() {
  $('#onboard-next').addEventListener('click', () => go(1));
  $('#onboard-back').addEventListener('click', () => go(-1));
  $('#onboard-skip').addEventListener('click', () => finish(true));
}
