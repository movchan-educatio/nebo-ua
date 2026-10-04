const DEFAULT_WINDOW_MS=60_000;

export function appendTimeline(items,item,{limit=80,windowMs=DEFAULT_WINDOW_MS}={}){
  const at=item.at instanceof Date?item.at:new Date(item.at);
  const existing=items[0];
  const same=existing&&existing.text===item.text&&existing.source===item.source;
  const close=same&&Math.abs(at-new Date(existing.at))<=windowMs;
  if(close){
    const merged={...existing,at,count:(existing.count||1)+1};
    return[merged,...items.slice(1)].slice(0,limit);
  }
  return[{...item,at,count:item.count||1},...items].slice(0,limit);
}
