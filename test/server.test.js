'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  api,
  createRoom,
  emitAck,
  join,
  joinGuest,
  joinHost,
  newClientId,
  onceEvent,
  startApp,
  wait,
} = require('./helpers');

const SDP_OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
  'a=sendrecv',
  '',
].join('\r\n');

const SDP_ANSWER = SDP_OFFER.replace('a=sendrecv', 'a=recvonly');

test('health, HTML pages, security headers and CORS', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const health = await api(ctx.base, '/healthz');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, 'ok');
  assert.equal(typeof health.body.rooms.activeRooms, 'number');
  assert.equal(health.response.headers.get('cache-control'), 'no-store');

  const home = await api(ctx.base, '/');
  assert.equal(home.response.status, 200);
  assert.match(home.body, /Start instant meeting/);
  const csp = home.response.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(home.response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(home.response.headers.get('x-frame-options'), 'DENY');
  assert.match(
    home.response.headers.get('permissions-policy') || '',
    /camera=\(self\)/,
  );

  const css = await api(ctx.base, '/css/base.css');
  assert.equal(css.response.status, 200);
  assert.match(css.response.headers.get('content-type') || '', /text\/css/);

  const script = await api(ctx.base, '/js/room.js');
  assert.equal(script.response.status, 200);
  assert.match(script.response.headers.get('content-type') || '', /javascript/);

  const lucide = await api(ctx.base, '/vendor/lucide.min.js');
  assert.equal(lucide.response.status, 200);
  assert.match(lucide.response.headers.get('content-type') || '', /javascript/);

  const favicon = await api(ctx.base, '/favicon.svg');
  assert.equal(favicon.response.status, 200);

  const invalidRoom = await api(ctx.base, '/room/not-a-valid-code!');
  assert.equal(invalidRoom.response.status, 404);
  assert.match(invalidRoom.body, /Meeting not found/);

  const missingApi = await api(ctx.base, '/api/does-not-exist');
  assert.equal(missingApi.response.status, 404);
  assert.equal(missingApi.body.error, 'not_found');

  const preflight = await fetch(ctx.base + '/api/rooms', {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://127.0.0.1:3000',
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get('access-control-allow-origin'),
    'http://127.0.0.1:3000',
  );

  const deniedPreflight = await fetch(ctx.base + '/api/rooms', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://evil.example',
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.equal(deniedPreflight.status, 403);

  const deniedPost = await fetch(ctx.base + '/api/rooms', {
    method: 'POST',
    headers: {
      Origin: 'https://evil.example',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: 'Nope' }),
  });
  assert.equal(deniedPost.status, 403);

  // Same-origin requests must work even when APP_URL names a different host.
  const sameOriginPost = await fetch(ctx.base + '/api/rooms', {
    method: 'POST',
    headers: {
      Origin: ctx.base,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: 'Same origin' }),
  });
  assert.equal(sameOriginPost.status, 201);
  assert.equal(sameOriginPost.headers.get('access-control-allow-origin'), ctx.base);

  await assert.rejects(ctx.socket({ extraHeaders: { Origin: 'https://evil.example' } }));
  const sameOriginSocket = await ctx.socket({ extraHeaders: { Origin: ctx.base } });
  assert.equal(sameOriginSocket.connected, true);
});

