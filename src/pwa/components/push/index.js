// Push-notification UI (subscribe/unsubscribe, test push, iOS/standalone
// detection). Uses the VAPID key from usage.get().daemonInfo which the
// notifications WS populates on /api/info hydration.
//
// mountPushSection(mount) builds a standalone copy of the push UI with no
// static markup dependency — used by the Settings surface on both layouts.
// Every registered target repaints together (see `targets` below) so more
// than one mounted copy stays in sync.

import { usage } from '../../state/usage.js';

const PUSH = {
  permission: typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  subscribed: false,
  endpoint: null,
};

// Each target is {banner, toggle, toggleState, test, status} — elements to
// paint against. The static sheet registers once at init; mountPushSection
// registers/deregisters per mount.
const targets = new Set();

function isiOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator.standalone === true); // iOS Safari legacy
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function setPushStatus(text) {
  for (const t of targets) if (t.status) t.status.textContent = text ?? '';
}

function refreshPushUI() {
  const needIosInstall = isiOS() && !isStandalone() && PUSH.permission !== 'granted';
  for (const t of targets) {
    if (!t.banner || !t.toggle || !t.toggleState || !t.test) continue;
    t.banner.hidden = !needIosInstall;
    t.toggle.setAttribute('aria-pressed', PUSH.subscribed ? 'true' : 'false');
    t.toggleState.textContent = PUSH.subscribed ? 'On' : 'Off';
    t.toggle.disabled = needIosInstall || typeof Notification === 'undefined';
    t.test.disabled = !PUSH.subscribed;
  }
}

async function subscribePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    setPushStatus('Push not supported in this browser.');
    return;
  }
  try {
    const perm = await Notification.requestPermission();
    PUSH.permission = perm;
    if (perm !== 'granted') {
      setPushStatus('Permission not granted.');
      refreshPushUI();
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const vapid = usage.get().daemonInfo?.vapidPublicKey;
    if (!vapid) {
      setPushStatus('Daemon has no VAPID key yet — reload and try again.');
      return;
    }
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid),
      });
    }
    const subJson = sub.toJSON();
    const r = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: subJson, userAgent: navigator.userAgent }),
    });
    if (!r.ok) throw new Error(`subscribe POST ${r.status}`);
    PUSH.subscribed = true;
    PUSH.endpoint = subJson.endpoint;
    setPushStatus('Subscribed.');
  } catch (e) {
    console.warn('subscribePush failed', e);
    setPushStatus(`Subscribe failed: ${e?.message ?? e}`);
  }
  refreshPushUI();
}

async function unsubscribePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await fetch('/api/push/subscribe', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint }),
      });
    }
    PUSH.subscribed = false;
    PUSH.endpoint = null;
    setPushStatus('Unsubscribed.');
  } catch (e) {
    console.warn('unsubscribePush failed', e);
    setPushStatus(`Unsubscribe failed: ${e?.message ?? e}`);
  }
  refreshPushUI();
}

async function sendTestPush() {
  try {
    setPushStatus('Sending…');
    const r = await fetch('/api/push/test', { method: 'POST' });
    if (!r.ok) throw new Error(`test POST ${r.status}`);
    setPushStatus('Test push sent.');
  } catch (e) {
    setPushStatus(`Test failed: ${e?.message ?? e}`);
  }
}

function togglePush() {
  if (PUSH.subscribed) unsubscribePush();
  else subscribePush();
}

// Hydrate PUSH state from the SW registration (async — a reload shows "On" if
// the registration still has a live subscription).
async function hydrate() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    PUSH.subscribed = !!sub;
    PUSH.endpoint = sub?.endpoint ?? null;
  } catch { /* hydration is informational */ }
  refreshPushUI();
}

// Builds a standalone copy of the push UI into `mount` (no reliance on
// index.html markup — used by the desktop Settings surface's Notifications
// section). Returns an unmount function.
export function mountPushSection(mount) {
  mount.innerHTML = `
    <div class="push-section">
      <div class="push-ios-banner" hidden>
        On iOS, push notifications require installing this app to your Home Screen first.
        Tap the Share button in Safari, then "Add to Home Screen", then reopen Outpost from the icon.
      </div>
      <button class="push-toggle" type="button" aria-pressed="false">
        <span class="push-toggle-label">Enable push notifications</span>
        <span class="push-toggle-state">Off</span>
      </button>
      <button class="push-test" type="button" disabled>Send test push</button>
      <div class="push-status" aria-live="polite"></div>
    </div>
  `;
  const target = {
    banner: mount.querySelector('.push-ios-banner'),
    toggle: mount.querySelector('.push-toggle'),
    toggleState: mount.querySelector('.push-toggle-state'),
    test: mount.querySelector('.push-test'),
    status: mount.querySelector('.push-status'),
  };
  targets.add(target);
  target.toggle.addEventListener('click', togglePush);
  target.test.addEventListener('click', sendTestPush);
  refreshPushUI();
  void hydrate();
  return () => { targets.delete(target); };
}

export { PUSH, refreshPushUI };
