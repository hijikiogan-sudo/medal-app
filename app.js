'use strict';
// ===== 写真と記録を端末の中（IndexedDB）に置く =====
// collection.js（第13工程）を書き換えずに動かすため、claude.ai の db・assets と同じ形の呼び出しだけを用意する。
// 端末の外には何も送らない。アプリを消すと写真も消えるので、バックアップの書き出し・戻しを付ける。
const IDB_NAME='medal-app';
let idbOpen=null;
const idb=()=>idbOpen??=new Promise((res,rej)=>{const r=indexedDB.open(IDB_NAME,1);
 r.onupgradeneeded=()=>{const d=r.result;d.createObjectStore('collection',{keyPath:'id'});d.createObjectStore('photos')};
 r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
async function idbDo(store,mode,fn){
 const d=await idb();
 return new Promise((res,rej)=>{const t=d.transaction(store,mode);const r=fn(t.objectStore(store));let out;if(r)r.onsuccess=()=>{out=r.result};
  t.oncomplete=()=>res(out);t.onerror=t.onabort=()=>rej(t.error)});
}
const FIELDS=['candidate_id','candidate_name','pref','label','acquired','note','photo','back','shape','created_at'];
const pick=o=>Object.fromEntries(Object.entries(o).filter(([k])=>FIELDS.includes(k)));
const failCode=e=>({code:e?.name==='QuotaExceededError'?'quota_or_state':'failed',message:e?.message});

function makeLocalBackend(){
 const URLS=new Map();let listener=null;
 const refresh=async()=>{
  if(!listener)return;
  try{
   const rows=await idbDo('collection','readonly',s=>s.getAll());
   for(const id of rows.flatMap(r=>[r.photo,r.back]))if(id&&!URLS.has(id)){const b=await idbDo('photos','readonly',s=>s.get(id));if(b)URLS.set(id,URL.createObjectURL(b))}
   rows.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
   listener.cb({metadata:{fromCache:false},docs:rows.map(r=>({id:r.id,data:()=>r}))});
  }catch(e){listener.err?.(failCode(e))}
 };
 const db={
  collection:()=>({
   onSnapshot(cb,err){listener={cb,err};refresh();return()=>{listener=null}},
   async add(o){try{await idbDo('collection','readwrite',s=>s.add({id:crypto.randomUUID(),...pick(o)}))}catch(e){throw failCode(e)}await refresh()}}),
  doc:p=>{const id=p.split('/')[1];return {
   async update(o){try{const cur=await idbDo('collection','readonly',s=>s.get(id));if(!cur)throw new Error('not found');await idbDo('collection','readwrite',s=>s.put({...cur,...pick(o)}))}catch(e){throw failCode(e)}await refresh()},
   async delete(){try{await idbDo('collection','readwrite',s=>s.delete(id))}catch(e){throw failCode(e)}await refresh()}}}};
 const EXT={'image/webp':'webp','image/png':'png','image/jpeg':'jpg'};
 const assets={
  async upload(blob,{type}={}){
   const id=crypto.randomUUID()+'.'+(EXT[type||blob.type]??'bin');
   try{await idbDo('photos','readwrite',s=>s.put(blob,id))}catch(e){throw failCode(e)}
   URLS.set(id,URL.createObjectURL(blob));return {id,url:URLS.get(id)}},
  async delete(id){await idbDo('photos','readwrite',s=>s.delete(id));const u=URLS.get(id);if(u)URL.revokeObjectURL(u);URLS.delete(id)}};
 return {db,assets,url:id=>URLS.get(id)??'',refresh};
}

// ===== バックアップ（記録と写真を1つのファイルに） =====
const BACKUP_KIND='kinen-medal-collection';
const toDataUrl=b=>new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=()=>rej(r.error);r.readAsDataURL(b)});
async function exportBackup(){
 const items=await idbDo('collection','readonly',s=>s.getAll());
 const photos={};
 for(const id of items.flatMap(r=>[r.photo,r.back]))if(id){const b=await idbDo('photos','readonly',s=>s.get(id));if(b)photos[id]=await toDataUrl(b)}
 const name='記念メダル_バックアップ_'+new Date().toISOString().slice(0,10)+'.json';
 const file=new File([JSON.stringify({kind:BACKUP_KIND,version:1,exported_at:new Date().toISOString(),items,photos})],name,{type:'application/json'});
 // iPhoneでは共有シートから「ファイルに保存」できる。共有が使えなければダウンロードにする
 if(navigator.canShare?.({files:[file]})){try{await navigator.share({files:[file],title:name});return items.length}catch(e){if(e?.name==='AbortError')return null}}
 const a=document.createElement('a');a.href=URL.createObjectURL(file);a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),60000);
 return items.length;
}
// 同じ記録（同じid）がすでにあれば飛ばす。足すだけで、今ある記録は消さない
async function importBackup(file){
 const d=JSON.parse(await file.text());
 if(d?.kind!==BACKUP_KIND||!Array.isArray(d.items))throw new Error('format');
 const have=new Set((await idbDo('collection','readonly',s=>s.getAll())).map(r=>r.id));
 let added=0;
 for(const it of d.items){
  if(typeof it?.id!=='string'||have.has(it.id)||typeof it.photo!=='string'||!d.photos?.[it.photo])continue;
  for(const id of [it.photo,it.back])if(id&&typeof d.photos[id]==='string'&&/^data:image\/(webp|png|jpeg);base64,/.test(d.photos[id])){
   const [head,b64]=d.photos[id].split(',');const bin=atob(b64);const bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
   const b=new Blob([bytes],{type:head.slice(5,head.indexOf(';'))});await idbDo('photos','readwrite',s=>s.put(b,id))}
  await idbDo('collection','readwrite',s=>s.put({id:it.id,...pick(it),back:it.back&&d.photos[it.back]?it.back:null}));
  added++;
 }
 return added;
}
// 戻した後は画面が描き直されるので、知らせる文は描き直しても残るように外に持つ
let backupNote='';
function backupTools(h){
 const msg=h('p',{class:'crop-msg',role:'status',text:backupNote});
 const note=t=>{backupNote=t;msg.textContent=t};
 const pickFile=h('input',{type:'file',accept:'application/json,.json',class:'visually-hidden','aria-label':'バックアップのファイル'});
 pickFile.addEventListener('change',async()=>{const f=pickFile.files?.[0];pickFile.value='';if(!f)return;note('戻しています…');
  try{const n=await importBackup(f);note(n?n+'枚を戻しました。':'新しく戻す記録はありませんでした（すでに入っています）。');await BACKEND.refresh()}
  catch{note('このファイルは戻せません。書き出したバックアップのファイルを選んでください。')}});
 return h('section',{class:'block backup'},h('h2',{text:'バックアップ'}),
  h('p',{class:'muted small',text:'写真と記録はこのiPhoneの中だけにあります。アプリを消したり機種を変えたりすると消えるので、ときどき書き出して「ファイル」に保存してください。'}),
  h('p',{},h('button',{type:'button',class:'btn',text:'書き出す',onclick:async()=>{note('書き出しています…');
    try{const n=await exportBackup();note(n==null?'':n+'枚分を書き出しました。')}catch{note('書き出せませんでした。')}}}),
   ' ',h('button',{type:'button',class:'btn',text:'ファイルから戻す',onclick:()=>pickFile.click()}),pickFile),msg);
}

