# Domain contracts (RA-75) — locked

**Status:** Locked 2026-08-05

## Layout (`packages/domain/src/`)

| File | Owns |
| --- | --- |
| `index.ts` | Public re-exports |
| `roles.ts` | `worker` \| `manager` \| `admin` |
| `authz.ts` | Server-side role/ownership helpers + error codes |
| `receipt-status.ts` | Receipt lifecycle statuses + terminal helpers |
| `extraction.ts` | Extraction v1 + `schema_version` |
| `review.ts` | Review decisions + light command payloads |
| `housecall.ts` | Step kinds/statuses + intent `payload_version` |
| `money.ts` | Deterministic cents helpers |
| `legacy-status.ts` | Map legacy status names → current |

`@svl/integrations` is unchanged in RA-75 (no premature adapter interfaces).

## Locked choices

| Topic | Choice |
| --- | --- |
| Qty type | `number` |
| Confidence | Per-field record |
| Review payloads | Light types (not full API surface) |
| Runtime validation | TypeScript only (no Zod yet) |
| Money | Integer cents; extended cost in app code |
| Extraction / intent versions | `schema_version: 1`, `payload_version: 1` |

## Out of scope here

Supabase/SQL, upload HTTP types, provider-specific AI JSON, full Housecall REST types.
