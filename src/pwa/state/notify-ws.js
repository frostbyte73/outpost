// Global notifications WebSocket. Singleton — one socket per client, opened
// at boot, reconnects with backoff. Carries cross-session broadcasts
// (approvals, work updates, sessions_changed, etc.) that don't belong on any
// particular session's WS.
//
// The message handler is installed by app.js at boot via installMessageHandler
// so this module doesn't need to import from app.js (which would circle).
//
// State is published to state/conn.js so the UI's connection indicator and
// the disconnect banner see updates without polling this module.

import { conn } from './conn.js';

const BACKOFF_MS = 1500;
const FAIL_THRESHOLD = 3;

let ws = null;
let retries = 0;
let timer = null;
let _handleMessage = null;
let _onOpen = null;

export function installNotifyHandlers({ onMessage, onOpen }) {
  _handleMessage = onMessage;
  _onOpen = onOpen;
}

function publish() {
  if (ws && ws.readyState === WebSocket.OPEN) conn.setNotify('connected');
  else if (retries >= FAIL_THRESHOLD) conn.setNotify('failed');
  else conn.setNotify('reconnecting');
}

export function openNotifyWs() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (timer) { clearTimeout(timer); timer = null; }
  publish();
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${scheme}://${location.host}/ws/notifications`);
  ws = socket;
  socket.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    _handleMessage?.(msg);
  };
  socket.onopen = () => {
    retries = 0;
    publish();
    _onOpen?.();
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    retries += 1;
    publish();
    const delay = BACKOFF_MS * Math.min(retries, 4);
    timer = setTimeout(openNotifyWs, delay);
  };
  socket.onerror = () => { /* close handler retries */ };
}

// Reset retries + reconnect immediately, bypassing backoff. Called by the
// user-facing "reconnect" button.
export function forceReconnectNotifyWs() {
  retries = 0;
  if (timer) { clearTimeout(timer); timer = null; }
  if (ws) ws.close();
  openNotifyWs();
}

// Send a frame on the notify WS if it's open. Returns true on success. Used
// for approval decisions, which prefer this channel because it survives
// session-WS churn (a session subprocess exit shouldn't drop the decision).
export function sendOnNotifyWs(wire) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(typeof wire === 'string' ? wire : JSON.stringify(wire));
  return true;
}

export function notifyWsReadyState() {
  return ws?.readyState ?? -1;
}
