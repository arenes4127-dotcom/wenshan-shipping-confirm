// 門市盤點流程的離線測試台
//
// 用法：cp Code.gs /tmp/CodeRun.js && node tests/count_harness.js /tmp/CodeRun.js
//
// 跟 archive_harness.js 同樣的理由：node --check 只看語法，抓不到未定義變數、
// 欄位對錯、累加算錯這類只有真的跑一次才會現形的問題。這支用假的 Apps Script
// 服務把整份 Code.gs 載進來，組出「條碼轉品號」與「山物地圖(快取)」兩張假來源表，
// 真的跑一次「開場次 → 掃描 → 手改數量 → 結束對帳」，然後逐項驗收。
const fs = require('fs'), vm = require('vm');

function makeSheet(name, rows){
  return {
    _name: name, _rows: rows.map(r=>r.slice()),
    getName(){ return this._name; },
    getLastRow(){ let last=0; this._rows.forEach((r,i)=>{ if(r.some(v=>String(v==null?'':v)!=='')) last=i+1; }); return last; },
    getLastColumn(){ return Math.max.apply(null, this._rows.map(r=>r.length).concat([1])); },
    getMaxRows(){ return this._rows.length; },
    getParent(){ return null; },
    appendRow(vals){ this._rows.push(vals.slice()); },
    getDataRange(){ return this.getRange(1,1,this._rows.length,this.getLastColumn()); },
    getRange(r,c,nr,nc){
      // 支援 A1 位址寫法（'A1'、'A1:A5'、'A2:A'）。Apps Script 兩種都收，
      // 盤點差異表那段用的是 A1 寫法。
      if(typeof r === 'string'){
        const col = t => { let n=0; for(const ch of t) n = n*26 + (ch.charCodeAt(0)-64); return n; };
        const parts = r.split(':');
        const m1 = /^([A-Z]+)(\d*)$/.exec(parts[0]);
        const m2 = parts[1] ? /^([A-Z]+)(\d*)$/.exec(parts[1]) : null;
        const r1 = m1[2] ? parseInt(m1[2],10) : 1, c1 = col(m1[1]);
        const r2 = m2 ? (m2[2] ? parseInt(m2[2],10) : Math.max(this.getLastRow(), r1)) : r1;
        const c2 = m2 ? col(m2[1]) : c1;
        r = r1; c = c1; nr = Math.max(r2 - r1 + 1, 1); nc = Math.max(c2 - c1 + 1, 1);
      }
      nr = nr==null?1:nr; nc = nc==null?1:nc;
      const sh = this;
      return {
        getValues(){ const o=[]; for(let i=0;i<nr;i++){ const row=sh._rows[r-1+i]||[]; const t=[];
          for(let j=0;j<nc;j++) t.push(row[c-1+j]===undefined?'':row[c-1+j]); o.push(t);} return o; },
        getValue(){ return this.getValues()[0][0]; },
        setValues(vals){ for(let i=0;i<vals.length;i++){ while(sh._rows.length < r-1+i+1) sh._rows.push([]);
          if(!sh._rows[r-1+i]) sh._rows[r-1+i] = [];
          for(let j=0;j<vals[i].length;j++) sh._rows[r-1+i][c-1+j]=vals[i][j]; } return this; },
        setValue(v){ return this.setValues([[v]]); },
        clearContent(){ for(let i=0;i<nr;i++){ const row=sh._rows[r-1+i]; if(!row) continue;
          for(let j=0;j<nc;j++) row[c-1+j]=''; } return this; },
        setNumberFormat(){ return this; }, setNote(){ return this; },
        setFontWeight(){ return this; }, setDataValidation(){ return this; },
        setFormula(f){ sh._formulas['R'+r+'C'+c] = f; return this; },
        getA1Notation(){ return 'R'+r+'C'+c; },
      };
    },
    deleteRows(st,n){ this._rows.splice(st-1, n==null?1:n); },
    setName(n){ this._name=n; }, getSheetId(){ return 1; }, getProtections(){ return []; },
    // 盤點差異表是整頁公式，建表時會用到這些；記下設過的公式讓測試檢查
    _formulas: {},
    clear(){ this._rows = []; this._formulas = {}; },
    clearConditionalFormatRules(){}, setFrozenRows(){}, setColumnWidth(){},
  };
}
function makeSS(name, sheets){
  return { _name:name, _sheets:sheets,
    getName(){ return this._name; }, getId(){ return 'id_'+this._name; },
    getSpreadsheetTimeZone(){ return 'Asia/Taipei'; },
    getSheetByName(n){ return this._sheets[n] || null; },
    insertSheet(n){ const s = makeSheet(n, []); this._sheets[n] = s; return s; },
    getSheets(){ return Object.keys(this._sheets).map(k=>this._sheets[k]); } };
}

// ---- 假來源資料 ----
// 「山物地圖(快取)」：第1列人工表頭、第2列來源表頭、第3列起資料
//   A品號 B品名 C規格 D ODM士林倉 E三相之力 F山物獵人網購倉
//   G中華門市倉 H門外漢門市倉 I網購庫存倉 J總倉
const CACHE_HEADER2 = ['品號','品名','規格','ODM士林倉','三相之力','山物獵人網購倉',
                       '中華門市倉','門外漢門市倉','網購庫存倉','總倉','商品在途倉','總計',
                       '定價','特惠價','1015更','台南總倉'];
const cacheRows = [CACHE_HEADER2];   // 山物倉地圖／庫存表：第1列表頭、第2列起資料
// 門市對照（使用者提供）：D=士林、E=台中、G=中華、H=台南；另有 I/J 網路倉、K 在途、P 台南總倉
const row16 = (sku,name,spec,D,E,F,G,H,I,J,K,P) =>
  [sku,name,spec,D,E,F,G,H,I,J,K,'','','','',P];
