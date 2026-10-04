import { fetchJson } from './http.js';
const ALERTS_URL = 'https://check-ua-proxy.kykyyzka.workers.dev/alerts';
export async function fetchAlerts(signal) {
  const data = await fetchJson(ALERTS_URL, { signal, timeout: 9000 });
  const raions = Array.isArray(data.raions) ? data.raions : [];
  const oblasts = Array.isArray(data.oblasts) ? data.oblasts : [];
  return [...oblasts, ...raions].filter(a => a && typeof a.name === 'string').map(a => ({...a, source:'NEPTUN', sourceUrl:'https://neptun.in.ua/'}));
}
