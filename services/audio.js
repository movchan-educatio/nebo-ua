export const AUDIO_TYPES=['officialStart','officialEnd','uav','missile','kab','aviation'];
export const AUDIO_LABELS={officialStart:'Офіційна тривога',officialEnd:'Відбій тривоги',uav:'БПЛА',missile:'Ракетна / балістична загроза',kab:'КАБ',aviation:'Авіаційна активність'};
export const DEFAULT_AUDIO_PREFS={enabled:false,officialStart:true,officialEnd:true,uav:true,missile:true,kab:true,aviation:true,volume:.65,quietHoursEnabled:false,quietStart:'23:00',quietEnd:'07:00',muteOfficialInQuiet:false};
const PREF_KEY='nebo-audio-preferences-v1',BASELINE_KEY='nebo-audio-baseline-v1';

export function normalizeAudioCategory(category){return category==='ballistic'?'missile':AUDIO_TYPES.includes(category)?category:null}
export function isQuietTime(prefs,now=new Date()){
  if(!prefs.quietHoursEnabled)return false;const minutes=now.getHours()*60+now.getMinutes(),parse=v=>{const [h,m]=String(v).split(':').map(Number);return h*60+m},start=parse(prefs.quietStart),end=parse(prefs.quietEnd);
  return start===end?true:start<end?minutes>=start&&minutes<end:minutes>=start||minutes<end;
}
export function snapshotForRegion(snapshot,region){
  const events=(snapshot?.events||[]).filter(e=>(e.region||e.derivedRegion)===region&&normalizeAudioCategory(e.category));
  const officialStatus=snapshot?.health?.OFFICIAL?.status,officialKnown=!snapshot?.health||officialStatus==='online'||officialStatus==='delayed';
  return{region,officialKnown,officialActive:(snapshot?.alerts||[]).some(a=>a.region===region),eventIds:Object.fromEntries(AUDIO_TYPES.slice(2).map(type=>[type,events.filter(e=>normalizeAudioCategory(e.category)===type).map(e=>String(e.id)).sort()]))};
}
export function audioTransitions(previous,current,prefs=DEFAULT_AUDIO_PREFS,now=new Date()){
  if(!previous||!current?.region||previous.region!==current.region||!prefs.enabled)return[];const result=[];
  if(current.officialKnown&&!previous.officialActive&&current.officialActive&&prefs.officialStart)result.push('officialStart');
  if(current.officialKnown&&previous.officialActive&&!current.officialActive&&prefs.officialEnd)result.push('officialEnd');
  const quiet=isQuietTime(prefs,now);
  for(const type of AUDIO_TYPES.slice(2)){const before=new Set(previous.eventIds?.[type]||[]),hasNew=(current.eventIds?.[type]||[]).some(id=>!before.has(id));if(hasNew&&prefs[type]&&!quiet)result.push(type)}
  return quiet&&prefs.muteOfficialInQuiet?result.filter(t=>!t.startsWith('official')):result;
}
export function loadAudioPreferences(storage=localStorage){try{return{...DEFAULT_AUDIO_PREFS,...JSON.parse(storage.getItem(PREF_KEY)||'{}')}}catch{return{...DEFAULT_AUDIO_PREFS}}}

export class AudioAlerts{
  constructor({storage=localStorage,onTestState=()=>{}}={}){this.storage=storage;this.prefs=loadAudioPreferences(storage);this.onTestState=onTestState;this.queue=Promise.resolve()}
  save(next){this.prefs={...this.prefs,...next,volume:Math.max(0,Math.min(1,Number(next.volume??this.prefs.volume)))};this.storage.setItem(PREF_KEY,JSON.stringify(this.prefs));return this.prefs}
  baseline(){try{return JSON.parse(this.storage.getItem(BASELINE_KEY)||'null')}catch{return null}}
  prime(snapshot,region){const current=snapshotForRegion(snapshot,region);this.storage.setItem(BASELINE_KEY,JSON.stringify(current));return current}
  process(snapshot,region,now=new Date()){const current=snapshotForRegion(snapshot,region),previous=this.baseline();if(!current.officialKnown&&previous?.region===region)current.officialActive=previous.officialActive;const types=audioTransitions(previous,current,this.prefs,now);this.storage.setItem(BASELINE_KEY,JSON.stringify(current));if(types.length)this.playTypes(types);return types}
  async enable(){this.save({enabled:true});await this.playFile('uav',.01)}
  playTypes(types){this.queue=this.queue.then(async()=>{for(const type of [...new Set(types)]){await this.playFile(type);await delay(180)}}).catch(()=>{})}
  async test(type){if(!AUDIO_TYPES.includes(type))return;this.onTestState(type);try{await this.playFile(type)}finally{setTimeout(()=>this.onTestState(null),900)}}
  async playFile(type,volume=this.prefs.volume){const audio=new Audio(`./assets/audio/${type}.wav`);audio.volume=volume;await audio.play()}
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
