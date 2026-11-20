// Settings window. Builds the form from the field list the main process sends. API keys are never
// shown or sent back here: only whether one is saved (and its last 4 characters). On Save, a key goes
// to the main process only when it was typed in, or as `null` when it should be removed.
const api = window.settingsApi;
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
};

const state = { data: null, secretEdits: {} }; // secretEdits: KEY -> string (new key) | null (remove)

function fieldRow(f, data) {
  const id = `f_${f.key}`;
  const label = el('label', { className: 'label', htmlFor: id, textContent: f.label });
  if (f.restart) label.append(el('span', { className: 'tag', textContent: 'applies after restart' }));
  const row = el('div', { className: 'field' }, label);
  let control;

  if (f.type === 'secret') {
    control = secretControl(f, data.secrets[f.key], id);
  } else if (f.type === 'select') {
    control = el('select', { id, name: f.key });
    const opts = f.options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
    const current = data.values[f.key];
    if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: current });
    for (const o of opts) control.append(el('option', { value: o.value, textContent: o.label }));
    control.value = current;
  } else if (f.type === 'bool') {
    const box = el('input', { type: 'checkbox', id, name: f.key, checked: data.values[f.key] === 'true' });
    control = el('label', { className: 'check' }, box, 'On');
    label.htmlFor = id;
  } else if (f.type === 'folder') {
    const input = el('input', { type: 'text', id, name: f.key, value: data.values[f.key], readOnly: true });
    const browse = el('button', { type: 'button', textContent: 'Browse…' });
    browse.addEventListener('click', async () => {
      const dir = await api.pickFolder(input.value);
      if (dir) input.value = dir;
    });
    const reset = el('button', { type: 'button', textContent: 'Default' });
    reset.addEventListener('click', () => (input.value = f.default));
    control = el('div', { className: 'row' }, input, browse, reset);
  } else {
    control = el('input', {
      type: f.type === 'number' ? 'number' : 'text',
      id,
      name: f.key,
      value: data.values[f.key] ?? '',
      placeholder: f.placeholder || f.default || '',
      autocomplete: 'off',
      spellcheck: false,
    });
    if (f.type === 'number') Object.assign(control, { min: f.min, max: f.max, step: 1 });
  }
  row.append(control);
  if (f.help) row.append(el('p', { className: 'help', textContent: f.help }));
  return row;
}

function secretControl(f, info, id) {
  const wrap = el('div');
  const render = () => {
    wrap.replaceChildren();
    const edit = state.secretEdits[f.key];
    if (edit === null) {
      const undo = el('button', { type: 'button', textContent: 'Undo' });
      undo.addEventListener('click', () => {
        delete state.secretEdits[f.key];
        render();
      });
      wrap.append(el('div', { className: 'key-state' }, el('span', { className: 'badge remove', textContent: 'Will be removed when you save' }), undo));
      return;
    }
    if (info.set && edit === undefined) {
      const badge = el('span', { className: 'badge ok' }, '✓ Saved securely');
      if (info.hint) badge.append(' · ends in ', el('code', { textContent: `…${info.hint}` }));
      const replace = el('button', { type: 'button', textContent: 'Replace' });
      replace.addEventListener('click', () => {
        state.secretEdits[f.key] = '';
        render();
        $('input', wrap).focus();
      });
      const remove = el('button', { type: 'button', className: 'danger', textContent: 'Remove' });
      remove.addEventListener('click', () => {
        state.secretEdits[f.key] = null;
        render();
      });
      wrap.append(el('div', { className: 'key-state' }, badge, replace, remove));
      return;
    }
    const input = el('input', {
      type: 'password',
      id,
      autocomplete: 'off',
      spellcheck: false,
      placeholder: info.set ? 'Paste the new key' : 'Paste your key',
      value: edit || '',
    });
    input.addEventListener('input', () => (state.secretEdits[f.key] = input.value));
    const show = el('button', { type: 'button', textContent: 'Show' });
    show.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      show.textContent = input.type === 'password' ? 'Show' : 'Hide';
    });
    const parts = [input, show];
    if (info.set) {
      const keep = el('button', { type: 'button', textContent: 'Keep saved key' });
      keep.addEventListener('click', () => {
        delete state.secretEdits[f.key];
        render();
      });
      parts.push(keep);
    }
    wrap.append(el('div', { className: 'row' }, ...parts));
    if (info.unreadable) {
      wrap.append(el('p', { className: 'help', textContent: 'A key was saved on another PC or Windows account and cannot be read here. Paste it again.' }));
    }
  };
  render();
  return wrap;
}

function collect() {
  const values = {};
  for (const f of state.data.fields) {
    if (f.type === 'secret') continue;
    const input = document.getElementsByName(f.key)[0];
    if (!input) continue;
    values[f.key] = f.type === 'bool' ? String(input.checked) : input.value;
  }
  const secrets = {};
  for (const [key, v] of Object.entries(state.secretEdits)) {
    if (v === null) secrets[key] = null;
    else if (v.trim()) secrets[key] = v.trim();
  }
  return { values, secrets };
}

function setStatus(text, kind = '') {
  const s = $('#status');
  s.textContent = text;
  s.className = `status ${kind}`;
}

async function load() {
  state.data = await api.load();
  state.secretEdits = {};
  for (const section of document.querySelectorAll('[data-group]')) {
    const box = $('.fields', section);
    box.replaceChildren(...state.data.fields.filter((f) => f.group === section.dataset.group).map((f) => fieldRow(f, state.data)));
  }
  $('#welcome').hidden = !state.data.welcome;
  $('#securityNote').textContent = state.data.canEncrypt
    ? 'API keys are encrypted with your Windows account (DPAPI) and stored only on this PC. They are never shown again after saving.'
    : 'Windows secure storage is not available, so API keys cannot be saved.';
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#save');
  btn.disabled = true;
  setStatus('Saving…');
  try {
    const result = await api.save(collect());
    if (result?.error) throw new Error(result.error);
    await load();
    setStatus(result.restartNeeded ? 'Saved. Some changes apply after a restart.' : 'Saved. Changes are in use now.', 'ok');
  } catch (err) {
    setStatus(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
  } finally {
    btn.disabled = false;
  }
});
$('#cancel').addEventListener('click', () => api.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.close();
});

load().catch((err) => setStatus(`Could not load settings: ${err.message}`, 'error'));
