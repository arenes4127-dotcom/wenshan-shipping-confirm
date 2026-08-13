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
const BACKEND_VERSION = '2026-08-13.104';

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
// itemsOverrideJson 是「訂單修改」分頁存下來的修改指令（缺貨不出／改數量／換貨號／加品項）。
// 為什麼要另外存一欄，而不是直接改 itemsJson：訂單每次同步都會從來源整列重寫，
// 直接改品項的話下一次同步（一天4次＋隨時手動）就被蓋回去，改了等於沒改。
// 存成「指令」而不是「改完的結果」，來源之後又變動（客服改了數量）也還套得上去。
const ORDERS_HEADER = ['orderNo','store','date','itemsJson','skuSummary','nameSummary','status','claimedBy','claimedAt','updatedAt','shipMethod','routingStatus','manualClose','logisticsConfirmed','logisticsTime','pickedJson','specialNote','itemsOverrideJson','pickDoneAt','pickDoneBy',
  // 一張訂單的時間軸。分散在各處的時間（揀貨紀錄、出貨紀錄）算得出來，但出貨紀錄每晚清空、
  // 揀貨紀錄要掃全表，KPI 每天都得重算一次很吃力，而且過了那天就再也回不去。
  // 把里程碑固定在訂單自己身上，之後不管算哪一段（進單→揀貨→出貨→進籃）都只讀這一張表。
  'createdAt','pickStartAt','shipStartAt','shipDoneAt'];
const SHEET_PICKLOG = '揀貨紀錄';
// APP 的兩個入口。正式網頁版（GitHub Pages）是倉庫裝置在用的；
// Drive 那份是同一支 index.html 的副本，網路連不到 GitHub 時的備援。
// 集中放在這裡，儀表板上的連結跟以後任何要顯示網址的地方都引用這兩個常數，
// 不要各自寫死一份——網址改掉時會漏改。
const APP_WEB_URL = 'https://arenes4127-dotcom.github.io/wenshan-shipping-confirm/';
const APP_DRIVE_FOLDER_ID = '1quwo_65K5YQMZtuLD-vkheg-g97kYond';
const APP_DRIVE_URL = 'https://drive.google.com/drive/folders/' + APP_DRIVE_FOLDER_ID;
// kind：文山／調撥。同樣是「打勾」，在文山貨架上揀到、跟等別的門店把貨送來，
// 是兩種完全不同的作業，效率也要分開看——沒有這一欄就只知道「今天打了幾個勾」。
// result/differenceDetails 只填在「揀貨完成」那一列，跟出貨紀錄同一個做法：
// 逐件的動作列不需要重複整張單的結論，填了反而看不出哪一列才是結案。
const PICKLOG_HEADER = ['logTime','orderNo','sku','baseName','location','qty','pickerId','pickerName','action','kind','result','differenceDetails'];
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
  pickedJson:'已揀品項(JSON)', specialNote:'特殊註記', pickerId:'揀貨人工號', pickerName:'揀貨人姓名', location:'儲位', action:'動作', kind:'類型', result:'揀貨結果',
  itemsOverrideJson:'品項修改(JSON)',
  pickDoneAt:'揀貨完成時間', pickDoneBy:'揀貨完成人',
  createdAt:'進單時間', pickStartAt:'開始揀貨時間', shipStartAt:'開始掃描時間', shipDoneAt:'出貨完成時間'
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
      case 'markPickDone': result = markPickDone(body); break;
      case 'logPickScanMiss': result = logPickScanMiss(body); break;
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
  syncSpecialNotes_: () => syncSpecialNotes_(),
  closeCancelledByNote_: () => closeCancelledByNote_(),
  testCancelByNote_: () => testCancelByNote_(),
  previewCancelledByNote_: () => previewCancelledByNote_(),
  batchCloseOtherWarehouseOrders_: () => batchCloseOtherWarehouseOrders_(),
  closeBasketConfirmedPending_: () => closeBasketConfirmedPending_(),
  batchCloseOrdersBefore_: (arg) => batchCloseOrdersBefore_(arg),
  setupAmendSheet_: () => setupAmendSheet_(),
  importProductImages_: () => importProductImages_(),
  checkProductImageCoverage_: () => checkProductImageCoverage_(),
  testApplyItemOps_: () => testApplyItemOps_(),
  testAmendFlow_: () => testAmendFlow_(),
  testOnEditWiring_: () => testOnEditWiring_(),
  cleanupTestSysLogRows_: () => cleanupTestSysLogRows_(),
  testFlaggedSpill_: () => testFlaggedSpill_(),
  dailyMaintenance_: () => dailyMaintenance_(),
  findScriptProjects_: () => findScriptProjects_(),
  inspectSourceSpreadsheet_: (arg) => inspectSourceSpreadsheet_(arg),
  inspectSheetFormulas_: (arg) => inspectSheetFormulas_(arg),
  listFolder_: (arg) => listFolder_(arg),
  findSheetOwner_: (arg) => findSheetOwner_(arg),
  hourlySync_: () => hourlySync_(),
  testStaleClaimRelease_: () => testStaleClaimRelease_(),
  migrateOrderStatusToChinese_: () => migrateOrderStatusToChinese_(),
  archiveShippedOrders_: () => archiveShippedOrders_(),
  appendDailyStats_: () => appendDailyStats_(),
  setupKpiSheet_: () => setupKpiSheet_(),
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
  const folder = DriveApp.getFolderById(APP_DRIVE_FOLDER_ID);
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
      logisticsTime: String(r.logisticsTime || '').trim(),
      specialNote: String(r.specialNote || '').trim(),
      pickDoneAt: String(r.pickDoneAt || '').trim(),
      pickDoneBy: String(r.pickDoneBy || '').trim(),
      createdAt: cellToText(r.createdAt, true) || '',
      pickStartAt: cellToText(r.pickStartAt, true) || '',
      shipStartAt: cellToText(r.shipStartAt, true) || '',
      shipDoneAt: cellToText(r.shipDoneAt, true) || ''
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
    // 主管在「訂單修改」分頁做過的調整，每次同步都要重新套一次——來源送過來的永遠是原始品項。
    const override = existing ? String(existing.itemsOverrideJson||'') : '';
    const finalItems = applyItemOps_(o.items||[], safeParse(override, []));
    const itemsJson = JSON.stringify(finalItems);
    const {skuSummary, nameSummary} = summarizeItems(finalItems);
    const targetRow = existing ? existing._row : sh.getLastRow()+1;
    // 「日期」欄位強制設成純文字格式再寫入，避免 Google試算表把「2026/8/5」這種字串
    // 自動偵測轉成日期型別儲存格（那樣讀回來會變成UTC的ISO時間字串，跟原本存的字不一樣）
    sh.getRange(targetRow, colOf(ORDERS_HEADER,'date')).setNumberFormat('@');
    // 時間軸那幾欄同樣要先設成純文字。不設的話「2026/08/13 14:13:40」會被試算表
    // 自動吃成日期型別，讀回來變成「Thu Aug 13 2026 ... GMT+0800」，
    // 解析時間的正則完全對不上，所有耗時就全部算不出來（實際踩到）。
    sh.getRange(targetRow, colOf(ORDERS_HEADER,'createdAt'), 1, 4).setNumberFormat('@');
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
      pickedJson: existing ? (existing.pickedJson||'') : '',
      // 特殊註記是客服寫的，由 syncSpecialNotes_ 專門更新，一般同步不要動它
      specialNote: existing ? (existing.specialNote||'') : '',
      // 品項修改指令要留著，不然同步一次就把主管改過的內容洗掉了
      itemsOverrideJson: override,
      // 揀貨完成的時間與人也是現場做出來的，同步只更新訂單內容，不能洗掉
      pickDoneAt: existing ? (existing.pickDoneAt||'') : '',
      pickDoneBy: existing ? (existing.pickDoneBy||'') : '',
      // 進單時間只在第一次寫入時記，之後每次同步都沿用——
      // 每次同步都覆蓋的話它會變成「最後一次同步時間」，那就完全不是進單時間了。
      createdAt: (existing && existing.createdAt) ? existing.createdAt : nowStamp_(),
      pickStartAt: existing ? (existing.pickStartAt||'') : '',
      shipStartAt: existing ? (existing.shipStartAt||'') : '',
      shipDoneAt: existing ? (existing.shipDoneAt||'') : ''
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
  // 「缺貨」也要收。這是實際踩到的問題：2026/8/12 的 2608114FD2T48C 在來源是「缺貨」，
  // 被這個篩選當成非本倉訂單擋掉，整張單在系統裡憑空消失，人員只好手動CSV貼進來再出。
  // 缺貨的單本質上還是文山的單，只是這一刻沒貨——它需要的是進到系統裡走缺貨不出／
  // 換貨／訂單修改的流程，而不是被丟掉。真正不屬於本倉的是山物出／中華宅配。
  return s === '文山' || s === '缺貨' || s.indexOf('調') === 0;
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
  const skippedByStatus = {};   // 訂單狀態 → 被擋掉的訂單號（去重），寫進系統紀錄用
  let skippedRows = 0, skippedOtherWarehouse = 0;
  for(let i = 1; i < values.length; i++){
    const row = values[i];
    const orderNo = String(row[iOrder]||'').trim();
    const sku = String(row[iSku]||'').trim();
    const qty = parseInt(row[iQty], 10);
    if(!orderNo || !sku || isNaN(qty)){ skippedRows++; continue; }
    if(iStatus >= 0 && !isHandledRoutingStatus_(row[iStatus])){
      const st = String(row[iStatus]||'').trim() || '(空白)';
      if(!skippedByStatus[st]) skippedByStatus[st] = [];
      if(skippedByStatus[st].indexOf(orderNo) < 0) skippedByStatus[st].push(orderNo);
      skippedOtherWarehouse++;
      continue;
    }
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

  // 被篩掉的訂單要留紀錄。這次就是因為沒有紀錄，才得從來源鏡像一路回推才知道
  // 「它被當成非本倉訂單擋掉了」。訂單號只留前20筆，避免一次寫進幾百筆把系統紀錄洗版。
  if(Object.keys(skippedByStatus).length){
    const summary = Object.keys(skippedByStatus).map(function(k){
      return k + ' ' + skippedByStatus[k].length + ' 張';
    }).join('、');
    const sample = [];
    Object.keys(skippedByStatus).forEach(function(k){
      skippedByStatus[k].slice(0, 20).forEach(function(no){ sample.push(k + ':' + no); });
    });
    // 這裡要跟「被擋掉的訂單張數」比，不能跟 skippedOtherWarehouse 比——
    // 那是被擋掉的「資料列數」，一張單有幾個品項就有幾列，永遠大於張數，
    // 結果是明明全部列出來了卻標成「僅列部分」，看的人會以為還有沒顯示的單。
    const skippedOrderCount = Object.keys(skippedByStatus).reduce(function(n, k){
      return n + skippedByStatus[k].length;
    }, 0);
    appendSysLog_('同步略過非本倉訂單', '', '',
      summary + '　｜　' + sample.join('、') + (sample.length < skippedOrderCount ? '…（僅列部分）' : ''));
  }

  const result = mergeOrders(parsed);
  syncNativeOrderSheet_(); // 順便把核對結果同步回舊的核對表單
  syncLogisticsConfirm_(); // 以及物流籃確認狀態
  syncSpecialNotes_();     // 以及客服寫的特殊註記
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
// APP 寫進來的時間都是 toLocaleString('zh-TW') 的格式：「2026/8/13 下午1:35:47」。
// 要算耗時就得先解析回時間；下午要 +12 小時，但「下午12點」本身就是12點不能再加，
// 「上午12點」則是0點——這兩個邊界不處理的話會算出差12小時的耗時。
function parseTwDateTime_(str){
  const s = String(str||'').trim();
  if(!s) return null;
  const m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s*(上午|下午)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if(!m) return null;
  let hour = parseInt(m[5], 10);
  if(m[4] === '下午' && hour < 12) hour += 12;
  if(m[4] === '上午' && hour === 12) hour = 0;
  const d = new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10),
                     hour, parseInt(m[6],10), m[7] ? parseInt(m[7],10) : 0);
  return isNaN(d.getTime()) ? null : d;
}
function minutesBetween_(a, b){
  // 傳進來的可能是純文字，也可能是被試算表吃成日期型別的舊資料——
  // 先統一轉成「yyyy/M/d HH:mm:ss」再解析，不然舊資料一律算不出來。
  const d1 = parseTwDateTime_(cellToText(a, true)), d2 = parseTwDateTime_(cellToText(b, true));
  if(!d1 || !d2) return null;
  const mins = (d2 - d1) / 60000;
  // 負數或誇張的值多半是資料有問題（跨日、時間欄被改過），不要讓它污染平均
  return (mins < 0 || mins > 24 * 60) ? null : mins;
}
function avg_(arr){
  const v = arr.filter(function(x){ return typeof x === 'number' && !isNaN(x); });
  return v.length ? Math.round(v.reduce(function(a,b){ return a+b; }, 0) / v.length * 10) / 10 : '';
}

// 當天的作業面 KPI。刻意從原始資料算，不從儀表板抓：
// 儀表板只有「現在」的樣子，而這些要的是「今天整天發生了什麼」，
// 而且出貨紀錄20:00就會被清空，錯過這個時間點就再也算不出來。
function computeDailyKpi_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd');
  const out = {};

  // ---- 出貨面：出貨紀錄是一列一品項，訂單層級欄位只填在第一列（需求件數>0） ----
  const logRows = readRows(SHEET_LOG, LOG_HEADER);
  const orderRows = logRows.filter(function(r){ return Number(r.requiredCount) > 0; });
  const durations = [], noBarcodeOrders = {};
  let perfect = 0, error = 0, manualEdit = 0;
  orderRows.forEach(function(r){
    const mins = minutesBetween_(r.startTime, r.time);
    if(mins !== null) durations.push(mins);
    const cr = String(r.checkResult||'');
    if(cr.indexOf('完成') === 0 && cr.indexOf('人工') < 0) perfect++;
    if(cr.indexOf('錯誤') === 0) error++;
    if(cr.indexOf('人工修正') >= 0) manualEdit++;
  });
  logRows.forEach(function(r){
    if(textToBool_(r.hadNoBarcodeConfirm)) noBarcodeOrders[r.orderNo] = true;
  });
  out['出貨張數'] = orderRows.length;
  out['出貨件數'] = logRows.reduce(function(n, r){ return n + (Number(r.scanned) || 0); }, 0);
  out['平均出貨耗時(分)'] = avg_(durations);
  out['最長出貨耗時(分)'] = durations.length ? Math.round(Math.max.apply(null, durations) * 10) / 10 : '';
  out['一次到位張數'] = perfect;
  out['一次到位率(%)'] = orderRows.length ? Math.round(perfect / orderRows.length * 1000) / 10 : '';
  out['錯誤張數'] = error;
  out['人工修正張數'] = manualEdit;
  out['無條碼核對張數'] = Object.keys(noBarcodeOrders).length;
  out['出貨人數'] = Object.keys(orderRows.reduce(function(m, r){
    if(String(r.staffName||'').trim()) m[r.staffName] = 1; return m;
  }, {})).length;

  // ---- 揀貨面：揀貨紀錄是累積的，要自己篩今天 ----
  // 不能用字串前綴比日期：揀貨紀錄的時間來自APP的 toLocaleString('zh-TW')，
  // 寫出來是「2026/8/13」不補零，而 today 是「2026/08/13」——直接比會全部對不到，
  // 結果是揀貨面的KPI整排0，看起來像沒人揀貨（第一次跑就踩到）。
  // 解析成日期再格式化，兩種寫法都吃得到。
  const pickRows = readRows(SHEET_PICKLOG, PICKLOG_HEADER).filter(function(r){
    const d = parseTwDateTime_(r.logTime);
    return d && Utilities.formatDate(d, tz, 'yyyy/MM/dd') === today;
  });
  const pickers = {}, doneOrders = {};
  let pickWs = 0, pickTr = 0, cancel = 0;
  const firstPickAt = {};
  pickRows.forEach(function(r){
    const act = String(r.action||'');
    if(act === '揀貨'){
      if(String(r.kind||'') === '調撥') pickTr++; else pickWs++;
      if(String(r.pickerName||'').trim()) pickers[r.pickerName] = 1;
      const t = String(r.logTime||'');
      if(!firstPickAt[r.orderNo] || t < firstPickAt[r.orderNo]) firstPickAt[r.orderNo] = t;
    } else if(act === '取消揀貨'){ cancel++; }
    else if(act === '揀貨完成'){ doneOrders[r.orderNo] = String(r.logTime||''); }
  });
  out['揀貨件數-文山'] = pickWs;
  out['揀貨件數-調撥調入'] = pickTr;
  out['取消揀貨次數'] = cancel;
  out['揀貨人數'] = Object.keys(pickers).length;
  out['揀貨完成張數'] = Object.keys(doneOrders).length;
  // 一張單從第一件被揀到按下「揀好了」的時間
  const pickSpans = Object.keys(doneOrders).map(function(no){
    return firstPickAt[no] ? minutesBetween_(firstPickAt[no], doneOrders[no]) : null;
  });
  out['平均揀貨耗時(分)'] = avg_(pickSpans);

  // ---- 時間軸：一張單走完各段各花多久 ----
  // 讀訂單分頁自己的里程碑欄位，不用再去翻揀貨紀錄／出貨紀錄。
  // 只看「今天出貨完成」的單：跨日的單如果照進單時間歸日，會把昨天的工作算到今天頭上。
  // 變數名不能叫 orderRows：同一個函式上面已經有一個「出貨紀錄的訂單層級列」用了這個名字，
  // 重複宣告會整支腳本掛掉。這裡讀的是「訂單分頁」，命名上也該分開。
  const orderTimeline = readOrderRows();
  const stage = {進單到開始揀:[], 開始揀到揀完:[], 揀完到開始掃:[], 掃描耗時:[], 進單到出貨:[]};
  let sameDay = 0;
  orderTimeline.forEach(function(r){
    const done = String(r.shipDoneAt||'').trim();
    if(!done) return;
    const d = parseTwDateTime_(done);
    if(!d || Utilities.formatDate(d, tz, 'yyyy/MM/dd') !== today) return;
    sameDay++;
    const push = function(key, a, b){
      const m = minutesBetween_(a, b);
      if(m !== null) stage[key].push(m);
    };
    push('進單到開始揀', r.createdAt, r.pickStartAt);
    push('開始揀到揀完', r.pickStartAt, r.pickDoneAt);
    push('揀完到開始掃', r.pickDoneAt, r.shipStartAt);
    push('掃描耗時', r.shipStartAt, done);
    push('進單到出貨', r.createdAt, done);
  });
  out['今日完成且有時間軸的張數'] = sameDay;
  Object.keys(stage).forEach(function(k){ out['平均' + k + '(分)'] = avg_(stage[k]); });

  // ---- 銜接面：揀完之後隔多久才出貨（包貨端塞不塞車） ----
  const shipTimeByOrder = {};
  orderRows.forEach(function(r){ shipTimeByOrder[r.orderNo] = String(r.time||''); });
  const waits = Object.keys(doneOrders).map(function(no){
    return shipTimeByOrder[no] ? minutesBetween_(doneOrders[no], shipTimeByOrder[no]) : null;
  });
  out['揀完到出貨平均等待(分)'] = avg_(waits);
  return out;
}

// hadNoBarcodeConfirm 存的是「是 🟠 / 否」這種顯示字，不是布林
function textToBool_(v){
  const s = String(v||'').trim();
  return s.indexOf('是') === 0 || s === 'TRUE' || s === 'true';
}

// ================= KPI 統計（日／月／年） =================
// 每日統計是一天一列的原始資料，人不會想從幾百列裡自己算月平均。
// 這張表把它彙總成三段：最近30天、各月、各年。
//
// 用公式而不是把算好的數字寫死：每天20:00多一列，公式隔天自己更新，
// 寫死的話得每天重跑一次彙總，漏跑一次就變成過期的數字掛在那裡沒人發現。
//
// 比率一律「先加總再相除」，不能拿每天的比率去平均——
// 出3張的那天跟出300張的那天權重會變成一樣，算出來的月一次到位率是錯的。
const SHEET_KPI = 'KPI統計';

// 欄位letter在建表當下依「每日統計」的表頭算出來，不寫死。
// 之後KPI欄位增減時重跑一次 setupKpiSheet_ 就好；沒重跑的話公式會指到別欄，
// 所以這裡也把當時的欄位名稱寫在表上，對不上時看得出來。
function colLetter2_(n){
  let out = '';
  while(n > 0){ const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = (n - 1 - r) / 26; }
  return out;
}

