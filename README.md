# 文山出貨確認系統

秀山莊文山倉的出貨／揀貨／調撥驗收 APP。這個 repo 就是**完整的開發專案**——本機資料夾
（`C:\Users\user\Desktop\秀山莊_出貨確認APP`）不見了的話，從這裡就能整包還原，不會少任何東西。

---

## 一、系統長什麼樣

三層，各自放在不同地方：

| 層 | 檔案 | 部署在哪 | 網址／ID |
|---|---|---|---|
| 前端 APP | `index.html`（單檔，含所有 CSS/JS） | GitHub Pages | https://arenes4127-dotcom.github.io/wenshan-shipping-confirm/ |
| 後端 API | `Code.gs` | Google Apps Script（Web App） | scriptId `1KIDgqKPeVzveXky1f_6yXBjVsMvFWNMAPrhbxR67AOntEQaIZ9fmPuDD` |
| 資料 | —— | Google 試算表 | 見下方「相關試算表」 |

前端是**純靜態網頁**，不經過 Apps Script 的 `HtmlService`；它用 `fetch` 打後端的 `/exec`。
所以 `index.html` 不會、也不應該被 clasp 推到 Apps Script 專案裡（`.claspignore` 用白名單擋掉了）。

正式後端網址（deployment ID 寫死在 `deploy.sh`，**不可以換**，換掉全倉庫裝置會同時連不上）：

```
https://script.google.com/macros/s/AKfycbxdzii_g-Dv59KDLIiWa2B7adWyv_JuLoBQBfP42INKYv7L6kOFtN7vseYFwHsa1RJG/exec
```

### 相關試算表 / Drive

| 名稱 | ID | 用途 |
|---|---|---|
| 文山出貨確認系統-後端 | `1ogk_YvgJvFhjlnlF0QFiy1LaNMd89Qoe49slswk7Ubs` | Apps Script 綁在這份上；訂單／出貨紀錄／揀貨紀錄／調撥／KPI 全在這 |
| 文山核對 工作區 | `1vCCJS_iHZDUnoFFjnqiT-ZySwCoKFxx4HXRwqrmtVmU` | 使用者的原生業務表（文山出貨V2／國際碼等）。**唯讀，不可修改** |
| 規格選項_圖片_貨號對應_四賣場總表 | `1DeqU2CnmM1XL-J3IudjDzc8OmMuv7Bqz` | ODM／蝦皮商品規格圖片來源 |
| 文山核對 資料夾 | `1quwo_65K5YQMZtuLD-vkheg-g97kYond` | 上面這些檔案的所在資料夾，也放 `index.html` 的離線備援副本 |

---

## 二、檔案清單

| 檔案 | 說明 | 會被推到 Apps Script？ |
|---|---|---|
| `Code.gs` | 後端全部程式碼（約 8,000 行） | ✅ |
| `appsscript.json` | Apps Script 資訊清單（時區 Asia/Taipei、V8、Web App 設定） | ✅ |
| `index.html` | 前端 APP 單檔 | ❌（走 GitHub Pages） |
| `zbar-wasm.min.js` / `zbar.wasm` | 條碼掃描引擎 | ❌ |
| `barcode-detector-polyfill.min.js` | 舊瀏覽器的 BarcodeDetector 補丁 | ❌ |
| `deploy.sh` | 一鍵部署後端 | ❌ |
| `.clasp.json` | scriptId 設定 | ❌ |
| `.claspignore` | 白名單，只放行 `Code.gs` + `appsscript.json` | ❌ |

**不在 repo 裡的東西**：只有 `.clasprc.json`（clasp 的 Google 登入憑證）。
它本來就存在使用者家目錄，而且是機密，`.gitignore` 另外再擋一層。還原後跑一次 `clasp login` 就有了。

---

## 三、還原本機開發環境（Windows）

### 1. 把專案抓回來

在 PowerShell 或 Git Bash：

```powershell
cd $env:USERPROFILE\Desktop
git clone https://github.com/arenes4127-dotcom/wenshan-shipping-confirm.git 秀山莊_出貨確認APP
cd 秀山莊_出貨確認APP
```

這樣連 commit 歷史一起回來，之後改壞了都能 `git log` / `git revert` 救回去。
（沒裝 git 的話：https://git-scm.com/download/win ，或直接到 repo 頁面按 Code → Download ZIP，
但 ZIP 沒有歷史紀錄，不建議。）

