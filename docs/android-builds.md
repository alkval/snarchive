# Android builds and signing

The build tooling currently targets standalone ARM64 APKs. The application ID is `com.alkval.snarchive`. Generated
native projects are disposable; the module and configuration plugins are the maintained sources.

## Toolchain

Install Node.js 22.18+, npm, JDK 17 and the Android SDK required by the pinned Expo configuration. The verified build
used compile SDK 37, build tools 37.0.0 and target SDK 36. Set `JAVA_HOME` to the JDK and `ANDROID_HOME` to the SDK.
Gradle resolves the native dependencies, including its required NDK.

The commands below assume a POSIX shell. Run native behaviour checks on a disposable emulator/profile with
synthetic data. Keep existing libraries and their signing keys separate from test installations.

## Development build

From the repository root:

```sh
npm ci
EXPO_NO_TELEMETRY=1 npx expo prebuild --platform android --no-install
cd android
./gradlew :app:assembleDebug
```

Use the serial for your test target explicitly:

```sh
adb devices
adb -s SERIAL install -r app/build/outputs/apk/debug/app-debug.apk
adb -s SERIAL reverse tcp:8081 tcp:8081
```

From the repository root, start Metro with `npm start -- --localhost`. Open the development client and connect to
the local Metro server. Development builds require Metro; their manifest can permit cleartext local development
traffic. They are not standalone release APKs.

If an installation has a different signature, use a separate disposable target or application ID. Do not uninstall
an existing library just to bypass a signing mismatch. Remove test port forwarding with
`adb -s SERIAL reverse --remove tcp:8081` when finished.

## Standalone build

Prepare an isolated snapshot:

```sh
npm run prepare:android-preview
```

In the printed workspace:

```sh
npm ci --no-audit --no-fund
CI=1 EXPO_NO_TELEMETRY=1 npx expo prebuild --platform android --no-install
npm run check
cd android
CI=1 EXPO_NO_TELEMETRY=1 ./gradlew :app:assembleRelease --no-daemon --max-workers=2 \
  -PreactNativeArchitectures=arm64-v8a -Pandroid.enableMinifyInReleaseBuilds=true
```

The resulting Gradle APK uses Expo's shared public template debug key by default. A release variant can be
non-debuggable and still use that public key. Use it only for disposable synthetic-data tests, not a real library.

The preview collector validates and records a build without replacing its signing identity:

```sh
npm run package:android-preview -- /path/to/workspace /path/to/new-output
```

Collectors require an existing parent and a new output directory outside the build workspace. They use SDK `aapt`
and `apksigner`, JDK `keytool`, and `unzip`. `SNARCHIVE_BUILD_TOOLS` can select an installed build-tools version;
the default is 37.0.0.

## Persistent signing

For a self-built installation that will hold real data, create your own persistent private signing identity.

Initialize once from the repository root:

```sh
npm run init:android-personal-key -- private/android-signing
```

This refuses an existing directory. Reuse the key for updates; do not generate another identity for each build.
Keep `private-key.p12`, `password.txt` and `identity.json` together in a secure backup. The directory is ignored by
Git and must stay outside isolated workspaces and distributed artifacts.

After building the isolated release, sign and collect it from the source checkout:

```sh
npm run package:android-personal -- /path/to/workspace private/android-signing /path/to/new-output
```

The collector signs a separate APK, verifies its certificate against the retained identity, rejects the known shared
template certificate, and checks input and APK evidence. Passwords are read from the private file rather than placed
on the command line. The APK, build report, input manifest and compressed R8 mapping can be retained independently
of the build workspace. No keystore or password is collected with them.

Android updates require a compatible signing identity. Losing the key can prevent updates that retain the same
installation's private data. A self-signed build is not an authenticated upstream release or a completed security audit.

## Packaging checks

Collectors verify the allowlisted source digest, package ID, ARM64 code, bundled JavaScript, signature and R8 mapping.
They reject debug/test-only APKs, unexpected permissions, unsafe or missing backup/cleartext/update settings, a
network-security override and a mismatched target SDK. The report records hashes and inspected settings. These are
local consistency checks; they do not establish trusted build provenance or reproducible APK bytes.

See [privacy](privacy.md) for the permission policy and [testing](testing.md) for the actual verification scope.

## Dependency upgrades and R8

After changing Expo, expo-file-system or R8, inspect `android/app/build/outputs/mapping/release/mapping.txt` for:

```text
expo.modules.filesystem.PickerCancelledException -> expo.modules.filesystem.PickerCancelledException:
```

Confirm the `Lexpo/modules/filesystem/PickerCancelledException;` descriptor remains in the APK DEX as well. The
JavaScript cancellation code depends on this class name; renaming or merging it can turn release-picker
cancellation into an unreadable-files error. Review `scripts/withAndroidPickerCancellation.cjs` if the mapping changes.
Verify both ZIP and folder picker cancellation on a fresh release build, separately from debug-client checks.
