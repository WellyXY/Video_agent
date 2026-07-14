// video-agent-studio chat widget — injected into Backlot pages.
// Binds the current Backlot project (/p/<folder>) to a studio project on :4747
// and provides agent chat as a right-side drawer. Self-contained, no deps.
(function () {
  // resolve the studio origin from wherever this script was served (works with any PORT)
  const STUDIO = (document.currentScript && document.currentScript.src)
    ? new URL(document.currentScript.src).origin
    : 'http://localhost:4747';
  const m = location.pathname.match(/^\/p\/(.+)$/);

  // ---------- library page (/): "new project" entry ----------
  if (!m) {
    if (location.pathname !== '/') return;
    const st = document.createElement('style');
    st.textContent = `
      #vas-new{position:fixed;right:22px;bottom:22px;z-index:9000;background:#e8e4da;color:#111;border:none;
        border-radius:26px;padding:14px 22px;font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:14px;
        font-weight:700;cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.5);letter-spacing:.03em}
      #vas-new:hover{transform:scale(1.04)}`;
    document.head.appendChild(st);
    const btn = document.createElement('button');
    btn.id = 'vas-new'; btn.textContent = '＋ 新專案';
    btn.onclick = async () => {
      const name = prompt('專案名稱(英文/數字最穩,會成為工作資料夾名):');
      if (!name || !name.trim()) return;
      try {
        const j = await fetch(`${STUDIO}/api/bind?slug=${encodeURIComponent(name.trim())}`).then(r => r.json());
        location.href = `/p/${encodeURIComponent(j.project.slug)}`;
      } catch {
        alert('studio server (:4747) 未啟動 — cd ~/video-agent-studio && node server.js');
      }
    };
    document.body.appendChild(btn);
    return;
  }

  const OM_SLUG = decodeURIComponent(m[1]).replace(/\/+$/, '');

  // ---------- tiny markdown renderer (escape first, then transform) ----------
  function md(src) {
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const blocks = [];
    src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
      return `\x00${blocks.length - 1}\x00`;
    });
    const inline = s => s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const lines = src.split('\n');
    let out = [], para = [], list = null, table = null;
    const flushP = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
    const flushL = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const flushT = () => {
      if (!table) return;
      let h = '<table>';
      table.forEach((cells, ri) => {
        h += '<tr>' + cells.map(c => `<t${ri === 0 ? 'h' : 'd'}>${inline(c)}</t${ri === 0 ? 'h' : 'd'}>`).join('') + '</tr>';
      });
      out.push(h + '</table>'); table = null;
    };
    for (const raw of lines) {
      const line = esc(raw);
      const t = line.trim();
      let mm;
      if (/^\x00\d+\x00$/.test(t)) { flushP(); flushL(); flushT(); out.push(blocks[+t.slice(1, -1)]); continue; }
      if (/^\|.*\|$/.test(t)) {
        flushP(); flushL();
        if (/^\|[\s:|-]+\|$/.test(t)) continue; // separator row
        (table = table || []).push(t.slice(1, -1).split('|').map(c => c.trim()));
        continue;
      } else flushT();
      if ((mm = t.match(/^(#{1,4})\s+(.*)/))) { flushP(); flushL(); out.push(`<div class="mh mh${mm[1].length}">${inline(mm[2])}</div>`); continue; }
      if (/^(-{3,}|\*{3,})$/.test(t)) { flushP(); flushL(); out.push('<hr>'); continue; }
      if ((mm = t.match(/^[-*•]\s+(.*)/))) { flushP(); if (list !== 'ul') { flushL(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(mm[1])}</li>`); continue; }
      if ((mm = t.match(/^\d+[.)]\s+(.*)/))) { flushP(); if (list !== 'ol') { flushL(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(mm[1])}</li>`); continue; }
      if ((mm = t.match(/^&gt;\s?(.*)/))) { flushP(); flushL(); out.push(`<blockquote>${inline(mm[1])}</blockquote>`); continue; }
      if (t === '') { flushP(); flushL(); continue; }
      para.push(line);
    }
    flushP(); flushL(); flushT();
    return out.join('');
  }

  // ---------- styles (Backlot-flavoured: mono, dark, hairline borders) ----------
  const css = `
  #vas-toggle{position:fixed;right:22px;bottom:22px;z-index:9000;width:52px;height:52px;border-radius:50%;
    background:#e8e4da;color:#111;border:none;cursor:pointer;font-size:22px;box-shadow:0 4px 18px rgba(0,0,0,.5);
    display:flex;align-items:center;justify-content:center;transition:transform .12s}
  #vas-toggle:hover{transform:scale(1.06)}
  #vas-toggle .dot{position:absolute;top:3px;right:3px;width:12px;height:12px;border-radius:50%;background:#e8b33e;
    border:2px solid #111;display:none}
  #vas-drawer{position:fixed;top:0;right:0;bottom:0;width:600px;max-width:96vw;z-index:8999;
    background:#101010;border-left:1px solid #2c2c2c;display:flex;flex-direction:column;
    font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:14.5px;color:#d8d4ca;
    transform:translateX(105%);transition:transform .18s ease}
  #vas-drawer.open{transform:translateX(0)}
  #vas-head{display:flex;align-items:center;gap:10px;padding:15px 18px;border-bottom:1px solid #2c2c2c}
  #vas-head .tt{font-size:11px;letter-spacing:.18em;color:#8a857a}
  #vas-head .nm{font-weight:700;font-size:14.5px;color:#e8e4da;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #vas-state{margin-left:auto;font-size:11px;letter-spacing:.1em;padding:3px 10px;border-radius:3px;border:1px solid #2c2c2c;color:#8a857a}
  #vas-state.busy{color:#e8b33e;border-color:#5c4a1a}
  #vas-close{background:none;border:none;color:#8a857a;font-size:17px;cursor:pointer}
  #vas-msgs{flex:1;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:12px}
  .vas-m{max-width:95%;line-height:1.7;word-break:break-word}
  .vas-m.u{align-self:flex-end;background:#1c2433;border:1px solid #2d3f5c;border-radius:8px 8px 3px 8px;padding:10px 13px;color:#cfe0f5;white-space:pre-wrap;font-size:14px}
  .vas-m.a{align-self:flex-start;background:#181816;border:1px solid #2c2c2c;border-radius:8px 8px 8px 3px;padding:11px 14px;font-size:14.5px}
  .vas-m.t{align-self:flex-start;color:#6f6a60;font-size:11.5px;border-left:2px solid #2c2c2c;padding-left:9px;margin-left:3px}
  .vas-m.r{align-self:center;color:#7fae7f;font-size:11.5px;letter-spacing:.08em}
  .vas-m.e{align-self:stretch;background:#231313;border:1px solid #5c2c28;border-radius:8px;padding:9px 12px;color:#e8a09a;font-size:13px}
  /* markdown inside assistant bubbles */
  .vas-m.a p{margin:0 0 9px} .vas-m.a p:last-child{margin-bottom:0}
  .vas-m.a .mh{font-weight:800;color:#e8e4da;margin:12px 0 7px;letter-spacing:.02em}
  .vas-m.a .mh1{font-size:17px} .vas-m.a .mh2{font-size:16px} .vas-m.a .mh3,.vas-m.a .mh4{font-size:15px}
  .vas-m.a ul,.vas-m.a ol{margin:4px 0 10px;padding-left:22px}
  .vas-m.a li{margin-bottom:4px}
  .vas-m.a code{background:#0a0a0a;border:1px solid #2c2c2c;border-radius:4px;padding:1px 6px;font-size:13px;color:#e8b33e}
  .vas-m.a pre{background:#0a0a0a;border:1px solid #2c2c2c;border-radius:6px;padding:11px 13px;overflow-x:auto;margin:8px 0}
  .vas-m.a pre code{background:none;border:none;padding:0;color:#c9d1b9;font-size:12.5px;line-height:1.6}
  .vas-m.a blockquote{margin:8px 0;padding:5px 12px;border-left:3px solid #4a4a46;color:#a8a396}
  .vas-m.a hr{border:none;border-top:1px solid #2c2c2c;margin:12px 0}
  .vas-m.a a{color:#8ab8ff}
  .vas-m.a table{border-collapse:collapse;margin:9px 0;font-size:13px;width:100%}
  .vas-m.a th,.vas-m.a td{border:1px solid #2c2c2c;padding:5px 9px;text-align:left}
  .vas-m.a th{color:#e8e4da;background:#181816}
  .vas-m.a b{color:#fff}
  #vas-quick{display:flex;gap:8px;padding:0 18px 10px;flex-wrap:wrap}
  #vas-quick button{background:#181816;border:1px solid #2c2c2c;color:#a8a396;border-radius:15px;
    padding:5px 14px;font-size:12.5px;cursor:pointer;font-family:inherit}
  #vas-quick button:hover{color:#e8e4da;border-color:#4a4a46}
  #vas-inputrow{display:flex;gap:9px;padding:13px 16px;border-top:1px solid #2c2c2c}
  #vas-input{flex:1;background:#181816;border:1px solid #2c2c2c;color:#e8e4da;border-radius:7px;
    padding:10px 12px;font-size:14px;font-family:inherit;resize:none;min-height:44px;max-height:140px;outline:none}
  #vas-input:focus{border-color:#4a4a46}
  #vas-send{background:#e8e4da;color:#111;border:none;border-radius:7px;padding:0 18px;font-weight:700;cursor:pointer;font-family:inherit;font-size:14px}
  #vas-send:disabled{opacity:.35;cursor:default}
  #vas-stop{background:none;border:1px solid #5c2c28;color:#e8a09a;border-radius:7px;padding:0 12px;cursor:pointer;font-size:12px;display:none;font-family:inherit}
  #vas-hint{padding:6px 18px 13px;color:#6f6a60;font-size:11px;letter-spacing:.03em}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ---------- DOM ----------
  const toggle = document.createElement('button');
  toggle.id = 'vas-toggle'; toggle.innerHTML = '💬<span class="dot" id="vas-dot"></span>';
  toggle.title = 'Agent chat';
  const drawer = document.createElement('div');
  drawer.id = 'vas-drawer';
  drawer.innerHTML = `
    <div id="vas-head">
      <div><div class="tt">AGENT</div><div class="nm" id="vas-nm">${OM_SLUG}</div></div>
      <span id="vas-state">IDLE</span>
      <button id="vas-close">✕</button>
    </div>
    <div id="vas-msgs"></div>
    <div id="vas-quick">
      <button data-t="✅ 批准,繼續下一步">✅ 批准</button>
      <button data-t="請修改後再給我看一次">🔁 修改</button>
      <button data-t="目前進度如何?列出已完成與待辦">📋 進度</button>
      <button data-t="這個專案目前總花費多少?">💰 成本</button>
    </div>
    <div id="vas-inputrow">
      <textarea id="vas-input" placeholder="指揮 agent…(Shift+Enter 送出,Enter 換行)"></textarea>
      <button id="vas-stop">■</button>
      <button id="vas-send">▶</button>
    </div>
    <div id="vas-hint">studio :4747 · project ${OM_SLUG} · 看板會隨 agent 工作即時更新</div>`;
  document.body.appendChild(toggle);
  document.body.appendChild(drawer);

  const $ = id => document.getElementById(id);
  const msgs = $('vas-msgs');
  let PID = null, BUSY = false, EVCOUNT = 0, OPEN = localStorage.getItem('vas_open') === '1', BOARD_MISSING = false;
  fetch(`/api/project/${encodeURIComponent(OM_SLUG)}/state`).then(r => {
    BOARD_MISSING = !r.ok;
    if (BOARD_MISSING) { setOpen(true); add({ type: 'error', text: '新專案:看板會在 agent 開始製作後出現。先在下方描述你要做的影片。' }); }
  });

  function setOpen(o) {
    OPEN = o; drawer.classList.toggle('open', o);
    localStorage.setItem('vas_open', o ? '1' : '0');
    if (o) { $('vas-dot').style.display = 'none'; $('vas-input').focus(); }
  }
  toggle.onclick = () => setOpen(!OPEN);
  $('vas-close').onclick = () => setOpen(false);
  if (OPEN) setOpen(true);

  function setBusy(b) {
    BUSY = b;
    const s = $('vas-state');
    s.textContent = b ? '● RUNNING' : 'IDLE';
    s.className = b ? 'busy' : '';
    $('vas-send').disabled = b;
    $('vas-stop').style.display = b ? 'block' : 'none';
  }
  let streamEl = null, streamText = '';
  function endStream() { streamEl = null; streamText = ''; }
  function add(ev) {
    if (ev.type === 'delta') {
      if (!streamEl) {
        streamEl = document.createElement('div');
        streamEl.className = 'vas-m a';
        msgs.appendChild(streamEl);
      }
      streamText += ev.text;
      streamEl.innerHTML = md(streamText);
      msgs.scrollTop = msgs.scrollHeight;
      return;
    }
    const d = document.createElement('div');
    if (ev.type === 'user') { d.className = 'vas-m u'; d.textContent = ev.text; }
    else if (ev.type === 'assistant') {
      // finalize the streaming bubble with the authoritative full text
      if (streamEl) { streamEl.innerHTML = md(ev.text); endStream(); if (!OPEN) $('vas-dot').style.display = 'block'; msgs.scrollTop = msgs.scrollHeight; return; }
      d.className = 'vas-m a'; d.innerHTML = md(ev.text); if (!OPEN) $('vas-dot').style.display = 'block';
    }
    else if (ev.type === 'tool') { d.className = 'vas-m t'; d.textContent = '⚙ ' + ev.text; }
    else if (ev.type === 'result') {
      d.className = 'vas-m r'; const extra = ev.cost != null ? ' · $' + Number(ev.cost).toFixed(3) : (ev.tokens ? ` · ${ev.tokens.in}+${ev.tokens.out} tok` : ''); d.textContent = `— ${ev.text || 'done'} (${ev.turns || '?'} turns${extra}) —`;
      // brand-new project: once the agent's first run created the folder, reload so the board appears
      if (BOARD_MISSING) fetch(`/api/project/${encodeURIComponent(OM_SLUG)}/state`).then(r => { if (r.ok) location.reload(); });
    }
    else if (ev.type === 'error') { d.className = 'vas-m e'; d.textContent = ev.text; }
    else if (ev.type === 'status') { if (ev.text !== 'running') endStream(); setBusy(ev.text === 'running'); return; }
    else return;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  }
  function connect() {
    const es = new EventSource(`${STUDIO}/api/projects/${PID}/stream?from=${EVCOUNT}`);
    es.onmessage = e => { const ev = JSON.parse(e.data); if (ev.i != null) EVCOUNT = Math.max(EVCOUNT, ev.i + 1); add(ev); };
    es.onerror = () => { es.close(); setTimeout(connect, 2500); };
  }
  async function send(text) {
    text = (text ?? $('vas-input').value).trim();
    if (!text || BUSY || !PID) return;
    $('vas-input').value = '';
    const r = await fetch(`${STUDIO}/api/projects/${PID}/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); add({ type: 'error', text: j.error || 'send failed' }); }
  }
  $('vas-send').onclick = () => send();
  $('vas-stop').onclick = () => fetch(`${STUDIO}/api/projects/${PID}/interrupt`, { method: 'POST' });
  $('vas-input').addEventListener('keydown', e => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); send(); } });
  $('vas-quick').addEventListener('click', e => { const b = e.target.closest('button'); if (b) send(b.dataset.t); });

  // ---------- bind to studio project ----------
  fetch(`${STUDIO}/api/bind?slug=${encodeURIComponent(OM_SLUG)}`)
    .then(r => r.json())
    .then(j => {
      PID = j.project.id;
      // bind pre-creates the OM project skeleton — if the board 404'd before that, refresh once
      const appEl = document.getElementById('app');
      if (appEl && /project not found/i.test(appEl.textContent || '')) {
        fetch(`/api/project/${encodeURIComponent(OM_SLUG)}/state`).then(r => { if (r.ok) location.reload(); });
      }
      $('vas-nm').textContent = j.project.name;
      if (j.provider) $('vas-hint').textContent = `agent: ${j.provider}${j.model && j.provider==='openai' ? ' · ' + j.model : ''} · project ${OM_SLUG} · 看板會隨 agent 工作即時更新`;
      setBusy(j.busy);
      connect();
    })
    .catch(() => add({ type: 'error', text: 'studio server (:4747) 未啟動 — cd ~/video-agent-studio && node server.js' }));
})();
