# RTC — peer-to-peer video meetings

A small, self-hosted video conferencing app with a Google Meet–inspired interface. It uses
native WebRTC for media and Socket.IO for signaling, chat, presence, and moderation.

**Live demo:** https://rtc-nexv.onrender.com/

RTC is deliberately boring under the hood: HTML, CSS, vanilla JavaScript, Nunjucks, Express,
Socket.IO, and native `RTCPeerConnection`. No frontend framework, no database, no build step,
and no paid services are required.

## Features

- **Instant meetings and scheduled links** — create a public or private room and share its link.
- **Lobby and device setup** — camera/microphone preview, device pickers, permission states, and
  join with mic or camera off.
- **Waiting room for private rooms** — the host admits or declines guests; guests wait without
  starting their camera.
- **Real WebRTC mesh calls** — audio/video between up to `MAX_PARTICIPANTS` peers (default 8).
- **Screen sharing** — replace your camera track with a display track, with browser-share-ended
  cleanup and a presenting state visible to everyone.
- **Meeting controls** — mute, camera, present, raise hand, leave, copy invite, meeting timer,
  participant count, and connection status.
- **Chat** — room-scoped messages with sanitization, rate limiting, history while the room lives,
  unread badges, and keyboard support.
- **Host moderation** — remove participants, end the meeting for everyone, and view the waiting
  room. Host authority is verified by the server, not by knowing the room code.
- **Reconnect/resume** — a short disconnect grace period lets a tab resume its participant session
  after a network drop or Socket.IO reconnect.
- **Light/dark themes, responsive layouts, reduced-motion support, visible focus states, and
  keyboard shortcuts** (`M`, `V`, `P`, `C`, `U`, `H`, `Esc`).
- **Security defaults** — CSP and other headers, origin checks, rate limits, input validation,
  server-derived participant identity, and no trust in client-supplied participant IDs.

## Stack

- **Frontend:** HTML5, CSS3, vanilla JavaScript, Nunjucks, Lucide icons
- **Backend:** Node.js 20.12+, Express 5, Socket.IO 4
- **Media:** native WebRTC (`RTCPeerConnection`, `getUserMedia`, `getDisplayMedia`)
- **Tests:** Node's built-in test runner, `socket.io-client`, Playwright Core with system Chrome

## How it works

1. `POST /api/rooms` creates a room. The server returns a public room summary and a one-time
   host token. Only a SHA-256 hash of the host token is stored.
2. The host token is kept in the browser's `localStorage`; participant resume tokens are kept in
   `sessionStorage`. The server verifies them on every join/resume.
3. Clients connect to Socket.IO and emit `room:join`. Public rooms admit immediately. Private
   rooms put non-hosts into the waiting room until a verified host admits them.
4. The server relays `webrtc:offer`, `webrtc:answer`, and `webrtc:ice` only between participants
   in the same room. The `from` field is set from socket state, never from the payload.
5. Each browser maintains one `RTCPeerConnection` per remote participant using perfect
   negotiation. Media is direct peer-to-peer; the server only carries signaling and chat.
6. Chat, presence, hand raises, participant updates, removals, and meeting end are all validated
   and broadcast from server state.

## Project structure

```text
.
├── server.js                 # process entrypoint, shutdown, signals
├── lib/
│   ├── app.js                # Express app, HTTP routes, headers, CORS, Socket.IO setup
│   ├── config.js             # environment parsing and defaults
│   ├── realtime.js           # join/resume/signaling/chat/moderation event handlers
│   ├── rooms.js              # in-memory room, participant, waiting, block store
│   ├── validation.js         # input normalization and sanitization
│   ├── rate-limit.js         # in-memory fixed-window limiter
│   └── logger.js             # small structured logger
├── views/                    # Nunjucks layouts, pages, dialog partials
├── public/
│   ├── css/                  # design tokens, components, home and room styles
│   └── js/                   # theme, common UI, media controller, home, room client
├── test/
│   ├── server.test.js        # HTTP + Socket.IO integration tests
│   ├── helpers.js
│   └── e2e/meeting.test.js   # Playwright end-to-end browser tests
├── .env.example
└── package.json
```

## Getting started

Requirements: Node.js 20.12 or newer and npm (for built-in `.env` loading).

```bash
git clone https://github.com/LelouchelawlietLIEBERT/rtc.git
cd rtc
npm ci
cp .env.example .env
npm start
```

Open <http://localhost:3000>. For development with automatic restart:

```bash
npm run dev        # node --watch server.js
```

Useful checks:

```bash
npm run check      # syntax-check server and browser JavaScript
npm test           # HTTP and Socket.IO integration tests
npm run test:e2e   # real browser tests (requires Chrome)
npm audit          # dependency audit
```

### Tests that actually run

As of the latest verification:

- `npm test` — **11/11 passing**. Covers health/security headers, CORS (including same-origin and
  rejected origins), room creation and validation, public joins, private waiting room
  admit/reject, chat isolation and rate limits, signaling authorization and cross-room isolation,
  host removal/ban/end, reconnect/resume, capacity, and lookup rate limiting.
- `npm run test:e2e` — **3/3 passing** with headless Google Chrome 156 and fake media devices.
  Covers instant room creation, lobby join, real bidirectional WebRTC audio/video, screen
  sharing, chat, hand raise, host removal (including the post-removal renderer), ending a meeting,
  theme switching, mobile-width overflow, and keyboard shortcuts.
- `npm run check` — passes.
- `npm audit` — **0 vulnerabilities** after removing the unused `nodemon`/`chokidar` development
  path and pinning the template engine's watch dependency override. Nunjucks file watching is
  disabled in this app.

