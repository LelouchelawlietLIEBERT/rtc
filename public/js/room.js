(function () {
  'use strict';

  var RTC = window.RTC;
  var roomApp = document.getElementById('room-app');
  if (!RTC || !roomApp) return;

  var $ = RTC.$;
  var $$ = RTC.$$;

  var CODE = String(roomApp.getAttribute('data-room-code') || '');
  var TITLE = String(roomApp.getAttribute('data-room-title') || 'Untitled meeting');
  var PRIVACY =
    roomApp.getAttribute('data-room-privacy') === 'private' ? 'private' : 'public';
  var CAPACITY = Number(roomApp.getAttribute('data-capacity')) || 8;
  var CLIENT_ID = RTC.getClientId();
  var SESSION_KEY = 'rtc.session.v1.' + CODE;
  var ACK_TIMEOUT = 8000;
  var SIGNAL_TIMEOUT = 6000;

  function el(id) {
    return document.getElementById(id);
  }

  function noop() {}

  function on(target, event, handler, options) {
    if (target) target.addEventListener(event, handler, options);
  }

  function setHidden(node, hidden) {
    if (node) node.hidden = Boolean(hidden);
  }

  function setText(node, value) {
    if (node) node.textContent = value;
  }

  function roomUrl() {
    return RTC.roomUrl(CODE, window.location.origin);
  }

  /* Session persistence ---------------------------------------------------
     The participant token is only useful for resuming a live session in
     this tab. It is intentionally kept in sessionStorage, not localStorage.
     The host credential lives in localStorage and is managed by common.js. */
  function saveSession(token) {
    if (!token) return;
    try {
      window.sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ token: token, savedAt: Date.now() }),
      );
    } catch (error) {
      // Session persistence is optional.
    }
  }

  function readSession() {
    try {
      var raw = window.sessionStorage.getItem(SESSION_KEY);
      if (!raw) return '';
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.token !== 'string') return '';
      if (!/^[a-f0-9]{64}$/.test(parsed.token)) return '';
      if (Date.now() - Number(parsed.savedAt || 0) > 1000 * 60 * 60 * 6) return '';
      return parsed.token;
    } catch (error) {
      return '';
    }
  }

  function clearSession() {
    try {
      window.sessionStorage.removeItem(SESSION_KEY);
    } catch (error) {
      // Ignore storage failures.
    }
  }

  /* Shared state ----------------------------------------------------------- */
  var state = {
    joined: false,
    joining: false,
    waiting: false,
    resuming: false,
    leaving: false,
    ended: false,
    selfId: '',
    selfName: '',
    isHost: false,
    participantToken: '',
    participants: new Map(),
    peers: new Map(),
    tiles: new Map(),
    messages: [],
    messageIds: new Set(),
    waitingRequests: [],
    iceServers: [],
    turnConfigured: false,
    startedAt: 0,
    timerId: null,
    panel: '',
    unread: 0,
    selfState: { mic: false, camera: false, sharing: false, hand: false },
    desiredMic: true,
    desiredCamera: true,
    mirror: RTC.getMirrorPreference(),
    lobbyMediaStarted: false,
    pendingJoin: null,
    earlySignals: new Map(),
    allowSubmit: false,
    resumeAttempted: false,
    resumeRetries: 0,
  };

  var media = new RTC.MediaController();
  var socket = null;

  /* Socket helpers --------------------------------------------------------- */
  function serverTimeOffset() {
    return 0;
  }

  function emitWithAck(event, payload, timeout) {
    return new Promise(function (resolve) {
      if (!socket || !socket.connected) {
        resolve({
          ok: false,
          code: 'disconnected',
          message: 'You are not connected to the server. Check your network.',
        });
        return;
      }
      var settled = false;
      var timer = window.setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve({
          ok: false,
          code: 'timeout',
          message: 'The server did not respond. Please try again.',
        });
      }, timeout || ACK_TIMEOUT);

      try {
        socket.emit(event, payload, function (response) {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve(response && typeof response === 'object' ? response : { ok: false });
        });
      } catch (error) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve({ ok: false, code: 'send_failed', message: 'The message could not be sent.' });
      }
    });
  }

  function waitForConnection(timeout) {
    return new Promise(function (resolve) {
      if (socket && socket.connected) {
        resolve(true);
        return;
      }
      if (!socket) {
        resolve(false);
        return;
      }
      var settled = false;
      var timer = window.setTimeout(function () {
        if (settled) return;
        settled = true;
        socket.off('connect', onConnect);
        resolve(false);
      }, timeout || ACK_TIMEOUT);

      function onConnect() {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        socket.off('connect', onConnect);
        resolve(true);
      }

      socket.once('connect', onConnect);
    });
  }

  /* Join payload helpers --------------------------------------------------- */
  function currentMediaState() {
    return {
      mic: Boolean(media.micEnabled),
      camera: Boolean(media.cameraEnabled),
      sharing: Boolean(media.sharing),
      hand: Boolean(state.selfState.hand),
    };
  }

  function displayName() {
    var input = el('lobby-name');
    var value = input ? input.value : RTC.getDisplayName();
    return RTC.setDisplayName(value) || String(value || '').trim().slice(0, 48);
  }

  /* View switching --------------------------------------------------------- */
  var VIEWS = ['lobby-view', 'waiting-view', 'exit-view', 'meeting-view'];

  function showView(name) {
    VIEWS.forEach(function (id) {
      var node = el(id);
      if (node) node.hidden = id !== name;
    });
  }

  function showLobby() {
    showView('lobby-view');
    var nameInput = el('lobby-name');
    if (nameInput) {
      nameInput.value = RTC.getDisplayName();
      RTC.applyAvatar(el('preview-avatar'), nameInput.value || 'Guest');
    }
    updateHostBadge();
    startLobbyMedia();
  }

  /* Lobby media ------------------------------------------------------------ */
  function mediaStatus(kind, title, message) {
    var note = el('media-status');
    var dot = el('preview-dot');
    var text = el('preview-status-text');

    if (dot) {
      dot.classList.toggle('is-ok', kind === 'ok');
      dot.classList.toggle('is-error', kind === 'error');
    }

    if (text) {
      text.textContent =
        kind === 'ok'
          ? 'You are ready to join'
          : kind === 'error'
            ? 'Check your device permissions'
            : 'Requesting camera and microphone…';
    }

    if (!note) return;
    note.className = 'status-note' + (kind === 'error' ? ' status-note--error' : '');
    note.replaceChildren();
    var icon = document.createElement('span');
    icon.className = 'status-note__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.appendChild(
      RTC.icon(kind === 'error' ? 'triangle-alert' : kind === 'ok' ? 'circle-check' : 'loader-circle'),
    );
    note.appendChild(icon);

    var body = document.createElement('div');
    var strong = document.createElement('strong');
    strong.textContent = title;
    var paragraph = document.createElement('p');
    paragraph.textContent = message;
    body.append(strong, paragraph);
    note.appendChild(body);
    RTC.refreshIcons();
  }

  function updateLobbyButtons() {
    var micOn = Boolean(media.micEnabled);
    var cameraOn = Boolean(media.cameraEnabled);

    var micButton = el('lobby-mic');
    if (micButton) {
      micButton.classList.toggle('is-off', !micOn);
      micButton.setAttribute('aria-pressed', micOn ? 'true' : 'false');
      micButton.setAttribute('aria-label', micOn ? 'Turn microphone off' : 'Turn microphone on');
      RTC.setIcon(micButton, micOn ? 'mic' : 'mic-off');
    }

    var cameraButton = el('lobby-camera');
    if (cameraButton) {
      cameraButton.classList.toggle('is-off', !cameraOn);
      cameraButton.setAttribute('aria-pressed', cameraOn ? 'true' : 'false');
      cameraButton.setAttribute('aria-label', cameraOn ? 'Turn camera off' : 'Turn camera on');
      RTC.setIcon(cameraButton, cameraOn ? 'video' : 'video-off');
    }

    var chip = el('preview-status');
    if (chip) {
      chip.classList.toggle('is-live', cameraOn);
      chip.classList.toggle('is-error', false);
      chip.replaceChildren(
        RTC.icon(cameraOn ? 'camera' : 'camera-off'),
        document.createTextNode(cameraOn ? 'Camera on' : 'Camera off'),
      );
    }

    var frame = el('preview-frame');
    if (frame) frame.classList.toggle('is-camera-off', !cameraOn);
    setHidden(el('preview-placeholder'), cameraOn);

    var preview = el('preview-video');
    if (preview) {
      preview.style.transform = state.mirror ? 'scaleX(-1)' : 'none';
      if (preview.srcObject !== media.stream) preview.srcObject = media.stream;
      if (cameraOn) {
        var playing = preview.play();
        if (playing && typeof playing.catch === 'function') playing.catch(noop);
      }
    }

    var statusStrong = el('mic-device-status');
    if (statusStrong) statusStrong.textContent = micOn ? 'On' : 'Off';
    var cameraStatus = el('camera-device-status');
    if (cameraStatus) cameraStatus.textContent = cameraOn ? 'On' : 'Off';
  }

  function deviceLabel(device, index, kind) {
    if (device.label) return device.label;
    var names = {
      audioinput: 'Microphone',
      videoinput: 'Camera',
      audiooutput: 'Speaker',
    };
    return (names[kind] || 'Device') + ' ' + (index + 1);
  }

  function populateDeviceSelects() {
    var groups = media.devices || {};
    $$('[data-device-select]').forEach(function (select) {
      var kind = select.getAttribute('data-device-select');
      var list = groups[kind] || [];
      var preferred =
        kind === 'audioinput'
          ? media.preferredAudioId
          : kind === 'videoinput'
            ? media.preferredVideoId
            : media.preferredOutputId;

      select.replaceChildren();
      var fallback = document.createElement('option');
      fallback.value = '';
      fallback.textContent = 'System default';
      select.appendChild(fallback);

      list.forEach(function (device, index) {
        var option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = deviceLabel(device, index, kind);
        select.appendChild(option);
      });

      if (preferred && list.some(function (item) { return item.deviceId === preferred; })) {
        select.value = preferred;
      } else {
        select.value = '';
      }
    });

    var speakerSupported = RTC.mediaSupport.speakerSelection();
    setHidden(el('speaker-field'), !speakerSupported);
    setHidden(el('meeting-speaker-field'), !speakerSupported);
  }

  async function startLobbyMedia() {
    if (state.lobbyMediaStarted || state.joined) return;
    state.lobbyMediaStarted = true;
    mediaStatus('loading', 'Checking your devices', 'Browser permission may be requested.');

    var result;
    try {
      result = await media.initialize({ audio: true, video: true });
    } catch (error) {
      result = { audioError: error, videoError: error };
    }

    state.desiredMic = Boolean(media.getAudioTrack());
    state.desiredCamera = Boolean(media.getCameraTrack());

    if (result.audioError) {
      var audioCopy = RTC.describeMediaError(result.audioError);
      mediaStatus(
        'error',
        audioCopy.title || 'Microphone unavailable',
        audioCopy.userMessage || audioCopy.message || 'You can join muted.',
      );
    } else if (result.videoError) {
      var videoCopy = RTC.describeMediaError(result.videoError);
      mediaStatus(
        'error',
        videoCopy.title || 'Camera unavailable',
        videoCopy.userMessage || videoCopy.message || 'You can join with your camera off.',
      );
    } else {
      mediaStatus(
        'ok',
        'Camera and microphone are ready',
        'You can change devices before joining.',
      );
    }

    updateLobbyButtons();
    populateDeviceSelects();
  }

  async function toggleLobbyMic() {
    try {
      var enabled = await media.setMic(!media.micEnabled);
      state.desiredMic = enabled;
      updateLobbyButtons();
    } catch (error) {
      var copy = RTC.describeMediaError(error);
      RTC.toast({
        type: 'error',
        title: copy.title || 'Microphone unavailable',
        message: copy.userMessage || copy.message,
      });
      updateLobbyButtons();
    }
  }

  async function toggleLobbyCamera() {
    try {
      var enabled = await media.setCamera(!media.cameraEnabled);
      state.desiredCamera = enabled;
      updateLobbyButtons();
    } catch (error) {
      var copy = RTC.describeMediaError(error);
      RTC.toast({
        type: 'error',
        title: copy.title || 'Camera unavailable',
        message: copy.userMessage || copy.message,
      });
      updateLobbyButtons();
    }
  }

  /* Joining ---------------------------------------------------------------- */
  function showLobbyError(message) {
    var error = el('lobby-error');
    if (!error) return;
    error.textContent = message || '';
    error.hidden = !message;
  }

  function handleJoinFailure(response) {
    var code = response && response.code;
    var message = (response && response.message) || 'Unable to join this meeting.';

    if (code === 'room_not_found' || code === 'room_ended' || code === 'already_connected' || code === 'access_blocked') {
      showExit({
        icon: code === 'access_blocked' ? 'ban' : code === 'already_connected' ? 'monitor-x' : 'door-closed',
        title:
          code === 'room_ended'
            ? 'This meeting has ended'
            : code === 'already_connected'
              ? 'Already connected elsewhere'
              : code === 'access_blocked'
                ? 'You cannot rejoin'
                : 'Meeting unavailable',
        message: message,
        primaryLabel: 'Back to home',
        onPrimary: function () {
          window.location.assign('/');
        },
      });
      return;
    }

    if (code === 'rate_limited') {
      var seconds = Math.ceil((Number(response.retryAfterMs) || 30000) / 1000);
      showLobbyError('Too many attempts. Try again in ' + seconds + ' seconds.');
      return;
    }

    showLobbyError(message);
    RTC.toast({
      type: 'error',
      title: 'Could not join',
      message: message,
    });
  }

  async function joinMeeting() {
    if (state.joining || state.joined || state.waiting) return;
    showLobbyError('');

    var input = el('lobby-name');
    var name = input ? RTC.setDisplayName(input.value) : RTC.getDisplayName();
    if (!name) {
      showLobbyError('Enter a display name to join.');
      if (input) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      }
      return;
    }
    if (input) input.removeAttribute('aria-invalid');

    var button = el('join-meeting');
    state.joining = true;
    RTC.setButtonLoading(button, true, 'Joining…');

    var connected = await waitForConnection(ACK_TIMEOUT);
    if (!connected) {
      state.joining = false;
      RTC.setButtonLoading(button, false);
      showLobbyError('Could not reach the server. Check your connection and try again.');
      return;
    }

    state.selfName = name;
    state.desiredMic = Boolean(media.micEnabled);
    state.desiredCamera = Boolean(media.cameraEnabled);

    var payload = {
      code: CODE,
      displayName: name,
      clientId: CLIENT_ID,
      state: currentMediaState(),
    };
    var hostToken = RTC.getHostToken(CODE);
    if (hostToken) payload.hostToken = hostToken;

    var response = await emitWithAck('room:join', payload, ACK_TIMEOUT);
    state.joining = false;
    RTC.setButtonLoading(button, false);

    if (!response || response.ok === false) {
      handleJoinFailure(response);
      return;
    }

    if (response.status === 'waiting') {
      enterWaiting(response);
      return;
    }

    state.desiredCamera = Boolean(currentMediaState().camera);
    state.desiredMic = Boolean(currentMediaState().mic);
    enterMeeting(response);
  }

  function enterWaiting(response) {
    state.waiting = true;
    state.pendingJoin = {
      code: CODE,
      displayName: state.selfName,
      clientId: CLIENT_ID,
      state: currentMediaState(),
    };
    state.desiredMic = Boolean(media.micEnabled);
    state.desiredCamera = Boolean(media.cameraEnabled);

    media.stopAll();
    updateLobbyButtons();

    RTC.applyAvatar(el('waiting-avatar'), state.selfName || 'Guest');
    var message = el('waiting-message');
    if (message) {
      message.textContent = response.hostConnected
        ? 'The host has been notified. Keep this tab open until they admit you.'
        : 'The host is not here yet. Keep this tab open; you will join once the host admits you.';
    }
    showView('waiting-view');
  }

  async function cancelWaiting() {
    var response = await emitWithAck('room:cancel-waiting', {}, ACK_TIMEOUT);
    if (response && response.ok) {
      state.waiting = false;
      state.pendingJoin = null;
      showLobby();
      state.lobbyMediaStarted = false;
      startLobbyMedia();
      return;
    }
    RTC.toast({
      type: 'warning',
      title: 'Still waiting',
      message: (response && response.message) || 'Your request could not be cancelled yet.',
    });
  }

  /* Meeting bootstrap ------------------------------------------------------ */
  function updateHostBadge() {
    var hasHostToken = Boolean(RTC.getHostToken(CODE));
    setHidden(el('host-badge'), !hasHostToken);
    var note = el('lobby-room-note');
    if (note && hasHostToken) {
      note.textContent = 'You will join this meeting as the host.';
    }
  }

  function updateHostControls() {
    setHidden(el('end-meeting'), !state.isHost);
    updateHostBadge();
  }

  function updateTurnStatus() {
    var badge = el('turn-badge');
    var text = el('turn-status');
    if (!badge || !text) return;
    if (state.turnConfigured) {
      badge.textContent = 'TURN';
      badge.className = 'badge badge--success';
      text.textContent = 'A TURN relay is configured for restrictive networks.';
    } else {
      badge.textContent = 'STUN only';
      badge.className = 'badge badge--warning';
      text.textContent =
        'No TURN relay is configured. Some peers may be unable to connect on strict networks.';
    }
  }

  function startTimer() {
    stopTimer();
    state.timerId = window.setInterval(updateTimer, 1000);
    updateTimer();
  }

  function stopTimer() {
    if (state.timerId) {
      window.clearInterval(state.timerId);
      state.timerId = null;
    }
  }

  function updateTimer() {
    var node = el('meeting-timer');
    if (!node) return;
    var span = node.querySelector('span');
    setText(span, RTC.formatDuration((Date.now() - state.startedAt) / 1000));
  }

  function setConnection(status, label) {
    var pill = el('connection-pill');
    if (pill) pill.setAttribute('data-state', status);
    var labels = {
      connected: 'Connected',
      connecting: 'Connecting…',
      reconnecting: 'Reconnecting…',
      disconnected: 'Disconnected',
    };
    setText(el('connection-label'), label || labels[status] || 'Connected');
    var chatStatus = el('chat-status');
    if (chatStatus) {
      chatStatus.hidden = status === 'connected';
      chatStatus.textContent =
        status === 'connected' ? '' : 'Connection lost. Messages will send after reconnecting.';
    }
  }

  function addParticipant(participant) {
    if (!participant || !participant.id) return;
    state.participants.set(participant.id, participant);
    if (participant.id !== state.selfId) flushEarlySignals(participant.id);
  }

  function updateParticipantsCounts() {
    var count = state.participants.size;
    var countNode = el('participant-count');
    if (countNode) setText(countNode.querySelector('span'), String(count));
    setText(el('details-participants'), String(count));
    setText(el('people-total'), String(count));
    var grid = el('video-grid');
    if (grid) grid.setAttribute('data-count', String(Math.max(1, count)));
    setHidden(el('alone-state'), !(state.joined && count === 1));
  }

  function selfVideoStream() {
    var track = media.getVideoTrack();
    if (!track) return null;
    if (!state.selfStream) state.selfStream = new MediaStream();
    var current = state.selfStream.getVideoTracks()[0];
    if (current !== track) {
      if (current) state.selfStream.removeTrack(current);
      state.selfStream.addTrack(track);
    }
    return state.selfStream;
  }

  function updateSelfTileStream() {
    var self = state.participants.get(state.selfId);
    if (!self) return;
    var tile = state.tiles.get(state.selfId);
    if (!tile) {
      renderParticipants();
      return;
    }
    var stream = selfVideoStream();
    if (stream) {
      if (tile.video.srcObject !== stream) {
        tile.video.srcObject = stream;
        var playing = tile.video.play();
        if (playing && typeof playing.catch === 'function') playing.catch(noop);
      }
    } else {
      tile.video.srcObject = null;
    }
  }

  function showMediaToast(error) {
    var copy = RTC.describeMediaError(error);
    RTC.toast({
      type: 'warning',
      title: copy.title || 'Device unavailable',
      message: copy.userMessage || copy.message || 'You can continue with that device off.',
      duration: 5000,
    });
  }

  async function ensureMeetingMedia() {
    if (!state.desiredMic) state.selfState.mic = false;
    if (!state.desiredCamera) state.selfState.camera = false;

    if (state.desiredMic && !media.getAudioTrack()) {
      try {
        await media.acquireAudio();
        state.selfState.mic = true;
      } catch (error) {
        state.selfState.mic = false;
        state.desiredMic = false;
        showMediaToast(error);
      }
    }
    if (state.desiredCamera && !media.getCameraTrack()) {
      try {
        await media.acquireVideo();
        state.selfState.camera = true;
      } catch (error) {
        state.selfState.camera = false;
        state.desiredCamera = false;
        showMediaToast(error);
      }
    }

    if (media.getAudioTrack() && !state.desiredMic) {
      await media.setMic(false);
    }
    if (media.getCameraTrack() && !state.desiredCamera) {
      await media.setCamera(false);
    }

    state.selfState.sharing = Boolean(media.sharing);
    state.selfState.mic = Boolean(media.micEnabled);
    state.selfState.camera = Boolean(media.cameraEnabled);
    updateSelfTileStream();
    syncLocalTracks();
    updateControlButtons();
    renderParticipants();
    publishState();
  }

  function publishState() {
    if (!state.joined || state.leaving || state.ended) return;
    var payload = currentMediaState();
    payload.hand = Boolean(state.selfState.hand);
    state.selfState.mic = payload.mic;
    state.selfState.camera = payload.camera;
    state.selfState.sharing = payload.sharing;

    var self = state.participants.get(state.selfId);
    if (self) self.state = Object.assign({}, self.state, payload);

    updateControlButtons();
    renderParticipants();

    emitWithAck('participant:state', payload, 5000).then(function (response) {
      if (response && response.ok === false && response.code === 'not_in_meeting') {
        handleSessionLost(response.message);
      }
    });
  }

  function mergeMessages(list) {
    if (!Array.isArray(list)) return;
    var changed = false;
    list.forEach(function (message) {
      if (!message || !message.id || state.messageIds.has(message.id)) return;
      state.messageIds.add(message.id);
      state.messages.push(message);
      changed = true;
    });
    if (changed) {
      state.messages.sort(function (a, b) {
        return Number(a.timestamp) - Number(b.timestamp);
      });
      renderMessages();
    }
  }

  function setSelfFromPayload(payload) {
    state.selfId = payload.self.id;
    state.selfName = payload.self.name;
    state.isHost = Boolean(payload.self.isHost);
    state.selfState = {
      mic: Boolean(payload.self.state && payload.self.state.mic),
      camera: Boolean(payload.self.state && payload.self.state.camera),
      sharing: Boolean(payload.self.state && payload.self.state.sharing),
      hand: Boolean(payload.self.state && payload.self.state.hand),
    };
    state.desiredMic = state.selfState.mic;
    state.desiredCamera = state.selfState.camera;
    state.startedAt = Number(payload.self.joinedAt) || Date.now();
  }

  function enterMeeting(payload, options) {
    var config = options || {};
    if (!payload || !payload.self || !payload.self.id) return;
    var wasJoined = state.joined;

    state.joined = true;
    state.waiting = false;
    state.joining = false;
    state.ended = false;
    state.participantToken = payload.participantToken || state.participantToken;
    if (state.participantToken) saveSession(state.participantToken);
    setSelfFromPayload(payload);

    if (Array.isArray(payload.iceServers)) state.iceServers = payload.iceServers;
    state.turnConfigured = Boolean(payload.turnConfigured);
    state.selfState.sharing = Boolean(media.sharing);
    state.selfState.mic = Boolean(media.micEnabled) || state.selfState.mic;
    state.selfState.camera = Boolean(media.cameraEnabled) || state.selfState.camera;

    setConnection('connected');
    setHidden(el('share-banner'), !media.sharing);
    updateHostControls();
    updateTurnStatus();

    if (!wasJoined) {
      state.participants.clear();
      state.messages = [];
      state.messageIds = new Set();
      state.panel = '';
      state.unread = 0;
      showView('meeting-view');
      if (!config.resume) {
        RTC.recent.add({
          code: CODE,
          title: TITLE,
          privacy: PRIVACY,
          isHost: state.isHost,
        });
      }
      startTimer();
    }

    addParticipant(Object.assign({}, payload.self, { state: Object.assign({}, state.selfState) }));
    (payload.peers || []).forEach(function (participant) {
      addParticipant(participant);
    });
    if (wasJoined) {
      reconcilePeers(payload.peers || []);
      mergeMessages(payload.messages || []);
    } else {
      mergeMessages(payload.messages || []);
      renderParticipants();
      (payload.peers || []).forEach(function (participant) {
        ensurePeer(participant.id);
      });
    }

    renderWaiting(payload.waitingRequests || []);
    updateParticipantsCounts();
    updateControlButtons();
    ensureMeetingMedia();
    setConnection('connected');
  }

  /* Participant tiles ------------------------------------------------------ */
  function createTile(participant) {
    var root = document.createElement('div');
    root.className = 'tile';
    root.setAttribute('data-participant-id', participant.id);

    var video = document.createElement('video');
    video.autoplay = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    root.appendChild(video);

    var placeholder = document.createElement('div');
    placeholder.className = 'tile__placeholder';
    placeholder.hidden = true;
    var avatar = document.createElement('span');
    avatar.className = 'avatar';
    RTC.applyAvatar(avatar, participant.name);
    var placeholderText = document.createElement('span');
    placeholderText.textContent = 'Camera is off';
    placeholder.append(avatar, placeholderText);
    root.appendChild(placeholder);

    var top = document.createElement('div');
    top.className = 'tile__top';
    var leftBadges = document.createElement('div');
    leftBadges.className = 'tile__badges';
    var rightBadges = document.createElement('div');
    rightBadges.className = 'tile__badges';
    top.append(leftBadges, rightBadges);
    root.appendChild(top);

    var bottom = document.createElement('div');
    bottom.className = 'tile__bottom';
    var name = document.createElement('span');
    name.className = 'tile__name';
    bottom.appendChild(name);
    root.appendChild(bottom);

    var connecting = document.createElement('div');
    connecting.className = 'tile__connecting';
    connecting.hidden = true;
    connecting.append(RTC.icon('loader-circle', 'spin'), document.createTextNode('Connecting…'));
    root.appendChild(connecting);

    var offline = document.createElement('div');
    offline.className = 'tile__offline';
    offline.hidden = true;
    offline.append(RTC.icon('wifi-off'), document.createTextNode('Connection lost'));
    root.appendChild(offline);

    var tile = {
      id: participant.id,
      root: root,
      video: video,
      placeholder: placeholder,
      avatar: avatar,
      leftBadges: leftBadges,
      rightBadges: rightBadges,
      name: name,
      connecting: connecting,
      offline: offline,
    };
    state.tiles.set(participant.id, tile);
    RTC.refreshIcons();
    return tile;
  }

  function badge(name, label, modifier) {
    var node = document.createElement('span');
    node.className = 'tile__badge' + (modifier ? ' tile__badge--' + modifier : '');
    node.append(RTC.icon(name), document.createTextNode(label));
    return node;
  }

  function updateTile(participant) {
    var tile = state.tiles.get(participant.id) || createTile(participant);
    var isSelf = participant.id === state.selfId;
    var participantState = isSelf ? state.selfState : participant.state || {};
    var cameraOn = Boolean(participantState.camera || participantState.sharing);
    var sharing = Boolean(participantState.sharing);
    var hand = Boolean(participantState.hand);
    var connected = isSelf || participant.connected !== false;

    tile.root.classList.toggle('tile--self', isSelf);
    tile.root.classList.toggle('tile--sharing', sharing);
    tile.root.classList.toggle('tile--camera-off', !cameraOn);
    tile.root.setAttribute(
      'aria-label',
      participant.name + (isSelf ? ' (you)' : '') + (cameraOn ? '' : ', camera off'),
    );
    tile.placeholder.hidden = cameraOn;
    RTC.applyAvatar(tile.avatar, participant.name);

    tile.video.muted = isSelf;
    if (isSelf) {
      var ownStream = selfVideoStream();
      if (tile.video.srcObject !== ownStream) {
        tile.video.srcObject = ownStream;
        if (ownStream) {
          var selfPlay = tile.video.play();
          if (selfPlay && typeof selfPlay.catch === 'function') selfPlay.catch(noop);
        }
      }
    } else {
      var peer = state.peers.get(participant.id);
      var stream = peer ? peer.stream : null;
      if (tile.video.srcObject !== stream) {
        tile.video.srcObject = stream || null;
        if (stream) playRemoteVideo(tile.video);
      }
    }

    tile.video.style.transform = isSelf
      ? sharing
        ? 'none'
        : state.mirror
          ? 'scaleX(-1)'
          : 'none'
      : '';

    tile.name.replaceChildren();
    tile.name.appendChild(RTC.icon(participantState.mic ? 'mic' : 'mic-off', participantState.mic ? '' : 'is-muted'));
    tile.name.appendChild(document.createTextNode(participant.name));
    if (isSelf) {
      var suffix = document.createElement('span');
      suffix.className = 'tile__name-suffix';
      suffix.textContent = ' (You)';
      tile.name.appendChild(suffix);
    }

    tile.leftBadges.replaceChildren();
    if (participant.isHost) {
      tile.leftBadges.appendChild(badge('crown', 'Host', 'host'));
    }
    if (sharing) {
      tile.leftBadges.appendChild(badge('monitor-up', 'Presenting', 'presenting'));
    }

    tile.rightBadges.replaceChildren();
    if (hand) {
      tile.rightBadges.appendChild(badge('hand', 'Hand raised', 'hand'));
    }

    setHidden(tile.offline, connected);
    var pc = !isSelf && peerConnection(participant.id);
    var connecting =
      !isSelf &&
      connected &&
      (!pc || (pc.connectionState !== 'connected' && pc.connectionState !== 'completed'));
    setHidden(tile.connecting, !connecting);

    if (!isSelf) applySpeakerToVideo(tile.video);
    return tile;
  }

  function renderParticipants() {
    var list = Array.from(state.participants.values());
    list.sort(function (a, b) {
      if (a.id === state.selfId) return 1;
      if (b.id === state.selfId) return -1;
      return Number(a.joinedAt || 0) - Number(b.joinedAt || 0);
    });

    var grid = el('video-grid');
    if (!grid) return;
    list.forEach(function (participant) {
      var tile = updateTile(participant);
      grid.appendChild(tile.root);
    });

    Array.from(state.tiles.keys()).forEach(function (id) {
      if (state.participants.has(id)) return;
      disposeTile(state.tiles.get(id));
      state.tiles.delete(id);
    });

    updateParticipantsCounts();
    renderPeople();
    RTC.refreshIcons();
  }

  function disposeTile(tile) {
    if (!tile) return;
    try {
      tile.video.pause();
      tile.video.srcObject = null;
    } catch (error) {
      // The element may already be detached.
    }
    tile.root.remove();
  }

  function removeParticipant(participantId) {
    state.participants.delete(participantId);
    var tile = state.tiles.get(participantId);
    if (tile) {
      disposeTile(tile);
      state.tiles.delete(participantId);
    }
    closePeer(participantId);
    renderParticipants();
  }

  /* WebRTC mesh ------------------------------------------------------------ */
  function localSendStream() {
    if (!state.sendStream) state.sendStream = new MediaStream();
    var desired = [media.getAudioTrack(), media.getVideoTrack()].filter(Boolean);
    state.sendStream.getTracks().forEach(function (track) {
      if (desired.indexOf(track) === -1) state.sendStream.removeTrack(track);
    });
    desired.forEach(function (track) {
      if (state.sendStream.getTracks().indexOf(track) === -1) {
        state.sendStream.addTrack(track);
      }
    });
    return state.sendStream;
  }

  function addSender(peer, kind) {
    var track = kind === 'audio' ? media.getAudioTrack() : media.getVideoTrack();
    if (!track) return null;
    var sender = peer.pc.addTrack(track, localSendStream());
    if (kind === 'audio') peer.audioSender = sender;
    else peer.videoSender = sender;
    return sender;
  }

  function createPeer(participantId) {
    if (state.peers.has(participantId)) return state.peers.get(participantId);
    if (!state.participants.has(participantId) || participantId === state.selfId) return null;
    if (typeof window.RTCPeerConnection !== 'function') {
      RTC.toast({
        type: 'error',
        title: 'WebRTC is not supported',
        message: 'Use a current version of Chrome, Edge, Firefox, or Safari.',
      });
      return null;
    }

    var pc;
    try {
      pc = new RTCPeerConnection({ iceServers: state.iceServers || [] });
    } catch (error) {
      RTC.toast({
        type: 'error',
        title: 'Could not start WebRTC',
        message: 'Your browser blocked the peer connection.',
      });
      return null;
    }

    var peer = {
      id: participantId,
      pc: pc,
      stream: new MediaStream(),
      polite: state.selfId > participantId,
      makingOffer: false,
      ignoreOffer: false,
      pendingCandidates: [],
      audioSender: null,
      videoSender: null,
      restarting: false,
    };
    state.peers.set(participantId, peer);

    var stream = localSendStream();
    var audio = media.getAudioTrack();
    var video = media.getVideoTrack();
    if (audio) peer.audioSender = pc.addTrack(audio, stream);
    if (video) peer.videoSender = pc.addTrack(video, stream);

    pc.onicecandidate = function (event) {
      if (event.candidate) {
        var json = typeof event.candidate.toJSON === 'function' ? event.candidate.toJSON() : event.candidate;
        sendSignal('webrtc:ice', participantId, { candidate: json });
      } else {
        sendSignal('webrtc:ice', participantId, { candidate: null });
      }
    };

    pc.ontrack = function (event) {
      var incoming = event.streams && event.streams[0];
      if (incoming) {
        peer.stream = incoming;
      } else if (peer.stream.getTracks().indexOf(event.track) === -1) {
        peer.stream.addTrack(event.track);
      }
      var tile = state.tiles.get(participantId);
      if (tile) {
        tile.video.srcObject = peer.stream;
        playRemoteVideo(tile.video);
      }
      updateTile(state.participants.get(participantId) || { id: participantId, name: 'Guest', state: {} });
      RTC.refreshIcons();
    };

    pc.onnegotiationneeded = function () {
      makeOffer(peer, false);
    };

    pc.onconnectionstatechange = function () {
      var tile = state.tiles.get(participantId);
      if (tile) updateTile(state.participants.get(participantId) || { id: participantId, name: 'Guest', state: {} });
      if (pc.connectionState === 'failed') {
        restartPeer(peer);
      }
      RTC.refreshIcons();
    };

    pc.oniceconnectionstatechange = function () {
      if (pc.iceConnectionState === 'failed') restartPeer(peer);
    };

    return peer;
  }

  function ensurePeer(participantId) {
    return state.peers.get(participantId) || createPeer(participantId);
  }

  function peerConnection(participantId) {
    var peer = state.peers.get(participantId);
    return peer ? peer.pc : null;
  }

  async function makeOffer(peer, iceRestart) {
    if (!state.joined || state.leaving || !peer || peer.pc.signalingState === 'closed') return;
    try {
      peer.makingOffer = true;
      var offer = await peer.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      if (peer.pc.signalingState === 'closed') return;
      await peer.pc.setLocalDescription(offer);
      await sendSignal('webrtc:offer', peer.id, {
        description: peer.pc.localDescription,
        reconnect: Boolean(iceRestart),
      });
    } catch (error) {
      // Negotiation failures are retried when the connection state changes.
    } finally {
      peer.makingOffer = false;
    }
  }

  function restartPeer(peer) {
    if (!peer || peer.pc.signalingState === 'closed' || peer.restarting) return;
    peer.restarting = true;
    try {
      peer.pc.restartIce();
    } catch (error) {
      // Older browsers may not expose restartIce.
    }
    window.setTimeout(function () {
      if (!peer || peer.pc.signalingState === 'closed') {
        peer && (peer.restarting = false);
        return;
      }
      if (peer.pc.signalingState === 'stable' && !peer.makingOffer) {
        makeOffer(peer, true).then(function () {
          peer.restarting = false;
        });
      } else {
        peer.restarting = false;
      }
    }, 400);
  }

  function closePeer(participantId) {
    var peer = state.peers.get(participantId);
    if (!peer) return;
    state.peers.delete(participantId);
    try {
      peer.pc.onicecandidate = null;
      peer.pc.ontrack = null;
      peer.pc.onnegotiationneeded = null;
      peer.pc.onconnectionstatechange = null;
      peer.pc.oniceconnectionstatechange = null;
      peer.pc.close();
    } catch (error) {
      // Ignore close failures.
    }
  }

  function syncPeerTrack(peer, kind, track) {
    if (!peer || !peer.pc || peer.pc.signalingState === 'closed') return;
    var key = kind === 'audio' ? 'audioSender' : 'videoSender';
    var sender = peer[key];

    if (!sender) {
      if (track) addSender(peer, kind);
      return;
    }
    if (track) {
      if (sender.track !== track) {
        var replaced = sender.replaceTrack(track);
        if (replaced && typeof replaced.catch === 'function') replaced.catch(noop);
      }
      return;
    }
    try {
      peer.pc.removeTrack(sender);
    } catch (error) {
      // The sender may already be removed.
    }
    peer[key] = null;
  }

  function syncLocalTracks() {
    var audio = media.getAudioTrack();
    var video = media.getVideoTrack();
    state.peers.forEach(function (peer) {
      syncPeerTrack(peer, 'audio', audio);
      syncPeerTrack(peer, 'video', video);
    });
  }

  async function sendSignal(event, to, payload) {
    if (!state.joined || !socket || !socket.connected) return;
    var data = Object.assign({ to: to }, payload || {});
    var response = await emitWithAck(event, data, SIGNAL_TIMEOUT);
    if (response && response.ok === false && response.code === 'peer_unavailable') {
      closePeer(to);
      var tile = state.tiles.get(to);
      if (tile) tile.connecting.hidden = true;
    }
  }

  async function handleOffer(peer, payload) {
    var description = payload.description;
    if (!description) return;
    var pc = peer.pc;
    var offerCollision =
      description.type === 'offer' &&
      (peer.makingOffer || pc.signalingState !== 'stable');
    peer.ignoreOffer = !peer.polite && offerCollision;
    if (peer.ignoreOffer) return;

    try {
      await pc.setRemoteDescription(description);
      await flushCandidates(peer);
      if (description.type === 'offer') {
        var answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendSignal('webrtc:answer', peer.id, { description: pc.localDescription });
      }
    } catch (error) {
      // A later negotiation will retry.
    }
  }

  async function handleAnswer(peer, payload) {
    if (!payload.description) return;
    try {
      await peer.pc.setRemoteDescription(payload.description);
      await flushCandidates(peer);
    } catch (error) {
      // Ignore stale answers from a previous negotiation.
    }
  }

  async function handleIce(peer, payload) {
    if (payload.candidate === null) return;
    if (!payload.candidate) return;
    if (!peer.pc.remoteDescription || !peer.pc.remoteDescription.type) {
      peer.pendingCandidates.push(payload.candidate);
      return;
    }
    try {
      await peer.pc.addIceCandidate(payload.candidate);
    } catch (error) {
      // Candidates that arrive too late are safe to ignore.
    }
  }

  async function flushCandidates(peer) {
    var queued = peer.pendingCandidates.splice(0);
    for (var index = 0; index < queued.length; index += 1) {
      try {
        await peer.pc.addIceCandidate(queued[index]);
      } catch (error) {
        // Ignore invalid or stale candidates.
      }
    }
  }

  function queueEarlySignal(participantId, event, payload) {
    var list = state.earlySignals.get(participantId) || [];
    list.push({ event: event, payload: payload });
    state.earlySignals.set(participantId, list);
  }

  function flushEarlySignals(participantId) {
    var list = state.earlySignals.get(participantId);
    if (!list || !list.length) return;
    state.earlySignals.delete(participantId);
    list.forEach(function (item) {
      handleSignal(item.event, item.payload);
    });
  }

  function handleSignal(event, payload) {
    if (!payload || !payload.from || payload.from === state.selfId) return;
    if (!state.participants.has(payload.from)) {
      queueEarlySignal(payload.from, event, payload);
      return;
    }
    var peer = ensurePeer(payload.from);
    if (!peer) return;
    if (event === 'webrtc:offer') handleOffer(peer, payload);
    else if (event === 'webrtc:answer') handleAnswer(peer, payload);
    else if (event === 'webrtc:ice') handleIce(peer, payload);
  }

  function reconcilePeers(peerList) {
    var expected = new Set(
      (peerList || []).map(function (participant) {
        return participant.id;
      }),
    );
    expected.add(state.selfId);

    state.peers.forEach(function (peer, id) {
      if (expected.has(id)) {
        restartPeer(peer);
      } else {
        closePeer(id);
      }
    });
    Array.from(state.participants.keys()).forEach(function (id) {
      if (!expected.has(id)) removeParticipant(id);
    });
    (peerList || []).forEach(function (participant) {
      addParticipant(participant);
      var existing = state.peers.get(participant.id);
      if (existing) {
        restartPeer(existing);
      } else {
        ensurePeer(participant.id);
      }
    });
    renderParticipants();
  }

  /* Chat ------------------------------------------------------------------- */
  function chatMessageNode(message) {
    var self = message.senderId === state.selfId;
    var row = document.createElement('div');
    row.className = 'chat-message' + (self ? ' chat-message--self' : '');
    row.setAttribute('data-message-id', message.id);

    var avatar = document.createElement('span');
    avatar.className = 'avatar';
    RTC.applyAvatar(avatar, message.senderName);
    row.appendChild(avatar);

    var body = document.createElement('div');
    body.className = 'chat-message__body';

    var head = document.createElement('div');
    head.className = 'chat-message__head';
    var name = document.createElement('span');
    name.className = 'chat-message__name';
    name.textContent = message.senderName;
    head.appendChild(name);
    if (self) {
      var you = document.createElement('span');
      you.className = 'chat-message__you';
      you.textContent = 'You';
      head.appendChild(you);
    }
    var time = document.createElement('span');
    time.className = 'chat-message__time';
    time.textContent = RTC.formatTime(message.timestamp);
    head.appendChild(time);
    body.appendChild(head);

    var text = document.createElement('div');
    text.className = 'chat-message__text';
    text.textContent = message.text;
    body.appendChild(text);

    row.appendChild(body);
    return row;
  }

  function renderMessages() {
    var container = el('chat-messages');
    if (!container) return;
    container.replaceChildren();
    state.messages.forEach(function (message) {
      container.appendChild(chatMessageNode(message));
    });
    setHidden(el('chat-empty'), state.messages.length > 0);
    container.scrollTop = container.scrollHeight;
    updateChatBadge();
  }

  function updateChatBadge() {
    var nodes = [el('chat-unread'), el('chat-control-badge')];
    nodes.forEach(function (node) {
      if (!node) return;
      node.textContent = String(state.unread);
      node.hidden = state.unread === 0;
    });
  }

  function updateChatCount() {
    var input = el('chat-input');
    var count = el('chat-count');
    if (!input || !count) return;
    var length = Array.from(input.value).length;
    count.textContent = length + '/2000';
    count.classList.toggle('is-over', length > 2000);
    var send = el('chat-send');
    if (send) send.disabled = length === 0 || length > 2000;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
  }

  async function sendChat() {
    var input = el('chat-input');
    if (!input) return;
    var text = input.value;
    if (!text.trim() || Array.from(text).length > 2000) return;

    var send = el('chat-send');
    if (send) send.disabled = true;
    var response = await emitWithAck('chat:send', { text: text }, 7000);
    if (send) send.disabled = false;

    if (!response || response.ok === false) {
      RTC.toast({
        type: 'error',
        title: 'Message not sent',
        message: (response && response.message) || 'Try again in a moment.',
      });
      return;
    }
    input.value = '';
    updateChatCount();
    input.focus();
  }

  function handleChatMessage(message) {
    if (!message || !message.id || state.messageIds.has(message.id)) return;
    state.messageIds.add(message.id);
    state.messages.push(message);
    state.messages.sort(function (a, b) {
      return Number(a.timestamp) - Number(b.timestamp);
    });
    if (state.panel !== 'chat') {
      state.unread += 1;
    }
    renderMessages();
  }

  /* Participants and waiting room ----------------------------------------- */
  function renderPeople() {
    var list = el('people-list');
    if (!list) return;
    list.replaceChildren();

    var participants = Array.from(state.participants.values());
    participants.sort(function (a, b) {
      if (a.id === state.selfId) return -1;
      if (b.id === state.selfId) return 1;
      return Number(a.joinedAt || 0) - Number(b.joinedAt || 0);
    });

    participants.forEach(function (participant) {
      var isSelf = participant.id === state.selfId;
      var participantState = participant.state || {};
      var row = document.createElement('div');
      row.className = 'person';

      var avatar = document.createElement('span');
      avatar.className = 'avatar avatar--sm';
      RTC.applyAvatar(avatar, participant.name);
      row.appendChild(avatar);

      var main = document.createElement('div');
      main.className = 'person__main';
      var name = document.createElement('span');
      name.className = 'person__name';
      name.textContent = participant.name;
      main.appendChild(name);
      if (isSelf) {
        var you = document.createElement('span');
        you.className = 'chat-message__you';
        you.textContent = '(You)';
        main.appendChild(you);
      }
      if (participant.isHost) {
        var host = document.createElement('span');
        host.className = 'badge badge--accent';
        host.textContent = 'Host';
        main.appendChild(host);
      }
      if (participant.connected === false && !isSelf) {
        var offline = document.createElement('span');
        offline.className = 'person__offline';
        offline.textContent = 'Reconnecting';
        main.appendChild(offline);
      }
      row.appendChild(main);

      var icons = document.createElement('div');
      icons.className = 'person__state';
      var mic = RTC.icon(participantState.mic ? 'mic' : 'mic-off');
      if (!participantState.mic) mic.classList.add('is-off');
      icons.appendChild(mic);
      var camera = RTC.icon(
        participantState.camera || participantState.sharing ? 'video' : 'video-off',
      );
      if (!participantState.camera && !participantState.sharing) camera.classList.add('is-off');
      icons.appendChild(camera);
      if (participantState.hand) {
        var hand = RTC.icon('hand');
        hand.classList.add('is-hand');
        icons.appendChild(hand);
      }
      row.appendChild(icons);

      if (state.isHost && !isSelf && !participant.isHost) {
        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'person__remove';
        remove.setAttribute('aria-label', 'Remove ' + participant.name + ' from the meeting');
        remove.appendChild(RTC.icon('user-minus'));
        remove.addEventListener('click', function () {
          removeParticipantByHost(participant.id);
        });
        row.appendChild(remove);
      }

      list.appendChild(row);
    });

    setText(el('people-total'), String(participants.length));
    RTC.refreshIcons();
  }

  async function removeParticipantByHost(participantId) {
    var participant = state.participants.get(participantId);
    if (!participant) return;
    var confirmed = await RTC.confirm({
      title: 'Remove ' + participant.name + '?',
      description:
        'They will be disconnected immediately and cannot rejoin for a short time.',
      confirmLabel: 'Remove',
      icon: 'user-minus',
    });
    if (!confirmed) return;

    var response = await emitWithAck('room:remove', { participantId: participantId });
    if (response && response.ok) {
      RTC.toast({
        type: 'success',
        title: 'Participant removed',
        message: participant.name + ' was removed from the meeting.',
        duration: 2600,
      });
    } else {
      RTC.toast({
        type: 'error',
        title: 'Could not remove participant',
        message: (response && response.message) || 'Please try again.',
      });
    }
  }

  function renderWaiting(requests) {
    var previousIds = new Set(
      state.waitingRequests.map(function (request) {
        return request.id;
      }),
    );
    state.waitingRequests = state.isHost && Array.isArray(requests) ? requests.slice() : [];

    var newCount = state.waitingRequests.filter(function (request) {
      return !previousIds.has(request.id);
    }).length;
    if (state.isHost && state.joined && newCount > 0) {
      RTC.toast({
        type: 'info',
        title: 'Someone is waiting',
        message:
          newCount === 1
            ? state.waitingRequests[state.waitingRequests.length - 1].name +
              ' is waiting to join.'
            : newCount + ' people are waiting to join.',
        duration: 3600,
      });
    }
    updateWaitingUi();
  }

  function waitingDuration(requestedAt) {
    var seconds = Math.max(0, Math.floor((Date.now() - Number(requestedAt || Date.now())) / 1000));
    if (seconds < 60) return 'Waiting just now';
    return 'Waiting ' + Math.floor(seconds / 60) + ' min';
  }

  function updateWaitingUi() {
    var requests = state.isHost ? state.waitingRequests : [];
    var count = requests.length;

    var section = el('waiting-section');
    setHidden(section, count === 0);
    var list = el('waiting-list');
    if (list) {
      list.replaceChildren();
      requests.forEach(function (request) {
        var row = document.createElement('div');
        row.className = 'waiting-request';

        var avatar = document.createElement('span');
        avatar.className = 'avatar avatar--sm';
        RTC.applyAvatar(avatar, request.name);
        row.appendChild(avatar);

        var main = document.createElement('div');
        main.className = 'waiting-request__main';
        var name = document.createElement('strong');
        name.className = 'waiting-request__name';
        name.textContent = request.name;
        var time = document.createElement('span');
        time.className = 'waiting-request__time';
        time.textContent = waitingDuration(request.requestedAt);
        main.append(name, time);
        row.appendChild(main);

        var actions = document.createElement('div');
        actions.className = 'waiting-request__actions';
        var admit = document.createElement('button');
        admit.type = 'button';
        admit.className = 'btn btn-primary btn-sm';
        admit.setAttribute('aria-label', 'Admit ' + request.name);
        admit.setAttribute('data-tooltip', 'Admit');
        admit.appendChild(RTC.icon('check'));
        admit.addEventListener('click', function () {
          decideWaiting(request.id, 'admit', row);
        });
        actions.appendChild(admit);

        var reject = document.createElement('button');
        reject.type = 'button';
        reject.className = 'btn btn-ghost btn-sm';
        reject.setAttribute('aria-label', 'Decline ' + request.name);
        reject.setAttribute('data-tooltip', 'Decline');
        reject.appendChild(RTC.icon('x'));
        reject.addEventListener('click', function () {
          decideWaiting(request.id, 'reject', row);
        });
        actions.appendChild(reject);

        row.appendChild(actions);
        list.appendChild(row);
      });
    }

    setText(el('waiting-count'), String(count));
    setText(el('people-total'), String(state.participants.size));
    var peopleBadges = [el('people-badge'), el('people-control-badge')];
    peopleBadges.forEach(function (badge) {
      if (!badge) return;
      badge.textContent = String(count);
      badge.hidden = count === 0;
    });

    var banner = el('waiting-banner');
    setHidden(banner, count === 0);
    setText(
      el('waiting-banner-text'),
      count === 1
        ? requests[0].name + ' is waiting to join'
        : count + ' people are waiting to join',
    );
    RTC.refreshIcons();
  }

  async function decideWaiting(requestId, action, row) {
    var buttons = row ? row.querySelectorAll('button') : [];
    Array.prototype.forEach.call(buttons, function (button) {
      button.disabled = true;
    });
    var response = await emitWithAck('room:waiting-decision', {
      requestId: requestId,
      action: action,
    });
    Array.prototype.forEach.call(buttons, function (button) {
      button.disabled = false;
    });

    if (!response || response.ok === false) {
      RTC.toast({
        type: 'error',
        title: action === 'admit' ? 'Could not admit' : 'Could not decline',
        message: (response && response.message) || 'Please try again.',
      });
      return;
    }

    state.waitingRequests = state.waitingRequests.filter(function (request) {
      return request.id !== requestId;
    });
    updateWaitingUi();
    RTC.toast({
      type: action === 'admit' ? 'success' : 'info',
      title: action === 'admit' ? 'Admitted' : 'Request declined',
      message: action === 'admit' ? 'They can now join the meeting.' : 'The request was declined.',
      duration: 2400,
    });
  }

  /* Panels ----------------------------------------------------------------- */
  function updatePanelButtons() {
    [['toggle-chat', 'chat'], ['toggle-people', 'people']].forEach(function (pair) {
      var button = el(pair[0]);
      if (!button) return;
      var active = state.panel === pair[1];
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    $$('.tab').forEach(function (tab) {
      var active = tab.getAttribute('data-panel') === state.panel;
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
    });
    var panels = {
      chat: el('panel-chat'),
      people: el('panel-people'),
    };
    Object.keys(panels).forEach(function (key) {
      setHidden(panels[key], state.panel !== key);
    });
  }

  function openPanel(kind) {
    if (kind !== 'chat' && kind !== 'people') return;
    state.panel = kind;
    setHidden(el('side-panel'), false);
    if (kind === 'chat') {
      state.unread = 0;
      window.setTimeout(function () {
        var container = el('chat-messages');
        if (container) container.scrollTop = container.scrollHeight;
      }, 20);
    }
    updatePanelButtons();
    updateChatBadge();
    RTC.refreshIcons();
    if (kind === 'chat') {
      var input = el('chat-input');
      if (input) input.focus();
    }
  }

  function closePanel() {
    state.panel = '';
    setHidden(el('side-panel'), true);
    updatePanelButtons();
    updateChatBadge();
  }

  function togglePanel(kind) {
    if (state.panel === kind) closePanel();
    else openPanel(kind);
  }

  /* Controls --------------------------------------------------------------- */
  function setControl(button, options) {
    if (!button) return;
    var config = options || {};
    if (config.off !== undefined) button.classList.toggle('is-off', Boolean(config.off));
    if (config.active !== undefined) button.classList.toggle('is-active', Boolean(config.active));
    if (config.hand !== undefined) button.classList.toggle('is-hand', Boolean(config.hand));
    if (config.pressed !== undefined) {
      button.setAttribute('aria-pressed', config.pressed ? 'true' : 'false');
    }
    if (config.label) button.setAttribute('aria-label', config.label);
    if (config.tooltip) button.setAttribute('data-tooltip', config.tooltip);
    if (config.icon) RTC.setIcon(button, config.icon);
    if (config.text) setText(button.querySelector('.control-btn__label'), config.text);
  }

  function updateControlButtons() {
    var micOn = Boolean(media.micEnabled);
    var cameraOn = Boolean(media.cameraEnabled);
    var sharing = Boolean(media.sharing);
    var hand = Boolean(state.selfState.hand);

    setControl(el('toggle-mic'), {
      off: !micOn,
      pressed: micOn,
      label: micOn ? 'Mute microphone' : 'Unmute microphone',
      tooltip: micOn ? 'Mute (M)' : 'Unmute (M)',
      icon: micOn ? 'mic' : 'mic-off',
      text: micOn ? 'Mute' : 'Unmute',
    });
    setControl(el('toggle-camera'), {
      off: !cameraOn,
      pressed: cameraOn,
      label: cameraOn ? 'Turn camera off' : 'Turn camera on',
      tooltip: cameraOn ? 'Camera off (V)' : 'Camera on (V)',
      icon: cameraOn ? 'video' : 'video-off',
      text: 'Camera',
    });
    setControl(el('toggle-share'), {
      active: sharing,
      pressed: sharing,
      label: sharing ? 'Stop sharing your screen' : 'Share your screen',
      tooltip: sharing ? 'Stop presenting (P)' : 'Present (P)',
      icon: sharing ? 'screen-share-off' : 'screen-share',
      text: sharing ? 'Presenting' : 'Present',
    });
    setControl(el('toggle-hand'), {
      hand: hand,
      pressed: hand,
      label: hand ? 'Lower your hand' : 'Raise your hand',
      tooltip: hand ? 'Lower hand (H)' : 'Raise hand (H)',
      icon: 'hand',
      text: hand ? 'Lower hand' : 'Raise hand',
    });
    setHidden(el('share-banner'), !sharing);
  }

  async function toggleMic() {
    try {
      await media.setMic(!media.micEnabled);
      state.desiredMic = media.micEnabled;
      updateLobbyButtons();
      updateControlButtons();
    } catch (error) {
      var copy = RTC.describeMediaError(error);
      RTC.toast({
        type: 'error',
        title: copy.title || 'Microphone unavailable',
        message: copy.userMessage || copy.message,
      });
    }
  }

  async function toggleCamera() {
    try {
      await media.setCamera(!media.cameraEnabled);
      state.desiredCamera = media.cameraEnabled;
      updateLobbyButtons();
      updateControlButtons();
    } catch (error) {
      var copy = RTC.describeMediaError(error);
      RTC.toast({
        type: 'error',
        title: copy.title || 'Camera unavailable',
        message: copy.userMessage || copy.message,
      });
    }
  }

  async function toggleScreenShare() {
    if (media.sharing) {
      media.stopScreenShare();
      return;
    }
    try {
      await media.startScreenShare();
    } catch (error) {
      var copy = RTC.describeMediaError(error);
      RTC.toast({
        type: copy.code === 'screen_denied' ? 'info' : 'error',
        title: copy.title || 'Could not share your screen',
        message: copy.message,
      });
    }
  }

  function toggleHand() {
    if (!state.joined) return;
    state.selfState.hand = !state.selfState.hand;
    publishState();
  }

  function playRemoteVideo(video) {
    if (!video || video.muted) return;
    try {
      var playing = video.play();
      if (playing && typeof playing.catch === 'function') {
        playing.catch(function () {
          setHidden(el('audio-unlock'), false);
        });
      }
    } catch (error) {
      setHidden(el('audio-unlock'), false);
    }
  }

  function applySpeakerToVideo(video) {
    if (!video || video.muted) return;
    if (!RTC.mediaSupport.speakerSelection()) return;
    if (typeof video.setSinkId !== 'function') return;
    var deviceId = media.preferredOutputId || '';
    if (video.__rtcSinkId === deviceId) return;
    video
      .setSinkId(deviceId)
      .then(function () {
        video.__rtcSinkId = deviceId;
      })
      .catch(noop);
  }

  function applySpeakerToAll() {
    $$('#video-grid video').forEach(applySpeakerToVideo);
  }

  function enableRemoteAudio() {
    $$('#video-grid video').forEach(function (video) {
      if (video.muted) return;
      var playing = video.play();
      if (playing && typeof playing.catch === 'function') playing.catch(noop);
    });
    setHidden(el('audio-unlock'), true);
  }

  /* Exit and cleanup ------------------------------------------------------- */
  function stopEverything() {
    stopTimer();
    state.peers.forEach(function (peer, id) {
      closePeer(id);
    });
    state.peers.clear();
    state.tiles.forEach(disposeTile);
    state.tiles.clear();
    media.stopAll();
    setHidden(el('share-banner'), true);
    setHidden(el('audio-unlock'), true);
  }

  function shutdownSocket() {
    if (!socket) return;
    try {
      socket.removeAllListeners();
      socket.disconnect();
    } catch (error) {
      // Ignore disconnect failures.
    }
    socket = null;
    state.socket = null;
  }

  function showExit(options) {
    if (state.ended) return;
    var config = options || {};
    state.ended = true;
    state.joined = false;
    state.waiting = false;
    state.joining = false;
    state.leaving = false;
    state.pendingJoin = null;
    state.participantToken = '';
    state.waitingRequests = [];
    clearSession();
    stopEverything();
    state.participants.clear();
    renderParticipants();
    updateWaitingUi();
    updatePanelButtons();
    showView('exit-view');

    var iconNode = el('exit-icon');
    if (iconNode) {
      iconNode.replaceChildren(RTC.icon(config.icon || 'door-closed'));
    }
    setText(el('exit-title'), config.title || 'Meeting unavailable');
    setText(el('exit-message'), config.message || 'This meeting is no longer available.');

    var primary = el('exit-primary');
    if (primary) {
      primary.onclick = function () {
        if (typeof config.onPrimary === 'function') config.onPrimary();
        else window.location.assign('/');
      };
      setText(primary, config.primaryLabel || 'Back to home');
      primary.className = 'btn btn-primary';
    }

    var secondary = el('exit-view').querySelector('.state-card__actions a');
    if (secondary) {
      secondary.href = '/';
      secondary.textContent = config.secondaryLabel || 'Back home';
    }

    RTC.refreshIcons();
    shutdownSocket();
  }

  function handleSessionLost(message) {
    showExit({
      icon: 'wifi-off',
      title: 'Connection lost',
      message: message || 'Your meeting session is no longer available. Please rejoin.',
      primaryLabel: 'Rejoin',
      onPrimary: function () {
        window.location.reload();
      },
    });
  }

  async function leaveMeeting() {
    if (state.leaving || state.ended) return;
    state.leaving = true;
    if (state.joined) {
      await emitWithAck('room:leave', {}, 4000);
    } else if (state.waiting) {
      await emitWithAck('room:cancel-waiting', {}, 4000);
    }
    showExit({
      icon: 'door-open',
      title: 'You left the meeting',
      message: 'You can rejoin from this browser while the meeting is still active.',
      primaryLabel: 'Rejoin',
      onPrimary: function () {
        window.location.reload();
      },
    });
  }

  async function endMeetingForAll() {
    var confirmed = await RTC.confirm({
      title: 'End the meeting for everyone?',
      description:
        'All participants will be disconnected and the invite link will stop working. This cannot be undone.',
      confirmLabel: 'End meeting',
      icon: 'phone-off',
    });
    if (!confirmed) return;

    var response = await emitWithAck('room:end', {}, 5000);
    if (state.ended) return;
    if (response && response.ok) {
      showExit({
        icon: 'phone-off',
        title: 'Meeting ended',
        message: 'You ended the meeting for everyone in this room.',
        primaryLabel: 'Back to home',
        onPrimary: function () {
          window.location.assign('/');
        },
      });
    } else {
      RTC.toast({
        type: 'error',
        title: 'Could not end the meeting',
        message: (response && response.message) || 'Please try again.',
      });
    }
  }

  /* Copy and device helpers ------------------------------------------------ */
  function copyCode(label) {
    RTC.copyWithToast(CODE, label || 'Meeting code copied.');
  }

  function copyInvite(label) {
    RTC.copyWithToast(roomUrl(), label || 'Invite link copied.');
  }

  async function changeDevice(select) {
    var kind = select.getAttribute('data-device-select');
    if (!kind) return;
    try {
      await media.switchDevice(kind, select.value);
      if (kind === 'audiooutput') applySpeakerToAll();
    } catch (error) {
      var copy = RTC.describeMediaError(error);
      RTC.toast({
        type: 'error',
        title: copy.title || 'Could not switch device',
        message: copy.userMessage || copy.message,
      });
    }
    populateDeviceSelects();
  }

  async function refreshDevices() {
    try {
      await media.refreshDevices();
      populateDeviceSelects();
      RTC.toast({
        type: 'success',
        title: 'Devices refreshed',
        message: 'The device list is up to date.',
        duration: 2200,
      });
    } catch (error) {
      RTC.toast({
        type: 'error',
        title: 'Could not list devices',
        message: 'Check your browser permissions and try again.',
      });
    }
  }

  /* Resume and reconnect --------------------------------------------------- */
  async function resumeSession() {
    if (state.resuming || state.ended || !state.participantToken || !socket) return;
    state.resuming = true;
    var wasJoined = state.joined;
    if (wasJoined) setConnection('reconnecting');

    var response = await emitWithAck(
      'room:resume',
      {
        code: CODE,
        clientId: CLIENT_ID,
        participantToken: state.participantToken,
      },
      ACK_TIMEOUT,
    );
    state.resuming = false;

    if (response && response.ok && (response.status === 'resumed' || response.status === 'admitted')) {
      state.resumeRetries = 0;
      enterMeeting(response, { resume: true });
      setConnection('connected');
      return;
    }

    var code = response && response.code;
    if (code === 'already_connected' && (state.resumeRetries || 0) < 2) {
      state.resumeRetries = (state.resumeRetries || 0) + 1;
      window.setTimeout(resumeSession, 1400);
      return;
    }
    state.resumeRetries = 0;

    if (wasJoined) {
      if (code === 'session_expired' || code === 'room_not_found' || code === 'room_ended') {
        showExit({
          icon: code === 'room_ended' ? 'door-closed' : 'wifi-off',
          title:
            code === 'room_ended'
              ? 'Meeting ended'
              : code === 'room_not_found'
                ? 'Meeting expired'
                : 'Session expired',
          message:
            (response && response.message) ||
            'Your session is no longer valid. Ask the host for a new invite.',
          primaryLabel: 'Back to home',
          onPrimary: function () {
            window.location.assign('/');
          },
        });
        return;
      }
      if (code === 'already_connected') {
        showExit({
          icon: 'monitor-x',
          title: 'Already connected',
          message: 'This meeting is open in another tab. Close it before rejoining here.',
          primaryLabel: 'Back to home',
          onPrimary: function () {
            window.location.assign('/');
          },
        });
        return;
      }
      setConnection('reconnecting');
      return;
    }

    clearSession();
    state.participantToken = '';
    if (code === 'room_not_found' || code === 'room_ended') {
      showExit({
        icon: 'door-closed',
        title: code === 'room_ended' ? 'Meeting ended' : 'Meeting expired',
        message: (response && response.message) || 'This meeting is no longer available.',
        primaryLabel: 'Back to home',
        onPrimary: function () {
          window.location.assign('/');
        },
      });
      return;
    }
    if (code === 'session_expired') {
      RTC.toast({
        type: 'info',
        title: 'Previous session ended',
        message: 'You can join the meeting again below.',
        duration: 4200,
      });
    }
  }

  async function rejoinWaiting() {
    if (!state.pendingJoin || state.ended || !socket || !socket.connected) return;
    var response = await emitWithAck('room:join', state.pendingJoin, ACK_TIMEOUT);
    if (!response || response.ok === false) {
      if (response && (response.code === 'room_ended' || response.code === 'room_not_found')) {
        handleJoinFailure(response);
      }
      return;
    }
    if (response.status === 'waiting') {
      state.waiting = true;
      var message = el('waiting-message');
      if (message) {
        message.textContent =
          'Your request is still pending. Keep this tab open until the host admits you.';
      }
      return;
    }
    if (response.status === 'admitted' || response.status === 'resumed') {
      enterMeeting(response);
    }
  }

  /* Socket wiring ---------------------------------------------------------- */
  function onSocketConnect() {
    setConnection('connected');
    if (state.ended) return;

    if (state.joined && state.participantToken) {
      resumeSession();
      return;
    }
    if (state.waiting && state.pendingJoin) {
      rejoinWaiting();
      return;
    }
    if (!state.joined && !state.joining && !state.resumeAttempted) {
      var token = readSession();
      if (token) {
        state.participantToken = token;
        state.resumeAttempted = true;
        resumeSession();
      }
    }
  }

  function onSocketDisconnect(reason) {
    if (state.ended) return;
    setConnection('reconnecting');
    if (state.waiting) {
      var message = el('waiting-message');
      if (message) message.textContent = 'Reconnecting to the meeting…';
    }
    if (reason === 'io server disconnect') {
      setConnection('disconnected');
    }
  }

  function handlePeerJoined(payload) {
    if (!payload || !payload.participant) return;
    var participant = payload.participant;
    if (participant.id === state.selfId) return;

    var existed = state.participants.has(participant.id);
    addParticipant(participant);
    ensurePeer(participant.id);
    renderParticipants();
    flushEarlySignals(participant.id);

    if (!existed && !payload.resumed && state.joined) {
      RTC.toast({
        type: 'info',
        title: participant.name + ' joined',
        message: 'They are now in the meeting.',
        duration: 2400,
      });
    }
  }

  function handlePeerLeft(payload) {
    if (!payload || !payload.participantId) return;
    var participant = state.participants.get(payload.participantId);
    removeParticipant(payload.participantId);
    if (participant && state.joined) {
      RTC.toast({
        type: 'info',
        title: participant.name + ' left',
        message:
          payload.reason === 'removed'
            ? 'They were removed by the host.'
            : 'They are no longer in the meeting.',
        duration: 2200,
      });
    }
  }

  function handlePeerUpdated(payload) {
    if (!payload || !payload.participantId) return;
    var participant = state.participants.get(payload.participantId);
    if (!participant) return;
    participant.state = Object.assign({}, participant.state, payload.state || {});
    participant.connected = payload.connected !== false;
    if (participant.connected) {
      ensurePeer(participant.id);
      var peer = state.peers.get(participant.id);
      if (peer && peer.pc.connectionState === 'failed') restartPeer(peer);
    }
    renderParticipants();
  }

  function handleWaitingList(payload) {
    renderWaiting(payload && payload.requests ? payload.requests : []);
  }

  function handleRejected(payload) {
    var reason = payload && payload.reason;
    var ended = reason === 'meeting_ended';
    showExit({
      icon: ended ? 'door-closed' : 'user-x',
      title: ended ? 'Meeting ended' : 'Request declined',
      message:
        (payload && payload.message) ||
        'The host did not admit you to this meeting.',
      primaryLabel: ended ? 'Back to home' : 'Back to lobby',
      onPrimary: function () {
        if (ended) window.location.assign('/');
        else window.location.reload();
      },
    });
  }

  function handleRemoved(payload) {
    showExit({
      icon: 'user-x',
      title: 'Removed from the meeting',
      message:
        (payload && payload.message) || 'The host removed you from this meeting.',
      primaryLabel: 'Back to home',
      onPrimary: function () {
        window.location.assign('/');
      },
    });
  }

  function handleMeetingEnded(payload) {
    showExit({
      icon: 'phone-off',
      title: 'Meeting ended',
      message: state.isHost
        ? 'You ended the meeting for everyone in this room.'
        : (payload && payload.message) || 'The host ended this meeting.',
      primaryLabel: 'Back to home',
      onPrimary: function () {
        window.location.assign('/');
      },
    });
  }

  function initSocket() {
    if (typeof window.io !== 'function') {
      RTC.toast({
        type: 'error',
        title: 'Realtime connection unavailable',
        message: 'The Socket.IO client could not be loaded. Reload the page.',
        duration: 8000,
      });
      return;
    }

    socket = window.io({
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 700,
      reconnectionDelayMax: 5000,
      timeout: 12000,
    });
    state.socket = socket;

    socket.on('connect', onSocketConnect);
    socket.on('disconnect', onSocketDisconnect);
    socket.on('connect_error', function (error) {
      if (state.ended) return;
      setConnection('disconnected');
      var message = (error && error.message) || 'Could not reach the meeting server.';
      if (!state.joined) {
        showLobbyError(message);
      }
    });
    socket.on('server:restarting', function () {
      setConnection('reconnecting', 'Server restarting…');
    });

    socket.on('peer:joined', handlePeerJoined);
    socket.on('peer:left', handlePeerLeft);
    socket.on('peer:updated', handlePeerUpdated);
    socket.on('chat:message', handleChatMessage);
    socket.on('room:waiting-list', handleWaitingList);
    socket.on('room:admitted', function (payload) {
      if (state.ended || state.joined) return;
      state.waiting = false;
      enterMeeting(payload);
    });
    socket.on('room:rejected', handleRejected);
    socket.on('room:removed', handleRemoved);
    socket.on('room:ended', handleMeetingEnded);
    socket.on('webrtc:offer', function (payload) {
      handleSignal('webrtc:offer', payload);
    });
    socket.on('webrtc:answer', function (payload) {
      handleSignal('webrtc:answer', payload);
    });
    socket.on('webrtc:ice', function (payload) {
      handleSignal('webrtc:ice', payload);
    });
  }

  /* Event wiring ----------------------------------------------------------- */
  function isDialogOpen() {
    return Boolean(document.querySelector('dialog[open]'));
  }

  function handleShortcut(event) {
    if (!state.joined || state.ended) return;
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (isDialogOpen()) return;

    var key = String(event.key || '').toLowerCase();
    // Escape should close the side panel even while the chat composer has
    // focus. Other single-key shortcuts stay disabled while typing.
    if (key === 'escape' && state.panel) {
      event.preventDefault();
      closePanel();
      return;
    }
    if (RTC.isEditableTarget(event.target)) return;
    if (key === 'm') {
      event.preventDefault();
      toggleMic();
    } else if (key === 'v') {
      event.preventDefault();
      toggleCamera();
    } else if (key === 'p') {
      event.preventDefault();
      toggleScreenShare();
    } else if (key === 'h') {
      event.preventDefault();
      toggleHand();
    } else if (key === 'c') {
      event.preventDefault();
      openPanel('chat');
    } else if (key === 'u') {
      event.preventDefault();
      openPanel('people');
    }
  }

  function initControls() {
    var nameInput = el('lobby-name');
    if (nameInput) {
      nameInput.value = RTC.getDisplayName();
      nameInput.addEventListener('input', function () {
        nameInput.removeAttribute('aria-invalid');
        showLobbyError('');
        RTC.applyAvatar(el('preview-avatar'), nameInput.value || 'Guest');
      });
      nameInput.addEventListener('blur', function () {
        if (nameInput.value.trim()) RTC.setDisplayName(nameInput.value);
      });
      nameInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          joinMeeting();
        }
      });
    }

    on(el('join-meeting'), 'click', joinMeeting);
    on(el('lobby-mic'), 'click', toggleLobbyMic);
    on(el('lobby-camera'), 'click', toggleLobbyCamera);
    on(el('lobby-settings'), 'click', function () {
      var sidebar = el('device-settings');
      if (sidebar) {
        sidebar.scrollIntoView({ behavior: 'smooth', block: 'center' });
        var select = el('lobby-mic-select');
        if (select) window.setTimeout(function () { select.focus(); }, 250);
      }
    });

    $$('[data-device-select]').forEach(function (select) {
      select.addEventListener('change', function () {
        changeDevice(select);
      });
    });
    on(el('refresh-devices'), 'click', refreshDevices);
    on(el('refresh-devices-meeting'), 'click', refreshDevices);

    on(el('cancel-waiting'), 'click', cancelWaiting);
    on(el('waiting-banner'), 'click', function () {
      openPanel('people');
    });
    on(el('close-panel'), 'click', closePanel);
    on(el('toggle-chat'), 'click', function () {
      togglePanel('chat');
    });
    on(el('toggle-people'), 'click', function () {
      togglePanel('people');
    });
    $$('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        openPanel(tab.getAttribute('data-panel'));
      });
      tab.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        var next = tab.getAttribute('data-panel') === 'chat' ? 'people' : 'chat';
        openPanel(next);
        var target = el(next === 'chat' ? 'tab-chat' : 'tab-people');
        if (target) target.focus();
      });
    });

    on(el('toggle-mic'), 'click', toggleMic);
    on(el('toggle-camera'), 'click', toggleCamera);
    on(el('toggle-share'), 'click', toggleScreenShare);
    on(el('toggle-hand'), 'click', toggleHand);
    on(el('stop-sharing-banner'), 'click', function () {
      media.stopScreenShare();
    });
    on(el('enable-audio'), 'click', enableRemoteAudio);
    on(el('end-meeting'), 'click', endMeetingForAll);
    on(el('leave-meeting'), 'click', leaveMeeting);

    var chatForm = el('chat-form');
    if (chatForm) {
      chatForm.addEventListener('submit', function (event) {
        event.preventDefault();
        sendChat();
      });
    }
    var chatInput = el('chat-input');
    if (chatInput) {
      chatInput.addEventListener('input', updateChatCount);
      chatInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          sendChat();
        }
      });
    }

    var mirrorToggle = el('mirror-toggle');
    if (mirrorToggle) {
      mirrorToggle.checked = state.mirror;
      mirrorToggle.addEventListener('change', function () {
        state.mirror = mirrorToggle.checked;
        RTC.setMirrorPreference(state.mirror);
        updateLobbyButtons();
        renderParticipants();
      });
    }

    var codeButtons = ['copy-code', 'copy-code-waiting', 'copy-code-meeting'];
    codeButtons.forEach(function (id) {
      on(el(id), 'click', function () {
        copyCode();
      });
    });

    var inviteButtons = [
      'copy-invite-lobby',
      'copy-invite-meeting',
      'copy-invite-alone',
      'copy-link-menu',
      'copy-details-link',
    ];
    inviteButtons.forEach(function (id) {
      on(el(id), 'click', function () {
        copyInvite();
      });
    });

    var detailsLink = el('details-link');
    if (detailsLink) detailsLink.value = roomUrl();

    on(el('exit-primary'), 'click', function () {});

    document.addEventListener('keydown', handleShortcut);
    window.addEventListener('pagehide', function () {
      media.stopAll();
    });

    media.subscribe(function (event) {
      if (!event) return;
      if (event.type === 'devices') {
        populateDeviceSelects();
        return;
      }
      if (event.type === 'speaker') {
        applySpeakerToAll();
        return;
      }
      if (event.type === 'mic' || event.type === 'camera' || event.type === 'screen') {
        if (event.type === 'mic') state.desiredMic = Boolean(event.enabled);
        if (event.type === 'camera') state.desiredCamera = Boolean(event.enabled);
        state.selfState.mic = Boolean(media.micEnabled);
        state.selfState.camera = Boolean(media.cameraEnabled);
        state.selfState.sharing = Boolean(media.sharing);
        updateLobbyButtons();
        updateControlButtons();
        syncLocalTracks();
        updateSelfTileStream();
        renderParticipants();
        if (state.joined) publishState();
        return;
      }
      if (event.type === 'track' || event.type === 'video-ended' || event.type === 'audio-ended') {
        updateSelfTileStream();
        syncLocalTracks();
        updateLobbyButtons();
        updateControlButtons();
        renderParticipants();
        if (state.joined) publishState();
      }
    });
  }

  function init() {
    if (!CODE || !RTC.isValidRoomCode(CODE)) {
      showExit({
        icon: 'door-closed',
        title: 'Meeting unavailable',
        message: 'This meeting link is not valid.',
      });
      return;
    }

    var nameInput = el('lobby-name');
    if (nameInput) nameInput.value = RTC.getDisplayName();
    RTC.applyAvatar(el('preview-avatar'), RTC.getDisplayName() || 'Guest');
    RTC.applyAvatar(el('waiting-avatar'), RTC.getDisplayName() || 'Guest');
    updateHostBadge();
    updateLobbyButtons();
    updateControlButtons();
    updateChatCount();
    updateChatBadge();
    updateWaitingUi();
    initControls();
    initSocket();
    startLobbyMedia();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
