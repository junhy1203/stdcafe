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

test('authenticated entry QR and counted available seats from official home fields', async () => {
  const entryCode='QR_SENSITIVE_ENTRY_TOKEN_MUST_NOT_LEAK';
  const requests=[];
  const remote=async(url,options)=>{
    const pathname=new URL(url).pathname;
    if(pathname==='/api/app.do'){
      const payload=JSON.parse(options.body);requests.push(payload.cmd);
      if(payload.cmd==='1201')return mkResponse(JSON.stringify({rspcode:'0000',result:{s_value:'Y',a_value:'AUTH_TEST_TOKEN',name:'회원'}}),'application/json');
      if(payload.cmd==='1100')return mkResponse(JSON.stringify({rspcode:'0000',result:{
        home_shop_no:'123',home_shop_name:'테스트 독서실',home_floor_no:'2',
        home_shop_tot_p:'42',home_shop_use_p:'17',
        home_shop_tot_g:'7',home_shop_use_g:'7',
        home_shop_tot_l:'30',home_shop_use_l:'31',
        home_shop_user_remain_m:'0',
        use_state:'C',
        home_qr_code:entryCode
      }}),'application/json');
      if(payload.cmd==='1101')return mkResponse(JSON.stringify({rspcode:'0000',result:{lsat_goods_use_info:[]}}),'application/json');
      throw Error('Unexpected API command '+payload.cmd);
    }
    return mkResponse('<html><body><div>항목</div></body></html>');
  };
  const server=createApp({fetchImpl:remote});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const first=await fetch(base+'/api/entry-qr');
    assert.equal(first.status,401);
    const init=await fetch(base+'/api/session');
    const csrf=(await init.json()).csrf;
    const Cookie=init.headers.get('set-cookie').split(';')[0];
    const login=await fetch(base+'/api/login',{method:'POST',headers:{Cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({username:'demo',password:'fake'})});
    assert.equal(login.status,200);
    const status=await fetch(base+'/api/status',{headers:{Cookie}});
    const statusString=await status.text();const data=JSON.parse(statusString);
    assert.equal(data.live.seatAvailability.personal.total,42);
    assert.equal(data.live.seatAvailability.personal.used,17);
    assert.equal(data.live.seatAvailability.personal.available,25);
    assert.equal(data.live.seatAvailability.group.available,0);
    assert.equal(data.live.seatAvailability.locker.available,null,'invalid used > total must remain unknown');
    assert.equal(data.live.seatAvailability.confirmedShop,true);
    assert.equal(data.live.currentShop.floorNo,'2');
    assert.equal(data.member.ticket.remainingMinutes,null,'home_shop_user_remain_m is monetary, not time');
    assert.equal(data.live.entryQrAvailable,true);
    assert.equal(data.live.accessState.homeUseStateCode,'C');
    assert.equal(data.live.accessState.verifiedMeaning,false);
    assert.equal(statusString.includes(entryCode),false,'QR must not be in ordinary status');
    const diag=await fetch(base+'/api/diagnostics',{headers:{Cookie}});
    assert.equal((await diag.text()).includes(entryCode),false,'QR must not be in diagnostics');
    const entry=await fetch(base+'/api/entry-qr',{headers:{Cookie}});
    assert.equal(entry.status,200);
    assert.equal(entry.headers.get('cache-control'),'no-store, private');
    const reply=await entry.json();
    assert.equal(reply.qr,entryCode);
    assert.equal(reply.shopName,'테스트 독서실');
    assert.deepEqual(requests,['1201','1100','1101','1100']);
  }finally{await new Promise(resolve=>server.close(resolve))}
});

test('bundled QR renderer produces scannable matrix for official app code',async()=>{
  const module=await import('../public/vendor/qrcode.mjs');
  const qr=module.default(0,'M');
  qr.addData('USER_TEST_CHECKIN','Byte');qr.make();
  assert.ok(qr.getModuleCount()>=21);
  let black=0;
  for(let r=0;r<qr.getModuleCount();r++)for(let c=0;c<qr.getModuleCount();c++)if(qr.isDark(r,c))black++;
  assert.ok(black>80);
});

test('entry, availability and QR elements exist in browser shell',async()=>{
  const fs=await import('node:fs/promises');
  const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const js=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
  for(const id of ['availability-counters','availability-refresh','entry-open-home','entry-open-seats','entry-overlay','entry-close','entry-dismiss','entry-qr-canvas','entry-status','entry-reload']){
    assert.ok(html.includes('id="'+id+'"'),'Missing HTML element '+id);
    assert.ok(js.includes("'"+id+"'"),'Missing JS reference '+id);
  }
  assert.ok(html.includes('app.js?v=20261116-reference-floorplan-v17'),'cache-version not updated');
});

test('QR ES module is deployed and served with the right MIME type',async()=>{
  const fs=await import('node:fs/promises');
  const installer=await fs.readFile(new URL('../deploy/install.sh',import.meta.url),'utf8');
  assert.match(installer,/install -d -m 0755[^\n]*"\$DEST\/public\/vendor"/,'installer must create vendor directory');
  assert.match(installer,/install -m 0644[^\n]*"\$DIR\/public\/vendor\/qrcode\.mjs"[^\n]*"\$DEST\/public\/vendor\/qrcode\.mjs"/,'installer must copy the QR module');
  assert.match(installer,/curl[^\n]*\/vendor\/qrcode\.mjs/,'installer must verify QR module is served');
  const server=createApp({ fetchImpl:async()=>{throw Error('no upstream request allowed')} });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const res=await fetch(base+'/vendor/qrcode.mjs');
    assert.equal(res.status,200,'QR import path must be routable');
    assert.match(res.headers.get('content-type'),/text\/javascript/,'Safari needs module JavaScript MIME type');
    const body=await res.text();
    assert.match(body,/export default qrcode/);
    const head=await fetch(base+'/vendor/qrcode.mjs',{method:'HEAD'});
    assert.equal(head.status,200,'installer uses a HEAD check');
    assert.match(head.headers.get('content-type'),/text\/javascript/);
  }finally{await new Promise(resolve=>server.close(resolve))}
});


