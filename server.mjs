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

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const UPSTREAM = 'https://m.ssamcafe.com';
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

export function loginPayload(username, password, device) {
  const digest = createHash('sha256').update(password + PASSWORD_SUFFIX, 'utf8').digest('hex').toUpperCase();
  return { cmd: '1201', id: username, password: digest, m_value: device };
}

function upstreamPayload(raw) {
  const outer = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!outer || typeof outer !== 'object') throw new Error('로그인 응답이 JSON 객체가 아닙니다.');
  const result = typeof outer.result === 'string' ? JSON.parse(outer.result) : outer.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('로그인 응답의 result 구조를 확인하지 못했습니다.');
  return result;
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
  function getSession(req, res) {
    const cookieVal = parseCookie(req.headers.cookie)[COOKIE] ?? '';
    let s = cookieVal && sessions.get(cookieVal);
    const t = now();
    if (s && t - s.last < TTL_MS) { s.last = t; return s; }
    if (cookieVal) sessions.delete(cookieVal);
    for (const [id, sess] of sessions) if (t - sess.last >= TTL_MS) sessions.delete(id);
    if (sessions.size >= 100) throw createError(503, '동시 사용자가 너무 많습니다.');
    const key = rand();
    s = { csrf: rand(24), device: randomBytes(8).toString('hex'), last: t, token: '', name: '', jar: new Map() };
    sessions.set(key, s);
    const secure = req.socket.encrypted ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${key}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL_MS/1000}${secure}`);
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
  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    try {
      if (pathname === '/api/health' && req.method === 'GET') return response(res, 200, { ok: true, name: 'ssamcafe-private-bridge' });
      if (pathname.startsWith('/api/')) {
        const s = getSession(req, res);
        if (pathname === '/api/session' && req.method === 'GET') return response(res, 200, { authenticated: !!s.token, name: s.token ? s.name : '', csrf: s.csrf, mode: 'WireGuard private, read-only', upstreamVerified: false });
        if (pathname === '/api/login' && req.method === 'POST') {
          checkMutation(req, s);
          const key = req.socket.remoteAddress || 'unknown';
          const recent = (attempts.get(key) || []).filter(t => now() - t < 300_000);
          if (recent.length >= 20) throw createError(429, '로그인 요청 제한(5분에 20회)입니다.');
          recent.push(now()); attempts.set(key, recent);
          const v = await bodyJson(req);
          if (typeof v.username !== 'string' || !v.username.trim() || v.username.length > 120 || typeof v.password !== 'string' || !v.password || v.password.length > 250 || (v.deviceId !== undefined && (typeof v.deviceId !== 'string' || v.deviceId.length < 8 || v.deviceId.length > 128))) throw createError(400, '로그인 입력값을 확인하세요.');
          s.token = ''; s.name = ''; s.jar.clear();
          if (v.deviceId) s.device = v.deviceId;
          const payload = loginPayload(v.username.trim(), v.password, s.device);
          const { text } = await upstream(`${UPSTREAM}/api/app.do`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) }, s.jar);
          let result;
          try { result = upstreamPayload(text); }
          catch { throw createError(502, '로그인 응답 형식이 APK 분석 결과와 다릅니다.'); }
          if (String(result.rspcode ?? '') !== '0000') throw createError(401, clean(result.rspmsg || result.resmsg || '서버가 로그인을 거부했습니다.'));
          if (String(result.s_value ?? '').toUpperCase() !== 'Y' || !result.a_value) throw createError(409, '앱 추가 인증 또는 기기 등록이 필요한 상태일 수 있습니다.');
          s.token = String(result.a_value); s.name = String(result.name || '회원').slice(0, 80);
          return response(res, 200, { authenticated: true, name: s.name });
        }
        if (pathname === '/api/logout' && req.method === 'POST') {
          checkMutation(req, s); s.token = ''; s.name = ''; s.jar.clear();
          return response(res, 200, { ok: true });
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
              if (!parsed || (/로그인/.test(parsed.slice(0, 100)) && /아이디/.test(parsed.slice(0, 250)) && /비밀번호/.test(parsed.slice(0, 250)))) return [kind, { ok: false, error: '로그인 페이지 또는 빈 화면이 반환됐습니다.' }];
              return [kind, { ok: true, text: parsed }];
            } catch (e) { return [kind, { ok: false, error: e.message.startsWith('쌤카페 서버') ? e.message : '페이지 조회 실패' }]; }
          }));
          return response(res, 200, asStatus(Object.fromEntries(entries), s.name));
        }
        throw createError(404, '지원되지 않는 API입니다.');
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const asset = ASSETS[pathname];
        if (!asset) throw createError(404, '파일을 찾을 수 없습니다.');
        const data = await readFile(path.join(PUBLIC, asset[0]));
        res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
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
