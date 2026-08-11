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
const BACKEND_VERSION = '2026-08-10.33';

// 分頁標籤跟欄位標題都用繁體中文，方便直接打開試算表看。內部程式邏輯（讀寫用的key）
// 還是用英文代碼，兩者分開靠 HEADER_LABELS 對應，不用整份程式碼牽動風險太大的改法。
const SHEET_ORDERS = '訂單';
const SHEET_LOG = '出貨紀錄';
const SHEET_STAFF = '人員';
const SHEET_SYSLOG = '系統紀錄';

// 舊分頁名稱（英文版）：第一次執行如果找不到中文分頁、但找得到對應的舊英文分頁，
// 會自動把舊分頁改名成新的中文名稱，資料原封不動保留，不用手動搬。
const LEGACY_SHEET_NAMES = { '訂單':'Orders', '出貨紀錄':'Log', '人員':'Staff' };

// manualClose（人工結案）加在最後面（不是插進中間），既有資料列不會位移，不用跑migration。
// 這一欄是給主管直接在試算表裡用下拉選單處理「不是由文山實際掃描出貨」的訂單用的：
// 別的門市／倉庫已經出掉的、缺貨取消的、整張取消的，選一個結案原因，APP待出貨清單就不會再顯示，
// 但資料列本身留著（有紀錄可追），不是直接把訂單刪掉。
// logisticsConfirmed／logisticsTime 一樣加在最後面，既有資料列不會位移，不用跑migration。
// 這兩欄記的是「包裝完成之後，有沒有真的被掃進物流籃」——來源是人員本來就在用的
// 「統計V2」分頁（他們在那裡掃訂單號確認上籃），我們只讀不寫。
// pickedJson：這張訂單「哪些品號已經揀好了」，存成 {"品號":{"by":"工號","at":"時間"}} 的JSON。
// 放在訂單列上而不是另開一張表，是為了讓 getState 不用多讀一張表——揀貨畫面要能秒開，
// 而 getState 本來就已經要讀「訂單」分頁了。稽核用的逐筆紀錄另外寫「揀貨紀錄」分頁。
const ORDERS_HEADER = ['orderNo','store','date','itemsJson','skuSummary','nameSummary','status','claimedBy','claimedAt','updatedAt','shipMethod','routingStatus','manualClose','logisticsConfirmed','logisticsTime','pickedJson'];
const SHEET_PICKLOG = '揀貨紀錄';
const PICKLOG_HEADER = ['logTime','orderNo','sku','baseName','location','qty','pickerId','pickerName','action'];
// 人工結案的三個選項，同時用在試算表的下拉選單驗證跟程式判斷，兩邊共用同一份定義不會不同步
const MANUAL_CLOSE_OPTIONS = ['出貨完成', '缺貨取消', '取消訂單'];
// 出貨紀錄改成「一列一品項」格式（品號一格一個，不再是itemsJson整包塞一欄+貨號/品名頓號串起來），
// 這樣原本另外開的「出貨紀錄明細」分頁就不需要了，兩個分頁合併成這一個。
// 同一次出貨如果有N個品項，出貨紀錄就會連續寫N列，訂單層級欄位（運單編號/包貨人員/完成時間等）每列都重複顯示。
// （原本另外開過一欄「verifyStatus」/「核對狀態」，後來依需求併回「核對結果」欄位本身，欄位已移除；
// 「無條碼手動核對明細」欄位也是同樣道理，後來依需求併回「差異明細」欄位，改成依貨號分別記錄。）
// hadNoBarcodeConfirm 原本放在最後面，2026-08-06再依需求移到differenceDetails前面——這是欄位中間插入
// （不是純append），既有資料列會跟著位移，需要跑一次migrateLogColumnReorder2_()把舊資料重新對齊。
const LOG_HEADER = ['store','orderNo','orderDate','waybill','shipMethod','sku','baseName','spec','qty','scanned','staffId','staffName','startTime','time','hadIssue','hadManualEdit','importedExternal','requiredCount','scannedCount','routingStatus','checkResult','hadNoBarcodeConfirm','differenceDetails','note'];
const STAFF_HEADER = ['id','name'];
// 系統自動處理掉的事情（目前只有「認領逾時自動釋放」）記在這裡，才不會無聲無息發生。
// 之後想看「是不是常常掉單、都是哪些人員/哪個時段」直接翻這個分頁就知道。
const SYSLOG_HEADER = ['logTime','event','orderNo','claimedBy','detail'];

// 內部欄位代碼 → 試算表裡實際顯示的繁體中文標題
const HEADER_LABELS = {
  orderNo:'訂單號', store:'賣場', date:'日期', itemsJson:'品項資料(JSON)',
  skuSummary:'貨號', nameSummary:'品名', status:'狀態',
  claimedBy:'認領人', claimedAt:'認領時間', updatedAt:'更新時間',
  orderDate:'訂單日期', waybill:'運單編號', staffId:'包貨人員工號', staffName:'包貨人員姓名',
  time:'完成時間', hadIssue:'曾觸發警示', hadManualEdit:'曾手動修改數量', importedExternal:'外部匯入',
  shipMethod:'寄送方式', note:'備註', id:'工號', name:'姓名',
  requiredCount:'需求件數', scannedCount:'掃描件數', routingStatus:'訂單狀態', checkResult:'核對結果',
  differenceDetails:'差異明細', startTime:'確認訂單開始時間',
  baseName:'品名', spec:'規格', sku:'品號', qty:'數量', scanned:'已掃數量',
  hadNoBarcodeConfirm:'曾無條碼手動核對', manualClose:'人工結案',
  logTime:'時間', event:'事件', detail:'說明',
  logisticsConfirmed:'確認物流', logisticsTime:'物流確認時間',
  pickedJson:'已揀品項(JSON)', pickerId:'揀貨人工號', pickerName:'揀貨人姓名', location:'儲位', action:'動作'
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
      case 'runOneTimeSetup': result = runOneTimeSetup(body.name, body.arg); break;
      case 'uploadFileToDrive': result = uploadFileToDrive(body.folderId, body.fileName, body.content, body.mimeType); break;
      case 'logNetFailures': result = logNetFailures(body.entries || []); break;
      case 'markPickedBatch': result = markPickedBatch(body.ops || []); break;
      // 部署腳本用來確認「doPost 這條路徑」也真的更新到新版了。
      // 只看 doGet 回報的版本號不夠：兩邊的更新有時差，doGet 已經是新版但 doPost
      // 還在跑舊程式碼的情況實際發生過好幾次，結果就是部署完馬上執行一次性函式時
      // 用到舊邏輯，而且不會報錯，很難發現。
      case '__versioncheck__': result = {ok:true, version: BACKEND_VERSION}; break;
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

// Apps Script編輯器裡「選取函式來執行」下拉選單偶爾會卡住/漏列某些函式（曾經實際發生過，
// 重新整理、重開分頁都沒用），這裡開一個白名單讓一次性設定/修復函式也能直接用API觸發，
// 不用完全依賴那個下拉選單。只有白名單內的名字可以被呼叫，不能任意呼叫檔案裡其他函式。
const ONE_TIME_SETUP_FUNCTIONS = {
  migrateLogToPerItemFormat_: () => migrateLogToPerItemFormat_(),
  migrateLogColumnReorder_: () => migrateLogColumnReorder_(),
  migrateLogColumnReorder2_: () => migrateLogColumnReorder2_(),
  migrateOrdersColumnShift: () => migrateOrdersColumnShift(),
  setupLogSheetColors: () => setupLogSheetColors(),
  deleteLegacyEmptySheets: () => deleteLegacyEmptySheets(),
  setupImportedMirrorSheets: () => setupImportedMirrorSheets(),
  rebuildOrderDetailSheet_: () => rebuildOrderDetailSheet_(),
  deleteTestOrders_: () => deleteTestOrders_(),
  fixRequiredScannedCountDisplay_: () => fixRequiredScannedCountDisplay_(),
  fixScannedCountCheckmark_: () => fixScannedCountCheckmark_(),
  fixMismatchResolutionNote_: () => fixMismatchResolutionNote_(),
  fixOverScanNote_: () => fixOverScanNote_(),
  autoSyncOrders_: () => autoSyncOrders_(),
  backupAndClearShippingLog_: () => backupAndClearShippingLog_(),
  installAutomationTriggers_: () => installAutomationTriggers_(),
  setupOrderManualCloseDropdown_: () => setupOrderManualCloseDropdown_(),
  setupOrderSheetColors: () => setupOrderSheetColors(),
  setupDashboardSheet_: () => setupDashboardSheet_(),
  debugReadDashboard_: () => debugReadDashboard_(),
  releaseStaleClaims_: () => releaseStaleClaims_(),
  syncNativeOrderSheet_: () => syncNativeOrderSheet_(),
  syncLogisticsConfirm_: () => syncLogisticsConfirm_(),
  findScriptProjects_: () => findScriptProjects_(),
  inspectSourceSpreadsheet_: (arg) => inspectSourceSpreadsheet_(arg),
  inspectSheetFormulas_: (arg) => inspectSheetFormulas_(arg),
  listFolder_: (arg) => listFolder_(arg),
  findSheetOwner_: (arg) => findSheetOwner_(arg),
  hourlySync_: () => hourlySync_(),
  testStaleClaimRelease_: () => testStaleClaimRelease_(),
  migrateOrderStatusToChinese_: () => migrateOrderStatusToChinese_(),
  archiveShippedOrders_: () => archiveShippedOrders_(),
  previewArchiveShippedOrders_: () => previewArchiveShippedOrders_(),
  fixCheckResultEmoji_: () => fixCheckResultEmoji_(),
  fixBooleanColumnEmoji_: () => fixBooleanColumnEmoji_(),
  mergeVerifyStatusIntoCheckResult_: () => mergeVerifyStatusIntoCheckResult_(),
  mergeNoBarcodeDetailIntoDifferenceDetails_: () => mergeNoBarcodeDetailIntoDifferenceDetails_(),
  fixNoteHadNoBarcodeConfirmShift_: () => fixNoteHadNoBarcodeConfirmShift_(),
  debugConditionalFormatRules_: () => debugConditionalFormatRules_(),
  authorizeDriveAccess_: () => authorizeDriveAccess_()
};
function runOneTimeSetup(name, arg){
  const fn = ONE_TIME_SETUP_FUNCTIONS[name];
  if(!fn) return {ok:false, error:'unknown setup function: '+name};
  const result = fn(arg);
  return {ok:true, ran:name, result: result===undefined ? null : result};
}

// 暫時性診斷用：把出貨紀錄目前實際存的條件式格式規則（公式＋顏色＋範圍）以JSON回傳，
// 方便直接從API看到規則到底存成什麼樣子，不用猜。用完可以刪掉，不是常駐功能。
function debugConditionalFormatRules_(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  if(!sh) return {error:'no sheet'};
  const rules = sh.getConditionalFormatRules();
  return rules.map(r=>{
    const cond = r.getBooleanCondition();
    return {
      formula: cond ? cond.getCriteriaValues()[0] : null,
      background: cond ? cond.getBackground() : null,
      ranges: r.getRanges().map(rg=>rg.getA1Notation())
    };
  });
}

// 把APP原始碼（index.html）之類的檔案放進使用者自己的Google雲端硬碟指定資料夾——
// 這個腳本本來只用到SpreadsheetApp，第一次呼叫到DriveApp（雲端硬碟）時Google會需要
// 額外授權範圍，這一步一定要使用者自己在Apps Script編輯器裡手動執行這個函式一次
// 才會跳出授權視窗（透過API用HTTP呼叫沒有互動畫面，跳不出授權提示，只會直接失敗）。
// 之後授權過一次，不管是編輯器執行還是API呼叫都可以正常用。
// 同名檔案已存在就先丟進垃圾桶再建新的，不會越傳越多份同名檔案。
function uploadFileToDrive(folderId, fileName, content, mimeType){
  const folder = DriveApp.getFolderById(folderId);
  const existing = folder.getFilesByName(fileName);
  while(existing.hasNext()){ existing.next().setTrashed(true); }
  const file = folder.createFile(fileName, content, mimeType || MimeType.HTML);
  return {fileId: file.getId(), url: file.getUrl()};
}

// 專門用來觸發雲端硬碟授權畫面的函式——在 Apps Script 編輯器裡選這個、按「執行」，
// 才會跳出「這個應用程式需要存取你的Google帳戶」的授權視窗，點「允許」就完成授權，
// 之後 uploadFileToDrive 不管是編輯器執行還是API呼叫都能正常用了。跑一次就好，之後不用再跑。
function authorizeDriveAccess_(){
  // 一定要真的「寫」一次（不能只是讀），Google才會請求完整的drive寫入權限範圍，
  // 只讀資料夾名稱那種操作只會拿到唯讀權限，之後createFile()還是會失敗。
  const folder = DriveApp.getFolderById('1quwo_65K5YQMZtuLD-vkheg-g97kYond');
  const testFile = folder.createFile('_授權測試_可刪除', '測試寫入權限', MimeType.PLAIN_TEXT);
  testFile.setTrashed(true);
  Logger.log('雲端硬碟授權成功（讀寫都已確認）');
  // 建立/管理時間觸發器（installAutomationTriggers_要用）也是獨立的授權範圍，跟DriveApp分開，
  // 這裡一併順便觸發，不用再為了這個另外跑一次授權流程。
  ScriptApp.getProjectTriggers();
  Logger.log('時間觸發器管理權限授權成功。');
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
  const orderRows = readOrderRows();
  const orders = {};
  orderRows.forEach(r=>{
    orders[r.orderNo] = {
      orderNo: r.orderNo, store: r.store, date: cellToText(r.date),
      items: safeParse(r.itemsJson, []), status: r.status,
      claimedBy: r.claimedBy || '', claimedAt: r.claimedAt || '',
      shipMethod: r.shipMethod || '', routingStatus: r.routingStatus || '',
      manualClose: String(r.manualClose || '').trim(),
      logisticsConfirmed: String(r.logisticsConfirmed || '').trim(),
      logisticsTime: String(r.logisticsTime || '').trim()
    };
    // 把「已揀」狀態掛回各品項上，前端就不用自己再對一次
    const picked = safeParse(r.pickedJson, {});
    orders[r.orderNo].items.forEach(it=>{
      const hit = picked[it.sku];
      if(hit){ it.picked = true; it.pickedBy = hit.by || ''; it.pickedAt = hit.at || ''; }
    });
  });
  // 出貨紀錄現在存的是「一列一品項」，同一次出貨的N個品項會連續寫N列（訂單層級欄位重複），
  // 這裡依「訂單號+完成時間」把同一次出貨的品項列重新組回一筆帶items陣列的紀錄，
  // 維持給前端APP的資料格狀跟以前一樣（APP自己畫面上還是把出貨紀錄當「一次出貨一筆」呈現）。
  const logRows = readRows(SHEET_LOG, LOG_HEADER);
  const logGroups = {};
  const logKeyOrder = [];
  logRows.forEach(r=>{
    const key = r.orderNo + '||' + r.time;
    if(!logGroups[key]){
      logGroups[key] = {
        orderNo: r.orderNo, orderDate: cellToText(r.orderDate), waybill: r.waybill,
        items: [], staffId: r.staffId, staffName: r.staffName,
        time: cellToText(r.time, true), hadIssue: textToBool(r.hadIssue), hadManualEdit: textToBool(r.hadManualEdit),
        importedExternal: textToBool(r.importedExternal), store: r.store, shipMethod: r.shipMethod, note: r.note,
        requiredCount: r.requiredCount || '', scannedCount: r.scannedCount || '',
        routingStatus: r.routingStatus || '', checkResult: r.checkResult || '',
        differenceDetails: r.differenceDetails || '', startTime: cellToText(r.startTime, true) || '',
        hadNoBarcodeConfirm: textToBool(r.hadNoBarcodeConfirm)
      };
      logKeyOrder.push(key);
    }
    if(r.sku || r.baseName){
      const displayName = r.spec ? `${r.baseName}（${r.spec}）` : (r.baseName || '');
      logGroups[key].items.push({sku: r.sku, name: displayName, baseName: r.baseName, spec: r.spec, qty: r.qty, scanned: r.scanned});
    }
  });
  const log = logKeyOrder.map(k=>logGroups[k]).reverse(); // 最新的在前面
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
// 是/否文字後面加燈號emoji方便肉眼掃視：否＝綠燈（沒事），是＝橘燈（有觸發/有發生，要留意）。
function boolToText(b){ return b ? '是 🟠' : '否 🟢'; }
// 用indexOf而不是完全比對字串，這樣不管是舊資料（純「是」/「否」沒有emoji）
// 還是新資料（「是 🟠」/「否 🟢」）都能正確判讀，不用特地跑migration轉換舊資料。
function textToBool(v){ return v === true || String(v).indexOf('是') === 0; }

// 「狀態」欄比照是非欄位的做法：試算表裡存繁體中文方便直接看，程式內部（含前端APP）
// 一律還是用英文代碼判斷，兩邊靠這組對照轉換，不用把散在各處的狀態比較全部改掉。
// 文字後面加燈號emoji的做法跟出貨紀錄的是非欄位一致：即使沒開啟顏色格式（匯出CSV、
// 手機小螢幕看不清背景色）也能一眼看出狀態。藍＝還在排隊等出貨、橘＝有人正在處理、綠＝完成。
const STATUS_LABELS = {pending:'待出貨 🔵', scanning:'掃描中 🟠', shipped:'已出貨 🟢'};
const STATUS_FROM_LABEL = {'待出貨':'pending', '掃描中':'scanning', '已出貨':'shipped'};
function statusToText(s){ return STATUS_LABELS[s] || s || ''; }
// 三種格式都要讀得懂，才能不強制跑資料轉換也正常運作（轉換只是為了讓試算表看起來一致）：
//   舊的英文代碼（pending/scanning/shipped）、純中文（待出貨）、中文+燈號（待出貨 🔵）。
// 中文+燈號用「開頭比對」處理，比照 textToBool() 用 indexOf 的做法，
// 以後燈號要換或要在後面加字都不用再改這裡。
function textToStatus(v){
  const s = String(v||'').trim();
  if(STATUS_FROM_LABEL[s]) return STATUS_FROM_LABEL[s];
  for(const label in STATUS_FROM_LABEL){
    if(s.indexOf(label) === 0) return STATUS_FROM_LABEL[label];
  }
  return s;
}
// 讀「訂單」分頁一律走這個，狀態欄在這裡統一轉成英文代碼，
// 後面所有 row.status === 'shipped' 之類的判斷就完全不用動。
function readOrderRows(){
  const rows = readRows(SHEET_ORDERS, ORDERS_HEADER);
  rows.forEach(r=>{ r.status = textToStatus(r.status); });
  return rows;
}

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
  // 先把逾時的認領放回待出貨，再讀資料——順序不能顛倒，不然下面的 keepClaim 會把
  // 那些其實早就沒人在處理的訂單當成「正在掃描中」保護起來，等於永遠釋放不掉。
  releaseStaleClaims_();
  const rows = readOrderRows();
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
    // 防呆：如果這張訂單目前正在被認領/掃描中，重新同步只更新品項/賣場等資料本身，
    // 不要動狀態／認領人／認領時間——不然等於把人家正在處理的訂單無聲無息退回待處理，
    // 之後如果又被別人認領，同一張訂單就可能被兩個人各自完成一次出貨，造成重複出貨紀錄。
    const keepClaim = existing && existing.status === 'scanning';
    // 用「欄位名稱→值」再依 ORDERS_HEADER 順序取值，之後再加欄位這裡完全不用改，
    // 也不會發生手寫的陣列少一格就整列往左位移的問題（出貨紀錄那邊已經吃過這種虧）。
    const rowObj = {
      orderNo: orderNo, store: o.store||'', date: String(o.date||''), itemsJson: itemsJson,
      skuSummary: skuSummary, nameSummary: nameSummary,
      status: statusToText(keepClaim ? existing.status : 'pending'),
      claimedBy: keepClaim ? existing.claimedBy : '',
      claimedAt: keepClaim ? existing.claimedAt : '',
      updatedAt: now, shipMethod: o.shipMethod||'', routingStatus: o.routingStatus||'',
      // 人工結案是主管在試算表裡自己填的，同步只是更新訂單內容，絕對不能把它洗掉——
      // 不然結案完的訂單下一輪自動同步就又跳回待出貨清單，等於白結。
      manualClose: existing ? (existing.manualClose||'') : '',
      // 物流籃確認同理：那是人員實際掃出來的結果，同步只更新訂單內容，不能覆蓋掉
      logisticsConfirmed: existing ? (existing.logisticsConfirmed||'') : '',
      logisticsTime: existing ? (existing.logisticsTime||'') : '',
      // 揀貨狀態是人員實際揀出來的，同步只更新訂單內容，不能洗掉
      pickedJson: existing ? (existing.pickedJson||'') : ''
    };
    sh.getRange(targetRow, 1, 1, ORDERS_HEADER.length).setValues([ORDERS_HEADER.map(h=>rowObj[h])]);
    if(existing) updated++; else added++;
  });
  rebuildOrderDetailSheet_();
  // 顏色規則的範圍依實際列數計算，所以每次同步完（訂單列數可能變多）都要重新套用一次，
  // 新增的訂單才不會落在規則範圍外變成沒有顏色。順便也有自動修復的效果：
  // 萬一哪個一次性函式把分頁重建掉、規則跟著消失，下一次同步就會自己補回來。
  setupOrderSheetColors();
  return {ok:true, added, updated, skippedShipped};
}

