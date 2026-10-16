// The website chat widget: one small script, no dependencies. It draws a chat button and panel inside a shadow
// root (so the site's styles can't break it, and it can't break the site), keeps the conversation in
// sessionStorage, and talks to /public/chat/<key> on the server it was loaded from. Answers are shown as plain
// text with bold and bullets; nothing from the server is inserted as HTML.

export const WIDGET_JS = String.raw`(function () {
  var s = document.currentScript || document.querySelector('script[data-crmagents-key]');
  if (!s) return;
  var key = s.getAttribute('data-crmagents-key');
  var color = s.getAttribute('data-color') || '#533afd';
  var api = new URL(s.src).origin + '/public/chat/' + encodeURIComponent(key);
  var store = 'crmagents-chat-' + key;
  var msgs = [];
  try { msgs = JSON.parse(sessionStorage.getItem(store) || '[]'); } catch (e) { msgs = []; }
  // This conversation's id: a verified email stays verified for it until the tab is closed.
  var sid = null;
  try { sid = sessionStorage.getItem(store + '-sid'); } catch (e) {}
  if (!sid) {
    sid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
    try { sessionStorage.setItem(store + '-sid', sid); } catch (e) {}
  }

  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483000';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>' +
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
    '.btn{width:56px;height:56px;border-radius:50%;border:0;background:' + color + ';color:#fff;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.2);font-size:24px}' +
    '.panel{display:none;position:absolute;right:0;bottom:70px;width:min(370px,calc(100vw - 32px));height:min(540px,calc(100vh - 110px));background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.22);flex-direction:column;overflow:hidden;color:#1a1f36}' +
    '.open .panel{display:flex}.head{padding:14px 16px;background:' + color + ';color:#fff;font-weight:600;display:flex;justify-content:space-between;align-items:center}' +
    '.x{background:none;border:0;color:#fff;font-size:20px;cursor:pointer}.log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:#f7f8fa}' +
    '.m{max-width:85%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}' +
    '.u{align-self:flex-end;background:' + color + ';color:#fff;border-bottom-right-radius:4px}.a{align-self:flex-start;background:#fff;border:1px solid #e3e8ee;border-bottom-left-radius:4px}' +
    '.typing{opacity:.6;font-style:italic}form{display:flex;gap:8px;padding:10px;border-top:1px solid #e3e8ee;background:#fff}' +
    'input{flex:1;border:1px solid #d5dbe1;border-radius:10px;padding:10px 12px;font-size:14px;outline:none}input:focus{border-color:' + color + '}' +
    '.send{border:0;border-radius:10px;padding:0 14px;background:' + color + ';color:#fff;font-weight:600;cursor:pointer}.send:disabled{opacity:.5}' +
    '.foot{font-size:11px;color:#8792a2;text-align:center;padding:0 0 8px;background:#fff}' +
    '</style>' +
    '<div class="wrap"><div class="panel" role="dialog" aria-label="Chat"><div class="head"><span class="title">Chat</span><button class="x" aria-label="Close">×</button></div>' +
    '<div class="log" aria-live="polite"></div><form><input aria-label="Message" placeholder="Type your question" maxlength="2000"><button class="send" type="submit">Send</button></form>' +
    '<div class="foot">AI assistant · answers can contain mistakes</div></div>' +
    '<button class="btn" aria-label="Open chat">💬</button></div>';
  document.body.appendChild(host);

  var wrap = root.querySelector('.wrap'), log = root.querySelector('.log'), form = root.querySelector('form');
  var input = root.querySelector('input'), send = root.querySelector('.send');

  function render(text, cls) {
    var d = document.createElement('div');
    d.className = 'm ' + cls;
    // Bold (**x**) only; everything else as plain text.
    String(text).split(/(\*\*[^*]+\*\*)/).forEach(function (part) {
      if (/^\*\*[^*]+\*\*$/.test(part)) { var b = document.createElement('b'); b.textContent = part.slice(2, -2); d.appendChild(b); }
      else d.appendChild(document.createTextNode(part.replace(/^- /gm, '• ')));
    });
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }
  function save() { try { sessionStorage.setItem(store, JSON.stringify(msgs.slice(-40))); } catch (e) {} }
  function draw() { log.innerHTML = ''; msgs.forEach(function (m) { render(m.text, m.role === 'user' ? 'u' : 'a'); }); }

  var loaded = false;
  function open() {
    wrap.classList.add('open');
    input.focus();
    if (loaded) return;
    loaded = true;
    fetch(api).then(function (r) { return r.json(); }).then(function (c) {
      root.querySelector('.title').textContent = c.name || 'Chat';
      if (!msgs.length && c.greeting) { msgs.push({ role: 'assistant', text: c.greeting }); save(); }
      draw();
    }).catch(function () { render('Chat is not available right now.', 'a'); });
  }
  root.querySelector('.btn').addEventListener('click', function () { wrap.classList.contains('open') ? wrap.classList.remove('open') : open(); });
  root.querySelector('.x').addEventListener('click', function () { wrap.classList.remove('open'); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || send.disabled) return;
    input.value = '';
    msgs.push({ role: 'user', text: text }); save();
    render(text, 'u');
    var t = render('Typing…', 'a typing');
    send.disabled = true;
    fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: msgs.slice(-20), sessionId: sid }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        t.remove();
        var answer = x.ok ? x.j.answer : (x.j.error || 'Sorry, something went wrong.');
        if (x.ok) { msgs.push({ role: 'assistant', text: answer }); save(); }
        render(answer, 'a');
      })
      .catch(function () { t.remove(); render('Sorry, I could not reach the server.', 'a'); })
      .then(function () { send.disabled = false; input.focus(); });
  });
})();`;
