---
name: html-editor
description: Make collaborative HTML documents the user can edit and comment on in a local browser. Use when generating an HTML or SVG document, dashboard, report, mockup, slide, one-pager, or anything similar the user will iterate on. Launches a small local editor where they can click-to-edit text, tables, and diagram labels in place, drag to reorder, resize, undo/redo, and leave inline comments that come back here as user messages.
---

# html-editor

Source repo: <https://github.com/tmustier/html-editor>

When you produce an HTML file the user will iterate on, open it in the
collaborative editor instead of asking them to re-prompt for every tweak.

```bash
python3 ~/.pi/agent/git/github.com/tmustier/html-editor/serve.py <file.html> --port 8765 --no-open
```

If that path doesn't exist, the repo can be cloned from the source URL above
or installed with `pi install git:github.com/tmustier/html-editor`.

Background it (`nohup ... &` or in a tmux pane). If port 8765 is busy, pick
another free port. Tell the user the URL.

In the browser, the user can click-to-edit text, table cells, and SVG
labels, drag to reorder, resize, undo/redo, and leave inline comments.
Edits write straight back to the source file. Comments arrive back here as
user messages automatically (the `html-editor-comments` extension is
bundled with this package).

For anything deeper, read the README in the repo — it's a small tool,
inspect the code directly if you need more.
