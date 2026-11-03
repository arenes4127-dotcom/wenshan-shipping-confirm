// 調撥單／驗收紀錄歸檔的離線測試台
//
// 用法：cp Code.gs /tmp/CodeRun.js && node tests/transfer_archive_harness.js /tmp/CodeRun.js
//
// 這支程式會刪資料，而這個系統在歸檔上被咬過太多次（deleteRows 靜默失效查了兩週、
// 備份檔差一步被覆蓋、SpreadsheetApp.create() 偷換作用中試算表）。所以不是看語法過
// 就算數，要真的組一張假表、真的跑一次、逐格驗收搬對了沒、不該搬的有沒有被動到。
const fs = require('fs'), vm = require('vm');

function makeSheet(name, rows){
  return {
    _name: name, _rows: rows.map(r => r.slice()),
    getName(){ return this._name; },
    getLastRow(){ let last = 0; this._rows.forEach((r,i)=>{ if(r.some(v=>String(v==null?'':v)!=='')) last=i+1; }); return last; },
    getLastColumn(){ return Math.max.apply(null, this._rows.map(r=>r.length).concat([1])); },
    getMaxRows(){ return this._rows.length; },
    getParent(){ return null; },
    appendRow(v){ this._rows.push(v.slice()); },
    getDataRange(){ return this.getRange(1,1,this._rows.length,this.getLastColumn()); },
    getRange(r,c,nr,nc){
      nr = nr==null?1:nr; nc = nc==null?1:nc;
      const sh = this;
      return {
        getValues(){ const o=[]; for(let i=0;i<nr;i++){ const row=sh._rows[r-1+i]||[]; const t=[];
          for(let j=0;j<nc;j++) t.push(row[c-1+j]===undefined?'':row[c-1+j]); o.push(t);} return o; },
        getValue(){ return this.getValues()[0][0]; },
        setValues(vals){ for(let i=0;i<vals.length;i++){ while(sh._rows.length < r-1+i+1) sh._rows.push([]);
          if(!sh._rows[r-1+i]) sh._rows[r-1+i]=[];
          for(let j=0;j<vals[i].length;j++) sh._rows[r-1+i][c-1+j]=vals[i][j]; } return this; },
        setValue(v){ return this.setValues([[v]]); },
        clearContent(){ for(let i=0;i<nr;i++){ const row=sh._rows[r-1+i]; if(!row) continue;
          for(let j=0;j<nc;j++) row[c-1+j]=''; } return this; },
        setNumberFormat(){ return this; }, setNote(){ return this; },
        setFontWeight(){ return this; }, setDataValidation(){ return this; },
        setFormula(){ return this; }, getA1Notation(){ return 'R'+r+'C'+c; },
      };
    },
    deleteRow(st){ this._rows.splice(st-1,1); },
    deleteRows(st,n){ this._rows.splice(st-1, n==null?1:n); },
    setName(n){ this._name=n; }, getSheetId(){ return 1; }, getProtections(){ return []; },
    _formulas:{}, clear(){ this._rows=[]; }, clearConditionalFormatRules(){},
    setFrozenRows(){}, setColumnWidth(){},
  };
}
function makeSS(name, sheets){
  return { _name:name, _sheets:sheets, getName:()=>name, getId:()=>'ss-'+name,
    getSheetByName(n){ return this._sheets[n] || null; },
    getSheets(){ return Object.keys(this._sheets).map(k=>this._sheets[k]); },
    insertSheet(n){ this._sheets[n] = makeSheet(n, []); return this._sheets[n]; },
    getSpreadsheetTimeZone(){ return 'Asia/Taipei'; }, getNumSheets(){ return 1; } };
}

