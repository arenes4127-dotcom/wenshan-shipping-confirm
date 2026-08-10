#!/bin/sh
# 一鍵部署後端：推送 Code.gs 到 Apps Script 專案，並更新「現有的」部署。
#
# 一定要指定部署ID（不帶 -i 的 clasp create-deployment 會產生全新的部署、拿到不同的
# /exec 網址，等於倉庫所有裝置瞬間連不上後端）。這個ID就是目前 /exec 網址裡的那一段。
DEPLOYMENT_ID="AKfycbxdzii_g-Dv59KDLIiWa2B7adWyv_JuLoBQBfP42INKYv7L6kOFtN7vseYFwHsa1RJG"
EXEC_URL="https://script.google.com/macros/s/$DEPLOYMENT_ID/exec"

set -e
# 部署前先擋一次語法錯誤，不要把壞掉的程式碼推上正式環境
cp Code.gs Code_check.js
node --check Code_check.js
rm Code_check.js

VERSION=$(grep -o "BACKEND_VERSION = '[^']*'" Code.gs | head -1 | sed "s/.*'\(.*\)'/\1/")

clasp push -f
clasp update-deployment "$DEPLOYMENT_ID" -d "${1:-手動部署}"

# 這裡一定要等到「doPost」也更新才算部署完成，不能只看 doGet 回報的版本號。
# 實際踩過好幾次：doGet 已經回報新版本了，但 doPost（執行函式的入口）還在跑舊程式碼，
# 於是「部署完馬上執行一次性函式」就會用到舊邏輯——症狀是函式找不到、或是寫出上一版的內容，
# 而且不會有任何錯誤訊息，很難察覺。所以改成直接戳 doPost 確認它回報的版本也對上了。
echo "等待部署傳播（doGet 與 doPost 都要更新）..."
i=0
while [ $i -lt 20 ]; do
  sleep 4
  GOT=$(curl -sL --data-binary '{"action":"__versioncheck__"}' -H "Content-Type: application/json" "$EXEC_URL" \
        | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(String(j.version||j.error||''))}catch(e){process.stdout.write('')}})")
  case "$GOT" in
    *"$VERSION"*) echo "  doPost 已更新：$VERSION"; exit 0 ;;
  esac
  i=$((i+1))
done
echo "  警告：等了 80 秒 doPost 仍未回報 $VERSION，執行一次性函式前請再確認一次"
exit 1
