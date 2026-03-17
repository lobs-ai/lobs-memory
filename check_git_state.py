#!/usr/bin/env python3
import subprocess
import json

print("=== Git Log (last 5 commits) ===")
try:
    result = subprocess.run(['git', 'log', '--oneline', '-5'], cwd='/Users/lobs/lobs/lobs-memory', capture_output=True, text=True)
    print(result.stdout if result.stdout else result.stderr)
except Exception as e:
    print(f"Error: {e}")

print("\n=== Staged config.json (HEAD) ===")
try:
    result = subprocess.run(['git', 'show', 'HEAD:config.json'], cwd='/Users/lobs/lobs/lobs-memory', capture_output=True, text=True)
    print(result.stdout[:3000] if result.stdout else result.stderr)
except Exception as e:
    print(f"Error: {e}")

print("\n=== Unstaged diff (current vs HEAD) ===")
try:
    result = subprocess.run(['git', 'diff', 'HEAD', '--', 'config.json'], cwd='/Users/lobs/lobs/lobs-memory', capture_output=True, text=True)
    print(result.stdout[:3000] if result.stdout else result.stderr)
except Exception as e:
    print(f"Error: {e}")
