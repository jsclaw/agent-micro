# jsclaw-agent-micro: zero-dependency agent container.
# No npm install — the runner is pure JS on the Node standard library.
FROM node:22-slim

# git for agents that work with repositories; ca-certificates for fetch
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /workspace/group /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input /app

COPY runner.js /app/runner.js
COPY src /app/src

WORKDIR /workspace/group

ENTRYPOINT ["node", "/app/runner.js"]
