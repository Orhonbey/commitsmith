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

  function section(title) {
    const s = el('section', 'sec');
    if (title) s.appendChild(el('h2', 'sec-title', title));
    return s;
  }

  function aiRow(m) {
    const ai = m.ai;
    const b = el('button', 'ai');
    b.type = 'button';
    b.title = S('pickTitle');
    let text;
    if (ai.current) text = ai.current;
    else if (ai.problem && ai.problem.kind === 'missing') text = fmt(S('toolMissing'), ai.problem.name);
    else if (ai.problem && ai.problem.kind === 'noModels') text = fmt(S('toolNoModels'), ai.problem.name);
    else text = S('noTool');
    b.appendChild(el('span', ai.current ? 'ai-main' : 'ai-main warn', '✦ ' + text));
    const found = el('span', 'ai-found');
    for (const t of ai.tools) {
      found.appendChild(el('span', 'tool ' + (t.found ? 'yes' : 'no'), t.name + ': ' + (t.found ? S('found') : S('notFound'))));
    }
    b.appendChild(found);
    b.addEventListener('click', () => post({ type: 'pickModel' }));
    return b;
  }

  function repoRow(m) {
    const s = section(S('repository'));
    if (m.repo.choices.length > 1) {
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
      s.appendChild(sel);
    } else {
      s.appendChild(el('div', 'repo-name', m.repo.name));
    }
    return s;
  }

  function scopeRow(m) {
    const s = section(S('scopeTitle'));
    const chips = el('div', 'chips');
    chips.appendChild(el('span', 'chip' + (m.scope.active === 'staged' ? ' active' : ''), fmt(S('staged'), m.scope.staged)));
    chips.appendChild(el('span', 'chip' + (m.scope.active === 'all' ? ' active' : ''), fmt(S('all'), m.scope.all)));
    s.appendChild(chips);
    if (m.scope.leftOut > 0) s.appendChild(el('div', 'note', fmt(S('leftOut'), m.scope.leftOut)));
    return s;
  }

  function actions(m) {
    const s = section('');
    const grid = el('div', 'grid');
    const defs = [
      ['writeMessage', '✦ ' + S('writeMessage'), false],
      ['writeAndCommit', '✦ ' + S('writeAndCommit'), true],
      ['smartSplit', '⧉ ' + S('smartSplit'), false],
      ['push', '⇡ ' + S('push'), false],
    ];
    for (const [id, label, primary] of defs) {
      const b = el('button', 'btn' + (primary ? ' primary' : ''), label);
      b.type = 'button';
      b.disabled = m.busy;
      b.addEventListener('click', () => post({ type: 'run', action: id }));
      grid.appendChild(b);
    }
    s.appendChild(grid);
    if (m.busy) s.appendChild(el('div', 'note working', S('working')));
    return s;
  }

  function pushText(p) {
    switch (p.kind) {
      case 'noRemote':
        return S('noRemote');
      case 'unborn':
        return S('unborn');
      case 'detached':
        return S('detached');
      case 'noUpstream':
        return fmt(S('pushNoUpstream'), p.ahead);
      case 'upstream':
        return fmt(S('pushUpstream'), p.upstream, p.ahead);
      default:
        return '';
    }
  }

  function pushRow(m) {
    const text = pushText(m.push);
    return text ? el('div', 'push-line', (m.push.kind === 'upstream' || m.push.kind === 'noUpstream' ? '→ ' : '') + text) : el('div');
  }

  function recentText(e) {
    if (e.kind === 'committed') return fmt(S('recentCommitted'), e.sha, e.subject);
    if (e.kind === 'pushed') return fmt(S('recentPushed'), e.branch);
    return e.text;
  }

  function recentRow(m) {
    const s = section(S('recent'));
    if (m.recent.length === 0) {
      s.appendChild(el('div', 'note', S('nothingYet')));
      return s;
    }
    const list = el('ul', 'recent');
    for (const e of m.recent) {
      const li = el('li', 'recent-item ' + e.kind);
      li.appendChild(el('span', 'recent-icon', e.kind === 'failed' ? '✕' : e.kind === 'pushed' ? '⇡' : '✓'));
      li.appendChild(el('span', 'recent-text', recentText(e)));
      list.appendChild(li);
    }
    s.appendChild(list);
    return s;
  }

  function render() {
    root.textContent = '';
    if (!state) return;
    const m = state.model;
    root.appendChild(aiRow(m));
    if (!m.hasRepo) {
      root.appendChild(el('div', 'note', S('noRepo')));
      return;
    }
    root.appendChild(repoRow(m));
    root.appendChild(scopeRow(m));
    root.appendChild(actions(m));
    root.appendChild(pushRow(m));
    root.appendChild(recentRow(m));
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'state' || !msg.model || !msg.strings) return;
    state = msg;
    render();
  });
  post({ type: 'ready' });
})();
