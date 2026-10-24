'use strict';

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const nunjucks = require('nunjucks');
const { Server } = require('socket.io');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { RateLimiter, expressRateLimit } = require('./rate-limit');
const { RoomStore } = require('./rooms');
const { attachRealtime } = require('./realtime');
const validation = require('./validation');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VIEWS_DIR = path.join(ROOT, 'views');
const LUCIDE_FILE = path.join(
  ROOT,
  'node_modules',
  'lucide',
  'dist',
  'umd',
  'lucide.min.js',
);

function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function securityHeaders(config) {
  return function applySecurityHeaders(req, res, next) {
    const connectSources = ["'self'", 'ws:', 'wss:'].join(' ');
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "media-src 'self' blob:",
      `connect-src ${connectSources}`,
      "worker-src 'self' blob:",
    ].join('; ');

    res.set('Content-Security-Policy', csp);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    res.set('Cross-Origin-Resource-Policy', 'same-origin');
    res.set(
      'Permissions-Policy',
      'camera=(self), microphone=(self), display-capture=(self), fullscreen=(self), geolocation=(), payment=()',
    );
    if (config.isProduction) {
      res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

function requestOriginFromHeaders(request, trustProxy = false) {
  const headers = request.headers || {};
  let protocol = request.socket && request.socket.encrypted ? 'https' : 'http';
  if (trustProxy) {
    const forwardedProto = headers['x-forwarded-proto'];
    if (typeof forwardedProto === 'string' && forwardedProto.trim()) {
      protocol = forwardedProto.split(',')[0].trim();
    }
  }
  const forwardedHost =
    trustProxy && typeof headers['x-forwarded-host'] === 'string'
      ? headers['x-forwarded-host'].split(',')[0].trim()
      : '';
  const host = forwardedHost || headers.host;
  if (!host) return null;
  return normalizeOrigin(`${protocol}://${host}`);
}

function corsMiddleware(config) {
  const allowedOrigins = new Set([config.appOrigin, ...config.corsOrigins]);
  if (!config.isProduction) {
    allowedOrigins.add('http://localhost:3000');
    allowedOrigins.add('http://127.0.0.1:3000');
  }

  return function applyCors(req, res, next) {
    const origin = req.get('origin');
    if (!origin) return next();

    const normalized = normalizeOrigin(origin);
    // Same-origin requests are always allowed, even when APP_URL points at a
    // different hostname (for example when opening the app via 127.0.0.1).
    const sameOrigin = Boolean(
      normalized && normalized === requestOriginFromHeaders(req, config.trustProxy),
    );
    const allowed = Boolean(normalized && (allowedOrigins.has(normalized) || sameOrigin));

    if (allowed) {
      res.set('Access-Control-Allow-Origin', normalized);
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Access-Control-Max-Age', '600');
      res.vary('Origin');
    }

    if (req.method === 'OPTIONS') {
      return allowed ? res.status(204).end() : res.status(403).json({
        error: 'forbidden_origin',
        message: 'This origin is not allowed.',
      });
    }

    if (!allowed && req.method !== 'GET' && req.method !== 'HEAD') {
      return res.status(403).json({
        error: 'forbidden_origin',
        message: 'This origin is not allowed.',
      });
    }

    return next();
  };
}

function createSocketIo(server, config) {
  const allowedOrigins = new Set([config.appOrigin, ...config.corsOrigins]);
  if (!config.isProduction) {
    allowedOrigins.add('http://localhost:3000');
    allowedOrigins.add('http://127.0.0.1:3000');
  }

  function originAllowed(origin, request) {
    if (!origin) return true;
    const normalized = normalizeOrigin(origin);
    if (!normalized) return false;
    if (allowedOrigins.has(normalized)) return true;
    return normalized === requestOriginFromHeaders(request, config.trustProxy);
  }

  return new Server(server, {
    // Browser clients are same-origin. Reflecting the origin here lets the
    // engine complete CORS preflights; allowRequest below is the actual gate.
    cors: {
      origin: true,
      methods: ['GET', 'POST'],
    },
    allowRequest(request, callback) {
      callback(null, originAllowed(request.headers.origin, request));
    },
    maxHttpBufferSize: 256 * 1024,
    pingInterval: 25000,
    pingTimeout: 25000,
    serveClient: true,
  });
}

function requestLogger(logger) {
  return function logRequests(req, res, next) {
    if (
      req.path === '/healthz' ||
      req.path === '/health' ||
      req.path.startsWith('/socket.io') ||
      req.path.startsWith('/vendor') ||
      /\.(?:css|js|svg|ico|txt|map)$/.test(req.path)
    ) {
      return next();
    }
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger.info('request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Math.round(elapsedMs),
      });
    });
    return next();
  };
}

