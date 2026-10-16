#!/bin/sh
# Builds "Medicare Fridays.exe" (Windows) and the standalone HTML download from medicare-fridays.html.
set -e
cd "$(dirname "$0")/.."
OUT="download/Medicare Fridays.html"
mkdir -p download
{
  echo '<!doctype html>'; echo '<html lang="en">'; echo '<head>'; echo '<meta charset="utf-8">'
  sed -n '1,/^<\/style>$/p' medicare-fridays.html | grep -v 'claude:viewport-fit-sides'
  echo '</head>'; echo '<body>'
  sed -n '/^<\/style>$/,$p' medicare-fridays.html | sed '1d'
  echo '</body>'; echo '</html>'
} > "$OUT"
cp "$OUT" desktop/app.html
cd desktop
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -H windowsgui" -o "../download/Medicare Fridays.exe" .
