import{getOblastRaionPolygons}from'../../services/raionShapesLocal.js';import{threatLevel,LEVEL_LABEL}from'../../services/levels.js';import{oblastRaions,raionDirectory,matchRaion,normOblast,raionAlertActive,raionMatches,territorialDanger,loadCenterCache,saveCenterCache,getCachedCenter}from'../../services/districts.js';import{selectGuardTargets,selectProximityAlerts}from'../../services/guard.js';import{speak}from'../../services/voice.js';import{fetchAll,shouldPoll,POLL_MS}from'../../services/data.js';import{appendTimeline}from'../../services/timeline.js';import{fetchRegions,regionName,pointInFeature}from'../../services/regions.js';import{AudioAlerts,AUDIO_TYPES,AUDIO_LABELS}from'../../services/audio.js';import{mountAdSlots}from'../../services/ads.js';import{setupEnhancements}from'./enhancements.js';import{createSituationMap,createRadarMap,META,iconFor,getThreatVisual,rangeRings}from'./map.js';import{createScope}from'./scope.js';import{describePlace}from'../../services/locations.js';import{pickTopThreat}from'../../services/relevance.js';import{flowStats,flowSummaryHTML,overallStatus,sourceState}from'../../services/summary.js';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];const state={snapshot:{alerts:[],events:[],health:{},disagreement:{}},geo:null,filter:localStorage.getItem('nebo-threat-filter')||'all',visible:new Set(loadJSON('nebo-cats',Object.keys(META)).filter(k=>META[k])),previous:new Map(),timeline:[],timelinePrimed:false,history:[],loading:true,lastSuccess:null,showWind:localStorage.getItem('nebo-wind')==='1',showReports:localStorage.getItem('nebo-reports-layer')!=='0',reports:[],wind:null,windError:null,userPos:null,watchId:null,satelliteOn:localStorage.getItem('nebo-sat')==='1',radarMode:localStorage.getItem('nebo-radar-mode')||'scope',radarRange:(()=>{const v=Number(localStorage.getItem('nebo-radar-range'));return [1,3,5,10,25,100].includes(v)?v:100})(),radarRangeManual:false,radarPin:null,layers:loadJSON('nebo-layers',{alerts:true,history:true,boundaries:true}),guard:{enabled:localStorage.getItem('nebo-guard-enabled')==='1',radius:Number(localStorage.getItem('nebo-guard-radius'))||30},guardSeen:new Map(),proxSeen:new Map(),prox:localStorage.getItem('nebo-prox-enabled')!=='0',threatSort:localStorage.getItem('nebo-threat-sort')||'time',raionOblast:null,raionOpen:new Set(loadJSON('nebo-raion-open',[])),showRaions:localStorage.getItem('nebo-raions-layer')==='1',raionDots:null,showShapes:localStorage.getItem('nebo-shapes-layer')==='1',raionShapes:null,rshapes:null,onlyFresh:localStorage.getItem('nebo-fresh')!=='0',voice:localStorage.getItem('nebo-voice-enabled')==='1'};
const mapUI=createSituationMap($('#map'),openDetail),radarUI=createRadarMap($('#radarMap'),openDetail);const scopeUI=createScope($('#scopeCanvas'));let centerOnNextPos=false;const audio=new AudioAlerts({onTestState:type=>{const el=$('#testSoundState');if(!el)return;el.hidden=!type;el.textContent=type?`ТЕСТ ЗВУКУ · ${AUDIO_LABELS[type]}`:'ТЕСТ ЗВУКУ'}});let refreshTimer;
async function load(){
  state.loading=true;
  renderGlobal();
  restoreCached();
  const settled=await Promise.allSettled([state.geo?Promise.resolve(state.geo):fetchRegions(),fetchAll()]);
  if(settled[0].status==='fulfilled')state.geo=settled[0].value;
  if(settled[1].status==='fulfilled'){
    const snap=settled[1].value;
    try{localStorage.setItem('nebo-last-snapshot', JSON.stringify(snap));}catch(e){}
    deriveRegions(snap.events);audio.process(snap,localStorage.getItem('nebo-region')||'');trackChanges(snap);state.snapshot=snap;state.lastSuccess=snap.receivedAt;annotateDistances();checkGuard();checkProximity();refreshRaionDots();if(state.showShapes)colorizeRaionShapes(false);ensureAlertShapes();state.history.push({at:new Date(),events:snap.events.length,alerts:new Set(snap.alerts.map(a=>a.region)).size});state.history=state.history.filter(x=>Date.now()-x.at<30*60000).slice(-30);dispatchEvent(new CustomEvent('nebo:snapshot',{detail:{snapshot:snap}}))}state.loading=false;renderAll()}
