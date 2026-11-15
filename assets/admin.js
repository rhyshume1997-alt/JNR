(function () {
  'use strict';
  var h = JNR.h, call = JNR.call;
  var app = document.getElementById('app');
  var me = null, meta = null, state = { status: '', q: '' };
  var STATUS_LABELS = { draft: 'Draft', pending_approval: 'Pending approval', approved: 'Approved', rejected: 'Rejected', published: 'Published', failed: 'Failed' };
  var isEditor = function () { return me.role === 'editor' || me.role === 'admin'; };
  var isAdmin = function () { return me.role === 'admin'; };
  var pill = function (s) { return h('span', { class: 'pill ' + s, text: STATUS_LABELS[s] || s.replace('_', ' ') }); };
  var fmt = function (d) { return d ? new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : ''; };

  async function boot() {
    app.textContent = '';
    try { meta = await call('GET', '/auth/me'); me = meta.user; } catch (e) {
      if (e.status === 401) { app.appendChild(JNR.loginForm(boot)); return; }
      app.appendChild(h('p', { class: 'notice bad', text: e.message })); return;
    }
    document.getElementById('who').textContent = me.name + ' (' + me.role + ')';
    var out = document.getElementById('out'); out.classList.remove('hidden');
    out.onclick = async function () { await call('POST', '/auth/logout'); location.reload(); };
    showList();
  }

  // ---------- list
  async function showList() {
    app.textContent = '';
    var box = h('div'); app.appendChild(box);
    var qs = '?limit=100' + (state.status ? '&status=' + state.status : '') + (state.q ? '&q=' + encodeURIComponent(state.q) : '');
    var data = await call('GET', '/entries' + qs);
    var tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Filter by status' });
    [['', 'All']].concat(Object.keys(STATUS_LABELS).map(function (s) { return [s, STATUS_LABELS[s]]; })).forEach(function (t) {
      var n = t[0] ? data.counts[t[0]] : Object.keys(data.counts).reduce(function (a, k) { return a + data.counts[k]; }, 0);
      tabs.appendChild(h('button', { 'aria-pressed': String(state.status === t[0]), text: t[1] + ' (' + n + ')', onclick: function () { state.status = t[0]; showList(); } }));
    });
    var search = h('input', { type: 'text', value: state.q, placeholder: 'Search title or description', 'aria-label': 'Search', onkeydown: function (e) { if (e.key === 'Enter') { state.q = search.value; showList(); } } });
    var nav = h('div', { class: 'row' }, h('div', { class: 'grow' }, search), isAdmin() ? h('button', { class: 'ghost', text: 'Users', onclick: showUsers }) : null);
    var list = h('div', { class: 'list' });
    if (!data.entries.length) list.appendChild(h('p', { class: 'notice', text: 'Nothing here yet.' }));
    data.entries.forEach(function (e) {
      list.appendChild(h('button', { class: 'item', onclick: function () { showEntry(e.id); } },
        h('span', null, h('strong', { text: e.title }), h('br'), h('small', { text: (meta.kinds.filter(function (k) { return k.id === e.kind; })[0] || {}).label + ' · ' + (e.image_count || 0) + ' photo(s) · ' + fmt(e.updated_at) })),
        h('span', null, pill(e.status), e.is_live ? h('span', { class: 'pill live', text: ' live' }) : null)));
    });
    box.appendChild(nav); box.appendChild(tabs); box.appendChild(list);
  }

  // ---------- one entry
  async function showEntry(id, banner) {
    app.textContent = '';
    var d;
    try { d = await call('GET', '/entries/' + id); } catch (e) { app.appendChild(h('p', { class: 'notice bad', text: e.message })); return; }
    var e = d.entry, imgs = d.images;
    var canEdit = isEditor() || ['draft', 'rejected'].indexOf(e.status) >= 0;
    var msg = h('div', { 'aria-live': 'polite' });
    if (banner) msg.appendChild(h('div', { class: 'notice ' + banner.kind, text: banner.text }));
    var say = function (text, kind) { msg.textContent = ''; msg.appendChild(h('div', { class: 'notice ' + (kind || 'ok'), role: kind === 'bad' ? 'alert' : 'status', text: text })); msg.scrollIntoView({ block: 'nearest' }); };
    var act = async function (fn, okText) { try { await fn(); await showEntry(id, okText ? { kind: 'ok', text: okText } : null); } catch (er) { handleErr(er, say, id); } };

    var f = {};
    function inp(name, label, type, extra) {
      var el = type === 'textarea' ? h('textarea', { id: 'f-' + name, disabled: !canEdit }) : h('input', { type: type || 'text', id: 'f-' + name, disabled: !canEdit });
      el.value = e[name] == null ? '' : e[name]; f[name] = el;
      if (extra && extra.rows) el.style.minHeight = extra.rows + 'px';
      return h('div', null, h('label', { for: 'f-' + name, text: label }), el, extra && extra.hint ? h('div', { class: 'hint', text: extra.hint }) : null);
    }
    var kind = h('select', { id: 'f-kind', disabled: !canEdit }, meta.kinds.map(function (k) { return h('option', { value: k.id, text: k.label, selected: k.id === e.kind }); })); f.kind = kind;
    var stage = h('select', { id: 'f-stage', disabled: !canEdit }, h('option', { value: '', text: 'Not set' }), meta.stages.map(function (s) { return h('option', { value: s.id, text: s.label, selected: s.id === e.stage }); })); f.stage = stage;
    var caseStudy = h('input', { type: 'checkbox', id: 'f-case', checked: e.is_case_study, disabled: !canEdit });
    var destWeb = h('input', { type: 'checkbox', id: 'd-web', checked: e.destinations.website, disabled: !canEdit || !isEditor() });
    var destLi = h('input', { type: 'checkbox', id: 'd-li', checked: e.destinations.linkedin, disabled: !canEdit || !isEditor() });
    var custOk = h('input', { type: 'checkbox', id: 'f-custok', checked: e.customer_public_ok, disabled: !isAdmin() || !canEdit });

    var fields = h('div', { class: 'card' }, h('h3', { text: 'Content' }),
      h('label', { for: 'f-kind', text: 'Type' }), kind, inp('title', 'Job title'), inp('summary', 'Short description', 'textarea'),
      inp('material', 'Material'), inp('process', 'Process'), h('label', { for: 'f-stage', text: 'Production stage' }), stage,
      inp('event_date', 'Date shown', 'date'),
      h('label', { class: 'check' }, caseStudy, h('span', { text: 'Substantial project: give it its own case study page' })),
      inp('body', 'Case study write-up (optional, plain text, blank line between paragraphs)', 'textarea', { rows: 200 }),
      h('h3', { text: 'Private (never published)' }),
      inp('customer_name', 'Customer'), inp('job_ref', 'Job reference'), inp('customer_notes', 'Customer notes', 'textarea'),
      isEditor() ? inp('internal_notes', 'Internal notes', 'textarea') : null,
      isAdmin() ? h('div', null, h('label', { class: 'check' }, custOk, h('span', { text: 'Admin: allow naming this customer publicly' })), inp('customer_public_label', 'Public customer label (what may be shown)')) : null);

    // caption
    var cap = h('textarea', { id: 'f-caption', disabled: !canEdit || !isEditor() }); cap.value = e.caption || '';
    var capCount = h('div', { class: 'cap-count' }); var upd = function () { capCount.textContent = cap.value.length + ' characters'; }; cap.oninput = upd; upd();
    var capBox = h('div', { class: 'card' }, h('h3', { text: 'LinkedIn caption' }),
      h('div', { class: 'hint', text: 'Source: ' + e.caption_source + '. Edit freely. Generated captions only use the job details above.' }), cap, capCount,
      isEditor() && canEdit ? h('div', { class: 'row' },
        h('button', { class: 'ghost small', type: 'button', text: 'Generate caption', onclick: async function () {
          try { await saveFields(true); var r = await call('POST', '/entries/' + id + '/caption', { save: true }); await showEntry(id, { kind: r.note ? 'warn' : 'ok', text: r.note || 'Caption generated from the job details (' + r.source + '). Check it, then edit if you want.' }); } catch (er) { handleErr(er, say, id); } } }),
        meta.features.ai_captions ? h('button', { class: 'ghost small', type: 'button', text: 'Try AI wording', onclick: async function () {
          try { await saveFields(true); var r = await call('POST', '/entries/' + id + '/caption', { save: true, provider: 'ai' }); await showEntry(id, { kind: r.note ? 'warn' : 'ok', text: r.note || 'AI caption saved (' + r.source + ').' }); } catch (er) { handleErr(er, say, id); } } }) : null) : null);

    // photos
    var photoBox = h('div', { class: 'card' }, h('h3', { text: 'Photos (order = order on site and LinkedIn)' }));
    var ids = imgs.map(function (i) { return i.id; });
    imgs.forEach(function (im, idx) {
      var alt = h('input', { type: 'text', value: im.alt_text || '', placeholder: 'Describe the photo', 'aria-label': 'Description of photo ' + (idx + 1), disabled: !canEdit });
      var cleared = h('input', { type: 'checkbox', checked: im.cleared_for_public, disabled: !canEdit });
      var move = function (dir) { return async function () { var j = idx + dir; var o = ids.slice(); var t = o[idx]; o[idx] = o[j]; o[j] = t; await act(function () { return call('PUT', '/entries/' + id + '/images/order', { order: o }); }); }; };
      photoBox.appendChild(h('div', { class: 'order' }, h('img', { src: '/api/admin/images/' + im.id + '/preview', alt: im.alt_text || 'Photo ' + (idx + 1), loading: 'lazy' }),
        h('div', { class: 'f' }, alt, h('label', { class: 'check tight' }, cleared, h('span', { text: 'Checked: no drawings, screens or customer details' }))),
        canEdit ? h('div', null,
          h('button', { class: 'ghost small', 'aria-label': 'Move photo up', text: '↑', disabled: idx === 0, onclick: move(-1) }), h('button', { class: 'ghost small', 'aria-label': 'Move photo down', text: '↓', disabled: idx === imgs.length - 1, onclick: move(1) }),
          h('button', { class: 'danger small', text: 'Remove', onclick: async function () { if (confirm('Remove this photo? The original is deleted.')) await act(function () { return call('DELETE', '/images/' + im.id); }); } })) : null));
      var save = async function () { await act(function () { return call('PATCH', '/images/' + im.id, { alt_text: alt.value, cleared_for_public: cleared.checked }); }); };
      alt.addEventListener('change', save); cleared.addEventListener('change', save);
    });
    if (canEdit) {
      var picker = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, class: 'visually-hidden', id: 'add-photos' });
      picker.addEventListener('change', async function () {
        var list = Array.prototype.slice.call(picker.files); var fails = [];
        for (var i = 0; i < list.length; i++) { say('Uploading ' + (i + 1) + ' of ' + list.length + '…'); try { await JNR.uploadPhoto(id, list[i]); } catch (er) { fails.push(list[i].name + ': ' + er.message); } }
        await showEntry(id, fails.length ? { kind: 'bad', text: fails.join(' | ') } : { kind: 'ok', text: 'Photos added.' });
      });
      photoBox.appendChild(h('div', { class: 'row' }, picker, h('button', { class: 'ghost', type: 'button', text: 'Add photos', onclick: function () { picker.click(); } })));
    }

    // checks (editor)
    var checks = null;
    if (isEditor() && d.checks && ['pending_approval', 'draft', 'rejected'].indexOf(e.status) >= 0) {
      checks = h('div', { class: 'card' }, h('h3', { text: 'Before approval' }));
      var any = false;
      d.checks.blocking.forEach(function (b) { any = true; checks.appendChild(h('p', { class: 'notice bad', text: b.message })); });
      d.checks.warnings.forEach(function (w) { any = true; checks.appendChild(h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-ack': w.code + ':' + w.field }), h('span', { text: w.message + ' Tick to confirm it is fine to publish.' }))); });
      if (d.checks.uncleared_images.length) { any = true; checks.appendChild(h('p', { class: 'notice warn', text: d.checks.uncleared_images.length + ' photo(s) are not marked as checked. They will not be published.' })); }
      if (!any) checks.appendChild(h('p', { class: 'notice ok', text: 'No problems found in the public text.' }));
    }

    async function saveFields(quiet) {
      if (!canEdit) return;
      var body = { version: e.version, kind: kind.value, title: f.title.value, summary: f.summary.value, material: f.material.value, process: f.process.value, stage: stage.value || null, event_date: f.event_date.value || undefined,
        body: f.body.value, is_case_study: caseStudy.checked, customer_name: f.customer_name.value, job_ref: f.job_ref.value, customer_notes: f.customer_notes.value };
      if (isEditor()) { body.internal_notes = f.internal_notes.value; body.destinations = { website: destWeb.checked, linkedin: destLi.checked }; body.caption = cap.value; }
      if (isAdmin()) { body.customer_public_ok = custOk.checked; body.customer_public_label = f.customer_public_label.value; }
      var r = await call('PATCH', '/entries/' + id, body); e = r.entry;
      if (!quiet) await showEntry(id, { kind: 'ok', text: r.changed.length ? 'Saved.' : 'Nothing changed.' });
    }

    var dest = h('div', { class: 'card' }, h('h3', { text: 'Where it goes' }),
      h('label', { class: 'check' }, destWeb, h('span', { text: 'Our Work page and homepage' })),
      h('label', { class: 'check' }, destLi, h('span', { text: 'LinkedIn (saved as a draft in Buffer only; you publish it from Buffer). Environment: ' + meta.features.buffer_env })));

    // actions
    var actions = h('div', { class: 'card' }, h('h3', { text: 'Actions' }), h('div', { class: 'row' }));
    var row = actions.lastChild;
    var btn = function (text, cls, fn) { row.appendChild(h('button', { class: cls || '', type: 'button', text: text, onclick: fn })); };
    if (canEdit) btn('Save changes', '', function () { saveFields().catch(function (er) { handleErr(er, say, id); }); });
    if (canEdit && ['draft', 'rejected'].indexOf(e.status) >= 0) btn('Send for approval', 'ghost', async function () { try { await saveFields(true); await call('POST', '/entries/' + id + '/submit'); await showEntry(id, { kind: 'ok', text: 'Sent for approval.' }); } catch (er) { handleErr(er, say, id); } });
    if (isEditor() && e.status === 'pending_approval') {
      btn('Approve', '', async function () {
        var ack = Array.prototype.map.call(document.querySelectorAll('[data-ack]:checked'), function (c) { return c.getAttribute('data-ack'); });
        try { await call('POST', '/entries/' + id + '/approve', { acknowledge: ack, excludeUncleared: d.checks && d.checks.uncleared_images.length > 0 && confirm('Some photos are not checked and will be left out. Continue?') }); await showEntry(id, { kind: 'ok', text: 'Approved. Public photo copies were prepared. Nothing is public until you publish.' }); } catch (er) { handleErr(er, say, id); }
      });
      btn('Reject', 'danger', async function () { var note = prompt('What needs changing?'); if (note) await act(function () { return call('POST', '/entries/' + id + '/reject', { note: note }); }, 'Rejected.'); });
    }
    if (isEditor() && ['approved', 'failed'].indexOf(e.status) >= 0) btn(e.status === 'failed' ? 'Retry publishing' : 'Publish', '', async function () {
      try { var r = await call('POST', '/entries/' + id + '/publish'); await showEntry(id, { kind: r.status === 'published' ? 'ok' : 'warn', text: r.status === 'published' ? 'Published. LinkedIn: draft saved and verified in Buffer. Nothing was posted.' : 'Some destinations did not finish. See below.' }); } catch (er) { handleErr(er, say, id); }
    });
    if (isAdmin() && e.is_live) btn('Take off the website', 'danger', function () { if (confirm('Remove this from the public site?')) act(function () { return call('POST', '/entries/' + id + '/unpublish'); }, 'Taken off the website.'); });
    btn('Back to list', 'ghost', showList);

    var head = h('div', { class: 'row' }, h('h2', { class: 'grow', text: e.title }), pill(e.status), e.is_live ? h('span', { class: 'pill live', text: 'live' }) : null);
    if (e.review_note && e.status === 'rejected') msg.appendChild(h('div', { class: 'notice bad', text: 'Rejected: ' + e.review_note }));

    // publications
    var pubs = h('div', { class: 'card' }, h('h3', { text: 'Publishing' }));
    (d.publications || []).forEach(function (p) {
      var line = h('div', { class: 'log' }, p.destination + ' ', h('span', { class: 'pill ' + p.status, text: p.status }), ' ' + (p.buffer_post_id ? 'Buffer post ' + p.buffer_post_id + ' ' : '') + (p.last_error ? '— ' + p.last_error : ''));
      pubs.appendChild(line);
      if (p.status === 'uncertain') {
        pubs.appendChild(h('p', { class: 'hint', text: 'Buffer did not confirm. Open Buffer and look for a draft with this caption. Then either link it, or confirm none exists.' }));
        pubs.appendChild(h('button', { class: 'ghost small', text: 'I found the draft', onclick: async function () { var pid = prompt('Paste the Buffer post id'); if (pid) await act(function () { return call('POST', '/publications/' + p.id + '/resolve', { action: 'link', buffer_post_id: pid }); }, 'Linked. Press Retry publishing to verify it.'); } }));
        pubs.appendChild(h('button', { class: 'ghost small', text: 'No draft exists, allow retry', onclick: function () { if (confirm('Only do this if you have checked Buffer and there is no draft.')) act(function () { return call('POST', '/publications/' + p.id + '/resolve', { action: 'retry' }); }, 'Retry allowed.'); } }));
      }
      if (p.buffer_post_id && (p.status === 'failed' || p.status === 'saved')) pubs.appendChild(h('button', { class: 'ghost small', text: 'Discard this Buffer draft link', onclick: function () { if (confirm('Delete the draft in Buffer first, then continue.')) act(function () { return call('POST', '/publications/' + p.id + '/resolve', { action: 'discard' }); }, 'Discarded. A new draft will be made on the next publish.'); } }));
    });
    if (!(d.publications || []).length) pubs.appendChild(h('p', { class: 'hint', text: 'Nothing published yet.' }));

    var logBox = h('div', { class: 'card' }, h('h3', { text: 'History' }));
    call('GET', '/entries/' + id + '/audit').then(function (a) {
      a.audit.forEach(function (x) { logBox.appendChild(h('div', { class: 'log', text: fmt(x.at) + ' · ' + (x.actor_email || 'system') + ' · ' + x.action.replace(/_/g, ' ') + (x.detail && x.detail.fields ? ': ' + x.detail.fields.join(', ') : '') + (x.detail && x.detail.note ? ': ' + x.detail.note : '') })); });
    });

    app.appendChild(head); app.appendChild(msg);
    app.appendChild(h('div', { class: 'cols' }, h('div', null, fields, photoBox, capBox), h('div', null, actions, checks, dest, pubs, logBox)));
  }

  function handleErr(er, say, id) {
    if (er.status === 401) return boot();
    if (er.data && er.data.blocking) return say(er.message + ' ' + er.data.blocking.map(function (b) { return b.message; }).join(' '), 'bad');
    if (er.data && er.data.warnings) return say('Tick the warnings in "Before approval" to confirm them, then approve again.', 'warn');
    if (er.data && er.data.errors) return say(Object.keys(er.data.errors).map(function (k) { return er.data.errors[k]; }).join(' '), 'bad');
    if (er.status === 409 && er.data && er.data.error === 'conflict') { return showEntry(id, { kind: 'warn', text: er.message }); }
    say(er.message, 'bad');
  }

  // ---------- users (admin)
  async function showUsers() {
    app.textContent = '';
    var d = await call('GET', '/users');
    var msg = h('div');
    var name = h('input', { type: 'text', id: 'u-name' }), email = h('input', { type: 'email', id: 'u-email' }), pw = h('input', { type: 'password', id: 'u-pw', autocomplete: 'new-password' });
    var role = h('select', { id: 'u-role' }, ['workshop', 'editor', 'admin'].map(function (r) { return h('option', { value: r, text: r }); }));
    app.appendChild(h('div', { class: 'row' }, h('h2', { class: 'grow', text: 'Users' }), h('button', { class: 'ghost', text: 'Back', onclick: showList })));
    d.users.forEach(function (u) {
      app.appendChild(h('div', { class: 'card row' }, h('span', { class: 'grow' }, h('strong', { text: u.name }), ' ' + u.email + ' · ' + u.role + (u.disabled ? ' · disabled' : '')),
        u.id !== me.id ? h('button', { class: 'ghost small', text: u.disabled ? 'Enable' : 'Disable', onclick: async function () { await call('PATCH', '/users/' + u.id, { disabled: !u.disabled }); showUsers(); } }) : null));
    });
    app.appendChild(h('form', { class: 'card', onsubmit: async function (ev) { ev.preventDefault(); msg.textContent = ''; try { await call('POST', '/users', { name: name.value, email: email.value, role: role.value, password: pw.value }); showUsers(); } catch (er) { msg.appendChild(h('div', { class: 'notice bad', text: er.message })); } } },
      h('h3', { text: 'Add a user' }), h('label', { for: 'u-name', text: 'Name' }), name, h('label', { for: 'u-email', text: 'Email' }), email, h('label', { for: 'u-role', text: 'Role' }), role,
      h('label', { for: 'u-pw', text: 'Temporary password (12+ characters)' }), pw, msg, h('button', { class: 'big', type: 'submit', text: 'Create user' })));
  }

  boot();
})();
