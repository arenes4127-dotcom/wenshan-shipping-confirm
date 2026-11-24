// 操作人員確認：只在開始新工作時問、閒置 15 分鐘或今天第一次才問、掃到一半不問、
// 掃描槍的 Enter 不能幫人按「是我」、五個人員選單是同一個人。
//
// 用法：node tests/operator_ui.js
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs'), http = require('http');
const _root = path.resolve('.');
const _srv = http.createServer((q, r) => {
  const f = path.join(_root, decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  fs.readFile(f, (e, d) => { if(e){ r.writeHead(404); r.end(); return; }
    r.writeHead(200, {'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8'}); r.end(d); });
}).listen(0);
(async () => {
  const b = await chromium.launch();
  const _PROD = /script\.google\.com|script\.googleusercontent\.com|docs\.google\.com/;
  const errs = [];
  let fail = 0;
  const ck = (id, cond, extra) => { if(!cond){ console.log('  FAIL', id, extra===undefined?'':JSON.stringify(extra)); fail++; } else console.log('  ok  ', id); };

  const ctx = await b.newContext();
  await ctx.route(_PROD, r => r.abort());
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push(String(e)));
  pg.on('dialog', d => d.accept());
  await pg.addInitScript(() => {
    localStorage.setItem('ssz_settings', JSON.stringify({backendUrl:'https://example.invalid/exec', store:'odm_shilin'}));
    localStorage.setItem('ssz_current_staff', 'S06');
  });
  await pg.goto('http://127.0.0.1:' + _srv.address().port + '/index.html');
  await pg.evaluate(() => {
    const mk = (no) => ({orderNo: no, date:'2026/11/24', store:'蝦皮', status:'pending',
      items:[{sku:'A1', name:'水壺', baseName:'水壺', spec:'', qty:2}]});
    window.__orders = { O1: mk('O1'), O2: mk('O2'), P1: mk('P1') };
    window.rawApiGet = async () => ({ok:true, orders: JSON.parse(JSON.stringify(window.__orders)),
      staff:[{id:'S05', name:'蔡'}, {id:'S06', name:'郭'}, {id:'S07', name:'陳'}], version:'2026-11-20.219'});
    window.rawApiPost = async () => ({ok:true});
  });
  await pg.evaluate(() => refreshFromBackend(true));
  await pg.evaluate(() => { staff = [{id:'S05', name:'蔡'}, {id:'S06', name:'郭'}, {id:'S07', name:'陳'}];
    setCurrentStaff('S06'); localStorage.removeItem('ssz_op_confirm'); opIdleFlag = false; gotoView('scan'); });
  const shown = () => pg.evaluate(() => document.getElementById('opMask').classList.contains('show'));

  console.log('\n【今天第一次】掃新訂單 → 先確認，確認完自動接著開這張');
  await pg.evaluate(() => scanOrder('O1'));
  ck('跳出確認框', await shown());
  ck('訂單還沒開（等確認）', await pg.evaluate(() => !current));
  let r = await pg.evaluate(() => ({who: document.getElementById('opWho').textContent, why: document.getElementById('opWhy').textContent}));
  ck('問的是目前的人、說明是今天第一次', r.who === '郭' && r.why.indexOf('今天第一次') >= 0, r);
  ck('其他人排在下面可以直接點', await pg.evaluate(() => document.querySelectorAll('#opGrid button').length === 2));

  console.log('\n【掃描槍的 Enter】不能幫人按下「是我」');
  await pg.keyboard.press('Enter');
  await pg.keyboard.type('4710000000000');
  await pg.keyboard.press('Enter');
  ck('框還在', await shown());
  ck('掃到的字沒有打進後面的輸入框', await pg.evaluate(() => document.getElementById('inputOrder').value === '' && document.getElementById('inputBarcode').value === ''));

  await pg.click('#opYes');
  await pg.waitForFunction(() => current && current.orderNo === 'O1', null, {timeout: 3000});
  ck('按「是我」→ 框關掉、O1 自動開好', !(await shown()));
  r = await pg.evaluate(() => JSON.parse(localStorage.getItem('ssz_op_confirm')));
  ck('記下今天確認的是 S06', r && r.staffId === 'S06', r);

  console.log('\n【掃到一半】商品掃描不問');
  await pg.evaluate(() => { opIdleFlag = true; });          // 就算剛好閒置過
  await pg.evaluate(() => scanShipmentBarcode('A1'));
  ck('掃商品沒有跳框', !(await shown()));
  ck('件數有算', await pg.evaluate(() => current.items[0].scanned === 1));
  await pg.evaluate(() => { opIdleFlag = false; });

  console.log('\n【剛確認過、也沒閒置】開下一張不問');
  await pg.evaluate(() => { current = null; });
  await pg.evaluate(() => scanOrder('O2'));
  ck('沒有跳框', !(await shown()));

  console.log('\n【閒置 14 分鐘】不問；【閒置 16 分鐘】問');
  await pg.evaluate(() => { current = null; opLastActivity = Date.now() - 14*60000; });
  await pg.mouse.click(5, 5);
  await pg.evaluate(() => scanPickOrder('P1'));
  ck('14 分鐘：沒有跳框', !(await shown()));
  await pg.evaluate(() => { opLastActivity = Date.now() - 16*60000; });
  await pg.mouse.click(5, 5);
  await pg.evaluate(() => { window.__retry = []; transferScan('T9'); });
  ck('16 分鐘後第一次開始新工作（調撥掃描）：跳框', await shown());
  r = await pg.evaluate(() => document.getElementById('opWhy').textContent);
  ck('說明寫幾分鐘沒操作', /16 分鐘沒有操作/.test(r), r);

  console.log('\n【不是本人】點自己的名字 → 五個選單一起換、接著做剛剛那一下');
  await pg.evaluate(() => { const real = window.transferScan; window.transferScan = function(c){ window.__retry.push(c); }; window.__realTransferScan = real; });
  await pg.click('#opGrid button[data-op-id="S05"]');
  await pg.waitForTimeout(50);
  r = await pg.evaluate(() => ({
    cur: currentStaffId, retry: window.__retry.slice(),
    sels: STAFF_SELECT_IDS.map(id => document.getElementById(id).value),
    header: document.getElementById('headerStaffName').textContent }));
  ck('目前操作人員換成 S05', r.cur === 'S05', r);
  ck('五個選單都是 S05', r.sels.every(v => v === 'S05'), r.sels);
  ck('頁首顯示新名字', r.header === '蔡', r.header);
  ck('剛剛那一下掃描接著做（T9）', r.retry.length === 1 && r.retry[0] === 'T9', r.retry);
  await pg.evaluate(() => { window.transferScan = window.__realTransferScan; });
  r = await pg.evaluate(() => JSON.parse(localStorage.getItem('ssz_recent_staff')));
  ck('最近用過的人排最前面', r[0] === 'S05' && r.indexOf('S06') === 1, r);

  console.log('\n【自己從選單換人】算本人確認過');
  await pg.evaluate(() => { localStorage.removeItem('ssz_op_confirm'); });
  await pg.evaluate(() => gotoView('pick'));
  await pg.selectOption('#pickStaffSelect', 'S07');
  r = await pg.evaluate(() => ({cur: currentStaffId, sels: STAFF_SELECT_IDS.map(id => document.getElementById(id).value)}));
  ck('換成 S07、五個選單一起換', r.cur === 'S07' && r.sels.every(v => v === 'S07'), r);
  await pg.evaluate(() => { pickCurrentOrder = ''; window.confirmLeaveOrder = async () => true; });
  await pg.evaluate(() => scanPickOrder('P1'));
  ck('接著揀新訂單不跳框', !(await shown()));

  console.log('\n【隔天】昨天確認過的不算');
  await pg.evaluate(() => { localStorage.setItem('ssz_op_confirm', JSON.stringify({date:'2000-01-01', staffId: currentStaffId})); });
  await pg.evaluate(() => startNewBatch());
  ck('開新批次前跳框', await shown());
  await pg.click('#opYes');
  ck('按「是我」關掉', !(await shown()));

  console.log('\n【重新整理頁面】閒置時間要記在本機，不能一重整就歸零');
  await pg.evaluate(() => { localStorage.setItem('ssz_last_activity', String(Date.now() - 20*60000)); });
  await pg.reload();
  await pg.evaluate(() => { staff = [{id:'S05', name:'蔡'}, {id:'S06', name:'郭'}, {id:'S07', name:'陳'}]; renderStaffSelects(); });
  await pg.mouse.click(5, 5);
  await pg.evaluate(() => startCount());
  ck('重整後第一次開始新工作：還是會問', await shown());

  ck('沒有頁面錯誤', errs.length === 0, errs);
  console.log(fail ? '\n有 ' + fail + ' 項失敗' : '\n介面全部通過');
  await b.close(); _srv.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
