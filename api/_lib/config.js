'use strict';

// All settings are read from the environment when used, never at import time, so tests can change them.
// Names only are listed in .env.example. Never commit values.

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function flag(name, fallback) {
  const v = env(name);
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function getConfig() {
  const bufferEnv = env('BUFFER_ENV', 'staging') === 'production' ? 'production' : 'staging';
  return {
    databaseUrl: env('DATABASE_URL'),
    siteUrl: env('SITE_URL', 'https://jnrengineering.co.uk').replace(/\/$/, ''),
    cookieSecure: !flag('ALLOW_INSECURE_COOKIES', false),
    allowedOrigins: env('ALLOWED_ORIGINS', '').split(',').map((s) => s.trim()).filter(Boolean),
    sessionHours: Number(env('SESSION_HOURS', '12')),
    storage: {
      endpoint: env('S3_ENDPOINT'),
      region: env('S3_REGION', 'auto'),
      accessKeyId: env('S3_ACCESS_KEY_ID'),
      secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
      privateBucket: env('S3_BUCKET_PRIVATE'),
      publicBucket: env('S3_BUCKET_PUBLIC'),
      publicBaseUrl: (env('PUBLIC_MEDIA_BASE_URL', '') || '').replace(/\/$/, ''),
      pathStyle: flag('S3_FORCE_PATH_STYLE', true),
    },
    upload: {
      maxBytes: Number(env('UPLOAD_MAX_BYTES', String(25 * 1024 * 1024))),
      maxPerEntry: Number(env('UPLOAD_MAX_PER_ENTRY', '12')),
      presignSeconds: 600,
    },
    caption: {
      // 'template' is free and offline. 'anthropic' calls a paid API: it stays off until AI_CAPTIONS_ENABLED=true.
      aiEnabled: flag('AI_CAPTIONS_ENABLED', false),
      apiKey: env('ANTHROPIC_API_KEY'),
      model: env('AI_CAPTION_MODEL', 'claude-haiku-5-5'),
      apiUrl: env('ANTHROPIC_API_URL', 'https://api.anthropic.com/v1/messages'),
    },
    buffer: {
      apiUrl: env('BUFFER_API_URL', 'https://api.buffer.com'),
      token: env('BUFFER_API_TOKEN'),
      env: bufferEnv,
      // Staging may only ever target the staging channel (the personal LinkedIn profile used for tests).
      stagingChannelId: env('BUFFER_STAGING_CHANNEL_ID'),
      // Production target, set when JNR's own LinkedIn page is connected to Buffer.
      linkedinChannelId: env('BUFFER_CHANNEL_ID_LINKEDIN'),
      retryDelaysMs: (env('BUFFER_RETRY_DELAYS_MS', '500,2000')).split(',').map(Number),
      timeoutMs: Number(env('BUFFER_TIMEOUT_MS', '15000')),
    },
    tolra: {
      enabled: flag('TOLRA_ENABLED', false),
      url: env('TOLRA_READ_URL'),
      token: env('TOLRA_READ_TOKEN'),
    },
  };
}

// Which LinkedIn channel a publish may use, given the environment. Throws if it is not configured safely.
function linkedinChannel(cfg) {
  const b = (cfg || getConfig()).buffer;
  if (b.env === 'production') {
    if (!b.linkedinChannelId) throw new Error('BUFFER_CHANNEL_ID_LINKEDIN is not set');
    return b.linkedinChannelId;
  }
  if (!b.stagingChannelId) throw new Error('BUFFER_STAGING_CHANNEL_ID is not set');
  return b.stagingChannelId;
}

module.exports = { getConfig, linkedinChannel, env, flag };