test('native WebView seat layout uses private shop and floor parameters, never exposes auth token', async () => {
  const {parseSeatLayout}=await import('../seat-map.mjs');
  const direct=parseSeatLayout('<div data-seat-no="A01" data-status="available" style="left: 25px; top: 40px"></div><div data-seat-no="A02" data-status="occupied" style="left: 80px; top: 40px"></div><div data-seat-no="A03" data-status="C" style="left: 130px; top: 80px"></div>');
  assert.equal(direct.seats.length,3);
  assert.equal(direct.summary.available,1);
  assert.equal(direct.summary.occupied,1);
  assert.equal(direct.summary.unknown,1);
  assert.equal(direct.actualPositions,true);
  const json=parseSeatLayout('<script>window.seatList = [{"SEAT_NO":"B01","USE_YN":"N","SEAT_X":20,"SEAT_Y":60},{"SEAT_NO":"B02","USE_YN":"Y","SEAT_X":70,"SEAT_Y":60}]</script>');
  assert.deepEqual(json.seats.map(x=>x.status),['available','occupied']);
  assert.equal(json.summary.count,2);
  const conflicted=parseSeatLayout('<span data-seat-no="B03" data-status="available"></span><span data-seat-no="B03" data-status="occupied"></span>');
  assert.equal(conflicted.seats.length,0,'conflicting seat data cannot be trusted');
  const empty=parseSeatLayout('<div>전체 174석, 사용중 69석, 빈자리 105석</div>');
  assert.equal(empty.seats.length,0,'aggregated counts must not fabricate seat numbers');

  const secret='PRIVATE_AUTH_MUST_NOT_BE_RETURNED';
  const calls=[];
  const mock=async(url,options)=>{
    const u=new URL(url);
    calls.push({path:u.pathname,params:u.searchParams,method:options.method||'GET'});
    if(u.pathname==='/api/app.do'){
      const body=JSON.parse(options.body);
      if(body.cmd==='1201')return mkResponse(JSON.stringify({rspcode:'0000',result:{s_value:'Y',a_value:secret,name:'회원'}}),'application/json');
      if(body.cmd==='1100')return mkResponse(JSON.stringify({rspcode:'0000',result:{home_shop_no:'SHOP77',home_shop_name:'테스트 독서실',home_floor_no:'2'}}),'application/json');
      throw Error('Unexpected command '+body.cmd);
    }
    if(u.pathname==='/mobile/enterSeatView.do'){
      assert.equal(u.searchParams.get('tk'),secret);
      assert.equal(u.searchParams.get('SHOP_NO'),'SHOP77');
      assert.equal(u.searchParams.get('FLOOR_NO'),'2');
      assert.ok(u.searchParams.get('m_value'));
      return mkResponse('<html><script src="/assets/js/seat-chart.js"></script><div data-seat-no="A01" data-seat-status="available" data-x="12" data-y="20"></div><div data-seat-no="A02" data-seat-status="occupied" data-x="88" data-y="80"></div></html>','text/html');
    }
    throw Error('Unexpected URL '+u.pathname);
  };
  const server=createApp({fetchImpl:mock});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    assert.equal((await fetch(base+'/api/seat-layout')).status,401);
    const init=await fetch(base+'/api/session');
    const csrf=(await init.json()).csrf;
    const cookie=init.headers.get('set-cookie').split(';')[0];
    const logged=await fetch(base+'/api/login',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({username:'tester',password:'wrong'})});
    assert.equal(logged.status,200);
    const res=await fetch(base+'/api/seat-layout',{headers:{Cookie:cookie}});
    assert.equal(res.status,200);
    const raw=await res.text(),data=JSON.parse(raw);
    assert.equal(data.ok,true);
    assert.equal(data.shopName,'테스트 독서실');
    assert.equal(data.floorNo,'2');
    assert.equal(data.seats.length,2);
    assert.equal(data.seats[0].status,'available');
    assert.equal(data.seats[1].status,'occupied');
    assert.equal(data.inspect.scriptPaths[0],'/assets/js/seat-chart.js');
    assert.equal(raw.includes(secret),false,'token must never appear in rendered map JSON');
    const diag=await fetch(base+'/api/diagnostics',{headers:{Cookie:cookie}});
    const diagRaw=await diag.text();
    assert.equal(diagRaw.includes(secret),false,'token must not appear in diagnostics');
    assert.ok(calls.some(c=>c.path==='/mobile/enterSeatView.do'));
    assert.equal(calls.some(c=>c.path==='/mobile/seatChangeView.do'),false);
  }finally{await new Promise(resolve=>server.close(resolve))}
});

test('native WebView seat layout falls back without inventing seats when HTML only has summary',async()=>{
  const mock=async(url,options)=>{
    const u=new URL(url);
    if(u.pathname==='/api/app.do'){
      const p=JSON.parse(options.body);
      if(p.cmd==='1201')return mkResponse(JSON.stringify({rspcode:'0000',result:{s_value:'Y',a_value:'TESTTOKEN'}}),'application/json');
      return mkResponse(JSON.stringify({rspcode:'0000',result:{home_shop_no:'99',home_floor_no:'1',home_shop_name:'테스트 매장'}}),'application/json');
    }
    if(u.pathname==='/mobile/enterSeatView.do'||u.pathname==='/mobile/seatChangeView.do'){
      return mkResponse('<html>빈 좌석 105석<script src="/assets/seatchart.js"></script></html>','text/html');
    }
    throw Error('unexpected request');
  };
  const server=createApp({fetchImpl:mock});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const init=await fetch(base+'/api/session'),csrf=(await init.json()).csrf,cookie=init.headers.get('set-cookie').split(';')[0];
    await fetch(base+'/api/login',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({username:'u',password:'p'})});
    const response=await fetch(base+'/api/seat-layout',{headers:{Cookie:cookie}});
    const result=await response.json();
    assert.equal(result.ok,false);
    assert.equal(result.seats.length,0);
    assert.ok(result.inspect.detectedScripts.includes('/assets/seatchart.js'));
    assert.ok(result.reason.includes('좌석별')||result.reason.includes('개별 상태'));
  }finally{await new Promise(resolve=>server.close(resolve))}
});


