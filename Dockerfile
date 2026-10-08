# Microsoft's Playwright image already carries Chromium and the system libraries
# it needs. Installing those onto a plain node image is a long list of apt
# packages that has to be kept in step with each Playwright release.
#
# Keep this tag's version in step with the playwright-core range in package.json:
# the image ships the browser build that version expects.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build

WORKDIR /app

# Browsers are already in the base image, so skip the download during install.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev


FROM mcr.microsoft.com/playwright:v1.63.0-noble AS runtime

# An init process is not optional here. Every browser recycle kills Chromium, and
# its child processes (renderer, GPU, zygote, crashpad) reparent to PID 1. Node
# does not wait() on them, so without something reaping orphans you accumulate a
# set of zombies per recycle until the PID table fills.
#
# tini is installed explicitly rather than assumed to be in the base image, so
# this does not silently break if the image contents change.
USER root
RUN apt-get update \
    && apt-get install --no-install-recommends -y tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HOST=0.0.0.0 \
    PORT=3000

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json README.md LICENSE ./

# pwuser comes from the Playwright base image. Chromium runs with --no-sandbox
# because its own sandbox needs privileges a container usually will not grant, so
# not running as root is the remaining line of defence.
USER pwuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/cli.js"]
