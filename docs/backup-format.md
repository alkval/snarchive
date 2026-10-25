# Portable backup format, versions 1–3

Version 2 adds extracted-folder sources; everything below about version 1 still applies to it. Version 3 adds
permanent-deletion markers. The version extensions below define the additional records.

Android backup export, inspection and additive restore are implemented. iOS export and restore are not implemented.
Keep independent export copies as well as library backups.

Backups are **unencrypted**. They contain private original photos, videos, overlays, filenames, and potentially
location metadata. They contain no device authentication material. Ordinary ZIP tools can extract the files.

## Archive layout

```
manifest.jsonl
objects/<first two lowercase hash characters>/<full SHA-256>
```

Each object is included once, with its original bytes. Extensions are intentionally absent from object names; manifest
associations identify photo, video and overlay roles. Several memories can reference the same object without becoming
one memory. No thumbnails, caches, raw SQLite databases, absolute device paths, source access tokens or signed
download links are included.

The ZIP uses UTF-8 names and DEFLATE level 0. Object SHA-256 values verify content; ZIP entry CRCs also protect
against accidental corruption. These checks do not authenticate a backup against deliberate modification. ZIP64
support at large sizes still needs device validation before release.

## Manifest records

`manifest.jsonl` is UTF-8 JSON Lines, with one JSON object and LF per record. The first record must be the header, and
the last must be the end record. Order is header, objects sorted by hash, sources sorted by archive hash with their
preserved observations in ordinal order, favorites sorted by memory ID, then end.

| Record | Fields and meaning |
| --- | --- |
| `header` | `format: "snarchive-backup"`, `version: 1` |
| `object` | `sha256`, `relativePath`, `bytes`. Path must be exactly the hash-derived path above. |
| `source` | `archiveSha256`, `inventory`. Inventory uses the allowlisted saved-preview format 1: `format`, `sources`, `identities`. Exactly one source, identified by `zip:<archiveSha256>`. |
| `preserved` | `archiveSha256`, zero-based `ordinal` into that inventory's files, `memoryId`, `role`, `sha256`. Role and identity must agree with the inventory file. The object must exist in the catalog. |
| `favorite` | `memoryId`. Only identities with preserved base media may be favorites. Absence means false in this snapshot; restore combines favorites and never removes one. |
| `end` | `records` counts all preceding records; `objects` counts unique object records; `originalBytes` sums their lengths. |

Source inventories preserve filenames, filename-derived dates, explicit timestamp text and UTC values, date precision,
media types, location evidence and diagnostics. They retain disagreements and metadata whose media has not yet
arrived. Inventories are normalized through the existing saved-preview codec; unknown fields and raw download URLs are
discarded. Its parser and types are in `src/storage/previewCodec.ts`, `src/import/sourceInventory.ts` and
`src/import/metadata.ts`.

A logical memory is identified by `memoryId`, not an object hash. Its associations are the distinct `(memoryId, role,
sha256)` tuples in preserved records. An overlay-only identity remains an orphan overlay, not a visible base memory.
Multiple preserved observations can refer to the same association. Competing hashes remain separate variants. There is
no truncation to the viewer's three-object query limit.

Every inventory file lacking a preserved record is pending. Source evidence without media is still retained. Job
runtime states and source permissions are deliberately excluded: restore must reconstruct pending/completed work from
the records, and resuming original import requires source reselection. Current date indexes are derived from source
evidence. No portable preferences are stored by the current app. Unsaved preview selections are not part of the
preserved library snapshot.

## Consistency and completion

`writeBackupSnapshot` runs inside one exclusive database transaction. It queries records incrementally, holding at
most one validated source inventory in memory. The sink must write the manifest and its object catalog to private
staging. It must not publish anything unless the entire function resolves successfully, including the transaction
commit. An end record alone is not proof that staging succeeded.