### 2. 裝工具

```powershell
# Node.js LTS: https://nodejs.org
npm install -g @google/clasp
clasp login          # 會開瀏覽器，用擁有那份試算表的 Google 帳號登入
```

`clasp login` 成功後 `.clasprc.json` 會寫到 `C:\Users\user\.clasprc.json`——這一步就是還原唯一缺的那塊。

### 3. 確認接得上

```bash
clasp status         # 應該列出 Code.gs 與 appsscript.json 兩個 tracked 檔案
```

想確認遠端 Apps Script 上的程式碼跟本機一致，可以 `clasp pull` 到別的暫存資料夾比對，
**不要**直接在專案資料夾 `clasp pull`——那會用遠端覆蓋本機。

---

## 四、部署

### 後端（Code.gs）

```bash
sh deploy.sh "這次改了什麼"
```

Windows 上用 **Git Bash** 跑（`deploy.sh` 是 sh 腳本，PowerShell 不能直接執行）。
腳本會依序做四件事：

1. `node --check` 先擋語法錯誤，不讓壞程式上正式環境
2. `clasp push -f`
3. `clasp update-deployment <既有的 DEPLOYMENT_ID>`——**用既有 ID 更新**，不是建新的
4. 反覆戳 `doPost` 的 `__versioncheck__`，直到回報的版本號等於 `Code.gs` 裡的 `BACKEND_VERSION` 才算完成

第 4 步不能省。實際踩過好幾次：`doGet` 已經回報新版本了，`doPost`（執行函式的入口）還在跑舊程式碼，
而且完全沒有錯誤訊息。

改 `Code.gs` 時記得順手把第 24 行的 `BACKEND_VERSION`（目前 `2026-08-18.157`）改掉，否則第 4 步永遠等不到。

### 前端（index.html）

推上 `master`，GitHub Pages 自己會更新：

```bash
git add index.html && git commit -m "..." && git push
```

改完記得把新的 `index.html` 也丟一份到 Drive 的「文山核對」資料夾——那是網路連不到 GitHub 時的備援入口。

---

## 五、後端試算表分頁

`Code.gs` 會自己建這些分頁（常數定義在檔案開頭附近）：

| 分頁 | 常數 | 內容 |
|---|---|---|
| 訂單 | `SHEET_ORDERS` | 訂單主檔，含品項 JSON、認領、人工結案、時間軸 |
| 訂單明細 | `SHEET_DETAIL` | 逐品項明細 |
| 出貨紀錄 | `SHEET_LOG` | 一列一品項，含核對結果／差異明細 |
| 揀貨紀錄 | `SHEET_PICKLOG` | 含 kind（文山／調撥）分流 |
| 調撥單匯入／調撥單／調撥驗收紀錄 | `SHEET_TRANSFER*` | 調撥三件組 |
| 儲位異動紀錄 | `SHEET_LOCLOG` | 含回寫「文山地圖」的結果 |
| 每日統計／KPI統計 | `SHEET_DAILY_STATS` / `SHEET_KPI` | 每天 20:00 寫一列 |
| 儀表板 | `SHEET_DASHBOARD` | 即時公式儀表板 |
| 訂單修改 | `SHEET_AMEND` | 缺貨不出／改數量／換貨號的人工修改指令 |
| 蝦皮資料更新 | `SHEET_SHOPEE_STAGE*` | 每週例行的規格／價格／圖片更新暫存 |
| 人員／系統紀錄／商品主圖 | `SHEET_STAFF` / `SHEET_SYSLOG` / `SHEET_PRODUCT_IMAGE` | —— |
| 文山出貨V2／條碼轉品號／特殊註記 | —— | 從「文山核對 工作區」IMPORTRANGE 過來的鏡像 |

「訂單修改」存的是**指令**不是結果——訂單每天同步 4 次以上，每次都從來源整列重寫，
直接改品項的話下一次同步就被蓋回去了。

---

## 六、備份策略（避免再次整包不見）

1. **GitHub 是唯一真實來源**，改完就 commit + push，不要只存在本機
2. Apps Script 端也有一份（`clasp pull` 隨時取得），但沒有歷史
3. `index.html` 在 Drive「文山核對」資料夾有備援副本
4. 後端試算表本身有每日備份排程（`Code.gs` 裡的每日歸檔）