function reviveDate(v){if(!v)return null;const d=v instanceof Date?v:new Date(v);return Number.isFinite(d.getTime())?d:null}
function restoreCached(){
  if(state.lastSuccess)return;
  try{
    const raw=localStorage.getItem('nebo-last-snapshot');
    if(!raw)return;
    const snap=JSON.parse(raw);
    snap.receivedAt=reviveDate(snap.receivedAt);
    if(!snap.receivedAt)return;
    for(const e of snap.events||[]){e.timestamp=reviveDate(e.timestamp);e.receivedAt=reviveDate(e.receivedAt);if(Array.isArray(e.trail))for(const p of e.trail)p.timestamp=reviveDate(p.timestamp);}
    for(const a of snap.alerts||[]){a.timestamp=reviveDate(a.timestamp);a.receivedAt=reviveDate(a.receivedAt);}
    state.snapshot={alerts:snap.alerts||[],events:snap.events||[],health:snap.health||{},disagreement:snap.disagreement||{}};
    state.lastSuccess=snap.receivedAt;
    renderAll();
  }catch(e){}
}
function deriveRegions(events){if(!state.geo)return;for(const e of events){if(!e.region&&e.lat!=null){const f=state.geo.features.find(x=>pointInFeature([e.lat,e.lon],x));if(f)e.derivedRegion=regionName(f)}}}
function trackChanges(snap){const next=new Map(snap.events.map(e=>[e.id,e]));if(!state.timelinePrimed){state.previous=next;state.timelinePrimed=true;return}const now=new Date();for(const e of snap.events){if(!state.previous.has(e.id))pushTimeline(now,`Нове моніторингове повідомлення: ${label(e.category)}`,e.source);else{const old=state.previous.get(e.id);if(e.timestamp?.getTime()!==old.timestamp?.getTime())pushTimeline(now,`Оновлено повідомлення: ${label(e.category)}`,e.source)}}for(const e of state.previous.values())if(!next.has(e.id))pushTimeline(now,'Подія більше не активна у поточному потоці',e.source);state.previous=next}
function pushTimeline(at,text,source){state.timeline=appendTimeline(state.timeline,{at,text,source})}
function renderAll(){annotateDistances();renderGlobal();if(state.geo)mapUI.setRegions(state.geo,state.snapshot.alerts,state.snapshot.events);drawAlertShapes();mapUI.setEvents(flowEvents(),state.visible);mapUI.setUserPos(state.userPos);renderLiveStrip();renderLayers();renderThreats();renderRaions();renderSources();renderSky();renderRadar();renderTimeline();renderMapRecent();renderRail();renderHistory();renderOverlays()}
function renderGlobal(){const h=state.snapshot.health,b=$('#liveBadge'),age=state.lastSuccess?(Date.now()-state.lastSuccess)/60000:Infinity;const st=overallStatus(h);let cls='loading',text='ОТРИМУЄМО ДАНІ';if(!state.loading){if(!navigator.onLine||st.level==='OFFLINE'){cls='offline';text='⛔ OFFLINE'}else if(st.level==='PARTIAL'){cls='delayed';text='⚠ PARTIAL'}else if(st.level==='DELAYED'||age>5){cls='delayed';text='⚠ DELAYED'}else{cls='live';text='● LIVE'}}b.className=`live-pill ${cls}`;b.textContent=text;const _ut=$('#updatedAt');_ut.textContent=state.lastSuccess?clock(state.lastSuccess):'—';_ut.title=state.lastSuccess?('Оновлено: '+new Intl.DateTimeFormat('uk-UA',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(state.lastSuccess))):'';const notice=$('#networkNotice');const officialDown=h.OFFICIAL?.status==='offline';const perSource=[sourceState('NEPTUN',h.NEPTUN),sourceState('MAPA',h.MAPA)];const fmtAge=(x)=>x.ageMs==null?null:fresh(new Date(Date.now()-x.ageMs));const sourceBits=perSource.map(x=>x.name.split(' ')[0]+': '+(x.state==='LIVE'?'LIVE':x.state==='DELAYED'?'DELAYED':'DOWN')+(x.state==='LIVE'&&x.ageMs!=null?' '+fmtAge(x):'')).join(' · ');if(!navigator.onLine){notice.hidden=false;notice.className='system-notice';notice.onclick=null;notice.textContent='Немає з\u2019єднання. Актуальні дані про повітряну обстановку недоступні.'}else if(officialDown){notice.hidden=false;notice.className='system-notice';notice.onclick=null;notice.textContent='Офіційний статус тривог тимчасово недоступний. Моніторингові дані не замінюють офіційний статус.'}else if(st.level==='OFFLINE'){notice.hidden=false;notice.className='system-notice';notice.onclick=null;notice.textContent='⛔ Моніторинг недоступний. Немає актуальних даних.'}else if(st.level==='PARTIAL'||st.level==='DELAYED'){notice.hidden=false;notice.className='system-notice compact';notice.onclick=()=>{showView('threatsView');setTimeout(()=>{const sh=$('#sourceHealth');if(sh)sh.scrollIntoView({behavior:'smooth'})},80)};notice.textContent='\u26a0 '+(st.level==='PARTIAL'?'Часткові дані':'Дані затримуються')+' · '+sourceBits+' (деталі — торкніться)'}else{notice.hidden=true;notice.onclick=null}}
function renderLiveStrip(){
  // Honest renderable counts: exact-coordinate, non-stale, visible-category
  // events by kind (disjoint, no double counting) + actually drawn raion
  // polygons. Labelled as повідомлення; stale-hidden count shown explicitly.
  const stats=flowStats(state.snapshot.events,{visible:state.visible,onlyFresh:state.onlyFresh});
  const raions=(state.raionFillItems||[]).length;
  $('#liveStrip').classList.remove('skeleton');
  $('#liveStrip').innerHTML=flowSummaryHTML(stats,raions);
  try{const hb=$('#liveBadge'),hl=$('#hudLive');if(hb&&hl){hl.textContent=hb.textContent;hl.className='hud-live '+hb.className.replace('live-pill','').trim();}}catch(e){}
  try{const hs=$('#hdrHomeSub');if(hs){const r=localStorage.getItem('nebo-region')||'';hs.textContent=r?r.replace(/ область$/,''):'';}}catch(e){}
}
function renderLayers(){const _lp=$('#layerPanel'),_st=_lp?_lp.scrollTop:0;const _sig=state.snapshot.alerts.length+'.'+state.snapshot.events.length+'.'+(state.wind?state.wind.at:'')+(state.windError||'')+(state.showWind?'1':'0')+(state.showReports?'1':'0')+(state.showRaions?'1':'0')+(state.showShapes?'1':'0')+(state.satelliteOn?'1':'0')+(state.onlyFresh?'1':'0')+[...state.visible].sort().join(',')+JSON.stringify(state.layers);if(_lp&&_lp.hidden&&_sig===state._layersSig)return;state._layersSig=_sig;const layers=[['alerts','Офіційні тривоги'],['history','Історія руху'],['boundaries','Адміністративні межі'],['satellite','Супутник (Esri)']],categories=[['uav','БПЛА'],['missile','Ракети'],['ballistic','Балістика'],['kab','КАБ'],['aviation','Авіація']];$('#layerPanel').innerHTML='<div class="layer-head"><span>Шари карти</span><button type="button" class="layer-close" data-close-layers aria-label="Закрити панель">×</button></div>'+layers.map(([k,n])=>`<label><input type="checkbox" data-layer="${k}" ${((k==='satellite')?state.satelliteOn:state.layers[k]!==false)?'checked':''}>${n}</label>`).join('')+categories.map(([k,n])=>`<label><input type="checkbox" data-category="${k}" ${state.visible.has(k)?'checked':''}>${n}</label>`).join('')+`<label><input type="checkbox" data-fresh ${state.onlyFresh?'checked':''}>Лише свіжі</label><div class="layer-sep"></div><label><input type="checkbox" data-overlay="wind" ${state.showWind?'checked':''}>Вітер (Open-Meteo)</label><label><input type="checkbox" data-overlay="shapes" ${state.showShapes?'checked':''}>Контури районів (OSM)</label><label><input type="checkbox" data-overlay="raions" ${state.showRaions?'checked':''}>Райони на карті</label><label><input type="checkbox" data-overlay="reports" ${state.showReports?'checked':''}>Мої мітки (цей пристрій)</label><button type="button" class="text-button" data-action="add-report">＋ Додати мітку в центрі карти</button>${state.windError?`<p class="micro">${esc(state.windError)}</p>`:''}${state.wind?`<p class="micro">Вітер оновлено ${esc(fresh(new Date(state.wind.at)))} · ${state.wind.items.length} точок</p>`:''}`;$('#layerPanel').querySelectorAll('[data-layer]').forEach(i=>i.onchange=()=>{if(i.dataset.layer==='satellite'){state.satelliteOn=i.checked;try{localStorage.setItem('nebo-sat',i.checked?'1':'0')}catch(e){}}else{state.layers[i.dataset.layer]=i.checked;saveJSON('nebo-layers',state.layers)}mapUI.toggle(i.dataset.layer,i.checked)});$('#layerPanel').querySelectorAll('[data-category]').forEach(i=>i.onchange=()=>{i.checked?state.visible.add(i.dataset.category):state.visible.delete(i.dataset.category);saveJSON('nebo-cats',[...state.visible]);mapUI.setEvents(flowEvents(),state.visible)});$('#layerPanel').querySelectorAll('[data-overlay]').forEach(i=>i.onchange=()=>{if(i.dataset.overlay==='wind')toggleWind(i.checked);if(i.dataset.overlay==='raions')toggleRaions(i.checked);if(i.dataset.overlay==='shapes')toggleRaionShapes(i.checked);if(i.dataset.overlay==='reports'){state.showReports=i.checked;localStorage.setItem('nebo-reports-layer',i.checked?'1':'0');renderOverlays()}});const freshBox=$('#layerPanel').querySelector('[data-fresh]');if(freshBox)freshBox.onchange=e=>{state.onlyFresh=e.target.checked;localStorage.setItem('nebo-fresh',e.target.checked?'1':'0');renderAll()};const lc=$('#layerPanel').querySelector('[data-close-layers]');if(lc)lc.onclick=()=>{$('#layerPanel').hidden=true;$('#layerButton').setAttribute('aria-expanded','false')};if(_lp)_lp.scrollTop=_st;const addBtn=$('#layerPanel').querySelector('[data-action="add-report"]');if(addBtn)addBtn.onclick=()=>$('#reportDialog')?.showModal()}
function renderOverlays(){if(state.showWind&&state.wind)mapUI.setWind(state.wind.items);for(const _lk of['alerts','history','boundaries'])mapUI.toggle(_lk,state.layers[_lk]!==false);mapUI.toggle('wind',!!(state.showWind&&state.wind));mapUI.setReports(state.showReports?state.reports:[],openReportDetail);mapUI.toggle('raions',!!(state.showRaions&&state.raionDots));if(state.showRaions&&!state.raionDots)toggleRaions(true);mapUI.toggle('shapes',!!(state.showShapes&&state.raionShapes));if(state.showShapes&&!state.raionShapes)toggleRaionShapes(true)}
async function toggleWind(on){state.showWind=on;localStorage.setItem('nebo-wind',on?'1':'');if(!on){mapUI.toggle('wind',false);renderLayers();return}try{const m=await import('../../services/wind.js');state.wind=await m.fetchWind();state.windError=null;mapUI.setWind(state.wind.items);mapUI.toggle('wind',true)}catch(e){state.wind=null;state.windError='Шар вітру тимчасово недоступний.';state.showWind=false;localStorage.setItem('nebo-wind','')}renderLayers()}
function refreshReports(){import('../../services/reports.js').then(m=>{state.reports=m.loadReports();renderOverlays()}).catch(()=>{})}
function setupOverlays(){refreshReports();if(state.showWind)toggleWind(true);$('#reportButton')?.addEventListener('click',()=>$('#reportDialog')?.showModal());$('#reportForm')?.addEventListener('submit',async e=>{e.preventDefault();try{const m=await import('../../services/reports.js');const c=mapUI.map.getCenter();m.saveReport({lat:c.lat,lon:c.lng,kind:$('#reportKind').value,note:$('#reportNote').value});$('#reportDialog').close();$('#reportNote').value='';$('#reportStatus').textContent='';refreshReports()}catch(err){$('#reportStatus').textContent='Не вдалося зберегти мітку.'}});$('#reportDialog')?.addEventListener('click',e=>{if(e.target.closest('[data-report-close]'))$('#reportDialog').close()})}
function openReportDetail(r){if(!r)return;import('../../services/reports.js').then(m=>{const names={sound:'Чув звук',sighting:'Бачив проліт',other:'Інше'};$('#detailContent').innerHTML=`<span class="detail-type">ЛОКАЛЬНА МІТКА · ЛИШЕ ЦЕЙ ПРИСТРІЙ</span><h2 class="detail-title">${esc(names[r.kind]||'Мітка')}</h2><div class="detail-grid">${field('Час',clock(new Date(r.at)))}${field('Нотатка',r.note||'—')}</div><div class="explain-box">Неперевірена особиста нотатка. Не є даними моніторингу, не надсилається нікуди, не замінює офіційні сповіщення.</div><button class="text-button" id="deleteReport">Видалити мітку</button>`;$('#detailSheet').showModal();$('#deleteReport').onclick=()=>{m.deleteReport(r.id);$('#detailSheet').close();refreshReports()}}).catch(()=>{})}
function renderThreats(){const available=flowEvents(),filters=['all',...new Set(available.map(e=>e.category))],names={all:'Усі',uav:'БПЛА',missile:'Ракети',ballistic:'Балістика',kab:'КАБ',aviation:'Авіація',recon:'Розвідка',other:'Інше'};$('#filters').innerHTML=`<button class="${state.threatSort==='time'?'active':''}" data-sort="time">За часом</button><button class="${state.threatSort==='eta'?'active':''}" data-sort="eta">За підльотом</button>`+filters.map(k=>`<button class="${state.filter===k?'active':''}" data-filter="${k}">${names[k]||k}</button>`).join('');$('#filters').querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{state.filter=b.dataset.filter;try{localStorage.setItem('nebo-threat-filter',state.filter)}catch(e){}renderThreats()});$('#filters').querySelectorAll('[data-sort]').forEach(b=>b.onclick=()=>{state.threatSort=b.dataset.sort;try{localStorage.setItem('nebo-threat-sort',state.threatSort)}catch(e){}renderThreats()});const items=available.filter(e=>state.filter==='all'||e.category===state.filter).sort(sortThreats);$('#threatList').innerHTML=guardDigest()+(items.length?items.map(card).join(''):`<div class="empty">${state.onlyFresh?'Свіжих':'Активних'} моніторингових повідомлень цієї категорії у підключених джерелах зараз не отримано.</div>`);$('#threatList').querySelectorAll('[data-event]').forEach(el=>el.onclick=()=>openDetail(state.snapshot.events.find(e=>e.id===el.dataset.event)));const d=state.snapshot.disagreement;$('#disagreementCard').innerHTML=d.active?`<div class="warning-card"><b>⚠ Дані моніторингових джерел відрізняються</b><span>${esc(d.reason)}</span></div>`:''}
function card(e){const ic=getThreatVisual(e),m=META[e.category]||META.other,loc=e.settlement||e.district||e.region||e.derivedRegion||'Місце не вказано',sources=e.correlated?.map(x=>x.source)||[e.source],title=e.kind==='shahed'&&!/shahed|шахед/i.test(e.subtype||'')?`Шахед · ${(e.subtype||m.label)}`:(e.subtype||m.label);return`<button class="threat-card cat-${e.category||'other'}${e.stale?' is-stale':''}" data-event="${esc(e.id)}"><span class="event-icon"><svg><use href="./assets/brand/threat-icons.svg#${ic.icon}"/></svg></span><span><h3>${esc(title)}</h3><p>${esc(loc)} · ${fresh(e.timestamp)}${e.areaOnly?' · відомо лише область':''}</p>${distBadge(e)}${lvlBadge(e)}<span class="source-badges">${[...new Set(sources)].map(s=>`<i class="source-badge">${esc(s)}</i>`).join('')}</span></span><time>${clock(e.timestamp,true)}</time></button>`}
function lvlBadge(e){const l=e._lvl||'yellow';return '<span class="lvl-badge lvl-'+l+'">'+esc(LEVEL_LABEL[l]||l)+'</span>'}function distBadge(e){if(e._distKm==null)return'';const cls=e._distKm<25?(e._closing?'closing':''):'far';let t=`${fmtDist(e._distKm)} від вас`;if(e._closing&&e._etaMin!=null)t+=` · наближається ${fmtEta(e._etaMin)}`;return`<span class="dist-badge ${cls}">${esc(t)}</span>`}
function renderSources(){const names={OFFICIAL:'Агреговані сигнали тривог',NEPTUN:'NEPTUN · моніторинг',MAPA:'MAPA · моніторинг'};const html=Object.entries(state.snapshot.health).map(([k,v])=>{const disabled=v.status==='disabled';const stateLabel=disabled?'НЕ НАЛАШТОВАНО':v.status.toUpperCase();const detail=disabled?'Офіційний токен не налаштовано. Джерело вимкнено.':(v.updatedAt?'Успішно '+clock(v.updatedAt,true)+(', '+fresh(new Date(v.updatedAt))):esc(v.error||'Немає даних'));return`<div class="source-row"><b>${names[k]||k}</b><span class="source-state ${v.status}">● ${stateLabel}</span><small>${detail}</small></div>`}).join('');$('#sourceHealth').innerHTML=html;const rs=$('#railSources');if(rs)rs.innerHTML=html;const sk=$('#skySources');if(sk)sk.innerHTML=html}
function renderSky(){if(!state.geo)return;var select=$('#regionSelect'),saved=localStorage.getItem('nebo-region')||'';select.innerHTML='<option value="">Оберіть область…</option>'+state.geo.features.map(function(f,idx){return '<option value="'+idx+'"'+(regionName(f)===saved?' selected':'')+'>'+esc(regionName(f))+'</option>'}).join('');var region=saved,officialOnline=state.snapshot.health.OFFICIAL?.status==='online';var alerts=region?state.snapshot.alerts.filter(function(a){return a.region===region}):[];var events=region?state.snapshot.events.filter(function(e){return e.region===region||e.derivedRegion===region}):[];var _place=null;try{_place=JSON.parse(localStorage.getItem('nebo-location')||'null')}catch(e){}var info=describePlace(_place);var scopeEvents=(_place&&_place.oblast)?state.snapshot.events.filter(function(e){return e.region===_place.oblast||e.derivedRegion===_place.oblast}):events;var _scope=(_place&&_place.oblast)?raionAlertActive(state.snapshot.alerts,_place.oblast,_place.raion):null;var myAlerts=_scope?(_scope.scope==='outside'?[]:_scope.alerts):alerts;var heroState=!officialOnline?'unknown':myAlerts.length?'alert':(events.length||(_scope&&_scope.scope==='outside'))?'watch':'calm';var heroTitle=!officialOnline?'Дані недоступні':myAlerts.length?'ПОВІТРЯНА ТРИВОГА':(events.length||(_scope&&_scope.scope==='outside'))?'Підвищена увага':'Спокійно';var heroSub='';if(!officialOnline)heroSub='Офіційний статус тривог тимчасово недоступний.';else if(myAlerts.length)heroSub=(_place&&_place.raion&&_scope&&_scope.scope==='raion')?('Сигнал у вашому районі: '+_place.raion):'Сигнал у вашій області.';else if(_scope&&_scope.scope==='outside')heroSub='Тривога в інших районах області. У вашому районі спокійно.';else if(events.length)heroSub='Є моніторингові дані у вашій області.';else heroSub=_place?'Активних загроз для вашого місця не зафіксовано.':'Оберіть своє місце, щоб бачити персональний статус.';var upd=state.lastSuccess?('Оновлено '+clock(state.lastSuccess)+' · '+fresh(state.lastSuccess)):'Час оновлення недоступний';$('#skyHero').innerHTML='<section class="sky-hero '+heroState+'"><span class="status-label">МОЄ МІСЦЕ · '+esc(info.title.toUpperCase())+'</span><h2 class="sky-status-big">'+heroTitle+'</h2><p class="sky-sub">'+esc(heroSub)+'</p><p class="micro" id="skyRaionLine"></p><div class="sky-meta"><span>'+upd+'</span></div><div class="sky-actions"><button class="primary sky-go" data-nav="mapView" type="button">До карти</button></div></section>';var top=pickTopThreat(scopeEvents,state.userPos);var reasonLabel={closing:'Наближається до вас',nearest:'Найближча до вас',latest:'Остання за часом'};$('#topThreat').innerHTML=top?('<p class="micro">'+(reasonLabel[top.reason]||'')+'</p>'+card(top.event)):'<div class="empty">Активних загроз для вашого місця не зафіксовано.</div>';$('#topThreat').querySelectorAll('[data-event]').forEach(function(el){el.onclick=function(){openDetail(state.snapshot.events.find(function(e){return e.id===el.dataset.event}))}});renderMyRaion();renderQuiet(region,alerts,events)}
function checkGuard(){if(!state.guard.enabled||!state.userPos)return;const now=Date.now(),hits=selectGuardTargets(flowEvents(),state.guard.radius);const fresh=hits.filter(h=>{const last=state.guardSeen.get(h.e.id);return last==null||now-last>5*60000});for(const id of[...state.guardSeen.keys()])if(!hits.some(h=>h.e.id===id))state.guardSeen.delete(id);if(!fresh.length)return;for(const h of fresh)state.guardSeen.set(h.e.id,now);playGuardTone();if(state.voice)sayGuard(fresh[0]);if(!$('#quietScreen').hidden)$('#quietScreen').hidden=true}
function guardLabel(e){return e.kind==='shahed'?'Шахед':(META[e.category]?.label||'Ціль')}
function sayGuard(h){let t=`Увага. ${guardLabel(h.e)}, ${fmtDist(h.distKm)} від вас`;if(Number.isFinite(Number(h.e.speed)))t+=`, швидкість ${Math.round(h.e.speed)} км/год`;if(h.closing&&h.etaMin!=null)t+=`, підліт ${fmtEta(h.etaMin)}`;speak(t)}
let guardToneCtx=null;function playGuardTone(){try{guardToneCtx=guardToneCtx||new(window.AudioContext||window.webkitAudioContext)();if(guardToneCtx.state==='suspended')guardToneCtx.resume();const t=guardToneCtx.currentTime;[0,.35,.7].forEach((o,i)=>{const osc=guardToneCtx.createOscillator(),g=guardToneCtx.createGain();osc.type='sine';osc.frequency.value=i===2?880:660;g.gain.setValueAtTime(.001,t+o);g.gain.exponentialRampToValueAtTime(.5,t+o+.02);g.gain.exponentialRampToValueAtTime(.001,t+o+.3);osc.connect(g).connect(guardToneCtx.destination);osc.start(t+o);osc.stop(t+o+.32)})}catch(e){}}
function playUrgentTone(){try{guardToneCtx=guardToneCtx||new(window.AudioContext||window.webkitAudioContext)();if(guardToneCtx.state==='suspended')guardToneCtx.resume();const t=guardToneCtx.currentTime;const seq=[880,880,1174,880,1174];seq.forEach((fq,i)=>{const o=i*.22,osc=guardToneCtx.createOscillator(),g=guardToneCtx.createGain();osc.type='square';osc.frequency.value=fq;g.gain.setValueAtTime(.001,t+o);g.gain.exponentialRampToValueAtTime(.4,t+o+.02);g.gain.exponentialRampToValueAtTime(.001,t+o+.16);osc.connect(g).connect(guardToneCtx.destination);osc.start(t+o);osc.stop(t+o+.18)})}catch(e){}}
function checkProximity(){if(!state.prox||!state.userPos)return;const now=Date.now();const sel=selectProximityAlerts(flowEvents(),state.proxSeen,now,10,120000);for(const id of[...state.proxSeen.keys()])if(!sel.hits.some(h=>h.id===id))state.proxSeen.delete(id);if(!sel.fresh.length)return;for(const h of sel.fresh)state.proxSeen.set(h.id,now);const top=sel.fresh.slice().sort((a,b)=>a._distKm-b._distKm)[0];playUrgentTone();if(!document.querySelector('#quietScreen').hidden)document.querySelector('#quietScreen').hidden=true;if(state.voice)speak('Увага! Ціль за '+fmtDist(top._distKm)+' від вас. Негайно пройдіть в укриття.')}
function guardDigest(){if(!state.userPos)return'';const hits=selectGuardTargets(flowEvents(),state.guard.enabled?state.guard.radius:50);if(!hits.length)return'';const h=hits[0];let t=`${guardLabel(h.e)} · ${fmtDist(h.distKm)} від вас`;if(h.closing&&h.etaMin!=null)t+=` · підліт ${fmtEta(h.etaMin)}`;return`<div class="guard-digest"><b>НАЙБЛИЖЧЕ</b> · ${esc(t)}</div>`}
function sortThreats(a,b){if(state.threatSort==='eta'&&state.userPos){const ae=a._etaMin??1e12,be=b._etaMin??1e12;if(ae!==be)return ae-be;const ad=a._distKm??1e12,bd=b._distKm??1e12;if(ad!==bd)return ad-bd}return(b.timestamp?.getTime()||0)-(a.timestamp?.getTime()||0)}
function setupGuard(){const g=$('#guardEnabled');if(!g)return;g.checked=state.guard.enabled;g.onchange=e=>{state.guard.enabled=e.target.checked;localStorage.setItem('nebo-guard-enabled',e.target.checked?'1':'0');if(e.target.checked){playGuardTone();if(!state.userPos)toastLoc('Вартового увімкнено. Натисніть «визначити місце», щоб він знав дистанцію.')}renderSky()};const r=$('#guardRadius'),out=$('#guardRadiusValue');r.value=state.guard.radius;out.textContent=`${state.guard.radius} км`;r.oninput=e=>{out.textContent=`${e.target.value} км`};r.onchange=e=>{state.guard.radius=Number(e.target.value)||30;localStorage.setItem('nebo-guard-radius',String(state.guard.radius))};const px=$('#proxEnabled');px.checked=state.prox;px.onchange=e=>{state.prox=e.target.checked;try{localStorage.setItem('nebo-prox-enabled',e.target.checked?'1':'0')}catch(err){}if(e.target.checked)playUrgentTone()};const v=$('#voiceEnabled');v.checked=state.voice;v.onchange=e=>{state.voice=e.target.checked;localStorage.setItem('nebo-voice-enabled',e.target.checked?'1':'0');if(e.target.checked)speak('Голос увімкнено.')};$('#voiceTest').onclick=()=>{if(!speak('Це перевірка голосу.'))toastLoc('Голос не підтримується цим браузером.')}}
function goHome(){mapUI.showHome(localStorage.getItem('nebo-region')||'')}
function locateAndCenter(){centerOnNextPos=true;locate()}
function setupRadarSearch(){const form=$('#radarSearchForm');if(!form)return;const input=$('#radarSearch'),box=$('#radarResults'),st=$('#radarSearchStatus');form.onsubmit=async e=>{e.preventDefault();const q=input.value.trim();if(q.length<2)return;st.textContent='Шукаємо…';box.replaceChildren();try{const m=await import('../../services/locations.js');const places=await m.searchUkrainianPlaces(q);st.textContent=places.length?('Знайдено: '+places.length):'Нічого не знайдено. Уточніть назву.';for(const p of places){const b=document.createElement('button');b.type='button';b.className='place-result';const nm=p.settlement||p.community||p.raion||p.oblast||'Місце';b.innerHTML='<b>'+esc(nm)+'</b><span>'+esc([p.raion,p.oblast].filter(Boolean).join(' · '))+'</span>';b.onclick=()=>{if(Number.isFinite(p.lat)&&Number.isFinite(p.lon)){radarUI.showPin(p.lat,p.lon,nm);state.radarPin={lat:p.lat,lon:p.lon,label:nm};box.replaceChildren();st.textContent='Радар наведено: '+nm}else st.textContent='У цього місця немає координат.'};box.append(b)}}catch(err){st.textContent='Пошук тимчасово недоступний.'}}}
function focusTiles(){try{if(!state.geo)return'';const names=state.geo.features.map(regionName),saved=localStorage.getItem('nebo-region')||'';if(!saved||!names.includes(saved))return'';const view=oblastRaions(state.snapshot,saved);return '<h3 class="subheading">Фокус: '+esc(saved)+'</h3><div class="qrtile-grid">'+view.rows.map(r=>'<button class="qrtile st-'+r.status+'" data-qrtile="'+esc(r.name)+'" data-oblast="'+esc(saved)+'">'+esc(r.name)+'</button>').join('')+'</div>'}catch(e){return''}}
function raionRow(r){const dot=r.status==='alert'?'dot-alert':r.status==='mon'?'dot-mon':'dot-calm';const meta=r.status==='alert'?('ТРИВОГА'+(r.alert&&r.alert.subtype?' · '+r.alert.subtype:'')):r.status==='mon'?('Моніторинг: '+r.monCount):'Спокійно';return '<button class="raion-row" data-raion="'+esc(r.name)+'"><i class="'+dot+'"></i><span><b>'+esc(r.name)+'</b><small>'+esc(meta)+'</small></span></button>'}
function renderRaions(){const box=document.querySelector('#raionList');if(!box||!state.geo)return;const names=state.geo.features.map(regionName);const saved=localStorage.getItem('nebo-region')||'';let html='';for(const oblast of names){const view=oblastRaions(state.snapshot,oblast);const nAlert=view.rows.filter(r=>r.status==='alert').length;const nMon=view.rows.filter(r=>r.status==='mon').length;const shouldOpen=nAlert>0||nMon>0||oblast===saved||state.raionOpen.has(oblast);const dot=nAlert?'dot-alert':nMon?'dot-mon':'dot-calm';const summary=nAlert?(nAlert+' тривоги'):nMon?(nMon+' мон.'):'спокійно';html+='<details class="oblast-details" data-oblast="'+esc(oblast)+'"'+(shouldOpen?' open':'')+'><summary><i class="'+dot+'"></i><b>'+esc(oblast)+'</b><small>'+esc(summary)+'</small></summary><div class="oblast-raions">'+view.rows.map(raionRow).join('')+'</div></details>'}box.innerHTML=focusTiles()+html||'<div class="empty">Немає даних.</div>';box.querySelectorAll('details[data-oblast]').forEach(d=>{d.ontoggle=()=>{const n=d.dataset.oblast;if(d.open)state.raionOpen.add(n);else state.raionOpen.delete(n);saveJSON('nebo-raion-open',[...state.raionOpen])}});box.querySelectorAll('[data-qrtile]').forEach(b=>b.onclick=()=>{const ob=b.dataset.oblast;const view=oblastRaions(state.snapshot,ob);openRaionDetail(view.rows.find(r=>r.name===b.dataset.qrtile),ob)});box.querySelectorAll('[data-raion]').forEach(b=>b.onclick=()=>{const det=b.closest('details');const oblast=det?det.dataset.oblast:'';const view=oblastRaions(state.snapshot,oblast);openRaionDetail(view.rows.find(r=>r.name===b.dataset.raion),oblast)})}
function openRaionDetail(r,oblast){if(!r)return;const st=r.status==='alert'?'ПОВІТРЯНА ТРИВОГА':r.status==='mon'?'Моніторинг':'Спокійно за поточними даними';let h='<span class="detail-type">РАЙОН · '+esc(oblast)+'</span><h2 class="detail-title">'+esc(r.name)+'</h2><div class="detail-grid">'+field('Статус',st);if(r.alert){h+=field('Сигнал з',clock(r.alert.timestamp))+field('Причина',r.alert.subtype||'Повітряна тривога')}if(r.monCount)h+=field('Моніторинг',r.monCount+' пов.'+(r.monSample.length?' · '+r.monSample.join(', '):''));h+='</div>';if(r.fromStream)h+='<div class="explain-box">Район з поточних даних; точної відповідності в довіднику не знайдено.</div>';else h+='<div class="explain-box">Відсутність повідомлень не означає відсутність небезпеки.</div>';h+='<button class="text-button" id="raionMap">Показати район на карті</button>';$('#detailContent').innerHTML=h;$('#detailSheet').showModal();$('#raionMap').onclick=()=>{$('#detailSheet').close();focusRaion(oblast,r.name)}}
function renderMyRaion(){try{var el=$('#skyRaionLine');if(!el)return;var p=JSON.parse(localStorage.getItem('nebo-location')||'null');if(!p||!p.raion||!p.oblast){el.textContent='';return}var dir=raionDirectory(p.oblast);if(!dir){el.textContent='';return}var view=oblastRaions(state.snapshot,p.oblast);var name=matchRaion(dir,p.raion);var row=name&&view.rows.find(function(r){return r.name===name});if(!row){el.textContent='';return}var t=row.status==='alert'?'тривога':row.status==='mon'?('моніторингові дані: '+row.monCount):('спокійно'+(view.rows.some(function(r){return r.status==='alert'})?', тривога в інших районах області':''));el.textContent='Ваш район ('+row.name+'): '+t+'.';}catch(e){}}
function toggleRaions(on){state.showRaions=on;try{localStorage.setItem('nebo-raions-layer',on?'1':'0')}catch(e){}if(!on){mapUI.toggle('raions',false);renderLayers();return}refreshRaionDots()}
async function refreshRaionDots(){try{const _n=Date.now();const _canFetch=!state._lastDotFetch||_n-state._lastDotFetch>60000;if(_canFetch)state._lastDotFetch=_n;const saved=state.raionOblast||localStorage.getItem('nebo-region')||'';const alertOblasts=[...new Set(state.snapshot.alerts.map(a=>matchGeoOblast(a.region)).filter(Boolean))];const oblasts=[...new Set([saved].concat(alertOblasts).filter(Boolean))].slice(0,6);if(!oblasts.length)return;const loc=await import('../../services/locations.js');const cache=loadCenterCache();let changed=false;const dots=[];let fetches=0;for(const oblast of oblasts){const view=oblastRaions(state.snapshot,oblast);for(const r of view.rows){if(r.status==='calm'&&!getCachedCenter(cache,oblast,r.name))continue;let c=getCachedCenter(cache,oblast,r.name);if(!c&&_canFetch&&fetches<6){try{const found=await loc.searchUkrainianPlaces(r.name+' район, '+oblast);fetches++;if(found.length&&Number.isFinite(found[0].lat)&&Number.isFinite(found[0].lon)){c={lat:found[0].lat,lon:found[0].lon,bbox:found[0].bbox||null,at:new Date().toISOString()};cache[oblast+'||'+r.name]=c;changed=true}}catch(e){}}if(c)dots.push({lat:c.lat,lon:c.lon,status:r.status,name:r.name,oblast:oblast});if(dots.length>=40)break}if(dots.length>=40)break}if(changed)saveCenterCache(cache);state.raionDots=dots.slice(0,40);if(state.raionDots.some(d=>d.status==='alert')&&!state.showRaions){state.showRaions=true;try{localStorage.setItem('nebo-raions-layer','1')}catch(e){}}mapUI.setRaionDots(state.raionDots,rr=>{const ob=rr.oblast||saved;const view=oblastRaions(state.snapshot,ob);openRaionDetail(view.rows.find(x=>x.name===rr.name),ob)});mapUI.toggle('raions',state.showRaions&&state.raionDots.length>0)}catch(e){}}
function toggleRaionShapes(on){state.showShapes=on;try{localStorage.setItem('nebo-shapes-layer',on?'1':'0')}catch(e){}if(!on){mapUI.toggle('shapes',false);renderLayers();return}colorizeRaionShapes(true)}
async function colorizeRaionShapes(fetchMissing){
    try{
      const oblast=state.raionOblast||localStorage.getItem('nebo-region')||'';
      if(!oblast)return;
      let geoms=state.raionShapes&&state.raionShapes.oblast===oblast?state.raionShapes.geoms:null;
      if(!geoms&&fetchMissing){
        try{
          geoms=await getOblastRaionPolygons(oblast);
          state.raionShapes={oblast:oblast,geoms:geoms};
        }catch(e){
          console.warn('[raionShapesLocal] failed to load', oblast, e);
          state.showShapes=false;
          mapUI.toggle('shapes',false);
          renderLayers();
          return;
        }
      }
      if(!geoms)return;
      const view=oblastRaions(state.snapshot,oblast);
      const dir=raionDirectory(oblast)||[];
      const items=[];
      for(const g of geoms){
        const hit=matchRaion(dir,g.name);
        const row=hit&&view.rows.find(r=>r.name===hit);
        items.push({rings:g.rings,status:row?row.status:'calm'});
      }
      mapUI.setRaionShapes(items);
      mapUI.toggle('shapes',true);
    }catch(e){ console.warn('[colorizeRaionShapes]', e); }
  }
