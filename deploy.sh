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

clasp push -f
clasp update-deployment "$DEPLOYMENT_ID" -d "${1:-手動部署}"

# Apps Script 部署有幾秒的傳播延遲，等一下再驗證版本號才不會讀到舊的
sleep 8
echo "線上版本："
curl -sL "$EXEC_URL" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log('  '+JSON.parse(d).version)}catch(e){console.log('  讀取失敗，可能還在傳播中，過幾秒再試一次')}})"
