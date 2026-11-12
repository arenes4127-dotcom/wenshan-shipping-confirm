// 真的開頁面、真的點按鈕，把後端換成假的。
// 介面的 bug（勾選狀態沒存、全選沒反應、重複品號沒擋掉）只有這樣才驗得出來。
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const b = await chromium.launch();
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push(String(e)));
  // 假後端網址當然連不上，那不是 JS 錯誤；真正要抓的是 pageerror 跟程式自己丟的錯
  pg.on('console', m => {
    if(m.type() !== 'error') return;
    const t = m.text();
    if(/Failed to load resource|net::ERR_/.test(t)) return;
    errs.push('console: ' + t);
  });

  await pg.addInitScript(() => {
    localStorage.setItem('wsc_settings', JSON.stringify({
      backendUrl: 'https://example.invalid/exec', store: 'odm_shilin', staff: '測試員' }));
  });
  await pg.goto('file://' + path.resolve('index.html'));

  // 攔掉所有對後端的呼叫，自己回答
  await pg.evaluate(() => {
    window.__sent = [];
    window.rawApiPost = async (action, payload) => {
      if(action === 'searchLocations') window.__sent.push({action, payload});
      if(action !== 'searchLocations') return {ok:true};
      const q = payload.q;
      if(q === '2076262A36*') return {ok:true, q, '符合幾筆':3, '回傳幾筆':3,
        '有沒有被截斷':false, items:[
          {sku:'2076262A3601A03', baseName:'冰絲魔術頭巾 深林之木', location:'C05-4'},
          {sku:'2076262A3601A04', baseName:'冰絲魔術頭巾 曜石黑',   location:'C05-4'},
          {sku:'2076262A3602B01', baseName:'冰絲魔術頭巾 淺灰',     location:'C06-2上'}]};
      if(q === 'FILL*') return {ok:true, q, '符合幾筆':120, '回傳幾筆':2,
        '有沒有被截斷':true, items:[
          {sku:'FILL0000', baseName:'填充商品0', location:'F01-1'},
          {sku:'FILL0001', baseName:'填充商品1', location:'F01-1'}]};
      return {ok:true, q, '符合幾筆':0, '回傳幾筆':0, '有沒有被截斷':false, items:[]};
    };
  });

  let fail = 0;
  const ck = (id, cond, extra) => { if(!cond){ console.log('  FAIL', id, extra===undefined?'':JSON.stringify(extra)); fail++; } else console.log('  ok  ', id); };

  await pg.evaluate(() => gotoView('loc'));
  ck('儲位頁有搜尋按鈕', await pg.isVisible('#btnLocSearch'));

  await pg.click('#btnLocSearch');
  ck('視窗打開了', await pg.isVisible('#findMask'));
  ck('一開始有提示文字', (await pg.textContent('#findList')).includes('按「搜尋」'));

  // 字太少
  await pg.fill('#findInput', 'A');
  await pg.click('#findGo');
  ck('一個字被擋下來', (await pg.textContent('#findList')).includes('至少輸入 2 個字'));
  ck('而且沒有打擾後端', (await pg.evaluate(() => window.__sent.length)) === 0);

  // 正常搜尋，用 Enter 送
  await pg.fill('#findInput', '2076262A36*');
  await pg.press('#findInput', 'Enter');
  await pg.waitForFunction(() => document.querySelectorAll('#findList input[type=checkbox]').length > 0);
  ck('Enter 可以搜尋', (await pg.evaluate(() => window.__sent.length)) === 1);
  ck('出現 3 筆', (await pg.locator('#findList input[type=checkbox]').count()) === 3);
  ck('回報符合 3 筆', (await pg.textContent('#findStat')).includes('符合 3 筆'));
  ck('有顯示品名', (await pg.textContent('#findList')).includes('冰絲魔術頭巾 深林之木'));
  ck('有顯示現在的位置', (await pg.textContent('#findList')).includes('C05-4'));
  ck('預設一個都沒勾',
     (await pg.locator('#findList input[type=checkbox]:checked').count()) === 0);

  // 全形＊也要收
  await pg.fill('#findInput', '2076262A36＊');
  await pg.click('#findGo');
  await pg.waitForTimeout(150);
  ck('全形＊被轉成半形送出',
     (await pg.evaluate(() => window.__sent[window.__sent.length-1].payload.q)) === '2076262A36*');

  // 沒勾就按加入
  await pg.click('#findOk');
  ck('沒勾選時不會加進清單', (await pg.evaluate(() => locBatch.length)) === 0);

  // 勾兩筆加入
  await pg.click('#btnLocSearch');
  await pg.fill('#findInput', '2076262A36*');
  await pg.click('#findGo');
  await pg.waitForFunction(() => document.querySelectorAll('#findList input[type=checkbox]').length === 3);
  await pg.locator('#findList input[type=checkbox]').nth(0).check();
  await pg.locator('#findList input[type=checkbox]').nth(2).check();
  await pg.click('#findOk');
  const batch = await pg.evaluate(() => locBatch.map(x => ({sku:x.sku, ok:x.ok, loc:x.location, name:x.baseName})));
  console.log('   清單：', JSON.stringify(batch));
  ck('加入 2 筆', batch.length === 2, batch);
  ck('加對了品號', batch[0].sku === '2076262A3601A03' && batch[1].sku === '2076262A3602B01', batch);
  ck('帶了品名進來', batch[0].name.includes('頭巾'), batch);
  ck('帶了原本的儲位', batch[0].loc === 'C05-4', batch);
  ck('標記成可送出', batch.every(x => x.ok === true), batch);
  ck('待處理數字有更新', (await pg.textContent('#locBatchCount')).includes('2 件'));

  // 已在清單裡的要被濾掉
  await pg.click('#btnLocSearch');
  await pg.fill('#findInput', '2076262A36*');
  await pg.click('#findGo');
  await pg.waitForFunction(() => document.querySelectorAll('#findList input[type=checkbox]').length > 0);
  ck('重複的被濾掉，只剩 1 筆',
     (await pg.locator('#findList input[type=checkbox]').count()) === 1);
  ck('而且說清楚有 2 筆已經在清單裡', (await pg.textContent('#findStat')).includes('2 筆已經在清單裡'));

  // 全選／全不選
  await pg.click('#findAll');
  ck('全選有效', (await pg.locator('#findList input[type=checkbox]:checked').count()) === 1);
  await pg.click('#findNone');
  ck('全不選有效', (await pg.locator('#findList input[type=checkbox]:checked').count()) === 0);

  // 截斷要講
  await pg.fill('#findInput', 'FILL*');
  await pg.click('#findGo');
  await pg.waitForFunction(() => document.getElementById('findStat').textContent.includes('120'));
  const st = await pg.textContent('#findStat');
  console.log('   截斷提示：', st);
  ck('誠實說出倉庫裡有 120 筆', st.includes('符合 120 筆'));
  ck('並且說只顯示前 2 筆', st.includes('只顯示前 2 筆'));
  ck('有提醒把條件縮小', st.includes('縮小'));

  // 查無資料
  await pg.fill('#findInput', 'ZZZZ');
  await pg.click('#findGo');
  await pg.waitForFunction(() => document.getElementById('findList').textContent.includes('找不到'));
  ck('查無資料有建議加 ＊', (await pg.textContent('#findList')).includes('前後加'));

  // 點背景關閉
  await pg.click('#findMask', {position:{x:5,y:5}});
  ck('點背景關得掉', !(await pg.isVisible('#findMask')));
  ck('關掉不會動到清單', (await pg.evaluate(() => locBatch.length)) === 2);

  ck('全程沒有 JS 錯誤', errs.length === 0, errs);
  await b.close();
  console.log(fail ? '\n有 '+fail+' 項失敗' : '\n介面全部通過');
  process.exit(fail?1:0);
})();