function setupKpiSheet_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const src = ss.getSheetByName(SHEET_DAILY_STATS);
  if(!src) return {ok:false, error:'還沒有「' + SHEET_DAILY_STATS + '」分頁，請先執行 appendDailyStats_'};
  const header = src.getRange(1, 1, 1, src.getLastColumn()).getDisplayValues()[0]
                    .map(function(x){ return String(x||'').trim(); });
  const col = function(name){
    const i = header.indexOf(name);
    return i < 0 ? null : colLetter2_(i + 1);
  };
  const D = "'" + SHEET_DAILY_STATS + "'";
  const need = ['出貨張數','出貨件數','一次到位張數','錯誤張數','人工修正張數','無條碼核對張數',
                '平均出貨耗時(分)','出貨人數','揀貨件數-文山','揀貨件數-調撥調入','取消揀貨次數',
                '揀貨人數','揀貨完成張數','平均揀貨耗時(分)','揀完到出貨平均等待(分)','新進訂單',
                '今日完成且有時間軸的張數','平均進單到開始揀(分)','平均開始揀到揀完(分)',
                '平均揀完到開始掃(分)','平均掃描耗時(分)','平均進單到出貨(分)'];
  const missing = need.filter(function(n){ return !col(n); });
  if(missing.length) return {ok:false, error:'每日統計缺少欄位：' + missing.join('、')};

  let sh = ss.getSheetByName(SHEET_KPI);
  if(!sh) sh = ss.insertSheet(SHEET_KPI);
  sh.clear();
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();

  // 每一列＝一個指標，欄位＝各期間。用 SUMPRODUCT 對日期字串取年月，
  // 日期欄存的是文字（yyyy/MM/dd），LEFT 取前7碼就是年月、前4碼就是年。
  const dateCol = col('日期');
  const rows = [
    ['訂單量', ''],
    ['新進訂單', 'sum:' + col('新進訂單')],
    ['出貨張數', 'sum:' + col('出貨張數')],
    ['出貨件數', 'sum:' + col('出貨件數')],
    ['出貨品質', ''],
    ['一次到位率(%)', 'rate:' + col('一次到位張數') + ':' + col('出貨張數')],
    ['錯誤率(%)', 'rate:' + col('錯誤張數') + ':' + col('出貨張數')],
    ['人工修正張數', 'sum:' + col('人工修正張數')],
    ['無條碼核對張數', 'sum:' + col('無條碼核對張數')],
    ['效率', ''],
    ['平均出貨耗時(分)', 'wavg:' + col('平均出貨耗時(分)') + ':' + col('出貨張數')],
    ['每人每日出貨張數', 'ratio:' + col('出貨張數') + ':' + col('出貨人數')],
    ['揀貨', ''],
    ['揀貨件數-文山', 'sum:' + col('揀貨件數-文山')],
    ['揀貨件數-調撥調入', 'sum:' + col('揀貨件數-調撥調入')],
    ['取消揀貨次數', 'sum:' + col('取消揀貨次數')],
    ['揀貨完成張數', 'sum:' + col('揀貨完成張數')],
    ['平均揀貨耗時(分)', 'wavg:' + col('平均揀貨耗時(分)') + ':' + col('揀貨完成張數')],
    ['揀完到出貨平均等待(分)', 'wavg:' + col('揀完到出貨平均等待(分)') + ':' + col('揀貨完成張數')],
    ['時間軸（平均分鐘）', ''],
    ['進單→開始揀', 'wavg:' + col('平均進單到開始揀(分)') + ':' + col('今日完成且有時間軸的張數')],
    ['開始揀→揀完', 'wavg:' + col('平均開始揀到揀完(分)') + ':' + col('今日完成且有時間軸的張數')],
    ['揀完→開始掃', 'wavg:' + col('平均揀完到開始掃(分)') + ':' + col('今日完成且有時間軸的張數')],
    ['掃描耗時', 'wavg:' + col('平均掃描耗時(分)') + ':' + col('今日完成且有時間軸的張數')],
    ['進單→出貨（總前置）', 'wavg:' + col('平均進單到出貨(分)') + ':' + col('今日完成且有時間軸的張數')]
  ];

  // 期間定義：條件式直接寫在公式裡，日／月／年只差這一段
  const periods = [
    ['近7天', '(' + D + '!$' + dateCol + '$2:$' + dateCol + '<>"")*(IFERROR(DATEVALUE(' + D + '!$' + dateCol + '$2:$' + dateCol + '),0)>=TODAY()-6)'],
    ['近30天', '(' + D + '!$' + dateCol + '$2:$' + dateCol + '<>"")*(IFERROR(DATEVALUE(' + D + '!$' + dateCol + '$2:$' + dateCol + '),0)>=TODAY()-29)'],
    ['本月', 'EXACT(LEFT(' + D + '!$' + dateCol + '$2:$' + dateCol + ',7),TEXT(TODAY(),"yyyy/MM"))'],
    ['上月', 'EXACT(LEFT(' + D + '!$' + dateCol + '$2:$' + dateCol + ',7),TEXT(EOMONTH(TODAY(),-1),"yyyy/MM"))'],
    ['今年', 'EXACT(LEFT(' + D + '!$' + dateCol + '$2:$' + dateCol + ',4),TEXT(TODAY(),"yyyy"))'],
    ['累計', '(' + D + '!$' + dateCol + '$2:$' + dateCol + '<>"")']
  ];

  const rng = function(c){ return D + '!$' + c + '$2:$' + c; };
  const build = function(spec, cond){
    const parts = spec.split(':');
    if(parts[0] === 'sum') return '=IFERROR(SUMPRODUCT(' + cond + ',N(' + rng(parts[1]) + ')),0)';
    // rate=百分比（要×100），ratio=純比值（例如每人每日張數，×100就變成4300那種鬼數字）。
    // 先前是用「spec字串裡有沒有『每人』」判斷，但spec裡只有欄位letter、永遠沒有那兩個字，
    // 所以一律當百分比處理——算出來看起來像個正常數字，只是大了100倍。
    if(parts[0] === 'rate' || parts[0] === 'ratio'){
      return '=IFERROR(ROUND(SUMPRODUCT(' + cond + ',N(' + rng(parts[1]) + '))'
        + '/SUMPRODUCT(' + cond + ',N(' + rng(parts[2]) + '))*'
        + (parts[0] === 'rate' ? '100' : '1') + ',1),"-")';
    }
    // 加權平均：用張數當權重。直接平均每日平均會讓小量的日子有一樣的份量。
    return '=IFERROR(ROUND(SUMPRODUCT(' + cond + ',N(' + rng(parts[1]) + '),N(' + rng(parts[2]) + '))'
      + '/SUMPRODUCT(' + cond + ',N(' + rng(parts[2]) + ')),1),"-")';
  };

  sh.getRange('A1').setValue('📊 揀貨・出貨 KPI（資料來源：每日統計，每天20:00寫入一列）');
  sh.getRange('A1:H1').merge().setFontSize(15).setFontWeight('bold')
    .setBackground('#1c4587').setFontColor('#ffffff');
  sh.getRange('A2').setFormula('="更新於 "&TEXT(NOW(),"yyyy/MM/dd HH:mm")&"　｜　每日統計目前 "&COUNTA(' + D + '!$' + dateCol + '$2:$' + dateCol + ')&" 天資料"');
  sh.getRange('A2:H2').merge().setFontColor('#666666');

  const headRow = 4;
  sh.getRange(headRow, 1).setValue('指標');
  periods.forEach(function(p, i){ sh.getRange(headRow, 2 + i).setValue(p[0]); });
  sh.getRange(headRow, 1, 1, periods.length + 1).setFontWeight('bold').setBackground('#f3f3f3');

  rows.forEach(function(r, ri) {
    const row = headRow + 1 + ri;
    sh.getRange(row, 1).setValue(r[0]);
    if(!r[1]){   // 分段標題
      sh.getRange(row, 1, 1, periods.length + 1).setBackground('#cfe2f3').setFontWeight('bold')
        .setFontColor('#1c4587');
      return;
    }
    if(r[1].indexOf('null') >= 0) return;   // 對照不到欄位就留白，不要寫出壞公式
    periods.forEach(function(p, pi){
      sh.getRange(row, 2 + pi).setFormula(build(r[1], p[1]));
    });
  });

  const lastRow = headRow + rows.length;
  sh.getRange(headRow + 1, 2, rows.length, periods.length).setHorizontalAlignment('center');
  sh.setColumnWidth(1, 200);
  for(let i = 0; i < periods.length; i++) sh.setColumnWidth(2 + i, 95);
  sh.setFrozenRows(headRow);
  // 不凍結欄：標題列是整列合併的（A1:H1），凍結第1欄等於把合併範圍切一半，
  // Google 會直接拒絕並讓整個重建失敗。指標名稱那一欄本來就在最左邊，不凍也看得到。

  const note = lastRow + 2;
  sh.getRange(note, 1, 1, periods.length + 1).merge();
  sh.getRange(note, 1).setValue([
    '比率一律「先加總再相除」，不是把每天的比率平均——出3張的那天跟出300張的那天權重不該一樣。',
    '平均耗時用張數加權，同理。',
    '「每日統計」每天20:00寫一列，所以歷史從導入這個功能的那天開始，之前的日子沒有資料。',
    '之後如果在「每日統計」增減欄位，要重跑一次 setupKpiSheet_，公式才會指到正確的欄。'
  ].join('\n')).setFontSize(10).setFontColor('#666666').setWrap(true).setVerticalAlignment('middle');
  sh.setRowHeight(note, 74);

  return {ok:true, 分頁: SHEET_KPI, 指標數: rows.filter(function(r){ return r[1]; }).length,
          期間: periods.map(function(p){ return p[0]; })};
}

// ---------------- 每日統計：把當天的儀表板數字留成一列 ----------------
// 儀表板只看得到「現在」。出貨紀錄每晚清空、來源鏡像每晚重置，所以今天的數字
// 過了20:30就永遠問不到了——想知道上週三出了幾張、品質如何，現在完全查不出來。
// 每天備份出貨紀錄的同時，把當天的儀表板數字追加一列，久了就是一張趨勢表。
//
// 取值方式刻意用「找標籤」而不是寫死儲存格位置：這張儀表板的版面今天就搬過兩次，
// 寫死列號的話搬完照抄還是會抄到，而且抄到的是別的指標的數字——不會報錯、只是靜靜地錯。
// 找不到標籤就留白，寧可少一格也不要填一個錯的數字進歷史紀錄。
const SHEET_DAILY_STATS = '每日統計';
// 標籤 → 這一欄在每日統計表裡的名稱。順序就是欄位順序。
const DAILY_STAT_FIELDS = [
  ['今日新進訂單', '新進訂單'],
  ['今日已出貨（張）', '已出貨(張)'],
  ['今日出貨（件）', '出貨(件)'],
  ['今日掃描品項列數', '掃描品項列數'],
  ['今日已進物流籃', '已進物流籃'],
  ['今日未進物流籃', '未進物流籃'],
  ['今日換貨待補正', '換貨待補正'],
  ['今日應出（單）', '應出(單)'],
  ['未出（單）-文山 ⚠含前期', '未出-文山(含前期)'],
  ['未出（單）-調撥 ⚠含前期', '未出-調撥(含前期)'],
  ['今日山物出（單）', '山物出(單)'],
  ['今日中華宅配（單）', '中華宅配(單)'],
  ['完成 🟢', '品質-完成'],
  ['錯誤 🔴', '品質-錯誤'],
  ['待核對 🔵', '品質-待核對'],
  ['人工修正數量', '品質-人工修正數量'],
  // 出貨總張數是從「出貨紀錄」算的，已出貨(張)是從「訂單」分頁算的，兩個來源不同。
  // 兩者通常相等，不等的時候差額是有意義的：出貨後才被標人工結案的訂單會算進前者、
  // 不算進後者（實例：260807QQ9EFPVJ 今天出貨後被標了「出貨完成」）。
  // 兩個都留著，之後看歷史才查得出哪一天有這種情況、差了幾張。
  ['出貨總張數', '出貨總張數(紀錄)'],
  ['待出貨', '收盤待出貨'],
  ['　└ 文山', '收盤待出貨-文山'],
  ['　└ 調撥（待調入）', '收盤待出貨-調撥'],
  ['　└ 缺貨', '收盤待出貨-缺貨'],
  ['掃描中', '收盤掃描中'],
  ['已進物流籃未結案', '已進物流籃未結案'],
  ['已揀完待包', '收盤已揀完待包']
];

// 掃描儀表板上「標籤在左、數字在右」的那幾組欄位，做成 標籤→值 的對照。
// 概況區(A/B)、當日數據(D/E)、出貨品質(G/H) 三組都是這個結構。
function readDashboardLabels_(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_DASHBOARD);
  if(!sh) return null;
  SpreadsheetApp.flush(); // 先讓公式算完，不然可能讀到上一次的值
  const rows = Math.min(sh.getLastRow(), 40);
  if(rows < 2) return null;
  const values = sh.getRange(1, 1, rows, 8).getDisplayValues();
  const map = {};
  values.forEach(function(row){
    [[0,1], [3,4], [6,7]].forEach(function(pair){
      const label = String(row[pair[0]]||'').trim();
      const value = String(row[pair[1]]||'').trim();
      if(label && value !== '' && map[label] === undefined) map[label] = value;
    });
  });
  return map;
}

function appendDailyStats_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const labels = readDashboardLabels_();
  if(!labels) return {ok:false, error:'讀不到儀表板'};
  const tz = ss.getSpreadsheetTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd');

  // 作業面KPI（出貨耗時、揀貨件數…）從原始資料算，儀表板上沒有這些數字。
  // 出貨紀錄20:00就清空，錯過就永遠算不出來，所以一定要在備份前算完。
  const kpi = computeDailyKpi_();
  const kpiKeys = Object.keys(kpi);
  const header = ['日期', '記錄時間']
    .concat(DAILY_STAT_FIELDS.map(function(f){ return f[1]; }))
    .concat(kpiKeys);

  let sh = ss.getSheetByName(SHEET_DAILY_STATS);
  if(!sh){
    sh = ss.insertSheet(SHEET_DAILY_STATS);
    sh.setFrozenRows(1);
    sh.setFrozenColumns(1);
    sh.setColumnWidth(1, 100); sh.setColumnWidth(2, 80);
  }
  // 表頭每次都重寫：之後增減KPI欄位時，舊表頭留著會讓新欄位對不上名稱。
  // 欄位只增不減、也不改順序，既有資料才不會錯位（跟訂單分頁同一個原則）。
  sh.getRange(1, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#f3f3f3');
  // 同一天重複執行就覆蓋那一列，不要多寫一列——手動補跑或觸發器重試都可能發生，
  // 一天兩列會讓之後任何加總、平均都默默算錯。
  const lastRow = sh.getLastRow();
  const existing = lastRow >= 2
    ? sh.getRange(2, 1, lastRow - 1, 1).getDisplayValues().map(function(r){ return String(r[0]||'').trim(); })
    : [];
  const hitIdx = existing.indexOf(today);
  const targetRow = hitIdx >= 0 ? hitIdx + 2 : lastRow + 1;

  const missing = [];
  const row = [today, Utilities.formatDate(new Date(), tz, 'HH:mm')].concat(
    DAILY_STAT_FIELDS.map(function(f){
      // 標籤兩邊都要用同一套 trim 再比：儀表板上的子項目是用全形空格縮排的
      // （「　└ 文山」），而 JS 的 trim() 會把全形空格也吃掉，
      // 兩邊不一致就會三個子項目全部抓不到值——第一次跑就踩到了。
      const v = labels[f[0].trim()];
      if(v === undefined){ missing.push(f[0]); return ''; }
      const n = Number(String(v).replace(/,/g, ''));
      return isNaN(n) ? v : n;   // 數字就存成數字，之後才畫得出圖
    })
  ).concat(kpiKeys.map(function(k){ return kpi[k]; }));
  sh.getRange(targetRow, 1, 1, row.length).setValues([row]);
  sh.getRange(targetRow, 1).setNumberFormat('@');
  return {ok:true, 日期: today, 覆蓋既有列: hitIdx >= 0, 列: targetRow,
          找不到的標籤: missing, KPI: kpi};
}

function backupAndClearShippingLog_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_LOG);
  if(!sh){ Logger.log('找不到「出貨紀錄」分頁'); return; }
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if(lastRow < 2){ Logger.log('出貨紀錄目前沒有資料，略過備份與清空'); return; }

  // 順序很重要：一定要在清空出貨紀錄「之前」把當天數字記下來。
  // 本日出貨張數/件數/品質分佈全都是從出貨紀錄算的，清掉之後這些數字就永遠回不來了。
  // 包在 try 裡：統計失敗不該連帶讓備份跟清空也不做，那會讓明天的資料疊在今天的上面。
  try{
    const stats = appendDailyStats_();
    Logger.log('每日統計：' + JSON.stringify(stats));
  }catch(err){
    Logger.log('每日統計寫入失敗（不影響備份）：' + err);
    try{ appendSysLog_('每日統計寫入失敗', '', '', String(err)); }catch(e){}
  }

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
  // 備份檔另開一頁放當天的儀表板數字：光看幾百列出貨明細看不出「這天整體如何」，
  // 而備份檔常常是事後唯一還留著的東西。
  try{
    const labels = readDashboardLabels_();
    if(labels){
      const statSh = backupSs.insertSheet('當日儀表板');
      const rows = [['指標', '數值']].concat(
        DAILY_STAT_FIELDS.map(function(f){
          const v = labels[f[0].trim()];
          return [f[1], v === undefined ? '' : v];
        })
      );
      statSh.getRange(1, 1, rows.length, 2).setValues(rows);
      statSh.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#f3f3f3');
      statSh.setColumnWidth(1, 200);
    }
  }catch(err){
    Logger.log('備份檔的儀表板頁寫入失敗（不影響出貨紀錄備份）：' + err);
  }
  const backupFile = DriveApp.getFileById(backupSs.getId());
  folder.addFile(backupFile);
  DriveApp.getRootFolder().removeFile(backupFile); // 只留在指定資料夾，不要同時出現在雲端硬碟根目錄

  sh.getRange(2, 1, lastRow - 1, lastCol).clearContent(); // 只清內容，條件式格式規則不會被清掉，明天新資料一樣自動套色
  Logger.log('已備份 '+(allValues.length-1)+' 列出貨紀錄到「'+fileName+'」，並清空出貨紀錄分頁準備明天使用。');
}

