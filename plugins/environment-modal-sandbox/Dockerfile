# Debian with Node.js and npm, pinned for reproducible machine images.
FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# Git/GitHub access, HTTP and JSON tools, fast search, and native build support.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bubblewrap \
        ca-certificates \
        curl \
        git \
        gh \
        jq \
        ripgrep \
        procps \
        build-essential \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# Package manager and coding agents. Versions match the supported Omnyo providers.
RUN npm install -g \
        pnpm@9.15.0 \
        @earendil-works/pi-coding-agent@0.99.0 \
        @openai/codex@0.159.0 \
        @anthropic-ai/claude-code@2.1.284 \
    && npm cache clean --force

# Run agents as an unprivileged user with a writable home directory.
# Omnyo installs its daemon on demand during bootstrap; it is not baked into this image.
USER node
WORKDIR /home/node
