'use strict';
// The GitHub Action for staging checks: how a run is requested, that it can only start safely, and that logs stay clean.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readMode, MODES } = require('../scripts/ci-mode');
const { scrub, describeTargets } = require('../scripts/lib/guard');

const root = path.join(__dirname, '..');
const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'staging-checks.yml'), 'utf8');
const tmp = (text) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jnr-ci-')), 'request.txt'); fs.writeFileSync(f, text); return f; };

describe('staging run request file and mode', () => {
  it('the committed request file runs nothing', () => assert.strictEqual(readMode({ EVENT_NAME: 'push' }, path.join(root, 'staging-run', 'request.txt')), 'none'));
  it('reads the mode line, ignoring comments and case', () => {
    for (const m of MODES) assert.strictEqual(readMode({ EVENT_NAME: 'push' }, tmp('# comment\nmode: ' + m.toUpperCase() + '\n')), m);
    assert.strictEqual(readMode({ EVENT_NAME: 'push' }, tmp('# mode: check\n')), 'none', 'a commented-out line does nothing');
    assert.strictEqual(readMode({ EVENT_NAME: 'push' }, path.join(os.tmpdir(), 'does-not-exist.txt')), 'none');
  });
  it('rejects anything it does not recognise instead of guessing', () => {
    for (const bad of ['mode: production', 'mode: check; rm -rf /', 'mode: e2e-drafts']) assert.throws(() => readMode({ EVENT_NAME: 'push' }, tmp(bad)), /Unknown mode/);
  });
  it('a manual run uses its chosen input, and an unknown input is refused', () => {
    assert.strictEqual(readMode({ EVENT_NAME: 'workflow_dispatch', MODE_INPUT: 'services' }, 'x'), 'services');
    assert.throws(() => readMode({ EVENT_NAME: 'workflow_dispatch', MODE_INPUT: 'all' }, 'x'), /Unknown mode/);
  });
});

