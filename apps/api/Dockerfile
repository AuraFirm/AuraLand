# Build from the repository root:  docker build -f apps/api/Dockerfile .
# Built, scanned (Trivy: 0 findings) and smoke-tested on 2026-10-10 under Colima (arm64): ran
# read-only, non-root, all capabilities dropped. CI builds and scans it on amd64 for every push.

FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY apps/web/package.json apps/web/
COPY tools/package.json tools/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY tools tools
COPY apps/api apps/api
COPY packages packages
RUN pnpm --filter @aura/api run build

# The bundle contains every dependency, so the runtime image needs no node_modules. Distroless has
# no shell, no package manager and no perl, which removes the HIGH advisories Trivy found in the
# Node base image's npm and Debian packages (ADR 0009). Its entrypoint is the node binary.
FROM gcr.io/distroless/nodejs24-debian13@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/api/dist ./dist
USER 65532:65532
EXPOSE 3001
CMD ["--enable-source-maps", "dist/main.js"]
