'use strict';

const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
];

const VALID_STUN = /^stuns?:[^\s]+$/i;
const VALID_TURN = /^turns?:[^\s]+$/i;

function parseList(value, fallback = []) {
  if (typeof value !== 'string' || value.trim() === '') return [...fallback];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseInteger(value, fallback, { min, max, name }) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function normalizeOrigin(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http or https.`);
  }
  return url.origin;
}

function normalizeUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http or https.`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an origin without a path, query or hash.`);
  }
  return url.origin;
}

function validateIceUrls(urls, pattern, name) {
  for (const url of urls) {
    if (!pattern.test(url)) {
      throw new Error(`${name} contains an invalid ICE server URL: ${url}`);
    }
  }
}

function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const port = parseInteger(env.PORT, 3000, {
    min: 0,
    max: 65535,
    name: 'PORT',
  });

  const fallbackUrl = env.RENDER_EXTERNAL_URL || `http://localhost:${port || 3000}`;
  const appUrl = normalizeUrl(env.APP_URL || fallbackUrl, 'APP_URL');
  const corsOrigins = parseList(env.CORS_ORIGINS).map((origin) =>
    normalizeOrigin(origin, 'CORS_ORIGINS'),
  );

  const stunUrls = parseList(env.STUN_URLS, DEFAULT_STUN_URLS);
  validateIceUrls(stunUrls, VALID_STUN, 'STUN_URLS');

  const turnUrls = parseList(env.TURN_URLS);
  validateIceUrls(turnUrls, VALID_TURN, 'TURN_URLS');
  const turnUsername = env.TURN_USERNAME || '';
  const turnCredential = env.TURN_CREDENTIAL || '';
  if (turnUrls.length > 0 && (!turnUsername || !turnCredential)) {
    throw new Error(
      'TURN_USERNAME and TURN_CREDENTIAL are required when TURN_URLS is set.',
    );
  }

  const iceServers = [];
  if (stunUrls.length > 0) iceServers.push({ urls: stunUrls });
  if (turnUrls.length > 0) {
    iceServers.push({
      urls: turnUrls,
      username: turnUsername,
      credential: turnCredential,
    });
  }

  const logLevel = (env.LOG_LEVEL || 'info').toLowerCase();
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(logLevel)) {
    throw new Error('LOG_LEVEL must be one of debug, info, warn, error, silent.');
  }

  const maxParticipants = parseInteger(env.MAX_PARTICIPANTS, 8, {
    min: 2,
    max: 12,
    name: 'MAX_PARTICIPANTS',
  });
  const roomTtlMinutes = parseInteger(env.ROOM_TTL_MINUTES, 180, {
    min: 5,
    max: 1440,
    name: 'ROOM_TTL_MINUTES',
  });

  return {
    env: nodeEnv,
    isProduction,
    port,
    appUrl,
    appOrigin: new URL(appUrl).origin,
    corsOrigins: Array.from(new Set(corsOrigins)),
    trustProxy:
      env.TRUST_PROXY === 'true' || (isProduction && env.TRUST_PROXY !== 'false'),
    iceServers,
    turnConfigured: turnUrls.length > 0,
    maxParticipants,
    roomTtlMs: roomTtlMinutes * 60 * 1000,
    emptyRoomTtlMs: roomTtlMinutes * 60 * 1000,
    endedRoomTtlMs: 5 * 60 * 1000,
    waitingTtlMs: 10 * 60 * 1000,
    disconnectGraceMs: 20 * 1000,
    removalBlockMs: 10 * 60 * 1000,
    removalIpBlockMs: 2 * 60 * 1000,
    maxWaitingRequests: 20,
    chatHistoryLimit: 100,
    maxChatLength: 2000,
    maxDisplayNameLength: 48,
    maxTitleLength: 80,
    rateLimits: {
      apiPerMinute: parseInteger(env.RATE_LIMIT_API_PER_MINUTE, 180, {
        min: 10,
        max: 10000,
        name: 'RATE_LIMIT_API_PER_MINUTE',
      }),
      createPerTenMinutes: parseInteger(env.RATE_LIMIT_CREATE_PER_10_MINUTES, 30, {
        min: 1,
        max: 1000,
        name: 'RATE_LIMIT_CREATE_PER_10_MINUTES',
      }),
      lookupPerMinute: parseInteger(env.RATE_LIMIT_LOOKUP_PER_MINUTE, 120, {
        min: 10,
        max: 10000,
        name: 'RATE_LIMIT_LOOKUP_PER_MINUTE',
      }),
      socketConnectsPerMinute: parseInteger(env.RATE_LIMIT_SOCKET_CONNECTS_PER_MINUTE, 60, {
        min: 5,
        max: 10000,
        name: 'RATE_LIMIT_SOCKET_CONNECTS_PER_MINUTE',
      }),
      joinsPerMinute: 20,
      chatPerTenSeconds: 8,
      signalingPerMinute: 600,
    },
    logLevel,
  };
}

module.exports = { loadConfig, DEFAULT_STUN_URLS };
