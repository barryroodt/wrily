# Multi-stage build for Wrily.

# Pinned gantry binary fetch — args sourced from .gantry-version at build time.
ARG GANTRY_VERSION
ARG TARGETARCH

FROM node:22-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS builder

WORKDIR /build

RUN npm install -g pnpm@9.12.0

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

# ----- Fetch pinned gantry binary -----
FROM debian:bookworm-slim AS gantry-fetch
ARG GANTRY_VERSION
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) asset="gantry-${GANTRY_VERSION}-x86_64-unknown-linux-gnu.tar.gz" ;; \
      arm64) asset="gantry-${GANTRY_VERSION}-aarch64-unknown-linux-gnu.tar.gz" ;; \
      *)     echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/barryroodt/gantry/releases/download/${GANTRY_VERSION}"; \
    cd /tmp; \
    curl -fsSL "${base}/${asset}" -o "${asset}"; \
    curl -fsSL "${base}/SHA256SUMS" -o SHA256SUMS; \
    grep " ${asset}$" SHA256SUMS | sha256sum -c -; \
    tar -xzf "${asset}" -C /usr/local/bin gantry

# ----- Runtime image -----
FROM node:22-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e

# Pinned gantry binary from the fetch stage.
COPY --from=gantry-fetch /usr/local/bin/gantry /usr/local/bin/gantry

# System deps: git for diff/clone, jq for ad-hoc JSON ops, gh for fixture
# clone helpers, ca-certificates+curl for the gh apt key fetch.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git jq gettext-base ca-certificates curl bash \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash reviewer \
  && mkdir -p /home/reviewer/.claude/skills /tmp/repo \
  && chown -R reviewer:reviewer /home/reviewer /tmp/repo

WORKDIR /app

RUN npm install -g pnpm@9.12.0
COPY --chown=reviewer:reviewer package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder --chown=reviewer:reviewer /build/dist ./dist

COPY --chown=reviewer:reviewer skills/ /home/reviewer/.claude/skills/

# TODO(GC-A2): once todo A2 creates profiles/review/, copy it into the image:
# COPY --chown=reviewer:reviewer profiles/review/ /app/profiles/review/

# Team-mode role prompts live under the copied skills dir. teamRoles.ts resolves
# templates relative to dist/ by default, but skills are copied to ~/.claude here,
# not under /app — so point it at the actual location.
ENV WRILY_SKILLS_DIR=/home/reviewer/.claude/skills

USER reviewer

# Safety net for cloneRepoStep: when git clones a fresh repo into /tmp under a
# different uid than the calling user, subsequent git operations can fail with
# `fatal: detected dubious ownership in repository`. Setting safe.directory '*'
# globally under the reviewer user avoids that without weakening the image.
RUN git config --global --add safe.directory '*'

ENTRYPOINT ["node", "/app/dist/main.js"]
