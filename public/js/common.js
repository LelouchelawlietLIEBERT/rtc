(function () {
  'use strict';

  var RTC = (window.RTC = window.RTC || {});
  var STORAGE = {
    name: 'rtc.displayName',
    recent: 'rtc.recentMeetings.v1',
    hostTokens: 'rtc.hostTokens.v1',
    clientId: 'rtc.clientId.v1',
    mirror: 'rtc.mirrorCamera',
  };

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function readJSON(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (error) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      return false;
    }
  }

  function readString(key, fallback) {
    try {
      var value = window.localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  function writeString(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  function removeKey(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      // Ignore storage failures.
    }
  }

  function refreshIcons() {
    if (!window.lucide || typeof window.lucide.createIcons !== 'function') return;
    window.lucide.createIcons({
      attrs: {
        'stroke-width': 1.8,
        'aria-hidden': 'true',
        focusable: 'false',
      },
    });
  }

  function iconElement(name, className) {
    var icon = document.createElement('i');
    icon.setAttribute('data-lucide', name);
    if (className) icon.className = className;
    return icon;
  }

  function setIcon(target, name) {
    if (!target) return;
    var slot = target.querySelector('[data-icon-slot]');
    if (slot) {
      slot.replaceChildren(iconElement(name));
    } else {
      target.replaceChildren(iconElement(name));
    }
    refreshIcons();
  }

  function initials(name) {
    var value = String(name || '').trim();
    if (!value) return 'G';
    var parts = value.split(/\s+/).filter(Boolean);
    var chars = function (part) {
      return Array.from(part)[0] || '';
    };
    if (parts.length === 1) {
      return (Array.from(parts[0]).slice(0, 2).join('') || 'G').toUpperCase();
    }
    return (chars(parts[0]) + chars(parts[parts.length - 1])).toUpperCase();
  }

  function applyAvatar(element, name) {
    if (!element) return;
    element.textContent = initials(name);
  }

  function getDisplayName() {
    return readString(STORAGE.name, '').trim().slice(0, 48);
  }

  function setDisplayName(name) {
    var clean = String(name || '')
      .normalize('NFC')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 48);
    if (clean) writeString(STORAGE.name, clean);
    return clean;
  }

  function isHostToken(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  }

  function getHostTokens() {
    var tokens = readJSON(STORAGE.hostTokens, {});
    return tokens && typeof tokens === 'object' && !Array.isArray(tokens) ? tokens : {};
  }

  function getHostToken(code) {
    if (!code) return '';
    var token = getHostTokens()[code];
    return isHostToken(token) ? token : '';
  }

  function setHostToken(code, token) {
    if (!code || !isHostToken(token)) return false;
    var tokens = getHostTokens();
    tokens[code] = token;
    return writeJSON(STORAGE.hostTokens, tokens);
  }

  function removeHostToken(code) {
    var tokens = getHostTokens();
    if (!(code in tokens)) return;
    delete tokens[code];
    writeJSON(STORAGE.hostTokens, tokens);
  }

  function isValidRoomCode(code) {
    return (
      typeof code === 'string' &&
      code.length >= 6 &&
      code.length <= 40 &&
      /^[a-z0-9]+(?:-[a-z0-9]+){1,3}$/.test(code) &&
      code.indexOf('--') === -1
    );
  }

  function parseRoomCode(input) {
    if (typeof input !== 'string') return '';
    var value = input.trim();
    if (!value) return '';

    if (/^https?:\/\//i.test(value)) {
      try {
        var url = new URL(value);
        var parts = url.pathname.split('/').filter(Boolean);
        var index = parts.lastIndexOf('room');
        if (index === -1) index = parts.lastIndexOf('r');
        value = index >= 0 && parts[index + 1] ? parts[index + 1] : '';
      } catch (error) {
        return '';
      }
    } else {
      value = value.split(/[?#]/)[0].replace(/\/+$/, '');
      if (value.indexOf('/') !== -1) {
        var segments = value.split('/').filter(Boolean);
        var roomIndex = segments.lastIndexOf('room');
        if (roomIndex === -1) roomIndex = segments.lastIndexOf('r');
        value = roomIndex >= 0 && segments[roomIndex + 1]
          ? segments[roomIndex + 1]
          : segments[segments.length - 1] || '';
      }
    }

    value = decodeURIComponent(value).trim().toLowerCase();
    return isValidRoomCode(value) ? value : '';
  }

  function roomUrl(code, baseUrl) {
    var base = String(baseUrl || window.location.origin).replace(/\/+$/, '');
    return base + '/room/' + encodeURIComponent(code);
  }

  function formatTime(timestamp) {
    var date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }).format(date);
    } catch (error) {
      return date.toLocaleTimeString();
    }
  }

  function formatRelative(timestamp) {
    var date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    var now = new Date();
    var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    var dayDiff = Math.round((startOfToday - startOfDate) / 86400000);
    var time = formatTime(date);
    if (dayDiff === 0) return 'Today, ' + time;
    if (dayDiff === 1) return 'Yesterday, ' + time;
    try {
      var options =
        date.getFullYear() === now.getFullYear()
          ? { month: 'short', day: 'numeric' }
          : { year: 'numeric', month: 'short', day: 'numeric' };
      return new Intl.DateTimeFormat(undefined, options).format(date) + ', ' + time;
    } catch (error) {
      return date.toLocaleDateString();
    }
  }

  function formatDuration(totalSeconds) {
    var seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var rest = seconds % 60;
    var pad = function (value) {
      return value < 10 ? '0' + value : String(value);
    };
    if (hours > 0) return hours + ':' + pad(minutes) + ':' + pad(rest);
    return pad(minutes) + ':' + pad(rest);
  }

  function getRecent() {
    var list = readJSON(STORAGE.recent, []);
    if (!Array.isArray(list)) return [];
    var seen = {};
    return list
      .filter(function (item) {
        if (!item || !isValidRoomCode(item.code)) return false;
        if (seen[item.code]) return false;
        seen[item.code] = true;
        return true;
      })
      .map(function (item) {
        return {
          code: item.code,
          title: String(item.title || 'Untitled meeting').slice(0, 80),
          privacy: item.privacy === 'private' ? 'private' : 'public',
          lastSeen: Number(item.lastSeen) || Date.now(),
          isHost: Boolean(item.isHost),
        };
      })
      .sort(function (a, b) {
        return b.lastSeen - a.lastSeen;
      })
      .slice(0, 8);
  }

  function addRecent(meeting) {
    if (!meeting || !isValidRoomCode(meeting.code)) return;
    var entry = {
      code: meeting.code,
      title: String(meeting.title || 'Untitled meeting').slice(0, 80),
      privacy: meeting.privacy === 'private' ? 'private' : 'public',
      lastSeen: Date.now(),
      isHost: Boolean(meeting.isHost || getHostToken(meeting.code)),
    };
    var next = [entry].concat(
      getRecent().filter(function (item) {
        return item.code !== entry.code;
      }),
    );
    writeJSON(STORAGE.recent, next.slice(0, 8));
  }

  function removeRecent(code) {
    writeJSON(
      STORAGE.recent,
      getRecent().filter(function (item) {
        return item.code !== code;
      }),
    );
  }

  function clearRecent() {
    removeKey(STORAGE.recent);
  }

  var clientIdCache = '';

  function generateClientId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID().replace(/-/g, '');
      }
      if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        var bytes = new Uint8Array(18);
        window.crypto.getRandomValues(bytes);
        var value = Array.prototype.map
          .call(bytes, function (byte) {
            return byte.toString(16).padStart(2, '0');
          })
          .join('');
        return value;
      }
    } catch (error) {
      // Fall through to a weaker but still local identifier.
    }
    return (
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2)
    ).slice(0, 32);
  }

  function getClientId() {
    if (clientIdCache) return clientIdCache;
    var existing = readString(STORAGE.clientId, '');
    if (/^[A-Za-z0-9_-]{16,64}$/.test(existing)) {
      clientIdCache = existing;
      return existing;
    }
    var generated = generateClientId();
    clientIdCache = generated;
    writeString(STORAGE.clientId, generated);
    return generated;
  }

  async function copyText(text) {
    var value = String(text || '');
    if (!value) return false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (error) {
      // Use the legacy fallback below.
    }
    try {
      var textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.setAttribute('aria-hidden', 'true');
      textarea.className = 'sr-only';
      document.body.appendChild(textarea);
      textarea.select();
      var copied = document.execCommand('copy');
      textarea.remove();
      return copied;
    } catch (error) {
      return false;
    }
  }

  async function copyWithToast(text, message) {
    var copied = await copyText(text);
    toast({
      type: copied ? 'success' : 'error',
      title: copied ? 'Copied' : 'Could not copy',
      message: copied
        ? message || 'Copied to your clipboard.'
        : 'Copy the link manually from the address bar.',
      duration: copied ? 2600 : 5000,
    });
    return copied;
  }

  var toastTimers = new Map();

  function removeToast(element) {
    if (!element) return;
    var timer = toastTimers.get(element);
    if (timer) window.clearTimeout(timer);
    toastTimers.delete(element);
    element.classList.add('toast--leaving');
    window.setTimeout(function () {
      element.remove();
    }, 140);
  }

  function toast(input, options) {
    var region = document.getElementById('toast-region');
    if (!region) return null;
    var config = typeof input === 'string' ? Object.assign({ message: input }, options) : input || {};
    var type = ['success', 'error', 'warning', 'info'].indexOf(config.type) >= 0 ? config.type : 'info';
    var icons = {
      success: 'circle-check',
      error: 'circle-alert',
      warning: 'triangle-alert',
      info: 'info',
    };
    var titles = {
      success: 'Success',
      error: 'Something went wrong',
      warning: 'Heads up',
      info: 'Notice',
    };

    var element = document.createElement('div');
    element.className = 'toast toast--' + type;
    element.setAttribute('role', type === 'error' ? 'alert' : 'status');

    var iconWrap = document.createElement('span');
    iconWrap.className = 'toast__icon';
    iconWrap.appendChild(iconElement(icons[type]));
    element.appendChild(iconWrap);

    var content = document.createElement('div');
    content.className = 'toast__content';
    var title = document.createElement('strong');
    title.className = 'toast__title';
    title.textContent = config.title || titles[type];
    content.appendChild(title);
    if (config.message) {
      var message = document.createElement('p');
      message.className = 'toast__message';
      message.textContent = config.message;
      content.appendChild(message);
    }
    element.appendChild(content);

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast__close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.appendChild(iconElement('x'));
    close.addEventListener('click', function () {
      removeToast(element);
    });
    element.appendChild(close);

    region.appendChild(element);
    refreshIcons();

    // removeToast() animates and detaches asynchronously, so it cannot be used
    // as the loop condition here. Detach the oldest toasts synchronously to
    // keep the stack bounded.
    while (region.children.length > 4) {
      var overflow = region.firstElementChild;
      if (!overflow) break;
      var overflowTimer = toastTimers.get(overflow);
      if (overflowTimer) window.clearTimeout(overflowTimer);
      toastTimers.delete(overflow);
      overflow.remove();
    }

    var duration = Number(config.duration) || (type === 'error' ? 6000 : 4000);
    if (duration > 0) {
      toastTimers.set(
        element,
        window.setTimeout(function () {
          removeToast(element);
        }, duration),
      );
    }
    return element;
  }

  function setButtonLoading(button, loading, label) {
    if (!button) return;
    if (loading) {
      if (!button._rtcOriginalNodes) {
        button._rtcOriginalNodes = Array.prototype.map.call(button.childNodes, function (node) {
          return node.cloneNode(true);
        });
      }
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      var spinner = document.createElement('span');
      spinner.className = 'btn__spinner';
      spinner.setAttribute('aria-hidden', 'true');
      button.replaceChildren(spinner);
      if (label) {
        var text = document.createElement('span');
        text.textContent = label;
        button.appendChild(text);
      }
    } else {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      if (button._rtcOriginalNodes) {
        button.replaceChildren.apply(button, button._rtcOriginalNodes);
        delete button._rtcOriginalNodes;
        refreshIcons();
      }
    }
  }

  function openDialog(target) {
    var dialog = typeof target === 'string' ? document.getElementById(target) : target;
    if (!dialog || typeof dialog.showModal !== 'function') return null;
    if (!dialog.open) dialog.showModal();
    return dialog;
  }

  function closeDialog(target) {
    var dialog = typeof target === 'string' ? document.getElementById(target) : target;
    if (dialog && dialog.open) dialog.close();
  }

  var confirmState = null;

  function confirmDialog(options) {
    var dialog = document.getElementById('confirm-dialog');
    if (!dialog || typeof dialog.showModal !== 'function') {
      return Promise.resolve(window.confirm((options && options.description) || 'Are you sure?'));
    }
    if (confirmState) {
      confirmState.resolve(false);
      confirmState = null;
    }

    var config = options || {};
    var title = document.getElementById('confirm-title');
    var description = document.getElementById('confirm-description');
    var icon = document.getElementById('confirm-icon');
    var ok = dialog.querySelector('[data-confirm-ok]');
    var cancel = dialog.querySelector('[data-confirm-cancel]');

    title.textContent = config.title || 'Are you sure?';
    description.textContent = config.description || '';
    description.hidden = !config.description;
    ok.textContent = config.confirmLabel || 'Confirm';
    cancel.textContent = config.cancelLabel || 'Cancel';
    ok.classList.toggle('btn-danger', config.danger !== false);
    ok.classList.toggle('btn-primary', config.danger === false);
    icon.classList.toggle('dialog__icon--danger', config.danger !== false);
    icon.classList.toggle('dialog__icon--success', config.danger === false);
    icon.replaceChildren(iconElement(config.icon || (config.danger === false ? 'check' : 'triangle-alert')));
    refreshIcons();

    return new Promise(function (resolve) {
      var settled = false;

      function cleanup() {
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        dialog.removeEventListener('close', onClose);
      }

      function finish(value) {
        if (settled) return;
        settled = true;
        cleanup();
        confirmState = null;
        if (dialog.open) dialog.close();
        resolve(value);
      }

      function onOk() {
        finish(true);
      }

      function onCancel() {
        finish(false);
      }

      function onClose() {
        if (!settled) {
          settled = true;
          cleanup();
          confirmState = null;
          resolve(false);
        }
      }

      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      dialog.addEventListener('close', onClose);
      confirmState = { resolve: finish };
      dialog.showModal();
      cancel.focus();
    });
  }

  function closeAllDropdowns(except) {
    $$('[data-dropdown]').forEach(function (dropdown) {
      if (except && dropdown === except) return;
      var trigger = dropdown.querySelector('[aria-haspopup="menu"]');
      var menu = dropdown.querySelector('[role="menu"]');
      if (!trigger || !menu) return;
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    });
  }

  function initDropdowns() {
    $$('[data-dropdown]').forEach(function (dropdown) {
      var trigger = dropdown.querySelector('[aria-haspopup="menu"]');
      var menu = dropdown.querySelector('[role="menu"]');
      if (!trigger || !menu) return;

      trigger.addEventListener('click', function (event) {
        event.stopPropagation();
        var willOpen = menu.hidden;
        closeAllDropdowns(dropdown);
        menu.hidden = !willOpen;
        trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        if (willOpen) {
          var firstItem = menu.querySelector('button');
          if (firstItem) firstItem.focus();
        }
      });

      dropdown.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
          menu.hidden = true;
          trigger.setAttribute('aria-expanded', 'false');
          trigger.focus();
        }
      });

      menu.addEventListener('click', function (event) {
        if (event.target.closest('button')) {
          menu.hidden = true;
          trigger.setAttribute('aria-expanded', 'false');
        }
      });
    });

    document.addEventListener('click', function (event) {
      if (!event.target.closest('[data-dropdown]')) closeAllDropdowns();
    });
  }

  function initDialogs() {
    document.addEventListener('click', function (event) {
      var opener = event.target.closest('[data-dialog-open]');
      if (opener) {
        event.preventDefault();
        var id = opener.getAttribute('data-dialog-open');
        var dialog = openDialog(id);
        if (dialog) {
          var firstInput = dialog.querySelector(
            'input:not([type="radio"]):not([type="checkbox"]):not([readonly]), textarea, select',
          );
          if (firstInput && !firstInput.disabled) {
            window.setTimeout(function () {
              firstInput.focus();
              if (typeof firstInput.select === 'function' && firstInput.tagName === 'INPUT') {
                firstInput.select();
              }
            }, 30);
          }
        }
      }

      var closer = event.target.closest('[data-dialog-close]');
      if (closer) {
        event.preventDefault();
        var open = closer.closest('dialog');
        if (open) open.close();
      }
    });

    $$('dialog').forEach(function (dialog) {
      dialog.addEventListener('click', function (event) {
        if (event.target === dialog) dialog.close();
      });
    });
  }

  function syncThemeButtons() {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    $$('[data-theme-toggle]').forEach(function (button) {
      button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
      button.setAttribute('title', dark ? 'Switch to light theme' : 'Switch to dark theme');
    });
  }

  function initThemeControls() {
    $$('[data-theme-toggle]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (window.RTCTheme) window.RTCTheme.toggle();
      });
    });
    document.addEventListener('themechange', syncThemeButtons);
    syncThemeButtons();
  }

  function isEditableTarget(target) {
    if (!target || !target.closest) return false;
    return Boolean(
      target.closest(
        'input, textarea, select, [contenteditable="true"], [contenteditable=""]',
      ),
    );
  }

  document.addEventListener('DOMContentLoaded', function () {
    initDialogs();
    initDropdowns();
    initThemeControls();
    refreshIcons();
  });

  RTC.$ = $;
  RTC.$$ = $$;
  RTC.storage = {
    getJSON: readJSON,
    setJSON: writeJSON,
    getString: readString,
    setString: writeString,
    remove: removeKey,
    keys: STORAGE,
  };
  RTC.refreshIcons = refreshIcons;
  RTC.icon = iconElement;
  RTC.setIcon = setIcon;
  RTC.initials = initials;
  RTC.applyAvatar = applyAvatar;
  RTC.getDisplayName = getDisplayName;
  RTC.setDisplayName = setDisplayName;
  RTC.getClientId = getClientId;
  RTC.getHostToken = getHostToken;
  RTC.setHostToken = setHostToken;
  RTC.removeHostToken = removeHostToken;
  RTC.recent = {
    list: getRecent,
    add: addRecent,
    remove: removeRecent,
    clear: clearRecent,
  };
  RTC.copyText = copyText;
  RTC.copyWithToast = copyWithToast;
  RTC.toast = toast;
  RTC.setButtonLoading = setButtonLoading;
  RTC.openDialog = openDialog;
  RTC.closeDialog = closeDialog;
  RTC.confirm = confirmDialog;
  RTC.parseRoomCode = parseRoomCode;
  RTC.isValidRoomCode = isValidRoomCode;
  RTC.roomUrl = roomUrl;
  RTC.formatTime = formatTime;
  RTC.formatRelative = formatRelative;
  RTC.formatDuration = formatDuration;
  RTC.isEditableTarget = isEditableTarget;
  RTC.getMirrorPreference = function () {
    return readString(STORAGE.mirror, 'true') !== 'false';
  };
  RTC.setMirrorPreference = function (enabled) {
    writeString(STORAGE.mirror, enabled ? 'true' : 'false');
  };
})();