// ===== 第13工程の画面（REAL は合言葉で開いた実データ） =====
function startApp(REAL){
'use strict';
// 全国Excelの調査記録（審査前）を表示する。文字列は必ずテキストとして入れる（innerHTMLを使わない）。
function h(tag,attrs={},...children){const el=document.createElement(tag);for(const [k,v] of Object.entries(attrs??{})){if(v==null||v===false)continue;if(k.startsWith('on'))el.addEventListener(k.slice(2),v);else if(k==='class')el.className=v;else if(k==='text')el.textContent=v;else el.setAttribute(k,v===true?'':v)}for(const c of children.flat()){if(c==null||c===false)continue;el.append(c instanceof Node?c:String(c))}return el}
const put=(el,...c)=>el.replaceChildren(...c.flat().filter(x=>x!=null&&x!==false));
const PREFS=['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'];
const prefName=c=>c?PREFS[Number(c)-1]??'':'県不明';
const D=REAL;
const root=document.getElementById('public-root');
// Excelの分類・状況の文から、目安の見出しを1つ選ぶ（自動の目安。元の文も必ず並べて表示する）
const TAGS=[
 ['ended_confirmed','終了・休止の記録あり',/終了|終売|閉鎖|停止|中断|売切|ended/],
 ['paused','要照合・要注意',/衝突|競合|重複|要照合|注意|risk|休館|時期外/],
 ['recent_confirmation','購入・訪問の報告あり',/購入|現地|訪問|設置報告|再納品|recent|purchase/],
 ['official_listing','施設・運営の案内あり',/公式|施設|運営|案内|告知|official/],
 ['historical_confirmation','メーカー・収集サイト掲載',/掲載|図鑑|メーカー|収集|candidate/]];
const tagOf=c=>{const t=(c.cls??'')+' '+(c.status??'');for(const [k,label,re] of TAGS)if(re.test(t))return {k,label};return {k:'none',label:'根拠の分類なし'}};
const link=u=>{let label=u;try{const x=new URL(u);label=x.hostname+(x.pathname.length>1?decodeURI(x.pathname).slice(0,40)+(x.pathname.length>41?'…':''):'')}catch{}return h('a',{href:u,target:'_blank',rel:'noopener noreferrer',text:label})};
const links=us=>us?.length?h('div',{class:'links'},...us.map(link)):null;
const kv=pairs=>{const p=pairs.filter(([,v])=>v!=null&&v!=='');return p.length?h('dl',{class:'kv'},...p.flatMap(([k,v])=>[h('dt',{text:k}),h('dd',{},v)])):null};
const fmt=s=>new Date(s).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
const banner=()=>h('div',{class:'warning unreviewed',role:'note',text:'未審査：全国Excel（v8）の調査記録をそのまま表示しています。審査・承認の前なので、販売中・在庫を保証するものではありません。'});
const tabs=cur=>h('nav',{class:'tabs','aria-label':'表示の切替'},h('a',{href:'#list','aria-current':cur==='list'?'page':null,text:'施設候補 '+D.candidates.length}),h('a',{href:'#past','aria-current':cur==='past'?'page':null,text:'過去品・除外 '+(D.past.length+D.exclusions.length)}),COL.db?h('a',{href:'#mine','aria-current':cur==='mine'?'page':null,text:'コレクション '+COL.items.length}):null);
const state={query:'',pref:'',tag:'',pastQuery:'',pastPref:''};
const prefSelect=(val,on)=>{const s=h('select',{'aria-label':'都道府県'},h('option',{value:'',text:'全国'}),...PREFS.map((p,i)=>h('option',{value:String(i+1).padStart(2,'0'),text:p})));s.value=val;s.addEventListener('change',()=>on(s.value));return s};
const byPref=(items)=>{const m=new Map();for(const it of [...items].sort((a,b)=>(a.pref??'99').localeCompare(b.pref??'99'))){const k=it.pref??'';if(!m.has(k))m.set(k,[]);m.get(k).push(it)}return m};

// ===== 施設候補の一覧 =====
function showList(){
 const search=h('input',{type:'search',id:'q',placeholder:'施設名・市町村で絞り込む','aria-label':'施設名・市町村で絞り込む',value:state.query});
 const pref=prefSelect(state.pref,v=>{state.pref=v;draw()});
 const tag=h('select',{id:'tag','aria-label':'記録の種類'},h('option',{value:'',text:'すべての記録'}),...[...TAGS.map(([k,l])=>[k,l]),['none','根拠の分類なし']].map(([k,l])=>h('option',{value:k,text:l})));tag.value=state.tag;
 tag.addEventListener('change',()=>{state.tag=tag.value;draw()});
 const body=h('div',{});const count=h('p',{class:'muted small'});
 const draw=()=>{const q=state.query.trim();
  const shown=D.candidates.filter(c=>(!state.pref||c.pref===state.pref)&&(!state.tag||tagOf(c).k===state.tag)&&(!q||(c.name+(c.muni??'')+c.id).includes(q)));
  count.textContent=shown.length+'件を表示';
  put(body,...(shown.length?[...byPref(shown)].map(([p,list])=>h('section',{},h('h2',{class:'pref-head'},prefName(p),h('span',{text:list.length+'件'})),
   h('ul',{class:'facility-grid'},...list.map(c=>{const t=tagOf(c);return h('li',{},h('a',{class:'facility-card',href:'#c-'+c.id},
    h('span',{class:'name',text:c.name}),
    h('span',{class:'meta'},h('span',{class:'pref',text:c.id}),c.muni?h('span',{text:c.muni}):null,c.date?h('span',{text:'根拠 '+c.date}):null),
    h('span',{class:'badges'},h('span',{class:'state '+t.k,text:t.label}),collectionBadge(c.id)),c.status?h('span',{class:'status-line',text:c.status}):null))}))))
   :[h('p',{class:'empty',text:'条件に合う施設候補はありません。'})]));
 };
 search.addEventListener('input',()=>{state.query=search.value;draw()});
 put(root,banner(),h('h1',{text:'記念メダルの施設候補（全国調査）'}),
  h('div',{class:'counts'},...[['施設候補',D.candidates.length],['根拠の記録',D.evidence.length],['過去品',D.past.length],['要再確認',D.recheck.length]].map(([k,v])=>h('span',{},k+' ',h('strong',{text:String(v)})))),
  tabs('list'),h('div',{class:'filters'},search,pref),h('div',{class:'filters'},tag,count),body);
 draw();
}

// ===== 施設候補のページ =====
function showCandidate(id){
 const c=D.candidates.find(x=>x.id===id);
 if(!c){put(root,banner(),h('p',{class:'crumb'},h('a',{href:'#list',text:'施設候補'})),h('p',{class:'empty',text:'この候補IDの記録はありません。'}));return}
 document.title=c.name+'｜記念メダルの施設候補';
 const t=tagOf(c);
 const ev=D.evidence.filter(e=>e.ids.includes(id));
 const s2=D.step2.filter(s=>s.id===id);
 const near=(a,b)=>a&&b&&(a.includes(b)||b.includes(a));
 const rc=D.recheck.filter(r=>(!r.pref||!c.pref||r.pref===c.pref)&&near(r.target,c.name));
 const ps=D.past.filter(p=>(!p.pref||p.pref===c.pref)&&near(p.name,c.name));
 put(root,banner(),
  h('p',{class:'crumb'},h('a',{href:'#list',text:'施設候補'}),' › '+c.name),
  h('div',{class:'facility-head'},h('h1',{text:c.name}),
   h('div',{class:'meta',text:[prefName(c.pref)+(c.pref_source==='inferred'?'（市町村から推定）':''),c.muni,c.region,'候補ID '+c.id].filter(Boolean).join('　')})),
  h('div',{class:'state '+t.k,text:t.label}),
  collectionSection(c),
  h('section',{class:'block'},h('h2',{text:'台帳の記録'}),kv([['現在の状況',c.status],['区分',c.cls],['根拠の時点',c.date],['再確認の優先度',c.prio],...Object.entries(c.notes),['台帳',c.sheet]]),links(c.urls)),
  ...s2.map(s=>h('section',{class:'block'},h('h2',{text:'STEP2 検証（'+(s.checked??'日付不明')+'）'}),
   kv([['対象',s.scope],['証拠の分類',s.cls],['証拠の日付',s.date],['オンラインで確認できた事実',s.fact],['判定（在庫保証なし）',s.judgement],['直接確認',s.direct],['次の確認作業',s.next],['注意',s.caution],['優先度',s.prio]]),links(s.urls))),
  h('section',{class:'block'},h('h2',{text:'根拠の記録 '+ev.length+'件'}),
   ev.length?h('ul',{class:'ev'},...ev.map(e=>h('li',{},h('div',{},h('span',{class:'ev-kind',text:e.kind??'種類なし'}),' ',h('span',{class:'ev-date',text:e.dates.map(d=>d.label+' '+d.value).join('　')})),
    e.content?h('div',{text:e.content}):null,e.limit?h('div',{class:'muted small',text:'限界：'+e.limit}):null,links(e.urls)))):h('p',{class:'muted small',text:'この候補IDに結び付いた根拠の記録はありません。'})),
  rc.length?h('section',{class:'block'},h('h2',{text:'要再確認（名称が一致・近いもの）'}),h('ul',{class:'ev'},...rc.map(r=>h('li',{},h('div',{class:'ev-kind',text:r.target}),r.judgement?h('div',{text:r.judgement}):null,h('div',{text:r.reason}),links(r.urls))))):null,
  ps.length?h('section',{class:'block'},h('h2',{text:'名称が近い過去品・終了の記録'}),h('ul',{class:'ev'},...ps.map(pastItem))):null,
  h('div',{class:'notice-box',text:'名称の近さで結び付けた記録は自動の目安です。同じ施設・同じメダルかどうかは確認していません。'}));
}
function pastItem(p){return h('li',{},h('div',{},h('span',{class:'ev-kind',text:p.name}),' ',h('span',{class:'ev-date',text:[p.id,prefName(p.pref)].join('　')})),
 h('div',{text:[p.state,p.source].filter(Boolean).join('（出典：')+(p.source&&p.state?'）':'')}),...Object.values(p.notes).map(n=>h('div',{class:'muted small',text:n})),links(p.urls))}

// ===== 過去品・除外 =====
function showPast(){
 const search=h('input',{type:'search',id:'pq',placeholder:'名称で絞り込む','aria-label':'名称で絞り込む',value:state.pastQuery});
 const pref=prefSelect(state.pastPref,v=>{state.pastPref=v;draw()});
 const body=h('div',{});
 const draw=()=>{const q=state.pastQuery.trim();const shown=D.past.filter(p=>(!state.pastPref||p.pref===state.pastPref)&&(!q||(p.name??'').includes(q)));
  put(body,...(shown.length?[...byPref(shown)].map(([p,list])=>h('section',{},h('h2',{class:'pref-head'},prefName(p),h('span',{text:list.length+'件'})),h('div',{class:'block'},h('ul',{class:'ev'},...list.map(pastItem))))):[h('p',{class:'empty',text:'条件に合う記録はありません。'})]))};
 search.addEventListener('input',()=>{state.pastQuery=search.value;draw()});
 put(root,banner(),h('h1',{text:'過去品・販売終了の記録'}),
  h('p',{class:'lead',text:'旧デザインの終売などの記録です。施設そのものの販売終了を意味しません。'}),
  tabs('past'),h('div',{class:'filters'},search,pref),body,
  h('section',{class:'block'},h('h2',{text:'除外・保留 '+D.exclusions.length+'件'}),h('ul',{class:'ev'},...D.exclusions.map(x=>h('li',{},h('div',{class:'ev-kind',text:x.place}),h('div',{text:x.handling}),h('div',{class:'muted small',text:x.reason}),links(x.urls))))));
 draw();
}

let current='';
function route(hash,keep){current=hash||'';document.title='記念メダルの施設候補';const m=/^#c-(.+)$/.exec(current);if(m)showCandidate(decodeURIComponent(m[1]));else if(current==='#past')showPast();else if(current==='#mine')showMine();else showList();if(!keep)window.scrollTo(0,0)}
// コレクションが変わったら、今の画面をスクロール位置のまま描き直す（入力中の欄があれば待つ）
function rerender(){const a=document.activeElement;if(a&&root.contains(a)&&/INPUT|SELECT|TEXTAREA/.test(a.tagName))return;route(current,true)}
document.addEventListener('click',e=>{const a=e.target.closest('a[href^="#"]');if(!a)return;e.preventDefault();route(a.getAttribute('href'))});
// ===== 持っているメダルのコレクション（claude.ai のアーティファクト上だけで動く） =====
// 写真は assets（アーティファクトのファイル置き場）、記録は db の collection/<id> に置く。
// どちらも使えない表示（手元のファイル・閲覧のみの人）では、コレクションの操作を出さない。
// build_real_preview.mjs が本体のスクリプト（h・put・D・root など）の後ろに埋め込む。
const use=name=>Promise.resolve(BACKEND[name]??null);
const COL={db:null,assets:null,items:[],loaded:false,slow:false,error:null};
const mine=id=>COL.items.filter(m=>m.candidate_id===id);
const photoUrl=id=>BACKEND.url?.(id)??'';
const ERR={too_large:'写真が大きすぎます。',unsupported_type:'この形式の画像は保存できません。',quota_or_state:'保存できる容量の上限に達しています。いらない写真を削除してください。',quota_exceeded:'保存できる件数の上限に達しています。',rate_limited:'操作が続いたため、少し待ってからもう一度保存してください。',upstream_auth:'claude.ai に入り直してから、もう一度保存してください。',not_granted:'このページでは写真を保存できません（編集できる人だけが保存できます）。'};
const errText=e=>ERR[e?.code]??'保存できませんでした。時間をおいてもう一度お試しください。';

async function initCollection(){
 COL.db=await use('db');
 if(!COL.db)return;
 COL.assets=await use('assets');
 const timer=setTimeout(()=>{COL.slow=true;rerender()},10000);
 COL.db.collection('collection').onSnapshot(snap=>{
  if(!snap.metadata.fromCache){clearTimeout(timer);COL.slow=false}
  COL.items=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
  COL.loaded=true;rerender();
 },e=>{clearTimeout(timer);COL.error=e.code;COL.loaded=true;rerender()});
}

function collectionBadge(id){const n=mine(id).length;return n?h('span',{class:'owned',text:'所持 '+n}):null}

// 表と裏。裏がある写真はタップで入れ替わる
function medalImage(m){
 const sq=m.shape==='square'?' square':'';
 const make=(id,side)=>{const img=h('img',{src:photoUrl(id),alt:(m.label||m.candidate_name||'メダル')+'（'+side+'）',loading:'lazy',class:'medal-photo'+sq});
  img.addEventListener('error',()=>img.replaceWith(h('div',{class:'medal-photo missing'+sq,text:'写真を読み込めません'})));return img};
 if(!m.back)return make(m.photo,'表');
 let side='front';
 const face=h('span',{class:'flip-face'},make(m.photo,'表'));
 const tag=h('span',{class:'side-tag',text:'表'});
 const btn=h('button',{type:'button',class:'flip','aria-label':'裏を見る'},face,tag);
 btn.addEventListener('click',()=>{side=side==='front'?'back':'front';btn.classList.remove('turning');void btn.offsetWidth;btn.classList.add('turning');
  setTimeout(()=>{put(face,make(side==='front'?m.photo:m.back,side==='front'?'表':'裏'));tag.textContent=side==='front'?'表':'裏';btn.setAttribute('aria-label',side==='front'?'裏を見る':'表を見る')},120)});
 return btn;
}
function medalTile(m,{showPlace=false}={}){
 const acts=h('div',{class:'tile-actions'});
 const arm=()=>put(acts,h('button',{type:'button',class:'btn small danger',text:'削除する（元に戻せません）',onclick:()=>removeMedal(m,acts)}),h('button',{type:'button',class:'btn small',text:'やめる',onclick:idle}));
 const idle=()=>put(acts,COL.assets?[h('button',{type:'button',class:'btn small quiet',text:m.back?'裏を撮り直す':'裏を追加',onclick:()=>openCropper({existing:m})}),h('button',{type:'button',class:'btn small quiet',text:'削除',onclick:arm})]:null);
 idle();
 return h('figure',{class:'medal-tile'},medalImage(m),h('figcaption',{},
  h('strong',{text:m.label||'名前なし'}),
  showPlace&&m.candidate_id?h('a',{href:'#c-'+m.candidate_id,text:m.candidate_name}):showPlace&&m.candidate_name?h('span',{text:m.candidate_name}):null,
  m.acquired?h('span',{class:'muted small',text:'入手 '+m.acquired}):null,
  m.note?h('span',{class:'muted small',text:m.note}):null),acts);
}
async function removeMedal(m,box){
 put(box,h('span',{class:'muted small',text:'削除中…'}));
 try{await COL.db.doc('collection/'+m.id).delete()}catch(e){put(box,h('span',{class:'muted small',text:'削除できませんでした。'}));return}
 for(const id of [m.photo,m.back])if(id)try{await COL.assets?.delete(id)}catch{}
}

function collectionStatus(){
 if(!COL.db)return h('p',{class:'muted small',text:'コレクションを使えません。'});
 if(COL.error)return h('p',{class:'muted small',text:'コレクションを読み込めませんでした。ページを開き直してください。'});
 if(!COL.loaded)return h('p',{class:'muted small',text:COL.slow?'コレクションにまだつながりません。通信状況を確かめてください。':'コレクションを読み込み中…'});
 return null;
}

// 施設候補のページに置くまとまり
function collectionSection(c){
 const items=mine(c.id);
 return h('section',{class:'block mine'},
  h('div',{class:'mine-head'},h('h2',{text:'持っているメダル '+items.length}),
   COL.assets&&COL.loaded?h('button',{type:'button',class:'btn primary',text:'写真で追加',onclick:()=>openCropper({candidate:c})}):null),
  collectionStatus(),
  items.length?h('div',{class:'medal-shelf'},...items.map(m=>medalTile(m))):COL.loaded?h('p',{class:'muted small',text:COL.assets?'メダルを撮影するか写真を選ぶと、丸く切り抜いてここに並べます。':'まだ登録はありません。'}):null);
}

// コレクションの一覧（#mine）
function showMine(){
 const groups=new Map();
 for(const m of COL.items){const k=m.pref??'';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(m)}
 put(root,h('h1',{text:'コレクション'}),
  h('div',{class:'counts'},h('span',{},'メダル ',h('strong',{text:String(COL.items.length)})),h('span',{},'施設 ',h('strong',{text:String(new Set(COL.items.map(m=>m.candidate_id??m.candidate_name)).size)}))),
  tabs('mine'),collectionStatus(),
  COL.assets&&COL.loaded?h('p',{},h('button',{type:'button',class:'btn',text:'候補にないメダルを追加',onclick:()=>openCropper({candidate:null})})):null,
  COL.loaded?backupTools(h):null,
  COL.items.length?[...groups].sort((a,b)=>(a[0]||'99').localeCompare(b[0]||'99')).map(([p,list])=>h('section',{},h('h2',{class:'pref-head'},prefName(p),h('span',{text:list.length+'枚'})),h('div',{class:'medal-shelf'},...list.map(m=>medalTile(m,{showPlace:true}))))):
   COL.loaded?h('p',{class:'empty',text:'まだ登録はありません。施設候補のページの「写真で追加」から登録できます。'}):null);
}

// ===== 写真の切り抜き =====
// 写真から丸いメダルの縁を探して（勾配の向きに沿った円の投票）、切り抜き枠に合わせる。手で動かして直せる。
function detectCircle(src){
 const N=240,s=N/Math.max(src.width,src.height),w=Math.max(8,Math.round(src.width*s)),hh=Math.max(8,Math.round(src.height*s));
 const cv=document.createElement('canvas');cv.width=w;cv.height=hh;const cx=cv.getContext('2d',{willReadFrequently:true});cx.drawImage(src,0,0,w,hh);
 const px=cx.getImageData(0,0,w,hh).data,g=new Float32Array(w*hh);
 for(let i=0;i<w*hh;i++)g[i]=px[i*4]*.299+px[i*4+1]*.587+px[i*4+2]*.114;
 const b=new Float32Array(w*hh);
 for(let y=1;y<hh-1;y++)for(let x=1;x<w-1;x++){let t=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)t+=g[(y+dy)*w+x+dx];b[y*w+x]=t/9}
 const GX=new Float32Array(w*hh),GY=new Float32Array(w*hh),M=new Float32Array(w*hh);
 for(let y=2;y<hh-2;y++)for(let x=2;x<w-2;x++){const i=y*w+x;
  GX[i]=b[i-w+1]+2*b[i+1]+b[i+w+1]-b[i-w-1]-2*b[i-1]-b[i+w-1];GY[i]=b[i+w-1]+2*b[i+w]+b[i+w+1]-b[i-w-1]-2*b[i-w]-b[i-w+1];M[i]=Math.hypot(GX[i],GY[i])}
 // 細い縁だけ残す（勾配の向きで隣より強い点）。なだらかな陰影は落とす
 const sorted=[...M].filter(v=>v>0).sort((a,b)=>a-b);if(sorted.length<50)return null;
 const th=Math.max(12,sorted[Math.floor(sorted.length*.99)]*.22);
 const E=new Uint8Array(w*hh),edges=[];
 for(let y=3;y<hh-3;y++)for(let x=3;x<w-3;x++){const i=y*w+x,m=M[i];if(m<th)continue;
  const ux=GX[i]/m,uy=GY[i]/m,dx=Math.round(ux),dy=Math.round(uy);
  if(m<M[i+dy*w+dx]||m<M[i-dy*w-dx])continue;E[i]=1;edges.push([x,y,ux,uy])}
 if(edges.length<30)return null;
 const md=Math.min(w,hh),rmin=Math.round(md*.12),rmax=Math.round(md*.52),R=rmax-rmin+1,acc=new Uint16Array(w*hh*R);
 for(const [x,y,ux,uy] of edges)for(let r=rmin;r<=rmax;r++)for(const sg of [1,-1]){const ax=Math.round(x+sg*ux*r),ay=Math.round(y+sg*uy*r);if(ax<0||ay<0||ax>=w||ay>=hh)continue;acc[(ay*w+ax)*R+r-rmin]++}
 // 票の多い候補を拾い、円周のうち実際に縁が通っている割合で確かめる
 const peaks=[];
 for(let i=0;i<acc.length;i++){const v=acc[i];if(v<8)continue;const r=i%R+rmin;const sc=v/Math.sqrt(r);if(peaks.length<40||sc>peaks[peaks.length-1].sc){peaks.push({i,r,sc});peaks.sort((a,b)=>b.sc-a.sc);if(peaks.length>40)peaks.pop()}}
 let best=null;
 for(const p of peaks){const q=(p.i-p.i%R)/R,x0=q%w+.5,y0=Math.floor(q/w)+.5;let hit=0;const K=120;
  for(let k=0;k<K;k++){const a=k/K*Math.PI*2,ca=Math.cos(a),sa=Math.sin(a);let ok=false;
   for(let d=-1.5;d<=1.5&&!ok;d+=.75){const xx=Math.round(x0+ca*(p.r+d)),yy=Math.round(y0+sa*(p.r+d));if(xx>=0&&yy>=0&&xx<w&&yy<hh&&E[yy*w+xx])ok=true}
   if(ok)hit++}
  const cov=hit/K;if(cov<.4)continue;const score=cov*Math.sqrt(p.r);
  if(!best||score>best.score)best={x:x0,y:y0,r:p.r,score}}
 if(!best)return null;
 return {cx:best.x/s,cy:best.y/s,r:(best.r+1)/s};
}

async function loadImage(file){
 const url=URL.createObjectURL(file);
 try{const img=new Image();img.decoding='async';img.src=url;await img.decode();
  // 大きすぎる写真は扱いやすい大きさにしておく（向きはブラウザが写真の情報どおりに直す）
  const max=2800,sc=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));
  const cv=document.createElement('canvas');cv.width=Math.round(img.naturalWidth*sc);cv.height=Math.round(img.naturalHeight*sc);
  cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);return cv}
 finally{URL.revokeObjectURL(url)}
}

