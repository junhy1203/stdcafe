/**
 * Personal, unofficial, read-only SSAMCAFE bridge. No framework or npm dependencies.
 * Upstream login flow inferred from user-provided APK; real-server compatibility unverified.
 * Deploy only to a private WireGuard interface; never expose this service to the internet.
 */
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {parseSeatLayout,parseSeatResponse,findSeatApiPaths,analyzeSeatDocument,analyzeSeatScript} from './seat-map.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const UPSTREAM = 'https://m.ssamcafe.com';
const NATIVE_WEBVIEW_UA='Mozilla/5.0 (Linux; Android 13; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.0.0 Mobile Safari/537.36';
const APP_VERSION = '2026-11-16-reference-floorplan-v17';
const PASSWORD_SUFFIX = '2V35NWWYUOQAUVONRI85298Q2YG5OY0F'; // public APK constant, NOT a secret
const LIMIT = 1_000_000;
const COOKIE = 'ssam_bridge_sid';
const TTL_MS = 4 * 60 * 60 * 1000;
const PAGE_PATHS = Object.freeze({
  profile: '/mobile/myInfo/main.do',
  seats: '/mobile/myInfo/bookingStats.do',
  tickets: '/mobile/shop/shopTicketList.do',
  history: '/mobile/myInfo/useList.do',
});
const ASSETS = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/vendor/qrcode.mjs': ['vendor/qrcode.mjs','text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
});

const rand = (size = 32) => randomBytes(size).toString('base64url');
const clean = v => String(v ?? '').slice(0, 160);
const createError = (status, msg) => Object.assign(new Error(msg), { status });
const bytesEqual = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const response = (res, code, body, extra = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, private', ...extra });
  res.end(JSON.stringify(body));
};


function seatHttpMetadata(resp,body=''){
  const headers=resp.headers;
  const type=headers.get('content-type')||'';
  const charset=/charset\s*=\s*["']?([A-Za-z0-9_-]{1,30})/i.exec(type)?.[1]||null;
  return {
    status:resp.status,
    mime:type.split(';')[0].toLowerCase().trim()||'unknown',
    charset,
    contentLengthHeader:Number(headers.get('content-length'))||null,
    characters:body.length,
    fingerprint:createHash('sha256').update(body).digest('hex').slice(0,20),
    cacheControl:(headers.get('cache-control')||'').slice(0,90),
    hasSetCookie:headers.has('set-cookie'),
    isHtml:/html/i.test(type),
    isJson:/json/i.test(type)
  };
}

export function loginPayload(username, password, device) {
  const digest = createHash('sha256').update(password + PASSWORD_SUFFIX, 'utf8').digest('hex').toUpperCase();
  return { cmd: '1201', id: username, password: digest, m_value: device };
}

function upstreamPayload(raw) {
  const outer = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!outer || typeof outer !== 'object' || Array.isArray(outer)) throw new Error('로그인 응답이 JSON 객체가 아닙니다.');
  const payloadType = typeof outer.result === 'string' ? 'json-string' : typeof outer.result === 'object' ? 'object' : 'missing';
  const result = typeof outer.result === 'string' ? JSON.parse(outer.result) : outer.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('로그인 응답의 result 구조를 확인하지 못했습니다.');
  const resultCode = result.rspcode == null ? null : String(result.rspcode);
  const outerCode = outer.rspcode == null ? null : String(outer.rspcode);
  // Never override an explicit rejection with a success code from another envelope level.
  if (resultCode !== null && outerCode !== null && resultCode !== outerCode) {
    throw new Error('상위 응답 코드와 결과 응답 코드가 일치하지 않습니다.');
  }
  const code = resultCode ?? outerCode;
  const safeKeys = obj => Object.keys(obj).filter(k => /^[A-Za-z][A-Za-z0-9_]{0,35}$/.test(k)).slice(0, 24);
  return {
    ...result,
    rspcode: code,
    rspmsg: result.rspmsg ?? outer.rspmsg,
    __meta: {
      codeLocation: resultCode !== null ? 'result' : outerCode !== null ? 'outer' : 'missing',
      resultType: payloadType,
      resultKeys: safeKeys(result),
      outerKeys: safeKeys(outer),
      rescode: result.rescode == null && outer.rescode == null ? null : String(result.rescode ?? outer.rescode).slice(0, 16).replace(/[^A-Za-z0-9_-]/g, '')
    }
  };
}