test('room creation validates input, normalizes fields and stores only a host-token hash', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const wrongType = await fetch(ctx.base + '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'title=Nope',
  });
  assert.equal(wrongType.status, 415);

  const malformed = await fetch(ctx.base + '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"title": ',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'bad_request');

  const publicRoom = await createRoom(ctx.base, {
    title: '  Design   sync  ',
    privacy: 'nonsense',
  });
  assert.equal(publicRoom.ok, true);
  assert.equal(publicRoom.room.title, 'Design sync');
  assert.equal(publicRoom.room.privacy, 'public');
  assert.match(publicRoom.room.code, /^[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}$/);
  assert.match(publicRoom.hostToken, /^[a-f0-9]{64}$/);
  assert.equal(publicRoom.inviteUrl, `${ctx.config.appUrl}/room/${publicRoom.room.code}`);

  const stored = ctx.application.store.get(publicRoom.room.code);
  assert.ok(stored);
  assert.equal(stored.hostTokenHash.length, 64);
  assert.notEqual(stored.hostTokenHash, publicRoom.hostToken);
  assert.equal(JSON.stringify(ctx.application.store.stats()).includes(publicRoom.hostToken), false);

  const privateRoom = await createRoom(ctx.base, { title: 'Secret', privacy: 'private' });
  assert.equal(privateRoom.room.privacy, 'private');
  assert.match(privateRoom.room.code, /^[a-z0-9]{6}(?:-[a-z0-9]{6}){3}$/);

  const longTitle = 'x'.repeat(200);
  const truncated = await createRoom(ctx.base, { title: longTitle });
  assert.equal(truncated.room.title.length, 80);

  const lookup = await api(ctx.base, `/api/rooms/${publicRoom.room.code}`);
  assert.equal(lookup.response.status, 200);
  assert.equal(lookup.body.room.code, publicRoom.room.code);
  assert.equal(lookup.body.room.participantCount, 0);

  const invalidLookup = await api(ctx.base, '/api/rooms/nope!');
  assert.equal(invalidLookup.response.status, 400);

  const missingLookup = await api(ctx.base, '/api/rooms/abc-defg-hij');
  assert.equal(missingLookup.response.status, 404);
  assert.equal(missingLookup.body.error, 'room_not_found');
});

test('public rooms admit directly and support chat, presence updates and history', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const room = await createRoom(ctx.base, { title: 'Public room' });
  const host = await joinHost(ctx, room);
  assert.equal(host.response.status, 'admitted');
  assert.equal(host.response.self.isHost, true);
  assert.deepEqual(host.response.peers, []);
  assert.equal(host.response.self.name, 'Host');

  const peerJoined = onceEvent(host.socket, 'peer:joined', {
    predicate: (payload) => payload.resumed === false,
  });
  const guest = await joinGuest(ctx, room.room.code, '  Grace   Hopper ');
  assert.equal(guest.response.status, 'admitted');
  assert.equal(guest.response.self.isHost, false);
  assert.equal(guest.response.self.name, 'Grace Hopper');
  assert.equal(guest.response.peers.length, 1);
  assert.equal(guest.response.peers[0].id, host.response.self.id);
  assert.equal((await peerJoined).participant.name, 'Grace Hopper');

  const duplicate = await join(guest.socket, {
    code: room.room.code,
    displayName: 'Again',
    clientId: newClientId(),
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'already_joined');

  const chatAtHost = onceEvent(host.socket, 'chat:message');
  const chatAck = await emitAck(guest.socket, 'chat:send', {
    text: '  Hello\r\n\r\n\r\n\r\nteam  ',
  });
  assert.equal(chatAck.ok, true);
  const message = await chatAtHost;
  assert.equal(message.text, 'Hello\n\n\nteam');
  assert.equal(message.senderId, guest.response.self.id);
  assert.equal(message.senderName, 'Grace Hopper');

  const stateAtHost = onceEvent(
    host.socket,
    'peer:updated',
    { predicate: (payload) => payload.participantId === guest.response.self.id },
  );
  const stateAck = await emitAck(guest.socket, 'participant:state', {
    mic: false,
    camera: false,
    hand: true,
  });
  assert.equal(stateAck.ok, true);
  const stateUpdate = await stateAtHost;
  assert.equal(stateUpdate.connected, true);
  assert.deepEqual(stateUpdate.state, {
    mic: false,
    camera: false,
    hand: true,
    sharing: false,
  });

  const lateGuest = await joinGuest(ctx, room.room.code, 'Late');
  assert.equal(lateGuest.response.status, 'admitted');
  assert.equal(lateGuest.response.messages.length, 1);
  assert.equal(lateGuest.response.messages[0].text, 'Hello\n\n\nteam');
  assert.equal(lateGuest.response.peers.length, 2);

  await emitAck(guest.socket, 'room:leave', {});
  const hostCount = ctx.application.store.get(room.room.code).participants.size;
  assert.equal(hostCount, 2);
});

