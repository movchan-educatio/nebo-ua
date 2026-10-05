// NEPTUN live WebSocket client (wss://neptun.in.ua/api/v1/stream).
//
// Documented protocol: every frame is an envelope { type, ts, data } with
// type = snapshot | upsert | remove | heartbeat | alerts. No API keys, CORS
// open. Reconnect uses backoff 1/2/5/10/20/30s (capped), never a storm.
//
// HONESTY RULES (hard):
// - positions come ONLY from snapshot/upsert frames (confirmed source data);
// - SDK dead-reckoning helpers are NEVER used here: no extrapolation,
//   no lat+speed*time, no movement between frames except the short CSS glide
//   the renderer already applies between two confirmed positions;
// - malformed frames are counted and ignored, never crash the app;
// - the client never fabricates coordinates, headings or speeds.
export const WS_URL = 'wss://neptun.in.ua/api/v1/stream';
export const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];

function validThreat(t) {
  return !!t && (typeof t.id === 'string' || typeof t.id === 'number');
}

export function classifyFrame(raw) {
  let env = null;
  try {
    env = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { type: 'malformed' };
  }
  if (!env || typeof env !== 'object' || typeof env.type !== 'string') {
    return { type: 'malformed' };
  }
  switch (env.type) {
    case 'snapshot':
      if (!env.data || !Array.isArray(env.data.threats)) return { type: 'malformed' };
      return { type: 'snapshot', threats: env.data.threats, alerts: env.data.alerts ?? null };
    case 'upsert':
      if (!validThreat(env.data)) return { type: 'malformed' };
      return { type: 'upsert', threat: env.data };
    case 'remove':
      if (env.data == null || (typeof env.data.id !== 'string' && typeof env.data.id !== 'number')) {
        return { type: 'malformed' };
      }
      return { type: 'remove', id: String(env.data.id) };
    case 'heartbeat':
      return { type: 'heartbeat' };
    case 'alerts':
      if (!env.data || typeof env.data !== 'object') return { type: 'malformed' };
      return { type: 'alerts', alerts: env.data };
    default:
      return { type: 'malformed' };
  }
}

export function nextBackoff(attempt) {
  const i = Math.max(0, Math.min(attempt | 0, BACKOFF_MS.length - 1));
  return BACKOFF_MS[i];
}

export function createLiveClient({
  url = WS_URL,
  onSnapshot = () => {},
  onUpsert = () => {},
  onRemove = () => {},
  onAlerts = () => {},
  onState = () => {},
  createSocket = null,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  let socket = null;
  let stopped = false;
  let attempt = 0;
  let timer = null;
  const stats = {
    state: 'off',
    reconnects: 0,
    lastEventAt: 0,
    received: { snapshot: 0, upsert: 0, remove: 0, heartbeat: 0, alerts: 0, malformed: 0 },
  };
  function setState(s) {
    stats.state = s;
    try { onState(s); } catch (e) {}
  }
  function connect() {
    if (stopped) return;
    const factory = createSocket || (typeof WebSocket !== 'undefined' ? (u) => new WebSocket(u) : null);
    if (!factory) {
      setState('disabled');
      return;
    }
    setState(attempt === 0 ? 'connecting' : 'reconnecting');
    let ws = null;
    try {
      ws = factory(url);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    socket = ws;
    try {
      ws.onmessage = (msg) => {
        const frame = classifyFrame(msg?.data);
        stats.received[frame.type === 'malformed' ? 'malformed' : frame.type] =
          (stats.received[frame.type] || 0) + 1;
        if (frame.type === 'malformed') return;
        stats.lastEventAt = Date.now();
        attempt = 0;
        if (stats.state !== 'live') setState('live');
        try {
          if (frame.type === 'snapshot') onSnapshot(frame.threats, frame.alerts);
          else if (frame.type === 'upsert') onUpsert(frame.threat);
          else if (frame.type === 'remove') onRemove(frame.id);
          else if (frame.type === 'alerts') onAlerts(frame.alerts);
        } catch (e) {}
      };
      ws.onopen = () => {
        attempt = 0;
        setState('live');
      };
      const down = () => {
        try { if (socket === ws) socket = null; } catch (e) {}
        scheduleReconnect();
      };
      ws.onclose = down;
      ws.onerror = () => {
        try { ws.close(); } catch (e) {}
      };
    } catch (e) {
      scheduleReconnect();
    }
  }
  function scheduleReconnect() {
    if (stopped) return;
    setState('reconnecting');
    const delay = nextBackoff(attempt);
    attempt++;
    stats.reconnects++;
    try { clearTimeoutFn(timer); } catch (e) {}
    timer = setTimeoutFn(connect, delay);
  }
  return {
    stats,
    start() {
      stopped = false;
      attempt = 0;
      connect();
    },
    stop() {
      stopped = true;
      try { clearTimeoutFn(timer); } catch (e) {}
      try { if (socket) socket.close(); } catch (e) {}
      socket = null;
      setState('off');
    },
    retry() {
      attempt = 0;
      try { if (socket) socket.close(); } catch (e) {}
      connect();
    },
  };
}
