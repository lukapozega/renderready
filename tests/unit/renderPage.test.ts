import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';

import { renderPage, type RenderPageOptions } from '../../src/browser/renderPage.js';
import { RenderError } from '../../src/errors.js';
import { noopLogger } from '../../src/logger.js';

interface RouteHandlerEntry {
  matcher: string | ((url: URL) => boolean);
  handler: (route: FakeRoute) => unknown;
}

class FakeRoute {
  aborted = false;
  continued = false;
  private readonly requestUrl: string;
  private readonly resourceType: string;

  constructor(requestUrl: string, resourceType: string) {
    this.requestUrl = requestUrl;
    this.resourceType = resourceType;
  }

  request = () => ({
    resourceType: () => this.resourceType,
    url: () => this.requestUrl,
  });

  abort = vi.fn(async () => {
    this.aborted = true;
  });

  continue = vi.fn(async () => {
    this.continued = true;
  });
}

/** A response for the navigation to present at the response stage. */
interface PausedResponse {
  url: string;
  status: number;
  headers?: { name: string; value: string }[];
}

/**
 * The CDP session redirect detection opens. `pause` plays Chromium's part: it
 * emits `Fetch.requestPaused` and resolves once the listener has released the
 * request, with whichever command released it.
 */
class FakeCDPSession {
  readonly sent: { method: string; params: Record<string, unknown> }[] = [];
  detached = false;
  /** Make every command after `Fetch.enable` fail, as when the page has closed. */
  releaseError: Error | undefined;
  private listener: ((event: unknown) => void) | undefined;
  private readonly releases = new Map<string, (method: string) => void>();
  private nextRequestId = 1;

  on = vi.fn((event: string, listener: (event: unknown) => void) => {
    if (event === 'Fetch.requestPaused') {
      this.listener = listener;
    }
    return this;
  });

  send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    this.sent.push({ method, params });
    const release = this.releases.get(String(params.requestId));
    if (method !== 'Fetch.enable' && this.releaseError) {
      release?.('failed');
      throw this.releaseError;
    }
    release?.(method);
    return {};
  });

  detach = vi.fn(async () => {
    this.detached = true;
  });

  get enabled(): boolean {
    return this.sent.some(command => command.method === 'Fetch.enable');
  }

  pause(response: PausedResponse): Promise<string> {
    const requestId = String(this.nextRequestId++);
    const released = new Promise<string>(resolve => this.releases.set(requestId, resolve));
    this.listener?.({
      requestId,
      request: { url: response.url },
      responseStatusCode: response.status,
      responseHeaders: response.headers ?? [],
    });
    return released;
  }

  sentMethods(): string[] {
    return this.sent.map(command => command.method);
  }
}

/**
 * A page whose `goto` presents its responses to the CDP session, the way a real
 * navigation would. That is what lets these tests exercise redirect detection
 * without a browser.
 */
class FakePage {
  readonly routes: RouteHandlerEntry[] = [];
  readonly viewports: { width: number; height: number }[] = [];
  readonly session = new FakeCDPSession();
  cdpError: Error | undefined;
  gotoStatus = 200;
  gotoHeaders: Record<string, string> = { 'content-type': 'text/html' };
  gotoError: Error | undefined;
  gotoReturnsNull = false;
  contentError: Error | undefined;
  htmlContent = '<html><body>rendered</body></html>';
  /** Document responses the navigation pauses on, in order, if interception is enabled. */
  pausedResponses: PausedResponse[] = [];

  url = vi.fn(() => 'https://example.test/');
  setViewportSize = vi.fn(async (viewport: { width: number; height: number }) => {
    this.viewports.push(viewport);
  });

  newCDPSession = vi.fn(async () => {
    if (this.cdpError) {
      throw this.cdpError;
    }
    return this.session;
  });

  context = () => ({ newCDPSession: this.newCDPSession });

  /** How the origin answers a probe from Node; unset makes the probe fail. */
  probeResponse: { status: number; headers: Record<string, string> } | undefined;
  probeDisposed = false;

  request = {
    fetch: vi.fn(async () => {
      const answer = this.probeResponse;
      if (!answer) {
        throw new Error('connect ECONNREFUSED');
      }
      return {
        status: () => answer.status,
        headers: () => answer.headers,
        dispose: async () => {
          this.probeDisposed = true;
        },
      };
    }),
  };

  route = vi.fn(
    async (matcher: RouteHandlerEntry['matcher'], handler: RouteHandlerEntry['handler']) => {
      this.routes.push({ matcher, handler });
    },
  );