async function limitedText(resp) {
  if (Number(resp.headers.get('content-length')) > LIMIT) throw createError(502, '원격 서버 응답이 너무 큽니다.');
  let n = 0;
  const chunks = [];
  if (resp.body) {
    for await (const piece of resp.body) {
      const part = Buffer.from(piece);
      n += part.length;
      if (n > LIMIT) {
        await resp.body.cancel?.().catch(() => {});
        throw createError(502, '원격 서버 응답이 너무 큽니다.');
      }
      chunks.push(part);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function decodeEntities(s) {
  const basic = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', bull: '•' };
  return s.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (m, k) => {
    if (k[0] !== '#') return basic[k.toLowerCase()] ?? m;
    const cp = k[1]?.toLowerCase() === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isInteger(cp) && cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : m;
  });
}
function pageText(html) {
  let s = html.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template|form|header|footer|nav)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(input|button|meta)\b[^>]*>/gi, ' ')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|td|th|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  return s.split(/\n/).map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean)
    .filter((v, i, a) => i === 0 || a[i-1] !== v).join('\n').slice(0, 4500);
}
function minutes(text) {
  const h = /(?:잔여\s*(?:시간|이용시간)|남은\s*(?:이용)?시간)\s*[:：]?\s*(\d{1,5})\s*시간\s*(\d{1,2})\s*분/s.exec(text);
  if (h) return Math.min(999999, Number(h[1]) * 60 + Number(h[2]));
  const m = /(?:잔여\s*(?:시간|이용시간)|남은\s*(?:이용)?시간)\s*[:：]?\s*(\d{1,5})\s*분/s.exec(text);
  return m ? Math.min(999999, Number(m[1])) : null;
}
function seat(text) {
  const m = /(?:현재\s*좌석|내\s*좌석|이용\s*좌석)\s*[:：]?\s*([A-Za-z가-힣0-9-]{1,12})\s*(?:석|번)?/s.exec(text);
  return m ? m[1].replace(/(?:석|번)$/, '') : null;
}
function asStatus(sources, name) {
  const profile = sources.profile?.text ?? '';
  const seats = sources.seats?.text ?? '';
  const tickets = sources.tickets?.text ?? '';
  return {
    store: { name: '매장 정보 미확인', address: '공식 조회 HTML에서 매장명을 확인하지 못했습니다.' },
    member: {
      seat: seat(seats) || seat(profile), seatDetail: '',
      ticket: { name: '이용권 정보', remainingMinutes: minutes(tickets) ?? minutes(profile), totalMinutes: null },
    },
    seats: [], // Never invent per-seat states from HTML without a verified API contract.
    updatedAt: new Date().toISOString(),
    live: { name, sources, note: '실제 HTML에서 명확하게 확인 가능한 값만 자동 추출합니다.' },
  };
}


function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.length <= LIMIT) {
    try { const v=JSON.parse(value); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch {}
  }
  return null;
}
function asArray(value) {
  if (typeof value === 'string' && value.length <= LIMIT) {
    try { value = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(value) ? value.map(v=>asObject(v)).filter(Boolean).slice(0,60) : [];
}
function readable(v, max=140) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v).trim().slice(0,max);
}
function validCount(v){const raw=readable(v,12);if(!/^\d{1,6}$/.test(raw))return null;const n=Number(raw);return Number.isSafeInteger(n)&&n<=999999?n:null;}
function seatCapacity(total,used){const t=validCount(total),u=validCount(used);return {total:t,used:u,available:t!==null&&u!==null&&u<=t?t-u:null};}
function validMinutes(v) {
  // Fields carrying remaining time are tentatively interpreted as minute counts.
  // Do not interpret arbitrary REMAIN_PERIOD values as minutes.
  const raw=readable(v,16);
  if(!/^\d{1,6}$/.test(raw))return null;
  const n=Number(raw);
  return Number.isSafeInteger(n) && n<=999999 ? n : null;
}
function extractStructuredData(home, goods, fallback) {
  const h=asObject(home)||{};
  const g=asObject(goods)||{};
  const recent=asArray(h.recent_shop_use_list);
  const goodsList=asArray(g.lsat_goods_use_info);
  // Home shop and recent shop are different concepts. Never label nearby shops as linked.
  const currentName=readable(h.home_shop_name);
  const currentNumber=readable(h.home_shop_no,40);
  const recentStores=recent.map(v=>({
    name:readable(v.SHOP_NAME),shopNo:readable(v.SHOP_NO,40),
    goodsName:readable(v.GOODS_NAME),goodsType:readable(v.GOODS_TYPE,35),
    remainingRaw:readable(v.REMAINTIME,40),useState:readable(v.USE_STATE,35)
  })).filter(v=>v.name||v.goodsName);
  const tickets=goodsList.map(v=>({
    shopName:readable(v.SHOP_NAME),shopNo:readable(v.SHOP_NO,40),
    goodsName:readable(v.GOODS_NAME),goodsType:readable(v.GOODS_TYPE,35),
    remainingPeriod:readable(v.REMAIN_PERIOD,50),seatState:readable(v.SEAT_STATE,35)
  })).filter(v=>v.shopName||v.goodsName||v.remainingPeriod);
  const currentRecent=recentStores.find(v=>currentNumber&&v.shopNo===currentNumber)
    || recentStores.find(v=>currentName&&v.name===currentName);
  const currentTicket=tickets.find(v=>currentNumber&&v.shopNo===currentNumber)
    || tickets.find(v=>currentName&&v.shopName===currentName);
  const chosenTicket=currentTicket||tickets[0];
  const chosenRecent=currentRecent||recentStores[0];
  // APK renders home_shop_user_remain_m with a KRW ("원") suffix: it is monetary,
  // NOT remaining study time. Never convert it into minutes.
  // REMAIN_PERIOD is delivered by the app's 1101 goods endpoint. For a product
  // explicitly named a time pass, interpret it as minutes (provisional until
  // compared with the official app's displayed remaining time).
  const timePass=/(?:\d+\s*시간|시간권|time\s*pass)/i.test(chosenTicket?.goodsName||'');
  const recentRemaining=validMinutes(currentRecent?.remainingRaw);
  const passRemaining=timePass?validMinutes(chosenTicket?.remainingPeriod):null;
  const inferredMinutes=recentRemaining??passRemaining;
  // Do not report a merely recent/historical store as the currently linked cafe.
  const confirmedStoreName=currentName||(currentNumber?(currentTicket?.shopName||currentRecent?.name||''):'');
  const result=asStatus(fallback,'');
  result.store={
    name:confirmedStoreName||'매장 정보 미확인',
    address:confirmedStoreName?'주소 미조회':'앱 홈 API에서 매장 정보를 찾지 못했습니다.'
  };
  result.member.ticket={
    name:chosenTicket?.goodsName||chosenRecent?.goodsName||'이용권 정보 미확인',
    remainingMinutes:inferredMinutes??result.member.ticket.remainingMinutes,
    totalMinutes:null
  };
  result.live.currentShop={name:currentName,shopNo:currentNumber,floorNo:readable(h.home_floor_no,30)};
  result.live.remainingTimeInterpretation=recentRemaining!==null?'최근 매장 REMAINTIME':passRemaining!==null?'이용권 REMAIN_PERIOD를 분 단위로 잠정 해석':'미확인';
  // These counters power the native app's occupied/total labels.
  // Individual seats are intentionally not fabricated from aggregate counts.
  result.live.seatAvailability={
    personal:seatCapacity(h.home_shop_tot_p,h.home_shop_use_p),
    group:seatCapacity(h.home_shop_tot_g,h.home_shop_use_g),
    locker:seatCapacity(h.home_shop_tot_l,h.home_shop_use_l),
    confirmedShop:!!currentName&&!!currentNumber,
    fetchedAt:new Date().toISOString()
  };
  result.live.entryQrAvailable=typeof h.home_qr_code==='string'&&h.home_qr_code.length>0;
  result.live.recentShops=recentStores;
  result.live.ticketItems=tickets;
  result.live.homeValues={recentCount:recentStores.length,ticketsCount:tickets.length};
  return result;
}

