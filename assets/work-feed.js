// Fills the "Recent work" strip on the homepage from /api/feed. If there is nothing approved yet, or the request
// fails, the section stays hidden and the page is unchanged.
(function () {
  'use strict';
  var box = document.getElementById('work-feed');
  if (!box) return;
  fetch('/api/feed', { headers: { accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (!d || !d.items || !d.items.length) return;
    var grid = box.querySelector('.work-grid');
    d.items.forEach(function (it) {
      var card = document.createElement('article'); card.className = 'work-card work-' + it.kind;
      if (it.image) {
        var ph = document.createElement('div'); ph.className = 'work-photo';
        var img = document.createElement('img'); img.src = it.image.url; img.alt = it.image.alt || ''; img.width = it.image.width; img.height = it.image.height; img.loading = 'lazy'; img.decoding = 'async';
        ph.appendChild(img); card.appendChild(ph);
      }
      var body = document.createElement('div'); body.className = 'work-body';
      var meta = document.createElement('div'); meta.className = 'work-meta';
      var pill = document.createElement('span'); pill.className = 'work-pill'; pill.textContent = it.kind_label; meta.appendChild(pill);
      var t = document.createElement('time'); t.setAttribute('datetime', it.date);
      t.textContent = new Date(it.date + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); meta.appendChild(t);
      var h3 = document.createElement('h3'); var a = document.createElement('a'); a.href = it.url; a.textContent = it.title; h3.appendChild(a);
      var p = document.createElement('p'); p.className = 'work-sum'; p.textContent = it.summary;
      body.appendChild(meta); body.appendChild(h3); body.appendChild(p); card.appendChild(body); grid.appendChild(card);
    });
    box.hidden = false;
  }).catch(function () { /* leave hidden */ });
})();