function setupScope(){const mb=document.querySelector('#radarMode');if(mb)mb.querySelectorAll('[data-mode]').forEach(b=>{if(b.dataset.mode===state.radarMode)b.classList.add('active');else b.classList.remove('active');b.onclick=()=>{state.radarMode=b.dataset.mode;try{localStorage.setItem('nebo-radar-mode',state.radarMode)}catch(e){}mb.querySelectorAll('[data-mode]').forEach(x=>x.classList.toggle('active',x===b));applyRadarMode()}});const rb=document.querySelector('#radarRange');if(rb)rb.querySelectorAll('[data-range]').forEach(b=>{if(Number(b.dataset.range)===state.radarRange)b.classList.add('active');else b.classList.remove('active');b.onclick=()=>{state.radarRangeManual=true;state.radarRange=Number(b.dataset.range)||100;try{localStorage.setItem('nebo-radar-range',String(state.radarRange))}catch(e){}rb.querySelectorAll('[data-range]').forEach(x=>x.classList.toggle('active',x===b));renderRadar()}});const cv=document.querySelector('#scopeCanvas');if(cv){cv.addEventListener('click',ev=>{const r=cv.getBoundingClientRect();const hit=scopeUI.pick(ev.clientX-r.left,ev.clientY-r.top);if(hit)openDetail(hit)});cv.addEventListener('pointermove',ev=>{const r=cv.getBoundingClientRect();const t=scopeUI.readout(ev.clientX-r.left,ev.clientY-r.top);document.querySelector('#scopeReadout').textContent=t||'—'});cv.addEventListener('pointerleave',()=>{document.querySelector('#scopeReadout').textContent='—'})}const rg=document.querySelector('#radarGps');if(rg)rg.onclick=()=>{const ro=document.querySelector('#scopeReadout');if(!navigator.geolocation){if(ro)ro.textContent='GPS не підтримується цим браузером.';return}if(state.userPos){renderRadar();if(ro){ro.textContent='Радар наведено на вас.';setTimeout(()=>{const r2=document.querySelector('#scopeReadout');if(r2)r2.textContent='—'},2500)}return}if(ro)ro.textContent='Визначаємо положення…';locateAndCenter()};applyRadarMode()}
function applyRadarMode(){const st=document.querySelector('.radar-stage');if(st)st.classList.toggle('mode-map',state.radarMode==='map');scopeUI.setActive(state.radarMode==='scope'&&!document.hidden&&!document.querySelector('#radarView').hidden);if(state.radarMode==='map')setTimeout(()=>radarUI.map.invalidateSize(),60)}
function matchGeoOblast(region){if(!state.geo||!region)return null;const f=state.geo.features.find(x=>normOblast(regionName(x))===normOblast(region));return f?regionName(f):null}
async function ensureAlertShapes(){
    try{
      const now=Date.now();
      state._shapeFail=state._shapeFail||{};
      const alertOblasts=[...new Set(state.snapshot.alerts.map(a=>matchGeoOblast(a.region)).filter(Boolean))];
      // Also load geoms for oblasts that only have monitoring fills (no official alerts).
      let fillOblasts=[];
      try{
        const { fills }=territorialDanger(state.snapshot.alerts,state.snapshot.events);
        fillOblasts=[...new Set(fills.map(f=>matchGeoOblast(f.oblast)).filter(Boolean))];
      }catch(e){}
      const oblasts=[...new Set([...alertOblasts,...fillOblasts])];
      state._shapeQueue=oblasts.filter(o=>!(state.rshapes&&state.rshapes[o])&&!(state._shapeFail[o]&&now-state._shapeFail[o]<300000));
      if(!state._shapeBusy&&state._shapeQueue.length&&(!state._shapeTry||now-state._shapeTry>120000)){
        state._shapeTry=now;
        state._shapeBusy=true;
        try{
          // Local GeoJSON is cheap (no Overpass): load everything on the
          // first run so raion polygons appear immediately; throttle only
          // later refreshes.
          const first=!state._shapePrimed;
          const batch=first?state._shapeQueue:state._shapeQueue.slice(0,2);
          for(const ob of batch){
            try{
              const geoms=await getOblastRaionPolygons(ob);
              state.rshapes=Object.assign({},state.rshapes,{[ob]:geoms});
              delete state._shapeFail[ob];
            }catch(e){
              state._shapeFail[ob]=Date.now();
            }
          }
          state._shapePrimed=true;
        }finally{
          state._shapeBusy=false;
        }
      }
      drawAlertShapes();
    }catch(e){}
  }
