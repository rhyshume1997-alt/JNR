'use strict';
// Creates the first admin (or any user). The password is read from the CREATE_USER_PASSWORD environment variable
// so it never appears in shell history or process lists.
// Usage: DATABASE_URL=... CREATE_USER_PASSWORD='...' node scripts/create-user.js admin you@example.com "Your Name"
const { createUser } = require('../api/_lib/auth');
const { closePool } = require('../api/_lib/db');

async function main() {
  const [role, email, ...nameParts] = process.argv.slice(2);
  const password = process.env.CREATE_USER_PASSWORD;
  if (!role || !email || !nameParts.length || !password) {
    console.error('Usage: CREATE_USER_PASSWORD=... node scripts/create-user.js <workshop|editor|admin> <email> "<Name>"');
    process.exit(2);
  }
  const u = await createUser({ email: 'cli' }, { role, email, name: nameParts.join(' '), password });
  console.log('Created ' + u.role + ' ' + u.email);
}
main().then(() => closePool(), (e) => { console.error(e.errors ? JSON.stringify(e.errors) : e.message); process.exit(1); });
