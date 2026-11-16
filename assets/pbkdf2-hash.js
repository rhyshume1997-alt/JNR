// Password hashing that runs in the browser (WebCrypto), used only by admin/first-admin to make the very first administrator's
// password hash without a terminal. PBKDF2-HMAC-SHA256 with 600,000 iterations (the OWASP figure). The server accepts this
// format and replaces it with a scrypt hash the first time the person signs in.
// Output format:  pbkdf2$<iterations>$<salt base64>$<hash base64>
(function (root) {
  'use strict';
  var ITERATIONS = 600000;

  function b64(bytes) {
    var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  async function hashPassword(password, saltBytes) {
    var subtle = (root.crypto || {}).subtle;
    if (!subtle) throw new Error('This browser cannot do secure hashing here (it needs https).');
    var salt = saltBytes || root.crypto.getRandomValues(new Uint8Array(16));
    var key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    var bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: ITERATIONS }, key, 256);
    return 'pbkdf2$' + ITERATIONS + '$' + b64(salt) + '$' + b64(new Uint8Array(bits));
  }

  // The SQL to paste into the database editor. Creates the first administrator only if there are no users yet.
  function buildSql(email, name, hash) {
    var q = function (v) { return "'" + String(v).replace(/'/g, "''") + "'"; };
    return '-- Creates the FIRST administrator, and only if there are no users yet. Safe to paste twice.\n' +
      'insert into users (email, name, role, password_hash)\n' +
      'select ' + q(email) + ', ' + q(name) + ", 'admin', " + q(hash) + '\n' +
      'where not exists (select 1 from users);\n';
  }

  function checkInputs(email, name, password, confirm) {
    var errors = {};
    if (!/^[^@\s'";\\]+@[^@\s'";\\]+\.[^@\s'";\\]+$/.test(email)) errors.email = 'Enter a valid email address.';
    if (!name || name.length > 100 || /[\r\n\u0000]/.test(name)) errors.name = 'Enter a name (one line).';
    if (typeof password !== 'string' || password.length < 14) errors.password = 'Use at least 14 characters. A few random words is best.';
    else if (password.length > 200) errors.password = 'That password is too long.';
    else if (/^(.)\1+$/.test(password)) errors.password = 'Use a less repetitive password.';
    if (password !== confirm) errors.confirm = 'The two passwords do not match.';
    return errors;
  }

  var api = { hashPassword: hashPassword, buildSql: buildSql, checkInputs: checkInputs, ITERATIONS: ITERATIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.JNRHash = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