// ---------------- 每天的收尾維護 ----------------
// 訂單狀態會變：今天匯入時是「文山」的單，之後可能被改成山物出／中華宅配。
// 篩選只擋新進來的，已經在我們系統裡的不會被擋掉，所以那些單會一直留在待出貨清單，
// 而那些貨根本不在文山，揀貨員看得到卻永遠找不到。之前就這樣累積了38張、最久的卡了三天。
//
// 所以每天收尾時自動結案一次。刻意排在晚上而不是每次同步就做：
// 訂單狀態白天可能來回變動，給它一整天的時間穩定下來再處理，不要一變就立刻結案。
// 每一筆都會寫進系統紀錄，可以回溯。
function dailyMaintenance_(){
  const closed = batchCloseOtherWarehouseOrders_();
  const archived = archiveShippedOrders_();
  Logger.log('每日維護完成：' + JSON.stringify({自動結案: closed, 歸檔: archived}));
  return {自動結案: closed, 歸檔: archived};
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
  const M = "'文山出貨V2'"; // 來源鏡像：算「今天該出多少」要用它（我們的訂單分頁是累計的，不是當日）
  const SY = "'" + SHEET_SYSLOG + "'"; // 系統紀錄：人工修改訂單的紀錄從這裡撈

  // ---- 標題 ----
  sh.getRange('A1').setValue('文山出貨　即時儀表板');
  sh.getRange('A1:O1').merge().setFontSize(18).setFontWeight('bold')
    .setBackground('#1c4587').setFontColor('#ffffff').setHorizontalAlignment('center');
  sh.getRange('A2').setFormula(
    '="資料即時連動，開啟或來源異動時自動更新　｜　本頁最後計算時間："&TEXT(NOW(),"yyyy/MM/dd HH:mm:ss")'
  );
  sh.getRange('A2:O2').merge().setFontColor('#666666').setHorizontalAlignment('center');

  // APP 連結。用 HYPERLINK() 而不是 setValue 一段網址文字：
  // 網址本身又長又醜，而且貼進儲存格後 Google 不一定會自動轉成可點的連結。
  // 兩個都放：正式網頁版是倉庫裝置在用的，Drive副本是網路連不到 GitHub 時的備援。
  sh.getRange('A3').setFormula(`=HYPERLINK("${APP_WEB_URL}","📱 開啟出貨確認APP（網頁版）")`);
  sh.getRange('A3:E3').merge().setFontSize(12).setFontWeight('bold')
    .setBackground('#e8f0fe').setVerticalAlignment('middle');
  sh.getRange('G3').setFormula(`=HYPERLINK("${APP_DRIVE_URL}","📄 APP備份檔（雲端硬碟）")`);
  sh.getRange('G3:H3').merge().setFontSize(10).setFontColor('#666666').setVerticalAlignment('middle');
  // 同一份試算表內跳分頁：gid 在執行時查，不要寫死——分頁被刪掉重建後 gid 會變，
  // 寫死的話連結會靜靜指到一個不存在的分頁。查不到就整格留白，不要留一個壞連結。
  const amendSheet = ss.getSheetByName(SHEET_AMEND);
  if(amendSheet){
    const amendUrl = ss.getUrl() + '#gid=' + amendSheet.getSheetId();
    sh.getRange('J3').setFormula(`=HYPERLINK("${amendUrl}","✏️ 前往「訂單修改」分頁")`);
    sh.getRange('J3:M3').merge().setFontSize(10).setFontColor('#666666').setVerticalAlignment('middle');
  }
  sh.setRowHeight(3, 26);

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
  // 這一區只講「現在」——待處理的工作，以及它們卡在誰身上。
  // 累計數字（已出貨／人工結案／訂單總數）另外分一段並標明，不要跟現況混在一起：
  // 它們是「訂單分頁裡累積了多少列」，會一直長到歸檔才減少，跟現場狀況無關。
  // 早先這裡把「今天的」（來自鏡像的文山可出／需調撥）跟「累計的」（山物出貨）並排，
  // 看起來可以互相比較，實際上時間範圍不同，是錯的。現在全部改用同一個來源、同一個時間範圍。
  sectionTitle('A4:B4', '📦 訂單即時概況（現在）');
  const pendingBy = cond => `=COUNTIFS(${O}!$G$2:$G,"待出貨*",${O}!$M$2:$M,""${cond})`;
  const orderStats = [
    ['待出貨', pendingBy('')],
    ['　└ 文山', pendingBy(`,${O}!$L$2:$L,"文山"`)],
    ['　└ 調撥（待調入）', pendingBy(`,${O}!$L$2:$L,"調*"`)],
    ['　└ 缺貨', pendingBy(`,${O}!$L$2:$L,"缺貨"`)],
    // 用相減補齊，確保三個細項加起來一定等於待出貨總數。
    // 細項湊不齊總數（實測差過1張，是訂單狀態空白的）會讓人整個不信任這張表，
    // 而且那一張反而是最該被看到的——狀態空白代表來源資料有問題。
    ['　└ 其他', '=MAX(0,$B$5-$B$6-$B$7-$B$8)'],
    // 揀完了但還沒開始掃描出貨的張數＝現在躺在包貨區等人包的量。
    // 這個數字持續變大就是包貨端塞住了，光看「待出貨」看不出來是揀不動還是包不動。
    // 欄位letter是照 ORDERS_HEADER 的順序數出來的：pickDoneAt 是第19個＝S欄。
    // （寫這行時先數成R欄，那是 itemsOverrideJson——這種錯不會報錯，只會算出一個看起來合理的數字。）
    ['已揀完待包', `=COUNTIFS(${O}!$G$2:$G,"待出貨*",${O}!$M$2:$M,"",${O}!$S$2:$S,"<>")`],
    ['掃描中', `=COUNTIFS(${O}!$G$2:$G,"掃描中*",${O}!$M$2:$M,"")`],
    // 看門狗：正常應該一直是0。有數字代表有人用舊流程包貨（掃了物流籃但沒走本系統），
    // 每小時的自動結案會把它清掉，所以看到非0多半是剛發生、還沒輪到下一次同步。
    ['已進物流籃未結案', `=COUNTIFS(${O}!$G$2:$G,"待出貨*",${O}!$M$2:$M,"",${O}!$N$2:$N,"已進*")`],
    ['待人工結案', `=COUNTIFS(${O}!$L$2:$L,"山物出",${O}!$M$2:$M,"")+COUNTIFS(${O}!$L$2:$L,"中華宅配",${O}!$M$2:$M,"")`],
    ['── 累計（未歸檔）──', ''],
    ['已出貨', `=COUNTIFS(${O}!$G$2:$G,"已出貨*",${O}!$M$2:$M,"")`],
    ['人工結案', `=COUNTA(${O}!$M$2:$M)`],
    ['訂單總數', `=COUNTA(${O}!$A$2:$A)`],
    // 累計數字要能自己說明「累計了多久」，不然看到566只會覺得「很多」，
    // 不知道那是三天還是三個月的量，也不知道什麼時候會降下來。
    // 訂單日期存的是「2026/8/5」這種純文字（欄位刻意設成文字格式避免被轉成日期型別），
    // 所以要先 DATEVALUE 轉回日期才能取最小／最大值。
    ['訂單日期範圍',
      `=IFERROR(TEXT(MIN(ARRAYFORMULA(IFERROR(DATEVALUE(${O}!$C$2:$C)))),"M/d")&" ~ "&`
      + `TEXT(MAX(ARRAYFORMULA(IFERROR(DATEVALUE(${O}!$C$2:$C)))),"M/d"),"-")`],
    // 只算「已出貨滿7天」這一個條件。實際歸檔還要求「來源已無此單」，那要比對鏡像、
    // 公式算起來慢又容易跟真正的歸檔邏輯對不起來，所以這裡只講得出口的那一半，
    // 完整規則寫在下面那行說明，不要讓人以為這個數字就是下次會被移走的量。
    ['已出貨滿7天',
      `=SUMPRODUCT((LEFT(${O}!$G$2:$G,3)="已出貨")*(IFERROR(INT(DATEVALUE(LEFT(${O}!$J$2:$J,10))`
      + `+TIMEVALUE(MID(${O}!$J$2:$J,12,8))+8/24)<=TODAY()-7,0)))`]
  ];
  orderStats.forEach((r, i)=>{
    sh.getRange(5+i, 1).setValue(r[0]);
    sh.getRange(5+i, 2).setFormula(r[1]);
  });

  // 歸檔規則寫在數字旁邊，不要只留在程式碼註解裡——
  // 看儀表板的人才是需要知道「這些數字什麼時候會降下來」的人。
  // 列號用 orderStats 的長度算出來，不要寫死：先前寫死 A16，後來概況區多了兩列，
  // 這行就蓋掉了「訂單日期範圍」那一格，而且畫面上看起來只是少一列，很難察覺。
  const ruleRow = 5 + orderStats.length;
  // 明確擋一次：說明列一旦長到下半部的起始列（24），就會把區塊標題整個蓋掉，
  // 而且不會有任何錯誤訊息。寧可在這裡直接失敗，也不要產出一張看起來正常的壞儀表板。
  if(ruleRow >= 22) throw new Error('概況區項目太多（'+orderStats.length+'項），說明列會蓋到第22列的各賣場區塊，請先把下面的區塊往下移');
  sh.getRange(ruleRow, 1, 1, 2).merge();
  sh.getRange(ruleRow, 1).setValue([
      '⚠ 上半部（待出貨／掃描中／待人工結案）是「現在」的待處理量，含前幾天累積下來的，不是今天的量。',
      '歸檔規則：每天 19:30；已出貨滿 7 天且來源已無此單才移出'
    ].join('\n'))
    .setFontSize(10).setFontColor('#666666').setWrap(true).setVerticalAlignment('middle');
  sh.setRowHeight(ruleRow, 46);

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

  // ---- 2b. 本日揀貨品質（G11:H16）----
  // 跟出貨品質同一欄、擺在它下面：兩個都是「今天做得好不好」，看的人視線不用跳。
  // 揀貨紀錄是累積的（不像出貨紀錄每晚清空），所以每一條都要自己篩今天。
  // 日期比對用 LEFT(...,10) 會踩到「2026/8/13」不補零的問題，改用 TEXT(DATEVALUE(...)) 正規化。
  const PL = "'" + SHEET_PICKLOG + "'";
  const plToday = `(IFERROR(INT(DATEVALUE(LEFT(${PL}!$A$2:$A,10)))=TODAY(),0))`;
  const plDone = `(${PL}!$I$2:$I="揀貨完成")`;
  sectionTitle('G11:H11', '🧺 本日揀貨品質');
  const pickStats = [
    ['完成 🟢', `=SUMPRODUCT(${plToday}*${plDone}*(LEFT(${PL}!$K$2:$K,2)="完成")*(ISERROR(SEARCH("修正",${PL}!$K$2:$K))))`],
    ['過程有修正 🟠', `=SUMPRODUCT(${plToday}*${plDone}*(ISNUMBER(SEARCH("修正",${PL}!$K$2:$K))))`],
    ['待調入 🟠', `=SUMPRODUCT(${plToday}*${plDone}*(LEFT(${PL}!$K$2:$K,3)="待調入"))`],
    ['漏點完成 🔴', `=SUMPRODUCT(${plToday}*${plDone}*(LEFT(${PL}!$K$2:$K,4)="漏點完成"))`],
    ['揀貨完成張數', `=SUMPRODUCT(${plToday}*${plDone})`]
  ];
  pickStats.forEach(function(r, i){
    sh.getRange(12 + i, 7).setValue(r[0]);
    sh.getRange(12 + i, 8).setFormula(r[1]);
  });
  sh.getRange('H12:H16').setFontSize(14).setFontWeight('bold').setHorizontalAlignment('center');

  // ---- 2c. 本日需注意的揀貨紀錄（V4起）----
  // 放在最右邊獨立一區：Q~T 是「需注意的出貨紀錄」的續接區、會往下長，
  // 兩個都無上限的區塊不能放同一欄。
  const V = 22; // V欄
  sectionTitle('V4:Y4', '⚠️ 本日需注意的揀貨紀錄');
  sh.getRange(5, V, 1, 4).setValues([['訂單號','揀貨人','揀貨結果','差異明細']])
    .setFontWeight('bold').setBackground('#f3f3f3');
  sh.getRange(6, V).setFormula(
    `=IFERROR(FILTER({${PL}!$B$2:$B,${PL}!$H$2:$H,${PL}!$K$2:$K,${PL}!$L$2:$L},`
    + `${PL}!$I$2:$I="揀貨完成",` + plToday.slice(1, -1) + `,`
    // 結果欄空白的是這個功能上線前留下的舊紀錄，不是「有問題」——
    // 不排除的話它們會因為「開頭不是完成」而全部被當成需注意，把真正要看的淹掉。
    + `${PL}!$K$2:$K<>"",`
    + `(LEFT(${PL}!$K$2:$K,2)<>"完成")+(ISNUMBER(SEARCH("修正",${PL}!$K$2:$K)))),"目前沒有需要注意的揀貨紀錄")`
  );
  sh.setColumnWidth(21, 24);                       // U：跟左邊的區塊隔開
  sh.setColumnWidth(22, 105); sh.setColumnWidth(23, 85);
  sh.setColumnWidth(24, 150); sh.setColumnWidth(25, 320);

  // ---- 3. 各賣場（第22列起，橫跨A~H）----
  // 位置：擺在上面三個區塊的下面、「目前掃描中」的上面，讓由上往下讀的順序是
  // 「整體概況 → 當日數據／品質 → 各賣場分解 → 現在誰在做什麼」。
  // 欄位配置要注意：A~H 之間夾著兩根24px的間隔欄（C、F，是上面三個區塊之間的視覺留白），
  // 所以六個資料欄放在 A/B/D/E/G/H，那兩根間隔欄剛好變成表格裡的分隔空白。
  // 用 UNIQUE+FILTER 抓出賣場，不寫死名稱，之後多了新品牌會自己出現。
  const SB = 22;                         // 區塊起始列
  const SC = ['A','B','D','E','G','H'];  // 六個資料欄（跳過間隔欄C、F）
  const SROWS = 8;                       // 最多列8個賣場
  const sr = function(i){ return SB + 2 + i; };
  sectionTitle('A'+SB+':H'+SB, '🏪 各賣場');
  sh.getRange('A'+(SB+1)+':H'+(SB+1)).setFontWeight('bold').setBackground('#f3f3f3');
  ['賣場','今日訂單','今日已出','待出貨','　└ 今日','　└ 前期'].forEach(function(t, i){
    sh.getRange(SC[i]+(SB+1)).setValue(t);
  });

  const today = 'TEXT(TODAY(),"yyyy/M/d")';
  const shippedToday = `(IFERROR(INT(DATEVALUE(LEFT(${O}!$J$2:$J,10))+TIMEVALUE(MID(${O}!$J$2:$J,12,8))+8/24)=TODAY(),0))`;
  // 賣場欄可能是空的（實際發生過：有訂單同步進來時來源就沒填賣場／日期）。
  // 空白如果直接進清單，那一列會被下面的 IF($A="") 判成「沒有這個賣場」而整列消失，
  // 結果就是各賣場加總比概況區的待出貨少，而且少的那幾張完全看不見。
  // 這裡把空白換成「（未指定）」讓它現形，統計時再換回空字串去比對。
  //
  // 清單的來源條件必須涵蓋這一區會呈現的每一種數字，否則欄位會憑空少算：
  // 只用「有待出貨」抓賣場的話，某個賣場今天出完、待出貨歸零，它就整列消失，
  // 連帶它今天出的那幾張也從表上不見了——合計對不起來但看不出是誰的。（實際發生過。）
  // 所以：現在有待出貨 或 今天有新訂單 或 今天有出貨，三者任一就要列出來。
  // 條件相加後用 >0 轉回布林，FILTER 只接受布林/0-1，相加得到的 2 不能直接餵進去。
  sh.getRange('A'+sr(0)).setFormula(
    `=ARRAY_CONSTRAIN(IFERROR(UNIQUE(FILTER(ARRAYFORMULA(IF(${O}!$B$2:$B="","（未指定）",${O}!$B$2:$B)),`
    + `ARRAYFORMULA(((LEFT(${O}!$G$2:$G,3)="待出貨")*(${O}!$M$2:$M="")`
    + `+(${O}!$C$2:$C=${today})`
    + `+(LEFT(${O}!$G$2:$G,3)="已出貨")*(${O}!$M$2:$M="")*${shippedToday})>0))),"（無）"),${SROWS},1)`
  );
  // 逐列寫，不用 ARRAYFORMULA 包 SUMPRODUCT——後者在陣列展開時不會逐列broadcast，
  // 會整欄算出同一個值，是很容易忽略的錯。
  // 欄位順序照作業流程讀：今天進來多少 → 出了多少 → 還剩多少。
  // 注意「待出貨」是含前幾天累積的，不等於「今日訂單－今日已出」——
  // 這三個數字之間不該硬湊等式，各自回答不同問題。
  const storeCri = function(row){ return `IF($A${row}="（未指定）","",$A${row})`; };
  for(let i = 0; i < SROWS; i++){
    const row = sr(i);
    const guard = `IF($A${row}="",""`;
    // 今日訂單：訂單日期是今天的（日期欄存純文字，直接跟 TEXT(TODAY()) 比字串）
    sh.getRange(SC[1]+row).setFormula(
      `=${guard},COUNTIFS(${O}!$B$2:$B,${storeCri(row)},${O}!$C$2:$C,${today}))`
    );
    // 今日已出：出貨完成時間換算台灣時間是今天的
    sh.getRange(SC[2]+row).setFormula(
      `=${guard},SUMPRODUCT((${O}!$B$2:$B=${storeCri(row)})*(LEFT(${O}!$G$2:$G,3)="已出貨")*(${O}!$M$2:$M="")`
      + `*${shippedToday}))`
    );
    // 待出貨：現在還沒出的（含前幾天累積）
    sh.getRange(SC[3]+row).setFormula(
      `=${guard},COUNTIFS(${O}!$B$2:$B,${storeCri(row)},${O}!$G$2:$G,"待出貨*",${O}!$M$2:$M,""))`
    );
    // 待出貨再拆成「今日進來的」與「前期累積的」，兩個數字相加要等於左邊的待出貨，
    // 對不起來就是資料有問題——這一欄的作用就是讓人一眼查得出來。
    sh.getRange(SC[4]+row).setFormula(
      `=${guard},COUNTIFS(${O}!$B$2:$B,${storeCri(row)},${O}!$G$2:$G,"待出貨*",${O}!$M$2:$M,"",${O}!$C$2:$C,${today}))`
    );
    // 前期刻意用 SUMPRODUCT 而不是 COUNTIFS 的 "<>今天"：
    // COUNTIFS 的不等於條件會把空白日期整個排除掉，日期一旦缺漏，今日+前期就會小於待出貨總數，
    // 反而讓查驗用的欄位自己先失準。SUMPRODUCT 下空白≠今天成立，會被歸進前期（當成舊單），
    // 兩欄相加才保證等於總數。
    sh.getRange(SC[5]+row).setFormula(
      `=${guard},SUMPRODUCT((${O}!$B$2:$B=${storeCri(row)})*(LEFT(${O}!$G$2:$G,3)="待出貨")*(${O}!$M$2:$M="")`
      + `*(${O}!$C$2:$C<>${today})))`
    );
  }
  sh.getRange(SC[4]+sr(0)+':'+SC[5]+sr(SROWS-1)).setFontColor('#666666');

  // 合計列刻意不用 SUM()——那樣只是把上面幾列再抄一次，上面漏掉什麼它就跟著漏掉什麼。
  // 這裡改成各自對整張訂單分頁重算，於是它跟明細的差額就代表「有訂單沒被列進來」
  // （賣場超過8個被截斷，或出現預期外的賣場值），數字自己會把問題講出來。
  // 待出貨的合計也應該等於上面概況區的「待出貨」，兩區對不起來就是有一邊算錯。
  const tot = SB + 2 + SROWS;
  sh.getRange(SC[0]+tot).setValue('合計（全表）');
  sh.getRange(SC[1]+tot).setFormula(`=COUNTIF(${O}!$C$2:$C,${today})`);
  sh.getRange(SC[2]+tot).setFormula(
    `=SUMPRODUCT((LEFT(${O}!$G$2:$G,3)="已出貨")*(${O}!$M$2:$M="")*${shippedToday})`
  );
  sh.getRange(SC[3]+tot).setFormula(`=COUNTIFS(${O}!$G$2:$G,"待出貨*",${O}!$M$2:$M,"")`);
  sh.getRange(SC[4]+tot).setFormula(`=COUNTIFS(${O}!$G$2:$G,"待出貨*",${O}!$M$2:$M,"",${O}!$C$2:$C,${today})`);
  sh.getRange(SC[5]+tot).setFormula(
    `=SUMPRODUCT((LEFT(${O}!$G$2:$G,3)="待出貨")*(${O}!$M$2:$M="")*(${O}!$C$2:$C<>${today}))`
  );
  sh.getRange('A'+tot+':H'+tot).setFontWeight('bold')
    .setBorder(true, null, null, null, null, null, '#999999', SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange(SC[4]+tot+':'+SC[5]+tot).setFontColor('#666666');
  const snote = tot + 1;
  sh.getRange('A'+snote+':H'+snote).merge();
  sh.getRange('A'+snote).setValue(
      '「待出貨」含前期累積，不等於「今日訂單－今日已出」；右邊兩欄就是它的今日／前期拆解。')
    .setFontSize(10).setFontColor('#666666').setWrap(true).setVerticalAlignment('middle');
  sh.setRowHeight(snote, 32);

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
    ['今日出貨（件）', `=SUM(${G}!$J$2:$J)`],
    ['今日掃描品項列數', `=COUNTA(${G}!$B$2:$B)`],
    ['今日已進物流籃',
      `=SUMPRODUCT((LEFT(${O}!$N$2:$N,5)="已進物流籃")*(${O}!$M$2:$M="")*(IFERROR(INT(DATEVALUE(LEFT(${O}!$J$2:$J,10))`
      + `+TIMEVALUE(MID(${O}!$J$2:$J,12,8))+8/24)=TODAY(),0)))`],
    ['今日未進物流籃', '=MAX(0,$E$6-$E$9)'],
    ['今日換貨待補正', `=COUNTIFS(${G}!$R$2:$R,">0",${G}!$U$2:$U,"換貨出貨*")`],
    // 今天該由我們出的訂單數：從鏡像算（來源每晚重置，整份就是當日的量）。
    // 不能再引用上面概況區的格子——那一區已經改成「現在的待處理」，不是「今天應出」。
    ['今日應出（單）',
      `=IF(SUMPRODUCT(--((${M}!$S$2:$S="文山")+(LEFT(${M}!$S$2:$S,1)="調")))=0,0,`
      + `COUNTA(UNIQUE(FILTER(${M}!$E$2:$E,(${M}!$S$2:$S="文山")+(LEFT(${M}!$S$2:$S,1)="調")))))`],
    // 未出再依出貨地拆開，看得出「還沒出的那些卡在誰身上」。
    // 這兩項刻意不叫「今日未出」——公式裡沒有任何日期條件，算的是「現在所有還沒出的」，
    // 含前幾天累積下來的。原本掛著「今日」兩個字擺在當日數據區裡，會被讀成今天的量
    // （實際查過：文山12張裡有6張是5天前的），標籤跟數字對不起來比沒有這個數字更糟。
    ['未出（單）-文山 ⚠含前期', `=COUNTIFS(${O}!$G$2:$G,"待出貨*",${O}!$L$2:$L,"文山",${O}!$M$2:$M,"")`],
    ['未出（單）-調撥 ⚠含前期', `=COUNTIFS(${O}!$G$2:$G,"待出貨*",${O}!$L$2:$L,"調*",${O}!$M$2:$M,"")`],
    // 山物出／中華宅配改從鏡像算，不能再從我們的「訂單」分頁算：
    // 訂單匯入是照「文山＋調撥」篩選的，那兩種狀態的訂單根本不會進來，
    // 分頁裡僅存的38張是加篩選以前的舊資料、而且都已經結案，公式永遠回0。
    // 一個永遠是0的數字比沒有更糟——它看起來像「今天對方沒有單」，其實是量不到。
    // 鏡像是來源當日全量（每晚重置），這兩個數字才真的是今天的。
    ['今日山物出（單）',
      `=IF(SUMPRODUCT(--(${M}!$S$2:$S="山物出"))=0,0,`
      + `COUNTA(UNIQUE(FILTER(${M}!$E$2:$E,${M}!$S$2:$S="山物出"))))`],
    ['今日中華宅配（單）',
      `=IF(SUMPRODUCT(--(${M}!$S$2:$S="中華宅配"))=0,0,`
      + `COUNTA(UNIQUE(FILTER(${M}!$E$2:$E,${M}!$S$2:$S="中華宅配"))))`]
  ];
  todayStats.forEach((r, i)=>{
    sh.getRange(5+i, 4).setValue(r[0]);
    sh.getRange(5+i, 5).setFormula(r[1]);
  });
  // 備註列跟著項目數量走，之後增減項目不用回頭改列號（先前寫死列號害說明被蓋掉過一次）
  const todayNoteRow = 5 + todayStats.length;
  sh.getRange(todayNoteRow, 4, 1, 2).merge();
  sh.getRange(todayNoteRow, 4).setValue([
      '除了標「⚠含前期」的兩項，本區都只算今天。',
      '山物出／中華宅配來自來源鏡像（當日全量），不是本倉出貨。'
    ].join('\n'))
    .setFontSize(10).setFontColor('#666666').setWrap(true).setVerticalAlignment('middle');
  sh.setRowHeight(todayNoteRow, 46);

  // ---- 4. 目前掃描中（A13 起，往下長）----
  // 下半部從第24列開始，不是緊貼著上面。上面的概況區是會長的（每加一個指標就多一列，
  // 說明文字又跟在最後一列的下一列），先前就發生過說明文字長到蓋掉別的內容。
  // 留4列緩衝，概況區還能再加4個指標都不會撞到這裡。
  sectionTitle('A36:E36', '🟠 目前掃描中（誰正在處理哪張）');
  sh.getRange('A37:E37').setValues([['訂單號','賣場','認領人','認領時間','已經過(分鐘)']])
    .setFontWeight('bold').setBackground('#f3f3f3');
  sh.getRange('A38').setFormula(
    `=IFERROR(FILTER({${O}!$A$2:$A,${O}!$B$2:$B,${O}!$H$2:$H,${O}!$I$2:$I},LEFT(${O}!$G$2:$G,3)="掃描中"),"目前沒有人在掃描")`
  );
  // 認領時間存的是 ISO 字串（2026-08-07T04:58:45.545Z），拆出日期跟時間再組回來，
  // 加 8/24 換成台灣時間，跟 NOW() 相減得到已經過幾分鐘。格式不合就顯示空白不要噴錯。
  // 用分鐘不用小時：時限是30分鐘，顯示「0.3小時」看不出離逾時還有多久。
  sh.getRange('E38').setFormula(
    '=ARRAYFORMULA(IF(D38:D53="","",IFERROR(ROUND((NOW()-(DATEVALUE(LEFT(D38:D53,10))+TIMEVALUE(MID(D38:D53,12,8))+8/24))*1440,0),"")))'
  );

  // ---- 5. 今日包貨人員（G13 起，往下長）----
  sectionTitle('G36:H36', '👤 本日包貨人員出貨張數');
  sh.getRange('G37:H37').setValues([['包貨人員','出貨張數']])
    .setFontWeight('bold').setBackground('#f3f3f3');
  sh.getRange('G38').setFormula(
    `=IFERROR(UNIQUE(FILTER(${G}!$L$2:$L,${G}!$R$2:$R>0)),"（尚無出貨）")`
  );
  // 這裡的 G26:G41 一定要跟上面 G26 的清單起點對齊。先前把整個下半部往下移4列時
  // 漏改這一行（還停在 G22:G37），結果姓名在26列起、張數卻從28列起，
  // 每個人被配到別人的數字——而且看起來完全正常，不會有任何錯誤訊息。
  sh.getRange('H38').setFormula(
    `=ARRAYFORMULA(IF(G38:G53="","",COUNTIFS(${G}!$L$2:$L,G38:G53,${G}!$R$2:$R,">0")))`
  );

  // ---- 6. 需要注意的出貨紀錄（J13 起，往下長）----
  // 直接用核對結果裡的燈號來篩：紅燈(錯誤)或橘燈(有人工介入)的才列出來，
  // 不用再自己組一堆條件，燈號本身就是既有的分類結果。
  // 這一區只有12列的高度可用（第6~17列，第22列就是各賣場區塊，長過頭會直接蓋掉它），
  // 但出貨異常多的那天不只12筆。與其叫人自己去翻「出貨紀錄」分頁，不如往右邊接著排：
  // 第13~24筆放在 Q~T 欄，同樣12列。想看的人往右捲就好，不用切分頁、不用自己再篩一次。
  const flagged = `FILTER({${G}!$B$2:$B,${G}!$L$2:$L,${G}!$U$2:$U,${G}!$W$2:$W},${G}!$R$2:$R>0,`
    + `ISNUMBER(SEARCH("🔴",${G}!$U$2:$U))+ISNUMBER(SEARCH("🟠",${G}!$U$2:$U)))`;
  const flaggedHeader = [['訂單號','包貨人員','核對結果','差異明細']];
  sectionTitle('J4:O4', '⚠️ 本日需注意的出貨紀錄（紅燈／橘燈）　1~12 筆');
  sh.getRange('J5:M5').setValues(flaggedHeader).setFontWeight('bold').setBackground('#f3f3f3');
  sh.getRange('J6').setFormula(
    `=ARRAY_CONSTRAIN(IFERROR(${flagged},"目前沒有需要注意的紀錄"),12,4)`
  );
  // 續接區：第13筆以後全部列出來，不設上限。Q欄以右往下沒有別的區塊，
  // 愛長多長都不會蓋到東西——左邊那一區之所以要限制12列，是因為第22列就是別的區塊。
  // 用 QUERY 的 offset 跳過前12筆：CHOOSEROWS 在筆數不足時會整個回錯誤，
  // offset 少於總筆數時只是回空的，剛好是這裡要的行為（沒有第13筆就什麼都不顯示）。
  sectionTitle('Q4:T4', '　（續）第 13 筆以後');
  sh.getRange('Q5:T5').setValues(flaggedHeader).setFontWeight('bold').setBackground('#f3f3f3');
  sh.getRange('Q6').setFormula(`=IFERROR(QUERY(${flagged},"offset 12",0),"")`);
  // 左邊滿12筆時指路到右邊。寫成公式而不是固定文字：沒有溢位時整格是空的，
  // 不會有一行永遠掛在那裡講一件今天沒發生的事。
  sh.getRange('J18').setFormula(
    `=IF(IFERROR(ROWS(${flagged}),0)>12,"↗ 第13筆以後接在右邊（Q欄起），共 "&ROWS(${flagged})&" 筆","")`
  );
  sh.getRange('J18').setFontSize(9).setFontColor('#999999');

  // ---- 6. 本日訂單修改（J40 起）----
  // 人工改過的訂單要能一眼看到是誰、改了什麼、為什麼——這是所有「出貨內容跟原訂單不一樣」
  // 的源頭，客訴回頭查的第一站。資料直接讀系統紀錄，不另外存一份，避免兩邊對不起來。
  // 位置跟左邊的「各賣場」對齊（同樣第22列起）：兩區都是「當天的分解」，
  // 擺在同一條水平線上，一眼掃過去是同一層資訊。
  // 這一區底下（J欄第24列以後）沒有別的區塊，所以也不用限制筆數。
  sectionTitle('J22:O22', '✏️ 本日訂單修改（缺貨／改單／盤差）');
  sh.getRange('J23:L23').setValues([['時間','訂單號','修改內容（含原因）']])
    .setFontWeight('bold').setBackground('#f3f3f3');
  sh.getRange('J24').setFormula(
    `=IFERROR(CHOOSECOLS(FILTER(${SY}!$A$2:$E,${SY}!$B$2:$B="訂單品項人工修改",`
    + `LEFT(${SY}!$A$2:$A,10)=TEXT(TODAY(),"yyyy/MM/dd")),1,3,5),"（今日尚無訂單修改）")`
  );

  // ---- 版面 ----
  sh.setColumnWidth(1, 130); sh.setColumnWidth(2, 90);
  sh.setColumnWidth(3, 24);
  sh.setColumnWidth(4, 155); sh.setColumnWidth(5, 100); // D欄放當日數據的標籤，字比較長
  sh.setColumnWidth(6, 24);
  sh.setColumnWidth(7, 145); sh.setColumnWidth(8, 100); // G欄放出貨品質標籤
  sh.setColumnWidth(9, 24);
  sh.setColumnWidth(10, 105); sh.setColumnWidth(11, 85); sh.setColumnWidth(14, 75); sh.setColumnWidth(15, 75);
  sh.setColumnWidth(16, 24); // P：續接區前面的間隔欄
  sh.setColumnWidth(17, 105); sh.setColumnWidth(18, 85); sh.setColumnWidth(19, 260); sh.setColumnWidth(20, 340); // Q~T：需注意續接區
  sh.setColumnWidth(12, 260); sh.setColumnWidth(13, 340);
  sh.getRange('B5:B13').setFontSize(14).setFontWeight('bold').setHorizontalAlignment('center');
  sh.getRange('E5:E16').setFontSize(14).setFontWeight('bold').setHorizontalAlignment('center');
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
      .whenNumberGreaterThan(0).setBackground('#d9ead3').setRanges([sh.getRange('E9')]).build(),
    // 有換貨待補正就標橘，提醒客服要去處理
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThan(0).setBackground('#fce5cd').setRanges([sh.getRange('E11')]).build(),
    // 未出（文山）：還有東西沒出就標橘，全部出完轉綠
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThan(0).setBackground('#fce5cd').setRanges([sh.getRange('E13:E16')]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberEqualTo(0).setBackground('#d9ead3').setRanges([sh.getRange('E13:E16')]).build()
  ]);

  Logger.log('「儀表板」分頁已建立（公式驅動，資料異動自動重算，不需要排程）。');
}

