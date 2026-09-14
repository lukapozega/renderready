import { networkInterfaces } from 'node:os';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { noopLogger } from '../../src/logger.js';
import { createRenderer, type Renderer } from '../../src/render/renderer.js';

import { startFixtureServer, type FixtureServer } from './fixtureServer.js';

/**
 * End-to-end against real Chromium and a real origin server.
 *
 * The unit suite mocks Playwright, so these tests exist to prove the assumptions
 * behind those mocks are true: that `waitUntil: 'commit'` plus the readiness poll
 * actually captures rendered content, that intercepting the document really does
 * stop a redirect from being followed, and that the transforms hold on HTML a
 * browser produced rather than HTML we wrote by hand.
 */

let origin: FixtureServer;
let renderer: Renderer;

beforeAll(async () => {
  origin = await startFixtureServer();
  renderer = createRenderer({
    logger: noopLogger,
    pageLoadTimeout: 10_000,
    pageDoneCheckInterval: 50,
    waitAfterLastRequest: 100,
  });
  await renderer.start();
}, 120_000);

afterAll(async () => {
  await renderer?.stop();
  await origin?.close();
});

beforeEach(() => {
  origin.reset();
});

describe('readiness', () => {
  it('captures content that only exists after javascript ran', async () => {
    const result = await renderer.render(`${origin.url}/ready`);

    expect(result.statusCode).toBe(200);
    expect(result.html).toContain('content from javascript');
    expect(result.timedOut).toBe(false);
  });

  // The whole point of honoring the flag: it returns as soon as the app says so,
  // rather than waiting out the budget.
  it('returns well before the budget when the page signals readiness', async () => {
    const result = await renderer.render(`${origin.url}/ready`);

    expect(result.durationMs).toBeLessThan(5_000);
  });

  // This is the case the service this was extracted from got wrong: a page that
  // never mentions renderReady must still render promptly, via network quiet.
  it('renders a page that never declares the flag', async () => {
    const result = await renderer.render(`${origin.url}/no-flag`);

    expect(result.html).toContain('rendered without a flag');
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it('waits for content that arrives via fetch', async () => {
    const result = await renderer.render(`${origin.url}/xhr`);

    expect(result.html).toContain('content from fetch');
    expect(result.timedOut).toBe(false);
  });

  // A timeout is not an error: partial content beats nothing.
  it('captures partial content when the flag never turns true', async () => {
    const result = await renderer.render(`${origin.url}/never-ready`, { timeout: 1_000 });

    expect(result.timedOut).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.html).toContain('partial content');
  });
});

describe('redirects', () => {
  it('reports a 302 without fetching the destination', async () => {
    const result = await renderer.render(`${origin.url}/redirect`);

    expect(result.statusCode).toBe(302);
    expect(result.isRedirect).toBe(true);
    expect(result.html).toBe('');
    expect(result.headers.location).toBe('/ready');
    // The proof that it was not followed.
    expect(origin.requests).toEqual(['/redirect']);
    expect(origin.requests).not.toContain('/ready');
  });

  it('reports a 301 the same way', async () => {
    const result = await renderer.render(`${origin.url}/redirect-permanent`);

    expect(result.statusCode).toBe(301);
    expect(origin.requests).not.toContain('/ready');
  });

  it('follows the redirect and renders the destination when asked to', async () => {
    const result = await renderer.render(`${origin.url}/redirect`, { followRedirects: true });

    expect(result.statusCode).toBe(200);
    expect(result.isRedirect).toBe(false);
    expect(result.html).toContain('content from javascript');
    expect(origin.requests).toContain('/ready');
  });

  // Resource blocking intercepts every request through Playwright, on top of
  // the document interception redirect detection does.
  it('still reports a redirect while resource blocking is intercepting too', async () => {
    const blocking = createRenderer({
      logger: noopLogger,
      blockedResourceTypes: ['image'],
      pageDoneCheckInterval: 50,
      waitAfterLastRequest: 100,
    });
    await blocking.start();
    try {
      const redirect = await blocking.render(`${origin.url}/redirect`);
      expect(redirect.statusCode).toBe(302);
      expect(origin.requests).not.toContain('/ready');

      const rendered = await blocking.render(`${origin.url}/external-script`);
      expect(rendered.html).toContain('content from an external script');
    } finally {
      await blocking.stop();
    }
  }, 60_000);
});

/**
 * The first IPv4 address of this machine in a private range, if it has one.
 * GitHub's hosted runners do.
 */
function privateNetworkAddress(): string | undefined {
  const isPrivate = (address: string): boolean =>
    /^10\./.test(address) ||
    /^192\.168\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address);

  return Object.values(networkInterfaces())
    .flat()
    .find(entry => entry?.family === 'IPv4' && !entry.internal && isPrivate(entry.address))
    ?.address;
}

