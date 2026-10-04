export async function fetchJson(url,{signal,timeout=8000,method='GET',headers={},body}={}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(new DOMException('Timeout','AbortError')),timeout);
  const abort=()=>controller.abort(signal?.reason);
  signal?.addEventListener('abort',abort,{once:true});
  try{
    const response=await fetch(url,{method,signal:controller.signal,cache:'no-store',headers:{Accept:'application/json',...headers},...(body!==undefined?{body}:{})});
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const text=await response.text();
    try{return JSON.parse(text)}catch{throw new Error('Некоректний JSON')}
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort)}
}