function drawAlertShapes(){
  try{
    if(!state.geo)return;
    // Raion fills from scope-driven territorial danger (alerts + monitoring).
    // Each fill resolves to its OWN raion polygon. A district with no polygon
    // warns and is skipped — it NEVER falls back to painting the oblast.
    const { fills }=territorialDanger(state.snapshot.alerts,state.snapshot.events);
    state._warnedRaion=state._warnedRaion||new Set();
    const items=[];
    for(const ob of Object.keys(state.rshapes||{})){
      const geoms=state.rshapes[ob];
      if(!Array.isArray(geoms))continue;
      const obFills=fills.filter(f=>normOblast(f.oblast)===normOblast(ob));
      for(const f of obFills){
        const g=geoms.find(g=>raionMatches(g.name,f.district));
        if(!g||!g.polys||!g.polys.length){
          const k=ob+'||'+f.district;
          if(!state._warnedRaion.has(k)){state._warnedRaion.add(k);console.warn('[raion-polygon-not-found]',ob,f.district);}
          continue;
        }
        items.push({polys:g.polys,oblast:ob,name:f.district,level:f.level});
      }
    }
    state.raionFillItems=items;
    mapUI.setAlertShapes(items,(it)=>{const view=oblastRaions(state.snapshot,it.oblast);openRaionDetail(view.rows.find(r=>r.name===it.name)||{name:it.name,status:'alert',alert:null,monCount:0,monSample:[],fromStream:true},it.oblast)});
  }catch(e){}
}
async function focusRaion(oblast,name){try{showView('mapView');let c=getCachedCenter(loadCenterCache(),oblast,name);if(!c||!c.bbox){try{const loc=await import('../../services/locations.js');const found=await loc.searchUkrainianPlaces(name+' район, '+oblast);if(found.length&&Number.isFinite(found[0].lat)&&Number.isFinite(found[0].lon)){c={lat:found[0].lat,lon:found[0].lon,bbox:found[0].bbox||null,at:new Date().toISOString()};const cc=loadCenterCache();cc[oblast+'||'+name]=c;saveCenterCache(cc)}}catch(e){}}if(c&&c.bbox&&c.bbox.length===4){const s=+c.bbox[0],n=+c.bbox[1],w=+c.bbox[2],e=+c.bbox[3];if([s,n,w,e].every(Number.isFinite)&&s<n&&w<e){setTimeout(()=>mapUI.map.fitBounds([[s,w],[n,e]],{padding:[16,16]}),80);return}}if(c)setTimeout(()=>mapUI.map.setView([c.lat,c.lon],9),80)}catch(e){}}
function setupDebug(){let ls=false;try{ls=localStorage.getItem('debug')==='1'||localStorage.getItem('nebo-debug')==='1'}catch(e){}
  // The green engineering overlay exists ONLY with an explicit opt-in:
  // ?debug=1 or localStorage.debug=true. Never in normal production UI.
  const DEV=location.search.indexOf('debug')>=0||location.hash==='#debug'||ls;if(!DEV)return;window.addEventListener('error',e=>{state._err=String((e&&e.message)||'err').slice(0,140)});const box=document.createElement('div');box.id='debugBox';document.body.append(box);setInterval(()=>{try{const cv=document.querySelector('#scopeCanvas');const r=cv?cv.getBoundingClientRect():null;let dbg='';try{const snap=state.snapshot;const raionAlerts=(snap.alerts||[]).filter(a=>a.district);const oblastAlerts=(snap.alerts||[]).length-raionAlerts.length;let matched=0,unmatched=0;try{const{fills}=territorialDanger(snap.alerts,snap.events);const geomsByOb={};for(const ob of Object.keys(state.rshapes||{}))geomsByOb[normOblast(ob)]=(state.rshapes[ob]||[]);for(const f of fills){const gs=geomsByOb[normOblast(f.oblast)]||[];if(gs.some(g=>raionMatches(g.name,f.district)))matched++;else unmatched++}}catch(e2){}const st=flowStats(snap.events);const markers=document.querySelectorAll('.threat-marker').length;const clusters=document.querySelectorAll('.threat-cluster').length;dbg=` | raw alerts:${snap.alerts.length} oblast-scope:${oblastAlerts} matched:${matched} unmatched:${unmatched} | raw events:${snap.events.length} coordinate:${st.exactTotal} markers:${markers} clusters:${clusters} | shahed:${st.byKind.shahed} uav:${st.byKind.uav} kab:${st.byKind.kab} missile:${st.byKind.missile} ballistic:${st.byKind.ballistic}`}catch(e3){dbg=' | dbg:n/a'}try{const _h=state.snapshot.health||{},_age=k=>{const u=_h[k]?.updatedAt;return u?Math.max(0,Math.round((Date.now()-new Date(u).getTime())/1000))+'s':'—'};const _srv=state.snapshot.receivedAt?Math.max(0,Math.round((Date.now()-new Date(state.snapshot.receivedAt).getTime())/1000))+'s':'—';dbg+=' | src age OFF:'+_age('OFFICIAL')+' NEP:'+_age('NEPTUN')+' MAPA:'+_age('MAPA')+' | TOTAL:'+_srv;}catch(e4){}box.textContent='ev:'+state.snapshot.events.length+' al:'+state.snapshot.alerts.length+' geo:'+(state.geo?state.geo.features.length:0)+' mode:'+state.radarMode+' range:'+state.radarRange+' canvas:'+(r?Math.round(r.width)+'x'+Math.round(r.height):'none')+' err:'+(state._err||'none')+dbg}catch(e){}},1500)}
