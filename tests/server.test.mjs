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
    assert.equal(requests.length, 7);
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


test('login rate limit allows 20 requests in 5 minutes and blocks the 21st', async () => {
  let sent = 0;
  const server = createApp({ now: () => 1_000, fetchImpl: async () => {
    sent += 1;
    return mkResponse(JSON.stringify({ result: { rspcode: '1001', rspmsg: '잘못된 로그인' } }), 'application/json');
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(base + '/api/session');
    const csrf = (await response.json()).csrf;
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const opts = { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ username: 'test', password: 'wrong' }) };
    for (let i = 0; i < 20; i++) assert.equal((await fetch(base + '/api/login', opts)).status, 401);
    const limited = await fetch(base + '/api/login', opts);
    assert.equal(limited.status, 429);
    assert.match((await limited.text()), /5분에 20회/);
    assert.equal(sent, 20);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('generic success-only pages are reported as failed data extraction, with redacted diagnostics', async () => {
  const secret = 'SECRET_DIAGNOSTIC_TEST_TOKEN';
  const fakeFetch = async (u) => new URL(u).pathname === '/api/app.do'
    ? mkResponse(JSON.stringify({ result: { rspcode: '0000', s_value: 'Y', a_value: secret, name: '테스트' } }), 'application/json')
    : mkResponse('<html><body>성공</body></html>');
  const server = createApp({ fetchImpl: fakeFetch });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const initial = await fetch(base + '/api/session');
    const csrf = (await initial.json()).csrf;
    const Cookie = initial.headers.get('set-cookie').split(';')[0];
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { Cookie, 'Content-Type':'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ username: 'demo', password:'test' }) });
    assert.equal(login.status, 200);
    const status = await fetch(base + '/api/status', { headers: { Cookie } });
    assert.equal(status.status, 200);
    const data = await status.json();
    assert.equal(data.member.seat, null);
    assert.equal(data.member.ticket.remainingMinutes, null);
    assert.ok(Object.values(data.live.sources).every(page => !page.ok && /성공 문구만 반환/.test(page.error)));
    const diagnosticResponse = await fetch(base + '/api/diagnostics', { headers: { Cookie } });
    assert.equal(diagnosticResponse.status, 200);
    const diagnosticString = await diagnosticResponse.text();
    const diagnostic = JSON.parse(diagnosticString);
    assert.equal(diagnostic.authenticated, true);
    assert.equal(diagnostic.lastCheck.summary.pagesLoaded, 0);
    assert.equal(diagnostic.lastCheck.summary.remainingTimeFound, false);
    assert.equal(diagnostic.lastCheck.summary.seatFound, false);
    assert.ok(!diagnosticString.includes(secret));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Safari session cookie continuity and stale sessions after restart', async () => {
  const first = createApp();
  await new Promise(resolve => first.listen(0, '127.0.0.1', resolve));
  let cookie;
  const addr='http://127.0.0.1:'+first.address().port;
  try {
    const response=await fetch(addr+'/api/session');
    const data=await response.json();
    assert.equal(data.authenticated,false);
    assert.equal(data.session.cookieSent,false);
    assert.equal(data.session.cookieRecognized,false);
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
    cookie=response.headers.get('set-cookie').split(';')[0];
    const another=await fetch(addr+'/api/session',{headers:{Cookie:cookie}});
    const known=await another.json();
    assert.equal(known.session.cookieSent,true);
    assert.equal(known.session.cookieRecognized,true);
    assert.equal(known.csrf,data.csrf);
    assert.ok(known.session.serverStartedAt);
  } finally {await new Promise(resolve=>first.close(resolve));}
  const restarted=createApp();
  await new Promise(resolve=>restarted.listen(0,'127.0.0.1',resolve));
  try {
    const fresh=await fetch('http://127.0.0.1:'+restarted.address().port+'/api/session',{headers:{Cookie:cookie}});
    const data=await fresh.json();
    assert.equal(data.authenticated,false);
    assert.equal(data.session.cookieSent,true);
    assert.equal(data.session.cookieRecognized,false);
    assert.ok(fresh.headers.get('set-cookie'));
  } finally {await new Promise(resolve=>restarted.close(resolve));}
});

test('login trace distinguishes upstream rejection, additional auth, malformed response and success', async () => {
  const secret = 'NEVER_SHOW_SECRET_AUTH_TOKEN';
  const cases = [
    { status: 401, stage: 'upstream_rejected', code: '1001', upstream: { result: { rspcode: '1001', s_value: 'N', rspmsg: '비밀번호 오류' } } },
    { status: 409, stage: 'additional_auth_required', code: '0000', upstream: { result: { rspcode: '0000', s_value: 'N' } } },
    { status: 502, stage: 'upstream_response_unrecognized', code: null, upstream: { result: '{not json' } },
    { status: 200, stage: 'authenticated', code: '0000', upstream: { result: { rspcode: '0000', s_value: 'Y', a_value: secret, name: '회원' } } },
  ];
  for (const scenario of cases) {
    const srv=createApp({ fetchImpl: async () => mkResponse(JSON.stringify(scenario.upstream), 'application/json') });
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    const base='http://127.0.0.1:'+srv.address().port;
    try {
      const start=await fetch(base+'/api/session');
      const csrf=(await start.json()).csrf;
      const cookie=start.headers.get('set-cookie').split(';')[0];
      const login=await fetch(base+'/api/login',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({username:'user1',password:'secret-password'})});
      assert.equal(login.status,scenario.status);
      const diagResp=await fetch(base+'/api/diagnostics',{headers:{Cookie:cookie}});
      assert.equal(diagResp.status,200);
      const raw=await diagResp.text();
      const diag=JSON.parse(raw);
      assert.equal(diag.lastLogin.stage,scenario.stage);
      assert.equal(diag.lastLogin.upstreamCode,scenario.code);
      assert.equal(diag.authenticated,scenario.status===200);
      assert.equal(raw.includes(secret),false);
      assert.equal(raw.includes('secret-password'),false);
      assert.equal(raw.includes('user1'),false);
    } finally {
      await new Promise(resolve => srv.close(resolve));
    }
  }
});

test('login envelope code locations and missing codes', async () => {
  const scenarios=[
    {name:'outer rspcode', expected:200, stage:'authenticated', location:'outer', shape:{rspcode:'0000', result:{s_value:'Y',a_value:'TOKEN_OUTER',name:'회원'}}},
    {name:'inner rspcode', expected:200, stage:'authenticated', location:'result', shape:{result:{rspcode:'0000',s_value:'Y',a_value:'TOKEN_INNER'}}},
    {name:'missing rspcode despite token', expected:401, stage:'success_code_missing', location:'missing', shape:{result:{rescode:'0000',s_value:'Y',a_value:'TOKEN_UNCONFIRMED'}}},
    {name:'non-success rspcode despite token', expected:401, stage:'upstream_rejected', location:'result', shape:{result:{rspcode:'1002',s_value:'Y',a_value:'TOKEN_DENIED'}}},
    {name:'conflicting codes', expected:502, stage:'upstream_response_unrecognized', location:null, shape:{rspcode:'0000',result:{rspcode:'1002',s_value:'Y',a_value:'TOKEN_CONFLICT'}}},
  ];
  for(const scenario of scenarios){
    const server=createApp({fetchImpl:async()=>mkResponse(JSON.stringify(scenario.shape),'application/json')});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    try{
      const init=await fetch(base+'/api/session');
      const csrf=(await init.json()).csrf;
      const Cookie=init.headers.get('set-cookie').split(';')[0];
      const login=await fetch(base+'/api/login',{method:'POST',headers:{Cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({username:'tester',password:'fake-password'})});
      assert.equal(login.status,scenario.expected,scenario.name);
      const diagResponse=await fetch(base+'/api/diagnostics',{headers:{Cookie}});
      const text=await diagResponse.text();
      const diag=JSON.parse(text);
      assert.equal(diag.authenticated,scenario.expected===200,scenario.name);
      assert.equal(diag.lastLogin.stage,scenario.stage,scenario.name);
      assert.equal(diag.lastLogin.codeLocation,scenario.location,scenario.name);
      assert.equal(diag.lastLogin.tokenProvided,scenario.stage==='upstream_response_unrecognized'?null:true,scenario.name);
      assert.equal(text.includes('TOKEN_'),false,'diagnostics leaked token');
      assert.equal(text.includes('fake-password'),false,'diagnostics leaked password');
      if(scenario.name==='missing rspcode despite token')assert.equal(diag.lastLogin.rescode,'0000');
    }finally{await new Promise(resolve=>server.close(resolve))}
  }
});

test('native structured home API shows real current cafe, recent cafes, and pass names', async () => {
  const calls=[];
  const fakeFetch=async(url,opts)=>{
    const path=new URL(url).pathname;
    if(path==='/api/app.do'){
      const v=JSON.parse(opts.body);
      calls.push(v);
      if(v.cmd==='1201')return mkResponse(JSON.stringify({rspcode:'0000',result:{s_value:'Y',a_value:'TEST_TOKEN',name:'Test Member'}}),'application/json');
      if(v.cmd==='1100'){
        assert.equal(v.tk,'TEST_TOKEN');
        assert.equal(v.latitude,'0');assert.equal(v.longitude,'0');
        return mkResponse(JSON.stringify({rspcode:'0000',result:{
          home_shop_no:'SHOP12',home_shop_name:'실제 앱 홈 매장',
          home_shop_user_remain_m:'125',
          recent_shop_use_list_cnt:1,
          recent_shop_use_list:[{SHOP_NO:'SHOP12',SHOP_NAME:'실제 앱 홈 매장',GOODS_NAME:'10시간권',REMAINTIME:'125',GOODS_TYPE:'TIME',USE_STATE:'Y'}]
        }}),'application/json');
      }
      if(v.cmd==='1101'){
        assert.equal(v.tk,'TEST_TOKEN');
        return mkResponse(JSON.stringify({rspcode:'0000',result:{
          lsat_goods_use_info_cnt:1,
          lsat_goods_use_info:JSON.stringify([{SHOP_NO:'SHOP12',SHOP_NAME:'실제 앱 홈 매장',GOODS_NAME:'10시간권',GOODS_TYPE:'TIME',REMAIN_PERIOD:'7',SEAT_STATE:'Y'}])
        }}),'application/json');
      }
      throw Error('Unexpected app cmd: '+v.cmd);
    }
    return mkResponse('<html><body><div>정보 없음</div></body></html>');
  };
  const server=createApp({fetchImpl:fakeFetch});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const init=await fetch(base+'/api/session');
    const csrf=(await init.json()).csrf;
    const Cookie=init.headers.get('set-cookie').split(';')[0];
    const login=await fetch(base+'/api/login',{method:'POST',headers:{Cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({username:'member',password:'test'})});
    assert.equal(login.status,200);
    const status=await fetch(base+'/api/status',{headers:{Cookie}});
    assert.equal(status.status,200);
    const body=await status.text();
    const data=JSON.parse(body);
    assert.equal(data.store.name,'실제 앱 홈 매장');
    assert.equal(data.member.ticket.name,'10시간권');
    assert.equal(data.member.ticket.remainingMinutes,125);
    assert.equal(data.live.currentShop.shopNo,'SHOP12');
    assert.equal(data.live.recentShops.length,1);
    assert.equal(data.live.ticketItems.length,1);
    assert.equal(data.live.ticketItems[0].remainingPeriod,'7');
    assert.equal(data.live.apis.home.ok,true);
    assert.equal(data.live.apis.goods.ok,true);
    assert.equal(body.includes('TEST_TOKEN'),false);
    const diag=await fetch(base+'/api/diagnostics',{headers:{Cookie}});
    const diagObj=await diag.json();
    assert.equal(diagObj.lastCheck.summary.homeApiSucceeded,true);
    assert.equal(diagObj.lastCheck.summary.goodsApiSucceeded,true);
    assert.equal(diagObj.lastCheck.summary.shopFound,true);
    assert.equal(diagObj.lastCheck.summary.ticketFound,true);
    assert.equal(calls.length,3);
  }finally{await new Promise(resolve=>server.close(resolve))}
});

test('cached HTML shell without structured panel is repaired without a null error', async () => {
  const { readFile } = await import('node:fs/promises');
  const frontend = await readFile(new URL('../public/app.js', import.meta.url),'utf8');
  const start = frontend.indexOf('function ensureStructuredPanel(){');
  const end = frontend.indexOf('\nfunction clearLiveSources(){',start);
  assert.ok(start>=0 && end>start,'missing structured-panel recovery function');
  function element(tag,id='') {
    return {
      tagName:tag,id,children:[],parentNode:null,hidden:false,
      append(...items){for(const child of items){child.parentNode=this;this.children.push(child)}},
      appendChild(child){this.append(child)},
      insertBefore(child,other){const index=this.children.indexOf(other);assert.ok(index>=0);child.parentNode=this;this.children.splice(index,0,child)},
      remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(x=>x!==this);this.parentNode=null}
    };
  }
  const home=element('section','view-home');
  const live=element('section','live-panel');home.append(live);
  function search(root,id) {
    if(root.id===id)return root;
    for(const child of root.children){const found=search(child,id);if(found)return found;}
    return null;
  }
  const document={createElement:tag=>element(tag)};
  const $=id=>search(home,id);
  const recover=new Function('document','$',frontend.slice(start,end)+'\nreturn ensureStructuredPanel;')(document,$);
  const panel=recover();
  assert.equal(panel.id,'structured-home-panel');
  assert.equal(panel.hidden,true);
  assert.equal($('structured-stores')?.id,'structured-stores');
  assert.equal($('structured-tickets')?.id,'structured-tickets');
  assert.equal(home.children[0],panel);
  assert.equal(home.children[1],live);
  assert.equal(recover(),panel,'must not recreate an existing panel');
});
