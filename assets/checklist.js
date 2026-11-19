/* "What to send with your quote": pick the kind of job and the list changes.
   Every list is in the page already, so without this file you see all of them. */
(function () {
  var box = document.getElementById('send');
  if (!box) return;
  var radios = [].slice.call(box.querySelectorAll('input[name="kind"]'));
  var lists = [].slice.call(box.querySelectorAll('.clist'));
  var title = document.getElementById('send-title');
  var count = document.getElementById('send-count');
  var bar = box.querySelector('.bar');

  function update() {
    var shown = lists.filter(function (l) { return !l.hidden; });
    var boxes = [];
    shown.forEach(function (l) { boxes = boxes.concat([].slice.call(l.querySelectorAll('input[type="checkbox"]'))); });
    var done = boxes.filter(function (b) { return b.checked; }).length;
    count.textContent = done + ' of ' + boxes.length + ' ready';
    if (bar) bar.style.setProperty('--p', boxes.length ? done / boxes.length : 0);
  }

  function show() {
    var kind = (radios.filter(function (r) { return r.checked; })[0] || radios[0]).value;
    var label = box.querySelector('input[value="' + kind + '"] + span').textContent.trim();
    lists.forEach(function (l) {
      var k = l.getAttribute('data-kind');
      l.hidden = !(k === 'common' || k === kind);
    });
    title.textContent = kind === 'any' ? 'Have these ready' : 'Have these ready for ' + label.toLowerCase();
    update();
  }

  radios.forEach(function (r) { r.addEventListener('change', show); });
  box.addEventListener('change', function (e) { if (e.target.type === 'checkbox') update(); });
  show();
})();