function renderRadar(){const region=localStorage.getItem('nebo-region'),f=state.geo?.features.find(x=>regionName(x)===region),center=state.userPos?[state.userPos.lat,state.userPos.lon]:(f?centerOf(f):[49,31]);state._radarCenter=center;radarUI.setBorders(state.geo,state.snapshot.alerts);radarUI.setAlertFills(state.raionFillItems);const guardKm=state.guard.enabled&&state.userPos?state.guard.radius:null;let _minD=null;for(const _e of flowEvents()){if(_e.lat==null||_e.lon==null)continue;const _d=distKm(center[0],center[1],_e.lat,_e.lon);if(_minD==null||_d<_minD)_minD=_d}if(!state.radarRangeManual&&_minD!=null){const _fit=_minD<=1?1:_minD<=3?3:_minD<=5?5:_minD<=10?10:_minD<=25?25:100;if(_fit!==state.radarRange){state.radarRange=_fit;try{localStorage.setItem('nebo-radar-range',String(_fit))}catch(e){}const _rb=document.querySelector('#radarRange');if(_rb)_rb.querySelectorAll('[data-range]').forEach(x=>x.classList.toggle('active',Number(x.dataset.range)===_fit))}}scopeUI.update(flowEvents(),center,{range:state.radarRange,guardKm:guardKm,pin:state.radarPin,geo:null,raionFills:[],alertRegions:[],geoSig:'pure:'+state.radarRange});if(state.radarMode==='map'){radarUI.render(flowEvents(),center,{guardKm:guardKm,range:state.radarRange});radarUI.setSatellite(state.satelliteOn);radarUI.renderUser(state.userPos);try{const _rl=document.querySelector('.range-labels');if(_rl)_rl.innerHTML=rangeRings(state.radarRange).map(km=>`<span>${km} км</span>`).join('')}catch(e){}}renderRadarNearest(center);renderRadarHud(center);renderRadarPanels(center);}
function renderRadarNearest(center){
  // Nearest-target readout lives BELOW the scope, never as center text.
  const box=document.querySelector('#radarNearest');
  if(!box) return;
  let best=null,bd=null;
  for(const e of flowEvents()){
    if(e.lat==null||e.lon==null) continue;
    const d=distKm(center[0],center[1],e.lat,e.lon);
    if(bd==null||d<bd){bd=d;best=e;}
  }
  if(best==null||bd==null){ box.innerHTML=''; box.hidden=true; return; }
  box.hidden=false;
  const v=getThreatVisual(best);
  if(bd<=state.radarRange){
    box.innerHTML=`<span class="rn-dot" style="--c:${v.color}"></span><span>Найближча ціль · ${esc(fmtDist(bd))} · ${esc(v.label)}</span>`;
  }else{
    const fit=[1,3,5,10,25,100].find(r=>r>=bd)||100;
    box.innerHTML=`<span class="rn-dot" style="--c:${v.color}"></span><span>Найближча відома ціль · ${esc(fmtDist(bd))} · ${esc(v.label)}</span>`
      + (fit>state.radarRange?`<button type="button" class="rn-more" data-range="${fit}">Показати ${fit} км</button>`:'');
    const btn=box.querySelector('.rn-more');
    if(btn) btn.onclick=()=>{
      state.radarRangeManual=true;state.radarRange=Number(btn.dataset.range)||100;
      try{localStorage.setItem('nebo-radar-range',String(state.radarRange))}catch(e){}
      document.querySelectorAll('#radarRange [data-range]').forEach(x=>x.classList.toggle('active',Number(x.dataset.range)===state.radarRange));
      renderRadar();
    };
  }
}
function renderRadarHud(center){
  // Compact scope HUD: RADAR · RANGE KM · center name + in-range target count.
  try{
    const mode=document.querySelector('#radarHudMode');
    if(mode) mode.textContent=`RADAR · ${state.radarRange} KM`;
    const cc=document.querySelector('#radarHudCenter');
    if(cc) cc.textContent=radarCenterName(center);
    const cnt=document.querySelector('#radarHudCount');
    if(cnt){
      let n=0;
      for(const e of flowEvents()){
        if(e.lat==null||e.lon==null) continue;
        if(distKm(center[0],center[1],e.lat,e.lon)<=state.radarRange) n++;
      }
      cnt.textContent=`${n} ${pluralUa(n,'ЦІЛЬ','ЦІЛІ','ЦІЛЕЙ')}`;
    }
    try{const rs=$('#hdrRadarSub');if(rs)rs.textContent=`${state.radarRange} км`;}catch(e){}
  }catch(e){}
}
function pluralUa(n,one,few,many){
  const m=Math.abs(Number(n))||0,r10=m%10,r100=m%100;
  if(r10===1&&r100!==11) return one;
  if(r10>=2&&r10<=4&&(r100<12||r100>14)) return few;
  return many;
}
function radarCenterName(center){
  // GPS > selected home point > saved region > Ukraine fallback.
  try{
    if(state.userPos&&center&&Math.abs(center[0]-state.userPos.lat)<1e-6&&Math.abs(center[1]-state.userPos.lon)<1e-6) return 'GPS';
    const p=JSON.parse(localStorage.getItem('nebo-location')||'null');
    if(p&&(p.settlement||p.community)) return String(p.settlement||p.community).toUpperCase().slice(0,18);
    const r=localStorage.getItem('nebo-region');
    if(r) return String(r).replace(/ область$/,'').toUpperCase().slice(0,18);
  }catch(e){}
  return 'УКРАЇНА';
}
function renderMapRecent(){
  // Reference "ОСТАННІ ПОДІЇ": latest 5 real events with kind icon + time.
  try{
    const box=$('#mapRecent');if(!box)return;
    const items=flowEvents().filter(e=>e.timestamp).sort((a,b)=>b.timestamp-a.timestamp).slice(0,5);
    if(!items.length){box.innerHTML='<p class="micro">Поки тихо — події з’являться тут.</p>';return;}
    box.innerHTML=items.map(ev=>{
      const v=getThreatVisual(ev);
      const loc=ev.settlement||ev.district||ev.region||ev.derivedRegion||'';
      return `<button type="button" class="recent-row" data-event="${esc(ev.id)}">`
        +`<svg aria-hidden="true" style="color:${v.color}"><use href="./assets/brand/threat-icons.svg#${v.icon}"/></svg>`
        +`<span><b>${esc(describeThreat(ev))}</b><small>${esc(loc)}</small></span><time>${clock(ev.timestamp,true)}</time></button>`;
    }).join('');
    box.querySelectorAll('[data-event]').forEach(el=>{el.onclick=()=>{const ev=(state.snapshot.events||[]).find(e=>e.id===el.dataset.event);if(ev)openDetail(ev);};});
  }catch(e){}
}
function renderRadarPanels(center){
  // Left rail: in-range counts per kind. Right rail: nearest list + selection.
  try{
    const title=$('#radarInTitle');
    if(title)title.textContent=`У радіусі ${state.radarRange} км`;
    const cats=$('#radarInCats');
    if(cats){
      const counts={};
      for(const e of flowEvents()){if(e.lat==null||e.lon==null)continue;if(distKm(center[0],center[1],e.lat,e.lon)>state.radarRange)continue;const k=classifyThreat(e);counts[k]=(counts[k]||0)+1;}
      const order=[['uav','БПЛА'],['missile','РАКЕТИ'],['ballistic','БАЛІСТИКА'],['kab','КАБ'],['aviation','АВІАЦІЯ'],['recon','РОЗВІДКА'],['shahed','ШАХЕД']];
      cats.innerHTML=order.filter(([k])=>(counts[k]||0)>0||['uav','missile','kab','aviation'].includes(k)).slice(0,6).map(([k,label])=>{
        const v=getThreatVisual(k);
        return `<div class="in-row"><svg aria-hidden="true" style="color:${v.color}"><use href="./assets/brand/threat-icons.svg#${v.icon}"/></svg><b>${counts[k]||0}</b><span>${k==='missile'?'ракет':k==='aviation'?'авіації':label.toLowerCase()}</span></div>`;
      }).join('')||'<p class="micro">Порожньо</p>';
    }
    const list=$('#radarNearList');
    if(list){
      const rows=flowEvents().filter(e=>e.lat!=null&&e.lon!=null).map(e=>({e,d:distKm(center[0],center[1],e.lat,e.lon)})).filter(x=>x.d<=state.radarRange*3).sort((a,b)=>a.d-b.d).slice(0,4);
      const inRange=rows.filter(x=>x.d<=state.radarRange).length;
      document.querySelector('#radarNearTitle').textContent=inRange>0?`НАЙБЛИЖЧІ ЦІЛІ (${state.radarRange} КМ)`:(rows.length?'НАЙБЛИЖЧІ ПОЗА РАДІУСОМ':`НАЙБЛИЖЧІ ЦІЛІ (${state.radarRange} КМ)`);
      list.innerHTML=rows.length?rows.map(({e,d})=>{
        const v=getThreatVisual(e);
        const brg=Math.round(bearingDeg(center[0],center[1],e.lat,e.lon));
        return `<button type="button" class="near-row" data-event="${esc(e.id)}"><svg aria-hidden="true" style="color:${v.color}"><use href="./assets/brand/threat-icons.svg#${v.icon}"/></svg><span><b>${esc(describeThreat(e))}</b><small>${fmtDist(d)} · ${brg}°</small></span><time>${clock(e.timestamp,true)}</time></button>`;
      }).join(''):'<p class="micro">Поруч цілей не зафіксовано.</p>';
      list.querySelectorAll('[data-event]').forEach(el=>{el.onclick=()=>{const ev=(state.snapshot.events||[]).find(e=>e.id===el.dataset.event);if(ev)openDetail(ev);};});
    }
    renderRadarSelected();
  }catch(e){}
}
function describeThreat(e){
  const v=getThreatVisual(e);
  if(v.kind==='shahed')return 'Шахед';
  if(v.kind==='missile')return 'Крилата ракета';
  if(v.kind==='ballistic')return 'Балістична ракета';
  if(v.kind==='kab')return 'КАБ';
  if(v.kind==='aviation')return 'Авіація';
  if(v.kind==='recon')return 'Розвідка';
  if(e.subtype)return String(e.subtype).slice(0,26);
  return v.label;
}
function renderRadarSelected(){
  try{
    const box=$('#radarSelected');if(!box)return;
    const ev=(state.snapshot.events||[]).find(e=>e.id===state.selectedId);
    if(!ev){box.innerHTML='<p class="micro">Торкніться цілі на радарі, щоб побачити деталі.</p>';return;}
    const v=getThreatVisual(ev);
    const c=state._radarCenter||[49,31];
    const d=(ev.lat!=null&&ev.lon!=null)?distKm(c[0],c[1],ev.lat,ev.lon):null;
    const brg=(d!=null)?Math.round(bearingDeg(c[0],c[1],ev.lat,ev.lon)):null;
    box.innerHTML=`<div class="sel-head"><svg aria-hidden="true" style="color:${v.color}"><use href="./assets/brand/threat-icons.svg#${v.icon}"/></svg><b>${esc(describeThreat(ev))}</b><button type="button" class="sel-close" aria-label="Закрити">×</button></div>`
      +`<div class="sel-grid">`
      +(d!=null?`<span>Відстань:</span><b>${esc(fmtDist(d))}</b>`:'')
      +(brg!=null?`<span>Напрямок:</span><b>${brg}°</b>`:'')
      +(ev.speed!=null?`<span>Швидкість:</span><b>${Math.round(ev.speed)} км/год</b>`:'')
      +`<span>Оновлено:</span><b>${esc(clock(ev.timestamp))}${ev.timestamp?` (${esc(fresh(ev.timestamp))})`:''}</b>`
      +(ev.uncertaintyKm!=null?`<span>Точність:</span><b>±${ev.uncertaintyKm} км</b>`:'')
      +`</div>`;
    const x=box.querySelector('.sel-close');if(x)x.onclick=()=>{try{state.selectedId=null;}catch(e){}renderRadarSelected();};
  }catch(e){}
}
function renderTimeline(){const items=state.timeline.slice(0,12);$('#timeline').innerHTML=items.length?items.map(x=>`<div class="timeline-item"><time>${clock(x.at,true)}</time><i></i><p>${esc(x.text)}${x.count>1?` <b>×${x.count}</b>`:''}<br><small>${esc(x.source)}</small></p></div>`).join(''):'<div class="empty">Зміни з’являться після наступного реального оновлення.</div>'}
function renderRail(){const box=$('#railChanges');if(!box)return;const ten=state.timeline.filter(x=>Date.now()-x.at<10*60000),n=ten.filter(x=>x.text.startsWith('Нове')).reduce((sum,x)=>sum+(x.count||1),0),end=ten.filter(x=>x.text.includes('більше не')).reduce((sum,x)=>sum+(x.count||1),0);box.innerHTML=`<p><b>+${n}</b> нових моніторингових повідомлень</p><p><b>−${end}</b> подій більше не активні</p>`}
function renderHistory(){const box=$('#historyScale');if(!box)return;const max=Math.max(1,...state.history.map(x=>x.events));box.innerHTML=state.history.map(x=>`<div class="history-bar" style="height:${18+Math.round(x.events/max*52)}px" title="${x.events} повідомлень"><span>${clock(x.at,true)}</span></div>`).join('')}
function openDetail(e){if(!e)return;
  // Preserve selection across Map ↔ Radar switches (TZ §32).
  try{ state.selectedId = e.id || null; }catch(err){}
  try{ renderRadarSelected(); }catch(err2){}
  const d=$('#detailSheet');if(e.official){$('#detailContent').innerHTML=`<span class="detail-type">ОФІЦІЙНИЙ СТАТУС</span><h2 class="detail-title">${e.status==='active'?'Повітряна тривога':'Поточний статус'}</h2><p>${e.status==='active'?'Активний офіційний сигнал тривоги.':'Активний сигнал повітряної тривоги не зафіксований у поточних даних.'}</p><div class="explain-box">Регіон: ${esc(e.region)}<br>Джерело: ${esc(e.source)}<br>Моніторингові дані не скасовують офіційний сигнал.${e.status==='active'?(e.partial&&e.raions&&e.raions.length?'<br>Сигнал лише в районах: '+e.raions.map(esc).join(', '):'<br>Сигнал по всій області.') : ''}</div><button class="text-button" id="makeMyRegion">Зробити моїм регіоном</button>`}else{const m=META[e.category]||META.other,srcs=[...new Set((e.correlated||[e]).map(x=>x.source))];$('#detailContent').innerHTML=`<span class="detail-type">${e.advisory?'ІНФОРМАЦІЙНЕ МОНІТОРИНГОВЕ ПОВІДОМЛЕННЯ':'МОНІТОРИНГОВЕ ПОВІДОМЛЕННЯ'}</span><h2 class="detail-title">${esc(e.kind==='shahed'&&!/shahed|шахед/i.test(e.subtype||'')?'Шахед · '+(e.subtype||m.label):(e.subtype||m.label))}</h2><div class="detail-grid">${field('Останнє оновлення',clock(e.timestamp))}${field('Свіжість',fresh(e.timestamp))}${e.latencyMs!=null?field('Затримка',e.latencyMs<1000?e.latencyMs+' мс':(e.latencyMs/1000).toFixed(1).replace('.',',')+' с'):''}${e.receivedAt?field('Отримано',clock(e.receivedAt)):''}${field('Місце',e.region||e.derivedRegion||e.settlement||'Не вказано')}${field('Позиція',e.areaOnly?'Тільки область':positionLabel(e.positionQuality))}${e.speed!=null?field('Швидкість',Math.round(e.speed)+' км/год'):''}${field('Напрямок',e.heading!=null?`${Math.round(e.heading)}° · ${compass(e.heading)}`:'Не передано')}${state.userPos&&e._distKm!=null?field('Відстань до вас',fmtDist(e._distKm)+(e._closing&&e._etaMin!=null?` · підліт ${fmtEta(e._etaMin)}`:e._closing?' · наближається':'')):''}${field('Невизначеність',e.uncertaintyKm!=null?`±${e.uncertaintyKm} км`:'Не передано')}${field('Оцінка джерела',e.confidence?.toUpperCase()||'Не передано')}${field('Агрегованих повідомлень',e.sourceCount??'Не передано')}${field('Напрямок за даними source',e.destination||'Не передано')}${field('Схожі повідомлення',srcs.length>1?`${srcs.length} джерела`:'Не знайдено')}${e.fusedCount>1?field('Зведено в контакт',`${e.fusedCount} повідомлень у радіусі 18 км`):''}</div><h3>Джерела</h3><p>${srcs.map(esc).join(' · ')}</p><div class="explain-box"><b>Чому це показано?</b><br>Тип: ${esc(m.label)}. Статус: monitoring. Подію отримано безпосередньо з ${esc(e.source)}. ${e.areaOnly?'Точкова позиція не показується, бо джерело передало лише область.':`Якість позиції: ${esc(positionLabel(e.positionQuality))}.`} ${srcs.length>1?'Знайдено схоже повідомлення в іншому джерелі; це не доводить, що йдеться про той самий фізичний об’єкт.':''}</div><p class="micro">Координати, напрямок та інші monitoring дані можуть бути приблизними. НЕБО UA не прогнозує майбутній маршрут чи ціль.</p>`}d.showModal();const mr=$('#makeMyRegion');if(mr)mr.onclick=()=>{if(e.region)setRegion(e.region);d.close()}}
