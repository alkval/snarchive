# Development

## Requirements

- Node.js 22.18 or newer and npm; use the committed lockfile.
- JDK 17 for the verified Android build workflow.
- Android SDK, build tools and NDK required by the pinned Expo/React Native configuration.
- A disposable Android emulator or test device for native behaviour checks.

The repository pins Expo 58.0.13, React Native 0.88.0, React 19.3.0 and TypeScript 6.0.3. The documented release build
used Android compile SDK 37, build tools 37.0.0 and ARM64. The packaging policy currently expects target SDK 36.
Commands below use a POSIX shell; other host environments need corresponding path and tool adjustments.

```sh
npm ci
npm run check
```

`npm run check` typechecks the project and runs the TypeScript/SQLite host tests. Native engines have separate JVM
runners; see [testing](testing.md). No real export is required.

## Source layout

| Path | Purpose |
| --- | --- |
| `App.tsx`, `src/ui/` | Application navigation, screens and reusable UI |
| `src/domain/` | Pure browsing, gesture, identity and timeline logic |
| `src/import/`, `src/storage/` | Inventory, import orchestration, SQLite and codecs |
| `src/backup/`, `src/integrity/` | Backup/restore, verification, repair and cleanup orchestration |
| `src/platform/` | JavaScript/native adapters |
| `modules/snarchive-sources/` | Local native source, ZIP, storage and backup implementations |
| `scripts/`, `tests/` | Build tooling, synthetic fixtures, host tests and benchmarks |
| `assets/`, `licenses/` | Bundled artwork and dependency notices |

Generated `android/`, `ios/`, `node_modules/` and `work/` are not source-of-truth directories. Put native changes in
the local module, `app.json` or configuration plugins. Never rely on hand edits to generated native projects.

## Android development client

Follow the [Android build guide](android-builds.md#development-build) to compile a development client. Once it is
installed on a disposable test target, `npm start` launches Metro. Metro is a development server, not an application
backend. Standalone builds bundle their JavaScript and do not need Metro.

To check JavaScript/assets without installing a native application:

```sh
EXPO_NO_TELEMETRY=1 npx expo export --platform all
```

An iOS JavaScript export is not an iOS native-build or feature verification result. Native iOS work remains
[deferred](issues/ios-support.md).

## Isolated workspaces

`npm run prepare:android-preview` creates an allowlisted source snapshot in a fresh temporary directory and prints
its path and input digest. Install dependencies and prebuild inside that directory for an isolated native build.
The copy excludes private inputs, generated projects, signing material and build outputs. Symlinks in selected
inputs are rejected. This is a file-copy policy, not a general secret scanner.

Use the main checkout for edits, then prepare a new snapshot when build inputs change. Collect verified outputs
before deleting an isolated workspace. Do not copy signing keys into it.

## Dependencies and upgrades

Keep version changes intentional and update the lockfile with npm. Do not apply speculative major-version overrides
to silence advisories. Dependency advisories and their runtime/build-time applicability still need assessment.
See [SECURITY.md](../SECURITY.md).

Native dependencies require a native rebuild. JavaScript-only changes still need a new standalone bundle before
APK testing. After Expo, file-system or R8 upgrades, perform the release cancellation checks in the
[Android guide](android-builds.md#dependency-upgrades-and-r8).
