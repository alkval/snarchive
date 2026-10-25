# Architecture

Snarchive uses an Expo/React Native interface, TypeScript application services, SQLite metadata and a local native
module for Android source access and persistent files. Media bytes stay in files; SQLite stores references and
source evidence.

## Layers

| Area | Responsibility |
| --- | --- |
| Domain | Memory identity, date evidence, filters, timeline positions and gesture decisions |
| Import | Source inventory, supported metadata, planning, resumable work and reports |
| Storage | SQLite migrations, import observations, memory associations, favourites and deletion markers |
| Native module | SAF access, bounded ZIP streams, hashing, persistent objects, thumbnails and session guards |
| Backup | Snapshot manifests, streamed writing, inspection, additive restore and compatibility |
| Integrity | Original checks, exact-byte repair, unused-file review and confirmed reset |
| UI | Library, fullscreen media, details, import confirmation and settings tools |

Native iOS scanner code exists, but complete iOS preservation, restore and native verification are unfinished.

## Memory identity and bytes

A logical memory is distinct from an immutable stored object. Several memories can reference the same hash without
becoming one memory. Photo, video and overlay roles remain explicit. Objects use paths of the form
`objects/<hash-prefix>/<sha256>`.

Import jobs retain validated source evidence and per-file observations. ZIP jobs use archive hashes. Folder jobs use
codec-normalized, label-neutral inventory evidence in canonical order, independent of provider listing order.
ZIP and folder jobs do not cross-match. Conflicting identities, dates or byte observations are retained or rejected
according to their operation; they are not silently replaced by a similar filename or matching image.

Raw signed download URLs and source access tokens do not belong in the library or backup manifest. Source selection
and scanning are not themselves proof that media has been preserved.

## Durable import and deletion

For each original, the native store streams to staging with length and integrity checks, finalizes the file, then
the import runner commits its references and job observation in SQLite. Filesystem and database changes are not one
atomic transaction. Cancellation retains completed observations; recovery handles staging and unused files.

Deleting a memory updates associations, job observations and a deletion marker transactionally before eligible
private-file cleanup. Shared objects remain referenced. Ordinary re-import respects deletion markers; explicit
backup restore can recover an older preserved observation. Reset commits empty metadata before removing owned
private files, so interruption can leave unused files rather than live rows pointing at intentionally removed media.

## Concurrency and cleanup

The native busy guard serializes import, backup, restore, integrity, repair and storage-review sessions. Original
store writers also share a file lock and an in-process claim. Guard release follows cleanup, including failed opens
and teardown; provider work is kept outside state locks.

Selected-file cleanup and the second phase of reset reserve the SQLite writer before checking references and
unlinking. Expo's deferred transaction alone would allow another connection to write during a read-only proof.
Native deletion revalidates owned paths, canonical parents and file identity without following links. A failure after
unlink is reported as removal with a warning; a cleanup error does not undo a durable metadata commit.

Backup metadata is read in one SQLite snapshot. Its native session protects the referenced originals through
export. Later metadata changes belong to a later backup. Restore applies its merge transaction only after object
verification; inspection does not authorize trusting a later, changed source.

## Dates, timeline and media

Known instants use UTC. Date-only evidence stays a calendar date without an invented time. Conflicts remain explicit.
Unknown and conflicting dates are separate display groups. On this day uses month/day in prior years, including
February 29 only on February 29.

The browser keeps a complete lightweight ID/date-group index, with known bounds for date headings and photo rows.
The normal scroll gesture and draggable handle share the same full pixel range. Full display facts are loaded only
near the viewport, with bounded reads and cache retention. Thumbnail work has its own sequential worker and cache.
Read generations and completed-favourite records keep late reads from reviving stale membership or state.

Viewer navigation uses strict `(sortDay DESC, sortTime DESC, id ASC)` neighbours with a bounded window. Sparse grid
caches never stand in for adjacent memories. Media and compatible overlays share a contained coordinate system and
photo transform. Conflicting overlay choices or incompatible geometry are not guessed. Original bytes are not
rewritten to create previews.

## Backup and repair

The portable [backup format](backup-format.md) preserves original objects, associations, source evidence, favourites
and deletion markers. It excludes caches, raw database files, access tokens and signing material.

Checks distinguish missing, damaged and unreadable originals. Repair rechecks a target before writing, verifies the
replacement's exact expected bytes and retains damaged bytes separately before replacement where possible. Valid
files remain untouched. Post-replacement durability or thumbnail-eviction problems are warnings on a repaired outcome.
Power-loss behaviour remains filesystem-dependent and is not established by process-interruption tests.