// 新しく登録するときは表（必須）と裏（任意）を、登録済みのメダルには裏だけを撮る
function openCropper({candidate=null,existing=null}){
 const blank=()=>({src:null,cx:0,cy:0,k:1,kFit:1,rot:0,bright:100,contrast:100,sat:100});
 const sides={front:blank(),back:blank()};
 const onlyBack=!!existing;
 let cur=onlyBack?'back':'front',st=sides[cur],shape=existing?.shape??'circle';
 const stage=h('canvas',{class:'crop-stage','aria-label':'切り抜きの調整。ドラッグで移動、2本指で拡大・回転'});
 const msg=h('p',{class:'crop-msg',role:'status'});
 const file=h('input',{type:'file',accept:'image/*',id:'medal-photo-file',class:'visually-hidden'});
 const pick=h('label',{for:'medal-photo-file',class:'btn primary'});
 const range=(id,label,min,max,step,on)=>{const r=h('input',{type:'range',id,min,max,step,value:'0'});r.addEventListener('input',()=>{if(!st.src)return;on(Number(r.value));draw()});return [h('label',{for:id,text:label}),r]};
 const [zl,zoom]=range('crop-zoom','拡大',-1.5,3,.01,v=>{st.k=st.kFit*2**v});
 const [rl,rot]=range('crop-rot','回転',-180,180,.5,v=>{st.rot=v*Math.PI/180});
 const [bl,bright]=range('crop-bright','明るさ',60,150,1,v=>{st.bright=v});
 const [cl,contrast]=range('crop-contrast','コントラスト',60,160,1,v=>{st.contrast=v});
 const [sl,sat]=range('crop-sat','あざやかさ',0,180,1,v=>{st.sat=v});
 const syncSliders=()=>{zoom.value=String(st.src?Math.log2(st.k/st.kFit):0);rot.value=String(((st.rot*180/Math.PI+540)%360)-180);bright.value=String(st.bright);contrast.value=String(st.contrast);sat.value=String(st.sat)};
 // 表・裏の切替。裏は表と同じ形で切り抜く
 const sideBtns=onlyBack?[]:[['front','表'],['back','裏（任意）']].map(([k,l])=>h('button',{type:'button',class:'seg','aria-pressed':String(k===cur),text:l,onclick:()=>switchSide(k)}));
 const shapeBtns=[['circle','丸'],['square','四角']].map(([k,l])=>h('button',{type:'button',class:'seg','aria-pressed':String(k===shape),disabled:onlyBack,text:l,onclick:e=>{shape=k;shapeBtns.forEach(b=>b.setAttribute('aria-pressed',String(b===e.currentTarget)));draw();drawThumbs()}}));
 const auto=h('button',{type:'button',class:'btn',text:'メダルに自動で合わせる',onclick:()=>{if(!st.src)return;fit(true);draw();drawThumbs()}});
 const thumbs={front:h('canvas',{class:'side-thumb',width:'96',height:'96'}),back:h('canvas',{class:'side-thumb',width:'96',height:'96'})};
 const clearBack=h('button',{type:'button',class:'btn small quiet',text:'裏をやめる',hidden:true,onclick:()=>{sides.back=blank();if(cur==='back'){st=sides.back;syncSliders()}clearBack.hidden=true;draw();drawThumbs();updatePick()}});
 const label=h('input',{type:'text',id:'medal-label',maxlength:'60',placeholder:candidate?'例：通常金色・図柄名':'メダルの名前（必須）'});
 const place=candidate?null:h('input',{type:'text',id:'medal-place',maxlength:'60',placeholder:'買った場所（任意）'});
 const acquired=h('input',{type:'date',id:'medal-acquired'});
 const note=h('textarea',{id:'medal-note',rows:'2',maxlength:'300',placeholder:'メモ（任意）'});
 const save=h('button',{type:'button',class:'btn primary',text:'保存',disabled:true});
 const cancel=h('button',{type:'button',class:'btn',text:'やめる'});
 const title=existing?(existing.back?'裏の写真を撮り直す':'裏の写真を追加'):'メダルの写真を追加';
 const panel=h('div',{class:'crop-panel',role:'dialog','aria-modal':'true','aria-label':title},
  h('div',{class:'crop-title'},h('strong',{text:title}),h('span',{class:'muted small',text:existing?(existing.label||existing.candidate_name||''):candidate?.name??''})),
  onlyBack?null:h('div',{class:'side-row'},h('div',{class:'segs'},...sideBtns),h('div',{class:'side-thumbs'},h('figure',{},thumbs.front,h('figcaption',{text:'表'})),h('figure',{},thumbs.back,h('figcaption',{text:'裏'}))),clearBack),
  h('div',{class:'crop-pick'},pick,file,h('span',{class:'muted small',text:'メダルを真上から、無地の背景で撮ると自動で合わせやすくなります。'})),
  h('div',{class:'crop-body'},stage,
   h('div',{class:'crop-controls'},h('div',{class:'segs'},...shapeBtns),auto,
    h('div',{class:'sliders'},zl,zoom,rl,rot,bl,bright,cl,contrast,sl,sat),
    existing?null:h('div',{class:'fields'},h('label',{for:'medal-label',text:'名前'}),label,place?h('label',{for:'medal-place',text:'場所'}):null,place,h('label',{for:'medal-acquired',text:'入手日'}),acquired,h('label',{for:'medal-note',text:'メモ'}),note))),
  msg,h('div',{class:'crop-actions'},cancel,save));
 const overlay=h('div',{class:'crop-overlay'},panel);
 document.body.append(overlay);document.body.classList.add('no-scroll');
 const close=()=>{overlay.remove();document.body.classList.remove('no-scroll')};
 cancel.addEventListener('click',close);
 overlay.addEventListener('keydown',e=>{if(e.key==='Escape')close()});
 const updatePick=()=>{const which=cur==='front'?'表':'裏';pick.textContent=st.src?`${which}を別の写真にする`:`${which}を撮影・写真を選ぶ`;save.disabled=onlyBack?!sides.back.src:!sides.front.src};
 function switchSide(k){cur=k;st=sides[k];sideBtns.forEach((b,i)=>b.setAttribute('aria-pressed',String(['front','back'][i]===k)));syncSliders();updatePick();msg.textContent='';draw()}
 updatePick();pick.focus();

 const S=()=>stage.clientWidth||320,ring=()=>S()*.44;
 function fit(useDetect){
  const found=useDetect?detectCircle(st.src):null;
  if(found){st.cx=found.cx;st.cy=found.cy;st.kFit=ring()/found.r;msg.textContent='メダルの縁を見つけて合わせました。ずれていたら指で動かしてください。'}
  else{st.cx=st.src.width/2;st.cy=st.src.height/2;st.kFit=ring()/(Math.min(st.src.width,st.src.height)*.45);if(useDetect)msg.textContent='メダルの縁を見つけられませんでした。指で動かして枠に合わせてください。'}
  st.k=st.kFit;st.rot=0;syncSliders();
 }
 const filter=t=>`brightness(${t.bright}%) contrast(${t.contrast}%) saturate(${t.sat}%)`;
 const place2=(ctx,t,scale)=>{ctx.rotate(t.rot);ctx.scale(t.k*scale,t.k*scale);ctx.translate(-t.cx,-t.cy)};
 const clip=(ctx,c,r)=>{ctx.beginPath();if(shape==='circle')ctx.arc(c,c,r,0,Math.PI*2);else ctx.roundRect?ctx.roundRect(c-r,c-r,2*r,2*r,r*.08):ctx.rect(c-r,c-r,2*r,2*r)};
 function draw(){
  const s=S(),dpr=Math.min(3,window.devicePixelRatio||1);
  if(stage.width!==Math.round(s*dpr)){stage.width=Math.round(s*dpr);stage.height=Math.round(s*dpr)}
  const ctx=stage.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,s,s);
  ctx.fillStyle=getComputedStyle(stage).getPropertyValue('--stage').trim()||'#222';ctx.fillRect(0,0,s,s);
  if(!st.src){ctx.fillStyle='#fff8';ctx.font='14px sans-serif';ctx.textAlign='center';ctx.fillText((cur==='front'?'表':'裏')+'の写真を選ぶとここに表示します',s/2,s/2);return}
  ctx.save();ctx.translate(s/2,s/2);place2(ctx,st,1);ctx.filter=filter(st);ctx.drawImage(st.src,0,0);ctx.restore();
  ctx.save();ctx.beginPath();ctx.rect(0,0,s,s);clip(ctx,s/2,ring());ctx.fillStyle='rgba(0,0,0,.55)';ctx.fill('evenodd');
  clip(ctx,s/2,ring());ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();ctx.restore();
 }
 // 切り抜いた結果を任意の大きさのキャンバスに描く（保存用と小さな見本で共用）
 function render(t,cv){const O=cv.width,ctx=cv.getContext('2d');ctx.clearRect(0,0,O,O);if(!t.src)return;
  ctx.save();clip(ctx,O/2,O/2);ctx.clip();ctx.translate(O/2,O/2);place2(ctx,t,O/2/ring());ctx.filter=filter(t);ctx.imageSmoothingQuality='high';ctx.drawImage(t.src,0,0);ctx.restore()}
 let thumbTimer=0;
 function drawThumbs(){if(onlyBack)return;clearTimeout(thumbTimer);thumbTimer=setTimeout(()=>{render(sides.front,thumbs.front);render(sides.back,thumbs.back)},60)}
 function output(t){
  const cv=document.createElement('canvas');cv.width=cv.height=900;render(t,cv);
  return new Promise(res=>cv.toBlob(b=>{if(b&&b.type==='image/webp')return res(b);cv.toBlob(res,'image/png')},'image/webp',.92));
 }
 file.addEventListener('change',async()=>{
  const f=file.files?.[0];file.value='';if(!f)return;msg.textContent='写真を読み込み中…';
  try{st.src=await loadImage(f)}catch{msg.textContent='この写真は読み込めませんでした。別の写真を選んでください。';return}
  st.bright=st.contrast=st.sat=100;fit(true);draw();drawThumbs();updatePick();
  if(cur==='back')clearBack.hidden=onlyBack;
  // 表を合わせたら裏へ進めるように案内する
  if(cur==='front'&&!onlyBack&&!sides.back.src)msg.textContent+=' 裏も撮るときは「裏（任意）」を押してください。';
 });
 // ドラッグで移動、2本指で拡大・回転
 const pts=new Map();let last=null;
 const pair=()=>{const [a,b]=[...pts.values()];return {d:Math.hypot(b.x-a.x,b.y-a.y),a:Math.atan2(b.y-a.y,b.x-a.x),x:(a.x+b.x)/2,y:(a.y+b.y)/2}};
 const pan=(dx,dy)=>{const c=Math.cos(-st.rot),s=Math.sin(-st.rot);st.cx-=(dx*c-dy*s)/st.k;st.cy-=(dx*s+dy*c)/st.k};
 stage.addEventListener('pointerdown',e=>{if(!st.src)return;stage.setPointerCapture(e.pointerId);pts.set(e.pointerId,{x:e.clientX,y:e.clientY});last=pts.size===2?pair():null});
 stage.addEventListener('pointermove',e=>{if(!pts.has(e.pointerId))return;const p=pts.get(e.pointerId);
  if(pts.size===1){pan(e.clientX-p.x,e.clientY-p.y);pts.set(e.pointerId,{x:e.clientX,y:e.clientY})}
  else{pts.set(e.pointerId,{x:e.clientX,y:e.clientY});const n=pair();if(last){st.k*=n.d/last.d;st.rot+=n.a-last.a;pan(n.x-last.x,n.y-last.y)}last=n;syncSliders()}
  draw()});
 const up=e=>{pts.delete(e.pointerId);last=pts.size===2?pair():null;drawThumbs()};
 stage.addEventListener('pointerup',up);stage.addEventListener('pointercancel',up);
 stage.addEventListener('wheel',e=>{if(!st.src)return;e.preventDefault();st.k*=Math.exp(-e.deltaY*.0015);syncSliders();draw();drawThumbs()},{passive:false});
 stage.addEventListener('keydown',e=>{const m={ArrowLeft:[-8,0],ArrowRight:[8,0],ArrowUp:[0,-8],ArrowDown:[0,8]}[e.key];if(!m||!st.src)return;e.preventDefault();pan(...m);draw();drawThumbs()});
 panel.addEventListener('input',e=>{if(e.target.type==='range')drawThumbs()});
 stage.tabIndex=0;
 new ResizeObserver(()=>draw()).observe(stage);

 save.addEventListener('click',async()=>{
  if(!existing&&!candidate&&!label.value.trim()){msg.textContent='候補にないメダルは名前を入れてください。';label.focus();return}
  save.disabled=true;cancel.disabled=true;save.textContent='保存中…';msg.textContent='';
  const uploaded=[];
  try{
   const put1=async t=>{const b=await output(t);if(!b)throw {code:'render'};const r=await COL.assets.upload(b,{type:b.type});uploaded.push(r.id);return r.id};
   if(existing){
    const backId=await put1(sides.back);
    await COL.db.doc('collection/'+existing.id).update({back:backId});
    if(existing.back)try{await COL.assets.delete(existing.back)}catch{}
   }else{
    const photo=await put1(sides.front);const back=sides.back.src?await put1(sides.back):null;
    await COL.db.collection('collection').add({candidate_id:candidate?.id??null,candidate_name:candidate?.name??(place.value.trim()||null),pref:candidate?.pref??null,
     label:label.value.trim()||null,acquired:acquired.value||null,note:note.value.trim()||null,photo,back,shape,created_at:new Date().toISOString()});
   }
   close();
  }catch(e){
   // 記録まで済まなかった写真は、どこからも指されないので消しておく
   for(const id of uploaded)try{await COL.assets.delete(id)}catch{}
   msg.textContent=errText(e);save.disabled=false;cancel.disabled=false;save.textContent='保存'}
 });
 draw();
}
initCollection();