cacheRows.push(row16('SKU-A','商品A','紅', 0,1,0, 5,2, 10,3, 0, 0));  // 中華5、台南2、台中1
cacheRows.push(row16('SKU-B','商品B','藍', 0,0,0, 3,0,  0,0, 0, 0));  // 中華3
cacheRows.push(row16('SKU-C','商品C','黑', 0,0,0, 0,7,  0,0, 0, 0));  // 中華0、台南7
cacheRows.push(row16('SKU-D','商品D','白', 0,1,0, 4,1,  0,0, 0, 0));  // 中華4、台南1
// 中華帳上是 0，但別的據點有貨 → 掃到它要能看出「那它在哪」
cacheRows.push(row16('SKU-E','商品E','黃', 9,0,0, 0,0,  0,0, 2, 4));  // 士林9、在途2、台南總倉4
// 庫存表有、條碼轉品號沒有（門市三萬多個品號的常態）。
// 中華與台南都給 0，不要動到其他測試的「未盤到」筆數。
cacheRows.push(row16('SKU-F','商品F（條碼表沒有）','綠', 6,0,0, 0,0,  0,0, 0, 0));  // 只有士林6
// 品號在庫存表裡帶連字號，現場掃到的是沒有連字號的寫法 → 要靠正規化救回來
cacheRows.push(row16('SKU-G1','商品G','綠',0,0,0, 6,0,  0,0, 0, 0));  // 中華6
const stock = makeSheet('庫存表', cacheRows);
// 現場實測：鏡像分頁「山物地圖(快取)」是空的（分頁在、但沒有資料列）。
// 這正是「分頁存在不等於有資料」那個坑，測試要重現它。
const emptyCache = makeSheet('山物地圖(快取)', [[], []]);

// 「條碼轉品號」：A? B品號 C條碼 D品名
const barcode = makeSheet('條碼轉品號', [
  ['', '品號', '條碼', '品名'],
  ['', 'SKU-A', '4711111111111', '商品A'],
  ['', 'SKU-B', '4722222222222', '商品B'],
  ['', 'SKU-C', '4733333333333', '商品C'],
  ['', 'SKU-D', '4744444444444', '商品D'],
  ['', 'SKU-E', '4755555555555', '商品E'],
  // 條碼轉品號有、但庫存表完全沒有 → 品名要能補上
  ['', 'SKU-X', '4766666666666', '商品X（庫存表沒有）'],
]);

