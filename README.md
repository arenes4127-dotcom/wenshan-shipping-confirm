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

正式後端網址（deployment ID 寫死在 `deploy.sh`、`deploy.ps1` 與 `.github/workflows/deploy-backend.yml`，
**不可以換**，換掉全倉庫裝置會同時連不上）：

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
| `.github/workflows/deploy-backend.yml` | **雲端**一鍵部署後端（GitHub Actions，平常用這個） | ❌ |
| `.github/workflows/deploy-frontend-cloudflare.yml` | 選用：手動把前端搬去 Cloudflare Pages，平常不會動 | ❌ |
| `build-site.sh` | 把要對外的四個前端檔案挑進 `dist/`，給靜態託管用 | ❌ |
| `deploy.sh` | 本機備援：一鍵部署後端（Git Bash） | ❌ |
| `deploy.ps1` | 本機備援：一鍵部署後端（PowerShell，內容等價） | ❌ |
| `.clasp.json` | scriptId 設定 | ❌ |
| `.claspignore` | 白名單，只放行 `Code.gs` + `appsscript.json` | ❌ |

**不在 repo 裡的東西**：只有 `.clasprc.json`（clasp 的 Google 登入憑證）。
它本來就存在使用者家目錄，而且是機密，`.gitignore` 另外再擋一層。還原後跑一次 `clasp login` 就有了。
雲端部署則是把同一份內容存成 GitHub secret `CLASPRC_JSON`（見 3-1）。

---

## 三、部署（雲端，平常就用這個）

**部署已經不需要桌面那台 Windows 了。** 前後端都在雲端跑，用手機開 GitHub 網頁按一下就能部署；
桌面資料夾不見、電腦重灌、人在倉庫現場，都不影響。本機那套（第四節）留著當備援。

### 3-1 只要設定一次：後端部署憑證

GitHub Actions 要代替你執行 clasp，就得有 Google 的登入憑證。這是**唯一需要人先做一次**的事：

1. 在有裝 clasp 的電腦上，找到 `C:\Users\<你>\.clasprc.json`（Mac/Linux 是 `~/.clasprc.json`）。
   沒有的話，任何一台電腦跑 `npm i -g @google/clasp@3` 再 `clasp login`，就會產生一份。
2. 用記事本打開，**整個檔案內容**複製起來。
3. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**
   - Name：`CLASPRC_JSON`
   - Secret：剛剛複製的內容，原封不動貼上
4. 存檔。之後就不用再碰這一步了。

> 這個檔案等於 Google 帳號的通行證，只能放進 GitHub Secrets（加密、不會出現在 log 裡），
> 絕對不能 commit 進 repo。`.gitignore` 已經先擋了一層。

憑證失效的徵兆：workflow 在 `clasp push` 那步報 401／invalid_grant。重跑一次 `clasp login`
拿到新的 `.clasprc.json`，把 secret 更新掉即可。

### 3-2 後端（`Code.gs`）

改完 `Code.gs`，**記得一起把第 24 行的 `BACKEND_VERSION` 改掉**（目前 `2026-08-26.158`），
然後兩種方式擇一：

- **push 到 `master`** —— `Code.gs` 或 `appsscript.json` 有變動就自動部署。
- **手動觸發** —— GitHub repo → **Actions → 「部署後端（Apps Script）」→ Run workflow**，
  可以填「這次改了什麼」，那段文字會寫進 Apps Script 的部署說明。手機上也能按。

workflow（`.github/workflows/deploy-backend.yml`）做的事跟舊的 `deploy.ps1` 一字不差：

1. `node --check` 先擋語法錯誤，不讓壞程式上正式環境
2. `clasp show-file-status`＋`clasp push -f`（`.claspignore` 白名單，只推 `Code.gs` 與 `appsscript.json`）
3. `clasp update-deployment <既有的 DEPLOYMENT_ID>` —— **用既有 ID 更新**，不是建新的
4. 反覆戳 `doPost` 的 `__versioncheck__`，直到回報的版本號等於 `Code.gs` 裡的 `BACKEND_VERSION`

第 4 步不能省。實際踩過好幾次：`doGet` 已經回報新版本了，`doPost`（執行函式的入口）還在跑舊程式碼，
而且完全沒有錯誤訊息。

比舊腳本多做的一件事：**部署前先記下線上版本**。如果你忘了改 `BACKEND_VERSION`，
第 4 步的條件在推之前就已經成立、會立刻「通過」但什麼都沒驗證到——這種情況現在會在
workflow 摘要頁亮黃字警告，而不是給你一個假的綠燈。