test('private rooms use the waiting room and only the host can admit or reject', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const room = await createRoom(ctx.base, { title: 'Private room', privacy: 'private' });
  const host = await joinHost(ctx, room);

  const waitingAtHost = onceEvent(host.socket, 'room:waiting-list', {
    predicate: (payload) => payload.requests.length === 1,
  });
  const guest = await joinGuest(ctx, room.room.code, 'Waiting Guest');
  assert.equal(guest.response.status, 'waiting');
  assert.equal(guest.response.self, undefined);
  assert.match(guest.response.requestId, /^[A-Za-z0-9_-]{8,64}$/);

  const waitingList = await waitingAtHost;
  assert.equal(waitingList.requests[0].name, 'Waiting Guest');

  const forbidden = await emitAck(guest.socket, 'room:waiting-decision', {
    requestId: waitingList.requests[0].id,
    action: 'admit',
  });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.code, 'not_in_meeting');

  const admittedAtGuest = onceEvent(guest.socket, 'room:admitted');
  const admitted = await emitAck(host.socket, 'room:waiting-decision', {
    requestId: waitingList.requests[0].id,
    action: 'admit',
  });
  assert.equal(admitted.ok, true);
  assert.equal(admitted.action, 'admit');
  const admission = await admittedAtGuest;
  assert.equal(admission.status, 'admitted');
  assert.equal(admission.self.name, 'Waiting Guest');
  assert.equal(admission.self.isHost, false);
  assert.match(admission.participantToken, /^[a-f0-9]{64}$/);
  assert.equal(admission.peers.length, 1);

  const secondWaitingAtHost = onceEvent(host.socket, 'room:waiting-list', {
    predicate: (payload) =>
      payload.requests.length === 1 && payload.requests[0].name === 'Second Guest',
  });
  const second = await joinGuest(ctx, room.room.code, 'Second Guest');
  assert.equal(second.response.status, 'waiting');
  const secondList = await secondWaitingAtHost;

  const rejectedAtGuest = onceEvent(second.socket, 'room:rejected');
  const rejected = await emitAck(host.socket, 'room:waiting-decision', {
    requestId: secondList.requests[0].id,
    action: 'reject',
  });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.action, 'reject');
  const rejection = await rejectedAtGuest;
  assert.equal(rejection.reason, 'host_rejected');

  const missingRequest = await emitAck(host.socket, 'room:waiting-decision', {
    requestId: secondList.requests[0].id,
    action: 'admit',
  });
  assert.equal(missingRequest.ok, false);
  assert.equal(missingRequest.code, 'request_not_found');

  const randomHostToken = 'a'.repeat(64);
  const fakeHost = await join(await ctx.socket(), {
    code: room.room.code,
    displayName: 'Fake host',
    clientId: newClientId(),
    hostToken: randomHostToken,
  });
  assert.equal(fakeHost.status, 'waiting');
});

