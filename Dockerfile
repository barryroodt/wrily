# Multi-stage build for Wrily.

FROM node:26-slim@sha256:424cafd2a035ed2b2d74acc3142b68b426fb62a47742c80a75e7117db02d6b30 AS builder

WORKDIR /build

RUN npm install -g pnpm@9.12.0

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

# ----- Runtime image -----
FROM node:26-slim@sha256:424cafd2a035ed2b2d74acc3142b68b426fb62a47742c80a75e7117db02d6b30

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
