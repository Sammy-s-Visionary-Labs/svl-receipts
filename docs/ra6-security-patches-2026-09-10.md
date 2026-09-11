# RA-6 dependency security patches — September 10, 2026

The integrated-flow closeout audit found a critical Next.js advisory, a high
severity sharp/libheif advisory, and a high severity js-yaml denial-of-service
advisory. Updated Next.js and its ESLint configuration from 16.3.0 to 16.3.4,
sharp from 0.35.3 to 0.35.4, and the resolved js-yaml dependency from 4.3.1 to
4.3.2. Associated platform binaries and lockfile dependencies were updated.

References:

- [Next.js image optimization advisory](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4)
- [Next.js Windows advisory](https://github.com/advisories/GHSA-p293-qw3h-jr36)
- [sharp/libheif advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)
- [js-yaml merge-budget advisory](https://github.com/advisories/GHSA-2883-xcg3-v3hh)

Validation after the patches: 698 unit checks, all 37 browser scenarios in one
run, all workspace typechecks, repository lint, and the Next.js production build
passed. The patch does not change database migrations or HCP authorization.

`npm audit --omit=dev --workspace=@svl/web` reports zero vulnerabilities. The full
monorepo audit reports zero critical/high and sixteen moderate entries, including
transitive dependents of three underlying issues:

- Vitest/mocker path traversal in the development test tooling; patching requires
  a separately validated Vitest major upgrade.
- Expo Router's query-string/decode-uri-component denial of service; its current
  dependency range does not accept the patched decoder. Validate an upstream
  compatible fix before distributing the mobile app beyond the test pilot.
- Expo's xcode/uuid build tooling chain; the reported vulnerable UUID functions
  require a caller-supplied buffer. Validate the upstream dependency update.

The suggested automatic fixes include downgrading Expo across SDK generations.
They were not applied. These remaining advisories are recorded release gates;
the clean web production audit is not a claim that the whole monorepo is clear.
