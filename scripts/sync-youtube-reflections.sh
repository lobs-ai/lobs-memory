#!/bin/bash
# Sync YouTube reflections from lobs DB to markdown files for indexing

DB="$HOME/.openclaw/plugins/lobs/lobs.db"
DEST="$HOME/lobs-shared-memory/research/youtube"
mkdir -p "$DEST"

# Get all ready/completed YouTube videos with reflections
json_output=$(sqlite3 "$DB" -json "
  SELECT 
    id, 
    title, 
    video_url, 
    channel, 
    publish_date, 
    video_summary, 
    reflection,
    created_at,
    duration_seconds
  FROM youtube_videos 
  WHERE status = 'ready' 
    AND reflection IS NOT NULL 
    AND reflection != 'No reflection generated.'
    AND length(reflection) > 50
  ORDER BY created_at DESC
")

if [ -z "$json_output" ] || [ "$json_output" = "[]" ]; then
  echo "No YouTube reflections found to sync"
  exit 0
fi

echo "$json_output" | python3 -c "
import json, sys, os, re

dest = '$DEST'
videos = json.load(sys.stdin)

def slugify(text):
    # Convert to lowercase, replace spaces/special chars with hyphens
    slug = re.sub(r'[^\w\s-]', '', text.lower())
    slug = re.sub(r'[-\s]+', '-', slug)
    return slug[:80].strip('-')

for video in videos:
    title = video.get('title') or 'Untitled Video'
    slug = slugify(title)
    filename = f'{slug}.md'
    filepath = os.path.join(dest, filename)
    
    # Extract date from created_at (format: 2024-01-15 12:34:56 or 2024-01-15T12:34:56)
    created = video.get('created_at', '')
    date_watched = created[:10] if len(created) >= 10 else 'Unknown'
    
    # Format duration
    duration_sec = video.get('duration_seconds')
    if duration_sec:
        minutes = int(duration_sec // 60)
        duration_str = f'{minutes} minutes'
    else:
        duration_str = 'Unknown'
    
    lines = []
    lines.append(f'# {title}')
    lines.append('')
    lines.append(f'**URL:** {video.get(\"video_url\", \"\")}')
    lines.append(f'**Channel:** {video.get(\"channel\", \"Unknown\")}')
    if video.get('publish_date'):
        lines.append(f'**Published:** {video[\"publish_date\"]}')
    lines.append(f'**Duration:** {duration_str}')
    lines.append(f'**Date Watched:** {date_watched}')
    lines.append('')
    
    if video.get('video_summary'):
        lines.append('## Summary')
        lines.append(video['video_summary'])
        lines.append('')
    
    if video.get('reflection'):
        lines.append('## Reflection')
        lines.append(video['reflection'])
        lines.append('')
    
    with open(filepath, 'w') as f:
        f.write('\n'.join(lines))

print(f'Synced {len(videos)} YouTube reflections to {dest}')
"

echo "YouTube reflection sync complete"