let SS = null;
const createdFiles = [];     // 備份檔：名字 + 真的被寫進去的內容
const log = [];
const sandbox = {
  console,
  Logger: { log: m => log.push(String(m)) },
  Session: { getEffectiveUser: () => ({ getEmail: () => 't@e.com' }) },
  Utilities: { formatDate: () => '2026_11_03', sleep(){}, base64Encode: x=>String(x),
               parseCsv: t => String(t||'').split(/\r?\n/).filter(l=>l!=='').map(l=>l.split(',')) },
  CacheService: { getScriptCache: () => ({ get:()=>null, put(){}, remove(){}, getAll:()=>({}), putAll(){}, removeAll(){} }) },
  LockService: { getScriptLock: () => ({ tryLock:()=>true, releaseLock(){}, waitLock(){} }) },
  ScriptApp: { getProjectTriggers:()=>[], WeekDay:{MONDAY:1}, TriggerSource:{CLOCK:'CLOCK'} },
  UrlFetchApp: { fetch: ()=>({ getContentText:()=>'{}', getResponseCode:()=>200 }) },
  ContentService: { createTextOutput: t=>({ setMimeType: ()=>t }), MimeType:{JSON:'json'} },
  HtmlService: {}, MimeType: { CSV:'text/csv', PLAIN_TEXT:'text/plain', HTML:'text/html' },
  DriveApp: {
    // 檔名重複檢查要真的有作用：同一天跑第二批時必須換名字，不能覆蓋第一批
    getFolderById: () => ({
      getFilesByName: (n) => { const hit = createdFiles.some(f => f.name === n);
        return { hasNext: () => hit, next(){ return {}; } }; },
      addFile(){}, createFile: () => ({ getId:()=>'f', getUrl:()=>'u', setTrashed(){} }) }),
    getFileById: () => ({ setTrashed(){}, getId:()=>'f' }),
    getRootFolder: () => ({ removeFile(){} }),
  },
  SpreadsheetApp: {
    getActiveSpreadsheet: () => SS,
    // create() 會偷換作用中試算表——這是真實行為，一定要重現，
    // 不然就測不出「建完備份忘了切回來」那個咬過人的 bug
    setActiveSpreadsheet: s => { SS = s; },
    openById: () => SS,
    flush(){},
    create(name){
      const sh = makeSheet('Sheet1', []);
      const rec = { name: name, sheet: sh };
      createdFiles.push(rec);
      const s = makeSS(name, {});
      s._sheets['Sheet1'] = sh;
      s.getSheets = () => [sh];
      s.getId = () => 'new-' + name;
      SS = s;                               // ← 真的偷換
      return s;
    },
    ProtectionType: { SHEET:'SHEET', RANGE:'RANGE' },
    DataValidation: {}, newDataValidation: ()=>({ requireValueInList: ()=>({ setAllowInvalid: ()=>({ build: ()=>({}) }) }) }),
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const src = fs.readFileSync(process.argv[2], 'utf8')
  + "\n;globalThis.__x = {TRANSFER_HEADER, TRANSFERLOG_HEADER, SHEET_TRANSFER, SHEET_TRANSFERLOG,"
  + " archiveTransferDone_, archiveTransferLog_, parseRowStamp_, getTransferPending,"
  + " TRANSFER_ARCHIVE_KEEP_DAYS, TRANSFERLOG_ARCHIVE_KEEP_DAYS};\n";
vm.runInContext(src, sandbox, { filename: 'Code.gs' });
const X = sandbox.__x;

let fail = 0;
const ck = (id, cond, extra) => { if(!cond){ console.log('  FAIL', id, extra===undefined?'':JSON.stringify(extra)); fail++; } else console.log('  ok  ', id); };
const TH = X.TRANSFER_HEADER, LH = X.TRANSFERLOG_HEADER;
const daysAgo = n => {
  const d = new Date(Date.now() - n*86400000);
  const p = x => String(x).padStart(2,'0');
  return d.getFullYear()+'/'+p(d.getMonth()+1)+'/'+p(d.getDate())+' 10:00:00';
};
const trow = (o) => TH.map(h => o[h] === undefined ? '' : o[h]);
const lrow = (o) => LH.map(h => o[h] === undefined ? '' : o[h]);

console.log('【調撥單歸檔】只搬「已驗收且超過 3 天」的，其他一列都不准動');
const transfer = makeSheet(X.SHEET_TRANSFER, [TH.slice(),
  trow({batchId:'B1', sku:'OLD-1', status:'done',      doneAt: daysAgo(10), qty:1}),
  trow({batchId:'B1', sku:'OPEN-1', status:'open',     doneAt: '',          qty:2}),
  trow({batchId:'B2', sku:'OLD-2', status:'done',      doneAt: daysAgo(4),  qty:3}),
  trow({batchId:'B3', sku:'NEW-1', status:'done',      doneAt: daysAgo(1),  qty:4}),
  trow({batchId:'B4', sku:'CANC-1', status:'cancelled',doneAt: daysAgo(9),  qty:5}),
  trow({batchId:'B5', sku:'BADDATE', status:'done',    doneAt: '不知道什麼時候', qty:6}),
  trow({batchId:'B6', sku:'OLD-3', status:'done',      doneAt: daysAgo(3.5),qty:7}),
]);
const tlog = makeSheet(X.SHEET_TRANSFERLOG, [LH.slice(),
  lrow({logTime: daysAgo(20), batchId:'B1', sku:'OLD-1', checkResult:'matched'}),
  lrow({logTime: daysAgo(11), batchId:'B2', sku:'OLD-2', checkResult:'matched'}),
  lrow({logTime: daysAgo(2),  batchId:'B3', sku:'NEW-1', checkResult:'matched'}),
]);
SS = makeSS('文山出貨確認系統-後端', {});
SS._sheets[X.SHEET_TRANSFER] = transfer;
SS._sheets[X.SHEET_TRANSFERLOG] = tlog;
const HOME = SS;

const r1 = X.archiveTransferDone_();
console.log('   回傳：', JSON.stringify(r1));
ck('搬了 3 筆（10天/4天/3.5天前驗收的）', r1.歸檔 === 3, r1);
ck('沒有剩下待歸檔', r1.剩餘待歸檔 === 0, r1);
ck('建完備份有切回原本的試算表', SpreadsheetAppActive() === HOME, SpreadsheetAppActive() && SpreadsheetAppActive().getName());
function SpreadsheetAppActive(){ return SS; }

const left = transfer._rows.slice(1).filter(r => String(r[0]||'') !== '').map(r => r[TH.indexOf('sku')]);
console.log('   留下來的：', JSON.stringify(left));
ck('open 的留著', left.indexOf('OPEN-1') >= 0, left);
ck('1 天前驗收的留著（沒滿 3 天）', left.indexOf('NEW-1') >= 0, left);
ck('cancelled 不碰', left.indexOf('CANC-1') >= 0, left);
ck('日期看不懂的留著，不猜', left.indexOf('BADDATE') >= 0, left);
ck('舊的三筆都走了', ['OLD-1','OLD-2','OLD-3'].every(s => left.indexOf(s) < 0), left);
ck('剩下正好 4 列', left.length === 4, left);

const bk = createdFiles[createdFiles.length-1];
const bkSkus = bk.sheet._rows.slice(1).map(r => r[TH.indexOf('sku')]);
console.log('   備份檔：', bk.name, JSON.stringify(bkSkus));
ck('備份檔名帶日期與用途', /2026_11_03_調撥單歸檔/.test(bk.name), bk.name);
ck('備份內容就是被搬走的那三筆', bkSkus.sort().join(',') === 'OLD-1,OLD-2,OLD-3', bkSkus);
ck('備份有寫表頭', String(bk.sheet._rows[0][0]) === TH[0], bk.sheet._rows[0]);

console.log('\n【驗收紀錄歸檔】留 10 天');
const r2 = X.archiveTransferLog_();
console.log('   回傳：', JSON.stringify(r2));
ck('搬了 2 筆（20天/11天前的）', r2.歸檔 === 2, r2);
const leftLog = tlog._rows.slice(1).filter(r => String(r[0]||'') !== '').map(r => r[LH.indexOf('sku')]);
ck('2 天前的留著', leftLog.length === 1 && leftLog[0] === 'NEW-1', leftLog);

console.log('\n【同一天跑第二次】不能覆蓋第一批的備份，也不能重複搬');
const before = createdFiles.length;
const r3 = X.archiveTransferDone_();
ck('沒東西可搬時不建檔案', r3.歸檔 === 0 && createdFiles.length === before, r3);
// 再塞一筆舊的進去，第二批必須換檔名
transfer._rows.push(trow({batchId:'B7', sku:'OLD-4', status:'done', doneAt: daysAgo(8), qty:8}));
const r4 = X.archiveTransferDone_();
ck('第二批搬得動', r4.歸檔 === 1, r4);
ck('第二批換了檔名、沒有覆蓋第一批',
   /第2批/.test(createdFiles[createdFiles.length-1].name), createdFiles.map(f=>f.name));

console.log('\n【getTransferPending 不受影響】歸檔只動已完成的舊列');
const pend = X.getTransferPending();
const pendSkus = (pend.items||[]).map(i => i.sku);
ck('待驗收清單還是看得到 OPEN-1', pendSkus.indexOf('OPEN-1') >= 0, pendSkus);

console.log('\n【日期解析】解不出來一律不歸檔');
ck('Date 物件', !isNaN(X.parseRowStamp_(new Date())));
ck('2026/11/03 14:05:01', !isNaN(X.parseRowStamp_('2026/11/03 14:05:01')));
ck('ISO 字串', !isNaN(X.parseRowStamp_('2026-11-03T06:05:01.000Z')));
ck('只有日期沒有時間', !isNaN(X.parseRowStamp_('2026/11/03')));
ck('空字串 → NaN', isNaN(X.parseRowStamp_('')));
ck('亂寫 → NaN', isNaN(X.parseRowStamp_('不知道什麼時候')));

console.log(fail ? '\n有 '+fail+' 項失敗' : '\n全部通過：只搬該搬的、備份內容正確、不覆蓋舊備份、待驗收清單不受影響');
process.exit(fail?1:0);
