const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

export const en = {
  title: 'Snarchive',
  promise: 'Your memories, yours to keep.',

  // Home: library
  libraryHeadline: (memories: number) => memories === 1 ? 'memory preserved' : 'memories preserved',
  libraryStats: (objects: number, files: number) => `${plural(objects, 'stored original', 'stored originals')} · ${plural(files, 'file record', 'file records')}`,
  libraryUnfinished: (jobs: number) => `${plural(jobs, 'unfinished ZIP import', 'unfinished ZIP imports')}. Choose the same ZIP below to resume.`,
  libraryConflicts: (memories: number) => `${plural(memories, 'memory has', 'memories have')} competing file versions. All were kept.`,
  libraryBrowse: 'Browse library', libraryBrowseDetail: 'Photos and videos, newest first',
  backupOpen: 'Back up library', backupOpenDetail: 'Save a portable ZIP of everything preserved',

  // Home: sources
  heading: 'Add an export',
  zip: 'Scan ZIP files', zipDetail: 'Snapchat export parts',
  folder: 'Scan a folder', folderDetail: 'An export you have already extracted',
  explanation: 'Choose Snapchat export ZIPs or an extracted folder from your phone.',
  zipNote: 'Snarchive reads a ZIP where it is when the storage provider allows it. Otherwise it makes a temporary copy, so keep free space for the largest ZIP plus 64 MiB. Your source is never changed.',
  preview: 'Inventory preview',
  report: { folders: 'Sources scanned', media: 'Memories with media files', metadataOnly: 'Metadata without media or overlay', orphan: 'Overlay-only memories', conflicts: 'Memories needing conflict review', unmatched: 'Metadata rows without a usable ID', repeated: 'Repeated metadata rows', warnings: 'Metadata warnings', other: 'Other files skipped' },
  previewNote: 'Built from filenames and metadata only; scanning copies no media.',
  savedNote: 'Saved on this device. Scan a source again if it has changed. This preview is not a backup.',
  originals: 'Preserve originals',
  importZip: (id: string) => `ZIP ${id}`, importZipDetail: 'Preserve or resume original files',
  importNote: 'Choose the same scanned ZIP again to copy its original files into Snarchive. Keep space for all expanded originals plus 64 MiB. Folder copying and restore are not ready yet; keep an independent copy of your exports.',
  importIos: 'Original-file import is not available on iOS yet.',
  prototype: 'Snarchive is in development. Scanning a source previews it; only preserving originals copies them.',

  // Status messages
  loading: 'Opening your library…',
  saving: 'Saving preview on this device…',
  restored: 'Your saved preview is ready.',
  empty: 'Scan an export to see what it contains.',
  loadFailed: 'Local data could not be opened. Scanning is paused so saved records are not replaced.',
  saveFailed: 'The new preview could not be saved. Your previous preview has been kept.',
  stagingNotCleared: 'Your library is ready, but temporary backup files could not be cleared. Reopen the app before creating another backup.',
  retry: 'Try again',
  busy: 'Opening the file picker…',
  scanning: 'Reading filenames and metadata…',
  cancel: 'Stop',
  cancelled: 'Stopped. Your previous preview has been kept.',
  pickerClosed: 'Nothing was added. The picker was closed or access was unavailable.',
  selected: (count: number) => `${plural(count, 'source', 'sources')} scanned and saved. No media was copied.`,
  failed: 'The source could not be scanned. Access may have expired, or a file or safety limit was reached. Your previous preview has been kept.',
  zipFailed: 'The ZIP could not be previewed. It may be corrupt, encrypted, unsafe, or outside the supported limits. Your previous preview has been kept.',
  zipIos: 'ZIP preview is not available on iOS yet. Choose an extracted folder instead.',
  storage: 'Not enough free space for a temporary ZIP copy. Your previous preview has been kept.',
  nativeRequired: 'This needs a newer Snarchive development build. Expo Go and older builds do not include the native scanner.',
  importPick: 'Choose the same ZIP again to preserve or resume its original files.',
  importOne: 'Choose one ZIP for this import.',
  importChanged: 'That ZIP does not match this preview. Choose the original ZIP, or scan the changed archive as a new source.',
  importPaused: 'The import stopped. Completed files were kept. Choose the same ZIP again to continue.',
  importStorage: 'Not enough free storage to continue. Completed files were kept. Free some space, then choose the same ZIP to resume.',
  importCorrupt: 'A stored original could not be verified. The import stopped without replacing it. Keep your source exports; repair is not available yet.',
  importComplete: 'Original files are preserved. Open the library to see your memories, and keep an independent backup.',
  importProgress: (count: number) => `${plural(count, 'file', 'files')} copied or verified. Keep Snarchive open.`,

  // Library
  libraryTitle: 'Library',
  libraryOrder: 'Newest first. Unknown or conflicting dates come last.',
  libraryPreviewNote: 'Previews show the base photo without its overlay.',
  libraryClose: 'Snarchive', libraryBack: 'Library',
  libraryNext: 'Next', libraryPrevious: 'Previous', libraryPage: (page: number) => `Page ${page}`,
  libraryLoading: 'Loading…', libraryEmpty: 'Nothing preserved yet.',
  libraryFailed: 'The library could not be read. Your originals have not been changed.', libraryRetry: 'Try again',
  sectionUnknown: 'Date unknown', sectionConflict: 'Conflicting dates',
  libraryMetadata: 'from export metadata', libraryInferred: 'Time unknown · from the filename',
  libraryUnknownDate: 'Capture date unknown', libraryDateConflict: 'Conflicting date evidence',
  libraryTile: (date: string, video: boolean, favorite: boolean) => `${video ? 'Video' : 'Photo'}, ${date}${favorite ? ', favorite' : ''}`,
  thumbnailMissing: 'No preview',
  libraryVariants: 'This memory has competing base files. All of them were kept; choosing a version is not available yet.',
  libraryVideoFailed: 'This video could not be verified or played. Its record and original file have been kept.',
  libraryPhotoFailed: 'This photo could not be verified or displayed. Its record has been kept. Keep your source export; repair is not available yet.',
  libraryOverlayVariants: 'Several overlays were preserved, so none is shown automatically.',
  libraryOverlaySize: 'The overlay has a different shape from the photo. It is preserved, but hidden so it is not stretched.',
  libraryOverlayFailed: 'The overlay could not be verified or shown. The original is still available.',
  libraryShowOverlay: 'Show overlay', libraryHideOverlay: 'Hide overlay', libraryPhoto: 'Preserved original photo',

  // Video
  videoPlay: 'Play', videoPause: 'Pause', videoRestart: 'Restart', videoBack: 'Back 5 seconds', videoForward: 'Forward 5 seconds',
  videoMute: 'Mute', videoUnmute: 'Unmute', videoLoading: 'Loading video…',
  videoGeometry: 'The video’s display size is unknown. Its overlay is preserved but hidden.',
  videoClock: (current: number, duration: number) => `${clock(current)} / ${clock(duration)}`,
  videoTime: (current: number, duration: number) => `${Math.floor(current)} of ${Math.floor(duration)} seconds`,

  // Favorites
  favoriteLabel: 'Favorite', favoriteAdd: 'Add to favorites', favoriteRemove: 'Remove from favorites', favoriteSaving: 'Saving favorite…', favoriteFailed: 'Could not save this change. Try again.',

  // Filters
  filtersTitle: 'Filters', filterButton: 'Filters',
  filterMediaHeader: 'Show', filterMedia: { all: 'All', photos: 'Photos', videos: 'Videos' },
  favoritesOnly: 'Favorites only',
  filterMonth: 'Month', filterMonthPlaceholder: 'YYYY-MM',
  filterMonthNote: 'Uses the recorded UTC or filename date. Unknown and conflicting dates are left out when a month is set.',
  filterInvalid: 'Enter a month such as 2026-10, or leave it empty.', filterApply: 'Apply', filterClear: 'Clear filters', filterCancel: 'Cancel',
  filterChips: (media: 'all' | 'photos' | 'videos', favorites: boolean, month: string) =>
    [media === 'all' ? '' : media === 'photos' ? 'Photos' : 'Videos', favorites ? 'Favorites' : '', month].filter(Boolean),
  filterEmpty: 'No memories match these filters.',

  // Backup
  backupTitle: 'Back up library', backupSubtitle: 'A portable ZIP of everything preserved in Snarchive.',
  backupUnencrypted: 'Not encrypted', backupUnencryptedDetail: 'Contains your photos, videos, overlays and metadata, including any saved locations. Choose a location you trust.',
  backupDirect: 'Saved where you choose', backupDirectDetail: 'Written directly to that location, which needs room for a copy of your library.',
  backupOpenApp: 'Keep Snarchive open', backupOpenAppDetail: 'If the app is closed while saving, an incomplete ZIP may remain there. Delete it before trying again.',
  backupFooter: 'Only files already preserved are included; pending files stay pending. Restore is not available in this development build.',
  backupStart: 'Create backup', backupCancel: 'Cancel backup', backupCancelling: 'Cancelling…',
  backupStage: { snapshot: 'Preparing library records…', choose: 'Choose where to save the backup.', save: 'Checking originals, writing the backup and checking the saved file…' },
  backupSaved: 'Backup saved and checked', backupSavedDetail: 'Restore is not available yet, so keep your original exports too.',
  backupCancelled: 'Backup cancelled.',
  backupErrors: {
    'backup-partial-remains': 'Saving did not finish. An incomplete file remains at the chosen location. Delete it before trying again.',
    'backup-unverified': 'The backup was written, but the chosen location could not hand it back for checking (some cloud services are still uploading). It was kept, but it has not been checked. Do not rely on it as your only copy.',
    'backup-saved-cleanup-failed': 'Backup saved and checked, but temporary files could not be cleared. Reopen the app before another backup.',
    'backup-cleanup-failed': 'Temporary backup files could not be cleared. Reopen the app before trying again.',
    'stored-object-corrupt': 'An original is missing or damaged. No backup was saved.',
    'insufficient-storage': 'Not enough space to create the backup. Free some space and try again.',
    'backup-schema-unsupported': 'This version of the app cannot back up this library yet. Update the app and try again.',
    'native-build-required': 'Install the latest Android development build to save backups.',
  } as Record<string, string>,
  backupFailed: 'The backup could not be saved and checked. Your library has not changed. Please try again.',

  // Backup inspection (read-only)
  inspectOpen: 'Check a backup', inspectOpenDetail: 'Verify a backup file and preview it',
  inspectTitle: 'Check a backup', inspectSubtitle: 'Verify a Snarchive backup and see what it contains. Nothing is restored or changed.',
  inspectFull: 'Reads every original', inspectFullDetail: 'Every photo and video in the backup is read and checked against its recorded size and checksum, so a large backup takes a while. Keep Snarchive open.',
  inspectReadOnly: 'Read-only', inspectReadOnlyDetail: 'Your library, favorites and import jobs are not touched, and the backup file is not changed.',
  inspectLater: 'Restore comes later', inspectLaterDetail: 'This checks a backup and previews it. Restoring a backup into your library is not available yet.',
  inspectChoose: 'Choose backup', inspectAgain: 'Check another backup', inspectCancel: 'Cancel check', inspectCancelling: 'Cancelling…',
  inspectStage: { opening: 'Opening the backup…', manifest: 'Checking the backup’s records…' },
  inspectObjects: (verified: number, total: number, bytes: string, totalBytes: string) => `Checked ${verified.toLocaleString()} of ${plural(total, 'original', 'originals')} (${bytes} of ${totalBytes}).`,
  inspectPickerClosed: 'No backup was chosen.',
  inspectCancelled: 'Check cancelled. Nothing was changed.',
  inspectVerified: 'Backup verified',
  inspectVerifiedDetail: 'Every original matched its recorded size and checksum, and every record checked out. Nothing has been restored; your library has not changed.',
  inspectCopyNote: 'This storage location could not be read in place, so a temporary private copy was used and has been deleted.',
  inspectCopyKept: 'This storage location could not be read in place, so a temporary private copy was used.',
  inspectCleanupFailed: 'A temporary copy of the backup could not be deleted. Reopen the app before checking another backup; Snarchive tries to remove it again at startup.',
  inspectContents: 'What this backup contains',
  inspectFooter: 'Verifying is not permanent approval: a future restore will check the file again before using it.',
  /** Never claims a deletion that did not happen: in place there was no copy; a copy that remains is reported separately. */
  inspectFooterFor: (inPlace: boolean, cleanupFailed: boolean): string =>
    inPlace ? en.inspectFooter : `${cleanupFailed ? en.inspectCopyKept : en.inspectCopyNote} ${en.inspectFooter}`,
  inspectCounts: {
    memories: ['Memories', 'Distinct memories with a preserved photo or video. Shared files and repeated observations count once.'],
    objects: ['Original files', 'Unique files stored in the backup, and their total size.'],
    shared: ['Shared files', 'Files used by more than one memory. Each memory stays separate.'],
    sources: ['Export sources', 'Snapchat export ZIPs that were scanned for this library.'],
    favorites: ['Favorites', 'Memories marked as favorites.'],
    pending: ['Pending files', 'Files listed in an export whose originals were not preserved yet.'],
    overlayOnly: ['Overlay-only memories', 'Overlays whose base photo or video is not preserved.'],
    variants: ['Competing versions', 'Memories with more than one file for the same role. All of them are kept.'],
    unlinked: ['Unlinked files', 'Files in the backup that no memory refers to.'],
  } as const,
  inspectErrors: {
    'busy': 'Another Snarchive task is running. Wait for it to finish, then try again.',
    'unsafe-or-unsupported-zip': 'This file is not a readable ZIP archive, or it uses ZIP features Snarchive does not accept.',
    'backup-not-snarchive': 'This ZIP is not a Snarchive backup. To add a Snapchat export, use Scan ZIP files on the home screen.',
    'backup-invalid': 'This backup’s records are malformed or inconsistent, so it cannot be trusted.',
    'backup-unsupported': 'This backup was made by a newer version of Snarchive. Update the app to check it.',
    'backup-damaged': 'Part of this backup is missing or damaged: a file did not match its recorded size or checksum.',
    'backup-limit': 'This backup is larger than Snarchive’s current limits.',
    'staging-cleanup-failed': 'A temporary copy left by an earlier check or import could not be removed, so this backup was not opened. Your backup and library are unchanged. Reopen Snarchive and try again.',
    'source-changed': 'The backup file changed while it was being checked. Make sure nothing else is writing to it, then try again.',
    'insufficient-storage': 'This location cannot be read in place, and there is not enough free space for a temporary copy. Free space equal to the backup’s size plus 64 MiB, or move the backup to this device.',
    'native-build-required': 'Install the latest Android development build to check backups.',
  } as Record<string, string>,
  inspectUnreadable: 'The backup could not be read. Access may have expired or the storage provider failed. Try choosing it again.',
  /** Notices for a failed or cancelled check: the outcome first, then a copy that could not be deleted. A leftover
   * copy that stopped the check from starting is explained once, without blaming the chosen backup. */
  inspectOutcomeNotices: (outcome: { cancelled: true } | { cancelled: false; code: string }, cleanupFailed: boolean): { tone: 'info' | 'warning' | 'error'; message: string }[] => {
    if (outcome.cancelled) return [{ tone: 'info', message: en.inspectCancelled }, ...(cleanupFailed ? [{ tone: 'warning' as const, message: en.inspectCleanupFailed }] : [])];
    const code = outcome.code;
    const tone = code === 'busy' || code === 'insufficient-storage' || code === 'staging-cleanup-failed' ? 'warning' : 'error';
    const notices: { tone: 'info' | 'warning' | 'error'; message: string }[] = [{ tone, message: en.inspectErrors[code] ?? en.inspectUnreadable }];
    if (cleanupFailed && code !== 'staging-cleanup-failed') notices.push({ tone: 'warning', message: en.inspectCleanupFailed });
    return notices;
  },
};
