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

/* ═══ QUOTE NUMBER ═══ */
function makeQuoteRef(){
  var d = new Date();
  var ymd = String(d.getFullYear()).slice(2) + ('0'+(d.getMonth()+1)).slice(-2) + ('0'+d.getDate()).slice(-2);
  var chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', tail = '';
  var rnd = (window.crypto && crypto.getRandomValues) ? crypto.getRandomValues(new Uint32Array(4)) : [0,0,0,0].map(function(){ return Math.floor(Math.random()*1e9); });
  for (var i = 0; i < 4; i++) tail += chars[rnd[i] % chars.length];
  return 'JNR-' + ymd + '-' + tail;
}

/* ═══ FORM SUBMIT (Formspree) ═══ */
async function submitForm() {
  var content = document.getElementById('formContent');
  var success = document.getElementById('formSuccess');
  var btn = document.querySelector('#formContent .form-submit');

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

  var ref = makeQuoteRef();
  var emailEl = document.querySelector('#formContent input[name="email"]');
  data.append('quote_number', ref);
  if (emailEl) data.append('_replyto', emailEl.value);
  data.append('_subject', 'Quote request ' + ref + ' from website');

  if (btn) { btn.disabled = true; btn.innerHTML = 'Sending...'; }
  try {
    var res = await fetch('https://formspree.io/f/xpqeznvj', {
      method: 'POST',
      body: data,
      headers: { 'Accept': 'application/json' }
    });
    if (res.ok) {
      var refEl = document.getElementById('quoteRef');
      if (refEl) refEl.textContent = ref;
      var mail = document.getElementById('quoteMail');
      if (mail) mail.href = 'mailto:john.hume@jnrengineeringltd.co.uk?subject=' + encodeURIComponent('Drawings for quote ' + ref);
      if (content) content.classList.add('form-hidden');
      if (success) success.classList.add('show');
      var wrap = document.querySelector('.q-form-wrap');
      if (wrap) window.scrollTo({ top: wrap.getBoundingClientRect().top + window.scrollY - 110, behavior: 'smooth' });
    } else {
      throw new Error('Send failed');
    }
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = 'Could not send. Please email us directly.';
      setTimeout(function(){
        btn.innerHTML = 'Send Quote Request <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
      }, 4000);
    }
  }
}

/* ═══ INIT ═══ */
if (!('IntersectionObserver' in window)) {
  document.querySelectorAll('.rv, .rv-img').forEach(function(el){ el.classList.add('in'); });
} else { initReveal(); }
setTimeout(function(){ document.querySelectorAll('.page.active .rv, .page.active .rv-img').forEach(function(el){ el.classList.add('in'); }); }, 2500);
