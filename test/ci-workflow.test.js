'use strict';
// The GitHub Action for staging checks. Each test pins one way credentials could otherwise leak or be reached by unreviewed code.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readMode, MODES } = require('../scripts/ci-mode');
const { scrub, describeTargets, installOutputScrubber } = require('../scripts/lib/guard');
const { blockers } = require('../scripts/premerge-check');

const root = path.join(__dirname, '..');
const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'staging-checks.yml'), 'utf8');
const code = wf.replace(/^\s*#.*$/gm, ''); // executable part only (no comments)
const SHA = '4373cabd1c720bcfa02f6789955f6909638e7510';
const tagEnv = (name, sha) => ({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: name, GITHUB_SHA: sha || SHA });
const stepBlock = (title) => { const i = code.indexOf('- name: ' + title); assert.ok(i > 0, 'missing step ' + title); const j = code.indexOf('\n      - ', i + 10); return code.slice(i, j === -1 ? undefined : j); };

describe('which run starts, and from what', () => {
  it('reads the mode from a tag that points at the commit its name says', () => {
    for (const m of MODES) assert.strictEqual(readMode(tagEnv('staging-' + m + '-4373cab')), m);
  });
  it('refuses branches, wrong or malformed tags, and a tag that does not match its commit', () => {
    assert.throws(() => readMode({ GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'feature/workshop-content', GITHUB_SHA: SHA }), /only from an approved tag/);
    for (const bad of ['staging-production-4373cab', 'staging-services', 'staging-services-4373ca', 'staging-services-4373cabX', 'staging-e2e-drafts-4373cab', 'staging-check-4373cab; rm -rf /', 'release-services-4373cab'])
      assert.throws(() => readMode(tagEnv(bad)), /tag name must look like/, bad);
    assert.throws(() => readMode(tagEnv('staging-services-1111111')), /Refusing/);
    assert.throws(() => readMode(tagEnv('staging-services-4373cab', 'short')), /No commit SHA/);
  });
});

describe('how credentials are kept from unreviewed code', () => {
  it('starts only from a tag push: no branches, pull requests, forks, schedules, manual dispatch or comments', () => {
    const on = code.slice(code.indexOf('\non:'), code.indexOf('\npermissions:'));
    assert.match(on, /push:\s*\n\s*tags:\s*\n\s*- 'staging-services-\*'\s*\n\s*- 'staging-check-\*'\s*\n\s*- 'staging-e2e-\*'/);
    assert.ok(!/branches|pull_request|pull_request_target|schedule|issue_comment|repository_dispatch|workflow_run|workflow_dispatch|release|paths/.test(on), 'no other trigger');
    assert.ok(!/refs\/heads/.test(code), 'no branch is referenced anywhere in the executable parts');
  });
  it('the secret-bearing job needs the staging environment and refuses any commit that is not the approved one BEFORE running anything from the repo', () => {
    assert.match(code, /environment: staging/);
    const runJob = code.slice(code.indexOf('\n  run:'));
    const firstStep = runJob.slice(runJob.indexOf('steps:'), runJob.indexOf('- uses:'));
    assert.match(firstStep, /APPROVED_SHA/); assert.match(firstStep, /\^\[0-9a-f\]\{40\}\$/); assert.match(firstStep, /\$GITHUB_SHA" != "\$APPROVED_SHA"/); assert.match(firstStep, /exit 1/);
    assert.match(firstStep, /APPROVED_SHA: \$\{\{ vars\.APPROVED_SHA \}\}/, 'the approved SHA comes from the environment variable only Rhys controls, not from the repository');
    assert.ok(runJob.indexOf('actions/checkout') > runJob.indexOf('APPROVED_SHA'), 'checkout happens after the check');
  });
  it('the planning job has no environment, no secrets and no variables', () => {
    const plan = code.slice(code.indexOf('\n  plan:'), code.indexOf('\n  run:'));
    assert.ok(!/environment:|secrets\.|vars\./.test(plan));
  });
  it('credentials appear only inside the four mode steps, never in setup, checkout or install steps', () => {
    const firstMode = code.indexOf('- name: services');
    assert.ok(firstMode > 0);
    assert.ok(!/secrets\./.test(code.slice(0, firstMode)), 'no secret before the mode steps');
    const secrets = new Set(Array.from(code.matchAll(/secrets\.([A-Z0-9_]+)/g)).map((m) => m[1]));
    assert.deepStrictEqual([...secrets].sort(), ['BUFFER_API_TOKEN', 'DATABASE_URL', 'S3_ACCESS_KEY_ID', 'S3_ENDPOINT', 'S3_SECRET_ACCESS_KEY']);
    assert.ok(!/secrets\.GITHUB_TOKEN|secrets\.[A-Z_]*(VERCEL|CLOUDFLARE)/i.test(code), 'no other credential, and nothing for Vercel');
  });
  it('gives each mode only what it needs: the Buffer token only to check and e2e-draft, and nothing production', () => {
    for (const title of ['services', 'e2e (whole', ]) assert.ok(!/BUFFER_API_TOKEN/.test(stepBlock(title)), title + ' must not receive the Buffer token');
    assert.match(stepBlock('check ('), /BUFFER_API_TOKEN: \$\{\{ secrets\.BUFFER_API_TOKEN \}\}/); assert.match(stepBlock('e2e-draft'), /BUFFER_API_TOKEN: \$\{\{ secrets\.BUFFER_API_TOKEN \}\}/);
    assert.strictEqual((code.match(/BUFFER_API_TOKEN: /g) || []).length, 2);
    for (const title of ['services', 'e2e (whole', 'check (', 'e2e-draft']) { assert.match(stepBlock(title), /DEPLOY_ENV: staging/); assert.match(stepBlock(title), /BUFFER_ENV: staging/); }
    assert.strictEqual((code.match(/--confirm-draft/g) || []).length, 1);
    assert.ok(!/\bproduction\b/i.test(code) && !/vercel/i.test(code));
  });
  it('is hardened against supply-chain and injection: pinned actions, no cache, no install scripts, no stored credentials, no expression in any script, read-only token', () => {
    for (const m of code.matchAll(/uses: (\S+)/g)) assert.match(m[1], /^actions\/(checkout|setup-node)@[0-9a-f]{40}$/, 'action not pinned to a full commit SHA: ' + m[1]);
    assert.ok(!/cache:|actions\/cache/.test(code), 'no cache that another run could poison');
    assert.match(code, /npm ci --ignore-scripts/); assert.ok(!/npm (install|i) |npx |curl|wget|\| *(ba)?sh/.test(code), 'nothing is downloaded and run');
    assert.strictEqual((code.match(/persist-credentials: false/g) || []).length, 2);
    assert.match(code, /permissions:\s*\n\s*contents: read/); assert.ok(!/(contents|actions|id-token|packages|checks|statuses): write/.test(code));
    for (const m of code.matchAll(/run: \|?\s*\n?([\s\S]*?)(?=\n\s+(env:|- |if:)|\n\n|$)/g)) assert.ok(!/\$\{\{/.test(m[1]), 'expression inside a script: ' + m[1].slice(0, 60));
    assert.match(code, /timeout-minutes: 10/); assert.match(code, /concurrency:\s*\n\s*group: staging-checks/);
  });
});

describe('logs stay clean (the repository is public, so Action logs are public)', () => {
  const env = { DATABASE_URL: 'postgresql://neondb_owner:Sup3rSecretPw@ep-cobalt-cable-123456-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require',
    S3_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com', S3_ACCESS_KEY_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', S3_SECRET_ACCESS_KEY: 'f'.repeat(64),
    PUBLIC_MEDIA_BASE_URL: 'https://pub-0a1b2c3d4e5f.r2.dev', BUFFER_API_TOKEN: 'tok_live_abcdef0123456789xyz', BUFFER_STAGING_CHANNEL_ID: '6afa05fbece6dfde5fd74165', GITHUB_ACTIONS: 'true',
    DEPLOY_ENV: 'staging', BUFFER_ENV: 'staging', S3_BUCKET_PRIVATE: 'jnr-staging-private', S3_BUCKET_PUBLIC: 'jnr-staging-public' };
  const LEAKS = ['ep-cobalt', 'neon.tech', 'neondb_owner', 'Sup3rSecretPw', '0123456789abcdef0123456789abcdef', 'a1b2c3d4e5f60718293a4b5c6d7e8f90', 'pub-0a1b2c3d4e5f', 'tok_live', '6afa05fbece6dfde5fd74165', 'f'.repeat(64), 'postgresql://'];
  it('removes hosts, users, passwords, keys, tokens and channel ids from any printed text, including stack traces', () => {
    const dirty = ['getaddrinfo ENOTFOUND ep-cobalt-cable-123456-pooler.eu-west-2.aws.neon.tech', 'password authentication failed for user "neondb_owner" (Sup3rSecretPw)', 'connect postgresql://neondb_owner:Sup3rSecretPw@host/db',
      'PUT https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/jnr-staging-private/x 403 key a1b2c3d4e5f60718293a4b5c6d7e8f90', 'GET https://pub-0a1b2c3d4e5f.r2.dev/public/x.jpg -> 404',
      'Buffer said tok_live_abcdef0123456789xyz is invalid for channel 6afa05fbece6dfde5fd74165', 'secret ' + 'f'.repeat(64), 'Error: boom\n    at connect (/x/pg/lib/client.js:1:1) ep-cobalt-cable-123456-pooler.eu-west-2.aws.neon.tech'].join('\n');
    const clean = scrub(dirty, env);
    for (const leak of LEAKS) assert.ok(!clean.includes(leak), 'leaked: ' + leak);
  });
  it('a scrubber on the whole process output catches console.error from the application code and uncaught errors too', () => {
    const { spawnSync } = require('node:child_process');
    const script = "const g=require(" + JSON.stringify(path.join(root, 'scripts', 'lib', 'guard.js')) + ");g.installOutputScrubber(process.env);" +
      "console.log('host '+process.env.PGH);console.error('Unhandled error:', new Error('connect to '+process.env.DATABASE_URL).stack);process.stdout.write('key '+process.env.S3_SECRET_ACCESS_KEY+'\\n');" +
      "Promise.reject(new Error('no route to '+process.env.PGH+' with '+process.env.BUFFER_API_TOKEN));";
    const r = spawnSync(process.execPath, ['-e', script], { env: Object.assign({}, env, { PGH: 'ep-cobalt-cable-123456-pooler.eu-west-2.aws.neon.tech' }), encoding: 'utf8' });
    const out = r.stdout + r.stderr;
    for (const leak of LEAKS) assert.ok(!out.includes(leak), 'leaked: ' + leak + '\n' + out);
    assert.notStrictEqual(r.status, 0); assert.match(out, /Unexpected error/);
  });
  it('shortens hosts and ids in the banner when running in GitHub Actions, and never shows a secret', () => {
    const t = describeTargets(env).join('\n');
    assert.ok(!/ep-cobalt-cable-123456-pooler\.eu-west-2\.aws\.neon\.tech|pub-0a1b2c3d4e5f\.r2\.dev|6afa05fbece6dfde5fd74165|Sup3rSecretPw|tok_live|f{64}/.test(t), t);
    assert.match(describeTargets(Object.assign({}, env, { GITHUB_ACTIONS: '' })).join('\n'), /ep-cobalt-cable-123456-pooler/, 'full host on the owner\'s own computer');
  });
  it('both staging scripts install the scrubber first', () => {
    for (const f of ['staging-check.js', 'staging-e2e.js']) assert.match(fs.readFileSync(path.join(root, 'scripts', f), 'utf8'), /installOutputScrubber\(process\.env\)/);
  });
});

describe('nothing temporary can be merged by accident', () => {
  it('the pre-merge check lists every temporary file and passes once they are gone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jnr-pm-'));
    assert.deepStrictEqual(blockers(dir), []);
    for (const f of ['admin/first-admin.html', 'assets/first-admin.js', 'assets/pbkdf2-hash.js']) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), 'x'); }
    fs.mkdirSync(path.join(dir, 'staging-run'));
    assert.strictEqual(blockers(dir).length, 4); assert.match(blockers(dir).join('\n'), /first-admin\.html/);
  });
  it('the old branch-triggered request file is gone', () => assert.ok(!fs.existsSync(path.join(root, 'staging-run'))));
});
