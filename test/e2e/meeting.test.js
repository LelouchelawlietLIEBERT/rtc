'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { chromium } = require('playwright-core');
const { api, createRoom, startApp } = require('../helpers');

const CHROME =
  process.env.CHROME_PATH ||
  (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : '');

const browserArgs = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--no-sandbox',
  '--auto-select-desktop-capture-source=Entire screen',
  '--enable-usermedia-screen-capturing',
  '--allow-http-screen-capture',
];

async function launchBrowser() {
  return chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: browserArgs,
  });
}

async function openParticipant(browser, base, roomCode, hostToken, name) {
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
  });
  if (hostToken) {
    await context.addInitScript((token) => {
      try {
        const code = window.location.pathname.split('/').filter(Boolean).pop();
        if (!code) return;
        const key = 'rtc.hostTokens.v1';
        const stored = JSON.parse(window.localStorage.getItem(key) || '{}');
        stored[code] = token;
        window.localStorage.setItem(key, JSON.stringify(stored));
      } catch {
        // The page may not have a storage-capable origin yet.
      }
    }, hostToken);
  }

  const page = await context.newPage();
  const pageErrors = [];
  let crashed = false;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('crash', () => {
    crashed = true;
  });

  await page.goto(`${base}/room/${roomCode}`);
  await page.locator('#lobby-name').fill(name);
  await page.locator('#join-meeting').click();
  return { context, page, pageErrors, crashed: () => crashed };
}

async function expectRemoteMedia(page) {
  await page.waitForFunction(
    () => {
      const videos = Array.from(document.querySelectorAll('#video-grid video'));
      return videos.some(
        (video) =>
          !video.muted &&
          video.srcObject &&
          video.srcObject.getVideoTracks().length > 0 &&
          video.videoWidth > 0,
      );
    },
    null,
    { timeout: 20000 },
  );
}

