'use strict';

const crypto = require('node:crypto');
const { RateLimiter } = require('./rate-limit');
const { publicParticipant } = require('./rooms');
const validation = require('./validation');

function getClientIp(socket, trustProxy) {
  let ip = socket.handshake.address || '';
  if (trustProxy) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      ip = forwarded.split(',')[0].trim();
    }
  }
  return ip.replace(/^::ffff:/, '') || 'unknown';
}

function attachRealtime({ io, store, config, logger }) {
  const limiters = {
    connect: new RateLimiter({
      limit: config.rateLimits.socketConnectsPerMinute,
      windowMs: 60 * 1000,
      name: 'socket-connect',
    }),
    join: new RateLimiter({
      limit: config.rateLimits.joinsPerMinute,
      windowMs: 60 * 1000,
      name: 'socket-join',
    }),
    chat: new RateLimiter({
      limit: config.rateLimits.chatPerTenSeconds,
      windowMs: 10 * 1000,
      name: 'chat',
    }),
    signaling: new RateLimiter({
      limit: config.rateLimits.signalingPerMinute,
      windowMs: 60 * 1000,
      name: 'signaling',
    }),
  };

  const disconnectTimers = new Map();

  function timerKey(code, participantId) {
    return `${code}:${participantId}`;
  }

  function clearDisconnectTimer(code, participantId) {
    const key = timerKey(code, participantId);
    const timer = disconnectTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      disconnectTimers.delete(key);
    }
  }

  function reply(ack, payload) {
    if (typeof ack === 'function') {
      try {
        ack(payload);
      } catch {
        // A failing acknowledgement must never crash the server.
      }
    }
  }

  function failure(ack, code, message, extra = {}) {
    reply(ack, { ok: false, code, message, ...extra });
  }

  function currentContext(socket) {
    const code = socket.data.roomId;
    if (!code) return null;
    const room = store.getActive(code);
    if (!room) return null;
    const participant = store.getParticipant(room, socket.data.participantId);
    if (!participant || participant.socketId !== socket.id || !participant.connected) {
      return null;
    }
    return { room, participant };
  }

  function joinPayload(room, participant) {
    return {
      room: {
        code: room.code,
        title: room.title,
        privacy: room.privacy,
        createdAt: room.createdAt,
        participantCount: room.participants.size,
        capacity: room.maxParticipants,
      },
      self: publicParticipant(participant),
      peers: store
        .connectedPublicParticipants(room)
        .filter((peer) => peer.id !== participant.id),
      messages: store.messages(room),
      iceServers: config.iceServers,
      turnConfigured: config.turnConfigured,
      hostConnected: store.hostConnected(room),
      waitingRequests: participant.isHost ? store.publicWaiting(room) : [],
      serverTime: Date.now(),
    };
  }

  function emitWaitingList(room) {
    if (!room || room.ended) return;
    const requests = store.publicWaiting(room);
    for (const socketId of store.hostSocketIds(room)) {
      io.to(socketId).emit('room:waiting-list', {
        requests,
        count: requests.length,
      });
    }
  }

  function notifyPeerJoined(room, participant, resumed) {
    for (const other of store.connectedParticipants(room)) {
      if (other.id === participant.id) continue;
      io.to(other.socketId).emit('peer:joined', {
        participant: publicParticipant(participant),
        resumed: Boolean(resumed),
      });
    }
  }

  function notifyPeerLeft(room, participantId, reason) {
    io.to(room.code).emit('peer:left', { participantId, reason });
  }

  function admitParticipant({
    socket,
    room,
    name,
    clientId,
    isHost,
    state,
    waitingRequest = null,
  }) {
    const added = store.addParticipant(room, {
      socketId: socket.id,
      name,
      clientId,
      isHost,
      state,
    });
    if (!added) return null;

    if (waitingRequest) store.removeWaiting(room, waitingRequest.id);
    socket.join(room.code);
    socket.data.roomId = room.code;
    socket.data.participantId = added.participant.id;
    socket.data.isHost = Boolean(isHost);
    socket.data.clientId = clientId;
    delete socket.data.waitingRoom;
    delete socket.data.waitingRequestId;

    const payload = {
      ok: true,
      status: 'admitted',
      participantToken: added.token,
      ...joinPayload(room, added.participant),
    };

    notifyPeerJoined(room, added.participant, false);
    emitWaitingList(room);
    return payload;
  }

  function handleDisconnect(socket) {
    try {
      if (socket.data.waitingRoom) {
        const waitingRoom = store.getActive(socket.data.waitingRoom);
        if (waitingRoom) {
          const request = store.waitingForSocket(waitingRoom, socket.id);
          if (request) {
            store.removeWaiting(waitingRoom, request.id);
            emitWaitingList(waitingRoom);
          }
        }
      }

      const { room, participant } = currentContext(socket) || {};
      if (!room || !participant) return;

      participant.connected = false;
      participant.disconnectedAt = Date.now();
      io.to(room.code).emit('peer:updated', {
        participantId: participant.id,
        state: { ...participant.state },
        connected: false,
      });

      clearDisconnectTimer(room.code, participant.id);
      const timer = setTimeout(() => {
        disconnectTimers.delete(timerKey(room.code, participant.id));
        const liveRoom = store.getActive(room.code);
        if (!liveRoom) return;
        const current = store.getParticipant(liveRoom, participant.id);
        if (!current || current.connected) return;
        store.removeParticipant(liveRoom, participant.id);
        notifyPeerLeft(liveRoom, participant.id, 'disconnected');
        emitWaitingList(liveRoom);
        logger.info('participant disconnected', {
          room: liveRoom.code,
          count: liveRoom.participants.size,
        });
      }, config.disconnectGraceMs);
      timer.unref?.();
      disconnectTimers.set(timerKey(room.code, participant.id), timer);
    } catch (error) {
      logger.error('disconnect cleanup failed', { message: error.message });
    }
  }

  function handleJoin(socket, payload, ack) {
    if (!validation.isPlainObject(payload)) {
      return failure(ack, 'invalid_request', 'The join request was malformed.');
    }
    if (socket.data.roomId) {
      return failure(ack, 'already_joined', 'You are already in a meeting.');
    }

    const code = validation.normalizeRoomCode(payload.code);
    const displayName = validation.normalizeDisplayName(
      payload.displayName,
      config.maxDisplayNameLength,
    );
    const clientId = payload.clientId;
    const state = validation.sanitizeParticipantState(payload.state) || {};

    if (!validation.isValidRoomCode(code)) {
      return failure(ack, 'invalid_room', 'That meeting code is not valid.');
    }
    if (!displayName) {
      return failure(ack, 'invalid_name', 'Please enter a display name.');
    }
    if (!validation.isValidClientId(clientId)) {
      return failure(ack, 'invalid_client', 'Your browser session is invalid. Reload the page.');
    }

    const rate = limiters.join.consume(`join:${socket.data.ip}`);
    if (!rate.allowed) {
      return failure(
        ack,
        'rate_limited',
        'Too many join attempts. Please wait a moment.',
        { retryAfterMs: rate.retryAfterMs },
      );
    }

    const room = store.get(code);
    if (!room) {
      return failure(ack, 'room_not_found', 'This meeting does not exist or has expired.');
    }
    if (room.ended) {
      return failure(ack, 'room_ended', 'This meeting has ended.');
    }
    if (socket.data.waitingRoom && socket.data.waitingRoom !== code) {
      const previousRoom = store.getActive(socket.data.waitingRoom);
      if (previousRoom) {
        const previous = store.waitingForSocket(previousRoom, socket.id);
        if (previous) store.removeWaiting(previousRoom, previous.id);
        emitWaitingList(previousRoom);
      }
      delete socket.data.waitingRoom;
      delete socket.data.waitingRequestId;
    }

    const isHost = store.isHostToken(room, payload.hostToken);
    if (!isHost && store.isBlocked(room, { clientId, ip: socket.data.ip })) {
      return failure(
        ack,
        'access_blocked',
        'You cannot rejoin this meeting. Contact the host if this was a mistake.',
      );
    }
    if (room.participants.size >= room.maxParticipants) {
      return failure(ack, 'room_full', 'This meeting is full.');
    }

    if (room.privacy === 'private' && !isHost) {
      const existing = store.waitingForSocket(room, socket.id);
      if (existing) {
        socket.data.waitingRoom = room.code;
        socket.data.waitingRequestId = existing.id;
        return reply(ack, {
          ok: true,
          status: 'waiting',
          requestId: existing.id,
          room: store.summary(room),
          hostConnected: store.hostConnected(room),
        });
      }

      const request = store.addWaiting(room, {
        socketId: socket.id,
        name: displayName,
        clientId,
        ip: socket.data.ip,
        state,
      });
      if (!request) {
        return failure(ack, 'room_full', 'This meeting has no room in the waiting area.');
      }

      socket.data.waitingRoom = room.code;
      socket.data.waitingRequestId = request.id;
      emitWaitingList(room);
      logger.info('waiting request created', { room: room.code });
      return reply(ack, {
        ok: true,
        status: 'waiting',
        requestId: request.id,
        room: store.summary(room),
        hostConnected: store.hostConnected(room),
      });
    }

    const admission = admitParticipant({
      socket,
      room,
      name: displayName,
      clientId,
      isHost,
      state,
    });
    if (!admission) {
      return failure(ack, 'room_full', 'This meeting is full.');
    }

    logger.info('participant joined', {
      room: room.code,
      host: isHost,
      count: room.participants.size,
    });
    return reply(ack, admission);
  }

  function handleResume(socket, payload, ack) {
    if (!validation.isPlainObject(payload)) {
      return failure(ack, 'invalid_request', 'The reconnect request was malformed.');
    }
    if (socket.data.roomId) {
      return failure(ack, 'already_joined', 'You are already in a meeting.');
    }

    const code = validation.normalizeRoomCode(payload.code);
    const clientId = payload.clientId;
    const token = payload.participantToken;
    if (!validation.isValidRoomCode(code) || !validation.isValidClientId(clientId)) {
      return failure(ack, 'invalid_request', 'The reconnect request was invalid.');
    }
    if (!validation.isValidToken(token)) {
      return failure(ack, 'session_expired', 'Your meeting session has expired.');
    }

    const room = store.get(code);
    if (!room) {
      return failure(ack, 'room_not_found', 'This meeting no longer exists.');
    }
    if (room.ended) {
      return failure(ack, 'room_ended', 'This meeting has ended.');
    }

    const participant = store.getParticipantByToken(room, token);
    if (!participant || !store.verifyParticipantClient(participant, clientId)) {
      return failure(ack, 'session_expired', 'Your meeting session is no longer valid.');
    }
    if (participant.connected && participant.socketId !== socket.id) {
      return failure(ack, 'already_connected', 'This session is active in another tab.');
    }

    clearDisconnectTimer(room.code, participant.id);
    participant.socketId = socket.id;
    participant.connected = true;
    participant.disconnectedAt = null;
    room.lastActivity = Date.now();

    socket.join(room.code);
    socket.data.roomId = room.code;
    socket.data.participantId = participant.id;
    socket.data.isHost = participant.isHost;
    socket.data.clientId = clientId;

    const admission = {
      ok: true,
      status: 'resumed',
      participantToken: token,
      ...joinPayload(room, participant),
    };

    notifyPeerJoined(room, participant, true);
    emitWaitingList(room);
    logger.info('participant resumed', {
      room: room.code,
      count: room.participants.size,
    });
    return reply(ack, admission);
  }

  function handleWaitingDecision(socket, payload, ack) {
    const context = currentContext(socket);
    if (!context) {
      return failure(ack, 'not_in_meeting', 'You are not in this meeting.');
    }
    const { room, participant } = context;
    if (!participant.isHost) {
      return failure(ack, 'forbidden', 'Only the host can manage the waiting room.');
    }
    if (!validation.isPlainObject(payload) || !validation.isValidId(payload.requestId)) {
      return failure(ack, 'invalid_request', 'That join request is invalid.');
    }
    const action = payload.action;
    if (action !== 'admit' && action !== 'reject') {
      return failure(ack, 'invalid_request', 'Unknown waiting-room action.');
    }

    const request = store.getWaiting(room, payload.requestId);
    if (!request) {
      return failure(ack, 'request_not_found', 'That join request is no longer pending.');
    }

    if (action === 'reject') {
      store.removeWaiting(room, request.id);
      const target = io.sockets.sockets.get(request.socketId);
      if (target) {
        if (target.data.waitingRequestId === request.id) {
          delete target.data.waitingRoom;
          delete target.data.waitingRequestId;
        }
        target.emit('room:rejected', {
          reason: 'host_rejected',
          message: 'The host declined your request to join.',
        });
      }
      emitWaitingList(room);
      logger.info('waiting request rejected', { room: room.code });
      return reply(ack, { ok: true, action: 'reject' });
    }

    const target = io.sockets.sockets.get(request.socketId);
    if (!target || !target.connected) {
      store.removeWaiting(room, request.id);
      emitWaitingList(room);
      return failure(ack, 'requester_gone', 'That person is no longer waiting.');
    }
    if (target.data.roomId) {
      store.removeWaiting(room, request.id);
      emitWaitingList(room);
      return failure(ack, 'requester_gone', 'That person already joined another meeting.');
    }
    if (room.participants.size >= room.maxParticipants) {
      return failure(ack, 'room_full', 'The meeting is full. Remove someone or reject the request.');
    }

    const admission = admitParticipant({
      socket: target,
      room,
      name: request.name,
      clientId: request.clientId,
      isHost: false,
      state: request.state,
      waitingRequest: request,
    });
    if (!admission) {
      return failure(ack, 'room_full', 'The meeting is full.');
    }

    target.emit('room:admitted', admission);
    emitWaitingList(room);
    logger.info('waiting request admitted', {
      room: room.code,
      count: room.participants.size,
    });
    return reply(ack, {
      ok: true,
      action: 'admit',
      participantId: admission.self.id,
    });
  }

  function handleCancelWaiting(socket, payload, ack) {
    const code = socket.data.waitingRoom;
    if (!code) {
      return failure(ack, 'not_waiting', 'You are not waiting to join a meeting.');
    }
    const room = store.get(code);
    const request = room ? store.waitingForSocket(room, socket.id) : null;
    if (!request) {
      delete socket.data.waitingRoom;
      delete socket.data.waitingRequestId;
      return failure(ack, 'request_not_found', 'Your join request is no longer pending.');
    }
    if (
      validation.isPlainObject(payload) &&
      payload.requestId &&
      payload.requestId !== request.id
    ) {
      return failure(ack, 'invalid_request', 'That join request is invalid.');
    }

    store.removeWaiting(room, request.id);
    delete socket.data.waitingRoom;
    delete socket.data.waitingRequestId;
    emitWaitingList(room);
    return reply(ack, { ok: true });
  }

  function handleLeave(socket, payload, ack) {
    if (!socket.data.roomId && socket.data.waitingRoom) {
      return handleCancelWaiting(socket, payload, ack);
    }
    const context = currentContext(socket);
    if (!context) {
      delete socket.data.roomId;
      delete socket.data.participantId;
      delete socket.data.isHost;
      delete socket.data.clientId;
      return reply(ack, { ok: true });
    }
    const { room, participant } = context;
    clearDisconnectTimer(room.code, participant.id);
    store.removeParticipant(room, participant.id);
    socket.leave(room.code);
    delete socket.data.roomId;
    delete socket.data.participantId;
    delete socket.data.isHost;
    delete socket.data.clientId;
    notifyPeerLeft(room, participant.id, 'left');
    emitWaitingList(room);
    logger.info('participant left', {
      room: room.code,
      count: room.participants.size,
    });
    return reply(ack, { ok: true });
  }

  function handleParticipantState(socket, payload, ack) {
    const context = currentContext(socket);
    if (!context) {
      return failure(ack, 'not_in_meeting', 'You are not in this meeting.');
    }
    const state = validation.sanitizeParticipantState(payload);
    if (!state) {
      return failure(ack, 'invalid_state', 'The participant state was invalid.');
    }
    Object.assign(context.participant.state, state);
    socket.to(context.room.code).emit('peer:updated', {
      participantId: context.participant.id,
      state: { ...context.participant.state },
      connected: true,
    });
    return reply(ack, { ok: true });
  }

  function handleChat(socket, payload, ack) {
    const context = currentContext(socket);
    if (!context) {
      return failure(ack, 'not_in_meeting', 'You are not in this meeting.');
    }
    if (!validation.isPlainObject(payload) || typeof payload.text !== 'string') {
      return failure(ack, 'invalid_message', 'The message was invalid.');
    }
    if (payload.text.length > config.maxChatLength * 2) {
      return failure(ack, 'message_too_long', 'The message is too long.');
    }
    const text = validation.normalizeChatText(payload.text, config.maxChatLength);
    if (!text) {
      return failure(ack, 'invalid_message', 'The message is empty.');
    }
    if (payload.text.length > config.maxChatLength) {
      return failure(
        ack,
        'message_too_long',
        `Messages are limited to ${config.maxChatLength} characters.`,
      );
    }

    const rate = limiters.chat.consume(
      `chat:${context.room.code}:${context.participant.id}`,
    );
    if (!rate.allowed) {
      return failure(
        ack,
        'rate_limited',
        'You are sending messages too quickly.',
        { retryAfterMs: rate.retryAfterMs },
      );
    }

    const message = {
      id: crypto.randomUUID(),
      senderId: context.participant.id,
      senderName: context.participant.name,
      text,
      timestamp: Date.now(),
    };
    store.addMessage(context.room, message);
    io.to(context.room.code).emit('chat:message', message);
    return reply(ack, { ok: true, id: message.id });
  }

  function handleSignal(socket, event, payload, ack) {
    const context = currentContext(socket);
    if (!context) {
      return failure(ack, 'not_in_meeting', 'You are not in this meeting.');
    }
    if (!validation.isPlainObject(payload) || !validation.isValidId(payload.to)) {
      return failure(ack, 'invalid_request', 'The signaling request was invalid.');
    }

    const rate = limiters.signaling.consume(`signal:${socket.id}`);
    if (!rate.allowed) {
      return failure(ack, 'rate_limited', 'Too many signaling messages.');
    }

    const target = store.getParticipant(context.room, payload.to);
    if (
      !target ||
      target.id === context.participant.id ||
      !target.connected ||
      target.socketId === socket.id
    ) {
      return failure(ack, 'peer_unavailable', 'That participant is no longer connected.');
    }

    if (event === 'webrtc:ice') {
      if (payload.candidate === null) {
        io.to(target.socketId).emit('webrtc:ice', {
          from: context.participant.id,
          candidate: null,
        });
        return reply(ack, { ok: true });
      }
      const candidate = validation.sanitizeIceCandidate(payload.candidate);
      if (!candidate) {
        return failure(ack, 'invalid_candidate', 'The ICE candidate was invalid.');
      }
      io.to(target.socketId).emit('webrtc:ice', {
        from: context.participant.id,
        candidate,
      });
      return reply(ack, { ok: true });
    }

    const description = validation.sanitizeSessionDescription(payload.description);
    if (!description) {
      return failure(ack, 'invalid_description', 'The session description was invalid.');
    }
    io.to(target.socketId).emit(event, {
      from: context.participant.id,
      description,
      reconnect: Boolean(payload.reconnect),
    });
    return reply(ack, { ok: true });
  }

  function handleRemove(socket, payload, ack) {
    const context = currentContext(socket);
    if (!context) {
      return failure(ack, 'not_in_meeting', 'You are not in this meeting.');
    }
    const { room, participant } = context;
    if (!participant.isHost) {
      return failure(ack, 'forbidden', 'Only the host can remove participants.');
    }
    if (!validation.isPlainObject(payload) || !validation.isValidId(payload.participantId)) {
      return failure(ack, 'invalid_request', 'That participant is invalid.');
    }
    const target = store.getParticipant(room, payload.participantId);
    if (!target) {
      return failure(ack, 'participant_not_found', 'That participant already left.');
    }
    if (target.id === participant.id) {
      return failure(ack, 'invalid_request', 'You cannot remove yourself. Use Leave meeting.');
    }
    if (target.isHost) {
      return failure(ack, 'forbidden', 'A host cannot be removed from the meeting.');
    }

    clearDisconnectTimer(room.code, target.id);
    store.removeParticipant(room, target.id);

    const targetSocket = io.sockets.sockets.get(target.socketId);
    store.block(
      room,
      { clientId: target.clientId },
      config.removalBlockMs,
    );
    if (targetSocket) {
      targetSocket.emit('room:removed', {
        reason: 'host_removed',
        message: 'The host removed you from the meeting.',
      });
      targetSocket.leave(room.code);
      // Block immediate re-entry even if the client rotates its local client id.
      if (targetSocket.data.ip) {
        store.block(
          room,
          { ip: targetSocket.data.ip },
          config.removalIpBlockMs,
        );
      }
      delete targetSocket.data.roomId;
      delete targetSocket.data.participantId;
      delete targetSocket.data.isHost;
      delete targetSocket.data.clientId;
    }

    notifyPeerLeft(room, target.id, 'removed');
    emitWaitingList(room);
    logger.info('participant removed', { room: room.code });
    return reply(ack, { ok: true, participantId: target.id });
  }

  function handleEnd(socket, payload, ack) {
    const context = currentContext(socket);
    if (!context) {
      return failure(ack, 'not_in_meeting', 'You are not in this meeting.');
    }
    const { room, participant } = context;
    if (!participant.isHost) {
      return failure(ack, 'forbidden', 'Only the host can end the meeting.');
    }

    const participantSockets = Array.from(room.participants.values()).map(
      (item) => item.socketId,
    );
    const waitingSockets = Array.from(room.waiting.values()).map((item) => item.socketId);

    for (const participantItem of room.participants.values()) {
      clearDisconnectTimer(room.code, participantItem.id);
    }
    store.end(room, 'host_ended');

    for (const socketId of waitingSockets) {
      const waiter = io.sockets.sockets.get(socketId);
      if (!waiter) continue;
      waiter.emit('room:rejected', {
        reason: 'meeting_ended',
        message: 'The host ended the meeting.',
      });
      delete waiter.data.waitingRoom;
      delete waiter.data.waitingRequestId;
    }

    for (const socketId of participantSockets) {
      io.to(socketId).emit('room:ended', {
        reason: 'host_ended',
        message: 'The host ended the meeting.',
      });
      const target = io.sockets.sockets.get(socketId);
      if (!target) continue;
      target.leave(room.code);
      delete target.data.roomId;
      delete target.data.participantId;
      delete target.data.isHost;
      delete target.data.clientId;
    }

    room.participants.clear();
    logger.info('meeting ended', { room: room.code });
    return reply(ack, { ok: true });
  }

  io.use((socket, next) => {
    const ip = getClientIp(socket, config.trustProxy);
    const result = limiters.connect.consume(ip);
    if (!result.allowed) {
      const error = new Error('Too many connection attempts. Please try again shortly.');
      error.data = { code: 'rate_limited', retryAfterMs: result.retryAfterMs };
      return next(error);
    }
    socket.data.ip = ip;
    socket.data.connectedAt = Date.now();
    return next();
  });

  io.on('connection', (socket) => {
    socket.on('room:join', (payload, ack) => {
      try {
        handleJoin(socket, payload, ack);
      } catch (error) {
        logger.error('join failed', { message: error.message });
        failure(ack, 'server_error', 'Unable to join the meeting right now.');
      }
    });

    socket.on('room:resume', (payload, ack) => {
      try {
        handleResume(socket, payload, ack);
      } catch (error) {
        logger.error('resume failed', { message: error.message });
        failure(ack, 'server_error', 'Unable to reconnect right now.');
      }
    });

    socket.on('room:waiting-decision', (payload, ack) => {
      try {
        handleWaitingDecision(socket, payload, ack);
      } catch (error) {
        logger.error('waiting decision failed', { message: error.message });
        failure(ack, 'server_error', 'Unable to update the waiting room.');
      }
    });

    socket.on('room:cancel-waiting', (payload, ack) => {
      try {
        handleCancelWaiting(socket, payload, ack);
      } catch (error) {
        logger.error('cancel waiting failed', { message: error.message });
        failure(ack, 'server_error', 'Unable to cancel the request.');
      }
    });

    socket.on('room:leave', (payload, ack) => {
      try {
        handleLeave(socket, payload, ack);
      } catch (error) {
        logger.error('leave failed', { message: error.message });
        failure(ack, 'server_error', 'Unable to leave the meeting cleanly.');
      }
    });

    socket.on('room:remove', (payload, ack) => {
      try {
        handleRemove(socket, payload, ack);
      } catch (error) {
        logger.error('remove failed', { message: error.message });
        failure(ack, 'server_error', 'Unable to remove the participant.');
      }
    });

    socket.on('room:end', (payload, ack) => {
      try {
        handleEnd(socket, payload, ack);
      } catch (error) {
        logger.error('end meeting failed', { message: error.message });
        failure(ack, 'server_error', 'Unable to end the meeting.');
      }
    });

    socket.on('participant:state', (payload, ack) => {
      try {
        handleParticipantState(socket, payload, ack);
      } catch (error) {
        logger.error('participant state failed', { message: error.message });
        failure(ack, 'server_error', 'Unable to update your status.');
      }
    });

    socket.on('chat:send', (payload, ack) => {
      try {
        handleChat(socket, payload, ack);
      } catch (error) {
        logger.error('chat failed', { message: error.message });
        failure(ack, 'server_error', 'Unable to send the message.');
      }
    });

    for (const event of ['webrtc:offer', 'webrtc:answer', 'webrtc:ice']) {
      socket.on(event, (payload, ack) => {
        try {
          handleSignal(socket, event, payload, ack);
        } catch (error) {
          logger.error('signaling failed', { event, message: error.message });
          failure(ack, 'server_error', 'Unable to relay the signaling message.');
        }
      });
    }

    socket.on('disconnect', () => handleDisconnect(socket));
  });

  const waitingSweep = setInterval(() => {
    const now = Date.now();
    for (const room of store.rooms.values()) {
      if (room.ended || room.waiting.size === 0) continue;
      let changed = false;
      for (const request of Array.from(room.waiting.values())) {
        if (now - request.requestedAt <= config.waitingTtlMs) continue;
        store.removeWaiting(room, request.id);
        changed = true;
        io.to(request.socketId).emit('room:rejected', {
          reason: 'timeout',
          message: 'The host did not admit you in time. Please try again.',
        });
        const waiter = io.sockets.sockets.get(request.socketId);
        if (waiter && waiter.data.waitingRequestId === request.id) {
          delete waiter.data.waitingRoom;
          delete waiter.data.waitingRequestId;
        }
      }
      if (changed) emitWaitingList(room);
    }
  }, 30000);
  waitingSweep.unref?.();

  return {
    stop() {
      clearInterval(waitingSweep);
      for (const timer of disconnectTimers.values()) clearTimeout(timer);
      disconnectTimers.clear();
      for (const limiter of Object.values(limiters)) limiter.stop();
    },
  };
}

module.exports = { attachRealtime };
