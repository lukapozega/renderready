import { chromium } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InvalidUrlError, UrlNotAllowedError } from '../../src/errors.js';
import type { Hooks } from '../../src/hooks.js';
import { noopLogger } from '../../src/logger.js';
import { createRenderer, type Renderer } from '../../src/render/renderer.js';

vi.mock('playwright-core', () => ({
  chromium: { launch: vi.fn() },
}));

const launchMock = vi.mocked(chromium.launch);

/** What the fake page will report for the next render. */
interface PageScript {
  html: string;
  status: number;
  headers: Record<string, string>;
  /** Set to make the navigation fail. */
  gotoError?: Error;
  /** Set to make readiness never complete, forcing a timeout. */
  neverReady?: boolean;
  /** Set to make the requested URL answer with a redirect. */
  redirect?: { status: number; headers: Record<string, string> };
}

let script: PageScript;
let lastContextOptions: Record<string, unknown> | undefined;
let lastViewport: { width: number; height: number } | undefined;

function makeFakeBrowser() {
  const makePage = () => {
    let onPaused: ((event: unknown) => void) | undefined;
    let released: (() => void) | undefined;

    const session = {
      on: vi.fn((_event: string, listener: (event: unknown) => void) => {
        onPaused = listener;
      }),
      send: vi.fn(async (method: string) => {
        if (method === 'Fetch.failRequest' || method === 'Fetch.continueRequest') {
          released?.();
        }
        return {};
      }),
      detach: vi.fn(async () => {}),
    };

    return {
      setViewportSize: vi.fn(async (viewport: { width: number; height: number }) => {
        lastViewport = viewport;
      }),
      route: vi.fn(async () => {}),
      context: () => ({ newCDPSession: vi.fn(async () => session) }),
      goto: vi.fn(async () => {
        // Pause the document on the session the way a real navigation would, so
        // the redirect path is genuinely exercised rather than simulated.
        if (script.redirect && onPaused) {
          const release = new Promise<void>(resolve => {
            released = resolve;
          });
          onPaused({
            requestId: '1',
            request: { url: 'https://example.test/' },
            responseStatusCode: script.redirect.status,
            responseHeaders: Object.entries(script.redirect.headers).map(([name, value]) => ({
              name,
              value,
            })),
          });
          await release;
          throw new Error('net::ERR_ABORTED');
        }
        if (script.gotoError) {
          throw script.gotoError;
        }
        return { status: () => script.status, allHeaders: async () => script.headers };
      }),
      content: vi.fn(async () => script.html),
      evaluate: vi.fn(async () => ({
        domReady: !script.neverReady,
        renderReady: null,
      })),
      url: vi.fn(() => 'https://example.test/'),
      on: vi.fn(),
      off: vi.fn(),
    };
  };

  let contextCount = 0;
  return {
    version: vi.fn(() => '140.0.0.0'),
    newContext: vi.fn(async (options: Record<string, unknown> = {}) => {
      // The very first context is the manager's user-agent probe, not a render.
      contextCount++;
      if (contextCount > 1) {
        lastContextOptions = options;
      }
      return {
        newPage: vi.fn(async () => makePage()),
        close: vi.fn(async () => {}),
      };
    }),
    close: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
  };
}

let renderer: Renderer | undefined;

beforeEach(() => {
  script = { html: '<html><head></head><body>hi</body></html>', status: 200, headers: {} };
  lastContextOptions = undefined;
  lastViewport = undefined;
  launchMock.mockReset();
  launchMock.mockImplementation(
    async () => makeFakeBrowser() as unknown as Awaited<ReturnType<typeof chromium.launch>>,
  );
});

afterEach(async () => {
  await renderer?.stop();
  renderer = undefined;
});

async function startRenderer(
  options: Parameters<typeof createRenderer>[0] = {},
): Promise<Renderer> {
  renderer = createRenderer({
    logger: noopLogger,
    // The production defaults make every render wait out a 500ms quiet window,
    // which would put the whole suite in the tens of seconds for no benefit.
    waitAfterLastRequest: 0,
    pageDoneCheckInterval: 5,
    ...options,
  });
  await renderer.start();
  return renderer;
}

