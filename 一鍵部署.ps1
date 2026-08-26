# 文山出貨確認系統 —— 後端一鍵部署（含所有前置檢查）
#
# 這支是給「本機環境剛重建、只想把後端推上去」用的：
# 從檢查工具、還原專案、登入、到真正部署並驗證，一支跑完，不用先裝 Claude Code。
#
# 用法：在 PowerShell 裡執行
#   powershell -ExecutionPolicy Bypass -File .\一鍵部署.ps1
#
# 中途只有一件事需要你動手：第一次跑會跳出瀏覽器要你登入 Google（clasp login），
# 請用「擁有文山出貨確認系統-後端 那份試算表」的帳號登入。

$ErrorActionPreference = "Stop"
$ProjectDir = Join-Path $env:USERPROFILE "Desktop\秀山莊_出貨確認APP"
$RepoUrl    = "https://github.com/arenes4127-dotcom/wenshan-shipping-confirm.git"

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)       { Write-Host "    OK  $msg" -ForegroundColor Green }
function Bad($msg)      { Write-Host "    !!  $msg" -ForegroundColor Red }

Write-Host "===== 文山出貨確認系統 後端部署 =====" -ForegroundColor White

# ---- 1. Node.js ----------------------------------------------------------
Step 1 "檢查 Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Bad "找不到 Node.js。這一項沒辦法自動裝，需要你手動安裝一次："
  Write-Host "      https://nodejs.org  （下載 LTS，安裝時保持預設、確認有加入 PATH）"
  Write-Host "      裝完把這個視窗關掉、重新開一個 PowerShell 再跑一次這支腳本。"
  Read-Host "`n按 Enter 結束"
  exit 1
}
Ok "Node.js $(node -v)"

# ---- 2. git --------------------------------------------------------------
Step 2 "檢查 git"
$hasGit = [bool](Get-Command git -ErrorAction SilentlyContinue)
if (-not $hasGit) { Bad "找不到 git（等一下會改用下載 ZIP 的方式取得程式碼）" }
else { Ok "git 已安裝" }

# ---- 3. clasp ------------------------------------------------------------
Step 3 "檢查 clasp"
if (-not (Get-Command clasp -ErrorAction SilentlyContinue)) {
  Write-Host "    clasp 沒安裝，現在幫你裝（npm install -g @google/clasp）..."
  npm install -g @google/clasp
  if ($LASTEXITCODE -ne 0) { Bad "clasp 安裝失敗，請把上面的錯誤訊息貼給 Claude"; Read-Host "`n按 Enter 結束"; exit 1 }
}
Ok "clasp 已就緒"

# ---- 4. 取得專案 ---------------------------------------------------------
Step 4 "取得最新程式碼"
if (Test-Path (Join-Path $ProjectDir "Code.gs")) {
  Ok "專案資料夾已存在：$ProjectDir"
  Set-Location $ProjectDir
  if ($hasGit -and (Test-Path ".git")) {
    Write-Host "    更新到最新版..."
    git fetch origin master 2>&1 | Out-Null
    git checkout master 2>&1 | Out-Null
    git pull origin master 2>&1 | Out-Null
  }
} elseif ($hasGit) {
  Write-Host "    從 GitHub clone..."
  New-Item -ItemType Directory -Force -Path (Split-Path $ProjectDir) | Out-Null
  git clone $RepoUrl $ProjectDir
  if ($LASTEXITCODE -ne 0) { Bad "clone 失敗"; Read-Host "`n按 Enter 結束"; exit 1 }
  Set-Location $ProjectDir
} else {
  Write-Host "    沒有 git，改下載 ZIP..."
  $zip = Join-Path $env:TEMP "wenshan.zip"
  Invoke-WebRequest -Uri "$($RepoUrl -replace '\.git$','')/archive/refs/heads/master.zip" -OutFile $zip
  $tmp = Join-Path $env:TEMP "wenshan_unzip"
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Force -Path $ProjectDir | Out-Null
  Copy-Item (Join-Path $tmp "wenshan-shipping-confirm-master\*") $ProjectDir -Recurse -Force
  Set-Location $ProjectDir
}
$ver = (Select-String -Path Code.gs -Pattern "BACKEND_VERSION = '([^']*)'" | Select-Object -First 1).Matches[0].Groups[1].Value
Ok "程式碼版本：$ver"

# ---- 5. clasp 登入 -------------------------------------------------------
Step 5 "檢查 Google 登入狀態"
if (Test-Path (Join-Path $env:USERPROFILE ".clasprc.json")) {
  Ok "找到既有憑證，不需要重新登入"
} else {
  Write-Host "    沒有憑證，現在開瀏覽器登入。" -ForegroundColor Yellow
  Write-Host "    請用『擁有 文山出貨確認系統-後端 試算表』的 Google 帳號登入。" -ForegroundColor Yellow
  clasp login
  if ($LASTEXITCODE -ne 0) { Bad "登入失敗"; Read-Host "`n按 Enter 結束"; exit 1 }
  Ok "登入完成"
}

# ---- 6. 部署 -------------------------------------------------------------
Step 6 "部署後端（會自動驗證版本號）"
& (Join-Path $ProjectDir "deploy.ps1") "調撥驗收效能優化"
$deployOk = ($LASTEXITCODE -eq 0)

Write-Host ""
if ($deployOk) {
  Write-Host "===== 部署成功：後端已是 $ver =====" -ForegroundColor Green
} else {
  Write-Host "===== 部署未完成 =====" -ForegroundColor Red
  Write-Host "把上面的訊息整段貼給 Claude，可以判斷是哪一步的問題。"
}
Read-Host "`n按 Enter 關閉"
