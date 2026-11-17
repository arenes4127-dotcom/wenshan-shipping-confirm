// 調撥驗收前端：先顯示本機清單、載入中掃描不誤響、背景送出不重複計算
// 用法：node tests/transfer_ui.js
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch();
  // 測試絕對不能碰到正式環境：預設設定裡帶著正式後端與試算表的網址。
  // 就算哪天設定的鍵名又寫錯，這一道也會把請求擋掉。
  const _PROD = /script\.google\.com|script\.googleusercontent\.com|docs\.google\.com/;
  { const _np = b.newPage.bind(b), _nc = b.newContext.bind(b);
    b.newPage = async (o) => { const p = await _np(o); await p.route(_PROD, r => r.abort()); return p; };
    b.newContext = async (o) => { const c = await _nc(o); await c.route(_PROD, r => r.abort()); return c; }; }
  const ctx = await b.newContext();
  const errs = [];
  let fail = 0;
  const ck = (id, cond, extra) => { if(!cond){ console.log('  FAIL', id, extra===undefined?'':JSON.stringify(extra)); fail++; } else console.log('  ok  ', id); };

  // 假後端：可以控制 getTransferPending 要拖多久、scanTransferBatch 怎麼回
  async function open(pg){
    pg.on('pageerror', e => errs.push(String(e)));
    await pg.addInitScript(() => {
      localStorage.setItem('ssz_settings', JSON.stringify({backendUrl:'https://example.invalid/exec', store:'odm_shilin', staff:'x'}));
    });
    await pg.goto('file://' + path.resolve('index.html'));
    await pg.evaluate(() => {
      window.__srv = { items:[
          {row:2, batchId:'B1', sku:'T1', baseName:'水壺', qty:3, scannedQty:0, importedAt:'2026/11/17 08:00'},
          {row:3, batchId:'B1', sku:'T2', baseName:'頭巾', qty:1, scannedQty:0, importedAt:'2026/11/17 08:00'}],
        done:[], delay: 0, calls: [] };
      window.rawApiPost = async (action, payload) => {
        const S = window.__srv; S.calls.push(action);
        if(action === 'getTransferPending'){
          const snap = JSON.parse(JSON.stringify({ok:true, items:S.items.filter(x=>x.scannedQty<x.qty), recentDone:S.done}));
          await new Promise(r => setTimeout(r, S.delay));
          return snap;
        }
        if(action === 'scanTransferBatch'){
          return {ok:true, results: payload.ops.map(op => {
            const it = S.items.find(x => x.sku === op.sku && x.scannedQty < x.qty);
            if(!it) return {ok:false, reason:'no_match', sku: op.sku};
            it.scannedQty++;
            return {ok:true, sku: it.sku, row: it.row, baseName: it.baseName, scannedQty: it.scannedQty, qty: it.qty, status: it.scannedQty >= it.qty ? 'done' : 'open'};
          })};
        }
        return {ok:true};
      };
      staff = [{id:'S1', name:'甲'}];
      window.__beeps = []; const ok0 = window.okBeep, er0 = window.errorBeep;
      window.okBeep = () => window.__beeps.push('ok'); window.errorBeep = () => window.__beeps.push('err');
    });
  }
  const pick = async (pg) => { await pg.evaluate(() => { renderStaffSelects(); const s = document.getElementById('transferStaffSelect'); s.value = 'S1'; }); };

  console.log('【第一次進調撥頁】沒有快取，等後端');
  const pg = await ctx.newPage();
  await open(pg);
  await pg.evaluate(() => gotoView('transfer'));
  await pg.waitForFunction(() => document.getElementById('transferPendingCount').textContent === '2');
  await pick(pg);
  ck('載入後顯示 2 筆', true);

  console.log('\n【掃描】先扣本機、背景送出');
  await pg.evaluate(() => transferScan('T1'));
  let r = await pg.evaluate(() => ({ q: transferQueue.length, local: transferPending.find(x=>x.sku==='T1').scannedQty, beeps: window.__beeps.slice() }));
  ck('本機立刻扣 1 件、響成功聲', r.local === 1 && r.beeps[r.beeps.length-1] === 'ok', r);
  await pg.waitForFunction(() => transferQueue.length === 0, null, {timeout: 5000});
  ck('1.2 秒後送出，佇列清空', true);

  console.log('\n【重新開頁面】先畫上次的清單，不空等');
  const pg2 = await ctx.newPage();
  await open(pg2);
  await pg2.evaluate(() => { window.__srv.items[0].scannedQty = 1; window.__srv.delay = 2500; });   // 後端狀態延續、這次很慢
  await pg2.evaluate(() => gotoView('transfer'));
  await pg2.waitForTimeout(150);
  r = await pg2.evaluate(() => ({ n: document.getElementById('transferPendingCount').textContent,
    hint: document.getElementById('transferSyncHint').textContent, list: document.getElementById('transferPendingList').textContent }));
  ck('0.15 秒內就看到清單（2 筆）', r.n === '2' && r.list.indexOf('水壺') >= 0, r);
  ck('標示這是幾點的清單、更新中', /顯示的是 \d+:\d\d 的清單，更新中/.test(r.hint), r.hint);
  await pick(pg2);

  console.log('\n【清單更新中掃到本機沒有的】不能先響錯');
  await pg2.evaluate(() => { window.__srv.items.push({row:4, batchId:'B2', sku:'NEW1', baseName:'剛匯入的', qty:1, scannedQty:0, importedAt:'2026/11/17 10:00'}); window.__beeps = []; });
  await pg2.evaluate(() => transferScan('NEW1'));
  r = await pg2.evaluate(() => ({ beeps: window.__beeps.slice(), flash: document.getElementById('flashBig').textContent }));
  ck('沒有響錯誤聲', r.beeps.indexOf('err') < 0, r);
  ck('告訴人「清單還在更新，這件已記下」', r.flash.indexOf('清單還在更新') >= 0, r.flash);
  await pg2.waitForFunction(() => window.__beeps.indexOf('ok') >= 0, null, {timeout: 6000});
  r = await pg2.evaluate(() => ({ flash: document.getElementById('flashBig').textContent }));
  ck('後端確認後響成功聲並說「已確認」', r.flash.indexOf('已確認') >= 0, r.flash);

  await pg2.evaluate(() => { window.__srv.delay = 2500; window.__beeps = []; loadTransferPending(); });
  await pg2.waitForTimeout(100);
  await pg2.evaluate(() => transferScan('GHOST'));
  await pg2.waitForFunction(() => window.__beeps.indexOf('err') >= 0, null, {timeout: 6000});
  r = await pg2.evaluate(() => document.getElementById('flashBig').textContent);
  ck('真的沒有的，後端回覆後才響錯誤', r.indexOf('找不到') >= 0, r);

  console.log('\n【清單確認過之後】掃到沒有的要當下就響');
  await pg2.waitForFunction(() => !transferLoading, null, {timeout: 6000});
  await pg2.evaluate(() => { window.__srv.delay = 0; window.__beeps = []; transferScan('GHOST2'); });
  r = await pg2.evaluate(() => window.__beeps.slice());
  ck('當下響錯誤（不用等網路）', r[0] === 'err', r);

  console.log('\n【不重複計算】載入途中有一批正在送');
  await pg2.waitForFunction(() => transferQueue.length === 0, null, {timeout: 5000});
  await pg2.evaluate(() => { window.__srv.items[0].qty = 10; window.__srv.items[0].scannedQty = 1; window.__srv.delay = 0; });
  await pg2.evaluate(() => loadTransferPending());
  await pg2.waitForFunction(() => !transferLoading);
  // 讓「送出」跟「載入」交錯：送出先到後端，載入回來時送出的 promise 還沒結束
  await pg2.evaluate(async () => {
    window.__srv.delay = 300;
    transferScan('T1'); transferScan('T1');
    const f = flushTransferQueue();       // 後端立刻 +2
    const l = loadTransferPendingInner_(); // 拿到的清單已經含這 2 件
    await Promise.all([f, l]);
  });
  await pg2.waitForFunction(() => !transferLoading && transferQueue.length === 0, null, {timeout: 6000});
  await pg2.waitForTimeout(400);
  r = await pg2.evaluate(() => ({ local: (transferPending.concat(transferDone)).find(x=>x.sku==='T1').scannedQty, srv: window.__srv.items[0].scannedQty }));
  ck('畫面件數跟後端一致（沒有算兩次）', r.local === r.srv && r.srv === 3, r);

  console.log('\n【快取過期】超過一天的不拿出來');
  const pg3 = await ctx.newPage();
  await open(pg3);
  await pg3.evaluate(() => { const c = JSON.parse(localStorage.getItem('ssz_transfer_cache')); c.at = Date.now() - 26*3600*1000; localStorage.setItem('ssz_transfer_cache', JSON.stringify(c)); window.__srv.delay = 2000; });
  await pg3.evaluate(() => gotoView('transfer'));
  await pg3.waitForTimeout(150);
  r = await pg3.evaluate(() => document.getElementById('transferPendingList').textContent);
  ck('顯示「載入中」而不是昨天的清單', r.indexOf('載入中') >= 0, r);

  console.log('\n【沒有快取又讀不到】不能一直轉「載入中」');
  const pg4 = await (await b.newContext()).newPage();
  await open(pg4);
  await pg4.evaluate(() => { window.rawApiPost = async () => { throw new Error('HTTP 503'); }; gotoView('transfer'); });
  await pg4.waitForFunction(() => document.getElementById('transferPendingList').textContent.indexOf('讀不到') >= 0, null, {timeout: 4000});
  r = await pg4.evaluate(() => document.getElementById('transferPendingList').textContent);
  ck('說清楚讀不到、原因、怎麼重試', r.indexOf('HTTP 503') >= 0 && r.indexOf('重新讀') >= 0, r);

  ck('全程沒有 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(fail ? '\n有 '+fail+' 項失敗' : '\n介面全部通過');
  process.exit(fail?1:0);
})();
