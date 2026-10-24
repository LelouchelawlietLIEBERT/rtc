(function () {
  'use strict';

  var STORAGE_KEY = 'rtc.theme';
  var root = document.documentElement;
  var mediaQuery = window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

  function readStoredTheme() {
    try {
      var value = window.localStorage.getItem(STORAGE_KEY);
      return value === 'light' || value === 'dark' ? value : '';
    } catch (error) {
      return '';
    }
  }

  function systemTheme() {
    return mediaQuery && mediaQuery.matches ? 'dark' : 'light';
  }

  function updateMeta(theme) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#09090b' : '#ffffff');
  }

  function applyTheme(theme, persist) {
    var next = theme === 'dark' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    updateMeta(next);
    if (persist) {
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch (error) {
        // Storage can be unavailable in privacy modes; the theme still applies.
      }
    }
    try {
      document.dispatchEvent(
        new CustomEvent('themechange', { detail: { theme: next } }),
      );
    } catch (error) {
      // CustomEvent is available in all supported browsers.
    }
  }

  applyTheme(readStoredTheme() || systemTheme(), false);

  if (mediaQuery) {
    var onSystemThemeChange = function (event) {
      if (!readStoredTheme()) applyTheme(event.matches ? 'dark' : 'light', false);
    };
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', onSystemThemeChange);
    } else if (typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(onSystemThemeChange);
    }
  }

  window.RTCTheme = {
    get: function () {
      return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    },
    set: function (theme) {
      applyTheme(theme, true);
    },
    toggle: function () {
      applyTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark', true);
    },
  };
})();
