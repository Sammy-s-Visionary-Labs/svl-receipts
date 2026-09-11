# Production mobile installation builds

The `production-install` EAS profile creates a standalone Android APK or an iOS
ad hoc build. Both use the EAS **production** environment and the backend at
`https://svl-receipts-web.vercel.app`, backed by Supabase project
`ouyhvzvtjntbtxpmeeyj`. They do not require Metro, a USB cable, or a running Mac.

Only these client settings are stored in the EAS production environment:

- `EXPO_PUBLIC_API_URL`
- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY` (the production publishable key)

Housecall, Gemini, cron and Supabase service keys remain on the server. The build
profile disables local dotenv loading, and the EAS post-install hook rejects a
test API/database, non-publishable key, or included local dotenv file. The root
`.easignore` excludes local evidence, environment files, generated native projects
and receipt fixtures from the upload archive.

Run EAS from `apps/mobile`:

```sh
npx eas-cli build --platform android --profile production-install
npx eas-cli build --platform ios --profile production-install
```

App version 1.0.2 includes the Android gallery/branding/page-removal improvements
and the additional iOS simulator fixes: history entries without photos no longer
hide newer receipts, receipt details return to Recent, and inactive-account
results offer a retry. The Expo Constants dependency is pinned to its patched
version for repeatable iOS builds in checkout paths containing spaces.

Production users must have active **worker** profiles to submit from mobile.
Managers and admins use the production website. Test-environment accounts and
receipts are separate and are not copied by installing this app. Receipt export
still requires a manager's approval of its contents and job assignments.

## iOS signing prerequisite

On September 11, 2026, Expo had no Apple team configured and the user confirmed
that Apple Developer enrollment is still needed. No signed iPhone build or
physical-iPhone installation has been claimed. After the membership is active,
configure the Apple team and distribution credentials, register the intended
iPhones with `eas device:create`, and build the iOS profile above. An ad hoc
installation link works only on devices included in its provisioning profile.

See [Apple enrollment](https://developer.apple.com/programs/enroll/) and
[Expo internal distribution](https://docs.expo.dev/build/internal-distribution/).

The regular `production` profile remains available for store distribution;
an iOS store build must be distributed through TestFlight or the App Store.