// 驗證用：把儀表板算完的實際顯示值原封不動回傳，用來確認公式有沒有算錯／標題有沒有掉。
// （用試算表的CSV匯出檢查會踩到型別推斷的坑：整欄是數字時，同一欄的文字標題會被匯出成空白，
// 看起來像標題不見了，其實只是匯出格式的問題——所以要直接讀儲存格才算數。）
// 1→A、27→AA。debug輸出用，欄號超過26時用 String.fromCharCode(65+j) 會跑出 [ \ ] 之類的符號。
function colLetter_(n){
  let out = '';
  while(n > 0){ const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = (n - 1 - r) / 26; }
  return out;
}
function debugReadDashboard_(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_DASHBOARD);
  if(!sh) return {error:'找不到儀表板分頁'};
  const values = sh.getRange(1, 1, 50, 25).getDisplayValues();
  const out = [];
  values.forEach((row, i)=>{
    const cells = [];
    row.forEach((v, j)=>{
      if(String(v).trim()) cells.push(colLetter_(j+1) + (i+1) + '=' + v);
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
    'syncNativeOrderSheet_', 'hourlySync_', 'dailyMaintenance_', 'releaseStaleClaims_'];
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
  ScriptApp.newTrigger('dailyMaintenance_').timeBased().atHour(19).nearMinute(30).everyDays(1).create();
  // 舊核對表單每小時同步一次。刻意不掛在「完成出貨」的流程裡：開啟外部試算表寫入要1~2秒，
  // 掛上去會直接拖慢人員每掃完一張訂單的反應時間，那是現場最在意的速度。
  ScriptApp.newTrigger('hourlySync_').timeBased().everyHours(1).create();
  // 認領逾時釋放另外排一個15分鐘的觸發器。原本這件事只掛在訂單同步裡（一天4次），
  // 時限3小時的時候還算堪用，改成30分鐘之後就不行了：早上10點卡住的單要等到14:05
  // 才會被釋放，時限寫30分鐘但實際上要4小時，等於數字是假的。
  // 15分鐘檢查一次，最壞情況是認領後45分鐘被釋放，跟設定值差得不多。
  ScriptApp.newTrigger('releaseStaleClaims_').timeBased().everyMinutes(15).create();

  Logger.log('已安裝自動排程：訂單同步(9:00/9:15/14:05/14:15) + 出貨紀錄備份(20:00)'
    +' + 每日維護：自動結案＋歸檔(19:30) + 舊核對表單與物流確認同步(每小時)'
    +' + 認領逾時釋放(每15分鐘)，共'
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
    manualClose: '', logisticsConfirmed: '', logisticsTime: '', pickedJson: '', specialNote: '', itemsOverrideJson: '',
    pickDoneAt: '', pickDoneBy: '', createdAt: '', pickStartAt: '', shipStartAt: '', shipDoneAt: ''};
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
// 為什麼是30分鐘：一張訂單正常掃完只要幾分鐘。誤釋放的代價很小（人員回來繼續掃，完成時
// finalizeShipment 不檢查認領人照樣能正常記錄，而且有「已出貨就不重複記錄」的防呆擋著）；
// 但卡住不放的代價是整張訂單當天出不掉、還沒人會發現。兩邊風險不對稱，所以取比較短的時限。
// （原本是3小時，實際上一張單卡到3小時當天就快來不及出了，改成30分鐘。）
const STALE_CLAIM_MINUTES = 30;
function isStaleClaim_(claimedAt){
  const t = Date.parse(claimedAt);
  if(isNaN(t)) return true; // 認領時間讀不出來（空白/格式壞掉）也視為逾時，不然會永遠卡著沒人能處理
  return (Date.now() - t) > STALE_CLAIM_MINUTES * 60 * 1000;
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

  const firstPickTime = {};   // 這一批動作裡，每張單最早的一次「揀貨」時間
  ops.forEach(op=>{
    const orderNo = String(op.orderNo||'').trim();
    const sku = String(op.sku||'').trim();
    const row = byOrderNo[orderNo];
    if(!row || !sku){ notFound++; return; }
    if(op.action !== 'unpick'){
      const t = String(op.time||'');
      if(t && (!firstPickTime[orderNo] || t < firstPickTime[orderNo])) firstPickTime[orderNo] = t;
    }
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
      action: op.action === 'unpick' ? '取消揀貨' : '揀貨',
      kind: op.kind === '調撥' ? '調撥' : '文山'
    });
  });

  const pickStartCol = colOf(ORDERS_HEADER, 'pickStartAt');
  Object.keys(touched).forEach(orderNo=>{
    const r = byOrderNo[orderNo];
    sh.getRange(r._row, pickedCol).setValue(JSON.stringify(touched[orderNo]));
    // 第一件被揀的時間。只在還空著時寫：中途取消再重揀不該把開始時間往後推，
    // 那樣算出來的揀貨耗時會比實際短。
    if(!String(r.pickStartAt||'').trim() && Object.keys(touched[orderNo]).length){
      sh.getRange(r._row, pickStartCol).setNumberFormat('@');
      sh.getRange(r._row, pickStartCol).setValue(firstPickTime[orderNo] || nowStamp_());
    }
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

// ---------------- 特殊註記：把客服寫的缺貨／換貨備註帶到包貨人員眼前 ----------------
// 註記是客服在白天陸續寫的，所以要比訂單同步更常更新——掛在每小時的維護排程裡。
// 只更新有註記的訂單；沒註記的不動，避免把先前抓到的註記洗掉（來源那一格可能被清空重寫）。
const NOTE_MIRROR_SHEET = '蝦proV2註記';
function syncSpecialNotes_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(NOTE_MIRROR_SHEET);
  if(!sh){ Logger.log('找不到「'+NOTE_MIRROR_SHEET+'」鏡像分頁，略過特殊註記同步'); return {ok:false}; }
  const lastRow = sh.getLastRow();
  if(lastRow < 2) return {ok:true, 來源筆數:0, 已更新:0};

  const values = sh.getRange(1, 1, lastRow, 2).getValues();
  const notes = {};
  for(let i = 1; i < values.length; i++){
    const no = String(values[i][0]||'').trim();
    const note = String(values[i][1]||'').trim();
    if(no && note) notes[no] = note;
  }
  const sourceCount = Object.keys(notes).length;
  if(!sourceCount) return {ok:true, 來源筆數:0, 已更新:0};

  const ordersSh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readOrderRows();
  const col = colOf(ORDERS_HEADER, 'specialNote');
  let updated = 0;
  rows.forEach(r=>{
    const hit = notes[String(r.orderNo||'').trim()];
    if(hit === undefined) return;
    if(String(r.specialNote||'').trim() === hit) return;   // 沒變就不要白寫
    ordersSh.getRange(r._row, col).setValue(hit);
    updated++;
  });
  const closed = closeCancelledByNote_();
  Logger.log('特殊註記同步：來源'+sourceCount+'筆，更新'+updated+'張訂單。'+JSON.stringify(closed));
  return {ok:true, 來源筆數:sourceCount, 已更新:updated, 依註記自動結案:closed};
}

// 這個功能會讓真實訂單從待出貨清單消失，所以四種情況都要先用測試資料驗過：
// 該結的有沒有結、不該碰的有沒有被碰。實際資料裡目前三張含「取消」的單都已經人工標過了，
// 光跑正式資料只驗得到「略過」那條路，其他三條完全沒被執行到。
function testCancelByNote_(){
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const stamp = Date.now();
  const cases = [
    {key:'待出貨＋註記取消 → 應結案', status:'pending', note:'客取消', manualClose:'', expect:'取消訂單'},
    {key:'待出貨＋註記沒取消 → 不動', status:'pending', note:'缺 已通知客 換貨', manualClose:'', expect:''},
    {key:'已有人工結案值 → 不覆蓋', status:'pending', note:'客取消', manualClose:'缺貨取消', expect:'缺貨取消'},
    {key:'掃描中 → 不動（不從人手上抽單）', status:'scanning', note:'客取消', manualClose:'', expect:''},
    {key:'已出貨 → 不動（貨都出去了）', status:'shipped', note:'客取消', manualClose:'', expect:''}
  ];
  const firstRow = sh.getLastRow() + 1;
  cases.forEach(function(c, i){
    const orderNo = 'TEST-CANCEL-' + stamp + '-' + i;
    c.orderNo = orderNo;
    const items = [{sku:'TSKU-X', name:'測試品', baseName:'測試品', spec:'', qty:1}];
    const sum = summarizeItems(items);
    const o = {
      orderNo: orderNo, store:'測試', date:'2026/8/12', itemsJson: JSON.stringify(items),
      skuSummary: sum.skuSummary, nameSummary: sum.nameSummary,
      status: statusToText(c.status), claimedBy: c.status === 'scanning' ? 'TEST01' : '',
      claimedAt: c.status === 'scanning' ? new Date().toISOString() : '',
      updatedAt: new Date().toISOString(), shipMethod:'', routingStatus:'文山',
      manualClose: c.manualClose, logisticsConfirmed:'', logisticsTime:'',
      pickedJson:'', specialNote: c.note, itemsOverrideJson:''
    };
    sh.getRange(firstRow + i, 1, 1, ORDERS_HEADER.length)
      .setValues([ORDERS_HEADER.map(function(h){ return o[h]; })]);
  });

  const steps = [];
  try{
    const result = closeCancelledByNote_();
    const after = readOrderRows();
    cases.forEach(function(c){
      const r = after.find(function(x){ return x.orderNo === c.orderNo; });
      const got = r ? String(r.manualClose||'').trim() : '(找不到)';
      steps.push((got === c.expect ? '✅ ' : '❌ ') + c.key + ' → 人工結案=「' + got + '」（期望「' + c.expect + '」）');
    });
    steps.push((result.已結案 === 1 ? '✅ ' : '❌ ') + '回報已結案 ' + result.已結案 + ' 張（期望1）');
    steps.push((result.已出貨需人工處理 === 1 ? '✅ ' : '❌ ') + '回報已出貨需人工處理 ' + result.已出貨需人工處理 + ' 張（期望1）');
    steps.push((result.掃描中略過 === 1 ? '✅ ' : '❌ ') + '回報掃描中略過 ' + result.掃描中略過 + ' 張（期望1）');
  }catch(err){
    steps.push('❌ 例外：' + err);
  }finally{
    // 由後往前刪，才不會刪掉一列之後後面的列號整個往上位移
    for(let i = cases.length - 1; i >= 0; i--) sh.deleteRow(firstRow + i);
    cleanupTestSysLogRows_();
  }
  return {全部通過: steps.every(function(x){ return x.indexOf('✅') === 0; }), 明細: steps};
}

// ---------------- 特殊註記寫「取消」的訂單自動結案 ----------------
// 客服在來源的特殊註記欄寫「客取消」之類的字，代表這張單不用出了。
// 沒有自動處理的話它會一直留在待出貨清單裡，揀貨員照樣去揀、包貨員照樣去包，
// 等於白做一趟；主管得自己一張一張看註記再去下拉選單標結案。
//
// 三個刻意不碰的情況：
//   已經有人工結案值 —— 那是人挑的，程式不覆蓋。
//   掃描中 —— 有人正在處理，從他手上把單抽走會讓他掃到一半突然失效。
//   已出貨 —— 貨都出去了，這時候標「取消訂單」等於在紀錄上說謊。
//              但這種情況要另外提出來：客人取消了而貨已經寄出，是要處理的事，
//              不是可以靜靜跳過的事。
const CANCEL_NOTE_KEYWORD = '取消';
// 試跑：只列出「會被自動結案的是哪幾張、註記寫什麼」，不寫入任何東西。
// 這個動作會讓訂單從待出貨清單消失，跑之前先看一眼清單比較安全。
function previewCancelledByNote_(){
  const rows = readOrderRows();
  const out = {將結案:[], 已出貨需人工處理:[], 掃描中略過:[], 已有結案值略過:[]};
  rows.forEach(function(r){
    const note = String(r.specialNote||'').trim();
    if(note.indexOf(CANCEL_NOTE_KEYWORD) < 0) return;
    const line = r.orderNo + '｜' + note;
    if(String(r.manualClose||'').trim()) out.已有結案值略過.push(line + '（現值：' + r.manualClose + '）');
    else if(r.status === 'shipped') out.已出貨需人工處理.push(line);
    else if(r.status === 'scanning') out.掃描中略過.push(line);
    else out.將結案.push(line);
  });
  return out;
}
function closeCancelledByNote_(){
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readOrderRows();
  const col = colOf(ORDERS_HEADER, 'manualClose');
  const done = [], shippedConflict = [], scanningSkipped = [];
  rows.forEach(function(r){
    const note = String(r.specialNote||'').trim();
    if(note.indexOf(CANCEL_NOTE_KEYWORD) < 0) return;
    if(String(r.manualClose||'').trim()) return;
    if(r.status === 'shipped'){ shippedConflict.push({orderNo:r.orderNo, note:note}); return; }
    if(r.status === 'scanning'){ scanningSkipped.push({orderNo:r.orderNo, note:note}); return; }
    // 一律標「取消訂單」。註記裡看不出該用「取消訂單」還是「缺貨取消」——
    // 實際資料裡同樣是「客取消」三個字，人工標的結果兩種都有，代表這件事沒辦法從文字推。
    // 標一個一致的值、把原文寫進系統紀錄，主管要改成「缺貨取消」在下拉選單點一下就好。
    sh.getRange(r._row, col).setValue('取消訂單');
    done.push({orderNo:r.orderNo, note:note});
  });

  if(done.length || shippedConflict.length || scanningSkipped.length){
    const logSh = getSheet(SHEET_SYSLOG, SYSLOG_HEADER);
    const now = nowStamp_();
    const entries = [];
    done.forEach(function(x){
      entries.push({logTime:now, event:'依註記自動結案', orderNo:x.orderNo, claimedBy:'',
        detail:'特殊註記含「'+CANCEL_NOTE_KEYWORD+'」→ 自動標記為「取消訂單」。註記原文：'+x.note
             + '　｜　如果實際只是取消其中一項商品、整張單仍要出，請把「人工結案」欄清空還原。'});
    });
    shippedConflict.forEach(function(x){
      entries.push({logTime:now, event:'⚠ 已出貨卻註記取消', orderNo:x.orderNo, claimedBy:'',
        detail:'這張訂單已經出貨，但特殊註記寫著取消，需要人工處理（攔件／退貨）。註記原文：'+x.note});
    });
    scanningSkipped.forEach(function(x){
      entries.push({logTime:now, event:'註記取消但掃描中，未處理', orderNo:x.orderNo, claimedBy:'',
        detail:'掃描中的訂單不自動結案，以免人員掃到一半失效。請人員中止後會在下次同步自動結案。註記原文：'+x.note});
    });
    const start = logSh.getLastRow() + 1;
    logSh.getRange(start, colOf(SYSLOG_HEADER,'logTime'), entries.length, 1).setNumberFormat('@');
    logSh.getRange(start, 1, entries.length, SYSLOG_HEADER.length)
      .setValues(entries.map(function(o){ return SYSLOG_HEADER.map(function(h){ return o[h]; }); }));
  }
  return {已結案: done.length, 已出貨需人工處理: shippedConflict.length, 掃描中略過: scanningSkipped.length,
          訂單號: done.map(function(x){ return x.orderNo; })};
}

// ================= 商品主圖對照 =================
// 用途：無條碼商品沒辦法用掃描確認，只能靠人眼比對，光看品名很容易拿錯
// （同款不同色、同色不同尺寸的品名幾乎一樣）。揀貨和出貨確認畫面帶一張圖，
// 現場可以直接對照實體商品。
//
// 來源是賣場後台匯出的「商品規格_價格_主圖」四賣場合併檔（Google雲端硬碟）。
// 只取兩欄：貨號 → 圖片ID。刻意不存完整網址：21552列每列都存一次
// 「https://s-cf-tw.shopeesz.com/file/」等於白白多傳 700KB 給每一台裝置，
// 網址前綴在APP端補回去就好。
const PRODUCT_IMAGE_SOURCE_ID = '1vkMgsfaesSQ2Arn9DwwO1KS5bnKdPZW8';
// 第二份來源：規格層級的圖（賣場後台的「貨號對應選項」）。
// 前一份的「商品圖片1」是商品層級的，同款不同色共用同一張，只能確認款式不能確認顏色。
// 這一份的「選項圖片」是每個規格自己的圖——實測3293個多規格商品裡有2901個的圖會隨規格變，
// 深灰/淺灰兩條毛巾拿到的是兩張不同的照片。這是揀貨現場真正需要的東西。
// 兩份合併成一張對照表：規格圖優先，沒有的退回商品圖。
const SPEC_IMAGE_SOURCE_ID = '1DeqU2CnmM1XL-J3IudjDzc8OmMuv7Bqz';
const SPEC_IMAGE_TAB = '貨號對應選項';
const PRODUCT_IMAGE_PREFIX = 'https://s-cf-tw.shopeesz.com/file/';
const SHEET_PRODUCT_IMAGE = '商品主圖';

// 來源是一份原生的 Google 試算表（實測 openById 開得起來），所以直接用 SpreadsheetApp 讀，
// 不要走 CSV。第一版是抓 export?format=csv 回來自己逐字元解析，6MB 的字串在 Apps Script 裡
// 跑不完——請求直接超時、分頁也沒建出來。直接讀儲存格快得多，而且只讀需要的那幾欄。
const PRODUCT_IMAGE_TAB = '商品規格對照';
function importProductImages_(){
  const src = SpreadsheetApp.openById(PRODUCT_IMAGE_SOURCE_ID);
  const sh0 = src.getSheetByName(PRODUCT_IMAGE_TAB) || src.getSheets()[0];
  const lastRow = sh0.getLastRow();
  if(lastRow < 2) return {ok:false, error:'來源分頁沒有資料列'};
  const header = sh0.getRange(1, 1, 1, sh0.getLastColumn()).getValues()[0]
                    .map(function(x){ return String(x||'').trim(); });
  const iOpt = header.indexOf('商品選項貨號');
  const iMain = header.indexOf('主商品貨號');
  const iImg = header.indexOf('主商品圖片');
  // 優先用「商品圖片1」——那才是賣場頁面的第一張圖，也就是實際的商品照。
  // 「主商品圖片」是行銷用的封面（滿版標語、免運貼紙、模特兒情境照），
  // 拿來對照實體商品反而看不清楚東西長什麼樣。實測21474列裡兩欄有21458列不同。
  const iImg1 = header.indexOf('商品圖片1');
  if((iImg < 0 && iImg1 < 0) || (iOpt < 0 && iMain < 0)){
    return {ok:false, error:'來源欄位不符（需要 商品圖片1/主商品圖片 與 商品選項貨號/主商品貨號）'};
  }
  // 只讀用得到的欄位範圍，不要整張 getDataRange()——那會把兩萬多列×十幾欄全部拉進記憶體
  const cols = [iOpt, iMain, iImg, iImg1].filter(function(x){ return x >= 0; });
  const from = Math.min.apply(null, cols) + 1;
  const to = Math.max.apply(null, cols) + 1;
  const values = sh0.getRange(2, from, lastRow - 1, to - from + 1).getValues();
  const col = function(row, idx){ return idx < 0 ? '' : row[idx + 1 - from]; };

  const map = {};
  let skipped = 0, foreign = 0, usedFallback = 0;
  values.forEach(function(row){
    // 商品圖片1 為主，空白時才退回主商品圖片（實測有16列沒有圖片1）。
    // 退回也比沒有圖好：行銷封面至少還看得出是哪一款商品。
    let img = String(col(row, iImg1)||'').trim();
    if(!img){ img = String(col(row, iImg)||'').trim(); if(img) usedFallback++; }
    if(!img){ skipped++; return; }
    if(img.indexOf(PRODUCT_IMAGE_PREFIX) !== 0){ foreign++; return; } // 網域不同就跳過，不然APP拼出來的網址是壞的
    const id = img.slice(PRODUCT_IMAGE_PREFIX.length);
    // 選項貨號優先：那是訂單上實際會出現的貨號。主商品貨號只在選項貨號沒對到時當備援，
    // 而且不覆蓋既有的，免得同一個主貨號的其中一個選項把別的選項蓋掉。
    [col(row, iOpt), col(row, iMain)].forEach(function(v){
      const sku = String(v||'').trim();
      if(sku && !map[sku]) map[sku] = id;
    });
  });

  // ---- 第二份來源：規格層級的圖 ----
  const specMap = {};
  let specSkipped = 0, specForeign = 0;
  try{
    const src2 = SpreadsheetApp.openById(SPEC_IMAGE_SOURCE_ID);
    const sh2 = src2.getSheetByName(SPEC_IMAGE_TAB) || src2.getSheets()[0];
    const last2 = sh2.getLastRow();
    if(last2 >= 2){
      const head2 = sh2.getRange(1, 1, 1, sh2.getLastColumn()).getValues()[0]
                       .map(function(x){ return String(x||'').trim(); });
      const jSku = head2.indexOf('商品選項貨號');
      const jImg = head2.indexOf('選項圖片');
      if(jSku >= 0 && jImg >= 0){
        const cols2 = [jSku, jImg];
        const from2 = Math.min.apply(null, cols2) + 1;
        const to2 = Math.max.apply(null, cols2) + 1;
        const v2 = sh2.getRange(2, from2, last2 - 1, to2 - from2 + 1).getValues();
        v2.forEach(function(row){
          const sku = String(row[jSku + 1 - from2]||'').trim();
          const img = String(row[jImg + 1 - from2]||'').trim();
          if(!sku) return;
          if(!img){ specSkipped++; return; }
          if(img.indexOf(PRODUCT_IMAGE_PREFIX) !== 0){ specForeign++; return; }
          if(!specMap[sku]) specMap[sku] = img.slice(PRODUCT_IMAGE_PREFIX.length);
        });
      }
    }
  }catch(err){
    // 第二份讀不到就只寫商品圖，不要整個匯入失敗——有商品圖總比完全沒有圖好
    Logger.log('規格圖來源讀取失敗，只匯入商品圖：' + err);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_PRODUCT_IMAGE);
  if(!sh) sh = ss.insertSheet(SHEET_PRODUCT_IMAGE);
  sh.clear();
  // 兩份的貨號取聯集：有些貨號只在其中一份出現
  const allSkus = {};
  Object.keys(map).forEach(function(k){ allSkus[k] = 1; });
  Object.keys(specMap).forEach(function(k){ allSkus[k] = 1; });
  const out = Object.keys(allSkus).map(function(k){ return [k, map[k] || '', specMap[k] || '']; });
  sh.getRange(1, 1, 1, 3).setValues([['貨號','圖片ID','規格圖ID']]).setFontWeight('bold');
  if(out.length){
    // 貨號欄設成文字格式：有些貨號是純數字，被當數字會掉前導零、長的還會變科學記號
    sh.getRange(2, 1, out.length, 1).setNumberFormat('@');
    sh.getRange(2, 1, out.length, 3).setValues(out);
  }
  sh.setColumnWidth(1, 180); sh.setColumnWidth(2, 320); sh.setColumnWidth(3, 320);
  sh.setFrozenRows(1);
  const bothCount = out.filter(function(r){ return r[1] && r[2]; }).length;
  return {ok:true, 貨號數: out.length,
          有商品圖: Object.keys(map).length, 有規格圖: Object.keys(specMap).length, 兩者都有: bothCount,
          只有規格圖: Object.keys(specMap).length - bothCount,
          只有商品圖: Object.keys(map).length - bothCount,
          商品圖用商品圖片1: Object.keys(map).length - usedFallback, 商品圖退回主商品圖片: usedFallback,
          商品圖無圖略過: skipped, 網域不符略過: foreign + specForeign,
          分頁: SHEET_PRODUCT_IMAGE, gid: sh.getSheetId()};
}

// 檢查對照表對「實際會用到的貨號」涵蓋到什麼程度。
// 涵蓋率低的話這個功能等於沒用，而且是那種不會報錯、只是圖片一直不出現的沉默失效，
// 所以要能隨時量得出來。
function checkProductImageCoverage_(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PRODUCT_IMAGE);
  if(!sh) return {error:'還沒建立「' + SHEET_PRODUCT_IMAGE + '」分頁'};
  const lastRow = sh.getLastRow();
  if(lastRow < 2) return {error:'對照表是空的'};
  const map = {}, specMap = {};
  sh.getRange(2, 1, lastRow - 1, 3).getValues().forEach(function(r){
    const k = String(r[0]||'').trim(); if(!k) return;
    const img = String(r[1]||'').trim(), spec = String(r[2]||'').trim();
    if(img || spec) map[k] = img || spec;   // 有任何一種圖就算有圖
    if(spec) specMap[k] = spec;
  });
  const rows = readOrderRows();
  const skuQty = {};
  rows.forEach(function(r){
    safeParse(r.itemsJson, []).forEach(function(it){
      const sku = String(it.sku||'').trim(); if(!sku) return;
      skuQty[sku] = (skuQty[sku]||0) + (Number(it.qty)||0);
    });
  });
  const all = Object.keys(skuQty);
  const hit = all.filter(function(s){ return map[s]; });
  const missQty = all.filter(function(s){ return !map[s]; })
                     .reduce(function(n,s){ return n + skuQty[s]; }, 0);
  const hitQty = hit.reduce(function(n,s){ return n + skuQty[s]; }, 0);
  const specHit = all.filter(function(s){ return specMap[s]; });
  return {
    對照表貨號數: Object.keys(map).length,
    訂單涉及貨號數: all.length,
    有圖貨號數: hit.length,
    有規格圖貨號數: specHit.length,
    規格圖涵蓋率: all.length ? Math.round(specHit.length / all.length * 100) + '%' : '-',
    貨號涵蓋率: all.length ? Math.round(hit.length / all.length * 100) + '%' : '-',
    件數涵蓋率: (hitQty + missQty) ? Math.round(hitQty / (hitQty + missQty) * 100) + '%' : '-',
    無圖貨號樣本: all.filter(function(s){ return !map[s]; }).slice(0, 10)
  };
}

// ================= 訂單品項人工修改（缺貨／客人改單／盤差） =================
// 現場遇到「這件沒貨了」「客人臨時改成別款」「盤點數量對不上」時，訂單內容跟實際要出的東西
// 就對不起來了，包貨人員掃到最後永遠湊不齊，只能靠人工介入硬過。
// 這一區讓主管在試算表上直接把訂單改對，APP下次更新就會拿到改過的內容。
//
// 設計上最關鍵的一點：改的是「指令」，不是「結果」。
// 訂單每次同步都會從來源整列重寫（一天4次＋隨時手動），如果直接改品項欄，
// 下一次同步就整個蓋回去，改了等於沒改，而且不會有任何錯誤訊息，最難查。
// 所以修改內容存成一串操作（哪個貨號 → 換成什麼／改幾件／不出），
// 放在訂單自己的 itemsOverrideJson 欄，同步時重新套一次。
const SHEET_AMEND = '訂單修改';
const AMEND_FIRST_ROW = 6;   // 第6列開始是品項工作區
const AMEND_MAX_ROWS = 30;   // 一張訂單最多處理30個品項，夠用且不會無限往下長
// 原因用下拉選單而不是自由填寫：這些字會被寫進出貨紀錄的「差異明細」，
// 之後要靠它統計「到底是缺貨多還是客人改單多」。自由填寫的話同一件事會有十種寫法，統計不出東西。
// 選單擋不住的細節（哪個客人、換成什麼顏色）寫在旁邊的「備註」欄，兩欄分工。
const AMEND_REASONS = ['缺貨不出', '缺貨改出替代品', '客人改單', '盤差調整', '商品瑕疵更換', '贈品／加購', '其他'];
// 欄位位置集中在這裡。先前欄位挪動時是散在四五個函式裡各改各的偏移量，
// 漏改一處就是「讀到隔壁欄」——不會報錯，只會把備註當成數量之類的默默出錯。
const AC = {check:1, sku:2, img1:3, name:4, qty:5, toSku:6, img2:7, toQty:8, reason:9, memo:10};
const AMEND_LAST_COL = 10;
function acLetter_(n){ return String.fromCharCode(64 + n); }

function nowStamp_(){
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  return Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd HH:mm:ss');
}

// 把訂單上存的修改指令組成一句給人看的話，用在出貨紀錄的「差異明細」。
// 舊資料的指令沒有 desc 欄（那時還沒有原因下拉），退回用貨號拼一句，不要整段變空白。
function amendSummary_(overrideJson){
  const ops = safeParse(String(overrideJson||''), []);
  if(!ops.length) return '';
  const parts = ops.map(function(op){
    if(op.desc) return op.desc;
    const from = String(op.sku||''), to = String(op.toSku||'');
    if(!from) return '加出 ' + to;
    if(op.qty === 0) return '不出 ' + from;
    return to ? (from + ' 改出 ' + to) : (from + ' 數量改為 ' + op.qty);
  });
  return '出貨前經人工修改：' + parts.join('；');
}

// 把一串修改指令套用到品項清單上。純函式，不碰試算表，方便單獨驗證。
// op 格式：{sku:'原貨號', toSku:'新貨號'|'', qty:數字|null, name:'新品名'}
//   qty=0        → 這個品項不出（缺貨、客人取消）
//   toSku 有值   → 換成別的貨號（客人改單、以同款替代）
//   sku 空白     → 新增一個原本訂單上沒有的品項（客人加購）
function applyItemOps_(items, ops){
  if(!ops || !ops.length) return items;
  const out = (items||[]).map(function(it){ return Object.assign({}, it); });
  ops.forEach(function(op){
    const from = String(op.sku||'').trim();
    const toSku = String(op.toSku||'').trim();
    const qty = (op.qty === null || op.qty === undefined || op.qty === '') ? null : Number(op.qty);
    if(!from){
      // 新增品項。沒指定數量就當1件，指定0件則是自相矛盾（新增又不出），直接忽略。
      if(!toSku || qty === 0) return;
      out.push({sku: toSku, name: op.name || toSku, baseName: op.name || toSku, spec: '',
                qty: qty === null ? 1 : qty, location: '', stockWs: '', stockMain: '',
                allocWs: 0, allocSp: 0, allocZh: 0, allocOm: 0, shortQty: 0, amended: true});
      return;
    }
    const idx = out.findIndex(function(it){ return String(it.sku||'').trim() === from; });
    if(idx < 0) return; // 來源已經沒有這個貨號了（客服自己改過），這條指令就跳過，不要憑空補一個回去
    if(qty === 0){ out.splice(idx, 1); return; }
    if(toSku && toSku !== from){
      out[idx].sku = toSku;
      out[idx].name = op.name || toSku;
      out[idx].baseName = op.name || toSku;
      out[idx].spec = '';
      // 換了貨號之後，原本那件的儲位／庫存／各店分配數就全部不適用了，一律清掉。
      // 留著會讓揀貨畫面指向錯的儲位，比沒有資訊更糟。
      out[idx].location = ''; out[idx].stockWs = ''; out[idx].stockMain = '';
      out[idx].allocWs = 0; out[idx].allocSp = 0; out[idx].allocZh = 0; out[idx].allocOm = 0;
      out[idx].shortQty = 0;
    }
    if(qty !== null && !isNaN(qty) && qty > 0) out[idx].qty = qty;
    out[idx].amended = true;
  });
  return out;
}

// 貨號→品名對照，從既有的「條碼轉品號」鏡像分頁拿（B欄品號、D欄品名）。
// 換貨號時順手把品名帶出來，包貨人員畫面上才不是一串看不懂的編號。
function skuNameMap_(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('條碼轉品號');
  const map = {};
  if(!sh) return map;
  const lastRow = sh.getLastRow();
  if(lastRow < 2) return map;
  const values = sh.getRange(2, 2, lastRow - 1, 3).getValues(); // B:品號 C:條碼 D:品名
  values.forEach(function(r){
    const sku = String(r[0]||'').trim();
    if(sku && !map[sku]) map[sku] = String(r[2]||'').trim();
  });
  return map;
}

// applyItemOps_ 是這個功能唯一會改到訂單內容的地方，出錯的話是包貨人員拿到錯的清單，
// 所以先用假資料把每一種情況跑過一遍再上線，不要拿真訂單試。
function testApplyItemOps_(){
  const base = [
    {sku:'A1', name:'甲', qty:2, location:'A-01-1'},
    {sku:'B2', name:'乙', qty:1, location:'B-02-3'},
    {sku:'C3', name:'丙', qty:5, location:'C-03-2'}
  ];
  const cases = [
    ['改數量', [{sku:'A1', qty:1}], function(r){ return r.length===3 && r[0].qty===1; }],
    ['整件不出', [{sku:'B2', qty:0}], function(r){ return r.length===2 && !r.some(function(x){return x.sku==='B2';}); }],
    ['換貨號並清掉儲位', [{sku:'C3', toSku:'D4', name:'丁', qty:2}], function(r){
      const d = r.find(function(x){ return x.sku==='D4'; });
      return !!d && d.qty===2 && d.name==='丁' && d.location===''; }],
    ['換貨號不改數量', [{sku:'A1', toSku:'E5', name:'戊'}], function(r){
      const e5 = r.find(function(x){ return x.sku==='E5'; }); return !!e5 && e5.qty===2; }],
    ['新增品項', [{sku:'', toSku:'F6', name:'己', qty:3}], function(r){
      return r.length===4 && r[3].sku==='F6' && r[3].qty===3; }],
    ['來源已無此貨號就跳過', [{sku:'ZZ', qty:9}], function(r){
      return r.length===3 && !r.some(function(x){ return x.sku==='ZZ'; }); }],
    ['多個指令一起套', [{sku:'A1', qty:1},{sku:'B2', qty:0},{sku:'', toSku:'G7', qty:1}], function(r){
      return r.length===3 && r[0].qty===1 && !r.some(function(x){return x.sku==='B2';})
        && r.some(function(x){ return x.sku==='G7'; }); }],
    ['沒有指令時原樣返回', [], function(r){ return r.length===3 && r[2].qty===5; }]
  ];
  const results = cases.map(function(c){
    let pass = false, err = '';
    try{ pass = c[2](applyItemOps_(base, c[1])); }catch(e){ err = String(e); }
    return (pass ? '✅ ' : '❌ ') + c[0] + (err ? ' ('+err+')' : '');
  });
  // 原始陣列不能被改到——套用是每次同步都要重跑的，改到來源就會一次比一次錯
  const untouched = base[0].qty === 2 && base.length === 3 && base[2].location === 'C-03-2';
  results.push((untouched ? '✅ ' : '❌ ') + '不會改到傳進來的原始陣列');
  return {全部通過: results.every(function(r){ return r.indexOf('✅')===0; }), 明細: results};
}

// 端對端驗證：自己建一張測試訂單，走完「帶出品項 → 填修改 → 套用」，
// 再模擬一次同步，確認修改沒有被同步蓋掉（這是整個設計最關鍵、也最容易錯的一點）。
// 跑完把測試訂單刪掉、工作區清空。用測試資料驗證才不用拿真訂單冒險。
function testAmendFlow_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ordersSh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const sh = ss.getSheetByName(SHEET_AMEND);
  if(!sh) return {error:'請先執行 setupAmendSheet_'};
  const orderNo = 'TEST-AMEND-' + Date.now();
  const srcItems = [
    {sku:'TSKU-A', name:'測試甲', baseName:'測試甲', spec:'', qty:2, location:'A-01-1'},
    {sku:'TSKU-B', name:'測試乙', baseName:'測試乙', spec:'', qty:1, location:'B-02-3'},
    {sku:'TSKU-C', name:'測試丙', baseName:'測試丙', spec:'', qty:5, location:'C-03-2'}
  ];
  const rowObj = {
    orderNo: orderNo, store: '測試', date: '2026/8/11',
    itemsJson: JSON.stringify(srcItems),
    skuSummary: summarizeItems(srcItems).skuSummary, nameSummary: summarizeItems(srcItems).nameSummary,
    status: statusToText('pending'), claimedBy: '', claimedAt: '',
    updatedAt: new Date().toISOString(), shipMethod: '', routingStatus: '文山',
    manualClose: '', logisticsConfirmed: '', logisticsTime: '', pickedJson: '', specialNote: '',
    itemsOverrideJson: ''
  };
  const testRow = ordersSh.getLastRow() + 1;
  ordersSh.getRange(testRow, 1, 1, ORDERS_HEADER.length).setValues([ORDERS_HEADER.map(function(h){ return rowObj[h]; })]);

  const steps = [];
  try{
    sh.getRange('B2').setValue(orderNo);
    const loadMsg = loadOrderIntoAmendSheet_(sh, orderNo);
    const loaded = sh.getRange(AMEND_FIRST_ROW, 1, 3, AMEND_LAST_COL).getValues();
    steps.push((loaded[0][AC.sku-1]==='TSKU-A' && loaded[2][AC.qty-1]===5 ? '✅ ' : '❌ ') + '帶出原始品項：' + loadMsg);
    steps.push((loaded.every(function(r){ return r[AC.check-1] === false; }) ? '✅ ' : '❌ ')
      + '帶出時勾選框預設都是未勾');

    // 填了內容卻沒勾 → 要擋下來。默默照做等於勾選沒有意義，默默略過則是人以為改好了其實沒改。
    sh.getRange(AMEND_FIRST_ROW, AC.toQty).setValue(0);
    const noCheck = applyAmendSheet_(sh, orderNo);
    steps.push((noCheck.indexOf('❌')===0 && noCheck.indexOf('沒勾')>0 ? '✅ ' : '❌ ')
      + '填了卻沒勾被擋下：' + noCheck);

    // 勾了卻沒填 → 也要擋
    sh.getRange(AMEND_FIRST_ROW, AC.toQty).setValue('');
    sh.getRange(AMEND_FIRST_ROW, AC.check).setValue(true);
    const noInput = applyAmendSheet_(sh, orderNo);
    steps.push((noInput.indexOf('❌')===0 && noInput.indexOf('沒填')>0 ? '✅ ' : '❌ ')
      + '勾了卻沒填被擋下：' + noInput);

    // 沒選原因就要被擋下來——原因是要寫進出貨紀錄的，漏了等於這筆修改事後查不出所以然
    sh.getRange(AMEND_FIRST_ROW, AC.toQty).setValue(0);
    const noReason = applyAmendSheet_(sh, orderNo);
    steps.push((noReason.indexOf('❌')===0 && noReason.indexOf('原因')>0 ? '✅ ' : '❌ ')
      + '沒選原因被擋下：' + noReason);

    // 第1列：整件不出；第3列：換成別的貨號並改數量
    sh.getRange(AMEND_FIRST_ROW, AC.reason).setValue('缺貨不出');
    sh.getRange(AMEND_FIRST_ROW + 2, AC.check).setValue(true);
    sh.getRange(AMEND_FIRST_ROW + 2, AC.toSku).setValue('TSKU-Z');
    sh.getRange(AMEND_FIRST_ROW + 2, AC.toQty).setValue(3);
    sh.getRange(AMEND_FIRST_ROW + 2, AC.reason).setValue('客人改單');
    sh.getRange(AMEND_FIRST_ROW + 2, AC.memo).setValue('客人來電改成綠色');
    // 第2列（TSKU-B）不勾也不填，套用後必須原封不動——這是這次要驗的重點
    const applyMsg = applyAmendSheet_(sh, orderNo);
    steps.push((applyMsg.indexOf('✅')===0 ? '✅ ' : '❌ ') + '套用：' + applyMsg);

    const after = readOrderRows().find(function(r){ return r.orderNo === orderNo; });
    const items = safeParse(after.itemsJson, []);
    const hasA = items.some(function(i){ return i.sku==='TSKU-A'; });
    const z = items.find(function(i){ return i.sku==='TSKU-Z'; });
    steps.push((!hasA ? '✅ ' : '❌ ') + '「不出」的品項已移除');
    steps.push((z && z.qty===3 && z.location==='' ? '✅ ' : '❌ ') + '換貨號生效且儲位已清空');
    steps.push((items.length===2 ? '✅ ' : '❌ ') + '剩餘品項數＝2（實際 '+items.length+'）');
    const untouched = items.find(function(i){ return i.sku === 'TSKU-B'; });
    steps.push((untouched && untouched.qty === 1 && !untouched.amended ? '✅ ' : '❌ ')
      + '沒勾選的 TSKU-B 完全沒被動到（數量仍為1、無修改標記）');

    // 最關鍵的一步：模擬同步。來源會送回「原始的」三個品項，
    // 套上存起來的指令之後應該還是改過的結果，不是退回原始內容。
    const ops = safeParse(String(after.itemsOverrideJson||''), []);
    const resynced = applyItemOps_(srcItems, ops);
    const okResync = resynced.length===2
      && !resynced.some(function(i){ return i.sku==='TSKU-A'; })
      && resynced.some(function(i){ return i.sku==='TSKU-Z' && i.qty===3; });
    steps.push((okResync ? '✅ ' : '❌ ') + '同步後修改仍在（不會被來源蓋回去）');

    // APP 拿到的是不是改過的內容——直接呼叫 APP 實際會呼叫的那支函式，不用推論。
    const state = getState();
    const appOrder = state.orders[orderNo];
    const appOk = appOrder && appOrder.items.length===2
      && !appOrder.items.some(function(i){ return i.sku==='TSKU-A'; })
      && appOrder.items.some(function(i){ return i.sku==='TSKU-Z' && i.qty===3; });
    steps.push((appOk ? '✅ ' : '❌ ') + 'getState（APP的資料來源）回傳的就是改過的品項');

    // 出貨時會寫進「差異明細」的那段字：原因跟備註都要在裡面，而且要自己讀得懂
    const summary = amendSummary_(after.itemsOverrideJson);
    const sumOk = summary.indexOf('出貨前經人工修改')===0
      && summary.indexOf('缺貨不出')>0 && summary.indexOf('客人改單')>0
      && summary.indexOf('客人來電改成綠色')>0;
    steps.push((sumOk ? '✅ ' : '❌ ') + '差異明細用字：' + summary);
  }catch(err){
    steps.push('❌ 例外：' + err);
  }finally{
    ordersSh.deleteRow(testRow);
    clearAmendGrid_(sh);
    sh.getRange('B2').clearContent();
    sh.getRange('D2:D3').clearContent();
    sh.getRange('B3').setValue(false);
    cleanupTestSysLogRows_();
  }
  return {全部通過: steps.every(function(s){ return s.indexOf('✅')===0; }), 明細: steps};
}

// 測 onEdit 這條路徑本身。傳進去的是真的 Range 物件，所以 onEdit 裡面的
// getSheet()/getA1Notation()/getValue() 都是真的在跑，跟真人編輯的差別只剩「誰觸發」。
// Google 到底會不會在真人編輯時呼叫 onEdit，這裡測不出來——那是平台行為，只能實際敲一次。
// 但如果 onEdit 內部有寫錯（欄位判斷、例外、勾選框沒彈回來），這個測試會抓到。
function testOnEditWiring_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ordersSh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const sh = ss.getSheetByName(SHEET_AMEND);
  if(!sh) return {error:'請先執行 setupAmendSheet_'};
  const orderNo = 'TEST-ONEDIT-' + Date.now();
  const srcItems = [
    {sku:'TSKU-A', name:'測試甲', baseName:'測試甲', spec:'', qty:2, location:'A-01-1'},
    {sku:'TSKU-B', name:'測試乙', baseName:'測試乙', spec:'', qty:4, location:'B-02-3'}
  ];
  const sum = summarizeItems(srcItems);
  const rowObj = {
    orderNo: orderNo, store: '測試', date: '2026/8/11', itemsJson: JSON.stringify(srcItems),
    skuSummary: sum.skuSummary, nameSummary: sum.nameSummary,
    status: statusToText('pending'), claimedBy: '', claimedAt: '', updatedAt: new Date().toISOString(),
    shipMethod: '', routingStatus: '文山', manualClose: '', logisticsConfirmed: '', logisticsTime: '',
    pickedJson: '', specialNote: '', itemsOverrideJson: ''
  };
  const testRow = ordersSh.getLastRow() + 1;
  ordersSh.getRange(testRow, 1, 1, ORDERS_HEADER.length).setValues([ORDERS_HEADER.map(function(h){ return rowObj[h]; })]);

  const steps = [];
  try{
    // 1) 模擬「在B2貼上訂單號」
    sh.getRange('B2').setValue(orderNo);
    onEdit({range: sh.getRange('B2')});
    const loaded = sh.getRange(AMEND_FIRST_ROW, 1, 2, AMEND_LAST_COL).getValues();
    const d2 = String(sh.getRange('D2').getValue()||'');
    steps.push((loaded[0][AC.sku-1]==='TSKU-A' && loaded[1][AC.qty-1]===4 ? '✅ ' : '❌ ')
      + 'B2 貼訂單號 → 自動帶出品項（狀態訊息：'+d2+'）');

    // 2) 模擬「填好修改內容後勾選套用」
    sh.getRange(AMEND_FIRST_ROW, AC.check).setValue(true);
    sh.getRange(AMEND_FIRST_ROW, AC.toQty).setValue(1);        // 甲 2→1 件
    sh.getRange(AMEND_FIRST_ROW, AC.reason).setValue('盤差調整');
    sh.getRange(AMEND_FIRST_ROW + 1, AC.check).setValue(true);
    sh.getRange(AMEND_FIRST_ROW + 1, AC.toSku).setValue('TSKU-Y'); // 乙 換成 Y
    sh.getRange(AMEND_FIRST_ROW + 1, AC.reason).setValue('商品瑕疵更換');
    sh.getRange('B3').setValue(true);
    onEdit({range: sh.getRange('B3')});
    const d3 = String(sh.getRange('D3').getValue()||'');
    const checkbox = sh.getRange('B3').getValue();
    steps.push((d3.indexOf('✅')===0 ? '✅ ' : '❌ ') + '勾選套用 → '+d3);
    steps.push((checkbox === false ? '✅ ' : '❌ ') + '勾選框已自動彈回未勾選');

    const after = readOrderRows().find(function(r){ return r.orderNo === orderNo; });
    const items = safeParse(after.itemsJson, []);
    const a = items.find(function(i){ return i.sku==='TSKU-A'; });
    const y = items.find(function(i){ return i.sku==='TSKU-Y'; });
    steps.push((a && a.qty===1 ? '✅ ' : '❌ ') + '數量已改為1');
    steps.push((y && y.qty===4 && y.location==='' ? '✅ ' : '❌ ') + '貨號已換且沿用原數量4、儲位已清空');

    // 3) 套用後工作區應該已經重新帶出改後內容、輸入欄清空（避免手滑重複套用）
    const regrid = sh.getRange(AMEND_FIRST_ROW, 1, 2, AMEND_LAST_COL).getValues();
    const inputsCleared = [0,1].every(function(i){
      return [AC.toSku, AC.toQty, AC.reason, AC.memo].every(function(c){
        return !String(regrid[i][c-1]||'').trim();
      }) && regrid[i][AC.check-1] === false;
    });
    steps.push((inputsCleared ? '✅ ' : '❌ ') + '套用後輸入欄與勾選都已清空，不會被重複套用');

    // 4) 已出貨的訂單要擋下來
    ordersSh.getRange(testRow, colOf(ORDERS_HEADER,'status')).setValue(statusToText('shipped'));
    const blocked = applyAmendSheet_(sh, orderNo);
    steps.push((blocked.indexOf('❌')===0 ? '✅ ' : '❌ ') + '已出貨的訂單被擋下：'+blocked);
  }catch(err){
    steps.push('❌ 例外：' + err);
  }finally{
    ordersSh.deleteRow(testRow);
    clearAmendGrid_(sh);
    sh.getRange('B2').clearContent();
    sh.getRange('D2:D3').clearContent();
    sh.getRange('B3').setValue(false);
    cleanupTestSysLogRows_();
  }
  return {全部通過: steps.every(function(s){ return s.indexOf('✅')===0; }), 明細: steps};
}

