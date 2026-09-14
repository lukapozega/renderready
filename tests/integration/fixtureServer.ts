import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A tiny origin server for the integration suite.
 *
 * Pages are inline strings rather than files on disk: each one exists to
 * demonstrate exactly one behaviour, and having the HTML next to the route that
 * serves it makes that behaviour readable in one place.
 *
 * It also records the requests it received, so a test can assert what the
 * renderer did *not* fetch — which is how "a redirect is never followed" is
 * verified.
 */
export interface FixtureServer {
  url: string;
  /** Paths requested so far, in order. */
  requests: string[];
  reset(): void;
  close(): Promise<void>;
}

const page = (head: string, body: string): string =>
  `<!DOCTYPE html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

/** A page that declares readiness only after its content has been rendered. */
const READY_PAGE = page(
  '<title>Ready</title>',
  `<div id="app">loading</div>
   <script>
     window.renderReady = false;
     setTimeout(function () {
       document.getElementById('app').textContent = 'content from javascript';
       window.renderReady = true;
     }, 150);
   </script>`,
);

/** Declares the flag and never flips it: must ride out the budget. */
const NEVER_READY_PAGE = page(
  '<title>Never ready</title>',
  `<div id="app">partial content</div>
   <script>window.renderReady = false;</script>`,
);

/** Never mentions the flag: readiness has to come from network quiet. */
const NO_FLAG_PAGE = page(
  '<title>No flag</title>',
  `<div id="app">loading</div>
   <script>
     setTimeout(function () {
       document.getElementById('app').textContent = 'rendered without a flag';
     }, 50);
   </script>`,
);

/**
 * Content comes from a script the page loads from its own origin. Unlike an
 * inline script, that is a request the document makes, so it only renders if
 * the browser lets the document reach its own origin.
 */
const EXTERNAL_SCRIPT_PAGE = page(
  '<title>External script</title>',
  `<div id="app">loading</div>
   <script src="/app.js"></script>`,
);

/** Content arrives via fetch, so the quiet window is what decides. */
const XHR_PAGE = page(
  '<title>Xhr</title>',
  `<div id="app">loading</div>
   <script>
     fetch('/data.json')
       .then(function (response) { return response.json(); })
       .then(function (data) { document.getElementById('app').textContent = data.message; });
   </script>`,
);

const LD_JSON_PAGE = page(
  `<title>Structured data</title>
   <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Kept"}</script>`,
  `<div id="app">body</div>
   <script>window.sideEffect = 'should be stripped';</script>
   <script>window.sideEffect2 = 'also stripped';</script>`,
);

const RELATIVE_URL_PAGE = page(
  '<title>Relative</title><link rel="stylesheet" href="/styles.css">',
  `<img src="/logo.png" alt="logo"><a href="/about">About</a><a href="https://other.test/x">Other</a>`,
);

const META_404_PAGE = page(
  '<title>Not found</title><meta name="renderready-status-code" content="404">',
  '<h1>No such page</h1>',
);

const META_REDIRECT_PAGE = page(
  `<title>Moved</title>
   <meta name="renderready-status-code" content="302">
   <meta name="renderready-header" content="Location: https://example.test/elsewhere">`,
  '<h1>Moved</h1>',
);

const COOKIE_PAGE = page(
  '<title>Cookies</title>',
  `<div id="app"></div>
   <script>
     document.getElementById('app').textContent = 'cookie:[' + document.cookie + ']';
     document.cookie = 'left-behind=yes';
   </script>`,
);

const HEADER_ECHO_PAGE = (headerValue: string): string =>
  page('<title>Headers</title>', `<div id="app">x-renderready:${headerValue}</div>`);

/**
 * @param host Address to listen on, and the host in the returned `url`. Loopback
 * by default; a private network address puts the origin where Chromium's local
 * network access checks apply, which they do not to loopback.
 */
export async function startFixtureServer(host = '127.0.0.1'): Promise<FixtureServer> {
  const requests: string[] = [];

  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    requests.push(path);

    const html = (body: string, status = 200): void => {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      response.end(body);
    };

    switch (path) {
      case '/ready':
        return html(READY_PAGE);
      case '/never-ready':
        return html(NEVER_READY_PAGE);
      case '/no-flag':
        return html(NO_FLAG_PAGE);
      case '/xhr':
        return html(XHR_PAGE);
      case '/external-script':
        return html(EXTERNAL_SCRIPT_PAGE);
      case '/ld-json':
        return html(LD_JSON_PAGE);
      case '/relative':
        return html(RELATIVE_URL_PAGE);
      case '/meta-404':
        return html(META_404_PAGE);
      case '/meta-redirect':
        return html(META_REDIRECT_PAGE);
      case '/cookies':
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'origin-session=secret; Path=/',
        });
        return response.end(COOKIE_PAGE);
      case '/echo-headers':
        return html(HEADER_ECHO_PAGE(String(request.headers['x-renderready'] ?? 'absent')));
      case '/data.json':
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ message: 'content from fetch' }));

      case '/redirect':
        response.writeHead(302, { location: '/ready' });
        return response.end();
      case '/redirect-permanent':
        response.writeHead(301, { location: '/ready' });
        return response.end();

      case '/server-error':
        return html(page('<title>Boom</title>', '<h1>Internal error</h1>'), 500);
      case '/gone':
        return html(page('<title>Gone</title>', '<h1>Gone</h1>'), 410);

      case '/custom-header':
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'x-origin-marker': 'present',
        });
        return response.end(page('<title>Header</title>', 'ok'));

      case '/app.js':
        response.writeHead(200, { 'content-type': 'text/javascript' });
        return response.end(
          "document.getElementById('app').textContent = 'content from an external script';",
        );

      case '/styles.css':
        response.writeHead(200, { 'content-type': 'text/css' });
        return response.end('body{color:red}');
      case '/logo.png':
        response.writeHead(200, { 'content-type': 'image/png' });
        return response.end(Buffer.alloc(0));

      default:
        return html(page('<title>404</title>', '<h1>Not found</h1>'), 404);
    }
  });

  await new Promise<void>(resolve => {
    server.listen(0, host, resolve);
  });

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${host}:${port}`,
    requests,
    reset: () => {
      requests.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      }),
  };
}
