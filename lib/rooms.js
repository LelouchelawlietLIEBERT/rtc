'use strict';

const crypto = require('node:crypto');
const {
  normalizeTitle,
  normalizePrivacy,
  isValidToken,
  normalizeDisplayName,
} = require('./validation');

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function randomFromAlphabet(length) {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return value;
}

function generateRoomCode(privacy) {
  if (privacy === 'private') {
    return [6, 6, 6, 6].map((size) => randomFromAlphabet(size)).join('-');
  }
  return [3, 4, 3].map((size) => randomFromAlphabet(size)).join('-');
}

function randomId(bytes = 9) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

function safeHashEqual(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const candidateBuffer = Buffer.from(candidate, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (candidateBuffer.length !== expectedBuffer.length || candidateBuffer.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
}

function verifySecret(secret, expectedHash) {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  return safeHashEqual(hashSecret(secret), expectedHash);
}

function defaultState() {
  return { mic: true, camera: true, sharing: false, hand: false };
}

function publicParticipant(participant) {
  return {
    id: participant.id,
    name: participant.name,
    isHost: participant.isHost,
    connected: participant.connected,
    joinedAt: participant.joinedAt,
    state: { ...participant.state },
  };
}

class RoomStore {
  constructor(options) {
    this.maxParticipants = options.maxParticipants;
    this.emptyRoomTtlMs = options.emptyRoomTtlMs;
    this.endedRoomTtlMs = options.endedRoomTtlMs;
    this.waitingTtlMs = options.waitingTtlMs;
    this.maxWaitingRequests = options.maxWaitingRequests || 20;
    this.chatHistoryLimit = options.chatHistoryLimit;
    this.maxDisplayNameLength = options.maxDisplayNameLength;
    this.rooms = new Map();
    this.startedAt = Date.now();
    this.cleanupTimer = setInterval(() => this.cleanup(), 60000);
    this.cleanupTimer.unref?.();
  }

  create({ title, privacy, now = Date.now() }) {
    const normalizedPrivacy = normalizePrivacy(privacy);
    const roomTitle = normalizeTitle(title) || 'Untitled meeting';
    let code = generateRoomCode(normalizedPrivacy);
    let attempts = 0;
    while (this.rooms.has(code) && attempts < 20) {
      code = generateRoomCode(normalizedPrivacy);
      attempts += 1;
    }
    if (this.rooms.has(code)) {
      throw new Error('Unable to allocate a unique room code.');
    }

    const hostToken = randomToken();
    const room = {
      code,
      title: roomTitle,
      privacy: normalizedPrivacy,
      createdAt: now,
      lastActivity: now,
      hostTokenHash: hashSecret(hostToken),
      maxParticipants: this.maxParticipants,
      participants: new Map(),
      waiting: new Map(),
      messages: [],
      blockedClientIds: new Map(),
      blockedIps: new Map(),
      ended: false,
      endedAt: null,
      endedReason: null,
    };

    this.rooms.set(code, room);
    return { room, hostToken };
  }

  get(code) {
    return this.rooms.get(code) || null;
  }

  getActive(code) {
    const room = this.rooms.get(code);
    if (!room || room.ended) return null;
    return room;
  }

  isHostToken(room, token) {
    if (!room || room.ended) return false;
    if (!isValidToken(token)) return false;
    return verifySecret(token, room.hostTokenHash);
  }

  addParticipant(room, options) {
    if (!room || room.ended) return null;
    if (room.participants.size >= room.maxParticipants) return null;

    const now = options.now || Date.now();
    const token = randomToken();
    const participant = {
      id: randomId(9),
      socketId: options.socketId,
      name: normalizeDisplayName(options.name, this.maxDisplayNameLength) || 'Guest',
      clientId: options.clientId,
      clientIdHash: hashSecret(options.clientId),
      tokenHash: hashSecret(token),
      isHost: Boolean(options.isHost),
      state: { ...defaultState(), ...(options.state || {}) },
      connected: true,
      joinedAt: now,
      disconnectedAt: null,
    };

    room.participants.set(participant.id, participant);
    room.lastActivity = now;
    return { participant, token };
  }

  getParticipant(room, participantId) {
    return room ? room.participants.get(participantId) || null : null;
  }

  getParticipantBySocket(room, socketId) {
    if (!room) return null;
    for (const participant of room.participants.values()) {
      if (participant.socketId === socketId) return participant;
    }
    return null;
  }

  getParticipantByToken(room, token) {
    if (!room || !isValidToken(token)) return null;
    const hash = hashSecret(token);
    for (const participant of room.participants.values()) {
      if (safeHashEqual(hash, participant.tokenHash)) return participant;
    }
    return null;
  }

  verifyParticipantToken(participant, token) {
    return Boolean(participant) && verifySecret(token, participant.tokenHash);
  }

  verifyParticipantClient(participant, clientId) {
    return Boolean(participant) && safeHashEqual(
      hashSecret(clientId),
      participant.clientIdHash,
    );
  }

  removeParticipant(room, participantId) {
    if (!room) return null;
    const participant = room.participants.get(participantId) || null;
    if (!participant) return null;
    room.participants.delete(participantId);
    room.lastActivity = Date.now();
    return participant;
  }

  connectedParticipants(room) {
    if (!room) return [];
    return Array.from(room.participants.values()).filter((participant) => participant.connected);
  }

  publicParticipants(room) {
    if (!room) return [];
    return Array.from(room.participants.values())
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map(publicParticipant);
  }

  connectedPublicParticipants(room) {
    if (!room) return [];
    return Array.from(room.participants.values())
      .filter((participant) => participant.connected)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map(publicParticipant);
  }

  hostSocketIds(room) {
    if (!room) return [];
    return Array.from(room.participants.values())
      .filter((participant) => participant.isHost && participant.connected)
      .map((participant) => participant.socketId);
  }

  hostConnected(room) {
    return Boolean(room) && Array.from(room.participants.values()).some(
      (participant) => participant.isHost && participant.connected,
    );
  }

  addWaiting(room, options) {
    if (!room || room.ended) return null;
    if (room.participants.size >= room.maxParticipants) return null;
    if (room.waiting.size >= this.maxWaitingRequests) return null;

    const request = {
      id: randomId(9),
      socketId: options.socketId,
      name: normalizeDisplayName(options.name, this.maxDisplayNameLength) || 'Guest',
      clientId: options.clientId,
      clientIdHash: hashSecret(options.clientId),
      ipHash: hashSecret(options.ip || 'unknown'),
      state: { ...defaultState(), ...(options.state || {}) },
      requestedAt: Date.now(),
    };
    room.waiting.set(request.id, request);
    room.lastActivity = Date.now();
    return request;
  }

  getWaiting(room, requestId) {
    return room ? room.waiting.get(requestId) || null : null;
  }

  waitingForSocket(room, socketId) {
    if (!room) return null;
    for (const request of room.waiting.values()) {
      if (request.socketId === socketId) return request;
    }
    return null;
  }

  removeWaiting(room, requestId) {
    if (!room) return null;
    const request = room.waiting.get(requestId) || null;
    if (request) room.waiting.delete(requestId);
    return request;
  }

  publicWaiting(room) {
    if (!room) return [];
    return Array.from(room.waiting.values())
      .sort((a, b) => a.requestedAt - b.requestedAt)
      .map((request) => ({
        id: request.id,
        name: request.name,
        requestedAt: request.requestedAt,
      }));
  }

  isBlocked(room, { clientId, ip }) {
    if (!room) return false;
    const now = Date.now();
    const clientHash = clientId ? hashSecret(clientId) : null;
    const ipHash = ip ? hashSecret(ip) : null;

    const clientExpiry = clientHash ? room.blockedClientIds.get(clientHash) : 0;
    if (clientExpiry && clientExpiry > now) return true;
    if (clientExpiry) room.blockedClientIds.delete(clientHash);

    const ipExpiry = ipHash ? room.blockedIps.get(ipHash) : 0;
    if (ipExpiry && ipExpiry > now) return true;
    if (ipExpiry) room.blockedIps.delete(ipHash);

    return false;
  }

  block(room, { clientId, ip }, durationMs) {
    if (!room) return;
    const until = Date.now() + durationMs;
    if (clientId) room.blockedClientIds.set(hashSecret(clientId), until);
    if (ip) room.blockedIps.set(hashSecret(ip), until);
  }

  addMessage(room, message) {
    if (!room) return null;
    room.messages.push(message);
    while (room.messages.length > this.chatHistoryLimit) room.messages.shift();
    room.lastActivity = Date.now();
    return message;
  }

  messages(room) {
    return room ? room.messages.map((message) => ({ ...message })) : [];
  }

  end(room, reason = 'ended') {
    if (!room || room.ended) return false;
    room.ended = true;
    room.endedAt = Date.now();
    room.endedReason = reason;
    room.waiting.clear();
    room.lastActivity = room.endedAt;
    return true;
  }

  delete(code) {
    return this.rooms.delete(code);
  }

  summary(room) {
    if (!room) return null;
    return {
      code: room.code,
      title: room.title,
      privacy: room.privacy,
      createdAt: room.createdAt,
      participantCount: room.participants.size,
      capacity: room.maxParticipants,
      waitingCount: room.waiting.size,
      ended: room.ended,
      endedAt: room.endedAt,
    };
  }

  cleanup(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      if (room.ended) {
        if (room.endedAt && now - room.endedAt > this.endedRoomTtlMs) {
          this.rooms.delete(code);
        }
        continue;
      }

      for (const [hash, expiry] of room.blockedClientIds) {
        if (expiry <= now) room.blockedClientIds.delete(hash);
      }
      for (const [hash, expiry] of room.blockedIps) {
        if (expiry <= now) room.blockedIps.delete(hash);
      }

      if (
        room.participants.size === 0 &&
        room.waiting.size === 0 &&
        now - room.lastActivity > this.emptyRoomTtlMs
      ) {
        this.rooms.delete(code);
      }
    }
  }

  stats() {
    let activeRooms = 0;
    let participants = 0;
    let waiting = 0;
    for (const room of this.rooms.values()) {
      if (room.ended) continue;
      activeRooms += 1;
      participants += room.participants.size;
      waiting += room.waiting.size;
    }
    return { activeRooms, participants, waiting };
  }

  stop() {
    clearInterval(this.cleanupTimer);
  }
}

module.exports = {
  RoomStore,
  generateRoomCode,
  hashSecret,
  publicParticipant,
};