function renderQuiet(region,alerts,events){$('#quietClock').textContent=clock(new Date(),false);$('#quietRegion').textContent=region||'Регіон не обрано';$('#quietOfficial').innerHTML=`<div class="quiet-status">${alerts.length?'🔴 ПОВІТРЯНА ТРИВОГА':'Офіційний сигнал не зафіксований у поточних даних'}</div>`;$('#quietMonitoring').innerHTML=`<div class="quiet-monitor">Моніторингових даних: ${events.length}</div>`;$('#quietUpdated').textContent=state.lastSuccess?'Оновлено '+clock(state.lastSuccess):'Немає оновлення'}
function setupRail(){
  const btn=$('#railToggle'),rail=$('#desktopRail'),view=$('#mapView');
  if(!btn||!rail||!view) return;
  const wide=()=>window.matchMedia('(min-width:1100px)').matches;
  let collapsed;
  try{ collapsed=localStorage.getItem('nebo-rail'); }catch(e){ collapsed=null; }
  const apply=(isCollapsed)=>{
    view.classList.toggle('rail-collapsed',isCollapsed);
    rail.classList.remove('rail-open');
    btn.setAttribute('aria-expanded',String(!isCollapsed));
    setTimeout(()=>{ try{mapUI.map.invalidateSize(true);}catch(e){} },80);
  };
  // Default: floating panel stays closed — the map owns the full width.
  if(collapsed==null) collapsed='1';
  apply(collapsed==='1');
  btn.onclick=()=>{
    if(!wide()){ // mobile: bottom sheet over the map
      const open=rail.classList.toggle('rail-open');
      btn.setAttribute('aria-expanded',String(open));
      return;
    }
    const isCollapsed=!view.classList.contains('rail-collapsed');
    try{localStorage.setItem('nebo-rail',isCollapsed?'1':'0')}catch(e){}
    apply(isCollapsed);
  };
}
function setup(){document.addEventListener('click',e=>{const nav=e.target.closest('[data-nav]');if(nav)showView(nav.dataset.nav)});$('#layerButton').onclick=()=>{const p=$('#layerPanel');p.hidden=!p.hidden;$('#layerButton').setAttribute('aria-expanded',String(!p.hidden))};
  setupRail();$('#refreshButton').onclick=load;$('#regionSelect').onchange=e=>{const f=state.geo?.features[Number(e.target.value)];setRegion(f?regionName(f):'')};$('#locateButton').onclick=locate;const hb=$('#homeButton');if(hb)hb.onclick=()=>mapUI.showHome(localStorage.getItem('nebo-region')||'');const gb=$('#gpsButton');if(gb)gb.onclick=()=>locateAndCenter();const _hh=$('#hdrHome');if(_hh)_hh.onclick=()=>{showView('mapView');mapUI.showHome(localStorage.getItem('nebo-region')||'')};const _zi=$('#zoomIn');if(_zi)_zi.onclick=()=>{try{mapUI.map.zoomIn()}catch(e){}};const _zo=$('#zoomOut');if(_zo)_zo.onclick=()=>{try{mapUI.map.zoomOut()}catch(e){}};const _ml=$('#myLocBtn');if(_ml)_ml.onclick=()=>locateAndCenter();$('#quietButton').onclick=()=>{$('#quietScreen').hidden=false;renderSky()};$('#exitQuiet').onclick=()=>$('#quietScreen').hidden=true;$('#settingsButton').onclick=()=>{$('#settingsDialog').showModal();renderAudioSettings()};$$('.sheet-close').forEach(b=>b.onclick=()=>b.closest('dialog').close());$('#autoRefresh').checked=localStorage.getItem('nebo-auto')!=='false';$('#autoRefresh').onchange=e=>localStorage.setItem('nebo-auto',e.target.checked);$('#reduceMotion').checked=localStorage.getItem('nebo-motion')==='reduce';$('#reduceMotion').onchange=e=>{localStorage.setItem('nebo-motion',e.target.checked?'reduce':'normal');document.body.classList.toggle('reduce-motion',e.target.checked)};document.body.classList.toggle('reduce-motion',$('#reduceMotion').checked);setupAudioSettings();mountAdSlots();setupOverlays();setupGuard();setupRadarSearch();setupScope();setupDebug();$('#startButton').onclick=()=>{localStorage.setItem('nebo-onboarded','1');$('#onboarding').close();showView('skyView')};if(!localStorage.getItem('nebo-onboarded'))$('#onboarding').showModal();addEventListener('online',load);addEventListener('offline',renderGlobal);try{clearInterval(refreshTimer);let _lastPoll=Date.now();refreshTimer=setInterval(()=>{try{if(!shouldPoll({hidden:document.hidden,autoRefresh:$('#autoRefresh')?.checked!==false,loading:state.loading,lastStart:_lastPoll,nowMs:Date.now(),intervalMs:POLL_MS}))return;_lastPoll=Date.now();load();}catch(e){}},POLL_MS);}catch(e){}document.addEventListener('visibilitychange',()=>{if(!document.hidden&&$('#autoRefresh').checked&&Date.now()-(state.lastSuccess?.getTime()||0)>30000)load()});addEventListener('nebo:position',e=>{if(e.detail&&Number.isFinite(e.detail.latitude))applyPosition(e.detail)});setInterval(()=>{renderGlobal();renderSky();const hasActive=state.snapshot.events.length>0;const interval=hasActive?7000:30000;if($('#autoRefresh').checked&&Date.now()-(state.lastSuccess?.getTime()||0)>interval)load()},5000);setInterval(()=>{if(!$('#quietScreen').hidden)$('#quietClock').textContent=clock(new Date(),false)},1000)}
