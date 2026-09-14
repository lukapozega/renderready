---
'renderready': patch
---

Render pages from origins on private network addresses, such as a Docker service name over plain
http. Redirect detection used to hand the browser a document fetched from Node, which Chromium
treats as public, so its local network access checks blocked every script and stylesheet the page
loaded from its own origin and the render came back empty. The browser now receives the document
from the network itself, and redirects are still reported without fetching the destination.
