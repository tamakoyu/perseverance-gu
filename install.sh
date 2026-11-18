#!/bin/sh
# 把插件安装/更新到本机 LearnHarness（只替换 dist/，保留 data/）。
set -e
SRC="$(cd "$(dirname "$0")" && pwd)/dist"
DEST="${1:-$HOME/Library/Application Support/LearnHarness/data/plugins}/kaoyan"
[ -d "$(dirname "$DEST")" ] || { echo "找不到插件目录：$(dirname "$DEST")"; exit 1; }
[ -L "$DEST/dist" ] && { echo "拒绝：$DEST/dist 是符号链接"; exit 1; }
mkdir -p "$DEST"
rm -rf "$DEST/dist.new"
cp -R "$SRC" "$DEST/dist.new"
rm -rf "$DEST/dist"
mv "$DEST/dist.new" "$DEST/dist"
echo "已安装到：$DEST/dist"
echo "首次安装：设置 → 社区插件 → 刷新 → 启用「考研工具箱」。更新代码后请重启 LearnHarness。"
