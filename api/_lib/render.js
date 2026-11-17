'use strict';

// Server-rendered public pages. Everything comes from live_snapshot (the approved, published copy), never from the
// working entry, so unapproved edits and private fields cannot appear. All text is HTML-escaped.

const { KIND_LABELS, STAGE_LABELS } = require('./model');
const { getConfig } = require('./config');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtDate(d) {
  const t = new Date(String(d).slice(0, 10) + 'T12:00:00Z');
  if (Number.isNaN(t.getTime())) return '';
  return t.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function clip(s, n) {
  const t = String(s || '').trim();
  if (t.length <= n) return t;
  return t.slice(0, n).replace(/\s+\S*$/, '').replace(/[.,;:!-]+$/, '') + '…';
}

function paragraphs(text) {
  return String(text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>').join('\n');
}

const NAV = [['Home', '/'], ['About', '/about'], ['Services', '/services'], ['Our Work', '/our-work']];

function layout(opts) {
  const site = getConfig().siteUrl;
  const robots = opts.noindex ? 'noindex, follow' : 'index, follow';
  const ogImage = opts.image || site + '/assets/mill.jpg';
  const navLinks = NAV.map((n) => '<li><a' + (n[1] === opts.active ? ' class="active"' : '') + ' href="' + n[1] + '">' + n[0] + '</a></li>').join('');
  const mobile = NAV.concat([['Get A Quote', '/quote']]).map((n) => '<a href="' + n[1] + '">' + n[0] + '</a>').join('');
  return '<!DOCTYPE html>\n<html lang="en-GB">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>' + esc(opts.title) + '</title>\n<meta name="description" content="' + esc(opts.description) + '">\n<meta name="robots" content="' + robots + '">\n' +
    '<link rel="canonical" href="' + esc(site + opts.path) + '">\n' +
    '<meta property="og:type" content="website">\n<meta property="og:title" content="' + esc(opts.title) + '">\n<meta property="og:description" content="' + esc(opts.description) + '">\n<meta property="og:locale" content="en_GB">\n<meta property="og:image" content="' + esc(ogImage) + '">\n<meta name="twitter:card" content="summary_large_image">\n' +
    '<link rel="icon" type="image/png" sizes="64x64" href="/assets/favicon.png">\n<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">\n' +
    (opts.jsonLd ? '<script type="application/ld+json">' + JSON.stringify(opts.jsonLd).replace(/</g, '\\u003c') + '</script>\n' : '') +
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">\n' +
    '<link rel="preload" href="/assets/jnr-head.otf" as="font" type="font/otf" crossorigin>\n<link rel="stylesheet" href="/assets/style.css">\n<link rel="stylesheet" href="/assets/work.css">\n</head>\n<body>\n' +
    '<nav id="nav">\n  <a class="nav-logo" href="/"><img class="lg-white" src="/assets/logo-white.png" alt="J.N.R. Engineering Ltd"><img class="lg-navy" src="/assets/logo-navy.png" alt="J.N.R. Engineering Ltd"></a>\n  <ul class="nav-links">' + navLinks + '</ul>\n' +
    '  <a class="nav-tel" href="tel:01416475913" aria-label="Call the workshop on 0141 647 5913">0141 647 5913</a>\n  <a class="nav-cta magnetic" href="/quote"><span class="btn-roll"><span>Get A Quote</span><span aria-hidden="true">Get A Quote</span></span></a>\n  <button class="hamburger" id="burger" onclick="toggleMenu()" aria-label="Menu"><span></span><span></span><span></span></button>\n</nav>\n' +
    '<div class="mobile-menu" id="mobileMenu">' + mobile + '</div>\n<div class="page active">\n' + opts.body + '\n</div>\n' + FOOTER +
    '\n<script src="/assets/gsap.min.js"></script>\n<script src="/assets/ScrollTrigger.min.js"></script>\n<script src="/assets/SplitText.min.js"></script>\n<script src="/assets/lenis.min.js"></script>\n<script src="/assets/site.js"></script>\n</body>\n</html>\n';
}

const FOOTER = '<footer>\n  <div class="foot-grid">\n    <div><span class="foot-logo"><img src="/assets/logo-navy.png" alt="J.N.R. Engineering Ltd" width="200" height="82" loading="lazy" decoding="async"></span><p class="foot-tag">CNC machining, water jet profiling and fabrication. Family run, Hamilton.</p></div>\n' +
  '    <div><div class="foot-h">Site</div><ul class="foot-links"><li><a href="/">Home</a></li><li><a href="/about">About</a></li><li><a href="/services">Services</a></li><li><a href="/our-work">Our Work</a></li><li><a href="/quote">Get A Quote</a></li></ul></div>\n' +
  '    <div><div class="foot-h">What we make</div><ul class="foot-links"><li><a href="/capabilities/cnc-milling">CNC Milling</a></li><li><a href="/capabilities/cnc-turning">CNC Turning</a></li><li><a href="/capabilities/prototypes">Prototypes</a></li><li><a href="/capabilities/batch-production">Batch Production</a></li><li><a href="/capabilities/materials">Materials</a></li></ul></div>\n' +
  '    <div><div class="foot-h">Family</div><ul class="foot-links"><li><a href="https://www.marpet.co.uk/" target="_blank" rel="noopener">Marpet Fabrications</a></li></ul></div>\n' +
  '    <div><div class="foot-h">Contact</div><ul class="foot-links"><li><a href="tel:01416475913">0141 647 5913</a></li><li><a href="mailto:john.hume@jnrengineeringltd.co.uk">john.hume@jnrengineeringltd.co.uk</a></li><li><span>Block 8 Unit 1, Whistleberry Industrial Estate, Hamilton, ML3 0ED</span></li></ul></div>\n  </div>\n' +
  '  <div class="foot-bottom"><span>© 2026 JNR Engineering Ltd</span><span class="foot-legal">Registered in Scotland, company no. SC334377. Registered office: Block 8 Unit 1, Whistleberry Industrial Estate, Blantyre, ML3 0ED</span><a href="/privacy">Privacy</a></div>\n</footer>';

// Size of the small (list and feed) copy. New snapshots store it. Older ones only have the large copy's size, and the small copy is
// that same picture fitted inside 640 x 640 (never enlarged), so it is worked out the same way: the long side is at most 640.
function thumbSize(img) {
  if (img.thumb_width > 0 && img.thumb_height > 0) return { width: img.thumb_width, height: img.thumb_height };
  const scale = Math.min(1, 640 / Math.max(img.width, img.height));
  return { width: Math.max(1, Math.round(img.width * scale)), height: Math.max(1, Math.round(img.height * scale)) };
}

function entryUrl(snap) { return snap.is_case_study && snap.body ? '/our-work/' + encodeURIComponent(snap.slug) : null; }

function card(snap) {
  const url = entryUrl(snap);
  const img = snap.images && snap.images[0];
  const spec = [snap.material, snap.process].filter(Boolean).map(esc).join(' · ');
  const stage = snap.kind === 'in_production' && snap.stage ? '<span class="work-stage">' + esc(STAGE_LABELS[snap.stage] || '') + '</span>' : '';
  const title = url ? '<a href="' + url + '">' + esc(snap.title) + '</a>' : esc(snap.title);
  return '<article class="work-card work-' + esc(snap.kind) + (url ? ' is-case' : '') + '">' +
    (img ? '<div class="work-photo"><img src="' + esc(img.thumb_url) + '" alt="' + esc(img.alt) + '" width="' + thumbSize(img).width + '" height="' + thumbSize(img).height + '" loading="lazy" decoding="async"></div>' : '') +
    '<div class="work-body"><div class="work-meta"><span class="work-pill">' + esc(KIND_LABELS[snap.kind]) + '</span>' + stage + '<time datetime="' + esc(String(snap.event_date).slice(0, 10)) + '">' + esc(fmtDate(snap.event_date)) + '</time></div>' +
    '<h3>' + title + '</h3><p class="work-sum">' + esc(clip(snap.summary, 220)) + '</p>' +
    (spec ? '<p class="work-spec">' + spec + '</p>' : '') +
    (url ? '<a class="work-more" href="' + url + '">Read the case study</a>' : '') + '</div></article>';
}

function renderIndex(entries) {
  const snaps = entries.map((e) => e.live_snapshot);
  const live = snaps.filter((s) => s.kind === 'in_production');
  const rest = snaps.filter((s) => s.kind !== 'in_production');
  const empty = !snaps.length;
  let body = '<div class="page-hero"><div class="hero-bg bg-draw"></div><div class="hero-shade"></div><div class="page-hero-content"><h1><span class="line"><span>Our</span></span> <span class="line"><span><em>Work.</em></span></span></h1><p class="hero-sub">What is on the machines and what has gone out of the Hamilton workshop recently.</p></div></div>';
  body += '<div class="section"><div class="section-inner"><p class="crumbs light-crumbs"><a href="/">Home</a> / Our Work</p>';
  if (empty) body += '<p class="work-empty">New work will be added here soon.</p>';
  if (live.length) body += '<h2 class="work-h">In production now</h2><div class="work-grid">' + live.map(card).join('') + '</div>';
  if (rest.length) body += '<h2 class="work-h">Completed work and workshop updates</h2><div class="work-grid">' + rest.map(card).join('') + '</div>';
  body += '</div></div><div class="cta-band"><div style="position:relative;z-index:2"><h2 class="cta-title">Need A Part<br><em>Made?</em></h2><p class="cta-sub">Fill in the form and upload the drawing. We\'ll come back with a price and a lead time.</p><a class="btn btn-primary magnetic" href="/quote#drawing"><span class="btn-roll"><span>Send Us Your Drawing</span><span aria-hidden="true">Send Us Your Drawing</span></span></a></div></div>';
  return layout({
    title: 'Our Work | J.N.R. Engineering, Hamilton', path: '/our-work', active: '/our-work', noindex: empty,
    description: 'Recent work from the J.N.R. Engineering workshop in Hamilton: parts in production, completed jobs and workshop updates.',
    image: snaps[0] && snaps[0].images && snaps[0].images[0] && snaps[0].images[0].url, body,
  });
}

function renderEntry(row) {
  const s = row.live_snapshot;
  const site = getConfig().siteUrl;
  const aside = [['Status', KIND_LABELS[s.kind] + (s.kind === 'in_production' && s.stage ? ' · ' + STAGE_LABELS[s.stage] : '')], ['Material', s.material], ['Process', s.process], ['Date', fmtDate(s.event_date)], ['Customer', s.customer]]
    .filter((r) => r[1]).map((r) => '<div><dt>' + r[0] + '</dt><dd>' + esc(r[1]) + '</dd></div>').join('');
  const gallery = (s.images || []).map((i) => '<figure class="work-fig"><img src="' + esc(i.url) + '" alt="' + esc(i.alt) + '" width="' + i.width + '" height="' + i.height + '" loading="lazy" decoding="async"></figure>').join('');
  const body = '<div class="page-hero"><div class="hero-bg bg-draw"></div><div class="hero-shade"></div><div class="page-hero-content"><h1><span class="line"><span>' + esc(s.title) + '</span></span></h1><p class="hero-sub">' + esc(clip(s.summary, 200)) + '</p></div></div>' +
    '<div class="section light"><div class="section-inner"><p class="crumbs"><a href="/">Home</a> / <a href="/our-work">Our Work</a> / ' + esc(clip(s.title, 60)) + '</p><div class="cap-layout"><div class="cap-copy"><p>' + esc(s.summary) + '</p>' + paragraphs(s.body) + (gallery ? '<div class="work-gallery">' + gallery + '</div>' : '') + '</div>' +
    '<aside class="cap-aside"><h3>The job</h3><dl class="proj-spec" style="margin-top:14px">' + aside + '</dl></aside></div></div></div>' +
    '<div class="cta-band"><div style="position:relative;z-index:2"><h2 class="cta-title">Need A Part Like This?<br><em>Send The Drawing.</em></h2><p class="cta-sub">Fill in the form and upload the drawing. We\'ll come back with a price and a lead time.</p><a class="btn btn-primary magnetic" href="/quote#drawing"><span class="btn-roll"><span>Send Us Your Drawing</span><span aria-hidden="true">Send Us Your Drawing</span></span></a></div></div>';
  return layout({
    title: s.title + ' | Our Work | J.N.R. Engineering', path: '/our-work/' + s.slug, active: '/our-work', noindex: false,
    description: clip(s.summary, 155), image: s.images && s.images[0] && s.images[0].url, body,
    jsonLd: { '@context': 'https://schema.org', '@type': 'Article', headline: s.title, description: clip(s.summary, 200), datePublished: String(s.event_date).slice(0, 10), image: (s.images || []).map((i) => i.url), publisher: { '@id': site + '/#business' } },
  });
}

function feedItems(entries) {
  return entries.map((e) => {
    const s = e.live_snapshot; const img = s.images && s.images[0];
    return { title: s.title, summary: clip(s.summary, 140), kind: s.kind, kind_label: KIND_LABELS[s.kind], url: entryUrl(s) || '/our-work', date: String(s.event_date).slice(0, 10),
      image: img ? { url: img.thumb_url, alt: img.alt, width: thumbSize(img).width, height: thumbSize(img).height } : null };
  });
}

function renderNotFound() {
  return layout({ title: 'Not found | J.N.R. Engineering', path: '/our-work', active: '/our-work', noindex: true, description: 'Page not found.',
    body: '<div class="page-hero"><div class="hero-bg bg-draw"></div><div class="hero-shade"></div><div class="page-hero-content"><h1><span class="line"><span>Not <em>found.</em></span></span></h1><p class="hero-sub"><a href="/our-work" style="color:#fff">See all our work</a></p></div></div>' });
}

module.exports = { esc, clip, fmtDate, layout, renderIndex, renderEntry, renderNotFound, feedItems, card, thumbSize };
