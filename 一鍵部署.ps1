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

# 這裡刻意不是 "Stop"。git / npm / clasp 都會把進度訊息寫到 stderr，而 PowerShell 在
# ErrorActionPreference=Stop 之下會把「原生程式寫了 stderr」當成終止錯誤——指令明明成功
# 也會讓腳本中斷。實際踩過：git fetch 印出正常的「From https://github.com/...」就被判定
# 成 NativeCommandError，整支停在第4步。原生程式的成敗一律看 $LASTEXITCODE。
$ErrorActionPreference = "Continue"
$ProjectDir = Join-Path $env:USERPROFILE "Desktop\秀山莊_出貨確認APP"
$RepoUrl    = "https://github.com/arenes4127-dotcom/wenshan-shipping-confirm.git"

# 萬一還是有沒攔到的終止錯誤，也要讓訊息留在畫面上——雙擊執行時視窗一閃而過
# 什麼都看不到，等於沒有任何線索可以回報。
trap {
  Write-Host "`n發生未預期的錯誤：" -ForegroundColor Red
  Write-Host $_ -ForegroundColor Red
  Write-Host "`n把上面整段訊息貼給 Claude。"
  Read-Host "按 Enter 關閉"
  exit 1
}

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
    # 不要用 2>&1 把 git 的輸出併進來（見檔案開頭關於 stderr 的說明）。
    # 更新失敗不是致命的——資料夾裡本來就有程式碼，頂多是版本舊一點，
    # 後面會印出實際版本號讓人自己判斷，不用在這裡中斷。
    git fetch origin master
    git checkout master
    git pull origin master
    if ($LASTEXITCODE -ne 0) { Write-Host "    (更新失敗，改用資料夾裡現有的程式碼繼續)" -ForegroundColor Yellow }
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
$verMatch = Select-String -Path Code.gs -Pattern "BACKEND_VERSION = '([^']*)'" | Select-Object -First 1
if (-not $verMatch) { Bad "Code.gs 裡找不到 BACKEND_VERSION，程式碼可能不完整"; Read-Host "`n按 Enter 結束"; exit 1 }
$ver = $verMatch.Matches[0].Groups[1].Value
Ok "程式碼版本：$ver"
if ($ver -ne "2026-08-26.158") {
  Write-Host "    (注意：預期是 2026-08-26.158，資料夾裡的程式碼可能沒更新到最新)" -ForegroundColor Yellow
}

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