// ---------------- 自動排程：配合蝦皮隔日到貨，一天四次自動同步訂單，不用等人手動按同步鈕 ----------------
// 直接讀「文山出貨V2」鏡像分頁本身（IMPORTRANGE即時同步自真正源頭），不用像前端那樣還要fetch
// CSV文字自己解析——Apps Script可以直接用SpreadsheetApp拿到已經解析好型別的儲存格值，比較穩。
// 邏輯完全比照 index.html 的 syncOrders()：用「訂單」「品號」「數量」三欄判斷資料完整性，
// 用「訂單狀態」欄篩選只留本倉（文山）負責的訂單，同一張訂單同一個品號的數量會加總。
// 週六日／國定假日／颱風假不出貨：這裡完全不用特別處理，觸發器照排程執行，
// 只是那幾天源頭多半沒有「文山」狀態的新資料、同步等於空跑，訂單本身會照樣累積在「訂單」
// 分頁等到下一個營業日才被掃描出貨，跟平常一模一樣，不需要另外寫假日判斷邏輯。
// 本倉要負責出貨的「訂單狀態」：文山本身，加上調撥中的訂單（調中華／調OM／調山物／調中華+OM…）——
// 調撥的最後還是會回到文山出貨，先匯進來不用等來源改狀態才看得到；等來源把狀態改回「文山」也不會
// 變成兩張訂單（mergeOrders是同一個訂單號就更新既有那一列）。其餘狀態（山物出、1、2、3…）不屬於本倉。
// 這裡的判斷邏輯要跟 index.html 的 HANDLED_STATUS_MODES['文山+調撥'] 保持一致，
// 不然手動按同步跟自動排程同步會匯進不一樣的訂單。
// 來源沒填狀態的（空白）一律放行，跟前端一樣，不要因為來源漏填就整張訂單被擋掉沒人出貨。
function isHandledRoutingStatus_(status){
  const s = String(status||'').trim();
  if(!s) return true;
  return s === '文山' || s.indexOf('調') === 0;
}
const MIRROR_ORDER_SHEET_NAME = '文山出貨V2';
function autoSyncOrders_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(MIRROR_ORDER_SHEET_NAME);
  if(!sh){ Logger.log('找不到「'+MIRROR_ORDER_SHEET_NAME+'」鏡像分頁，無法自動同步'); return; }
  const values = sh.getDataRange().getValues();
  if(values.length < 2){ Logger.log('鏡像分頁目前沒有資料列，略過這次自動同步'); return; }
  const header = values[0];
  const idx = name => header.indexOf(name);
  const iOrder = idx('訂單'), iSku = idx('品號'), iName = idx('品名'), iSpec = idx('規格'),
        iQty = idx('數量'), iStore = idx('賣場'), iDate = idx('日期'), iStatus = idx('訂單狀態'),
        iShipMethod = idx('寄送方式'),
        // 揀貨用：儲位決定走動路線，庫存讓人員當場判斷是不是真的缺貨
        iLocation = idx('文山儲位'), iStockWs = idx('文山'), iStockMain = idx('總倉'),
        // 分配欄位：決定這件是文山自己揀，還是要從別的門店調撥過來
        iShort = idx('缺貨量'), iAllocWs = idx('文山分配'), iAllocSp = idx('山物分配'),
        iAllocZh = idx('中華分配'), iAllocOm = idx('OM分配');
  if(iOrder < 0 || iSku < 0 || iQty < 0){
    Logger.log('鏡像分頁欄位格式不符（找不到訂單/品號/數量欄），無法自動同步');
    return;
  }

  const parsed = {};
  let skippedRows = 0, skippedOtherWarehouse = 0;
  for(let i = 1; i < values.length; i++){
    const row = values[i];
    const orderNo = String(row[iOrder]||'').trim();
    const sku = String(row[iSku]||'').trim();
    const qty = parseInt(row[iQty], 10);
    if(!orderNo || !sku || isNaN(qty)){ skippedRows++; continue; }
    if(iStatus >= 0 && !isHandledRoutingStatus_(row[iStatus])){ skippedOtherWarehouse++; continue; }
    const spec = iSpec>=0 ? String(row[iSpec]||'').trim() : '';
    const baseName = iName>=0 ? String(row[iName]||'').trim() : sku;
    const name = spec ? `${baseName}（${spec}）` : baseName;
    const store = iStore>=0 ? String(row[iStore]||'').trim() : '';
    const date = iDate>=0 ? parseOrderDate_(row[iDate]) : '';
    const shipMethod = iShipMethod>=0 ? String(row[iShipMethod]||'').trim() : '';
    const routingStatus = iStatus>=0 ? String(row[iStatus]||'').trim() : '';
    const location = iLocation>=0 ? String(row[iLocation]||'').trim() : '';
    const stockWs = iStockWs>=0 ? String(row[iStockWs]||'').trim() : '';
    const stockMain = iStockMain>=0 ? String(row[iStockMain]||'').trim() : '';
    const num = i => { const v = i>=0 ? parseInt(row[i], 10) : 0; return isNaN(v) ? 0 : v; };
    const allocWs = num(iAllocWs), allocSp = num(iAllocSp), allocZh = num(iAllocZh),
          allocOm = num(iAllocOm), shortQty = num(iShort);
    if(!parsed[orderNo]) parsed[orderNo] = {orderNo, store, date, shipMethod, routingStatus, items:[]};
    const existingItem = parsed[orderNo].items.find(it=>it.sku===sku);
    if(existingItem){
      existingItem.qty += qty;
      existingItem.allocWs += allocWs; existingItem.allocSp += allocSp;
      existingItem.allocZh += allocZh; existingItem.allocOm += allocOm;
      existingItem.shortQty += shortQty;
    } else {
      parsed[orderNo].items.push({sku, name, baseName, spec, qty, location, stockWs, stockMain,
        allocWs, allocSp, allocZh, allocOm, shortQty});
    }
  }

  const result = mergeOrders(parsed);
  syncNativeOrderSheet_(); // 順便把核對結果同步回舊的核對表單
  syncLogisticsConfirm_(); // 以及物流籃確認狀態
  Logger.log('自動同步完成：新增'+result.added+'／更新'+result.updated+'／已出貨略過'+result.skippedShipped
    +'，非本倉略過'+skippedOtherWarehouse+'，資料欄位不全略過'+skippedRows+'。');
}

// 跟 index.html 的 parseOrderDate()/excelSerialToDateStr() 邏輯對應：純數字字串當Excel序列日期換算，
// 一般字串取空白前的日期部分。多一種SpreadsheetApp才會遇到的情況：儲存格本身已經是Date型別
// （getValues()讀到的是真正的Date物件，不是CSV那種一定是文字），直接用cellToText()的邏輯格式化。
function parseOrderDate_(raw){
  if(raw instanceof Date){
    return Utilities.formatDate(raw, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy/M/d');
  }
  const s = String(raw||'').trim();
  if(!s) return '';
  if(/^\d+(\.\d+)?$/.test(s)){
    const ms = Math.round((Number(s) - 25569) * 86400 * 1000);
    return Utilities.formatDate(new Date(ms), 'UTC', 'yyyy/M/d');
  }
  return s.split(' ')[0];
}

// ---------------- 自動排程：每天晚上把「出貨紀錄」備份成獨立試算表，備份完清空準備隔天使用 ----------------
// 出貨紀錄不會無限長大（對照效能：整批讀取的耗時會隨資料量增加），也符合使用者要的
// 「備份後清空舊資料，尚未出貨的新資料繼續照樣累積」——這裡的「舊資料」單純指出貨紀錄本身，
// 「訂單」分頁裡還沒出貨的訂單完全不受影響，繼續留著等下一個營業日被掃描（週末/假日也一樣）。
// 同名檔案已存在就先丟垃圾桶再建新的，同一天重跑不會留下好幾份重複的備份檔。
const SHIPPING_LOG_BACKUP_FOLDER_ID = '1fC7kFv-6ozYmrY1S_up55R_yslcu2qYE';
function backupAndClearShippingLog_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_LOG);
  if(!sh){ Logger.log('找不到「出貨紀錄」分頁'); return; }
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if(lastRow < 2){ Logger.log('出貨紀錄目前沒有資料，略過備份與清空'); return; }

  const tz = ss.getSpreadsheetTimeZone();
  const fileName = Utilities.formatDate(new Date(), tz, 'yyyy_MM_dd') + '_已出貨備份';
  const allValues = sh.getRange(1, 1, lastRow, lastCol).getValues();

  const folder = DriveApp.getFolderById(SHIPPING_LOG_BACKUP_FOLDER_ID);
  const existing = folder.getFilesByName(fileName);
  while(existing.hasNext()){ existing.next().setTrashed(true); }

  const backupSs = SpreadsheetApp.create(fileName);
  const backupSh = backupSs.getSheets()[0];
  backupSh.setName(SHEET_LOG);
  backupSh.getRange(1, 1, allValues.length, lastCol).setValues(allValues);
  const backupFile = DriveApp.getFileById(backupSs.getId());
  folder.addFile(backupFile);
  DriveApp.getRootFolder().removeFile(backupFile); // 只留在指定資料夾，不要同時出現在雲端硬碟根目錄

  sh.getRange(2, 1, lastRow - 1, lastCol).clearContent(); // 只清內容，條件式格式規則不會被清掉，明天新資料一樣自動套色
  Logger.log('已備份 '+(allValues.length-1)+' 列出貨紀錄到「'+fileName+'」，並清空出貨紀錄分頁準備明天使用。');
}

// ---------------- 一次性設定用：在「訂單」分頁的「人工結案」欄裝下拉選單 ----------------
// 不是由文山實際掃描出貨的訂單（別的門市/倉庫已經出掉、缺貨取消、整張訂單取消），
// 主管直接在試算表這一欄用下拉選單挑一個原因，APP的待出貨清單就不會再顯示這張訂單，
// 但資料列留著不刪，之後要查「這張到底怎麼結掉的」看這一欄就知道。
// 選單範圍鋪到第1000列，之後新同步進來的訂單也一樣有下拉選單可以選，不用每次重跑。
// 顏色規則統一由 setupOrderSheetColors() 一次設定（兩邊分開設定的話會互相覆蓋掉對方的規則）。
function setupOrderManualCloseDropdown_(){
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const col = colOf(ORDERS_HEADER, 'manualClose');
  const range = sh.getRange(2, col, 999, 1); // 第2列到第1000列
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(MANUAL_CLOSE_OPTIONS, true)
    .setAllowInvalid(false)
    .setHelpText('不是由文山掃描出貨的訂單，選一個結案原因；選了之後APP待出貨清單就不會再顯示這張訂單。')
    .build();
  range.setDataValidation(rule);
  setupOrderSheetColors(); // 順便把顏色規則一起套上，不用再多跑一個函式
  Logger.log('已在「訂單」分頁第'+col+'欄（人工結案）裝好下拉選單：'+MANUAL_CLOSE_OPTIONS.join('／')+'，範圍第2~1000列。');
}

// ---------------- 「訂單」分頁的顏色規則（狀態整列上色 ＋ 人工結案單欄上色）----------------
// 兩組規則一定要在同一個函式裡一次設定完：Google試算表的條件式格式是「先符合的先套用」，
// 分兩次 setConditionalFormatRules() 後面那次會整組蓋掉前面那次的規則。
// 順序也很重要——人工結案那一欄的規則要排在整列規則前面，否則整列的底色會蓋過去，
// 就看不出那一欄挑的是哪一種結案原因了。
// 顏色跟「核對結果」燈號同一套語意：藍＝等待中、橘＝進行中/要留意、綠＝完成、紅＝取消。
function setupOrderSheetColors(){
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const colLetter = n => String.fromCharCode(64 + n);
  const numCols = ORDERS_HEADER.length;
  // 範圍不要寫死一個固定數字（寫死1000的話訂單累積超過就默默沒顏色，不會有任何錯誤訊息），
  // 改成依目前實際列數再多留200列緩衝，並且在 mergeOrders() 每次同步完重新套用一次，
  // 這樣不管訂單累積到幾列都不會漏掉，分頁被重建導致規則消失也會自動補回來。
  const lastRow = Math.max(sh.getLastRow(), 2);
  const numRows = Math.max(Math.min(lastRow - 1 + 200, sh.getMaxRows() - 1), 1);

  const closeCol = colOf(ORDERS_HEADER, 'manualClose');
  const closeRange = sh.getRange(2, closeCol, numRows, 1);
  const closeLetter = colLetter(closeCol);
  const statusLetter = colLetter(colOf(ORDERS_HEADER, 'status'));
  const fullRange = sh.getRange(2, 1, numRows, numCols);

  const rules = [];
  // 1. 人工結案欄（單欄，優先）
  const closeColor = {'出貨完成':'#cfe2f3', '缺貨取消':'#fce5cd', '取消訂單':'#f4cccc'};
  MANUAL_CLOSE_OPTIONS.forEach(opt=>{
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=$${closeLetter}2="${opt}"`)
      .setBackground(closeColor[opt])
      .setRanges([closeRange])
      .build());
  });
  // 2. 已經人工結案的訂單整列打灰，一眼看出這張不用出（比狀態本身的顏色優先）
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(`=$${closeLetter}2<>""`)
    .setBackground('#e0e0e0')
    .setRanges([fullRange])
    .build());
  // 3. 依狀態整列上色。狀態欄存的是「待出貨 🔵」這種中文+燈號，用 LEFT() 只比對前面的中文字，
  //    取幾個字直接由標籤本身的長度算出來——不要寫死數字，不然哪天狀態改成四個字（例如「待出貨中」）
  //    比對就會不相等、顏色無聲無息消失。用 LEFT 而不是完整比對，是為了讓還沒加燈號的舊資料也吃得到。
  const statusColor = {'待出貨':'#cfe2f3', '掃描中':'#fce5cd', '已出貨':'#d9ead3'};
  Object.keys(statusColor).forEach(label=>{
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=LEFT($${statusLetter}2,${label.length})="${label}"`)
      .setBackground(statusColor[label])
      .setRanges([fullRange])
      .build());
  });
  sh.setConditionalFormatRules(rules);
  Logger.log('已套用「訂單」分頁顏色規則：待出貨(藍)／掃描中(橘)／已出貨(綠)，人工結案整列打灰，'
    +'共'+rules.length+'條規則，範圍第2~'+(numRows+1)+'列。');
}

// ---------------- 一次性修復用：把「訂單」分頁既有的英文狀態值換成繁體中文 ----------------
// 程式本身英文中文都讀得懂（textToStatus兩種都吃），這個只是讓試算表看起來一致，
// 不跑也不會壞。已經是中文的列會跳過，可以放心重複執行。
function migrateOrderStatusToChinese_(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ORDERS);
  if(!sh){ Logger.log('找不到「訂單」分頁'); return; }
  const lastRow = sh.getLastRow();
  if(lastRow < 2){ Logger.log('訂單分頁目前沒有資料列'); return; }
  const col = colOf(ORDERS_HEADER, 'status');
  const range = sh.getRange(2, col, lastRow-1, 1);
  const values = range.getValues();
  let changed = 0;
  // 英文代碼、純中文、中文+燈號 都先用 textToStatus() 轉回代碼，再統一寫成目前的標準寫法，
  // 所以不管跑幾次、之前是哪一種格式，跑完都會變成一致的「中文 + 燈號」。
  const out = values.map(([v])=>{
    const label = STATUS_LABELS[textToStatus(v)];
    if(label && label !== String(v||'').trim()){ changed++; return [label]; }
    return [v];
  });
  if(changed) range.setValues(out);
  Logger.log('已把 '+changed+' 列的狀態統一成「中文＋燈號」寫法（共'+values.length+'列）。');
}

