'use strict';

const ROOM_CODE_RE = /^[a-z0-9]+(?:-[a-z0-9]+){1,3}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRoomCode(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function isValidRoomCode(value) {
  const code = normalizeRoomCode(value);
  return (
    code.length >= 6 &&
    code.length <= 40 &&
    ROOM_CODE_RE.test(code) &&
    !code.includes('--')
  );
}

function normalizeDisplayName(value, maxLength = 48) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFC')
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeTitle(value, maxLength = 80) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFC')
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizePrivacy(value) {
  return value === 'private' ? 'private' : 'public';
}

function isValidClientId(value) {
  return typeof value === 'string' && CLIENT_ID_RE.test(value);
}

function isValidToken(value) {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

function isValidId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

function normalizeChatText(value, maxLength = 2000) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, maxLength);
}

function sanitizeIceCandidate(value) {
  if (value === null) return null;
  if (!isPlainObject(value)) return null;

  const candidate = typeof value.candidate === 'string' ? value.candidate.trim() : '';
  if (!candidate || candidate.length > 4096) return null;

  const sdpMid =
    typeof value.sdpMid === 'string' && value.sdpMid.length <= 256
      ? value.sdpMid
      : null;
  const sdpMLineIndex =
    Number.isInteger(value.sdpMLineIndex) &&
    value.sdpMLineIndex >= 0 &&
    value.sdpMLineIndex <= 64
      ? value.sdpMLineIndex
      : null;
  if (sdpMid === null && sdpMLineIndex === null) return null;

  return { candidate, sdpMid, sdpMLineIndex };
}

function sanitizeSessionDescription(value) {
  if (!isPlainObject(value)) return null;
  const type = value.type;
  const sdp = value.sdp;
  if (type !== 'offer' && type !== 'answer') return null;
  if (typeof sdp !== 'string' || sdp.length < 20 || sdp.length > 100000) {
    return null;
  }
  if (!sdp.startsWith('v=0')) return null;
  return { type, sdp };
}

function sanitizeParticipantState(value) {
  if (!isPlainObject(value)) return null;
  const state = {};
  for (const key of ['mic', 'camera', 'sharing', 'hand']) {
    if (typeof value[key] === 'boolean') state[key] = value[key];
  }
  if (Object.keys(state).length === 0) return null;
  return state;
}

module.exports = {
  isPlainObject,
  normalizeRoomCode,
  isValidRoomCode,
  normalizeDisplayName,
  normalizeTitle,
  normalizePrivacy,
  isValidClientId,
  isValidToken,
  isValidId,
  normalizeChatText,
  sanitizeIceCandidate,
  sanitizeSessionDescription,
  sanitizeParticipantState,
  ROOM_CODE_RE,
};
