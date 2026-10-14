// 歸檔流程的離線測試台
//
// 用法（在專案資料夾裡）：
//   cp Code.gs /tmp/CodeRun.js && node tests/archive_harness.js /tmp/CodeRun.js
//
// 為什麼需要這個：node --check 只檢查語法。2026-10-14 我在重構 archiveShippedOrders_
// 時把 `const lastRowBefore = ...` 那一行連同舊程式碼一起刪掉，語法檢查完全過關，
// 部署到現場才炸出 ReferenceError。這支會用假的 Apps Script 服務把整份 Code.gs
// 載進來、組一張 1,452 列的假「訂單」分頁、真的呼叫一次 archiveShippedOrders_，
// 然後驗收：歸檔筆數、剩餘筆數、lastRow、被歸檔的訂單不該留在表上、沒有空白訂單號。
//
// 假環境只模擬這條路徑會用到的 API，不是完整的 Apps Script 模擬器。它抓得到
// 「程式自己的錯」（未定義變數、範圍算錯、欄位對不上、保留/清除的列算錯），
// 抓不到「真實試算表環境的怪異行為」——例如這次纏鬥很久的 deleteRows 靜默失效，
// 那種只有在真的試算表上跑才會現形。

// 用假的 Apps Script 服務把整份 Code.gs 載進來，真的呼叫 archiveShippedOrders_。
// 目的：抓 node --check 抓不到的執行期錯誤（未定義變數、範圍算錯、欄位對不上）。
const fs = require('fs');
const vm = require('vm');