  goto = vi.fn(async () => {
    if (this.session.enabled) {
      for (const response of this.pausedResponses) {
        // A failed request is an aborted navigation, as Chromium reports it.
        if ((await this.session.pause(response)) === 'Fetch.failRequest') {
          throw new Error('net::ERR_ABORTED');
        }
      }
    }
    if (this.gotoError) {
      throw this.gotoError;
    }
    if (this.gotoReturnsNull) {
      return null;
    }
    return {
      status: () => this.gotoStatus,
      allHeaders: async () => this.gotoHeaders,
    };
  });

  content = vi.fn(async () => {
    if (this.contentError) {
      throw this.contentError;
    }
    return this.htmlContent;
  });

  // Readiness: parsed, and no renderReady flag declared.
  evaluate = vi.fn(async () => ({ domReady: true, renderReady: null }));

  on = vi.fn();
  off = vi.fn();

  waitForLoadState = vi.fn();
}

const asPage = (page: FakePage): Page => page as unknown as Page;

const options = (overrides: Partial<RenderPageOptions> = {}): RenderPageOptions => ({
  url: 'https://example.test/',
  viewport: { width: 1440, height: 718 },
  timeoutMs: 5_000,
  followRedirects: false,
  readiness: { pageDoneCheckInterval: 5, waitAfterLastRequest: 0, renderReadyDelay: 10 },
  blockedResourceTypes: [],
  blockedUrlPatterns: [],
  logger: noopLogger,
  ...overrides,
});