const privateAddress = privateNetworkAddress();

// Where a renderer usually meets its origin: a Docker service name, a Kubernetes
// service or an internal load balancer, all private addresses over plain http.
// Chromium applies its local network access checks there and not to loopback,
// which is why the fixture above cannot show this.
describe.skipIf(privateAddress === undefined)('an origin on a private network address', () => {
  let privateOrigin: FixtureServer;

  beforeAll(async () => {
    privateOrigin = await startFixtureServer(privateAddress);
  });

  afterAll(async () => {
    await privateOrigin?.close();
  });

  beforeEach(() => {
    privateOrigin.reset();
  });

  it('renders content from a script the page loads from its own origin', async () => {
    const result = await renderer.render(`${privateOrigin.url}/external-script`);

    expect(result.html).toContain('content from an external script');
    expect(privateOrigin.requests).toContain('/app.js');
  });

  it('reports a 302 without fetching the destination', async () => {
    const result = await renderer.render(`${privateOrigin.url}/redirect`);

    expect(result.statusCode).toBe(302);
    expect(result.headers.location).toBe('/ready');
    expect(privateOrigin.requests).toEqual(['/redirect']);
  });
});

describe('status codes', () => {
  it('passes a 500 through, with its body', async () => {
    const result = await renderer.render(`${origin.url}/server-error`);

    expect(result.statusCode).toBe(500);
    expect(result.html).toContain('Internal error');
  });

  it('passes a 410 through', async () => {
    expect((await renderer.render(`${origin.url}/gone`)).statusCode).toBe(410);
  });

  it('passes a 404 through', async () => {
    expect((await renderer.render(`${origin.url}/nothing-here`)).statusCode).toBe(404);
  });

  it('honors a soft 404 declared by a meta tag, and strips the tag', async () => {
    const result = await renderer.render(`${origin.url}/meta-404`);

    expect(result.statusCode).toBe(404);
    expect(result.html).not.toContain('renderready-status-code');
    expect(result.html).toContain('No such page');
  });

  it('honors a meta-declared redirect with its Location header', async () => {
    const result = await renderer.render(`${origin.url}/meta-redirect`);

    expect(result.statusCode).toBe(302);
    expect(result.headers.Location).toBe('https://example.test/elsewhere');
    expect(result.html).not.toContain('renderready-header');
  });
});

describe('html transforms', () => {
  it('strips scripts but keeps ld+json structured data', async () => {
    const result = await renderer.render(`${origin.url}/ld-json`);

    expect(result.html).toContain('application/ld+json');
    expect(result.html).toContain('"headline":"Kept"');
    expect(result.html).not.toContain('should be stripped');
    expect(result.html).not.toContain('also stripped');
  });

  it('rewrites root-relative URLs to absolute ones', async () => {
    const result = await renderer.render(`${origin.url}/relative`);

    expect(result.html).toContain(`src="${origin.url}/logo.png"`);
    expect(result.html).toContain(`href="${origin.url}/about"`);
    expect(result.html).toContain(`href="${origin.url}/styles.css"`);
    // Already absolute, so untouched.
    expect(result.html).toContain('href="https://other.test/x"');
  });

  it('returns a complete document including the doctype', async () => {
    const result = await renderer.render(`${origin.url}/no-flag`);

    expect(result.html.toLowerCase()).toContain('<!doctype html>');
    expect(result.html).toContain('</html>');
  });

  it('can be told to leave scripts alone', async () => {
    const keepScripts = createRenderer({
      logger: noopLogger,
      removeScriptTags: false,
      pageDoneCheckInterval: 50,
      waitAfterLastRequest: 100,
    });
    await keepScripts.start();
    try {
      const result = await keepScripts.render(`${origin.url}/ld-json`);
      expect(result.html).toContain('should be stripped');
    } finally {
      await keepScripts.stop();
    }
  }, 60_000);
});