function makeSheet(name, header, dataRows){
  return {
    _name: name, _rows: [header.slice()].concat(dataRows.map(r=>r.slice())), _maxCols: header.length,
    getName(){ return this._name; },
    getSheetId(){ return 1; },
    getParent(){ return SS; },
    getLastRow(){ let last=0; this._rows.forEach((r,i)=>{ if(r.some(v=>String(v||'')!=='')) last=i+1; }); return last; },
    getLastColumn(){ return this._maxCols; },
    getMaxRows(){ return this._rows.length; },
    getDataRange(){ return this.getRange(1,1,this._rows.length,this._maxCols); },
    insertSheet(){ throw new Error('not used'); },
    getRange(r, c, nr, nc){
      nr = nr==null?1:nr; nc = nc==null?1:nc;
      const sh = this;
      return {
        getValues(){ const o=[]; for(let i=0;i<nr;i++){ const row=sh._rows[r-1+i]||[]; const out=[];
            for(let j=0;j<nc;j++) out.push(row[c-1+j]===undefined?'':row[c-1+j]); o.push(out);} return o; },
        getValue(){ return this.getValues()[0][0]; },
        getDisplayValue(){ return String(this.getValue()); },
        setValues(vals){ for(let i=0;i<vals.length;i++){ while(sh._rows.length < r-1+i+1) sh._rows.push([]);
            for(let j=0;j<vals[i].length;j++) sh._rows[r-1+i][c-1+j]=vals[i][j]; } return this; },
        setValue(v){ return this.setValues([[v]]); },
        clearContent(){ for(let i=0;i<nr;i++){ const row=sh._rows[r-1+i]; if(!row) continue;
            for(let j=0;j<nc;j++) row[c-1+j]=''; } return this; },
        setNumberFormat(){ return this; }, setNote(){ return this; }, getA1Notation(){ return 'R'+r+'C'+c; },
        setDataValidation(){ return this; }, setBackground(){ return this; },
      };
    },
    deleteRows(start, count){ this._rows.splice(start-1, count==null?1:count); },
    deleteRow(r){ this._rows.splice(r-1,1); },
    insertRowsAfter(){ }, insertRowsBefore(){ },
    clearContents(){ this._rows = [this._rows[0]]; },
    getConditionalFormatRules(){ return []; }, setConditionalFormatRules(){ },
    getProtections(){ return []; }, setName(n){ this._name=n; },
  };
}
let SS = null;
const created = [];
const log = [];
const sandbox = {
  console,
  Logger: { log: m => log.push(String(m)) },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'test@example.com' }) },
  Utilities: { formatDate: () => '2026_10_14', sleep(){}, base64Encode: x=>String(x) },
  CacheService: { getScriptCache: () => ({ get:()=>null, put(){}, remove(){}, getAll:()=>({}), putAll(){}, removeAll(){} }) },
  LockService: { getScriptLock: () => ({ tryLock: ()=>true, releaseLock(){}, waitLock(){} }) },
  ScriptApp: { getProjectTriggers: ()=>[], newTrigger: ()=>({timeBased:()=>({atHour:()=>({nearMinute:()=>({everyDays:()=>({create(){}})})})})}),
               deleteTrigger(){}, WeekDay:{MONDAY:1}, TriggerSource:{CLOCK:'CLOCK'} },
  UrlFetchApp: { fetch: ()=>({ getContentText: ()=>'{}', getResponseCode: ()=>200 }) },
  ContentService: { createTextOutput: t=>({ setMimeType: ()=>t }), MimeType:{JSON:'json'} },
  HtmlService: {}, MimeType: { CSV:'text/csv', PLAIN_TEXT:'text/plain', HTML:'text/html' },
  DriveApp: {
    getFolderById: () => ({ getFilesByName: () => ({ hasNext: () => false, next(){ throw new Error('none'); } }),
                            addFile(){}, createFile:()=>({ getId:()=>'f', getUrl:()=>'u', setTrashed(){} }) }),
    getFileById: () => ({ setTrashed(){}, getId: ()=>'f' }),
    getRootFolder: () => ({ removeFile(){} }),
  },
  SpreadsheetApp: {
    getActiveSpreadsheet: () => SS,
    setActiveSpreadsheet: s => { SS = s; },
    openById: () => SS,
    flush(){},
    create(name){ const s = { _name:name, getName:()=>name, getId:()=>'new', getSheets:()=>[makeSheet('Sheet1',[],[])] };
                  created.push(name); return s; },
    ProtectionType: { SHEET:'SHEET', RANGE:'RANGE' },
    DataValidation: {}, newDataValidation: ()=>({ requireValueInList: ()=>({ setAllowInvalid: ()=>({ build: ()=>({}) }) }) }),
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const src = fs.readFileSync(process.argv[2], 'utf8')
  + "\n;globalThis.__x = {ORDERS_HEADER, HEADER_LABELS, ARCHIVE_MAX_ROWS_PER_RUN,"
  + " archiveShippedOrders_, SHEET_ORDERS, SHIPPED_ORDER_RETENTION_DAYS};\n";
vm.runInContext(src, sandbox, { filename: 'Code.gs' });
const X = sandbox.__x;

// ---- 組一張假的「訂單」分頁 ----
const H = X.ORDERS_HEADER;
const iOrder = H.indexOf('orderNo'), iStatus = H.indexOf('status'), iUpd = H.indexOf('updatedAt');
const N = 1452, ARCHIVABLE = 516;
const data = [];
const oldTs = new Date(Date.now() - 10*86400*1000).toISOString();
for(let k=0;k<N;k++){
  const row = new Array(H.length).fill('');
  row[iOrder] = 'ORD' + (k+2);
  // 第 314~720 列（1-indexed 含標題）之間放 516 筆「可歸檔」
  const rowNum = k + 2;
  const archivable = rowNum >= 314 && rowNum < 314 + ARCHIVABLE;
  row[iStatus] = archivable ? '已出貨 🟢' : '待出貨';
  row[iUpd] = archivable ? oldTs : '';
  data.push(row);
}
const orders = makeSheet('訂單', H.map(h => X.HEADER_LABELS[h] || h), data);
const mirror = makeSheet('文山出貨V2', ['訂單'], [['NOT_IN_OUR_SHEET']]);
const detail = makeSheet('訂單明細', ['a','b','c','d','e'], []);
SS = { getName:()=>'文山出貨確認系統-後端', getId:()=>'ssid', getSpreadsheetTimeZone:()=>'Asia/Taipei',
       _sheets: {'訂單':orders, '文山出貨V2':mirror, '訂單明細':detail},
       getSheetByName(n){ return this._sheets[n] || null; },
       insertSheet(n){ const s = makeSheet(n, [], []); this._sheets[n]=s; return s; },
       getSheets(){ return Object.keys(this._sheets).map(k=>this._sheets[k]); } };

console.log('歸檔前 lastRow =', orders.getLastRow());
const res = X.archiveShippedOrders_();
console.log('回傳：', JSON.stringify(res, null, 2));
console.log('歸檔後 lastRow =', orders.getLastRow());
log.forEach(l => console.log('[Logger]', l.slice(0, 300)));

// 驗收
const expectArchived = Math.min(ARCHIVABLE, X.ARCHIVE_MAX_ROWS_PER_RUN);
const expectLastRow = 1453 - expectArchived;
let fail = 0;
const ck = (id, ok, extra) => { if(!ok){ console.log('FAIL', id, extra===undefined?'':extra); fail++; } };
ck('歸檔筆數', res && res.歸檔 === expectArchived, res && res.歸檔);
ck('剩餘待歸檔', res && res.剩餘待歸檔 === ARCHIVABLE - expectArchived, res && res.剩餘待歸檔);
ck('lastRow', orders.getLastRow() === expectLastRow, orders.getLastRow() + ' 應為 ' + expectLastRow);
// 保留下來的不該有任何「可歸檔」的那批（ORD314~ORD(314+400-1)）
const left = [];
for(let r=2;r<=orders.getLastRow();r++) left.push(String(orders._rows[r-1][iOrder]||''));
let leaked = 0;
for(let k=0;k<expectArchived;k++) if(left.indexOf('ORD'+(314+k))>=0) leaked++;
ck('歸檔的訂單不應留在表上', leaked===0, '殘留 '+leaked+' 筆');
ck('保留筆數', left.length === expectLastRow-1, left.length);
ck('沒有空白訂單號', left.every(v=>v!==''), '有空白');
console.log(fail ? '\n有 '+fail+' 項失敗' : '\n全部通過：archiveShippedOrders_ 在假環境下真的跑完並搬對了');
process.exit(fail?1:0);
