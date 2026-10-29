/* JNR Engineering - site behaviour. No smooth-scroll hijack, no magnetic buttons. */
(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* nav goes solid once you leave the top */
  var nav = document.getElementById('nav');
  function navState() { if (nav) nav.classList.toggle('solid', window.scrollY > 40 || document.body.classList.contains('menu-open')); }
  window.addEventListener('scroll', navState, { passive: true });
  navState();

  /* mobile menu: button state, Escape to close, focus handling */
  var burger = document.getElementById('burger');
  var menu = document.getElementById('mobileMenu');
  function setMenu(open) {
    if (!burger || !menu) return;
    menu.classList.toggle('open', open);
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    document.body.classList.toggle('menu-open', open);
    navState();
    if (open) { var first = menu.querySelector('a'); if (first) first.focus(); }
  }
  if (burger) burger.addEventListener('click', function () { setMenu(burger.getAttribute('aria-expanded') !== 'true'); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && menu && menu.classList.contains('open')) { setMenu(false); burger.focus(); }
  });
  if (menu) menu.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
  window.addEventListener('resize', function () { if (window.innerWidth > 860 && menu && menu.classList.contains('open')) setMenu(false); });

  /* one quiet reveal; everything is visible without JS or with reduced motion */
  var rv = document.querySelectorAll('.rv');
  if (reduce || !('IntersectionObserver' in window)) {
    rv.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    rv.forEach(function (el) { io.observe(el); });
    setTimeout(function () { rv.forEach(function (el) { el.classList.add('in'); }); }, 3000);
  }

  /* how quoting works: steps mark themselves as you reach them (order matters, so it is shown) */
  var steps = document.querySelectorAll('.steps li');
  if (steps.length) {
    if (reduce || !('IntersectionObserver' in window)) steps.forEach(function (s) { s.classList.add('on'); });
    else {
      var so = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('on'); so.unobserve(e.target); } });
      }, { threshold: 0.6 });
      steps.forEach(function (s) { so.observe(s); });
    }
  }

  /* hero headline builds in letter by letter (kept from the previous version) */
  var lines = document.querySelectorAll('.hero h1 .line > span');
  if (lines.length && !reduce && window.gsap && window.SplitText) {
    gsap.registerPlugin(SplitText);
    var run = function () {
      var tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
      lines.forEach(function (ln, i) {
        var sp = new SplitText(ln, { type: 'words,chars' });
        tl.from(sp.chars, { yPercent: 110, duration: 1.1, stagger: 0.018 }, 0.1 + i * 0.16);
      });
    };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(run); else run();
  }
})();

/* ═══ QUOTE FORM ═══
   Sends to Formspree (same endpoint as before). The site's Formspree setup doesn't take file uploads,
   so drawings still go by email; the success screen opens a pre-addressed email for that. */
(function () {
  var form = document.getElementById('quoteForm');
  if (!form) return;
  var content = document.getElementById('formContent');
  var success = document.getElementById('formSuccess');
  var status = document.getElementById('formStatus');
  var btn = form.querySelector('[type=submit]');
  var btnText = btn ? btn.innerHTML : '';
  var checked = form.querySelectorAll('input[required], input[type=email], input[type=tel]');

  function fieldError(el, msg) {
    var err = document.getElementById(el.id + '-err');
    if (msg) { el.setAttribute('aria-invalid', 'true'); if (err) err.textContent = msg; }
    else { el.removeAttribute('aria-invalid'); if (err) err.textContent = ''; }
  }
  function check(el) {
    var v = el.value.trim();
    if (el.required && !v) { fieldError(el, 'Please fill this in.'); return false; }
    if (el.type === 'email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { fieldError(el, 'That email address doesn’t look right.'); return false; }
    if (el.type === 'tel' && v && v.replace(/[^0-9]/g, '').length < 7) { fieldError(el, 'Please give a number we can call.'); return false; }
    fieldError(el, ''); return true;
  }
  checked.forEach(function (el) {
    el.addEventListener('blur', function () { if (el.value.trim() || el.getAttribute('aria-invalid')) check(el); });
  });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    status.textContent = ''; status.className = 'form-status';
    var firstBad = null;
    checked.forEach(function (el) { if (!check(el) && !firstBad) firstBad = el; });
    if (firstBad) {
      status.textContent = 'Some details are missing or need checking. They’re marked below.';
      status.className = 'form-status is-error';
      firstBad.focus();
      return;
    }
    var data = new FormData(form);
    var company = (data.get('company') || '').toString().trim();
    data.append('_subject', 'Website quote request from ' + (company || 'a new customer'));
    var email = (data.get('email') || '').toString().trim();
    if (email) data.append('_replyto', email);

    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      var res = await fetch(form.action, { method: 'POST', body: data, headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error('Send failed');
      var mail = document.getElementById('quoteMail');
      if (mail) mail.href = 'mailto:john.hume@jnrengineeringltd.co.uk?subject=' + encodeURIComponent('Drawings for quote request, ' + (company || 'your company name'));
      content.classList.add('form-hidden');
      success.classList.add('show');
      var h = success.querySelector('h2'); if (h) { h.setAttribute('tabindex', '-1'); h.focus(); }
    } catch (err) {
      status.innerHTML = 'That didn’t send. Your details are still here, so try again, or call <a href="tel:01416475913">0141 647 5913</a> or email <a href="mailto:john.hume@jnrengineeringltd.co.uk">john.hume@jnrengineeringltd.co.uk</a>.';
      status.className = 'form-status is-error';
      if (btn) { btn.disabled = false; btn.innerHTML = btnText; }
    }
  });
})();
