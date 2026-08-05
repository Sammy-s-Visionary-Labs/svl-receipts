# Tooling (RA-74)

| Concern | Choice |
| --- | --- |
| Lint + format | Biome |
| Lint policy | Errors fail (`npm run lint` exits non-zero) |
| Tests | Vitest in `@svl/domain` |
| Commands | `npm run typecheck`, `npm run lint`, `npm test`, `npm run format` |

Config: `biome.json` at repo root. Domain tests: `packages/domain` (`vitest.config.ts`).
