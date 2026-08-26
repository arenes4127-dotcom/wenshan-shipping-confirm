# 一鍵部署後端（PowerShell 版，跟 deploy.sh 做的事完全一樣）
#
# 為什麼要有這一份：deploy.sh 是 sh 腳本，Windows 上一定要開 Git Bash 才能跑。
# 這一份用 PowerShell 原生寫，右鍵「用 PowerShell 執行」就能動，少裝一套東西。
# 兩份擇一使用即可，維護時記得兩邊要一起改。
#
# 用法：
#   .\deploy.ps1 "這次改了什麼"
# 如果被執行原則擋下來（紅字 about_Execution_Policies），改用：
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1 "這次改了什麼"

param(
  [string]$Description = "手動部署"
)

$ErrorActionPreference = "Stop"

# 一定要指定部署ID。不帶 -i 的 clasp create-deployment 會產生全新的部署、拿到不同的
# /exec 網址，等於倉庫所有裝置瞬間連不上後端。這個ID就是目前 /exec 網址裡的那一段。
$DeploymentId = "AKfycbxdzii_g-Dv59KDLIiWa2B7adWyv_JuLoBQBfP42INKYv7L6kOFtN7vseYFwHsa1RJG"
$ExecUrl = "https://script.google.com/macros/s/$DeploymentId/exec"

# 先確認該有的工具都在，不然錯誤訊息會很難懂
foreach ($cmd in @("node", "clasp")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Host "找不到 $cmd。" -ForegroundColor Red
    if ($cmd -eq "node") { Write-Host "  請先安裝 Node.js LTS：https://nodejs.org（安裝時要勾選加入 PATH）" }
    else { Write-Host "  請先執行：npm install -g @google/clasp　然後 clasp login" }
    exit 1
  }
}

if (-not (Test-Path "Code.gs")) {
  Write-Host "這個資料夾裡沒有 Code.gs，請先切換到專案資料夾再執行。" -ForegroundColor Red
  exit 1
}

# 部署前先擋一次語法錯誤，不要把壞掉的程式碼推上正式環境
Copy-Item Code.gs Code_check.js -Force
node --check Code_check.js
$syntaxOk = ($LASTEXITCODE -eq 0)
Remove-Item Code_check.js -Force
if (-not $syntaxOk) {
  Write-Host "Code.gs 有語法錯誤，已中止部署。" -ForegroundColor Red
  exit 1
}

$versionLine = Select-String -Path Code.gs -Pattern "BACKEND_VERSION = '([^']*)'" | Select-Object -First 1
if (-not $versionLine) {
  Write-Host "在 Code.gs 裡找不到 BACKEND_VERSION，已中止。" -ForegroundColor Red
  exit 1
}
$Version = $versionLine.Matches[0].Groups[1].Value
Write-Host "準備部署版本：$Version"

clasp push -f
if ($LASTEXITCODE -ne 0) { Write-Host "clasp push 失敗。" -ForegroundColor Red; exit 1 }

clasp update-deployment $DeploymentId -d $Description
if ($LASTEXITCODE -ne 0) {
  Write-Host "clasp update-deployment 失敗。" -ForegroundColor Red
  Write-Host "  最常見原因：Apps Script 專案版本數已達 200 上限（這個專案踩過）。"
  Write-Host "  處理方式：開 Apps Script 編輯器 → 部署 → 管理部署作業，手動刪掉幾個舊版本再重跑。"
  exit 1
}

# 這裡一定要等到「doPost」也更新才算部署完成，不能只看 doGet 回報的版本號。
# 實際踩過好幾次：doGet 已經回報新版本了，但 doPost（執行函式的入口）還在跑舊程式碼，
# 於是「部署完馬上執行一次性函式」就會用到舊邏輯——症狀是函式找不到、或是寫出上一版的
# 內容，而且不會有任何錯誤訊息，很難察覺。所以改成直接戳 doPost 確認它回報的版本也對上。
Write-Host "等待部署傳播（doGet 與 doPost 都要更新）..."
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 4
  try {
    $res = Invoke-RestMethod -Uri $ExecUrl -Method Post -ContentType "application/json" `
                             -Body '{"action":"__versioncheck__"}' -TimeoutSec 30
    if ($res.version -eq $Version) {
      Write-Host "  doPost 已更新：$Version" -ForegroundColor Green
      exit 0
    }
  } catch {
    # 部署傳播中偶爾會連不上或回非JSON，屬正常現象，繼續等下一輪
  }
}

Write-Host "  警告：等了 80 秒 doPost 仍未回報 $Version，執行一次性函式前請再確認一次" -ForegroundColor Yellow
exit 1
