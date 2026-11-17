// John's single page: photos + the job in his own words -> an AI-written post -> edit it -> save it as a Buffer DRAFT.
// Everything goes through the existing API (entries, photos, writing guide, AI draft, save-draft). No new rules live here.
(function () {
  'use strict';
  var h = JNR.h, call = JNR.call;
  var app = document.getElementById('app');
  var me = null, meta = null, guide = null;
  var S = { id: null, own: true, images: [], ack: [] };
  var KEY = 'jnr-post-entry';
  var LABELS = { draft: 'Draft', pending_approval: 'Waiting for a check', approved: 'Approved', rejected: 'Sent back', published: 'Saved to Buffer', failed: 'Not finished' };
  var el = {};

  async function boot() {
    app.textContent = '';
    try { meta = await call('GET', '/auth/me'); me = meta.user; } catch (e) {
      if (e.status === 401) { app.appendChild(JNR.loginForm(boot)); return; }
      app.appendChild(h('p', { class: 'notice bad', text: e.message })); return;
    }
    document.getElementById('who').textContent = me.name + ' (' + me.role + ')';
    var out = document.getElementById('out'); out.classList.remove('hidden');
    out.onclick = async function () { try { sessionStorage.removeItem(KEY); } catch (_) { /* ignore */ } await call('POST', '/auth/logout'); location.reload(); };
    if (me.role === 'workshop') { app.appendChild(h('div', { class: 'card' }, h('h2', { text: 'This page is for John and the office' }), h('p', { text: 'To send an update for John to check, use the workshop form.' }), h('a', { href: '/workshop', text: 'Open the workshop form' }))); return; }
    if (meta.features && meta.features.public_media_is_dev) app.appendChild(h('div', { class: 'notice warn', id: 'dev-media-notice', role: 'note', text: 'Test mode: photos on the website go to a public development address. Use test photographs only.' }));
    try { guide = await call('GET', '/writing-guide'); } catch (e) { guide = null; }
    build();
    loadLists();
    var want = new URLSearchParams(location.search).get('entry') || (function () { try { return sessionStorage.getItem(KEY); } catch (_) { return null; } })();
    if (want) openEntry(want, true);
  }

  // ---------- the page
  function build() {
    var f = meta.features || {};
    var aiOn = !!f.ai_captions, liOn = f.linkedin !== false;
    el.msg = h('div', { id: 'p-msg', 'aria-live': 'polite' });
    el.waiting = h('div', { id: 'p-waiting' });
    el.recent = h('div', { id: 'p-recent' });

    // 1. photos
    el.file = h('input', { type: 'file', id: 'p-file', accept: 'image/jpeg,image/png,image/webp', multiple: true, class: 'visually-hidden' });
    el.file.addEventListener('change', function () { addPhotos(Array.prototype.slice.call(el.file.files)); el.file.value = ''; });
    el.photos = h('div', { id: 'p-photos' });
    el.check = h('input', { type: 'checkbox', id: 'p-check' });
    el.checkRow = h('label', { class: 'check hidden', id: 'p-check-row' }, el.check, h('span', { text: 'I have checked these photos show no drawings, screens or customer details.' }));
    var photoCard = h('div', { class: 'card' }, h('h2', { text: '1. Photos' }),
      h('button', { type: 'button', class: 'ghost', id: 'p-add', text: 'Add photos', onclick: function () { el.file.click(); } }), el.file,
      h('div', { class: 'hint', text: 'Photographs only. No drawings, screens or paperwork in shot.' }), el.photos, el.checkRow);

    // 2. the job
    el.title = h('input', { type: 'text', id: 'p-title', maxlength: '120', autocomplete: 'off', placeholder: 'For example: Brackets for a boat builder' });
    el.notes = h('textarea', { id: 'p-notes', maxlength: '4000', rows: '7', placeholder: 'Talk like you would to a mate: what was made, what it is for, anything tricky or interesting.' });
    var jobCard = h('div', { class: 'card' }, h('h2', { text: '2. The job' }),
      h('label', { for: 'p-title', text: 'Job name (short)' }), el.title,
      h('label', { for: 'p-notes', text: 'Tell us about the job in your own words' }), el.notes,
      h('div', { class: 'hint', text: 'Use the microphone on your phone keyboard if it is easier. Leave out prices and drawing numbers. This is private: it is only used to help write the post.' }));

    // 3. write
    var brands = (guide && guide.guide.brands) || [];
    el.brand = brands.length > 1 ? h('select', { id: 'p-brand', 'aria-label': 'Post as' }, brands.map(function (b) { return h('option', { value: b.id, text: 'Post as ' + b.name }); })) : null;
    var so = guide && guide.guide.sign_off;
    el.sign = so && so.text ? h('input', { type: 'checkbox', id: 'p-sign', checked: so.use_by_default === true }) : null;
    el.instr = h('input', { type: 'text', id: 'p-instr', maxlength: '200', class: 'hidden', placeholder: 'Optional: change it, for example "make it shorter"', 'aria-label': 'Change it' });
    el.ai = h('div', { id: 'p-ai', 'aria-live': 'polite' });
    el.caption = h('textarea', { id: 'p-caption', rows: '9', maxlength: '3000' });
    el.count = h('div', { class: 'cap-count' });
    el.caption.addEventListener('input', function () { el.count.textContent = el.caption.value.length + ' characters'; });
    el.gen = h('button', { type: 'button', class: 'big', id: 'p-gen', text: aiOn ? 'Write my post' : 'Make a post from the template', onclick: aiOn ? generate : template });
    var writeCard = h('div', { class: 'card' }, h('h2', { text: '3. The post' }),
      aiOn ? null : h('div', { class: 'notice warn', id: 'p-ai-off', text: 'AI writing is switched off on this site, so there is a plain template. You can also just type the post yourself.' }),
      h('div', { class: 'row' }, el.brand, el.sign ? h('label', { class: 'check tight' }, el.sign, h('span', { text: 'Add my sign-off' })) : null),
      el.instr, el.gen, el.ai,
      h('label', { for: 'p-caption', text: 'Your post (edit it as much as you like)' }), el.caption, el.count);

    // 4. save
    el.web = h('input', { type: 'checkbox', id: 'p-web' });
    el.save = h('button', { type: 'button', class: 'big', id: 'p-save', text: liOn ? 'Save as LinkedIn draft in Buffer' : 'Buffer is not connected yet', disabled: !liOn, onclick: save });
    el.ack = h('div', { id: 'p-ack' });
    el.result = h('div', { id: 'p-result', 'aria-live': 'polite' });
    var saveCard = h('div', { class: 'card' }, h('h2', { text: '4. Save it' }),
      h('label', { class: 'check' }, el.web, h('span', { text: 'Also put it on our website (the Our Work page). Separate from LinkedIn.' })),
      el.ack, el.save,
      h('div', { class: 'hint', text: 'This only saves a draft in Buffer. Nothing is posted or scheduled: you press Post in Buffer yourself.' }),
      el.result);

    app.appendChild(el.msg);
    app.appendChild(el.waiting);
    app.appendChild(photoCard); app.appendChild(jobCard); app.appendChild(writeCard); app.appendChild(saveCard);
    app.appendChild(el.recent);
    el.count.textContent = '0 characters';
  }

  var say = function (text, kind) { el.msg.textContent = ''; if (text) el.msg.appendChild(h('div', { class: 'notice ' + (kind || 'ok'), role: kind === 'bad' ? 'alert' : 'status', text: text })); if (text) el.msg.scrollIntoView({ block: 'nearest' }); };
  function fail(e) {
    if (e.status === 401) return boot();
    if (e.data && e.data.blocking) return say((e.message || 'This cannot be saved yet.') + ' ' + e.data.blocking.map(function (b) { return b.message; }).join(' '), 'bad');
    if (e.data && e.data.errors) return say(Object.keys(e.data.errors).map(function (k) { return e.data.errors[k]; }).join(' '), 'bad');
    say(e.message || 'Something went wrong.', 'bad');
  }

  // ---------- the entry behind the page (made when the first photo, draft or save needs it)
  async function ensureEntry() {
    if (S.id) return S.id;
    var title = el.title.value.trim().length >= 3 ? el.title.value.trim() : 'LinkedIn post draft';
    var r = await call('POST', '/entries', { kind: 'update', title: title, summary: title, rough_notes: el.notes.value, destinations: { website: false, linkedin: false } }, { 'Idempotency-Key': JNR.uuid() });
    S.id = r.entry.id; S.own = true;
    try { sessionStorage.setItem(KEY, S.id); } catch (_) { /* ignore */ }
    return S.id;
  }
  async function syncFields() {
    var id = await ensureEntry();
    var title = el.title.value.trim();
    var body = { rough_notes: el.notes.value };
    if (title.length >= 3) body.title = title;
    await call('PATCH', '/entries/' + id, body);
  }
  async function refreshImages() {
    var d = await call('GET', '/entries/' + S.id);
    S.images = d.images || [];
    drawPhotos();
  }

  // ---------- photos
  async function addPhotos(files) {
    if (!files.length) return;
    say('');
    try { await ensureEntry(); } catch (e) { return fail(e); }
    for (var i = 0; i < files.length; i++) {
      var row = h('div', { class: 'order' }, h('div', { class: 'f' }, h('div', { text: 'Uploading ' + files[i].name + '…' }), h('div', { class: 'bar-prog' }, h('i'))));
      el.photos.appendChild(row);
      try { await JNR.uploadPhoto(S.id, files[i], function (p) { row.querySelector('i').style.width = Math.round(p * 100) + '%'; }); row.remove(); }
      catch (e) { row.textContent = ''; row.appendChild(h('div', { class: 'f notice bad', role: 'alert', text: files[i].name + ': ' + e.message })); }
    }
    try { await refreshImages(); } catch (e) { fail(e); }
  }
  function drawPhotos() {
    var keep = Array.prototype.slice.call(el.photos.querySelectorAll('.notice.bad')).map(function (n) { return n.parentNode.parentNode; });
    el.photos.textContent = ''; keep.forEach(function (k) { el.photos.appendChild(k); });
    var ids = S.images.map(function (i) { return i.id; });
    S.images.forEach(function (im, idx) {
      var alt = h('input', { type: 'text', value: im.alt_text || '', placeholder: 'What does it show? (optional, helps the post)', maxlength: '300', 'aria-label': 'Description of photo ' + (idx + 1) });
      alt.addEventListener('change', function () { call('PATCH', '/images/' + im.id, { alt_text: alt.value }).catch(fail); });
      var move = function (dir) { return async function () { var o = ids.slice(); var j = idx + dir; var t = o[idx]; o[idx] = o[j]; o[j] = t; try { await call('PUT', '/entries/' + S.id + '/images/order', { order: o }); await refreshImages(); } catch (e) { fail(e); } }; };
      el.photos.appendChild(h('div', { class: 'order' }, h('img', { src: '/api/admin/images/' + im.id + '/preview', alt: im.alt_text || 'Photo ' + (idx + 1), loading: 'lazy' }),
        h('div', { class: 'f' }, alt), h('div', null,
          h('button', { type: 'button', class: 'ghost small', 'aria-label': 'Move photo up', text: '↑', disabled: idx === 0, onclick: move(-1) }),
          h('button', { type: 'button', class: 'ghost small', 'aria-label': 'Move photo down', text: '↓', disabled: idx === ids.length - 1, onclick: move(1) }),
          h('button', { type: 'button', class: 'danger small', text: 'Remove', onclick: async function () { if (confirm('Remove this photo? The original is deleted.')) { try { await call('DELETE', '/images/' + im.id); await refreshImages(); } catch (e) { fail(e); } } } }))));
    });
    el.checkRow.classList.toggle('hidden', !S.images.length);
  }

  // ---------- writing the post
  async function generate() {
    el.ai.textContent = ''; say(''); S.ack = [];
    el.gen.disabled = true; var label = el.gen.textContent; el.gen.textContent = 'Writing…';
    try {
      if (el.title.value.trim().length < 3) { say('Give the job a short name first (at least 3 letters).', 'bad'); return; }
      await syncFields();
      var r = await call('POST', '/entries/' + S.id + '/ai-caption', {
        brand: el.brand ? el.brand.value : undefined, sign_off: el.sign ? el.sign.checked : undefined, instruction: el.instr.value || undefined,
        acknowledge: S.ack.filter(function (a) { return a.box.checked; }).map(function (a) { return a.key; }) });
      S.ack = [];
      var usage = r.usage ? ' You have used ' + r.usage.user_today + ' of ' + r.usage.user_limit + ' AI drafts today.' : '';
      if (r.status === 'ok') {
        el.caption.value = r.caption; el.caption.dispatchEvent(new Event('input')); el.instr.classList.remove('hidden'); label = 'Regenerate';
        el.ai.appendChild(h('div', { class: 'notice ok', role: 'status', text: 'Draft ready below. Read it, change anything you like, then save it.' + usage }));
      } else if (r.status === 'blocked') {
        r.findings.forEach(function (x) { el.ai.appendChild(h('div', { class: 'notice bad', role: 'alert', text: x.message })); });
        el.ai.appendChild(h('div', { class: 'hint', text: 'Nothing was sent to the AI. Fix this above, then try again.' }));
      } else if (r.status === 'needs_acknowledgement') {
        el.ai.appendChild(h('div', { class: 'notice warn', role: 'alert', text: 'Please check before this goes to the AI:' }));
        r.warnings.forEach(function (w) { var box = h('input', { type: 'checkbox' }); S.ack.push({ key: w.key, box: box }); el.ai.appendChild(h('label', { class: 'check' }, box, h('span', { text: w.message + ' I have checked it is OK to share.' }))); });
        el.ai.appendChild(h('div', { class: 'hint', text: 'Tick each one, then press the button again.' }));
      } else if (r.status === 'questions') {
        el.ai.appendChild(h('div', { class: 'notice warn', role: 'status', text: 'There is not quite enough to go on. Add the answers to the job notes above, then try again:' }));
        r.questions.forEach(function (q) { el.ai.appendChild(h('div', { class: 'hint', text: '• ' + q })); });
      } else {
        el.ai.appendChild(h('div', { class: 'notice warn', role: 'alert', text: r.status === 'rejected' ? r.message : r.error }));
        if (r.fallback) el.ai.appendChild(h('button', { type: 'button', class: 'ghost small', text: 'Use the free template instead', onclick: function () { el.caption.value = r.fallback; el.caption.dispatchEvent(new Event('input')); el.ai.textContent = ''; } }));
      }
    } catch (e) {
      if (e.status === 429 || e.status === 403 || e.status === 503) el.ai.appendChild(h('div', { class: 'notice warn', role: 'alert', text: e.message }));
      else fail(e);
    } finally { el.gen.disabled = false; el.gen.textContent = label; }
  }
  async function template() {
    el.ai.textContent = ''; say('');
    try {
      if (el.title.value.trim().length < 3) { say('Give the job a short name first (at least 3 letters).', 'bad'); return; }
      await syncFields();
      var r = await call('POST', '/entries/' + S.id + '/caption', { provider: 'template' });
      el.caption.value = r.caption; el.caption.dispatchEvent(new Event('input'));
      el.ai.appendChild(h('div', { class: 'notice ok', role: 'status', text: 'Template post ready below. Edit it, then save it.' }));
    } catch (e) { fail(e); }
  }

  // ---------- save as a Buffer draft
  async function save() {
    el.result.textContent = ''; el.ack.textContent = ''; say('');
    if (el.title.value.trim().length < 3) return say('Give the job a short name first (at least 3 letters).', 'bad');
    if (!el.caption.value.trim()) return say('Write or generate the post first.', 'bad');
    if (S.images.length && !el.check.checked) return say('Please tick that you have checked the photos.', 'bad');
    el.save.disabled = true; var label = el.save.textContent; el.save.textContent = 'Saving…';
    try {
      await syncFields();
      var r = await call('POST', '/entries/' + S.id + '/save-draft', {
        caption: el.caption.value, website: el.web.checked, clear_photos: el.check.checked, use_caption_as_summary: S.own,
        acknowledge: S.ack.filter(function (a) { return a.box.checked; }).map(function (a) { return a.key; }) });
      S.ack = [];
      var lines = [];
      if (r.status === 'published') {
        lines.push(r.already ? 'This post is already saved in Buffer as a draft.' : 'Saved in Buffer as a draft. Nothing has been posted. Open Buffer and press Post when you are happy with it.');
        if (el.web.checked && !r.already) lines.push('Website: published.');
        el.result.appendChild(h('div', { class: 'notice ok', role: 'status', text: lines.join(' ') }));
        el.result.appendChild(h('button', { type: 'button', class: 'ghost', id: 'p-another', text: 'Start another post', onclick: reset }));
        try { sessionStorage.removeItem(KEY); } catch (_) { /* ignore */ }
        loadLists();
      } else {
        var s = JNR.publishSummary(r);
        el.result.appendChild(h('div', { class: 'notice warn', role: 'alert', text: s.text + ' Nothing was posted. You can press the button again.' }));
        loadLists();
      }
    } catch (e) {
      if (e.data && e.data.error === 'needs_acknowledgement') {
        el.ack.appendChild(h('div', { class: 'notice warn', role: 'alert', text: 'Please check before this is saved:' }));
        (e.data.warnings || []).forEach(function (w) { var box = h('input', { type: 'checkbox' }); S.ack.push({ key: w.code + ':' + w.field, box: box }); el.ack.appendChild(h('label', { class: 'check' }, box, h('span', { text: w.message + ' I have checked it is OK to share.' }))); });
        el.ack.appendChild(h('div', { class: 'hint', text: 'Tick each one, then press Save again.' }));
      } else if (e.data && e.data.error === 'images_not_cleared') say('Please tick that you have checked the photos.', 'bad');
      else fail(e);
    } finally { el.save.disabled = false; el.save.textContent = label; }
  }
  function reset() {
    S = { id: null, own: true, images: [], ack: [] };
    try { sessionStorage.removeItem(KEY); } catch (_) { /* ignore */ }
    el.title.value = ''; el.notes.value = ''; el.caption.value = ''; el.caption.dispatchEvent(new Event('input')); el.web.checked = false; el.check.checked = false; el.instr.value = ''; el.instr.classList.add('hidden');
    el.ai.textContent = ''; el.result.textContent = ''; el.ack.textContent = ''; say(''); drawPhotos(); window.scrollTo(0, 0);
  }

  // ---------- open something already there (a colleague's update, or an unfinished post)
  async function openEntry(id, quiet) {
    try {
      var d = await call('GET', '/entries/' + id); var e = d.entry;
      S = { id: e.id, own: e.created_by === me.id, images: d.images || [], ack: [] };
      try { sessionStorage.setItem(KEY, S.id); } catch (_) { /* ignore */ }
      el.title.value = e.title || ''; el.notes.value = e.rough_notes || ''; el.caption.value = e.caption || ''; el.caption.dispatchEvent(new Event('input'));
      el.web.checked = !!(e.destinations && e.destinations.website); el.check.checked = false; el.ai.textContent = ''; el.result.textContent = ''; el.ack.textContent = '';
      if (e.caption) el.instr.classList.remove('hidden');
      drawPhotos();
      if (!quiet) { say(S.own ? 'Opened your post.' : 'Opened an update from a colleague. Check it, write or edit the post, then save it.', 'ok'); window.scrollTo(0, 0); }
    } catch (er) { if (!quiet) fail(er); else { try { sessionStorage.removeItem(KEY); } catch (_) { /* ignore */ } } }
  }

  // ---------- lists
  function item(e) {
    return h('div', { class: 'card row' }, h('span', { class: 'grow' }, h('strong', { text: e.title }), h('div', { class: 'hint', text: (e.created_by_name ? 'From ' + e.created_by_name + '. ' : '') + (e.image_count || 0) + ' photo' + (e.image_count === 1 ? '' : 's') })),
      h('span', { class: 'pill ' + e.status, text: LABELS[e.status] || e.status }), h('button', { type: 'button', class: 'ghost small', text: 'Open', onclick: function () { openEntry(e.id); } }));
  }
  async function loadLists() {
    try {
      var w = await call('GET', '/entries?status=pending_approval&limit=20');
      var theirs = (w.entries || []).filter(function (e) { return e.created_by !== me.id; });
      el.waiting.textContent = '';
      if (theirs.length) { el.waiting.appendChild(h('div', { class: 'card' }, h('h2', { text: 'Waiting for you' }), h('p', { class: 'hint', text: 'Updates sent by the workshop. Open one, write the post, and save it.' }), theirs.map(item))); }
      var r = await call('GET', '/entries?limit=8');
      el.recent.textContent = '';
      if ((r.entries || []).length) el.recent.appendChild(h('div', { class: 'card' }, h('h2', { text: 'Recent posts' }), r.entries.map(item)));
    } catch (e) { /* the lists are a convenience; the page works without them */ }
  }

  boot();
})();
