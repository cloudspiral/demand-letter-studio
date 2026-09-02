FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-bookworm-slim AS node-runtime

FROM python:3.13-slim-bookworm AS runtime

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin steno \
    && mkdir -p /app /var/lib/steno/storage \
    && chown -R steno:steno /app /var/lib/steno

WORKDIR /app
COPY --from=build --chown=steno:steno /app /app
RUN python -m pip install --no-cache-dir -r services/document-worker/requirements.txt

ENV HOST=0.0.0.0 \
    PORT=3001 \
    STATIC_DIR=apps/web/dist \
    STORAGE_DIR=/var/lib/steno/storage \
    DEMO_ASSET_DIR=/var/lib/steno/demo \
    PYTHON_BIN=python

EXPOSE 3001
USER steno

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3001/api/ready', timeout=4)" || exit 1

CMD ["node", "apps/api/dist/index.js"]