describe('renderPage', () => {
  it('navigates, waits for readiness and returns the HTML', async () => {
    const page = new FakePage();

    const result = await renderPage(asPage(page), options());

    expect(result).toMatchObject({
      html: '<html><body>rendered</body></html>',
      status: 200,
      isRedirect: false,
      timedOut: false,
    });
  });

  it('sets the requested viewport', async () => {
    const page = new FakePage();

    await renderPage(asPage(page), options({ viewport: { width: 640, height: 480 } }));

    expect(page.viewports).toEqual([{ width: 640, height: 480 }]);
  });

  // Readiness is decided by the poll loop; waiting on a load state would
  // reintroduce the networkidle problem this design exists to avoid.
  it('never waits on a Playwright load state', async () => {
    const page = new FakePage();

    await renderPage(asPage(page), options());

    expect(page.waitForLoadState).not.toHaveBeenCalled();
  });

  it('commits the navigation rather than waiting for load', async () => {
    const page = new FakePage();

    await renderPage(asPage(page), options());

    expect(page.goto).toHaveBeenCalledWith(
      'https://example.test/',
      expect.objectContaining({ waitUntil: 'commit' }),
    );
  });

  it('passes the origin response headers through', async () => {
    const page = new FakePage();
    page.gotoHeaders = { 'content-type': 'text/html', 'x-custom': 'yes' };

    const result = await renderPage(asPage(page), options());

    expect(result.headers).toEqual({ 'content-type': 'text/html', 'x-custom': 'yes' });
  });

  it('passes a 5xx status through instead of failing', async () => {
    const page = new FakePage();
    page.gotoStatus = 503;

    const result = await renderPage(asPage(page), options());

    expect(result.status).toBe(503);
    expect(result.isRedirect).toBe(false);
  });

  // Every render gets an empty cache, so there is nothing for a caller to
  // revalidate a 304 against.
  it('reports a 304 as 200', async () => {
    const page = new FakePage();
    page.gotoStatus = 304;

    expect((await renderPage(asPage(page), options())).status).toBe(200);
  });

  it('reports status 0 when there is no response object', async () => {
    const page = new FakePage();
    page.gotoReturnsNull = true;

    const result = await renderPage(asPage(page), options());

    expect(result.status).toBe(0);
    expect(result.headers).toEqual({});
  });

  it('raises a RenderError when navigation fails', async () => {
    const page = new FakePage();
    page.gotoError = new Error('net::ERR_NAME_NOT_RESOLVED');

    await expect(renderPage(asPage(page), options())).rejects.toThrow(RenderError);
    await expect(renderPage(asPage(page), options())).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
  });

  it('raises a RenderError when the content cannot be read', async () => {
    const page = new FakePage();
    page.contentError = new Error('Target closed');

    await expect(renderPage(asPage(page), options())).rejects.toThrow(/Could not read the page/);
  });

  it('captures partial HTML when readiness times out', async () => {
    const page = new FakePage();
    page.evaluate.mockResolvedValue({ domReady: false, renderReady: null });

    const result = await renderPage(asPage(page), options({ timeoutMs: 30 }));

    expect(result.timedOut).toBe(true);
    expect(result.html).toBe('<html><body>rendered</body></html>');
  });

  describe('redirect detection', () => {
    it('returns the 3xx without loading the destination', async () => {
      const page = new FakePage();
      page.pausedResponses = [
        {
          url: 'https://example.test/',
          status: 302,
          headers: [{ name: 'Location', value: 'https://example.test/new' }],
        },
      ];

      const result = await renderPage(asPage(page), options());

      expect(result).toMatchObject({ status: 302, isRedirect: true, html: '' });
      expect(result.headers.location).toBe('https://example.test/new');
      expect(page.session.sentMethods()).toContain('Fetch.failRequest');
      expect(page.session.sentMethods()).not.toContain('Fetch.continueRequest');
      expect(page.request.fetch).not.toHaveBeenCalled();
    });

    describe('a redirect Chromium made itself', () => {
      const hstsUpgrade: PausedResponse = {
        url: 'http://example.test/',
        status: 307,
        headers: [
          { name: 'Location', value: 'https://example.test/' },
          { name: 'Non-Authoritative-Reason', value: 'HSTS' },
        ],
      };

      it("reports the origin's own redirect instead", async () => {
        const page = new FakePage();
        page.pausedResponses = [hstsUpgrade];
        page.probeResponse = { status: 301, headers: { location: 'https://example.test/' } };

        const result = await renderPage(asPage(page), options({ url: 'http://example.test/' }));

        expect(result).toMatchObject({ status: 301, isRedirect: true, html: '' });
        expect(result.headers).toEqual({ location: 'https://example.test/' });
        expect(page.request.fetch).toHaveBeenCalledWith(
          'http://example.test/',
          expect.objectContaining({ maxRedirects: 0 }),
        );
        expect(page.probeDisposed).toBe(true);
      });

      it('is followed when the origin itself does not redirect', async () => {
        const page = new FakePage();
        page.pausedResponses = [hstsUpgrade];
        page.probeResponse = { status: 200, headers: {} };

        const result = await renderPage(asPage(page), options({ url: 'http://example.test/' }));

        expect(page.session.sentMethods()).toContain('Fetch.continueRequest');
        expect(result.isRedirect).toBe(false);
        expect(page.probeDisposed).toBe(true);
      });

      it('is followed when the origin cannot be asked', async () => {
        const page = new FakePage();
        page.pausedResponses = [hstsUpgrade];

        const result = await renderPage(asPage(page), options({ url: 'http://example.test/' }));

        expect(page.session.sentMethods()).toContain('Fetch.continueRequest');
        expect(result.isRedirect).toBe(false);
      });
    });

    it('pauses document requests once their response headers arrive', async () => {
      const page = new FakePage();

      await renderPage(asPage(page), options());

      expect(page.session.sent[0]).toEqual({
        method: 'Fetch.enable',
        params: {
          patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }],
        },
      });
    });

    // The browser has to receive the document from the network. A document
    // fulfilled from outside it counts as public to Chromium, whose local network
    // access checks then block the page's requests to a private-address origin.
    it('lets a non-redirect response through instead of replacing it', async () => {
      const page = new FakePage();
      page.pausedResponses = [{ url: 'https://example.test/', status: 200 }];

      const result = await renderPage(asPage(page), options());

      expect(page.session.sentMethods()).toEqual(['Fetch.enable', 'Fetch.continueRequest']);
      expect(page.route).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 200, isRedirect: false });
      expect(result.html).toBe('<html><body>rendered</body></html>');
    });

    it('reports header names lowercased, with repeated headers joined', async () => {
      const page = new FakePage();
      page.pausedResponses = [
        {
          url: 'https://example.test/',
          status: 301,
          headers: [
            { name: 'Location', value: '/moved' },
            { name: 'Link', value: '</a>; rel=preload' },
            { name: 'link', value: '</b>; rel=preload' },
            { name: 'Set-Cookie', value: 'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT' },
            { name: 'set-cookie', value: 'b=2' },
          ],
        },
      ];

      const result = await renderPage(asPage(page), options());

      // Playwright joins set-cookie with newlines, since an Expires date has a comma.
      expect(result.headers).toEqual({
        location: '/moved',
        link: '</a>; rel=preload, </b>; rel=preload',
        'set-cookie': 'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT\nb=2',
      });
    });

    it('releases a redirect on any other document, such as an iframe', async () => {
      const page = new FakePage();
      page.pausedResponses = [
        { url: 'https://example.test/', status: 200 },
        { url: 'https://ads.example.test/frame', status: 302 },
      ];

      const result = await renderPage(asPage(page), options());

      expect(page.session.sentMethods()).not.toContain('Fetch.failRequest');
      expect(result.isRedirect).toBe(false);
    });

    it('matches the requested URL regardless of its fragment', async () => {
      const page = new FakePage();
      page.pausedResponses = [{ url: 'https://example.test/', status: 302 }];

      const result = await renderPage(
        asPage(page),
        options({ url: 'https://example.test/#section' }),
      );

      expect(result.isRedirect).toBe(true);
    });

    it('detaches the session once the render is done', async () => {
      const page = new FakePage();

      await renderPage(asPage(page), options());

      expect(page.session.detached).toBe(true);
    });

    it('detaches the session when navigation fails too', async () => {
      const page = new FakePage();
      page.gotoError = new Error('net::ERR_CONNECTION_REFUSED');

      await expect(renderPage(asPage(page), options())).rejects.toThrow(RenderError);
      expect(page.session.detached).toBe(true);
    });

    it('navigates normally when interception is unavailable', async () => {
      const page = new FakePage();
      page.cdpError = new Error('CDP session is only available in Chromium');

      const result = await renderPage(asPage(page), options());

      expect(result).toMatchObject({ status: 200, isRedirect: false });
    });

    it('still finishes the render when a paused request cannot be released', async () => {
      const page = new FakePage();
      page.pausedResponses = [{ url: 'https://example.test/', status: 200 }];
      page.session.releaseError = new Error('Target page, context or browser has been closed');

      const result = await renderPage(asPage(page), options());

      expect(result.isRedirect).toBe(false);
    });

    it('opens no session at all when following redirects', async () => {
      const page = new FakePage();
      page.pausedResponses = [{ url: 'https://example.test/', status: 302 }];

      const result = await renderPage(asPage(page), options({ followRedirects: true }));

      expect(page.newCDPSession).not.toHaveBeenCalled();
      expect(page.routes).toHaveLength(0);
      expect(result.isRedirect).toBe(false);
    });

    it('propagates a genuine navigation failure rather than reporting a redirect', async () => {
      const page = new FakePage();
      page.pausedResponses = [{ url: 'https://example.test/', status: 200 }];
      page.gotoError = new Error('net::ERR_CONNECTION_REFUSED');

      await expect(renderPage(asPage(page), options())).rejects.toThrow(RenderError);
    });
  });

  describe('resource blocking', () => {
    it('installs no handler when nothing is configured', async () => {
      const page = new FakePage();

      await renderPage(asPage(page), options({ followRedirects: true }));

      expect(page.routes).toHaveLength(0);
    });

    it('blocks through a single route, leaving redirect detection to the CDP session', async () => {
      const page = new FakePage();

      await renderPage(asPage(page), options({ blockedResourceTypes: ['image'] }));

      expect(page.routes).toHaveLength(1);
      expect(page.routes[0]?.matcher).toBe('**/*');
      expect(page.session.enabled).toBe(true);
    });

    it('aborts a blocked resource type and allows everything else', async () => {
      const page = new FakePage();
      await renderPage(asPage(page), options({ blockedResourceTypes: ['image', 'media'] }));
      const blocker = page.routes[0]?.handler;

      const image = new FakeRoute('https://cdn.test/a.png', 'image');
      await blocker?.(image);
      expect(image.aborted).toBe(true);

      const script = new FakeRoute('https://cdn.test/a.js', 'script');
      await blocker?.(script);
      expect(script.continued).toBe(true);
    });

    it('aborts a request whose URL matches a blocked pattern', async () => {
      const page = new FakePage();
      await renderPage(asPage(page), options({ blockedUrlPatterns: ['google-analytics.com'] }));
      const blocker = page.routes[0]?.handler;

      const tracker = new FakeRoute('https://www.google-analytics.com/collect', 'script');
      await blocker?.(tracker);
      expect(tracker.aborted).toBe(true);

      const allowed = new FakeRoute('https://example.test/app.js', 'script');
      await blocker?.(allowed);
      expect(allowed.continued).toBe(true);
    });
  });
});
