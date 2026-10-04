// Data source switch. Flip DATA_MODE to 'direct' to bypass the aggregator.
// AGGREGATOR_URL can be overridden per-device via localStorage 'nebo-api-url'.
export const DATA_MODE = 'aggregator';
export const AGGREGATOR_URL = 'https://check-ua-proxy.kykyyzka.workers.dev/v1/state';
export function aggregatorUrl() {
  try {
    const custom = typeof localStorage !== 'undefined' ? localStorage.getItem('nebo-api-url') : null;
    if (custom && /^https?:\/\//.test(custom)) return custom;
  } catch { /* ignore */ }
  return AGGREGATOR_URL;
}