// 測試用的訂單會在系統紀錄留下修改紀錄，不清掉的話儀表板的「本日訂單修改」
// 會列出一堆 TEST- 開頭的假資料，看的人分不出哪些是真的。
// 由後往前刪，才不會刪掉一列之後後面的列號整個往上位移。
function cleanupTestSysLogRows_(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SYSLOG);
  if(!sh) return 0;
  const lastRow = sh.getLastRow();
  if(lastRow < 2) return 0;
  const col = colOf(SYSLOG_HEADER, 'orderNo');
  const values = sh.getRange(2, col, lastRow - 1, 1).getValues();
  let removed = 0;
  for(let i = values.length - 1; i >= 0; i--){
    if(String(values[i][0]||'').indexOf('TEST-') === 0){ sh.deleteRow(i + 2); removed++; }
  }
  return removed;
}

// 「需注意」改成往右續接之後，第13~24筆用 QUERY 的 offset 取。
// 這種公式最容易在邊界出事：沒有資料時 QUERY 會不會噴 #VALUE、剛好12筆時續接區
// 是不是真的空的、超過24筆時提示會不會出現——用真的資料在暫存分頁上跑一遍，
// 不要等某天出貨爆量才在正式儀表板上發現。跑完把暫存分頁刪掉。
function testFlaggedSpill_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const name = '__spill_test';
  const old = ss.getSheetByName(name);
  if(old) ss.deleteSheet(old);
  const sh = ss.insertSheet(name);
  const steps = [];
  try{
    const src = `FILTER($A$2:$D,$A$2:$A<>"")`;
    sh.getRange('F1').setFormula(`=ARRAY_CONSTRAIN(IFERROR(${src},"目前沒有需要注意的紀錄"),12,4)`);
    sh.getRange('L1').setFormula(`=ARRAY_CONSTRAIN(IFERROR(QUERY(${src},"offset 12",0),""),12,4)`);
    sh.getRange('R1').setFormula(
      `=IF(IFERROR(ROWS(${src}),0)>24,"⚠ 還有 "&(ROWS(${src})-24)&" 筆未顯示","")`
    );
    // 期望值：[第一區筆數, 續接區筆數, 提示文字有沒有出現]
    const cases = [[0,1,0,false], [5,5,0,false], [12,12,0,false],
                   [13,12,1,false], [24,12,12,false], [30,12,12,true]];
    cases.forEach(function(c){
      const n = c[0];
      sh.getRange('A2:D100').clearContent();
      if(n > 0){
        const rows = [];
        for(let i = 1; i <= n; i++) rows.push(['單'+i, '人'+i, '結果'+i, '差異'+i]);
        sh.getRange(2, 1, n, 4).setValues(rows);
      }
      SpreadsheetApp.flush();
      const left  = sh.getRange('F1:F12').getDisplayValues().filter(function(r){ return String(r[0]).trim(); }).length;
      const right = sh.getRange('L1:L12').getDisplayValues().filter(function(r){ return String(r[0]).trim(); }).length;
      const hint  = String(sh.getRange('R1').getDisplayValue()||'').trim();
      const hintShown = hint.length > 0;
      const ok = left === c[1] && right === c[2] && hintShown === c[3];
      steps.push((ok ? '✅ ' : '❌ ') + n + ' 筆 → 左區' + left + '（期望' + c[1] + '）'
        + '／右區' + right + '（期望' + c[2] + '）'
        + '／提示' + (hintShown ? ('「' + hint + '」') : '無') + (c[3] ? '（期望有）' : '（期望無）'));
      // 任何一格出現錯誤值都要抓出來——公式回 #VALUE 但筆數剛好對得上是有可能的
      const cells = sh.getRange('F1:R12').getDisplayValues();
      const bad = [];
      cells.forEach(function(r){ r.forEach(function(v){
        if(/^#(REF|N\/A|ERROR|VALUE|NAME|DIV)/.test(String(v))) bad.push(String(v));
      }); });
      if(bad.length) steps.push('❌ ' + n + ' 筆時出現錯誤值：' + bad.slice(0,3).join(','));
    });
  }catch(err){
    steps.push('❌ 例外：' + err);
  }finally{
    const t = ss.getSheetByName(name);
    if(t) ss.deleteSheet(t);
  }
  return {全部通過: steps.every(function(x){ return x.indexOf('✅') === 0; }), 明細: steps};
}

