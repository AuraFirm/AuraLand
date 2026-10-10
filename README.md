# AuraLand

Verification and trust layer for software capability, for people and for AI agents.
Context and the full implementation kit: [`docs/kit/`](docs/kit/00_START_HERE.md). Rules for Claude: [`CLAUDE.md`](CLAUDE.md).

## Run it locally

Requirements: Node 24 (`.nvmrc`), pnpm 12 (`corepack enable`), PostgreSQL 18.

```sh
pnpm install
docker compose -f infra/compose.yml up -d        # PostgreSQL 18 on 127.0.0.1:54329
cp .env.example .env
pnpm db:migrate                                   # needs AURA_DATABASE_URL in the environment
pnpm check && pnpm test && pnpm test:sim
pnpm check:semgrep                                # security rules; needs Docker
pnpm build && pnpm --filter @aura/e2e exec playwright install chromium   # once
pnpm test:e2e                                     # real browser, API, web and Mailpit (see ADR 0020)
# after building the images (docker build --file apps/<app>/Dockerfile --tag aura-<app>:local .):
pnpm check:trivy                                  # image and Dockerfile scan; needs Docker
pnpm dev                                          # api :3001, web :3000
```

On macOS without Docker Desktop: `brew install docker docker-compose colima && colima start`, then
use `docker-compose` (hyphenated) for the Homebrew standalone binary. If Docker complains about
`docker-credential-osxkeychain`, point `DOCKER_CONFIG` at a directory containing `{}` for pulls of
public images. Without Docker at all, any PostgreSQL 18 works. For example, with Homebrew:

```sh
brew install postgresql@18
/opt/homebrew/opt/postgresql@18/bin/initdb -D .pgdata -U aura --auth=trust
/opt/homebrew/opt/postgresql@18/bin/pg_ctl -D .pgdata -o "-p 54329 -k /tmp -c listen_addresses=127.0.0.1" start
```

`.env` also needs `AURA_PUBLIC_ORIGIN` (the origin browsers use, `http://localhost:3000` locally), which the cross-site request check compares against. Database tests read `AURA_TEST_DATABASE_URL` and fail without it. They create and drop throwaway
databases on that server.

## Layout
`apps/api` (Hono) · `apps/web` (Next.js renderer) · `packages/contracts` (schemas, errors, assert) ·
`packages/db` (client, RLS context, migrations) · `tools` (tigerlint, depcheck, build) ·
`docs/adr` (decisions) · `docs/stages` (stage plans and reports).
