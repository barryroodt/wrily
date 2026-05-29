# Multi-stage build for Wrily.

FROM alpine:3.20 AS rig-fetch
ARG TARGETARCH
RUN apk add --no-cache curl ca-certificates jq
ARG RIG_RELEASE=latest
RUN set -eu; \
    if [ "$RIG_RELEASE" = "skip" ]; then \
      printf '%s\n' '#!/bin/sh' \
        'echo "wrily-rig binary not bundled in this image" >&2' \
        'exit 1' > /wrily-rig; \
      chmod +x /wrily-rig; \
    else \
      case "$TARGETARCH" in \
        amd64) RIG_TARGET=x86_64-unknown-linux-gnu ;; \
        arm64) RIG_TARGET=aarch64-unknown-linux-gnu ;; \
        *) echo "unsupported arch: $TARGETARCH"; exit 1 ;; \
      esac; \
      if [ "$RIG_RELEASE" = "latest" ]; then \
        RIG_TAG="$(curl -sSL "https://api.github.com/repos/barryroodt/wrily/releases" \
          | jq -r '[.[] | select(.tag_name | startswith("wrily-rig-"))][0].tag_name')"; \
        [ -n "$RIG_TAG" ] && [ "$RIG_TAG" != "null" ] || { echo "no wrily-rig-* release found"; exit 1; }; \
      else \
        RIG_TAG="$RIG_RELEASE"; \
      fi; \
      ASSET="wrily-rig-${RIG_TARGET}"; \
      BASE="https://github.com/barryroodt/wrily/releases/download/${RIG_TAG}/${ASSET}"; \
      curl -sSL -o "/tmp/${ASSET}" "${BASE}"; \
      curl -sSL -o "/tmp/${ASSET}.sha256" "${BASE}.sha256"; \
      ( cd /tmp && sha256sum -c "${ASSET}.sha256" ); \
      chmod +x "/tmp/${ASSET}"; \
      mv "/tmp/${ASSET}" /wrily-rig; \
    fi

FROM node:22-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS builder

WORKDIR /build

RUN npm install -g pnpm@9.12.0

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

# ----- Runtime image -----
FROM node:22-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e

# System deps: git for diff/clone, jq for ad-hoc JSON ops, gh for fixture
# clone helpers, ca-certificates+curl for the gh apt key fetch.
COPY --from=rig-fetch /wrily-rig /usr/local/bin/wrily-rig

RUN apt-get update && apt-get install -y --no-install-recommends \
    git jq gettext-base ca-certificates curl bash \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@2.1.126

ENV CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1

RUN useradd -m -s /bin/bash reviewer \
  && mkdir -p /home/reviewer/.claude/skills /tmp/repo \
  && chown -R reviewer:reviewer /home/reviewer /tmp/repo

WORKDIR /app

RUN npm install -g pnpm@9.12.0
COPY --chown=reviewer:reviewer package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder --chown=reviewer:reviewer /build/dist ./dist

COPY --chown=reviewer:reviewer skills/ /home/reviewer/.claude/skills/

USER reviewer

# Safety net for cloneRepoStep: when git clones a fresh repo into /tmp under a
# different uid than the calling user, subsequent git operations can fail with
# `fatal: detected dubious ownership in repository`. Setting safe.directory '*'
# globally under the reviewer user avoids that without weakening the image.
RUN git config --global --add safe.directory '*'

ENTRYPOINT ["node", "/app/dist/main.js"]
