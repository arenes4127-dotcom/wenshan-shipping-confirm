// 貨架查詢結果：點單一商品加入／移出異動清單
// 用法：node tests/shelf_pick_ui.js [截圖輸出路徑]
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
  const pg = await b.newPage({ viewport:{width:430, height:900}, deviceScaleFactor: process.argv[2] ? 2 : 1 });
  const errs = [];
  pg.on('pageerror', e => errs.push(String(e)));
  await pg.addInitScript(() => localStorage.setItem('ssz_settings', JSON.stringify({backendUrl:'https://example.invalid/exec', store:'odm_shilin', staff:'x'})));
  await pg.goto('file://' + path.resolve('index.html'));
  let fail = 0;
  const ck = (id, cond, extra) => { if(!cond){ console.log('  FAIL', id, extra===undefined?'':JSON.stringify(extra)); fail++; } else console.log('  ok  ', id); };

  await pg.evaluate(() => {
    const items = [];
    ['AL','AM','AS','AX'].forEach((s, i) => items.push({sku:'1004P42171'+s, baseName:'PS 兒童羽絨背心<紅/'+(152-i*12)+'>',
      matched:'B11-3', location:'B11-3', stockWs:'2', stockMain:'0', alsoAt:[], note:''}));
    items.push({sku:'ZERO1', baseName:'庫存 0 的', matched:'B11-3', location:'B11-3、M2-2', stockWs:'', stockMain:'', alsoAt:['M2-2'], note:''});
    window.rawApiPost = async (action) => action === 'listLocationContents'
      ? {ok:true, total:items.length, noStock:1, locations:[{location:'B11-3'}], items}
      : (action === 'getLocationVocab' ? {ok:true, zones:[{code:'B', slots:[11], levels:[3], usedSlots:[11], pad:true}], textZones:[], suffixes:[], known:['B11-3']} : {ok:true});
    gotoView('loc');
  });
  await pg.click('#btnShelfQuery');
  await pg.waitForSelector('#shelfMask.show');
  await pg.click('#qRun');
  await pg.waitForSelector('#qResult .q-item');

  console.log('【點一件】');
  ck('每一列都有 ＋', (await pg.locator('#qResult .q-item .pick').allTextContents()).every(t => t === '＋'));
  await pg.locator('#qResult .q-item').nth(1).click();
  let r = await pg.evaluate(() => ({ batch: locBatch.filter(x=>x.ok).map(x=>x.sku),
    mark: document.querySelectorAll('#qResult .q-item')[1].querySelector('.pick').textContent,
    cls: document.querySelectorAll('#qResult .q-item')[1].classList.contains('in-batch'),
    count: document.getElementById('locBatchCount').textContent }));
  ck('只加了點的那一件', r.batch.join(',') === '1004P42171AM', r);
  ck('那一列變成 ✓ 並且亮起來', r.mark === '✓' && r.cls, r);
  ck('下面的待處理數字跟著更新', r.count.indexOf('1 件') >= 0, r.count);
  ck('帶入原本的儲位', (await pg.evaluate(() => locBatch[0].location)) === 'B11-3');

  await pg.locator('#qResult .q-item').nth(3).click();
  await pg.locator('#qResult .q-item').nth(4).click();
  r = await pg.evaluate(() => locBatch.filter(x=>x.ok).map(x=>x.sku));
  ck('再點兩件，共三件', r.length === 3 && r.indexOf('ZERO1') >= 0, r);
  ck('多個儲位的商品，原本的儲位清單有帶全', (await pg.evaluate(() => locBatch.find(x=>x.sku==='ZERO1').locations.join(','))) === 'B11-3,M2-2');

  console.log('\n【再點一次拿掉】');
  await pg.locator('#qResult .q-item').nth(1).click();
  r = await pg.evaluate(() => ({ batch: locBatch.filter(x=>x.ok).map(x=>x.sku),
    mark: document.querySelectorAll('#qResult .q-item')[1].querySelector('.pick').textContent }));
  ck('AM 被拿掉、其他兩件還在', r.batch.length === 2 && r.batch.indexOf('1004P42171AM') < 0, r);
  ck('標記回到 ＋', r.mark === '＋', r);

  console.log('\n【點圖片是看大圖，不是加入】');
  await pg.evaluate(() => { window.__origImg = window.productImageUrl; window.productImageUrl = () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw='; renderShelfResult(); });
  const before = await pg.evaluate(() => locBatch.length);
  await pg.locator('#qResult .q-item img.thumb').first().click();
  ck('點圖片不會加入清單', (await pg.evaluate(() => locBatch.length)) === before);
  await pg.evaluate(() => { window.productImageUrl = window.__origImg; renderShelfResult(); });
  await pg.evaluate(() => { const v = document.getElementById('imgView'); if(v) v.classList.remove('show'); if(window.closeImgView) closeImgView(); });

  console.log('\n【跟整格加入一起用】');
  await pg.click('#qResult button:has-text("整格加入異動清單")');
  r = await pg.evaluate(() => ({ n: locBatch.filter(x=>x.ok).length,
    marks: Array.from(document.querySelectorAll('#qResult .q-item .pick')).map(x=>x.textContent) }));
  ck('整格加入只補上還沒加的，不會重複（共 5 件）', r.n === 5, r);
  ck('每一列都變成 ✓', r.marks.every(t => t === '✓'), r.marks);

  console.log('\n【捲動位置】點一件之後不該跳回最上面');
  await pg.evaluate(() => { const box = document.querySelector('#shelfMask .confirm-box'); box.style.maxHeight = '300px'; box.style.overflow = 'auto'; box.scrollTop = 200; });
  const top0 = await pg.evaluate(() => document.querySelector('#shelfMask .confirm-box').scrollTop);
  await pg.evaluate(() => toggleShelfItemInBatch('ZERO1', 'B11-3'));
  const top1 = await pg.evaluate(() => document.querySelector('#shelfMask .confirm-box').scrollTop);
  ck('捲動位置沒變', top0 === top1 && top0 > 0, {top0, top1});
  await pg.evaluate(() => { const box = document.querySelector('#shelfMask .confirm-box'); box.style.maxHeight = ''; box.style.overflow = ''; box.scrollTop = 0; });

  if(process.argv[2]){
    await pg.evaluate(() => { locBatch = []; renderLocBatch(); renderShelfResult(); });
    await pg.locator('#qResult .q-item').nth(0).click();
    await pg.locator('#qResult .q-item').nth(2).click();
    await pg.waitForTimeout(1300);
    await pg.locator('#shelfMask .confirm-box').screenshot({ path: process.argv[2] });
  }
  ck('全程沒有 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(fail ? '\n有 '+fail+' 項失敗' : '\n介面全部通過');
  process.exit(fail?1:0);
})();