test('realtime signaling is authenticated, same-room only and server-attributed', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const room = await createRoom(ctx.base);
  const host = await joinHost(ctx, room);
  const guest = await joinGuest(ctx, room.room.code);

  const anonymous = await ctx.socket();
  const anonymousResult = await emitAck(anonymous, 'webrtc:offer', {
    to: host.response.self.id,
    description: { type: 'offer', sdp: SDP_OFFER },
  });
  assert.equal(anonymousResult.ok, false);
  assert.equal(anonymousResult.code, 'not_in_meeting');

  const offerAtHost = onceEvent(host.socket, 'webrtc:offer');
  const offerAck = await emitAck(guest.socket, 'webrtc:offer', {
    to: host.response.self.id,
    from: 'spoofed-id',
    description: { type: 'offer', sdp: SDP_OFFER },
  });
  assert.equal(offerAck.ok, true);
  const offer = await offerAtHost;
  assert.equal(offer.from, guest.response.self.id);
  assert.equal(offer.description.sdp, SDP_OFFER);

  const answerAtGuest = onceEvent(guest.socket, 'webrtc:answer');
  const answerAck = await emitAck(host.socket, 'webrtc:answer', {
    to: guest.response.self.id,
    description: { type: 'answer', sdp: SDP_ANSWER },
  });
  assert.equal(answerAck.ok, true);
  assert.equal((await answerAtGuest).from, host.response.self.id);

  const iceAtHost = onceEvent(host.socket, 'webrtc:ice');
  const iceAck = await emitAck(guest.socket, 'webrtc:ice', {
    to: host.response.self.id,
    candidate: {
      candidate: 'candidate:1 1 UDP 2122252543 192.0.2.1 5000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: 'secret-fragment',
    },
  });
  assert.equal(iceAck.ok, true);
  const ice = await iceAtHost;
  assert.equal(ice.from, guest.response.self.id);
  assert.deepEqual(ice.candidate, {
    candidate: 'candidate:1 1 UDP 2122252543 192.0.2.1 5000 typ host',
    sdpMid: '0',
    sdpMLineIndex: 0,
  });
  assert.equal('usernameFragment' in ice.candidate, false);

  const selfTarget = await emitAck(guest.socket, 'webrtc:offer', {
    to: guest.response.self.id,
    description: { type: 'offer', sdp: SDP_OFFER },
  });
  assert.equal(selfTarget.code, 'peer_unavailable');

  const badSdp = await emitAck(guest.socket, 'webrtc:offer', {
    to: host.response.self.id,
    description: { type: 'offer', sdp: 'not-sdp' },
  });
  assert.equal(badSdp.code, 'invalid_description');

  const badCandidate = await emitAck(guest.socket, 'webrtc:ice', {
    to: host.response.self.id,
    candidate: { candidate: 'not-a-candidate' },
  });
  assert.equal(badCandidate.code, 'invalid_candidate');

  const otherRoom = await createRoom(ctx.base, { title: 'Other room' });
  const otherHost = await joinHost(ctx, otherRoom);
  const crossRoom = await emitAck(guest.socket, 'webrtc:offer', {
    to: otherHost.response.self.id,
    description: { type: 'offer', sdp: SDP_OFFER },
  });
  assert.equal(crossRoom.code, 'peer_unavailable');

  const nullCandidateAtHost = onceEvent(host.socket, 'webrtc:ice');
  const nullAck = await emitAck(guest.socket, 'webrtc:ice', {
    to: host.response.self.id,
    candidate: null,
  });
  assert.equal(nullAck.ok, true);
  assert.equal((await nullCandidateAtHost).candidate, null);
});

test('host moderation, removal blocks, and ending the meeting are server-enforced', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const room = await createRoom(ctx.base);
  const host = await joinHost(ctx, room);
  const guest = await joinGuest(ctx, room.room.code, 'Removable');
  const bystander = await joinGuest(ctx, room.room.code, 'Bystander');

  const selfRemove = await emitAck(host.socket, 'room:remove', {
    participantId: host.response.self.id,
  });
  assert.equal(selfRemove.ok, false);
  assert.equal(selfRemove.code, 'invalid_request');

  const guestRemove = await emitAck(guest.socket, 'room:remove', {
    participantId: bystander.response.self.id,
  });
  assert.equal(guestRemove.ok, false);
  assert.equal(guestRemove.code, 'forbidden');

  const guestEnd = await emitAck(guest.socket, 'room:end', {});
  assert.equal(guestEnd.ok, false);
  assert.equal(guestEnd.code, 'forbidden');

  const removedAtGuest = onceEvent(guest.socket, 'room:removed');
  const leftAtHost = onceEvent(host.socket, 'peer:left', {
    predicate: (payload) => payload.participantId === guest.response.self.id,
  });
  const removeAck = await emitAck(host.socket, 'room:remove', {
    participantId: guest.response.self.id,
  });
  assert.equal(removeAck.ok, true);
  assert.equal(removeAck.participantId, guest.response.self.id);
  assert.equal((await removedAtGuest).reason, 'host_removed');
  assert.equal((await leftAtHost).reason, 'removed');
  assert.equal(
    ctx.application.store.get(room.room.code).participants.has(guest.response.self.id),
    false,
  );

  const blockedSameClient = await join(await ctx.socket(), {
    code: room.room.code,
    displayName: 'Removable',
    clientId: guest.clientId,
  });
  assert.equal(blockedSameClient.ok, false);
  assert.equal(blockedSameClient.code, 'access_blocked');

  const blockedNewClient = await join(await ctx.socket(), {
    code: room.room.code,
    displayName: 'Someone else',
    clientId: newClientId(),
  });
  assert.equal(blockedNewClient.ok, false);

  const hostBypass = await join(await ctx.socket(), {
    code: room.room.code,
    displayName: 'Host again',
    clientId: newClientId(),
    hostToken: room.hostToken,
  });
  assert.equal(hostBypass.status, 'admitted');
  assert.equal(hostBypass.self.isHost, true);

  const endedAtHost = onceEvent(host.socket, 'room:ended');
  const endAck = await emitAck(host.socket, 'room:end', {});
  assert.equal(endAck.ok, true);
  assert.equal((await endedAtHost).reason, 'host_ended');

  const endedLookup = await api(ctx.base, `/api/rooms/${room.room.code}`);
  assert.equal(endedLookup.response.status, 410);
  assert.equal(endedLookup.body.error, 'room_ended');

  const endedPage = await api(ctx.base, `/room/${room.room.code}`);
  assert.equal(endedPage.response.status, 410);
  assert.match(endedPage.body, /Meeting ended/);

  const joinEnded = await join(await ctx.socket(), {
    code: room.room.code,
    displayName: 'Too late',
    clientId: newClientId(),
    hostToken: room.hostToken,
  });
  assert.equal(joinEnded.ok, false);
  assert.equal(joinEnded.code, 'room_ended');
});

