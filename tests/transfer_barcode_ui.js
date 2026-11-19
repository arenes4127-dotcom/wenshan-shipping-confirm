// 調撥驗收：國際碼辨識、現場綁定 的介面測試
// 用法：node tests/transfer_barcode_ui.js
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
  const ctx = await b.newContext();                // 第二頁要共用同一份本機儲存，所以自己開 context
  const pg = await ctx.newPage();
  await pg.route(_PROD, r => r.abort());
  const errs = [];
  pg.on('pageerror', e => errs.push(String(e)));
  let fail = 0;
  const ck = (id, cond, extra) => { if(!cond){ console.log('  FAIL', id, extra===undefined?'':JSON.stringify(extra)); fail++; } else console.log('  ok  ', id); };
  await pg.addInitScript(() => localStorage.setItem('ssz_settings', JSON.stringify({backendUrl:'https://example.invalid/exec', store:'odm_shilin'})));
  await pg.goto(PAGE_URL());

  await pg.evaluate(() => {
    const S = window.__srv = { items: [
        {row:2, batchId:'B1', sku:'3020MB1150104', baseName:'mont-bell O.D. Pocket Tissue', spec:'1150104', qty:3, scannedQty:0, importedAt:'2026/11/19 08:00'},
        {row:3, batchId:'B1', sku:'3222C8809817182488', baseName:'CARGO 一氧化碳偵測器', spec:'8809817182488 軍綠', qty:1, scannedQty:0, importedAt:'2026/11/19 08:00'},
        {row:4, batchId:'B1', sku:'2022BF135730555', baseName:'BUFF Coolnet 頭巾', spec:'BF135730-555', qty:2, scannedQty:0, importedAt:'2026/11/19 08:00'},
        {row:5, batchId:'B1', sku:'SKU-UPC', baseName:'UPC 商品', spec:'', qty:1, scannedQty:0, importedAt:'2026/11/19 08:00'}],
      patch: [], binds: [], scans: [] };
    window.rawApiPost = async (action, payload) => {
      if(action === 'getTransferPending') return {ok:true, items: S.items.filter(x => x.scannedQty < x.qty).map(x => Object.assign({}, x)), recentDone: []};
      if(action === 'getBarcodePatch') return {ok:true, items: S.patch.slice()};
      if(action === 'bindBarcode'){
        S.binds.push(payload);
        const ex = S.patch.find(x => x.code === payload.code);
        if(ex && ex.sku !== payload.sku) return {ok:false, reason:'conflict', error:'已經記成 ' + ex.sku};
        if(!ex) S.patch.push({code: payload.code, sku: payload.sku});
        return {ok:true};
      }
      if(action === 'scanTransferBatch'){
        return {ok:true, results: payload.ops.map(op => {
          S.scans.push(op.sku);
          const it = S.items.find(x => x.sku === op.sku && x.scannedQty < x.qty);
          if(!it) return {ok:false, reason:'no_match', sku: op.sku};
          it.scannedQty++;
          return {ok:true, sku: it.sku, row: it.row, baseName: it.baseName, scannedQty: it.scannedQty, qty: it.qty, status: it.scannedQty >= it.qty ? 'done' : 'open'};
        })};
      }
      return {ok:true};
    };
    // 國際碼對照表：UPC 商品存的是 12 碼
    barcodeMap = {}; addBarcodeToMap_(barcodeMap, '043619147155', 'SKU-UPC', false);
    addBarcodeToMap_(barcodeMap, '4710000000002', 'NOT-ON-LIST', false);
    staff = [{id:'S05', name:'蔡'}];
    window.__beeps = []; window.errorBeep = () => window.__beeps.push('err'); window.okBeep = () => window.__beeps.push('ok');
    gotoView('transfer');
  });
  await pg.waitForFunction(() => transferConfirmedAt > 0);
  await pg.evaluate(() => { renderStaffSelects(); document.getElementById('transferStaffSelect').value = 'S05'; });
  const last = () => pg.evaluate(() => ({ beeps: window.__beeps.slice(), flash: document.getElementById('flashBig').textContent + '｜' + document.getElementById('flashSub').textContent }));
  const scanned = (sku) => pg.evaluate((s) => { const it = transferPending.concat(transferDone).find(x => x.sku === s); return it ? it.scannedQty : -1; }, sku);

  console.log('【寫法不同】UPC 開頭的 0 被吃掉（11 碼）也要認得');
  await pg.evaluate(() => { window.__beeps = []; transferScan('43619147155'); });
  ck('11 碼直接算進 SKU-UPC', (await scanned('SKU-UPC')) === 1, await last());

  console.log('\n【從單子上自動對】掃到的碼就是品號結尾／規格裡的編號');
  await pg.evaluate(() => { window.__beeps = []; transferScan('8809817182488'); });
  ck('算進 CARGO 那一件', (await scanned('3222C8809817182488')) === 1, await last());
  ck('沒有跳出選擇視窗', !(await pg.isVisible('#tbindMask')));
  ck('而且記住了', (await pg.evaluate(() => (barcodeMap['8809817182488']||[]).join())) === '3222C8809817182488');
  await pg.waitForFunction(() => window.__srv.binds.length === 1, null, {timeout: 3000});
  ck('後端也記下，來源寫「品號／規格內含此碼」', (await pg.evaluate(() => window.__srv.binds[0].source)).indexOf('規格內含') >= 0);

  console.log('\n【網址 QR】');
  await pg.evaluate(() => { window.__beeps = []; transferScan('https://www.buff.com/how-to-wear'); });
  let r = await last();
  ck('講清楚是網址 QR、請掃一維條碼', r.beeps[0] === 'err' && r.flash.indexOf('網址 QR') >= 0, r);
  ck('不會跳出選擇視窗', !(await pg.isVisible('#tbindMask')));

  console.log('\n【認得、但不在這批調撥單上】');
  await pg.evaluate(() => { window.__beeps = []; transferScan('4710000000002'); });
  r = await last();
  ck('講出是哪個品號', r.beeps[0] === 'err' && r.flash.indexOf('NOT-ON-LIST') >= 0, r);

  console.log('\n【別件商品的品號標籤】不能拿去問「這是哪一件」');
  await pg.evaluate(() => { window.__beeps = []; transferScan('1007A1UCGZ15MAXL'); });
  r = await last();
  ck('英數品號：照原本當場響「找不到」，不跳指認', r.beeps[0] === 'err' && !(await pg.isVisible('#tbindMask')), r);
  await pg.evaluate(() => { productImages['320135100130'] = 'x'; window.__beeps = []; transferScan('320135100130'); });
  r = await last();
  ck('全數字的品號（剛好像條碼）：認出是品號，不跳指認', r.beeps[0] === 'err' && r.flash.indexOf('是一個品號') >= 0 && !(await pg.isVisible('#tbindMask')), r);

  console.log('\n【沒掃完整】檢查碼不對');
  await pg.evaluate(() => { window.__beeps = []; transferScan('4943161421987'); });
  r = await last();
  ck('請再掃一次，不給綁定', r.beeps[0] === 'err' && r.flash.indexOf('沒掃完整') >= 0 && !(await pg.isVisible('#tbindMask')), r);

  console.log('\n【認不得的國際碼】請人點是哪一件');
  await pg.evaluate(() => { window.__beeps = []; transferScan('4943161421986'); });
  ck('跳出「這個條碼是哪一件？」', await pg.isVisible('#tbindMask'));
  ck('沒有響錯誤聲', (await last()).beeps.indexOf('err') < 0);
  ck('只列還沒收滿的（2 件：CARGO、UPC 已收滿不列）', (await pg.locator('#tbindList .q-item').count()) === 2);
  await pg.fill('#tbindFilter', 'tissue');
  ck('打字可以縮小範圍', (await pg.locator('#tbindList .q-item').count()) === 1);
  await pg.locator('#tbindList .q-item').first().click();
  await pg.waitForSelector('#confirmMask.show');
  ck('確認框寫清楚記住之後出貨也會認得', (await pg.textContent('#confirmMask')).indexOf('出貨掃描') >= 0);
  await pg.click('#confirmCancel');
  ck('按取消回到選擇視窗、沒有算件數', (await pg.isVisible('#tbindMask')) && (await scanned('3020MB1150104')) === 0);
  await pg.locator('#tbindList .q-item').first().click();
  await pg.waitForSelector('#confirmMask.show');
  await pg.click('#confirmOk');
  // 前面「從規格自動對到 CARGO」也記了一筆，所以找這個條碼的那一筆
  await pg.waitForFunction(() => window.__srv.binds.some(x => x.code === '4943161421986'), null, {timeout: 3000});
  r = await pg.evaluate(() => ({ b: window.__srv.binds.find(x => x.code === '4943161421986'), map: (barcodeMap['4943161421986']||[]).join(), shown: document.getElementById('tbindMask').classList.contains('show') }));
  ck('這次算進那一件', (await scanned('3020MB1150104')) === 1);
  ck('後端記下：條碼、品號、誰、來源', r.b.code === '4943161421986' && r.b.sku === '3020MB1150104' && r.b.staffName === '蔡' && /人工指認/.test(r.b.source), r.b);
  ck('本機也馬上認得', r.map === '3020MB1150104', r);
  await pg.evaluate(() => { window.__beeps = []; transferScan('4943161421986'); });
  ck('再掃同一個碼：直接算，不再問', (await scanned('3020MB1150104')) === 2 && !(await pg.isVisible('#tbindMask')));

  console.log('\n【後端不收】例如別人剛把同一個碼記成別的品號');
  await pg.evaluate(() => { window.__srv.patch.push({code:'8428927574923', sku:'SOMEONE-ELSE'}); window.__beeps = []; transferScan('8428927574923'); });
  await pg.locator('#tbindList .q-item', {hasText: 'BUFF'}).click();
  await pg.waitForSelector('#confirmMask.show');
  await pg.click('#confirmOk');
  await pg.waitForFunction(() => window.__beeps.indexOf('err') >= 0, null, {timeout: 3000});
  r = await pg.evaluate(() => ({ map: barcodeMap['8428927574923'], flash: document.getElementById('flashBig').textContent, saved: JSON.parse(localStorage.getItem('ssz_barcode_patch')).some(x => x.code === '8428927574923') }));
  ck('撤回本機那一筆', !r.map && !r.saved, r);
  ck('說明沒記住', r.flash.indexOf('沒有記住') >= 0, r);

  console.log('\n【其他模組也認得】重新整理頁面後，出貨掃描掃到綁過的碼');
  const pg2 = await ctx.newPage();      // 同一個瀏覽器環境，本機儲存才是共用的
  await pg2.route(_PROD, r => r.abort());
  pg2.on('pageerror', e => errs.push(String(e)));
  await pg2.addInitScript(() => localStorage.setItem('ssz_settings', JSON.stringify({backendUrl:'https://example.invalid/exec', store:'odm_shilin'})));
  // 同一個瀏覽器 context 的 localStorage 是共用的：本機副本在
  await pg2.goto(PAGE_URL());
  r = await pg2.evaluate(() => (barcodeMap['4943161421986']||[]).join());
  ck('開頁面就認得（本機副本）', r === '3020MB1150104', r);

  console.log('\n【後端還沒部署】綁定送不到，部署後同步時自動補送');
  await pg.evaluate(() => {
    window.__srv.down = true;
    const orig = window.rawApiPost;
    window.rawApiPost = async (a, p) => { if(window.__srv.down && (a === 'bindBarcode' || a === 'getBarcodePatch')) throw new Error('後端還沒更新到支援這個功能的版本'); return orig(a, p); };
    window.__srv.items.push({row:9, batchId:'B2', sku:'NEW-ODM', baseName:'ODM 門市商品', spec:'', qty:1, scannedQty:0, importedAt:'2026/11/19 09:00'});
  });
  await pg.evaluate(() => loadTransferPending());
  await pg.waitForFunction(() => transferPending.some(x => x.sku === 'NEW-ODM'));
  await pg.evaluate(() => { window.__beeps = []; transferScan('4548801148102'); });
  await pg.locator('#tbindList .q-item', {hasText: 'ODM'}).click();
  await pg.waitForSelector('#confirmMask.show');
  await pg.click('#confirmOk');
  await pg.waitForTimeout(300);
  r = await pg.evaluate(() => ({ pend: barcodePatchList.filter(x => x.pending).map(x => x.code), srv: window.__srv.patch.map(x => x.code) }));
  ck('送不到：這次照樣算件數，本機標成待送', (await scanned('NEW-ODM')) === 1 && r.pend.indexOf('4548801148102') >= 0 && r.srv.indexOf('4548801148102') < 0, r);
  await pg.evaluate(() => { window.__srv.down = false; return loadBarcodePatch(); });
  await pg.waitForFunction(() => window.__srv.patch.some(x => x.code === '4548801148102'), null, {timeout: 3000});
  r = await pg.evaluate(() => ({ pend: barcodePatchList.filter(x => x.pending).length, note: window.__srv.binds.filter(x => x.code === '4548801148102').pop().note }));
  ck('部署後同步時自動補送到後端', r.pend === 0, r);
  ck('補送的那筆有註明是補送', /補送/.test(r.note), r);

  ck('全程沒有 JS 錯誤', errs.length === 0, errs);
  await b.close(); _srv.close();
  console.log(fail ? '\n有 '+fail+' 項失敗' : '\n介面全部通過');
  process.exit(fail?1:0);
})();
