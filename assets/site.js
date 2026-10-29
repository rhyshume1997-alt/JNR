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

/* ═══ FORM SUBMIT (Formspree) ═══ */
async function submitForm() {
  var content = document.getElementById('formContent');
  var success = document.getElementById('formSuccess');
  var btn = document.querySelector('#formContent .form-submit');
  var btnHTML = btn ? btn.innerHTML : '';

  var status = document.getElementById('formStatus');
  if (status) status.textContent = '';

  // Each required field says what's wrong under it; the first one with a problem gets the focus
  var data = new FormData();
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
    data.append(el.name || 'field', el.value);
  });
  if (firstBad) { firstBad.focus(); return; }

  var emailEl = document.querySelector('#formContent input[name="email"]');
  var companyEl = document.querySelector('#formContent input[name="company"]');
  var urgentEl = document.getElementById('q-urgent');
  var urgent = !!(urgentEl && urgentEl.checked);
  var company = companyEl ? companyEl.value.trim() : '';
  if (emailEl) data.append('_replyto', emailEl.value);
  data.append('urgent', urgent ? 'Yes' : 'No');
  data.append('_subject', (urgent ? 'URGENT: ' : '') + 'Website quote request from ' + (company || 'a new customer'));

  if (btn) { btn.disabled = true; btn.innerHTML = 'Sending...'; }
  try {
    var res = await fetch('https://formspree.io/f/xpqeznvj', {
      method: 'POST',
      body: data,
      headers: { 'Accept': 'application/json' }
    });
    if (res.ok) {
      var mail = document.getElementById('quoteMail');
      if (mail) mail.href = 'mailto:john.hume@jnrengineeringltd.co.uk?subject=' + encodeURIComponent('Drawings for quote request, ' + (company || 'your company name'));
      if (content) content.classList.add('form-hidden');
      if (success) success.classList.add('show');
      var wrap = document.querySelector('.q-form-wrap');
      if (wrap) { var y = wrap.getBoundingClientRect().top + window.scrollY - 110; if (window.lenis) window.lenis.scrollTo(y); else window.scrollTo({ top: y, behavior: 'smooth' }); }
    } else {
      throw new Error('Send failed');
    }
  } catch (err) {
    // Stays on screen with the way round it; nothing typed is lost
    if (btn) { btn.disabled = false; btn.innerHTML = btnHTML; }
    if (status) status.innerHTML = 'Your request didn’t send. Nothing you typed is lost: try again, or email it to <a href="mailto:john.hume@jnrengineeringltd.co.uk">john.hume@jnrengineeringltd.co.uk</a> or phone <a href="tel:01416475913">0141 647 5913</a>.';
  }
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

/* ═══ CALL BAR (phones) ═══ */
// On a breakdown people ring, so phones get a call button that stays on screen. It uses the page's own phone link.
(function(){
  var tel = document.querySelector('footer a[href^="tel:"]');
  if (!tel) return;
  var bar = document.createElement('a');
  bar.className = 'call-bar';
  bar.href = tel.getAttribute('href');
  bar.innerHTML = '<span>Breakdown or urgent job?</span><b>Call the workshop</b>';
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
