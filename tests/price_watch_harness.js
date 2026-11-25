// 價格異動紀錄的離線測試台
//
// 用法：cp Code.gs /tmp/CodeRun.js && node tests/price_watch_harness.js /tmp/CodeRun.js
//
// 真的執行 Code.gs 的 checkPriceChanges_，來源分頁、後端分頁都是假的。
// 要驗的是：第一次只建基準不亂記、真的改價才記、來源沒載入完不能記一大片假異動、
// 新貨號不算異動、來源一格都不寫。
const fs = require('fs'), vm = require('vm');

function makeSheet(name, rows){
  const sh = {
    _name:name, _rows: rows.map(r=>r.slice()), _hidden:false, _writes:0,
    getName(){ return this._name; },
    getLastRow(){ let last=0; this._rows.forEach((r,i)=>{ if(r.some(v=>String(v==null?'':v)!=='')) last=i+1; }); return last; },
    getLastColumn(){ return Math.max.apply(null, this._rows.map(r=>r.length).concat([1])); },
    getRange(r,c,nr,nc){
      nr=nr==null?1:nr; nc=nc==null?1:nc;
      const api = {
        getValues(){ const o=[]; for(let i=0;i<nr;i++){ const row=sh._rows[r-1+i]||[]; const t=[];
          for(let j=0;j<nc;j++) t.push(row[c-1+j]===undefined?'':row[c-1+j]); o.push(t);} return o; },
        setValues(v){ sh._writes++;
          for(let i=0;i<v.length;i++){ while(sh._rows.length < r+i) sh._rows.push([]);
            const row = sh._rows[r-1+i]; for(let j=0;j<v[i].length;j++) row[c-1+j]=v[i][j]; } return api; },
        clearContent(){ sh._writes++; for(let i=0;i<nr;i++){ const row=sh._rows[r-1+i]; if(row) for(let j=0;j<nc;j++) row[c-1+j]=''; } return api; },
        setNumberFormat(){ return api; }, setNote(){ return api; },
      };
      return api;
    },
    appendRow(v){ this._rows.push(v.slice()); },
    deleteRow(r){ this._writes++; this._rows.splice(r - 1, 1); },
    isSheetHidden(){ return this._hidden; }, hideSheet(){ this._hidden = true; },
  };
  return sh;
}

