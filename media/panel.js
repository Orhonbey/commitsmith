// Webview for the Activity Bar panel. Every string shown comes from the extension (`strings`) or
// from the repository; all of it is rendered as text, never as HTML.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('app');
  let state = null; // last `state` message: { model, strings }

  const post = (m) => vscode.postMessage(m);
  const fmt = (s, ...a) => s.replace(/\{(\d+)\}/g, (_, i) => String(a[Number(i)]));
  const S = (k) => (state && state.strings[k]) || '';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // The skeleton is built once so the message box keeps focus and the caret while the rest re-renders.
  const aiHolder = el('div');
  const repoHolder = el('div');
  const box = el('textarea', 'message');
  box.rows = 3;
  box.spellcheck = false;
  const actionsHolder = el('div');
  const infoHolder = el('div');
  root.append(aiHolder, repoHolder, box, actionsHolder, infoHolder);

  box.addEventListener('input', () => post({ type: 'setMessage', value: box.value }));

  // Skipped while the box has focus, so typing is never overwritten.
  function showMessage(value) {
    if (document.activeElement === box || box.value === value) return;
    box.value = value;
  }

  function aiRow(m) {
    const ai = m.ai;
    const b = el('button', 'ai');
    b.type = 'button';
    let text;
    if (ai.current) text = ai.current;
    else if (ai.problem && ai.problem.kind === 'missing') text = fmt(S('toolMissing'), ai.problem.name);
    else if (ai.problem && ai.problem.kind === 'noModels') text = fmt(S('toolNoModels'), ai.problem.name);
    else text = S('noTool');
    b.title = S('pickTitle') + '\n' + ai.tools.map((t) => t.name + ': ' + (t.found ? S('found') : S('notFound'))).join('\n');
    b.appendChild(el('span', ai.current ? 'ai-main' : 'ai-main warn', '✦ ' + text));
    b.appendChild(el('span', 'ai-caret', '▾'));
    b.addEventListener('click', () => post({ type: 'pickModel' }));
    return b;
  }

  function repoRow(m) {
    if (m.repo.choices.length < 2) return null;
    const sel = el('select', 'repo-select');
    sel.title = S('repository');
    for (const c of m.repo.choices) {
      const o = el('option', '', c.name);
      o.value = c.root;
      o.title = c.root;
      o.selected = c.root === m.repo.selected;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => post({ type: 'selectRepo', root: sel.value }));
    return sel;
  }

  function ahead(p) {
    return p.kind === 'upstream' || p.kind === 'noUpstream' ? p.ahead : 0;
  }

  function actions(m) {
    const s = el('div');
    const pushLabel = ahead(m.push) > 0 ? fmt(S('pushCount'), ahead(m.push)) : S('push');
    const rows = [
      [
        ['writeMessage', '✦ ' + S('writeMessage'), 'aibtn'],
        ['writeAndCommit', '✦ ' + S('writeAndCommit'), 'primary'],
      ],
      [
        ['smartSplit', '⧉ ' + S('smartSplit'), 'aibtn'],
        ['push', '⇡ ' + pushLabel, ''],
      ],
    ];
    for (const row of rows) {
      const grid = el('div', 'grid');
      for (const [id, label, kind] of row) {
        const b = el('button', 'btn ' + kind, label);
        b.type = 'button';
        b.disabled = m.busy;
        b.addEventListener('click', () => post({ type: 'run', action: id }));
        grid.appendChild(b);
      }
      s.appendChild(grid);
    }
    if (m.busy) s.appendChild(el('div', 'note working', S('working')));
    return s;
  }

  function pushParts(p) {
    const parts = [];
    switch (p.kind) {
      case 'noRemote':
        parts.push(S('noRemote'));
        break;
      case 'unborn':
        parts.push(S('unborn'));
        break;
      case 'detached':
        parts.push(S('detached'));
        break;
      case 'noUpstream':
        parts.push(fmt(S('branchNoUpstream'), p.branch));
        break;
      case 'upstream':
        parts.push(fmt(S('branchUpstream'), p.branch, p.upstream));
        break;
      default:
        break;
    }
    if (ahead(p) > 0) parts.push(fmt(S('commitsToPush'), ahead(p)));
    return parts;
  }

  function info(m) {
    const scope = m.scope.active === 'staged' ? fmt(S('lookStaged'), m.scope.staged) : fmt(S('lookAll'), m.scope.all);
    return el('div', 'info', [scope, ...pushParts(m.push)].join(' · '));
  }

  function render() {
    const m = state.model;
    aiHolder.textContent = '';
    repoHolder.textContent = '';
    actionsHolder.textContent = '';
    infoHolder.textContent = '';
    aiHolder.appendChild(aiRow(m));
    if (!m.hasRepo) {
      box.hidden = true;
      infoHolder.appendChild(el('div', 'note', S('noRepo')));
      return;
    }
    box.hidden = false;
    box.placeholder = S('messagePlaceholder');
    const repo = repoRow(m);
    if (repo) repoHolder.appendChild(repo);
    showMessage(m.message);
    actionsHolder.appendChild(actions(m));
    infoHolder.appendChild(info(m));
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'message' && typeof msg.value === 'string') {
      showMessage(msg.value);
      return;
    }
    if (msg.type !== 'state' || !msg.model || !msg.strings) return;
    state = msg;
    render();
  });
  post({ type: 'ready' });
})();