// ---------------- 自動排程：已出貨訂單定期歸檔，避免「訂單」分頁無限長大 ----------------
// 已出貨的訂單原本要一直留著，才能在重新同步時被擋掉（skippedShipped），不然來源資料還在的話
// 會又被當成新訂單加回待出貨清單造成重複出貨——所以歸檔不能單看「已出貨」就搬走，一定要確認
// 這張訂單「已經不在來源資料裡了」，搬走之後才不可能被重新匯入。
// 三道保險，任何一道不過就整個略過不動，寧可晚幾天歸檔也不要誤刪造成重複出貨：
//   1. 來源鏡像分頁讀不到／沒有資料列 → 直接放棄（IMPORTRANGE載入中或壞掉時整份會是空的，
//      這時候每一張都會看起來「不在來源」，照做會把所有已出貨訂單一次全搬走）。
//   2. 訂單編號還出現在來源資料裡 → 留著。
//   3. 出貨完成時間距今未滿保留天數 → 留著（給來源資料一點延遲時間，也保留近期可查詢的資料）。
const SHIPPED_ORDER_RETENTION_DAYS = 7;
const SHIPPED_ORDER_ARCHIVE_FOLDER_ID = '1fC7kFv-6ozYmrY1S_up55R_yslcu2qYE';
function archiveShippedOrders_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_ORDERS);
  if(!sh){ Logger.log('找不到「訂單」分頁'); return; }

  // 保險1：來源鏡像分頁一定要讀得到而且有資料，否則不做任何事
  const mirror = ss.getSheetByName(MIRROR_ORDER_SHEET_NAME);
  if(!mirror){ Logger.log('找不到「'+MIRROR_ORDER_SHEET_NAME+'」鏡像分頁，為安全起見略過歸檔'); return; }
  const mirrorValues = mirror.getDataRange().getValues();
  if(mirrorValues.length < 2){
    Logger.log('鏡像分頁目前沒有資料列（可能還在載入或IMPORTRANGE異常），為安全起見略過歸檔');
    return;
  }
  const mirrorHeader = mirrorValues[0];
  const iOrder = mirrorHeader.indexOf('訂單');
  if(iOrder < 0){ Logger.log('鏡像分頁找不到「訂單」欄，為安全起見略過歸檔'); return; }
  const stillInSource = {};
  for(let i = 1; i < mirrorValues.length; i++){
    const no = String(mirrorValues[i][iOrder]||'').trim();
    if(no) stillInSource[no] = true;
  }

  const cutoff = Date.now() - SHIPPED_ORDER_RETENTION_DAYS * 86400 * 1000;
  const rows = readOrderRows();
  const toArchive = rows.filter(r=>{
    if(r.status !== 'shipped') return false;                    // 只搬已出貨的
    if(stillInSource[String(r.orderNo||'').trim()]) return false; // 保險2：來源還有就留著
    const shippedAt = Date.parse(r.updatedAt);                   // 保險3：太新的留著
    if(isNaN(shippedAt) || shippedAt > cutoff) return false;
    return true;
  });
  if(!toArchive.length){ Logger.log('目前沒有符合歸檔條件的已出貨訂單，不動作。'); return; }

  // 先備份再刪，備份失敗就會直接拋錯中斷，不會發生「刪掉了但沒備份成功」
  const tz = ss.getSpreadsheetTimeZone();
  const fileName = Utilities.formatDate(new Date(), tz, 'yyyy_MM_dd') + '_已出貨訂單歸檔';
  const displayHeader = ORDERS_HEADER.map(h => HEADER_LABELS[h] || h);
  const archiveRows = toArchive.map(r=>
    ORDERS_HEADER.map(h=> h==='status' ? statusToText(r[h]) : r[h])
  );
  const folder = DriveApp.getFolderById(SHIPPED_ORDER_ARCHIVE_FOLDER_ID);
  const existing = folder.getFilesByName(fileName);
  while(existing.hasNext()){ existing.next().setTrashed(true); }
  const archiveSs = SpreadsheetApp.create(fileName);
  const archiveSh = archiveSs.getSheets()[0];
  archiveSh.setName(SHEET_ORDERS);
  archiveSh.getRange(1, 1, 1, displayHeader.length).setValues([displayHeader]);
  archiveSh.getRange(2, 1, archiveRows.length, ORDERS_HEADER.length).setValues(archiveRows);
  const archiveFile = DriveApp.getFileById(archiveSs.getId());
  folder.addFile(archiveFile);
  DriveApp.getRootFolder().removeFile(archiveFile);

  // 由下往上刪，不然刪掉一列之後下面的列號會往上跑，會刪錯列
  toArchive.map(r=>r._row).sort((a,b)=>b-a).forEach(rowNum=> sh.deleteRow(rowNum));

  rebuildOrderDetailSheet_(); // 訂單少了幾張，明細分頁跟著重建才不會對不起來
  Logger.log('已歸檔 '+toArchive.length+' 張已出貨訂單到「'+fileName+'」並從訂單分頁移除'
    +'（條件：已出貨＋來源已無此訂單＋出貨滿'+SHIPPED_ORDER_RETENTION_DAYS+'天）。');
}

// 試跑用：只計算「如果現在跑歸檔會搬走哪些訂單」，不動任何資料，直接把結果回傳成JSON。
// 正式跑 archiveShippedOrders_() 之前先用這個確認範圍對不對，比較安心。
function previewArchiveShippedOrders_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const mirror = ss.getSheetByName(MIRROR_ORDER_SHEET_NAME);
  if(!mirror) return {ok:false, reason:'找不到鏡像分頁，正式執行會直接略過不動作'};
  const mirrorValues = mirror.getDataRange().getValues();
  if(mirrorValues.length < 2) return {ok:false, reason:'鏡像分頁沒有資料列，正式執行會直接略過不動作'};
  const iOrder = mirrorValues[0].indexOf('訂單');
  if(iOrder < 0) return {ok:false, reason:'鏡像分頁找不到「訂單」欄，正式執行會直接略過不動作'};
  const stillInSource = {};
  for(let i = 1; i < mirrorValues.length; i++){
    const no = String(mirrorValues[i][iOrder]||'').trim();
    if(no) stillInSource[no] = true;
  }
  const cutoff = Date.now() - SHIPPED_ORDER_RETENTION_DAYS * 86400 * 1000;
  const rows = readOrderRows();
  const shipped = rows.filter(r=>r.status === 'shipped');
  const wouldArchive = [], keptInSource = [], keptTooNew = [];
  shipped.forEach(r=>{
    const no = String(r.orderNo||'').trim();
    if(stillInSource[no]){ keptInSource.push(no); return; }
    const shippedAt = Date.parse(r.updatedAt);
    if(isNaN(shippedAt) || shippedAt > cutoff){ keptTooNew.push(no + '（' + (r.updatedAt||'無出貨時間') + '）'); return; }
    wouldArchive.push(no);
  });
  return {
    ok: true,
    保留天數: SHIPPED_ORDER_RETENTION_DAYS,
    訂單總數: rows.length,
    已出貨: shipped.length,
    這次會歸檔: wouldArchive.length,
    會歸檔的訂單: wouldArchive,
    留著_來源還有這張: keptInSource.length,
    留著_出貨未滿保留天數: keptTooNew.length,
    留著的明細_未滿天數: keptTooNew.slice(0, 20)
  };
}

// ---------------- 「儀表板」分頁：即時營運概況 ----------------
// 刻意全部用「公式」而不是用腳本把數字算好寫進去：公式會在來源資料一變動就自動重算，
// 所以不需要另外排觸發器、也不用按重新整理，打開就是當下的狀況（這才叫即時）。
// 腳本只負責「把公式擺上去」，跑一次就好，之後不用再跑。
//
// 兩個關鍵的資料特性，公式都必須跟著配合，不然數字會錯：
//   1. 「狀態」欄存的是「待出貨 🔵」這種中文+燈號，所以比對一律用 "待出貨*" 萬用字元或 LEFT()。
//   2. 「出貨紀錄」是一列一品項，同一張訂單會佔好幾列；但「需求件數(R欄)」只填在該訂單的
//      第一列。所以要算「出貨了幾張訂單」就數 R 欄有值的列，不能直接數總列數（那是品項數）。
//
// 版面配置：會自動長高的區塊（掃描中/包貨人員/需注意紀錄）故意左右並排、都從第14列開始，
// 各自往下長也不會互相撞到；如果改成上下排，其中一個變長就會蓋掉下面那一區。
const SHEET_DASHBOARD = '儀表板';
function setupDashboardSheet_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_DASHBOARD);
  if(!sh) sh = ss.insertSheet(SHEET_DASHBOARD, 0); // 放在最前面，打開試算表第一眼就看到
  sh.clear();
  sh.clearConditionalFormatRules();
  // clear() 不會解除儲存格合併，一定要另外拆掉：不然改版面時（例如某個區塊從 J 欄搬到 G 欄）
  // 舊的合併會留在原地，跟新的合併範圍打架，畫面會亂掉。
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();

  const O = "'訂單'";   // 來源分頁名稱有中文，公式裡要加單引號
  const G = "'出貨紀錄'";

  // ---- 標題 ----
  sh.getRange('A1').setValue('文山出貨　即時儀表板');
  sh.getRange('A1:N1').merge().setFontSize(18).setFontWeight('bold')
    .setBackground('#1c4587').setFontColor('#ffffff').setHorizontalAlignment('center');
  sh.getRange('A2').setFormula(
    '="資料即時連動，開啟或來源異動時自動更新　｜　本頁最後計算時間："&TEXT(NOW(),"yyyy/MM/dd HH:mm:ss")'
  );
  sh.getRange('A2:N2').merge().setFontColor('#666666').setHorizontalAlignment('center');

  // ---- 區塊標題樣式 ----
  // 一定要用 merge()，不能只 setValue：對多格範圍呼叫 setValue 會把同一段文字
  // 塞進範圍內「每一個」儲存格，標題就會重複顯示好幾次（J13:N13 會變成連續5個一樣的標題）。
  const sectionTitle = (a1, text)=>{
    const range = sh.getRange(a1);
    range.merge();
    range.setValue(text).setFontWeight('bold')
      .setBackground('#cfe2f3').setFontColor('#1c4587');
  };

  // ---- 1. 訂單即時概況（A4:B9）----
  // 四個狀態刻意做成「互斥」的（已出貨也要排除掉人工結案的，不然一張訂單會被算兩次），
  // 這樣四個數字加起來剛好等於訂單總數，看到不一致就知道是資料有問題，而不是統計方式的錯。
  sectionTitle('A4:B4', '📦 訂單即時概況');
  const orderStats = [
    ['待出貨', `=COUNTIFS(${O}!$G$2:$G,"待出貨*",${O}!$M$2:$M,"")`],
    ['掃描中', `=COUNTIFS(${O}!$G$2:$G,"掃描中*",${O}!$M$2:$M,"")`],
    ['已出貨', `=COUNTIFS(${O}!$G$2:$G,"已出貨*",${O}!$M$2:$M,"")`],
    ['人工結案', `=COUNTA(${O}!$M$2:$M)`],
    ['訂單總數', `=COUNTA(${O}!$A$2:$A)`]
  ];
  orderStats.forEach((r, i)=>{
    sh.getRange(5+i, 1).setValue(r[0]);
    sh.getRange(5+i, 2).setFormula(r[1]);
  });

  // ---- 2. 出貨品質（J4:K9）----
  // 都加上「R欄有值」的條件，才是以「訂單張數」為單位，不是品項列數
  // 出貨紀錄每晚20:00備份後會清空，所以這一區永遠是「今天累積到現在」的量，不是歷史總計。
  // 標題要寫清楚，不然早上看到一片0會以為是壞掉了。
  sectionTitle('G4:H4', '✅ 本日出貨品質');
  const qualityStats = [
    ['完成 🟢', `=COUNTIFS(${G}!$R$2:$R,">0",${G}!$U$2:$U,"完成*")`],
    ['錯誤 🔴', `=COUNTIFS(${G}!$R$2:$R,">0",${G}!$U$2:$U,"錯誤*")`],
    ['待核對 🔵', `=COUNTIFS(${G}!$R$2:$R,">0",${G}!$U$2:$U,"待核對*")`],
    ['人工修正數量', `=COUNTIFS(${G}!$R$2:$R,">0",${G}!$P$2:$P,"是*")`],
    ['出貨總張數', `=COUNTIF(${G}!$R$2:$R,">0")`]
  ];
  qualityStats.forEach((r, i)=>{
    sh.getRange(5+i, 7).setValue(r[0]);
    sh.getRange(5+i, 8).setFormula(r[1]);
  });

  // ---- 3. 各賣場待出貨（G4:H）----
  // 用 UNIQUE+FILTER 抓出目前實際有待出貨訂單的賣場，不寫死賣場名稱，
  // 之後多了新品牌也會自己出現，不用回頭改公式。
  sectionTitle('J4:K4', '🏪 各賣場待出貨');
  // 這一區的長度取決於實際有幾個賣場，會往下長。下面第13列就是「需注意紀錄」的區塊標題，
  // 萬一哪天賣場變多、清單長到撞上去，整個公式會變成 #REF! 連數字都不見。
  // 用 ARRAY_CONSTRAIN 限制最多8列（第5~12列），確保不管賣場增加到幾個都不會溢出撞到下一區。
  sh.getRange('J5').setFormula(
    `=ARRAY_CONSTRAIN(IFERROR(UNIQUE(FILTER(${O}!$B$2:$B,LEFT(${O}!$G$2:$G,3)="待出貨",${O}!$M$2:$M="")),"（無）"),8,1)`
  );
  sh.getRange('K5').setFormula(
    `=ARRAYFORMULA(IF(J5:J12="","",COUNTIFS(${O}!$B$2:$B,J5:J12,${O}!$G$2:$G,"待出貨*",${O}!$M$2:$M,"")))`
  );

  // ---- 3b. 當日數據（J4:K9）----
  // 「今日已出貨」不能直接拿更新時間的前10碼比對日期：那個欄位存的是UTC的ISO字串
  // （2026-08-10T03:00:00Z），台灣是UTC+8，所以台灣時間早上8點前完成的出貨，
  // UTC日期還停在前一天，直接比字串會少算。這裡先把ISO拆成日期+時間、加8小時換成台灣時間再比。
  // 出貨紀錄每晚清空，所以那幾項直接統計整張表就等於當日數字，不用再另外篩日期。
  sectionTitle('D4:E4', '📅 當日數據');
  const todayStats = [
    ['今日新進訂單', `=COUNTIF(${O}!$C$2:$C,TEXT(TODAY(),"yyyy/M/d"))`],
    ['今日已出貨（張）',
      `=SUMPRODUCT((LEFT(${O}!$G$2:$G,3)="已出貨")*(${O}!$M$2:$M="")*(IFERROR(INT(DATEVALUE(LEFT(${O}!$J$2:$J,10))`
      + `+TIMEVALUE(MID(${O}!$J$2:$J,12,8))+8/24)=TODAY(),0)))`],
    ['今日出貨（張）', `=COUNTIF(${G}!$R$2:$R,">0")`],
    ['今日出貨（件）', `=SUM(${G}!$J$2:$J)`],
    ['今日掃描品項列數', `=COUNTA(${G}!$B$2:$B)`],
    // 包裝完成之後還要掃進物流籃才算真的出得去，這兩格是這段的進度。
    // 「已進物流籃」不能直接數整欄：那一欄會保留前幾天確認過的結果（來源的統計V2隔天就清空，
    // 我們這邊刻意不讓它退回「未進」），整欄數出來會是歷史累計而不是今天的量。
    // 所以要再加上「這張是今天出貨的」這個條件，跟上面「今日已出貨」用同一套時區換算。
    // 「未進物流籃」則只會寫在今天出貨的訂單上，直接數整欄就是今天的數字。
    // 兩者相加應該等於「今日已出貨（張）」，對不起來就代表哪裡有問題。
    ['今日已進物流籃',
      `=SUMPRODUCT((LEFT(${O}!$N$2:$N,5)="已進物流籃")*(${O}!$M$2:$M="")*(IFERROR(INT(DATEVALUE(LEFT(${O}!$J$2:$J,10))`
      + `+TIMEVALUE(MID(${O}!$J$2:$J,12,8))+8/24)=TODAY(),0)))`],
    // 未進 = 今日已出貨 − 今日已進，用相減而不是去數「未進物流籃」那個欄位值。
    // 原因：欄位值是同步時才寫進去的，剛出貨還沒同步到的訂單那一格會是空的，
    // 用數的就會漏掉它們，三個數字加起來對不上（實測差了3張，就是同步後才出的貨）。
    // 相減則是由構造上保證一致，而且語意也對——剛包好還沒同步的訂單，本來就還沒進物流籃。
    ['今日未進物流籃', '=MAX(0,$E$6-$E$10)']
  ];
  todayStats.forEach((r, i)=>{
    sh.getRange(5+i, 4).setValue(r[0]);
    sh.getRange(5+i, 5).setFormula(r[1]);
  });

  // ---- 4. 目前掃描中（A13 起，往下長）----
  sectionTitle('A13:E13', '🟠 目前掃描中（誰正在處理哪張）');
  sh.getRange('A14:E14').setValues([['訂單號','賣場','認領人','認領時間','已經過(小時)']])
    .setFontWeight('bold').setBackground('#f3f3f3');
  sh.getRange('A15').setFormula(
    `=IFERROR(FILTER({${O}!$A$2:$A,${O}!$B$2:$B,${O}!$H$2:$H,${O}!$I$2:$I},LEFT(${O}!$G$2:$G,3)="掃描中"),"目前沒有人在掃描")`
  );
  // 認領時間存的是 ISO 字串（2026-08-07T04:58:45.545Z），拆出日期跟時間再組回來，
  // 加 8/24 換成台灣時間，跟 NOW() 相減得到已經過幾小時。格式不合就顯示空白不要噴錯。
  sh.getRange('E15').setFormula(
    '=ARRAYFORMULA(IF(D15:D30="","",IFERROR(ROUND((NOW()-(DATEVALUE(LEFT(D15:D30,10))+TIMEVALUE(MID(D15:D30,12,8))+8/24))*24,1),"")))'
  );

  // ---- 5. 今日包貨人員（G13 起，往下長）----
  sectionTitle('G13:H13', '👤 本日包貨人員出貨張數');
  sh.getRange('G14:H14').setValues([['包貨人員','出貨張數']])
    .setFontWeight('bold').setBackground('#f3f3f3');
  sh.getRange('G15').setFormula(
    `=IFERROR(UNIQUE(FILTER(${G}!$L$2:$L,${G}!$R$2:$R>0)),"（尚無出貨）")`
  );
  sh.getRange('H15').setFormula(
    `=ARRAYFORMULA(IF(G15:G30="","",COUNTIFS(${G}!$L$2:$L,G15:G30,${G}!$R$2:$R,">0")))`
  );

  // ---- 6. 需要注意的出貨紀錄（J13 起，往下長）----
  // 直接用核對結果裡的燈號來篩：紅燈(錯誤)或橘燈(有人工介入)的才列出來，
  // 不用再自己組一堆條件，燈號本身就是既有的分類結果。
  sectionTitle('J13:N13', '⚠️ 本日需注意的出貨紀錄（紅燈／橘燈）');
  sh.getRange('J14:M14').setValues([['訂單號','包貨人員','核對結果','差異明細']])
    .setFontWeight('bold').setBackground('#f3f3f3');
  sh.getRange('J15').setFormula(
    `=IFERROR(FILTER({${G}!$B$2:$B,${G}!$L$2:$L,${G}!$U$2:$U,${G}!$W$2:$W},${G}!$R$2:$R>0,`
    + `ISNUMBER(SEARCH("🔴",${G}!$U$2:$U))+ISNUMBER(SEARCH("🟠",${G}!$U$2:$U))),"目前沒有需要注意的紀錄")`
  );

  // ---- 版面 ----
  sh.setColumnWidth(1, 130); sh.setColumnWidth(2, 90);
  sh.setColumnWidth(3, 24);
  sh.setColumnWidth(4, 155); sh.setColumnWidth(5, 100); // D欄放當日數據的標籤，字比較長
  sh.setColumnWidth(6, 24);
  sh.setColumnWidth(7, 145); sh.setColumnWidth(8, 100); // G欄放出貨品質標籤
  sh.setColumnWidth(9, 24);
  sh.setColumnWidth(10, 120); sh.setColumnWidth(11, 90);  // J/K欄放賣場名稱與張數
  sh.setColumnWidth(12, 260); sh.setColumnWidth(13, 340);
  sh.getRange('B5:B9').setFontSize(14).setFontWeight('bold').setHorizontalAlignment('center');
  sh.getRange('E5:E11').setFontSize(14).setFontWeight('bold').setHorizontalAlignment('center');
  sh.getRange('H5:H9').setFontSize(14).setFontWeight('bold').setHorizontalAlignment('center');
  sh.setFrozenRows(2);

  // 待出貨數字上色：0張是綠的（都出完了），越多越要注意。
  // 錯誤筆數在「本日出貨品質」區的第2列（H6），只要不是0就標紅。
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThan(0).setBackground('#fce5cd').setRanges([sh.getRange('B5')]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberEqualTo(0).setBackground('#d9ead3').setRanges([sh.getRange('B5')]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThan(0).setBackground('#f4cccc').setRanges([sh.getRange('H6')]).build(),
    // 今日未進物流籃只要不是0就標橘：有貨包好了還沒送出去，要有人去處理
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThan(0).setBackground('#fce5cd').setRanges([sh.getRange('E11')]).build(),
    // 已進物流籃是好事，0張以上就標綠
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThan(0).setBackground('#d9ead3').setRanges([sh.getRange('E10')]).build()
  ]);

  Logger.log('「儀表板」分頁已建立（公式驅動，資料異動自動重算，不需要排程）。');
}

