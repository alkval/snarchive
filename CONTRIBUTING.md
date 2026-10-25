# Contributing to Snarchive

Snarchive is an Android-first, local-first archive viewer. Contributions should keep original bytes intact, make
import outcomes clear and keep the browsing interface simple.

## Development workflow

1. Read the [development guide](docs/development.md) and install the pinned dependencies with `npm ci`.
2. Create a branch for one focused change.
3. Run `npm run check`. Run the relevant native suites when changing ZIP, storage, backup or bridge code.
4. Describe the problem, the resulting behaviour and the checks actually performed in the pull request.

Keep unrelated refactors and dependency upgrades separate. Explain migrations and compatibility changes explicitly.
A passing host test does not establish device behaviour; report host, emulator and physical-device results separately.

## Fixtures and reports

Use generated media and synthetic metadata. The [testing guide](docs/testing.md) lists fixture generators and runners.
Do not commit or attach real exports, personal images, GPS data, source access tokens, signed download links,
credentials or signing material. A redacted structural example should still be checked for identifying metadata.

For UI bugs, include the app version, Android version, reproduction steps and a screenshot or recording made with
synthetic content. For import bugs, explain the export layout and observed error without uploading the archive.

## Changes that affect stored data

Preserve the distinction between a logical memory and its stored bytes. Identical content may be shared by several
memories. Re-imports, partial imports, cancellation, process interruption, source changes and cleanup failures must
not silently replace evidence or remove referenced originals.

Changes to import, repair, restore or deletion should include tests for the failure paths they affect. Consult the
[architecture](docs/architecture.md) and [backup format](docs/backup-format.md) before changing persistent data.

## Native code and generated files

Edit the local native module or Expo configuration plugins. Do not make source changes inside generated native
projects or `node_modules/`. Keep generated APKs, fixture outputs, signing files and caches outside Git.

Dependency upgrades need a release build as well as typechecking. In particular, verify the Android picker-cancellation
class mapping described in the [build guide](docs/android-builds.md#dependency-upgrades-and-r8).

## Scope

Android compatibility, accessibility, provider behaviour, large-library performance and preservation correctness
are active areas for improvement. iOS work is tracked separately in the [roadmap](docs/roadmap.md). Discuss changes
that add accounts, network services, new backup formats or major interface flows before implementation.

Contributions are distributed under the repository's [MIT license](LICENSE). Preserve applicable copyright and
third-party notices.
