#!/bin/sh
# 把「前端真正要對外的檔案」集中到 dist/，給靜態網站託管服務發佈用。
#
# 為什麼需要這一步：這個 repo 的根目錄同時放著前端（index.html）跟後端原始碼（Code.gs，
# 約 8,000 行）、部署腳本、clasp 設定。如果直接把整個 repo 根目錄當成網站根目錄發佈，
# 後端程式碼跟部署設定也會一起變成任何人都能下載的網址。這裡用白名單只挑該公開的四個檔案，
# 跟 .claspignore 是同一套思路。
#
# 用法：
#   sh build-site.sh          → 產生 ./dist
#
# Cloudflare Pages 的專案設定要對應成：
#   Build command:      sh build-site.sh
#   Build output dir:   dist
#
# 這四個檔案是綁在一起的，不能只挑其中一個：index.html 會用相對路徑動態載入
# zbar-wasm.min.js 與 barcode-detector-polyfill.min.js（iOS Safari 沒有原生
# BarcodeDetector 時的掃碼備援），而 zbar-wasm.min.js 又會去抓同目錄的 zbar.wasm。
# 少一個，iPhone 就掃不出條碼，而且是靜悄悄地壞掉。

set -e

OUT="${1:-dist}"

rm -rf "$OUT"
mkdir -p "$OUT"

for f in index.html zbar-wasm.min.js barcode-detector-polyfill.min.js zbar.wasm; do
  if [ ! -f "$f" ]; then
    echo "找不到 $f，請確認是在專案根目錄執行" >&2
    exit 1
  fi
  cp "$f" "$OUT/"
done

echo "已產生 $OUT/："
ls -l "$OUT"
