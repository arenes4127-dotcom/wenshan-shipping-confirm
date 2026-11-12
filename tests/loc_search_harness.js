// 儲位模糊查詢與快取預熱的離線測試台
//
// 用法：cp Code.gs /tmp/CodeRun.js && node tests/loc_search_harness.js /tmp/CodeRun.js
//
// 重點在兩件只有真的跑才驗得出來的事：
//   1. 樣式轉正規式的跳脫。原始碼經過 Python 字串 → JS 原始碼兩層跳脫，
//      少一個反斜線就會變成「點號當萬用字元」或整個正規式壞掉。
//   2. 分片快取的往返。寫進去 20 片、讀回來要湊得齊，缺一片等於搜尋結果
//      會莫名其妙少一批商品——那比「搜尋比較慢」難發現得多。
const fs = require('fs'), vm = require('vm');

function makeSheet(name, rows){
  return {
    _name:name, _rows: rows.map(r=>r.slice()),
    getName(){ return this._name; },
    getLastRow(){ let last=0; this._rows.forEach((r,i)=>{ if(r.some(v=>String(v==null?'':v)!=='')) last=i+1; }); return last; },
    getLastColumn(){ return Math.max.apply(null, this._rows.map(r=>r.length).concat([1])); },
    getRange(r,c,nr,nc){
      nr=nr==null?1:nr; nc=nc==null?1:nc; const sh=this;
      return {
        getValues(){ const o=[]; for(let i=0;i<nr;i++){ const row=sh._rows[r-1+i]||[]; const t=[];
          for(let j=0;j<nc;j++) t.push(row[c-1+j]===undefined?'':row[c-1+j]); o.push(t);} return o; },
        getValue(){ return this.getValues()[0][0]; },
        setValues(){ return this; }, setValue(){ return this; }, setNumberFormat(){ return this; },
        setNote(){ return this; }, setFontWeight(){ return this; }, clearContent(){ return this; },
      };
    },
    getProtections(){ return []; }, setName(n){ this._name=n; },
  };
}

// 真的會存東西的快取，不是回 null 的假貨——這支測試的重點之一就是分片往返
const CACHE = {};
let putAllCalls = 0;
const scriptCache = {
  get: k => (CACHE[k] === undefined ? null : CACHE[k]),
  put: (k,v) => { CACHE[k] = v; },
  remove: k => { delete CACHE[k]; },
  removeAll: ks => ks.forEach(k => delete CACHE[k]),
  getAll: ks => { const o = {}; ks.forEach(k => { if(CACHE[k] !== undefined) o[k] = CACHE[k]; }); return o; },
  putAll: (obj) => { putAllCalls++; Object.keys(obj).forEach(k => { CACHE[k] = obj[k]; }); },
};

