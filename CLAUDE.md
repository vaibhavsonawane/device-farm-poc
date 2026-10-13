# CLAUDE.md — conventions for DeviceLab

On-prem remote device lab (BFSI). Read `docs/ARCHITECTURE.md` first. Security
rules in `docs/SECURITY.md` are non-negotiable.

## Layout

- `apps/server` NestJS + Prisma. Domain services are registered in `app.module.ts`; infra modules (config, prisma, redis, storage, audit, auth, realtime) are global.
- `apps/portal` React 18 + Vite + MUI v6 + TanStack Query + Zustand. It consumes `packages/*` as **TypeScript source** via Vite aliases.
- `apps/host-agent` Node 20. One `DeviceDriver` implementation per platform (`drivers/android`, `drivers/ios`, `drivers/mock`); `DeviceManager` routes commands.
- `packages/shared-types` is the single source of truth for DTOs, enums, permissions and every Socket.IO event. `packages/protocol` owns the binary frame format.

## Rules

- TypeScript strict. No `any` (lint error); if unavoidable, add a justification comment.
- Validate every external input with Zod: REST bodies/queries with `ZodPipe` + `ApiZodBody`, socket payloads with `safeParse`, agent config with `agentConfigSchema`.
- **RBAC**: every non-public route needs `@Permissions(...)`. The guard denies routes without it (default deny). `@Permissions()` with no arguments means "any signed-in user". Socket events re-check access (`SessionsService.access`).
- **Audit**: add new actions to `AuditAction` in `audit.service.ts` and log every reservation, install, session, download, login and admin change.
- **Typed events only**: add a Socket.IO event to the interfaces in `packages/shared-types/src/ws.ts` before using it. Do not emit string-typed events.
- Binary frames: change `packages/protocol/src/frames.ts`, bump `PROTOCOL_VERSION` for incompatible changes, and extend `protocol.test.ts`.
- Server DI needs runtime imports of injected classes (`emitDecoratorMetadata`); `consistent-type-imports` is off in `apps/server`.
- No third-party network calls (on-prem). Fonts are bundled (`@fontsource/inter`), and nothing loads from CDNs.
- No secrets in the repo; only `.env.example` files.
- Attribution: "Crafted by Vaibhav Sonawane through Claude" appears once in the portal shell footer (`packages/ui` `Footer`), in the agent banner, in Swagger and in the README. Do not duplicate it.

## Commands

```bash
pnpm i && pnpm build          # build shared packages
pnpm dev                      # server :3000 + portal :5173 (Vite proxies /api, /socket.io, /ws)
pnpm dev:mock-agent           # simulated devices (MOCK_VIDEO=mjpeg for browsers without H.264)
pnpm test | pnpm lint | pnpm typecheck
pnpm --filter @devicelab/server prisma:migrate    # new migration (dev DB only)
pnpm test:e2e                 # Playwright
```

- Prisma migrations: edit `schema.prisma`, run `prisma migrate dev --name <change>`, commit the SQL. Hand-written SQL (like the partial unique index on active reservations) goes in the migration file.
- API tests (`apps/server/test`) truncate tables, and only on a database whose name ends in `_test`.
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`…). Husky runs Prettier via lint-staged.
