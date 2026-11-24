#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
out="$(cd "${1:?Pass an empty output directory}" && pwd)"
app="$out/Weekly Content Feed Setup.app"
archive="$out/Omnyo-Weekly-Content-Feed-Setup.zip"
test ! -e "$app" && test ! -e "$archive" || exit 1
version="${3:?Pass the minimum supported public app version}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1
digest=$(plutil -extract sha256 raw -o - "$root/apps/web/src/workflow-catalog/weekly-content-feed.release.json")
[[ "$digest" =~ ^[0-9a-f]{64}$ ]]
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
swiftc -module-cache-path "$out/module-cache" -O -parse-as-library -target arm64-apple-macos13.0 "$root/apps/desktop/workflow-installer/Installer.swift" "$root/apps/desktop/workflow-installer/PublicRelease.swift" -o "$app/Contents/MacOS/WorkflowSetup"
cp "$root/apps/desktop/assets/icon.icns" "$app/Contents/Resources/icon.icns"
plist="$app/Contents/Info.plist"
plutil -create xml1 "$plist"
plutil -insert CFBundleIdentifier -string dev.omnyo.weekly-feed-setup "$plist"
plutil -insert CFBundleName -string 'Weekly Content Feed Setup' "$plist"
plutil -insert CFBundleExecutable -string WorkflowSetup "$plist"
plutil -insert CFBundlePackageType -string APPL "$plist"
plutil -insert CFBundleIconFile -string icon.icns "$plist"
plutil -insert CFBundleShortVersionString -string "$version" "$plist"
plutil -insert CFBundleVersion -string "$version" "$plist"
plutil -insert LSMinimumSystemVersion -string 13.0 "$plist"
plutil -insert OmnyoMinimumVersion -string "$version" "$plist"
plutil -insert OmnyoWorkflowID -string "${digest:0:32}" "$plist"
codesign --force --sign "${2:--}" --options runtime "$app"
codesign --verify --strict "$app"
ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