function createApplication(options = {}) {
  const config = options.config || loadConfig();
  const logger = options.logger || createLogger(config.logLevel);
  const app = express();
  const server = http.createServer(app);
  const io = createSocketIo(server, config);

  const store = new RoomStore({
    maxParticipants: config.maxParticipants,
    emptyRoomTtlMs: config.emptyRoomTtlMs,
    endedRoomTtlMs: config.endedRoomTtlMs,
    waitingTtlMs: config.waitingTtlMs,
    maxWaitingRequests: config.maxWaitingRequests,
    chatHistoryLimit: config.chatHistoryLimit,
    maxDisplayNameLength: config.maxDisplayNameLength,
  });

  const apiLimiter = new RateLimiter({
    limit: config.rateLimits.apiPerMinute,
    windowMs: 60 * 1000,
    name: 'api',
  });
  const createLimiter = new RateLimiter({
    limit: config.rateLimits.createPerTenMinutes,
    windowMs: 10 * 60 * 1000,
    name: 'room-create',
  });
  const lookupLimiter = new RateLimiter({
    limit: config.rateLimits.lookupPerMinute,
    windowMs: 60 * 1000,
    name: 'room-lookup',
  });

  const realtime = attachRealtime({ io, store, config, logger });

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'njk');
  app.set('views', VIEWS_DIR);

  nunjucks.configure(VIEWS_DIR, {
    autoescape: true,
    express: app,
    watch: false,
    noCache: !config.isProduction,
  });

  app.use(securityHeaders(config));
  app.use(corsMiddleware(config));
  app.use(requestLogger(logger));
  app.use(
    express.json({
      limit: '32kb',
      type: 'application/json',
      strict: true,
    }),
  );

  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      etag: true,
      maxAge: config.isProduction ? '1h' : 0,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
      },
    }),
  );

  app.get('/vendor/lucide.min.js', (req, res, next) => {
    res.sendFile(LUCIDE_FILE, {
      maxAge: config.isProduction ? '7d' : 0,
      headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
    }, (error) => {
      if (error) next(error);
    });
  });

  app.get('/favicon.ico', (req, res) => {
    res.redirect(301, '/favicon.svg');
  });

  app.get('/health', (req, res) => sendHealth(res));
  app.get('/healthz', (req, res) => sendHealth(res));

  function sendHealth(res) {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      version: pkg.version,
      rooms: store.stats(),
      timestamp: new Date().toISOString(),
    });
  }

  app.use('/api', expressRateLimit(apiLimiter));

  app.post(
    '/api/rooms',
    expressRateLimit(createLimiter),
    (req, res) => {
      if (!req.is('application/json')) {
        return res.status(415).json({
          error: 'unsupported_media_type',
          message: 'Send the request as application/json.',
        });
      }
      const body = validation.isPlainObject(req.body) ? req.body : {};
      const title =
        validation.normalizeTitle(body.title, config.maxTitleLength) || 'Untitled meeting';
      const privacy = validation.normalizePrivacy(body.privacy);
      const { room, hostToken } = store.create({ title, privacy });
      const inviteUrl = `${config.appUrl}/room/${room.code}`;

      logger.info('meeting created', {
        room: room.code,
        privacy: room.privacy,
      });

      return res.status(201).json({
        ok: true,
        room: store.summary(room),
        hostToken,
        inviteUrl,
      });
    },
  );

  app.get(
    '/api/rooms/:code',
    expressRateLimit(lookupLimiter),
    (req, res) => {
      const code = validation.normalizeRoomCode(req.params.code);
      if (!validation.isValidRoomCode(code)) {
        return res.status(400).json({
          error: 'invalid_room',
          message: 'That meeting code is not valid.',
        });
      }
      const room = store.get(code);
      if (!room) {
        return res.status(404).json({
          error: 'room_not_found',
          message: 'This meeting does not exist or has expired.',
        });
      }
      if (room.ended) {
        return res.status(410).json({
          error: 'room_ended',
          message: 'This meeting has ended.',
        });
      }
      const summary = store.summary(room);
      return res.json({
        ok: true,
        room: {
          code: summary.code,
          title: summary.title,
          privacy: summary.privacy,
          createdAt: summary.createdAt,
          participantCount: summary.participantCount,
          capacity: summary.capacity,
        },
      });
    },
  );

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not_found', message: 'That API endpoint does not exist.' });
  });

  app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.render('home', {
      appName: 'RTC',
      appUrl: config.appUrl,
      maxParticipants: config.maxParticipants,
    });
  });

  app.get('/room', (req, res) => {
    const code = validation.normalizeRoomCode(req.query.id || req.query.code || '');
    if (validation.isValidRoomCode(code)) {
      return res.redirect(307, `/room/${code}`);
    }
    return res.redirect(302, '/');
  });

  app.get('/r/:code', (req, res) => {
    const code = validation.normalizeRoomCode(req.params.code);
    if (validation.isValidRoomCode(code)) return res.redirect(301, `/room/${code}`);
    return res.redirect(302, '/');
  });

  app.get('/room/:code', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const code = validation.normalizeRoomCode(req.params.code);
    if (!validation.isValidRoomCode(code)) {
      return res.status(404).render('error', {
        appName: 'RTC',
        statusCode: 404,
        title: 'Meeting not found',
        message: 'That meeting code is not valid. Check the link and try again.',
        actionHref: '/',
        actionLabel: 'Back to home',
      });
    }

    const room = store.get(code);
    if (!room) {
      return res.status(404).render('error', {
        appName: 'RTC',
        statusCode: 404,
        title: 'Meeting not found',
        message: 'This meeting does not exist or has expired.',
        actionHref: '/',
        actionLabel: 'Back to home',
      });
    }
    if (room.ended) {
      return res.status(410).render('error', {
        appName: 'RTC',
        statusCode: 410,
        title: 'Meeting ended',
        message: 'This meeting has already ended. Ask the host for a new link.',
        actionHref: '/',
        actionLabel: 'Back to home',
      });
    }

    return res.render('room', {
      appName: 'RTC',
      appUrl: config.appUrl,
      room: store.summary(room),
      maxParticipants: room.maxParticipants,
      lucideAvailable: true,
    });
  });

  app.use((req, res) => {
    res.status(404).render('error', {
      appName: 'RTC',
      statusCode: 404,
      title: 'Page not found',
      message: 'The page you are looking for does not exist.',
      actionHref: '/',
      actionLabel: 'Back to home',
    });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);

    const status = Number(error.status) || 500;
    if (status >= 500) {
      logger.error('request failed', {
        method: req.method,
        path: req.path,
        message: error.message,
      });
    }

    const message =
      status === 400
        ? 'The request could not be processed.'
        : status === 413
          ? 'The request is too large.'
          : 'Something went wrong on our side.';

    if (req.path.startsWith('/api') || req.is('application/json')) {
      return res.status(status).json({
        error: status === 400 ? 'bad_request' : status === 413 ? 'payload_too_large' : 'server_error',
        message,
      });
    }
    return res.status(status).render('error', {
      appName: 'RTC',
      statusCode: status,
      title: 'Something went wrong',
      message,
      actionHref: '/',
      actionLabel: 'Back to home',
    });
  });

  function start(port = config.port) {
    return new Promise((resolve, reject) => {
      function onError(error) {
        server.off('listening', onListening);
        reject(error);
      }
      function onListening() {
        server.off('error', onError);
        resolve(server.address());
      }
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '0.0.0.0');
    });
  }

  function stop() {
    realtime.stop();
    store.stop();
    apiLimiter.stop();
    createLimiter.stop();
    lookupLimiter.stop();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      io.close(finish);
      setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        finish();
      }, 5000).unref?.();
    });
  }

  return {
    app,
    server,
    io,
    store,
    config,
    logger,
    start,
    stop,
    limiters: { apiLimiter, createLimiter, lookupLimiter },
  };
}

module.exports = {
  createApplication,
  normalizeOrigin,
  requestOriginFromHeaders,
  securityHeaders,
  corsMiddleware,
};
