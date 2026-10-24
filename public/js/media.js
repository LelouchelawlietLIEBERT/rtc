(function () {
  'use strict';

  var RTC = window.RTC || {};

  var ERROR_COPY = {
    permission_denied: {
      title: 'Permission denied',
      message:
        'Allow access in your browser site settings, then try again. Look for the camera and microphone icons in the address bar.',
    },
    device_not_found: {
      title: 'No device found',
      message: 'Connect a device or choose a different one, then try again.',
    },
    device_busy: {
      title: 'Device is unavailable',
      message:
        'Another application may be using your camera or microphone. Close it and try again.',
    },
    device_unavailable: {
      title: 'Device unavailable',
      message: 'That device could not be started. Choose another device.',
    },
    insecure_context: {
      title: 'HTTPS is required',
      message: 'Camera and microphone access requires a secure (HTTPS) page.',
    },
    unsupported: {
      title: 'Not supported',
      message: 'This browser does not support the required media APIs.',
    },
    aborted: {
      title: 'Request cancelled',
      message: 'The device request was interrupted.',
    },
    screen_denied: {
      title: 'Screen sharing cancelled',
      message: 'No screen or window was selected.',
    },
    unknown: {
      title: 'Media error',
      message: 'Your device could not be started.',
    },
  };

  function MediaError(code, kind, original) {
    this.name = 'MediaError';
    this.code = ERROR_COPY[code] ? code : 'unknown';
    this.kind = kind || '';
    this.original = original || null;
    var label = kind === 'video' ? 'camera' : kind === 'audio' ? 'microphone' : 'device';
    var copy = ERROR_COPY[this.code];
    this.title = copy.title;
    this.message = copy.message;
    this.userMessage = kind ? label.charAt(0).toUpperCase() + label.slice(1) + ': ' + copy.message : copy.message;
    if (Error.captureStackTrace) Error.captureStackTrace(this, MediaError);
  }
  MediaError.prototype = Object.create(Error.prototype);
  MediaError.prototype.constructor = MediaError;

  function mapError(error, kind) {
    if (error instanceof MediaError) return error;
    var name = error && error.name ? error.name : '';
    var code = 'unknown';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      code = name === 'SecurityError' ? 'insecure_context' : 'permission_denied';
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      code = 'device_not_found';
    } else if (name === 'NotReadableError' || name === 'TrackStartError') {
      code = 'device_busy';
    } else if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
      code = 'device_unavailable';
    } else if (name === 'AbortError') {
      code = 'aborted';
    } else if (name === 'TypeError') {
      code = 'unsupported';
    }
    return new MediaError(code, kind, error);
  }

  function supportsMedia() {
    return Boolean(
      window.isSecureContext &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function',
    );
  }

  function supportsScreenShare() {
    return Boolean(
      window.isSecureContext &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getDisplayMedia === 'function',
    );
  }

  function supportsSpeakerSelection() {
    return Boolean(
      typeof HTMLMediaElement !== 'undefined' &&
        'setSinkId' in HTMLMediaElement.prototype,
    );
  }

  function MediaController() {
    this.stream = new MediaStream();
    this.audioTrack = null;
    this.videoTrack = null;
    this.screenTrack = null;
    this.screenStream = null;
    this.preferredAudioId = '';
    this.preferredVideoId = '';
    this.preferredOutputId = '';
    this.devices = { audioinput: [], videoinput: [], audiooutput: [] };
    this.permissions = { microphone: 'unknown', camera: 'unknown' };
    this.errors = { audio: null, video: null };
    this.listeners = [];
    this.destroyed = false;

    var self = this;
    this.onDeviceChange = function () {
      self.refreshDevices().catch(function () {});
    };
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange);
    }
  }

  MediaController.prototype.subscribe = function (listener) {
    var self = this;
    this.listeners.push(listener);
    return function () {
      self.listeners = self.listeners.filter(function (item) {
        return item !== listener;
      });
    };
  };

  MediaController.prototype.emit = function (type, detail) {
    var event = Object.assign({ type: type }, detail || {});
    this.listeners.slice().forEach(function (listener) {
      try {
        listener(event);
      } catch (error) {
        // A UI listener must not break media handling.
      }
    });
  };

  Object.defineProperties(MediaController.prototype, {
    micEnabled: {
      get: function () {
        return Boolean(
          this.audioTrack &&
            this.audioTrack.readyState === 'live' &&
            this.audioTrack.enabled,
        );
      },
    },
    cameraEnabled: {
      get: function () {
        return Boolean(this.videoTrack && this.videoTrack.readyState === 'live');
      },
    },
    sharing: {
      get: function () {
        return Boolean(this.screenTrack && this.screenTrack.readyState === 'live');
      },
    },
  });

  MediaController.prototype.getVideoTrack = function () {
    return this.screenTrack && this.screenTrack.readyState === 'live'
      ? this.screenTrack
      : this.videoTrack && this.videoTrack.readyState === 'live'
        ? this.videoTrack
        : null;
  };

  MediaController.prototype.getCameraTrack = function () {
    return this.videoTrack && this.videoTrack.readyState === 'live' ? this.videoTrack : null;
  };

  MediaController.prototype.getAudioTrack = function () {
    return this.audioTrack && this.audioTrack.readyState === 'live' ? this.audioTrack : null;
  };

  MediaController.prototype.getLocalStream = function () {
    var stream = new MediaStream();
    var audio = this.getAudioTrack();
    var video = this.getVideoTrack();
    if (audio) stream.addTrack(audio);
    if (video) stream.addTrack(video);
    return stream;
  };

  MediaController.prototype.audioConstraints = function (deviceId) {
    var audio = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };
    return audio;
  };

  MediaController.prototype.videoConstraints = function (deviceId) {
    var video = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 24, max: 30 },
      facingMode: 'user',
    };
    if (deviceId) video.deviceId = { exact: deviceId };
    return video;
  };

  MediaController.prototype.commitAudio = function (track, enabled) {
    var old = this.audioTrack;
    if (old && old !== track) {
      try {
        this.stream.removeTrack(old);
      } catch (error) {
        // The track may already have been removed.
      }
      old.stop();
    }
    this.audioTrack = track;
    track.enabled = enabled !== false;
    if (!this.stream.getAudioTracks().includes(track)) this.stream.addTrack(track);
    this.permissions.microphone = 'granted';
    this.errors.audio = null;
    var self = this;
    track.addEventListener('ended', function () {
      if (self.audioTrack !== track) return;
      try {
        self.stream.removeTrack(track);
      } catch (error) {
        // Ignore.
      }
      self.audioTrack = null;
      self.emit('audio-ended', { track: track });
      self.emit('mic', { enabled: false, track: null });
    });
    this.emit('track', { kind: 'audio', track: track });
    return track;
  };

  MediaController.prototype.commitVideo = function (track) {
    var old = this.videoTrack;
    if (old && old !== track) {
      try {
        this.stream.removeTrack(old);
      } catch (error) {
        // The track may already have been removed.
      }
      old.stop();
    }
    this.videoTrack = track;
    if (!this.stream.getVideoTracks().includes(track)) this.stream.addTrack(track);
    this.permissions.camera = 'granted';
    this.errors.video = null;
    var self = this;
    track.addEventListener('ended', function () {
      if (self.videoTrack !== track) return;
      try {
        self.stream.removeTrack(track);
      } catch (error) {
        // Ignore.
      }
      self.videoTrack = null;
      self.emit('video-ended', { track: track });
      self.emit('camera', { enabled: false, track: null });
    });
    this.emit('track', { kind: 'video', track: track });
    return track;
  };

  MediaController.prototype.acquireAudio = async function (deviceId, options) {
    if (!supportsMedia()) throw new MediaError('unsupported', 'audio');
    var settings = options || {};
    var enabled =
      settings.enabled !== undefined
        ? settings.enabled
        : this.audioTrack
          ? this.audioTrack.enabled
          : true;
    var selected = deviceId === undefined ? this.preferredAudioId : deviceId;
    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        audio: this.audioConstraints(selected),
        video: false,
      });
      var track = stream.getAudioTracks()[0];
      if (!track) {
        stream.getTracks().forEach(function (item) {
          item.stop();
        });
        throw new MediaError('device_not_found', 'audio');
      }
      this.preferredAudioId = track.getSettings().deviceId || selected || '';
      this.commitAudio(track, enabled);
      return track;
    } catch (error) {
      var mapped = mapError(error, 'audio');
      this.errors.audio = mapped;
      if (mapped.code === 'permission_denied') this.permissions.microphone = 'denied';
      throw mapped;
    }
  };

  MediaController.prototype.acquireVideo = async function (deviceId) {
    if (!supportsMedia()) throw new MediaError('unsupported', 'video');
    var selected = deviceId === undefined ? this.preferredVideoId : deviceId;
    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: this.videoConstraints(selected),
      });
      var track = stream.getVideoTracks()[0];
      if (!track) {
        stream.getTracks().forEach(function (item) {
          item.stop();
        });
        throw new MediaError('device_not_found', 'video');
      }
      this.preferredVideoId = track.getSettings().deviceId || selected || '';
      this.commitVideo(track);
      return track;
    } catch (error) {
      var mapped = mapError(error, 'video');
      this.errors.video = mapped;
      if (mapped.code === 'permission_denied') this.permissions.camera = 'denied';
      throw mapped;
    }
  };

  MediaController.prototype.initialize = async function (options) {
    var config = Object.assign({ audio: true, video: true }, options || {});
    var results = { audioError: null, videoError: null };

    if (!supportsMedia()) {
      var unsupported = new MediaError(
        window.isSecureContext ? 'unsupported' : 'insecure_context',
        'video',
      );
      results.audioError = unsupported;
      results.videoError = unsupported;
      this.errors.audio = unsupported;
      this.errors.video = unsupported;
      this.emit('initialized', results);
      return results;
    }

    if (config.audio && config.video) {
      try {
        var stream = await navigator.mediaDevices.getUserMedia({
          audio: this.audioConstraints(this.preferredAudioId),
          video: this.videoConstraints(this.preferredVideoId),
        });
        var audio = stream.getAudioTracks()[0];
        var video = stream.getVideoTracks()[0];
        if (audio) this.commitAudio(audio, true);
        if (video) this.commitVideo(video);
        stream.getTracks().forEach(function (track) {
          if (track.readyState === 'live' && !track.enabled) track.stop();
        });
      } catch (error) {
        if (config.audio) {
          try {
            await this.acquireAudio();
          } catch (audioError) {
            results.audioError = audioError;
          }
        }
        if (config.video) {
          try {
            await this.acquireVideo();
          } catch (videoError) {
            results.videoError = videoError;
          }
        }
      }
    } else {
      if (config.audio) {
        try {
          await this.acquireAudio();
        } catch (error) {
          results.audioError = error;
        }
      }
      if (config.video) {
        try {
          await this.acquireVideo();
        } catch (error) {
          results.videoError = error;
        }
      }
    }

    await this.refreshDevices().catch(function () {});
    await this.refreshPermissionStates();
    this.emit('initialized', results);
    return results;
  };

  MediaController.prototype.refreshPermissionStates = async function () {
    if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
      return this.permissions;
    }
    var self = this;
    var kinds = [
      ['microphone', 'microphone'],
      ['camera', 'camera'],
    ];
    await Promise.all(
      kinds.map(async function (entry) {
        try {
          var status = await navigator.permissions.query({ name: entry[0] });
          self.permissions[entry[1]] = status.state;
        } catch (error) {
          // Some browsers do not expose camera/microphone permission names.
        }
      }),
    );
    return this.permissions;
  };

  MediaController.prototype.refreshDevices = async function () {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
      this.devices = { audioinput: [], videoinput: [], audiooutput: [] };
      this.emit('devices', this.devices);
      return this.devices;
    }
    var list = await navigator.mediaDevices.enumerateDevices();
    var grouped = { audioinput: [], videoinput: [], audiooutput: [] };
    list.forEach(function (device) {
      if (!grouped[device.kind]) return;
      grouped[device.kind].push({
        deviceId: device.deviceId,
        label: device.label || '',
        groupId: device.groupId || '',
      });
    });
    this.devices = grouped;
    this.emit('devices', grouped);
    return grouped;
  };

  MediaController.prototype.setMic = async function (enabled) {
    if (enabled) {
      if (this.audioTrack && this.audioTrack.readyState === 'live') {
        this.audioTrack.enabled = true;
      } else {
        await this.acquireAudio(this.preferredAudioId, { enabled: true });
      }
      this.emit('mic', { enabled: true, track: this.audioTrack });
      return true;
    }
    if (this.audioTrack) this.audioTrack.enabled = false;
    this.emit('mic', { enabled: false, track: this.audioTrack });
    return false;
  };

  MediaController.prototype.setCamera = async function (enabled) {
    if (enabled) {
      if (!this.videoTrack || this.videoTrack.readyState !== 'live') {
        await this.acquireVideo(this.preferredVideoId);
      }
      this.emit('camera', { enabled: true, track: this.videoTrack });
      return true;
    }
    if (this.videoTrack) {
      var track = this.videoTrack;
      this.videoTrack = null;
      try {
        this.stream.removeTrack(track);
      } catch (error) {
        // Ignore.
      }
      track.stop();
    }
    this.emit('camera', { enabled: false, track: null });
    return false;
  };

  MediaController.prototype.switchDevice = async function (kind, deviceId) {
    var selected = deviceId || '';
    if (kind === 'audioinput') {
      this.preferredAudioId = selected;
      if (this.audioTrack) {
        await this.acquireAudio(selected, {
          enabled: this.audioTrack ? this.audioTrack.enabled : true,
        });
      }
      return;
    }
    if (kind === 'videoinput') {
      this.preferredVideoId = selected;
      if (this.videoTrack) {
        await this.acquireVideo(selected);
      }
      return;
    }
    if (kind === 'audiooutput') {
      this.preferredOutputId = selected;
      this.emit('speaker', { deviceId: selected });
    }
  };

  MediaController.prototype.startScreenShare = async function () {
    if (!supportsScreenShare()) throw new MediaError('unsupported', 'screen');
    if (this.screenTrack) return this.screenTrack;
    try {
      var stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 15, max: 30 },
        },
        audio: false,
      });
      var track = stream.getVideoTracks()[0];
      if (!track) {
        stream.getTracks().forEach(function (item) {
          item.stop();
        });
        throw new MediaError('screen_denied', 'screen');
      }
      this.screenStream = stream;
      this.screenTrack = track;
      var self = this;
      track.addEventListener('ended', function () {
        if (self.screenTrack === track) self.stopScreenShare({ fromEnded: true });
      });
      this.emit('screen', { active: true, track: track });
      return track;
    } catch (error) {
      var mapped =
        error instanceof MediaError
          ? error
          : new MediaError(
              error && error.name === 'NotAllowedError' ? 'screen_denied' : 'unknown',
              'screen',
              error,
            );
      throw mapped;
    }
  };

  MediaController.prototype.stopScreenShare = function (options) {
    var wasSharing = Boolean(this.screenTrack);
    var track = this.screenTrack;
    var stream = this.screenStream;
    this.screenTrack = null;
    this.screenStream = null;
    if (track && (!options || !options.fromEnded)) {
      try {
        track.stop();
      } catch (error) {
        // Ignore.
      }
    }
    if (stream) {
      stream.getTracks().forEach(function (item) {
        if (item !== track) {
          try {
            item.stop();
          } catch (error) {
            // Ignore.
          }
        }
      });
    }
    if (wasSharing) this.emit('screen', { active: false, track: null });
  };

  MediaController.prototype.stopAll = function () {
    var tracks = [this.audioTrack, this.videoTrack, this.screenTrack].filter(Boolean);
    tracks.forEach(function (track) {
      try {
        track.stop();
      } catch (error) {
        // Ignore.
      }
    });
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(function (track) {
        try {
          track.stop();
        } catch (error) {
          // Ignore.
        }
      });
    }
    this.stream.getTracks().forEach(function (track) {
      try {
        track.stop();
      } catch (error) {
        // Ignore.
      }
    });
    this.audioTrack = null;
    this.videoTrack = null;
    this.screenTrack = null;
    this.screenStream = null;
    this.stream = new MediaStream();
    this.emit('stopped', {});
  };

  MediaController.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopAll();
    if (navigator.mediaDevices && navigator.mediaDevices.removeEventListener) {
      navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange);
    }
    this.listeners = [];
  };

  RTC.MediaController = MediaController;
  RTC.MediaError = MediaError;
  RTC.describeMediaError = function (error) {
    return error instanceof MediaError ? error : mapError(error, '');
  };
  RTC.mediaSupport = {
    getUserMedia: supportsMedia,
    screenShare: supportsScreenShare,
    speakerSelection: supportsSpeakerSelection,
  };

  window.RTC = RTC;
})();
