# 文山出貨確認系統 — 開發文件

秀山莊文山倉的出貨／揀貨／調撥驗收／儲位管理系統。

> 這份文件是在「本機開發資料夾整個遺失」之後，從原始碼逆向整理出來的完整架構備存。
> 目的是：**任何人（或任何 AI）從零接手，只讀這一份就能重建出完整的心智模型**。
>
> 版本基準：`Code.gs` @ `BACKEND_VERSION = 2026-08-26.158`／7,831 行，`index.html`／5,571 行。

---

## 目錄

1. [系統全貌](#1-系統全貌)
2. [資料模型](#2-資料模型)
3. [後端 API](#3-後端-api)
4. [前端結構](#4-前端結構)
5. [核心業務流程](#5-核心業務流程)
6. [自動排程](#6-自動排程)
7. [快取策略](#7-快取策略)
8. [效能與延遲](#8-效能與延遲)（← 目前最大的待改善項）
9. [部署](#9-部署)
10. [踩過的坑](#10-踩過的坑)

---

## 1. 系統全貌

三層，各自跑在不同地方。理解這個分層是理解一切的前提。

```
┌─────────────────────────────────────────────────────────┐
│  前端  index.html（單檔 5,571 行，含全部 CSS/JS）        │
│  部署：GitHub Pages（純靜態）                            │
│  https://arenes4127-dotcom.github.io/wenshan-shipping-confirm/ │
└───────────────────────┬─────────────────────────────────┘
                        │  fetch POST（text/plain 避開 CORS preflight）
                        ▼
┌─────────────────────────────────────────────────────────┐
│  後端  Code.gs（7,831 行）                               │
│  部署：Google Apps Script Web App                        │
│  scriptId    1KIDgqKPeVzveXky1f_6yXBjVsMvFWNMAPrhbxR67AOntEQaIZ9fmPuDD │
│  deployment  AKfycbxdzii_g-Dv59KDLIiWa2B7adWyv_JuLoBQBfP42INKYv7L6kOFtN7vseYFwHsa1RJG │
└───────────────────────┬─────────────────────────────────┘
                        │  SpreadsheetApp
                        ▼
┌─────────────────────────────────────────────────────────┐
│  資料  Google 試算表（19 個分頁）                        │
│  文山出貨確認系統-後端  1ogk_YvgJvFhjlnlF0QFiy1LaNMd89Qoe49slswk7Ubs │
└─────────────────────────────────────────────────────────┘
```

### 為什麼前端不走 HtmlService

`index.html` 是**純靜態網頁**，不是 Apps Script 的 HTML 樣板。它用 `fetch` 打後端的 `/exec`。

這個選擇的後果，每一條都要記住：

- `.claspignore` 用**白名單**把 `index.html` 擋在 Apps Script 之外（只放行 `Code.gs` + `appsscript.json`）
- 前後端**部署管道完全不同**：前端 push 到 `master` 由 GitHub Pages 自動發布；後端要跑 `deploy.sh`
- 兩邊可能不同步。所以後端有 `BACKEND_VERSION`，前端「設定 → 測試連線」會顯示它
- 跨網域，所以請求用 `Content-Type: text/plain` 避開 CORS preflight，後端自己 `JSON.parse`

### 外部相依

| 名稱 | ID | 用途 | 可否寫入 |
|---|---|---|---|
| 文山出貨確認系統-後端 | `1ogk_Yvg...` | 本系統的主資料庫，Apps Script 綁在這上面 | ✅ 完全擁有 |
| 文山核對 工作區 | `1vCCJS_iHZDUnoFFjnqiT-ZySwCoKFxx4HXRwqrmtVmU` | 使用者原生業務表（文山出貨V2／國際碼） | ❌ **唯讀，使用者交代不可修改** |
| 文山出貨 工作區 | `1wMrjppENakDhT354VJ6-W7txoG9FSwYR2OjMzPRl2KQ` | 「調撥驗收」鏡射目標 | ⚠️ 破例可寫，僅限該分頁 |
| 規格選項_圖片_貨號對應_四賣場總表 | `1DeqU2CnmM1XL-J3IudjDzc8OmMuv7Bqz` | ODM／蝦皮商品規格、價格、圖片來源 | ✅ |
| 文山核對 資料夾 | `1quwo_65K5YQMZtuLD-vkheg-g97kYond` | 上述檔案所在；也放 `index.html` 離線備援副本 | ✅ |

### 前端資產

| 檔案 | 用途 |
|---|---|
| `zbar-wasm.min.js` + `zbar.wasm` | 相機掃描的條碼解碼引擎（ZBar 編譯成 WebAssembly） |
| `barcode-detector-polyfill.min.js` | 舊瀏覽器的 `BarcodeDetector` 介面補丁 |

兩者都 **vendor 進 repo 同網域**，不走外部 CDN——倉庫網路只放行自己網域。
載入路徑帶 `?v=ZBAR_ASSET_VERSION` 做 cache-busting，改檔案內容時要記得同步改那個常數。

---

## 2. 資料模型

### 分頁總覽

| 分頁 | 常數 | 欄數 | 性質 |
|---|---|---|---|
| 訂單 | `SHEET_ORDERS` | 24 | 主檔，持續更新 |
| 訂單明細 | `SHEET_DETAIL` | 5 | 每次同步重建 |
| 出貨紀錄 | `SHEET_LOG` | 24 | 累加，**每天 20:00 備份後清空** |
| 揀貨紀錄 | `SHEET_PICKLOG` | 12 | 累加 |
| 調撥單匯入 | `SHEET_TRANSFER_STAGE` | — | 人工貼上的暫存區 |
| 調撥單 | `SHEET_TRANSFER` | 15 | 主檔 |
| 調撥驗收紀錄 | `SHEET_TRANSFERLOG` | 8 | 累加 |
| 儲位異動紀錄 | `SHEET_LOCLOG` | 11 | 累加 |
| 每日統計 | `SHEET_DAILY_STATS` | 49 | 每天 20:00 寫一列 |
| KPI統計 | `SHEET_KPI` | — | 從每日統計彙總 |
| 儀表板 | `SHEET_DASHBOARD` | — | 純公式 |
| 訂單修改 | `SHEET_AMEND` | — | 人工修改**指令** |
| 人員 | `SHEET_STAFF` | 2 | APP 存檔時整份覆蓋 |
| 系統紀錄 | `SHEET_SYSLOG` | 5 | 稽核 |
| 商品主圖 | `SHEET_PRODUCT_IMAGE` | 3 | 貨號→圖片ID |
| 蝦皮資料更新 ×3 | `SHEET_SHOPEE_STAGE*` | — | 每週例行暫存 |
| 文山出貨V2 / 條碼轉品號 / 特殊註記 | — | — | IMPORTRANGE 鏡像（唯讀） |

13 張由系統自動讀寫的分頁，A1 都掛了「請勿手動更動」的附註（`systemSheetNotesMap_()`）。

### 訂單（`ORDERS_HEADER`，24 欄）

```
orderNo  store  date  itemsJson  skuSummary  nameSummary  status
claimedBy  claimedAt  updatedAt  shipMethod  routingStatus  manualClose
logisticsConfirmed  logisticsTime  pickedJson  specialNote  itemsOverrideJson
pickDoneAt  pickDoneBy
createdAt  pickStartAt  shipStartAt  shipDoneAt          ← 時間軸五欄
```

三個設計決策值得記住：

**`itemsOverrideJson` 存的是「指令」不是「結果」。**
訂單每天同步 4 次以上，每次都從來源整列重寫。直接改品項的話，下一次同步就被蓋回去。
存成「缺貨不出 / 改數量 / 換貨號 / 加品項」這種指令，來源之後又變動（客服改了數量）也還套得上。

**時間軸固定在訂單自己身上。**
進單→揀貨→出貨→進籃這幾段時間，散在揀貨紀錄／出貨紀錄裡也算得出來，但出貨紀錄每晚清空、
揀貨紀錄要掃全表，KPI 每天重算很吃力，而且過了那天就再也回不去。

**狀態欄三種格式都要讀得懂。**
`textToStatus()` 同時吃舊的英文代碼（`pending`）、純中文（`待出貨`）、中文+燈號（`待出貨 🔵`）。
這樣改顯示格式不用強制跑資料轉換。

### 出貨紀錄（`LOG_HEADER`，24 欄）

**一列一品項**。同一次出貨有 N 個品項就連續寫 N 列，訂單層級欄位（運單編號／包貨人員／完成時間）每列重複。

這是從「itemsJson 整包塞一欄」改過來的，原本另開的「出貨紀錄明細」分頁因此不需要了。

⚠️ 這張表**每天 20:00 備份到 Drive 後整個清空**。任何需要跨日查詢的東西都不能只依賴它。

### 調撥單（`TRANSFER_HEADER`，15 欄）

```
batchId  sku  baseName  spec  qty  unit  reason  price  priceTotal
extraNote  scannedQty  status  importedAt  importedBy  doneAt
```

`status` ∈ `open` / `done` / `cancelled`。
驗收核對用**品號**而非整單：現場掃到什麼就核對什麼，以 FIFO（同品號取最早匯入且未收滿的那批）扣件。

---

## 3. 後端 API

單一入口 `doPost(e)`，用 `body.action` 分派，共 **25 個 action**。

### 分派與鎖

```js
const NO_LOCK_ACTIONS = {
  lookupLocation:1, lookupLocations:1, getLocationVocab:1, findSiblingSkus:1,
  listLocationContents:1, getShopeePriceInfo:1, getTransferPending:1, __versioncheck__:1
};

function doPost(e){
  const body = JSON.parse(e.postData.contents);
  const needsLock = !NO_LOCK_ACTIONS[body.action];
  const lock = needsLock ? LockService.getScriptLock() : null;
  if(lock) lock.waitLock(10000);
  ...
}
```

只讀的動作跳過鎖。這是為了避免「一個慢查詢卡住所有人」——查詢售價效能事故就是這樣來的。

> ⚠️ **鎖只在 `doPost` 這一層取得。** 排程觸發器（`autoSyncOrders_`、`hourlySync_` 等）
> 直接呼叫業務函式，**完全不經過這把鎖**。詳見 [§8 效能與延遲](#8-效能與延遲)。

### Action 清單

| Action | 鎖 | 說明 |
|---|:-:|---|
| `mergeOrders` | 🔒 | 從鏡像同步訂單進來 |
| `claimOrder` / `releaseOrder` | 🔒 | 認領／釋放訂單（避免兩人掃同一張） |
| `finalizeShipment` | 🔒 | **完成出貨**——寫訂單狀態＋出貨紀錄 |
| `importShippedBatch` | 🔒 | 匯入已出貨試算表 |
| `markPickedBatch` / `markPickDone` | 🔒 | 揀貨打勾（批次）／揀貨完成 |
| `logPickScanMiss` | 🔒 | 揀貨掃到不在單上的東西 |
| `changeLocation` / `changeLocationBatch` | 🔒 | 儲位異動（會回寫「文山地圖」） |
| `setStaffList` | 🔒 | 人員名單（整份覆蓋） |
| `scanTransferBatch` / `closeTransferItem` | 🔒 | 調撥驗收掃描／放棄 |
| `uploadFileToDrive` / `logNetFailures` / `runOneTimeSetup` | 🔒 | 工具 |
| `refreshProductImages` | 🔒 | 手動重抓商品圖 |
| `lookupLocation(s)` / `getLocationVocab` / `findSiblingSkus` / `listLocationContents` | — | 儲位查詢 |
| `getShopeePriceInfo` | — | 查詢售價 |
| `getTransferPending` | — | 待驗收清單 |
| `__versioncheck__` | — | 部署驗證專用 |

`doGet(e)` → `getState()`：回傳 `{orders, log, staff, version}`。前端**每 20 秒**背景輪詢這一支。

### 一次性函式白名單

Apps Script 編輯器的「選取函式」下拉偶爾會卡住／漏列。`ONE_TIME_SETUP_FUNCTIONS` 開了一個白名單，
讓維護／診斷函式能用 `runOneTimeSetup` 這個 action 直接觸發：

```powershell
Invoke-RestMethod -Uri $execUrl -Method Post -ContentType "application/json" `
  -Body '{"action":"runOneTimeSetup","name":"timeSingleTransferScan_"}'
```

只有白名單內的名字可以被呼叫，不能任意呼叫檔案裡其他函式。

---

## 4. 前端結構

### 八個畫面

| view | 內容 |
|---|---|
| `home` | 儀表板、同步按鈕 |
| `scan` | **出貨流程**：掃訂單號 → 逐件掃條碼 → 掃運單編號完成 |
| `orders` | 待出貨清單、訂單資料匯入 |
| `pick` | 揀貨（單張／批次兩種模式） |
| `transfer` | 調撥驗收 |
| `loc` | 儲位查詢／異動／紀錄儲位商品／查詢售價／同款規格 |
| `log` | 出貨紀錄 |
| `settings` | 後端網址、測試連線、人員管理 |

### 狀態

```js
let orders   = loadJSON(LS.orders, {});   // 訂單全集（後端鏡像）
let log      = loadJSON(LS.log, []);      // 出貨紀錄
let staff    = loadJSON(LS.staff, [...]); // 人員
let settings = {...};                     // 後端網址等
let barcodeMap = {};                      // 條碼 → 貨號
let current  = null;                      // 正在掃描的那張訂單
```

全部鏡射到 `localStorage`。**離線可用**是設計目標：網路斷了還能繼續掃，回線後補送。

### 掃描輸入：`wireScanInput()`

全系統有 **9 個掃描點**，統一走這一支：

```js
wireScanInput(inputOrder,        scanOrder);           // 出貨：訂單號
wireScanInput(inputBarcode,      scanShipmentBarcode); // 出貨：商品條碼
wireScanInput(inputFinalWaybill, finalizeShipment);    // 出貨：運單編號
wireScanInput(pickOrderInput,    scanPickOrder);       // 揀貨：訂單號
wireScanInput(pickBarcodeInput,  handlePickScan);      // 揀貨：商品
wireScanInput(transferScanInput, transferScan);        // 調撥驗收
wireScanInput(locSkuInput,       locScan);             // 儲位
wireScanInput(priceSkuInput,     priceScan);           // 查詢售價
wireScanInput(auditScanInput,    auditScan);           // 紀錄儲位商品
```

**為什麼要這一層：** Point Mobile PM85 盤點機的 Wedge 設定送不出真正的 Enter 鍵，
而是把「`\`」「`n`」兩個**字面字元**打進輸入框。瀏覽器收不到 `keydown` 的 Enter，畫面就沒反應。

`wireScanInput` 同時監聽兩種：`keydown` 的真 Enter（一般 USB／藍牙掃描器）＋
`input` 事件裡尾端出現字面 `\n`。兩條路徑觸發完全相同的 handler。

每個掃描點旁邊還有 📷 相機按鈕，解碼出來的字串餵進**同一支** handler——
不管條碼是掃描器打進來的還是相機解出來的，判斷邏輯必須一模一樣，不能有兩套將來各自改壞。

---

## 5. 核心業務流程

### 出貨（view-scan）

```
掃訂單號
  ├─ 本機立刻進入掃描畫面、okBeep、setPill        ← 0ms
  └─ 背景 claimOrder（不擋畫面）
       └─ 失敗才 rollbackClaim（已被認領／已出貨／已人工結案）

逐件掃商品條碼
  └─ 純本機比對 current.items，完全不打後端        ← 0ms

掃運單編號 → finalizeShipment
  └─ ⚠️ 同步等後端（見 §8）
       後端：寫訂單狀態 + shipStartAt/shipDoneAt + appendLogRow
```

**認領機制**：`claimedBy` / `claimedAt`。`releaseStaleClaims_` 每 15 分鐘釋放逾時認領
（設定 30 分鐘，實際最壞 45 分鐘）。

### 揀貨（view-pick）

兩種模式：
- **single**（預設）：一次揀一張、揀完直接包
- **batch**：一趟收多張訂單的貨，回分揀台再依訂單分裝

打勾走 `pickQueue` → 2.5 秒去抖動 → `markPickedBatch` 批次送出。**樂觀更新**：點下去畫面立刻反應。

`kind` 欄位（文山／調撥）要在前端判斷再送：後端只看得到品項快照，
分不出這件是「在文山貨架上揀到」還是「等別的門店送來才確認調入」，而那兩件事的效率要分開看。

### 分配欄位

「文山出貨V2」已經依各倉庫庫存判定好每一件由誰出：

| 欄位 | 意義 |
|---|---|
| `文山分配 > 0` | 這幾件文山自己揀得到 |
| `山物/中華/OM分配 > 0` | 要從那個門店調撥過來，**揀貨員在文山怎麼找都找不到** |

四個欄位都是 0 的舊訂單一律當「文山全揀」處理。
文山一件都揀不到的品項不放進走動路線，免得人員照著儲位去找空架。

### 調撥驗收（view-transfer）

```
訂單缺貨 → 分店/他倉調貨回文山 → ERP 開調撥單
  → 人工貼進「調撥單匯入」暫存分頁 → 勾選匯入
  → 現場掃描驗收（FIFO 扣件）
  → 鏡射回「文山出貨 工作區」的調撥驗收分頁
```

掃描走 `transferQueue` → 1.2 秒去抖動 → `scanTransferBatch` 批次送出（樂觀更新，2026-08 改）。

### 儲位（view-loc）

`add` / `remove` / `move` 三種模式，`last_one` 安全鎖避免商品變成沒有儲位。

⚠️ M3架下這類**文字層級後綴**：地圖上很多位置的「層」不是數字，是「架上／架下」。
後端 `parseLocToken_` 的 level 是純數字 regex，**不能自己組字串**，一律先用查詢結果反推真正存在的位置。

---

## 6. 自動排程

`installAutomationTriggers_()` 安裝：

| 時間 | 函式 | 做什麼 |
|---|---|---|
| 07:30 每日 | `syncMissingLocationRowsDaily_` | 儲位主檔補新品號列 |
| 09:00 / 09:15 / 14:05 / 14:15 | `autoSyncOrders_` | 從鏡像同步訂單 |
| 每小時 | `hourlySync_` | 同步回舊的「文山核對 工作區－訂單」核對表 |
| 每 15 分 | `releaseStaleClaims_` | 釋放逾時認領 |
| 每 15 分 | `mirrorTransferScheduled_` | 調撥驗收鏡射保底 |
| 19:30 每日 | `dailyMaintenance_` | 歸檔已出貨訂單（**要在 20:30 來源被清空前跑**） |
| 20:00 每日 | `backupAndClearShippingLog_` | 備份出貨紀錄＋稽核表後清空 |
| 週一 06:00 | `importProductImages_` | 重抓蝦皮商品圖 |

> ⚠️ `everyMinutes()` **只接受 1/5/10/15/30**。曾經寫 `everyMinutes(20)`，
> 那個非法值讓四支排程**從加進來那天起就沒有真的被安裝過**，很久之後才發現。

### 每日備份涵蓋範圍

| 類型 | 分頁 | 策略 |
|---|---|---|
| 全量快照 | 人員／調撥單／訂單 | 既有列內容會被持續修改，每天整份複製 |
| 累加式 | 系統紀錄／揀貨紀錄／儲位異動紀錄／調撥驗收紀錄 | 一列寫入後不再修改，用 Script Properties 記上次備份到第幾列 |

---

## 7. 快取策略

三層，解決的是不同問題：

### `_ssMemo_`：同一次執行內的 openById 記憶

```js
const _ssMemo_ = {};
function openSheetMemo_(id){
  if(!_ssMemo_[id]) _ssMemo_[id] = SpreadsheetApp.openById(id);
  return _ssMemo_[id];
}
```

`SpreadsheetApp.openById` 實測 **350–570ms**。同一次執行裡重複開同一份就是白付第二次。

⚠️ 這**不是**跨請求快取。Apps Script 每次 `doGet`/`doPost` 都是全新的全域作用域。

### `_headerOk_`：同一次執行內的表頭檢查

`getSheet()` 原本每次呼叫都無條件重寫表頭（自我修復用），但那是**真正的寫入**。
改成：同一次執行只檢查一次 ＋ 先讀回比對、不同才寫。

### `CacheService`：跨請求快取

| 用途 | TTL | 效果（專案自己量到的） |
|---|---|---|
| `locIndex_` 儲位索引 | 5 分鐘 | 1.6 秒 → **46–114ms** |
| `cacheInfoFor_` 品號→列號 | — | 4 秒多 → **70–90ms** |
| `specSkuIndex_` 規格索引 | — | 解決 60k+ 列整欄重掃逾時 |
| 調撥鏡射去抖動 | 8 秒 | 連續掃描只付一次鏡射代價 |
| `getLocationVocab` | 6 小時 | — |

超過單一 key 100KB 上限的索引用 `shardedCacheKeys_` 分片。

> **這三個數字是本專案最重要的效能經驗**：把「整欄重掃」換成「索引 + 只讀需要的那一列」，
> 一律是 **20–50 倍**的差距。§8 的建議完全建立在這個已驗證的模式上。

---

## 8. 效能與延遲

> 現場回報：「前端掃描確認後再同步到後端，再到前端完成，反應速度有些會超過 10 秒。」
> 這一節是針對那個問題的完整分析。

### 8.1 先確認：哪些地方人其實不用等

這些已經是樂觀更新／背景送出，**不是**問題來源：

| 操作 | 狀態 |
|---|---|
| 出貨逐件掃商品條碼 | ✅ 純本機比對，0 網路 |
| 掃訂單號 | ✅ `claimOrder` 背景跑，不擋畫面 |
| 揀貨打勾 | ✅ `pickQueue` 2.5 秒去抖動批次送 |
| 調撥驗收掃描 | ✅ `transferQueue` 1.2 秒去抖動批次送（2026-08 改） |
| 揀貨掃到不在單上的 | ✅ `logPickScanMiss` 不 await |

### 8.2 人真正在等的地方

| 操作 | 前端 | 後端做什麼 |
|---|---|---|
| **完成出貨** `finalizeShipment` | `await`，按鈕 disabled | 搶鎖 → `readOrderRows()` **整張訂單表** → 3 次寫入 → `appendLogRow` |
| 揀貨完成 `markPickDone` | `await` | 搶鎖 → 讀訂單 → 寫 |
| 儲位確認變更 | `await` | 搶鎖 → 讀寫「文山地圖」外部試算表 |
| 同步訂單 `mergeOrders` | `await` | 搶鎖 → 讀整張 → **逐列 setValues** → 重建明細 → 重套顏色 |
| 調撥撤銷／放棄 | `await`（先 flush 佇列） | 搶鎖 |

### 8.3 「超過 10 秒」的成因

延遲是三段疊加：

```
總延遲 = Apps Script 固定開銷 + 鎖等待 + 實際工作
         (~1–2s，無法消除)    (0–10s)   (1–3s)
```

**① 鎖等待（0–10 秒）— 這是「超過 10 秒」最可能的來源**

`lock.waitLock(10000)` 這個數字跟現場回報的「超過 10 秒」吻合得太準。

全系統**共用一把 script lock**。任何一個寫入動作執行期間，其他所有寫入動作都排隊。
在倉庫尖峰（多台裝置同時出貨／揀貨／驗收）時：

- A 按完成出貨（佔用 3 秒）
- B 同時按完成出貨 → 等 3 秒才開始，自己再跑 3 秒 = **6 秒**
- C 再排在後面 = **9 秒**
- 第四個人 → `waitLock` 逾時，直接失敗

**② `readOrderRows()` 整張讀（1–3 秒）**

```js
function finalizeShipment(entry){
  const ordersSh = getSheet(SHEET_ORDERS, ORDERS_HEADER);
  const rows = readOrderRows();                      // ← 整張表，522+ 列 × 24 欄
  let row = rows.find(r => r.orderNo === entry.orderNo);   // 只為了找 1 列
  ...
}
```

為了找一列，讀了全部。而且 `itemsJson` 那欄是大 JSON，資料量很可觀。
`claimOrder`、`markPickDone`、`mergeOrders` 都是同一個模式。

這**正是** `cacheInfoFor_`（4 秒 → 70–90ms）和 `locIndex_`（1.6 秒 → 46–114ms）
已經解決過兩次的同一類問題，只是還沒套用到訂單表。

**③ `mergeOrders` 逐列寫入**

```js
rows.forEach(...)
  sh.getRange(targetRow, 1, 1, ORDERS_HEADER.length).setValues([...]);  // 一列一次
```

一天 128 張新訂單 = 128 次獨立 RPC，再加 `rebuildOrderDetailSheet_()` 和
`setupOrderSheetColors()`。**這支函式佔著鎖的時間最長**，它一跑，全倉庫的寫入都卡住。

**④ 排程完全繞過鎖（正確性風險，不只是慢）**

鎖是在 `doPost` 取得的（`Code.gs:142`，全檔唯一一處 `getScriptLock`），
排程觸發器直接呼叫業務函式，**完全不經過它**。已確認兩支排程會寫「訂單」分頁：

| 排程 | 頻率 | 對訂單表做什麼 |
|---|---|---|
| `autoSyncOrders_` → `mergeOrders()` | 每日 4 次 | `readOrderRows()` 後**逐列重寫整張表** |
| `hourlySync_` → `closeBasketConfirmedPending_()` | 每小時 | `readOrderRows()` 後寫 `manualClose` 欄 |

所以這個情境是真的會發生：

```
09:00  autoSyncOrders_   讀整張 → 逐列寫回      ← 沒有鎖
09:00  某人按完成出貨     寫同一列 status/時間    ← 有鎖，但鎖不住排程
```

兩邊同時讀-改-寫同一張表，**後寫的會蓋掉先寫的**——出貨完成的狀態可能被同步洗回「待出貨」。
這不只是延遲問題，是 lost update。

> 註：`Code.gs:2207` 附近有註解說明排程時間會飄移、順序可能調換，
> 並主張 `mergeOrders()` 是「同步現況」所以重複執行無妨。那個論證處理的是
> **排程彼此之間**的冪等性，**沒有**涵蓋排程與使用者寫入之間的競爭。

**⑤ 每 20 秒的全量輪詢**

```js
setInterval(() => {
  if(current) return;              // 掃描中會跳過，這個保護是對的
  refreshFromBackend(true);        // doGet → getState()
}, 20000);
```

`getState()` 曾實測 **365KB / 2.94 秒**（已從 807KB/3.75s 優化過）。
每台裝置每 20 秒抓一次全量。它不搶鎖，所以不會擋住寫入，
但會吃掉 Apps Script 的執行配額與倉庫 WiFi 頻寬，跟掃描的請求互相競爭。

### 8.4 建議：分三層，由便宜到根本

#### 第一層：把人從等待中移開（成本最低，效果最直接）

**這是 2026-08 對調撥驗收做過、已驗證有效的同一招。** 連續掃 10 件的量測結果：

| | 請求數 | 試算表讀 | 試算表寫 |
|---|---|---|---|
| 改前 | 10 | 40 | 175 |
| 改後 | **1** | **5** | **5** |

套用到剩下的阻塞點：

- **揀貨完成 `markPickDone`**：直接比照 `pickQueue`，本機先標記完成、背景送出
- **儲位確認變更**：本機先更新清單、背景送出＋對帳
- **同步訂單 `mergeOrders`**：改成觸發後立刻回應「已排入」，實際同步交給排程或非同步跑

⚠️ **`finalizeShipment` 建議「不要」改成樂觀更新。** 那一步的 `already_shipped` 檢查是
防止重複出貨的最後一道關卡，讓人員以為出完了、其實衝突了，風險比多等兩秒高。
它應該走第二層——把它變快，而不是把它變非同步。

#### 第二層：後端手術（讓 `finalizeShipment` 從 3 秒降到 0.5 秒以內）

1. **訂單號 → 列號索引**
   比照 `locIndex_`／`cacheInfoFor_`，用 `CacheService` 存 `orderNo → row`，
   只讀需要的那一列。依專案自己的兩次前例，預期 **20–50 倍**改善。
   `finalizeShipment` / `claimOrder` / `markPickDone` 全部受益。

2. **縮小鎖的臨界區**
   目前整個 action 從頭到尾被鎖住，包括讀取和衍生運算。
   應該只鎖「讀-改-寫同一列」那幾行。

3. **`mergeOrders` 改批次寫入**
   逐列 `setValues` → 整塊一次寫（`scanTransferBatch` 已經是這個做法，可以照抄）。
   `rebuildOrderDetailSheet_()` 和 `setupOrderSheetColors()` 移出請求路徑，交給排程。

4. **排程也要拿鎖**
   把 `LockService` 從 `doPost` 下沉到業務函式，或讓排程函式自己包一層。
   這是**正確性**修復，不只是效能。

5. **輪詢改成增量**
   `getState()` 加 `since` 參數，只回傳有變動的訂單。365KB → 幾 KB。

#### 第三層：架構層（真正的「完全改善」）

前兩層能把體感壓到 1 秒內，但 Apps Script 有**無法消除的 1–2 秒固定開銷**
（冷啟動、302 重導、Sheets RPC）。要做到真正的即時，只有換資料層：

| 方案 | 延遲 | 遷移成本 | 備註 |
|---|---|---|---|
| 維持 Apps Script + 前兩層優化 | 體感 ~0（背景 1–3s） | 低 | **建議先做到這裡** |
| Firebase Realtime DB / Firestore | 50–200ms，且**推播不用輪詢** | 中 | 前端改動大，試算表退化成報表匯出目標 |
| Supabase / Cloud SQL + 薄 API | 50–150ms | 高 | 要自己管後端 |

**判斷標準：** 第一、二層做完後，如果體感還是不夠快，才值得考慮第三層。
以目前每天 60–70 張訂單的量體，前兩層應該就夠了——
**問題不在資料量，在同步等待與鎖競爭。**

### 8.5 量測工具

`timeSingleTransferScan_()`（在 `ONE_TIME_SETUP_FUNCTIONS` 白名單裡）可以量單次掃描的後端耗時：

```powershell
Invoke-RestMethod -Uri $execUrl -Method Post -ContentType "application/json" `
  -Body '{"action":"runOneTimeSetup","name":"timeSingleTransferScan_"}'
```

2026-08-26 實測：`totalScanMs: 2449`、`mirrorAloneMs: 748`（最壞情況，含強制鏡射）。

改任何效能之前，**先量一次當基準**。這個專案有過「單憑一次 client 端量測就下結論」而誤判的紀錄。

---

## 9. 部署

### 前端

push 到 `master`，GitHub Pages 自動發布（約 40–70 秒）。
改完記得把 `index.html` 也丟一份到 Drive「文山核對」資料夾——網路連不到 GitHub 時的備援入口。

### 後端

```bash
sh deploy.sh "說明"                                    # Git Bash
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 "說明"   # PowerShell
powershell -ExecutionPolicy Bypass -File .\一鍵部署.ps1        # 含所有前置檢查
```

四個步驟，一個都不能省：

1. `node --check` 擋語法錯誤
2. `clasp push -f`
3. `clasp update-deployment <既有 ID>` — **用既有 ID 更新，不是建新的**
4. 反覆戳 `doPost` 的 `__versioncheck__`，直到版本號對上

**第 4 步為什麼不能省：** 實際踩過好幾次，`doGet` 已經回報新版本了，
`doPost`（執行函式的入口）還在跑舊程式碼，而且完全沒有錯誤訊息。

**改 `Code.gs` 一定要同步改 `BACKEND_VERSION`**，否則第 4 步會拿舊版本號自我比對成功、整道驗證空轉。
2026-08 就發生過：946 行後端改動沒改版號，驗證等於沒做。

### 環境需求

- Node.js LTS
- `npm install -g @google/clasp`
- `clasp login`（憑證寫到 `C:\Users\<user>\.clasprc.json`，**不在專案資料夾裡**）

> ⚠️ 不要在專案資料夾直接跑 `clasp pull`，那會用遠端覆蓋本機。

---

## 10. 踩過的坑

按類型整理。每一條都是實際發生過、花時間查出來的。

### Apps Script

**頂層 const 的執行順序。**
`SYSTEM_SHEET_NOTES` 原本寫成頂層 `const`，在檔案開頭就引用了宣告在 2000 多行後面的常數。
Apps Script 頂層程式碼照順序整份執行，引用「還沒宣告」的 const 會在**腳本載入當下就炸**，
結果是部署後**所有 API 全部打不通**，包括版本查詢。`node --check` 抓不出來（只驗語法，不驗執行順序）。
→ 改成函式，只有被呼叫時才組物件。

**`everyMinutes()` 只接受 1/5/10/15/30。** 非法值讓四支排程從加進來那天起就沒被安裝過。

**專案版本數 200 上限。** `clasp update-deployment` 會失敗，要先到編輯器手動刪舊版本。

**`Range.setNote()` 不是 `insertNote()`**（後者不存在，直接丟例外）。

### 試算表操作

**`getSheet()` 每次呼叫都重寫表頭 = 每次都是一次寫入。**
掃一件調撥會經過 `getSheet` 四次。→ 改成 memo + 先比對。

**同一塊資料重複讀。** 鏡射函式自己再 `readRows` 一次，但呼叫端剛整張讀完。→ 傳進去。

**整欄重掃是最大的效能殺手。** 三次都是同一個解法：建索引 + 只讀需要的列。

### PowerShell（部署腳本）

**`$ErrorActionPreference = "Stop"` + 原生程式的 stderr = 假的失敗。**
git / npm / clasp 把進度訊息寫到 stderr，PowerShell 在 Stop 之下把它當終止錯誤，
**不管結束代碼是不是 0**。`git fetch` 印出正常的「From https://...」就讓整支腳本中斷。
→ 改成 `Continue`，成敗一律看 `$LASTEXITCODE`。

**Windows PowerShell 5.1 沒有 BOM 會把 UTF-8 當 ANSI 讀**，中文全部亂碼。→ 存成 UTF-8 with BOM。

**`.ps1` 雙擊閃退** = 執行原則擋下來，腳本根本沒開始跑。
→ 從已開啟的視窗跑 `powershell -ExecutionPolicy Bypass -File ...`。

### JavaScript

**`Array.map(fn)` 會把索引當第二個參數傳進去。**
`list.map(transferRowHtml)` 讓 `transferRowHtml(it, isDone)` 的 `isDone` 收到索引，
清單裡**奇數位置**的品項被誤判成已完成，動作按鈕全部不顯示。
→ `list.map(function(it){ return transferRowHtml(it); })`。

**classic script 最外層的 `const`/`let` 不會掛到 `window` 上。**
`zbar-wasm.min.js` 用 `var` 宣告（會掛 window），`barcode-detector-polyfill.min.js` 用 `const`（不會）。
寫 `window.barcodeDetectorPolyfill` 永遠是 undefined，要用裸變數名稱存取。

**`input.value` 對真的換行字元（`\n`, ASCII 10）會在賦值當下靜默過濾掉。**
`wireScanInput` 裡那個防呆分支在這幾個輸入框身上永遠不會真的觸發（註解裡已註明，不要誤以為測過）。

### 工具鏈

**用 Python 產生含跳脫字元的多行字串會出事。**
非 raw 字串搭配 `\n` 沒有可靠地轉成兩個字元，反而寫進真正的換行把 JS 字串截斷。
→ 一律用 raw 字串，或直接用陣列 `join('\n')`。

### 流程

**量到反常數字要重複測。** 曾量到 `getState()` 跑 23 秒兩次，
用 server 端計時工具直接測才發現真正的計算只要 2.5 秒，是剛部署後的暫時現象。

**本機測試環境接的是正式後端。** 測相機掃描訂單號時不小心 `claimOrder` 認領了一張真實訂單。
→ 會寫入正式資料的操作，改用攔截 `apiPost` 檢查 payload 的方式驗證，不要真的送出。

**GitHub Pages 背後是 Fastly CDN**，不同地區／電信的邊緣節點快取更新時機不一樣，
單純重新整理不一定能繞過。vendor 檔案路徑要帶 `?v=` 版本號。

---

## 附錄：備份策略

1. **GitHub 是唯一真實來源** — 改完就 commit + push，不要只存在本機
2. Apps Script 端有一份（`clasp pull` 隨時取得），但沒有歷史
3. `index.html` 在 Drive「文山核對」資料夾有備援副本
4. 後端試算表每天 20:00 自動備份到 Drive

> 2026-08 的教訓：一支 50 行的量測函式在本機躺了一段時間、GitHub 上完全沒有備份，
> 而桌面資料夾在那之前才剛整個遺失過一次。**寫完就推。**
