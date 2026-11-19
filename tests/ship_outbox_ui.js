// 完成出貨「先過、後送」的端到端測試
//
// 用法：node tests/ship_outbox_ui.js
//
// 走真的流程：掃訂單號 → 掃商品 → 掃運單 → 完成出貨。後端換成可以控制的假後端：
// 可以讓它慢、讓它逾時（但其實已寫入）、讓它回「已經被別人出掉了」。
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs'), http = require('http');
// 用本機 http 伺服器開頁面，不用 file://。Chromium 對 file:// 的 localStorage 在不同分頁間
// 不保證共用（實測 14 次有 4 次第二頁拿到空的），而這支測試正好要驗「重新開頁面後本機資料還在」。
const _root = path.resolve('.');
const _srv = http.createServer((q, r) => {
  const f = path.join(_root, decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  fs.readFile(f, (e, d) => { if(e){ r.writeHead(404); r.end(); return; }
    r.writeHead(200, {'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8'}); r.end(d); });
}).listen(0);
const PAGE_URL = () => 'http://127.0.0.1:' + _srv.address().port + '/index.html';
(async () => {
  const b = await chromium.launch();
  const _PROD = /script\.google\.com|script\.googleusercontent\.com|docs\.google\.com/;
  const errs = [];
  let fail = 0;
  const ck = (id, cond, extra) => { if(!cond){ console.log('  FAIL', id, extra===undefined?'':JSON.stringify(extra)); fail++; } else console.log('  ok  ', id); };

  async function open(ctx, version){
    const pg = await ctx.newPage();
    await pg.route(_PROD, r => r.abort());
    pg.on('pageerror', e => errs.push(String(e)));
    pg.on('dialog', d => d.dismiss());
    await pg.addInitScript((v) => {
      localStorage.setItem('ssz_settings', JSON.stringify({backendUrl:'https://example.invalid/exec', store:'odm_shilin'}));
      localStorage.setItem('ssz_current_staff', 'S06');
      if(v) localStorage.setItem('ssz_backend_version', JSON.stringify(v));
    }, version);
    await pg.goto(PAGE_URL());
    await pg.evaluate(() => {
      // 假後端。srv 在 localStorage 外面的記憶體裡，模擬「後端那邊的真相」
      const S = window.__srv = { shipped: {}, logRows: [], mode: 'ok', delayMs: 0, calls: [] };
      const mkOrder = (no) => ({orderNo: no, date:'2026/11/17', store:'蝦皮', status:'pending',
        items:[{sku:'A1', name:'水壺', baseName:'水壺', spec:'', qty:1}]});
      window.__orders = { O1: mkOrder('O1'), O2: mkOrder('O2'), O3: mkOrder('O3') };
      window.rawApiGet = async () => {
        const out = JSON.parse(JSON.stringify(window.__orders));
        Object.keys(S.shipped).forEach(k => { if(out[k]) out[k].status = 'shipped'; });
        return {ok:true, orders: out, staff:[{id:'S06', name:'郭'}], version: window.__srvVersion || '2026-11-17.217'};
      };
      window.rawApiPost = async (action, payload) => {
        S.calls.push(action);
        if(action === 'claimOrder') return {ok:true};
        if(action !== 'finalizeShipment') return {ok:true};
        const e = payload.entry;
        await new Promise(r => setTimeout(r, S.delayMs));
        if(S.mode === 'down') throw new Error('Failed to fetch');
        if(S.mode === 'timeoutAfterWrite' && !S.shipped[e.orderNo]){
          S.shipped[e.orderNo] = e.time; S.logRows.push(e.orderNo);
          throw new Error('逾時');                     // 其實寫進去了，只是回應丟了
        }
        if(S.shipped[e.orderNo]){
          if(S.shipped[e.orderNo] === e.time) return {ok:true, duplicate:true};
          return {ok:false, reason:'already_shipped', shippedAt: S.shipped[e.orderNo]};
        }
        S.shipped[e.orderNo] = e.time; S.logRows.push(e.orderNo);
        return {ok:true};
      };
      window.__beeps = [];
      window.errorBeep = () => window.__beeps.push('err');
    });
    await pg.evaluate(() => refreshFromBackend(true));
    await pg.evaluate(() => { staff = [{id:'S06', name:'郭'}]; currentStaffId = 'S06'; gotoView('scan'); });
    return pg;
  }
  async function shipOne(pg, no, waybill){
    await pg.evaluate(async (no) => { await scanOrder(no); }, no);
    await pg.waitForFunction(() => current && current.items, null, {timeout: 3000});
    await pg.evaluate(() => scanShipmentBarcode('A1'));
    const t0 = Date.now();
    await pg.evaluate((w) => finalizeShipment(w), waybill);
    return Date.now() - t0;
  }

  console.log('【先過】後端很慢（3 秒），按下完成出貨不用等');
  const ctx = await b.newContext();
  let pg = await open(ctx, '2026-11-17.217');
  await pg.evaluate(() => { window.__srv.delayMs = 3000; });
  let ms = await shipOne(pg, 'O1', 'W1');
  let r = await pg.evaluate(() => ({ cur: !!current, stage: document.getElementById('stage-order').style.display,
    status: orders.O1.status, chip: document.getElementById('shipQueueChip').textContent, q: shipQueue.length,
    logTag: log[0] && log[0]._pending, badge: document.getElementById('pendingBadge').textContent }));
  console.log('   按下完成出貨到可以掃下一張：' + ms + ' ms');
  ck('不到 0.5 秒就回到「掃下一張」', ms < 500 && !r.cur && r.stage === 'block', {ms, r});
  ck('本機已當成出貨', r.status === 'shipped', r);
  ck('標題列顯示「1 筆出貨送出中」', r.chip.indexOf('1 筆出貨送出中') >= 0, r.chip);
  ck('出貨紀錄先記一筆，標「送出中」', r.logTag === true, r);
  // 「N 張待出貨」只在首頁重畫（既有行為），切過去看
  const badge = await pg.evaluate(() => { gotoView('home'); const t = document.getElementById('pendingBadge').textContent; gotoView('scan'); return t; });
  ck('首頁的待出貨立刻少一張（3 → 2）', badge.indexOf('2 張') === 0, badge);

  console.log('\n【連續出貨】上一張還在送，下一張照樣可以掃');
  ms = await shipOne(pg, 'O2', 'W2');
  r = await pg.evaluate(() => ({ q: shipQueue.length, chip: document.getElementById('shipQueueChip').textContent }));
  ck('第二張也不用等（' + ms + ' ms）', ms < 500, ms);
  ck('佇列 2 筆', r.q === 2 && r.chip.indexOf('2 筆') >= 0, r);

  await pg.waitForFunction(() => shipQueue.length === 0, null, {timeout: 12000});
  r = await pg.evaluate(() => ({ srv: window.__srv.logRows.slice(), chip: document.getElementById('shipQueueChip').style.display,
    pending: log.filter(l => l._pending).length }));
  ck('兩筆都送到後端，照順序', r.srv.join(',') === 'O1,O2', r.srv);
  ck('送完後標題列的提示消失', r.chip === 'none', r);
  ck('出貨紀錄的「送出中」都拿掉了', r.pending === 0, r);

  console.log('\n【背景輪詢】還沒送到時拿回後端資料，剛出完的單不能又冒出來');
  await pg.evaluate(() => { window.__srv.delayMs = 4000; });
  await shipOne(pg, 'O3', 'W3');
  await pg.evaluate(() => refreshFromBackend(true, true));      // 後端那邊 O3 還沒寫進去
  r = await pg.evaluate(() => ({ s: orders.O3.status, srv: !!window.__srv.shipped.O3 }));
  ck('後端還沒收到，但本機仍顯示已出貨', r.s === 'shipped' && r.srv === false, r);
  await pg.evaluate(() => refreshFromBackend(true, false));     // 完整刷新（含出貨紀錄）
  r = await pg.evaluate(() => log.filter(l => l.orderNo === 'O3').map(l => !!l._pending));
  ck('完整刷新後，出貨紀錄裡那筆「送出中」還在', r.length === 1 && r[0] === true, r);
  await pg.waitForFunction(() => shipQueue.length === 0, null, {timeout: 12000});

  console.log('\n【逾時但其實已寫入】自動重送不能被當成衝突，也不能出兩次');
  await pg.evaluate(() => { window.__orders.O4 = {orderNo:'O4', date:'', store:'', status:'pending', items:[{sku:'A1', name:'水壺', baseName:'水壺', spec:'', qty:1}]};
    window.__srv.delayMs = 0; window.__srv.mode = 'timeoutAfterWrite'; window.__beeps = []; });
  await pg.evaluate(() => refreshFromBackend(true));
  await shipOne(pg, 'O4', 'W4');
  await pg.waitForFunction(() => shipQueue.length === 0, null, {timeout: 12000});
  r = await pg.evaluate(() => ({ srv: window.__srv.logRows.filter(x => x === 'O4').length, issues: shipIssues.length,
    beeps: window.__beeps.slice(), banner: document.getElementById('shipIssueBanner').style.display }));
  ck('後端只記了一次', r.srv === 1, r);
  ck('沒有跳衝突警示、沒有響錯誤', r.issues === 0 && r.beeps.length === 0 && r.banner === 'none', r);

  console.log('\n【真的被別人出掉了】警示一直掛著，按「我知道了」才收');
  await pg.evaluate(() => { window.__orders.O5 = {orderNo:'O5', date:'', store:'', status:'pending', items:[{sku:'A1', name:'水壺', baseName:'水壺', spec:'', qty:1}]};
    window.__srv.mode = 'ok'; window.__srv.delayMs = 300; });
  await pg.evaluate(() => refreshFromBackend(true));
  await shipOne(pg, 'O5', 'W5-mine');
  await pg.evaluate(() => { window.__srv.shipped.O5 = '2026/11/17 下午3:00:00'; });   // 送到之前，別台先出了
  await pg.waitForFunction(() => shipQueue.length === 0, null, {timeout: 8000});
  r = await pg.evaluate(() => ({ banner: document.getElementById('shipIssueBanner').textContent,
    shown: document.getElementById('shipIssueBanner').style.display, beeps: window.__beeps.slice(),
    inLog: log.some(l => l.orderNo === 'O5' && l.waybill === 'W5-mine') }));
  ck('紅色警示出現，講清楚是哪張、哪個運單、對方什麼時候出的', r.shown === '' && r.banner.indexOf('O5') >= 0
     && r.banner.indexOf('W5-mine') >= 0 && r.banner.indexOf('下午3:00:00') >= 0, r);
  ck('有響錯誤聲', r.beeps.indexOf('err') >= 0, r.beeps);
  ck('本機那筆沒被記錄的出貨紀錄拿掉了', r.inLog === false, r);
  await pg.waitForTimeout(3000);
  ck('3 秒後還掛著（不會自己消失）', (await pg.evaluate(() => document.getElementById('shipIssueBanner').style.display)) === '');
  await pg.click('#shipIssueBanner button');
  ck('按「我知道了」才收起來', (await pg.evaluate(() => document.getElementById('shipIssueBanner').style.display)) === 'none');

  console.log('\n【斷線】送不出去就一直留著，重新整理也不會掉，恢復後自動送完');
  await pg.evaluate(() => { window.__orders.O6 = {orderNo:'O6', date:'', store:'', status:'pending', items:[{sku:'A1', name:'水壺', baseName:'水壺', spec:'', qty:1}]};
    window.__srv.mode = 'down'; window.__srv.delayMs = 0; });
  await pg.evaluate(() => refreshFromBackend(true));
  await shipOne(pg, 'O6', 'W6');
  await pg.waitForFunction(() => shipQueue[0] && shipQueue[0].tries >= 2, null, {timeout: 10000});
  r = await pg.evaluate(() => ({ q: shipQueue.length, saved: JSON.parse(localStorage.getItem('ssz_ship_queue')).length }));
  ck('留在佇列、也存進本機', r.q === 1 && r.saved === 1, r);
  await pg.evaluate(() => { shipQueue[0].tries = 4; renderShipStatus_(); });
  r = await pg.evaluate(() => ({ t: document.getElementById('shipQueueChip').textContent, w: document.getElementById('shipQueueChip').classList.contains('warn') }));
  ck('一直送不出去時標題列轉紅提醒', r.w && r.t.indexOf('還沒送出') >= 0, r);

  // 重新開頁面（模擬關掉分頁、隔一陣子再開），後端恢復
  await pg.close();
  pg = await open(ctx, null);      // 新頁面的假後端是正常的（網路恢復）
  r = await pg.evaluate(() => ({ q: shipQueue.length, o: shipQueue[0] && shipQueue[0].entry.orderNo }));
  ck('重新開頁面，佇列還在（O6 那筆沒掉）', r.q === 1 && r.o === 'O6', r);
  await pg.waitForFunction(() => shipQueue.length === 0, null, {timeout: 15000});
  r = await pg.evaluate(() => ({ srv: window.__srv.logRows.filter(x => x === 'O6').length }));
  ck('網路恢復後自動送完，後端收到一次', r.srv === 1, r);

  console.log('\n【後端還是舊版】不啟用，照舊等後端確認');
  const ctx2 = await b.newContext();
  pg = await open(ctx2, '2026-11-17.216');
  await pg.evaluate(() => { window.__srvVersion = '2026-11-17.216'; window.__srv.delayMs = 1500; });
  await pg.evaluate(() => refreshFromBackend(true));
  ms = await shipOne(pg, 'O1', 'W1');
  r = await pg.evaluate(() => ({ q: shipQueue.length, srv: window.__srv.logRows.length, en: shipOutboxEnabled_() }));
  ck('沒有啟用', r.en === false, r);
  ck('照舊等後端寫完才回來（' + ms + ' ms）', ms >= 1400 && r.q === 0 && r.srv === 1, {ms, r});

  ck('全程沒有 JS 錯誤', errs.length === 0, errs);
  await b.close(); _srv.close();
  console.log(fail ? '\n有 '+fail+' 項失敗' : '\n介面全部通過');
  process.exit(fail?1:0);
})();
