const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

export const en = {
  title: 'Snarchive',
  promise: 'Your memories, yours to keep.',

  detailsTitle: 'Memory details',
  detailsSelected: (section: string) => `${section} · selected`,
  detailsSections: { originals: 'Stored originals', dates: 'Recorded dates', sources: 'Export file records' },
  detailsNote: 'Library records only. Opening details does not check file integrity or access your exports. Use Settings → Troubleshooting → Check saved files to verify stored files.',
  detailsDateNote: 'Distinct dates indexed from export metadata (UTC) and filenames (inferred). These are recorded evidence, not an editable capture date. Repeated evidence is shown once; unknown dates have no entry.',
  detailsSourceNote: 'Paths are relative to the recorded ZIP or extracted folder root. A pending record has not been preserved by that import. Source identities describe recorded imports; access to those exports is not checked.',
  detailsEmpty: 'No records in this section.',
  detailsLoading: 'Loading memory details…',
  detailsFailed: 'These records could not be read. Try again, or close details to return to the memory.',
  detailsPrevious: 'Previous records', detailsNext: 'Next records', detailsDone: 'Done',
  detailsMemoryId: 'Memory ID', detailsHash: 'SHA-256', detailsPath: 'Stored path', detailsBytes: (bytes: number) => `${bytes.toLocaleString('en-US')} bytes`,
  detailsRoles: { photo: 'Photo', video: 'Video', overlay: 'Overlay' },
  detailsKinds: { zip: 'ZIP', folder: 'Extracted folder' },
  detailsStates: { done: 'Preserved by this import', pending: 'Pending in this import' },
  detailsDateKinds: { instant: 'Export metadata · UTC', 'date-only': 'Filename · inferred day' },
  detailsSourceId: 'Source identity', detailsExportPath: 'Path within export',

  appearanceTitle: 'Appearance',
  appearanceDetail: 'System, Light or Dark',
  appearanceChoices: { system: 'System', light: 'Light', dark: 'Dark' },
  appearanceNote: 'Choose how Snarchive looks. System follows your device’s light or dark setting.',
  appearanceLocalNote: 'Saved on this device. This preference is not included in library backups. System dialogs and media keep their own appearance.',
  appearanceLoading: 'Loading appearance…',
  appearanceSaving: 'Saving appearance…',
  appearanceLoadFailed: 'Your saved appearance could not be read. Snarchive is using System. Try again to load your preference.',
  appearanceSaveFailed: 'Appearance could not be saved. Your previous choice is still in use. Choose an option to try again.',

  // Home: library
  libraryHeadline: (memories: number) => memories === 1 ? 'memory preserved' : 'memories preserved',
  libraryStats: (objects: number, files: number) => `${plural(objects, 'stored original', 'stored originals')} · ${plural(files, 'file record', 'file records')}`,
  libraryUnfinished: (jobs: number) => `${plural(jobs, 'unfinished import', 'unfinished imports')}. Choose the same ZIP or folder below to resume.`,
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
  importFolder: (id: string) => `Folder ${id}`, importFolderDetail: 'Choose this folder again to copy its originals',
  importNote: 'Scanning only reads an export. Preserving copies its original files into Snarchive: choose the same ZIP or folder again each time. Keep space for the originals plus 64 MiB, and keep an independent copy of your exports.',
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
  importCorrupt: 'A stored original could not be verified. The import stopped without replacing it. Use Settings → Troubleshooting → Check saved files to repair it from a backup or a recorded export. Keep your source exports.',
  importComplete: 'Original files are preserved. Open the library to see your memories, and keep an independent backup.',
  importProgress: (count: number) => `${plural(count, 'file', 'files')} copied or verified. Keep Snarchive open.`,
  folderPick: 'Choose the same folder again to preserve or resume its original files.',
  folderComplete: (preserved: number) => `${plural(preserved, 'original', 'originals')} copied or verified from this folder. Every file in its scan is preserved. Open the library to see your memories.`,
  folderPartial: (preserved: number, left: number) => `${plural(preserved, 'original', 'originals')} copied or verified. ${plural(left, 'file', 'files')} could not be read or changed while being read, so they were left for later. Choose the folder again to retry them.`,
  folderChangedSince: (count: number) => `${plural(count, 'preserved file has', 'preserved files have')} since changed size in the folder. The originals copied earlier were kept.`,
  folderChanged: 'This folder does not match its scan: files or metadata were added, removed or edited, or a different folder was chosen. Scan the folder again, then preserve it.',
  folderAccess: 'Snarchive can no longer read this folder. Choose it again to give access. Completed files were kept.',
  folderUnreadable: 'The folder could not be read. Completed files were kept. Check that it is still available, then choose it again.',
  folderPaused: 'Preserving stopped. Completed files were kept. Choose the same folder again to continue.',
  folderStorage: 'Not enough free storage to continue. Completed files were kept. Free some space, then choose the same folder to resume.',
  folderCancelled: 'Preserving cancelled. Completed files were kept; the rest stay pending.',
  folderStoreCleanup: 'A partly copied original could not be removed from Snarchive’s storage. It is never used as a memory. Snarchive tries to remove it again the next time you restore a backup or preserve originals.',

  // Library
  libraryTitle: 'Library',
  libraryOrder: 'Newest first. Unknown or conflicting dates come last.',
  onThisDay: 'On this day',
  onThisDayScope: (day: string) => `${day} (UTC) · Previous years only. Unknown and conflicting dates are left out.`,
  onThisDayNote: 'Uses the recorded UTC or filename date, in previous years. Replaces the month filter. February 29 matches February 29 only.',
  onThisDayEmpty: 'No memories from this day in previous years match these filters.',
  onThisDayAllDates: 'Show all dates',
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
  libraryPhotoFailed: 'This photo could not be verified or displayed. Its record has been kept. Use Settings → Troubleshooting → Check saved files to check it and, if needed, repair its exact bytes. Keep your source exports.',
  libraryOverlayVariants: 'Several overlays were preserved, so none is shown automatically.',
  libraryOverlaySize: 'The overlay has a different shape from the photo. It is preserved, but hidden so it is not stretched.',
  libraryOverlayFailed: 'The overlay could not be verified or shown. The original is still available.',
  viewerStep: (direction: 'next' | 'previous') => direction === 'next' ? 'Next memory' : 'Previous memory',
  viewerNone: (direction: 'next' | 'previous') => direction === 'next' ? 'No next memory' : 'No previous memory',
  viewerNavigationFailed: (direction: 'next' | 'previous') => `The ${direction} memory could not be loaded. Your library has not been changed. Try again.`,
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
  filterChips: (media: 'all' | 'photos' | 'videos', favorites: boolean, month: string, onThisDay = '') =>
    [media === 'all' ? '' : media === 'photos' ? 'Photos' : 'Videos', favorites ? 'Favorites' : '', month, onThisDay ? `On this day: ${onThisDay} (UTC)` : ''].filter(Boolean),
  filterEmpty: 'No memories match these filters.',

  // Backup
  backupTitle: 'Save a backup', backupSubtitle: 'A portable ZIP of everything preserved in Snarchive.',
  backupUnencrypted: 'Not encrypted', backupUnencryptedDetail: 'Contains your photos, videos, overlays and metadata, including any saved locations. Choose a location you trust.',
  backupDirect: 'Saved where you choose', backupDirectDetail: 'Written directly to that location, which needs room for a copy of your library.',
  backupOpenApp: 'Keep Snarchive open', backupOpenAppDetail: 'If the app is closed while saving, an incomplete ZIP may remain there. Delete it before trying again.',
  backupFooter: 'Only files already preserved are included; pending files stay pending. Restore it from Settings → Restore a backup.',
  backupStart: 'Create backup', backupCancel: 'Cancel backup', backupCancelling: 'Cancelling…',
  backupStage: { snapshot: 'Preparing library records…', choose: 'Choose where to save the backup.', save: 'Checking originals, writing the backup and checking the saved file…' },
  backupSaved: 'Backup saved and checked', backupSavedDetail: 'Keep your original exports too: resuming unfinished imports still needs them.',
  backupCancelled: 'Backup cancelled.',
  backupErrors: {
    'backup-partial-remains': 'Saving did not finish. An incomplete file remains at the chosen location. Delete it before trying again.',
    'backup-unverified': 'The backup was written, but the chosen location could not hand it back for checking (some cloud services are still uploading). It was kept, but it has not been checked. Do not rely on it as your only copy.',
    'backup-saved-cleanup-failed': 'Backup saved and checked, but temporary files could not be cleared. Reopen the app before another backup.',
    'backup-cleanup-failed': 'Temporary backup files could not be cleared. Reopen the app before trying again.',
    'stored-object-corrupt': 'An original is missing or damaged, so no backup was saved. Use Settings → Troubleshooting → Check saved files to repair it from an earlier backup or a recorded export. Keep your source exports.',
    'insufficient-storage': 'Not enough space to create the backup. Free some space and try again.',
    'backup-schema-unsupported': 'This version of the app cannot back up this library yet. Update the app and try again.',
    'native-build-required': 'Install the latest Android development build to save backups.',
  } as Record<string, string>,
  backupFailed: 'The backup could not be saved and checked. Your library has not changed. Please try again.',

  // Backup inspection (read-only)
  inspectOpen: 'Check or restore a backup', inspectOpenDetail: 'Verify a backup file, then restore it if you choose',
  originalsOpen: 'Check originals', originalsOpenDetail: 'Verify every stored photo and video',
  storageOpen: 'Manage storage', storageOpenDetail: 'Review leftover files and kept damaged copies',

  // Manage storage (Android, section 24)
  storageTitle: 'Free up unused space', storageSubtitle: 'Review files Snarchive keeps that no memory uses, and remove the ones you choose.',
  storageReviewOnly: 'Reviewing changes nothing', storageReviewOnlyDetail: 'Snarchive lists the files and you choose what to remove. Nothing is selected for you.',
  storageProtected: 'Your library is protected', storageProtectedDetail: 'Originals the library records are never listed, and are checked again just before each removal. Memories, sources and favorites are never removed.',
  storageEstimate: 'Sizes are estimates', storageEstimateDetail: 'Removing a file may free less space than its size, for example when the system shares its storage with another file.',
  storageStart: 'Review removable files', storageCancel: 'Cancel', storageCancelling: 'Cancelling…',
  storageScanning: (listed: number) => `Reviewing storage: ${listed.toLocaleString()} files looked at.`,
  storageUncatalogued: 'Leftover originals', storageUncataloguedFooter: 'Files left by an interrupted import or restore. The library does not record them, so no memory uses them.',
  storageQuarantine: 'Kept damaged copies', storageQuarantineFooter: 'Copies of damaged files that a repair replaced. They may be damaged or incomplete.',
  storageNone: 'Nothing to review here.',
  storageCount: (count: number, bytes: string) => `${count.toLocaleString()} · ${bytes}`,
  storageObjectTitle: (hash: string) => `Original ${hash.slice(0, 12)}`,
  storageQuarantineTitle: (copy: string, hash: string) => `Copy ${copy} of original ${hash.slice(0, 12)}`,
  storageDetail: (bytes: string, date: string) => `${bytes} · ${date}`,
  storageSelectAll: (count: number) => `Select all ${count.toLocaleString()}`, storageClear: 'Clear selection',
  storageMore: (shown: number, total: number) => `Show more (${shown.toLocaleString()} of ${total.toLocaleString()})`,
  storageRemoveSelected: (count: number) => `Remove ${plural(count, 'selected file', 'selected files')}…`,
  storageUnrecognized: (count: number) => `${plural(count, 'other item was', 'other items were')} found that Snarchive does not recognize. ${count === 1 ? 'It is' : 'They are'} not listed and cannot be removed here.`,
  storageSelection: 'Selected files',
  storageConfirmTitle: (count: number, bytes: string) => `Remove ${plural(count, 'file', 'files')} (${bytes})?`,
  storageConfirmObjects: 'Only these files are removed, and only if each is still exactly the file listed and the library still does not use it. Removal cannot be undone.',
  storageConfirmQuarantine: 'These are copies of damaged files. They may be damaged or incomplete, and may be the only remaining copy of those damaged bytes. Only these copies are removed, and removal cannot be undone.',
  storageConfirm: 'Remove', storageConfirmCancel: 'Keep files',
  storageRemoving: (done: number, total: number) => `Removing: ${done.toLocaleString()} of ${total.toLocaleString()}.`,
  storageResultTitle: 'Removal results',
  storageResultRows: {
    removed: ['Removed', 'Deleted from Snarchive’s storage.'],
    skipped: ['Skipped', 'No longer the file that was listed, or the library now uses it. Left as it is.'],
    failed: ['Could not be removed', 'Left as it is.'],
    notAttempted: ['Not attempted', 'The removal stopped before these.'],
  } as const,
  storageResultFooter: 'Space freed may be less than the sizes shown. Review again to see what remains.',
  storageSyncWarning: (count: number) => `${plural(count, 'removed file was', 'removed files were')} deleted, but the system could not confirm the change was written to storage.`,
  storageStopped: (code: string) => code === 'cancelled' ? 'Removal cancelled. Files already removed stay removed; the rest were left as they are.'
    : code === 'storage-schema-unsupported' || code === 'library-check-failed' ? 'Snarchive could not confirm that the remaining files are unused, so it stopped. They were left as they are.'
    : 'Removal stopped. Files already removed stay removed; the rest were left as they are.',
  storageFailed: (code: string) => code === 'cancelled' ? 'Cancelled. Nothing was removed.'
    : code === 'busy' ? 'Another Snarchive task is running. Wait for it to finish, then try again.'
    : code === 'storage-busy' ? 'Another Snarchive write is using storage. Wait for it to finish, then try again. Nothing was removed.'
    : code === 'storage-schema-unsupported' ? 'This library uses a version this screen cannot check safely. Nothing was removed.'
    : code === 'native-build-required' ? 'Install the latest Snarchive Android development build to manage storage.'
    : 'Storage could not be reviewed. Nothing was removed. Try again.',
  storageSessionCleanup: 'The storage session could not be closed cleanly. Reopen Snarchive before trying again.',
  storageReviewAgain: 'Review again', storageDone: 'Done',

  // Check originals and repair from a backup (Android, section 22)
  originalsTitle: 'Check saved files', originalsSubtitle: 'Find originals in your library that are missing or damaged.',
  originalsFull: 'Every file is read', originalsFullDetail: 'Each original is read in full and compared with the checksum recorded when it was preserved. This can take a while for a large library.',
  originalsReadOnly: 'Checking changes nothing', originalsReadOnlyDetail: 'The check only reads. Repair is a separate step that you start.',
  originalsRepairScope: 'Repair needs an exact copy', originalsRepairScopeDetail: 'Choose a Snarchive backup, the original export ZIP, or an extracted folder. Only files matching the library’s recorded checksum and length can repair an original. Keep your exports and independent backups.',
  originalsChooseSource: 'Choose a repair source',
  originalsRepairZip: 'Repair from an export ZIP', originalsRepairFolder: 'Repair from an extracted folder',
  originalsBackupDetail: 'A Snarchive backup containing the exact original',
  originalsZipDetail: 'Choose one original ZIP part; repeat with other parts as needed',
  originalsFolderDetail: 'Choose the folder where recorded relative paths begin. If extraction added an outer folder, open it first.',
  originalsZipNotRecorded: 'This ZIP is not one of the exports recorded in your library. Choose the original ZIP part or another repair source. Nothing was changed.',
  originalsExportValidating: 'Opening and checking the export…',
  originalsPickerClosed: 'No repair source was chosen.',
  originalsSourceCleanup: 'The selected source could not be fully closed or its temporary files could not be cleared. Reopen the app before trying again. Snarchive retries temporary-copy cleanup at startup or when opening another ZIP.',
  originalsStart: 'Check saved files', originalsCancel: 'Cancel check', originalsCancelling: 'Cancelling…',
  originalsProgress: (checked: number, total: number) => `Checking originals: ${checked.toLocaleString()} of ${total.toLocaleString()}.`,
  originalsAllGood: (total: number) => total === 0 ? 'There are no originals in your library yet.' : `All ${total.toLocaleString()} originals match their recorded checksums.`,
  originalsAllGoodTitle: 'Originals verified',
  originalsFoundTitle: (count: number) => `${plural(count, 'original needs', 'originals need')} attention`,
  originalsFound: (total: number) => `Checked ${total.toLocaleString()} originals. Repair them from a backup that contains them.`,
  originalsCancelled: 'Check cancelled. Nothing was changed.',
  originalsFailed: 'The check could not be completed. Nothing was changed. Try again.',
  originalsBusy: 'Another Snarchive task is running. Wait for it to finish, then try again.',
  originalsHealth: { missing: 'Missing', damaged: 'Damaged', unreadable: 'Could not be read' } as const,
  originalsHealthDetail: { missing: 'The file is gone.', damaged: 'The file has the wrong length or content.', unreadable: 'The file could not be opened or read, so its content is unknown.' } as const,
  originalsUsedBy: (count: number, first: string) => count === 0 ? 'Not used by any memory' : count === 1 ? first : `${first} and ${plural(count - 1, 'other memory', 'other memories')}`,
  originalsShared: (count: number) => `${plural(count, 'damaged original is', 'damaged originals are')} shared by several memories.`,
  originalsMore: (shown: number, total: number) => `Show more (${shown.toLocaleString()} of ${total.toLocaleString()})`,
  originalsRepair: 'Repair from a backup', originalsCheckAgain: 'Check again', originalsDone: 'Done',
  originalsRepairCancel: 'Cancel repair',
  originalsRepairValidating: 'Checking the backup…',
  originalsRepairProgress: (done: number, total: number) => `Repairing: ${done.toLocaleString()} of ${total.toLocaleString()}.`,
  originalsRepairTitle: 'Repair results',
  originalsRepairRows: {
    repaired: ['Repaired', 'Replaced with verified original bytes.'],
    alreadyValid: ['Already valid', 'Verified when repair began; nothing was written.'],
    unavailable: ['Not available in this source', 'No usable recorded path or object was found here. Try another source, or Check again to refresh the original’s health.'],
    mismatch: ['Source copy did not match', 'The source’s copy failed its length or checksum check; nothing was changed.'],
    failed: ['Could not be repaired', 'The original was left as it was.'],
    notAttempted: ['Not attempted', 'The repair stopped before these.'],
  } as const,
  originalsQuarantine: 'Damaged copies are kept in Snarchive’s private storage and still use space. Removing them is not available yet.',
  originalsRepairStopped: (code: string) => code === 'cancelled' ? 'Repair cancelled. Originals already repaired stay repaired; the others were not changed.'
    : code === 'insufficient-storage' ? 'Not enough free storage to continue repairing. Free some space, then try again.'
    : 'Repair stopped. Originals already repaired stay repaired; the others were not changed.',
  originalsRepairFailed: (code: string, source: 'backup' | 'zip' | 'folder' = 'backup') => code === 'cancelled' ? 'Repair cancelled. Nothing was changed.'
    : code === 'busy' ? 'Another Snarchive task is running. Wait for it to finish, then try again.'
    : code === 'storage-busy' ? 'Another Snarchive write is using storage. Wait for it to finish, then try again. Nothing was changed.'
    : code === 'store-staging-cleanup-failed' ? 'A partly written original could not be cleared, so repair did not start. Your originals were not changed.'
    : code === 'choose-one-zip' ? 'Choose one export ZIP for this repair. You can repeat with another part afterwards. Nothing was changed.'
    : code === 'native-build-required' ? 'Install the latest Snarchive Android development build to use this repair source.'
    : code === 'export-unreadable' || code === 'source-changed' ? 'The export could not be read or changed while opening. Choose it again to retry. Nothing was changed.'
    : source !== 'backup' && code === 'insufficient-storage' ? (source === 'zip'
      ? 'Not enough free space to open this export ZIP. A ZIP that cannot be read in place needs a temporary copy: free its size plus 64 MiB, or move it to this device. Your export and library were not changed.'
      : 'Not enough free space to open this export folder. Free some space and try again. Your export and library were not changed.')
    : source !== 'backup' && code === 'staging-cleanup-failed' ? 'A temporary ZIP copy left by an earlier operation could not be removed, so this export was not opened. Your export and library were not changed. Reopen Snarchive and try again.'
    : source !== 'backup' ? 'The export could not be opened for repair. Access may have expired or the storage provider failed. Choose it again to retry. Your export and library were not changed.'
    : `${en.inspectErrors[code] ?? en.inspectUnreadable} Nothing was changed.`,
  originalsAfterRepair: 'Check again to confirm the result.',
  originalsRepairWarning: (code: string, count: number) => code === 'thumbnail-eviction-failed'
    ? `${plural(count, 'repaired original', 'repaired originals')} kept an old cached thumbnail that could not be removed; it may still look damaged in the grid. The original itself is repaired.`
    : `${plural(count, 'repaired original is', 'repaired originals are')} in place, but the system could not confirm the change was written to storage. Check again later.`,
  originalsUnknownDay: 'Date unknown', originalsRole: { photo: 'photo', video: 'video', overlay: 'overlay' } as const,
  inspectTitle: 'Restore a backup', inspectSubtitle: 'Verify a Snarchive backup and see what it contains. Checking changes nothing; restoring is a separate step.',
  inspectFull: 'Reads every original', inspectFullDetail: 'Every photo and video in the backup is read and checked against its recorded size and checksum, so a large backup takes a while. Keep Snarchive open.',
  inspectReadOnly: 'Read-only', inspectReadOnlyDetail: 'Your library, favorites and import jobs are not touched, and the backup file is not changed.',
  inspectLater: 'Restore only when you choose', inspectLaterDetail: 'After a successful check you can restore the backup into your library. Nothing changes until you choose Restore.',
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
  inspectFooter: 'Verifying is not permanent approval: restoring checks the file again before using it.',
  /** Never claims a deletion that did not happen: in place there was no copy; a copy that remains is reported separately. */
  inspectFooterFor: (inPlace: boolean, cleanupFailed: boolean): string =>
    inPlace ? en.inspectFooter : `${cleanupFailed ? en.inspectCopyKept : en.inspectCopyNote} ${en.inspectFooter}`,
  inspectCounts: {
    memories: ['Memories', 'Distinct memories with a preserved photo or video. Shared files and repeated observations count once.'],
    objects: ['Original files', 'Unique files stored in the backup, and their total size.'],
    shared: ['Shared files', 'Files used by more than one memory. Each memory stays separate.'],
    sources: ['Export sources', 'Snapchat export ZIPs and extracted folders that were scanned for this library.'],
    favorites: ['Favorites', 'Memories marked as favorites.'],
    pending: ['Pending files', 'Files listed in an export whose originals were not preserved yet.'],
    overlayOnly: ['Overlay-only memories', 'Overlays whose base photo or video is not preserved.'],
    variants: ['Competing versions', 'Memories with more than one file for the same role. All of them are kept.'],
    unlinked: ['Unlinked files', 'Files in the backup that no memory refers to.'],
  } as const,
  inspectErrors: {
    'busy': 'Another Snarchive task is running. Wait for it to finish, then try again.',
    'unsafe-or-unsupported-zip': 'This file is not a readable ZIP archive, or it uses ZIP features Snarchive does not accept.',
    'backup-not-snarchive': 'This ZIP is not a Snarchive backup. To add a Snapchat export, use Add memories and choose ZIP files.',
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

  // Restore (Android)
  restoreHeader: 'Restore into this library',
  restoreAdds: 'Adds to your library', restoreAddsDetail: 'Memories, originals and source details from the backup are added. Nothing in your library is deleted or replaced, and memories already here are not duplicated.',
  restoreFavorites: 'Favorites are combined', restoreFavoritesDetail: 'A memory that is a favorite in your library or in the backup stays a favorite.',
  restoreVariants: 'Every version is kept', restoreVariantsDetail: 'If the backup has a different file for a memory you already have, both versions are kept.',
  restoreChecked: 'Checked again, added in one step', restoreCheckedDetail: 'The backup is verified again while restoring, then added all at once. If anything fails, your library is left as it was.',
  restoreFooter: 'Needs free space for originals that are not already in your library. Originals already here are checked, never overwritten. Resuming unfinished imports still needs the original export ZIPs.',
  restoreStart: 'Restore into library', restoreCancel: 'Cancel restore', restoreCancelling: 'Cancelling…',
  restoreStage: { validating: 'Checking the backup again…', merging: 'Adding memories to your library…' },
  restoreObjects: (stored: number, total: number, bytes: string, totalBytes: string) => `Adding originals: ${stored.toLocaleString()} of ${total.toLocaleString()} (${bytes} of ${totalBytes}).`,
  restoreDone: 'Restore complete',
  restoreDoneDetail: 'Your library now includes this backup. Nothing was removed, and memories that were already here were not duplicated.',
  restoreChanges: 'Changes to your library',
  restoreChangeRows: {
    memories: ['Memories added', 'Memories that had no photo or video in your library before.'],
    files: ['Original files', 'Written by this restore, and already present (checked, then reused).'],
    favorites: ['Favorites added', 'Favorites from the backup that were not favorites here.'],
    sources: ['Export sources', 'Added, and existing ones that gained preserved files.'],
    preserved: ['Files preserved', 'Inventory files that are now preserved, from new or existing sources.'],
  } as const,
  restoreFilesValue: (added: number, reused: number) => `${added.toLocaleString()} new · ${reused.toLocaleString()} reused`,
  restoreSourcesValue: (added: number, updated: number) => `${added.toLocaleString()} new · ${updated.toLocaleString()} updated`,
  restoreOpenLibrary: 'Open library', restoreFinish: 'Done',
  restoreCancelled: 'Restore cancelled. Your library was not changed.',
  restoreNotChanged: 'Your library was not changed. Originals that were already checked may stay in Snarchive’s storage, unused, and a later restore reuses them.',
  restoreErrors: {
    'restore-conflict': 'This backup disagrees with an export already in your library: the same export, with different contents or different preserved files. Nothing was restored.',
    'stored-object-corrupt': 'An original already in your library is damaged, so nothing was restored and that file was left untouched. Use Settings → Troubleshooting → Check saved files to repair it from a backup or a recorded export, then restore again. Keep your exports.',
    'restore-schema-unsupported': 'This library uses a version Snarchive cannot restore into. Update the app and try again.',
    'restore-failed': 'The restore could not be completed safely.',
    'store-staging-cleanup-failed': 'A partly written original in Snarchive’s storage could not be removed, so the restore stopped. Your backup is unchanged. Snarchive tries to remove it again the next time you restore a backup or preserve originals; try again later.',
  } as Record<string, string>,
  restoreStoreCleanupFailed: 'A partly written original could not be removed from Snarchive’s storage. It is never used as a memory. Snarchive tries to remove it again the next time you restore a backup, preserve originals or repair.',
  /** Notices for a restore that did not commit: the cause, that the library is unchanged, then each kind of leftover:
   * a private ZIP or manifest copy (cleanupFailed) and a partly written original in store staging (storeCleanupFailed).
   * A leftover that is itself the cause is explained once. */
  restoreFailureNotices: (code: string, cleanupFailed: boolean, storeCleanupFailed = false): { tone: 'info' | 'warning' | 'error'; message: string }[] => {
    const notices: { tone: 'info' | 'warning' | 'error'; message: string }[] = code === 'cancelled'
      ? [{ tone: 'info', message: en.restoreCancelled }]
      : [{ tone: code === 'busy' || code === 'insufficient-storage' || code === 'staging-cleanup-failed' || code === 'store-staging-cleanup-failed' ? 'warning' : 'error',
        message: en.restoreErrors[code] ?? en.inspectErrors[code] ?? en.restoreErrors['restore-failed']! }, { tone: 'info', message: en.restoreNotChanged }];
    if (cleanupFailed && code !== 'staging-cleanup-failed') notices.push({ tone: 'warning', message: en.inspectCleanupFailed });
    if (storeCleanupFailed && code !== 'store-staging-cleanup-failed') notices.push({ tone: 'warning', message: en.restoreStoreCleanupFailed });
    return notices;
  },
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