test('seat WebView Javascript discovers a read-only seat-status GET endpoint', async()=>{
  const {findSeatApiPaths,parseSeatResponse}=await import('../seat-map.mjs');
  const found=findSeatApiPaths("const url='/mobile/seatStatusList.do';const dangerous='/mobile/seatChangeView.do';");
  assert.deepEqual(found,['/mobile/seatStatusList.do']);
  const rows=parseSeatResponse(JSON.stringify({rspcode:'0000',result:JSON.stringify({seatList:[
    {SEAT_NO:'11',USE_YN:'N',SEAT_X:10,SEAT_Y:20},
    {SEAT_NO:'12',USE_YN:'Y',SEAT_X:20,SEAT_Y:20}
  ]})}));
  assert.equal(rows.summary.available,1);
  assert.equal(rows.summary.occupied,1);
  const urls=[];
  const mock=async(url,opts)=>{
    const u=new URL(url);urls.push(u.pathname);
    if(u.pathname==='/api/app.do'){
      const req=JSON.parse(opts.body);
      if(req.cmd==='1201')return mkResponse(JSON.stringify({rspcode:'0000',result:{s_value:'Y',a_value:'PRIVATE_TOKEN'}}),'application/json');
      return mkResponse(JSON.stringify({rspcode:'0000',result:{home_shop_no:'7',home_floor_no:'1',home_shop_name:'테스트 독서실'}}),'application/json');
    }
    if(/View\.do$/.test(u.pathname))return mkResponse('<html><script src="/js/seat.js"></script>자리 조회 안내</html>','text/html');
    if(u.pathname==='/js/seat.js')return mkResponse("const url='/mobile/seatStatusList.do';const bad='/mobile/seatChangeView.do';",'text/javascript');
    if(u.pathname==='/mobile/seatStatusList.do'){
      assert.equal(u.searchParams.get('SHOP_NO'),'7');
      assert.equal(u.searchParams.get('FLOOR_NO'),'1');
      return mkResponse(JSON.stringify({result:[{SEAT_NO:'A1',USE_YN:'N',SEAT_X:10,SEAT_Y:20},{SEAT_NO:'A2',USE_YN:'Y',SEAT_X:25,SEAT_Y:20}]}),'application/json');
    }
    throw Error('unexpected '+u.pathname);
  };
  const server=createApp({fetchImpl:mock});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const init=await fetch(base+'/api/session'),csrf=(await init.json()).csrf,cookie=init.headers.get('set-cookie').split(';')[0];
    const login=await fetch(base+'/api/login',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({username:'demo',password:'pw'})});
    assert.equal(login.status,200);
    const map=await fetch(base+'/api/seat-layout',{headers:{Cookie:cookie}});
    assert.equal(map.status,200);
    const raw=await map.text(),data=JSON.parse(raw);
    assert.equal(data.ok,true);
    assert.equal(data.summary.available,1);
    assert.equal(data.summary.occupied,1);
    assert.ok(urls.includes('/js/seat.js'));
    assert.ok(urls.includes('/mobile/seatStatusList.do'));
    assert.ok(!urls.includes('/mobile/seatChange.do'));
    assert.ok(!raw.includes('PRIVATE_TOKEN'));
  }finally{await new Promise(resolve=>server.close(resolve))}
});

test('time-based pass converts remaining period 866 minutes to 14 hours 26 minutes',async()=>{
  const remote=async(url,opts)=>{
    const u=new URL(url);
    if(u.pathname==='/api/app.do'){
      const data=JSON.parse(opts.body);
      if(data.cmd==='1201')return mkResponse(JSON.stringify({rspcode:'0000',result:{s_value:'Y',a_value:'TEST_TOKEN'}}),'application/json');
      if(data.cmd==='1100')return mkResponse(JSON.stringify({rspcode:'0000',result:{home_shop_no:'15',home_shop_name:'카페',recent_shop_use_list:[]}}),'application/json');
      if(data.cmd==='1101')return mkResponse(JSON.stringify({rspcode:'0000',result:{lsat_goods_use_info:[{SHOP_NO:'15',SHOP_NAME:'카페',GOODS_NAME:'다인실 등 30시간',REMAIN_PERIOD:'866',SEAT_STATE:'C'}]}}),'application/json');
    }
    return mkResponse('<html><body>안내</body></html>','text/html');
  };
  const server=createApp({fetchImpl:remote});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const a=await fetch(base+'/api/session'),csrf=(await a.json()).csrf,Cookie=a.headers.get('set-cookie').split(';')[0];
    const login=await fetch(base+'/api/login',{method:'POST',headers:{Cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({username:'test',password:'test'})});
    assert.equal(login.status,200);
    const r=await fetch(base+'/api/status',{headers:{Cookie}});
    const data=await r.json();
    assert.equal(data.member.ticket.remainingMinutes,866);
    assert.equal(Math.floor(866/60),14);
    assert.equal(866%60,26);
    assert.match(data.live.remainingTimeInterpretation,/잠정/);
  }finally{await new Promise(resolve=>server.close(resolve))}
});


test('varied native seat markup and undocumented status remain conservative',async()=>{
  const {parseSeatLayout,parseSeatResponse}=await import('../seat-map.mjs');
  const html=parseSeatLayout(
    '<div data-seat-no="1" data-use-yn="N" style="transform:translate(50px, 20px)"></div>'+
    '<div data-seat-no="2" class="seat-occupied" style="left:80px;top:20px"></div>'+
    '<div data-seat-no="3" data-seat-status="C" style="left:120px;top:50px"></div>'
  );
  assert.deepEqual(html.seats.map(x=>x.status),['available','occupied','unknown']);
  assert.equal(html.seats[0].x,50);assert.equal(html.seats[0].y,20);
  const list=parseSeatLayout("<script>window.seatList=[{no:'10',use_yn:'N',x:10,y:30},{no:'11',use_yn:'Y',x:40,y:30}]</script>");
  assert.equal(list.seats.length,2);
  assert.deepEqual(list.seats.map(x=>x.status),['available','occupied']);
  const response=parseSeatResponse(JSON.stringify({result:{seatList:[{no:'12',USE_YN:'N',SEAT_POSITION_X:'18',SEAT_POSITION_Y:'22'}]}}));
  assert.equal(response.seats[0].id,'12');
  assert.equal(response.seats[0].status,'available');
  assert.equal(response.seats[0].x,18);assert.equal(response.seats[0].y,22);
});


test('installer includes the separate authenticated seat-map module and UI controls',async()=>{
  const fs=await import('node:fs/promises');
  const sh=await fs.readFile(new URL('../deploy/install.sh',import.meta.url),'utf8');
  const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const js=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const server=await fs.readFile(new URL('../server.mjs',import.meta.url),'utf8');
  assert.ok(sh.includes('"$DIR/seat-map.mjs"'), 'install script must include seat-map.mjs');
  assert.ok(server.includes("from './seat-map.mjs'"),'server imports seat-map module');
  assert.ok(html.includes('id="seat-layout-refresh"'));
  assert.ok(html.includes('id="seat-layout-status"'));
  assert.ok(js.includes("requestJson('/api/seat-layout?floor='+encodeURIComponent(selectedSeatZone))"));
  assert.ok(js.includes("parent.classList.add('physical-floor-plan')"));
});


test('APK personal seat page is the primary individual-seat source',async()=>{
  const calls=[];
  const mock=async (url,options)=>{
    const u=new URL(url);calls.push({path:u.pathname,params:u.searchParams});
    if(u.pathname==='/api/app.do'){
      const req=JSON.parse(options.body);
      if(req.cmd==='1201')return mkResponse(JSON.stringify({rspcode:'0000',result:{s_value:'Y',a_value:'TESTTOKEN'}}),'application/json');
      if(req.cmd==='1100')return mkResponse(JSON.stringify({rspcode:'0000',result:{home_shop_no:'999',home_shop_name:'실제 좌석 화면',home_floor_no:''}}),'application/json');
    }
    if(u.pathname==='/mobile/purchase/personal.do'){
      assert.equal(u.searchParams.get('SHOP_NO'),'999');
      assert.equal(u.searchParams.get('tk'),'TESTTOKEN');
      assert.ok(u.searchParams.get('m_value'));
      assert.equal(u.searchParams.has('FLOOR_NO'),false,'APK getPersonal does not pass floor');
      return mkResponse('<html><div data-seat-no="S12" data-use-yn="N" data-x="20" data-y="35"></div><div data-seat-no="S13" data-use-yn="Y" data-x="80" data-y="35"></div><div data-seat-no="S14" data-use-yn="N" data-x="40" data-y="70"></div></html>','text/html');
    }
    throw Error('unexpected request '+u.pathname);
  };
  const server=createApp({fetchImpl:mock});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const session=await fetch(base+'/api/session');
    const csrf=(await session.json()).csrf,Cookie=session.headers.get('set-cookie').split(';')[0];
    const login=await fetch(base+'/api/login',{method:'POST',headers:{Cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({username:'u',password:'p'})});
    assert.equal(login.status,200);
    const r=await fetch(base+'/api/seat-layout',{headers:{Cookie}});
    assert.equal(r.status,200);
    const result=await r.json();
    assert.equal(result.ok,true);assert.equal(result.source,'personal');
    assert.equal(result.seats.length,3);
    assert.equal(result.summary.available,2);
    assert.equal(result.summary.occupied,1);
    assert.equal(result.actualPositions,true);
    assert.deepEqual(calls.map(x=>x.path),['/api/app.do','/api/app.do','/mobile/purchase/personal.do']);
  }finally{await new Promise(resolve=>server.close(resolve))}
});