The ZIP writer accepts that trusted manifest and matching catalog. It does not parse or independently reconcile the
manifest; the Android bridge uses both products of the same successful snapshot. It streams each original in 64 KiB
chunks and checks its SHA-256 against the catalog during copying. Same-length corruption therefore fails export. It
streams the ZIP directly into the caller's output, which is the user's chosen document on Android, and returns the
SHA-256 and length of the written bytes. The caller syncs the destination and reads it back. A failed or cancelled
stream never receives a central directory, so an undeleted remainder does not open as a complete ZIP. The Android
coordinator deletes the destination on failure. If the read-back is short or unreadable, it keeps the destination and
reports it as unchecked. Only the manifest and catalog are staged privately. Process termination can leave them
behind, and the coordinator cleans them at startup under a file lock.

Once the database snapshot is taken, later imports or favorite changes belong to a later backup. Original bytes are
immutable. The shared native session guard prevents deletion from overlapping the active snapshot/export; cleanup must
not remove objects the snapshot depends on. The caller must serialize exports and must keep the staged manifest
immutable while writing.

## Current limits

- Manifest: 128 MiB of UTF-8, at most 1,000,000 records.
- One source inventory: existing 32 MiB character limit, at most 100,000 files.
- Object catalog: at most 100,000 unique objects, 8 GiB per object, 64 GiB total.
- Media buffers: 64 KiB. ZIP entry metadata and the hash set grow with the bounded object count; a single source's metadata is still decoded in memory.
- ZIP output keeps a 64 MiB reserve on the app's data partition. No private copy of the ZIP is made; the destination needs room for the backup.

Exceeding a limit aborts staging; it must never produce an apparently complete partial backup. The limits are initial
implementation safeguards, not measured mobile capacity. The streaming save flow to Downloads, destination read-back,
picker cancellation and staging recovery have been checked on the emulator. A 65,601-entry ZIP64 archive passes host
tests for both export and inspection. Objects over 4 GiB, Android's ZIP64 output, large-library performance, cloud
providers, physical devices and iOS export are unverified.

## Reading a backup

Readers treat a backup as untrusted. The Android inspector applies, in order:

- **ZIP structure:** the import engine's checks, with backup limits (100,001 entries; 64 GiB + 128 MiB uncompressed; 8 GiB per entry).
- **Layout:** exactly one `manifest.jsonl` plus `objects/<2 hex>/<64 hex>` entries whose prefix matches the hash. No directories or other entries.
- **Manifest:** strict UTF-8. Each line must be exactly the `JSON.stringify` text of its parsed value, which rules out duplicate keys, extra whitespace, non-canonical escapes and numbers; key order is free. Each record has exact keys per type and the order described above. Sources must round-trip unchanged through the saved-preview codec with identity `zip:<archiveSha256>`. Observations follow the identity, role and ordinal rules above, favorites need preserved base media, and the end-record totals must match.
- **Line limits:** 32 MiB + 1,024 characters for a source record, 4,096 for any other.
- **Objects:** every declared object present exactly once with its declared length, and no undeclared objects. Every object is streamed and its length, ZIP CRC and SHA-256 checked.

Objects that no observation references are valid in v1 and are counted, not rejected. See the [testing
guide](testing.md) for verification scope.

## Restoring

A verified inspection is not a lasting approval of a file. Restore re-validates in the session that consumes the
bytes, then proceeds in three steps:

1. It stores every object, with the declared SHA-256 required before finalization; existing local objects are fully re-hashed and never overwritten.
2. It reads the manifest again from a private copy whose SHA-256 must equal the validated bytes.
3. It applies the records in one exclusive transaction: an additive merge by memory ID that keeps shared bytes, variants, overlay-only identities, pending evidence and favorites. An archive already in the library must have an identical inventory, and its done files cannot change object.

Unreferenced catalog objects are restored as stored-object rows. A round trip (export → restore → export) gives an
identical manifest. See the [testing guide](testing.md) for verification scope.

## Android saving

