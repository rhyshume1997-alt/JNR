'use strict';
// Checks a set of environment variables for the staging setup WITHOUT contacting anything: names present, formats right,
// obvious mix-ups caught (a placeholder left in, the private and public bucket the same, a non-https media URL).
// Returns { problems, warnings }. Never includes a value in a message.

const HEX24 = /^[a-f0-9]{24}$/i;

function lint(env, opts) {
  const skipBuffer = !!(opts && opts.skipBuffer);
  const problems = []; const warnings = [];
  const get = (k) => String(env[k] === undefined ? '' : env[k]).trim();
  const need = (k) => { if (!get(k)) { problems.push(k + ' is not set.'); return false; } if (/^(xxx+|changeme|todo|your[-_ ]|<.*>|\.\.\.)/i.test(get(k))) { problems.push(k + ' still looks like a placeholder.'); return false; } return true; };

  if (get('DEPLOY_ENV') !== 'staging') problems.push('DEPLOY_ENV must be "staging" in .env.staging.');
  if (need('DATABASE_URL')) {
    const u = get('DATABASE_URL');
    if (!/^postgres(ql)?:\/\//.test(u)) problems.push('DATABASE_URL must start with postgres:// or postgresql://.');
    else {
      if (!/localhost|127\.0\.0\.1/.test(u) && !/sslmode=/.test(u)) warnings.push('DATABASE_URL has no sslmode. Neon strings end in ?sslmode=require; copy the string as shown.');
      if (/-pooler\./.test(u) === false && /neon\.tech/.test(u)) warnings.push('DATABASE_URL is the unpooled Neon string. Use the pooled one (host contains "-pooler") for serverless.');
    }
  }
  if (need('S3_ENDPOINT')) {
    const e = get('S3_ENDPOINT');
    if (!/^https:\/\/[a-f0-9]{32}(\.(eu|fedramp))?\.r2\.cloudflarestorage\.com\/?$/.test(e)) warnings.push('S3_ENDPOINT does not look like an R2 address (https://<32-character account id>.r2.cloudflarestorage.com, no bucket name on the end).');
    if (/\.r2\.cloudflarestorage\.com\/[^/]+/.test(e)) problems.push('S3_ENDPOINT must not include a bucket name.');
  }
  ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET_PRIVATE', 'S3_BUCKET_PUBLIC'].forEach(need);
  ['S3_BUCKET_PRIVATE', 'S3_BUCKET_PUBLIC'].forEach((k) => { if (get(k) && !/staging/i.test(get(k))) problems.push(k + ' must contain "staging" (use jnr-staging-private / jnr-staging-public) so staging can never touch a production bucket.'); });
  if (get('S3_BUCKET_PRIVATE') && get('S3_BUCKET_PRIVATE') === get('S3_BUCKET_PUBLIC')) problems.push('S3_BUCKET_PRIVATE and S3_BUCKET_PUBLIC must be two different buckets.');
  if (get('S3_ACCESS_KEY_ID') && !/^[a-f0-9]{32}$/i.test(get('S3_ACCESS_KEY_ID'))) warnings.push('S3_ACCESS_KEY_ID is not 32 hex characters, which is what R2 gives. Check you copied the Access Key ID, not the token value.');
  if (get('S3_SECRET_ACCESS_KEY') && !/^[a-f0-9]{64}$/i.test(get('S3_SECRET_ACCESS_KEY'))) warnings.push('S3_SECRET_ACCESS_KEY is not 64 hex characters, which is what R2 gives for an S3 token.');
  if (need('PUBLIC_MEDIA_BASE_URL')) {
    const m = get('PUBLIC_MEDIA_BASE_URL');
    if (!/^https:\/\//.test(m)) problems.push('PUBLIC_MEDIA_BASE_URL must be https (Buffer fetches the images from it).');
    if (/\/$/.test(m)) problems.push('PUBLIC_MEDIA_BASE_URL must not end with a slash.');
    if (/\.r2\.dev/.test(m)) warnings.push('PUBLIC_MEDIA_BASE_URL is an r2.dev address: use it for testing with synthetic or non-sensitive photographs only. Anything copied to it is publicly readable by anyone with the link, Cloudflare rate-limits it, and it is not a production address.');
    if (/r2\.cloudflarestorage\.com/.test(m)) problems.push('PUBLIC_MEDIA_BASE_URL must be the PUBLIC address of the public bucket, not the private S3 endpoint.');
  }
  if (skipBuffer) return { problems, warnings };
  if (need('BUFFER_API_TOKEN') && get('BUFFER_API_TOKEN').length < 20) warnings.push('BUFFER_API_TOKEN looks too short to be a Buffer key.');
  if (get('BUFFER_ENV') !== 'staging') problems.push('BUFFER_ENV must be "staging" for these tests.');
  if (!HEX24.test(get('BUFFER_STAGING_CHANNEL_ID'))) problems.push('BUFFER_STAGING_CHANNEL_ID must be the 24-character channel id.');
  if (get('BUFFER_CHANNEL_ID_LINKEDIN') && get('BUFFER_CHANNEL_ID_LINKEDIN') === get('BUFFER_STAGING_CHANNEL_ID')) warnings.push('BUFFER_CHANNEL_ID_LINKEDIN equals the staging channel. Leave it empty until JNR\'s own page is connected.');
  if (/^(1|true|yes|on)$/i.test(get('AI_CAPTIONS_ENABLED'))) problems.push('AI_CAPTIONS_ENABLED is on. Leave it off: it is a paid API.');
  if (/^(1|true|yes|on)$/i.test(get('TOLRA_ENABLED'))) problems.push('TOLRA_ENABLED is on. Leave it off.');
  if (/^(1|true|yes|on)$/i.test(get('ALLOW_INSECURE_COOKIES'))) warnings.push('ALLOW_INSECURE_COOKIES is set. It is ignored on Vercel but should not be in a staging file.');
  return { problems, warnings };
}

module.exports = { lint };