The e2e suite uses `/usr/bin/google-chrome` by default. Set `CHROME_PATH` to another Chrome or
Chromium binary. If no matching browser is found, the e2e tests are skipped rather than failed.

## Configuration

Copy `.env.example` to `.env`. All variables are optional except that production deployment should
set `APP_URL` explicitly.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` enables HSTS, cache headers, and proxy defaults. |
| `PORT` | `3000` | HTTP port. Render injects this automatically. |
| `APP_URL` | `RENDER_EXTERNAL_URL` or `http://localhost:PORT` | Public origin used for invite links. |
| `CORS_ORIGINS` | empty | Extra comma-separated browser origins allowed to call the API/socket. Same-origin is always allowed. |
| `TRUST_PROXY` | true in production, false otherwise | Trust `X-Forwarded-*` headers from a reverse proxy. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, or `silent`. |
| `MAX_PARTICIPANTS` | `8` | Mesh room capacity (2–12). Every participant uploads to every other participant. |
| `ROOM_TTL_MINUTES` | `180` | Empty-room expiry (5–1440 minutes). |
| `STUN_URLS` | Google STUN servers | Comma-separated STUN URLs. |
| `TURN_URLS` | empty | Comma-separated TURN/TURNS URLs. |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | empty | Required together with `TURN_URLS`. |
| `RATE_LIMIT_API_PER_MINUTE` | `180` | General `/api` request limit per IP. |
| `RATE_LIMIT_CREATE_PER_10_MINUTES` | `30` | Room creation limit per IP. |
| `RATE_LIMIT_LOOKUP_PER_MINUTE` | `120` | Room lookup limit per IP. |
| `RATE_LIMIT_SOCKET_CONNECTS_PER_MINUTE` | `60` | Socket.IO connection attempts per IP. |

TURN is strongly recommended for production. STUN alone fails on symmetric NATs and restrictive
corporate networks. Configure a TURN service or self-host coturn, then set `TURN_URLS`,
`TURN_USERNAME`, and `TURN_CREDENTIAL`. The app sends these ICE servers to clients in the join
payload.

## Security model

- **Host identity is a server-issued bearer token.** A 32-byte random token is returned once at
  creation; only its hash is stored. Knowing the room code does not grant host powers.
- **Private-room admission** happens server-side. A non-host joining a private room is placed in
  the waiting room and cannot receive signaling, chat, or participant media until admitted.
- **Every socket event re-derives the room, participant, and host flag from socket state.**
  Client-supplied `from`, `participantId`, and names are not trusted for authorization.
- **Room-scoped signaling.** Offers, answers, and ICE candidates are relayed only to a currently
  connected participant in the same room.
- **Moderation is server-enforced.** Only the host can admit/reject waiters, remove participants,
  or end the meeting. Hosts cannot remove themselves or another host.
- **Removal blocks** apply to the removed client ID and IP for a short period. Host tokens bypass
  the block. A NAT shared by many users can therefore affect other guests from the same address.
- **Input and payload limits.** Display names, titles, chat text, SDP, ICE candidates, and Socket.IO
  message sizes are bounded and sanitized. HTML is rendered through Nunjucks autoescaping or
  `textContent`.
- **Rate limits** cover room creation, lookups, socket connections, joins, chat, and signaling.
- **HTTP hardening:** restrictive CSP, `nosniff`, `DENY` framing, referrer policy, permissions
  policy, HSTS in production, no `X-Powered-By`, origin-checked CORS, and same-origin Socket.IO
  checks.
- **Ephemeral data only.** Rooms, messages, blocks, and tokens live in process memory. There is no
  database to leak, but there is also no persistence.

WebRTC media is encrypted in transit with DTLS-SRTP between browsers. This app does not provide
application-level end-to-end identity verification, and the signaling server can see SDP/ICE and
chat messages. In a mesh call, every participant receives media directly from every other
participant.

## Deploying on Render

The repository is set up for Render's Node runtime and preserves the existing Render deployment:

1. Create a **Web Service** from the repository.
2. Build command: `npm ci`
3. Start command: `npm start`
4. Health check path: `/healthz`
5. Set environment variables:
   - `NODE_ENV=production`
   - `APP_URL=https://<your-service>.onrender.com`
   - `TRUST_PROXY=true`
   - optionally `CORS_ORIGINS`, `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`
6. Do not set `PORT`; Render provides it and the app reads it.

Render terminates TLS and forwards WebSocket upgrades, so Socket.IO works over
`https://`/`wss://` without extra configuration. Keep the service to a **single instance**: room
state is in memory. Scaling horizontally would require a shared Socket.IO adapter (for example
Redis), a shared room store, and sticky sessions; those are intentionally not included.

## Ephemeral behavior and limits

- All room state is lost when the process restarts or the Render instance sleeps/redeploys.
- Empty rooms expire after `ROOM_TTL_MINUTES`; ended rooms are kept briefly so clients receive a
  clear "meeting ended" response, then removed.
- Chat history is capped at 100 messages and exists only while the room is in memory.
- The default room capacity is 8. Mesh calls cost `(n − 1)` upload streams per participant;
  smaller rooms (2–6) perform best.
- There is no recording, file sharing, persistent chat, calendar integration, or account system.
- Screen sharing depends on browser support and is generally unavailable on mobile browsers.
- Host privileges are tied to the browser that created the room. Clearing site data or using
  another browser loses host access unless the host token is exported.

## Manual verification notes

Automated browser coverage uses headless Chrome with fake media devices. The following are
implemented but were not part of the automated suite: real camera/microphone hardware, Safari and
Firefox behavior, screen readers, and actual TURN relays. Those should be verified in the target
deployment environment before relying on them for production.

## License

MIT. Author: Ashwin Gowda.