route(location.hash);
document.getElementById('built').textContent=fmt(D.generated_at);

}
// ===== ホーム画面アプリの入口（合言葉で実データを開く） =====
// 未審査の実データは合言葉で暗号化した data.bin として置く（AES-GCM、鍵は合言葉から PBKDF2-SHA256 で作る）。
// 合言葉は最初の1回だけ入れ、この端末に覚えておく。「ロックする」で忘れさせる。
const shell=document.getElementById('public-root');
const PASS_KEY='medal-pass';
let BACKEND={};
function el(tag,attrs={},...kids){const e=document.createElement(tag);for(const [k,v] of Object.entries(attrs)){if(v==null||v===false)continue;if(k.startsWith('on'))e.addEventListener(k.slice(2),v);else if(k==='text')e.textContent=v;else if(k==='class')e.className=v;else e.setAttribute(k,v===true?'':v)}e.append(...kids.filter(Boolean));return e}
const say=(...kids)=>shell.replaceChildren(...kids);
const normPass=s=>String(s).toLowerCase().replace(/[^a-z0-9]/g,'');
const store={get:k=>{try{return localStorage.getItem(k)}catch{return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch{}},del:k=>{try{localStorage.removeItem(k)}catch{}}};

// data.bin：'MDL1'・繰り返し回数(4バイト)・salt(16)・iv(12)・暗号文（末尾に認証タグ）
let encrypted=null;
async function unlock(pass){
 encrypted??=await fetch('data.bin').then(r=>{if(!r.ok)throw {code:'fetch'};return r.arrayBuffer()}).catch(()=>{throw {code:'fetch'}});
 const b=new Uint8Array(encrypted);
 if(String.fromCharCode(...b.slice(0,4))!=='MDL1')throw {code:'format'};
 const iter=new DataView(encrypted).getUint32(4),salt=b.slice(8,24),iv=b.slice(24,36),body=b.slice(36);
 const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(normPass(pass)),'PBKDF2',false,['deriveKey']);
 const key=await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:iter},base,{name:'AES-GCM',length:256},false,['decrypt']);
 let plain;try{plain=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,body)}catch{throw {code:'wrong'}}
 return JSON.parse(new TextDecoder().decode(plain));
}

