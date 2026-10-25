# User guide

## Import your exports

Download your Memories export from Snapchat before using Snarchive. The app does not sign in to Snapchat or fetch
memories from download links.

For ZIP exports, keep all parts compressed. Choose **Add → Choose ZIP files**, select the parts, review the scan
summary and confirm **Add to library**. For an extracted export, choose the folder containing the media at the
expected relative-path root. A folder containing ZIP files is not treated as a multi-ZIP selection.

Scanning discovers supported media and evidence. Confirmation starts copying accepted files into app-private
storage. ZIP contents are streamed per file; the app does not move your chosen ZIPs into its library or unpack every
entry into a shared gallery folder. Some storage providers require a temporary private copy of an archive before
it can be read, so imports may need more free space than the final media alone.

Keep the app open until the import report appears. Cancellation retains work already committed. Reselect the same
source to resume interrupted work. Changed, missing, unsupported or ambiguous files are reported rather than
silently treated as successful imports.

Keep independent export copies even after import. App storage can be lost through uninstallation, device failure
or a reset. Unzipped exports left in shared phone storage may still appear in another gallery app; importing them
does not remove those source files.

## Browse the library

Normal swipes and the right-hand handle control one continuous timeline. Swipe to browse nearby memories; drag the
handle to move quickly through months and years. You can continue toward newer or older items after dragging.

Use **Filters** for photos, videos, favourites, a month or **On this day**. Known instants use UTC; filename-only
dates remain dates without an invented time. Unknown and conflicting dates are labelled separately. On this day
matches month and day in previous years; February 29 matches February 29 only.

Open a memory to swipe between items. Pinch or double-tap a photo to zoom. Tap the media to show or hide controls.
Swipe up or use the details button for recorded dates and source information. Details describe stored evidence;
opening them does not run an integrity check.

## Overlays

Matching overlays are shown by default in thumbnails and fullscreen media. **Hide overlay** temporarily shows the
base media alone. The app renders the layers together; it does not bake stickers or captions into your original.

An overlay with genuinely incompatible proportions is kept but hidden to avoid stretching or misplacing it. Small
export rounding differences are tolerated. Multiple competing candidates remain ambiguous rather than being
arbitrarily stacked. Preview detail is bounded, and increasing display size cannot recover detail absent from the
source overlay.

## Delete memories or start over

The viewer's trash button permanently removes a memory from Snarchive after confirmation. It does not delete the
selected export. Shared stored bytes remain while another memory uses them. A deletion marker prevents an ordinary
re-import from bringing that memory back; explicitly restoring an older backup can recover it.

**Settings → Delete all Snarchive media** clears the library, import history and private media/cache copies after a
separate confirmation. Appearance and files outside Snarchive remain. This reset allows a fresh import. A cleanup
failure may leave unreferenced private files and can be retried; deletion is not secure erasure.

## Back up and restore

**Settings → Save a backup** writes a portable ZIP containing preserved originals and library evidence. Keep the app
open. The save flow checks original hashes while writing and reads the saved document back before reporting a
verified save. Keep exports or another independent backup as well.

Backups are unencrypted and can contain filenames, dates and location evidence. A cloud storage provider can upload
a document you save through it. Protect backups according to their contents.

**Settings → Restore a backup** checks a selected Snarchive backup and offers an additive merge. Existing memories
are not replaced wholesale. Conflicting source evidence is rejected. A backup's deletion markers do not delete
already-live memories. See the [format specification](backup-format.md) for compatibility rules.

## Troubleshooting tools

**Check saved files** verifies stored originals and reports missing, damaged or unreadable files. Repair can use a
Snarchive backup, a recorded original ZIP part or a matching extracted folder. A repair must match the expected
bytes; selecting a different export with similar images is not enough. For folders, choose the recorded relative-path
root. An extra outer directory changes those paths.

Repair leaves valid files alone and keeps damaged bytes separately before replacement when possible. Those copies
consume storage. **Free up unused space** lists unreferenced files and kept damaged copies for explicit selection
and confirmation. Nothing is preselected.

If a tool reports storage is busy, let the active import, backup or repair finish before retrying. For unreadable
sources, reselect the document or folder and check provider availability. For a reproducible bug, use the
[issue tracker](https://github.com/alkval/snarchive/issues) and provide synthetic reproduction steps, not your export.