test('personal-seat WebView same-origin redirect is followed without leaking credentials', async () => {
  const routes=[];
  const mock=async(url,options)=>{
    const u=new URL(url);routes.push(u.pathname);
    if(u.pathname==='/api/app.do'){
      const payload=JSON.parse(options.body);
      if(payload.cmd==='1201')return mkResponse(JSON.stringify({rspcode:'0000',result:{s_value:'Y',a_value:'TEST_SECRET'}}),'application/json');
      if(payload.cmd==='1100')return mkResponse(JSON.stringify({rspcode:'0000',result:{home_shop_no:'S1',home_floor_no:'2',home_shop_name:'테스트'}}),'application/json');
    }
    if(u.pathname==='/mobile/purchase/personal.do'){
      return new Response(null,{status:302,headers:{location:'/mobile/purchase/personalChart.do'}});
    }
    if(u.pathname==='/mobile/purchase/personalChart.do'){
      return mkResponse('<html><div data-seat-no="1" data-use-yn="N"></div><div data-seat-no="2" data-use-yn="Y"></div></html>','text/html');
    }
    throw Error('Unexpected upstream route '+u.pathname);
  };
  const server=createApp({fetchImpl:mock});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const response=await fetch(base+'/api/session'),initial=await response.json(),Cookie=response.headers.get('set-cookie').split(';')[0];
    const login=await fetch(base+'/api/login',{method:'POST',headers:{Cookie,'Content-Type':'application/json','X-CSRF-Token':initial.csrf},body:JSON.stringify({username:'u',password:'p'})});
    assert.equal(login.status,200);
    const map=await fetch(base+'/api/seat-layout',{headers:{Cookie}});
    const raw=await map.text(),json=JSON.parse(raw);
    assert.equal(json.ok,true);
    assert.equal(json.seats.length,2);
    assert.equal(json.source,'personal');
    assert.ok(!raw.includes('TEST_SECRET'));
    assert.deepEqual(routes,['/api/app.do','/api/app.do','/mobile/purchase/personal.do','/mobile/purchase/personalChart.do']);
  }finally{await new Promise(resolve=>server.close(resolve))}
});


test('DOM ID variants for seat numbers remain scoped to actual seat-prefixed elements',async()=>{
  const {parseSeatLayout}=await import('../seat-map.mjs');
  const parsed=parseSeatLayout('<div id="seat-A01" class="seat available"></div><div id="chair_B02" class="seat occupied"></div><div id="topmenu" class="available"></div>');
  assert.deepEqual(parsed.seats.map(x=>[x.id,x.status]),[['A01','available'],['B02','occupied']]);
});


test('seat-layout diagnostics identify login or script-only HTML without exposing source text',async()=>{
  const {parseSeatLayout}=await import('../seat-map.mjs');
  const html='<html><form action="/mobile/login.do"><input type="password" value="SENSITIVE_PASSWORD"></form><script src="/js/chart.js"></script><p>로그인 필요</p></html>';
  const out=parseSeatLayout(html,'personal');
  assert.equal(out.seats.length,0);
  assert.equal(out.inspect.structure.likelyLoginPage,true);
  assert.equal(out.inspect.structure.forms,1);
  assert.equal(out.inspect.structure.externalScripts,1);
  assert.equal(out.inspect.scriptPaths[0],'/js/chart.js');
  assert.equal(JSON.stringify(out.inspect).includes('SENSITIVE_PASSWORD'),false);
});

test('seat diagnostics copy widget exists, sanitizes and supports HTTP Safari fallback',async()=>{
  const fs=await import('node:fs/promises');
  const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const app=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const css=await fs.readFile(new URL('../public/style.css',import.meta.url),'utf8');
  assert.match(html,/id="seat-diagnostic-copy"/);
  assert.match(html,/id="seat-diagnostic-export"/);
  assert.match(app,/function safeSeatDiagnostic\(data\)/);
  assert.match(app,/document\.execCommand\('copy'\)/);
  assert.match(css,/seat-diagnostic-export\[hidden\]/);
  const start=app.indexOf('function safeSeatDiagnostic(data){');
  const end=app.indexOf('\nasync function copySeatDiagnostic()',start);
  assert.ok(start>=0&&end>start);
  const safe=new Function(app.slice(start,end)+'\nreturn safeSeatDiagnostic;')();
  const diag={version:'v12',authenticated:true,csrf:'SENSITIVE_CSRF',
    lastLogin:{username:'PERSON'},seatPage:{shopName:'PRIVATE_SHOP',floorNo:'2',source:'personal',
      attempts:[{name:'personal',htmlCharacters:100,error:'',structure:{scripts:3}}],
      detectedScripts:['/js/chart.js'],detectedReadApis:['/mobile/seatStatusList.do'],accessToken:'SENSITIVE_TOKEN'}};
  const body=JSON.stringify(safe(diag));
  assert.ok(body.includes('/mobile/seatStatusList.do'));
  assert.equal(body.includes('SENSITIVE'),false);
  assert.equal(body.includes('PRIVATE_SHOP'),false);
  assert.equal(body.includes('PERSON'),false);
});

test('inline personal-seat AJAX reveals POST/GET verbs and field names without raw values',async()=>{
  const {parseSeatLayout,inspectSeatRequests}=await import('../seat-map.mjs');
  const page='<html><form action="/mobile/purchase/seatType.do" method="post"><input name="SHOP_NO" value="private-shop-secret"><input name="FLOOR_NO" value="1"></form><script>$.ajax({url:"/mobile/purchase/chart.do",type:"POST",data:{SHOP_NO: $("#s").val(), FLOOR_NO:$("#f").val()}, success:function(data){}});</script></html>';
  const hints=inspectSeatRequests(page);
  assert.ok(hints.some(v=>v.path==='/mobile/purchase/chart.do'&&v.method==='POST'));
  assert.ok(hints.some(v=>v.path==='/mobile/purchase/seatType.do'&&v.method==='POST'));
  const parsed=parseSeatLayout(page,'personal');
  const json=JSON.stringify(parsed.inspect);
  assert.ok(json.includes('SHOP_NO'));
  assert.ok(json.includes('FLOOR_NO'));
  assert.ok(!json.includes('private-shop-secret'));
});

