/**
 * 文山出貨確認系統 —— 共用後端（部署為 Web App）
 *
 * 用途：讓多人、多台裝置同時使用同一份「待出貨清單／出貨紀錄／人員名單」，
 * 而不是各自存在自己瀏覽器的 localStorage 裡看不到彼此。
 *
 * 部署目標（使用者指定）：直接部署在既有的訂單來源試算表上——
 * https://docs.google.com/spreadsheets/d/1vCCJS_iHZDUnoFFjnqiT-ZySwCoKFxx4HXRwqrmtVmU
 * 這個腳本只會另外「新增」訂單／出貨紀錄／人員 三個分頁來存共用狀態，
 * 不會動到原本放訂單資料的那個分頁。
 * 風險提醒：如果這份試算表本身是被某個流程整份定期覆蓋重建（例如每次蝦皮匯出都整份重存），
 * 這裡新增的 訂單／出貨紀錄／人員 分頁可能會被一起清掉；如果只是原分頁的資料列被更新、
 * 整份檔案本身沒被取代，就完全不受影響。實際狀況要請使用者確認這份表的維護方式。
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
const BACKEND_VERSION = '2026-08-05.4';

// 分頁標籤跟欄位標題都用繁體中文，方便直接打開試算表看。內部程式邏輯（讀寫用的key）
// 還是用英文代碼，兩者分開靠 HEADER_LABELS 對應，不用整份程式碼牽動風險太大的改法。
const SHEET_ORDERS = '訂單';
const SHEET_LOG = '出貨紀錄';
const SHEET_STAFF = '人員';

// 舊分頁名稱（英文版）：第一次執行如果找不到中文分頁、但找得到對應的舊英文分頁，
// 會自動把舊分頁改名成新的中文名稱，資料原封不動保留，不用手動搬。
const LEGACY_SHEET_NAMES = { '訂單':'Orders', '出貨紀錄':'Log', '人員':'Staff' };

const ORDERS_HEADER = ['orderNo','store','date','itemsJson','status','claimedBy','claimedAt','updatedAt'];
const LOG_HEADER = ['orderNo','orderDate','waybill','itemsJson','staffId','staffName','time','hadIssue','hadManualEdit','importedExternal','store','shipMethod','note'];
const STAFF_HEADER = ['id','name'];

// 內部欄位代碼 → 試算表裡實際顯示的繁體中文標題
const HEADER_LABELS = {
  orderNo:'訂單號', store:'賣場', date:'日期', itemsJson:'品項資料(JSON)', status:'狀態',
  claimedBy:'認領人', claimedAt:'認領時間', updatedAt:'更新時間',
  orderDate:'訂單日期', waybill:'運單編號', staffId:'包貨人員工號', staffName:'包貨人員姓名',
  time:'完成時間', hadIssue:'曾觸發警示', hadManualEdit:'曾手動修改數量', importedExternal:'外部匯入',
  shipMethod:'運送方式', note:'備註', id:'工號', name:'姓名'
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
      claimedBy: r.claimedBy || '', claimedAt: r.claimedAt || ''
    };
  });
  const logRows = readRows(SHEET_LOG, LOG_HEADER);
  const log = logRows.map(r=>({
    orderNo: r.orderNo, orderDate: cellToText(r.orderDate), waybill: r.waybill,
    items: safeParse(r.itemsJson, []), staffId: r.staffId, staffName: r.staffName,
    time: cellToText(r.time, true), hadIssue: !!r.hadIssue, hadManualEdit: !!r.hadManualEdit,
    importedExternal: !!r.importedExternal, store: r.store, shipMethod: r.shipMethod, note: r.note
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
    const targetRow = existing ? existing._row : sh.getLastRow()+1;
    // 「日期」欄位（第3欄）強制設成純文字格式再寫入，避免 Google試算表把「2026/8/5」這種字串
    // 自動偵測轉成日期型別儲存格（那樣讀回來會變成UTC的ISO時間字串，跟原本存的字不一樣）
    sh.getRange(targetRow, 3).setNumberFormat('@');
    sh.getRange(targetRow, 1, 1, ORDERS_HEADER.length).setValues([[
      orderNo, o.store||'', String(o.date||''), itemsJson, 'pending', '', '', now
    ]]);
    if(existing) updated++; else added++;
  });
  return {ok:true, added, updated, skippedShipped};
}

// ---------------- 認領訂單（避免兩人同時掃同一張） ----------------
function claimOrder(orderNo, staffId, staffName){
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readRows(SHEET_ORDERS, ORDERS_HEADER);
  const row = rows.find(r=>r.orderNo===orderNo);
  if(!row) return {ok:false, reason:'not_found'};
  if(row.status === 'shipped') return {ok:false, reason:'already_shipped'};
  if(row.status === 'scanning' && row.claimedBy && row.claimedBy !== staffId){
    return {ok:false, reason:'claimed_by_other', claimedBy: row.claimedBy};
  }
  const now = new Date().toISOString();
  sh.getRange(row._row, 5, 1, 4).setValues([['scanning', staffId||'', now, now]]);
  return {ok:true, order: {orderNo: row.orderNo, store: row.store, date: cellToText(row.date), items: safeParse(row.itemsJson, [])}};
}

function releaseOrder(orderNo){
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readRows(SHEET_ORDERS, ORDERS_HEADER);
  const row = rows.find(r=>r.orderNo===orderNo);
  if(!row) return {ok:false, reason:'not_found'};
  if(row.status === 'shipped') return {ok:true}; // 已出貨就不用管了
  sh.getRange(row._row, 5, 1, 3).setValues([['pending', '', '']]);
  return {ok:true};
}

// ---------------- 完成出貨：標記已出貨＋寫入紀錄 ----------------
function finalizeShipment(entry){
  if(!entry || !entry.orderNo) return {ok:false, error:'missing orderNo'};
  const ordersSh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readRows(SHEET_ORDERS, ORDERS_HEADER);
  const row = rows.find(r=>r.orderNo===entry.orderNo);
  if(row){
    const now = new Date().toISOString();
    ordersSh.getRange(row._row, 5, 1, 4).setValues([['shipped', '', '', now]]);
  }
  appendLogRow(entry);
  return {ok:true};
}

function appendLogRow(entry){
  const logSh = getSheet(SHEET_LOG, LOG_HEADER);
  const targetRow = logSh.getLastRow()+1;
  // orderDate（第2欄）跟 time（第7欄）都長得像日期/時間字串，強制設純文字格式再寫，
  // 避免 Google試算表自動轉成日期型別（讀回來會變UTC ISO字串，顯示會跑掉）
  logSh.getRange(targetRow, 2).setNumberFormat('@');
  logSh.getRange(targetRow, 7).setNumberFormat('@');
  logSh.getRange(targetRow, 1, 1, LOG_HEADER.length).setValues([[
    entry.orderNo, String(entry.orderDate||''), entry.waybill||'', JSON.stringify(entry.items||[]),
    entry.staffId||'', entry.staffName||'', String(entry.time||''), !!entry.hadIssue, !!entry.hadManualEdit,
    !!entry.importedExternal, entry.store||'', entry.shipMethod||'', entry.note||''
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
    const row = byOrderNo[entry.orderNo];
    if(!row){ skippedNotFound++; return; }
    if(row.status === 'shipped'){ skippedAlreadyShipped++; return; }
    ordersSh.getRange(row._row, 5, 1, 4).setValues([['shipped', '', '', now]]);
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
