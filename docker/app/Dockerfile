FROM golang:1.26.8 AS bridge
WORKDIR /build
COPY bridge/agent-comm-direct/go.mod bridge/agent-comm-direct/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY bridge/agent-comm-direct/main.go ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -mod=readonly -trimpath -o /out/agent-comm-direct .

FROM node:26.10.0-bookworm-slim
WORKDIR /app
COPY --from=bridge /out/agent-comm-direct /usr/local/bin/agent-comm-direct
COPY src/ src/
COPY public/ public/
COPY profiles/ profiles/
COPY workspaces/ workspaces/
COPY demo/environment/ demo/environment/
COPY scripts/demo.mjs scripts/demo.mjs
COPY docker/app/start.mjs docker/app/start.mjs
RUN install -d -o node -g node -m 0700 /app/.data
ENV DEMO_AGENT_COMM_DIRECT=/usr/local/bin/agent-comm-direct
USER node
CMD ["node", "docker/app/start.mjs"]