function setupAmendSheet_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_AMEND);
  if(!sh) sh = ss.insertSheet(SHEET_AMEND);
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  sh.clear();
  sh.clearNotes();
  // clear() 不會清掉資料驗證。欄位一旦挪動位置，舊的下拉選單會留在原本那一欄，
  // 然後擋下寫進去的新內容——實際踩到的錯：原因欄從F移到H之後，
  // 舊的驗證還留在F，寫圖片公式進F直接噴「請從清單選一個原因」，整個重建中途失敗。
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearDataValidations();
  try{ sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).removeCheckboxes(); }catch(e){}

  sh.getRange('A1:J1').merge();
  sh.getRange('A1').setValue('✏️ 訂單品項人工修改（缺貨不出／客人改單／盤差）')
    .setFontSize(14).setFontWeight('bold').setBackground('#fff2cc');

  sh.getRange('A2').setValue('訂單號').setFontWeight('bold');
  sh.getRange('B2').setNumberFormat('@'); // 訂單號有純數字開頭的，設文字格式才不會被吃掉前導零
  sh.getRange('C2').setValue('← 貼上訂單號後，下面會自動帶出原始品項').setFontColor('#666666');
  sh.getRange('A3').setValue('套用').setFontWeight('bold');
  sh.getRange('B3').insertCheckboxes().setValue(false);
  sh.getRange('C3').setValue('← 勾好要改的品項並填完內容之後，勾這一格送出；勾完會自動彈回並顯示結果')
    .setFontColor('#666666');
  sh.getRange('A4:J4').merge();
  sh.getRange('A4').setValue([
      '① 先勾選「要改」的那幾列，沒勾的維持原樣不會被動到。',
      '② 填法：只改數量 → 只填「改成數量」；換商品 → 填「改成貨號」（要改數量再填數量）；',
      '　 整件不出 → 「改成數量」填 0；客人加購 → 在空白列勾選並填「改成貨號」和「改成數量」。',
      '已出貨的訂單不能改；正在掃描中的訂單會擋下來，請先請人員中止再改。'
    ].join('\n'))
    .setFontSize(10).setFontColor('#666666').setWrap(true).setVerticalAlignment('middle');
  sh.setRowHeight(4, 64);

  // 圖片欄擺在對應貨號的右邊：換貨號時看著圖挑，不是憑貨號字串猜。
  // 今天四筆修改全部都是「缺貨改出替代品」，正是最需要看圖的情境。
  const header = ['要改','原貨號','圖','原品名','原數量','改成貨號','圖','改成數量','原因（下拉）','備註'];
  sh.getRange(5, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#f3f3f3');
  // 每一列一個勾選框。一張訂單常常只有一兩項要改，其餘完全不該被碰——
  // 沒有這個勾選的話，判斷「這列要不要改」只能靠「右邊有沒有填東西」，
  // 手滑在不該動的列打了一個字就會被當成要修改。
  sh.getRange(AMEND_FIRST_ROW, AC.check, AMEND_MAX_ROWS, 1).insertCheckboxes();
  // 原因欄裝下拉選單。setAllowInvalid(false) 是刻意的：允許亂填就等於沒有選單，
  // 之後在儀表板上按原因分類統計會又回到各寫各的。
  sh.getRange(AMEND_FIRST_ROW, AC.reason, AMEND_MAX_ROWS, 1).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(AMEND_REASONS, true)
      .setAllowInvalid(false)
      .setHelpText('請從清單選一個原因；細節寫在右邊的「備註」欄')
      .build()
  );
  // 圖片用公式即時查對照表，不要在載入品項時把網址寫死進儲存格：
  // 寫死的話「改成貨號」改了圖不會跟著換，看著舊圖做決定比沒有圖更危險。
  // 對照表查不到就留白（IFERROR），不要顯示破圖。
  // 用陣列拼再 join，不要一路 '+' 串：這條公式裡同時有雙引號（Excel字串）跟單引號（分頁名），
  // 混在一起的跳脫很容易寫錯，而且錯了是公式壞掉、不是程式報錯。
  const Q = '"';
  const imgFormula = function(row, skuCol){
    const cell = '$' + skuCol + row;
    return [
      '=IF(', cell, '=', Q, Q, ',', Q, Q, ',',
      'IFERROR(IMAGE(', Q, PRODUCT_IMAGE_PREFIX, Q, '&',
      'VLOOKUP(', cell, ",'", SHEET_PRODUCT_IMAGE, "'!$A:$B,2,FALSE)&", Q, '_tn', Q,
      ',1),', Q, Q, '))'
    ].join('');
  };
  for(let r = AMEND_FIRST_ROW; r < AMEND_FIRST_ROW + AMEND_MAX_ROWS; r++){
    sh.getRange(r, AC.img1).setFormula(imgFormula(r, acLetter_(AC.sku)));
    sh.getRange(r, AC.img2).setFormula(imgFormula(r, acLetter_(AC.toSku)));
    sh.setRowHeight(r, 60);   // 縮圖要看得清楚，列高不能是預設的21px
  }
  sh.getRange(AMEND_FIRST_ROW, AC.qty, AMEND_MAX_ROWS, 1).setNumberFormat('0');
  sh.getRange(AMEND_FIRST_ROW, AC.toQty, AMEND_MAX_ROWS, 1).setNumberFormat('0');
  // 貨號欄一律文字格式：有些貨號是純數字，被當成數字會掉前導零、也會變科學記號
  sh.getRange(AMEND_FIRST_ROW, AC.sku, AMEND_MAX_ROWS, 1).setNumberFormat('@');
  sh.getRange(AMEND_FIRST_ROW, AC.toSku, AMEND_MAX_ROWS, 1).setNumberFormat('@');
  // 要填的四欄給底色，一眼看得出哪裡是輸入區（圖片欄是公式算的，不上底色）
  sh.getRange(AMEND_FIRST_ROW, AC.toSku, AMEND_MAX_ROWS, 1).setBackground('#fff9e6');
  sh.getRange(AMEND_FIRST_ROW, AC.toQty, AMEND_MAX_ROWS, 3).setBackground('#fff9e6');
  sh.getRange(AMEND_FIRST_ROW, AC.check, AMEND_MAX_ROWS, 1)
    .setBackground('#e8f0fe').setHorizontalAlignment('center');

  [55, 140, 70, 300, 70, 160, 70, 80, 200, 220].forEach(function(w, i){ sh.setColumnWidth(i+1, w); });
  sh.setFrozenRows(5);
  return {ok:true, 分頁: SHEET_AMEND};
}

