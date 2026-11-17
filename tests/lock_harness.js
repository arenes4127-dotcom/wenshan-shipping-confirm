// 鎖行為的離線測試台
//
// 用法：cp Code.gs /tmp/CodeRun.js && node tests/lock_harness.js /tmp/CodeRun.js
//
// 這裡驗的不是「功能對不對」，是「鎖是不是在該放的時候真的放了」。
// 那種錯在正式環境不會報錯，只會讓現場的人偶爾等不到鎖——也就是這整件事的起因。
const fs = require('fs'), vm = require('vm');

function makeSheet(name, rows){
  const sh = {
    _name:name, _rows: rows.map(r=>r.slice()), _reads:0, _lastReadCols:0,
    getName(){ return this._name; },
    getLastRow(){ let last=0; this._rows.forEach((r,i)=>{ if(r.some(v=>String(v==null?'':v)!=='')) last=i+1; }); return last; },
    getLastColumn(){ return Math.max.apply(null, this._rows.map(r=>r.length).concat([1])); },
    getDataRange(){ return this.getRange(1,1,Math.max(this.getLastRow(),1),this.getLastColumn()); },
    getRange(r,c,nr,nc){
      nr=nr==null?1:nr; nc=nc==null?1:nc;
      const api = {
        getValues(){ sh._reads++; sh._lastReadCols = nc; EVENTS.push({t:'read', sheet:sh._name, held:LOCK.held, cols:nc, rows:nr});
          const o=[]; for(let i=0;i<nr;i++){ const row=sh._rows[r-1+i]||[]; const t=[];
          for(let j=0;j<nc;j++) t.push(row[c-1+j]===undefined?'':row[c-1+j]); o.push(t);} return o; },
        getValue(){ return api.getValues()[0][0]; },
        setValues(v){ EVENTS.push({t:'write', sheet:sh._name, held:LOCK.held});
          for(let i=0;i<v.length;i++){ while(sh._rows.length < r+i) sh._rows.push([]);
            const row = sh._rows[r-1+i]; for(let j=0;j<v[i].length;j++) row[c-1+j]=v[i][j]; } return api; },
        setValue(v){ return api.setValues([[v]]); },
        setNumberFormat(){ return api; }, setNote(){ return api; }, setFontWeight(){ return api; },
        clearContent(){ return api; }, setBackground(){ return api; },
      };
      return api;
    },
    appendRow(v){ this._rows.push(v.slice()); },
    getProtections(){ return []; }, setName(n){ this._name=n; },
    getConditionalFormatRules(){ return []; }, setConditionalFormatRules(){}, getMaxRows(){ return 5000; },
  };
  return sh;
}

