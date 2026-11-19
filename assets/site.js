/* Site behaviour: the phone menu and the scroll reveals.
   Without this file every page is complete: the menu is a plain row of links and nothing is hidden. */
(function () {
  var root = document.documentElement;
  var calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- phone menu ---- */
  var toggle = document.getElementById('navToggle');
  var nav = document.getElementById('siteNav');
  if (toggle && nav) {
    function setMenu(open) {
      nav.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.querySelector('span').textContent = open ? 'Close' : 'Menu';
    }
    toggle.addEventListener('click', function () { setMenu(!nav.classList.contains('open')); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('open')) { setMenu(false); toggle.focus(); }
    });
  }

  /* ---- scroll reveals: hidden only once this script is running, never for reduced motion ---- */
  var items = [].slice.call(document.querySelectorAll('.rv'));
  if (!calm && 'IntersectionObserver' in window && items.length) {
    root.classList.add('rv-on');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -5% 0px' });
    items.forEach(function (el) { io.observe(el); });
    /* Safety net: if anything is still hidden after a few seconds, show it. */
    setTimeout(function () { items.forEach(function (el) { el.classList.add('in'); }); }, 4000);
  }
})();
