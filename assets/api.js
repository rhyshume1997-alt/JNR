// Shared by the workshop form and the admin dashboard. No libraries.
(function () {
  'use strict';
  var BASE = '/api/admin';

  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === false || v == null) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    (function add(list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c == null || c === false) continue;
        if (Array.isArray(c)) { add(c); continue; }
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    })(Array.prototype.slice.call(arguments, 2));
    return el;
  }

  async function call(method, path, body, headers) {
    var res;
    try {
      res = await fetch(BASE + path, {
        method: method, credentials: 'same-origin',
        headers: Object.assign({ 'X-Requested-With': 'jnr', 'Content-Type': 'application/json' }, headers || {}),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) { var err = new Error('No connection. Check your signal and try again.'); err.offline = true; throw err; }
    var data = null;
    try { data = await res.json(); } catch (e) { /* not json */ }
    if (!res.ok) { var e2 = new Error((data && data.message) || 'Something went wrong.'); e2.status = res.status; e2.data = data || {}; throw e2; }
    return data;
  }

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // PUT one file straight to storage using the signed link, with progress. Retries up to 3 times.
  function putFile(upload, file, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(upload.method, upload.url);
      Object.keys(upload.headers || {}).forEach(function (k) { xhr.setRequestHeader(k, upload.headers[k]); });
      xhr.upload.onprogress = function (e) { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = function () { xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('The upload was refused (' + xhr.status + ').')); };
      xhr.onerror = function () { reject(new Error('The upload was interrupted.')); };
      xhr.send(file);
    });
  }

  // Full photo flow: ask for a link, upload, ask the server to check it. Retries on poor signal. If it finally fails, the unfinished
  // upload is removed again (best effort; the server also clears abandoned ones), so a failed photo never blocks or counts.
  async function uploadPhoto(entryId, file, onProgress) {
    var lastErr, lastImageId = null, outcomeUnknown = false;
    for (var attempt = 0; attempt < 3; attempt++) {
      var finalizing = false;
      try {
        var p = await call('POST', '/entries/' + entryId + '/images/presign', { name: file.name, type: file.type, size: file.size });
        lastImageId = p.image_id;
        await putFile(p.upload, file, onProgress);
        finalizing = true;
        var f = await call('POST', '/images/' + p.image_id + '/finalize');
        return f.image;
      } catch (e) {
        lastErr = e;
        // No reply to "finalize", or a gateway error from it, means the photo may have been accepted: never remove it then.
        outcomeUnknown = finalizing && (!e.status || e.status >= 500);
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 409 && e.status !== 429) break; // a real "no": do not retry
        if (attempt < 2) await sleep(800 * Math.pow(2, attempt));
      }
    }
    if (lastImageId && !outcomeUnknown) { try { await call('DELETE', '/images/' + lastImageId); } catch (_) { /* the server clears abandoned uploads itself */ } }
    throw lastErr;
  }

  // What the office is told after "Publish": only destinations that were really chosen, each with what actually happened.
  function publishSummary(r) {
    var res = (r && r.results) || [];
    var by = {};
    res.forEach(function (x) { by[x.destination] = x; });
    function line(name, x, verifiedText, notSelectedText) {
      if (!x) return notSelectedText;
      if (x.status === 'verified') return verifiedText;
      if (x.status === 'saved') return name + ': saved in Buffer as a draft, but it could not be checked yet. Look at it in Buffer before relying on it.';
      if (x.status === 'uncertain') return name + ': not sure whether the draft reached Buffer. Check Buffer before trying again.';
      return name + ': did not finish' + (x.error ? ' (' + x.error + ')' : '') + '.';
    }
    var web = line('Website', by.website, 'Website: published.', 'Website: not selected.');
    var li = line('LinkedIn', by.linkedin, 'LinkedIn: draft saved in Buffer and checked. Nothing was posted.', 'LinkedIn: not selected, nothing was sent to Buffer.');
    var ok = r && r.status === 'published';
    return { kind: ok ? 'ok' : 'warn', text: (ok ? 'Published. ' : 'Not everything finished. ') + web + ' ' + li };
  }

  function uuid() { return (crypto.randomUUID ? crypto.randomUUID() : 'k' + Date.now() + Math.random().toString(16).slice(2)); }

  function loginForm(onDone) {
    var msg = h('div', { class: 'err', role: 'alert' });
    var email = h('input', { type: 'email', id: 'li-email', autocomplete: 'username', required: true });
    var pw = h('input', { type: 'password', id: 'li-pw', autocomplete: 'current-password', required: true });
    var btn = h('button', { class: 'big', type: 'submit', text: 'Sign in' });
    var form = h('form', { class: 'login card', novalidate: true, onsubmit: async function (ev) {
      ev.preventDefault(); msg.textContent = ''; btn.disabled = true;
      try { var r = await call('POST', '/auth/login', { email: email.value, password: pw.value }); onDone(r.user); }
      catch (e) { msg.textContent = e.message; } finally { btn.disabled = false; }
    } }, h('h2', { text: 'Sign in' }), h('label', { for: 'li-email', text: 'Email' }), email, h('label', { for: 'li-pw', text: 'Password' }), pw, msg, btn);
    return form;
  }

  window.JNR = { h: h, call: call, uploadPhoto: uploadPhoto, publishSummary: publishSummary, uuid: uuid, loginForm: loginForm, sleep: sleep };
})();
