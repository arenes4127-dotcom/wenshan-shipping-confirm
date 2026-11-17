// 查詢售價的離線測試台
//
// 用法：cp Code.gs /tmp/CodeRun.js && node tests/price_harness.js /tmp/CodeRun.js
//
// 最重要的一項：來源表被重新匯出、列整個位移之後，拿著舊列號去讀，
// 絕對不能把「別的商品的價格」顯示成這個商品的。那種錯畫面上完全看不出來。
const fs = require('fs'), vm = require('vm');

let RPC = 0;
function makeSheet(name, rows){
  const sh = {
    _name:name, _rows: rows.map(r=>r.slice()),
    getName(){ return this._name; },
    getLastRow(){ let last=0; this._rows.forEach((r,i)=>{ if(r.some(v=>String(v==null?'':v)!=='')) last=i+1; }); return last; },
    getLastColumn(){ return Math.max.apply(null, this._rows.map(r=>r.length).concat([1])); },
    getRange(r,c,nr,nc){
      nr=nr==null?1:nr; nc=nc==null?1:nc;
      return {
        getValues(){ RPC++; sh._log.push({r,c,nr,nc});
          const o=[]; for(let i=0;i<nr;i++){ const row=sh._rows[r-1+i]||[]; const t=[];
          for(let j=0;j<nc;j++) t.push(row[c-1+j]===undefined?'':row[c-1+j]); o.push(t);} return o; },
        getValue(){ return this.getValues()[0][0]; },
        setValues(){ return this; }, setNumberFormat(){ return this; },
      };
    },
    _log: [],
  };
  return sh;
}
const CACHE = {};
const scriptCache = {
  get: k => (CACHE[k]===undefined?null:CACHE[k]), put:(k,v)=>{CACHE[k]=v;}, remove:k=>{delete CACHE[k];},
  removeAll: ks=>ks.forEach(k=>delete CACHE[k]),
  getAll: ks=>{ const o={}; ks.forEach(k=>{ if(CACHE[k]!==undefined) o[k]=CACHE[k]; }); return o; },
  putAll: o=>Object.keys(o).forEach(k=>{CACHE[k]=o[k];}),
};
const BOOKS = {};
const sandbox = {
  console, Logger:{ log(){} },
  Session:{ getEffectiveUser: () => ({ getEmail: () => 't@e.com' }) },
  Utilities:{ formatDate: () => '2026/11/17 09:00', sleep(){} },
  CacheService:{ getScriptCache: () => scriptCache },
  LockService:{ getScriptLock: () => ({ tryLock:()=>true, releaseLock(){} }) },
  ScriptApp:{ getProjectTriggers:()=>[], WeekDay:{MONDAY:1}, TriggerSource:{CLOCK:'CLOCK'} },
  ContentService:{ createTextOutput: t=>({ setMimeType: ()=>t }), MimeType:{JSON:'json'} },
  HtmlService:{}, MimeType:{},
  DriveApp:{ getFileById: () => ({ getLastUpdated: () => new Date() }) },
  SpreadsheetApp:{
    getActiveSpreadsheet: () => ({ getSpreadsheetTimeZone: () => 'Asia/Taipei', getSheetByName: () => null }),
    openById: id => BOOKS[id], flush(){},
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const src = fs.readFileSync(process.argv[2],'utf8')
  + "\n;globalThis.__x = {getShopeePriceInfo_, warmPriceCaches_, readRowsClustered_, specSkuIndexCacheClear_,"
  + " SPEC_IMAGE_SOURCE_ID, SPEC_IMAGE_TAB, LOCMAP_SOURCE_ID, LOC_SYNC_TAB, diagnosePriceQuery, ROW_CLUSTER_GAP};\n";
vm.runInContext(src, sandbox, { filename:'Code.gs' });
const X = sandbox.__x;

let fail = 0;
const ck = (id, cond, extra) => { if(!cond){ console.log('  FAIL', id, extra===undefined?'':JSON.stringify(extra)); fail++; } else console.log('  ok  ', id); };

// ---------- 來源表：貨號對應選項 ----------
const HEAD = ['賣場ID','賣場名稱','商品ID','商品名稱','商品選項ID','商品規格名稱','選項序號','選項名稱','選項圖片','第二階規格','商品選項貨號','價格','對應方式'];
function specRow(shopId, shop, itemId, item, spec, sku, price){
  return [shopId, shop, itemId, item, 'm'+itemId, spec, 1, spec, '', '', sku, price, ''];
}
function buildSpec(prefixRows){
  const rows = [HEAD.slice()];
  for(let i = 0; i < (prefixRows||0); i++) rows.push(specRow('S0','墊檔賣場','X'+i,'墊檔商品'+i,'', 'PAD'+i, 1));
  // 賣場 A 區
  rows.push(specRow('S1','秀山莊','I100','冰絲魔術頭巾','深林之木','SKU-A', 299));
  rows.push(specRow('S1','秀山莊','I100','冰絲魔術頭巾','曜石黑','SKU-B', 299));
  rows.push(specRow('S1','秀山莊','I200','大寬嘴水壺','灰藍','SKU-C', 890));
  for(let i = 0; i < 400; i++) rows.push(specRow('S1','秀山莊','F'+i,'填充'+i,'', 'FILL'+i, 10+i));
  // 賣場 B 區（同一批貨也掛在這裡賣，價格不同）
  rows.push(specRow('S2','ODM','I900','冰絲魔術頭巾 ODM','深林之木','SKU-A', 279));
  rows.push(specRow('S2','ODM','I901','別的東西','','SKU-Z', 55));
  return rows;
}
let specSheet = makeSheet(X.SPEC_IMAGE_TAB, buildSpec(0));
BOOKS[X.SPEC_IMAGE_SOURCE_ID] = { getSheetByName: n => (n === X.SPEC_IMAGE_TAB ? specSheet : null), getSheets: () => [specSheet] };

// ---------- ERP：山物地圖(快取)，資料從第 3 列開始，M 定價 N 特惠價 ----------
const erpRows = [new Array(14).fill('h'), new Array(14).fill('')];
function erp(sku, list, special){ const r = new Array(14).fill(''); r[0]=sku; r[12]=list; r[13]=special; erpRows.push(r); }
erp('SKU-A', 350, 299); erp('SKU-B', 350, ''); erp('SKU-C', 990, 890); erp('SKU-ERPONLY', 120, 99);
const erpSheet = makeSheet(X.LOC_SYNC_TAB, erpRows);
BOOKS[X.LOCMAP_SOURCE_ID] = { getSheetByName: n => (n === X.LOC_SYNC_TAB ? erpSheet : null), getSheets: () => [erpSheet] };

const clearCache = () => Object.keys(CACHE).forEach(k => delete CACHE[k]);
const brief = r => r.ok ? r.matches.map(m => m.shopName + ':' + m.price + ':' + m.specName).join('|') + (r.erp ? '｜ERP ' + r.erp.listPrice + '/' + r.erp.specialPrice : '')
                        : 'NOTFOUND' + (r.erp ? '｜ERP ' + r.erp.listPrice + '/' + r.erp.specialPrice : '');

console.log('【基本】查得到、跨賣場都列出來、ERP 有附');
clearCache();
let res = X.getShopeePriceInfo_({skus:['SKU-A']});
console.log('   SKU-A →', brief(res.results['SKU-A']));
ck('查詢成功', res.ok === true);
ck('兩個賣場都列出來', res.results['SKU-A'].matches.length === 2, res.results['SKU-A']);
ck('各賣場價格是對的', brief(res.results['SKU-A']).indexOf('秀山莊:299:深林之木|ODM:279:深林之木') === 0, brief(res.results['SKU-A']));
ck('附上 ERP 定價與特惠價', res.results['SKU-A'].erp && res.results['SKU-A'].erp.listPrice === '350' && res.results['SKU-A'].erp.specialPrice === '299', res.results['SKU-A'].erp);
ck('有資料更新時間', !!res.updatedAt);

clearCache();
res = X.getShopeePriceInfo_({skus:['NOPE', 'SKU-ERPONLY']});
ck('查不到的回 not_found', res.results['NOPE'].ok === false && res.results['NOPE'].reason === 'not_found', res.results['NOPE']);
ck('沒上架但 ERP 有定價的，ERP 價格照樣附上', res.results['SKU-ERPONLY'].ok === false && res.results['SKU-ERPONLY'].erp.listPrice === '120', res.results['SKU-ERPONLY']);

console.log('\n【往返次數】預熱之後，查一個貨號不該再整欄掃、也不該一列一趟');
clearCache();
const w = X.warmPriceCaches_();
ck('預熱成功', w.ok === true && w.貨號數 > 400, w);
RPC = 0; specSheet._log.length = 0; erpSheet._log.length = 0;
res = X.getShopeePriceInfo_({skus:['SKU-A']});
console.log('   預熱後查 SKU-A：來源表', specSheet._log.length, '趟、ERP', erpSheet._log.length, '趟');
ck('來源表只讀 2 趟（兩個賣場相隔 400 列，各一段）', specSheet._log.length === 2, specSheet._log);
ck('沒有整欄掃描', specSheet._log.every(l => l.nr < 50), specSheet._log);
ck('沒有再去讀表頭', specSheet._log.every(l => l.r !== 1), specSheet._log);

RPC = 0; specSheet._log.length = 0; erpSheet._log.length = 0;
res = X.getShopeePriceInfo_({skus:['SKU-A']});
ck('5 分鐘內再查同一個：完全不碰試算表', RPC === 0, RPC);
ck('而且內容一樣', brief(res.results['SKU-A']).indexOf('秀山莊:299') === 0, brief(res.results['SKU-A']));

console.log('\n【一次查多個】相鄰的列要併成一趟');
clearCache(); X.warmPriceCaches_();
specSheet._log.length = 0; erpSheet._log.length = 0;
res = X.getShopeePriceInfo_({skus:['SKU-B', 'SKU-C', 'FILL3']});
console.log('   三個貨號：來源表', specSheet._log.length, '趟、ERP', erpSheet._log.filter(l=>l.nc===14).length, '趟');
ck('三個相鄰貨號只讀 1 趟', specSheet._log.length === 1, specSheet._log);
ck('ERP 兩個貨號只讀 1 趟', erpSheet._log.filter(l => l.nc === 14).length === 1, erpSheet._log);
ck('三個都查對', res.results['SKU-B'].matches[0].price === '299' && res.results['SKU-C'].matches[0].price === '890'
   && res.results['FILL3'].matches[0].price === '13', [brief(res.results['SKU-B']), brief(res.results['SKU-C']), brief(res.results['FILL3'])]);

console.log('\n【列號過期】來源表重新匯出、整個往下位移 7 列——不能顯示別人的價格');
clearCache(); X.warmPriceCaches_();                       // 索引是照舊表建的
specSheet = makeSheet(X.SPEC_IMAGE_TAB, buildSpec(7));    // 表換了，索引還是舊的
res = X.getShopeePriceInfo_({skus:['SKU-A', 'SKU-C']});
console.log('   位移後 SKU-A →', brief(res.results['SKU-A']));
console.log('   位移後 SKU-C →', brief(res.results['SKU-C']));
ck('SKU-A 價格仍然正確（自己發現對不上、重建後再查）', brief(res.results['SKU-A']).indexOf('秀山莊:299:深林之木|ODM:279:深林之木') === 0, brief(res.results['SKU-A']));
ck('SKU-C 價格仍然正確', res.results['SKU-C'].ok && res.results['SKU-C'].matches[0].price === '890', res.results['SKU-C']);
ck('沒有混進任何別的商品', res.results['SKU-A'].matches.every(m => m.itemName.indexOf('頭巾') >= 0), res.results['SKU-A'].matches);

console.log('\n【表頭被調換】價格欄搬家了，快取的表頭還是舊的');
clearCache(); X.warmPriceCaches_();
// 價格 ↔ 對應方式 對調，而且對應方式那欄有文字。貨號欄沒動，所以「貨號核對」會過。
const moved = buildSpec(0).map((r, i) => { const c = r.slice(); if(i > 0) c[12] = 'auto'; const t = c[11]; c[11] = c[12]; c[12] = t; return c; });
specSheet = makeSheet(X.SPEC_IMAGE_TAB, moved);
res = X.getShopeePriceInfo_({skus:['SKU-C']});
console.log('   欄位對調後 SKU-C →', brief(res.results['SKU-C']));
ck('沒有把「auto」當成價格顯示', res.results['SKU-C'].matches.every(m => m.price !== 'auto'), res.results['SKU-C']);
ck('自己重讀表頭後查到正確價格', res.results['SKU-C'].ok && res.results['SKU-C'].matches[0].price === '890', res.results['SKU-C']);

console.log('\n【分段讀的邊界】');
const big = makeSheet('big', Array.from({length: 1000}, (_, i) => ['r' + (i+1)]));
big._log.length = 0;
let got = X.readRowsClustered_(big, [5, 6, 100, 900], 1, 1);
ck('5、6、100 併一段，900 另一段（共 2 趟）', big._log.length === 2, big._log);
ck('只回傳要的那幾列', Object.keys(got).sort().join(',') === '100,5,6,900', Object.keys(got));
ck('內容對得上列號', got[5][0] === 'r5' && got[900][0] === 'r900', got);
ck('空清單不打任何一趟', (big._log.length = 0, X.readRowsClustered_(big, [], 1, 1), big._log.length === 0));
ck('重複的列號只算一次', Object.keys(X.readRowsClustered_(big, [7,7,7], 1, 1)).length === 1);

console.log('\n【診斷】跑得完、三次結果一致');
specSheet = makeSheet(X.SPEC_IMAGE_TAB, buildSpec(0));
clearCache();
const txt = X.diagnosePriceQuery('SKU-A');
ck('診斷跑得完', txt.indexOf('查詢售價效能診斷') === 0, txt);
ck('三次結果一致', txt.indexOf('一樣，OK') >= 0, txt);

console.log(fail ? '\n有 '+fail+' 項失敗' : '\n全部通過：價格正確、跨賣場齊全、往返次數降下來、列號過期會自我修復、不顯示別人的價格');
process.exit(fail?1:0);
