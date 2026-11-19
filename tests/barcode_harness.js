// 條碼補充、條碼格式統一、調撥鏡射移出鎖外 的離線測試台
//
// 用法：cp Code.gs /tmp/CodeRun.js && node tests/barcode_harness.js /tmp/CodeRun.js
const fs = require('fs'), vm = require('vm');

const EVENTS = [];
const LOCK = { held:false };
function makeSheet(name, rows){
  const sh = {
    _name:name, _rows: rows.map(r=>r.slice()),
    getName(){ return this._name; },
    getLastRow(){ let last=0; this._rows.forEach((r,i)=>{ if(r.some(v=>String(v==null?'':v)!=='')) last=i+1; }); return last; },
    getLastColumn(){ return Math.max.apply(null, this._rows.map(r=>r.length).concat([1])); },
    getMaxRows(){ return 1000; }, getMaxColumns(){ return 30; },
    getRange(r,c,nr,nc){
      nr=nr==null?1:nr; nc=nc==null?1:nc;
      const api = {
        getValues(){ EVENTS.push({t:'read', sheet:sh._name, held:LOCK.held});
          const o=[]; for(let i=0;i<nr;i++){ const row=sh._rows[r-1+i]||[]; const t=[];
          for(let j=0;j<nc;j++) t.push(row[c-1+j]===undefined?'':row[c-1+j]); o.push(t);} return o; },
        getDisplayValues(){ return api.getValues().map(r => r.map(String)); },
        getValue(){ return api.getValues()[0][0]; },
        setValues(v){ EVENTS.push({t:'write', sheet:sh._name, held:LOCK.held});
          for(let i=0;i<v.length;i++){ while(sh._rows.length < r+i) sh._rows.push([]);
            const row = sh._rows[r-1+i]; for(let j=0;j<v[i].length;j++) row[c-1+j]=v[i][j]; } return api; },
        setValue(v){ return api.setValues([[v]]); },
        setNumberFormat(){ return api; }, setNote(){ return api; }, clearContent(){ return api; },
        setFontWeight(){ return api; }, setBackground(){ return api; },
      };
      return api;
    },
    appendRow(v){ EVENTS.push({t:'write', sheet:sh._name, held:LOCK.held}); this._rows.push(v.slice()); },
    getProtections(){ return []; }, setName(n){ this._name=n; }, setFrozenRows(){},
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
const WS = { getSheetByName: () => ({ getLastRow: () => 1, getRange: () => ({ setValues(){ EVENTS.push({t:'mirror', held:LOCK.held}); }, clearContent(){}, getValues: () => [[]], setNumberFormat(){ return this; } }), getMaxRows: () => 500 }) };
const sandbox = {
  console, Logger:{ log(){} },
  Session:{ getEffectiveUser: () => ({ getEmail: () => 't@e.com' }) },
  Utilities:{ formatDate: () => '2026/11/19 15:00:00', sleep(){} },
  CacheService:{ getScriptCache: () => scriptCache },
  LockService:{ getScriptLock: () => ({ tryLock(){ LOCK.held = true; return true; }, releaseLock(){ LOCK.held = false; } }) },
  ScriptApp:{ getProjectTriggers:()=>[], WeekDay:{MONDAY:1}, TriggerSource:{CLOCK:'CLOCK'} },
  ContentService:{ createTextOutput: t=>({ setMimeType: ()=>t }), MimeType:{JSON:'json'} },
  HtmlService:{}, MimeType:{}, DriveApp:{},
  SpreadsheetApp:{ getActiveSpreadsheet: () => BACKEND, openById: () => WS, flush(){} },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(process.argv[2],'utf8')
  + "\n;globalThis.__x = {barcodeVariants_, barcodeToSkuMap_, bindBarcode, getBarcodePatch, SHEET_BARCODE_PATCH,"
  + " scanTransferBatch, withScriptLock_, SHEET_TRANSFER, TRANSFER_HEADER, HEADER_LABELS, runAfterLock_};\n",
  sandbox, { filename:'Code.gs' });
const X = sandbox.__x;

let fail = 0;
const ck = (id, cond, extra) => { if(!cond){ console.log('  FAIL', id, extra===undefined?'':JSON.stringify(extra)); fail++; } else console.log('  ok  ', id); };

console.log('【條碼寫法統一】11／12／13／14 碼都當同一個');
let v = X.barcodeVariants_('043619147155');
ck('UPC-A 12 碼展開出 11 碼與 EAN-13', v.indexOf('43619147155') >= 0 && v.indexOf('0043619147155') >= 0 && v.indexOf('043619147155') >= 0, v);
v = X.barcodeVariants_('43619147155');
ck('11 碼（開頭 0 被吃掉）也能展開回 12 碼', v.indexOf('043619147155') >= 0, v);
ck('非數字照原樣', X.barcodeVariants_('BF-123').join() === 'BF-123');
ck('空的回空陣列', X.barcodeVariants_('').length === 0);

// 條碼轉品號：A 空、B 品號、C 條碼、D 品名
SHEETS['條碼轉品號'] = makeSheet('條碼轉品號', [['條碼','品號','條碼','品名','規格'],
  ['', 'SKU-UPC', '043619147155', 'UPC 商品', ''],
  ['', 'SKU-EAN', '4710000000001', 'EAN 商品', ''],
  ['', 'SKU-OTHER', '4710000000002', '別的商品', '']]);

console.log('\n【對照表】掃到任何一種寫法都對得到');
let m = X.barcodeToSkuMap_();
ck('11 碼對得到', m['43619147155'] && m['43619147155'].sku === 'SKU-UPC', m['43619147155']);
ck('13 碼對得到', m['0043619147155'] && m['0043619147155'].sku === 'SKU-UPC');
ck('原本的 12 碼照樣對得到', m['043619147155'].sku === 'SKU-UPC');

console.log('\n【綁定】');
let r = X.bindBarcode({code:'4943161421986', sku:'3020MB1150104', name:'mont-bell O.D. Pocket Tissue', staffName:'蔡佩璇', source:'調撥驗收'});
ck('新條碼綁定成功', r.ok === true && !r.duplicate, r);
const ps = SHEETS[X.SHEET_BARCODE_PATCH];
ck('寫進「條碼補充」表一列，記了誰、何時、來源', ps && ps.getLastRow() === 2 && ps._rows[1][3] === '蔡佩璇' && ps._rows[1][5] === '調撥驗收', ps && ps._rows);
m = X.barcodeToSkuMap_();
ck('綁定後對照表就認得', m['4943161421986'] && m['4943161421986'].sku === '3020MB1150104', m['4943161421986']);
r = X.bindBarcode({code:'4943161421986', sku:'3020MB1150104'});
ck('同一組再綁一次：當成功，不多寫', r.ok && r.duplicate && ps.getLastRow() === 2, r);
r = X.bindBarcode({code:'4943161421986', sku:'SOMETHING-ELSE'});
ck('補充表裡已經對到別的品號：擋下', r.ok === false && r.reason === 'conflict' && r.existing === '3020MB1150104', r);
r = X.bindBarcode({code:'4710000000001', sku:'SKU-X'});
ck('國際碼對照表已有、對到別的品號：擋下，不能蓋上游', r.ok === false && r.reason === 'conflict' && r.existing === 'SKU-EAN', r);
r = X.bindBarcode({code:'43619147155', sku:'SKU-X'});
ck('寫法不同（11 碼）但其實是上游已有的碼：照樣擋下', r.ok === false && r.existing === 'SKU-UPC', r);
r = X.bindBarcode({code:'SKU-OTHER', sku:'SKU-X'});
ck('掃到的是另一件商品的品號：擋下', r.ok === false && r.existing === 'SKU-OTHER', r);
r = X.bindBarcode({code:'https://www.buff.com/how-to-wear', sku:'SKU-X'});
ck('吊牌上的網址 QR：拒絕', r.ok === false && /不是商品條碼/.test(r.error), r);
ck('被擋下的都沒有寫進表裡', ps.getLastRow() === 2, ps.getLastRow());
r = X.getBarcodePatch();
ck('前端拿得到補充表內容', r.ok && r.items.length === 1 && r.items[0].code === '4943161421986', r);

console.log('\n【調撥掃描】鏡射要在放鎖之後才做');
const TH = X.TRANSFER_HEADER;
const disp = TH.map(h => X.HEADER_LABELS[h] || h);
function trow(o){ return TH.map(h => o[h] === undefined ? '' : o[h]); }
SHEETS[X.SHEET_TRANSFER] = makeSheet(X.SHEET_TRANSFER, [disp,
  trow({batchId:'B1', sku:'T1', baseName:'水壺', qty:2, scannedQty:0, status:'open', importedAt:'2026/11/19 09:00:00'})]);
Object.keys(CACHE).forEach(k => delete CACHE[k]);
EVENTS.length = 0;
r = X.withScriptLock_('doPost:scanTransferBatch', function(){ return X.scanTransferBatch([{sku:'T1', staffId:'S05', staffName:'蔡', time:'t'}]); });
ck('掃描成功', r.ok && r.results[0].ok, r);
const mirrors = EVENTS.filter(e => e.t === 'mirror');
ck('有做鏡射', mirrors.length >= 1, EVENTS.map(e=>e.t));
ck('鏡射時鎖已經放掉了', mirrors.every(e => e.held === false), mirrors);
ck('自己的表的寫入仍在鎖裡', EVENTS.filter(e => e.t === 'write').every(e => e.held === true), EVENTS.filter(e => e.t === 'write'));
EVENTS.length = 0;
X.runAfterLock_(function(){ EVENTS.push({t:'direct', held: LOCK.held}); });
ck('沒拿著鎖時排的工作會直接做', EVENTS.length === 1 && EVENTS[0].held === false, EVENTS);

console.log(fail ? '\n有 '+fail+' 項失敗' : '\n全部通過：條碼寫法統一、綁定會擋衝突、鏡射在鎖外');
process.exit(fail?1:0);
