# Testing and verification

## Host checks

```sh
npm ci
npm run check
```

The suite uses Node's built-in test runner, TypeScript stripping and SQLite. It covers parsing, inventory evidence,
import/restore state, manifests, navigation, gestures, timeline geometry, delayed reads, favourites and cleanup proof
transactions. The 0.2.9 baseline passed **419 tests** and typechecking. This is a recorded baseline, not a substitute
for running checks on a new change.

## Native Java suites

Set `JAVA_HOME` to JDK 17. Place the pinned ZIP engine in the ignored work directory:

```sh
mkdir -p work/zip-engine
curl --fail --location \
  https://repo.maven.apache.org/maven2/net/lingala/zip4j/zip4j/2.11.6/zip4j-2.11.6.jar \
  --output work/zip-engine/zip4j-2.11.6.jar
npm run test:zip-engine
npm run test:original-store
npm run test:backup-writer
npm run test:backup-inspection
```

Runners verify JAR SHA-256 `5f1eb1e9d67cfee200a695e4079751b49e73a226b154193e13f7c602efbe72fb` before compilation.
The same pinned Maven coordinate is resolved by Android Gradle.

| Suite | Recorded host baseline |
| --- | --- |
| ZIP engine | 37 |
| Original store / folder preservation / original repair / export repair / storage review | 35 / 13 / 20 / 9 / 15 |
| Backup writer / session / coordinator | 11 / 6 / 8 |
| Backup inspection / restore / repair | 27 / 16 / 9 |

These runners exercise production engine code on the host JVM. They do not exercise SAF provider behaviour,
Android lifecycle/responder integration or physical storage durability. The Swift scanner has five earlier host
tests; those do not verify a complete iOS application.

## Fixtures

Generators write synthetic outputs outside tracked source:

| Command or script | Purpose |
| --- | --- |
| `npm run fixtures:inventory` | Filename and metadata inventory cases; media can be non-playable placeholders |
| `python3 scripts/generate-personal-fixture.py OUTPUT` | Small two-part export with playable media and overlays |
| `python3 scripts/generate-viewer-fixture.py OUTPUT` | Viewer calibration media, orientation and overlay ambiguity |
| `npm run fixtures:resume` | Resumable import cases |
| `npm run fixtures:video` | Generated video cases |
| `scripts/generate-folder-migration-fixtures.ts` | Legacy folder-job migration inputs |

Media generators can require Python, Pillow and ffmpeg; read each script's usage. Placeholder inventory media is
not evidence that playback works. Keep all generated outputs out of Git. Never replace synthetic fixtures with
personal archives, access tokens, signed links or identifying location data.

## Android verification scope

Clean Kotlin/Java release compilation and ARM64 R8 assembly have passed. Standalone APK checks cover package,
signature, permissions, compiled privacy flags, bundled JavaScript and mapping evidence. The build tools do not
prove trusted provenance or reproducible APK bytes.

Synthetic API 35 emulator checks have exercised import/resume, overlay previews, local browsing/playback, backup
save/read-back, additive restore, original repair, selected cleanup and confirmed reset. The continuous timeline
was checked with 500 generated photos: normal scrolling, fast dragging in both directions, endpoints, photo taps,
favourites, empty-filter recovery and settled-image stability. Host adapters and domain tests cover delayed-save/read
races and injected failures separately from the emulator.

Known gaps include systematic physical-device/provider coverage, TalkBack and large-text coverage for the latest UI,
physical frame timing, peak memory, mixed-video scrolling at scale, direct proof of in-place ZIP opening on a device,
large ZIP64 objects on Android, and power-loss behaviour. Earlier process-interruption tests do not establish
power-loss durability. iOS native import, restore and app builds remain unverified.

## Query benchmarks

`node --experimental-strip-types scripts/benchmark-library.ts` creates query-only synthetic databases, captured
queries and host results at 1,000, 10,000 and 50,000 memories. Supply a new output directory and sample count as
optional arguments. Never point it at an application database.

[Recorded query measurements](benchmarks/library-queries.csv) compare the earlier and optimized chronological SQL
on the host and emulator. They measure database reads, not media decoding or end-to-end scrolling. A separate
50,000-memory host probe returned 45,000 visible ID/date entries in about 114 ms; its decoded-index JSON was about
2 MB. Geometry took about 5.6 ms and a 60-ID display-fact read about 2 ms. These single-run host observations are
not mobile latency or peak-memory guarantees.

## Reporting results

State the source version, toolchain, fixture, build variant and target actually used. Separate host, emulator and
physical-device checks. Include failed or incomplete checks and any injected conditions. Do not generalize a debug
picker result to an R8 release, a Downloads result to every provider, or a synthetic query benchmark to media playback.