test('explicit POST chart request is mirrored as a read-only seat fetch',async()=>{
  const routes=[];
  const mock=async(url,options)=>{
    const u=new URL(url);
    routes.push({path:u.pathname,method:options.method||'GET',body:options.body||''});
    if(u.pathname==='/api/app.do'){
      const cmd=JSON.parse(options.body).cmd;
      if(cmd==='1201')return mkResponse(JSON.stringify({rspcode:'0000',result:{s_value:'Y',a_value:'PRIVATE_AUTH'}}),'application/json');
      return mkResponse(JSON.stringify({rspcode:'0000',result:{home_shop_no:'SHOP7',home_floor_no:'1',home_shop_name:'유효한 매장'}}),'application/json');
    }
    if(u.pathname==='/mobile/purchase/personal.do'){
      return mkResponse('<html><script>$.ajax({url:"/mobile/purchase/chart.do",type:"POST",data:{SHOP_NO: $("#s").val(),FLOOR_NO:$("#f").val()},success:function(data){}});</script></html>','text/html');
    }
    if(u.pathname==='/mobile/enterSeatView.do'||u.pathname==='/mobile/seatChangeView.do')return mkResponse('<html>좌석 정보 준비 중</html>','text/html');
    if(u.pathname==='/mobile/purchase/chart.do'){
      assert.equal(options.method,'POST');
      const body=new URLSearchParams(options.body);
      assert.equal(body.get('SHOP_NO'),'SHOP7');
      assert.equal(body.get('FLOOR_NO'),'1');
      return mkResponse(JSON.stringify({result:{seatList:[{SEAT_NO:'A01',USE_YN:'N',SEAT_X:10,SEAT_Y:20},{SEAT_NO:'A02',USE_YN:'Y',SEAT_X:25,SEAT_Y:20}]}}),'application/json');
    }
    throw Error('Unrecognized request '+u.pathname);
  };
  const server=createApp({fetchImpl:mock});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const init=await fetch(base+'/api/session'),csrf=(await init.json()).csrf,Cookie=init.headers.get('set-cookie').split(';')[0];
    const login=await fetch(base+'/api/login',{method:'POST',headers:{Cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({username:'demo',password:'not-real'})});
    assert.equal(login.status,200);
    const result=await fetch(base+'/api/seat-layout',{headers:{Cookie}});
    assert.equal(result.status,200);
    const raw=await result.text(),data=JSON.parse(raw);
    assert.equal(data.ok,true);
    assert.equal(data.summary.available,1);
    assert.equal(data.summary.occupied,1);
    assert.equal(data.source,'app-seat-api');
    assert.ok(routes.some(r=>r.path==='/mobile/purchase/chart.do'&&r.method==='POST'));
    assert.ok(!raw.includes('PRIVATE_AUTH'));
    const diag=await fetch(base+'/api/diagnostics',{headers:{Cookie}});
    const diagRaw=await diag.text();
    assert.ok(diagRaw.includes('POST'));
    assert.ok(!diagRaw.includes('PRIVATE_AUTH'));
  }finally{await new Promise(resolve=>server.close(resolve))}
});


test('forensic HTML diagnostics expose structure but never form or script secret values',async()=>{
  const {analyzeSeatDocument,analyzeSeatScript}=await import('../seat-map.mjs');
  const privateValue='SENSITIVE_PRIVATE_ACCOUNT_12345';
  const page='<html><form action="/mobile/purchase/personal.do" method="POST"><input type="hidden" name="checkbox" value="'+privateValue+'"><select name="FLOOR_NO"><option value="1">1층</option></select></form>'+
    '<script>const privateToken="'+privateValue+'";$.ajax({url:"/mobile/purchase/chart.do",type:"POST",data:{SHOP_NO:$("#shop").val()},success:function(data){}});</script>'+
    '<div class="seat-board" id="seat-chart-area" data-seat-no="10"></div><img src="/images/seat-plan.png"></html>';
  const info=analyzeSeatDocument(page,'text/html');
  assert.equal(info.format,'html');
  assert.equal(info.forms[0].method,'POST');
  assert.deepEqual(info.forms[0].fields.map(x=>x.name),['checkbox','FLOOR_NO']);
  assert.ok(info.staticDoPaths.includes('/mobile/purchase/chart.do'));
  assert.equal(info.tagCounts.form,1);
  assert.equal(info.tagCounts.script,1);
  assert.equal(info.inlineScripts[0].operations.jqueryAjax,1);
  assert.ok(info.relevantDom.classes.includes('seat-board'));
  assert.ok(info.imagePaths.includes('/images/seat-plan.png'));
  assert.ok(!JSON.stringify(info).includes(privateValue));
  assert.ok(!JSON.stringify(analyzeSeatScript('const privateToken="'+privateValue+'";$.get("/mobile/purchase/chart.do");')).includes(privateValue));
});
test('nested app JSON describes safe schema and status enums without private values',async()=>{
  const {analyzeSeatDocument}=await import('../seat-map.mjs');
  const input=JSON.stringify({rspcode:'0000',result:JSON.stringify({seatList:[
    {SEAT_NO:'1',USE_YN:'N',nickname:'DO_NOT_PRINT_PERSON_123'},
    {SEAT_NO:'2',USE_YN:'Y',nickname:'DO_NOT_PRINT_PERSON_123'}
  ],user:{id:'DO_NOT_PRINT_PERSON_123'}})});
  const result=analyzeSeatDocument(input,'application/json');
  assert.equal(result.format,'json');
  assert.equal(result.outline.properties.result.type,'json-string');
  assert.equal(result.statusCodes.USE_YN.N,1);
  assert.equal(result.statusCodes.USE_YN.Y,1);
  assert.equal(JSON.stringify(result).includes('DO_NOT_PRINT_PERSON_123'),false);
});
test('failed native seat lookup includes redacted HTML and chart response forensics',async()=>{
  const secret='NONPUBLIC_PASSWORD_OR_MEMBER_DATA';
  const calls=[];
  const remote=async(url,opts)=>{
    const u=new URL(url);calls.push({path:u.pathname,method:opts.method||'GET'});
    if(u.pathname==='/api/app.do'){
      const cmd=JSON.parse(opts.body).cmd;
      if(cmd==='1201')return mkResponse(JSON.stringify({rspcode:'0000',result:{s_value:'Y',a_value:'PRIVATE_AUTH_TOKEN',name:'SECRET_PERSON'}}),'application/json');
      if(cmd==='1100')return mkResponse(JSON.stringify({rspcode:'0000',result:{home_shop_no:'17',home_floor_no:'1',home_shop_name:'SECRET_CAFE'}}),'application/json');
    }
    if(u.pathname==='/mobile/purchase/personal.do')
      return mkResponse('<html><form action="/mobile/purchase/personal.do" method="POST"><input name="checkbox" value="'+secret+'"></form><script src="/js/seat-chart.js"></script><script>var seatUrl="/mobile/purchase/chart.do";</script></html>','text/html');
    if(u.pathname==='/mobile/enterSeatView.do')
      return mkResponse('<html><script>var chartUrl="/mobile/purchase/chart.do";</script></html>','text/html');
    if(u.pathname==='/mobile/seatChangeView.do')
      return new Response(null,{status:302,headers:{Location:'/mobile/error/notEnterRoomInfo.do'}});
    if(u.pathname==='/mobile/error/notEnterRoomInfo.do')
      return mkResponse('<html><p>현재 입실 상태가 아닙니다</p></html>','text/html');
    if(u.pathname==='/js/seat-chart.js')
      return mkResponse('function renderSeatChart(){ $.get("/mobile/purchase/chart.do", function(){}); }','text/javascript');
    if(u.pathname==='/mobile/purchase/chart.do')
      return mkResponse('<html><form method="GET" action="/mobile/purchase/chart.do"><input name="SHOP_NO" value="'+secret+'"></form><p>층 선택 필요</p></html>','text/html');
    throw Error('Unexpected upstream path '+u.pathname);
  };
  const server=createApp({fetchImpl:remote});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const init=await fetch(base+'/api/session'),v=await init.json(),Cookie=init.headers.get('set-cookie').split(';')[0];
    const logged=await fetch(base+'/api/login',{method:'POST',headers:{Cookie,'Content-Type':'application/json','X-CSRF-Token':v.csrf},body:JSON.stringify({username:'person',password:'private'})});
    assert.equal(logged.status,200);
    const response=await fetch(base+'/api/seat-layout',{headers:{Cookie}});
    assert.equal(response.status,200);
    assert.equal((await response.json()).ok,false);
    const diagResponse=await fetch(base+'/api/diagnostics',{headers:{Cookie}});
    const diagRaw=await diagResponse.text(),diag=JSON.parse(diagRaw);
    assert.equal(diag.seatPage.attempts[0].forensic.forms[0].fields[0].name,'checkbox');
    assert.ok(diag.seatPage.attempts[0].http.fingerprint);
    assert.equal(diag.seatPage.attempts[0].http.mime,'text/html');
    assert.ok(diag.seatPage.inspected.find(x=>x.path==='/js/seat-chart.js').code.operations.jqueryGet>0);
    const chart=diag.seatPage.probes.find(x=>x.path==='/mobile/purchase/chart.do');
    assert.ok(chart);
    assert.equal(chart.responseAnalysis.format,'html');
    assert.ok(chart.responseAnalysis.forms.some(x=>x.fields.some(v=>v.name==='SHOP_NO')));
    assert.equal(chart.http.status,200);
    assert.ok(!calls.some(x=>x.path==='/mobile/purchase/personal.do'&&x.method==='POST'),'do not replay arbitrary checkbox POST');
    for(const value of [secret,'PRIVATE_AUTH_TOKEN','SECRET_PERSON','SECRET_CAFE'])assert.ok(!diagRaw.includes(value),'leaked '+value);
  }finally{await new Promise(resolve=>server.close(resolve))}
});