let BACKEND = null, CACHE_SS = null, stampSeq = 1;
// ERP 每日匯出檔的假資料。預設空的，要測的時候再塞——
// 不要讓它影響到前面那些只看庫存表的測試。
let ERP_FILES = {};
let FILE_MTIME = {};
const mkCsv = (text, updatedAt) => ({
  getBlob: () => ({ getDataAsString: () => text }),
  getLastUpdated: () => updatedAt
});
const log = [];
const sandbox = {
  console,
  Logger: { log: m => log.push(String(m)) },
  Session: { getEffectiveUser: () => ({ getEmail: () => 't@e.com' }) },
  Utilities: { formatDate: (d,tz,f) => '20261015-1015' + String(stampSeq++).padStart(2,'0'), sleep(){},
    // 真的解 CSV，不要用假的——ERP 匯出檔是純文字，解錯了就會把帳上數量算錯
    parseCsv: (t) => String(t||'').split(/\r?\n/).filter(l=>l!=='').map(l=>l.split(',')) },
  CacheService: { getScriptCache: () => ({ get:()=>null, put(){}, remove(){}, getAll:()=>({}), putAll(){}, removeAll(){} }) },
  LockService: { getScriptLock: () => ({ tryLock:()=>true, releaseLock(){}, waitLock(){} }) },
  ScriptApp: { getProjectTriggers:()=>[], WeekDay:{MONDAY:1}, TriggerSource:{CLOCK:'CLOCK'} },
  UrlFetchApp: { fetch: ()=>({ getContentText:()=>'{}', getResponseCode:()=>200 }) },
  ContentService: { createTextOutput: t=>({ setMimeType: ()=>t }), MimeType:{JSON:'json'} },
  HtmlService: {}, MimeType: { CSV:'text/csv', PLAIN_TEXT:'text/plain', HTML:'text/html' },
  DriveApp: {
    getFolderById:(id)=>({
      getFilesByName:(name)=>{
        const f = ERP_FILES[name];
        let served = false;
        return { hasNext:()=> !!f && !served, next:()=>{ served = true; return f; } };
      }, addFile(){} }),
    getFileById:(id)=>({ setTrashed(){}, getLastUpdated:()=> FILE_MTIME[id] || null }),
    getRootFolder:()=>({ removeFile(){} }) },
  SpreadsheetApp: {
    newDataValidation: () => ({ requireValueInRange: () => ({ setAllowInvalid: () => ({ build: () => ({}) }) }),
                                requireValueInList:  () => ({ setAllowInvalid: () => ({ build: () => ({}) }) }) }),
    getActiveSpreadsheet: () => BACKEND,
    setActiveSpreadsheet: s => { BACKEND = s; },
    openById: id => (String(id).indexOf('1rVA') === 0 ? STOCK_SS
                 : String(id).indexOf('1hZ6') === 0 ? CACHE_SS : BACKEND),
    flush(){}, create: n => makeSS(n, {}),
    ProtectionType:{SHEET:'SHEET',RANGE:'RANGE'},
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const src = fs.readFileSync(process.argv[2],'utf8')
  + "\n;globalThis.__x = {startCountSession, countScanBatch, setCountQty, finishCountSession,"
  + " getCountSession, listCountSessions, cancelCountSession, STORE_LIST, STORE_DEFS, storeDef_,"
  + " openStoreStockSheet_, storeStockSnapshot_, stockNamesForSkus_, _ssMemo_,"
  + " namePatchMap_, barcodeToSkuMap_, SHEET_NAME_PATCH, NAME_PATCH_HEADER,"
  + " erpStockSnapshot_, STORE_STOCK_SOURCE_ID, ERP_STOCK_STALE_DAYS,"
  + " setupCountDiffSheet_, SHEET_COUNT_DIFF, recheckCountSession, recheckAllCountSessions,"
  + " SHEET_COUNT_SESSION, SHEET_COUNT_DETAIL, COUNT_DETAIL_HEADER, COUNT_SESSION_HEADER};\n";
vm.runInContext(src, sandbox, { filename:'Code.gs' });
const X = sandbox.__x;

let STOCK_SS = makeSS('山物倉地圖', {'庫存表': stock});
CACHE_SS = makeSS('文山地圖', {'山物地圖(快取)': emptyCache});
BACKEND  = makeSS('文山出貨確認系統-後端', {'條碼轉品號': barcode});

let fail = 0;
const ck = (id, cond, extra) => { if(!cond){ console.log('  FAIL', id, extra===undefined?'':JSON.stringify(extra)); fail++; } else console.log('  ok  ', id); };

console.log('【門市欄位對照】');
X.STORE_DEFS.forEach(d => console.log('   ', d.name, '←', d.from.join(' ＋ '), 'cols', JSON.stringify(d.cols)));
ck('共 4 家門市（網路倉庫不列入）', X.STORE_LIST.length === 4, X.STORE_LIST);
ck('秀山莊-中華門市 = G(7)', JSON.stringify(X.storeDef_('秀山莊-中華門市').cols) === '[7]');
ck('ODM-台南門市 = H(8)', JSON.stringify(X.storeDef_('ODM-台南門市').cols) === '[8]');
ck('ODM-台中門市 = E(5)', JSON.stringify(X.storeDef_('ODM-台中門市').cols) === '[5]');
ck('ODM-士林門市 = D(4)', JSON.stringify(X.storeDef_('ODM-士林門市').cols) === '[4]');
ck('快取第7欄表頭是中華門市倉', CACHE_HEADER2[6] === '中華門市倉', CACHE_HEADER2[6]);
ck('快取第5欄表頭是三相之力', CACHE_HEADER2[4] === '三相之力', CACHE_HEADER2[4]);
ck('快取第8欄表頭是門外漢門市倉', CACHE_HEADER2[7] === '門外漢門市倉', CACHE_HEADER2[7]);

console.log('\n【來源挑選】鏡像是空的，必須自己退回去讀真的那一份');
const open1 = X.openStoreStockSheet_();
console.log('   用到的來源：', open1.label, '| 試過：', JSON.stringify(open1.tried));
ck('挑到山物倉地圖／庫存表', open1.ok && open1.label === '山物倉地圖／庫存表', open1.label);
ck('資料從第2列起', open1.firstRow === 2, open1.firstRow);
const snapChk = X.storeStockSnapshot_('秀山莊-中華門市');
ck('讀得到庫存（不是空的）', snapChk.ok && snapChk.withStock.length === 4, snapChk.ok && snapChk.withStock);

console.log('\n【開場次】');
ck('門市沒選會被擋', X.startCountSession({counterId:'01'}).ok === false);
ck('舊的欄位名稱不能當門市用', X.startCountSession({store:'中華門市倉', counterId:'01'}).ok === false);
ck('沒選盤點人會被擋', X.startCountSession({store:'秀山莊-中華門市'}).ok === false);
const st = X.startCountSession({store:'秀山莊-中華門市', counterId:'01', counterName:'小明'});
ck('開場次成功', st.ok === true, st);
const SID = st.sessionId;

console.log('\n【掃描】掃國際碼、掃品號、重複掃累加、掃到不認得的碼');
let r = X.countScanBatch({sessionId: SID, ops:[
  {code:'4711111111111', qty:1},   // 國際碼 → SKU-A
  {code:'4711111111111', qty:1},   // 再掃一次 → 累加成 2
  {code:'SKU-B', qty:3},           // 直接掃品號
  {code:'9999999999999', qty:1},   // 不認得
]});
ck('批次回傳成功', r.ok === true, r);
const byCode = {}; (r.results||[]).forEach(x=>{ byCode[x.sku] = x; });
ck('SKU-A 累加成 2', byCode['SKU-A'] && byCode['SKU-A'].total === 2, byCode['SKU-A']);
ck('SKU-B 是 3', byCode['SKU-B'] && byCode['SKU-B'].total === 3, byCode['SKU-B']);
ck('不認得的碼標成 known=false', byCode['9999999999999'] && byCode['9999999999999'].known === false);
ck('掃描件數合計 6', r.scannedQty === 6, r.scannedQty);
ck('品項數 3', r.itemCount === 3, r.itemCount);

console.log('\n【第二批掃描】跨批次要接續累加，不能從頭算');
r = X.countScanBatch({sessionId: SID, ops:[{code:'4711111111111', qty:1}]});
ck('SKU-A 跨批累加成 3', r.results[0].total === 3, r.results[0]);
ck('件數合計 7', r.scannedQty === 7, r.scannedQty);

console.log('\n【手改數量】整箱不會一件一件掃');
const sq = X.setCountQty({sessionId: SID, sku:'SKU-B', qty: 10});
ck('改數量成功', sq.ok === true && sq.qty === 10, sq);
ck('改完件數重算成 14', sq.scannedQty === 14, sq.scannedQty);
ck('負數被擋', X.setCountQty({sessionId: SID, sku:'SKU-B', qty:-1}).ok === false);
ck('不存在的品號被擋', X.setCountQty({sessionId: SID, sku:'SKU-ZZZ', qty:1}).ok === false);

console.log('\n【讀回場次】手持機當掉要能接回來');
const gs = X.getCountSession({sessionId: SID});
ck('讀得回來', gs.ok === true && gs.items.length === 3, gs.ok && gs.items.length);

console.log('\n【結束盤點＋對帳】秀山莊-中華門市：A應5實3(盤虧2)、B應3實10(盤盈7)、D應4未盤到、9999查無');
const fin = X.finishCountSession({sessionId: SID, includeUnscanned: true});
console.log('  回傳：', JSON.stringify(fin));
ck('結束成功', fin.ok === true, fin);
ck('未盤到 3 筆（SKU-D/SKU-E 不算 0、SKU-G1）', fin['未盤到'] === 2, fin['未盤到']);
ck('查無此品號 1 筆', fin['庫存表查無此品號'] === 1, fin['庫存表查無此品號']);
ck('有差異 2 筆（A盤虧、B盤盈）', fin['有差異'] === 2, fin['有差異']);
ck('不能重複結束', X.finishCountSession({sessionId: SID}).ok === false);
ck('結束後不能再掃', X.countScanBatch({sessionId: SID, ops:[{code:'SKU-A',qty:1}]}).ok === false);

const det = BACKEND.getSheetByName(X.SHEET_COUNT_DETAIL);
const H = X.COUNT_DETAIL_HEADER;
const iSku=H.indexOf('sku'), iSc=H.indexOf('countScanned'), iEx=H.indexOf('countExpected'),
      iDf=H.indexOf('countDiff'), iRs=H.indexOf('countResult');
const detail = {};
det._rows.slice(1).forEach(row=>{ if(row[iSku]) detail[row[iSku]] = row; });
console.log('\n【明細分頁實際內容】');
Object.keys(detail).forEach(k=>console.log('   ', k, '實盤', detail[k][iSc], '應有', detail[k][iEx],
  '差異', detail[k][iDf], detail[k][iRs]));
ck('SKU-A 實3 應5 差-2 盤虧', detail['SKU-A'][iSc]===3 && detail['SKU-A'][iEx]===5 && detail['SKU-A'][iDf]===-2 && detail['SKU-A'][iRs]==='盤虧', detail['SKU-A']);
ck('SKU-B 實10 應3 差7 盤盈', detail['SKU-B'][iSc]===10 && detail['SKU-B'][iEx]===3 && detail['SKU-B'][iDf]===7 && detail['SKU-B'][iRs]==='盤盈', detail['SKU-B']);
ck('SKU-D 實0 應4 差-4 未盤到', detail['SKU-D'][iSc]===0 && detail['SKU-D'][iEx]===4 && detail['SKU-D'][iDf]===-4 && detail['SKU-D'][iRs]==='未盤到', detail['SKU-D']);
ck('SKU-C 不該出現（中華庫存0、也沒掃）', !detail['SKU-C'], detail['SKU-C']);
ck('9999 標成查無此品號', detail['9999999999999'] && detail['9999999999999'][iRs]==='庫存表查無此品號', detail['9999999999999']);
const iOs0 = H.indexOf('otherStock');
console.log('   盤虧/盤盈的「其他據點庫存」：');
['SKU-A','SKU-B'].forEach(k=>console.log('    ', k, detail[k][iRs], '|', detail[k][iOs0]));
ck('盤虧(SKU-A)也要列出哪裡有貨', /ODM-台南門市 2/.test(detail['SKU-A'][iOs0]) && /秀山莊通路-網路倉庫/.test(detail['SKU-A'][iOs0]), detail['SKU-A'][iOs0]);
ck('不列出正在盤的這家店自己', !/秀山莊-中華門市/.test(detail['SKU-A'][iOs0]), detail['SKU-A'][iOs0]);
ck('不顯示括弧裡的原始欄名', !/（/.test(detail['SKU-A'][iOs0]), detail['SKU-A'][iOs0]);
ck('同名的倉要合併相加（網購庫存倉10＋總倉3=13）', /秀山莊通路-網路倉庫 13/.test(detail['SKU-A'][iOs0]), detail['SKU-A'][iOs0]);
ck('同名的倉只出現一次', (detail['SKU-A'][iOs0].match(/秀山莊通路-網路倉庫/g)||[]).length === 1, detail['SKU-A'][iOs0]);
ck('盤盈(SKU-B)其他據點都沒貨時明講', /其他據點都沒有庫存/.test(detail['SKU-B'][iOs0]), detail['SKU-B'][iOs0]);
ck('未盤到(SKU-D)不掛長字串', !detail['SKU-D'][iOs0], detail['SKU-D'][iOs0]);

console.log('\n【另一家門市分開對帳】ODM-台南門市 = H：A應2、C應7、D應1');
const st2 = X.startCountSession({store:'ODM-台南門市', counterId:'02', counterName:'小華'});
X.countScanBatch({sessionId: st2.sessionId, ops:[{code:'SKU-A', qty:2}]});
const fin2 = X.finishCountSession({sessionId: st2.sessionId, includeUnscanned: true});
console.log('  回傳：', JSON.stringify(fin2));
const d2 = {};
det._rows.slice(1).forEach(row=>{ if(row[0]===st2.sessionId && row[iSku]) d2[row[iSku]] = row; });
console.log('  台南門市明細：');
Object.keys(d2).forEach(k=>console.log('   ', k, '實盤', d2[k][iSc], '應有', d2[k][iEx], d2[k][iRs]));
ck('台南 SKU-A 應有=2（H欄，不是中華的5）且相符', d2['SKU-A'] && d2['SKU-A'][iEx]===2 && d2['SKU-A'][iRs]==='相符', d2['SKU-A']);
ck('台南 SKU-C 應有=7 未盤到', d2['SKU-C'] && d2['SKU-C'][iEx]===7 && d2['SKU-C'][iRs]==='未盤到', d2['SKU-C']);
ck('台南 SKU-D 應有=1 未盤到', d2['SKU-D'] && d2['SKU-D'][iEx]===1 && d2['SKU-D'][iRs]==='未盤到', d2['SKU-D']);
ck('台南 SKU-B 不該出現（H0 又沒掃）', !d2['SKU-B'], d2['SKU-B']);
ck('兩場次互不干擾：中華那場 SKU-A 應有仍是 5', detail['SKU-A'][iEx]===5);

const ls = X.listCountSessions({});
ck('場次編號帶隨機碼（不會同秒撞號）', /-[0-9A-Z]{3}$/.test(SID), SID);
ck('場次清單有兩筆、最新在前', ls.ok && ls.sessions.length===2 && ls.sessions[0].sessionId===st2.sessionId, ls.sessions && ls.sessions.length);

console.log('\n【查無此品號／帳上為0】要補品名、要指出哪裡有貨');
const st4 = X.startCountSession({store:'秀山莊-中華門市', counterId:'04', counterName:'阿忠'});
X.countScanBatch({sessionId: st4.sessionId, ops:[
  {code:'SKU-E', qty:1},     // 中華帳上0，但士林9、在途2、台南總倉4
  {code:'SKU-X', qty:2},     // 條碼轉品號有、庫存表沒有
  {code:'8888888888888', qty:1}, // 兩邊都沒有
  {code:'skug1', qty:6},     // 庫存表是 SKU-G1，靠正規化對上
]});
const fin4 = X.finishCountSession({sessionId: st4.sessionId});
console.log('  回傳：', JSON.stringify(fin4));
const iOs = H.indexOf('otherStock'), iNm = H.indexOf('baseName');
const d4 = {};
det._rows.slice(1).forEach(row=>{ if(row[0]===st4.sessionId && row[iSku]) d4[row[iSku]] = row; });
Object.keys(d4).forEach(k=>console.log('   ', k, '|', d4[k][iNm], '|', d4[k][iRs], '|', d4[k][iOs]));
ck('SKU-E 帳上0 → 列出士林/在途/台南總倉', /ODM-士林門市/.test(d4['SKU-E'][iOs]) && /台南總倉/.test(d4['SKU-E'][iOs]) && /商品在途倉/.test(d4['SKU-E'][iOs]), d4['SKU-E'][iOs]);
ck('只顯示對照後的名稱', /ODM-士林門市 9/.test(d4['SKU-E'][iOs]) && !/（/.test(d4['SKU-E'][iOs]), d4['SKU-E'][iOs]);
ck('otherStock 是最後一欄（既有資料不會錯位）', H[H.length-1] === 'otherStock', H[H.length-1]);
ck('SKU-E 不應列出中華（正在盤的就是這家）', !/秀山莊-中華門市/.test(d4['SKU-E'][iOs]), d4['SKU-E'][iOs]);
ck('SKU-X 查無此品號但品名有補上', d4['SKU-X'][iRs]==='庫存表查無此品號' && /商品X/.test(d4['SKU-X'][iNm]), [d4['SKU-X'][iRs], d4['SKU-X'][iNm]]);
ck('SKU-X 說明「條碼轉品號查得到、庫存表沒有」', /條碼轉品號查得到/.test(d4['SKU-X'][iOs]), d4['SKU-X'][iOs]);
ck('8888… 兩邊都沒有時明講、並指向 ERP',
   /都沒有這個品號/.test(d4['8888888888888'][iOs]) && /ERP/.test(d4['8888888888888'][iOs]),
   d4['8888888888888'][iOs]);
// 不可以再寫成「各據點都沒有庫存」——那是推論不是事實，而且實際踩過反例（庫存表慢更）
ck('不要把「庫存表沒有」講成「沒有庫存」',
   !/各據點都沒有庫存/.test(d4['8888888888888'][iOs] + d4['SKU-X'][iOs]));
ck('SKU-X 也要指向 ERP', /ERP/.test(d4['SKU-X'][iOs]), d4['SKU-X'][iOs]);
ck('相符且非正規化對上的不填（SKU-A台南場相符）', !d2['SKU-A'][iOs], d2['SKU-A'][iOs]);
ck('skug1 靠正規化對上 SKU-G1 且相符', d4['skug1'][iEx]===6 && d4['skug1'][iRs]==='相符', [d4['skug1'][iEx], d4['skug1'][iRs]]);
ck('正規化對上時要註明原本的品號', /SKU-G1/.test(d4['skug1'][iOs]), d4['skug1'][iOs]);
ck('skug1 其他據點沒貨（只有中華有，而中華就是本場）', /其他據點都沒有庫存/.test(d4['skug1'][iOs]), d4['skug1'][iOs]);
ck('回傳有統計靠正規化救回幾筆', fin4['靠正規化才對上的品號'] === 1, fin4['靠正規化才對上的品號']);

console.log('\n【預設不列未盤到】只盤一區卻列出整店未盤到 = 一張假盤虧表');
const st3 = X.startCountSession({store:'秀山莊-中華門市', counterId:'03', counterName:'小美'});
X.countScanBatch({sessionId: st3.sessionId, ops:[{code:'SKU-A', qty:5}]});
const fin3 = X.finishCountSession({sessionId: st3.sessionId});   // 不傳 includeUnscanned
console.log('  回傳：', JSON.stringify(fin3));
ck('預設不列未盤到', fin3['未盤到'] === 0, fin3['未盤到']);
ck('但仍誠實回報有幾個沒掃到', fin3['庫存表中沒被掃到的品項總數'] === 3, fin3['庫存表中沒被掃到的品項總數']);
ck('有列出未盤到嗎=false', fin3['有列出未盤到嗎'] === false);
const d3 = {};
det._rows.slice(1).forEach(row=>{ if(row[0]===st3.sessionId && row[iSku]) d3[row[iSku]] = row; });
ck('明細只有掃到的那一筆', Object.keys(d3).length === 1 && d3['SKU-A'], Object.keys(d3));
ck('掃到的那筆仍然有對帳（應5實5相符）', d3['SKU-A'][iEx]===5 && d3['SKU-A'][iRs]==='相符', d3['SKU-A']);

console.log('\n【重算既有場次】新增欄位後要能補齊舊場次，不必重掃真的貨');
// 模擬「這些列是舊版本結束的」：把其他據點庫存清空
const detSheet = BACKEND.getSheetByName(X.SHEET_COUNT_DETAIL);
const iOs2 = H.indexOf('otherStock');
let cleared = 0;
detSheet._rows.forEach((row,i)=>{ if(i>0 && row[0]===SID && row[iOs2]){ row[iOs2]=''; cleared++; } });
console.log('   先清掉中華那場的「其他據點庫存」共', cleared, '格');
ck('有東西可以清（不然這個測試沒意義）', cleared > 0, cleared);
const before未盤到 = detSheet._rows.filter(r=>r[0]===SID && r[iRs]==='未盤到').length;
const rc = X.recheckCountSession({sessionId: SID});
console.log('   重算回傳：', JSON.stringify(rc));
ck('重算成功', rc.ok === true, rc);
const after = {};
detSheet._rows.slice(1).forEach(row=>{ if(row[0]===SID && row[iSku]) after[row[iSku]] = row; });
ck('盤虧列的其他據點庫存補回來了', /ODM-台南門市/.test(after['SKU-A'][iOs2]), after['SKU-A'][iOs2]);
ck('查無此品號列也補回來了', /都沒有這個品號|條碼轉品號查得到/.test(after['9999999999999'][iOs2]), after['9999999999999'][iOs2]);
ck('未盤到沒有被改判成盤虧', after['SKU-D'][iRs] === '未盤到', after['SKU-D'][iRs]);
ck('未盤到的列數沒有變', detSheet._rows.filter(r=>r[0]===SID && r[iRs]==='未盤到').length === before未盤到);
ck('實盤數沒有被動到（那是現場數出來的事實）', after['SKU-A'][iSc] === 3, after['SKU-A'][iSc]);
ck('不會產生新列', Object.keys(after).length === 5, Object.keys(after));
const rcAll = X.recheckAllCountSessions();
ck('批次重算只處理已完成的場次', /重算了 \d+ 個已完成的場次/.test(rcAll), String(rcAll).slice(0,40));

console.log('\n【備援】主來源整個不見時要退回鏡像，而不是整個停擺');
const savedStock = STOCK_SS;
// openSheetMemo_ 會把開過的試算表記在 _ssMemo_ 裡（同一次執行內重用，省開檔成本）。
// 測試中途換掉來源的話一定要先清掉，不然它根本不會重新開檔——這是測試自己的陷阱，
// 不是被測程式的問題。
const clearMemo = () => Object.keys(X._ssMemo_).forEach(k => { delete X._ssMemo_[k]; });
clearMemo();
STOCK_SS = makeSS('山物倉地圖', {});                       // 分頁被改名／權限被收回
CACHE_SS._sheets['山物地圖(快取)'] = makeSheet('山物地圖(快取)',
  [[], CACHE_HEADER2, ['SKU-A','商品A','紅',0,1,0,5,2,10,3]]);   // 鏡像這次有資料
const open2 = X.openStoreStockSheet_();
console.log('   用到的來源：', open2.label, '| 試過：', JSON.stringify(open2.tried));
ck('退回鏡像備援', open2.ok && open2.label === '鏡像備援', open2.label);
ck('備援的資料從第3列起', open2.firstRow === 3, open2.firstRow);
CACHE_SS._sheets['山物地圖(快取)'] = makeSheet('山物地圖(快取)', [[], []]);
clearMemo();
const open3 = X.openStoreStockSheet_();
ck('兩個來源都沒資料時誠實回報失敗', open3.ok === false && /沒有資料列|找不到/.test(open3.error||''), open3.error);
STOCK_SS = savedStock; clearMemo();

console.log('\n【盤點差異表】整頁公式，引號寫錯只會在試算表裡變 #ERROR、不會拋錯');
const diffInfo = X.setupCountDiffSheet_();
const dsh = BACKEND.getSheetByName(X.SHEET_COUNT_DIFF);
ck('分頁建出來了', !!dsh, diffInfo);
const f = dsh._formulas;
const qf = f['R8C1'];
console.log('   A8 的 QUERY 公式：');
console.log('   ', qf);
ck('A8 有 QUERY 公式', !!qf && qf.indexOf('QUERY') > 0, qf);
ck('引號成對（單引號偶數個）', (qf.match(/'/g)||[]).length % 2 === 0, (qf.match(/'/g)||[]).length);
ck('雙引號成對', (qf.match(/"/g)||[]).length % 2 === 0, (qf.match(/"/g)||[]).length);
ck('指到盤點明細', qf.indexOf("'盤點明細'!") > 0, qf.slice(0,60));
ck('有 where 條件綁 B1', qf.indexOf('where A = ') > 0 && qf.indexOf('$B$1') > 0);
ck('有「只看有差異」的條件', qf.indexOf("I <> ") > 0 && qf.indexOf('$B$2') > 0);
ck('最負的差異排前面', qf.indexOf('order by H asc') > 0);
ck('空場次時給提示而不是 #ERROR', qf.indexOf('請先在 B1 選一個場次編號') > 0);
console.log('   E1 的計數公式：', f['R1C5']);
ck('相符計數綁場次與結果欄', (f['R1C5']||'').indexOf("'盤點明細'!I:I") > 0 && (f['R1C5']||'').indexOf('$B$1') > 0, f['R1C5']);
ck('五種核對結果都有計數', ['R1C5','R2C5','R3C5','R4C5','R5C5'].every(k=>!!f[k]));
console.log('   B5 的場次摘要：', f['R5C2']);
ck('摘要指到盤點場次', (f['R5C2']||'').indexOf("'盤點場次'!") > 0, f['R5C2']);

console.log('\n【作廢場次】現場會誤按「開始盤點」開出空場次，要有路把它收掉、又不能算成已對帳');
const stC = X.startCountSession({store:'秀山莊-中華門市', counterId:'05', counterName:'誤按的'});
ck('開得起來', stC.ok === true, stC);
X.countScanBatch({sessionId: stC.sessionId, ops:[{code:'SKU-A', qty:2}]});
const cx = X.cancelCountSession({sessionId: stC.sessionId});
ck('作廢成功', cx.ok === true && cx['狀態'] === '已作廢', cx);
const gotC = X.getCountSession({sessionId: stC.sessionId});
ck('狀態改成已作廢', String(gotC.session.countStatus) === '已作廢', gotC.session.countStatus);
ck('有註記說未對帳', /未對帳/.test(String(gotC.session.note||'')), gotC.session.note);
// 明細列不删：那是現場真的數過的紀錄，刪掉就查不回來
ck('已經掃的明細還在', gotC.items.length === 1 && gotC.items[0].scanned === 2, gotC.items);
ck('作廢後不能再掃', X.countScanBatch({sessionId: stC.sessionId, ops:[{code:'SKU-A', qty:1}]}).ok === false);
ck('作廢後不能結束對帳', X.finishCountSession({sessionId: stC.sessionId}).ok === false);
ck('重複作廢不會爆掉', X.cancelCountSession({sessionId: stC.sessionId}).ok === true);
ck('找不到的場次要誠實回報', X.cancelCountSession({sessionId:'沒這個'}).ok === false);
ck('沒給 sessionId 要擋下來', X.cancelCountSession({}).ok === false);
// 已完成的不能追作廢：它已經對過帳、差異表也發出去了
ck('已完成的不能作廢', X.cancelCountSession({sessionId: SID}).ok === false, SID);
// 清單要看得到作廢的場次（前端靠它判斷要不要出「接續」按鈕）
const lsC = X.listCountSessions({limit: 50});
const rowC = (lsC.sessions||[]).filter(function(x){ return x.sessionId === stC.sessionId; })[0];
ck('清單裡有這場且標為已作廢', !!rowC && String(rowC.countStatus) === '已作廢', rowC);

console.log('\n【掃描當下的品名】條碼轉品號只收有建條碼對照的，門市三萬多個品號大多不在上面');
// 現場截圖：31 項全部顯示「查不到品名」，等於盲掃。品名一直在庫存表 B 欄。
ck('庫存表查得到、條碼表沒有的也要有品名',
   (X.stockNamesForSkus_(['SKU-F'])['SKU-F']||{}).baseName === '商品F（條碼表沒有）',
   X.stockNamesForSkus_(['SKU-F']));
ck('規格也一併帶回來', (X.stockNamesForSkus_(['SKU-F'])['SKU-F']||{}).spec === '綠');
ck('兩邊都沒有的就不要編一個出來', X.stockNamesForSkus_(['沒這個品號'])['沒這個品號'] === undefined);
ck('空陣列不會爆掉', JSON.stringify(X.stockNamesForSkus_([])) === '{}');

const stN = X.startCountSession({store:'秀山莊-中華門市', counterId:'06', counterName:'掃品名'});
const rN = X.countScanBatch({sessionId: stN.sessionId, ops:[{code:'SKU-F', qty:1}, {code:'SKU-A', qty:1}]});
const byCodeN = {};
(rN.results||[]).forEach(function(r){ byCodeN[r.code] = r; });
ck('掃描回應帶回庫存表的品名', (byCodeN['SKU-F']||{}).name === '商品F（條碼表沒有）', byCodeN['SKU-F']);
ck('條碼表查得到的不受影響', (byCodeN['SKU-A']||{}).name === '商品A', byCodeN['SKU-A']);
ck('內部參照不要送回前端', (byCodeN['SKU-F']||{})._ref === undefined);
// 品名也要落到試算表上，不是只給畫面看看
const gotN = X.getCountSession({sessionId: stN.sessionId});
const detF = (gotN.items||[]).filter(function(x){ return x.sku === 'SKU-F'; })[0];
ck('盤點明細裡也寫了品名', !!detF && detF.baseName === '商品F（條碼表沒有）', detF);
// 兩邊都查不到的，要誠實留空，不能隨便填一個
X.countScanBatch({sessionId: stN.sessionId, ops:[{code:'完全沒見過的碼', qty:1}]});
const gotN2 = X.getCountSession({sessionId: stN.sessionId});
const detU = (gotN2.items||[]).filter(function(x){ return x.sku === '完全沒見過的碼'; })[0];
ck('真的查不到就留空', !!detU && !String(detU.baseName||'').trim(), detU);
// 這個修正上線前已經在掃的場次，明細列上的品名是空的。
// getCountSession 要能把畫面補滱，不然現場按「接續」回來還是一片「查不到品名」。
const dsh2 = BACKEND.getSheetByName(X.SHEET_COUNT_DETAIL);
const bnCol = X.COUNT_DETAIL_HEADER.indexOf('baseName') + 1;
const skuCol = X.COUNT_DETAIL_HEADER.indexOf('sku') + 1;
for(let i = 2; i <= dsh2.getLastRow(); i++){
  if(String(dsh2.getRange(i, skuCol, 1, 1).getValue()||'').trim() === 'SKU-F'){
    dsh2.getRange(i, bnCol, 1, 1).setValue('');      // 模擬舊資料：品名是空的
  }
}
const gotN3 = X.getCountSession({sessionId: stN.sessionId});
const detF3 = (gotN3.items||[]).filter(function(x){ return x.sku === 'SKU-F'; })[0];
ck('舊場次接回來時也要補上品名', !!detF3 && detF3.baseName === '商品F（條碼表沒有）', detF3);
// 但不可以順手回寫試算表——這支是不拿鎖的讀取動作
let stillBlank = false;
for(let i = 2; i <= dsh2.getLastRow(); i++){
  if(String(dsh2.getRange(i, skuCol, 1, 1).getValue()||'').trim() === 'SKU-F'
     && !String(dsh2.getRange(i, bnCol, 1, 1).getValue()||'').trim()) stillBlank = true;
}
ck('不拿鎖的讀取不會回寫明細', stillBlank);
X.cancelCountSession({sessionId: stN.sessionId});

console.log('\n【品名補充表】「條碼轉品號」是 IMPORTRANGE 鏡像，手貼會把整張打成 #REF!');
// 所以新貨的品名另外放一張我們寫得了的表，疊在鏡像之後。
BACKEND._sheets[X.SHEET_NAME_PATCH] = makeSheet(X.SHEET_NAME_PATCH, [
  X.NAME_PATCH_HEADER,
  ['SKU-NEW', '新貨商品（倉地圖還沒同步）', '紅', 'ERP 有'],
  ['SKU-A',   '不該贏過上游的名字', '', '測優先序'],
  ['',        '沒品號的列要被跳過', '', ''],
]);
const pm = X.namePatchMap_();
ck('讀得到補充表', (pm['SKU-NEW']||{}).name === '新貨商品（倉地圖還沒同步）', pm['SKU-NEW']);
ck('沒品號的列跳過', pm[''] === undefined);
const bm = X.barcodeToSkuMap_();
ck('鏡像沒有的從補充表補上', (bm['SKU-NEW']||{}).name === '新貨商品（倉地圖還沒同步）', bm['SKU-NEW']);
// 上游優先：等「國際碼對照表」補齊了，補充表要自動退場，
// 不然兩個版本的品名會打架，而且沒人會記得回頭清補充表。
ck('上游有的不被補充表贏過', (bm['SKU-A']||{}).name === '商品A', bm['SKU-A']);
// 實際掃一筆：條碼表、庫存表都沒有，只有補充表有
const stP = X.startCountSession({store:'秀山莊-中華門市', counterId:'07', counterName:'新貨'});
const rP = X.countScanBatch({sessionId: stP.sessionId, ops:[{code:'SKU-NEW', qty:1}]});
ck('掃新貨時畫面上有品名',
   ((rP.results||[])[0]||{}).name === '新貨商品（倉地圖還沒同步）', rP.results);
X.cancelCountSession({sessionId: stP.sessionId});
delete BACKEND._sheets[X.SHEET_NAME_PATCH];
ck('沒建補充表時不會壞', JSON.stringify(X.namePatchMap_()) === '{}');

console.log('\n【ERP 匯出檔】庫存表一週才更新一次，新進貨根本不在上面，對不了帳');
const STOCK_ID = X.STORE_STOCK_SOURCE_ID;
const D = (iso) => new Date(iso);
// 庫存表說中華 SKU-A=5、SKU-B=3；ERP 說 SKU-A=7，另外有一個庫存表根本沒有的新貨
ERP_FILES['xsz_zhonghua.csv'] = mkCsv(
  'sku,endQty\nSKU-A,7\nSKU-B,3\nSKU-ERPNEW,9\n', D('2026-10-16T04:15:00Z'));
FILE_MTIME[STOCK_ID] = D('2026-10-10T00:00:00Z');        // 庫存表是上週的

const e1 = X.erpStockSnapshot_('秀山莊-中華門市');
ck('讀得到 ERP 匯出檔', e1.ok === true && e1.rows === 3, e1);
ck('表頭有被跳過', e1.ok && e1.bySku['sku'] === undefined);
ck('數量有解對', e1.ok && e1.bySku['SKU-A'] === 7 && e1.bySku['SKU-ERPNEW'] === 9, e1.bySku);

clearMemo();
const sn1 = X.storeStockSnapshot_('秀山莊-中華門市');
console.log('   來源說明：', sn1.sourceNote);
ck('ERP 較新時蓋過庫存表', sn1.bySku['SKU-A'].expected === 7, sn1.bySku['SKU-A']);
ck('庫存表沒有的新貨被補上', (sn1.bySku['SKU-ERPNEW']||{}).expected === 9, sn1.bySku['SKU-ERPNEW']);
ck('新貨標記來自 ERP', sn1.bySku['SKU-ERPNEW'].fromErp === true);
ck('數字一樣的不算覆寫', sn1.bySku['SKU-B'].fromErp === undefined, sn1.bySku['SKU-B']);
ck('來源記在 expectedSource', /ERP/.test(sn1.expectedSource||''), sn1.expectedSource);
ck('來源說明兩邊時間都有', /庫存表/.test(sn1.sourceNote) && /ERP/.test(sn1.sourceNote), sn1.sourceNote);

// 實際跑一場：新貨要能算出差異，而不是「庫存表查無此品號」
const stE = X.startCountSession({store:'秀山莊-中華門市', counterId:'08', counterName:'ERP'});
X.countScanBatch({sessionId: stE.sessionId, ops:[{code:'SKU-ERPNEW', qty:6}, {code:'SKU-A', qty:7}]});
const finE = X.finishCountSession({sessionId: stE.sessionId});
ck('結束得了', finE.ok === true, finE);
const dE = {};
BACKEND.getSheetByName(X.SHEET_COUNT_DETAIL)._rows.forEach(function(r){
  if(r[0] === stE.sessionId) dE[r[2]] = r;
});
const iRes = X.COUNT_DETAIL_HEADER.indexOf('countResult');
const iExp = X.COUNT_DETAIL_HEADER.indexOf('countExpected');
const iDif = X.COUNT_DETAIL_HEADER.indexOf('countDiff');
const iOsE = X.COUNT_DETAIL_HEADER.indexOf('otherStock');
ck('新貨不再是「查無此品號」', dE['SKU-ERPNEW'][iRes] === '盤虧', dE['SKU-ERPNEW'][iRes]);
ck('新貨的帳上數量來自 ERP', dE['SKU-ERPNEW'][iExp] === 9, dE['SKU-ERPNEW'][iExp]);
ck('新貨的差異算得出來', dE['SKU-ERPNEW'][iDif] === -3, dE['SKU-ERPNEW'][iDif]);
// 這一格不可以講「其他據點都沒有庫存」——CSV 只有這家店，別家是「不明」
ck('別家庫存要說不明而不是沒有',
   /不明/.test(dE['SKU-ERPNEW'][iOsE]) && !/都沒有庫存/.test(dE['SKU-ERPNEW'][iOsE]), dE['SKU-ERPNEW'][iOsE]);
ck('SKU-A 用 ERP 的 7 對帳所以相符', dE['SKU-A'][iRes] === '相符', dE['SKU-A'][iRes]);
// 用了哪個來源要留在場次備註裡，不然事後沒人追得回來
const sesE = X.getCountSession({sessionId: stE.sessionId});
ck('場次備註記下來源', /帳上數量來源/.test(String(sesE.session.note||'')), sesE.session.note);
ck('結束回應也帶來源', /ERP/.test(String(finE['帳上數量來源']||'')), finE['帳上數量來源']);

// 反過來：庫存表比較新時，ERP 不可以蓋掉它，但缺的還是要補
FILE_MTIME[STOCK_ID] = D('2026-10-17T00:00:00Z');
clearMemo();
const sn2 = X.storeStockSnapshot_('秀山莊-中華門市');
ck('庫存表較新時不被 ERP 蓋過', sn2.bySku['SKU-A'].expected === 5, sn2.bySku['SKU-A']);
ck('但庫存表沒有的還是要補', (sn2.bySku['SKU-ERPNEW']||{}).expected === 9, sn2.bySku['SKU-ERPNEW']);
ck('expectedSource 改指庫存表', !/ERP/.test(sn2.expectedSource||''), sn2.expectedSource);

// 匯出檔太舊要大聲講——自動排程默默停掉是這套系統真的發生過的事
ERP_FILES['xsz_zhonghua.csv'] = mkCsv('sku,endQty\nSKU-A,7\n', D('2026-01-01T00:00:00Z'));
FILE_MTIME[STOCK_ID] = null;
clearMemo();
const sn3 = X.storeStockSnapshot_('秀山莊-中華門市');
ck('來源太舊時有警告', /天沒更新/.test(sn3.sourceNote||''), sn3.sourceNote);

// 沒有匯出檔也要能跑，只是退回只用庫存表
ERP_FILES = {};
clearMemo();
const sn4 = X.storeStockSnapshot_('秀山莊-中華門市');
ck('沒匯出檔時退回庫存表', sn4.ok === true && sn4.bySku['SKU-A'].expected === 5, sn4.bySku['SKU-A']);
ck('並且說清楚為什麼沒用到', /沒用到/.test(sn4.sourceNote||''), sn4.sourceNote);

console.log(fail ? '\n有 '+fail+' 項失敗' : '\n全部通過：欄位對照、跨批累加、同批重複掃、手改數量、一店多欄加總、場次隔離、作廢場次、掃描當下補品名、品名補充表、ERP 匯出檔疊合、來源挑選與備援');
process.exit(fail?1:0);
