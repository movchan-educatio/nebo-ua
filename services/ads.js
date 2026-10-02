export const advertising={adsEnabled:false,provider:null,user:{isAdFree:false}};
export function adsAllowed(config=advertising){return config.adsEnabled===true&&config.provider!==null&&!config.user?.isAdFree}
export function mountAdSlots(root=document,config=advertising){for(const slot of root.querySelectorAll('[data-ad-slot]')){const enabled=adsAllowed(config);slot.hidden=!enabled;slot.replaceChildren();if(enabled)slot.setAttribute('aria-label','Реклама')}}
