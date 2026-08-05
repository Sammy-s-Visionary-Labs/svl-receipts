# Package boundaries

These rules keep the Receipt App maintainable. If a change would break a rule, stop and rethink — do not “just import it this once.”

## Packages

| Package | Role |
| --- | --- |
| `@svl/mobile` | Expo phone app for field workers |
| `@svl/web` | Next.js manager dashboard and server API routes |
| `@svl/domain` | Shared business vocabulary (types, statuses, schemas) |
| `@svl/integrations` | Adapters to outside systems (Housecall, vision AI) |

## Allowed imports

```text
@svl/mobile        →  @svl/domain
@svl/web           →  @svl/domain
@svl/web           →  @svl/integrations   (server-side only)
@svl/integrations  →  @svl/domain
```

## Forbidden imports

- `@svl/domain` → anything else (no UI, no vendor SDKs)
- `@svl/mobile` → `@svl/web` or `@svl/integrations`
- `@svl/web` → `@svl/mobile`
- `@svl/integrations` → `@svl/mobile` or `@svl/web`
- Circular dependencies between any packages

## Out of this repo (for now)

- QuickBooks implementation
- Local Mac Mini / on-device inference implementation
