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
  assert.ok(html.includes('app.js?v=20261116-personal-seat-v11'),'cache-version not updated');
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
  assert.match(server,/import \{parseSeatLayout,parseSeatResponse,findSeatApiPaths\} from '\.\/seat-map\.mjs'/);
  assert.ok(html.includes('id="seat-layout-refresh"'));
  assert.ok(html.includes('id="seat-layout-status"'));
  assert.ok(js.includes("requestJson('/api/seat-layout')"));
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