function setRegion(region,{preservePlace=false}={}){if(region)localStorage.setItem('nebo-region',region);else localStorage.removeItem('nebo-region');if(!preservePlace){localStorage.removeItem('nebo-location');dispatchEvent(new CustomEvent('nebo:place-changed'))}audio.prime(state.snapshot,region);renderSky();renderRadar();dispatchEvent(new CustomEvent('nebo:push-sync'));if(region&&!localStorage.getItem('nebo-audio-prompted'))$('#audioPrompt').showModal()}
function setupAudioSettings(){const ids={officialStart:'audioOfficialStart',officialEnd:'audioOfficialEnd',uav:'audioUav',missile:'audioMissile',kab:'audioKab',aviation:'audioAviation'};for(const[type,id]of Object.entries(ids))$('#'+id).onchange=e=>audio.save({[type]:e.target.checked});$('#audioEnabled').onchange=async e=>{if(e.target.checked){try{await audio.enable()}catch{audio.save({enabled:false});e.target.checked=false}}else audio.save({enabled:false})};$('#audioVolume').oninput=e=>{audio.save({volume:Number(e.target.value)/100});$('#audioVolumeValue').textContent=`${e.target.value}%`};$('#quietHoursEnabled').onchange=e=>audio.save({quietHoursEnabled:e.target.checked});$('#quietStart').onchange=e=>audio.save({quietStart:e.target.value});$('#quietEnd').onchange=e=>audio.save({quietEnd:e.target.value});$('#muteOfficialInQuiet').onchange=e=>audio.save({muteOfficialInQuiet:e.target.checked});$('#soundTests').innerHTML=AUDIO_TYPES.map(type=>`<button class="sound-test" data-sound="${type}">${esc(AUDIO_LABELS[type])}</button>`).join('');$('#soundTests').onclick=e=>{const button=e.target.closest('[data-sound]');if(button)audio.test(button.dataset.sound).catch(()=>{$('#testSoundState').hidden=false;$('#testSoundState').textContent='ТЕСТ ЗВУКУ · браузер заблокував відтворення'})};$('#enableAudio').onclick=async()=>{try{await audio.enable();localStorage.setItem('nebo-audio-prompted','enabled');$('#audioPrompt').close();renderAudioSettings()}catch{$('#audioPrompt p').textContent='Браузер не дозволив відтворення. Спробуйте ще раз у налаштуваннях.'}};$('#laterAudio').onclick=()=>{localStorage.setItem('nebo-audio-prompted','later');$('#audioPrompt').close()};renderAudioSettings()}
function renderAudioSettings(){const p=audio.prefs,map={audioOfficialStart:'officialStart',audioOfficialEnd:'officialEnd',audioUav:'uav',audioMissile:'missile',audioKab:'kab',audioAviation:'aviation'};$('#audioEnabled').checked=p.enabled;for(const[id,key]of Object.entries(map))$('#'+id).checked=p[key];$('#audioVolume').value=Math.round(p.volume*100);$('#audioVolumeValue').textContent=`${Math.round(p.volume*100)}%`;$('#quietHoursEnabled').checked=p.quietHoursEnabled;$('#quietStart').value=p.quietStart;$('#quietEnd').value=p.quietEnd;$('#muteOfficialInQuiet').checked=p.muteOfficialInQuiet}
function showView(id){$$('.view').forEach(v=>v.hidden=v.id!==id);$$('.nav-item').forEach(b=>{const active=b.dataset.nav===id;b.classList.toggle('active',active);active?b.setAttribute('aria-current','page'):b.removeAttribute('aria-current')});
  // Root cause of the old "blank on first open": both Leaflet maps are
  // constructed while #radarMap is hidden (0px), so the radar tiles/canvas
  // never get a layout pass. A single 50ms invalidate was racy (fonts,
  // HUD and bottom-nav shift layout later). Re-invalidate on a schedule and
  // restart the scope loop every time the radar becomes visible.
  if(id==='radarView'){
    applyRadarMode();
    renderRadar();
    // Size first, then replay deferred radar layers (flush) once layout
    // settled — never touch Canvas paths of a 0px container (TZ §27).
    for(const t of [60,250,700]) setTimeout(()=>{ try{ radarUI.flush ? radarUI.flush() : radarUI.map.invalidateSize(true); }catch(e){} },t);
    setTimeout(()=>{ applyRadarMode(); renderRadar(); try{ radarUI.flush && radarUI.flush(); }catch(e){} },300);
  } else {
    scopeUI.setActive(false);
    if(id==='mapView'){
      for(const t of [60,250]) setTimeout(()=>{ try{mapUI.map.invalidateSize(true);}catch(e){} },t);
      // Radar → Map: restore the exact viewport the user left (same point/scale).
      try{
        const sv=state._mapView;
        if(sv&&Number.isFinite(sv.lat)&&Number.isFinite(sv.lon)&&Number.isFinite(sv.zoom))
          setTimeout(()=>{ try{mapUI.map.setView([sv.lat,sv.lon],sv.zoom,{animate:false});}catch(e){} },120);
      }catch(e){}
    } else {
      // Leaving the map: remember its viewport for an exact return.
      try{
        const c=mapUI.map.getCenter();
        state._mapView={lat:c.lat,lon:c.lng,zoom:mapUI.map.getZoom()};
      }catch(e){}
    }
  }}
