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
  document.getElementById('mobileMenu').classList.toggle('open');
  document.getElementById('burger').classList.toggle('open');
}

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

  var data = new FormData();
  var inputs = document.querySelectorAll('#formContent .form-input');
  var missingRequired = false;
  inputs.forEach(function(el){
    if (el.hasAttribute('required') && !el.value.trim()) {
      missingRequired = true;
      el.style.borderColor = '#d33';
    } else {
      el.style.borderColor = '';
    }
    data.append(el.name || 'field', el.value);
  });
  if (missingRequired) {
    if (btn) {
      var old = btn.innerHTML;
      btn.innerHTML = 'Please fill in the required fields';
      setTimeout(function(){ btn.innerHTML = old; }, 2500);
    }
    return;
  }

  var emailEl = document.querySelector('#formContent input[name="email"]');
  var companyEl = document.querySelector('#formContent input[name="company"]');
  var company = companyEl ? companyEl.value.trim() : '';
  if (emailEl) data.append('_replyto', emailEl.value);
  data.append('_subject', 'Website quote request from ' + (company || 'a new customer'));

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
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = 'Could not send. Please email us directly.';
      setTimeout(function(){
        btn.innerHTML = btnHTML;
      }, 4000);
    }
  }
}

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
      var st = ScrollTrigger.create({
        trigger: proc.querySelector('.proc-grid'),
        start: 'top 62%', end: '+=520', scrub: 0.6,
        onUpdate: function(self){
          var p = self.progress;
          gsap.set(bar, { scaleX: p });
          steps.forEach(function(s, i){ s.classList.toggle('on', p >= (i + 0.5) / steps.length || (i === 0 && p > 0.02)); });
        }
      });
      return function(){ st.kill(); steps.forEach(function(s){ s.classList.remove('on'); }); };
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