function parseCookie(header) {
  const result = {};
  for (const item of String(header || '').split(';')) {
    const p = item.indexOf('=');
    if (p > 0) result[item.slice(0, p).trim()] = item.slice(p + 1).trim();
  }
  return result;
}
function collectUpstreamCookies(headers, jar) {
  const parts = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie')].filter(Boolean);
  for (const h of parts) {
    const first = h.split(';', 1)[0];
    if (/^[a-z0-9_-]{1,70}=.{0,1024}$/i.test(first)) {
      const [name, ...rest] = first.split('=');
      jar.set(name, rest.join('='));
    }
  }
}
function cookieHeader(jar) { return [...jar].map(([a,b]) => `${a}=${b}`).join('; '); }

async function bodyJson(req) {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw createError(415, 'application/json 요청만 허용합니다.');
  const chunks = []; let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 12000) throw createError(413, '요청 본문이 너무 큽니다.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw createError(400, '잘못된 JSON 요청입니다.'); }
}
function checkMutation(req, s) {
  if (!bytesEqual(req.headers['x-csrf-token'] || '', s.csrf)) throw createError(403, '보호 토큰이 일치하지 않습니다. 새로고침 후 다시 시도하세요.');
  const origin = req.headers.origin;
  if (origin) {
    try {
      const u = new URL(origin);
      if (u.host !== req.headers.host || !['http:', 'https:'].includes(u.protocol)) throw new Error('origin');
    } catch { throw createError(403, '외부 사이트의 요청은 허용하지 않습니다.'); }
  }
}