test('iPad diagnostic JSON download uses only redacted report data',async()=>{
  const fs=await import('node:fs/promises');
  const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const app=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const css=await fs.readFile(new URL('../public/style.css',import.meta.url),'utf8');
  assert.ok(html.includes('id="seat-diagnostic-save"'));
  assert.ok(app.includes("'seat-diagnostic-save'"));
  assert.ok(app.includes("zones[floor]={...safeSeatDiagnostic(current)"));
  assert.ok(app.includes('stdcafe-both-room-diagnostics-v16.json'));
  assert.ok(app.includes("'/api/seat-layout?floor='+floor"));
  assert.ok(app.includes("for(const floor of ['1','2'])"));
  assert.ok(app.includes('URL.createObjectURL(file)'));
  assert.ok(css.includes('#seat-diagnostic-save'));
});


test('native inline seat markers appear as partial unknown-status seats',async()=>{
  const {parseSeatLayout,extractNativeSeatMarkers}=await import('../seat-map.mjs');
  const ids=[19,4,23,65,43,15,10,46,27,59,57,3,66,62,22,67,13,58,41,56,47,63,
    38,25,26,87,94,73,82,90,77,98,45,42,24,1,11,16,7,9,21,8,5,12,20,30,52,2,
    17,50,88,91,71,97,84,79];
  let page='<html><div class="wrap-seat"><div class="seat"></div></div>';
  for(const id of ids)page+='<script>$("#seatNo_'+id+'").addClass("some-undocumented-code")</script>';
  page+='<script>function fn_seatList(){ const seatState="C"; }</script></html>';
  const result=extractNativeSeatMarkers(page);
  assert.equal(result.seats.length,56);
  assert.deepEqual(new Set(result.seats.map(x=>x.id)).size,56);
  const view=parseSeatLayout(page,'enter');
  assert.equal(view.seats.length,56);
  assert.equal(view.summary.available,0);
  assert.equal(view.summary.occupied,0);
  assert.equal(view.summary.unknown,56);
  assert.equal(view.partialSeatList,true);
  assert.equal(view.actualPositions,false);
  assert.equal(view.summary.completeFloorLayout,false);
  assert.ok(view.seats.every(x=>x.status==='unknown'&&x.x===null&&x.y===null));
});
test('native seat classes with explicit known status preserve verified occupancy',async()=>{
  const {parseSeatLayout}=await import('../seat-map.mjs');
  const page='<html><div class="seat seatNo_1 available"></div><div class="seat seatNo_2 occupied"></div>'+
    '<script>$(".seatNo_3").addClass("unclear-state")</script><script>$(".seatNo_4").addClass("unknown-code")</script>'+
    '<script>$(".seatNo_5").addClass("unknown-code")</script></html>';
  const view=parseSeatLayout(page,'enter');
  assert.equal(view.summary.available,1);
  assert.equal(view.summary.occupied,1);
  assert.equal(view.summary.unknown,3);
  assert.equal(view.partialSeatList,false);
  assert.equal(view.seats.find(x=>x.id==='1').status,'available');
  assert.equal(view.seats.find(x=>x.id==='2').status,'occupied');
});
test('server keeps scanning verified API after finding unknown native seat IDs',async()=>{
  const calls=[];
  const mock=async (url,options)=>{
    const u=new URL(url);calls.push(u.pathname);
    if(u.pathname==='/api/app.do'){
      const cmd=JSON.parse(options.body).cmd;
      if(cmd==='1201')return mkResponse(JSON.stringify({rspcode:'0000',result:{s_value:'Y',a_value:'TOKEN_SECRET'}}),'application/json');
      return mkResponse(JSON.stringify({rspcode:'0000',result:{home_shop_no:'77',home_floor_no:'1',home_shop_name:'TEST'}}),'application/json');
    }
    if(u.pathname==='/mobile/purchase/personal.do')
      return mkResponse('<html><script>var seatMap="/mobile/purchase/chart.do";</script></html>','text/html');
    if(u.pathname==='/mobile/enterSeatView.do')
      return mkResponse('<html><div class="wrap-seat"></div><script>var seatNo_19=1;</script><script>var seatNo_4=2;</script><script>var seatNo_23=3;</script></html>','text/html');
    if(u.pathname==='/mobile/seatChangeView.do')return mkResponse('<html><p>not entered</p></html>','text/html');
    if(u.pathname==='/mobile/purchase/chart.do')
      return mkResponse(JSON.stringify({seatList:[{SEAT_NO:'11',USE_YN:'Y'},{SEAT_NO:'12',USE_YN:'N'}]}),'application/json');
    throw Error('unexpected '+u.pathname);
  };
  const server=createApp({fetchImpl:mock});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const init=await fetch(base+'/api/session'),csrf=(await init.json()).csrf,Cookie=init.headers.get('set-cookie').split(';')[0];
    const login=await fetch(base+'/api/login',{method:'POST',headers:{Cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({username:'demo',password:'example'})});
    assert.equal(login.status,200);
    const map=await fetch(base+'/api/seat-layout',{headers:{Cookie}});
    assert.equal(map.status,200);
    const result=await map.json();
    assert.equal(result.ok,true);
    assert.equal(result.source,'app-seat-api');
    assert.equal(result.summary.available,1);
    assert.equal(result.summary.occupied,1);
    assert.ok(calls.includes('/mobile/purchase/chart.do'));
  }finally{await new Promise(resolve=>server.close(resolve))}
});
test('server returns partial marker-only seats when upstream chart has no occupancy evidence',async()=>{
  const mock=async(url,opts)=>{
    const u=new URL(url);
    if(u.pathname==='/api/app.do'){
      const cmd=JSON.parse(opts.body).cmd;
      if(cmd==='1201')return mkResponse(JSON.stringify({rspcode:'0000',result:{s_value:'Y',a_value:'TOKEN_SECRET'}}),'application/json');
      return mkResponse(JSON.stringify({rspcode:'0000',result:{home_shop_no:'77',home_floor_no:'1',home_shop_name:'TEST',home_shop_tot_p:174,home_shop_use_p:72}}),'application/json');
    }
    if(u.pathname==='/mobile/purchase/personal.do')
      return mkResponse('<html><script>var seatMap="/mobile/purchase/chart.do";</script></html>','text/html');
    if(u.pathname==='/mobile/enterSeatView.do')
      return mkResponse('<html><div class="wrap-seat"></div><script>var seatNo_19=1;</script><script>var seatNo_4=2;</script><script>var seatNo_23=3;</script></html>','text/html');
    if(u.pathname==='/mobile/seatChangeView.do')return mkResponse('<html></html>','text/html');
    if(u.pathname==='/mobile/purchase/chart.do')return mkResponse('<html><p>Not valid parameters</p></html>','text/html');
    throw Error('unexpected '+u.pathname);
  };
  const server=createApp({fetchImpl:mock});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const init=await fetch(base+'/api/session'),csrf=(await init.json()).csrf,Cookie=init.headers.get('set-cookie').split(';')[0];
    const login=await fetch(base+'/api/login',{method:'POST',headers:{Cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({username:'demo',password:'example'})});
    assert.equal(login.status,200);
    const map=await fetch(base+'/api/seat-layout',{headers:{Cookie}});
    const result=await map.json();
    assert.equal(result.ok,true);
    assert.equal(result.partialSeatList,true);
    assert.equal(result.seats.length,3);
    assert.equal(result.summary.available,0);
    assert.equal(result.summary.occupied,0);
    assert.ok(result.inspect.probes);
    const diag=await fetch(base+'/api/diagnostics',{headers:{Cookie}});
    const meta=(await diag.json()).seatPage;
    assert.equal(meta.summary.nativeMarkerCount,3);
    assert.equal(meta.attempts.find(x=>x.name==='enter').nativeSeatMarkers.count,3);
  }finally{await new Promise(resolve=>server.close(resolve))}
});