Choose **Settings → Save a backup**, read the privacy/storage notice, then **Create backup**. Keep the app open. The
app takes a database snapshot, opens the system save picker, then streams the ZIP into the chosen file, checking every
original's SHA-256 on the way. It reports success only after reading back the saved file and checking its hash and
length. Ordinary failures attempt to remove the incomplete destination; an interrupted process can leave a partial ZIP
that must be deleted manually. Open it from **Settings → Restore a backup**. See the [testing guide](testing.md) for
verification scope.

## Version 2: folder sources

Without deletion markers, the writer uses version 1 when the library has no folder job, and version 2 otherwise. A
version 2 manifest may contain, after every `source` record and its `preserved` records, and before favorites:

| Record | Fields and meaning |
| --- | --- |
| `folder` | `inventorySha256`, `inventory`. One codec-normalized source with identity `folder:<inventorySha256>`, sorted by hash. `inventorySha256` must equal SHA-256 of `snarchive-folder-inventory\n1\n` followed by the inventory's label-neutral evidence as written (`listedFolderHash` in `src/import/sourceEvidence.ts`); readers recompute it. Current writers write the inventory in canonical order (`canonicalFolderSource`: files by path, metadata results by content, renumbered by rank), so the key is the folder's canonical identity (`folderInventoryHash`). |
| `folder-preserved` | `inventorySha256`, `ordinal`, `memoryId`, `role`, `sha256`. Same rules as `preserved`. |

The inventory hash identifies what a scan of the folder saw (names, metadata, diagnostics, counts), not media bytes, a
location or the provider's listing order. Older backups may hold a folder inventory in listing order, keyed by its
listed-order hash; they still verify. Restore applies folder records as written, then, in the same transaction,
applies the library's schema 5 rule: a listing-order job on its own is re-keyed to canonical order (observations
follow their file paths), duplicates of one folder are merged where they agree, and one that completed a file with
other bytes is kept apart under its own key and exported that way. Current readers accept versions 1, 2 and 3. A
`folder` record in version 1 is `backup-invalid`, and versions above 3 are `backup-unsupported`. Restore creates or
matches `kind='folder'` jobs (library schema 6; folder canonicalization from schema 5) by the same full-evidence
comparison as archives, and never mixes kinds. Preview counts add `folders`.

## Version 3: permanent deletion

Schema 6 adds `memory_deletions(memory_id PRIMARY KEY)`. Deleting a memory removes its favourite and associations and
completed object references in every import job, in one transaction. Inventory items stay pending with null object
hashes; the deletion marker makes them ineligible for resume and excludes them from pending-work counts. Source plans
and their derived date index remain as evidence, so an explicit restore retains dates and conflicts. Unshared object
catalog rows are removed in that transaction, followed by native file cleanup with the usual fresh reference and
file-identity checks. Shared objects remain.

Only libraries with deletion markers require version 3. After the header, before objects, it emits records of the form
`{"type":"deleted","memoryId":"example"}`, sorted strictly by memory ID. IDs use the existing memory-ID rules; at most
100,000 are allowed. Each must occur in a source's decoded inventory. Duplicate, unknown, misplaced and
preserved-plus-deleted IDs are refused. Every earlier object/source/folder/favourite/end rule still applies, and the
end count includes deletion records. Deleted files do not contribute to pendingFiles or the object catalog. Older
readers refuse version 3; current readers still accept versions 1 and 2.

Restore remains additive. A backup's deletion marker cannot delete an existing live memory. On an empty library the
markers round-trip and prevent a later export import from resurrecting those memories. Explicitly restoring a backup
with a preserved observation clears a local deletion marker for that identity and can recover the memory, including
from an older backup. All changes remain in the restore transaction; source-evidence conflicts still fail closed. Old
backups and repair quarantine copies are not purged when deleting a memory. Quarantine removal remains an explicit
choice under Settings. Neither deletion nor backup provides secure erasure or encryption.