const EVENTS = [];
const LOCK = { held:false, acquires:0, busy:false, flushWhileHeld:0, labels:[] };
const CACHE = {};
const scriptCache = {
  get: k => (CACHE[k]===undefined?null:CACHE[k]), put:(k,v)=>{CACHE[k]=v;}, remove:k=>{delete CACHE[k];},
  removeAll: ks=>ks.forEach(k=>delete CACHE[k]),
  getAll: ks=>{ const o={}; ks.forEach(k=>{ if(CACHE[k]!==undefined) o[k]=CACHE[k]; }); return o; },
  putAll: o=>Object.keys(o).forEach(k=>{CACHE[k]=o[k];}),
};
const SHEETS = {};
const BACKEND = {
  getSheetByName: n => SHEETS[n] || null, getSheets: () => Object.values(SHEETS),
  insertSheet: n => (SHEETS[n] = makeSheet(n, [])),
  getSpreadsheetTimeZone: () => 'Asia/Taipei', getName: () => '後端', getId: () => 'be',
};
const sandbox = {
  console, Logger:{ log(){} },
  Session:{ getEffectiveUser: () => ({ getEmail: () => 't@e.com' }) },
  Utilities:{ formatDate: () => '2026/11/17 10:00:00', sleep(ms){ EVENTS.push({t:'sleep', held:LOCK.held, ms}); },
              base64Encode:x=>String(x), parseCsv:()=>[] },
  CacheService:{ getScriptCache: () => scriptCache },
  LockService:{ getScriptLock: () => ({
    tryLock(){ if(LOCK.busy) return false; if(LOCK.held) throw new Error('測試台：鎖被重複取得（不可重入）');
               LOCK.held = true; LOCK.acquires++; EVENTS.push({t:'lock'}); return true; },
    releaseLock(){ LOCK.held = false; EVENTS.push({t:'unlock'}); }, waitLock(){},
  }) },
  ScriptApp:{ getProjectTriggers:()=>[], WeekDay:{MONDAY:1}, TriggerSource:{CLOCK:'CLOCK'} },
  UrlFetchApp:{ fetch: ()=>({ getContentText:()=>'{}', getResponseCode:()=>200 }) },
  ContentService:{ createTextOutput: t=>({ setMimeType: ()=>t }), MimeType:{JSON:'json'} },
  HtmlService:{}, MimeType:{ CSV:'text/csv' },
  DriveApp:{},
  SpreadsheetApp:{
    getActiveSpreadsheet: () => BACKEND, openById: () => BACKEND,
    flush(){ EVENTS.push({t:'flush', held:LOCK.held}); if(LOCK.held) LOCK.flushWhileHeld++; },
    ProtectionType:{SHEET:'SHEET',RANGE:'RANGE'},
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const src = fs.readFileSync(process.argv[2],'utf8')
  + "\n;globalThis.__x = {ORDERS_HEADER, HEADER_LABELS, SHEET_ORDERS, MIRROR_ORDER_SHEET_NAME, statusToText,"
  + " STALE_CLAIM_MINUTES, releaseStaleClaims_, hasStaleClaimCandidate_, hourlySync_, autoSyncOrders_,"
  + " mergeOrders, readOrderRows, withScriptLock_, finalizeShipment, diagnoseLockHolds,"
  + " SHEET_SYSLOG, SYSLOG_HEADER, SHEET_LOG, LOG_HEADER, LOCK_SLOW_MS};\n";
vm.runInContext(src, sandbox, { filename:'Code.gs' });
const X = sandbox.__x;

let fail = 0;
const ck = (id, cond, extra) => { if(!cond){ console.log('  FAIL', id, extra===undefined?'':JSON.stringify(extra)); fail++; } else console.log('  ok  ', id); };
const reset = () => { EVENTS.length = 0; LOCK.acquires = 0; LOCK.flushWhileHeld = 0; LOCK.busy = false; };

// ---------- 訂單表 ----------
const H = X.ORDERS_HEADER;
const disp = H.map(h => X.HEADER_LABELS[h] || h);
function orderRow(o){ return H.map(h => o[h] === undefined ? '' : o[h]); }
const fresh = new Date(Date.now() - 5*60000).toISOString();
const stale = new Date(Date.now() - (X.STALE_CLAIM_MINUTES*3)*60000).toISOString();
function buildOrders(list){ SHEETS[X.SHEET_ORDERS] = makeSheet(X.SHEET_ORDERS, [disp].concat(list.map(orderRow))); return SHEETS[X.SHEET_ORDERS]; }
const items = JSON.stringify([{sku:'A1', name:'測試', baseName:'測試', spec:'', qty:1}]);

console.log('【逾時認領】沒事可做的時候，連鎖都不該碰');
let osh = buildOrders([
  {orderNo:'O1', status:X.statusToText('pending'), itemsJson:items},
  {orderNo:'O2', status:X.statusToText('scanning'), claimedBy:'S01', claimedAt:fresh, itemsJson:items},
  {orderNo:'O3', status:X.statusToText('shipped'), itemsJson:items},
]);
reset();
let n = X.releaseStaleClaims_();
ck('沒有逾時的 → 釋放 0 張', n === 0, n);
ck('而且完全沒有拿鎖', LOCK.acquires === 0, LOCK.acquires);
// 標題列核對（1 列 × 全欄）不算，那是 getSheet 每次執行做一次的固定成本
const bodyReads = EVENTS.filter(e => e.t==='read' && e.sheet===X.SHEET_ORDERS && e.rows > 1);
ck('預檢只讀 3 欄，沒有整張讀', bodyReads.length === 1 && bodyReads[0].cols === 3, EVENTS.filter(e=>e.t==='read'));

console.log('\n【逾時認領】真的有逾時的，要進鎖並且釋放對的那一張');
osh = buildOrders([
  {orderNo:'O1', status:X.statusToText('pending'), itemsJson:items},
  {orderNo:'O2', status:X.statusToText('scanning'), claimedBy:'S01', claimedAt:fresh, itemsJson:items},
  {orderNo:'O4', status:X.statusToText('scanning'), claimedBy:'S02', claimedAt:stale, itemsJson:items},
  {orderNo:'O5', status:X.statusToText('scanning'), claimedBy:'S03', claimedAt:'', itemsJson:items},
]);
reset();
n = X.releaseStaleClaims_();
const after = X.readOrderRows();
ck('釋放 2 張（逾時的＋認領時間壞掉的）', n === 2, n);
ck('拿了一次鎖', LOCK.acquires === 1, LOCK.acquires);
ck('做完鎖有放掉', LOCK.held === false);
ck('O4 回到待出貨、認領人清空', after[2].status === 'pending' && !after[2].claimedBy, after[2]);
ck('O5 也回到待出貨', after[3].status === 'pending', after[3]);
ck('還在時限內的 O2 沒被動到', after[1].status === 'scanning' && after[1].claimedBy === 'S01', after[1]);
ck('寫入都發生在鎖裡', EVENTS.filter(e=>e.t==='write' && e.sheet===X.SHEET_ORDERS).every(e=>e.held),
   EVENTS.filter(e=>e.t==='write'));
ck('放鎖之前有 flush', LOCK.flushWhileHeld >= 1, LOCK.flushWhileHeld);

console.log('\n【每小時同步】四件事各拿各的鎖，中間要讓出來');
const calls = [];
function spy(name, opts){ return function(){ calls.push({name, held: LOCK.held}); if(opts && opts.boom) throw new Error('故意失敗'); return name; }; }
sandbox.syncNativeOrderSheet_ = spy('native');
sandbox.syncLogisticsConfirm_ = spy('logistics');
sandbox.closeBasketConfirmedPending_ = spy('closeBasket');
sandbox.syncSpecialNotes_ = spy('notes');
reset(); calls.length = 0;
X.hourlySync_();
ck('四件都做了、順序沒變', calls.map(c=>c.name).join(',') === 'native,logistics,closeBasket,notes', calls);
ck('每一件都在鎖裡做', calls.every(c=>c.held), calls);
ck('鎖拿了 4 次（不是 1 次佔到底）', LOCK.acquires === 4, LOCK.acquires);
const seq = EVENTS.filter(e=>['lock','unlock','sleep'].indexOf(e.t)>=0).map(e=>e.t).join(' ');
ck('件與件之間：放鎖 → 停一下 → 再拿', seq === 'lock unlock sleep lock unlock sleep lock unlock sleep lock unlock', seq);
ck('停的那一下鎖是放開的', EVENTS.filter(e=>e.t==='sleep').every(e=>e.held===false));

console.log('\n【每小時同步】其中一件出錯，後面的還是要做');
sandbox.syncLogisticsConfirm_ = spy('logistics', {boom:true});
reset(); calls.length = 0;
X.hourlySync_();
ck('第二件爆了，第三、四件照做', calls.map(c=>c.name).join(',') === 'native,logistics,closeBasket,notes', calls);
ck('爆掉之後鎖有放', LOCK.held === false);
sandbox.syncLogisticsConfirm_ = spy('logistics');

console.log('\n【自動同步】讀來源鏡像不該佔著鎖');
SHEETS[X.MIRROR_ORDER_SHEET_NAME] = makeSheet(X.MIRROR_ORDER_SHEET_NAME, [
  ['訂單','品號','品名','規格','數量','賣場','日期','訂單狀態','寄送方式'],
  ['N1','SKU1','新品','紅',2,'蝦皮','2026/11/17','文山','7-11'],
  ['N1','SKU1','新品','紅',1,'蝦皮','2026/11/17','文山','7-11'],
  ['N2','SKU2','別倉','', 1,'蝦皮','2026/11/17','山物出','7-11'],
  ['O4','SKU9','既有單更新','', 5,'蝦皮','2026/11/17','文山','7-11'],
]);
osh = buildOrders([
  {orderNo:'O4', status:X.statusToText('pending'), itemsJson:items, manualClose:'', createdAt:'2026/11/16 09:00:00'},
  {orderNo:'O6', status:X.statusToText('shipped'), itemsJson:items},
]);
sandbox.rebuildOrderDetailSheet_ = spy('detail');
sandbox.setupOrderSheetColors = spy('colors');
reset(); calls.length = 0;
const steps = X.autoSyncOrders_();
const mirrorReads = EVENTS.filter(e=>e.t==='read' && e.sheet===X.MIRROR_ORDER_SHEET_NAME);
ck('有讀鏡像', mirrorReads.length >= 1);
ck('讀鏡像時沒有佔鎖', mirrorReads.every(e=>e.held===false), mirrorReads);
ck('寫訂單表都在鎖裡', EVENTS.filter(e=>e.t==='write' && e.sheet===X.SHEET_ORDERS).every(e=>e.held));
ck('六步各拿一次鎖', LOCK.acquires === 6, LOCK.acquires);
ck('後續五步順序正確', calls.map(c=>c.name).join(',') === 'detail,colors,native,logistics,notes', calls);
ck('每一步都回報成功', steps.every(s=>s.ok), steps);
const merged = X.readOrderRows();
const byNo = {}; merged.forEach(r=>byNo[r.orderNo]=r);
ck('新訂單 N1 進來了', !!byNo.N1, Object.keys(byNo));
ck('同單同品號數量有加總（2+1=3）', byNo.N1 && JSON.parse(byNo.N1.itemsJson)[0].qty === 3, byNo.N1 && byNo.N1.itemsJson);
ck('非本倉的 N2 沒進來', !byNo.N2);
ck('既有的 O4 被更新', byNo.O4 && JSON.parse(byNo.O4.itemsJson)[0].sku === 'SKU9', byNo.O4 && byNo.O4.itemsJson);
ck('O4 的進單時間沒被洗掉', byNo.O4 && byNo.O4.createdAt === '2026/11/16 09:00:00', byNo.O4 && byNo.O4.createdAt);
ck('已出貨的 O6 沒被動', byNo.O6 && byNo.O6.status === 'shipped');

console.log('\n【手動同步】APP 按同步那條路要跟以前一樣一次做完');
reset(); calls.length = 0;
const r2 = X.withScriptLock_('doPost:mergeOrders', function(){
  return X.mergeOrders({M1:{orderNo:'M1', store:'蝦皮', date:'2026/11/17', items:[{sku:'Z', name:'z', baseName:'z', spec:'', qty:1}]}});
});
ck('合併成功', r2.ok === true && r2.added === 1, r2);
ck('明細與顏色有接著做', calls.map(c=>c.name).join(',') === 'detail,colors', calls);
ck('整段只拿一次鎖（在 doPost 的鎖裡）', LOCK.acquires === 1, LOCK.acquires);

console.log('\n【排程搶不到鎖】不能整支掛掉，要記下來繼續');
osh = buildOrders([{orderNo:'O4', status:X.statusToText('pending'), itemsJson:items}]);
reset(); calls.length = 0; LOCK.busy = true;
let threw = false, steps2;
try{ steps2 = X.autoSyncOrders_(); }catch(e){ threw = true; }
ck('沒有丟例外', !threw);
ck('每一步都回報失敗而不是假裝成功', steps2 && steps2.every(s=>s.ok===false), steps2);
ck('訂單表沒有被寫入', !EVENTS.some(e=>e.t==='write' && e.sheet===X.SHEET_ORDERS));
LOCK.busy = false;

console.log('\n【完成出貨】加了分段計時之後，功能要跟原本一樣');
osh = buildOrders([
  {orderNo:'F1', status:X.statusToText('scanning'), claimedBy:'S06', claimedAt:fresh, itemsJson:items},
  {orderNo:'F2', status:X.statusToText('shipped'), itemsJson:items},
]);
delete SHEETS[X.SHEET_LOG];
Object.keys(CACHE).forEach(k=>delete CACHE[k]);
reset();
const entry = {orderNo:'F1', orderDate:'2026/11/17', waybill:'W123', staffId:'S06', staffName:'測試',
  time:'2026/11/17 10:00:05', startTime:'2026/11/17 09:59:00', requiredCount:1, scannedCount:1,
  items:[{sku:'A1', baseName:'測試', spec:'', qty:1, scanned:1}]};
const fr = X.withScriptLock_('doPost:finalizeShipment', function(){ return X.finalizeShipment(entry); });
ck('完成出貨成功', fr && fr.ok === true, fr);
const afterF = X.readOrderRows();
ck('訂單變成已出貨、認領清空', afterF[0].status === 'shipped' && !afterF[0].claimedBy, afterF[0]);
ck('出貨起訖時間寫回訂單', afterF[0].shipStartAt === '2026/11/17 09:59:00' && afterF[0].shipDoneAt === '2026/11/17 10:00:05', afterF[0]);
const logSh = SHEETS[X.SHEET_LOG];
ck('出貨紀錄多了一列', logSh && logSh.getLastRow() === 2, logSh && logSh.getLastRow());
ck('運單號寫進出貨紀錄', logSh && logSh._rows[1].indexOf('W123') >= 0, logSh && logSh._rows[1]);
ck('寫入全部在鎖裡', EVENTS.filter(e=>e.t==='write').every(e=>e.held), EVENTS.filter(e=>e.t==='write'));
ck('放鎖前有 flush', LOCK.flushWhileHeld >= 1);
reset();
const fr2 = X.withScriptLock_('doPost:finalizeShipment', function(){ return X.finalizeShipment(entry); });
ck('同一次出貨的重送（逾時後自動重送）：當成功，不報衝突', fr2.ok === true && fr2.duplicate === true, fr2);
ck('被擋下來時出貨紀錄沒有多一列', logSh.getLastRow() === 2, logSh.getLastRow());
reset();
const other = Object.assign({}, entry, {time:'2026/11/17 10:07:30', staffId:'S02', waybill:'W999'});
const fr3 = X.withScriptLock_('doPost:finalizeShipment', function(){ return X.finalizeShipment(other); });
ck('別人（不同完成時間）再出同一張：照舊擋下', fr3.ok === false && fr3.reason === 'already_shipped', fr3);
ck('而且帶回原本那次的完成時間，警示才講得清楚', fr3.shippedAt === '2026/11/17 10:00:05', fr3);
ck('被擋下時出貨紀錄還是只有一列', logSh.getLastRow() === 2, logSh.getLastRow());

console.log('\n【完成出貨】訂單不在表裡時的重送，不能寫兩次出貨紀錄');
const ghost = Object.assign({}, entry, {orderNo:'GHOST1', time:'2026/11/17 10:09:00'});
X.withScriptLock_('doPost:finalizeShipment', function(){ return X.finalizeShipment(ghost); });
const n1 = logSh.getLastRow();
const fr4 = X.withScriptLock_('doPost:finalizeShipment', function(){ return X.finalizeShipment(ghost); });
ck('第一次照原本行為寫了紀錄', n1 === 3, n1);
ck('重送回成功、不再多寫一列', fr4.ok === true && fr4.duplicate === true && logSh.getLastRow() === 3, {fr4, n: logSh.getLastRow()});

console.log('\n【鎖診斷】半夜的不能淹沒白天的');
const SH = X.SYSLOG_HEADER;
const iT = SH.indexOf('logTime'), iE = SH.indexOf('event'), iD = SH.indexOf('detail');
function sysRow(t, det){ const r = SH.map(()=> ''); r[iT]=t; r[iE]='鎖佔用過久'; r[iD]=det; return r; }
const today = new Date(); const d = today.getFullYear()+'/'+(today.getMonth()+1)+'/'+today.getDate();
SHEETS[X.SHEET_SYSLOG] = makeSheet(X.SHEET_SYSLOG, [SH.slice(),
  sysRow(d+' 04:25:19', 'hourlySync_　佔用 21928ms　等待 161ms'),
  sysRow(d+' 05:02:13', 'releaseStaleClaims_　佔用 10701ms　等待 287ms'),
  sysRow(d+' 09:19:34', 'autoSyncOrders_　佔用 9957ms　等待 135ms'),
  sysRow(d+' 14:05:40', 'autoSync:detail　佔用 41000ms　等待 100ms'),
  sysRow(d+' 16:06:10', 'doPost:finalizeShipment　佔用 52000ms　等待 300ms　｜找列 80ms／寫訂單 51000ms／寫出貨紀錄 400ms（其餘是最後送出的時間）'),
]);
const txt = X.diagnoseLockHolds(14);
ck('有工作時段的排行', txt.indexOf('工作時段 9:00–19:00 誰佔最久') >= 0, txt);
const work = txt.split('【工作時段 9:00–19:00 誰佔最久】')[1].split('【工作時段、佔用超過 20 秒】')[0];
ck('工作時段排行不含半夜的 hourlySync_', work.indexOf('hourlySync_') < 0, work);
ck('工作時段排行第一名是佔最久的', work.trim().split('\n')[1].indexOf('doPost:finalizeShipment') >= 0, work);
const kill = txt.split('【工作時段、佔用超過 20 秒】')[1].split('【哪一小時】')[0];
ck('列出會造成失敗的那兩筆', kill.indexOf('14:05:40') >= 0 && kill.indexOf('16:06:10') >= 0, kill);
ck('不到 20 秒的不列', kill.indexOf('09:19:34') < 0, kill);
ck('分段時間有跟著顯示', kill.indexOf('寫訂單 51000ms') >= 0, kill);
ck('帶分段說明的紀錄仍然被正確解析', txt.indexOf('doPost:finalizeShipment：1 次，最久佔用 52.0 秒') >= 0, txt);

console.log(fail ? '\n有 '+fail+' 項失敗' : '\n全部通過：沒事不拿鎖、拆鎖有讓出、鏡像讀取在鎖外、合併結果不變、搶不到鎖不掛掉');
process.exit(fail?1:0);