export function createApp({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  const sessions = new Map();
  const attempts = new Map();
  const startedAt = new Date(now()).toISOString();
  function getSession(req, res) {
    const cookieVal = parseCookie(req.headers.cookie)[COOKIE] ?? '';
    let s = cookieVal && sessions.get(cookieVal);
    const t = now();
    if (s && t - s.last < TTL_MS) { s.last = t; return s; }
    if (cookieVal) sessions.delete(cookieVal);
    for (const [id, sess] of sessions) if (t - sess.last >= TTL_MS) sessions.delete(id);
    if (sessions.size >= 100) throw createError(503, '동시 사용자가 너무 많습니다.');
    const key = rand();
    s = { sid: key, csrf: rand(24), device: randomBytes(8).toString('hex'), last: t, token: '', name: '', jar: new Map(), lastDiagnostic: null, lastLogin: null, lastSeatDiagnostic: null };
    sessions.set(key, s);
    const secure = req.socket.encrypted ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS/1000}${secure}`);
    return s;
  }
  async function upstream(url, options = {}, jar = new Map()) {
    // URLs are constructed only from fixed, hard-coded endpoint paths.
    const headers = { 'Accept-Language': 'ko-KR,ko;q=0.9', 'User-Agent': 'SSAMCAFE-selfhosted-readonly/1.0', ...options.headers };
    const cookies = cookieHeader(jar);
    if (cookies) headers.Cookie = cookies;
    let resp;
    try { resp = await fetchImpl(url, { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(12000) }); }
    catch { throw createError(502, '쌤카페 서버 연결 또는 DNS/TLS 요청에 실패했습니다.'); }
    collectUpstreamCookies(resp.headers, jar);
    if (resp.status !== 200) throw createError(502, `쌤카페 서버가 HTTP ${resp.status}을 반환했습니다.`);
    return { resp, text: await limitedText(resp) };
  }
  async function upstreamMobilePage(rawUrl, jar) {
    // Follow only safe, same-origin GET redirects inside the mobile read-only
    // pages; a WebView normally follows these, but our base client does not.
    let url=new URL(rawUrl);
    const redirects=[];
    for(let hop=0;hop<=3;hop++){
      if(url.origin!==UPSTREAM || !url.pathname.startsWith('/mobile/'))
        throw createError(502,'모바일 화면이 다른 호스트 또는 허용되지 않은 경로로 이동했습니다.');
      const headers={
        Accept:'text/html,application/xhtml+xml',
        'Accept-Language':'ko-KR,ko;q=0.9',
        'User-Agent':NATIVE_WEBVIEW_UA
      };
      const cookies=cookieHeader(jar);
      if(cookies)headers.Cookie=cookies;
      let resp;
      try { resp=await fetchImpl(url,{method:'GET',headers,redirect:'manual',signal:AbortSignal.timeout(12000)}); }
      catch { throw createError(502,'공식 모바일 좌석 화면에 연결하지 못했습니다.'); }
      collectUpstreamCookies(resp.headers,jar);
      if([301,302,303,307,308].includes(resp.status)){
        const loc=resp.headers.get('location');
        if(!loc)throw createError(502,'공식 모바일 화면에서 이동 주소를 받지 못했습니다.');
        const next=new URL(loc,url);
        if(next.origin!==UPSTREAM || !next.pathname.startsWith('/mobile/'))
          throw createError(502,'모바일 화면이 다른 호스트 또는 허용되지 않은 경로로 이동했습니다.');
        // No token or query string enters diagnostics.
        redirects.push(next.pathname);
        url=next;continue;
      }
      if(resp.status!==200)throw createError(502,'공식 모바일 좌석 화면 HTTP '+resp.status);
      return {resp,text:await limitedText(resp),redirects,finalPath:url.pathname};
    }
    throw createError(502,'모바일 좌석 화면의 이동 횟수가 너무 많습니다.');
  }
  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    try {
      if (pathname === '/api/health' && req.method === 'GET') return response(res, 200, { ok: true, name: 'ssamcafe-private-bridge', version: APP_VERSION });
      if (pathname.startsWith('/api/')) {
        const presentedCookie = parseCookie(req.headers.cookie)[COOKIE] || '';
        const s = getSession(req, res);
        const cookieRecognized = Boolean(presentedCookie && presentedCookie === s.sid);
        const sessionInfo = { cookieSent: Boolean(presentedCookie), cookieRecognized, serverStartedAt: startedAt };
        if (pathname === '/api/session' && req.method === 'GET') return response(res, 200, { authenticated: !!s.token, name: s.token ? s.name : '', csrf: s.csrf, mode: 'WireGuard private, read-only', upstreamVerified: false, version: APP_VERSION, session: sessionInfo, lastLogin: s.lastLogin });
        if (pathname === '/api/diagnostics' && req.method === 'GET') return response(res, 200, { version: APP_VERSION, authenticated: !!s.token, lastCheck: s.lastDiagnostic, session: sessionInfo, lastLogin: s.lastLogin, seatPage: s.lastSeatDiagnostic });
        if (pathname === '/api/login' && req.method === 'POST') {
          checkMutation(req, s);
          const loginTrace = { checkedAt: new Date(now()).toISOString(), stage: 'started', upstreamCode: null, codeLocation: null, resultType: null, rescode: null, resultKeys: [], outerKeys: [], secondFactorAccepted: null, tokenProvided: null };
          s.lastLogin = loginTrace;
          const key = req.socket.remoteAddress || 'unknown';
          const recent = (attempts.get(key) || []).filter(t => now() - t < 300_000);
          if (recent.length >= 20) { loginTrace.stage = 'rate_limited'; throw createError(429, '로그인 요청 제한(5분에 20회)입니다.'); }
          recent.push(now()); attempts.set(key, recent);
          const v = await bodyJson(req);
          if (typeof v.username !== 'string' || !v.username.trim() || v.username.length > 120 || typeof v.password !== 'string' || !v.password || v.password.length > 250 || (v.deviceId !== undefined && (typeof v.deviceId !== 'string' || v.deviceId.length < 8 || v.deviceId.length > 128))) throw createError(400, '로그인 입력값을 확인하세요.');
          s.token = ''; s.name = ''; s.jar.clear(); s.lastDiagnostic = null; s.lastSeatDiagnostic = null;
          if (v.deviceId) s.device = v.deviceId;
          const payload = loginPayload(v.username.trim(), v.password, s.device);
          loginTrace.stage = 'connecting_to_upstream';
          let text;
          try {
            ({ text } = await upstream(`${UPSTREAM}/api/app.do`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) }, s.jar));
          } catch (e) {
            loginTrace.stage = 'upstream_connection_failed';
            throw e;
          }
          loginTrace.stage = 'upstream_responded';
          let result;
          try { result = upstreamPayload(text); }
          catch {
            loginTrace.stage = 'upstream_response_unrecognized';
            throw createError(502, '로그인 응답 형식 또는 성공 코드 위치가 예상과 다릅니다.');
          }
          // Only store non-secret, bounded protocol metadata. Never store user ID, password, raw response, or token.
          loginTrace.upstreamCode = String(result.rspcode ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || null;
          loginTrace.codeLocation = result.__meta.codeLocation;
          loginTrace.resultType = result.__meta.resultType;
          loginTrace.rescode = result.__meta.rescode;
          loginTrace.resultKeys = result.__meta.resultKeys;
          loginTrace.outerKeys = result.__meta.outerKeys;
          loginTrace.secondFactorAccepted = String(result.s_value ?? '').toUpperCase() === 'Y';
          loginTrace.tokenProvided = Boolean(result.a_value);
          if (String(result.rspcode ?? '') !== '0000') {
            loginTrace.stage = result.rspcode === null ? 'success_code_missing' : 'upstream_rejected';
            throw createError(401, clean(result.rspmsg || result.resmsg || (result.rspcode === null ? '서버 응답에서 로그인 성공 코드를 찾지 못했습니다.' : '쌤카페 서버가 로그인을 거부했습니다.')));
          }
          if (!loginTrace.secondFactorAccepted || !loginTrace.tokenProvided) {
            loginTrace.stage = 'additional_auth_required';
            throw createError(409, '쌤카페 로그인 응답에 앱 추가 인증 또는 기기 등록이 필요하다고 표시됐습니다.');
          }
          s.token = String(result.a_value); s.name = String(result.name || '회원').slice(0, 80);
          loginTrace.stage = 'authenticated';
          return response(res, 200, { authenticated: true, name: s.name });
        }
        if (pathname === '/api/logout' && req.method === 'POST') {
          checkMutation(req, s); s.token = ''; s.name = ''; s.jar.clear(); s.lastDiagnostic = null; s.lastLogin = null; s.lastSeatDiagnostic = null;
          return response(res, 200, { ok: true });
        }
        // Read the entry QR only when the signed-in user explicitly opens the QR screen.
        // Never include QR payloads in status, diagnostics, URLs, logs, or persistent storage.
        // The native APK opens enterSeatView.do using tk,m_value,SHOP_NO,FLOOR_NO.
        // All upstream credentials stay on this VPN-only server. HTML and scripts
        // are parsed as DATA and are never executed or sent to the user's browser.
        if (pathname === '/api/seat-layout' && req.method === 'GET') {
          if (!s.token) throw createError(401,'좌석별 현황을 보려면 로그인해 주세요.');
          let home;
          try{
            const remote=await upstream(UPSTREAM+'/api/app.do',{
              method:'POST',
              headers:{'Content-Type':'application/json',Accept:'application/json'},
              body:JSON.stringify({cmd:'1100',m_value:s.device,tk:s.token,latitude:'0',longitude:'0'})
            },s.jar);
            home=upstreamPayload(remote.text);
          }catch{
            return response(res,200,{ok:false,source:'app-home',seats:[],reason:'앱 홈에서 매장·층 정보를 확인하지 못했습니다.'});
          }
          if(String(home.rspcode??'')!=='0000')
            return response(res,200,{ok:false,source:'app-home',seats:[],reason:'앱 홈에서 현재 매장 정보를 조회할 수 없습니다.'});
          const shopNo=readable(home.home_shop_no,40);
          const detectedFloor=readable(home.home_floor_no,40);
          // Display both native seating tabs as read-only information,
          // independent of the user's ticket type.
          const requestedFloor=new URL(req.url??'','http://localhost').searchParams.get('floor');
          if(requestedFloor!==null&&!/^[1-9][0-9]?$/.test(requestedFloor))
            throw createError(400,'좌석 구역 선택값이 올바르지 않습니다.');
          const floorNo=requestedFloor||detectedFloor;
          if(!/^[0-9A-Za-z_-]{1,40}$/.test(shopNo))
            return response(res,200,{ok:false,source:'app-home',seats:[],reason:'현재 매장번호가 없어 좌석 조회 화면을 특정할 수 없습니다.'});
          const validFloor=/^[0-9A-Za-z_-]{1,40}$/.test(floorNo);
          const diagnosticContext={
            floorSource:requestedFloor?'user-selected-room-tab':'home-api',
            passFiltered:false,
            hasShopNo:true,hasFloorNo:validFloor,
            observedCookieCount:s.jar.size,
            clientType:'Android WebView request emulation',
            homeResponseKeys:Object.keys(home).filter(k=>/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(k)&&k!=='__meta').slice(0,100),
            expectedSeatCounts:{
              personal:{total:validCount(home.home_shop_tot_p),used:validCount(home.home_shop_use_p)},
              group:{total:validCount(home.home_shop_tot_g),used:validCount(home.home_shop_use_g)},
              locker:{total:validCount(home.home_shop_tot_l),used:validCount(home.home_shop_use_l)}
            }
          };
          const attempts=[];
          let provisionalSeats=null;
          // APK Lg5/c.onSingleClick uses getPersonal() for the normal
          // personal-seat screen (token, device, shop); the earlier code
          // incorrectly probed only enter/change screens.
          for(const [name,pathnameUp,needsFloor] of [
            ['personal','/mobile/purchase/personal.do',false],
            ['enter','/mobile/enterSeatView.do',true],
            ['change','/mobile/seatChangeView.do',true]
          ]){
            if(needsFloor&&!validFloor){
              attempts.push({name,error:'층 번호 없음 · 해당 화면의 조회 생략'});continue;
            }
            const url=new URL(pathnameUp,UPSTREAM);
            url.searchParams.set('tk',s.token);
            url.searchParams.set('m_value',s.device);
            url.searchParams.set('SHOP_NO',shopNo);
            if(needsFloor)url.searchParams.set('FLOOR_NO',floorNo);
            const started=now();
            try{
              const remote=await upstreamMobilePage(url,s.jar);
              const mime=remote.resp.headers.get('content-type')||'';
              if(!/html/i.test(mime)){attempts.push({name,error:'HTML 형식이 아닌 응답',mime:mime.split(';')[0],redirects:remote.redirects,durationMs:now()-started});continue;}
              const parsed=parseSeatLayout(remote.text,name);
              attempts.push({name,summary:parsed.summary,inspect:parsed.inspect,durationMs:now()-started,
                requestFieldNames:[...url.searchParams.keys()],requestMethod:'GET',
                http:seatHttpMetadata(remote.resp,remote.text),
                redirects:remote.redirects,finalPath:remote.finalPath});
              if(parsed.seats.length){
                // An inline seatNo_ marker is an ID, not reliable occupancy
                // evidence. Keep scanning read-only APIs before presenting it.
                if(parsed.partialSeatList || (parsed.inspect?.nativeMarkers?.count||0)>0){
                  if(!provisionalSeats||parsed.seats.length>provisionalSeats.seats.length)
                    provisionalSeats=parsed;
                }else{
                  s.lastSeatDiagnostic={
                    checkedAt:new Date(now()).toISOString(),...diagnosticContext,shopIdentified:Boolean(readable(home.home_shop_name)),
                    floorNo,source:name,summary:parsed.summary,
                    detectedScripts:parsed.inspect.scriptPaths,
                    attempts:attempts.map(a=>({
                      name:a.name,summary:a.summary||null,
                      nativeSeatMarkers:a.inspect?.nativeMarkers||null,
                      nativeLayout:a.inspect?.nativeLayout||null,
                      forensic:a.inspect?.forensic||null,
                      structure:a.inspect?.structure||null,
                      http:a.http||null,durationMs:a.durationMs??null
                    }))
                  };
                  return response(res,200,{
                    ok:true,shopName:readable(home.home_shop_name),floorNo,
                    ...parsed,
                    note:parsed.actualPositions?'실제 페이지에 포함된 좌표로 표시':'확인된 좌석번호와 상태를 목록형으로 표시합니다. 전체 배치도와 다를 수 있습니다.'
                  });
                }
              }
            }catch(e){
              attempts.push({name,error:e.status?readable(e.message,120):'HTML 구조 또는 응답을 분석할 수 없음',durationMs:now()-started});
            }
          }
          // If the WebView only renders a JavaScript shell, discover the seat
          // *read* requests used by its own scripts. Never execute upstream JS.
          const allScripts=[...new Set(attempts.flatMap(a=>a.inspect?.scriptPaths||[]))]
            .filter(p=>p.startsWith('/')&&!p.includes('..')&&/\.m?js$/i.test(p))
            .sort((a,b)=>Number(/seat|chart|floor/i.test(b))-Number(/seat|chart|floor/i.test(a)));
          const scripts=allScripts.slice(0,14);
          const requestHints=attempts.flatMap(a=>a.inspect?.requestHints||[]);
          const discovered=[...new Set([...requestHints.map(x=>x.path),...attempts.flatMap(a=>a.inspect?.candidateApiPaths||[])])];
          const inspected=[];
          await Promise.all(scripts.map(async p=>{
            const assetStarted=now();
            try{
              const url=new URL(p,UPSTREAM);
              if(url.origin!==UPSTREAM)return;
              const remote=await upstream(url,{method:'GET',headers:{Accept:'text/javascript,application/javascript','User-Agent':NATIVE_WEBVIEW_UA,Referer:UPSTREAM+'/mobile/purchase/personal.do'}},s.jar);
              const analysis=analyzeSeatScript(remote.text);
              const candidates=findSeatApiPaths(remote.text);
              inspected.push({path:p,candidates,durationMs:now()-assetStarted,
                http:seatHttpMetadata(remote.resp,remote.text),code:analysis});
              for(const hint of analysis.requestHints||[])requestHints.push(hint);
              for(const candidate of [...candidates,...(analysis.requestHints||[]).map(h=>h.path)])discovered.push(candidate);
            }catch{inspected.push({path:p,error:'JavaScript 파일 조회 불가',durationMs:now()-assetStarted});}
          }));
          // The personal.do form with a checkbox is NOT evidence for a seat API.
          // Do not issue arbitrary POST requests to upstream HTML forms.
          const lookupPaths=[...new Set(discovered)]
            .filter(p=>p!=='/mobile/purchase/personal.do')
            .slice(0,10);
          const probes=[];
          for(const p of lookupPaths){
            const url=new URL(p,UPSTREAM);
            if(url.origin!==UPSTREAM||!url.pathname.startsWith('/mobile/')&&!url.pathname.startsWith('/api/'))continue;
            // POST is used only if the real HTML script or form explicitly
            // declares POST for this allowlisted chart/seat read route.
            const matchedHints=requestHints.filter(x=>x.path===p);
            const confirmedAjax=matchedHints.filter(h=>['ajax','fetch','load'].includes(h.source));
            const explicitPost=confirmedAjax.some(x=>x.method==='POST');
            const method=explicitPost?'POST':'GET';
            const evidence=explicitPost?'script-confirmed-post':
              confirmedAjax.length?'script-confirmed-get':
              matchedHints.some(x=>x.source==='form')?'form-only (not submitted)':'static-path-only';
            const params=new URLSearchParams();
            // Only bind proven app context values to known query/form names.
            const knownFields={
              tk:s.token,m_value:s.device,
              SHOP_NO:shopNo,FLOOR_NO:validFloor?floorNo:'',
              shop_no:shopNo,floor_no:validFloor?floorNo:'',
              shopNo:shopNo,floorNo:validFloor?floorNo:'',
              shop_no_key:shopNo
            };
            if(method==='GET'){
              for(const [key,value] of Object.entries(knownFields))
                if(['tk','m_value','SHOP_NO','FLOOR_NO'].includes(key)&&value)url.searchParams.set(key,value);
            } else {
              const hintedFields=[...new Set(confirmedAjax.flatMap(h=>h.fields||[]))];
              // The form's exact parameter names are safer than guessing
              // undocumented action types, seat IDs, or order identifiers.
              for(const key of hintedFields)
                if(Object.hasOwn(knownFields,key)&&knownFields[key])params.set(key,knownFields[key]);
              if(params.size===0){
                for(const key of ['tk','m_value','SHOP_NO','FLOOR_NO'])
                  if(knownFields[key])params.set(key,knownFields[key]);
              }
            }
            const probeStarted=now();
            try{
              const remote=await upstream(url,{
                method,
                headers:{
                  Accept:'application/json,text/html',
                  Referer:UPSTREAM+'/mobile/purchase/personal.do',
                  'User-Agent':NATIVE_WEBVIEW_UA,
                  ...(confirmedAjax.length?{'X-Requested-With':'XMLHttpRequest'}:{}),
                  ...(method==='POST'?{'Content-Type':'application/x-www-form-urlencoded',Origin:UPSTREAM}:{})
                },
                ...(method==='POST'?{body:params.toString()}:{})
              },s.jar);
              const result=parseSeatResponse(remote.text,'app-seat-api');
              const type=remote.resp.headers.get('content-type')?.split(';')[0]||'unknown';
              probes.push({
                path:p,method,evidence,durationMs:now()-probeStarted,
                requestedFieldNames:method==='POST'?[...params.keys()]:[...url.searchParams.keys()],
                sourceHints:matchedHints,
                http:seatHttpMetadata(remote.resp,remote.text),
                count:result.summary.count,
                responseAnalysis:result.inspect?.forensic||analyzeSeatDocument(remote.text,type)
              });
              if(result.seats.length){
                s.lastSeatDiagnostic={
                  checkedAt:new Date(now()).toISOString(),...diagnosticContext,shopIdentified:Boolean(readable(home.home_shop_name)),
                  floorNo,source:'app-seat-api',summary:result.summary,
                  detectedScripts:scripts,discoveredScripts:allScripts,detectedReadApis:lookupPaths,requestHints,inspected,
                  attempts:attempts.map(a=>({
                    name:a.name,error:a.error||'',summary:a.summary||null,
                    nativeSeatMarkers:a.inspect?.nativeMarkers||null,
                    nativeLayout:a.inspect?.nativeLayout||null,
                    forensic:a.inspect?.forensic||null,
                    structure:a.inspect?.structure||null,
                    http:a.http||null,durationMs:a.durationMs??null,
                    redirects:a.redirects||[],finalPath:a.finalPath||null
                  })),
                  probes
                };
                return response(res,200,{
                  ok:true,shopName:readable(home.home_shop_name),floorNo,
                  ...result,
                  note:result.actualPositions?'공식 API 좌표로 표시':'실제 좌석 상태를 배열한 그림입니다(물리적인 배치는 아님).'
                });
              }
             }catch(e){
              const upstreamStatus=/\bHTTP\s+(\d{3})/.exec(String(e.message||''))?.[1]||null;
              probes.push({
                path:p,method,evidence,durationMs:now()-probeStarted,error:e.status?'공식 서버 HTTP 응답 오류':'응답 확인 실패',
                upstreamHttpStatus:upstreamStatus?Number(upstreamStatus):null,
                requestedFieldNames:method==='POST'?[...params.keys()]:[...url.searchParams.keys()]
              });
            }
          }
          s.lastSeatDiagnostic={
            checkedAt:new Date(now()).toISOString(),...diagnosticContext,shopIdentified:Boolean(readable(home.home_shop_name)),
            floorNo,source:provisionalSeats?.source||null,summary:provisionalSeats?.summary||null,
            detectedScripts:scripts,discoveredScripts:allScripts,detectedReadApis:lookupPaths,requestHints,
            inspected,probes,
            attempts:attempts.map(a=>({
              name:a.name,error:a.error||'',summary:a.summary||null,
              hints:a.inspect?.hints||null,requestHints:a.inspect?.requestHints||[],
              structure:a.inspect?.structure||null,
              nativeSeatMarkers:a.inspect?.nativeMarkers||null,
              nativeLayout:a.inspect?.nativeLayout||null,
              forensic:a.inspect?.forensic||null,http:a.http||null,durationMs:a.durationMs??null,
              requestMethod:a.requestMethod||'GET',requestFieldNames:a.requestFieldNames||[],
              redirects:a.redirects||[],finalPath:a.finalPath||null,
              htmlCharacters:a.inspect?.htmlCharacters??null
            }))
          };
          if(provisionalSeats){
            return response(res,200,{
              ok:true,shopName:readable(home.home_shop_name),floorNo,
              ...provisionalSeats,
              partialSeatList:true,
              note:'앱의 인라인 스크립트에서 실제 좌석번호 일부만 확인했습니다. 빈자리·이용 중 상태와 위치는 미확인입니다.',
              inspect:{attempts:s.lastSeatDiagnostic.attempts,detectedScripts:scripts,
                detectedReadApis:lookupPaths,discoveredScripts:allScripts,requestHints,inspected,probes}
            });
          }
          return response(res,200,{
            ok:false,shopName:readable(home.home_shop_name),floorNo,seats:[],
            reason:'공식 좌석 화면과 읽기 전용 추가 API에서 좌석별 번호·상태를 확인하지 못했습니다. 좌석총계는 정상이며, 개별 상태는 추정하지 않습니다.',
            inspect:{attempts:s.lastSeatDiagnostic.attempts,detectedScripts:scripts,
              detectedReadApis:lookupPaths,discoveredScripts:allScripts,requestHints,inspected,probes}
          });
        }
        if (pathname === '/api/entry-qr' && req.method === 'GET') {
          if (!s.token) throw createError(401,'로그인 후 입장 QR을 확인할 수 있습니다.');
          const remote=await upstream(UPSTREAM+'/api/app.do',{
            method:'POST',
            headers:{'Content-Type':'application/json',Accept:'application/json'},
            body:JSON.stringify({cmd:'1100',m_value:s.device,tk:s.token,latitude:'0',longitude:'0'})
          },s.jar);
          let qrResponse;
          try{qrResponse=upstreamPayload(remote.text);}
          catch{throw createError(502,'공식 앱 홈의 QR 응답을 해석하지 못했습니다.');}
          if(String(qrResponse.rspcode??'')!=='0000') throw createError(502,'공식 앱 홈 데이터 조회가 실패했습니다.');
          const qr=qrResponse.home_qr_code;
          if(typeof qr!=='string'||qr.trim()===''||qr.length>3000)
            throw createError(404,'현재 계정의 앱 입장 QR이 제공되지 않았습니다.');
          return response(res,200,{
            qr,
            shopName:readable(qrResponse.home_shop_name),
            qrAvailable:true,
            use:'공식 앱 홈 QR입니다. 현장 스캐너에서 입·퇴실에 사용할 수 있는지는 매장 운영 방식에 따라 직접 확인해야 합니다.',
            exitQrVerified:false
          });
        }
        if (pathname === '/api/status' && req.method === 'GET') {
          if (!s.token) throw createError(401, '먼저 본인 계정으로 로그인하세요.');
          const entries = await Promise.all(Object.entries(PAGE_PATHS).map(async ([kind, page]) => {
            const url = new URL(page, UPSTREAM);
            url.searchParams.set('tk', s.token);
            url.searchParams.set('m_value', s.device);
            try {
              const { resp, text } = await upstream(url, { method: 'GET', headers: { Accept: 'text/html,application/xhtml+xml' } }, s.jar);
              if (!resp.headers.get('content-type')?.toLowerCase().includes('html')) return [kind, { ok: false, error: 'HTML 형식의 응답이 아닙니다.' }];
              const parsed = pageText(text);
              if (/^(?:성공|success|ok|true)$/i.test(parsed.trim())) return [kind, { ok: false, error: '서버가 성공 문구만 반환했으며 실제 회원 데이터는 없습니다.' }];
              if (!parsed || (/로그인/.test(parsed.slice(0, 100)) && /아이디/.test(parsed.slice(0, 250)) && /비밀번호/.test(parsed.slice(0, 250)))) return [kind, { ok: false, error: '로그인 페이지 또는 빈 화면이 반환됐습니다.' }];
              return [kind, { ok: true, text: parsed }];
            } catch (e) { return [kind, { ok: false, error: e.message.startsWith('쌤카페 서버') ? e.message : '페이지 조회 실패' }]; }
          }));
          // Native app: cmd 1100 returns current/home shop and recently used shop data.
          // cmd 1101 returns last goods use records. These are structured app responses.
          async function readAppData(cmd, fields={}) {
            try {
              const remote=await upstream(UPSTREAM+'/api/app.do',{
                method:'POST',
                headers:{'Content-Type':'application/json',Accept:'application/json'},
                body:JSON.stringify({cmd,m_value:s.device,tk:s.token,...fields})
              },s.jar);
              const payload=upstreamPayload(remote.text);
              if(String(payload.rspcode??'')!=='0000')
                return {ok:false,reason:'API 응답코드 '+readable(payload.rspcode,16)};
              return {ok:true,payload};
            }catch(e) {
              return {ok:false,reason:e.status?'서버 응답 오류':'응답 해석 실패'};
            }
          }
          const [home,goods]=await Promise.all([
            readAppData('1100',{latitude:'0',longitude:'0'}),
            readAppData('1101')
          ]);
          const sources=Object.fromEntries(entries);
          const result=extractStructuredData(home.ok?home.payload:null, goods.ok?goods.payload:null, sources);
          result.live.name=s.name;
          result.live.sources=sources;
          result.live.apis={
            home:{ok:home.ok,reason:home.ok?'':home.reason},
            goods:{ok:goods.ok,reason:goods.ok?'':goods.reason}
          };
          const pages = Object.fromEntries(entries.map(([kind, info]) => [kind, {
            ok: info.ok,
            characters: info.ok ? info.text.length : 0,
            reason: info.ok ? '' : info.error,
          }]));
          s.lastDiagnostic = {
            checkedAt: new Date(now()).toISOString(),
            pages,
            apis: result.live.apis,
            summary: {
              pagesLoaded: Object.values(pages).filter(p => p.ok).length,
              seatFound: !!result.member.seat,
              remainingTimeFound: Number.isFinite(result.member.ticket.remainingMinutes),
              seatLayoutFound: result.seats.length > 0,
              shopFound: result.store.name !== '매장 정보 미확인',
              ticketFound: result.live.ticketItems.length > 0,
              homeApiSucceeded: home.ok,
              goodsApiSucceeded: goods.ok,
            },
          };
          return response(res, 200, result);
        }
        throw createError(404, '지원되지 않는 API입니다.');
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const asset = ASSETS[pathname];
        if (!asset) throw createError(404, '파일을 찾을 수 없습니다.');
        const data = await readFile(path.join(PUBLIC, asset[0]));
        res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store, max-age=0, must-revalidate' });
        return res.end(req.method === 'HEAD' ? undefined : data);
      }
      throw createError(405, '지원되지 않는 요청입니다.');
    } catch (e) {
      response(res, Number.isInteger(e.status) ? e.status : 500, { detail: Number.isInteger(e.status) ? e.message : '서버 내부 오류가 발생했습니다.' });
    }
  }
  return http.createServer(handle);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 범위는 1024~65535입니다.');
  createApp().listen(port, host, () => console.log(`SSAMCAFE web bridge listening on http://${host}:${port} (private WireGuard only)`));
}
