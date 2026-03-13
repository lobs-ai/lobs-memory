#!/bin/bash
# Sync GitHub PR descriptions and comments to markdown for indexing
# Pulls from all paw-engineering repos

DEST="$HOME/lobs-shared-memory/github-prs"
mkdir -p "$DEST"

REPOS="paw-hub paw-portal paw-site ship-api lobs-sail lobs-sets-sail"

for repo in $REPOS; do
  REPO_DIR="$DEST/$repo"
  mkdir -p "$REPO_DIR"
  
  # Get merged + open PRs from last 90 days
  prs=$(gh pr list --repo "paw-engineering/$repo" --state all --limit 50 --json number,title,body,author,mergedAt,createdAt,state,comments,reviews 2>/dev/null)
  
  if [ -z "$prs" ] || [ "$prs" = "[]" ]; then
    continue
  fi
  
  # Process each PR into a markdown file
  echo "$prs" | python3 -c "
import json, sys, os

dest = '$REPO_DIR'
prs = json.load(sys.stdin)

for pr in prs:
    num = pr['number']
    filepath = os.path.join(dest, f'PR-{num}.md')
    
    lines = []
    lines.append(f'# PR #{num}: {pr[\"title\"]}')
    lines.append(f'')
    lines.append(f'**Repo:** paw-engineering/$repo')
    lines.append(f'**Author:** {pr[\"author\"][\"login\"]}')
    lines.append(f'**State:** {pr[\"state\"]}')
    if pr.get('createdAt'):
        lines.append(f'**Created:** {pr[\"createdAt\"][:10]}')
    if pr.get('mergedAt'):
        lines.append(f'**Merged:** {pr[\"mergedAt\"][:10]}')
    lines.append('')
    
    if pr.get('body'):
        lines.append('## Description')
        lines.append(pr['body'])
        lines.append('')
    
    # Add review comments
    if pr.get('reviews'):
        for review in pr['reviews']:
            if review.get('body'):
                author = review.get('author', {}).get('login', 'unknown')
                lines.append(f'### Review by {author} ({review.get(\"state\", \"\")})')
                lines.append(review['body'])
                lines.append('')
    
    # Add comments
    if pr.get('comments'):
        for comment in pr['comments']:
            if comment.get('body'):
                author = comment.get('author', {}).get('login', 'unknown')
                lines.append(f'### Comment by {author}')
                lines.append(comment['body'])
                lines.append('')
    
    with open(filepath, 'w') as f:
        f.write('\n'.join(lines))

print(f'$repo: {len(prs)} PRs synced')
"
done

echo "GitHub PR sync complete"
