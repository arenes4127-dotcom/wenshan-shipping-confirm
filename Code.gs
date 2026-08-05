/**
 * 文山出貨確認系統 —— 共用後端（部署為 Web App）
 *
 * 用途：讓多人、多台裝置同時使用同一份「待出貨清單／出貨紀錄／人員名單」，
 * 而不是各自存在自己瀏覽器的 localStorage 裡看不到彼此。
 *
 * 部署目標：獨立的專用試算表「文山出貨確認系統-後端」——
 * https://docs.google.com/spreadsheets/d/1ogk_YvgJvFhjlnlF0QFiy1LaNMd89Qoe49slswk7Ubs
 * 跟使用者的共用業務試算表「文山核對 工作區」（1vCCJS...，放文山出貨V2/出貨核對A/B/國際碼等
 * 原始工作表，使用者交代不可修改）完全分開，避免互相干擾。
 *
 * 部署步驟：
 * 1. 開啟上面那份試算表 → 擴充功能 → Apps Script，把這個檔案的內容整個貼進去（取代預設的 Code.gs）。
 * 2. 上方選單「部署」→「新增部署作業」→ 類型選「網頁應用程式」。
 *    - 執行身份：我（你自己的帳號）
 *    - 誰可以存取：任何人
 * 3. 部署後會得到一個網址（.../exec），把這個網址貼到系統的「設定」頁「後端 Web App 網址」欄位。
 * 4. 之後每次改這個腳本，記得「管理部署作業」→ 編輯 → 部署新版本，網址才會套用最新程式碼。
 */

// 每次改完這個檔案要重新部署時，把這個版本號也順手改一下（例如日期+序號）。
// 部署後直接用瀏覽器打開 .../exec 網址，檢查回傳JSON裡的 "version" 是不是這個數字，
// 就能確認 Apps Script 編輯器裡真的是最新內容、部署也真的套用了最新版本，不用再用其他方式猜。
const BACKEND_VERSION = '2026-08-05.10';

// 分頁標籤跟欄位標題都用繁體中文，方便直接打開試算表看。內部程式邏輯（讀寫用的key）
// 還是用英文代碼，兩者分開靠 HEADER_LABELS 對應，不用整份程式碼牽動風險太大的改法。
const SHEET_ORDERS = '訂單';
const SHEET_LOG = '出貨紀錄';
const SHEET_STAFF = '人員';

// 舊分頁名稱（英文版）：第一次執行如果找不到中文分頁、但找得到對應的舊英文分頁，
// 會自動把舊分頁改名成新的中文名稱，資料原封不動保留，不用手動搬。
const LEGACY_SHEET_NAMES = { '訂單':'Orders', '出貨紀錄':'Log', '人員':'Staff' };

const ORDERS_HEADER = ['orderNo','store','date','itemsJson','skuSummary','nameSummary','status','claimedBy','claimedAt','updatedAt','shipMethod','routingStatus'];
const LOG_HEADER = ['orderNo','orderDate','waybill','itemsJson','skuSummary','nameSummary','staffId','staffName','time','hadIssue','hadManualEdit','importedExternal','store','shipMethod','note','requiredCount','scannedCount','routingStatus','checkResult','differenceDetails'];
const STAFF_HEADER = ['id','name'];

// 內部欄位代碼 → 試算表裡實際顯示的繁體中文標題
const HEADER_LABELS = {
  orderNo:'訂單號', store:'賣場', date:'日期', itemsJson:'品項資料(JSON)',
  skuSummary:'貨號', nameSummary:'品名', status:'狀態',
  claimedBy:'認領人', claimedAt:'認領時間', updatedAt:'更新時間',
  orderDate:'訂單日期', waybill:'運單編號', staffId:'包貨人員工號', staffName:'包貨人員姓名',
  time:'完成時間', hadIssue:'曾觸發警示', hadManualEdit:'曾手動修改數量', importedExternal:'外部匯入',
  shipMethod:'寄送方式', note:'備註', id:'工號', name:'姓名',
  requiredCount:'需求件數', scannedCount:'掃描件數', routingStatus:'訂單狀態', checkResult:'核對結果',
  differenceDetails:'差異明細'
};