function locate(){if(!navigator.geolocation){toastLoc('Геолокація не підтримується цим браузером.');return}const b=$('#locateButton');b.disabled=true;toastLoc('Визначаємо положення…');navigator.geolocation.getCurrentPosition(p=>{b.disabled=false;applyPosition(p.coords);startWatch()},()=>{b.disabled=false;toastLoc('Доступ до геолокації не надано. Дозвольте доступ у налаштуваннях браузера.');b.title='Доступ до геолокації не надано'},{timeout:12000,maximumAge:10000,enableHighAccuracy:true})}
function toastLoc(t){const s=$('#placeSearchStatus');if(s)s.textContent=t}
function applyPosition(c){if(!c||!Number.isFinite(c.latitude)||!Number.isFinite(c.longitude))return;state.userPos={lat:c.latitude,lon:c.longitude,acc:Number.isFinite(c.accuracy)?c.accuracy:null,at:Date.now()};mapUI.setUserPos(state.userPos);if(centerOnNextPos){centerOnNextPos=false;mapUI.centerOnUser()}const f=state.geo?.features.find(x=>pointInFeature([c.latitude,c.longitude],x));if(f){const n=regionName(f);if(n!==localStorage.getItem('nebo-region'))setRegion(n)}toastLoc(`GPS: ${state.userPos.acc!=null?`±${Math.round(state.userPos.acc)} м`:''} · ${clock(new Date(),true)}`);renderAll()}
function startWatch(){if(!navigator.geolocation||state.watchId!=null)return;let last=0;try{state.watchId=navigator.geolocation.watchPosition(p=>{const now=Date.now();if(now-last<8000)return;const u=state.userPos;if(!u||distKm(u.lat,u.lon,p.coords.latitude,p.coords.longitude)*1000>300){last=now;applyPosition(p.coords)}},null,{timeout:20000,maximumAge:15000,enableHighAccuracy:false})}catch(e){}}
function countCats(events){const c={uav:0,missile:0,ballistic:0,kab:0,aviation:0,recon:0,other:0};events.forEach(e=>c[e.category]=(c[e.category]||0)+1);return c}function label(k){return META[k]?.label||'Інше'}function stat(n,v){return`<span class="live-stat"><b>${v}</b>${n}</span>`}function monitorCell(n,v){return`<div class="monitor-cell"><b>${v}</b><span>${n} · повідомлень</span></div>`}function field(n,v){return`<div class="detail-field"><span>${n}</span><b>${esc(v)}</b></div>`}function positionLabel(q){return q==='confirmed'?'підтверджена джерелом':q==='approx'?'приблизна':q==='source-position'?'позиція джерела':'якість не передана'}
function fresh(d){if(!d)return'час не передано';const s=Math.max(0,Math.round((Date.now()-new Date(d).getTime())/1000));if(s<60)return`${s} сек тому`;if(s<3600)return`${Math.floor(s/60)} хв тому`;return`${Math.floor(s/3600)} год тому`}function clock(d,short=false){if(!d)return'—';return new Intl.DateTimeFormat('uk-UA',{hour:'2-digit',minute:'2-digit',second:short?undefined:'2-digit'}).format(new Date(d))}function compass(h){return['Пн','ПнСх','Сх','ПдСх','Пд','ПдЗх','Зх','ПнЗх'][Math.round(h/45)%8]}function distKm(a,b,c,d){const r=6371,p=Math.PI/180,dLa=(c-a)*p,dLo=(d-b)*p,x=Math.sin(dLa/2)**2+Math.cos(a*p)*Math.cos(c*p)*Math.sin(dLo/2)**2;return 2*r*Math.asin(Math.sqrt(x))}function bearingDeg(a,b,c,d){const p=Math.PI/180,y=Math.sin((d-b)*p)*Math.cos(c*p),x=Math.cos(a*p)*Math.sin(c*p)-Math.sin(a*p)*Math.cos(c*p)*Math.cos((d-b)*p);return(Math.atan2(y,x)/p+360)%360}function fmtDist(km){return km<10?`${km.toFixed(1).replace('.',',')} км`:`${Math.round(km)} км`}function fmtEta(min){return min<1?'менше хвилини':min<60?`~${Math.round(min)} хв`:`~${Math.floor(min/60)} год ${Math.round(min%60)} хв`}function annotateDistances(){const u=state.userPos;for(const e of state.snapshot.events){e._distKm=null;e._closing=false;e._etaMin=null;e._lvl=threatLevel(e);if(!u||e.lat==null||e.lon==null)continue;const d=distKm(u.lat,u.lon,e.lat,e.lon);e._distKm=d;const h=Number(e.heading),s=Number(e.speed);if(Number.isFinite(h)&&Number.isFinite(s)&&s>0){const brg=bearingDeg(e.lat,e.lon,u.lat,u.lon);let diff=Math.abs(h-brg)%360;if(diff>180)diff=360-diff;if(diff<35){e._closing=true;e._etaMin=d/s*60}};e._lvl=threatLevel(e)}}function saveJSON(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
function loadJSON(k,f){try{const v=JSON.parse(localStorage.getItem(k));return v==null?f:v}catch(e){return f}}
function flowEvents(){return state.onlyFresh?state.snapshot.events.filter(e=>!e.stale):state.snapshot.events}
function nearestEvent(){let best=null;for(const e of flowEvents())if(e._distKm!=null&&(!best||e._distKm<best._distKm))best=e;return best}function centerOf(f){const pts=[];walk(f.geometry.coordinates,pts);const b=pts.reduce((a,p)=>[Math.min(a[0],p[1]),Math.min(a[1],p[0]),Math.max(a[2],p[1]),Math.max(a[3],p[0])],[90,180,-90,-180]);return[(b[0]+b[2])/2,(b[1]+b[3])/2]}function walk(a,out){if(typeof a?.[0]==='number')out.push(a);else a?.forEach(x=>walk(x,out))}function esc(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
setup();setupEnhancements({getSnapshot:()=>state.snapshot,onRegion:setRegion,onRender:renderSky});const _os=$('#openSources');if(_os)_os.onclick=()=>{$('#settingsDialog').close();showView('threatsView');setTimeout(()=>$('#sourceHealth').scrollIntoView({behavior:'smooth'}),80)};load();if('serviceWorker'in navigator)addEventListener('load',()=>navigator.serviceWorker.register('./service-worker.js').catch(()=>{}));
