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
                       '中華門市倉','門外漢門市倉','網購庫存倉','總倉'];
const cacheRows = [CACHE_HEADER2];   // 山物倉地圖／庫存表：第1列表頭、第2列起資料
// 門市對照（使用者提供）：D=士林、E=台中、G=中華、H=台南
//            品號     品名    規格   D  E  F  G  H   I   J
cacheRows.push(['SKU-A','商品A','紅', 0, 1, 0, 5, 2, 10,  3]);  // 中華5、台南2、台中1
cacheRows.push(['SKU-B','商品B','藍', 0, 0, 0, 3, 0,  0,  0]);  // 中華3、台南0
cacheRows.push(['SKU-C','商品C','黑', 0, 0, 0, 0, 7,  0,  0]);  // 中華0、台南7
cacheRows.push(['SKU-D','商品D','白', 0, 1, 0, 4, 1,  0,  0]);  // 中華4、台南1
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
]);

let BACKEND = null, CACHE_SS = null, stampSeq = 1;
const log = [];
const sandbox = {
  console,
  Logger: { log: m => log.push(String(m)) },
  Session: { getEffectiveUser: () => ({ getEmail: () => 't@e.com' }) },
  Utilities: { formatDate: (d,tz,f) => '20261015-1015' + String(stampSeq++).padStart(2,'0'), sleep(){} },
  CacheService: { getScriptCache: () => ({ get:()=>null, put(){}, remove(){}, getAll:()=>({}), putAll(){}, removeAll(){} }) },
  LockService: { getScriptLock: () => ({ tryLock:()=>true, releaseLock(){}, waitLock(){} }) },
  ScriptApp: { getProjectTriggers:()=>[], WeekDay:{MONDAY:1}, TriggerSource:{CLOCK:'CLOCK'} },
  UrlFetchApp: { fetch: ()=>({ getContentText:()=>'{}', getResponseCode:()=>200 }) },
  ContentService: { createTextOutput: t=>({ setMimeType: ()=>t }), MimeType:{JSON:'json'} },
  HtmlService: {}, MimeType: { CSV:'text/csv', PLAIN_TEXT:'text/plain', HTML:'text/html' },
  DriveApp: { getFolderById:()=>({ getFilesByName:()=>({hasNext:()=>false}), addFile(){} }),
              getFileById:()=>({ setTrashed(){} }), getRootFolder:()=>({ removeFile(){} }) },
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
  + " getCountSession, listCountSessions, STORE_LIST, STORE_DEFS, storeDef_,"
  + " openStoreStockSheet_, storeStockSnapshot_, _ssMemo_,"
  + " setupCountDiffSheet_, SHEET_COUNT_DIFF,"
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
ck('讀得到庫存（不是空的）', snapChk.ok && snapChk.withStock.length === 3, snapChk.ok && snapChk.withStock);

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
ck('未盤到 1 筆（SKU-D）', fin['未盤到'] === 1, fin['未盤到']);
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

console.log('\n【預設不列未盤到】只盤一區卻列出整店未盤到 = 一張假盤虧表');
const st3 = X.startCountSession({store:'秀山莊-中華門市', counterId:'03', counterName:'小美'});
X.countScanBatch({sessionId: st3.sessionId, ops:[{code:'SKU-A', qty:5}]});
const fin3 = X.finishCountSession({sessionId: st3.sessionId});   // 不傳 includeUnscanned
console.log('  回傳：', JSON.stringify(fin3));
ck('預設不列未盤到', fin3['未盤到'] === 0, fin3['未盤到']);
ck('但仍誠實回報有幾個沒掃到', fin3['庫存表中沒被掃到的品項總數'] === 2, fin3['庫存表中沒被掃到的品項總數']);
ck('有列出未盤到嗎=false', fin3['有列出未盤到嗎'] === false);
const d3 = {};
det._rows.slice(1).forEach(row=>{ if(row[0]===st3.sessionId && row[iSku]) d3[row[iSku]] = row; });
ck('明細只有掃到的那一筆', Object.keys(d3).length === 1 && d3['SKU-A'], Object.keys(d3));
ck('掃到的那筆仍然有對帳（應5實5相符）', d3['SKU-A'][iEx]===5 && d3['SKU-A'][iRs]==='相符', d3['SKU-A']);

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

console.log(fail ? '\n有 '+fail+' 項失敗' : '\n全部通過：欄位對照、跨批累加、同批重複掃、手改數量、一店多欄加總、場次隔離、來源挑選與備援');
process.exit(fail?1:0);