test('only directly applied known classes yield verified seat status',async()=>{
  const {parseSeatLayout,inspectNativeSeatScriptEffects}=await import('../seat-map.mjs');
  const page='<html><div class="wrap-seat"></div>'+
    '<script>$("#seatNo_19").addClass("occupied");</script>'+
    '<script>$("#seatNo_4").addClass("available");</script>'+
    '<script>$("#seatNo_23").addClass("C");</script>'+
    '<script>$("#seatNo_65").css("background-color","#ababab");</script>'+
    '<script>$("#seatNo_67").addClass("on");</script></html>';
  const parsed=parseSeatLayout(page,'enter');
  assert.equal(parsed.summary.count,5);
  assert.equal(parsed.summary.occupied,1);
  assert.equal(parsed.summary.available,1);
  assert.equal(parsed.summary.unknown,3);
  assert.equal(parsed.seats.find(x=>x.id==='19').status,'occupied');
  assert.equal(parsed.seats.find(x=>x.id==='4').status,'available');
  assert.equal(parsed.seats.find(x=>x.id==='23').status,'unknown');
  assert.equal(parsed.seats.find(x=>x.id==='65').status,'unknown');
  const effects=inspectNativeSeatScriptEffects(page);
  assert.equal(effects.markerCount,5);
  assert.equal(effects.scriptCount,5);
  assert.ok(effects.patterns.some(x=>x.classes.includes('occupied')));
  assert.ok(effects.patterns.some(x=>x.cssProps.includes('background-color')));
  const report=JSON.stringify(effects);
  assert.ok(!report.includes('<script>'));
});


