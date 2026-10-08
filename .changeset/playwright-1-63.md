---
'renderready': patch
---

Update Playwright to 1.63. The `playwright-core` dependency now requires `^1.63.0`, and the Docker
image is built on `mcr.microsoft.com/playwright:v1.63.0-noble`, which ships the matching Chromium.
If you run renderready outside Docker, run `npx playwright install chromium` after upgrading so the
browser build matches.