// 把某張訂單目前的品項帶進工作區。回傳訊息字串，直接寫在狀態欄給人看。
function loadOrderIntoAmendSheet_(sh, orderNo){
  clearAmendGrid_(sh);
  if(!orderNo) return '';
  const rows = readOrderRows();
  const row = rows.find(function(r){ return String(r.orderNo||'').trim() === orderNo; });
  if(!row) return '❌ 找不到這張訂單（可能已歸檔或訂單號有誤）';
  if(row.status === 'shipped') return '❌ 這張訂單已經出貨，不能再改品項';
  const items = safeParse(row.itemsJson, []);
  if(!items.length) return '⚠️ 這張訂單沒有品項資料';
  // B欄跟F欄是圖片公式，不能被覆蓋掉——所以分段寫入，跳過那兩欄
  const out = items.slice(0, AMEND_MAX_ROWS);
  out.forEach(function(it, i){
    const row = AMEND_FIRST_ROW + i;
    sh.getRange(row, AC.check).setValue(false);
    sh.getRange(row, AC.sku).setValue(it.sku || '');
    sh.getRange(row, AC.name, 1, 2).setValues([[it.baseName || it.name || '', it.qty || 0]]);
    sh.getRange(row, AC.toSku).setValue('');
    sh.getRange(row, AC.toQty, 1, 3).setValues([['', '', '']]);
  });
  const warn = row.status === 'scanning'
    ? '⚠️ 這張訂單正在被「'+(row.claimedBy||'?')+'」掃描中，改之前請先請他中止'
    : '';
  const prev = String(row.itemsOverrideJson||'').trim();
  const prevNote = prev && prev !== '[]' ? '（這張先前已經改過 '+safeParse(prev,[]).length+' 項，下面顯示的是改過之後的內容）' : '';
  return ('✅ 已帶出 '+out.length+' 個品項　'+warn+prevNote).trim();
}

// 清工作區但保留B、F兩欄的圖片公式。用 clearContent() 掃過整片會把公式也清掉，
// 圖就再也不會出現了——而且畫面上只是「沒有圖」，不會有任何錯誤訊息。
function clearAmendGrid_(sh){
  sh.getRange(AMEND_FIRST_ROW, AC.check, AMEND_MAX_ROWS, 1).setValue(false);
  sh.getRange(AMEND_FIRST_ROW, AC.sku, AMEND_MAX_ROWS, 1).clearContent();
  sh.getRange(AMEND_FIRST_ROW, AC.name, AMEND_MAX_ROWS, 3).clearContent();  // 品名/數量/改成貨號
  sh.getRange(AMEND_FIRST_ROW, AC.toQty, AMEND_MAX_ROWS, 3).clearContent(); // 數量/原因/備註
}

// 讀工作區、組出修改指令、寫回訂單。回傳給使用者看的結果訊息。
function applyAmendSheet_(sh, orderNo){
  if(!orderNo) return '❌ 請先填訂單號';
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ordersSh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readOrderRows();
  const row = rows.find(function(r){ return String(r.orderNo||'').trim() === orderNo; });
  if(!row) return '❌ 找不到這張訂單';
  if(row.status === 'shipped') return '❌ 這張訂單已經出貨，不能再改品項';
  if(row.status === 'scanning'){
    return '❌ 這張訂單正在被「'+(row.claimedBy||'?')+'」掃描中。'
      + '現在改的話他手機上那份不會跟著變，掃到最後會對不起來——請先請他中止再改。';
  }
  const grid = sh.getRange(AMEND_FIRST_ROW, 1, AMEND_MAX_ROWS, AMEND_LAST_COL).getValues();
  const nameMap = skuNameMap_();
  const ops = [], notes = [], missingReason = [], checkedButEmpty = [], filledButUnchecked = [];
  grid.forEach(function(r){
    const checked = r[AC.check - 1] === true;
    const from = String(r[AC.sku - 1]||'').trim();
    const toSku = String(r[AC.toSku - 1]||'').trim();
    const rawQty = r[AC.toQty - 1];
    const qtyRaw = String(rawQty === 0 ? '0' : (rawQty||'')).trim();
    const reason = String(r[AC.reason - 1]||'').trim();
    const memo = String(r[AC.memo - 1]||'').trim();
    const hasInput = !!toSku || qtyRaw !== '';
    // 勾了卻沒填、填了卻沒勾，兩種都當成錯誤停下來問，不要自己猜。
    // 靜靜略過的話，人以為改好了、實際上沒改，等到出貨才發現——那時貨都揀完了。
    if(checked && !hasInput){ checkedButEmpty.push(from || '（空白列）'); return; }
    if(!checked && hasInput){ filledButUnchecked.push(from || toSku); return; }
    if(!checked) return;                            // 沒勾就是不動這一列
    const qty = qtyRaw === '' ? null : Number(qtyRaw);
    if(qtyRaw !== '' && (isNaN(qty) || qty < 0)){
      notes.push('「'+(from||toSku)+'」的數量填了「'+qtyRaw+'」，不是有效數字，這一列略過');
      return;
    }
    if(!from && !toSku) return;
    if(!reason){ missingReason.push(from || toSku); return; }
    // 這一句會原封不動寫進出貨紀錄的「差異明細」，所以要自己讀得懂、不依賴上下文。
    const what = !from ? ('加出 '+toSku+' × '+(qty===null?1:qty))
      : qty === 0 ? ('不出 '+from)
      : toSku ? (from+' 改出 '+toSku+(qty===null?'':' × '+qty))
      : (from+' 數量改為 '+qty);
    const desc = what + '（' + reason + (memo ? '：'+memo : '') + '）';
    ops.push({sku: from, toSku: toSku, qty: qty, name: toSku ? (nameMap[toSku] || '') : '',
              reason: reason, memo: memo, desc: desc, at: nowStamp_()});
    notes.push(desc);
  });
  if(checkedButEmpty.length){
    return '❌ 這幾列勾了「要改」卻沒填內容：' + checkedButEmpty.join('、')
      + '。請填「改成貨號」或「改成數量」，或把勾勾取消。';
  }
  if(filledButUnchecked.length){
    return '❌ 這幾列填了內容卻沒勾「要改」：' + filledButUnchecked.join('、')
      + '。沒勾的列一律不會被修改——確定要改的話請勾起來，不改的話請把內容清掉。';
  }
  if(missingReason.length){
    return '❌ 這幾列還沒選「原因」：' + missingReason.join('、')
      + '。原因會寫進出貨紀錄的差異明細，沒有原因的修改事後查不出所以然，所以一律要選。';
  }
  if(!ops.length) return '⚠️ 沒有勾選任何要修改的品項';

  // 工作區顯示的是「目前的品項」＝ 已經套過舊指令的結果，所以這次的指令要接在舊的後面，
  // 不能取代舊的：舊指令描述的是「原始來源 → 目前」，取代掉的話同步時會退回原始內容。
  const prevOps = safeParse(String(row.itemsOverrideJson||''), []);
  const allOps = prevOps.concat(ops);
  const baseItems = safeParse(row.itemsJson, []);
  const newItems = applyItemOps_(baseItems, ops);
  if(!newItems.length) return '❌ 改完之後這張訂單一件商品都不剩，這種情況請改用「人工結案」把整張訂單結掉';

  const summary = summarizeItems(newItems);
  const rowObj = Object.assign({}, row, {
    itemsJson: JSON.stringify(newItems),
    skuSummary: summary.skuSummary,
    nameSummary: summary.nameSummary,
    status: statusToText(row.status),
    updatedAt: new Date().toISOString(),
    itemsOverrideJson: JSON.stringify(allOps)
  });
  ordersSh.getRange(row._row, 1, 1, ORDERS_HEADER.length)
    .setValues([ORDERS_HEADER.map(function(h){ return rowObj[h]; })]);
  appendSysLog_('訂單品項人工修改', orderNo, '', notes.join('；'));
  rebuildOrderDetailSheet_();

  // 套用完重新帶出一次，讓人直接看到改完的結果，也把輸入欄清空避免重複套用
  loadOrderIntoAmendSheet_(sh, orderNo);
  return '✅ 已套用 '+ops.length+' 項修改：'+notes.join('；')+'　（APP下次更新就會拿到）';
}

// 簡單觸發器：主管在分頁上打字就會跑，不用去按選單。
// 只認「訂單修改」這一個分頁的B2（訂單號）和B3（套用勾選框），其他編輯一律立刻返回——
// 這個函式在整份試算表的每一次編輯都會被呼叫，慢一點就會拖累所有人打字。
// 選單是 onEdit 的備援。onEdit 是簡單觸發器，權限受限、也可能被「保護範圍」之類的設定擋掉；
// 選單項目則是以操作者本人的身分執行，權限完整。兩條路呼叫的是同一組函式。
function onOpen(){
  SpreadsheetApp.getUi()
    .createMenu('出貨系統')
    .addItem('帶出訂單品項（讀 B2 的訂單號）', 'menuLoadAmendOrder')
    .addItem('套用訂單修改', 'menuApplyAmend')
    .addToUi();
}
function menuLoadAmendOrder(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_AMEND);
  if(!sh) return;
  const orderNo = String(sh.getRange('B2').getValue()||'').trim();
  sh.getRange('D2').setValue(loadOrderIntoAmendSheet_(sh, orderNo));
}
function menuApplyAmend(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_AMEND);
  if(!sh) return;
  const orderNo = String(sh.getRange('B2').getValue()||'').trim();
  let msg;
  try{ msg = applyAmendSheet_(sh, orderNo); }
  catch(err){ msg = '❌ 套用失敗：' + err; }
  sh.getRange('D3').setValue(msg);
  SpreadsheetApp.getUi().alert(msg);
}

function onEdit(e){
  try{
    if(!e || !e.range) return;
    const sh = e.range.getSheet();
    if(sh.getName() !== SHEET_AMEND) return;
    const a1 = e.range.getA1Notation();
    if(a1 === 'B2'){
      const orderNo = String(e.range.getValue()||'').trim();
      sh.getRange('D2').setValue(loadOrderIntoAmendSheet_(sh, orderNo));
      return;
    }
    if(a1 === 'B3'){
      if(e.range.getValue() !== true) return;
      const orderNo = String(sh.getRange('B2').getValue()||'').trim();
      let msg;
      try{ msg = applyAmendSheet_(sh, orderNo); }
      catch(err){ msg = '❌ 套用失敗：' + err; }
      sh.getRange('B3').setValue(false); // 勾選框只是按鈕，用完馬上彈回來，避免以為還沒套
      sh.getRange('D3').setValue(msg);
    }
  }catch(err){
    // 觸發器裡不能讓例外靜靜消失，寫進系統紀錄才查得到
    try{ appendSysLog_('onEdit 例外', '', '', String(err)); }catch(e2){}
  }
}

// ---------------- 揀貨完成：這張單的貨已經揀齊、放到包貨區 ----------------
// 為什麼需要這一步：逐件點掉只知道「每一件幾點被揀」，不知道「這張什麼時候可以包」。
// 沒有這個時間點就沒辦法回答「揀完到包完隔多久」「現在有幾張躺在包貨區等人包」，
// 而那正是現場塞車時最想知道的兩件事。
// 狀態刻意不動：訂單狀態的權威在掃描出貨那條路徑，揀貨完成只是多一個時間戳，
// 兩邊各記各的才不會互相蓋掉。
// 揀貨結果的分類。順序＝嚴重程度，先命中的優先——跟出貨那邊的 classifyVerifyStatus_ 一樣的思路。
//   漏點完成：按了完成但還有文山品項沒點，貨到底有沒有進盒子沒人知道，最嚴重
//   調撥未到齊：文山的部分做完了，但還在等別的門店，屬於正常狀態但不能直接包
//   有取消：過程中點錯又改，通常沒事，但重複發生代表流程或標示有問題
function classifyPickResult_(d){
  if(d.unpicked > 0) return '漏點完成 🔴';
  if(d.transferPending > 0) return '待調入 🟠';
  if(d.cancelCount > 0 || d.scanMiss > 0) return '完成（過程有修正） 🟠';
  return '完成 🟢';
}
function buildPickDifference_(d){
  const parts = [];
  if(d.unpicked > 0) parts.push('未點到 ' + d.unpicked + ' 件（文山）');
  if(d.transferPending > 0) parts.push('調撥未到 ' + d.transferPending + ' 件');
  if(d.cancelCount > 0) parts.push('取消揀貨 ' + d.cancelCount + ' 次');
  if(d.scanMiss > 0) parts.push('掃到不屬於此單 ' + d.scanMiss + ' 次');
  return parts.length ? parts.join('；') : '無差異';
}

// 這張單在揀貨紀錄裡出現過幾次「取消揀貨」「掃描不符」。
// 從紀錄算而不是靠前端傳：人員可能中途重整頁面、換裝置，前端記的次數會歸零，
// 而紀錄不會。
function countPickEvents_(orderNo){
  const rows = readRows(SHEET_PICKLOG, PICKLOG_HEADER);
  let cancel = 0, miss = 0;
  rows.forEach(function(r){
    if(String(r.orderNo||'').trim() !== orderNo) return;
    const a = String(r.action||'');
    if(a === '取消揀貨') cancel++;
    else if(a === '掃描不符') miss++;
  });
  return {cancelCount: cancel, scanMiss: miss};
}

function markPickDone(body){
  const orderNo = String((body && body.orderNo) || '').trim();
  if(!orderNo) return {ok:false, error:'missing orderNo'};
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readOrderRows();
  const row = rows.find(function(r){ return String(r.orderNo||'').trim() === orderNo; });
  if(!row) return {ok:false, reason:'not_found'};
  if(row.status === 'shipped') return {ok:false, reason:'already_shipped'};

  const undo = !!(body && body.undo);
  const atCol = colOf(ORDERS_HEADER, 'pickDoneAt');
  const byCol = colOf(ORDERS_HEADER, 'pickDoneBy');
  const time = undo ? '' : (String((body && body.time) || '') || nowStamp_());
  const who = undo ? '' : String((body && body.pickerName) || (body && body.pickerId) || '');
  sh.getRange(row._row, atCol).setNumberFormat('@');
  sh.getRange(row._row, atCol, 1, 2).setValues([[time, who]]);

  // 揀貨紀錄留一筆，跟逐件的紀錄放同一張表，事後看得出整張單的完整過程
  const logSh = getSheet(SHEET_PICKLOG, PICKLOG_HEADER);
  const counts = countPickEvents_(orderNo);
  const detail = {
    unpicked: Number((body && body.unpicked) || 0),
    transferPending: Number((body && body.transferPending) || 0),
    cancelCount: counts.cancelCount,
    scanMiss: counts.scanMiss
  };
  const o = {
    logTime: undo ? nowStamp_() : time, orderNo: orderNo, sku: '', baseName: '（整張訂單）',
    location: '', qty: '', pickerId: String((body && body.pickerId) || ''),
    pickerName: String((body && body.pickerName) || ''),
    action: undo ? '取消揀貨完成' : '揀貨完成',
    kind: '整單',
    result: undo ? '' : classifyPickResult_(detail),
    differenceDetails: undo ? '' : buildPickDifference_(detail)
  };
  const start = logSh.getLastRow() + 1;
  logSh.getRange(start, 1, 1, PICKLOG_HEADER.length)
       .setValues([PICKLOG_HEADER.map(function(h){ return o[h]; })]);
  return {ok:true, orderNo: orderNo, pickDoneAt: time, pickDoneBy: who,
          揀貨結果: o.result, 差異明細: o.differenceDetails};
}

