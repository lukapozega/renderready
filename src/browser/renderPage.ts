import type { CDPSession, Page, Route } from 'playwright-core';

import type { ResourceType } from '../config.js';
import { RenderError, errorMessage } from '../errors.js';
import type { Logger } from '../logger.js';

import { trackRequests, waitForPageReady, type ReadinessOptions } from './readiness.js';

export interface RenderPageOptions {
  url: string;
  viewport: { width: number; height: number };
  /** Budget for the whole render: navigation and the readiness wait share it. */
  timeoutMs: number;
  followRedirects: boolean;
  readiness: ReadinessOptions;
  blockedResourceTypes: readonly ResourceType[];
  blockedUrlPatterns: readonly string[];
  logger: Logger;
}

interface RenderPageResult {
  html: string;
  status: number;
  /** Response headers from the origin's reply to the requested URL. */
  headers: Record<string, string>;
  /** The requested URL answered with a 3xx that we deliberately did not follow. */
  isRedirect: boolean;
  /** The readiness budget ran out; `html` is whatever had rendered by then. */
  timedOut: boolean;
}

const isRedirectStatus = (status: number): boolean => status >= 300 && status < 400;

/**
 * Drive one page: navigate, wait for readiness, return the serialized HTML.
 *
 * The page and its private context are owned by the browser manager; this
 * function only borrows them. Navigation failures are raised as `RenderError`.
 */
export async function renderPage(
  page: Page,
  options: RenderPageOptions,
): Promise<RenderPageResult> {
  const { url, logger } = options;
  const deadlineAt = Date.now() + options.timeoutMs;
  const remaining = (): number => Math.max(0, deadlineAt - Date.now());

  await page.setViewportSize(options.viewport);

  await installResourceBlocking(page, options);

  // Populated during navigation when the requested URL answers with a 3xx.
  // Absent entirely when following redirects is enabled.
  const redirect = options.followRedirects
    ? undefined
    : await installRedirectDetection(page, url, remaining, logger);

  const asRedirectResult = (): RenderPageResult | undefined =>
    redirect?.status === undefined
      ? undefined
      : {
          html: '',
          status: redirect.status,
          headers: redirect.headers,
          isRedirect: true,
          timedOut: false,
        };

  const tracker = trackRequests(page);

  try {
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'commit', timeout: remaining() });
    } catch (error) {
      // Aborting the navigation is how a detected redirect stops the render, so
      // a goto failure with a captured 3xx is a success, not a failure.
      const redirected = asRedirectResult();
      if (redirected) {
        return redirected;
      }
      throw new RenderError(`Could not load ${url}: ${errorMessage(error)}`, { cause: error });
    }

    const redirected = asRedirectResult();
    if (redirected) {
      return redirected;
    }

    const rawStatus = response?.status() ?? 0;
    const headers = response ? await safeHeaders(response) : {};

    const { timedOut, usedReadyFlag } = await waitForPageReady(
      page,
      tracker,
      options.readiness,
      deadlineAt,
      logger,
    );

    const html = await page.content().catch((error: unknown) => {
      throw new RenderError(`Could not read the page content for ${url}: ${errorMessage(error)}`, {
        cause: error,
      });
    });

    logger.debug('Page captured', {
      url,
      status: rawStatus,
      timedOut,
      usedReadyFlag,
      bytes: html.length,
    });

    return {
      html,
      // A 304 means "your cache is current", but each render uses a fresh
      // context with an empty cache, so there is nothing for a caller to
      // revalidate against. Report what the body actually is.
      status: rawStatus === 304 ? 200 : rawStatus,
      headers,
      isRedirect: false,
      timedOut,
    };
  } finally {
    tracker.stop();
    await redirect?.detach();
  }
}

interface RedirectCapture {
  status: number | undefined;
  headers: Record<string, string>;
  /** Stop intercepting. Never throws, including after the page has closed. */
  detach: () => Promise<void>;
}

/** The parts of a CDP `Fetch.requestPaused` event redirect detection reads. */
interface PausedRequest {
  requestId: string;
  request: { url: string };
  /** Present when paused at the response stage, which is the only stage enabled. */
  responseStatusCode?: number;
  responseHeaders?: { name: string; value: string }[];
}

/**
 * Detect a redirect on the requested URL without following it.
 *
 * Crawlers need to see the 3xx so they can update their index, so the default is
 * not to follow — but Playwright's `goto()` always does. The workaround is to
 * pause the top-level document request through the Chrome DevTools Protocol once
 * its response headers arrive. On a 3xx we record it and fail the request, so the
 * destination is never fetched or rendered; otherwise the browser carries on
 * with the response it is already receiving.
 *
 * Letting that response through matters. Fetching the document from Node and
 * fulfilling the navigation with it looks equivalent, but a fulfilled document
 * has no remote address, so Chromium places it in the public address space. Its
 * local network access checks then block every request the page makes to an
 * origin on a private address — a Docker service name, say — and the page never
 * loads its own scripts.
 *
 * Not every redirect that pauses came from the origin. Chromium makes some up
 * without sending the request — an HSTS upgrade of `http://` to `https://` is a
 * `307 Internal Redirect` — and those are asked of the origin from Node instead,
 * so the caller hears what a crawler would. That probe is only read, never handed
 * to the page, so it cannot trip the checks above.
 *
 * Scoped to document requests for the exact requested URL; any other document
 * that pauses is released untouched.
 */