test('both native seat room tabs can be inspected regardless of pass type',async()=>{
  const html=await (await import('node:fs/promises')).readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const js=await (await import('node:fs/promises')).readFile(new URL('../public/app.js',import.meta.url),'utf8');
  assert.ok(html.includes('data-seat-zone="1"'));
  assert.ok(html.includes('data-seat-zone="2"'));
  assert.ok(js.includes("'/api/seat-layout?floor='+encodeURIComponent(selectedSeatZone)"));
  assert.ok(!js.includes('passType===selectedSeatZone'));
});
test('API accepts explicitly chosen seat zone independently of home floor',async()=>{
  const seen=[];
  const mock=async(url,options)=>{
    const u=new URL(url);seen.push({path:u.pathname,floor:u.searchParams.get('FLOOR_NO')});
    if(u.pathname==='/api/app.do'){
      const cmd=JSON.parse(options.body).cmd;
      if(cmd==='1201')return mkResponse(JSON.stringify({rspcode:'0000',result:{s_value:'Y',a_value:'PRIVATE_TOKEN'}}),'application/json');
      if(cmd==='1100')return mkResponse(JSON.stringify({rspcode:'0000',result:{home_shop_no:'89',home_floor_no:'1',home_shop_tot_p:174,home_shop_use_p:70}}),'application/json');
    }
    if(u.pathname==='/mobile/purchase/personal.do')return mkResponse('<html><script>var chart="/mobile/purchase/chart.do";</script></html>','text/html');
    if(u.pathname==='/mobile/enterSeatView.do'){
      if(u.searchParams.get('FLOOR_NO')==='2')return mkResponse('<html><div class="wrap-seat"></div><script>var seatNo_157=1;</script><script>var seatNo_158=1;</script><script>var seatNo_159=1;</script></html>','text/html');
      return mkResponse('<html><div class="wrap-seat"></div><script>var seatNo_1=1;</script><script>var seatNo_2=1;</script><script>var seatNo_3=1;</script></html>','text/html');
    }
    if(u.pathname==='/mobile/seatChangeView.do')return mkResponse('<html></html>','text/html');
    if(u.pathname==='/mobile/purchase/chart.do')return mkResponse('<html><p>select floor</p></html>','text/html');
    throw Error('unexpected upstream read '+u.pathname);
  };
  const server=createApp({fetchImpl:mock});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const init=await fetch(base+'/api/session'),csrf=(await init.json()).csrf,Cookie=init.headers.get('set-cookie').split(';')[0];
    const login=await fetch(base+'/api/login',{method:'POST',headers:{Cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({username:'example',password:'example'})});
    assert.equal(login.status,200);
    const response=await fetch(base+'/api/seat-layout?floor=2',{headers:{Cookie}});
    const result=await response.json();
    assert.equal(response.status,200);
    assert.equal(result.ok,true);
    assert.equal(result.floorNo,'2');
    assert.ok(result.seats.some(x=>x.id==='157'));
    assert.ok(!result.seats.some(x=>x.id==='1'));
    assert.ok(result.seats.every(x=>x.status==='unknown'));
    assert.ok(seen.some(x=>x.path==='/mobile/enterSeatView.do'&&x.floor==='2'));
    assert.ok(!seen.some(x=>x.path==='/mobile/enterSeatView.do'&&x.floor==='1'));
    const bad=await fetch(base+'/api/seat-layout?floor=not-a-floor',{headers:{Cookie}});
    assert.equal(bad.status,400);
  }finally{await new Promise(resolve=>server.close(resolve))}
});

test('native layout diagnostics capture sanitized CSS paths and numeric geometry',async()=>{
  const {inspectNativeRoomLayout,parseSeatLayout}=await import('../seat-map.mjs');
  const secret='PRIVATE_LOGIN_COOKIE_OR_TOKEN';
  const html='<html><head><link rel="stylesheet" href="/css/seat-plan.css?tk='+secret+'">'+
    '<style>.seat{position:absolute;left:10px}.wrap-seat{background-image:url("/images/seat_plan.png")}</style></head>'+
    '<body><div class="wrap-seat"><div class="seat" style="left:120px;top:27%;width:42px;height:30px" data-seat-no="12"></div>'+
    '<div class="seat" style="left:180px;top:27%" data-seat-no="13"></div></div>'+
    '<script>var seatNo_12=1;var seatNo_13=1;var seatNo_14=1;</script>'+
    '<span data-token="'+secret+'"></span></body></html>';
  const report=inspectNativeRoomLayout(html);
  assert.ok(report.stylesheets.includes('/css/seat-plan.css'));
  assert.ok(report.imageAssetPaths.includes('/images/seat_plan.png'));
  assert.equal(report.seatElements,2);
  assert.equal(report.seatElementsWithGeometry,2);
  assert.equal(report.examplesWithGeometry[0].x.value,120);
  assert.equal(report.examplesWithGeometry[0].y.unit,'%');
  assert.equal(report.inlineCss.containsBackgroundAsset,true);
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.ok(parseSeatLayout(html,'enter').inspect.nativeLayout.stylesheets.includes('/css/seat-plan.css'));
});


test('screenshot reference plans contain all visible distinct coordinates and preserve unpictured seats',async()=>{
  const fs=await import('node:fs/promises');
  const app=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const from=app.indexOf('function screenshotSeatPlan(zone){');
  const to=app.indexOf('function renderScreenshotFloorPlan(',from);
  assert.ok(from>=0&&to>from,'reference geometry must be accessible');
  const plan=new Function(app.slice(from,to)+'\nreturn screenshotSeatPlan;')();
  const room1=plan('1'),room2=plan('2');
  assert.equal(room1.seats.length,98);
  assert.equal(room2.seats.length,76);
  const seen=new Set();
  for(const p of [...room1.seats,...room2.seats]){
    assert.match(p.id,/^\d+$/);
    assert.ok(Number(p.id)>=1&&Number(p.id)<=186);
    assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));
    assert.ok(p.x>=0&&p.y>=0);
    assert.ok(!seen.has(p.id),'duplicate photographed seat '+p.id);
    seen.add(p.id);
  }
  assert.deepEqual(room2.missing,Array.from({length:12},(_,i)=>121+i));
  assert.ok(room2.missing.every(id=>!seen.has(String(id))));
  assert.ok(room1.seats.some(x=>x.id==='1'));
  assert.ok(room1.seats.some(x=>x.id==='98'));
  assert.ok(room2.seats.some(x=>x.id==='186'));
  assert.equal(room1.seats.filter(x=>x.id==='99').length,0);
});
test('real reference floorplan uses live statuses only and cannot run entry on seat tap',async()=>{
  const fs=await import('node:fs/promises');
  const js=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const css=await fs.readFile(new URL('../public/style.css',import.meta.url),'utf8');
  const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
  assert.match(js,/referenceStore=.*'회원모아독서실'/);
  assert.ok(js.includes("const status=['available','occupied','disabled'].includes(matched?.status)?matched.status:'unknown'"));
  assert.ok(js.includes("배치 위치는 제공된 사진을 기준으로 재구성했습니다"));
  assert.ok(js.includes("parent.classList.add('reference-floor-plan')"));
  assert.ok(css.includes('.seat-grid.full.reference-floor-plan'));
  assert.ok(html.includes('20261116-reference-floorplan-v17'));
});
test('entry and departure provide official authenticated QR with no unverified checkout POST',async()=>{
  const fs=await import('node:fs/promises');
  const js=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
  for(const id of ['entry-open-home','entry-open-seats','exit-open-home','exit-open-seats','access-verify','access-explanation'])
    assert.ok(html.includes('id="'+id+'"'));
  assert.ok(js.includes("()=>openAccess('enter')"));
  assert.ok(js.includes("()=>openAccess('exit')"));
  assert.ok(js.includes("const data=await requestJson('/api/entry-qr')"));
  assert.ok(js.includes("await fetchLive()"));
  assert.ok(!js.includes("requestJson('/api/exit'"));
});
