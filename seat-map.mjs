/**
 * Conservative, read-only extractor for the native SSAMCAFE WebView seat page.
 * The app opens /mobile/enterSeatView.do?tk=&m_value=&SHOP_NO=&FLOOR_NO=.
 * Only render explicit per-seat IDs paired with a recognizable occupancy state.
 * Never make up seats from aggregate counters.
 */
const MAX_HTML = 1_000_000;
const MAX_SEATS = 500;
const SEAT_KEYS = ['SEAT_NO','seat_no','seatNo','seat_num','seatNum','SEAT_NUM','seat_id','seatId','SEAT_ID','no','seat_number','seatNumber','seat','seat_label','seatLabel','SEAT_NAME'];
const STATUS_KEYS = ['SEAT_STATUS','seat_status','seatStatus','status','STATUS','USE_YN','use_yn','usedYn','USED_YN','USE_STATE','useState','state','STATE','isUsed','occupied','isOccupied'];
const X_KEYS = ['SEAT_X','seat_x','seatX','SEAT_POSITION_X','POS_X','pos_x','posX','x','X','LEFT','left','leftPos'];
const Y_KEYS = ['SEAT_Y','seat_y','seatY','SEAT_POSITION_Y','POS_Y','pos_y','posY','y','Y','TOP','top','topPos'];
const ATTR_SEAT_KEYS=['data-seat-no','data-seat-id','data-seatnum','data-seat-num','data-seat-number','data-no','data-seat','seat-no','seatnum'];
const ATTR_STATUS_KEYS=['data-seat-status','data-status','data-state','data-use-yn','data-occupied','data-used','aria-label','title'];
const get = (o,keys) => { for(const k of keys) if(Object.hasOwn(o,k) && o[k]!==null && o[k]!==undefined) return [o[k],k]; return [null,null]; };
function safeString(v,n=64){return typeof v==='string'||typeof v==='number'?String(v).trim().slice(0,n):'';}
function coordinates(o,keys){
  const [v] = get(o,keys);
  if(v===null)return null;
  const match=/^-?\d+(?:\.\d+)?(?:px|%)?$/.exec(String(v).trim());
  if(!match)return null;
  const number=Number(String(v).replace(/(?:px|%)$/,''));
  return Number.isFinite(number)&&Math.abs(number)<=100000?number:null;
}
function occupancy(v,key,context=''){
  if(typeof v==='boolean')return v?'occupied':'available';
  if(typeof v==='number' && (key==='isUsed'||key==='isOccupied'))return v?'occupied':'available';
  const code=safeString(v,40).toLowerCase().replace(/\s/g,'');
  if(!code)return null;
  const free=['available','empty','vacant','free','unused','notused','unoccupied','open','이용가능','빈자리','공석','사용가능','예약가능'];
  const taken=['occupied','using','inuse','used','taken','busy','unavailable','이용중','사용중','사용불가','예약됨','예약중'];
  const mine=['mine','myseat','내좌석'];
  if(free.includes(code))return 'available';
  if(taken.includes(code))return 'occupied';
  if(mine.includes(code))return 'mine';
  if(/^(isUsed|isOccupied|usedYn|USE_YN|use_yn|USED_YN|data-use-yn|data-used|data-occupied)$/i.test(key||'')){
    if(['y','yes','true','1'].includes(code))return 'occupied';
    if(['n','no','false','0'].includes(code))return 'available';
  }
  if(key==='class'){
    if(/(?:^|[-_])(?:available|free|vacant|empty)(?:$|[-_])/.test(code))return 'available';
    if(/(?:^|[-_])(?:occupied|busy|inuse|used)(?:$|[-_])/.test(code))return 'occupied';
    if(/(?:^|[-_])(?:disabled|blocked)(?:$|[-_])/.test(code))return 'disabled';
  }
  if(key==='aria-label'||key==='title'||key==='class'){
    if(/(?:사용\s*중|이용\s*중|예약\s*중)/.test(context||code))return 'occupied';
    if(/(?:이용\s*가능|빈\s*자리|사용\s*가능)/.test(context||code))return 'available';
  }
  // App-specific one-letter SEAT_STATE/SEAT_STATUS codes (C etc.) are not verified.
  return null;
}
function seatFromObject(o,seatContext=false){
  if(!o||typeof o!=='object'||Array.isArray(o))return null;
  const [rawId,key]=get(o,SEAT_KEYS);
  let id=safeString(rawId,40);
  if(key==='no' && !seatContext && !Object.keys(o).some(k=>/seat|좌석/i.test(k)))return null;
  if(!/^[\p{L}\p{N}_\- ]{1,30}$/u.test(id))return null;
  const [rawStatus,stateKey]=get(o,STATUS_KEYS);
  const status=occupancy(rawStatus,stateKey);
  // A legitimate, identified seat may have an undocumented app-specific
  // status code. Show it as unknown, never fabricate an available seat.
  if(!status && !stateKey && !seatContext && !/^SEAT_|^seat/i.test(key))return null;
  return {id,status:status||'unknown',x:coordinates(o,X_KEYS),y:coordinates(o,Y_KEYS)};
}
function decodeHtml(v){return String(v).replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&amp;/gi,'&');}
function htmlAttrs(tag){
  const attrs={};
  for(const m of tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]{0,300})"|'([^']{0,300})'|([^\s>]{1,300}))/g)){
    attrs[m[1].toLowerCase()]=decodeHtml(m[2]??m[3]??m[4]);
  }
  return attrs;
}
function seatFromElement(a){
  let id=ATTR_SEAT_KEYS.map(k=>a[k]).find(Boolean);
  // Native seat charts sometimes encode the seat number in the element ID.
  // Only accept explicitly seat-prefixed IDs, never arbitrary DOM IDs.
  if(!id&&typeof a.id==='string'){
    const m=/^(?:seat|chair)[-_]?([A-Za-z0-9_-]{1,25})$/i.exec(a.id);
    if(m)id=m[1];
  }
  if(!id)return null;
  const obj={SEAT_NO:id};
  for(const key of ATTR_STATUS_KEYS){
    if(!a[key])continue;
    const status=occupancy(a[key],key,a[key]);
    if(status){
      obj.status=status;
      break;
    }
  }
  if(!obj.status && a.class){
    const classTokens=a.class.toLowerCase().split(/\s+/);
    for(const token of classTokens){
      const status=occupancy(token,'class',token);
      if(status){obj.status=status;break;}
    }
  }
  const style=a.style||'';
  const left=/\bleft\s*:\s*(-?\d+(?:\.\d+)?)\s*(?:px|%)/i.exec(style);
  const top=/\btop\s*:\s*(-?\d+(?:\.\d+)?)\s*(?:px|%)/i.exec(style);
  const translate=/translate(?:3d)?\s*\(\s*(-?\d+(?:\.\d+)?)px\s*,\s*(-?\d+(?:\.\d+)?)px/i.exec(style);
  if(left)obj.x=left[1];
  if(top)obj.y=top[1];
  if(translate){obj.x=translate[1];obj.y=translate[2];}
  if(a['data-x'])obj.x=a['data-x'];
  if(a['data-y'])obj.y=a['data-y'];
  return seatFromObject(obj);
}
function normalizeLooseJson(text){
  // Parse a restricted JSON-like literal without eval or execution.
  // Property names may be unquoted and simple strings may use single quotes.
  if(typeof text!=='string'||text.length>200000||/\b(?:function|=>|\bnew\b|\bimport\b|\bawait\b)\b/.test(text))return null;
  const quotedKeys=text.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g,'$1"$2"$3');
  const quotes=quotedKeys.replace(/'([^'\\]{0,300})'/g,(_,value)=>JSON.stringify(value));
  try{return JSON.parse(quotes)}catch{return null}
}
export function findSeatApiPaths(source){
  if(typeof source!=='string'||source.length>MAX_HTML)return [];
  const found=[];
  for(const m of source.matchAll(/(?:["'\x60])((?:https:\/\/m\.ssamcafe\.com)?\/(?:mobile|api)\/[A-Za-z0-9_./-]{1,160}\.do)(?:["'\x60])/gi)){
    const path=m[1].replace(/^https:\/\/m\.ssamcafe\.com/i,'');
    if(!/seat|chart|floor|자리|좌석|booking/i.test(path)||/change|cancel|reserve|register|enter|exit|pay|modify|update|insert|delete|save/i.test(path))continue;
    if(!found.includes(path))found.push(path);
    if(found.length>=16)break;
  }
  return found;
}

/** Inventory exact read requests found in HTML forms and inline scripts.
 * Report only route, HTTP verb and parameter NAMES; never expose source,
 * request bodies, input values, authentication tokens or user identifiers. */
// Parse a balanced static JavaScript group without executing it.
function staticGroup(source,start,open='(',close=')',limit=8000){
  if(source[start]!==open)return '';
  let depth=0,quote='',escaped=false;
  for(let i=start;i<Math.min(source.length,start+limit);i++){
    const ch=source[i];
    if(quote){
      if(escaped){escaped=false;continue;}
      if(ch==='\\'){escaped=true;continue;}
      if(ch===quote)quote='';
      continue;
    }
    if(ch==='"'||ch==="'"||ch.charCodeAt(0)===96){quote=ch;continue;}
    if(ch===open)depth++;
    if(ch===close&&--depth===0)return source.slice(start,i+1);
  }
  return '';
}

export function inspectSeatRequests(html){
  if(typeof html!=='string'||html.length>MAX_HTML)return [];
  const matches=new Map();
  const record=(path,method,fields,origin)=>{
    try{
      const u=new URL(decodeHtml(path),'https://m.ssamcafe.com');
      if(u.origin!=='https://m.ssamcafe.com')return;
      const p=u.pathname;
      if(!/^\/(?:mobile|api)\/[A-Za-z0-9_./-]{1,180}\.do$/i.test(p))return;
      if(!/seat|chart|floor|personal|자리|좌석/i.test(p))return;
      if(/change|cancel|reserve|register|enter|exit|pay|modify|update|insert|delete|save/i.test(p))return;
      const verb=String(method||'UNKNOWN').toUpperCase();
      const safeMethod=['GET','POST'].includes(verb)?verb:'UNKNOWN';
      const safeFields=(fields||[]).filter(x=>/^[A-Za-z][A-Za-z0-9_]{0,45}$/.test(x)).slice(0,30);
      const key=p+'|'+safeMethod+'|'+origin;
      if(!matches.has(key))matches.set(key,{path:p,method:safeMethod,fields:safeFields,source:origin});
      else{
        const old=matches.get(key);
        old.fields=[...new Set([...old.fields,...safeFields])].slice(0,30);
      }
    }catch{}
  };
  // Inspect declared HTML forms without reading their field values.
  for(const m of html.matchAll(/<form\b([^>]{0,2400})>([\s\S]{0,40000}?)<\/form>/gi)){
    const attrs=htmlAttrs('<form '+m[1]+'>');
    if(!attrs.action)continue;
    const fields=[...m[2].matchAll(/<(?:input|select|textarea)\b[^>]{0,700}\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)]
      .map(x=>x[1]||x[2]||x[3]);
    record(attrs.action,attrs.method||'GET',fields,'form');
  }
  // Discover exact static URLs used in JS. Scope verb detection to one
  // jQuery AJAX block or fetch call, not the entire page.
  for(const m of html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]{0,250000}?)<\/script>/gi)){
    const body=m[1];
    for(const call of body.matchAll(/\$\.(?:ajax|get|post)\s*\(/gi)){
      const openAt=call.index+call[0].lastIndexOf('(');
      const balanced=staticGroup(body,openAt,'(',')');
      if(!balanced)continue;
      const raw=body.slice(call.index,openAt)+balanced;
      const url=/\burl\s*:\s*["']([^"']{1,230})["']/i.exec(raw)
        ||/\$\.(?:get|post)\s*\(\s*["']([^"']{1,230})["']/i.exec(raw);
      if(!url)continue;
      const method=/\$\.post\s*\(/i.test(raw)?'POST':/\$\.get\s*\(/i.test(raw)?'GET':
        /\b(?:type|method)\s*:\s*["'](GET|POST)["']/i.exec(raw)?.[1]||'UNKNOWN';
      const dataStart=/\bdata\s*:\s*\{/i.exec(raw);
      const dataGroup=dataStart?staticGroup(raw,dataStart.index+dataStart[0].length-1,'{','}'):null;
      const fields=dataGroup
        ?[...dataGroup.slice(1,-1).matchAll(/(?:^|,)\s*["']?([A-Za-z][A-Za-z0-9_]{0,45})["']?\s*:/g)].map(x=>x[1]):[];
      record(url[1],method,fields,'ajax');
    }
    for(const call of body.matchAll(/fetch\s*\(\s*["']([^"']{1,230})["']\s*(?:,\s*\{([^}]{0,1400})\})?\s*\)/gi)){
      const method=/\bmethod\s*:\s*["'](GET|POST)["']/i.exec(call[2]||'')?.[1]||'GET';
      record(call[1],method,[], 'fetch');
    }
    for(const call of body.matchAll(/\.load\s*\(\s*["']([^"']{1,230})["']/gi)){
      record(call[1],'GET',[],'load');
    }
  }
  return [...matches.values()].slice(0,30);
}

function arrayCandidates(html){
  const inputs=[];
  for(const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/json["'][^>]*>([\s\S]{0,200000}?)<\/script>/gi))inputs.push(decodeHtml(m[1]));
  for(const m of html.matchAll(/\b(?:seatList|seatData|seatArr|seatArray|seatInfo|seatMap|chartList|seat_list|seat_list_data)\b\s*(?::|=)\s*(\[[\s\S]{0,200000}?\])/gi))inputs.push(m[1]);
  for(const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]{0,200000}?)<\/script>/gi))inputs.push(m[1]);
  return inputs.slice(0,16);
}
function collectObjects(input,out,depth=0,seatContext=false){
  if(depth>7 || out.length>=MAX_SEATS*3)return;
  if(Array.isArray(input)){for(const item of input.slice(0,MAX_SEATS*3))collectObjects(item,out,depth+1,seatContext);return;}
  if(!input||typeof input!=='object')return;
  const seat=seatFromObject(input,seatContext);
  if(seat)out.push(seat);
  for(const [key,value] of Object.entries(input)){
    if(/password|token|secret|private|user|account|name/i.test(key)&&!/seat|room|chart/i.test(key))continue;
    const isSeatCollection=seatContext||/seat|chart|자리|좌석/i.test(key);
    if(value&&typeof value==='object')collectObjects(value,out,depth+1,isSeatCollection);
    else if(typeof value==='string'&&value.length<200000&&/^[\s]*[\[{]/.test(value)){
      try{collectObjects(JSON.parse(value),out,depth+1,isSeatCollection)}catch{}
    }
  }
}
function extractHtmlSeatRecords(html){
  const out=[];
  for(const m of html.matchAll(/<(?:div|button|li|span|td|a|rect|g)\b[^>]{0,1200}>/gi)){
    const seat=seatFromElement(htmlAttrs(m[0]));
    if(seat)out.push(seat);
    if(out.length>=MAX_SEATS*2)break;
  }
  for(const candidate of arrayCandidates(html)){
    try{collectObjects(JSON.parse(candidate),out,0,true);}
    catch{const parsed=normalizeLooseJson(candidate);if(parsed)collectObjects(parsed,out,0,true);}
  }
  return out;
}
function pageStructure(html){
  // Report only counts and broad categories, never page text, input values,
  // query parameters, or private app tokens.
  const count=regex=>[...html.matchAll(regex)].length;
  const loginFields=/<input\b[^>]*(?:type\s*=\s*["']?password|name\s*=\s*["']?(?:password|passwd|pwd))\b/i.test(html);
  const loginTerms=/(?:로그인|아이디.*비밀번호|login\s*required|session\s*expired|세션.*만료)/i.test(html);
  const errorTerms=/(?:접근.*불가|권한.*없|알 수 없는 오류|잘못된 요청|not\s*found|unauthorized|forbidden)/i.test(html);
  return {
    likelyLoginPage:loginFields||loginTerms,
    likelyErrorPage:errorTerms,
    forms:count(/<form\b/gi),
    scripts:count(/<script\b/gi),
    externalScripts:count(/<script\b[^>]*\bsrc\s*=/gi),
    inlineScripts:count(/<script\b(?![^>]*\bsrc\s*=)/gi),
    iframes:count(/<iframe\b/gi),
    canvas:count(/<canvas\b/gi),
    svg:count(/<svg\b/gi),
    seatIdentifiers:count(/(?:data-seat-no|data-seat-id|SEAT_NO|seatList|seatMap|seatData)/gi)
  };
}
function scriptPaths(html){
  const out=[];
  for(const m of html.matchAll(/<script\b[^>]*src\s*=\s*["']([^"']{1,300})["']/gi)){
    try{
      const u=new URL(decodeHtml(m[1]),'https://m.ssamcafe.com');
      if(u.origin==='https://m.ssamcafe.com' && /\.(?:js|mjs)$/i.test(u.pathname) && !out.includes(u.pathname))out.push(u.pathname);
    }catch{}
    if(out.length>=20)break;
  }
  return out;
}
export function parseSeatLayout(html,source='enter'){
  if(typeof html!=='string'||html.length>MAX_HTML)throw new Error('좌석 페이지 크기를 확인할 수 없습니다.');
  const rows=extractHtmlSeatRecords(html),byId=new Map(),ambiguous=new Set();
  let conflict=0;
  for(const seat of rows){
    if(ambiguous.has(seat.id))continue;
    const old=byId.get(seat.id);
    if(old&&old.status!==seat.status){conflict++;byId.delete(seat.id);ambiguous.add(seat.id);continue;}
    if(!old)byId.set(seat.id,seat);
  }
  const seats=[...byId.values()].slice(0,MAX_SEATS);
  const placed=seats.filter(s=>s.x!==null&&s.y!==null).length;
  const actualPositions=seats.length>2&&placed===seats.length;
  const [available,occupied,unknown]=['available','occupied','unknown'].map(status=>seats.filter(s=>s.status===status).length);
  return {
    source,seats,actualPositions,
    summary:{count:seats.length,available,occupied,unknown,coordinates:placed,conflicts:conflict},
    inspect:{
      htmlCharacters:html.length,
      scriptPaths:scriptPaths(html),
      candidateApiPaths:findSeatApiPaths(html),
      requestHints:inspectSeatRequests(html),
      structure:pageStructure(html),
      hints:{
        hasSeatKeyword:/seat|좌석|자리/i.test(html),
        hasWebviewData:/chart|canvas|floor/i.test(html),
        hasJsonSeatList:/seatList|seatData|seatArr|seatMap|seat_list/i.test(html)
      }
    }
  };
}


// Parse actual JSON returned by a read-only seat-status endpoint, not static JS.
// Only seat records with explicit IDs are ever returned.
export function parseSeatResponse(raw,source='api'){
  if(typeof raw!=='string'||raw.length>MAX_HTML)throw new Error('좌석 응답 크기를 확인할 수 없습니다.');
  let json;
  try{json=JSON.parse(raw)}catch{return parseSeatLayout(raw,source)}
  const rows=[];collectObjects(json,rows);
  const byId=new Map(),ambiguous=new Set();
  let conflicts=0;
  for(const seat of rows){
    if(ambiguous.has(seat.id))continue;
    const old=byId.get(seat.id);
    if(old && old.status!==seat.status){byId.delete(seat.id);ambiguous.add(seat.id);conflicts++;continue}
    if(!old)byId.set(seat.id,seat);
  }
  const seats=[...byId.values()].slice(0,MAX_SEATS);
  const count=status=>seats.filter(s=>s.status===status).length;
  const positions=seats.filter(s=>s.x!==null&&s.y!==null).length;
  return {
    source,seats,actualPositions:seats.length>2&&positions===seats.length,
    summary:{count:seats.length,available:count('available'),occupied:count('occupied'),unknown:count('unknown'),coordinates:positions,conflicts},
    inspect:{htmlCharacters:raw.length,scriptPaths:[],candidateApiPaths:[],hints:{hasSeatKeyword:rows.length>0,hasWebviewData:false,hasJsonSeatList:true}}
  };
}