async function boot(){
 if(!window.crypto?.subtle||!window.indexedDB)return say(el('div',{class:'block'},el('h1',{text:'このブラウザでは開けません'}),el('p',{text:'iPhoneのSafariで https のURLを開いてください。'})));
 const saved=store.get(PASS_KEY);
 if(saved){say(el('p',{class:'muted',text:'読み込み中…'}));try{return enter(await unlock(saved))}catch(e){if(e?.code!=='wrong')return showFail()}store.del(PASS_KEY)}
 showPass();
}
function showPass(){
 const pass=el('input',{type:'password',id:'pass',autocomplete:'current-password',autocapitalize:'off',spellcheck:'false',required:true});
 const msg=el('p',{class:'crop-msg',role:'status'});
 const ok=el('button',{type:'submit',class:'btn primary',text:'開く'});
 const form=el('form',{class:'block login'},el('h1',{text:'合言葉'}),
  el('p',{class:'muted small',text:'最初の1回だけ合言葉を入れてください。この端末では次から入れずに開けます。'}),
  el('div',{class:'fields'},el('label',{for:'pass',text:'合言葉'}),pass),msg,el('p',{},ok));
 form.addEventListener('submit',async ev=>{ev.preventDefault();ok.disabled=true;msg.textContent='確かめています…';
  try{const d=await unlock(pass.value);store.set(PASS_KEY,pass.value);enter(d)}
  catch(e){msg.textContent=e?.code==='wrong'?'合言葉が違います。':'データを読み込めません。通信状況を確かめてください。';ok.disabled=false}});
 say(form);pass.focus();
}
function showFail(){
 say(el('div',{class:'block'},el('h1',{text:'データを読み込めません'}),el('p',{text:'通信状況を確かめてください。'}),
  el('p',{},el('button',{type:'button',class:'btn primary',text:'もう一度読み込む',onclick:boot}))));
}
function enter(data){
 BACKEND=makeLocalBackend();
 navigator.storage?.persist?.().catch(()=>{});
 const lock=document.getElementById('lock');lock.hidden=false;
 lock.onclick=()=>{store.del(PASS_KEY);location.replace(location.pathname)};
 document.getElementById('foot-info').hidden=false;
 startApp(data);
}
if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
boot();
