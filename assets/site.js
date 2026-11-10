/* ═══ NAV SCROLL STATE ═══ */
var nav = document.getElementById('nav');
function navState(){
  if (window.scrollY > 60) nav.classList.add('solid');
  else nav.classList.remove('solid');
}
window.addEventListener('scroll', navState, { passive: true });
navState();

/* ═══ MOBILE MENU ═══ */
function toggleMenu(){
  var menu = document.getElementById('mobileMenu');
  var open = menu.classList.toggle('open');
  menu.inert = !open;
  var burger = document.getElementById('burger');
  burger.classList.toggle('open', open);
  burger.setAttribute('aria-expanded', open ? 'true' : 'false');
  burger.setAttribute('aria-label', open ? 'Close menu' : 'Menu');
  nav.classList.toggle('menu-open', open);
}
// Escape closes the menu
document.addEventListener('keydown', function(e){
  if (e.key === 'Escape' && document.getElementById('mobileMenu').classList.contains('open')) window.toggleMenu();
});

/* ═══ SCROLL REVEAL ═══ */
var obs;
function initReveal(){
  if (obs) obs.disconnect();
  obs = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if (e.isIntersecting){
        e.target.classList.add('in');
        if (e.target.classList.contains('stats')) runCounters(e.target);
        obs.unobserve(e.target);
      }
    });
  }, { threshold: 0.12 });
  document.querySelectorAll('.page.active .rv, .page.active .rv-img').forEach(function(el){
    if (!el.classList.contains('in')) obs.observe(el);
  });
}

