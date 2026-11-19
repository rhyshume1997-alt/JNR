/* Quote form: drawings list, checks, submit. Posts exactly what the form always posted to /api/quote. */
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


var quoteForm = document.getElementById('formContent');
if (quoteForm) quoteForm.addEventListener('submit', function(e){ e.preventDefault(); submitForm(); });