function doGet(e){
  return respond(getState());
}

function doPost(e){
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try{
    const body = JSON.parse(e.postData.contents);
    let result;
    switch(body.action){
      case 'mergeOrders': result = mergeOrders(body.orders || {}); break;
      case 'claimOrder': result = claimOrder(body.orderNo, body.staffId, body.staffName); break;
      case 'releaseOrder': result = releaseOrder(body.orderNo); break;
      case 'finalizeShipment': result = finalizeShipment(body.entry); break;
      case 'importShippedBatch': result = importShippedBatch(body.entries || []); break;
      case 'setStaffList': result = setStaffList(body.staff || []); break;
      default: result = {ok:false, error:'unknown action: '+body.action};
    }
    return respond(result);
  }catch(err){
    return respond({ok:false, error: String(err)});
  }finally{
    lock.releaseLock();
  }
}

function respond(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getSheet(name, header){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if(!sh && LEGACY_SHEET_NAMES[name]){
    const legacy = ss.getSheetByName(LEGACY_SHEET_NAMES[name]);
    if(legacy){ legacy.setName(name); sh = legacy; } // 沿用舊分頁資料，只是改名
  }
  const displayHeader = header.map(h => HEADER_LABELS[h] || h);
  if(!sh){
    sh = ss.insertSheet(name);
    sh.appendRow(displayHeader);
  } else {
    // 不管是剛建立、沿用舊分頁、或標題被手動改過，都強制對齊成目前這套中文標題
    sh.getRange(1, 1, 1, displayHeader.length).setValues([displayHeader]);
  }
  return sh;
}

function readRows(name, header){
  const sh = getSheet(name, header);
  const lastRow = sh.getLastRow();
  if(lastRow < 2) return [];
  const values = sh.getRange(2, 1, lastRow-1, header.length).getValues();
  return values.map((row, i)=>{
    const obj = {_row: i+2};
    header.forEach((h, idx)=> obj[h] = row[idx]);
    return obj;
  });
}

// ---------------- state (讀取全部資料，給前端初始化/輪詢用) ----------------
function getState(){
  const orderRows = readRows(SHEET_ORDERS, ORDERS_HEADER);
  const orders = {};
  orderRows.forEach(r=>{
    orders[r.orderNo] = {
      orderNo: r.orderNo, store: r.store, date: cellToText(r.date),
      items: safeParse(r.itemsJson, []), status: r.status,
      claimedBy: r.claimedBy || '', claimedAt: r.claimedAt || '',
      shipMethod: r.shipMethod || '', routingStatus: r.routingStatus || ''
    };
  });
  const logRows = readRows(SHEET_LOG, LOG_HEADER);
  const log = logRows.map(r=>({
    orderNo: r.orderNo, orderDate: cellToText(r.orderDate), waybill: r.waybill,
    items: safeParse(r.itemsJson, []), staffId: r.staffId, staffName: r.staffName,
    time: cellToText(r.time, true), hadIssue: textToBool(r.hadIssue), hadManualEdit: textToBool(r.hadManualEdit),
    importedExternal: textToBool(r.importedExternal), store: r.store, shipMethod: r.shipMethod, note: r.note,
    requiredCount: r.requiredCount || '', scannedCount: r.scannedCount || '',
    routingStatus: r.routingStatus || '', checkResult: r.checkResult || '',
    differenceDetails: r.differenceDetails || ''
  })).reverse(); // 最新的在前面
  const staffRows = readRows(SHEET_STAFF, STAFF_HEADER);
  const staff = staffRows.map(r=>({id:r.id, name:r.name}));
  return {ok:true, orders, log, staff, version: BACKEND_VERSION};
}

function safeParse(json, fallback){
  try{ return json ? JSON.parse(json) : fallback; }catch(e){ return fallback; }
}

// 不管當初寫入時 Google試算表有沒有自動把「2026/8/5」這種字串轉成日期型別儲存格，
// 讀出來一律轉回固定格式的可讀文字，避免前端拿到UTC ISO時間字串
function cellToText(v, withTime){
  if(v instanceof Date){
    const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    return Utilities.formatDate(v, tz, withTime ? 'yyyy/M/d HH:mm:ss' : 'yyyy/M/d');
  }
  return v;
}

// 出貨紀錄表的是非欄位存成中文「是／否」方便直接看試算表，讀回來時轉回真正的布林值給前端用
function boolToText(b){ return b ? '是' : '否'; }
function textToBool(v){ return v === '是' || v === true; }

// 用欄位名稱查1-indexed欄號，不要用寫死的數字——加新欄位時舊的寫死數字會全部錯位
function colOf(header, name){
  const idx = header.indexOf(name);
  if(idx < 0) throw new Error('colOf: 找不到欄位 '+name);
  return idx + 1;
}

// 品項資料(JSON)不好直接在試算表裡看，另外拆出「貨號」「品名」兩欄方便肉眼掃視
// （一張訂單可能有多個品項，用頓號串起來，跟itemsJson欄位是同一份資料，只是多一種顯示方式）
function summarizeItems(items){
  const list = items || [];
  return {
    skuSummary: list.map(i=>i.sku).join('、'),
    nameSummary: list.map(i=>i.name).join('、')
  };
}

// ---------------- 訂單同步（合併，已出貨的不覆蓋） ----------------
function mergeOrders(incoming){
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readRows(SHEET_ORDERS, ORDERS_HEADER);
  const byOrderNo = {};
  rows.forEach(r=> byOrderNo[r.orderNo] = r);

  let added=0, updated=0, skippedShipped=0;
  const now = new Date().toISOString();

  Object.keys(incoming).forEach(orderNo=>{
    const o = incoming[orderNo];
    const existing = byOrderNo[orderNo];
    if(existing && existing.status === 'shipped'){ skippedShipped++; return; }
    const itemsJson = JSON.stringify(o.items||[]);
    const {skuSummary, nameSummary} = summarizeItems(o.items);
    const targetRow = existing ? existing._row : sh.getLastRow()+1;
    // 「日期」欄位強制設成純文字格式再寫入，避免 Google試算表把「2026/8/5」這種字串
    // 自動偵測轉成日期型別儲存格（那樣讀回來會變成UTC的ISO時間字串，跟原本存的字不一樣）
    sh.getRange(targetRow, colOf(ORDERS_HEADER,'date')).setNumberFormat('@');
    sh.getRange(targetRow, 1, 1, ORDERS_HEADER.length).setValues([[
      orderNo, o.store||'', String(o.date||''), itemsJson, skuSummary, nameSummary, 'pending', '', '', now, o.shipMethod||'', o.routingStatus||''
    ]]);
    if(existing) updated++; else added++;
  });
  return {ok:true, added, updated, skippedShipped};
}

// 保險機制：萬一還有資料列沒跑過 migrateOrdersColumnShift() 就先被claim/release/finalize動到，
// 這裡先就地把那一列的欄位位移修正好，再讓呼叫端繼續原本的邏輯，避免寫壞舊資料
// （判斷方式跟 migrateOrdersColumnShift() 一樣：新版狀態欄一定是這三個值之一）。
const VALID_ORDER_STATUS = {pending:1, scanning:1, shipped:1};
function healOrderRowIfNeeded_(sh, row){
  if(VALID_ORDER_STATUS[row.status]) return row;
  const raw = sh.getRange(row._row, 1, 1, ORDERS_HEADER.length).getValues()[0];
  const orderNo=raw[0], store=raw[1], date=raw[2], itemsJson=raw[3];
  const oldStatus=raw[4], oldClaimedBy=raw[5], oldClaimedAt=raw[6], oldUpdatedAt=raw[7], oldShipMethod=raw[8], oldRoutingStatus=raw[9];
  const items = safeParse(itemsJson, []);
  const {skuSummary, nameSummary} = summarizeItems(items);
  sh.getRange(row._row, colOf(ORDERS_HEADER,'date')).setNumberFormat('@');
  sh.getRange(row._row, 1, 1, ORDERS_HEADER.length).setValues([[
    orderNo, store, date, itemsJson, skuSummary, nameSummary,
    oldStatus || 'pending', oldClaimedBy || '', oldClaimedAt || '', oldUpdatedAt || '', oldShipMethod || '', oldRoutingStatus || ''
  ]]);
  return {_row: row._row, orderNo, store, date, itemsJson, skuSummary, nameSummary,
    status: oldStatus || 'pending', claimedBy: oldClaimedBy || '', claimedAt: oldClaimedAt || '',
    updatedAt: oldUpdatedAt || '', shipMethod: oldShipMethod || '', routingStatus: oldRoutingStatus || ''};
}

// ---------------- 認領訂單（避免兩人同時掃同一張） ----------------
function claimOrder(orderNo, staffId, staffName){
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readRows(SHEET_ORDERS, ORDERS_HEADER);
  let row = rows.find(r=>r.orderNo===orderNo);
  if(!row) return {ok:false, reason:'not_found'};
  row = healOrderRowIfNeeded_(sh, row);
  if(row.status === 'shipped') return {ok:false, reason:'already_shipped'};
  if(row.status === 'scanning' && row.claimedBy && row.claimedBy !== staffId){
    return {ok:false, reason:'claimed_by_other', claimedBy: row.claimedBy};
  }
  const now = new Date().toISOString();
  sh.getRange(row._row, colOf(ORDERS_HEADER,'status'), 1, 4).setValues([['scanning', staffId||'', now, now]]);
  return {ok:true, order: {orderNo: row.orderNo, store: row.store, date: cellToText(row.date), items: safeParse(row.itemsJson, []), shipMethod: row.shipMethod||'', routingStatus: row.routingStatus||''}};
}

function releaseOrder(orderNo){
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readRows(SHEET_ORDERS, ORDERS_HEADER);
  let row = rows.find(r=>r.orderNo===orderNo);
  if(!row) return {ok:false, reason:'not_found'};
  row = healOrderRowIfNeeded_(sh, row);
  if(row.status === 'shipped') return {ok:true}; // 已出貨就不用管了
  sh.getRange(row._row, colOf(ORDERS_HEADER,'status'), 1, 3).setValues([['pending', '', '']]);
  return {ok:true};
}

// ---------------- 完成出貨：標記已出貨＋寫入紀錄 ----------------
function finalizeShipment(entry){
  if(!entry || !entry.orderNo) return {ok:false, error:'missing orderNo'};
  const ordersSh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readRows(SHEET_ORDERS, ORDERS_HEADER);
  let row = rows.find(r=>r.orderNo===entry.orderNo);
  if(row){
    row = healOrderRowIfNeeded_(ordersSh, row);
    const now = new Date().toISOString();
    ordersSh.getRange(row._row, colOf(ORDERS_HEADER,'status'), 1, 4).setValues([['shipped', '', '', now]]);
  }
  appendLogRow(entry);
  return {ok:true};
}

function appendLogRow(entry){
  const logSh = getSheet(SHEET_LOG, LOG_HEADER);
  const targetRow = logSh.getLastRow()+1;
  const {skuSummary, nameSummary} = summarizeItems(entry.items);
  // orderDate跟time都長得像日期/時間字串，強制設純文字格式再寫，
  // 避免 Google試算表自動轉成日期型別（讀回來會變UTC ISO字串，顯示會跑掉）
  logSh.getRange(targetRow, colOf(LOG_HEADER,'orderDate')).setNumberFormat('@');
  logSh.getRange(targetRow, colOf(LOG_HEADER,'time')).setNumberFormat('@');
  logSh.getRange(targetRow, 1, 1, LOG_HEADER.length).setValues([[
    entry.orderNo, String(entry.orderDate||''), entry.waybill||'', JSON.stringify(entry.items||[]), skuSummary, nameSummary,
    entry.staffId||'', entry.staffName||'', String(entry.time||''), boolToText(entry.hadIssue), boolToText(entry.hadManualEdit),
    boolToText(entry.importedExternal), entry.store||'', entry.shipMethod||'', entry.note||'',
    entry.requiredCount||0, entry.scannedCount||0, entry.routingStatus||'', entry.checkResult||'', entry.differenceDetails||''
  ]]);
}

// ---------------- 批次匯入已出貨紀錄（指定出貨Excel那個功能用） ----------------
function importShippedBatch(entries){
  const ordersSh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readRows(SHEET_ORDERS, ORDERS_HEADER);
  const byOrderNo = {};
  rows.forEach(r=> byOrderNo[r.orderNo] = r);

  let imported=0, skippedNotFound=0, skippedAlreadyShipped=0;
  const now = new Date().toISOString();
  entries.forEach(entry=>{
    let row = byOrderNo[entry.orderNo];
    if(!row){ skippedNotFound++; return; }
    row = healOrderRowIfNeeded_(ordersSh, row);
    if(row.status === 'shipped'){ skippedAlreadyShipped++; return; }
    ordersSh.getRange(row._row, colOf(ORDERS_HEADER,'status'), 1, 4).setValues([['shipped', '', '', now]]);
    appendLogRow(entry);
    imported++;
  });
  return {ok:true, imported, skippedNotFound, skippedAlreadyShipped};
}

// ---------------- 人員名單（整份覆蓋，簡單起見） ----------------
function setStaffList(staffList){
  const sh = getSheet(SHEET_STAFF, STAFF_HEADER);
  const lastRow = sh.getLastRow();
  if(lastRow > 1) sh.getRange(2, 1, lastRow-1, STAFF_HEADER.length).clearContent();
  staffList.forEach(s=> sh.appendRow([s.id, s.name]));
  return {ok:true};
}

// ---------------- 一次性清理用：改成中文分頁名稱後留下的空舊分頁 ----------------
// 在 Apps Script 編輯器裡（不是部署網址）直接選這個函式、按「執行」跑一次即可，
// 執行前已經人工核對過 Orders/Log/Staff/工作表1 都只剩表頭或完全空白，資料都在
// 訂單/出貨紀錄/人員 這三個中文分頁裡，刪除這幾個不會遺失任何資料。
function deleteLegacyEmptySheets(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const namesToDelete = ['Orders', 'Log', 'Staff', '工作表1'];
  const deleted = [];
  namesToDelete.forEach(name=>{
    const sh = ss.getSheetByName(name);
    if(sh){ ss.deleteSheet(sh); deleted.push(name); }
  });
  Logger.log('已刪除分頁：' + deleted.join('、'));
}

// ---------------- 一次性設定用：出貨紀錄分頁的顏色標示 ----------------
// 在 Apps Script 編輯器裡選這個函式、按「執行」跑一次即可（不用重新部署）。
// 設定的是「條件式格式」，套一次之後，之後每一筆新的出貨紀錄會自動套用顏色，
// 不用每次寫入資料時都重新設定一次。
// 整列上色，依優先順序：曾觸發警示(是)＝紅色 > 曾手動修改數量(是，且無警示)＝黃色 >
// 外部匯入(是，且無警示無手動修改)＝藍色。
function setupLogSheetColors(){
  const sh = getSheet(SHEET_LOG, LOG_HEADER);
  const numCols = LOG_HEADER.length;
  const numRows = 998; // 涵蓋第2列到第999列，之後新資料都會自動套用
  const fullRange = sh.getRange(2, 1, numRows, numCols);

  // 欄位位置用 colOf() 動態換算成字母，不要寫死——之前 skuSummary/nameSummary 插入LOG_HEADER
  // 就讓這三欄從 H/I/J 位移到 J/K/L，寫死字母的話顏色規則會套錯欄位
  const colLetter = n => String.fromCharCode(64 + n); // 1->A, 2->B, ...
  const hadIssueCol = colLetter(colOf(LOG_HEADER,'hadIssue'));
  const hadManualEditCol = colLetter(colOf(LOG_HEADER,'hadManualEdit'));
  const importedExternalCol = colLetter(colOf(LOG_HEADER,'importedExternal'));
  const rules = [
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=$${hadIssueCol}2="是"`)
      .setBackground('#f4cccc')
      .setRanges([fullRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=AND($${hadIssueCol}2<>"是",$${hadManualEditCol}2="是")`)
      .setBackground('#fff2cc')
      .setRanges([fullRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=AND($${hadIssueCol}2<>"是",$${hadManualEditCol}2<>"是",$${importedExternalCol}2="是")`)
      .setBackground('#cfe2f3')
      .setRanges([fullRange])
      .build()
  ];
  sh.setConditionalFormatRules(rules);
  Logger.log('已設定出貨紀錄分頁的顏色規則');
}

// ---------------- 一次性緊急修復用：還原插入貨號/品名欄位造成的舊資料列位移 ----------------
// 背景：ORDERS_HEADER／LOG_HEADER 中間插入 skuSummary/nameSummary 兩欄後，
// getSheet() 只會強制對齊「標題列」，部署前既有的「資料列」欄位內容還留在舊的欄位位置，
// 用新標題去讀就會整組錯位（例如舊的寄送方式被讀成claimedAt、舊的完成時間被讀成貨號…）。
// 這兩個函式在 Apps Script 編輯器裡選取後按「執行」各跑一次即可（不用重新部署），
// 會把還沒搬過的舊資料列平移回正確欄位，並補上貨號/品名兩欄。
// 判斷「這列是否還沒搬過」的方式：
//   訂單：新版「狀態」欄只會是 pending/scanning/shipped 三選一，不是的話代表還是舊版資料列。
//   出貨紀錄：新版「核對結果」欄一定有值（完成/完成（人工修正數量）），是空的代表還是舊版資料列。
// 已經是新版寫入的列會被自動略過，重複執行也不會壞資料，可以放心跑。
function migrateOrdersColumnShift(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ORDERS);
  if(!sh) { Logger.log('找不到「訂單」分頁'); return; }
  const lastRow = sh.getLastRow();
  if(lastRow < 2){ Logger.log('沒有資料列'); return; }
  const numCols = Math.max(sh.getLastColumn(), ORDERS_HEADER.length);
  const values = sh.getRange(2, 1, lastRow-1, numCols).getValues();
  const VALID_STATUS = {pending:1, scanning:1, shipped:1};
  const dateCol = colOf(ORDERS_HEADER,'date');
  let migrated = 0;
  values.forEach((row, i)=>{
    if(VALID_STATUS[row[6]]) return; // 第7欄已經是合法狀態值，代表這列已經是新版，跳過
    const orderNo=row[0], store=row[1], date=row[2], itemsJson=row[3];
    const oldStatus=row[4], oldClaimedBy=row[5], oldClaimedAt=row[6], oldUpdatedAt=row[7], oldShipMethod=row[8], oldRoutingStatus=row[9];
    const items = safeParse(itemsJson, []);
    const {skuSummary, nameSummary} = summarizeItems(items);
    const targetRow = i + 2;
    sh.getRange(targetRow, dateCol).setNumberFormat('@');
    sh.getRange(targetRow, 1, 1, ORDERS_HEADER.length).setValues([[
      orderNo, store, date, itemsJson, skuSummary, nameSummary,
      oldStatus || 'pending', oldClaimedBy || '', oldClaimedAt || '', oldUpdatedAt || '', oldShipMethod || '', oldRoutingStatus || ''
    ]]);
    migrated++;
  });
  Logger.log('訂單分頁：已還原 '+migrated+' 列舊資料的欄位位移');
}

function migrateLogColumnShift(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  if(!sh) { Logger.log('找不到「出貨紀錄」分頁'); return; }
  const lastRow = sh.getLastRow();
  if(lastRow < 2){ Logger.log('沒有資料列'); return; }
  const numCols = Math.max(sh.getLastColumn(), LOG_HEADER.length);
  const values = sh.getRange(2, 1, lastRow-1, numCols).getValues();
  const orderDateCol = colOf(LOG_HEADER,'orderDate');
  const timeCol = colOf(LOG_HEADER,'time');
  let migrated = 0;
  values.forEach((row, i)=>{
    if(row[18]) return; // 第19欄(核對結果)已經有值，代表這列已經是新版，跳過
    const orderNo=row[0], orderDate=row[1], waybill=row[2], itemsJson=row[3];
    const oldStaffId=row[4], oldStaffName=row[5], oldTime=row[6], oldHadIssue=row[7],
          oldHadManualEdit=row[8], oldImportedExternal=row[9], oldStore=row[10], oldShipMethod=row[11],
          oldNote=row[12], oldRequiredCount=row[13], oldScannedCount=row[14], oldRoutingStatus=row[15],
          oldCheckResult=row[16], oldDifferenceDetails=row[17];
    const items = safeParse(itemsJson, []);
    const {skuSummary, nameSummary} = summarizeItems(items);
    const targetRow = i + 2;
    sh.getRange(targetRow, orderDateCol).setNumberFormat('@');
    sh.getRange(targetRow, timeCol).setNumberFormat('@');
    sh.getRange(targetRow, 1, 1, LOG_HEADER.length).setValues([[
      orderNo, orderDate, waybill, itemsJson, skuSummary, nameSummary,
      oldStaffId, oldStaffName, oldTime, oldHadIssue, oldHadManualEdit, oldImportedExternal,
      oldStore, oldShipMethod, oldNote, oldRequiredCount, oldScannedCount, oldRoutingStatus,
      oldCheckResult, oldDifferenceDetails
    ]]);
    migrated++;
  });
  Logger.log('出貨紀錄分頁：已還原 '+migrated+' 列舊資料的欄位位移');
}

// ---------------- 一次性設定用：把「文山出貨V2」跟「國際碼」鏡像進這份後端試算表 ----------------
// 在 Apps Script 編輯器裡選這個函式、按「執行」跑一次即可（不用重新部署）。
// 直接複製原本兩個分頁自己的 IMPORTRANGE 公式，指向「真正的」原始資料來源
// （而不是再從「文山核對 工作區」轉一手——那兩個分頁本身也是IMPORTRANGE鏡像過去的，
// 直接接到源頭比較不會有雙層IMPORTRANGE刷新不穩定的問題）。
// 兩邊來源都只被「讀取」，不會寫入/修改任何東西，符合使用者「不可去動文山核對工作區」的交代。
// 跑完之後：
//   1. 打開這份後端試算表裡新出現的「文山出貨V2」「條碼轉品號」兩個分頁，
//      如果 A1 儲存格顯示「#REF! 這個公式參照到未經授權的外部資料範圍」，
//      點裡面的「允許存取」按鈕，做一次性授權（這一步一定要用瀏覽器手動點，Apps Script沒辦法代勞）。
//   2. 授權完成後，資料會自動載入，之後來源那邊資料有變動，這兩個分頁也會自動跟著更新
//      （IMPORTRANGE是活的連結，不是複製一次就結束）。
function setupImportedMirrorSheets(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 文山出貨V2：跟「文山核對 工作區」裡那個分頁自己的公式一模一樣，直接接到同一個源頭
  let orderSh = ss.getSheetByName('文山出貨V2');
  if(!orderSh) orderSh = ss.insertSheet('文山出貨V2');
  orderSh.getRange('A1').setFormula(
    '=CHOOSECOLS(IMPORTRANGE("1wMrjppENakDhT354VJ6-W7txoG9FSwYR2OjMzPRl2KQ","\'文山出貨V2\'!A:AE"),1,2,3,4,5,6,7,8,9,31)'
  );

  // 條碼轉品號：「國際碼」分頁本身也是IMPORTRANGE鏡像，直接接到它指向的真正來源
  let barcodeSh = ss.getSheetByName('條碼轉品號');
  if(!barcodeSh) barcodeSh = ss.insertSheet('條碼轉品號');
  barcodeSh.getRange('A1').setFormula(
    '=IMPORTRANGE("1rVAAGPeTc3p4m0xpKLnByteYELW1imuhLPhJhTmbI_8","\'國際碼對照表\'!A:E")'
  );

  Logger.log('已建立「文山出貨V2」「條碼轉品號」鏡像分頁，請打開這兩個分頁手動完成一次性授權（如果有跳出提示的話）。');
}
