---
name: nyx-ui-screenshots
description: Regenerate the README UI screenshots for nyx-local-ai from the browser harness — build the webview, serve the harness scenes, capture and crop the images into docs/. Use when the UI changed visibly, when the user asks to update screenshots, or before a release with UI changes.
---

# Regenerating the UI screenshots

The README images in `docs/` are captured from `.harness/index.html`, which
renders the real webview bundle (`media/main.js` + `main.css`) with scripted
demo data inside a 430px sidebar frame.

## Workflow

1. **Build the current bundle**: `npm run build`
2. **Serve the repo** (background): `python3 -m http.server 8321 --bind 127.0.0.1`
3. **Capture each scene** with the IDE browser at
   `http://127.0.0.1:8321/.harness/index.html?scene=<scene>`; wait until the
   page title reads `nyx-scene-<scene>-ready`, then take a screenshot.

| Scene | Target file | Shows |
| --- | --- | --- |
| `chat` | `docs/nyx-agent-run.png` | tool cards, diff card, answer, 1M context meter |
| `approval` | `docs/nyx-approval.png` | diff-preview approval, Always allow, queue |
| `machines` | `docs/nyx-machines.png` | machine manager (DGX / Mac Studio) |

4. **Center-crop** each capture to the frame (screenshots are centered):

```bash
sips -c 1839 1062 docs/<file>.png --out docs/<file>.png
```

(Values assume the default 714×1024 CSS viewport at ~2.22× scale — if the
frame looks cut off, recompute: crop ≈ (430+68)×(780+68) CSS px × scale.)

5. **Review the images** (read the files) before committing: no debug text,
   context meter plausible, no real secrets/IPs you don't want public.

## Editing the scenes

Demo data lives in `.harness/index.html` (`sceneChat`, `sceneApproval`,
`sceneMachines`) — plain `HostToWebview` messages. When new UI features ship,
extend the relevant scene so the screenshots keep showcasing them.
