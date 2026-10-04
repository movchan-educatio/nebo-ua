// Two-level danger scale shared by map, list, raions and sky view.
// RED: official alert context, inbound (closing) contact, fresh ballistic,
//      or confirmed fresh missile/shahed. YELLOW: any other fresh monitoring.
// GREY: stale (shown dimmed, never alerts). Pure logic, no network.
export function threatLevel(e) {
  if (!e || e.stale) return 'grey';
  if (e._closing) return 'red';
  if (e.category === 'ballistic') return 'red';
  if (e.confirmed && (e.category === 'missile' || e.kind === 'shahed')) return 'red';
  return 'yellow';
}
export function raionLevel(status) {
  return status === 'alert' ? 'red' : status === 'mon' ? 'yellow' : 'green';
}
export const LEVEL_LABEL = { red: 'ЧЕРВОНИЙ', yellow: 'ЖОВТИЙ', green: 'СПОКІЙНО', grey: 'СТАРЕ' };