test(
  'instant meeting creation and public lobby join work end to end',
  { skip: !CHROME, timeout: 120000 },
  async (t) => {
    const ctx = await startApp();
    const browser = await launchBrowser();
    t.after(async () => {
      await browser.close().catch(() => {});
      await ctx.close();
    });

    const context = await browser.newContext({
      permissions: ['camera', 'microphone'],
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(ctx.base + '/');
    assert.match(await page.title(), /RTC/);
    await page.locator('#instant-meeting').click();
    await page.waitForURL(/\/room\/[a-z0-9-]+$/, { timeout: 15000 });
    await page.locator('#lobby-view').waitFor({ state: 'visible' });

    const roomCode = page.url().split('/').pop();
    assert.match(roomCode, /^[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}$/);
    await page.locator('#host-badge').waitFor({ state: 'visible' });

    await page.locator('#lobby-name').fill('Instant Host');
    await page.locator('#join-meeting').click();
    await page.locator('#meeting-view').waitFor({ state: 'visible' });
    await page.locator('#meeting-timer').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#more-button').isVisible(), true);
    await page.locator('#toggle-people').click();
    await page.locator('#more-button').click();
    await page.locator('#end-meeting').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');

    const summary = await api(ctx.base, `/api/rooms/${roomCode}`);
    assert.equal(summary.response.status, 200);
    assert.equal(summary.body.room.privacy, 'public');
    assert.deepEqual(pageErrors, []);
  },
);

test(
  'private waiting room, media, chat, hand raise, removal and host end work end to end',
  { skip: !CHROME, timeout: 180000 },
  async (t) => {
    const ctx = await startApp();
    const room = await createRoom(ctx.base, {
      title: 'E2E private meeting',
      privacy: 'private',
    });
    const browser = await launchBrowser();
    const participants = [];
    t.after(async () => {
      for (const participant of participants) {
        await participant.context.close().catch(() => {});
      }
      await browser.close().catch(() => {});
      await ctx.close();
    });

    const host = await openParticipant(
      browser,
      ctx.base,
      room.room.code,
      room.hostToken,
      'Host',
    );
    participants.push(host);
    await host.page.locator('#meeting-view').waitFor({ state: 'visible' });

    const guest = await openParticipant(
      browser,
      ctx.base,
      room.room.code,
      '',
      'Guest',
    );
    participants.push(guest);
    await guest.page.locator('#waiting-view').waitFor({ state: 'visible' });

    await host.page.locator('#waiting-banner').waitFor({ state: 'visible' });
    await host.page.locator('#waiting-banner').click();
    await host.page
      .locator('.waiting-request__actions button[aria-label^="Admit"]')
      .click();
    await guest.page.locator('#meeting-view').waitFor({ state: 'visible' });

    await host.page.waitForFunction(
      () => document.querySelectorAll('#video-grid .tile').length === 2,
    );
    await expectRemoteMedia(host.page);
    await expectRemoteMedia(guest.page);

    await host.page.locator('#toggle-share').click();
    await host.page.locator('#share-banner').waitFor({ state: 'visible' });
    await guest.page.locator('.tile--sharing').waitFor({ timeout: 15000 });
    assert.equal(
      await host.page.locator('#toggle-share').getAttribute('aria-pressed'),
      'true',
    );
    await host.page.locator('#toggle-share').click();
    await host.page.locator('#share-banner').waitFor({ state: 'hidden' });
    await guest.page
      .locator('.tile--sharing')
      .waitFor({ state: 'detached', timeout: 15000 });

    // Toast stack stays bounded even when several notifications arrive at once.
    await host.page.evaluate(() => {
      for (let index = 0; index < 8; index += 1) {
        window.RTC.toast({
          type: 'info',
          title: 'Burst ' + index,
          message: 'Testing the toast stack',
          duration: 0,
        });
      }
    });
    assert.ok((await host.page.locator('#toast-region .toast').count()) <= 4);

    await host.page.locator('#toggle-chat').click();
    await host.page.locator('#chat-input').fill('Hello from the host');
    await host.page.locator('#chat-send').click();
    await guest.page.locator('#toggle-chat').click();
    await guest.page
      .locator('#chat-messages')
      .getByText('Hello from the host')
      .waitFor({ timeout: 10000 });

    await host.page.locator('#toggle-hand').click();
    await guest.page.locator('.tile__badge--hand').waitFor({ timeout: 10000 });
    await host.page.locator('#toggle-hand').click();

    await host.page.locator('#toggle-people').click();
    await host.page.locator('.person__remove').first().click();
    await host.page.locator('#confirm-dialog [data-confirm-ok]').click();
    await guest.page.locator('#exit-view').waitFor({ state: 'visible' });
    assert.match(await guest.page.locator('#exit-title').innerText(), /Removed/);

    await host.page.waitForFunction(
      () => document.querySelectorAll('#video-grid .tile').length === 1,
    );
    // Give deferred toast timers and media teardown a chance to run. A hung or
    // crashed renderer would make this evaluation time out.
    await host.page.waitForTimeout(3200);
    assert.equal(await host.page.evaluate(() => document.querySelectorAll('.tile').length), 1);
    assert.equal(host.crashed(), false);

    await host.page.locator('#more-button').click();
    await host.page.locator('#end-meeting').click();
    await host.page.locator('#confirm-dialog [data-confirm-ok]').click();
    await host.page.locator('#exit-view').waitFor({ state: 'visible' });
    assert.match(await host.page.locator('#exit-title').innerText(), /Meeting ended/);

    const ended = await api(ctx.base, `/api/rooms/${room.room.code}`);
    assert.equal(ended.response.status, 410);
    assert.equal(ended.body.error, 'room_ended');

    assert.deepEqual(host.pageErrors, []);
    assert.equal(guest.crashed(), false);
    assert.deepEqual(guest.pageErrors, []);
  },
);

test(
  'theme toggle, mobile layout and keyboard shortcuts work end to end',
  { skip: !CHROME, timeout: 120000 },
  async (t) => {
    const ctx = await startApp();
    const browser = await launchBrowser();
    t.after(async () => {
      await browser.close().catch(() => {});
      await ctx.close();
    });

    const context = await browser.newContext({
      permissions: ['camera', 'microphone'],
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(ctx.base + '/');
    const initialTheme = await page.locator('html').getAttribute('data-theme');
    await page.locator('[data-theme-toggle]').first().click();
    const nextTheme = await page.locator('html').getAttribute('data-theme');
    assert.notEqual(nextTheme, initialTheme);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      true,
    );

    await page.locator('#instant-meeting').click();
    await page.waitForURL(/\/room\//, { timeout: 15000 });
    await page.locator('#lobby-view').waitFor({ state: 'visible' });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      true,
    );

    await page.locator('#lobby-name').fill('Mobile User');
    await page.locator('#join-meeting').click();
    await page.locator('#meeting-view').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      true,
    );

    assert.equal(await page.locator('#toggle-mic').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('m');
    await page.waitForFunction(
      () => document.getElementById('toggle-mic').getAttribute('aria-pressed') === 'false',
    );
    await page.keyboard.press('m');
    await page.waitForFunction(
      () => document.getElementById('toggle-mic').getAttribute('aria-pressed') === 'true',
    );

    await page.keyboard.press('c');
    await page.locator('#side-panel').waitFor({ state: 'visible' });
    const panelBox = await page.locator('#side-panel').boundingBox();
    assert.ok(panelBox && panelBox.width >= 389);
    await page.keyboard.press('Escape');
    await page.locator('#side-panel').waitFor({ state: 'hidden' });

    assert.deepEqual(pageErrors, []);
  },
);