describe('createRenderer', () => {
  it('renders a URL and returns transformed HTML', async () => {
    script.html = '<html><head><script>app()</script></head><body><img src="/a.png"></body></html>';
    const active = await startRenderer();

    const result = await active.render('https://example.test/page');

    expect(result.statusCode).toBe(200);
    expect(result.html).not.toContain('app()');
    expect(result.html).toContain('src="https://example.test/a.png"');
    expect(result.url).toBe('https://example.test/page');
    expect(result.renderId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('normalizes the URL before rendering', async () => {
    const active = await startRenderer();

    const result = await active.render('  https://example.test  ');

    expect(result.url).toBe('https://example.test/');
  });

  it('rejects an invalid URL without touching the browser', async () => {
    const active = await startRenderer();

    await expect(active.render('not-a-url')).rejects.toThrow(InvalidUrlError);
  });

  it('rejects a URL excluded by the allow list', async () => {
    const active = await startRenderer({ allowedDomains: ['allowed.test'] });

    await expect(active.render('https://other.test/')).rejects.toThrow(UrlNotAllowedError);
  });

  it('exposes the resolved configuration', async () => {
    const active = await startRenderer({ pageLoadTimeout: 1234 });

    expect(active.config.render.pageLoadTimeout).toBe(1234);
  });

  it('reports readiness from the browser manager', async () => {
    const active = await startRenderer();

    expect(active.isReady()).toBe(true);
    expect(active.stats()).toMatchObject({ ready: true, renderCount: 0 });
  });

  describe('per-request options', () => {
    it('uses the configured viewport by default', async () => {
      const active = await startRenderer();

      await active.render('https://example.test/');

      expect(lastViewport).toEqual({ width: 1440, height: 718 });
    });

    it('honors width and height overrides', async () => {
      const active = await startRenderer();

      await active.render('https://example.test/', { width: 375, height: 812 });

      expect(lastViewport).toEqual({ width: 375, height: 812 });
    });

    it('honors a user-agent override', async () => {
      const active = await startRenderer();

      await active.render('https://example.test/', { userAgent: 'MyCrawler/2.0' });

      expect(lastContextOptions?.userAgent).toBe('MyCrawler/2.0');
    });

    it('sends the configured origin headers so an app can detect the renderer', async () => {
      const active = await startRenderer();

      await active.render('https://example.test/');

      expect(lastContextOptions?.extraHTTPHeaders).toEqual({ 'X-RenderReady': '1' });
    });

    it('sends no extra headers when originHeaders is emptied', async () => {
      const active = await startRenderer({ originHeaders: {} });

      await active.render('https://example.test/');

      expect(lastContextOptions?.extraHTTPHeaders).toBeUndefined();
    });
  });

  describe('status resolution', () => {
    it('passes the origin status through', async () => {
      script.status = 503;
      const active = await startRenderer();

      expect((await active.render('https://example.test/')).statusCode).toBe(503);
    });

    it('uses renderErrorStatusCode when there was no response', async () => {
      script.status = 0;
      const active = await startRenderer({ renderErrorStatusCode: 502 });

      expect((await active.render('https://example.test/')).statusCode).toBe(502);
    });

    it('lets a meta status code override the origin', async () => {
      script.html = '<html><head><meta name="renderready-status-code" content="404"></head></html>';
      const active = await startRenderer();

      const result = await active.render('https://example.test/');

      expect(result.statusCode).toBe(404);
      expect(result.html).not.toContain('renderready-status-code');
    });

    it('merges headers requested via meta tags over the origin headers', async () => {
      script.headers = { 'content-type': 'text/html' };
      script.html =
        '<html><head><meta name="renderready-header" content="Location: /new"></head></html>';
      const active = await startRenderer();

      const result = await active.render('https://example.test/');

      expect(result.headers).toEqual({ 'content-type': 'text/html', Location: '/new' });
    });

    it('applies timeoutStatusCode when the render times out', async () => {
      script.neverReady = true;
      const active = await startRenderer({
        pageLoadTimeout: 30,
        pageDoneCheckInterval: 10,
        timeoutStatusCode: 504,
      });

      const result = await active.render('https://example.test/');

      expect(result.timedOut).toBe(true);
      expect(result.statusCode).toBe(504);
    });

    it('keeps the origin status on timeout when no timeoutStatusCode is set', async () => {
      script.neverReady = true;
      script.status = 200;
      const active = await startRenderer({ pageLoadTimeout: 30, pageDoneCheckInterval: 10 });

      const result = await active.render('https://example.test/');

      expect(result.timedOut).toBe(true);
      expect(result.statusCode).toBe(200);
    });

    // The app knows its own routing better than the timeout heuristic does.
    it('lets a meta status code win over timeoutStatusCode', async () => {
      script.neverReady = true;
      script.html = '<html><head><meta name="renderready-status-code" content="404"></head></html>';
      const active = await startRenderer({
        pageLoadTimeout: 30,
        pageDoneCheckInterval: 10,
        timeoutStatusCode: 504,
      });

      expect((await active.render('https://example.test/')).statusCode).toBe(404);
    });

    it('reports a redirect with its Location header and no body', async () => {
      script.redirect = { status: 301, headers: { location: 'https://example.test/moved' } };
      const active = await startRenderer();

      const result = await active.render('https://example.test/');

      expect(result.statusCode).toBe(301);
      expect(result.isRedirect).toBe(true);
      expect(result.html).toBe('');
      expect(result.headers.location).toBe('https://example.test/moved');
    });

    // There is no document to transform, and injecting provenance tags into an
    // empty body would produce a response that looks like a page but is not one.
    it('skips transforms entirely for a redirect', async () => {
      script.redirect = { status: 302, headers: {} };
      const active = await startRenderer({ injectRenderMeta: true });

      const result = await active.render('https://example.test/');

      expect(result.html).toBe('');
      expect(result.html).not.toContain('x-renderready-render-id');
    });

    it('applies transforms on a normal render', async () => {
      const active = await startRenderer({ injectRenderMeta: true });

      const result = await active.render('https://example.test/');

      expect(result.isRedirect).toBe(false);
      expect(result.html).toContain('x-renderready-render-id');
    });
  });

  describe('hooks', () => {
    it('calls onRequest before any browser work', async () => {
      const onRequest = vi.fn();
      const active = await startRenderer({ hooks: { onRequest } });

      await active.render('https://example.test/page');

      expect(onRequest).toHaveBeenCalledTimes(1);
      expect(onRequest.mock.calls[0]?.[0]).toMatchObject({ url: 'https://example.test/page' });
    });

    it('lets onRequest abort the render', async () => {
      const hooks: Hooks = {
        onRequest: () => {
          throw new Error('denied');
        },
      };
      const active = await startRenderer({ hooks });

      await expect(active.render('https://example.test/')).rejects.toThrow('denied');
    });

    it('calls onPageCreated with the page before navigation', async () => {
      const calls: string[] = [];
      const hooks: Hooks = {
        onPageCreated: page => {
          calls.push('created');
          expect(page).toBeDefined();
        },
      };
      const active = await startRenderer({ hooks });

      await active.render('https://example.test/');

      expect(calls).toEqual(['created']);
    });

    it('lets onPageLoaded rewrite the html, status and headers', async () => {
      const hooks: Hooks = {
        onPageLoaded: context => {
          context.html = '<html>replaced</html>';
          context.statusCode = 418;
          context.headers['X-Cache'] = 'MISS';
        },
      };
      const active = await startRenderer({ hooks });

      const result = await active.render('https://example.test/');

      expect(result.html).toBe('<html>replaced</html>');
      expect(result.statusCode).toBe(418);
      expect(result.headers['X-Cache']).toBe('MISS');
    });

    it('reports timings to onRenderFinished on success', async () => {
      const onRenderFinished = vi.fn();
      const active = await startRenderer({ hooks: { onRenderFinished } });

      await active.render('https://example.test/');

      expect(onRenderFinished).toHaveBeenCalledTimes(1);
      expect(onRenderFinished.mock.calls[0]?.[0]).toMatchObject({
        url: 'https://example.test/',
        statusCode: 200,
        isRedirect: false,
      });
      expect(onRenderFinished.mock.calls[0]?.[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('reports the error to onRenderFinished on failure', async () => {
      script.gotoError = new Error('net::ERR_FAILED');
      const onRenderFinished = vi.fn();
      const active = await startRenderer({ hooks: { onRenderFinished } });

      await expect(active.render('https://example.test/')).rejects.toThrow();

      expect(onRenderFinished).toHaveBeenCalledTimes(1);
      expect(onRenderFinished.mock.calls[0]?.[0].error).toBeDefined();
      expect(onRenderFinished.mock.calls[0]?.[0].statusCode).toBeUndefined();
    });

    it('reports a hook rejection to onRenderFinished too', async () => {
      const onRenderFinished = vi.fn();
      const hooks: Hooks = {
        onRequest: () => {
          throw new Error('denied');
        },
        onRenderFinished,
      };
      const active = await startRenderer({ hooks });

      await expect(active.render('https://example.test/')).rejects.toThrow('denied');

      expect(onRenderFinished).toHaveBeenCalledTimes(1);
    });

    // Metrics code must not be able to break rendering.
    it('swallows an error thrown by onRenderFinished', async () => {
      const hooks: Hooks = {
        onRenderFinished: () => {
          throw new Error('statsd is down');
        },
      };
      const active = await startRenderer({ hooks });

      await expect(active.render('https://example.test/')).resolves.toMatchObject({
        statusCode: 200,
      });
    });

    it('awaits async hooks', async () => {
      const order: string[] = [];
      const hooks: Hooks = {
        onRequest: async () => {
          await new Promise(resolve => setTimeout(resolve, 5));
          order.push('request');
        },
        onPageLoaded: async () => {
          await new Promise(resolve => setTimeout(resolve, 5));
          order.push('loaded');
        },
      };
      const active = await startRenderer({ hooks });

      await active.render('https://example.test/');

      expect(order).toEqual(['request', 'loaded']);
    });
  });

  describe('failures', () => {
    it('propagates a navigation failure as a RenderError', async () => {
      script.gotoError = new Error('net::ERR_NAME_NOT_RESOLVED');
      const active = await startRenderer();

      await expect(active.render('https://example.test/')).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
    });
  });
});
