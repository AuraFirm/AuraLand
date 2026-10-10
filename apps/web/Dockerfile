# Build from the repository root:  docker build -f apps/web/Dockerfile .
# Base images come from public registries without Docker Hub's anonymous pull limit, which
# GitHub's shared runners exhaust (ADR 0010). Digests are identical to the Docker Hub ones.
# Built, scanned (Trivy: 0 findings) and smoke-tested on 2026-10-10 under Colima (arm64): ran
# read-only, non-root, all capabilities dropped. CI builds and scans it on amd64 for every push.

FROM public.ecr.aws/docker/library/node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY apps/e2e/package.json apps/e2e/
COPY packages/bundle/package.json packages/bundle/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY tools/package.json tools/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY apps/web apps/web
COPY packages/contracts packages/contracts
RUN pnpm --filter @aura/web run build

# Distroless runtime: no shell, package manager or perl (ADR 0009). Its entrypoint is the node binary.
FROM gcr.io/distroless/nodejs24-debian13@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
USER 65532:65532
EXPOSE 3000
CMD ["apps/web/server.js"]
