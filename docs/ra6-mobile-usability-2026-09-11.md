# Android branding, gallery and page removal — September 11, 2026

## Changes

- The Android launcher icon, splash image, app header, sign-in screen, buttons,
  backgrounds and tabs now use the manager website's SVL monogram and forest
  green / cream palette. `scripts/generate-mobile-brand.mjs` regenerates the
  checked-in image assets from the monogram drawing.
- Gallery selection keeps the selected page order and five-page limit. Android
  can fall back to its document picker if the photo picker cannot launch.
  Canceling does not reopen a picker or create a draft. Image-preparation errors
  are separate from photo-library launch errors.
- A visible **× Remove page** button appears above the current photo during
  review. The ready-to-send screen also has a remove button on each thumbnail.
  Removing a page preserves the remaining order and requires reviewing the
  updated set again. Removing the last page returns to Capture with no draft.
- Removal is available before the first submission. It does not delete an
  existing durable upload, a submitted receipt, manager review history, or an
  original photo in the phone's library.

## Native gallery failure and build requirement

The failure reproduced before the system picker opened. The native exception was
`IllegalStateException: Attempting to launch an unregistered ActivityResultLauncher`.
A cold process restart opened the picker, which isolated the stale activity-result
registration from receipt decoding and permissions.

`patches/expo-image-picker+57.0.14.patch` repairs this specific pre-launch failure:
launch on the Android UI thread, register a replacement image-library launcher
if the old one was unregistered, then retry once. Other exceptions propagate.
Cancellation and image processing do not cause another native launch.

The package is pinned to 57.0.14, and root `postinstall` applies the patch with
`--error-on-fail`. `patch-package` is a regular root dependency so this install
hook also works when Vercel omits root development dependencies. Mobile Expo
autolinking explicitly builds `expo-image-picker`
from source. SDK 57 otherwise uses a precompiled Android library and ignores
Kotlin source patches. See [Expo autolinking buildFromSource](https://docs.expo.dev/modules/autolinking/#buildfromsource).
When upgrading this dependency, reassess/remove the patch and repeat physical
Android gallery checks. Patch files must contain source changes only, never
Gradle build outputs.

## Verification

- 120 mobile tests passed, including gallery cancel/fallback/error handling and
  page-removal ordering, invalid indexes, last-page reset and retake indexes.
- Mobile TypeScript and repository lint passed; `git diff --check` passed.
- The native patch passed reverse/apply checks against a separate copy of its
  source, and `patch-package --error-on-fail` succeeded.
- Android release `1.0.1` / version code `2` was built for ARM64 and installed as
  an update on the connected Pixel 10 Pro XL. The certificate matches the previous
  install; existing sign-in and Recent uploads remained available.
- The APK contains the native `launchImageLibraryWithRecovery` method, bundled
  JavaScript and the stable cloud API URL. Temporary diagnostic messages and
  checked server-secret values are absent from the bundle.
- On the physical phone: opened gallery after installing, selected two synthetic
  images, reached two-page review, removed the first and retained the second,
  continued to the ready screen, and removed its last page to clear the draft.
- On the final layout build: canceled the gallery without creating a draft,
  backgrounded/reopened the app, selected another synthetic image, inspected the
  remove button above the full receipt, then removed the last page successfully.
- Camera controls opened and closed. No new physical-camera receipt was submitted
  in this verification. This is not a new end-to-end Housecall acceptance run.
- No Send receipt or manager approval action was taken. No Housecall writes were
  made. The two temporary gallery fixture copies were removed after testing.

Final APK SHA-256:
`9145c69420271643684de23a38fa8b7072f586e8a950fb90aacdc7a7356c3cb7`

Device screenshots and the bundle-verification JSON are in the ignored
`.local/ra6/` directory. The app remains a standalone release with the cloud API;
USB and a development server are not needed for normal use.
