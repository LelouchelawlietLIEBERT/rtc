'use strict';

const crypto = require('node:crypto');
const { io } = require('socket.io-client');
const { loadConfig } = require('../lib/config');
const { createApplication } = require('../lib/app');

const APP_URL = 'http://127.0.0.1:3000';

function buildConfig(overrides = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    PORT: '0',
    APP_URL,
    LOG_LEVEL: 'silent',
    RATE_LIMIT_API_PER_MINUTE: '10000',
    RATE_LIMIT_CREATE_PER_10_MINUTES: '1000',
    RATE_LIMIT_LOOKUP_PER_MINUTE: '10000',
    RATE_LIMIT_SOCKET_CONNECTS_PER_MINUTE: '10000',
    ...overrides,
  });
}

async function startApp(options = {}) {
  const config = buildConfig(options.env || {});
  if (typeof options.configure === 'function') options.configure(config);

  const application = createApplication({ config });
  const address = await application.start(0);
  const base = `http://127.0.0.1:${address.port}`;
  const sockets = [];

  return {
    application,
    base,
    config,
    async socket(extra = {}) {
      const socket = await openSocket(base, extra);
      sockets.push(socket);
      return socket;
    },
    async close() {
      for (const socket of sockets) {
        try {
          socket.removeAllListeners();
          socket.close();
        } catch {
          // Ignore socket teardown failures.
        }
      }
      await application.stop();
    },
  };
}

function newClientId() {
  return crypto.randomBytes(18).toString('hex');
}

function openSocket(base, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = io(base, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      timeout: 4000,
      ...options,
    });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Timed out connecting to Socket.IO.'));
    }, 4000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });
}

function emitAck(socket, event, payload = {}, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for an acknowledgement from ${event}.`));
    }, timeout);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function onceEvent(socket, event, options = {}) {
  const timeout = options.timeout || 4000;
  const predicate = options.predicate || (() => true);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}.`));
    }, timeout);

    function handler(payload) {
      let matches = false;
      try {
        matches = predicate(payload);
      } catch {
        matches = false;
      }
      if (!matches) return;
      cleanup();
      resolve(payload);
    }

    function cleanup() {
      clearTimeout(timer);
      socket.off(event, handler);
    }

    socket.on(event, handler);
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(base, path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

async function createRoom(base, options = {}) {
  const { response, body } = await api(base, '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: options.title || 'Test meeting',
      privacy: options.privacy || 'public',
    }),
  });
  if (response.status !== 201) {
    throw new Error(`Room creation failed with ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function join(socket, payload) {
  return emitAck(socket, 'room:join', payload);
}

async function joinHost(ctx, room, displayName = 'Host') {
  const socket = await ctx.socket();
  const clientId = newClientId();
  const response = await join(socket, {
    code: room.room.code,
    displayName,
    clientId,
    hostToken: room.hostToken,
  });
  if (!response || response.ok !== true) {
    throw new Error(`Host join failed: ${JSON.stringify(response)}`);
  }
  return { socket, clientId, response };
}

async function joinGuest(ctx, code, displayName = 'Guest') {
  const socket = await ctx.socket();
  const clientId = newClientId();
  const response = await join(socket, { code, displayName, clientId });
  return { socket, clientId, response };
}

module.exports = {
  APP_URL,
  api,
  buildConfig,
  createRoom,
  emitAck,
  join,
  joinGuest,
  joinHost,
  newClientId,
  onceEvent,
  startApp,
  wait,
};
