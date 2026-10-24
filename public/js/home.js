(function () {
  'use strict';

  var RTC = window.RTC;

  function api(path, options) {
    return fetch(path, Object.assign(
      {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      },
      options || {},
    )).then(async function (response) {
      var data = null;
      try {
        data = await response.json();
      } catch (error) {
        data = null;
      }
      if (!response.ok) {
        var failure = new Error(
          (data && data.message) || 'The request could not be completed.',
        );
        failure.code = data && data.error;
        failure.status = response.status;
        throw failure;
      }
      return data;
    });
  }

  function updateNameUi() {
    var name = RTC.getDisplayName();
    RTC.$$('[data-user-name]').forEach(function (element) {
      element.textContent = name || 'Set your name';
    });
    RTC.$$('[data-user-avatar]').forEach(function (element) {
      RTC.applyAvatar(element, name || 'Guest');
    });
  }

  function showInlineError(element, message) {
    if (!element) return;
    element.textContent = message;
    element.hidden = !message;
  }

  function renderRecent() {
    var container = document.getElementById('recent-list');
    var empty = document.getElementById('recent-empty');
    var clear = document.getElementById('clear-recent');
    if (!container || !empty || !clear) return;

    var meetings = RTC.recent.list();
    container.replaceChildren();
    empty.hidden = meetings.length > 0;
    clear.hidden = meetings.length === 0;

    meetings.forEach(function (meeting) {
      var row = document.createElement('div');
      row.className = 'recent-item';

      var iconWrap = document.createElement('span');
      iconWrap.className = 'recent-item__icon';
      iconWrap.setAttribute('aria-hidden', 'true');
      iconWrap.appendChild(RTC.icon('video'));
      row.appendChild(iconWrap);

      var main = document.createElement('div');
      main.className = 'recent-item__main';

      var titleRow = document.createElement('div');
      titleRow.className = 'recent-item__title-row';
      var title = document.createElement('span');
      title.className = 'recent-item__title';
      title.textContent = meeting.title;
      titleRow.appendChild(title);
      if (meeting.isHost || RTC.getHostToken(meeting.code)) {
        var hostBadge = document.createElement('span');
        hostBadge.className = 'badge badge--accent';
        hostBadge.textContent = 'Host';
        titleRow.appendChild(hostBadge);
      }
      main.appendChild(titleRow);

      var meta = document.createElement('div');
      meta.className = 'recent-item__meta';
      var code = document.createElement('code');
      code.textContent = meeting.code;
      meta.appendChild(code);
      var separator = document.createElement('span');
      separator.textContent = '·';
      meta.appendChild(separator);
      var time = document.createElement('span');
      time.textContent = RTC.formatRelative(meeting.lastSeen);
      meta.appendChild(time);
      var privacy = document.createElement('span');
      privacy.className = 'badge badge--outline';
      privacy.textContent = meeting.privacy === 'private' ? 'Private' : 'Public';
      meta.appendChild(privacy);
      main.appendChild(meta);
      row.appendChild(main);

      var actions = document.createElement('div');
      actions.className = 'recent-item__actions';

      var join = document.createElement('button');
      join.type = 'button';
      join.className = 'btn btn-secondary btn-sm';
      join.appendChild(document.createTextNode('Rejoin'));
      join.appendChild(RTC.icon('arrow-right'));
      join.addEventListener('click', function () {
        window.location.assign('/room/' + encodeURIComponent(meeting.code));
      });
      actions.appendChild(join);

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-ghost btn-icon btn-sm recent-item__remove';
      remove.setAttribute('aria-label', 'Remove ' + meeting.title + ' from recent meetings');
      remove.appendChild(RTC.icon('x'));
      remove.addEventListener('click', function () {
        RTC.recent.remove(meeting.code);
        renderRecent();
      });
      actions.appendChild(remove);

      row.appendChild(actions);
      container.appendChild(row);
    });

    RTC.refreshIcons();
  }

  async function createMeeting(title, privacy, intent, triggerButton) {
    var submitButtons = RTC.$$('#create-form button[type="submit"]');
    submitButtons.forEach(function (button) {
      button.disabled = true;
    });
    if (triggerButton) RTC.setButtonLoading(triggerButton, true, 'Creating…');

    try {
      var data = await api('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ title: title, privacy: privacy }),
      });
      var room = data.room;
      RTC.setHostToken(room.code, data.hostToken);
      RTC.recent.add({
        code: room.code,
        title: room.title,
        privacy: room.privacy,
        isHost: true,
      });
      renderRecent();

      if (intent === 'now') {
        window.location.assign('/room/' + encodeURIComponent(room.code));
        return;
      }

      var name = document.getElementById('created-name');
      var privacyLabel = document.getElementById('created-privacy');
      var link = document.getElementById('created-link');
      var open = document.getElementById('open-created-lobby');
      if (name) name.textContent = room.title;
      if (privacyLabel) {
        privacyLabel.textContent = room.privacy === 'private' ? 'Private' : 'Public';
        privacyLabel.className =
          'badge ' + (room.privacy === 'private' ? 'badge--warning' : 'badge--success');
      }
      if (link) link.value = data.inviteUrl || RTC.roomUrl(room.code);
      if (open) open.href = '/room/' + encodeURIComponent(room.code);
      RTC.closeDialog('create-dialog');
      RTC.openDialog('created-dialog');
      RTC.toast({
        type: 'success',
        title: 'Meeting created',
        message: 'The invite link is ready to share.',
        duration: 3000,
      });
    } catch (error) {
      RTC.toast({
        type: 'error',
        title: 'Could not create meeting',
        message: error.message || 'Please try again.',
      });
      if (intent !== 'now') {
        showInlineError(document.getElementById('create-error'), error.message);
      }
    } finally {
      submitButtons.forEach(function (button) {
        button.disabled = false;
      });
      if (triggerButton) RTC.setButtonLoading(triggerButton, false);
    }
  }

  function initNameDialog() {
    var input = document.getElementById('name-input');
    var form = document.getElementById('name-form');
    var error = document.getElementById('name-error');

    RTC.$$('[data-dialog-open="name-dialog"]').forEach(function (trigger) {
      trigger.addEventListener('click', function () {
        if (input) input.value = RTC.getDisplayName();
        showInlineError(error, '');
      });
    });

    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var value = input ? input.value.trim() : '';
        if (!value) {
          showInlineError(error, 'Enter a display name.');
          if (input) {
            input.setAttribute('aria-invalid', 'true');
            input.focus();
          }
          return;
        }
        var saved = RTC.setDisplayName(value);
        updateNameUi();
        RTC.closeDialog('name-dialog');
        RTC.toast({
          type: 'success',
          title: 'Display name saved',
          message: 'You will join meetings as ' + saved + '.',
          duration: 2800,
        });
      });
    }

    if (input) {
      input.addEventListener('input', function () {
        input.removeAttribute('aria-invalid');
        showInlineError(error, '');
      });
    }
  }

  function initJoinForm() {
    var form = document.getElementById('join-form');
    var input = document.getElementById('join-code');
    var error = document.getElementById('join-error');
    if (!form || !input) return;

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var code = RTC.parseRoomCode(input.value);
      if (!code) {
        showInlineError(
          error,
          'Enter a valid meeting code or paste a full invite link.',
        );
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      input.removeAttribute('aria-invalid');
      showInlineError(error, '');
      window.location.assign('/room/' + encodeURIComponent(code));
    });

    input.addEventListener('input', function () {
      input.removeAttribute('aria-invalid');
      showInlineError(error, '');
    });
  }

  function initCreateDialog() {
    var form = document.getElementById('create-form');
    var instantButton = document.getElementById('instant-meeting');
    var error = document.getElementById('create-error');

    RTC.$$('[data-open-create]').forEach(function (button) {
      button.addEventListener('click', function () {
        showInlineError(error, '');
        var title = document.getElementById('create-title-input');
        if (title) title.value = '';
        var privacy = document.querySelector('#create-form input[name="privacy"][value="public"]');
        if (privacy) privacy.checked = true;
        RTC.openDialog('create-dialog');
      });
    });

    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        showInlineError(error, '');
        var submitter = event.submitter;
        var intent = submitter && submitter.value === 'now' ? 'now' : 'later';
        var titleInput = document.getElementById('create-title-input');
        var privacyInput = form.querySelector('input[name="privacy"]:checked');
        createMeeting(
          titleInput ? titleInput.value.trim() : '',
          privacyInput ? privacyInput.value : 'public',
          intent,
          submitter,
        );
      });
    }

    if (instantButton) {
      instantButton.addEventListener('click', function () {
        createMeeting('Instant meeting', 'public', 'now', instantButton);
      });
    }

    var copy = document.getElementById('copy-created');
    if (copy) {
      copy.addEventListener('click', function () {
        var link = document.getElementById('created-link');
        if (link) RTC.copyWithToast(link.value, 'Invite link copied.');
      });
    }

    var clear = document.getElementById('clear-recent');
    if (clear) {
      clear.addEventListener('click', async function () {
        var confirmed = await RTC.confirm({
          title: 'Clear recent meetings?',
          description:
            'This only removes history from this browser. It does not delete any meeting.',
          confirmLabel: 'Clear history',
        });
        if (!confirmed) return;
        RTC.recent.clear();
        renderRecent();
        RTC.toast({
          type: 'success',
          title: 'History cleared',
          message: 'Recent meetings were removed from this browser.',
          duration: 2600,
        });
      });
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    updateNameUi();
    initNameDialog();
    initJoinForm();
    initCreateDialog();
    renderRecent();

    window.addEventListener('storage', function (event) {
      if (!event.key || event.key.indexOf('rtc.') === 0) {
        updateNameUi();
        renderRecent();
      }
    });
  });
})();
