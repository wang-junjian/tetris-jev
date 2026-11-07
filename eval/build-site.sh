#!/usr/bin/env bash
# ================================================================
#  组装 GitHub Pages 站点目录（本地与 CI 完全同一条命令，理由见下）
#
#  本项目没有构建步骤：Pages 的产物就是仓库文件本身。因此这里只做
#  「挑出该公开的文件」这一步，不做任何转换 —— 线上看到的就是仓库里的字节。
#
#  不放进站点的：eval/（评估工具与 runs）、*.mjs / *.py（需要 Node/Python
#  运行环境）、skills/、.workbuddy/、docs/*.md（索引页改为链到 GitHub 原文）。
#
#  用法：bash eval/build-site.sh && node eval/check-site.mjs
# ================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf site
mkdir -p site/docs/assets

cp index.html engine.js site/
cp docs/*.html site/docs/
# 演示素材：只带 mp4 + 封面图，.mov 是同一段内容的备份，省 6.5 MB 流量
cp docs/assets/demo.png docs/assets/demo.mp4 site/docs/assets/

# .nojekyll：让 Pages 直接按静态文件服务，不跑 Jekyll（否则下划线开头的路径会被吞）
touch site/.nojekyll

printf 'Playable build of commit %s\n' "${GITHUB_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo local)}" > site/build.txt

echo "✓ site/ 组装完成"
du -sh site
