FROM node:24.22.2-bookworm-slim
LABEL org.opencontainers.image.title="omi-worker"
RUN apt-get update && apt-get install -y --no-install-recommends \
    git gh make g++ python3 ca-certificates procps util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @anthropic-ai/claude-code@2.1.322 @openai/codex@0.167.0 \
    && npm cache clean --force \
    && useradd --home-dir /work --shell /bin/bash omi \
    && mkdir -p /work /profiles \
    && chown omi:omi /work /profiles
COPY init.mjs /usr/local/lib/omi-init.mjs
USER omi
ENV HOME=/work
ENV OMI_DOCKER_RUNTIME=1
WORKDIR /work
CMD ["sleep", "infinity"]
