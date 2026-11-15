import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, loginPayload } from '../server.mjs';
import { createHash } from 'node:crypto';

const mkResponse = (body, type = 'text/html; charset=utf-8', status = 200) => new Response(body, { status, headers: { 'content-type': type } });

test('mocked login, 4 member pages, logout, CSRF, no token leaks, static allowlist', async () => {
  const requests = [];
  const secret = 'MOCK_TOKEN_NEVER_SEND_TO_BROWSER';
  const fakeFetch = async (u, options) => {
    const url = new URL(u);
    requests.push({ url, options });
    assert.equal(url.host, 'm.ssamcafe.com');
    if (url.pathname === '/api/app.do') {
      const p = JSON.parse(options.body);
      assert.equal(p.cmd, '1201');
      assert.equal(p.id, 'testuser');
      assert.equal(p.m_value.length, 16);
      assert.equal(p.password, createHash('sha256').update('test-password' + '2V35NWWYUOQAUVONRI85298Q2YG5OY0F').digest('hex').toUpperCase());
      return mkResponse(JSON.stringify({ result: JSON.stringify({ rspcode: '0000', s_value: 'Y', a_value: secret, name: '테스트회원' }) }), 'application/json');
    }
    assert.equal(url.searchParams.get('tk'), secret);
    assert.match(url.searchParams.get('m_value'), /^[0-9a-f]{16}$/);
    const pages = {
      '/mobile/myInfo/main.do': '<h1>내 정보</h1><p>잔여시간 1시간 40분</p>',
      '/mobile/myInfo/bookingStats.do': '<h2>좌석</h2><p>현재 좌석 A12석</p>',
      '/mobile/shop/shopTicketList.do': '<h2>이용권</h2><p>남은 시간 2시간 5분</p><script>LEAK ME</script>',
      '/mobile/myInfo/useList.do': '<h2>이용내역</h2><p>1회 이용</p>',
    };
    assert.ok(Object.hasOwn(pages, url.pathname), url.pathname);
    return mkResponse('<html><body>' + pages[url.pathname] + '</body></html>');
  };
  const server = createApp({ fetchImpl: fakeFetch });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const visit = async (path, opts = {}) => {
    const r = await fetch(base + path, { ...opts, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) } });
    if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
    return r;
  };
  try {
    const health = await visit('/api/health');
    assert.equal(health.status, 200);
    const status = await visit('/api/session');
    const { csrf, authenticated } = await status.json();
    assert.equal(authenticated, false);
    assert.ok(cookie.startsWith('ssam_bridge_sid='));
    assert.equal((await visit('/api/status')).status, 401);
    assert.equal((await visit('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
    const login = await visit('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ username: 'testuser', password: 'test-password' }) });
    const loggedIn = await login.text();
    assert.equal(login.status, 200, loggedIn);
    assert.equal(loggedIn.includes(secret), false);
    const data = await visit('/api/status');
    const raw = await data.text();
    assert.equal(data.status, 200, raw);
    const out = JSON.parse(raw);
    assert.equal(out.member.seat, 'A12');
    assert.equal(out.member.ticket.remainingMinutes, 125);
    assert.equal(out.seats.length, 0);
    assert.equal(raw.includes(secret), false);
    assert.equal(raw.includes('LEAK ME'), false);
    assert.equal(requests.length, 5);
    for (const p of ['/server.mjs','/tests/server.test.mjs','/deploy/install.sh','/README.md','/.git/config']) assert.equal((await visit(p)).status, 404);
    assert.equal((await visit('/app.js')).status, 200);
    assert.equal((await visit('/api/logout',{ method:'POST', headers: { 'X-CSRF-Token': csrf } })).status, 200);
    assert.equal((await visit('/api/status')).status, 401);
  } finally { await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});

test('wrong origin rejected; nonexistent API rejected', async () => {
  const server = createApp({ fetchImpl: async () => { throw Error('should not call upstream'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(base + '/api/session');
    const csrf = (await r.json()).csrf;
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const denied = await fetch(base + '/api/logout', { method:'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: 'https://attacker.example' } });
    assert.equal(denied.status,403);
    assert.equal((await fetch(base + '/api/arbitrary')).status,404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('sha256 login payload produces expected fields', () => {
  const p = loginPayload('demo', 'test', 'abcdef12345');
  assert.deepEqual(Object.keys(p), ['cmd','id','password','m_value']);
  assert.equal(p.password.length, 64);
  assert.equal(p.password.toUpperCase(), p.password);
});