let LOCSS = null, BACKEND = null;
const log = [];
const sandbox = {
  console,
  Logger:{ log: m => log.push(String(m)) },
  Session:{ getEffectiveUser: () => ({ getEmail: () => 't@e.com' }) },
  Utilities:{ formatDate: () => '2026_11_12', sleep(){}, base64Encode: x=>String(x),
              parseCsv: t => String(t||'').split(/\r?\n/).filter(l=>l!=='').map(l=>l.split(',')) },
  CacheService:{ getScriptCache: () => scriptCache },
  LockService:{ getScriptLock: () => ({ tryLock:()=>true, releaseLock(){}, waitLock(){} }) },
  ScriptApp:{ getProjectTriggers:()=>[], WeekDay:{MONDAY:1}, TriggerSource:{CLOCK:'CLOCK'} },
  UrlFetchApp:{ fetch: ()=>({ getContentText:()=>'{}', getResponseCode:()=>200 }) },
  ContentService:{ createTextOutput: t=>({ setMimeType: ()=>t }), MimeType:{JSON:'json'} },
  HtmlService:{}, MimeType:{ CSV:'text/csv', PLAIN_TEXT:'text/plain', HTML:'text/html' },
  DriveApp:{ getFolderById:()=>({ getFilesByName:()=>({hasNext:()=>false}), addFile(){} }),
             getFileById:()=>({ setTrashed(){} }), getRootFolder:()=>({ removeFile(){} }) },
  SpreadsheetApp:{
    getActiveSpreadsheet: () => BACKEND,
    setActiveSpreadsheet: s => { BACKEND = s; },
    openById: () => LOCSS,
    flush(){}, ProtectionType:{SHEET:'SHEET',RANGE:'RANGE'},
    newDataValidation: ()=>({ requireValueInList: ()=>({ setAllowInvalid: ()=>({ build: ()=>({}) }) }) }),
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const src = fs.readFileSync(process.argv[2],'utf8')
  + "\n;globalThis.__x = {searchLocations, locSearchIndexBuild_, locSearchIndexGet_,"
  + " locPatternToRegex_, warmLocCaches_, locIndex_, LOC_SEARCH_SHARDS, LOC_SEARCH_MAX_HITS,"
  + " LOCMAP_COL, _ssMemo_};\n";
vm.runInContext(src, sandbox, { filename:'Code.gs' });
const X = sandbox.__x;

let fail = 0;
const ck = (id, cond, extra) => { if(!cond){ console.log('  FAIL', id, extra===undefined?'':JSON.stringify(extra)); fail++; } else console.log('  ok  ', id); };

// 主檔：A品號 B品名 C儲位（LOCMAP_COL sku=1 name=2 location=3）
const rows = [['品號','品名','儲位']];
const add = (sku,name,loc) => rows.push([sku,name,loc]);
add('2076262A3601A03', '冰絲魔術頭巾 深林之木', 'C05-4');
add('2076262A3601A04', '冰絲魔術頭巾 曜石黑',   'C05-4');
add('2076262A3602B01', '冰絲魔術頭巾 淺灰',     'C06-2上');
add('3041T20200248',   'NGN 大寬嘴水壺 T-1.5L 灰藍', 'M2-2');
add('3041T20201148',   'NGN 大寬嘴水壺 T-1.5L 發光綠','M2-2');
add('1020MB1114707NVS','mont-bell WIC.T 短袖排汗T 海軍藍/S','A01-1');
add('ODD.NAME.X',      '點號測試用商品', 'Z9-9');
// 多塞一些，確保分片真的會分散（20 片）
for(let i = 0; i < 120; i++) add('FILL' + String(i).padStart(4,'0'), '填充商品' + i, 'F01-1');

const locSheet = makeSheet(' 文山倉儲位', rows);
LOCSS = { getSheetByName: n => (String(n).trim() === '文山倉儲位' ? locSheet : null),
          getSheets: () => [locSheet], insertSheet: () => locSheet,
          getSpreadsheetTimeZone: () => 'Asia/Taipei', getName: () => '文山地圖', getId: () => 'loc' };
BACKEND = { getSheetByName: () => null, getSheets: () => [], insertSheet: n => makeSheet(n,[]),
            getSpreadsheetTimeZone: () => 'Asia/Taipei', getName: () => '後端', getId: () => 'be' };

console.log('【樣式轉正規式】跳脫錯一個字元，點號就會變成萬用字元');
const re1 = X.locPatternToRegex_('2076262A36*');
ck('前綴 * 命中', re1.test('2076262A3601A03'));
ck('前綴 * 不該命中別的', !re1.test('3041T20200248'));
const re2 = X.locPatternToRegex_('*頭巾*');
ck('前後 * 命中品名', re2.test('冰絲魔術頭巾 深林之木'));
const re3 = X.locPatternToRegex_('水壺');
ck('沒有 * 時當「包含」', re3.test('NGN 大寬嘴水壺 T-1.5L 灰藍'));
const re4 = X.locPatternToRegex_('ODD.NAME*');
ck('點號是字面的點，不是萬用字元', re4.test('ODD.NAME.X') && !re4.test('ODDxNAMEyX'), 'ODD.NAME*');
ck('大小寫不分', X.locPatternToRegex_('odd.name*').test('ODD.NAME.X'));
ck('空字串回 null', X.locPatternToRegex_('') === null);
ck('括號不會把正規式弄壞', X.locPatternToRegex_('A(B') !== null);

console.log('\n【建索引與分片往返】缺一片 = 搜尋結果少一批商品');
const built = X.locSearchIndexBuild_(locSheet);
console.log('   建了：', JSON.stringify(built));
ck('建索引成功', built.ok === true, built);
ck('筆數對（127 筆有效品號）', built.rows === 127, built);
ck('分了 20 片', built.shards === X.LOC_SEARCH_SHARDS, built);
ck('putAll 只呼叫一次（不要一片一片寫）', putAllCalls === 1, putAllCalls);
const shards = X.locSearchIndexGet_();
ck('20 片都讀得回來', Array.isArray(shards) && shards.length === 20, shards && shards.length);
const totalLines = shards.reduce((a,sline)=> a + (sline ? sline.split('\n').filter(x=>x).length : 0), 0);
ck('所有片加起來等於總筆數', totalLines === 127, totalLines);

console.log('\n【搜尋】');
const r1 = X.searchLocations({q:'2076262A36*'});
console.log('   2076262A36* →', JSON.stringify(r1.items.map(i=>i.sku)));
ck('前綴搜到 3 筆', r1.ok && r1['符合幾筆'] === 3, r1);
ck('帶回品名', r1.items[0].baseName.indexOf('頭巾') >= 0, r1.items[0]);
ck('帶回儲位', r1.items[0].location === 'C05-4', r1.items[0]);
ck('結果有排序', r1.items[0].sku <= r1.items[1].sku, r1.items.map(i=>i.sku));

const r2 = X.searchLocations({q:'*頭巾*'});
ck('用品名搜得到（品號完全不像）', r2.ok && r2['符合幾筆'] === 3, r2);
const r3 = X.searchLocations({q:'水壺'});
ck('沒有 * 當包含用', r3.ok && r3['符合幾筆'] === 2, r3);
const r4 = X.searchLocations({q:'ODD.NAME.X'});
ck('點號不會誤擴大', r4.ok && r4['符合幾筆'] === 1, r4);

console.log('\n【截斷】一個 * 不能把整個倉庫倒到手持機上');
const r5 = X.searchLocations({q:'FILL*', limit: 10});
ck('只回 10 筆', r5.items.length === 10, r5.items.length);
ck('但誠實回報總數 120', r5['符合幾筆'] === 120, r5);
ck('有標示被截斷', r5['有沒有被截斷'] === true, r5);
const r6 = X.searchLocations({q:'*'});
ck('單一個 * 不給過（太短）', r6.ok === false, r6);
ck('一個字不給過', X.searchLocations({q:'A'}).ok === false);

console.log('\n【快取不在時自己重建】');
Object.keys(CACHE).forEach(k => delete CACHE[k]);
const r7 = X.searchLocations({q:'水壺'});
ck('快取被清掉還是查得到', r7.ok && r7['符合幾筆'] === 2, r7);
ck('而且回報了「這次有重建」', r7['這次有沒有重建索引'] === true, r7);

console.log('\n【預熱】兩個索引一起建，而且不拿寫入鎖');
Object.keys(CACHE).forEach(k => delete CACHE[k]);
const w = X.warmLocCaches_();
console.log('   預熱：', JSON.stringify({品號索引筆數:w['品號索引筆數'], 搜尋索引:w['搜尋索引']}));
ck('預熱成功', w.ok === true, w);
ck('品號索引有建起來', w['品號索引筆數'] === 127, w);
ck('搜尋索引也建起來', w['搜尋索引'].ok === true && w['搜尋索引'].rows === 127, w);
ck('預熱後搜尋不需要再重建',
   X.searchLocations({q:'水壺'})['這次有沒有重建索引'] === false);

console.log(fail ? '\n有 '+fail+' 項失敗' : '\n全部通過：跳脫正確、分片湊得齊、品名搜得到、截斷誠實、預熱有效');
process.exit(fail?1:0);