// 驗證用：把儀表板算完的實際顯示值原封不動回傳，用來確認公式有沒有算錯／標題有沒有掉。
// （用試算表的CSV匯出檢查會踩到型別推斷的坑：整欄是數字時，同一欄的文字標題會被匯出成空白，
// 看起來像標題不見了，其實只是匯出格式的問題——所以要直接讀儲存格才算數。）
function debugReadDashboard_(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_DASHBOARD);
  if(!sh) return {error:'找不到儀表板分頁'};
  const values = sh.getRange(1, 1, 20, 14).getDisplayValues();
  const out = [];
  values.forEach((row, i)=>{
    const cells = [];
    row.forEach((v, j)=>{
      if(String(v).trim()) cells.push(String.fromCharCode(65+j) + (i+1) + '=' + v);
    });
    if(cells.length) out.push(cells.join('  |  '));
  });
  return out;
}

// ---------------- 同步回舊的「文山核對 工作區－訂單」核對表單 ----------------
// 這份是使用者原本在用的舊核對表單，裡面還有出貨核對A/B、國際碼、包貨人員名單等
// 別人在用的工作表，所以這裡的寫入範圍刻意壓到最小，規則如下（不要為了方便就放寬）：
//   1. 只開「訂單」這一個分頁，其他分頁一律不碰。
//   2. 只寫「核對狀態(F欄)」跟右半部的結果區(I~R欄)。左半部 A~E（訂單號/賣場/寄送方式/
//      需求件數/訂單狀態）是他們自己的來源資料，絕對不寫。
//   3. 一律用「訂單號」比對後寫回該列，不用列號對應——對方的排序隨時可能變，
//      用列號會整批寫到錯的訂單上。
//   4. 不新增列、不刪除列、不排序。對方有幾列就處理幾列。
const NATIVE_SHEET_ID = '1vCCJS_iHZDUnoFFjnqiT-ZySwCoKFxx4HXRwqrmtVmU';
const NATIVE_ORDER_TAB = '訂單';

// 我們的出貨紀錄每晚清空，所以只有「今天」出的貨查得到完整核對結果與差異明細。
// 先前出貨的訂單明細已經進了雲端硬碟備份檔，線上查不到 —— 那種情況據實寫成
// 「已出貨（明細已歸檔）」，不要假裝有完整核對結果，也不要留著「待核對」讓人以為還沒處理。
function buildNativeStatusMap_(){
  const map = {};
  // 1) 先鋪底：訂單分頁的狀態（涵蓋所有訂單，包含明細已歸檔的）
  readOrderRows().forEach(r=>{
    const no = String(r.orderNo||'').trim();
    if(!no) return;
    const closed = String(r.manualClose||'').trim();
    if(closed){ map[no] = {status: '人工結案：'+closed}; return; }
    if(r.status === 'shipped') map[no] = {status: '已出貨（明細已歸檔）'};
    else if(r.status === 'scanning') map[no] = {status: '掃描中'};
    // pending 不寫，讓對方維持原本的「待核對」
  });
  // 2) 再用出貨紀錄覆蓋：有當日明細的，換成完整的核對結果
  const logRows = readRows(SHEET_LOG, LOG_HEADER);
  logRows.forEach(r=>{
    if(!(Number(r.requiredCount) > 0)) return; // 只取每張訂單的第一列（需求件數只填在第一列）
    const no = String(r.orderNo||'').trim();
    if(!no) return;
    map[no] = {
      status: String(r.checkResult||'').trim(),
      time: String(r.time||''), store: String(r.store||''),
      shipMethod: String(r.shipMethod||''),
      required: r.requiredCount, scanned: r.scannedCount,
      detail: String(r.differenceDetails||'')
    };
  });
  return map;
}

function syncNativeOrderSheet_(){
  const map = buildNativeStatusMap_();
  const ss = SpreadsheetApp.openById(NATIVE_SHEET_ID);
  const sh = ss.getSheetByName(NATIVE_ORDER_TAB);
  if(!sh){ Logger.log('舊核對表單找不到「'+NATIVE_ORDER_TAB+'」分頁，略過'); return {ok:false, reason:'找不到分頁'}; }
  const lastRow = sh.getLastRow();
  if(lastRow < 2){ Logger.log('舊核對表單沒有資料列，略過'); return {ok:false, reason:'沒有資料列'}; }

  const orderNos = sh.getRange(2, 1, lastRow-1, 1).getValues();      // A欄：目前訂單
  const statusCol = sh.getRange(2, 6, lastRow-1, 1).getValues();     // F欄：核對狀態

  // 右半部先把「已經在表上的明細」讀回來，用訂單編號(K欄)當key保留。
  // 這一步是必要的：我們的出貨紀錄每晚清空，隔天再同步時對前幾天的訂單已經拿不出明細了，
  // 如果直接整塊清掉重寫，等於把先前好不容易回填上去的結果洗掉——備份檔裡雖然還有，
  // 但這張表上就消失了。所以改成「有新資料才覆蓋，沒有就保留原樣」。
  const existing = sh.getRange(2, 9, lastRow-1, 10).getValues();
  const detailMap = {}, detailOrder = [];
  existing.forEach(r=>{
    const no = String(r[2]||'').trim(); // I=0, J=1, K=2（訂單編號）
    if(!no) return;
    if(!detailMap[no]) detailOrder.push(no);
    detailMap[no] = r;
  });
  Object.keys(map).forEach(no=>{
    const hit = map[no];
    if(!hit.time) return; // 只有粗略狀態、沒有當日明細的，不要動右半部
    if(!detailMap[no]) detailOrder.push(no);
    // 「序號」「寄送分類」跟第二個「差異明細」不確定原本的用途，寧可留白也不要自己猜著填，
    // 填錯比空白更難發現。
    detailMap[no] = ['', hit.time, no, '', hit.shipMethod, hit.store, hit.required, hit.scanned, hit.detail, ''];
  });

  let updated = 0, kept = 0, noData = 0;
  const newStatus = orderNos.map((row, i)=>{
    const no = String(row[0]||'').trim();
    const current = statusCol[i][0];
    const hit = no ? map[no] : null;
    if(!hit){ if(no) noData++; return [current]; } // 我們沒有這張訂單的資料，原樣保留
    if(hit.time){ updated++; return [hit.status]; } // 有當日完整明細，這是最新最完整的，直接覆蓋
    // 只有粗略狀態（已出貨但明細已歸檔／人工結案／掃描中）：只在對方還沒有結果時才填。
    // 已經回填過完整核對結果的不要降級成粗略描述，那是資訊倒退。
    const cur = String(current||'').trim();
    if(!cur || cur === '待核對'){ updated++; return [hit.status]; }
    kept++;
    return [current];
  });

  sh.getRange(2, 6, newStatus.length, 1).setValues(newStatus);
  // 右半部可寫的列數受限於對方現有的列數——不新增列是這次同步的原則之一，
  // 真的放不下就先寫得下的部分並記錄下來，不要自己去動對方表格的結構。
  const capacity = lastRow - 1;
  const detailRows = detailOrder.slice(0, capacity).map(no=>detailMap[no]);
  const overflow = Math.max(detailOrder.length - capacity, 0);
  sh.getRange(2, 9, capacity, 10).clearContent();
  if(detailRows.length){
    sh.getRange(2, 9, detailRows.length, 10).setValues(detailRows);
  }
  const result = {已回填核對狀態: updated, 保留既有結果不降級: kept,
    我方無資料保留原樣: noData, 明細列數: detailRows.length, 放不下的明細列: overflow};
  Logger.log('舊核對表單同步完成：'+JSON.stringify(result));
  return result;
}

// ---------------- 一次性設定用：安裝上面兩組自動排程的時間觸發器 ----------------
// 在 Apps Script 編輯器裡選這個函式、按「執行」跑一次即可（觸發器的建立需要授權，
// 透過API用HTTP呼叫可能拿不到，這一步比照之前DriveApp授權的做法，用編輯器手動跑一次比較保險）。
// 會先清掉這兩個函式名稱底下所有舊觸發器再重新建立，重複執行不會裝出好幾份一樣的排程。
// 注意：Apps Script的時間觸發器本身不保證精準命中指定的分鐘數（Google官方文件說明會有數十分鐘
// 內的誤差空間），9:00/9:15、14:05/14:15這種只差10-15分鐘的排程實際執行時間可能會前後飄動、
// 甚至順序調換——但因為mergeOrders()本來就是「同步現況」的概念，同一天重複執行/順序調換
// 都不會有副作用（只是把「訂單」分頁同步到源頭當下最新的樣子），不影響最終結果只是可能差幾分鐘。
function installAutomationTriggers_(){
  const handlerNames = ['autoSyncOrders_', 'backupAndClearShippingLog_', 'archiveShippedOrders_',
    'syncNativeOrderSheet_', 'hourlySync_'];
  ScriptApp.getProjectTriggers().forEach(t=>{
    if(handlerNames.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });

  [[9,0],[9,15],[14,5],[14,15]].forEach(([h,m])=>{
    ScriptApp.newTrigger('autoSyncOrders_').timeBased().atHour(h).nearMinute(m).everyDays(1).create();
  });
  ScriptApp.newTrigger('backupAndClearShippingLog_').timeBased().atHour(20).nearMinute(0).everyDays(1).create();
  // 已出貨訂單歸檔刻意排在 19:30，不能排在 20:30——
  // 「文山出貨 工作區」自己也有一個 20:30 的觸發器（dailyArchiveAndResetAuto），
  // 它會把「文山出貨V2」從模板還原、也就是清空當天的訂單資料。我們的歸檔要讀那份鏡像
  // 來判斷「這張訂單是不是已經從來源消失了」，如果撞在一起跑，鏡像可能已經被清空，
  // 歸檔函式的安全檢查（來源沒有資料列就整個略過）就會被觸發，導致歸檔永遠不會真的執行。
  // 排在來源被清空之前，來源資料還在，判斷才有意義。
  ScriptApp.newTrigger('archiveShippedOrders_').timeBased().atHour(19).nearMinute(30).everyDays(1).create();
  // 舊核對表單每小時同步一次。刻意不掛在「完成出貨」的流程裡：開啟外部試算表寫入要1~2秒，
  // 掛上去會直接拖慢人員每掃完一張訂單的反應時間，那是現場最在意的速度。
  ScriptApp.newTrigger('hourlySync_').timeBased().everyHours(1).create();

  Logger.log('已安裝自動排程：訂單同步(9:00/9:15/14:05/14:15) + 出貨紀錄備份(20:00)'
    +' + 已出貨訂單歸檔(19:30) + 舊核對表單與物流確認同步(每小時)，共'
    +ScriptApp.getProjectTriggers().length+'個觸發器。');
}

// ---------------- 「訂單明細」分頁：一列一品項，方便直接在試算表裡肉眼看 ----------------
// 每次 mergeOrders() 同步完都會重新整張重建（品項內容只會在同步時變動，
// claim/release/finalize只改狀態不改品項，不需要每次都重建，效能上不用擔心）。
// baseName/spec 是品名/規格拆開後的欄位（來源CSV本來就是分開的兩欄，只是之前組訂單時
// 為了掃描畫面好認又把兩者黏成一欄「品名（規格）」存進name——name繼續保留給掃描畫面用，
// 這裡另外用baseName/spec兩個原始欄位還原成使用者要的表格）。
// 舊資料如果還沒有baseName/spec（這次改版之前同步存的），品名欄位退回用完整的name顯示，
// 規格留空，不會噴錯。
const SHEET_DETAIL = '訂單明細';
const DETAIL_DISPLAY_HEADER = ['訂單', '品名', '規格', '品號', '數量'];
function rebuildOrderDetailSheet_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_DETAIL);
  if(!sh) sh = ss.insertSheet(SHEET_DETAIL);
  const orderRows = readOrderRows();
  const out = [];
  orderRows.forEach(r=>{
    const items = safeParse(r.itemsJson, []);
    items.forEach(it=>{
      out.push([r.orderNo, it.baseName || it.name || '', it.spec || '', it.sku || '', it.qty || 0]);
    });
  });
  sh.clearContents();
  sh.getRange(1, 1, 1, DETAIL_DISPLAY_HEADER.length).setValues([DETAIL_DISPLAY_HEADER]);
  if(out.length){
    sh.getRange(2, 1, out.length, DETAIL_DISPLAY_HEADER.length).setValues(out);
  }
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
  const fixed = {_row: row._row, orderNo, store, date, itemsJson, skuSummary, nameSummary,
    status: textToStatus(oldStatus) || 'pending', claimedBy: oldClaimedBy || '', claimedAt: oldClaimedAt || '',
    updatedAt: oldUpdatedAt || '', shipMethod: oldShipMethod || '', routingStatus: oldRoutingStatus || '',
    // 舊格式（位移過的列）本來就沒有這一欄，補空字串；有值的話這裡也讀不到正確位置，
    // 一律當沒結案處理，主管在試算表看得到就能重選一次，不會誤把訂單擋掉。
    manualClose: '', logisticsConfirmed: '', logisticsTime: '', pickedJson: ''};
  // 寫回試算表的狀態要轉成中文，回傳給呼叫端的物件維持英文代碼
  sh.getRange(row._row, 1, 1, ORDERS_HEADER.length)
    .setValues([ORDERS_HEADER.map(h=> h==='status' ? statusToText(fixed.status) : fixed[h])]);
  return fixed;
}

// ---------------- 認領逾時自動釋放 ----------------
// 訂單認領之後，只有人員在APP按「中止」才會回到待出貨——如果他直接關掉APP、平板休眠斷線、
// 或掃到一半被叫走沒回來，這張訂單就會永遠停在「掃描中」：它不會出現在待出貨清單裡
// （清單只撈 pending），別人掃它也會被擋掉（claimed_by_other），等於整張訂單沒有人出得掉，
// 而且不會有任何人發現。這裡設一個時限，超過就自動放回待出貨。
//
// 為什麼是3小時：一張訂單正常掃完只要幾分鐘。誤釋放的代價很小（人員回來繼續掃，完成時
// finalizeShipment 不檢查認領人照樣能正常記錄，而且有「已出貨就不重複記錄」的防呆擋著）；
// 但卡住不放的代價是整張訂單當天出不掉、還沒人會發現。兩邊風險不對稱，所以取比較短的時限。
const STALE_CLAIM_HOURS = 3;
function isStaleClaim_(claimedAt){
  const t = Date.parse(claimedAt);
  if(isNaN(t)) return true; // 認領時間讀不出來（空白/格式壞掉）也視為逾時，不然會永遠卡著沒人能處理
  return (Date.now() - t) > STALE_CLAIM_HOURS * 3600 * 1000;
}

