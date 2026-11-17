// 「搶不到鎖自動重試」與「同款規格等待畫面」的介面測試
// 用法：node tests/retry_ui.js
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch();
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push(String(e)));
  await pg.addInitScript(() => {
    localStorage.setItem('wsc_settings', JSON.stringify({
      backendUrl: 'https://example.invalid/exec', store: 'odm_shilin', staff: '測試員' }));
  });
  await pg.goto('file://' + path.resolve('index.html'));
  let fail = 0;
  const ck = (id, cond, extra) => { if(!cond){ console.log('  FAIL', id, extra===undefined?'':JSON.stringify(extra)); fail++; } else console.log('  ok  ', id); };

  // 把 fetch 換成照劇本回答的假後端
  await pg.evaluate(() => {
    window.__script = []; window.__posts = [];
    window.fetchWithTimeout_ = async (url, opts) => {
      if(!opts || opts.method !== 'POST') return {ok:true, json: async () => ({ok:true, orders:{}, log:[], staff:[]})};
      const body = JSON.parse(opts.body);
      window.__posts.push(body.action);
      const next = window.__script.length ? window.__script.shift() : {ok:true};
      return {ok:true, status:200, json: async () => next};
    };
  });
  const BUSY = {ok:false, error:'Error: 系統忙碌中，請稍候再試（等不到寫入鎖：doPost:finalizeShipment）'};

  console.log('【搶不到鎖】前兩次忙碌、第三次成功 → 使用者不該看到錯誤');
  let r = await pg.evaluate(async (BUSY) => {
    window.__posts = []; window.__script = [BUSY, BUSY, {ok:true, done:1}];
    try{ return {res: await rawApiPost('finalizeShipment', {entry:{orderNo:'X'}}), posts: window.__posts.length}; }
    catch(e){ return {err: e.message, posts: window.__posts.length}; }
  }, BUSY);
  ck('最後成功了', r.res && r.res.done === 1, r);
  ck('總共送了 3 次', r.posts === 3, r);

  console.log('\n【搶不到鎖】一直忙碌 → 重試 3 次後才報錯，不會無限重送');
  r = await pg.evaluate(async (BUSY) => {
    window.__posts = []; window.__script = [BUSY, BUSY, BUSY, BUSY, BUSY, BUSY];
    try{ await rawApiPost('finalizeShipment', {}); return {posts: window.__posts.length}; }
    catch(e){ return {err: e.message, posts: window.__posts.length}; }
  }, BUSY);
  ck('最後有報錯', !!r.err && r.err.indexOf('系統忙碌中') >= 0, r);
  ck('1 次原始 + 3 次重試 = 4 次', r.posts === 4, r);

  console.log('\n【其他錯誤】不能跟著重送（那些可能已經寫進去了）');
  r = await pg.evaluate(async () => {
    window.__posts = []; window.__script = [{ok:false, error:'Error: 寫入失敗'}];
    try{ await rawApiPost('finalizeShipment', {}); return {posts: window.__posts.length}; }
    catch(e){ return {err: e.message, posts: window.__posts.length}; }
  });
  ck('只送 1 次', r.posts === 1, r);
  ck('原訊息照實顯示', r.err === 'Error: 寫入失敗', r);

  r = await pg.evaluate(async () => {
    // 內層的鎖（不是 doPost: 開頭）代表動作已經開始跑了，不能重送
    window.__posts = []; window.__script = [{ok:false, error:'Error: 系統忙碌中，請稍候再試（等不到寫入鎖：releaseStaleClaims_）'}];
    try{ await rawApiPost('claimOrder', {}); return {posts: window.__posts.length}; }
    catch(e){ return {err: e.message, posts: window.__posts.length}; }
  });
  ck('內層鎖失敗不重送', r.posts === 1, r);

  console.log('\n【後端還沒部署】要講人話');
  r = await pg.evaluate(async () => {
    window.__posts = []; window.__script = [{ok:false, error:'unknown action: searchLocations'}];
    try{ await rawApiPost('searchLocations', {q:'ab'}); return {}; } catch(e){ return {err: e.message}; }
  });
  ck('訊息說的是「後端還沒更新」', r.err && r.err.indexOf('後端還沒更新') >= 0, r);

  console.log('\n【同款規格】等待的每一秒都要看得到東西');
  await pg.evaluate(() => {
    window.rawApiPost = (action) => new Promise(res => setTimeout(() => res(action === 'findSiblingSkus'
      ? {ok:true, siblings:[{sku:'S2', baseName:'同款', spec:'黑', stockWs:'3', stockMain:'', location:'A01-1', inMap:true}]}
      : {ok:true}), 1500));
    gotoView('loc');
  });
  const p = pg.evaluate(() => openSiblings('S1'));
  await pg.waitForTimeout(200);
  ck('按下去 0.2 秒視窗就出來了', await pg.isVisible('#sibMask'));
  ck('裡面寫著查詢中', (await pg.textContent('#sibList')).indexOf('查詢中') >= 0);
  await pg.waitForTimeout(800);
  ck('1 秒後還看得到（以前這時候字已經消失了）', await pg.isVisible('#sibMask') && (await pg.textContent('#sibList')).indexOf('查詢中') >= 0);
  await p;
  ck('資料回來換成清單', (await pg.locator('#sibList input[type=checkbox]').count()) === 1);
  ck('標題更新成筆數', (await pg.textContent('#sibTitle')).indexOf('1 個') >= 0);
  await pg.click('#sibCancel');

  // 等待中把視窗關掉，資料回來不該又彈出來
  const p2 = pg.evaluate(() => openSiblings('S1'));
  await pg.waitForTimeout(200);
  await pg.click('#sibCancel');
  await p2;
  ck('等待中關掉，回來不會又彈出來', !(await pg.isVisible('#sibMask')));

  ck('全程沒有 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(fail ? '\n有 '+fail+' 項失敗' : '\n介面全部通過');
  process.exit(fail?1:0);
})();
