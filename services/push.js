// Web Push client: subscribes via the service worker, syncs the subscription
// together with places / categories / quiet hours to the backend aggregator.
// Pure helpers are exported for unit tests; DOM/Notification only in flows.
import { fetchJson } from './http.js';
import { aggregatorUrl } from './config.js';

function apiRoot() {
  try {
    return new URL(aggregatorUrl()).origin;
  } catch {
    return '';
  }
}

export function pushSupported() {
  try {
    return typeof window !== 'undefined'
      && 'serviceWorker' in navigator
      && 'PushManager' in window
      && 'Notification' in window;
  } catch {
    return false;
  }
}

export function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const bytes = atob(raw);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
  return out;
}

function apiError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function api(path, body) {
  try {
    return await fetchJson(apiRoot() + path, {
      timeout: 12000,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw apiError('backend', 'Сервер недоступний. Перевірте з’єднання або зачекайте.');
  }
}

export async function getVapidKey() {
  let data;
  try {
    data = await fetchJson(apiRoot() + '/v1/push/vapid-public-key', { timeout: 8000 });
  } catch (e) {
    throw apiError('backend', 'Push-backend недоступний або не оновлений. Завершіть деплой бекенда.');
  }
  if (!data || typeof data.publicKey !== 'string' || !data.publicKey) {
    throw apiError('vapid', 'VAPID-ключ не налаштовано на сервері.');
  }
  return data.publicKey;
}

async function swReady(timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, rej) => { timer = setTimeout(() => rej(apiError('sw', 'Service Worker не активувався вчасно. Перезавантажте сторінку.')), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function ensurePushSubscription() {
  if (!pushSupported()) throw apiError('unsupported', 'Push не підтримується цим браузером');
  const reg = await swReady();
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;
  const key = await getVapidKey();
  try {
    return await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
  } catch (e) {
    throw apiError('subscribe', 'Не вдалося створити push-підписку: ' + (e?.name || 'невідома помилка'));
  }
}

export function buildSubscribeBody({ subscription, places, categories, quiet }) {
  return {
    subscription: {
      endpoint: subscription?.endpoint,
      keys: { p256dh: subscription?.keys?.p256dh, auth: subscription?.keys?.auth },
    },
    places: Array.isArray(places) ? places : [],
    categories: { ...(categories || {}) },
    quiet: { ...(quiet || {}) },
  };
}

export async function syncPushToBackend({ places, categories, quiet }) {
  const sub = await ensurePushSubscription();
  const body = buildSubscribeBody({ subscription: sub.toJSON ? sub.toJSON() : sub, places, categories, quiet });
  await api('/v1/push/subscribe', body);
  return sub;
}

export async function sendPushTest() {
  const sub = await ensurePushSubscription();
  const endpoint = sub.endpoint || sub.toJSON?.().endpoint;
  const res = await api('/v1/push/test', { endpoint });
  if (!res || res.ok !== true) throw apiError('backend', 'Сервер не зміг доставити тест. Спробуйте пізніше.');
  return res;
}

export async function disablePush() {
  try {
    if (pushSupported()) {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      const endpoint = sub?.endpoint;
      if (sub) await sub.unsubscribe().catch(() => {});
      if (endpoint) await api('/v1/push/unsubscribe', { endpoint }).catch(() => {});
    }
  } catch { /* best effort */ }
}

export async function pushState() {
  if (!pushSupported()) return { supported: false, permission: 'unsupported', subscribed: false };
  const permission = Notification.permission;
  let subscribed = false;
  try {
    const reg = await navigator.serviceWorker.ready;
    subscribed = !!(await reg.pushManager.getSubscription());
  } catch { /* ignore */ }
  return { supported: true, permission, subscribed };
}
