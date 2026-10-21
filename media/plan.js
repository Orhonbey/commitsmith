// Webview for the Smart split plan tab. Every string shown comes from the extension (`strings`)
// or from the repository; all of it is rendered as text, never as HTML.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('app');
  let model = null; // last `plan` message
  let result = null;
  let busyText = '';
  let errorText = '';
  let pushAfter = false;
  let dragged = null;
  let newFiles = new Set();
  let typed = new Map(); // message text not yet confirmed by the extension, per group id

  const post = (m) => vscode.postMessage(m);
  // Edits, commit and regroup are tied to the plan revision they were made against.
  const send = (m) => post(Object.assign({ revision: model.revision }, m));
  const fmt = (s, ...a) => s.replace(/\{(\d+)\}/g, (_, i) => String(a[Number(i)]));
  const S = (k) => (model && model.strings[k]) || '';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function button(label, cls, onClick, disabled) {
    const b = el('button', 'btn ' + (cls || ''), label);
    b.type = 'button';
    b.disabled = !!disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  /** Files of a group in display order: each .meta right after its asset, indented. */
  function displayFiles(files) {
    const set = new Set(files);
    const out = [];
    for (const f of files) {
      if (f.endsWith('.meta') && set.has(f.slice(0, -5))) continue;
      out.push({ path: f, sub: false });
      if (set.has(f + '.meta')) out.push({ path: f + '.meta', sub: true });
    }
    return out;
  }

  function fileRow(path, sub) {
    const row = el('div', 'file' + (sub ? ' sub-file' : ''));
    row.draggable = true;
    row.addEventListener('dragend', () => {
      dragged = null;
    });
    row.addEventListener('dragstart', (e) => {
      dragged = path;
      e.dataTransfer.setData('text/plain', path);
      e.dataTransfer.effectAllowed = 'move';
    });
    row.appendChild(el('span', '', path));
    if (newFiles.has(path)) row.appendChild(el('span', 'tag', S('new')));
    return row;
  }

  function dropTarget(card, groupId) {
    card.addEventListener('dragover', (e) => {
      if (!dragged) return;
      e.preventDefault();
      card.classList.add('over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('over'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('over');
      const file = dragged;
      dragged = null;
      if (file) send({ type: 'edit', edit: { kind: 'move', file: file, toGroupId: groupId } });
    });
  }

  function groupCard(g, i, count, locked) {
    const card = el('div', 'card' + (g.checked ? '' : ' off'));
    dropTarget(card, g.id);
    const head = el('div', 'card-head');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = g.checked;
    cb.disabled = locked;
    cb.title = S('include');
    cb.addEventListener('change', () => send({ type: 'edit', edit: { kind: 'toggle', groupId: g.id } }));
    const input = el('input');
    input.type = 'text';
    input.value = typed.has(g.id) ? typed.get(g.id) : g.message;
    input.disabled = locked;
    input.setAttribute('data-msg', g.id);
    input.setAttribute('aria-label', S('messageLabel'));
    input.addEventListener('change', () => send({ type: 'edit', edit: { kind: 'message', groupId: g.id, text: input.value } }));
    const move = el('span', 'move');
    for (const [glyph, delta, title, off] of [['↑', -1, S('moveUp'), i === 0], ['↓', 1, S('moveDown'), i === count - 1]]) {
      const b = el('button', '', glyph);
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.disabled = locked || off;
      b.addEventListener('click', () => send({ type: 'edit', edit: { kind: 'reorder', groupId: g.id, delta: delta } }));
      move.appendChild(b);
    }
    head.append(cb, el('span', 'num', String(i + 1)), input, move);
    card.appendChild(head);

    const body = el('div', 'card-body');
    if (g.files.length === 0) body.appendChild(el('div', 'empty', S('noFiles')));
    for (const f of displayFiles(g.files)) body.appendChild(fileRow(f.path, f.sub));
    if (g.reason) body.appendChild(el('div', 'why', g.reason));
    if (g.uncertain) body.appendChild(el('div', 'warn', '⚠ ' + S('uncertain')));
    card.appendChild(body);
    return card;
  }

  function resultView() {
    const frag = document.createDocumentFragment();
    frag.appendChild(el('h1', '', S('resultTitle')));
    for (const c of result.done) {
      const r = el('div', 'result');
      r.appendChild(el('span', 'sha', c.sha.slice(0, 7)));
      r.appendChild(el('span', '', c.message));
      frag.appendChild(r);
    }
    if (result.failed) {
      const r = el('div', 'result failed');
      r.appendChild(el('div', '', fmt(S('failed'), result.failed.message)));
      r.appendChild(el('div', 'error', result.failed.error));
      frag.appendChild(r);
    }
    return frag;
  }

  function render() {
    // Keep keyboard focus across re-renders (the extension re-posts the plan after each edit).
    const active = document.activeElement;
    const focusId = active && active.getAttribute ? active.getAttribute('data-msg') : null;
    root.replaceChildren();
    if (!model) return;
    const locked = busyText !== '';
    const { plan } = model;

    if (result) {
      root.appendChild(resultView());
    } else {
      root.appendChild(el('h1', '', fmt(S('proposes'), model.toolLabel, plan.groups.length)));
      root.appendChild(el('div', 'sub', fmt(S('subline'), model.fileCount, model.branch)));
      if (model.stale) root.appendChild(el('div', 'banner', S('stale')));
      if (plan.groups.length === 0) root.appendChild(el('div', 'empty', S('noGroups')));
      plan.groups.forEach((g, i) => root.appendChild(groupCard(g, i, plan.groups.length, locked)));

      const un = el('div', 'card unassigned');
      dropTarget(un, 'unassigned');
      const head = el('div', 'card-head');
      head.appendChild(el('span', '', S('unassigned')));
      head.appendChild(el('span', 'unassigned-note', S('unassignedNote')));
      un.appendChild(head);
      const body = el('div', 'card-body');
      if (plan.unassigned.length === 0) body.appendChild(el('div', 'empty', S('noFiles')));
      for (const f of displayFiles(plan.unassigned)) body.appendChild(fileRow(f.path, f.sub));
      un.appendChild(body);
      root.appendChild(un);
    }

    if (busyText) root.appendChild(el('div', 'busy', busyText));
    if (errorText) root.appendChild(el('div', 'error', errorText));

    const checked = plan.groups.filter((g) => g.checked && g.files.length > 0).length;
    const bar = el('div', 'buttons');
    if (!result) {
      bar.appendChild(button(fmt(S('commitChecked'), checked), 'primary', () => {
        errorText = '';
        send({ type: 'commit', pushAfter: pushAfter });
      }, locked || model.stale || model.used || checked === 0));
    }
    bar.appendChild(button(S('regroup'), '', () => {
      errorText = '';
      send({ type: 'regroup' });
    }, locked));
    bar.appendChild(button(result ? S('close') : S('cancel'), '', () => post({ type: 'cancel' }), false));
    if (!result) {
      const label = el('label', 'push');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = pushAfter;
      cb.addEventListener('change', () => { pushAfter = cb.checked; });
      label.append(cb, el('span', '', S('pushWhenDone')));
      bar.appendChild(label);
    }
    root.appendChild(bar);
    if (!result) root.appendChild(el('div', 'hint', S('hint')));

    if (focusId) {
      const again = root.querySelector('input[data-msg="' + focusId + '"]');
      if (again) again.focus();
    }
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'plan') {
      const same = model && model.revision === m.revision;
      typed = new Map();
      if (same) {
        for (const g of model.plan.groups) {
          const input = root.querySelector('input[data-msg="' + g.id + '"]');
          if (input && input.value !== g.message) typed.set(g.id, input.value);
        }
      }
      model = m;
      newFiles = new Set(m.newFiles);
      if (!same) result = null;
      busyText = '';
      render();
    } else if (m.type === 'busy') {
      busyText = String(m.text);
      errorText = '';
      render();
    } else if (m.type === 'result') {
      result = m.result;
      busyText = '';
      render();
    } else if (m.type === 'error') {
      errorText = String(m.text);
      busyText = '';
      render();
    }
  });

  post({ type: 'ready' });
})();
