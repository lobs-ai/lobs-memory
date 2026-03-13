#!/bin/bash
# Refresh OpenClaw docs from installed package (English only, markdown only)
SOURCE="/opt/homebrew/lib/node_modules/openclaw/docs"
DEST="$HOME/lobs-shared-memory/openclaw-docs"

if [ -d "$SOURCE" ]; then
  rm -rf "$DEST"
  cp -r "$SOURCE" "$DEST"
  
  # Remove non-English translations
  rm -rf "$DEST/ja-JP" "$DEST/zh-CN"
  
  # Remove non-markdown files (images, CSS, JS, JSON, etc.)
  find "$DEST" -type f ! -name "*.md" -delete
  
  # Remove empty directories
  find "$DEST" -type d -empty -delete
  
  echo "Refreshed OpenClaw docs: $(find "$DEST" -name '*.md' | wc -l) markdown files"
else
  echo "OpenClaw docs not found at $SOURCE"
  exit 1
fi
