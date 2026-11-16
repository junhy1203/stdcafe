'use strict';

// Unofficial self-hosted read-only web client. Live data is fetched only after the user logs in.
// Demo data is clearly marked; when live extraction fails no sample values are substituted.
const demoSeats = Array.from({length:30}, (_,i) => ({
  id: `A${String(i+1).padStart(2,'0')}`,
  status: i === 11 ? 'mine' : ([2,5,8,9,15,16,19,20,23,28].includes(i) ? 'occupied' : ([4,26].includes(i) ? 'disabled' : 'available'))
}));
const demo = {
  store: {name:'샘플 스터디카페', address:'예시 데이터 · 실제 매장이 아닙니다'},
  member: {seat:'A12', seatDetail:'자유석 · A구역', ticket: {name:'시간권', remainingMinutes: 385, totalMinutes:900}},
  seats:demoSeats,
  updatedAt:null
};

const statusNames = {available:'이용 가능', occupied:'사용 중', mine:'내 좌석', disabled:'사용 불가', unknown:'상태 미확인'};
// Never show fictitious seats or remaining time by default. Sample data is opt-in only.
const emptyData = {
  store:{name:'매장 정보 미확인',address:'로그인 후 서버 조회가 필요합니다.'},
  member:{seat:null,seatDetail:'',ticket:{name:'이용권 정보',remainingMinutes:null,totalMinutes:null}},
  seats:[],updatedAt:null
};
let state = {data:emptyData, origin:'unlinked', endpoint:null, selectedSeat:null, currentView:'home'};
let csrfToken = '';
let liveAuthenticated = false;
let liveAvailability = null;
let seatLayoutMeta = null;
let seatLayoutRequested = false;
const $ = id => document.getElementById(id);
let toastTimer;
function toast(message) {
  const el = $('toast');el.textContent=message;el.classList.add('visible');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),3500);
}
function safeDate(v){ if(!v) return '—'; const d=new Date(v);return Number.isNaN(d.getTime())?'—':new Intl.DateTimeFormat('ko-KR',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(d); }
function safeNum(value,cap=999999){if(!Number.isFinite(Number(value)))return 0;return Math.max(0,Math.min(cap,Math.floor(Number(value))));}
function minutesText(v){if(v===null || v===undefined || v==='')return '—';const n=safeNum(v);if(n>=60)return `${Math.floor(n/60)}시간 ${n%60}분`;return `${n}분`;}
function setText(id,txt){$(id).textContent=String(txt);}
function normalize(input){
  if(!input || typeof input !== 'object' || !input.store || !input.member || !Array.isArray(input.seats)) throw Error('store, member, seats 배열이 필요합니다. sample-data.json을 참고해 주세요.');
  if(!input.member.ticket || typeof input.member.ticket !== 'object') throw Error('member.ticket에 이용권 정보가 있어야 합니다.');
  if(input.seats.length>500) throw Error('좌석은 최대 500개까지 지원합니다.');
  const validStatuses = ['available','occupied','mine','disabled','unknown'];
  const seats = input.seats.map((s,i)=>{
    if(!s || typeof s.id!=='string' || !validStatuses.includes(s.status)) throw Error(`${i+1}번째 좌석 데이터가 올바르지 않습니다.`);
    return {id:s.id.slice(0,30),status:s.status,
      x:Number.isFinite(Number(s.x))&&s.x!==null?Number(s.x):null,
      y:Number.isFinite(Number(s.y))&&s.y!==null?Number(s.y):null};
  });
  const t=input.member.ticket;
  return {
    store:{name:String(input.store.name||'매장 정보 없음').slice(0,100),address:String(input.store.address||'').slice(0,200)},
    member:{seat:String(input.member.seat||'—').slice(0,30),seatDetail:String(input.member.seatDetail||'').slice(0,100),ticket:{name:String(t.name||'이용권').slice(0,50),remainingMinutes:t.remainingMinutes===null || t.remainingMinutes===undefined ? null:safeNum(t.remainingMinutes),totalMinutes:t.totalMinutes===null || t.totalMinutes===undefined ? null:safeNum(t.totalMinutes)}},
    seats,updatedAt:input.updatedAt||null
  };
}
function buildSeats(containerId){
  const parent=$(containerId);parent.replaceChildren();
  parent.classList.remove('physical-floor-plan');
  const seats=state.data.seats;
  if(!seats.length){
    const info=document.createElement('p');info.className='empty-seats';
    info.textContent='공식 서버에서 좌석별 번호·상태를 아직 확인하지 못했습니다. 좌석 현황의 개별 좌석 조회 버튼으로 확인해 주세요.';
    parent.appendChild(info);return;
  }
  const spatial=containerId==='seat-map-full'&&seatLayoutMeta?.actualPositions;
  const points=seats.filter(t=>t.x!==null&&t.y!==null);
  const minx=Math.min(...points.map(t=>t.x)),maxx=Math.max(...points.map(t=>t.x));
  const miny=Math.min(...points.map(t=>t.y)),maxy=Math.max(...points.map(t=>t.y));
  if(spatial&&maxx>minx&&maxy>miny)parent.classList.add('physical-floor-plan');
  const fragment=document.createDocumentFragment();
  const items=containerId==='seat-map-home'&&seats.length>48?seats.slice(0,48):seats;
  for(const seat of items){
    const b=document.createElement('button');
    b.type='button';
    b.className=`seat ${seat.status}${state.selectedSeat===seat.id?' selected':''}`;
    b.textContent=seat.id;
    b.title=`${seat.id} · ${statusNames[seat.status]||'상태 미확인'}`;
    b.setAttribute('aria-label',b.title);
    if(parent.classList.contains('physical-floor-plan')&&seat.x!==null&&seat.y!==null){
      b.style.left=(5+(seat.x-minx)/(maxx-minx)*90).toFixed(3)+'%';
      b.style.top=(5+(seat.y-miny)/(maxy-miny)*85).toFixed(3)+'%';
    }
    b.addEventListener('click',()=>{
      state.selectedSeat=seat.id;
      const el=$('seat-detail');
      el.textContent=`${seat.id} · ${statusNames[seat.status]||'상태 미확인'}${state.origin==='demo'?' (예시 데이터)':''} — 보기 전용이며 예약·입실 요청은 보내지 않습니다.`;
      buildSeats('seat-map-full');
      if(containerId==='seat-map-home')navigate('seats');
    });
    fragment.appendChild(b);
  }
  parent.appendChild(fragment);
}
function render(){
  const d=state.data,t=d.member.ticket, seats=d.seats;
  const nAvailable=seats.filter(s=>s.status==='available').length, nOccupied=seats.filter(s=>s.status==='occupied').length;
  const ratio=t.totalMinutes>0?Math.max(0,Math.min(100,t.remainingMinutes/t.totalMinutes*100)):0;
  setText('my-seat',d.member.seat||'—');setText('my-seat-detail',d.member.seatDetail||d.store.name||'');
  setText('my-seat-status',d.member.seat==='—'?'좌석 미지정':'현재 좌석 정보');
  setText('time-left',minutesText(t.remainingMinutes));setText('ticket-name',t.name);
  $('time-progress').style.width=ratio+'%';
  const aggregate=(state.origin==='live' && liveAvailability)?liveAvailability.personal:null;
  const knownFree=aggregate && Number.isInteger(aggregate.available)?aggregate.available:null;
  setText('available-count',knownFree!==null?knownFree+'석':seats.length?nAvailable+'석':'—');
  setText('available-detail',knownFree!==null?'개인석 전체 '+aggregate.total+'석 · 이용 중 '+aggregate.used+'석':seats.length?'전체 '+seats.length+'석 중 이용 가능':'좌석별 이용 현황 미확인');
  const unknown=seats.filter(s=>s.status==='unknown').length;
  setText('map-summary',seats.length
    ?'실제 좌석 '+seats.length+'개 · 빈 좌석 '+nAvailable+'개 · 이용 중 '+nOccupied+'개'+(unknown?' · 상태 미확인 '+unknown+'개':'')
    :'개별 좌석 위치·상태 미조회 · 상단의 현재 매장 집계값과 별개입니다.');
  setText('store-name',d.store.name);setText('store-address',d.store.address);
  setText('last-update',state.origin==='demo'?'예시':safeDate(d.updatedAt));
  setText('seat-available-total',knownFree!==null?knownFree:seats.length?nAvailable:'—');
  setText('seat-occupied-total',aggregate&&Number.isInteger(aggregate.used)?aggregate.used:seats.length?nOccupied:'—');
  setText('seats-store-name',d.store.name+(seatLayoutMeta?.floorNo?' · '+seatLayoutMeta.floorNo+'층':''));
  setText('pass-title',t.name);setText('pass-left',minutesText(t.remainingMinutes));setText('pass-total',minutesText(t.totalMinutes));
  $('pass-bar').style.width=ratio+'%';setText('pass-store',d.store.name);
  setText('pass-seat',d.member.seat||'—');setText('pass-updated',state.origin==='demo'?'예시 데이터':safeDate(d.updatedAt));
  setText('pass-source',state.origin==='demo'?'샘플':state.origin==='file'?'사용자 불러오기':state.origin==='live'?'쌤카페 앱 API 및 회원 페이지':'사용자 API');
  setText('today',new Intl.DateTimeFormat('ko-KR',{year:'numeric',month:'long',day:'numeric',weekday:'short'}).format(new Date()));
  const views = {
    demo:['예시 데이터', '예시 화면입니다.', '실제 매장·이용권 정보가 아닌 샘플입니다.'],
    file:['불러온 데이터', '직접 가져온 데이터입니다.', '파일이 최신인지 확인하세요.'],
    live:['서버 조회', '서버 조회 결과입니다.', '확인 가능한 실제 값만 표시하며 알 수 없는 값은 —로 둡니다.'],
    error:['조회 실패', '서버 데이터 조회에 실패했습니다.', '로그인 성공은 좌석·이용권 조회 성공이 아닙니다. 설정의 오류 메시지와 페이지 조회 결과를 확인하세요.'],
    unlinked:['미연결', '실제 데이터가 연결되지 않았습니다.', '설정에서 쌤카페 계정으로 로그인해 주세요.'],
    api:['API 조회', '사용자 API 데이터입니다.', '입력한 API의 응답입니다.']
  };
  const view=views[state.origin]||views.unlinked;
  $('mode-pill').className=`mode-pill${state.origin==='demo'?'':' imported'}`;
  $('mode-pill').innerHTML=`<span class="pill-dot"></span>${view[0]}`;
  const notice=$('notice-text');notice.replaceChildren();
  const strong=document.createElement('strong');strong.textContent=view[1];
  notice.append(strong,document.createTextNode(' '+view[2]));
  buildSeats('seat-map-home');buildSeats('seat-map-full');
  renderAvailabilityCounters();
}

function renderAvailabilityCounters(){
  const parent=$('availability-counters');if(!parent)return;
  parent.replaceChildren();
  const groups=[['personal','개인석'],['group','스터디룸'],['locker','사물함']];
  for(const [key,label] of groups){
    const item=document.createElement('div');item.className='availability-counter';
    const title=document.createElement('strong');title.textContent=label;
    const a=liveAvailability?.[key];
    const quantity=document.createElement('div');quantity.className='availability-number';
    quantity.textContent=state.origin==='live'&&Number.isInteger(a?.available)?a.available+'개 이용 가능':'—';
    const detail=document.createElement('p');
    detail.textContent=state.origin==='live'&&Number.isInteger(a?.total)&&Number.isInteger(a?.used)
      ?'전체 '+a.total+'개 · 사용 중 '+a.used+'개'
      :'앱 홈에서 집계값을 확인하지 못했습니다.';
    item.append(title,quantity,detail);parent.append(item);
  }
  setText('seat-count-source',state.origin==='live'&&liveAvailability?.confirmedShop
    ?'현재 연동 매장 · 앱 홈에서 조회한 집계 ('+safeDate(liveAvailability.fetchedAt)+')'
    :'매장 및 현재 좌석 집계 확인 필요 · 개별 좌석 번호는 아직 미지원');
}

function navigate(target){
  if(!['home','seats','tickets','diagnostics'].includes(target))return;
  state.currentView=target;
  const names={home:'대시보드',seats:'좌석 현황',tickets:'이용권 정보',diagnostics:'진단 모드'};
  for(const item of document.querySelectorAll('[data-view]')){if(item.classList.contains('nav-item'))item.classList.toggle('active',item.dataset.view===target);}
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${target}`));
  setText('breadcrumb',names[target]);window.scrollTo(0,0);
  if(target==='seats'&&liveAuthenticated&&!seatLayoutRequested)loadSeatLayout();
}
function showModal(){ $('modal-error').hidden=true;$('modal-overlay').hidden=false;$('data-file').focus(); }
function hideModal(){ $('modal-overlay').hidden=true; }
function modalError(message){ $('modal-error').textContent=message;$('modal-error').hidden=false; }
function updateData(raw,origin){
  seatLayoutMeta=null;seatLayoutRequested=false;state.data=normalize(raw);state.origin=origin;state.selectedSeat=null;render();if(origin!=='live')clearLiveSources();hideModal();toast('조회 데이터를 화면에 반영했습니다.');
}
for(const btn of document.querySelectorAll('[data-view]')) btn.addEventListener('click',()=>navigate(btn.dataset.view));
for(const id of ['settings','settings-nav','connect-cta']) $(id).addEventListener('click',showModal);
for(const id of ['close-modal','dismiss-modal']) $(id).addEventListener('click',hideModal);
$('modal-overlay').addEventListener('click',e=>{if(e.target===$('modal-overlay'))hideModal();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')hideModal();});
$('restore-demo').addEventListener('click',()=>{liveAvailability=null;seatLayoutMeta=null;seatLayoutRequested=false;state={...state,data:demo,origin:'demo',selectedSeat:null,endpoint:null};$('endpoint-url').value='';render();hideModal();toast('예시 데이터로 돌아왔습니다.');});
$('data-file').addEventListener('change', async e=>{
  const f=e.target.files?.[0];if(!f)return;
  if(f.size>1_000_000){modalError('파일은 1MB 이하만 지원합니다.');return;}
  try{const data=JSON.parse(await f.text());updateData(data,'file');}catch(err){modalError(`JSON 데이터를 읽지 못했습니다: ${err.message}`);}finally{e.target.value='';}
});
async function fromEndpoint(){
  const raw=$('endpoint-url').value.trim();
  if(!raw){modalError('API 주소를 입력해 주세요.');return;}
  let u;try{u=new URL(raw);}catch{modalError('올바른 URL을 입력해 주세요.');return;}
  if(u.protocol!=='https:' && !(u.protocol==='http:' && ['localhost','127.0.0.1'].includes(u.hostname))){modalError('HTTPS 또는 localhost HTTP 주소만 허용합니다.');return;}
  if(u.username || u.password || u.search){modalError('주소에 사용자명·비밀번호·쿼리 토큰을 포함할 수 없습니다.');return;}
  $('fetch-endpoint').disabled=true;$('fetch-endpoint').textContent='조회 중…';
  try{
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),12000);
    let resp;try{resp=await fetch(u.href,{method:'GET',mode:'cors',credentials:'omit',cache:'no-store',headers:{'Accept':'application/json'},signal:controller.signal});}finally{clearTimeout(timeout);}
    if(!resp.ok)throw Error(`HTTP ${resp.status}`);
    if(!String(resp.headers.get('content-type')||'').includes('application/json'))throw Error('JSON 응답이 아닙니다.');
    const txt=await resp.text();if(txt.length>1_000_000)throw Error('응답 크기가 너무 큽니다.');
    updateData(JSON.parse(txt),'api');state.endpoint=u.href;
  }catch(err){modalError(`연결 실패: ${err.message}. 인증·CORS 또는 주소를 확인하세요.`);}
  finally{$('fetch-endpoint').disabled=false;$('fetch-endpoint').textContent='불러오기';}
}
$('fetch-endpoint').addEventListener('click',fromEndpoint);
$('refresh').addEventListener('click',()=>{if(state.origin==='live' && liveAuthenticated){fetchLive();return;}if(state.endpoint){$('endpoint-url').value=state.endpoint;fromEndpoint();}else{toast('실시간 연결이 없습니다. 설정에서 JSON 파일이나 API를 연결해 주세요.');}});
// Self-hosted authenticated read-only server integration.
const sourceNames = {profile:'내 정보',seats:'좌석 현황',tickets:'이용권 정보',history:'이용 내역'};
const liveBlank = () => ({store:{name:'매장 정보 미확인',address:'서버 데이터에서 매장명을 확인하지 못했습니다.'},member:{seat:null,seatDetail:'',ticket:{name:'이용권 정보',remainingMinutes:null,totalMinutes:null}},seats:[],updatedAt:null});
// Older Safari HTML can remain cached after the server updates app.js.
// Rebuild the display container when an old HTML shell lacks the new section.
function ensureStructuredPanel(){
  let panel=$('structured-home-panel');
  if(panel && $('structured-stores') && $('structured-tickets'))return panel;
  const home=$('view-home');
  if(!home)return null;
  if(panel)panel.remove();
  panel=document.createElement('section');
  panel.id='structured-home-panel';
  panel.className='panel live-panel';
  panel.hidden=true;
  const title=document.createElement('div');
  title.className='panel-title';
  const intro=document.createElement('div');
  const heading=document.createElement('h2');heading.textContent='앱 홈에서 조회한 매장·이용권';
  const caption=document.createElement('p');caption.textContent='현재 매장과 최근 이용 매장을 구분해 표시합니다.';
  intro.append(heading,caption);title.append(intro);panel.append(title);
  const cols=document.createElement('div');cols.className='structured-columns';
  for(const [id,label] of [['structured-stores','현재·최근 이용 매장'],['structured-tickets','확인된 이용권']]){
    const group=document.createElement('div'),h=document.createElement('h3'),list=document.createElement('div');
    h.textContent=label;list.id=id;list.className='structured-items';
    group.append(h,list);cols.append(group);
  }
  panel.append(cols);
  const before=$('live-panel');
  if(before && before.parentNode===home)home.insertBefore(panel,before);
  else home.append(panel);
  return panel;
}
function clearLiveSources(){
  const panel=ensureStructuredPanel();
  if(panel)panel.hidden=true;
  $('structured-stores')?.replaceChildren();
  $('structured-tickets')?.replaceChildren();
  for(const id of ['live-panel','live-seat-panel','live-ticket-panel'])$(id).hidden=true;
  for(const id of ['live-sources','live-seat-source','live-ticket-source'])$(id).replaceChildren();
}
function sourceBlock(kind,source){
  const wrap=document.createElement('article');wrap.className='source-item';
  const h=document.createElement('h3');h.textContent=sourceNames[kind]||kind;wrap.appendChild(h);
  if(!source || !source.ok){const p=document.createElement('p');p.className='source-error';p.textContent='조회 실패: '+(source?.error||'응답 없음');wrap.appendChild(p);return wrap;}
  const pre=document.createElement('pre');pre.textContent=source.text||'(서버에서 확인 가능한 표시 텍스트가 없습니다.)';wrap.appendChild(pre);
  return wrap;
}

function structuredRow(parent,title,detail){
  const item=document.createElement('article');item.className='structured-item';
  const strong=document.createElement('strong');strong.textContent=title||'이름 미확인';
  const info=document.createElement('p');info.textContent=detail||'추가 정보 없음';
  item.append(strong,info);parent.appendChild(item);
}
function renderStructured(live){
  const panel=ensureStructuredPanel();
  if(!panel)return false;
  const current=live?.currentShop||{};
  const recent=Array.isArray(live?.recentShops)?live.recentShops:[];
  const passes=Array.isArray(live?.ticketItems)?live.ticketItems:[];
  const storesEl=$('structured-stores'), passesEl=$('structured-tickets');
  storesEl.replaceChildren();passesEl.replaceChildren();
  const seen=new Set();
  if(current.name){
    structuredRow(storesEl,current.name,'앱 홈에서 확인된 현재 매장');
    seen.add(current.shopNo||current.name);
  }
  for(const v of recent){
    const key=v.shopNo||v.name;
    if(key&&seen.has(key))continue;
    if(key)seen.add(key);
    structuredRow(storesEl,v.name||'매장명 없음','최근 이용 · '+(v.goodsName||'이용권명 미확인')+(v.remainingRaw?' · 잔여값 원문 '+v.remainingRaw:''));
  }
  for(const p of passes){
    const detail=[p.shopName,p.remainingPeriod?'잔여기간 원문 '+p.remainingPeriod:'',p.seatState?'좌석 상태 '+p.seatState:''].filter(Boolean).join(' · ');
    structuredRow(passesEl,p.goodsName||'이용권명 미확인',detail);
  }
  if(!passes.length){
    for(const r of recent.filter(v=>v.goodsName)){
      structuredRow(passesEl,r.goodsName,'최근 이용 내역 · '+(r.name||'매장 미확인')+(r.remainingRaw?' · 잔여값 원문 '+r.remainingRaw:''));
    }
  }
  if(!storesEl.children.length)structuredRow(storesEl,'매장 정보 없음','앱 홈 API에서 매장명이나 최근 이용 매장이 확인되지 않았습니다.');
  if(!passesEl.children.length)structuredRow(passesEl,'이용권 정보 없음','앱 이용권 API에서 항목이 확인되지 않았습니다.');
  panel.hidden=false;
  return true;
}

function showLiveSources(sources){
  clearLiveSources();
  $('live-panel').hidden=false;
  const parent=$('live-sources');
  for(const [kind,source] of Object.entries(sources||{}))parent.appendChild(sourceBlock(kind,source));
  $('live-seat-panel').hidden=false;
  $('live-seat-source').appendChild(sourceBlock('seats',sources?.seats));
  $('live-ticket-panel').hidden=false;
  $('live-ticket-source').appendChild(sourceBlock('tickets',sources?.tickets));
}
function bridgeStatus(msg){setText('bridge-status',msg);}
function lookupSummary(msg){const el=$('lookup-summary');if(el)el.textContent=msg;}
function bridgeError(msg){$('bridge-error').textContent=msg;$('bridge-error').hidden=false;}
function clearBridgeError(){$('bridge-error').hidden=true;}
async function requestJson(url,options={}){
  const r=await fetch(url,{credentials:'same-origin',cache:'no-store',...options});
  const obj=await r.json().catch(()=>null);
  if(!r.ok)throw Error(obj?.detail||`요청 실패: HTTP ${r.status}`);
  if(!obj)throw Error('JSON 응답이 아닙니다. 서버가 실행 중인지 확인해 주세요.');
  return obj;
}

const loginStageNames = {
  started:'로그인 요청 시작',
  rate_limited:'연속 로그인 제한에 도달',
  connecting_to_upstream:'쌤카페 서버에 로그인 요청 전송 중',
  upstream_connection_failed:'쌤카페 서버 연결 실패',
  upstream_responded:'쌤카페 서버가 응답함',
  upstream_response_unrecognized:'로그인 응답 구조를 인식하지 못함',
  upstream_rejected:'쌤카페 서버에서 0000이 아닌 응답 코드를 반환함',
  success_code_missing:'응답에 rspcode 성공 코드가 없음',
  additional_auth_required:'앱 추가 인증 또는 기기 등록이 필요할 가능성',
  authenticated:'로그인 API 인증 성공'
};
function loginTraceText(attempt){
  if(!attempt)return '이번 서버 실행 중 로그인 요청 기록이 없습니다.';
  const stage=loginStageNames[attempt.stage]||'알 수 없는 로그인 처리 단계';
  const info=[];
  if(attempt.upstreamCode!==null)info.push('rspcode: '+attempt.upstreamCode);
  else if(attempt.codeLocation==='missing')info.push('rspcode: 없음');
  if(attempt.codeLocation)info.push('코드 위치: '+({result:'result 내부',outer:'바깥 응답',missing:'확인되지 않음'}[attempt.codeLocation]||attempt.codeLocation));
  if(attempt.rescode)info.push('rescode: '+attempt.rescode);
  if(attempt.resultType)info.push('result 형식: '+attempt.resultType);
  if(attempt.resultKeys?.length)info.push('result 필드: '+attempt.resultKeys.join(', '));
  if(attempt.outerKeys?.length)info.push('바깥 필드: '+attempt.outerKeys.join(', '));
  if(attempt.secondFactorAccepted!==null)info.push('추가 인증 조건: '+(attempt.secondFactorAccepted?'충족':'미충족'));
  if(attempt.tokenProvided!==null)info.push('인증 토큰 발급: '+(attempt.tokenProvided?'확인':'확인되지 않음'));
  return stage+(info.length?' · '+info.join(' · '):'');
}
const diagNames = {profile:'내 정보',seats:'좌석 현황',tickets:'이용권',history:'이용 내역'};
function setDiagFeedback(message){setText('diagnostics-feedback',message);}
function showDiagnosticResult(data, sessionResponse){
  setText('diagnostics-version',data.version||'확인 불가');
  setText('diagnostics-auth',data.authenticated?'로그인됨':'로그인 안 됨');
  const last=data.lastCheck;
  setText('diagnostics-loaded',last?.summary ? String(last.summary.pagesLoaded)+'/4개' : '조회 기록 없음');
  setText('diagnostics-time',last?.checkedAt?safeDate(last.checkedAt):'—');
  const parent=$('diagnostics-pages');parent.replaceChildren();
  const seatDiag=data.seatPage;
  const seatItem=document.createElement('div');seatItem.className='diagnostics-page-item';
  const seatHeading=document.createElement('strong');seatHeading.textContent='개별 좌석 화면 / 추가 API 분석';
  const seatText=document.createElement('span');
  if(!seatDiag){
    seatText.textContent='아직 개별 좌석 화면을 조회하지 않았습니다. 좌석 현황 → 개별 좌석 상태 조회를 눌러 주세요.';
  }else{
    const summary=seatDiag.summary;
    const apiPaths=seatDiag.detectedReadApis||[];
    const scripts=seatDiag.detectedScripts||[];
    const parts=[
      '매장 좌석 화면: '+(seatDiag.source||'개별 데이터 미확인'),
      summary?'좌석번호 '+summary.count+'개 · 이용 가능 '+summary.available+'개 · 사용 중 '+summary.occupied+'개':'좌석별 데이터 없음',
      '공식 페이지 JS '+scripts.length+'개',
      '좌석 관련 읽기 전용 API 후보 '+apiPaths.length+'개'
    ];
    if(apiPaths.length)parts.push('후보 경로: '+apiPaths.join(', '));
    if(seatDiag.requestHints?.length)parts.push('페이지에서 확인된 실제 요청 방법: '+seatDiag.requestHints.map(h=>h.path+' '+h.method).join(', '));
    const tries=seatDiag.attempts||[];
    for(const t of tries){
      const detail=[
        t.name==='personal'?'개인석 조회 화면':t.name==='enter'?'입실 화면':t.name==='change'?'자리이동 화면':t.name,
        t.error||'확인된 좌석 '+(t.summary?.count??0)+'개',
        t.htmlCharacters!==null&&t.htmlCharacters!==undefined?'HTML '+t.htmlCharacters+'자':'',
        t.redirects?.length?'화면 이동: '+t.redirects.join(' → '):'',
        t.finalPath?'최종 경로: '+t.finalPath:''
      ].filter(Boolean).join(' · ');
      parts.push(detail);
    }
    seatText.textContent=parts.join(' / ');
  }
  seatItem.append(seatHeading,seatText);parent.appendChild(seatItem);
  const loginItem=document.createElement('div');loginItem.className='diagnostics-page-item';
  const loginTitle=document.createElement('strong');loginTitle.textContent='최근 로그인 시도';
  const loginText=document.createElement('span');loginText.textContent=loginTraceText(data.lastLogin);
  loginItem.append(loginTitle,loginText);parent.appendChild(loginItem);
  const cookieInfo = sessionResponse?.session || data.session;
  const cookieStatus = document.createElement('div');cookieStatus.className='diagnostics-page-item';
  const cookieTitle=document.createElement('strong');cookieTitle.textContent='브라우저 세션 쿠키';
  const cookieText=document.createElement('span');
  cookieText.textContent = !cookieInfo ? '세션 정보 없음'
    : !cookieInfo.cookieSent ? '이전 쿠키가 전달되지 않음 (처음 접속 또는 쿠키 차단/삭제 가능)'
    : cookieInfo.cookieRecognized ? '서버가 현재 쿠키를 인식함' : '이전 쿠키가 현재 서버에서 유효하지 않음 (서버 재시작·만료 가능)';
  cookieStatus.append(cookieTitle,cookieText);parent.appendChild(cookieStatus);
  const boot=document.createElement('div');boot.className='diagnostics-page-item';
  const bootTitle=document.createElement('strong');bootTitle.textContent='웹서버 시작';
  const bootText=document.createElement('span');bootText.textContent=cookieInfo?.serverStartedAt?safeDate(cookieInfo.serverStartedAt):'확인할 수 없음';
  boot.append(bootTitle,bootText);parent.appendChild(boot);
  if(!data.authenticated){
    setDiagFeedback(data.lastLogin ? '계정 인증이 완료되지 않았습니다. 아래 최근 로그인 시도에서 어느 단계가 실패했는지 확인해 주세요.' : '이 서버 실행 중 로그인 요청 기록이 없습니다. 설정에서 로그인해 주세요.');
  }else if(!last){
    setDiagFeedback('로그인 상태는 확인됐지만 회원정보 조회 기록이 없습니다. 회원 데이터 다시 조회를 눌러 보세요.');
  }else{
    setDiagFeedback('로그인 확인 · 회원 페이지 '+(last.summary?.pagesLoaded??0)+'/4개 수신');
  }
  if(!last){
    setText('diagnostics-extraction','좌석·잔여시간 조회 기록 없음');
    return;
  }
  setText('diagnostics-extraction','현재 매장: '+(last.summary?.shopFound?'확인':'미확인')+' · 이용권: '+(last.summary?.ticketFound?'확인':'미확인')+' · 좌석 번호: '+(last.summary?.seatFound?'확인':'미확인')+' · 잔여시간: '+(last.summary?.remainingTimeFound?'확인':'미확인')+' · 좌석 배치: '+(last.summary?.seatLayoutFound?'확인':'미확인'));
  for(const [key,label] of [['home','홈/매장 API 1100'],['goods','이용권 API 1101']]){
    const item=document.createElement('div');item.className='diagnostics-page-item';
    const h=document.createElement('strong');h.textContent=label;
    const info=document.createElement('span');const api=last.apis?.[key];
    info.textContent=!api?'조회 기록 없음':api.ok?'앱 API 응답 성공':'앱 API 실패: '+(api.reason||'원인 미확인');
    item.append(h,info);parent.appendChild(item);
  }
  for(const kind of ['profile','seats','tickets','history']){
    const page=last.pages?.[kind];
    const item=document.createElement('div');item.className='diagnostics-page-item';
    const heading=document.createElement('strong');heading.textContent=diagNames[kind]||kind;
    const info=document.createElement('span');
    info.textContent=!page?'조회 기록 없음':page.ok?'응답 있음 · 표시 텍스트 '+(page.characters||0)+'자':'조회 실패 · '+(page.reason||'원인 미확인');
    item.append(heading,info);parent.appendChild(item);
  }
}
async function refreshDiagnostics(){
  const btn=$('diagnostics-refresh');btn.disabled=true;
  setDiagFeedback('현재 사이트의 인증 세션을 확인하고 있습니다…');
  try{
    const session=await requestJson('/api/session');
    csrfToken=session.csrf;
    liveAuthenticated=!!session.authenticated;
    const diagnostic=await requestJson('/api/diagnostics');
    showDiagnosticResult(diagnostic,session);
  }catch(err){
    setDiagFeedback('진단 요청 실패: '+err.message);
    setText('diagnostics-auth','확인 실패');
    setText('diagnostics-loaded','—');
    setText('diagnostics-time','—');
    setText('diagnostics-extraction','서버 접근 또는 네트워크 상태를 확인하세요.');
    $('diagnostics-pages').replaceChildren();
  }finally{btn.disabled=false;}
}
function enterDiagnostics(){
  navigate('diagnostics');
  refreshDiagnostics();
}
for(const id of ['diagnostics-from-home','diagnostics-from-sidebar']) $(id).addEventListener('click',enterDiagnostics);
$('diagnostics-back').addEventListener('click',()=>navigate('home'));
$('diagnostics-refresh').addEventListener('click',refreshDiagnostics);
$('diagnostics-retry').addEventListener('click',async()=>{
  const button=$('diagnostics-retry');button.disabled=true;
  try{
    const session=await requestJson('/api/session');
    liveAuthenticated=!!session.authenticated;
    csrfToken=session.csrf;
    if(!liveAuthenticated){setDiagFeedback('로그인되지 않았습니다. 설정에서 로그인한 다음 다시 시도하세요.');return;}
    setDiagFeedback('회원 페이지 4개의 데이터 조회를 요청하고 있습니다…');
    await fetchLive();
    await refreshDiagnostics();
  }catch(err){setDiagFeedback('조회 요청 실패: '+err.message);}
  finally{button.disabled=false;}
});

async function syncBridge(){
  try{
    const status=await requestJson('/api/session');
    csrfToken=status.csrf;
    liveAuthenticated=status.authenticated;
    bridgeStatus(status.authenticated?`${status.name||'회원'} 계정 로그인 상태 · 읽기 전용`:'개인용 서버 연결됨 · 로그인 필요');
    $('bridge-logout').hidden=!status.authenticated;
    if(status.authenticated){
      state.data=normalize(liveBlank());state.origin='live';render();
      lookupSummary('로그인 상태 확인됨 · 실제 좌석·잔여시간 조회 중');
      await fetchLive();
    } else {
      const c=status.session;
      const msg=c?.cookieSent && !c?.cookieRecognized
        ? '이전 로그인 쿠키가 이 서버에서 유효하지 않습니다. 서버 업데이트·재시작 후에는 다시 로그인해야 합니다.'
        : c && !c.cookieSent
          ? '현재 브라우저의 로그인 쿠키가 전달되지 않았습니다. 최초 접속이 아니라면 사파리 쿠키 설정을 확인해 주세요.'
          : '로그인하지 않았습니다. 실제 값은 아직 없습니다.';
      lookupSummary(msg);
    }
  }catch{
    bridgeStatus('개인용 서버 브리지 없음 — 이 사이트의 Node.js 서버가 실행 중인지 확인하세요.');
    $('bridge-login').disabled=true;
    lookupSummary('개인용 웹서버 연결에 실패했습니다.');
  }
}
async function fetchLive(){
  if(!liveAuthenticated){bridgeError('먼저 로그인해 주세요.');return false;}
  const btn=$('refresh');btn.disabled=true;bridgeStatus('쌤카페 서버의 4개 회원 페이지 조회 중…');lookupSummary('로그인 성공 · 실제 회원 페이지 4개를 조회하고 있습니다…');clearBridgeError();
  // Clear stale/demo values before the request, including after a page reload.
  liveAvailability=null;seatLayoutMeta=null;seatLayoutRequested=false;
  state.data=normalize(liveBlank());state.origin='live';state.endpoint=null;state.selectedSeat=null;render();
  try{
    const received=await requestJson('/api/status');
    state.data=normalize(received);
    liveAvailability=received.live?.seatAvailability||null;
    const sources=received.live?.sources||{};
    showLiveSources(sources);
    renderStructured(received.live);
    const count=Object.values(sources).filter(s=>s.ok).length;
    const apis=received.live?.apis||{};
    const apiCount=Object.values(apis).filter(v=>v.ok).length;
    const hasValue=Boolean(received.member?.seat)
      || Number.isFinite(received.member?.ticket?.remainingMinutes)
      || (received.store?.name && received.store.name!=='매장 정보 미확인')
      || Boolean(received.live?.ticketItems?.length)
      || Boolean(received.live?.recentShops?.length);
    if(count===0 && apiCount===0){
      state.origin='error';render();
      bridgeStatus('로그인 성공 · 웹페이지 및 앱 API 조회 실패');
      const reasons=Object.entries(sources).filter(([,v])=>!v.ok).slice(0,2).map(([k,v])=>`${sourceNames[k]||k}: ${v.error||'응답 없음'}`).join(' / ');
      lookupSummary(`로그인 성공 · 회원정보 조회 0/4개 실패. ${reasons} 자세한 원인은 좌측 '서버 조회 진단'에서 확인하세요.`);
      bridgeError('인증은 성공했지만 웹페이지와 앱 API 모두에서 유효한 데이터를 조회하지 못했습니다.');
      toast('로그인은 성공했지만 데이터 조회 실패');
      return false;
    }
    if(!hasValue){
      state.origin='error';render();
      bridgeStatus(`로그인 성공 · 페이지 ${count}/4개 수신 · 좌석·잔여시간 인식 실패`);
      lookupSummary('로그인 성공 · 회원 페이지 '+count+'/4개, 앱 API '+apiCount+'/2개 응답 · 실사용자 데이터를 찾지 못했습니다. 진단 모드를 확인하세요.');
      bridgeError('서버 응답은 받았지만 매장명·이용권·좌석·잔여시간 값을 아직 찾지 못했습니다.');
      toast('서버 데이터는 왔지만 표시할 값을 추출하지 못함');
      return false;
    }
    state.origin='live';render();
    if((received.live?.remainingTimeInterpretation||'').includes('잠정')){
      setText('pass-source','쌤카페 이용권 API · REMAIN_PERIOD를 분으로 잠정 해석');
    }
    if(state.currentView==='seats')await loadSeatLayout();
    bridgeStatus('로그인됨 · 앱 API '+apiCount+'/2개 · 웹페이지 '+count+'/4개 · 확인된 값 반영');
    const timeNote=received.live?.remainingTimeInterpretation||'';
    lookupSummary('현재 매장: '+(received.store?.name&&received.store.name!=='매장 정보 미확인'?'확인':'미확인')+' · 이용권: '+(received.live?.ticketItems?.length?'확인':'미확인')+' · 좌석: '+(received.member?.seat?'확인':'미확인')+' · 잔여시간: '+(Number.isFinite(received.member?.ticket?.remainingMinutes)?'확인 ('+timeNote+')':'미확인'));
    toast('실제 앱 데이터 '+apiCount+'/2개 API 조회 · 확인된 항목만 반영');
    return true;
  }catch(err){
    liveAvailability=null;
    state.data=normalize(liveBlank());state.origin='error';render();clearLiveSources();
    bridgeError(`실시간 조회 실패: ${err.message}`);
    bridgeStatus('로그인 성공 · 서버 조회 오류');
    lookupSummary(`로그인은 성공했지만 데이터 조회 중 오류: ${err.message}`);
    toast('로그인 성공, 데이터 조회 실패');
    return false;
  }finally{btn.disabled=false;}
}

async function loadSeatLayout(force=false){
  if(!liveAuthenticated){
    setText('seat-layout-status','좌석별 배치를 조회하려면 먼저 로그인해야 합니다.');
    return false;
  }
  if(seatLayoutRequested&&!force)return true;
  const btn=$('seat-layout-refresh');
  btn.disabled=true;
  setText('seat-layout-status','쌤카페 앱의 실제 좌석 선택 화면을 조회하고 있습니다…');
  seatLayoutRequested=true;
  try{
    const payload=await requestJson('/api/seat-layout');
    if(!payload.ok||!Array.isArray(payload.seats)||payload.seats.length===0){
      seatLayoutMeta={actualPositions:false,floorNo:payload.floorNo||''};
      state.data=normalize({...state.data,seats:[]});render();
      const reason=payload.reason||'서버 응답에 개별 좌석 상태가 없습니다.';
      const tries=payload.inspect?.attempts||[];
      const personal=tries.find(a=>a.name==='personal');
      const hint=personal
        ?' 개인석 화면: '+(personal.error||((personal.htmlCharacters??0)+'자 HTML'))+
          (personal.structure?.likelyLoginPage?' (로그인 화면 가능성)':'')
        :'';
      setText('seat-layout-status',reason+hint+' · 아래 좌석 조회 진단 복사 버튼으로 분석 결과를 복사할 수 있습니다.');
      return false;
    }
    seatLayoutMeta={actualPositions:!!payload.actualPositions,floorNo:payload.floorNo||'',source:payload.source};
    state.data=normalize({...state.data,seats:payload.seats});render();
    const report=payload.summary||{};
    setText('seat-layout-status',
      '실제 좌석 '+payload.seats.length+'개 조회 · 빈 좌석 '+(report.available||0)+'개 · 사용 중 '+(report.occupied||0)+'개'+
      (report.unknown?' · 상태 미확인 '+report.unknown+'개':'')+
      (payload.actualPositions?' · 서버 제공 좌표로 실제 배치':' · 위치 정보가 없어 목록형 그림으로 표시'));
    return true;
  }catch(err){
    seatLayoutRequested=false;
    setText('seat-layout-status','좌석별 화면 조회 실패: '+err.message);
    return false;
  }finally{btn.disabled=false;}
}
$('seat-layout-refresh').addEventListener('click',()=>loadSeatLayout(true));

function safeSeatDiagnostic(data){
  const page=data?.seatPage||null;
  const attempt = a=>({
    screen:a.name||'',
    error:a.error||'',
    redirectedPaths:Array.isArray(a.redirects)?a.redirects.slice(0,5):[],
    finalPath:a.finalPath||null,
    htmlCharacters:a.htmlCharacters??null,
    structure:a.structure||null,
    hints:a.hints||null,
    seatsFound:a.summary?.count??0,
    http:a.http||null,
    forensic:a.forensic||null,
    requestHints:Array.isArray(a.requestHints)?a.requestHints.map(h=>({
      path:h.path||'',method:h.method||'UNKNOWN',fields:h.fields||[],source:h.source||''
    })):[]
  });
  return {
    version:data?.version||'',
    authenticated:!!data?.authenticated,
    seat:{
      checkedAt:page?.checkedAt||null,
      floorNo:page?.floorNo||null,
      source:page?.source||null,
      summary:page?.summary||null,
      attemptedPages:Array.isArray(page?.attempts)?page.attempts.map(attempt):[],
      loadedJsPaths:Array.isArray(page?.detectedScripts)?page.detectedScripts.slice(0,40):[],
      allDiscoveredJsPaths:Array.isArray(page?.discoveredScripts)?page.discoveredScripts.slice(0,60):[],
      seatReadApiCandidates:Array.isArray(page?.detectedReadApis)?page.detectedReadApis.slice(0,32):[],
      requestHints:Array.isArray(page?.requestHints)?page.requestHints.slice(0,80):[],
      jsAnalysis:Array.isArray(page?.inspected)?page.inspected.map(x=>({
        path:x.path||'',candidatePaths:x.candidates||[],error:x.error||'',
        http:x.http||null,code:x.code||null
      })):[],
      attemptedReadApis:Array.isArray(page?.probes)?page.probes.slice(0,24):[]
    }
  };
}
async function copySeatDiagnostic(){
  const button=$('seat-diagnostic-copy'),area=$('seat-diagnostic-export');
  button.disabled=true;
  try{
    const data=await requestJson('/api/diagnostics');
    if(!data.seatPage){
      setText('seat-layout-status','좌석 조회 기록이 없습니다. 먼저 개별 좌석 상태 조회를 눌러 주세요.');
      return;
    }
    const report=JSON.stringify(safeSeatDiagnostic(data),null,2);
    area.value=report;area.hidden=false;
    let copied=false;
    if(typeof navigator!=='undefined'&&navigator.clipboard?.writeText){
      try{await navigator.clipboard.writeText(report);copied=true;}catch{}
    }
    if(!copied){
      area.focus();area.select();
      try{copied=!!document.execCommand('copy')}catch{}
    }
    setText('seat-layout-status',copied
      ?'좌석 진단 결과 복사 완료. 인증 토큰·비밀번호·매장명은 포함하지 않았습니다. 내용을 채팅에 붙여넣어 주세요.'
      :'아래 진단 텍스트가 선택됐습니다. 직접 복사해 채팅에 붙여넣어 주세요.');
    if(copied)toast('좌석 조회 진단 복사 완료');
  }catch(err){
    setText('seat-layout-status','진단 결과를 가져오지 못했습니다: '+err.message);
  }finally{button.disabled=false;}
}
$('seat-diagnostic-copy').addEventListener('click',copySeatDiagnostic);


const QR_NS='http://www.w3.org/2000/svg';
function closeEntry(){
  $('entry-overlay').hidden=true;
  $('entry-qr-canvas').replaceChildren();
  setText('entry-status','입장 QR을 닫았습니다. 다시 열면 공식 서버에서 새로 조회합니다.');
}
async function refreshEntryQr(){
  const btn=$('entry-reload');btn.disabled=true;
  $('entry-qr-canvas').replaceChildren();
  setText('entry-status','현재 본인 계정의 쌤카페 공식 입장 QR을 조회하고 있습니다…');
  try{
    const data=await requestJson('/api/entry-qr');
    if(typeof data.qr!=='string' || data.qr.length<1)throw Error('서버에서 유효한 QR 값을 받지 못했습니다.');
    // MIT licensed, bundled locally: no QR data sent to an external generator.
    const qrLib=await import('/vendor/qrcode.mjs');
    const qr=qrLib.default(0,'M');
    qr.addData(data.qr,'Byte');qr.make();
    const total=qr.getModuleCount(),pad=4;
    const svg=document.createElementNS(QR_NS,'svg');
    svg.setAttribute('viewBox','0 0 '+(total+pad*2)+' '+(total+pad*2));
    svg.setAttribute('role','img');svg.setAttribute('aria-label','매장 스캐너에 제시할 공식 쌤카페 입장 QR');
    const white=document.createElementNS(QR_NS,'rect');
    white.setAttribute('x','0');white.setAttribute('y','0');
    white.setAttribute('width',String(total+pad*2));white.setAttribute('height',String(total+pad*2));
    white.setAttribute('fill','#ffffff');svg.append(white);
    const dots=document.createDocumentFragment();
    for(let r=0;r<total;r++)for(let c=0;c<total;c++)if(qr.isDark(r,c)){
      const pixel=document.createElementNS(QR_NS,'rect');
      pixel.setAttribute('x',String(c+pad));pixel.setAttribute('y',String(r+pad));
      pixel.setAttribute('width','1');pixel.setAttribute('height','1');pixel.setAttribute('fill','#111111');
      dots.append(pixel);
    }
    svg.append(dots);
    $('entry-qr-canvas').replaceChildren(svg);
    setText('entry-status',data.shopName
      ?data.shopName+' · 공식 앱 홈의 QR을 표시했습니다. 현장 스캐너에 제시해 주세요.'
      :'공식 앱 홈의 QR을 표시했습니다. 현장 스캐너에 제시해 주세요.');
  }catch(err){
    setText('entry-status','입장 QR을 표시하지 못했습니다: '+err.message);
  }finally{btn.disabled=false;}
}
async function openEntry(){
  if(!liveAuthenticated){toast('설정에서 쌤카페 계정으로 먼저 로그인해 주세요.');showModal();return;}
  $('entry-overlay').hidden=false;
  await refreshEntryQr();
}
for(const id of ['entry-open-home','entry-open-seats'])$(id).addEventListener('click',openEntry);
for(const id of ['entry-close','entry-dismiss'])$(id).addEventListener('click',closeEntry);
$('entry-reload').addEventListener('click',refreshEntryQr);
$('entry-overlay').addEventListener('click',e=>{if(e.target===$('entry-overlay'))closeEntry();});
$('availability-refresh').addEventListener('click',async()=>{
  if(!liveAuthenticated){toast('먼저 로그인해 주세요.');showModal();return;}
  $('availability-refresh').disabled=true;
  try{await fetchLive();}finally{$('availability-refresh').disabled=false;}
});

$('bridge-login-form').addEventListener('submit',async(e)=>{
  e.preventDefault();clearBridgeError();
  if(!csrfToken){bridgeError('먼저 개인용 서버를 실행해 주세요.');return;}
  const btn=$('bridge-login');btn.disabled=true;btn.textContent='로그인 중…';
  const username=$('login-id').value.trim();
  const pw=$('login-password').value;
  const device=$('login-device').value.trim();
  $('login-password').value='';
  try{
    const loginResult=await requestJson('/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({username,password:pw,...(device?{deviceId:device}:{})})});
    if(!loginResult.authenticated)throw Error('인증 응답이 로그인 성공을 확인하지 않았습니다.');
    const verified=await requestJson('/api/session');
    csrfToken=verified.csrf;
    if(!verified.authenticated){
      liveAuthenticated=false;
      state.data=normalize(liveBlank());state.origin='error';render();
      const detail=verified.session?.cookieSent && !verified.session?.cookieRecognized
        ? '세션 쿠키가 서버에서 인식되지 않습니다.'
        : verified.session && !verified.session.cookieSent
          ? '사파리가 세션 쿠키를 보내지 않았습니다.'
          : '서버가 로그인 세션을 유지하지 못했습니다.';
      lookupSummary('계정 인증은 성공했지만 '+detail+' 진단 모드에서 쿠키 상태를 확인해 주세요.');
      throw Error('계정 인증 성공 후 세션 유지 실패: '+detail);
    }
    liveAuthenticated=true;
    lookupSummary('로그인 성공 · 쌤카페 회원 페이지 연결을 확인하는 중…');
    $('bridge-logout').hidden=false;
    state.data=normalize(liveBlank());state.origin='live';render();
    const loaded=await fetchLive();
    if(!loaded)return;
    hideModal();
  }catch(err){
    let explanation=err.message;
    try {
      const d=await requestJson('/api/diagnostics');
      if(d.lastLogin)explanation+='\n진단: '+loginTraceText(d.lastLogin);
      showDiagnosticResult(d);
    }catch{}
    bridgeError(explanation);
    bridgeStatus('로그인 API 또는 인증 세션 처리 실패 · 아래 진단을 확인하세요');
    lookupSummary('계정 로그인에 실패했습니다. 설정의 오류 메시지와 진단 모드의 최근 로그인 시도를 확인하세요.');
  }
  finally{btn.disabled=false;btn.textContent='로그인 후 실제 데이터 조회';}
});
$('bridge-logout').addEventListener('click',async()=>{
  try{await requestJson('/api/logout',{method:'POST',headers:{'X-CSRF-Token':csrfToken}});
    liveAuthenticated=false;$('bridge-logout').hidden=true;bridgeStatus('로그아웃 완료');
    liveAvailability=null;
    state.data=normalize(liveBlank());state.origin='unlinked';render();clearLiveSources();lookupSummary('로그아웃됨 · 회원 데이터 없음');toast('로그아웃했습니다.');
  }catch(err){bridgeError(err.message);}
});
render();
syncBridge();
