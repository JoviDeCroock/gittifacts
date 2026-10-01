# syntax=docker/dockerfile:1.7
#
# gittifacts sandbox image: CI steps, evidence tools (`gittifacts-runner`) and previews
# (`wrangler dev`). The Runner Durable Object starts it and `exec`s commands into it.
#
# Build from the REPOSITORY ROOT, after bundling the runner:
#   pnpm --filter @app/sandbox build
#   docker build -f apps/sandbox/Dockerfile -t gittifacts-sandbox .
# (apps/sandbox/Dockerfile.dockerignore keeps the context to the bundle.)

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------- tool installs (npm)
FROM ${NODE_IMAGE} AS tools
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
# Node 22's bundled npm 10.9 crashes resolving this tree ("Cannot read properties of null
# (reading 'edgesOut')"); npm 11 resolves it. Only this build stage uses it.
ARG NPM_VERSION=11.16.0
RUN npm install -g "npm@${NPM_VERSION}" && npm cache clean --force
# The runner's own tools, next to the bundle: TypeScript, esbuild, Stryker, coverage-v8 (+ vitest peer).
WORKDIR /opt/gittifacts-runner
COPY apps/sandbox/dist/package.json ./package.json
RUN npm install --omit=dev \
 && npm cache clean --force \
 && rm -f package-lock.json
# Global wrangler (brings workerd) used to build and preview Worker projects.
ARG WRANGLER_VERSION=4.145.0
WORKDIR /opt/wrangler
RUN npm init -y >/dev/null \
 && npm install --omit=dev "wrangler@${WRANGLER_VERSION}" \
 && npm cache clean --force \
 && rm -f package-lock.json \
 # sharp only backs the local Images binding; previews don't need it (~20 MB).
 && rm -rf node_modules/sharp node_modules/@img

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates coreutils procps tini \
 && rm -rf /var/lib/apt/lists/*

# Package managers through corepack, pre-fetched so a build needs no corepack download.
# Stable cache/store paths: a container snapshot taken after an install can be reused by any
# project with the same lockfile. Registries are NOT pinned here: set npm_config_registry,
# YARN_NPM_REGISTRY_SERVER and COREPACK_NPM_REGISTRY to route through an allowlisting proxy.
ARG PNPM_VERSION=11.27.0
ARG YARN_VERSION=1.22.22
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_ENABLE_AUTO_PIN=0 \
    COREPACK_ENABLE_STRICT=0 \
    PNPM_HOME=/opt/pnpm \
    pnpm_config_store_dir=/opt/pnpm-store \
    npm_config_store_dir=/opt/pnpm-store \
    npm_config_cache=/opt/npm-cache \
    YARN_CACHE_FOLDER=/opt/yarn-cache \
    npm_config_update_notifier=false \
    pnpm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    WRANGLER_SEND_METRICS=false \
    NO_UPDATE_NOTIFIER=1 \
    DO_NOT_TRACK=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    ASTRO_TELEMETRY_DISABLED=1 \
    CI=1
# The non-root user owns the workspace, the stores and COREPACK_HOME (so a project's own
# `packageManager` version can still be fetched), created empty before anything is written.
RUN groupadd --gid 10001 runner \
 && useradd --uid 10001 --gid runner --create-home --home-dir /home/runner --shell /bin/sh runner \
 && mkdir -p /workspace /opt/pnpm-store /opt/npm-cache /opt/yarn-cache /opt/corepack /opt/pnpm /tmp/gittifacts \
 && chown runner:runner /workspace /opt/pnpm-store /opt/npm-cache /opt/yarn-cache /opt/corepack /opt/pnpm /tmp/gittifacts \
 && rm -rf /opt/yarn-v1.22.22
# Steps are exec'd with a minimal env (PATH, HOME=/root, ...), so the ENV above would not reach
# them: every entry point is a wrapper that sources env.sh (defaults only, callers win).
COPY apps/sandbox/image/env.sh /opt/gittifacts/env.sh
COPY apps/sandbox/image/install-wrappers.sh /opt/gittifacts/install-wrappers.sh
RUN /opt/gittifacts/install-wrappers.sh \
      pnpm=/usr/local/lib/node_modules/corepack/dist/pnpm.js \
      pnpx=/usr/local/lib/node_modules/corepack/dist/pnpx.js \
      yarn=/usr/local/lib/node_modules/corepack/dist/yarn.js \
      yarnpkg=/usr/local/lib/node_modules/corepack/dist/yarnpkg.js \
      corepack=/usr/local/lib/node_modules/corepack/dist/corepack.js \
      npm=/usr/local/lib/node_modules/npm/bin/npm-cli.js \
      npx=/usr/local/lib/node_modules/npm/bin/npx-cli.js \
      wrangler=/opt/wrangler/node_modules/wrangler/bin/wrangler.js \
      gittifacts-runner=/opt/gittifacts-runner/gittifacts-runner.mjs
USER runner
RUN corepack prepare "pnpm@${PNPM_VERSION}" --activate \
 && corepack prepare "yarn@${YARN_VERSION}" --activate \
 && rm -rf /home/runner/.cache
USER root

COPY --from=tools /opt/gittifacts-runner /opt/gittifacts-runner
COPY --from=tools /opt/wrangler /opt/wrangler
COPY apps/sandbox/dist/gittifacts-runner.mjs /opt/gittifacts-runner/gittifacts-runner.mjs

RUN git config --system safe.directory '*' \
 && git config --system init.defaultBranch main \
 && git --version && node --version && pnpm --version && yarn --version \
 && gittifacts-runner --version && wrangler --version

USER runner
ENV HOME=/home/runner
WORKDIR /workspace

# tini reaps the processes the Runner DO execs; the container itself just stays up.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
