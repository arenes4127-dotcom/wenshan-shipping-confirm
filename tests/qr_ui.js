// 儲位 QR 標籤的介面測試
//
// 用法：node tests/qr_ui.js [存放輸出 PDF/PNG 的資料夾]
// 選用：設環境變數 QR_DECODE_MODULES 指到裝有 jsqr 與 pngjs 的 node_modules，
//       會把印出來的標籤轉成圖再真的解碼一次（QR 畫得出來不代表掃得到）。
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs'), http = require('http');
const outDir = process.argv[2] || null;

(async () => {
  // qrcode.js 是動態載入的，file:// 下載入行為各瀏覽器不一，用本機伺服器比較接近正式環境
  const root = path.resolve('.');
  const srv = http.createServer((q, r) => {
    const f = path.join(root, decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
    fs.readFile(f, (e, d) => { if(e){ r.writeHead(404); r.end(); return; }
      r.writeHead(200, {'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8'}); r.end(d); });
  }).listen(0);
  const port = srv.address().port;

  const b = await chromium.launch();
  const pg = await b.newPage({ viewport:{width:900, height:1100} });
  const errs = [];
  pg.on('pageerror', e => errs.push(String(e)));
  await pg.addInitScript(() => {
    localStorage.setItem('wsc_settings', JSON.stringify({ backendUrl:'https://example.invalid/exec', store:'odm_shilin', staff:'測試員' }));
  });
  await pg.goto('http://127.0.0.1:' + port + '/index.html');
  let fail = 0;
  const ck = (id, cond, extra) => { if(!cond){ console.log('  FAIL', id, extra===undefined?'':JSON.stringify(extra)); fail++; } else console.log('  ok  ', id); };

  const VOCAB = {ok:true,
    zones:[{code:'A', slots:[1,2,3,4], levels:[1,2,3], usedSlots:[1,4], pad:true},
           {code:'K', slots:[9,10], levels:[1,2], usedSlots:[9], pad:true}],
    textZones:[{code:'門口棧板'}], suffixes:['上','下'],
    known:['A01-1','A01-2','A04-3','K9-1','K10-2','C06-2上','門口棧板']};
  await pg.evaluate((VOCAB) => {
    window.__calls = [];
    window.rawApiPost = async (action, payload) => {
      window.__calls.push({action, payload});
      if(action === 'getLocationVocab') return VOCAB;
      if(action === 'listLocationContents') return {ok:true, total:0, items:[]};
      return {ok:true};
    };
    window.__printed = 0;
    window.print = () => { window.__printed++; };      // 不要真的跳出列印視窗
  }, VOCAB);
  await pg.evaluate(() => gotoView('loc'));

  console.log('【編碼】標籤內容要是純英數符號，而且解得回來');
  let r = await pg.evaluate(() => ({
    a: locQrEncode('A04-3'), b: locQrEncode('C06-2上'), c: locQrEncode('門口棧板'),
    da: locQrDecode(locQrEncode('A04-3')), db: locQrDecode(locQrEncode('C06-2上')), dc: locQrDecode(locQrEncode('門口棧板')),
    sku: locQrDecode('2076262A3601A03'), ean: locQrDecode('4710123456789'), bare: locQrDecode('A04-3'),
  }));
  console.log('   ', r.a, '／', r.b);
  ck('一般儲位', r.a === 'LOC:A04-3', r.a);
  ck('含中文的儲位編出來沒有中文', /^[\x21-\x7e]+$/.test(r.b) && /^[\x21-\x7e]+$/.test(r.c), [r.b, r.c]);
  ck('三種都解得回原字串', r.da === 'A04-3' && r.db === 'C06-2上' && r.dc === '門口棧板', r);
  ck('商品貨號、國際條碼不會被誤認成儲位', r.sku === null && r.ean === null, r);
  ck('沒有前綴的「A04-3」不算儲位標籤（它可能是貨號）', r.bare === null, r);

  await pg.click('#btnQrGen');
  await pg.waitForFunction(() => document.querySelectorAll('#qrZone option').length > 0);
  r = await pg.evaluate(() => ({
    full: locQrDecode('ＬＯＣ：Ａ０４－３'), caps: locQrDecode('loc:a04-3'), capsK: locQrDecode('loc:k9-1'),
    bad: locQrDecode('LOC:%E4%B8'), empty: locQrDecode('LOC:'),
  }));
  ck('輸入法全形打出來的也認得', r.full === 'A04-3', r);
  ck('Caps Lock 反掉大小寫，會對回地圖上的寫法', r.caps === 'A04-3' && r.capsK === 'K9-1', r);
  ck('壞掉的內容回 null 而不是丟例外', r.bad === null && r.empty === null, r);

  console.log('\n【清單】整區加入、已有儲位、手打、去重複');
  ck('視窗打開', await pg.isVisible('#qrMask'));
  ck('區的選單有貨架區跟文字區', (await pg.locator('#qrZone option').count()) === 3);
  await pg.selectOption('#qrFrom', '1'); await pg.selectOption('#qrTo', '2');
  await pg.click('#qrAddGrid');
  let list = (await pg.inputValue('#qrList')).split('\n');
  console.log('   A 區第 1–2 格 →', list.join(' '));
  ck('2 格 × 3 層 = 6 個', list.length === 6 && list[0] === 'A01-1' && list[5] === 'A02-3', list);
  ck('統計：6 張、1 頁', (await pg.textContent('#qrStat')).indexOf('共 6 張標籤，1 頁') === 0, await pg.textContent('#qrStat'));
  await pg.click('#qrAddGrid');
  ck('再按一次不會重複加', (await pg.inputValue('#qrList')).split('\n').length === 6);

  await pg.selectOption('#qrZone', 'K');
  await pg.click('#qrAddGrid');
  list = (await pg.inputValue('#qrList')).split('\n');
  ck('K 區沿用地圖上既有的寫法（K9-1，不是 K09-1）', list.indexOf('K9-1') >= 0 && list.indexOf('K09-1') < 0, list);

  await pg.click('#qrClear');
  await pg.selectOption('#qrZone', 'A');
  await pg.click('#qrAddKnown');
  list = (await pg.inputValue('#qrList')).split('\n');
  ck('「地圖上已有的」只加 A 區實際存在的三個', list.join(',') === 'A01-1,A01-2,A04-3', list);
  await pg.selectOption('#qrZone', '__t__門口棧板');
  ck('文字區不顯示格位範圍', !(await pg.isVisible('#qrFromField')));
  await pg.click('#qrAddKnown');
  await pg.evaluate(() => { const t = document.getElementById('qrList'); t.value += '\nC06-2上\nA01-1, ZZ99-9'; t.dispatchEvent(new Event('input')); });
  ck('手打的也算進去、重複的只算一次（共 6 張）', (await pg.textContent('#qrStat')).indexOf('共 6 張') === 0, await pg.textContent('#qrStat'));

  console.log('\n【起始格】標籤紙前面用掉幾格，從中間開始印');
  await pg.selectOption('#qrStart', '8');
  ck('從第 8 格開始，6 張要 2 頁', (await pg.textContent('#qrStat')).indexOf('2 頁') > 0, await pg.textContent('#qrStat'));

  console.log('\n【列印版面】');
  await pg.evaluate(() => { window.removeEventListener; });
  // 攔住 afterprint 的清理，才看得到排好的版面
  await pg.evaluate(() => { window.__origPrint = window.print; });
  await pg.click('#qrPrint');
  await pg.waitForFunction(() => window.__printed === 1);
  r = await pg.evaluate(() => {
    const area = document.getElementById('qrPrintArea');
    const cells = Array.from(area.querySelectorAll('.qr-cell'));
    return { sheets: area.querySelectorAll('.qr-sheet').length, cells: cells.length,
      filled: cells.map((c, i) => c.querySelector('svg') ? i : -1).filter(i => i >= 0),
      names: cells.filter(c => c.querySelector('svg')).map(c => c.querySelector('.qr-name').textContent),
      libLoaded: typeof window.qrcode === 'function', pageStyle: !!document.getElementById('qrPageStyle'),
      bodyCls: document.body.classList.contains('printing-qr'),
      direct: area.parentNode === document.body };
  });
  ck('QR 函式庫是按了列印才載入的', r.libLoaded);
  ck('排成 2 張、20 格', r.sheets === 2 && r.cells === 20, r);
  ck('前 7 格空著，從第 8 格開始放', r.filled.join(',') === '7,8,9,10,11,12', r.filled);
  ck('每格的名稱照清單順序', r.names.join(',') === 'A01-1,A01-2,A04-3,門口棧板,C06-2上,ZZ99-9', r.names);
  ck('列印區直接掛在 body 底下（隱藏其他內容的規則才會生效）', r.direct);
  ck('紙張設定有套上', r.pageStyle && r.bodyCls, r);

  await pg.emulateMedia({ media: 'print' });
  const vis = await pg.evaluate(() => {
    const shown = Array.from(document.body.children).filter(el => getComputedStyle(el).display !== 'none').map(el => el.id || el.tagName);
    const c = document.querySelector('#qrPrintArea .qr-cell svg').closest('.qr-cell').getBoundingClientRect();
    const s = document.querySelector('#qrPrintArea .qr-sheet').getBoundingClientRect();
    const mm = v => +(v * 25.4 / 96).toFixed(1);
    const sv = document.querySelector('#qrPrintArea .qr-cell svg').getBoundingClientRect();
    const over = Array.from(document.querySelectorAll('#qrPrintArea .qr-cell')).filter(el => el.scrollWidth > el.clientWidth + 1).length;
    return { shown, cellW: mm(c.width), cellH: mm(c.height), sheetW: mm(s.width), sheetH: mm(s.height), qr: mm(sv.width), over };
  });
  console.log('   列印時：格子', vis.cellW, '×', vis.cellH, 'mm，整張', vis.sheetW, '×', vis.sheetH, 'mm，QR', vis.qr, 'mm');
  ck('列印時畫面上只剩標籤', vis.shown.join(',') === 'qrPrintArea', vis.shown);
  ck('每格 105 × 59.4 mm', Math.abs(vis.cellW - 105) < 0.3 && Math.abs(vis.cellH - 59.4) < 0.3, vis);
  ck('整張寬 210 mm、高不超過 297 mm', Math.abs(vis.sheetW - 210) < 0.3 && vis.sheetH <= 297 && vis.sheetH > 296, vis);
  ck('儲位名稱沒有超出格子', vis.over === 0, vis.over);
  const wrapped = await pg.evaluate(() => Array.from(document.querySelectorAll('#qrPrintArea .qr-name')).filter(el => {
    const fs = parseFloat(getComputedStyle(el).fontSize);
    return el.getBoundingClientRect().height > fs * 1.6;      // 超過一行半就是被折行了
  }).map(el => el.textContent));
  ck('常見的儲位名稱都在一行內（沒有被折成兩行）', wrapped.length === 0, wrapped);

  // 真的解碼：把第 2 張轉成圖，逐格解 QR
  const mods = process.env.QR_DECODE_MODULES;
  if(mods){
    const jsQR = require(path.join(mods, 'jsqr')); const { PNG } = require(path.join(mods, 'pngjs'));
    await pg.setViewportSize({ width: 794, height: 1123 });
    const sheet = pg.locator('#qrPrintArea .qr-sheet').nth(1);
    const cells = sheet.locator('.qr-cell');
    const decoded = [];
    for(let i = 0; i < 3; i++){
      const png = PNG.sync.read(await cells.nth(i).screenshot({ scale: 'css' }));
      const q = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
      decoded.push(q ? q.data : null);
    }
    console.log('   實際解碼：', JSON.stringify(decoded));
    const back = await pg.evaluate(d => d.map(x => x ? locQrDecode(x) : null), decoded);
    ck('印出來的 QR 真的掃得到，而且解回正確的儲位', back.join(',') === '門口棧板,C06-2上,ZZ99-9', back);
    if(outDir) fs.writeFileSync(path.join(outDir, '儲位QR標籤_預覽.png'), await pg.locator('#qrPrintArea .qr-sheet').nth(1).screenshot());
  }else{
    console.log('   （未設 QR_DECODE_MODULES，略過實際解碼）');
  }

  // 產 PDF 放最後：它會觸發 afterprint，也就是下面要驗的「印完收乾淨」
  const pdf = await pg.pdf({ preferCSSPageSize: true, printBackground: true });
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  ck('PDF 剛好 2 頁（沒有多出空白頁）', pages === 2, pages);
  if(outDir){ fs.mkdirSync(outDir, {recursive:true}); fs.writeFileSync(path.join(outDir, '儲位QR標籤_範例.pdf'), pdf); }

  await pg.emulateMedia({ media: 'screen' });
  r = await pg.evaluate(() => ({ cls: document.body.classList.contains('printing-qr'), st: !!document.getElementById('qrPageStyle'),
    html: document.getElementById('qrPrintArea').innerHTML.length }));
  ck('印完之後紙張設定與版面都收乾淨', !r.cls && !r.st && r.html === 0, r);
  await pg.click('#qrClose');

  console.log('\n【掃儲位標籤】清單有商品 → 帶入新儲位');
  await pg.evaluate(() => {
    locBatch.push({uid: ++locSeq, code:'S1', ok:true, sku:'S1', baseName:'測試', spec:'', location:'A01-1', locations:['A01-1'], note:'', updated:'', isNew:false, stockWs:''});
    renderLocBatch();
  });
  await pg.evaluate(() => locScan('LOC:C06-2%E4%B8%8A'));
  r = await pg.evaluate(() => ({ target: locTargetValue(), n: locBatch.length, zone: document.getElementById('locZoneSelect').value }));
  ck('新儲位變成 C06-2上', r.target === 'C06-2上', r);
  ck('標籤沒有被當成商品加進清單', r.n === 1, r);
  await pg.evaluate(() => locScan('loc:k09-1'));
  r = await pg.evaluate(() => locTargetValue());
  ck('掃 K09-1 會沿用地圖上的 K9-1', r === 'K9-1', r);

  console.log('\n【掃儲位標籤】清單是空的 → 打開貨架查詢');
  await pg.evaluate(() => { locBatch = []; renderLocBatch(); window.__calls = []; });
  await pg.evaluate(() => locScan('LOC:A04-3'));
  await pg.waitForFunction(() => window.__calls.some(c => c.action === 'listLocationContents'));
  r = await pg.evaluate(() => window.__calls.find(c => c.action === 'listLocationContents').payload);
  ck('貨架查詢視窗打開', await pg.isVisible('#shelfMask'));
  ck('查的是 A 區第 4 格第 3 層', r.zone === 'A' && String(r.slot) === '4' && String(r.level) === '3', r);
  await pg.click('#qClose');
  await pg.evaluate(() => { window.__calls = []; });
  await pg.evaluate(() => locScan('LOC:ZZ99-9'));
  ck('地圖上沒有的位置不會亂開查詢', !(await pg.isVisible('#shelfMask')) && !(await pg.evaluate(() => window.__calls.some(c => c.action === 'listLocationContents'))));

  ck('全程沒有 JS 錯誤', errs.length === 0, errs);
  await b.close(); srv.close();
  console.log(fail ? '\n有 '+fail+' 項失敗' : '\n介面全部通過');
  process.exit(fail?1:0);
})();
