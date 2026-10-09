# Build from the repository root:  docker build -f apps/api/Dockerfile .
# Built and smoke-tested on 2026-10-10 under Colima (Docker 29.5, linux/arm64): ran read-only,
# non-root, all capabilities dropped. Not yet built for amd64; CI builds it on every push.

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

# The bundle contains every dependency, so the runtime image needs no node_modules.
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/api/dist ./dist
USER node
EXPOSE 3001
CMD ["node", "--enable-source-maps", "dist/main.js"]