test('participants can resume a live session after reconnecting', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const room = await createRoom(ctx.base);
  const host = await joinHost(ctx, room);
  const guest = await joinGuest(ctx, room.room.code, 'Reconnecting');

  const offlineAtHost = onceEvent(host.socket, 'peer:updated', {
    predicate: (payload) =>
      payload.participantId === guest.response.self.id && payload.connected === false,
  });
  guest.socket.close();
  await offlineAtHost;

  const resumedSocket = await ctx.socket();
  const resumedAtHost = onceEvent(host.socket, 'peer:joined', {
    predicate: (payload) =>
      payload.participant.id === guest.response.self.id && payload.resumed === true,
  });
  const resumed = await emitAck(resumedSocket, 'room:resume', {
    code: room.room.code,
    clientId: guest.clientId,
    participantToken: guest.response.participantToken,
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.status, 'resumed');
  assert.equal(resumed.self.id, guest.response.self.id);
  assert.equal((await resumedAtHost).participant.id, guest.response.self.id);

  const wrongClient = await emitAck(await ctx.socket(), 'room:resume', {
    code: room.room.code,
    clientId: newClientId(),
    participantToken: guest.response.participantToken,
  });
  assert.equal(wrongClient.ok, false);
  assert.equal(wrongClient.code, 'session_expired');

  const duplicate = await emitAck(await ctx.socket(), 'room:resume', {
    code: room.room.code,
    clientId: guest.clientId,
    participantToken: guest.response.participantToken,
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'already_connected');

  const invalidToken = await emitAck(await ctx.socket(), 'room:resume', {
    code: room.room.code,
    clientId: guest.clientId,
    participantToken: 'not-a-token',
  });
  assert.equal(invalidToken.ok, false);
  assert.equal(invalidToken.code, 'session_expired');
});

test('room capacity is enforced and freed when a participant leaves', async (t) => {
  const ctx = await startApp({ env: { MAX_PARTICIPANTS: '2' } });
  t.after(() => ctx.close());

  const room = await createRoom(ctx.base);
  const host = await joinHost(ctx, room);
  const guest = await joinGuest(ctx, room.room.code, 'First guest');
  assert.equal(guest.response.status, 'admitted');

  const third = await joinGuest(ctx, room.room.code, 'Third');
  assert.equal(third.response.ok, false);
  assert.equal(third.response.code, 'room_full');

  const leaveAck = await emitAck(guest.socket, 'room:leave', {});
  assert.equal(leaveAck.ok, true);

  const replacement = await joinGuest(ctx, room.room.code, 'Replacement');
  assert.equal(replacement.response.status, 'admitted');
  assert.equal(replacement.response.peers.length, 1);
  assert.equal(host.response.self.id, replacement.response.peers[0].id);
});

test('chat is room-scoped, sanitized and rate limited', async (t) => {
  const ctx = await startApp({
    configure(config) {
      config.rateLimits.chatPerTenSeconds = 2;
    },
  });
  t.after(() => ctx.close());

  const roomA = await createRoom(ctx.base, { title: 'Room A' });
  const hostA = await joinHost(ctx, roomA);
  const guestA = await joinGuest(ctx, roomA.room.code, 'Guest A');

  const roomB = await createRoom(ctx.base, { title: 'Room B' });
  const hostB = await joinHost(ctx, roomB);
  const guestB = await joinGuest(ctx, roomB.room.code, 'Guest B');

  const leaked = [];
  hostB.socket.on('chat:message', (payload) => leaked.push(payload));
  const receivedAtA = onceEvent(hostA.socket, 'chat:message');
  const ack = await emitAck(guestA.socket, 'chat:send', { text: 'Only in A' });
  assert.equal(ack.ok, true);
  assert.equal((await receivedAtA).text, 'Only in A');
  await wait(250);
  assert.equal(leaked.length, 0);

  const empty = await emitAck(guestA.socket, 'chat:send', { text: '   ' });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'invalid_message');

  const tooLong = await emitAck(guestA.socket, 'chat:send', { text: 'x'.repeat(2001) });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.code, 'message_too_long');

  const first = await emitAck(guestB.socket, 'chat:send', { text: 'one' });
  const second = await emitAck(guestB.socket, 'chat:send', { text: 'two' });
  const limited = await emitAck(guestB.socket, 'chat:send', { text: 'three' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(limited.ok, false);
  assert.equal(limited.code, 'rate_limited');
  assert.ok(limited.retryAfterMs > 0);

  const chatHistory = ctx.application.store.messages(
    ctx.application.store.get(roomB.room.code),
  );
  assert.equal(chatHistory.length, 2);
  assert.equal(chatHistory[1].senderName, 'Guest B');
  assert.equal(chatHistory[1].senderId, guestB.response.self.id);
});

test('API lookup rate limits return 429 with a retry hint', async (t) => {
  const ctx = await startApp({ env: { RATE_LIMIT_LOOKUP_PER_MINUTE: '10' } });
  t.after(() => ctx.close());

  const room = await createRoom(ctx.base);
  for (let index = 0; index < 10; index += 1) {
    const result = await api(ctx.base, `/api/rooms/${room.room.code}`);
    assert.equal(result.response.status, 200);
  }
  const limited = await api(ctx.base, `/api/rooms/${room.room.code}`);
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(Number(limited.response.headers.get('retry-after')) >= 1);
  assert.equal(limited.response.headers.get('ratelimit-limit'), '10');
});

test('join validation rejects malformed names, codes, clients and unavailable rooms', async (t) => {
  const ctx = await startApp();
  t.after(() => ctx.close());

  const socket = await ctx.socket();
  const noName = await join(socket, {
    code: 'abc-defg-hij',
    displayName: ' ',
    clientId: newClientId(),
  });
  assert.equal(noName.code, 'invalid_name');

  const badClient = await join(socket, {
    code: 'abc-defg-hij',
    displayName: 'Person',
    clientId: 'short',
  });
  assert.equal(badClient.code, 'invalid_client');

  const badCode = await join(socket, {
    code: 'nope!',
    displayName: 'Person',
    clientId: newClientId(),
  });
  assert.equal(badCode.code, 'invalid_room');

  const missing = await join(socket, {
    code: 'abc-defg-hij',
    displayName: 'Person',
    clientId: newClientId(),
  });
  assert.equal(missing.code, 'room_not_found');

  const sdpInjection = await api(ctx.base, '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '<script>alert(1)</script>', privacy: 'public' }),
  });
  assert.equal(sdpInjection.response.status, 201);
  assert.equal(sdpInjection.body.room.title, '<script>alert(1)</script>');

  const roomPage = await api(ctx.base, `/room/${sdpInjection.body.room.code}`);
  assert.equal(roomPage.response.status, 200);
  assert.doesNotMatch(roomPage.body, /<script>alert\(1\)<\/script>/);
  assert.match(roomPage.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