// 掃到不屬於這張單的條碼也要留下來。原本只在畫面上閃一下就沒了，
// 於是「這個人今天掃錯幾次」「哪個商品最常被掃錯」完全查不到，
// 而那正是判斷「是不是兩款商品長太像」的線索。
function logPickScanMiss(body){
  const code = String((body && body.code) || '').trim();
  if(!code) return {ok:false, error:'missing code'};
  const sh = getSheet(SHEET_PICKLOG, PICKLOG_HEADER);
  const o = {
    logTime: String((body && body.time) || '') || nowStamp_(),
    orderNo: String((body && body.orderNo) || ''), sku: code,
    baseName: '（掃到不屬於此' + (body && body.mode === 'batch' ? '批次' : '訂單') + '的條碼）',
    location: '', qty: '', pickerId: String((body && body.pickerId) || ''),
    pickerName: String((body && body.pickerName) || ''),
    action: '掃描不符', kind: '', result: '', differenceDetails: ''
  };
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 1, 1, PICKLOG_HEADER.length)
    .setValues([PICKLOG_HEADER.map(function(h){ return o[h]; })]);
  return {ok:true};
}

// ---------------- 已進物流籃卻還掛在待出貨的訂單，自動結案 ----------------
// 為什麼會有這種訂單：物流籃掃描（來源的統計V2）是舊系統的包貨完成確認。
// 有人用舊流程包完、把訂單號掃進物流籃，貨就跟著出去了，但我們這套系統從頭到尾沒被碰過，
// 狀態就一直停在「待出貨」。實際查過的例子：2608101FY04R1R 在來源的包貨時間是 11:40:23，
// 跟我們記到的物流籃時間一模一樣，但出貨紀錄裡完全沒有這張單。
//
// 不處理的後果比誤判嚴重：那張單會一直留在待出貨清單和揀貨清單裡，
// 揀貨員看到就會再揀一次、再包一次 —— 重複出貨的成本遠高於漏出貨。
// 而且物流籃是實體流程的最後一步，掃進去就代表貨已經離開了，證據夠強。
//
// 只動「待出貨」的：掃描中代表現在有人正在處理（他等一下自己會完成），不能抽掉。
function closeBasketConfirmedPending_(){
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readOrderRows();
  const col = colOf(ORDERS_HEADER, 'manualClose');
  const hits = rows.filter(function(r){
    return r.status === 'pending'
      && !String(r.manualClose||'').trim()
      && String(r.logisticsConfirmed||'').indexOf('已進') === 0;
  });
  if(!hits.length) return {已結案: 0};

  hits.forEach(function(r){ sh.getRange(r._row, col).setValue('出貨完成'); });
  const logSh = getSheet(SHEET_SYSLOG, SYSLOG_HEADER);
  const start = logSh.getLastRow() + 1;
  const now = nowStamp_();
  logSh.getRange(start, colOf(SYSLOG_HEADER,'logTime'), hits.length, 1).setNumberFormat('@');
  const logRows = hits.map(function(r){
    const o = {
      logTime: now, event: '已進物流籃自動結案', orderNo: r.orderNo, claimedBy: '',
      detail: '訂單已掃進物流籃（' + String(r.logisticsTime||'') + '）＝已包貨出貨，'
        + '但本系統沒有出貨紀錄，代表是用舊流程包的。自動標記為「出貨完成」以免留在待出貨清單裡被重複揀貨。'
        + '如果是誤掃物流籃，把「人工結案」欄清空即可還原。'
    };
    return SYSLOG_HEADER.map(function(h){ return o[h]; });
  });
  logSh.getRange(start, 1, logRows.length, SYSLOG_HEADER.length).setValues(logRows);
  Logger.log('已進物流籃自動結案 ' + hits.length + ' 張');
  return {已結案: hits.length, 訂單號: hits.map(function(r){ return r.orderNo; })};
}

// ---------------- 依訂單日期批次結案（清舊帳用） ----------------
// 用途：待出貨清單裡積了幾天前的老訂單，實際上早就在系統外處理掉了（別的管道出貨、
// 客服取消、調撥後直接寄出沒回頭掃描…），主管要一次把某個日期以前的清掉。
//
// 跟 batchCloseOtherWarehouseOrders_ 一樣，這個動作是「代替人宣告結果」而不是驗證結果，
// 所以每一筆都寫進系統紀錄，事後查得到是哪一次批次、用什麼條件、標了什麼原因。
// 反悔的話把「人工結案」欄清空即可，訂單會自己回到待出貨清單（同步不會覆蓋這一欄）。
//
// 參數 arg：{before:'2026/8/10', reason:'出貨完成', dryRun:true}
//   before  必填，只結案「訂單日期 < 這一天」的（不含當天）
//   reason  必填，必須是「人工結案」下拉選單裡的值，不然試算表驗證會擋掉
//   dryRun  true 時只回傳會被動到哪些訂單，不寫入
// 日期欄存的是「2026/8/6」這種純文字，先轉成 yyyymmdd 數字再比，避免字串比大小
// 把「2026/8/9」排在「2026/8/10」後面（字串比對是逐字元比，'9' > '1'）。
function ymdKey_(s){
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(String(s||'').trim());
  if(!m) return null; // 日期空白或格式不明的一律回 null，由呼叫端決定要不要碰——不猜
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}
function batchCloseOrdersBefore_(arg){
  const opt = arg || {};
  const cutoff = ymdKey_(opt.before);
  const reason = String(opt.reason||'').trim();
  if(!cutoff) return {ok:false, error:'before 必須是 yyyy/M/d 格式的日期'};
  if(MANUAL_CLOSE_OPTIONS.indexOf(reason) < 0){
    return {ok:false, error:'reason 必須是下拉選單裡的值：' + MANUAL_CLOSE_OPTIONS.join('／')};
  }
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readOrderRows();
  const col = colOf(ORDERS_HEADER, 'manualClose');
  // 只動「待出貨」——掃描中代表現在有人正在處理，結掉會把人家做到一半的工作抽掉；
  // 已出貨的本來就不在清單上。日期空白的也跳過：不知道是哪一天的，不能替它決定。
  const skippedNoDate = [];
  const hits = rows.filter(function(r){
    if(r.status !== 'pending') return false;
    if(String(r.manualClose||'').trim()) return false;
    const k = ymdKey_(r.date);
    if(k === null){ skippedNoDate.push(r.orderNo); return false; }
    return k < cutoff;
  });
  const detailOf = function(r){
    return [r.orderNo, r.date, (r.store||'(未指定)'), (r.routingStatus||'-')].join(' | ');
  };
  if(!hits.length){
    return {ok:true, 已結案:0, 說明:'沒有訂單日期早於 '+opt.before+' 的待出貨訂單', 日期空白未處理:skippedNoDate};
  }
  if(opt.dryRun){
    return {ok:true, dryRun:true, 將結案:hits.length, 原因:reason,
            清單:hits.map(detailOf), 日期空白未處理:skippedNoDate};
  }

  hits.forEach(function(r){ sh.getRange(r._row, col).setValue(reason); });

  const logSh = getSheet(SHEET_SYSLOG, SYSLOG_HEADER);
  const start = logSh.getLastRow() + 1;
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const now = Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd HH:mm:ss');
  logSh.getRange(start, colOf(SYSLOG_HEADER,'logTime'), hits.length, 1).setNumberFormat('@');
  const logRows = hits.map(function(r){
    const o = {
      logTime: now, event: '批次人工結案（依日期）', orderNo: r.orderNo, claimedBy: '',
      detail: '訂單日期 ' + r.date + '（出貨地「' + String(r.routingStatus||'') + '」）早於 '
        + opt.before + '，依指示批次標記為「' + reason + '」以清出待出貨清單。'
        + '此標記未經逐筆確認，如發現實際情況不符請以此紀錄回溯；把「人工結案」欄清空即可還原。'
    };
    return SYSLOG_HEADER.map(function(h){ return o[h]; });
  });
  logSh.getRange(start, 1, logRows.length, SYSLOG_HEADER.length).setValues(logRows);

  const byStatus = {};
  hits.forEach(function(r){
    const st = String(r.routingStatus||'').trim() || '(空白)';
    byStatus[st] = (byStatus[st]||0) + 1;
  });
  return {ok:true, 已結案:hits.length, 原因:reason, 依出貨地:byStatus,
          清單:hits.map(detailOf), 日期空白未處理:skippedNoDate};
}

// ---------------- 一次性處理：把積在待出貨清單裡的山物出／中華宅配訂單批次結案 ----------------
// 背景：訂單狀態篩選（文山＋調撥）是後來才加的，篩選只擋新進來的，不會回頭清舊的。
// 所以在那之前匯入的山物出／中華宅配訂單一直留在待出貨清單裡——那些貨不在文山，
// 揀貨員看得到卻永遠找不到，而且會一直累積。
//
// 這個動作等於代替人宣告「這些都已經由對方出掉了」，本身沒有辦法驗證，
// 所以每一筆都寫進「系統紀錄」：之後如果發現哪一張其實沒出，查得到是這次批次標記的、什麼時候做的。
// 只動 山物出／中華宅配 且尚未結案的，文山跟調撥的訂單完全不碰。
function batchCloseOtherWarehouseOrders_(){
  const targetStatus = {'山物出':1, '中華宅配':1};
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readOrderRows();
  const col = colOf(ORDERS_HEADER, 'manualClose');
  const hits = rows.filter(function(r){
    const st = String(r.routingStatus||'').trim();
    return targetStatus[st] && !String(r.manualClose||'').trim();
  });
  if(!hits.length) return {已結案:0, 說明:'沒有符合條件的訂單'};

  hits.forEach(function(r){ sh.getRange(r._row, col).setValue('出貨完成'); });

  // 整批寫一次系統紀錄，不要每筆各寫一次（38筆各來回一次會很慢）
  const logSh = getSheet(SHEET_SYSLOG, SYSLOG_HEADER);
  const start = logSh.getLastRow() + 1;
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const now = Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd HH:mm:ss');
  logSh.getRange(start, colOf(SYSLOG_HEADER,'logTime'), hits.length, 1).setNumberFormat('@');
  const logRows = hits.map(function(r){
    const o = {
      logTime: now, event: '批次人工結案', orderNo: r.orderNo, claimedBy: '',
      detail: '出貨地「' + String(r.routingStatus||'') + '」的訂單積在待出貨清單裡，'
        + '批次標記為「出貨完成」以清出清單。此標記未經逐筆確認，如發現實際未出貨請以此紀錄回溯。'
    };
    return SYSLOG_HEADER.map(function(h){ return o[h]; });
  });
  logSh.getRange(start, 1, logRows.length, SYSLOG_HEADER.length).setValues(logRows);

  const byStatus = {};
  hits.forEach(function(r){
    const st = String(r.routingStatus||'').trim();
    byStatus[st] = (byStatus[st]||0) + 1;
  });
  Logger.log('批次結案 ' + hits.length + ' 張：' + JSON.stringify(byStatus));
  return {已結案: hits.length, 依出貨地: byStatus, 訂單號: hits.map(function(r){ return r.orderNo; })};
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
  // 層號是選填的：實際資料裡有「L13牌面」「E10~12」這種寫法，那些一樣是貨架上的位置，
  // 只是沒寫到第幾層。要求一定有層號的話它們會被判成「無法解析」而排到整份清單最後面，
  // 揀貨員走到L區時看不到「L13牌面」，走完整趟才發現還有一件要回頭拿。
  // 沒寫層號的給 99，排在該貨架最後，走到那一格時順手看牌面。
  const m = first.match(/^([A-Za-z])\s*(\d{1,3})(?:\s*[-~～]\s*(\d{1,2}))?/);
  if(!m) return null;
  const aisle = m[1].toUpperCase();
  return {
    aisle: aisle,
    aisleIndex: AISLE_ORDER.indexOf(aisle), // -1 = 不在地圖上
    bay: parseInt(m[2], 10),
    level: m[3] ? parseInt(m[3], 10) : 99
  };
}

// 註：實際揀貨畫面的排序是在 index.html 由前端做的（同一套規則的另一份實作）。
// 這一份目前沒有呼叫端，留著是因為它同時也是「走動順序」這件事的規格書；
// 兩邊的解析規則要一起改，不然哪天後端要用就會跟現場走的路線對不起來。
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
  // 順序不能顛倒：要先更新完物流籃狀態，才知道哪些訂單該結案。
  // 掛在每小時而不是每天19:30，是因為留在清單裡的每一分鐘都可能被人重複揀一次。
  closeBasketConfirmedPending_();
  syncSpecialNotes_();
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

// 唯讀診斷用：評估「特殊註記」值不值得接進來——看多少訂單真的有註記、內容長什麼樣。
function inspectSpecialNotes_(){
  const ss = SpreadsheetApp.openById('1wMrjppENakDhT354VJ6-W7txoG9FSwYR2OjMzPRl2KQ');
  const sh = ss.getSheetByName('蝦proV2');
  if(!sh) return {error:'找不到蝦proV2'};
  const lastRow = sh.getLastRow();
  const v = sh.getRange(1, 1, Math.min(lastRow, 400), 16).getValues();
  const iOrder = 5, iStatus = 6, iNote = 10; // F=訂單編號, G=狀態, K=特殊註記
  let withOrder = 0, withNote = 0;
  const samples = [], byStatus = {};
  for(let i = 1; i < v.length; i++){
    const no = String(v[i][iOrder]||'').trim();
    if(!no) continue;
    withOrder++;
    const note = String(v[i][iNote]||'').trim();
    if(!note) continue;
    withNote++;
    const st = String(v[i][iStatus]||'').trim() || '(空白)';
    byStatus[st] = (byStatus[st]||0) + 1;
    if(samples.length < 12) samples.push({訂單: no, 狀態: st, 註記: note.slice(0, 60)});
  }
  return {有訂單編號的列: withOrder, 有特殊註記的列: withNote,
          比例: withOrder ? (withNote/withOrder*100).toFixed(1)+'%' : '-',
          有註記者的訂單狀態分布: byStatus, 範例: samples};
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
    const mins = Math.round((Date.now() - Date.parse(r.claimedAt)) / 60000);
    sh.getRange(r._row, colOf(ORDERS_HEADER,'status'), 1, 3).setValues([[statusToText('pending'), '', '']]);
    appendSysLog_('認領逾時自動釋放', r.orderNo, r.claimedBy,
      '認領後 '+(isNaN(Date.parse(r.claimedAt)) ? '（認領時間異常）' : mins+' 分鐘')
      +'未完成出貨，已自動放回待出貨清單（時限'+STALE_CLAIM_MINUTES+'分鐘）');
    released++;
  });
  if(released) Logger.log('認領逾時自動釋放：'+released+' 張訂單已放回待出貨清單。');
  return released;
}

// 驗證用：自己建一張「遠早於時限就被認領、之後就沒動作」的測試訂單，跑一次自動釋放看結果對不對，
// 跑完把測試訂單刪掉。用測試資料驗證才不用去動真實訂單，也不用把時限改成0（那樣在正式環境很危險，
// 真的有人員正在掃描的話會被立刻釋放掉）。確認功能正常之後這個函式可以刪掉。
function testStaleClaimRelease_(){
  const sh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const orderNo = 'TEST-STALE-' + Date.now();
  // 用時限的4倍當測試時間點，時限之後再調整也不用回頭改這裡
  const staleAt = new Date(Date.now() - STALE_CLAIM_MINUTES * 4 * 60 * 1000).toISOString();
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
    時限分鐘: STALE_CLAIM_MINUTES,
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
      '原認領人未完成出貨（超過'+STALE_CLAIM_MINUTES+'分鐘），改由「'+(staffId||'?')+'」接手掃描');
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
    // 這張訂單如果在「訂單修改」分頁被人工調整過，把調整內容一起寫進出貨紀錄的差異明細。
    // 不寫的話，事後看紀錄只會看到「完成 🟢、無差異」，完全看不出實際出的東西跟原訂單不一樣，
    // 客訴回頭查的時候會查不到為什麼少一件。APP端不知道有這回事，所以只能在這裡補。
    entry.amendSummary = amendSummary_(row.itemsOverrideJson);
    const now = new Date().toISOString();
    ordersSh.getRange(row._row, colOf(ORDERS_HEADER,'status'), 1, 4).setValues([[statusToText('shipped'), '', '', now]]);
    // 出貨的起訖時間也寫回訂單。出貨紀錄每晚20:00清空，只留在那裡的話
    // 隔天就再也算不出「這張掃了多久」，而那是要進 KPI 的。
    const ssCol = colOf(ORDERS_HEADER, 'shipStartAt');
    ordersSh.getRange(row._row, ssCol, 1, 2).setNumberFormat('@');
    ordersSh.getRange(row._row, ssCol, 1, 2)
      .setValues([[String(entry.startTime||''), String(entry.time||'')]]);
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
  // 有換貨的話，貨其實有出（只是出了別的商品），所以不該講成「少N件」。
  // 而且這張單還沒真的結束——客服要到蝦皮把訂單內容補正，訂單/發票/庫存才會一致。
  // 排在缺貨判斷之前：換貨一定伴隨缺貨標記，但它比單純缺貨更需要後續處理。
  if((Number(entry.substituteCount) || 0) > 0) return '換貨出貨（待客服補正）';
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
  // 缺貨出貨／換貨出貨都是已知情況，給橘燈（要留意但不是做錯）；真正的漏掃才給紅燈
  if(String(vs).indexOf('缺貨出貨') === 0 || String(vs).indexOf('換貨出貨') === 0) return '🟠';
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
  entry.substituteCount = items.reduce(function(sum, it){
    return sum + ((it.substitutes && it.substitutes.length) ? it.substitutes.length : 0);
  }, 0);
  const verifyStatus = classifyVerifyStatus_(entry);
  const checkResultText = buildCheckResult_(entry, verifyStatus);
  // entry.differenceDetails是「跟特定品項無關」的訂單層級事件（目前只有：掃到不屬於這張訂單的條碼），
  // 只會出現在第一列；每個品項「自己」的差異（無條碼手動核對/數量超過/人工修正）由it.itemDifferenceDetails
  // 帶過來，放在那個品項自己的列，不會像以前那樣把整張訂單所有品項的事件混在同一段文字裡重複顯示。
  let orderLevelText = (entry.differenceDetails && entry.differenceDetails !== '無差異') ? entry.differenceDetails : '';
  // 掃到不屬於這張訂單的條碼時，後面接著寫清楚「後來到底有沒有拿對商品掃進去」，
  // 這樣事後看差異明細就能直接判斷這張訂單實際出的貨對不對，不用再自己去比對件數。
  if(orderLevelText && hasMismatch_(entry)) orderLevelText += buildMismatchResolution_(entry);
  // 人工修改的說明擺在最前面：看差異明細的人要先知道「這張訂單本來就跟原始訂單不一樣」，
  // 才不會把包貨人員掃出來的結果誤判成他掃錯。
  if(entry.amendSummary) orderLevelText = [entry.amendSummary, orderLevelText].filter(Boolean).join('；');
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
      logisticsConfirmed: '', logisticsTime: '', pickedJson: '', specialNote: ''
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
    //       28包貨時間（來源是統計V2的過刷紀錄；沒過刷會是「-」，用來算「未核單數」）
    //         （這五欄決定「這件在文山揀得到嗎」——分配到別的門店的要走調撥，
    //           揀貨員在文山怎麼找都找不到，一定要標示出來，不然就是白找）
    //       31訂單狀態
    // 多抓欄位不影響既有邏輯——autoSyncOrders_ 是用表頭名稱找欄位（header.indexOf），
    // 不是用寫死的欄號，所以欄位順序變動不會讓它讀錯。
    '=CHOOSECOLS(IMPORTRANGE("1wMrjppENakDhT354VJ6-W7txoG9FSwYR2OjMzPRl2KQ","\'文山出貨V2\'!A:AE"),1,2,3,4,5,6,7,8,9,12,13,14,18,19,20,21,22,28,31)'
  );

  // 蝦proV2 的「特殊註記」：客服處理缺貨／盤差時寫的備註，例如
  //   「客取消 3076213KA4007A 缺1 直幫換 3076213KA4007C 已通知」
  // 包貨人員掃到缺貨時最需要這一行——沒有它就得停下來去問客服聯絡了沒、要換什麼。
  // 只取 F欄(訂單編號) 跟 K欄(特殊註記) 兩欄，其他欄位跟我們無關。
  let noteSh = ss.getSheetByName('蝦proV2註記');
  if(!noteSh) noteSh = ss.insertSheet('蝦proV2註記');
  noteSh.getRange('A1').setFormula(
    '=CHOOSECOLS(IMPORTRANGE("1wMrjppENakDhT354VJ6-W7txoG9FSwYR2OjMzPRl2KQ","\'蝦proV2\'!A:P"),6,11)'
  );

  // 條碼轉品號：「國際碼」分頁本身也是IMPORTRANGE鏡像，直接接到它指向的真正來源
  let barcodeSh = ss.getSheetByName('條碼轉品號');
  if(!barcodeSh) barcodeSh = ss.insertSheet('條碼轉品號');
  barcodeSh.getRange('A1').setFormula(
    '=IMPORTRANGE("1rVAAGPeTc3p4m0xpKLnByteYELW1imuhLPhJhTmbI_8","\'國際碼對照表\'!A:E")'
  );

  Logger.log('已建立「文山出貨V2」「條碼轉品號」鏡像分頁，請打開這兩個分頁手動完成一次性授權（如果有跳出提示的話）。');
}
