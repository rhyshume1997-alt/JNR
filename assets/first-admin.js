// Page logic for /admin/first-admin. Everything happens in this browser tab: no request is sent anywhere with the password.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var out = $('sql');

  $('make').addEventListener('click', async function () {
    var email = $('email').value.trim(), name = $('name').value.trim(), pw = $('pw').value, again = $('pw2').value;
    ['email', 'name', 'pw', 'pw2'].forEach(function (k) { $(k + '-err').textContent = ''; });
    var errs = JNRHash.checkInputs(email, name, pw, again);
    if (errs.email) $('email-err').textContent = errs.email;
    if (errs.name) $('name-err').textContent = errs.name;
    if (errs.password) $('pw-err').textContent = errs.password;
    if (errs.confirm) $('pw2-err').textContent = errs.confirm;
    if (Object.keys(errs).length) return;
    $('make').disabled = true; $('make').textContent = 'Working…';
    try {
      var hash = await JNRHash.hashPassword(pw);
      out.value = JNRHash.buildSql(email, name, hash);
      $('result').classList.remove('hidden');
      $('pw').value = ''; $('pw2').value = ''; // the password is not kept on the page
      out.focus(); out.select();
    } catch (e) { $('pw-err').textContent = e.message; }
    finally { $('make').disabled = false; $('make').textContent = 'Make the SQL'; }
  });

  $('copy').addEventListener('click', async function () {
    try { await navigator.clipboard.writeText(out.value); $('copied').textContent = 'Copied. Now paste it into the Neon SQL editor and press Run.'; }
    catch (_) { out.focus(); out.select(); $('copied').textContent = 'Press Ctrl+C (or Cmd+C) to copy, then paste it into the Neon SQL editor.'; }
  });
})();
