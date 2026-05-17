#!/usr/bin/env bash
# Usage: comments.sh [path/to/file.html]   (defaults to path/to/some.html)
F="${1:-path/to/some.html}.comments.json"
if [ ! -s "$F" ]; then echo "(no comments yet at $F)"; exit 0; fi
python3 -c "
import json,sys
data=json.load(open('$F'))
if not data: print('(no comments yet)'); sys.exit(0)
for c in data:
    print(f\"[{c['timestamp']}]  {c['id']} <{c.get('tag','?')}>\")
    print(f\"  comment: {c['comment']}\")
    print(f\"  on: {c['excerpt']}\")
    print()
"