function appendSysLog_(event, orderNo, claimedBy, detail){
  const sh = getSheet(SHEET_SYSLOG, SYSLOG_HEADER);
  const row = sh.getLastRow() + 1;
  sh.getRange(row, colOf(SYSLOG_HEADER,'logTime')).setNumberFormat('@'); // 免得被自動轉成日期型別
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const rowObj = {
    logTime: Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd HH:mm:ss'),
    event: event, orderNo: orderNo || '', claimedBy: claimedBy || '', detail: detail || ''
  };
  sh.getRange(row, 1, 1, SYSLOG_HEADER.length).setValues([SYSLOG_HEADER.map(h=>rowObj[h])]);
}

// ---------------- 收集現場的連線失敗紀錄 ----------------
// 用來量測「倉庫現場到底多久斷線一次」，作為要不要投入做離線佇列的判斷依據。
// 裝置在斷線當下沒辦法回報（回報本身也要連線），所以是先存在裝置本機，
// 等下一次任何一個請求成功時才一併補送過來——因此這裡收到的時間會晚於實際發生時間，
// 「時間」欄位用的是裝置記錄的失敗當下時間，不是收到的時間。
// 整批一次寫入，不要每筆都各自 getRange 一次（那樣20筆就要來回20次，很慢）。
function logNetFailures(entries){
  if(!entries.length) return {ok:true, 收到:0};
  const sh = getSheet(SHEET_SYSLOG, SYSLOG_HEADER);
  const startRow = sh.getLastRow() + 1;
  sh.getRange(startRow, colOf(SYSLOG_HEADER,'logTime'), entries.length, 1).setNumberFormat('@');
  const rows = entries.map(e=>{
    const rowObj = {
      logTime: String(e.time||''),
      event: '連線失敗',
      orderNo: String(e.orderNo||''),
      claimedBy: String(e.staffId||''),
      detail: '動作：' + String(e.action||'?') + '　訊息：' + String(e.message||'')
    };
    return SYSLOG_HEADER.map(h=>rowObj[h]);
  });
  sh.getRange(startRow, 1, rows.length, SYSLOG_HEADER.length).setValues(rows);
  return {ok:true, 收到: rows.length};
}

// ---------------- 揀貨：批次記錄「已揀 / 取消揀」 ----------------
// 刻意做成批次：揀貨是連續動作，一件一件送出的話每件都要等後端 1.2 秒以上，現場根本沒辦法用。
// 前端點下去先本機更新畫面（樂觀），累積幾筆再一起送過來，這裡一次寫完。
// 同一張訂單的多個品項會合併成一次儲存格寫入，不會每個品項各寫一次。
function markPickedBatch(ops){
  if(!ops || !ops.length) return {ok:true, 處理筆數:0};
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readOrderRows();
  const byOrderNo = {};
  rows.forEach(r=> byOrderNo[r.orderNo] = r);

  const pickedCol = colOf(ORDERS_HEADER, 'pickedJson');
  const touched = {};   // orderNo -> 這張訂單最新的 picked 物件
  const logRows = [];
  let applied = 0, notFound = 0;

  ops.forEach(op=>{
    const orderNo = String(op.orderNo||'').trim();
    const sku = String(op.sku||'').trim();
    const row = byOrderNo[orderNo];
    if(!row || !sku){ notFound++; return; }
    if(!touched[orderNo]) touched[orderNo] = safeParse(row.pickedJson, {});
    if(op.action === 'unpick'){
      delete touched[orderNo][sku];
    } else {
      touched[orderNo][sku] = {by: op.pickerId||'', at: op.time||''};
    }
    applied++;
    logRows.push({
      logTime: op.time || '', orderNo: orderNo, sku: sku,
      baseName: op.baseName || '', location: op.location || '', qty: op.qty || '',
      pickerId: op.pickerId || '', pickerName: op.pickerName || '',
      action: op.action === 'unpick' ? '取消揀貨' : '揀貨'
    });
  });

  Object.keys(touched).forEach(orderNo=>{
    const r = byOrderNo[orderNo];
    sh.getRange(r._row, pickedCol).setValue(JSON.stringify(touched[orderNo]));
  });

  if(logRows.length){
    const logSh = getSheet(SHEET_PICKLOG, PICKLOG_HEADER);
    const start = logSh.getLastRow() + 1;
    logSh.getRange(start, colOf(PICKLOG_HEADER,'logTime'), logRows.length, 1).setNumberFormat('@');
    logSh.getRange(start, 1, logRows.length, PICKLOG_HEADER.length)
         .setValues(logRows.map(o=> PICKLOG_HEADER.map(h=> o[h])));
  }
  return {ok:true, 處理筆數: applied, 找不到訂單: notFound};
}

// ---------------- 揀貨路線：把儲位換算成「走動順序」 ----------------
// 依據倉庫地圖（儲位主檔的「儲位類品(地圖)」分頁）：排的實體排列是
//   L K J I H G F E D C B A   ← 由左到右，不是字母順序，所以不能直接用字串排序
// 每一排有 1~12 座，儲位寫成「M55-3」＝ M排 55座 3層。
//
// 走蛇行（boustrophedon）：第一排由小座號往大走，下一排由大往小走，
// 這樣走完一排就直接接著走下一排，不用再走回起點——這是揀貨路線最基本也最有效的優化。
//
// 實測 7122 個有儲位的品項：非標準格式（「鐵門前」「架上」「前排展示」）只佔 639 項（9%），
// 一律排在最後——它們多半是散裝／展示區，順路最後帶走，而且沒有座標可以排。
//
// 揀貨走動順序（使用者實地確認）：
//   M 前方展售區 → A~L 貨架區（蛇行）→ P/Q/R/T/U → S(二樓)／未建立／描述性位置
// A~L 是貨架編號、實體由右至左排列；走的方向是 A 走到 L。
// 每一排走完接著走下一排時方向相反（蛇行），不用回到起點。
const AISLE_ORDER = ['M','A','B','C','D','E','F','G','H','I','J','K','L'];
// 貨架區走完之後才去的區域，順序照使用者給的
const SECONDARY_AISLE_ORDER = ['P','Q','R','T','U'];
// S 在二樓，跟「未建立」「鐵門前」「架上」這類一起排最後——上樓是另外一趟，順路帶不到

function parseLocation_(loc){
  const s = String(loc||'').trim();
  if(!s) return null;
  // 一個品項可能寫多個儲位（「B09-1、B10-2」），取第一個當作路線依據
  const first = s.split(/[、,，\s]/)[0];
  const m = first.match(/^([A-Za-z])\s*(\d{1,3})\s*-\s*(\d{1,2})/);
  if(!m) return null;
  const aisle = m[1].toUpperCase();
  return {
    aisle: aisle,
    aisleIndex: AISLE_ORDER.indexOf(aisle), // -1 = 不在地圖上
    bay: parseInt(m[2], 10),
    level: parseInt(m[3], 10)
  };
}

// 回傳可直接排序的字串鍵。分四層，順序就是人員實際的作業順序：
//   0 = 文山倉走得到的儲位（地圖上的排走蛇行，最後接後半段的M總倉）
//   1 = 位置未確認的排（P/Q/R/S/T/U，依字母集中，至少同一區一次收完）
//   2 = 已確認不在文山倉的地點（目前無，確認後填進 OFFSITE_LOCATIONS）——拿不到，要走調撥
//   3 = 未建立／描述性位置（鐵門前、架上…）——要自己找
function locationSortKey_(loc){
  const pad = n => String(n).padStart(3, '0');
  const p = parseLocation_(loc);
  if(!p) return '2|ZZZ|999|999|' + String(loc||'');
  const i0 = AISLE_ORDER.indexOf(p.aisle);
  if(i0 >= 0){
    // 蛇行：奇數順位的排反向走，座號用 (999 - bay) 讓它由大往小排
    const bay = (i0 % 2 === 1) ? (999 - p.bay) : p.bay;
    return '0|' + pad(i0) + '|' + pad(bay) + '|' + pad(p.level) + '|' + String(loc||'');
  }
  const i1 = SECONDARY_AISLE_ORDER.indexOf(p.aisle);
  if(i1 >= 0) return '1|' + pad(i1) + '|' + pad(p.bay) + '|' + pad(p.level) + '|' + String(loc||'');
  return '2|' + p.aisle + '|' + pad(p.bay) + '|' + pad(p.level) + '|' + String(loc||'');
}

// ---------------- 物流籃確認：讀「統計V2」人員掃上籃的紀錄，回填到我們的訂單分頁 ----------------
// 人員包裝完成後，會在來源試算表的「統計V2」分頁掃訂單號，確認這張已經放進物流籃。
// 那個分頁的結構：第8列是表頭（掃描／時間／賣場／查重／運送方式），第9列開始才是掃描紀錄，
// 上面第1~7列是依賣場×寄送方式的統計摘要，讀的時候要跳過。
// 我們只讀不寫——那份是所有資料的源頭（文山出貨V2/統計/各賣場分頁都從它來），寫入風險太高。
const LOGISTICS_SOURCE_ID = '1wMrjppENakDhT354VJ6-W7txoG9FSwYR2OjMzPRl2KQ';
const LOGISTICS_TAB = '統計V2';
const LOGISTICS_FIRST_DATA_ROW = 9;
function readLogisticsScans_(){
  const ss = SpreadsheetApp.openById(LOGISTICS_SOURCE_ID);
  const sh = ss.getSheetByName(LOGISTICS_TAB);
  if(!sh) return null; // 讀不到就回傳null，讓呼叫端知道要整個略過，不要當成「大家都沒掃」
  const lastRow = sh.getLastRow();
  if(lastRow < LOGISTICS_FIRST_DATA_ROW) return {};
  const rows = sh.getRange(LOGISTICS_FIRST_DATA_ROW, 1, lastRow - LOGISTICS_FIRST_DATA_ROW + 1, 2)
                 .getDisplayValues(); // 用顯示值，時間欄才會是「上午 11:28:40」這種可讀格式
  const map = {};
  rows.forEach(r=>{
    const no = String(r[0]||'').trim();
    if(!no) return;
    map[no] = String(r[1]||'').trim();
  });
  return map;
}

// 出貨完成時間存的是UTC的ISO字串，要換算成台灣時間再比對日期，
// 不然台灣時間早上8點前完成的出貨，UTC日期還停在前一天，會被誤判成「不是今天出的」。
function isShippedToday_(updatedAt){
  const t = Date.parse(updatedAt);
  if(isNaN(t)) return false;
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  return Utilities.formatDate(new Date(t), tz, 'yyyy-MM-dd')
      === Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}

function syncLogisticsConfirm_(){
  const scans = readLogisticsScans_();
  if(scans === null){
    Logger.log('讀不到「'+LOGISTICS_TAB+'」分頁，為安全起見略過物流確認同步');
    return {ok:false, reason:'找不到來源分頁'};
  }
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readOrderRows();
  if(!rows.length) return {ok:true, 已確認:0};

  const confirmCol = colOf(ORDERS_HEADER,'logisticsConfirmed');
  const timeCol = colOf(ORDERS_HEADER,'logisticsTime');
  const confirmVals = [], timeVals = [];
  let confirmed = 0, waiting = 0, kept = 0;
  rows.forEach(r=>{
    const no = String(r.orderNo||'').trim();
    const hit = scans[no];
    if(hit !== undefined){
      confirmVals.push(['已進物流籃 🟢']);
      timeVals.push([hit]);
      confirmed++;
      return;
    }
    // 來源分頁可能每天清空重來（統計摘要看起來是當日的量）。已經確認過的不要因為
    // 來源清掉了就退回「未進物流籃」——那會讓昨天明明出掉的貨看起來像漏掉的。
    if(String(r.logisticsConfirmed||'').indexOf('已進') === 0){
      confirmVals.push([r.logisticsConfirmed]);
      timeVals.push([r.logisticsTime]);
      kept++;
      return;
    }
    // 只有「今天出貨、卻還沒被掃進物流籃」才提醒。這個「今天」的限制是必要的：
    // 來源的統計V2只留當日的掃描紀錄（筆數大約就是當天的出貨量，不是累積的），
    // 所以前幾天出的貨在這裡一定查不到——但那不代表當時沒掃，只是紀錄已經被清掉了。
    // 不加這個限制的話，會把一大批其實正常出掉的舊訂單標成「未進物流籃」，變成假警報，
    // 真正需要處理的今日漏籃反而被淹沒在裡面。
    if(r.status === 'shipped' && !String(r.manualClose||'').trim() && isShippedToday_(r.updatedAt)){
      confirmVals.push(['未進物流籃 🟠']);
      timeVals.push(['']);
      waiting++;
    } else {
      confirmVals.push(['']);
      timeVals.push(['']);
    }
  });

  sh.getRange(2, confirmCol, confirmVals.length, 1).setValues(confirmVals);
  sh.getRange(2, timeCol, timeVals.length, 1).setNumberFormat('@').setValues(timeVals);
  const result = {已進物流籃: confirmed, 已出貨但未進物流籃: waiting, 沿用先前確認: kept, 來源掃描筆數: Object.keys(scans).length};
  Logger.log('物流確認同步完成：'+JSON.stringify(result));
  return result;
}

// 每小時跑的維護工作合併在這裡，一個觸發器做完兩件事，不用裝兩個。
function hourlySync_(){
  syncNativeOrderSheet_();
  syncLogisticsConfirm_();
}

// 唯讀診斷用：看某個分頁的資料列是靜態值還是公式（公式才看得出資料是從哪裡串過來的）。
// arg 格式：'試算表ID|分頁名稱'
function inspectSheetFormulas_(arg){
  const parts = String(arg||'').split('|');
  const ss = SpreadsheetApp.openById(parts[0]);
  const sh = ss.getSheetByName(parts[1]);
  if(!sh) return {error:'找不到分頁 '+parts[1]};
  const lastCol = Math.min(sh.getLastColumn(), 40);
  const out = {};
  // 第2列（第一筆資料）跟第3列各看一次，有些表第2列是說明列
  [2,3].forEach(r=>{
    if(sh.getLastRow() < r) return;
    const f = sh.getRange(r, 1, 1, lastCol).getFormulas()[0];
    f.forEach((v, i)=>{
      if(!v) return;
      const key = '第'+r+'列 第'+(i+1)+'欄';
      if(!out[key]) out[key] = String(v).slice(0, 200);
    });
  });
  return Object.keys(out).length ? out : {結論:'這個分頁的資料列是靜態值，沒有公式（由腳本或人工寫入）'};
}

// 唯讀診斷用：列出某個雲端硬碟資料夾裡的檔案；arg = 資料夾ID
function listFolder_(folderId){
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFiles();
  const out = [];
  while(files.hasNext() && out.length < 30){
    const f = files.next();
    out.push({名稱: f.getName(), id: f.getId(), 類型: f.getMimeType().split('.').pop()});
  }
  return {資料夾: folder.getName(), 檔案: out};
}

// 唯讀診斷用：找出「含有指定分頁名稱」的試算表（用來反查綁定式腳本掛在哪份表上）。
// arg = 分頁名稱。只掃使用者雲端硬碟裡的試算表，找到就停。
function findSheetOwner_(tabName){
  const files = DriveApp.getFilesByType(MimeType.GOOGLE_SHEETS);
  const hits = [], checked = [];
  let n = 0;
  while(files.hasNext() && n < 60 && hits.length < 3){
    const f = files.next(); n++;
    checked.push(f.getName());
    try{
      const ss = SpreadsheetApp.openById(f.getId());
      if(ss.getSheetByName(tabName)) hits.push({名稱: f.getName(), id: f.getId()});
    }catch(e){}
  }
  return {找到: hits, 已檢查數量: n, 檢查過的檔名: checked.slice(0, 30)};
}