async function installRedirectDetection(
  page: Page,
  url: string,
  remaining: () => number,
  logger: Logger,
): Promise<RedirectCapture> {
  const capture: RedirectCapture = {
    status: undefined,
    headers: {},
    detach: async () => {},
  };
  // Compared without the fragment, which CDP never includes in a request URL.
  const target = withoutFragment(url);

  let session: CDPSession | undefined;
  try {
    session = await page.context().newCDPSession(page);
    const cdp = session;

    const originRedirect = async (event: PausedRequest): Promise<RedirectResponse | undefined> => {
      const status = event.responseStatusCode;
      if (
        status === undefined ||
        !isRedirectStatus(status) ||
        withoutFragment(event.request.url) !== target
      ) {
        return undefined;
      }
      const headers = headerRecord(event.responseHeaders ?? []);
      if (headers[INTERNAL_REDIRECT_HEADER] === undefined) {
        return { status, headers };
      }
      const answer = await probeOrigin(page, url, remaining(), logger);
      return answer !== undefined && isRedirectStatus(answer.status) ? answer : undefined;
    };

    const release = async (event: PausedRequest): Promise<void> => {
      try {
        const redirect = await originRedirect(event);
        if (redirect) {
          capture.status = redirect.status;
          capture.headers = redirect.headers;
          await cdp.send('Fetch.failRequest', {
            requestId: event.requestId,
            errorReason: 'Aborted',
          });
          return;
        }
        await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
      } catch (error) {
        // The page closed while the request was paused, which ends the render anyway.
        logger.debug('Could not release a paused document request', {
          url,
          error: errorMessage(error),
        });
      }
    };

    cdp.on('Fetch.requestPaused', event => void release(event));
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }],
    });
    capture.detach = () => cdp.detach().catch(() => {});
  } catch (error) {
    // Without interception the navigation is ordinary, and a redirect is followed.
    logger.debug('Redirect detection unavailable; navigating normally', {
      url,
      error: errorMessage(error),
    });
    await session?.detach().catch(() => {});
  }

  return capture;
}

interface RedirectResponse {
  status: number;
  headers: Record<string, string>;
}

/** Chromium sets this on a redirect it made itself rather than received. */
const INTERNAL_REDIRECT_HEADER = 'non-authoritative-reason';

/**
 * How the origin itself answers `url`, without following a redirect.
 *
 * @returns `undefined` when the origin could not be asked, in which case the
 * browser's own redirect is followed, as a navigation without detection would.
 */
async function probeOrigin(
  page: Page,
  url: string,
  timeoutMs: number,
  logger: Logger,
): Promise<RedirectResponse | undefined> {
  let response;
  try {
    // A timeout of 0 means none at all to Playwright, so a spent budget still gets one.
    response = await page.request.fetch(url, { maxRedirects: 0, timeout: Math.max(1, timeoutMs) });
  } catch (error) {
    logger.debug('Origin probe failed; following the browser redirect', {
      url,
      error: errorMessage(error),
    });
    return undefined;
  }
  try {
    return { status: response.status(), headers: response.headers() };
  } finally {
    // Not optional: without this the response body is retained for the life of
    // the context, which leaks steadily under load.
    await response.dispose().catch(() => {});
  }
}

/**
 * Never throws: a paused request whose URL cannot be parsed must still be
 * released, or its navigation hangs until the render times out.
 */
function withoutFragment(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * CDP header entries as a record. Names are lowercased, as Playwright reports
 * them, and repeated headers are joined into one comma-separated value.
 */
function headerRecord(entries: { name: string; value: string }[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { name, value } of entries) {
    const key = name.toLowerCase();
    const existing = headers[key];
    headers[key] = existing === undefined ? value : `${existing}, ${value}`;
  }
  return headers;
}

/**
 * Abort requests matching the configured resource types or URL substrings.
 *
 * Only installed when something is actually configured — an always-on `**\/*`
 * handler routes every request through Node, which is a real cost on an
 * asset-heavy page.
 */
async function installResourceBlocking(page: Page, options: RenderPageOptions): Promise<void> {
  const { blockedResourceTypes, blockedUrlPatterns } = options;
  if (blockedResourceTypes.length === 0 && blockedUrlPatterns.length === 0) {
    return;
  }

  const types = new Set<string>(blockedResourceTypes);

  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const blocked =
      types.has(request.resourceType()) ||
      blockedUrlPatterns.some(pattern => request.url().includes(pattern));

    if (blocked) {
      await route.abort();
      return;
    }
    await route.continue();
  });
}

/** Response headers, tolerating a response that has already gone away. */
async function safeHeaders(response: {
  allHeaders: () => Promise<Record<string, string>>;
}): Promise<Record<string, string>> {
  try {
    return await response.allHeaders();
  } catch {
    return {};
  }
}
