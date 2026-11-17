// 揀貨後端的離線測試台
//
// 用法：cp Code.gs /tmp/CodeRun.js && node tests/pick_harness.js /tmp/CodeRun.js
//
// 驗兩件事：
//   1. markPickedBatch 不再整張讀訂單表之後，寫到的還是對的那張單、對的欄位。
//   2. countPickEvents_ 改用 TextFinder 之後，數出來的次數跟原本整張讀一模一樣——
//      包括 TextFinder 不能用時的退路。
const fs = require('fs'), vm = require('vm');

const EVENTS = [];
function makeSheet(name, rows){
  const sh = {
    _name:name, _rows: rows.map(r=>r.slice()),
    getName(){ return this._name; },
    getLastRow(){ let last=0; this._rows.forEach((r,i)=>{ if(r.some(v=>String(v==null?'':v)!=='')) last=i+1; }); return last; },
    getLastColumn(){ return Math.max.apply(null, this._rows.map(r=>r.length).concat([1])); },
    getRange(r,c,nr,nc){
      nr=nr==null?1:nr; nc=nc==null?1:nc;
      const api = {
        getValues(){ EVENTS.push({t:'read', sheet:sh._name, r, c, nr, nc});
          const o=[]; for(let i=0;i<nr;i++){ const row=sh._rows[r-1+i]||[]; const t=[];
          for(let j=0;j<nc;j++) t.push(row[c-1+j]===undefined?'':row[c-1+j]); o.push(t);} return o; },
        getValue(){ return api.getValues()[0][0]; },
        setValues(v){ EVENTS.push({t:'write', sheet:sh._name, r, c});
          for(let i=0;i<v.length;i++){ while(sh._rows.length < r+i) sh._rows.push([]);
            const row = sh._rows[r-1+i]; for(let j=0;j<v[i].length;j++) row[c-1+j]=v[i][j]; } return api; },
        setValue(v){ return api.setValues([[v]]); },
        setNumberFormat(){ return api; }, setNote(){ return api; },
        createTextFinder(text){
          if(sh._noTextFinder) throw new Error('TextFinder 不能用（測試退路）');
          const tf = { _whole:false,
            matchEntireCell(b){ tf._whole = b; return tf; }, matchCase(){ return tf; },
            findAll(){ EVENTS.push({t:'find', sheet:sh._name});
              const out = [];
              for(let i=0;i<nr;i++){ const v = String((sh._rows[r-1+i]||[])[c-1] ?? '');
                if(tf._whole ? v === text : v.indexOf(text) >= 0) out.push({getRow: () => r + i}); }
              return out; } };
          return tf;
        },
      };
      return api;
    },
    appendRow(v){ this._rows.push(v.slice()); },
    getProtections(){ return []; }, setName(n){ this._name=n; },
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
const SHEETS = {};
const BACKEND = { getSheetByName: n => SHEETS[n] || null, getSheets: () => Object.values(SHEETS),
  insertSheet: n => (SHEETS[n] = makeSheet(n, [])), getSpreadsheetTimeZone: () => 'Asia/Taipei', getName: () => 'be', getId: () => 'be' };
const sandbox = {
  console, Logger:{ log(){} },
  Session:{ getEffectiveUser: () => ({ getEmail: () => 't@e.com' }) },
  Utilities:{ formatDate: () => '2026/11/17 10:00:00', sleep(){} },
  CacheService:{ getScriptCache: () => scriptCache },
  LockService:{ getScriptLock: () => ({ tryLock:()=>true, releaseLock(){} }) },
  ScriptApp:{ getProjectTriggers:()=>[], WeekDay:{MONDAY:1}, TriggerSource:{CLOCK:'CLOCK'} },
  ContentService:{ createTextOutput: t=>({ setMimeType: ()=>t }), MimeType:{JSON:'json'} },
  HtmlService:{}, MimeType:{}, DriveApp:{},
  SpreadsheetApp:{ getActiveSpreadsheet: () => BACKEND, openById: () => BACKEND, flush(){} },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(process.argv[2],'utf8')
  + "\n;globalThis.__x = {ORDERS_HEADER, HEADER_LABELS, SHEET_ORDERS, SHEET_PICKLOG, PICKLOG_HEADER, statusToText, PICKLOG_TEXTFINDER_MIN_ROWS,"
  + " markPickedBatch, markPickDone, countPickEvents_, readOrderRows, diagnosePickTransfer, orderIndexCacheClear_};\n",
  sandbox, { filename:'Code.gs' });
const X = sandbox.__x;

let fail = 0;
const ck = (id, cond, extra) => { if(!cond){ console.log('  FAIL', id, extra===undefined?'':JSON.stringify(extra)); fail++; } else console.log('  ok  ', id); };

const H = X.ORDERS_HEADER, disp = H.map(h => X.HEADER_LABELS[h] || h);
const orderRow = o => H.map(h => o[h] === undefined ? '' : o[h]);
const items = JSON.stringify([{sku:'A', qty:1}, {sku:'B', qty:2}]);
function buildOrders(n){
  const rows = [disp];
  for(let i = 0; i < n; i++) rows.push(orderRow({orderNo:'N' + i, status: X.statusToText('pending'), itemsJson: items}));
  SHEETS[X.SHEET_ORDERS] = makeSheet(X.SHEET_ORDERS, rows);
  X.orderIndexCacheClear_();
  return SHEETS[X.SHEET_ORDERS];
}
const PH = X.PICKLOG_HEADER;
function plRow(orderNo, action){ const r = PH.map(()=> ''); r[PH.indexOf('orderNo')] = orderNo; r[PH.indexOf('action')] = action; r[PH.indexOf('logTime')] = '2026/11/17 上午9:00:00'; return r; }
function buildPickLog(list){ SHEETS[X.SHEET_PICKLOG] = makeSheet(X.SHEET_PICKLOG, [PH.slice()].concat(list.map(x => plRow(x[0], x[1])))); return SHEETS[X.SHEET_PICKLOG]; }

console.log('【點件送出】只讀動到的單，寫到對的單');
let osh = buildOrders(300);
buildPickLog([]);
EVENTS.length = 0;
let r = X.markPickedBatch([
  {orderNo:'N150', sku:'A', action:'pick', pickerId:'S1', pickerName:'甲', time:'2026/11/17 上午9:01:00'},
  {orderNo:'N150', sku:'B', action:'pick', pickerId:'S1', pickerName:'甲', time:'2026/11/17 上午9:01:05'},
  {orderNo:'N7',   sku:'A', action:'pick', pickerId:'S1', pickerName:'甲', time:'2026/11/17 上午9:02:00'},
  {orderNo:'NOPE', sku:'A', action:'pick', pickerId:'S1', pickerName:'甲', time:'2026/11/17 上午9:03:00'},
]);
ck('處理 3 筆、找不到 1 筆', r.ok && r.處理筆數 === 3 && r.找不到訂單 === 1, r);
const bigReads = EVENTS.filter(e => e.t === 'read' && e.sheet === X.SHEET_ORDERS && e.nr > 5 && e.nc > 1);
ck('沒有整張讀訂單表', bigReads.length === 0, bigReads);
let rows = X.readOrderRows();
const by = {}; rows.forEach(x => by[x.orderNo] = x);
ck('N150 的已揀品項是 A、B', Object.keys(JSON.parse(by.N150.pickedJson)).sort().join(',') === 'A,B', by.N150.pickedJson);
ck('N7 的已揀品項是 A', Object.keys(JSON.parse(by.N7.pickedJson)).join(',') === 'A', by.N7.pickedJson);
ck('揀貨開始時間記第一件的時間', by.N150.pickStartAt === '2026/11/17 上午9:01:00', by.N150.pickStartAt);
ck('其他單完全沒被動到', rows.filter(x => x.orderNo !== 'N150' && x.orderNo !== 'N7').every(x => !x.pickedJson && !x.pickStartAt));
ck('揀貨紀錄寫了 3 筆（找不到的那筆不寫）', SHEETS[X.SHEET_PICKLOG].getLastRow() === 4, SHEETS[X.SHEET_PICKLOG].getLastRow());

X.markPickedBatch([{orderNo:'N150', sku:'A', action:'unpick', pickerId:'S1', time:'2026/11/17 上午9:05:00'}]);
rows = X.readOrderRows(); rows.forEach(x => by[x.orderNo] = x);
ck('取消揀貨：A 拿掉、B 還在', Object.keys(JSON.parse(by.N150.pickedJson)).join(',') === 'B', by.N150.pickedJson);
ck('取消再揀不會把開始時間往後推', by.N150.pickStartAt === '2026/11/17 上午9:01:00', by.N150.pickStartAt);

console.log('\n【列號位移】歸檔刪過列之後，索引過期也不能寫到別張單');
X.markPickedBatch([{orderNo:'N200', sku:'A', action:'pick', pickerId:'S1', time:'t1'}]);   // 先讓索引快取起來
osh._rows.splice(1, 10);                                                                     // 前面 10 張被歸檔刪掉
X.markPickedBatch([{orderNo:'N200', sku:'B', action:'pick', pickerId:'S1', time:'t2'}]);
rows = X.readOrderRows(); rows.forEach(x => by[x.orderNo] = x);
ck('N200 拿到 A、B', Object.keys(JSON.parse(by.N200.pickedJson)).sort().join(',') === 'A,B', by.N200.pickedJson);
ck('位移後落在 N200 原本位置的 N210 沒被寫到', !by.N210.pickedJson, by.N210.pickedJson);

console.log('\n【揀貨完成】小表（現場實際 52 列）：直接讀一趟，不用 TextFinder');
const small = [];
for(let i = 0; i < 60; i++) small.push(['X' + (i % 20), i % 3 ? '揀貨' : '取消揀貨']);
small.push(['N150', '揀貨'], ['N150', '取消揀貨'], ['N150', '掃描不符'], ['N150', '取消揀貨'], ['N1500', '取消揀貨'], ['XN150', '掃描不符']);
let pl = buildPickLog(small);
EVENTS.length = 0;
r = X.countPickEvents_('N150');
ck('N150：取消 2 次、掃錯 1 次（不會把 N1500、XN150 算進來）', r.cancelCount === 2 && r.scanMiss === 1, r);
const plReads = EVENTS.filter(e => e.t === 'read' && e.sheet === X.SHEET_PICKLOG && e.nr > 1);
ck('只讀一趟', plReads.length === 1, plReads);
ck('只讀訂單號～動作那一段欄位，不是整張 12 欄', plReads[0] && plReads[0].nc < X.PICKLOG_HEADER.length, plReads);
ck('小表不用 TextFinder（它有固定成本，小表反而慢）', !EVENTS.some(e => e.t === 'find'));
r = X.countPickEvents_('NOT-THERE');
ck('沒有紀錄的單回 0/0', r.cancelCount === 0 && r.scanMiss === 0, r);

console.log('\n【揀貨完成】大表（超過門檻）：改用 TextFinder，結果一樣');
const big = [];
for(let i = 0; i < 5200; i++) big.push(['X' + (i % 400), i % 3 ? '揀貨' : '取消揀貨']);
big.push(['N150', '揀貨'], ['N150', '取消揀貨'], ['N150', '掃描不符'], ['N150', '取消揀貨'], ['N1500', '取消揀貨'], ['XN150', '掃描不符']);
pl = buildPickLog(big);
EVENTS.length = 0;
r = X.countPickEvents_('N150');
ck('結果一樣：取消 2、掃錯 1', r.cancelCount === 2 && r.scanMiss === 1, r);
ck('用了 TextFinder', EVENTS.some(e => e.t === 'find'));
ck('沒有把整欄拉回來', !EVENTS.some(e => e.t === 'read' && e.sheet === X.SHEET_PICKLOG && e.nr > 50), EVENTS.filter(e=>e.t==='read'));
pl._noTextFinder = true;
r = X.countPickEvents_('N150');
ck('TextFinder 不能用時退回直接讀，結果一樣', r.cancelCount === 2 && r.scanMiss === 1, r);
pl._noTextFinder = false;

console.log('\n【揀貨完成】整支跑一次');
buildOrders(50); buildPickLog([['N5','揀貨'],['N5','取消揀貨'],['N5','掃描不符']]);
r = X.markPickDone({orderNo:'N5', pickerId:'S1', pickerName:'甲', time:'2026/11/17 上午10:00:00', unpicked:0, transferPending:0});
ck('成功', r.ok === true, r);
ck('差異明細有算到取消 1 次、掃錯 1 次', r.差異明細 === '取消揀貨 1 次；掃到不屬於此單 1 次', r.差異明細);
rows = X.readOrderRows();
ck('訂單上記了揀貨完成時間與人', rows[5].pickDoneAt === '2026/11/17 上午10:00:00' && rows[5].pickDoneBy === '甲', rows[5]);

console.log('\n【診斷】只讀，跑得完，兩種算法一致，樣本挑還在訂單表裡的');
buildOrders(30); buildPickLog([['N3','揀貨'],['N3','取消揀貨'],['ARCHIVED-1','揀貨']]);   // 最後一筆是已歸檔的單
EVENTS.length = 0;
let txt = '';
try{ txt = X.diagnosePickTransfer(); }catch(e){ txt = 'ERR ' + e.message; }
ck('跑得完', txt.indexOf('揀貨／調撥效能診斷') === 0, txt);
ck('取消次數兩種算法一致', txt.indexOf('一樣，OK') >= 0, txt);
ck('不會挑到已歸檔的單', txt.indexOf('樣本訂單：N3') >= 0 && txt.indexOf('ARCHIVED-1') < 0, txt.split('\n').slice(0,6));
ck('冷、熱索引分開量，而且都找得到', /索引剛過期.*\d+ ms/.test(txt) && /索引熱的.*\d+ ms/.test(txt) && txt.indexOf('找不到這張單') < 0, txt);
ck('沒有寫入任何東西', !EVENTS.some(e => e.t === 'write'), EVENTS.filter(e => e.t === 'write'));

console.log(fail ? '\n有 '+fail+' 項失敗' : '\n全部通過：只讀動到的單、位移不寫錯、次數跟整張讀一致、退路有效、診斷只讀');
process.exit(fail?1:0);