const PROPS = {};
const DAY = {d: '2026/11/24'};
const SHEETS = {};
const BACKEND = {
  getSheetByName: n => SHEETS[n] || null, getSheets: () => Object.values(SHEETS),
  insertSheet: n => (SHEETS[n] = makeSheet(n, [])),
  getSpreadsheetTimeZone: () => 'Asia/Taipei',
};
let SRC;   // 「山物地圖(快取)」
const SOURCE = { getSheetByName: n => (n === '山物地圖(快取)' ? SRC : null), getSheets: () => [SRC] };
const sandbox = {
  console, Logger:{ log(){} },
  Utilities:{ formatDate: (d, tz, fmt) => (fmt === 'yyyy/MM/dd' ? DAY.d : DAY.d + ' 10:00:00'), sleep(){} },
  CacheService:{ getScriptCache: () => ({ get:()=>null, put(){}, remove(){}, getAll:()=>({}), putAll(){} }) },
  PropertiesService:{ getScriptProperties: () => ({
    getProperty: k => (PROPS[k] === undefined ? null : PROPS[k]), setProperty: (k,v) => { PROPS[k] = String(v); } }) },
  LockService:{ getScriptLock: () => ({ tryLock: () => true, releaseLock(){} }) },
  ScriptApp:{}, UrlFetchApp:{}, ContentService:{}, HtmlService:{}, MimeType:{}, DriveApp:{},
  Session:{ getEffectiveUser: () => ({ getEmail: () => 't@e.com' }) },
  SpreadsheetApp:{ getActiveSpreadsheet: () => BACKEND, openById: () => SOURCE, flush(){} },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const src = fs.readFileSync(process.argv[2],'utf8')
  + "\n;globalThis.__x = {checkPriceChanges_, normPrice_, SHEET_PRICE_LOG, SHEET_PRICE_SNAP, PRICE_LOG_HEADER, HEADER_LABELS,"
  + " PRICE_WATCH_PROP_FULLAT};\n";
vm.runInContext(src, sandbox, { filename:'Code.gs' });
const X = sandbox.__x;

let fail = 0;
const ck = (id, cond, extra) => { if(!cond){ console.log('  FAIL', id, extra===undefined?'':JSON.stringify(extra)); fail++; } else console.log('  ok  ', id); };

const HDR = ['1124更','品名','規格','ODM士林倉','三相之力','山物獵人網購倉','中華門市倉','門外漢門市倉','網購庫存倉','總倉','商品在途倉','總計','定價','特惠價'];
function srcRow(sku, list, special, name){ return [sku, name || ('商品'+sku), '規格'+sku, 0,0,0,0,0,1,0,0,1, list, special]; }
function buildSource(version, rows){
  SRC = makeSheet('山物地圖(快取)', [['人工表頭（過期）'], [version].concat(HDR.slice(1))].concat(rows));
}
// 1200 列（來源少於 1000 列會被當成還在載入）
function baseRows(){
  const rows = [];
  for(let i = 0; i < 1200; i++) rows.push(srcRow('0' + (100000 + i), 1000 + i, i % 3 === 0 ? '' : 900 + i));
  return rows;
}
function logRows(){ const sh = SHEETS[X.SHEET_PRICE_LOG]; return sh ? sh._rows.slice(1).filter(r=>r.some(v=>v!=='')) : []; }

console.log('\n【價格正規化】');
ck('數字與千分位字串視為同一個', X.normPrice_(1280) === '1280' && X.normPrice_('1,280') === '1280' && X.normPrice_(1280.0) === '1280');
ck('空白是空字串', X.normPrice_('') === '' && X.normPrice_(null) === '');
ck('看不懂的回 null（這輪不判斷）', X.normPrice_('#N/A') === null && X.normPrice_('Loading...') === null);

console.log('\n【第一次執行】只建基準，不記異動');
buildSource('1124更', baseRows());
let r = X.checkPriceChanges_({});
ck('回報建立基準 1200 筆', r.ok && r.建立基準 === 1200, r);
ck('沒有任何異動紀錄', logRows().length === 0, logRows().length);
ck('快照分頁有 1200 列且藏起來', SHEETS[X.SHEET_PRICE_SNAP]._rows.length === 1201 && SHEETS[X.SHEET_PRICE_SNAP]._hidden);
ck('快照的貨號保留開頭的 0', SHEETS[X.SHEET_PRICE_SNAP]._rows[1][0] === '0100000', SHEETS[X.SHEET_PRICE_SNAP]._rows[1]);
ck('來源一格都沒寫', SRC._writes === 0);

console.log('\n【來源沒更新】A2 一樣、也還沒到整張重比的時間 → 直接跳過');
r = X.checkPriceChanges_({});
ck('跳過', r.skipped === true, r);

console.log('\n【改價】');
const rows2 = baseRows();
rows2[5][12] = 1999;                 // 0100005 定價 1005 → 1999
rows2[7][13] = '';                   // 0100007 特惠價 907 → 空白（取消特惠）
rows2[9][12] = '1,009';              // 0100009 定價寫法不同但數字一樣 → 不算異動
rows2[3][13] = 555;                  // 0100003 特惠價 空白 → 555（新增特惠）
rows2.push(srcRow('NEW001', 300, 250));   // 新貨號
buildSource('1125更', rows2);
r = X.checkPriceChanges_({});
ck('偵測到 3 筆異動、1 個新貨號', r.ok && r.價格異動 === 3 && r.新貨號 === 1, r);
const L = logRows();
const H = X.PRICE_LOG_HEADER;
const row = sku => L.find(x => x[H.indexOf('priceSku')] === sku);
const r5 = row('0100005');
ck('定價改了：原始 1005 → 現行 1999，特惠價兩邊都是 905', r5 && r5[H.indexOf('oldListPrice')] === '1005' && r5[H.indexOf('newListPrice')] === '1999'
   && r5[H.indexOf('oldSpecialPrice')] === '905' && r5[H.indexOf('newSpecialPrice')] === '905', r5);
ck('有日期、品名、規格、來源版本', r5 && r5[H.indexOf('priceDate')] === '2026/11/24' && r5[H.indexOf('baseName')] === '商品0100005' && r5[H.indexOf('spec')] === '規格0100005' && r5[H.indexOf('srcVersion')] === '1125更', r5);
const r6 = row('0100007');
ck('取消特惠：原始特惠 907 → 現行空白', r6 && r6[H.indexOf('oldSpecialPrice')] === '907' && r6[H.indexOf('newSpecialPrice')] === '', r6);
const r3 = row('0100003');
ck('新增特惠：原始空白 → 555', r3 && r3[H.indexOf('oldSpecialPrice')] === '' && r3[H.indexOf('newSpecialPrice')] === '555', r3);
ck('千分位寫法不同不算異動', !row('0100009'));
ck('新貨號不算異動', !row('NEW001'));
ck('分頁標題是中文', SHEETS[X.SHEET_PRICE_LOG]._rows[0].join(',') === '日期,貨號,品名,規格,原始定價,原始特惠價,現行定價,現行特惠價,來源版本,最後更新時間', SHEETS[X.SHEET_PRICE_LOG]._rows[0]);

console.log('\n【同樣的資料再比一次】不能重複記');
r = X.checkPriceChanges_({force:true});
ck('0 筆異動', r.ok && r.價格異動 === 0, r);
ck('紀錄還是 3 筆', logRows().length === 3, logRows().length);

console.log('\n【A2 沒變】山物地圖一天只更新一次：A2 沒換日期就不整張比，過再久都一樣');
const rows3 = rows2.map(x=>x.slice()); rows3[8][12] = 2222;
buildSource('1125更', rows3);
PROPS[X.PRICE_WATCH_PROP_FULLAT] = String(Date.now() - 20 * 3600000);
r = X.checkPriceChanges_({});
ck('A2 一樣：跳過', r.skipped === true, r);
buildSource('1126更', rows3);
r = X.checkPriceChanges_({});
ck('A2 換成隔天：整張比，抓到 1 筆', r.ok && !r.skipped && r.價格異動 === 1, r);

console.log('\n【來源還沒載入完】');
buildSource('1127更', baseRows().slice(0, 10));
r = X.checkPriceChanges_({});
ck('只有 10 列：不比、不記', r.ok === false && logRows().length === 4, {r, n: logRows().length});
r = X.checkPriceChanges_({});
ck('上一輪被擋下沒記 A2：下一小時同一個 A2 會再試，不會跳過一整天', r.skipped !== true, r);
const blankRows = baseRows().map(x => { const y = x.slice(); y[12] = ''; y[13] = ''; return y; });
buildSource('1127更', blankRows);
r = X.checkPriceChanges_({});
ck('一大片價格同時變空白：判斷是讀到一半，不記', r.ok === false && logRows().length === 4, {r, n: logRows().length});
const loading = baseRows().map(x => { const y = x.slice(); y[12] = 'Loading...'; return y; });
buildSource('1127更', loading);
r = X.checkPriceChanges_({});
ck('格子是 Loading...：那些列這輪不判斷', r.ok && r.價格異動 === 0 && r.讀不懂略過 === 1200, r);
ck('讀不懂的列快照沒被弄丟', SHEETS[X.SHEET_PRICE_SNAP]._rows.filter(x=>x[0]).length >= 1201, SHEETS[X.SHEET_PRICE_SNAP]._rows.length);

console.log('\n【以天為單位】同一天同一個貨號只有一列');
buildSource('1128更', rows3);            // 先恢復正常來源
PROPS[X.PRICE_WATCH_PROP_FULLAT] = '0';
X.checkPriceChanges_({});
const before = logRows().length;
const rows4 = rows3.map(x=>x.slice()); rows4[5][12] = 2500;      // 0100005 今天第二次改：1999 → 2500
buildSource('1128更B', rows4);
r = X.checkPriceChanges_({});
let L2 = logRows();
const same = L2.filter(x => x[H.indexOf('priceSku')] === '0100005');
ck('同一天第二次改價：還是只有一列', same.length === 1 && L2.length === before, {n: same.length, before, now: L2.length});
ck('原始定價留著當天開始的 1005、現行更新成 2500', same[0] && same[0][H.indexOf('oldListPrice')] === '1005' && same[0][H.indexOf('newListPrice')] === '2500', same[0]);
ck('回報「今天再次變動 1」', r.今天再次變動 === 1 && r.今天新增 === 0, r);
const rows5 = rows4.map(x=>x.slice()); rows5[5][12] = 1005;      // 又改回原價
buildSource('1128更C', rows5);
r = X.checkPriceChanges_({});
L2 = logRows();
ck('當天改回原價：那一列拿掉', !L2.some(x => x[H.indexOf('priceSku')] === '0100005') && r.今天改回原價移除 === 1, r);
ck('其他貨號的列沒被動到', L2.length === before - 1 && L2.some(x => x[H.indexOf('priceSku')] === '0100007'), L2.map(x=>x[H.indexOf('priceSku')]));
DAY.d = '2026/11/25';
const rows6 = rows5.map(x=>x.slice()); rows6[5][12] = 1100;
buildSource('1129更', rows6);
r = X.checkPriceChanges_({});
L2 = logRows();
const nextDay = L2.filter(x => x[H.indexOf('priceSku')] === '0100005');
ck('隔天再改：新的一天新的一列', nextDay.length === 1 && nextDay[0][H.indexOf('priceDate')] === '2026/11/25' && r.今天新增 === 1, {nextDay, r});

console.log(fail ? '\n有 '+fail+' 項失敗' : '\n全部通過：第一次只建基準、改價才記、寫法不同不算、新貨號不算、沒載入完不亂記、來源不寫');
process.exit(fail?1:0);