部署失敗最常見的原因是 Apps Script 專案版本數達到 200 上限（這個專案踩過）。
workflow 會直接把處理方式印在錯誤訊息裡：開 Apps Script 編輯器 → 部署 → 管理部署作業，
手動刪掉幾個舊版本再重跑一次。

### 3-3 前端（`index.html`）

前端本來就是雲端部署，什麼都不用設定，push 到 `master` 就好：

```bash
git add index.html && git commit -m "..." && git push
```

GitHub Pages 會自己發佈：https://arenes4127-dotcom.github.io/wenshan-shipping-confirm/

改完記得把新的 `index.html` 也丟一份到 Drive 的「文山核對」資料夾——那是網路連不到
GitHub 時的備援入口。

#### 想搬到 Cloudflare Pages 的話（選用，目前沒在用）

`build-site.sh` 會把該對外的四個檔案挑進 `dist/`：`index.html`、`zbar-wasm.min.js`、
`barcode-detector-polyfill.min.js`、`zbar.wasm`。這四個綁在一起不能只挑一個——`index.html`
用相對路徑動態載入後兩者（iOS Safari 沒有原生 BarcodeDetector 時的掃碼備援），
`zbar-wasm.min.js` 又會去抓同目錄的 `zbar.wasm`；少一個 iPhone 就掃不出條碼，而且是靜悄悄地壞掉。
順便也讓網站根目錄不會多出 `Code.gs`、部署腳本這些跟前端無關的東西。

有這支腳本之後，兩種接法都能用：

- **Cloudflare 官方 Git 整合**：dashboard → Workers & Pages → **新建一個專屬這個 APP 的
  Pages 專案** → Settings → Builds，Production branch 填 `master`、
  Build command 填 `sh build-site.sh`、Build output directory 填 `dist`。
- **`.github/workflows/deploy-frontend-cloudflare.yml`**：只能手動觸發，每次要自己輸入
  Pages 專案名稱（刻意不給預設值、刻意不掛 push 觸發）。需要 `CLOUDFLARE_API_TOKEN` 與
  `CLOUDFLARE_ACCOUNT_ID` 兩個 repo secret；沒設就直接略過。

> ⚠️ **`mogu-erp` 不是這個專案。** https://mogu-erp.pages.dev/ 是蘑咕 MOGU ERP 的正式站，
> 跟文山出貨確認系統無關，也不是從這個 GitHub 帳號的 repo 建的。把這個 APP 部署過去
> 會直接把那個系統蓋掉，而且 Cloudflare 不會攔、會安靜地部署成功。
> workflow 裡已經寫死擋掉 `mogu-erp` 這個名稱，但 Cloudflare 官方 Git 整合那條路沒有這層保護，
> 建專案時要自己看清楚。

---

## 四、還原本機開發環境（Windows，備援用）

平常不需要做這一段。要在本機開發、或雲端整個掛掉時才用。

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
npm install -g @google/clasp@3
clasp login          # 會開瀏覽器，用擁有那份試算表的 Google 帳號登入
```

`clasp login` 成功後 `.clasprc.json` 會寫到 `C:\Users\user\.clasprc.json`。
**順手把這個檔案的內容存成 GitHub secret `CLASPRC_JSON`**（見 3-1）——雲端部署就靠它。

### 3. 確認接得上

```bash
clasp show-file-status   # 舊版是 clasp status，應列出 Code.gs 與 appsscript.json 兩個檔案
```

想確認遠端 Apps Script 上的程式碼跟本機一致，可以 `clasp pull` 到別的暫存資料夾比對，
**不要**直接在專案資料夾 `clasp pull`——那會用遠端覆蓋本機。

### 4. 本機部署腳本

`deploy.ps1`（PowerShell）與 `deploy.sh`（Git Bash）做的事完全一樣，也跟雲端 workflow 一樣：

```powershell
.\deploy.ps1 "這次改了什麼"
# 被執行原則擋下來的話
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 "這次改了什麼"
```

```bash
sh deploy.sh "這次改了什麼"
```

三份要一起維護：改了部署流程，`deploy.ps1`、`deploy.sh`、
`.github/workflows/deploy-backend.yml` 三邊都要同步。

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

1. **GitHub 是唯一真實來源**，改完就 commit + push，不要只存在本機。
   部署也全部由 GitHub Actions／GitHub Pages 跑（第三節），本機那台不見了不影響上線
2. Apps Script 端也有一份（`clasp pull` 隨時取得），但沒有歷史
3. `index.html` 在 Drive「文山核對」資料夾有備援副本
4. 後端試算表本身有每日備份排程（`Code.gs` 裡的每日歸檔）