// 唯讀診斷用：在雲端硬碟裡找 Apps Script 專案（clasp 的授權範圍只看得到它自己建立的檔案，
// 列不出既有專案；我們這邊有完整 drive 權限所以找得到）。用完可以刪掉。
function findScriptProjects_(keyword){
  const files = DriveApp.getFilesByType('application/vnd.google-apps.script');
  const out = [];
  while(files.hasNext() && out.length < 50){
    const f = files.next();
    const name = f.getName();
    if(keyword && name.indexOf(keyword) < 0) continue;
    out.push({名稱: name, id: f.getId(), 最後修改: Utilities.formatDate(f.getLastUpdated(),
      SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy/MM/dd HH:mm')});
  }
  return out;
}

// 唯讀診斷用：看「蝦proV2」的過刷欄實際存了什麼值（已過刷 vs 未過刷分別長怎樣）。
function inspectScanTab_(){
  const ss = SpreadsheetApp.openById('1wMrjppENakDhT354VJ6-W7txoG9FSwYR2OjMzPRl2KQ');
  const sh = ss.getSheetByName('蝦proV2');
  if(!sh) return {error:'找不到蝦proV2'};
  const lastRow = sh.getLastRow();
  const values = sh.getRange(1, 1, Math.min(lastRow, 400), 16).getValues();
  const header = values[0];
  const iOrder = 5, iStatus = 6, iScan = 13; // F=訂單編號(5), G=狀態(6), N=文山過刷(13)
  const dist = {};
  const samples = [];
  let withOrder = 0;
  for(let i = 1; i < values.length; i++){
    const no = String(values[i][iOrder]||'').trim();
    if(!no) continue;
    withOrder++;
    const raw = values[i][iScan];
    const key = raw === '' || raw === null ? '(空白)' : JSON.stringify(String(raw)).slice(0, 40);
    dist[key] = (dist[key]||0) + 1;
    if(samples.length < 8 && String(raw||'').trim() && String(raw).trim() !== '-'){
      samples.push({列: i+1, 訂單: no, 狀態: String(values[i][iStatus]||''), 過刷值: String(raw)});
    }
  }
  return {
    N欄表頭: String(header[iScan]||''),
    有訂單編號的列數: withOrder,
    過刷欄值分布: dist,
    已過刷範例: samples
  };
}

// 唯讀診斷用：列出來源試算表有哪些分頁、各自的表頭跟資料量，用來確認要接哪一個分頁。
// 只讀不寫。確認完之後這個函式可以刪掉。
function inspectSourceSpreadsheet_(ssId){
  const ss = SpreadsheetApp.openById(ssId || '1wMrjppENakDhT354VJ6-W7txoG9FSwYR2OjMzPRl2KQ');
  return ss.getSheets().map(sh=>{
    const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    let header = [];
    if(lastRow >= 1 && lastCol >= 1){
      header = sh.getRange(1, 1, 1, Math.min(lastCol, 20)).getValues()[0].filter(String);
    }
    // A1的公式最能看出這個分頁的資料是自己來的、還是IMPORTRANGE別份試算表過來的
    let a1 = '';
    try{ a1 = String(sh.getRange('A1').getFormula()||''); }catch(e){}
    return {分頁: sh.getName(), gid: sh.getSheetId(), 列數: lastRow, 欄數: lastCol, 表頭: header, A1公式: a1.slice(0, 220)};
  });
}

// 把所有逾時的認領一次放回待出貨。每次同步（自動排程4次＋手動按同步）都會跑一次。
function releaseStaleClaims_(){
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readOrderRows();
  let released = 0;
  rows.forEach(r=>{
    if(r.status !== 'scanning') return;
    if(!isStaleClaim_(r.claimedAt)) return;
    const hours = ((Date.now() - Date.parse(r.claimedAt)) / 3600000).toFixed(1);
    sh.getRange(r._row, colOf(ORDERS_HEADER,'status'), 1, 3).setValues([[statusToText('pending'), '', '']]);
    appendSysLog_('認領逾時自動釋放', r.orderNo, r.claimedBy,
      '認領後 '+(isNaN(Date.parse(r.claimedAt)) ? '（認領時間異常）' : hours+' 小時')
      +'未完成出貨，已自動放回待出貨清單（時限'+STALE_CLAIM_HOURS+'小時）');
    released++;
  });
  if(released) Logger.log('認領逾時自動釋放：'+released+' 張訂單已放回待出貨清單。');
  return released;
}

// 驗證用：自己建一張「5小時前就被認領、之後就沒動作」的測試訂單，跑一次自動釋放看結果對不對，
// 跑完把測試訂單刪掉。用測試資料驗證才不用去動真實訂單，也不用把時限改成0（那樣在正式環境很危險，
// 真的有人員正在掃描的話會被立刻釋放掉）。確認功能正常之後這個函式可以刪掉。
function testStaleClaimRelease_(){
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const orderNo = 'TEST-STALE-' + Date.now();
  const staleAt = new Date(Date.now() - 5 * 3600 * 1000).toISOString(); // 5小時前
  const rowObj = {
    orderNo: orderNo, store: '測試', date: '2026/8/7',
    itemsJson: JSON.stringify([{sku:'TEST-SKU', name:'測試品項', baseName:'測試品項', spec:'', qty:1}]),
    skuSummary: 'TEST-SKU', nameSummary: '測試品項',
    status: statusToText('scanning'), claimedBy: 'TEST01', claimedAt: staleAt,
    updatedAt: staleAt, shipMethod: '', routingStatus: '文山', manualClose: ''
  };
  const testRow = sh.getLastRow() + 1;
  sh.getRange(testRow, 1, 1, ORDERS_HEADER.length).setValues([ORDERS_HEADER.map(h=>rowObj[h])]);

  const before = readOrderRows().find(r=>r.orderNo === orderNo);
  const released = releaseStaleClaims_();
  const after = readOrderRows().find(r=>r.orderNo === orderNo);

  const result = {
    測試訂單: orderNo,
    認領時間: staleAt,
    時限小時: STALE_CLAIM_HOURS,
    釋放前狀態: before ? before.status : '(找不到)',
    釋放前認領人: before ? before.claimedBy : '',
    這次釋放張數: released,
    釋放後狀態: after ? after.status : '(找不到)',
    釋放後認領人: after ? (after.claimedBy || '(已清空)') : '',
    判定: (before && before.status === 'scanning' && after && after.status === 'pending' && !after.claimedBy)
      ? '通過：逾時認領已正確放回待出貨並清掉認領人' : '不符預期，請檢查'
  };
  // 不管上面結果如何都要把測試訂單刪掉，不要留在正式的待出貨清單裡
  const cleanupRow = readOrderRows().find(r=>r.orderNo === orderNo);
  if(cleanupRow) sh.deleteRow(cleanupRow._row);
  result.測試訂單已刪除 = !readOrderRows().some(r=>r.orderNo === orderNo);
  return result;
}

// ---------------- 認領訂單（避免兩人同時掃同一張） ----------------
function claimOrder(orderNo, staffId, staffName){
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readOrderRows();
  let row = rows.find(r=>r.orderNo===orderNo);
  if(!row) return {ok:false, reason:'not_found'};
  row = healOrderRowIfNeeded_(sh, row);
  if(row.status === 'shipped') return {ok:false, reason:'already_shipped'};
  // 已經人工結案的訂單（別的門市/倉庫出掉、缺貨取消、整張取消）不給認領，
  // 就算人員手上的清單還沒更新、直接掃到這張訂單的條碼也會被擋下來。
  const manualClose = String(row.manualClose||'').trim();
  if(manualClose) return {ok:false, reason:'manually_closed', manualClose: manualClose};
  if(row.status === 'scanning' && row.claimedBy && row.claimedBy !== staffId){
    // 認領超過時限就讓後面這個人直接接手，不用等排程同步才釋放——現場遇到「掃不動、說被某某人
    // 認領了」的當下就能自己解決，這是最需要即時處理的時機點。
    if(!isStaleClaim_(row.claimedAt)){
      return {ok:false, reason:'claimed_by_other', claimedBy: row.claimedBy};
    }
    appendSysLog_('認領逾時被接手', orderNo, row.claimedBy,
      '原認領人未完成出貨（超過'+STALE_CLAIM_HOURS+'小時），改由「'+(staffId||'?')+'」接手掃描');
  }
  const now = new Date().toISOString();
  // 同一人重新叫出同一張還在掃描中的訂單（例如中途切到別的畫面又回來），
  // 開始時間要延續原本第一次認領的時間，不要每次重新叫出來就往後跳
  const claimedAt = (row.status === 'scanning' && row.claimedBy === staffId && row.claimedAt) ? row.claimedAt : now;
  sh.getRange(row._row, colOf(ORDERS_HEADER,'status'), 1, 4).setValues([[statusToText('scanning'), staffId||'', claimedAt, now]]);
  return {ok:true, order: {orderNo: row.orderNo, store: row.store, date: cellToText(row.date), items: safeParse(row.itemsJson, []), shipMethod: row.shipMethod||'', routingStatus: row.routingStatus||'', claimedAt}};
}

function releaseOrder(orderNo){
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readOrderRows();
  let row = rows.find(r=>r.orderNo===orderNo);
  if(!row) return {ok:false, reason:'not_found'};
  row = healOrderRowIfNeeded_(sh, row);
  if(row.status === 'shipped') return {ok:true}; // 已出貨就不用管了
  sh.getRange(row._row, colOf(ORDERS_HEADER,'status'), 1, 3).setValues([[statusToText('pending'), '', '']]);
  return {ok:true};
}

// ---------------- 完成出貨：標記已出貨＋寫入紀錄 ----------------
function finalizeShipment(entry){
  if(!entry || !entry.orderNo) return {ok:false, error:'missing orderNo'};
  const ordersSh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readOrderRows();
  let row = rows.find(r=>r.orderNo===entry.orderNo);
  if(row){
    row = healOrderRowIfNeeded_(ordersSh, row);
    // 防呆：這張訂單已經出貨過了就不要再記錄第二次（例如兩台裝置都認領到同一張訂單、
    // 或使用者不小心點了兩次完成出貨）。找不到這張訂單（row為null，理論上不該發生）維持原行為照樣記錄。
    if(row.status === 'shipped'){
      return {ok:false, reason:'already_shipped'};
    }
    const now = new Date().toISOString();
    ordersSh.getRange(row._row, colOf(ORDERS_HEADER,'status'), 1, 4).setValues([[statusToText('shipped'), '', '', now]]);
  }
  appendLogRow(entry);
  return {ok:true};
}

// 對照原生系統「訂單」追蹤表的「核對狀態」欄位概念（待核對／完成／錯誤：商品不符／錯誤：少N件），
// 用我們自己資料算出對應狀態，現在直接併入「核對結果」欄位本身顯示（不再另外開一欄）。
// 跟原生系統不同的是：我們的掃描流程本來就要求數量對齊才能完成出貨，所以「掃描件數」低於
// 「需求件數」正常情況下不會發生在本系統掃描完成的紀錄裡——只有「指定出貨Excel匯入」那種
// 沒有真的逐項掃描驗證過的外部匯入紀錄，才會出現需求/掃描件數是0（沒有這個資訊可比對），
// 這種情況歸類成「待核對」，不誤標成「完成」。
function classifyVerifyStatus_(entry){
  if(entry.hadIssue && String(entry.differenceDetails||'').indexOf('商品不符') >= 0) return '錯誤：商品不符';
  const required = Number(entry.requiredCount) || 0;
  const scanned = Number(entry.scannedCount) || 0;
  // 缺貨/盤差時人員會把出不了的品項標成「缺貨不出」。這種短少是「知道而且刻意」的，
  // 跟掃漏、掃錯那種疏失完全不同，不能一律歸成「錯誤：少N件」——
  // 那會讓真正需要追查的漏掃案件淹沒在一堆正常的缺貨出貨裡。
  const shortShip = Number(entry.shortShipCount) || 0;
  if(required > 0 && scanned < required){
    const missing = required - scanned;
    if(shortShip >= missing) return '缺貨出貨：少'+missing+'件';
    // 短少的量超過標記的缺貨量，代表除了缺貨之外還漏了東西，那部分仍然是錯誤
    if(shortShip > 0) return '錯誤：少'+(missing-shortShip)+'件（另缺貨'+shortShip+'件）';
    return '錯誤：少'+missing+'件';
  }
  if(required > 0 && scanned >= required) return '完成';
  return '待核對';
}

// 掃描件數如果等於（或超過）需求件數，代表這張訂單真的全部確認完成，數字後面加個綠色打勾方便一眼看出來。
// 沒有需求件數可比對（例如外部匯入）或還沒補滿就只顯示數字，不會誤加打勾。
function formatScannedCount_(required, scanned){
  const req = Number(required) || 0;
  const sc = Number(scanned) || 0;
  if(req > 0 && sc >= req) return `${sc} ✅`;
  return sc;
}

// 跟 setupLogSheetColors() 整列上色用的是同一套判斷邏輯，這裡額外把對應的燈號emoji
// 直接寫進「核對結果」文字後面，這樣即使沒開啟顏色格式（例如匯出CSV、手機小螢幕看不清楚背景色）
// 也能一眼看出這筆是哪一種狀態。verifyStatus可以省略不傳，函式會自己算一次。
function classifyLogEmoji_(entry, verifyStatus){
  const vs = verifyStatus !== undefined ? verifyStatus : classifyVerifyStatus_(entry);
  // 缺貨出貨是已知情況，給橘燈（要留意但不是做錯）；真正的漏掃才給紅燈
  if(String(vs).indexOf('缺貨出貨') === 0) return '🟠';
  if(entry.hadIssue || String(vs).indexOf('錯誤') === 0) return '🔴';
  if(entry.hadManualEdit || entry.hadNoBarcodeConfirm) return '🟠';
  if(vs === '待核對' || entry.importedExternal) return '🔵';
  return '🟢';
}

// 「商品不符」代表掃到不屬於這張訂單的條碼（拿錯商品）。光看這個事件不知道後續有沒有補救，
// 所以這裡再判斷一次「最後到底有沒有把正確的商品掃進去」，方便事後判斷這張訂單實際出貨對不對。
// 判斷依據是完成出貨時的需求件數／掃描件數：全部掃滿代表訂單裡每個品項都真的被掃到過，
// 那個掃錯的條碼只是多掃的、後來有拿對商品重新掃。
// 但「掃滿」也可能是靠人工修正數量或無條碼手動核對湊出來的，那種情況不能說是「掃入正確商品」，
// 要分開講清楚，不然這個註記反而會讓人誤判成已經確認過實體商品了。
function buildMismatchResolution_(entry){
  const required = Number(entry.requiredCount) || 0;
  const scanned = Number(entry.scannedCount) || 0;
  if(required <= 0) return '（無數量資訊可判斷）';
  if(scanned < required) return '（後續未補齊，短少'+(required-scanned)+'件）';
  if(entry.hadManualEdit || entry.hadNoBarcodeConfirm){
    return '（數量已補齊，但含人工介入，非全部實際掃到條碼）';
  }
  return '（後續已掃入正確商品，數量已補齊）';
}
function hasMismatch_(entry){
  return String(entry.differenceDetails||'').indexOf('商品不符') >= 0;
}

// 把「核對狀態」文字＋人工介入註記＋燈號emoji組成最終的「核對結果」欄位內容。
function buildCheckResult_(entry, verifyStatus){
  let text = verifyStatus;
  if(entry.hadManualEdit) text += '（人工修正數量）';
  if(entry.hadNoBarcodeConfirm) text += '（含無條碼手動核對）';
  // 商品不符的後續處理結果直接寫在核對結果欄，不用再去翻差異明細那一長串文字才知道有沒有補救。
  // 燈號維持紅燈不變：確實發生過拿錯商品，這件事本身就該被看見，補救成功也不該當作沒發生過。
  if(hasMismatch_(entry)) text += buildMismatchResolution_(entry);
  // 掃描超量（同一個品項掃超過應出數量）也會把 hadIssue 設成true、跟著亮紅燈，
  // 但件數最後是對的，核對狀態會判成「完成」——只寫「完成」配紅燈看起來自相矛盾，
  // 會讓人以為是系統出錯。這裡把紅燈的原因補進文字裡，文字跟燈號才對得起來。
  else if(entry.hadIssue && String(verifyStatus).indexOf('錯誤') !== 0) text += '（曾掃描超量）';
  return text + ' ' + classifyLogEmoji_(entry, verifyStatus);
}

// entry.items 有幾個品項就寫幾列，訂單層級欄位（運單編號/包貨人員/完成時間等）每列都重複填入。
// 先組成「欄位名稱→值」的物件，再用 LOG_HEADER.map() 依目前欄位順序取值——
// 這樣以後要調整 LOG_HEADER 欄位順序，這裡完全不用跟著改，不會又發生手動排列的陣列跟欄位順序對不起來的問題。
function appendLogRow(entry){
  const logSh = getSheet(SHEET_LOG, LOG_HEADER);
  const items = (entry.items && entry.items.length) ? entry.items : [{}]; // 萬一沒有品項資料，至少留一列基本記錄，不整筆遺失
  const startRow = logSh.getLastRow()+1;
  // orderDate跟time跟startTime都長得像日期/時間字串，強制設純文字格式再寫，
  // 避免 Google試算表自動轉成日期型別（讀回來會變UTC ISO字串，顯示會跑掉）
  logSh.getRange(startRow, colOf(LOG_HEADER,'orderDate'), items.length, 1).setNumberFormat('@');
  logSh.getRange(startRow, colOf(LOG_HEADER,'time'), items.length, 1).setNumberFormat('@');
  logSh.getRange(startRow, colOf(LOG_HEADER,'startTime'), items.length, 1).setNumberFormat('@');
  // 核對結果是整張訂單層級的判斷（核對狀態＋人工介入註記＋燈號），每個品項列都一樣，
  // 只需要算一次，不用放進.map()裡每個品項都重算一次。
  // 各品項標記的缺貨量加總，用來判斷「短少是不是已知的缺貨」
  entry.shortShipCount = items.reduce(function(sum, it){ return sum + (Number(it.shortShipQty)||0); }, 0);
  const verifyStatus = classifyVerifyStatus_(entry);
  const checkResultText = buildCheckResult_(entry, verifyStatus);
  // entry.differenceDetails是「跟特定品項無關」的訂單層級事件（目前只有：掃到不屬於這張訂單的條碼），
  // 只會出現在第一列；每個品項「自己」的差異（無條碼手動核對/數量超過/人工修正）由it.itemDifferenceDetails
  // 帶過來，放在那個品項自己的列，不會像以前那樣把整張訂單所有品項的事件混在同一段文字裡重複顯示。
  let orderLevelText = (entry.differenceDetails && entry.differenceDetails !== '無差異') ? entry.differenceDetails : '';
  // 掃到不屬於這張訂單的條碼時，後面接著寫清楚「後來到底有沒有拿對商品掃進去」，
  // 這樣事後看差異明細就能直接判斷這張訂單實際出的貨對不對，不用再自己去比對件數。
  if(orderLevelText && hasMismatch_(entry)) orderLevelText += buildMismatchResolution_(entry);
  const rows = items.map((it, idx)=>{
    const rowObj = {
      orderNo: entry.orderNo, orderDate: String(entry.orderDate||''), waybill: entry.waybill||'',
      baseName: it.baseName || it.name || '', spec: it.spec || '', sku: it.sku || '', qty: it.qty || 0, scanned: it.scanned || 0,
      staffId: entry.staffId||'', staffName: entry.staffName||'', time: String(entry.time||''),
      hadIssue: boolToText(entry.hadIssue), hadManualEdit: boolToText(entry.hadManualEdit), importedExternal: boolToText(entry.importedExternal),
      store: entry.store||'', shipMethod: entry.shipMethod||'', note: entry.note||'',
      // 需求件數／掃描件數是整張訂單的加總，不是這一列品項自己的數量——只填在該訂單第一列，
      // 後面幾列品項留空，不要每一列都重複顯示同一組總數字，容易誤會成是那個品項自己的數量。
      requiredCount: idx===0 ? (entry.requiredCount||0) : '',
      scannedCount: idx===0 ? formatScannedCount_(entry.requiredCount, entry.scannedCount) : '',
      routingStatus: entry.routingStatus||'',
      checkResult: checkResultText,
      differenceDetails: idx===0
        ? ([orderLevelText, it.itemDifferenceDetails].filter(Boolean).join('；') || '無差異')
        : (it.itemDifferenceDetails || ''),
      startTime: String(entry.startTime||''),
      // 這一欄是「這個品項自己」有沒有被無條碼手動核對過（不是整張訂單層級），
      // 跟核對結果用的entry.hadNoBarcodeConfirm（訂單裡只要有任一品項用過就算）分開判斷。
      hadNoBarcodeConfirm: boolToText((it.noBarcodeCount||0) > 0)
    };
    return LOG_HEADER.map(h=>rowObj[h]);
  });
  logSh.getRange(startRow, 1, rows.length, LOG_HEADER.length).setValues(rows);
}

// ---------------- 一次性修復用：把既有出貨紀錄裡重複顯示的需求件數／掃描件數清乾淨 ----------------
// 這兩欄改成「只顯示在該訂單第一列」之前寫入的資料，每個品項列都重複著同一組總數字。
// 這裡依「訂單號+完成時間」分組（跟getState()用的分組邏輯一樣），同一組裡除了第一列，
// 其餘列的需求件數／掃描件數清空。用colOf()動態抓欄位，不管欄位順序後來又怎麼調都不受影響。
function fixRequiredScannedCountDisplay_(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  if(!sh){ Logger.log('找不到「出貨紀錄」分頁'); return; }
  const rows = readRows(SHEET_LOG, LOG_HEADER);
  const requiredCol = colOf(LOG_HEADER,'requiredCount');
  const scannedCol = colOf(LOG_HEADER,'scannedCount');
  const seenKeys = {};
  let cleared = 0;
  rows.forEach(r=>{
    const key = r.orderNo + '||' + r.time;
    if(seenKeys[key]){
      sh.getRange(r._row, requiredCol).setValue('');
      sh.getRange(r._row, scannedCol).setValue('');
      cleared++;
    } else {
      seenKeys[key] = true;
    }
  });
  Logger.log('已清空 '+cleared+' 列非該訂單第一列的需求件數／掃描件數重複值。');
}

// ---------------- 一次性修復用：既有「商品不符」紀錄補上後續處理結果註記 ----------------
// buildMismatchResolution_() 是這次才加的，之前寫入的紀錄只寫了「掃到不屬於此訂單的條碼」，
// 沒說後來有沒有補救。這裡依同一組判斷邏輯把註記補上去。
// 需求件數／掃描件數只存在每組訂單的第一列，其餘品項列要沿用同一組的值才判斷得出來。
// 已經補過的（文字裡已經有「後續」或「無數量資訊」）會跳過，可以重複執行。
function fixMismatchResolutionNote_(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  if(!sh){ Logger.log('找不到「出貨紀錄」分頁'); return; }
  const rows = readRows(SHEET_LOG, LOG_HEADER);
  const checkResultCol = colOf(LOG_HEADER,'checkResult');
  const differenceCol = colOf(LOG_HEADER,'differenceDetails');

  const groupInfo = {};
  rows.forEach(r=>{
    const key = r.orderNo + '||' + r.time;
    if(!groupInfo[key] && r.requiredCount !== '' && r.requiredCount !== undefined){
      groupInfo[key] = {requiredCount: r.requiredCount, scannedCount: r.scannedCount};
    }
  });

  let fixed = 0;
  rows.forEach(r=>{
    const diff = String(r.differenceDetails||'');
    if(diff.indexOf('商品不符') < 0) return;
    if(diff.indexOf('後續') >= 0 || diff.indexOf('無數量資訊') >= 0) return; // 補過了
    const key = r.orderNo + '||' + r.time;
    const g = groupInfo[key] || {requiredCount: 0, scannedCount: 0};
    const entryLike = {
      differenceDetails: diff,
      hadManualEdit: textToBool(r.hadManualEdit), hadNoBarcodeConfirm: textToBool(r.hadNoBarcodeConfirm),
      hadIssue: textToBool(r.hadIssue), importedExternal: textToBool(r.importedExternal),
      // 掃描件數欄位可能長成「20 ✅」，取開頭的數字部分來比較
      requiredCount: parseInt(g.requiredCount, 10) || 0,
      scannedCount: parseInt(String(g.scannedCount).replace(/[^\d]/g, ''), 10) || 0
    };
    const note = buildMismatchResolution_(entryLike);
    sh.getRange(r._row, differenceCol).setValue(diff + note);
    const verifyStatus = classifyVerifyStatus_(entryLike);
    sh.getRange(r._row, checkResultCol).setValue(buildCheckResult_(entryLike, verifyStatus));
    fixed++;
  });
  Logger.log('已為 '+fixed+' 列「商品不符」紀錄補上後續處理結果註記。');
  return {已補註記列數: fixed};
}

// ---------------- 一次性修復用：既有「完成」卻亮紅燈的紀錄補上原因 ----------------
// 掃描超量會把 hadIssue 設成true（跟著亮紅燈），但件數最後是對的、核對狀態判成「完成」，
// 於是變成「完成 🔴」這種文字跟燈號自相矛盾的顯示。這裡把原因補進文字裡。
// 已經補過的（含「曾掃描超量」）或本來就是錯誤開頭的都會跳過，可以重複執行。
function fixOverScanNote_(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  if(!sh){ Logger.log('找不到「出貨紀錄」分頁'); return; }
  const rows = readRows(SHEET_LOG, LOG_HEADER);
  const checkResultCol = colOf(LOG_HEADER,'checkResult');
  let fixed = 0;
  rows.forEach(r=>{
    if(!textToBool(r.hadIssue)) return;
    const cur = String(r.checkResult||'');
    if(!cur || cur.indexOf('錯誤') === 0) return;      // 真的錯誤，本來就該紅燈，不用補
    if(cur.indexOf('曾掃描超量') >= 0) return;          // 補過了
    if(cur.indexOf('商品不符') >= 0) return;            // 商品不符另有註記邏輯
    const idx = cur.lastIndexOf(' ');                   // 燈號前面插入註記，燈號留在最後
    const body = idx > 0 ? cur.slice(0, idx) : cur;
    const emoji = idx > 0 ? cur.slice(idx) : '';
    sh.getRange(r._row, checkResultCol).setValue(body + '（曾掃描超量）' + emoji);
    fixed++;
  });
  Logger.log('已為 '+fixed+' 列「完成卻亮紅燈」的紀錄補上掃描超量原因。');
  return {已補註記列數: fixed};
}

// ---------------- 一次性修復用：把既有出貨紀錄的掃描件數補上綠色打勾 ----------------
// formatScannedCount_()是這次才加的，之前寫入的既有列還只是純數字，沒有打勾。
// 用是否已經含有✅字元判斷「補過了沒」，補過的列會跳過，可以放心重複執行。
function fixScannedCountCheckmark_(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  if(!sh){ Logger.log('找不到「出貨紀錄」分頁'); return; }
  const rows = readRows(SHEET_LOG, LOG_HEADER);
  const scannedCol = colOf(LOG_HEADER,'scannedCount');
  let fixed = 0;
  rows.forEach(r=>{
    if(r.requiredCount === '' || r.requiredCount === undefined) return; // 不是該訂單第一列，維持空白
    const current = String(r.scannedCount||'');
    if(current.indexOf('✅') >= 0) return; // 已經補過了，跳過
    const newVal = formatScannedCount_(r.requiredCount, r.scannedCount);
    if(String(newVal) !== current){
      sh.getRange(r._row, scannedCol).setValue(newVal);
      fixed++;
    }
  });
  Logger.log('已補上掃描件數的綠色打勾：'+fixed+' 列');
}

// ---------------- 一次性修復用：把獨立的「核對狀態」欄位併回「核對結果」欄位，並刪掉舊欄位 ----------------
// 用標題文字（而不是寫死欄號）找出舊「核對狀態」欄實際在哪一欄，因為LOG_HEADER已經拿掉這個欄位了、
// colOf()查不到。需求件數/掃描件數只存在每組訂單的第一列，其餘品項列要沿用同一組的值才能正確判斷，
// 不能直接拿自己那一列的（會是空白，誤判成「待核對」）。
function mergeVerifyStatusIntoCheckResult_(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  if(!sh){ Logger.log('找不到「出貨紀錄」分頁'); return; }
  const lastCol = sh.getLastColumn();
  const headerRow = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const oldVerifyStatusColIdx = headerRow.indexOf('核對狀態'); // 0-indexed，-1代表這次沒找到（可能已經處理過了）

  const rows = readRows(SHEET_LOG, LOG_HEADER);
  const checkResultCol = colOf(LOG_HEADER,'checkResult');
  const groupInfo = {};
  rows.forEach(r=>{
    const key = r.orderNo + '||' + r.time;
    if(!groupInfo[key] && r.requiredCount !== '' && r.requiredCount !== undefined){
      groupInfo[key] = {requiredCount: r.requiredCount, scannedCount: r.scannedCount};
    }
  });
  rows.forEach(r=>{
    const key = r.orderNo + '||' + r.time;
    const g = groupInfo[key] || {requiredCount: 0, scannedCount: 0};
    const entryLike = {
      hadIssue: textToBool(r.hadIssue), hadManualEdit: textToBool(r.hadManualEdit),
      hadNoBarcodeConfirm: textToBool(r.hadNoBarcodeConfirm), importedExternal: textToBool(r.importedExternal),
      differenceDetails: r.differenceDetails, requiredCount: g.requiredCount, scannedCount: g.scannedCount
    };
    const verifyStatus = classifyVerifyStatus_(entryLike);
    sh.getRange(r._row, checkResultCol).setValue(buildCheckResult_(entryLike, verifyStatus));
  });

  if(oldVerifyStatusColIdx >= 0){
    sh.deleteColumn(oldVerifyStatusColIdx + 1);
    Logger.log('已刪除舊的獨立「核對狀態」欄位（原第'+(oldVerifyStatusColIdx+1)+'欄）。');
  }
  Logger.log('已重新計算 '+rows.length+' 列的核對結果（併入核對狀態資訊）。');
}

// ---------------- 一次性修復用：把差異明細改成依貨號分別記錄，並刪掉舊的「無條碼手動核對明細」欄位 ----------------
// 舊版每一列的差異明細都是整張訂單的事件全部串成一長串文字、每個品項的列都重複顯示同一份，
// 不容易看出「這個貨號」實際發生了什麼事。這裡把舊差異明細文字拆開，依內容裡出現的貨號分別歸類：
//   - 找得到對應貨號的片段（數量超過／人工修正／無條碔手動核對，這幾種原本的文字就有帶貨號）
//     → 簡化成「貨號／規格／處理方式」格式（不帶品名），只放在那個貨號自己的列。
//   - 找不到對應貨號的片段（目前只有「商品不符」，因為掃到的是根本不屬於這張訂單的條碼）
//     → 算訂單層級事件，維持原樣只放在該次出貨的第一列。
// 用標題文字找出舊「無條碼手動核對明細」欄實際在哪一欄，因為LOG_HEADER已經拿掉這個欄位、colOf()查不到。
function mergeNoBarcodeDetailIntoDifferenceDetails_(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  if(!sh){ Logger.log('找不到「出貨紀錄」分頁'); return; }
  const lastCol = sh.getLastColumn();
  const headerRow = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const oldNoBarcodeDetailColIdx = headerRow.indexOf('無條碼手動核對明細'); // 0-indexed，-1代表已經處理過或本來就沒有

  const rows = readRows(SHEET_LOG, LOG_HEADER);
  const differenceDetailsCol = colOf(LOG_HEADER,'differenceDetails');

  const groups = {};
  const groupOrder = [];
  rows.forEach(r=>{
    const key = r.orderNo + '||' + r.time;
    if(!groups[key]){ groups[key] = []; groupOrder.push(key); }
    groups[key].push(r);
  });

  // 把舊格式的一句話簡化成「處理方式」短句，不帶品名；無法辨識的格式就整句原樣保留，不憑空遺失資訊
  const methodLabel = f=>{
    if(/^數量超過：/.test(f)) return '數量超過應出數量';
    let m = f.match(/^無條碼手動核對：.*第\s*(\d+)\/(\d+)\s*件/);
    if(m) return `無條碼手動核對第${m[1]}件`;
    m = f.match(/^人工修正：.*已掃數量從\s*(\d+)\s*改為\s*(\d+)/);
    if(m) return `人工修正數量（${m[1]}→${m[2]}）`;
    return f;
  };

  let updated = 0;
  groupOrder.forEach(key=>{
    const groupRows = groups[key];
    const fullText = groupRows[0].differenceDetails || '';
    const fragments = (fullText && fullText !== '無差異') ? fullText.split('；') : [];
    const orderLevelFragments = [];
    const perSkuMethods = {}; // sku -> [處理方式,...]

    fragments.forEach(f=>{
      const owner = groupRows.find(r=> r.sku && f.indexOf(r.sku) >= 0);
      if(owner){
        if(!perSkuMethods[owner.sku]) perSkuMethods[owner.sku] = [];
        perSkuMethods[owner.sku].push(methodLabel(f));
      } else {
        orderLevelFragments.push(f); // 比對不到任何品號，算訂單層級（例如商品不符）
      }
    });

    groupRows.forEach((r, idx)=>{
      const methods = perSkuMethods[r.sku] || [];
      let rowText = methods.length ? `${r.sku}／${r.spec || '-'}／${methods.join('、')}` : '';
      if(idx === 0){
        rowText = [orderLevelFragments.join('；'), rowText].filter(Boolean).join('；') || '無差異';
      }
      sh.getRange(r._row, differenceDetailsCol).setValue(rowText);
      updated++;
    });
  });

  if(oldNoBarcodeDetailColIdx >= 0){
    sh.deleteColumn(oldNoBarcodeDetailColIdx + 1);
    Logger.log('已刪除舊的獨立「無條碼手動核對明細」欄位（原第'+(oldNoBarcodeDetailColIdx+1)+'欄）。');
  }
  Logger.log('已重新整理 '+updated+' 列的差異明細（改成依貨號分別記錄）。');
}

// ---------------- 一次性修復用：還原特定一批在部署交接期間寫入、備註／曾無條碼手動核對欄位錯位的資料列 ----------------
// 背景：這次session中間有個時間點LOG_HEADER還在調整，剛好在那個交接窗口寫入的出貨紀錄
// （目前已知只有一張訂單、8列品項）備註欄跟曾無條碔手動核對欄的內容整組錯開了一格——
// 備註欄目前存的其實是「是/否+燈號」（本來應該是曾無條碼手動核對的值），曾無條碼手動核對欄
// 存的是舊「無條碼手動核對明細」欄的殘留值（本來已經併入差異明細，這裡多的是孤兒資料）。
// 判斷依據：備註欄本來一定是空字串（掃描流程從來不會寫入備註，只有外部匯入Excel才會用到這欄），
// 只要備註欄目前看起來像「是 ...」或「否 ...」就代表是這個錯位，其餘正常資料列不會被誤判。
function fixNoteHadNoBarcodeConfirmShift_(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  if(!sh){ Logger.log('找不到「出貨紀錄」分頁'); return; }
  const rows = readRows(SHEET_LOG, LOG_HEADER);
  const noteCol = colOf(LOG_HEADER,'note');
  const hadNoBarcodeConfirmCol = colOf(LOG_HEADER,'hadNoBarcodeConfirm');
  let fixed = 0;
  rows.forEach(r=>{
    const noteVal = String(r.note||'');
    if(/^(是|否)[\s　]/.test(noteVal)){
      sh.getRange(r._row, hadNoBarcodeConfirmCol).setValue(noteVal);
      sh.getRange(r._row, noteCol).setValue('');
      fixed++;
    }
  });
  Logger.log('已修正 '+fixed+' 列的備註／曾無條碼手動核對欄位錯位。');
}

// ---------------- 一次性修復用：把既有出貨紀錄的核對結果補上燈號emoji ----------------
// classifyLogEmoji_() 是這次才加的，之前寫入的既有列「核對結果」欄還只是純文字，沒有燈號。
// 用是否已經含有🔴🟠🔵🟢其中一個字元判斷「補過了沒」，補過的列會跳過，可以放心重複執行。
function fixCheckResultEmoji_(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  if(!sh){ Logger.log('找不到「出貨紀錄」分頁'); return; }
  const rows = readRows(SHEET_LOG, LOG_HEADER);
  const checkResultCol = colOf(LOG_HEADER,'checkResult');
  let fixed = 0;
  rows.forEach(r=>{
    const current = String(r.checkResult||'');
    if(/[🔴🟠🔵🟢]/.test(current)) return; // 已經補過燈號了，跳過
    const emoji = classifyLogEmoji_({
      hadIssue: textToBool(r.hadIssue), hadManualEdit: textToBool(r.hadManualEdit),
      hadNoBarcodeConfirm: textToBool(r.hadNoBarcodeConfirm), importedExternal: textToBool(r.importedExternal)
    });
    sh.getRange(r._row, checkResultCol).setValue((current||'完成') + ' ' + emoji);
    fixed++;
  });
  Logger.log('已補上燈號的核對結果：'+fixed+' 列');
}

// ---------------- 一次性修復用：把既有出貨紀錄的是/否欄位補上燈號emoji ----------------
// boolToText()是這次才改成回傳「是 🟠」/「否 🟢」，之前寫入的既有列這幾欄還是純文字「是」/「否」。
// 判斷「補過了沒」用是否已經含有🟠或🟢字元，補過的列會跳過，可以放心重複執行。
function fixBooleanColumnEmoji_(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  if(!sh){ Logger.log('找不到「出貨紀錄」分頁'); return; }
  const rows = readRows(SHEET_LOG, LOG_HEADER);
  const boolFields = ['hadIssue', 'hadManualEdit', 'importedExternal', 'hadNoBarcodeConfirm'];
  const cols = {};
  boolFields.forEach(f=> cols[f] = colOf(LOG_HEADER, f));
  let fixed = 0;
  rows.forEach(r=>{
    boolFields.forEach(f=>{
      const current = String(r[f]||'');
      if(/[🟠🟢]/.test(current)) return; // 已經補過燈號了，跳過
      if(current !== '是' && current !== '否') return; // 不是預期的是非文字就不動它
      sh.getRange(r._row, cols[f]).setValue(boolToText(current === '是'));
      fixed++;
    });
  });
  Logger.log('已補上燈號的是/否欄位：'+fixed+' 格');
}

// ---------------- 批次匯入已出貨紀錄（指定出貨Excel那個功能用） ----------------
function importShippedBatch(entries){
  const ordersSh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readOrderRows();
  const byOrderNo = {};
  rows.forEach(r=> byOrderNo[r.orderNo] = r);

  let imported=0, skippedNotFound=0, skippedAlreadyShipped=0;
  const now = new Date().toISOString();
  entries.forEach(entry=>{
    let row = byOrderNo[entry.orderNo];
    if(!row){ skippedNotFound++; return; }
    row = healOrderRowIfNeeded_(ordersSh, row);
    if(row.status === 'shipped'){ skippedAlreadyShipped++; return; }
    ordersSh.getRange(row._row, colOf(ORDERS_HEADER,'status'), 1, 4).setValues([[statusToText('shipped'), '', '', now]]);
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

// ---------------- 一次性清理用：清掉開發過程中留下的測試訂單 ----------------
// 凡是訂單號開頭是「TEST-」的都當作測試假訂單清掉（不用每次新增測試資料都要回來改這個清單），
// 從「訂單」「出貨紀錄」兩個分頁刪掉對應列，「訂單明細」跟著重建一次自然就乾淨了。
function deleteTestOrders_(){
  const isTestOrder = orderNo => String(orderNo||'').indexOf('TEST-') === 0;
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const ordersSh = ss.getSheetByName(SHEET_ORDERS);
  let deletedOrderRows = 0;
  if(ordersSh){
    const rows = readOrderRows();
    const rowNums = rows.filter(r=>isTestOrder(r.orderNo)).map(r=>r._row).sort((a,b)=>b-a);
    rowNums.forEach(rowNum=>{ ordersSh.deleteRow(rowNum); deletedOrderRows++; });
  }

  const logSh = ss.getSheetByName(SHEET_LOG);
  let deletedLogRows = 0;
  if(logSh){
    const rows = readRows(SHEET_LOG, LOG_HEADER);
    const rowNums = rows.filter(r=>isTestOrder(r.orderNo)).map(r=>r._row).sort((a,b)=>b-a);
    rowNums.forEach(rowNum=>{ logSh.deleteRow(rowNum); deletedLogRows++; });
  }

  rebuildOrderDetailSheet_(); // 訂單明細是從訂單分頁重建的，訂單裡的測試列刪掉後這裡要跟著刷新
  Logger.log('已刪除「TEST-」開頭的測試訂單：訂單分頁 '+deletedOrderRows+' 列、出貨紀錄分頁 '+deletedLogRows+' 列。');
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
// 整列上色，四選一、互斥（每列一定會落在其中一種，不會沒有顏色）：
// 錯誤(紅燈)：曾觸發警示(是)，或「核對結果」顯示錯誤（少件/商品不符，目前只有外部匯入的紀錄才可能出現）。
// 警示(橘燈)：沒有錯誤，但曾手動修改數量或曾無條碼手動核對——過程有人工介入，值得留意但不算出錯。
// 完成(藍燈)：沒有錯誤也沒有警示，但是外部匯入的紀錄——不是這個系統掃描出來的，來源不同特別標示。
// 正確(綠燈)：以上皆非，全程正常掃描完成，沒有任何人工介入——最單純、最理想的狀態。
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
  const hadNoBarcodeConfirmCol = colLetter(colOf(LOG_HEADER,'hadNoBarcodeConfirm'));
  const checkResultCol = colLetter(colOf(LOG_HEADER,'checkResult'));
  // boolToText()現在存的是「是 🟠」/「否 🟢」（文字+燈號），不是單純「是」/「否」了，
  // 用LEFT(...,1)="是"只比對開頭那個字，新舊資料（含不含燈號）都吃得下，不用另外判斷。
  const isYes = col => `LEFT($${col}2,1)="是"`;
  const isNo = col => `LEFT($${col}2,1)<>"是"`;
  // 「核對結果」欄位現在把核對狀態（完成/待核對/錯誤：xxx）併進去了，
  // 整列判斷是否出錯除了看曾觸發警示，也要看核對結果開頭是不是「錯誤」。
  const isError = `OR(${isYes(hadIssueCol)},LEFT($${checkResultCol}2,2)="錯誤")`;
  const isNotError = `AND(${isNo(hadIssueCol)},LEFT($${checkResultCol}2,2)<>"錯誤")`;
  const rules = [
    // 紅燈：錯誤
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=${isError}`)
      .setBackground('#f4cccc')
      .setRanges([fullRange])
      .build(),
    // 橘燈：警示（人工修正數量 或 無條碼手動核對，但沒有真的出錯）
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=AND(${isNotError},OR(${isYes(hadManualEditCol)},${isYes(hadNoBarcodeConfirmCol)}))`)
      .setBackground('#fce5cd')
      .setRanges([fullRange])
      .build(),
    // 藍燈：完成（外部匯入的紀錄，且沒有錯誤也沒有警示）
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=AND(${isNotError},${isNo(hadManualEditCol)},${isNo(hadNoBarcodeConfirmCol)},${isYes(importedExternalCol)})`)
      .setBackground('#cfe2f3')
      .setRanges([fullRange])
      .build(),
    // 綠燈：正確（以上皆非，全程正常掃描完成）
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=AND(${isNotError},${isNo(hadManualEditCol)},${isNo(hadNoBarcodeConfirmCol)},${isNo(importedExternalCol)})`)
      .setBackground('#d9ead3')
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
  const dateCol = colOf(ORDERS_HEADER,'date');
  let migrated = 0;
  values.forEach((row, i)=>{
    // 第7欄已經是合法狀態值（不管是舊的英文代碼還是現在的中文），代表這列已經是新版，跳過
    if(STATUS_LABELS[textToStatus(row[6])]) return;
    const orderNo=row[0], store=row[1], date=row[2], itemsJson=row[3];
    const oldStatus=row[4], oldClaimedBy=row[5], oldClaimedAt=row[6], oldUpdatedAt=row[7], oldShipMethod=row[8], oldRoutingStatus=row[9];
    const items = safeParse(itemsJson, []);
    const {skuSummary, nameSummary} = summarizeItems(items);
    const targetRow = i + 2;
    sh.getRange(targetRow, dateCol).setNumberFormat('@');
    // 依 ORDERS_HEADER 目前的欄位數量組出整列，之後再加欄位這裡不用跟著改
    // （寫死12個值的話，現在多了「人工結案」欄就會直接噴「欄數不符」的錯）
    const rowObj = {
      orderNo, store, date, itemsJson, skuSummary, nameSummary,
      status: statusToText(textToStatus(oldStatus) || 'pending'),
      claimedBy: oldClaimedBy || '', claimedAt: oldClaimedAt || '', updatedAt: oldUpdatedAt || '',
      shipMethod: oldShipMethod || '', routingStatus: oldRoutingStatus || '', manualClose: '',
      logisticsConfirmed: '', logisticsTime: '', pickedJson: ''
    };
    sh.getRange(targetRow, 1, 1, ORDERS_HEADER.length).setValues([ORDERS_HEADER.map(h=>rowObj[h])]);
    migrated++;
  });
  Logger.log('訂單分頁：已還原 '+migrated+' 列舊資料的欄位位移');
}

// （migrateLogColumnShift() 這個舊的一次性修復函式已經完成階段性任務並移除——
// 出貨紀錄後來又整個改成一列一品項格式，下面 migrateLogToPerItemFormat_() 是取代它的新版本。）

// ---------------- 一次性重建用：出貨紀錄改成「一列一品項」格式，順便併入出貨紀錄明細分頁 ----------------
// 在 Apps Script 編輯器裡選這個函式、按「執行」跑一次即可（不用重新部署）：
//   1. 讀出「出貨紀錄」現有的每一列（訂單層級一列，itemsJson整包塞在一欄），
//   2. 依 items 展開成新格式重新寫入（一個品項一列，訂單層級欄位每列重複），
//   3. 刪除「出貨紀錄明細」分頁——這個分頁的功能已經併入「出貨紀錄」本身，不用再開兩個分頁對照。
// 執行完後記得重新跑一次 setupLogSheetColors()：分頁被整個重建，舊的顏色規則會失效需要重新套用。
// 防止 migrateLogToPerItemFormat_() 重複執行用的標記格：故意放在遠超過 LOG_HEADER
// 欄位範圍之外的欄位（getSheet()每次讀取都會強制重寫表頭列，但只會動到 1~LOG_HEADER.length
// 這個範圍內的欄位，不會碰到這裡），才不會被「隨便呼叫一次API結果表頭列被重寫」誤判成已經轉換過。
const LOG_MIGRATION_MARKER_COL = 30; // AD欄
const LOG_MIGRATION_MARKER_VALUE = 'migrated-per-item-v1';
function migrateLogToPerItemFormat_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const OLD_LOG_HEADER = ['orderNo','orderDate','waybill','itemsJson','skuSummary','nameSummary','staffId','staffName','time','hadIssue','hadManualEdit','importedExternal','store','shipMethod','note','requiredCount','scannedCount','routingStatus','checkResult','differenceDetails','startTime'];
  const oldSh = ss.getSheetByName(SHEET_LOG);
  if(oldSh && oldSh.getRange(1, LOG_MIGRATION_MARKER_COL).getValue() === LOG_MIGRATION_MARKER_VALUE){
    Logger.log('偵測到已轉換標記，出貨紀錄已經是一列一品項格式，不重複執行。');
    return;
  }
  const oldEntries = [];
  if(oldSh){
    const lastRow = oldSh.getLastRow();
    if(lastRow >= 2){
      const numCols = Math.max(oldSh.getLastColumn(), OLD_LOG_HEADER.length);
      const values = oldSh.getRange(2, 1, lastRow-1, numCols).getValues();
      values.forEach(row=>{
        const obj = {};
        OLD_LOG_HEADER.forEach((h, idx)=> obj[h] = row[idx]);
        oldEntries.push(obj);
      });
    }
    ss.deleteSheet(oldSh);
  }
  getSheet(SHEET_LOG, LOG_HEADER); // 用新表頭重新建立空白分頁
  oldEntries.forEach(r=>{
    appendLogRow({
      orderNo: r.orderNo, orderDate: cellToText(r.orderDate), waybill: r.waybill,
      items: safeParse(r.itemsJson, []), staffId: r.staffId, staffName: r.staffName,
      time: cellToText(r.time, true),
      hadIssue: textToBool(r.hadIssue), hadManualEdit: textToBool(r.hadManualEdit), importedExternal: textToBool(r.importedExternal),
      store: r.store, shipMethod: r.shipMethod, note: r.note,
      requiredCount: r.requiredCount, scannedCount: r.scannedCount, routingStatus: r.routingStatus,
      checkResult: r.checkResult, differenceDetails: r.differenceDetails, startTime: cellToText(r.startTime, true)
    });
  });
  const detailSh = ss.getSheetByName('出貨紀錄明細');
  if(detailSh) ss.deleteSheet(detailSh);
  ss.getSheetByName(SHEET_LOG).getRange(1, LOG_MIGRATION_MARKER_COL).setValue(LOG_MIGRATION_MARKER_VALUE);
  Logger.log('出貨紀錄已轉成一列一品項格式，共轉換 '+oldEntries.length+' 筆出貨紀錄；出貨紀錄明細分頁已刪除（功能已併入出貨紀錄）。記得重新執行一次 setupLogSheetColors() 套用顏色規則。');
}

// ---------------- 一次性重建用：出貨紀錄欄位重新排序 ----------------
// 只是調整欄位顯示順序，資料內容不變。用「欄位名稱→值」讀出每一列（跟順序無關），
// 再依新的 LOG_HEADER 順序重寫，所以不管欄位怎麼調都不會對錯欄位。
// 標記格用不同的欄位（AE，跟前面那個位移用的AD分開），避免兩個判斷互相干擾。
const LOG_REORDER_MARKER_COL = 31; // AE欄
const LOG_REORDER_MARKER_VALUE = 'reordered-v1';
function migrateLogColumnReorder_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // 這裡列的是「重新排序」這個動作執行前，LOG_HEADER當時的順序（一列一品項格式剛上線時的順序），
  // 用來正確讀出還沒重新排序過的舊資料列；跟目前（重新排序後）的 LOG_HEADER 分開，不要搞混。
  const PRE_REORDER_LOG_HEADER = ['orderNo','orderDate','waybill','baseName','spec','sku','qty','scanned','staffId','staffName','time','hadIssue','hadManualEdit','importedExternal','store','shipMethod','note','requiredCount','scannedCount','routingStatus','checkResult','differenceDetails','startTime'];
  const sh = ss.getSheetByName(SHEET_LOG);
  if(!sh){ Logger.log('找不到「出貨紀錄」分頁'); return; }
  if(sh.getRange(1, LOG_REORDER_MARKER_COL).getValue() === LOG_REORDER_MARKER_VALUE){
    Logger.log('偵測到已重新排序標記，不重複執行。');
    return;
  }
  const lastRow = sh.getLastRow();
  const oldEntries = [];
  if(lastRow >= 2){
    const numCols = Math.max(sh.getLastColumn(), PRE_REORDER_LOG_HEADER.length);
    const values = sh.getRange(2, 1, lastRow-1, numCols).getValues();
    values.forEach(row=>{
      const obj = {};
      PRE_REORDER_LOG_HEADER.forEach((h, idx)=> obj[h] = row[idx]);
      oldEntries.push(obj);
    });
  }
  ss.deleteSheet(sh);
  const newSh = getSheet(SHEET_LOG, LOG_HEADER);
  if(oldEntries.length){
    newSh.getRange(2, colOf(LOG_HEADER,'orderDate'), oldEntries.length, 1).setNumberFormat('@');
    newSh.getRange(2, colOf(LOG_HEADER,'time'), oldEntries.length, 1).setNumberFormat('@');
    newSh.getRange(2, colOf(LOG_HEADER,'startTime'), oldEntries.length, 1).setNumberFormat('@');
    const rows = oldEntries.map(r=> LOG_HEADER.map(h=> r[h]));
    newSh.getRange(2, 1, rows.length, LOG_HEADER.length).setValues(rows);
  }
  newSh.getRange(1, LOG_REORDER_MARKER_COL).setValue(LOG_REORDER_MARKER_VALUE);
  Logger.log('出貨紀錄欄位順序調整完成，共 '+oldEntries.length+' 列。記得重新執行一次 setupLogSheetColors() 套用顏色規則（分頁被重建，舊規則會失效）。');
}

// ---------------- 一次性重建用：把「曾無條碼手動核對」欄位移到「差異明細」前面 ----------------
// 跟 migrateLogColumnReorder_() 同樣做法：讀出「重新排序前」的舊欄位順序，依欄位名稱轉成物件，
// 再用目前（已經改好順序的）LOG_HEADER重新寫回，不管欄位怎麼調都不會對錯欄位。
// 標記格用第32欄（AF），跟前面兩次重建用的AD/AE分開，避免互相干擾判斷。
const LOG_REORDER2_MARKER_COL = 32; // AF欄
const LOG_REORDER2_MARKER_VALUE = 'reordered-v2';
function migrateLogColumnReorder2_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // 這次重新排序前，LOG_HEADER當時的順序（hadNoBarcodeConfirm還在最後面、note在它前面）
  const PRE_REORDER2_LOG_HEADER = ['store','orderNo','orderDate','waybill','shipMethod','sku','baseName','spec','qty','scanned','staffId','staffName','startTime','time','hadIssue','hadManualEdit','importedExternal','requiredCount','scannedCount','routingStatus','checkResult','differenceDetails','note','hadNoBarcodeConfirm'];
  const sh = ss.getSheetByName(SHEET_LOG);
  if(!sh){ Logger.log('找不到「出貨紀錄」分頁'); return; }
  if(sh.getRange(1, LOG_REORDER2_MARKER_COL).getValue() === LOG_REORDER2_MARKER_VALUE){
    Logger.log('偵測到已重新排序標記，不重複執行。');
    return;
  }
  const lastRow = sh.getLastRow();
  const oldEntries = [];
  if(lastRow >= 2){
    const numCols = Math.max(sh.getLastColumn(), PRE_REORDER2_LOG_HEADER.length);
    const values = sh.getRange(2, 1, lastRow-1, numCols).getValues();
    values.forEach(row=>{
      const obj = {};
      PRE_REORDER2_LOG_HEADER.forEach((h, idx)=> obj[h] = row[idx]);
      oldEntries.push(obj);
    });
  }
  ss.deleteSheet(sh);
  const newSh = getSheet(SHEET_LOG, LOG_HEADER);
  if(oldEntries.length){
    newSh.getRange(2, colOf(LOG_HEADER,'orderDate'), oldEntries.length, 1).setNumberFormat('@');
    newSh.getRange(2, colOf(LOG_HEADER,'time'), oldEntries.length, 1).setNumberFormat('@');
    newSh.getRange(2, colOf(LOG_HEADER,'startTime'), oldEntries.length, 1).setNumberFormat('@');
    const rows = oldEntries.map(r=> LOG_HEADER.map(h=> r[h]));
    newSh.getRange(2, 1, rows.length, LOG_HEADER.length).setValues(rows);
  }
  newSh.getRange(1, LOG_REORDER2_MARKER_COL).setValue(LOG_REORDER2_MARKER_VALUE);
  Logger.log('出貨紀錄欄位順序調整完成（曾無條碼手動核對移到差異明細前面），共 '+oldEntries.length+' 列。記得重新執行一次 setupLogSheetColors() 套用顏色規則（分頁被重建，舊規則會失效）。');
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
    // 欄位：1日期 2賣場 3下單時間 4寄送方式 5訂單 6品名 7規格 8品號 9數量
    //       12文山儲位 13總倉 14文山（揀貨要用：儲位決定走動路線，庫存讓人員判斷缺不缺）
    //       18缺貨量 19文山分配 20山物分配 21中華分配 22OM分配
    //         （這五欄決定「這件在文山揀得到嗎」——分配到別的門店的要走調撥，
    //           揀貨員在文山怎麼找都找不到，一定要標示出來，不然就是白找）
    //       31訂單狀態
    // 多抓欄位不影響既有邏輯——autoSyncOrders_ 是用表頭名稱找欄位（header.indexOf），
    // 不是用寫死的欄號，所以欄位順序變動不會讓它讀錯。
    '=CHOOSECOLS(IMPORTRANGE("1wMrjppENakDhT354VJ6-W7txoG9FSwYR2OjMzPRl2KQ","\'文山出貨V2\'!A:AE"),1,2,3,4,5,6,7,8,9,12,13,14,18,19,20,21,22,31)'
  );

  // 條碼轉品號：「國際碼」分頁本身也是IMPORTRANGE鏡像，直接接到它指向的真正來源
  let barcodeSh = ss.getSheetByName('條碼轉品號');
  if(!barcodeSh) barcodeSh = ss.insertSheet('條碼轉品號');
  barcodeSh.getRange('A1').setFormula(
    '=IMPORTRANGE("1rVAAGPeTc3p4m0xpKLnByteYELW1imuhLPhJhTmbI_8","\'國際碼對照表\'!A:E")'
  );

  Logger.log('已建立「文山出貨V2」「條碼轉品號」鏡像分頁，請打開這兩個分頁手動完成一次性授權（如果有跳出提示的話）。');
}