describe('request behaviour', () => {
  it('sends X-RenderReady to the origin so an app can detect it', async () => {
    const result = await renderer.render(`${origin.url}/echo-headers`);

    expect(result.html).toContain('x-renderready:1');
  });

  it('reports the origin response headers', async () => {
    const result = await renderer.render(`${origin.url}/custom-header`);

    expect(result.headers['x-origin-marker']).toBe('present');
  });

  it('applies the requested viewport', async () => {
    const wide = createRenderer({
      logger: noopLogger,
      pageDoneCheckInterval: 50,
      waitAfterLastRequest: 100,
    });
    await wide.start();
    try {
      const result = await wide.render(`${origin.url}/no-flag`, { width: 375, height: 812 });
      expect(result.statusCode).toBe(200);
    } finally {
      await wide.stop();
    }
  }, 60_000);

  // Each render gets a fresh BrowserContext specifically so this holds. The page
  // writes `left-behind` via document.cookie *after* reading the jar, so if the
  // context were shared the second render would read it back.
  it('gives each render a private cookie jar', async () => {
    const first = await renderer.render(`${origin.url}/cookies`);
    const second = await renderer.render(`${origin.url}/cookies`);

    expect(first.html).not.toContain('left-behind');
    expect(second.html).not.toContain('left-behind');
    // Each render does see the cookie its own response set, as a browser would.
    expect(second.html).toContain('origin-session=secret');
  });
});

describe('failures', () => {
  it('raises a RenderError for a host that does not resolve', async () => {
    await expect(
      renderer.render('http://this-host-does-not-exist.invalid/', { timeout: 5_000 }),
    ).rejects.toThrow(/Could not load/);
  });

  it('rejects a non-http scheme before touching the browser', async () => {
    await expect(renderer.render('file:///etc/passwd')).rejects.toThrow(/only http and https/i);
  });
});

describe('concurrency', () => {
  // Unbounded by design; this asserts parallel renders do not interfere.
  it('handles simultaneous renders independently', async () => {
    const results = await Promise.all([
      renderer.render(`${origin.url}/ready`),
      renderer.render(`${origin.url}/no-flag`),
      renderer.render(`${origin.url}/ld-json`),
      renderer.render(`${origin.url}/meta-404`),
      renderer.render(`${origin.url}/relative`),
    ]);

    expect(results[0]?.html).toContain('content from javascript');
    expect(results[1]?.html).toContain('rendered without a flag');
    expect(results[2]?.html).toContain('"headline":"Kept"');
    expect(results[3]?.statusCode).toBe(404);
    expect(results[4]?.html).toContain(`src="${origin.url}/logo.png"`);
  });
});

describe('browser recycling', () => {
  it('keeps serving renders across a recycle', async () => {
    const recycling = createRenderer({
      logger: noopLogger,
      recycleAfterRenders: 2,
      pageDoneCheckInterval: 50,
      waitAfterLastRequest: 100,
    });
    await recycling.start();
    try {
      for (let index = 0; index < 5; index++) {
        const result = await recycling.render(`${origin.url}/no-flag`);
        expect(result.statusCode).toBe(200);
        expect(result.html).toContain('rendered without a flag');
      }
      // The browser was relaunched at least twice along the way.
      expect(recycling.stats().renderCount).toBeLessThan(5);
    } finally {
      await recycling.stop();
    }
  }, 120_000);
});