describe('workflow safety (staging-checks.yml)', () => {
  it('can only start from a push to the feature branch that edits the request file, or a manual run: never PRs, forks, schedules or comments', () => {
    const on = wf.slice(wf.indexOf('\non:'), wf.indexOf('\npermissions:'));
    assert.match(on, /push:\s*\n\s*branches: \[feature\/workshop-content\]\s*\n\s*paths: \['staging-run\/request\.txt'\]/);
    assert.match(on, /workflow_dispatch:/);
    assert.ok(!/pull_request|pull_request_target|schedule|issue_comment|repository_dispatch|workflow_run|release|fork/.test(on), 'no other triggers');
  });
  it('has read-only repository permissions, a timeout, a branch guard and a one-at-a-time lock', () => {
    assert.match(wf, /permissions:\s*\n\s*contents: read/);
    assert.ok(!/(write|admin)\b/.test(wf.replace(/staging-run|workflow_dispatch/g, '')), 'no write permission anywhere');
    assert.match(wf, /timeout-minutes: 10/); assert.match(wf, /github\.ref == 'refs\/heads\/feature\/workshop-content'/);
    assert.match(wf, /concurrency:\s*\n\s*group: staging-checks\s*\n\s*cancel-in-progress: false/);
  });
  it('runs only after approval in the "staging" environment, and nothing runs for mode none', () => {
    assert.match(wf, /environment: staging/); assert.match(wf, /needs\.plan\.outputs\.mode != 'none'/);
    const planJob = wf.slice(wf.indexOf('  plan:'), wf.indexOf('  run:'));
    assert.ok(!/environment:|secrets\./.test(planJob), 'the planning job has no environment and no secrets');
  });
  it('gives secrets to the final step only, never to checkout, setup or install steps', () => {
    const runStepAt = wf.indexOf('- name: Run the selected staging check');
    assert.ok(runStepAt > 0);
    const before = wf.slice(0, runStepAt);
    assert.ok(!/secrets\./.test(before.replace(/^\s*#.*$/gm, '')), 'no secret is referenced before the final step');
    for (const s of ['DATABASE_URL', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'BUFFER_API_TOKEN']) assert.match(wf, new RegExp(s + ': \\$\\{\\{ secrets\\.' + s + ' \\}\\}'));
    assert.ok(!/(echo|printenv|env\s*$|set -x|cat \.env)/m.test(wf.slice(runStepAt, wf.indexOf('env:', runStepAt)).replace('echo "Unknown mode"', '')), 'the step never prints the environment');
  });
  it('is hardened: pinned major versions, no stored git credentials, no install scripts, only staging values', () => {
    assert.match(wf, /actions\/checkout@v4/); assert.match(wf, /actions\/setup-node@v4/);
    assert.strictEqual((wf.match(/persist-credentials: false/g) || []).length, 2);
    assert.match(wf, /npm ci --ignore-scripts/); assert.match(wf, /DEPLOY_ENV: staging/); assert.match(wf, /BUFFER_ENV: staging/);
    assert.ok(!/\bproduction\b/i.test(wf.replace(/#.*$/gm, '')), 'no production anywhere in the executable parts');
    assert.ok(!/vercel/i.test(wf.replace(/#.*$/gm, '')), 'does not touch Vercel');
  });
  it('maps each mode to exactly the intended script, and e2e-draft is the only one that creates a Buffer draft', () => {
    assert.match(wf, /services\)\s+node scripts\/staging-check\.js --skip-buffer/); assert.match(wf, /check\)\s+node scripts\/staging-check\.js ;;/);
    assert.match(wf, /e2e\)\s+node scripts\/staging-e2e\.js ;;/); assert.match(wf, /e2e-draft\)\s+node scripts\/staging-e2e\.js --confirm-draft/);
    assert.strictEqual((wf.match(/--confirm-draft/g) || []).length, 1);
  });
});

describe('logs stay clean (the repository is public, so Action logs are public)', () => {
  const env = { DATABASE_URL: 'postgresql://neondb_owner:Sup3rSecretPw@ep-cobalt-cable-123456-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require',
    S3_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com', S3_ACCESS_KEY_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', S3_SECRET_ACCESS_KEY: 'f'.repeat(64),
    PUBLIC_MEDIA_BASE_URL: 'https://pub-0a1b2c3d4e5f.r2.dev', BUFFER_API_TOKEN: 'tok_live_abcdef0123456789xyz', BUFFER_STAGING_CHANNEL_ID: '6afa05fbece6dfde5fd74165', GITHUB_ACTIONS: 'true',
    DEPLOY_ENV: 'staging', BUFFER_ENV: 'staging', S3_BUCKET_PRIVATE: 'jnr-staging-private', S3_BUCKET_PUBLIC: 'jnr-staging-public' };
  it('removes hosts, users, passwords, keys, tokens and channel ids from any printed line', () => {
    const dirty = [
      'getaddrinfo ENOTFOUND ep-cobalt-cable-123456-pooler.eu-west-2.aws.neon.tech', 'password authentication failed for user "neondb_owner" (Sup3rSecretPw)', 'connect postgresql://neondb_owner:Sup3rSecretPw@host/db',
      'PUT https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/jnr-staging-private/x 403 key a1b2c3d4e5f60718293a4b5c6d7e8f90', 'GET https://pub-0a1b2c3d4e5f.r2.dev/public/x.jpg -> 404',
      'Buffer said tok_live_abcdef0123456789xyz is invalid for channel 6afa05fbece6dfde5fd74165', 'secret ' + 'f'.repeat(64),
    ].join('\n');
    const clean = scrub(dirty, env);
    for (const leak of ['ep-cobalt', 'neon.tech', 'neondb_owner', 'Sup3rSecretPw', '0123456789abcdef0123456789abcdef', 'a1b2c3d4e5f60718293a4b5c6d7e8f90', 'pub-0a1b2c3d4e5f', 'tok_live', '6afa05fbece6dfde5fd74165', 'f'.repeat(64), 'postgresql://']) assert.ok(!clean.includes(leak), 'leaked: ' + leak);
    assert.match(clean, /<db-host>/); assert.match(clean, /<buffer-token>/);
  });
  it('shortens hosts and ids in the banner when running in GitHub Actions, and never shows a secret', () => {
    const t = describeTargets(env).join('\n');
    assert.ok(!/ep-cobalt-cable-123456-pooler\.eu-west-2\.aws\.neon\.tech|pub-0a1b2c3d4e5f\.r2\.dev|6afa05fbece6dfde5fd74165|Sup3rSecretPw|tok_live|f{64}/.test(t), t);
    assert.match(t, /jnr-staging-private/);
    const local = describeTargets(Object.assign({}, env, { GITHUB_ACTIONS: '' })).join('\n');
    assert.match(local, /ep-cobalt-cable-123456-pooler/, 'full host is shown on the owner\'s own computer');
    assert.ok(!/Sup3rSecretPw|tok_live/.test(local));
  });
  it('the request file template tells the person exactly what to do', () => {
    const t = fs.readFileSync(path.join(root, 'staging-run', 'request.txt'), 'utf8');
    for (const m of ['services', 'check', 'e2e', 'e2e-draft', 'none']) assert.match(t, new RegExp(m));
    assert.match(t, /Approve and deploy/); assert.match(t, /^mode: none$/m);
  });
});
