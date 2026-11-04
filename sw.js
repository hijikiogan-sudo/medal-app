// 画面の部品と暗号化したデータを端末に控え、電波がなくても開けるようにする
const V='medal-cc80e24cd29d';
const SHELL=["./","index.html","app.css","app.js","data.bin","manifest.webmanifest","icons/icon-180.png","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png"];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
 const u=new URL(e.request.url);
 if(e.request.method!=='GET'||u.origin!==location.origin)return;
 e.respondWith(caches.match(e.request,{ignoreSearch:true}).then(r=>r||fetch(e.request).catch(()=>e.request.mode==='navigate'?caches.match('index.html'):Response.error())));
});