/* ═══ COUNTERS ═══ */
function runCounters(scope){
  (scope || document).querySelectorAll('.count').forEach(function(el){
    if (el.dataset.done) return;
    el.dataset.done = '1';
    var target = parseInt(el.dataset.target, 10);
    var dur = 1400, t0 = null;
    function step(ts){
      if (!t0) t0 = ts;
      var p = Math.min((ts - t0) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(eased * target);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
}

/* ═══ QUOTE FORM: drawings and submit ═══ */
var MAX_FILES = 4;
var MAX_BYTES = 4 * 1024 * 1024;
var FILE_EXT = ['pdf', 'dxf', 'dwg', 'step', 'stp', 'iges', 'igs', 'stl', 'jpg', 'jpeg', 'png'];
var chosenFiles = [];

function fmtSize(n){
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// Returns a message if the files can't be sent, or an empty string
function checkFiles(list){
  if (list.length > MAX_FILES) return 'Please send no more than 4 drawings. Remove one and try again.';
  var total = 0;
  for (var i = 0; i < list.length; i++) {
    var ext = (list[i].name.split('.').pop() || '').toLowerCase();
    if (FILE_EXT.indexOf(ext) === -1) return '"' + list[i].name + '" is not a file type we can take. We can take PDF, DXF, DWG, STEP, IGES, STL, JPG and PNG.';
    total += list[i].size;
  }
  if (total > MAX_BYTES) return 'Your drawings are ' + fmtSize(total) + ' in total. The limit is 4 MB, so please email the bigger files instead.';
  return '';
}

function renderFiles(){
  var ul = document.getElementById('fileList');
  var err = document.getElementById('q-files-err');
  if (!ul) return;
  ul.innerHTML = '';
  chosenFiles.forEach(function(f, i){
    var li = document.createElement('li');
    var name = document.createElement('span');
    name.textContent = f.name;
    var size = document.createElement('small');
    size.textContent = fmtSize(f.size);
    name.appendChild(size);
    var rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = 'Remove';
    rm.setAttribute('aria-label', 'Remove ' + f.name);
    rm.addEventListener('click', function(){ chosenFiles.splice(i, 1); renderFiles(); });
    li.appendChild(name);
    li.appendChild(rm);
    ul.appendChild(li);
  });
  if (err) err.textContent = checkFiles(chosenFiles);
}

function addFiles(fileList){
  Array.prototype.forEach.call(fileList, function(f){
    var dupe = chosenFiles.some(function(c){ return c.name === f.name && c.size === f.size; });
    if (!dupe) chosenFiles.push(f);
  });
  renderFiles();
}

(function(){
  var drop = document.getElementById('drawing');
  var input = document.getElementById('q-files');
  var stamp = document.getElementById('q-t');
  if (stamp) stamp.value = String(Date.now());
  if (!drop || !input) return;
  input.addEventListener('change', function(){ addFiles(input.files); input.value = ''; });
  ['dragenter', 'dragover'].forEach(function(ev){
    drop.addEventListener(ev, function(e){ e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function(ev){
    drop.addEventListener(ev, function(e){ e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function(e){ if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
  // Linked from elsewhere with #drawing: bring the box into view
  if (location.hash === '#drawing') setTimeout(function(){ drop.scrollIntoView({ block: 'center' }); }, 300);
  // The server sends people back here if the form was submitted without JavaScript and failed
  if (/[?&]sent=error/.test(location.search)) {
    var st = document.getElementById('formStatus');
    if (st) st.innerHTML = 'Your request didn’t send. Please try again, or email it to <a href="mailto:john.hume@jnrengineeringltd.co.uk">john.hume@jnrengineeringltd.co.uk</a> or phone <a href="tel:01416475913">0141 647 5913</a>.';
  }
})();

function resetCheck(){ setCheckStatus('', ''); if (window.turnstile) { try { window.turnstile.reset(); } catch (e) { /* ignore */ } } }

// Our own line under the Cloudflare box, so people can see the security check has passed
function setCheckStatus(state, text){
  var el = document.getElementById('tsStatus');
  if (!el) return;
  el.className = 'ts-status' + (state ? ' is-' + state : '');
  el.textContent = text;
}
function turnstileOk(){ setCheckStatus('ok', 'Security check passed. You can send your request.'); }
function turnstileExpired(){ setCheckStatus('warn', 'The security check timed out. Please tick the box again.'); }
function turnstileError(){ setCheckStatus('warn', 'The security check didn’t load. Refresh the page, or email john.hume@jnrengineeringltd.co.uk or phone 0141 647 5913.'); }

// The Cloudflare box is 300px wide. On narrow phones there isn't room, so use its compact size instead.
// Runs before Cloudflare's script, which loads after this file.
(function(){
  var box = document.querySelector('.cf-turnstile');
  if (box && !box.getAttribute('data-size') && box.getBoundingClientRect().width < 300) box.setAttribute('data-size', 'compact');
})();

async function submitForm() {
  var form = document.getElementById('formContent');
  var btn = document.querySelector('#formContent .form-submit');
  var btnHTML = btn ? btn.innerHTML : '';
  var status = document.getElementById('formStatus');
  if (status) status.textContent = '';

  // Each required field says what's wrong under it; the first one with a problem gets the focus
  var inputs = document.querySelectorAll('#formContent .form-input');
  var firstBad = null;
  inputs.forEach(function(el){
    var err = document.getElementById(el.id + '-err');
    var value = el.value.trim();
    var msg = '';
    if (el.hasAttribute('required') && !value) msg = 'Please fill this in.';
    else if (el.type === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) msg = 'That email address doesn’t look right.';
    el.classList.toggle('is-bad', !!msg);
    el.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (err) err.textContent = msg;
    if (msg && !firstBad) firstBad = el;
  });
  var fileMsg = checkFiles(chosenFiles);
  var fileErr = document.getElementById('q-files-err');
  if (fileErr) fileErr.textContent = fileMsg;
  if (firstBad) { firstBad.focus(); return; }
  if (fileMsg) { var drop = document.getElementById('drawing'); if (drop) drop.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }

  var data = new FormData(form);
  // Don't send until the security check has finished, the server would only turn it away
  if (window.turnstile && !String(data.get('cf-turnstile-response') || '')) {
    setCheckStatus('warn', 'Please wait for the security check to finish, or tick the box, then send it again.');
    var ts = document.querySelector('.cf-turnstile'); if (ts && ts.scrollIntoView) ts.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  data.delete('drawings');
  chosenFiles.forEach(function(f){ data.append('drawings', f, f.name); });
  var urgentEl = document.getElementById('q-urgent');
  data.set('urgent', urgentEl && urgentEl.checked ? 'Yes' : 'No');

  if (btn) { btn.disabled = true; btn.innerHTML = 'Sending...'; }
  try {
    var res = await fetch('/api/quote', { method: 'POST', body: data, headers: { 'Accept': 'application/json' } });
    var json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    if (res.ok && json && json.ok) {
      window.location.href = '/thanks';
      return;
    }
    // The server says what was wrong where it can
    if (json && json.errors) {
      var map = { full_name: 'q-name', company: 'q-company', phone: 'q-phone', email: 'q-email', required_by: 'q-required-by', drawings: 'q-files' };
      var first = null;
      Object.keys(json.errors).forEach(function(k){
        var id = map[k];
        var span = id && document.getElementById(id + '-err');
        if (span) span.textContent = json.errors[k];
        var field = id && document.getElementById(id);
        if (field && field.classList) field.classList.add('is-bad');
        if (field && !first) first = field;
      });
      if (btn) { btn.disabled = false; btn.innerHTML = btnHTML; }
      if (first && first.focus) first.focus();
      if (status) status.textContent = json.error || 'Some details need another look.';
      resetCheck();
      return;
    }
    if (btn) { btn.disabled = false; btn.innerHTML = btnHTML; }
    resetCheck();
    showSendError(json && json.error);
  } catch (err) {
    // Stays on screen with the way round it; nothing typed is lost
    if (btn) { btn.disabled = false; btn.innerHTML = btnHTML; }
    resetCheck();
    showSendError('');
  }
}

// One message, said once: what went wrong (the server's words if it gave any), then the way round it
function showSendError(serverMessage){
  var status = document.getElementById('formStatus');
  if (!status) return;
  var lead = serverMessage ? String(serverMessage) : 'Your request didn’t send.';
  var safe = lead.replace(/[&<>"]/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  status.innerHTML = safe + ' Nothing you typed is lost: try again, or email <a href="mailto:john.hume@jnrengineeringltd.co.uk">john.hume@jnrengineeringltd.co.uk</a> or phone <a href="tel:01416475913">0141 647 5913</a>.';
}

// A field's message clears as soon as it's fixed
document.querySelectorAll('#formContent .form-input').forEach(function(el){
  el.addEventListener('input', function(){
    if (!el.classList.contains('is-bad') || !el.value.trim()) return;
    el.classList.remove('is-bad');
    el.setAttribute('aria-invalid', 'false');
    var err = document.getElementById(el.id + '-err');
    if (err) err.textContent = '';
  });
});

/* ═══ CALL AND QUOTE BAR (phones) ═══ */
// On a breakdown people ring, and everyone else wants to send a drawing, so phones get both buttons staying on screen.
(function(){
  var tel = document.querySelector('footer a[href^="tel:"]');
  if (!tel) return;
  var onQuote = !!document.getElementById('page-quote') || !!document.getElementById('page-thanks');
  var bar = document.createElement('div');
  bar.className = 'call-bar' + (onQuote ? ' call-only' : '');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Call or send a drawing');
  bar.innerHTML = '<a class="call-bar-call" href="' + tel.getAttribute('href') + '"><span>Breakdown or urgent?</span><b>Call us</b></a>' +
    (onQuote ? '' : '<a class="call-bar-quote" href="/quote#drawing"><span>Got a drawing?</span><b>Send it for a quote</b></a>');
  document.body.appendChild(bar);
})();

// The closed menu is out of reach for keyboards and screen readers
var mobileMenu = document.getElementById('mobileMenu');
if (mobileMenu) mobileMenu.inert = !mobileMenu.classList.contains('open');

/* ═══ INIT ═══ */
if (!('IntersectionObserver' in window)) {
  document.querySelectorAll('.rv, .rv-img').forEach(function(el){ el.classList.add('in'); });
} else { initReveal(); }
setTimeout(function(){ document.querySelectorAll('.page.active .rv, .page.active .rv-img').forEach(function(el){ el.classList.add('in'); }); }, 2500);

/* ═══ MOTION: Lenis smooth scroll + GSAP ═══ */
(function(){
  if (!window.gsap || !window.ScrollTrigger) return;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = window.matchMedia('(pointer: fine)').matches;
  gsap.registerPlugin(ScrollTrigger);

  // Smooth scroll (desktop wheel only, touch stays native)
  if (!reduce && window.Lenis) {
    var lenis = new Lenis({ lerp: 0.09, wheelMultiplier: 0.95 });
    window.lenis = lenis;
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add(function(t){ lenis.raf(t * 1000); });
    gsap.ticker.lagSmoothing(0);
    var _toggle = window.toggleMenu;
    window.toggleMenu = function(){
      _toggle();
      if (document.getElementById('mobileMenu').classList.contains('open')) lenis.stop(); else lenis.start();
    };
  }

  // Magnetic buttons
  if (fine && !reduce) {
    document.querySelectorAll('.magnetic').forEach(function(b){
      var xTo = gsap.quickTo(b, 'x', { duration: 0.6, ease: 'power3' });
      var yTo = gsap.quickTo(b, 'y', { duration: 0.6, ease: 'power3' });
      b.addEventListener('mousemove', function(e){
        var r = b.getBoundingClientRect();
        xTo((e.clientX - r.left - r.width / 2) * 0.22);
        yTo((e.clientY - r.top - r.height / 2) * 0.35);
      });
      b.addEventListener('mouseleave', function(){ xTo(0); yTo(0); });
    });
  }

  if (reduce) { document.querySelectorAll('.proc-step').forEach(function(el){ el.classList.add('on'); }); return; }

  // Ticker: steady drift, speeds up with scroll and follows scroll direction
  var track = document.querySelector('.ticker-track');
  if (track) {
    track.style.animation = 'none';
    var tx = 0, dir = -1, boost = 0, base = 0.55, slow = 1;
    gsap.ticker.add(function(){
      var half = track.scrollWidth / 2;
      if (!half) return;
      tx += (base * slow + boost) * dir;
      if (tx <= -half) tx += half;
      if (tx > 0) tx -= half;
      gsap.set(track, { x: tx });
      boost *= 0.93;
    });
    ScrollTrigger.create({ onUpdate: function(self){
      boost = Math.min(Math.abs(self.getVelocity()) / 260, 9);
      dir = self.direction === 1 ? -1 : 1;
    }});
    var tk = track.parentNode;
    tk.addEventListener('mouseenter', function(){ gsap.to({v: slow}, { v: 0.25, duration: 0.6, onUpdate: function(){ slow = this.targets()[0].v; } }); });
    tk.addEventListener('mouseleave', function(){ gsap.to({v: slow}, { v: 1, duration: 0.6, onUpdate: function(){ slow = this.targets()[0].v; } }); });
  }

  // Hero headline builds in letter by letter
  var hl = document.querySelectorAll('.hero h1 .line > span');
  if (hl.length && window.SplitText) {
    gsap.registerPlugin(SplitText);
    document.documentElement.classList.add('split-on');
    document.fonts.ready.then(function(){
      var tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
      tl.from('.hero .hero-bg', { opacity: 0, duration: 1.8, ease: 'power2.out' }, 0);
      hl.forEach(function(ln, i){
        var sp = new SplitText(ln, { type: 'words,chars' });
        tl.from(sp.chars, { yPercent: 115, duration: 1.15, stagger: 0.02 }, 0.25 + i * 0.18);
      });
    });
  }

  // Hero content drifts up and fades as you scroll away
  var hc = document.querySelector('.hero-content, .page-hero-content');
  var hero = document.querySelector('.hero, .page-hero');
  if (hc && hero) {
    gsap.to(hc, { yPercent: -12, opacity: 0.15, ease: 'none',
      scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: true } });
  }

  // How quoting works: steps light up one by one
  var proc = document.getElementById('process');
  if (proc) {
    var steps = proc.querySelectorAll('.proc-step');
    var bar = proc.querySelector('.proc-bar span');
    var mm = gsap.matchMedia();
    mm.add('(min-width: 1101px)', function(){
      // Pinned: the section holds still while the steps slide across
      var grid = proc.querySelector('.proc-grid');
      var inner = proc.querySelector('.section-inner');
      proc.classList.add('proc-pinned');
      var dist = function(){ return Math.max(0, grid.scrollWidth - inner.clientWidth); };
      var tw = gsap.to(grid, {
        x: function(){ return -dist(); }, ease: 'none',
        scrollTrigger: {
          trigger: proc, start: 'top top', end: function(){ return '+=' + (dist() + 500); },
          pin: true, scrub: 0.8, invalidateOnRefresh: true,
          onUpdate: function(self){
            var p = self.progress;
            gsap.set(bar, { scaleX: p });
            steps.forEach(function(s, i){ s.classList.toggle('on', p >= i / steps.length + 0.02); });
          }
        }
      });
      return function(){ tw.scrollTrigger.kill(); tw.kill(); gsap.set(grid, { x: 0 }); proc.classList.remove('proc-pinned'); steps.forEach(function(s){ s.classList.remove('on'); }); };
    });
    mm.add('(max-width: 1100px)', function(){
      var sts = [];
      steps.forEach(function(s){
        sts.push(ScrollTrigger.create({ trigger: s, start: 'top 70%', onEnter: function(){ s.classList.add('on'); }, onLeaveBack: function(){ s.classList.remove('on'); } }));
      });
      return function(){ sts.forEach(function(t){ t.kill(); }); };
    });
  }

  window.addEventListener('load', function(){ ScrollTrigger.refresh(); });
})();
