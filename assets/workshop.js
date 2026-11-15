(function () {
  'use strict';
  var h = JNR.h;
  var app = document.getElementById('app');
  var meta = null;
  var MAX_NOTE = 600;

  async function start() {
    app.textContent = '';
    try { meta = await JNR.call('GET', '/auth/me'); } catch (e) {
      if (e.status === 401) { app.appendChild(JNR.loginForm(start)); return; }
      app.appendChild(h('p', { class: 'notice bad', text: e.message })); return;
    }
    document.getElementById('who').textContent = meta.user.name;
    if (meta.user.role !== 'workshop') document.getElementById('adminlink').classList.remove('hidden');
    renderForm();
  }

  function field(id, label, input, hint) {
    return h('div', null, h('label', { for: id, text: label }), input, hint ? h('div', { class: 'hint', text: hint }) : null, h('div', { class: 'err', id: id + '-err', role: 'alert' }));
  }

  function renderForm() {
    app.textContent = '';
    if (meta.features && meta.features.public_media_is_dev) {
      app.appendChild(h('div', { class: 'notice warn', role: 'note', id: 'dev-media-notice', text: 'Test mode: photos that get approved are copied to a public development address that anyone with the link can open. Use test photographs only, never a real customer\'s part, drawing or paperwork.' }));
    }
    var files = []; // { file, el, bar, state, imageId }
    var entryId = null;
    var key = sessionStorage.getItem('jnr-key') || JNR.uuid();
    sessionStorage.setItem('jnr-key', key);

    var kinds = meta.kinds.map(function (k, i) {
      return [h('input', { type: 'radio', name: 'kind', id: 'k-' + k.id, value: k.id, checked: i === 0 }), h('label', { for: 'k-' + k.id, text: k.label })];
    });
    var title = h('input', { type: 'text', id: 'title', maxlength: '120', autocomplete: 'off', required: true });
    var summary = h('textarea', { id: 'summary', maxlength: String(MAX_NOTE), required: true });
    var count = h('div', { class: 'cap-count', text: '0 / ' + MAX_NOTE });
    summary.addEventListener('input', function () { count.textContent = summary.value.length + ' / ' + MAX_NOTE; });
    var material = h('input', { type: 'text', id: 'material', maxlength: '200', autocomplete: 'off' });
    var process = h('input', { type: 'text', id: 'process', maxlength: '200', autocomplete: 'off' });
    var stage = h('select', { id: 'stage' }, h('option', { value: '', text: 'Not set' }), meta.stages.map(function (s) { return h('option', { value: s.id, text: s.label }); }));
    var stageWrap = field('stage', 'Current production stage', stage);
    function syncStage() { var k = document.querySelector('input[name=kind]:checked').value; stageWrap.classList.toggle('hidden', k !== 'in_production'); }

    var photosBox = h('div', { class: 'photos', 'aria-live': 'polite' });
    var picker = h('input', { type: 'file', id: 'photos', accept: 'image/jpeg,image/png,image/webp', multiple: true, class: 'visually-hidden' });
    var pickBtn = h('button', { type: 'button', class: 'ghost', text: 'Add photos', onclick: function () { picker.click(); } });
    picker.addEventListener('change', function () { addFiles(Array.prototype.slice.call(picker.files)); picker.value = ''; });

    function addFiles(list) {
      list.forEach(function (f) {
        if (files.length >= meta.limits.maxPerEntry) return;
        if (['image/jpeg', 'image/png', 'image/webp'].indexOf(f.type) < 0) { flash('"' + f.name + '" is not a photo. Only JPEG, PNG or WebP. Drawings and CAD files are not allowed here.', 'bad'); return; }
        if (f.size > meta.limits.maxBytes) { flash('"' + f.name + '" is too large.', 'bad'); return; }
        var bar = h('i'); var status = h('span', { text: 'Ready' });
        var el = h('div', { class: 'photo' }, h('img', { alt: '', src: URL.createObjectURL(f) }),
          h('button', { type: 'button', class: 'x', 'aria-label': 'Remove ' + f.name, text: '×', onclick: function () { files = files.filter(function (x) { return x.el !== el; }); el.remove(); } }),
          h('div', { class: 'meta' }, status, h('div', { class: 'bar-prog' }, bar)));
        photosBox.appendChild(el);
        files.push({ file: f, el: el, bar: bar, status: status, state: 'ready' });
      });
    }

    var cust = h('input', { type: 'text', id: 'customer', maxlength: '200', autocomplete: 'off' });
    var jobref = h('input', { type: 'text', id: 'jobref', maxlength: '60', autocomplete: 'off' });
    var notes = h('textarea', { id: 'notes', maxlength: '2000' });
    var review = h('input', { type: 'checkbox', id: 'review', checked: true });
    var msg = h('div', { 'aria-live': 'polite' });
    var send = h('button', { type: 'submit', class: 'big', text: 'Save update' });

    function flash(text, kind) { msg.textContent = ''; msg.appendChild(h('div', { class: 'notice ' + (kind || 'ok'), role: kind === 'bad' ? 'alert' : 'status', text: text })); msg.scrollIntoView({ block: 'nearest' }); }

    var form = h('form', { novalidate: true, onsubmit: async function (ev) {
      ev.preventDefault(); msg.textContent = '';
      ['title', 'summary'].forEach(function (id) { document.getElementById(id + '-err').textContent = ''; });
      send.disabled = true; send.textContent = 'Saving…';
      try {
        if (!entryId) {
          var body = { kind: document.querySelector('input[name=kind]:checked').value, title: title.value, summary: summary.value, material: material.value, process: process.value,
            stage: stage.value || null, customer_name: cust.value, job_ref: jobref.value, customer_notes: notes.value, destinations: { website: true, linkedin: false } };
          var created = await JNR.call('POST', '/entries', body, { 'Idempotency-Key': key });
          entryId = created.entry.id;
        }
        var failed = 0;
        for (var i = 0; i < files.length; i++) {
          var f = files[i];
          if (f.state === 'done') continue;
          f.el.classList.remove('fail'); f.status.textContent = 'Uploading…';
          try {
            await JNR.uploadPhoto(entryId, f.file, function (p) { f.bar.style.width = Math.round(p * 100) + '%'; });
            f.state = 'done'; f.el.classList.add('done'); f.bar.style.width = '100%'; f.status.textContent = 'Uploaded';
          } catch (e) { failed++; f.el.classList.add('fail'); f.status.textContent = e.message; }
        }
        if (failed) { flash('Your update is saved, but ' + failed + ' photo(s) did not upload. Tap "Save update" again to retry just those.', 'warn'); return; }
        if (review.checked) await JNR.call('POST', '/entries/' + entryId + '/submit');
        sessionStorage.removeItem('jnr-key');
        app.textContent = '';
        app.appendChild(h('div', { class: 'card' }, h('h2', { text: 'Saved' }),
          h('p', { text: review.checked ? 'Sent to the office for approval. Nothing goes on the website or LinkedIn until it is approved.' : 'Saved as a draft. Nothing is public.' }),
          h('button', { class: 'big', type: 'button', text: 'Add another update', onclick: renderForm })));
      } catch (e) {
        if (e.data && e.data.errors) { Object.keys(e.data.errors).forEach(function (k) { var n = document.getElementById(k + '-err'); if (n) n.textContent = e.data.errors[k]; }); flash('Please fix the highlighted fields.', 'bad'); }
        else if (e.status === 401) {
          // Signed out part way through (a long job, a lost signal). Keep everything typed and photos chosen; sign in right here.
          msg.textContent = '';
          msg.appendChild(h('div', { class: 'notice warn', role: 'alert', text: 'You were signed out. Sign in again and your update will carry on. Nothing you typed is lost.' }));
          msg.appendChild(JNR.loginForm(function () { msg.textContent = ''; flash('Signed in. Tap "Save update" to carry on.'); }));
        }
        else flash(e.message + (entryId ? ' Your details are saved. Tap "Save update" to carry on.' : ''), 'bad');
      } finally { send.disabled = false; send.textContent = 'Save update'; }
    } },
      h('h3', { text: 'What is it?' }), h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Type of update' }, kinds),
      field('title', 'Job title', title, 'A short name for the part or job. No customer names.'),
      h('div', null, h('label', { for: 'summary', text: 'Short description' }), summary, count, h('div', { class: 'hint', text: 'What it is and what is happening, in plain words. Do not include customer names, drawing numbers or contact details.' }), h('div', { class: 'err', id: 'summary-err', role: 'alert' })),
      field('material', 'Material', material, 'For example: 316 stainless steel'),
      field('process', 'Process', process, 'For example: CNC milling, then fabrication'),
      stageWrap,
      h('h3', { text: 'Photos' }), pickBtn, h('div', { class: 'hint', text: 'Photographs only. No drawings, screens or paperwork in shot.' }), picker, photosBox,
      h('details', null, h('summary', { text: 'Customer and internal details (private, never published)' }),
        field('customer', 'Customer', cust), field('jobref', 'Job reference', jobref), field('notes', 'Private notes', notes)),
      h('label', { class: 'check' }, review, h('span', { text: 'Ready for review. Untick to keep it as a draft.' })),
      msg, send);
    app.appendChild(form);
    app.querySelectorAll('input[name=kind]').forEach(function (r) { r.addEventListener('change', syncStage); });
    syncStage();
  }

  start();
})();
