package com.alkval.snarchive.sources

import android.app.Activity
import android.content.Intent
import expo.modules.kotlin.Promise
import com.alkval.snarchive.sources.backup.BackupCoordinator
import com.alkval.snarchive.sources.backup.BackupInspection
import com.alkval.snarchive.sources.backup.DeleteOnClose
import com.alkval.snarchive.sources.backup.InspectionGate
import com.alkval.snarchive.sources.backup.BackupSession
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.StatFs
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.security.MessageDigest
import java.io.FileOutputStream
import com.alkval.snarchive.sources.storage.OriginalStore
import com.alkval.snarchive.sources.storage.ArchiveOriginals
import com.alkval.snarchive.sources.storage.FolderOriginals
import com.alkval.snarchive.sources.storage.ExportRepairSession
import com.alkval.snarchive.sources.storage.StorageReview
import com.alkval.snarchive.sources.storage.ThumbnailFiles
import com.alkval.snarchive.sources.zip.ArchiveSource
import com.alkval.snarchive.sources.zip.ZipInventory
import android.provider.DocumentsContract
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean

class SnarchiveSourcesModule : Module() {
  private val backupLock = Any() // Guards the picker promise only; backup state lives in the coordinator.
  private var backupPicker: Promise? = null
  private val cancelled = AtomicBoolean(false)
  private val busy = AtomicBoolean(false)
  // Provider cleanup after teardown runs on its own thread; busy stays held until it has finished.
  private val backups = BackupCoordinator({ Thread(it, "snarchive-backup-cleanup").start() }, { cancelled.get() }, { busy.set(false) })
  // Read-only backup inspection. Holds the busy guard for the whole session, so no import, scan or backup overlaps it.
  private val inspections = InspectionGate<BackupInspection>({ Thread(it, "snarchive-inspection-cleanup").start() },
    { BackupInspection.code(it, cancelled.get()) }, { busy.set(false) })
  private val exportRepairs = InspectionGate<ExportRepairSession>({ Thread(it, "snarchive-export-repair-cleanup").start() },
    { ExportRepairSession.code(it, cancelled.get()) }, { busy.set(false) })
  // Storage review and cleanup (section 24). The gate holds the shared busy guard from opening until close has finished,
  // so no import, scan, check, backup, inspection, restore or repair overlaps a review; a cleanup session also holds the
  // store's cross-process writer lock for its whole life.
  private val storageReviews = InspectionGate<StorageReview>({ Thread(it, "snarchive-storage-review-cleanup").start() },
    { reviewCode(it) }, { busy.set(false) })
  private fun reviewCode(error: Exception): String = if (cancelled.get()) "cancelled" else when (error.message) {
    "cancelled", "storage-busy", "storage-unreadable", "invalid-entry", "unsafe-path", "inaccessible", "delete-failed", "unsafe-storage-path" -> error.message!!
    else -> "storage-review-failed"
  }
  private fun backupRoot() = File(requireNotNull(appContext.reactContext).noBackupFilesDir, "snarchive-backups")
  private var thumbnails: com.alkval.snarchive.sources.storage.ThumbnailCache? = null
  private var importArchive: ArchiveOriginals? = null
  private var importFile: File? = null
  private var importBudget: OriginalStore.Budget? = null
  // A folder preservation session: this run's scan of the reselected tree, pinning each file's document and facts.
  private var importFolder: FolderOriginals? = null
  // An originals check (section 22) in progress: reads the whole store, so nothing may write to it meanwhile.
  @Volatile private var originalCheck = false
  /** True while a ZIP or folder preservation session or an originals check is open; every other operation is refused. */
  private fun importing() = importArchive != null || importFolder != null || originalCheck
  private fun originals(): OriginalStore = OriginalStore(File(requireNotNull(appContext.reactContext).filesDir, "snarchive-originals"))
  override fun definition() = ModuleDefinition {
    Name("SnarchiveSources")
    Function("cancel") { cancelled.set(true) }
    OnDestroy {
      cancelled.set(true); originalCheck = false
      synchronized(backupLock) { backupPicker?.resolve(mapOf("ok" to true, "canceled" to true)); backupPicker = null }
      backups.finishLater()
      inspections.finishLater()
      exportRepairs.finishLater()
      storageReviews.finishLater()
    }
    AsyncFunction("recoverBackups") {
      if (importing() || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      // Also removes private ZIP copies an interrupted preview, import or inspection left behind.
      try { BackupSession(backupRoot(), File::getUsableSpace).use { }; ArchiveSource.removeAbandonedCopies(previewRoot()); mapOf("ok" to true) }
      catch (error: Exception) { backupError(error) }
      finally { busy.set(false) }
    }
    AsyncFunction("beginBackup") {
      if (importing() || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      cancelled.set(false)
      backupResult(backups.begin { BackupSession(backupRoot(), File::getUsableSpace) }.also { if (it != null) busy.set(false) })
    }
    AsyncFunction("appendBackupChunk") { chunk: String -> backupResult(backups.call { it.append(chunk) }) }
    AsyncFunction("addBackupObject") { hash: String, bytes: Double -> backupResult(backups.call {
      require(bytes.isFinite() && bytes >= 0 && bytes <= OriginalStore.MAX_OBJECT && bytes % 1.0 == 0.0)
      it.`object`(hash, bytes.toLong())
    }) }
    AsyncFunction("sealBackup") { backupResult(backups.call { it.seal() }) }
    AsyncFunction("chooseBackupDestination") { promise: Promise ->
      synchronized(backupLock) {
        if (!backups.active() || backupPicker != null || cancelled.get()) {
          promise.resolve(mapOf("ok" to false, "code" to "cancelled"))
        } else {
          backupPicker = promise
          try {
            val activity = requireNotNull(appContext.currentActivity)
            activity.runOnUiThread {
              try {
                activity.startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                  addCategory(Intent.CATEGORY_OPENABLE); type = "application/zip"
                  putExtra(Intent.EXTRA_TITLE, "Snarchive-${java.text.SimpleDateFormat("yyyy-MM-dd-HHmmss", java.util.Locale.ROOT).format(java.util.Date())}.zip")
                  addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                }, 7143)
              } catch (_: Exception) { synchronized(backupLock) {
                backupPicker?.resolve(mapOf("ok" to false, "code" to "backup-save-failed")); backupPicker = null
              } }
            }
          } catch (_: Exception) { backupPicker = null; promise.resolve(mapOf("ok" to false, "code" to "backup-save-failed")) }
        }
      }
    }
    OnActivityResult { _, (requestCode, resultCode, intent) ->
      if (requestCode == 7143) synchronized(backupLock) {
        backupPicker?.let { promise ->
          val uri = if (resultCode == Activity.RESULT_OK) intent?.data?.takeIf { it.scheme == "content" } else null
          val chosen = uri != null && backups.destination(documentDestination(uri)) == null
          promise.resolve(mapOf("ok" to true, "canceled" to !chosen))
          backupPicker = null
        }
      }
    }
    AsyncFunction("saveBackup") { backupResult(backups.save(originals())) }
    AsyncFunction("endBackup") { backupResult(backups.finish()) }

    AsyncFunction("beginBackupInspection") { uriString: String ->
      if (importing() || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      cancelled.set(false)
      var inPlace = false
      // Read in place when the provider allows it; otherwise a bounded, cancellable private copy that is deleted on close.
      val opened = inspections.beginWithStatus {
        val opened = openArchive(uriString)
        inPlace = opened.second == null
        val copy = opened.second
        BackupInspection.open(opened.first, copy?.let { DeleteOnClose(it) }) { cancelled.get() }
      }
      // The gate already released the guard. A failed open keeps its own code and reports a copy it could not delete.
      if (opened.code != null) return@AsyncFunction mapOf("ok" to false, "code" to opened.code, "cleanupFailed" to opened.cleanupFailed)
      val info = inspections.run { mapOf("ok" to true, "inPlace" to inPlace, "objects" to it.objectCount(), "objectBytes" to it.objectBytes().toDouble()) }
      info.value ?: mapOf("ok" to false, "code" to (info.code ?: "backup-unreadable"))
    }
    AsyncFunction("beginBackupRestore") { uriString: String ->
      if (importing() || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      cancelled.set(false)
      var inPlace = false
      // Restore mode: the same opening and validation as inspection, plus a private hashed copy of the manifest
      // (created after openArchive, whose abandoned-copy cleanup would otherwise remove it). Both private files
      // are deleted when the session closes.
      val opened = inspections.beginWithStatus {
        val archive = openArchive(uriString)
        inPlace = archive.second == null
        val staged = try { File.createTempFile("preview-", ".part", previewRoot()) }
          catch (error: Exception) { runCatching { archive.first.close() }; archive.second?.let { DeleteOnClose.deleteOrSuppress(it, error) }; throw error }
        val session = BackupInspection.open(archive.first, DeleteOnClose(archive.second, staged)) { cancelled.get() }
        try { session.enableRestore(staged) } catch (error: Exception) { try { session.close() } catch (cleanup: Exception) { error.addSuppressed(cleanup) }; throw error }
        session
      }
      if (opened.code != null) return@AsyncFunction mapOf("ok" to false, "code" to opened.code, "cleanupFailed" to opened.cleanupFailed)
      mapOf("ok" to true, "inPlace" to inPlace)
    }
    AsyncFunction("prepareBackupRestore") {
      val result = inspections.run { session ->
        val store = originals(); store.recoverStaging()
        val missing = session.missingBytes(store)
        if (StatFs(requireNotNull(appContext.reactContext).filesDir.path).availableBytes < missing + OriginalStore.RESERVE) throw IllegalStateException("insufficient-storage")
        missing
      }
      result.value?.let { mapOf("ok" to true, "missingBytes" to it.toDouble()) } ?: runFailure(result)
    }
    AsyncFunction("storeBackupObjects") {
      val result = inspections.run { it.store(originals(), 250) { cancelled.get() } }
      result.value?.let { mapOf("ok" to true, "stored" to it.stored, "total" to it.total, "added" to it.added, "reused" to it.reused,
        "bytes" to it.bytes.toDouble(), "totalBytes" to it.totalBytes.toDouble(), "done" to it.done) }
        ?: runFailure(result)
    }
    AsyncFunction("readStagedManifest") {
      val chunk = inspections.run { it.readStagedManifest(BackupInspection.MAX_CHUNK) { cancelled.get() } }
      chunk.value?.let { mapOf("ok" to true, "text" to it.text, "done" to it.done) } ?: runFailure(chunk)
    }
    AsyncFunction("readBackupManifest") {
      val chunk = inspections.run { it.readManifest(BackupInspection.MAX_CHUNK) { cancelled.get() } }
      chunk.value?.let { mapOf("ok" to true, "text" to it.text, "done" to it.done) } ?: mapOf("ok" to false, "code" to (chunk.code ?: "backup-unreadable"))
    }
    AsyncFunction("declareBackupObjects") { hashes: List<String>, sizes: List<Double> ->
      val result = inspections.run { session ->
        if (hashes.size != sizes.size || hashes.size > 1000) throw java.io.IOException("backup-invalid")
        for (index in hashes.indices) {
          val bytes = sizes[index]
          if (!bytes.isFinite() || bytes < 0 || bytes % 1.0 != 0.0 || bytes > OriginalStore.MAX_OBJECT) throw java.io.IOException("backup-invalid")
          session.declare(hashes[index], bytes.toLong())
        }
        true
      }
      if (result.code == null) mapOf("ok" to true) else mapOf("ok" to false, "code" to result.code)
    }
    AsyncFunction("sealBackupInspection") {
      val result = inspections.run { it.seal(); true }
      if (result.code == null) mapOf("ok" to true) else mapOf("ok" to false, "code" to result.code)
    }
    AsyncFunction("verifyBackupObjects") {
      // Short slices, so progress reaches the screen and Cancel is honoured between calls as well as within them.
      val result = inspections.run { it.verify(250) { cancelled.get() } }
      result.value?.let { mapOf("ok" to true, "verified" to it.verified, "total" to it.total, "bytes" to it.bytes.toDouble(), "totalBytes" to it.totalBytes.toDouble(), "done" to it.done) }
        ?: mapOf("ok" to false, "code" to (result.code ?: "backup-unreadable"))
    }
    AsyncFunction("endBackupInspection") {
      val code = inspections.finish()
      if (code == null) mapOf("ok" to true) else mapOf("ok" to false, "code" to code)
    }

    AsyncFunction("thumbnail") { hash: String, bytes: Double, video: Boolean ->
      try {
        require(bytes.isFinite() && bytes >= 0 && bytes <= OriginalStore.MAX_OBJECT && bytes % 1.0 == 0.0)
        val context = requireNotNull(appContext.reactContext)
        val cache = synchronized(this) { thumbnails ?: com.alkval.snarchive.sources.storage.ThumbnailCache(context.filesDir, context.cacheDir).also { thumbnails = it } }
        mapOf("ok" to true, "uri" to Uri.fromFile(cache.create(hash, bytes.toLong(), video)).toString())
      } catch (_: Exception) { mapOf("ok" to false, "code" to "thumbnail-unavailable") }
    }
    AsyncFunction("scanArchive") { uriString: String ->
      if (importing() || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      cancelled.set(false)
      var source: ArchiveSource? = null
      var staged: File? = null
      try {
        val opened = openArchive(uriString); source = opened.first; staged = opened.second
        val sha256 = source.pinnedSha256() ?: source.sha256 { cancelled.get() }
        ZipInventory.scan(source) { cancelled.get() }.toMutableMap().apply { source.checkUnchanged(); put("archiveSha256", sha256) }
      } catch (error: Exception) {
        mapOf("ok" to false, "code" to if (cancelled.get()) "cancelled" else if (error.message == "insufficient-storage") "insufficient-storage" else "unsafe-or-unsupported-zip")
      } finally { runCatching { source?.close() }; staged?.delete(); busy.set(false) }
    }
    AsyncFunction("openImportArchive") { uri: String, hash: String, remaining: Double ->
      if (importing() || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      cancelled.set(false)
      var source: ArchiveSource? = null
      var staged: File? = null
      var archive: ArchiveOriginals? = null
      try {
        require(hash.matches(Regex("[a-f0-9]{64}")))
        require(remaining.isFinite() && remaining >= 0 && remaining <= 64L * 1024 * 1024 * 1024 && remaining % 1.0 == 0.0)
        val opened = openArchive(uri); source = opened.first; staged = opened.second
        check((source.pinnedSha256() ?: source.sha256 { cancelled.get() }) == hash) { "source-changed" }
        val store = originals(); store.recoverStaging()
        archive = ArchiveOriginals(source) { cancelled.get() }; source = null // Archive owns and closes it.
        val bytes = archive.totalOriginalBytes()
        // The archive is already readable (in place or copied). Completed items are confirmed on resume; reserve for pending bytes.
        val pendingBytes = maxOf(0L, bytes - (64L * 1024 * 1024 * 1024 - remaining.toLong()))
        if (StatFs(requireNotNull(appContext.reactContext).filesDir.path).availableBytes < pendingBytes + OriginalStore.RESERVE) throw IllegalStateException("insufficient-storage")
        importArchive = archive; importFile = staged; importBudget = OriginalStore.Budget(remaining.toLong())
        mapOf("ok" to true)
      } catch (error: Exception) {
        runCatching { archive?.close() }; runCatching { source?.close() }; staged?.delete(); importError(error)
      } finally { busy.set(false) }
    }
    AsyncFunction("preserveImportEntry") { path: String ->
      if (!busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      try {
        val result = requireNotNull(importArchive).preserve(path, originals(), requireNotNull(importBudget)) { cancelled.get() }
        mapOf("ok" to true, "sha256" to result.sha256, "relativePath" to result.relativePath, "bytes" to result.bytes)
      } catch (error: Exception) { importError(error) } finally { busy.set(false) }
    }
    AsyncFunction("confirmOriginal") { hash: String, bytes: Double ->
      if (!busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      try {
        require(bytes.isFinite() && bytes >= 0 && bytes <= OriginalStore.MAX_OBJECT && bytes % 1.0 == 0.0)
        originals().confirm(hash, bytes.toLong())
        mapOf("ok" to true)
      } catch (error: Exception) { importError(error) } finally { busy.set(false) }
    }
    AsyncFunction("originalUri") { hash: String, bytes: Double ->
      if (importing() || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      cancelled.set(false)
      try {
        require(bytes.isFinite() && bytes >= 0 && bytes <= OriginalStore.MAX_OBJECT && bytes % 1.0 == 0.0)
        val file = originals().confirm(hash, bytes.toLong())
        mapOf("ok" to true, "uri" to Uri.fromFile(file).toString())
      } catch (error: Exception) { importError(error) } finally { busy.set(false) }
    }
    AsyncFunction("originalVideo") { hash: String, bytes: Double ->
      if (importing() || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      cancelled.set(false)
      try {
        require(bytes.isFinite() && bytes >= 0 && bytes <= OriginalStore.MAX_OBJECT && bytes % 1.0 == 0.0)
        val file = originals().confirm(hash, bytes.toLong())
        val result = mutableMapOf<String, Any>("ok" to true, "uri" to Uri.fromFile(file).toString())
        val metadata = android.media.MediaMetadataRetriever()
        try {
          metadata.setDataSource(file.path)
          result["width"] = metadata.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
          result["height"] = metadata.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
          result["rotation"] = metadata.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: -1
        } catch (_: Exception) {
          // Playback may still work. Without geometry, overlays remain unavailable.
        } finally { runCatching { metadata.release() } }
        result
      } catch (error: Exception) { importError(error) } finally { busy.set(false) }
    }
    AsyncFunction("closeImportArchive") {
      if (!busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      try { importArchive?.close(); mapOf("ok" to true) }
      catch (error: Exception) { importError(error) }
      finally { importArchive = null; importBudget = null; importFile?.delete(); importFile = null; busy.set(false) }
    }
    // Folder preservation (section 21). The folder is reselected for every run and scanned again here; JS checks that
    // the scan's inventory identity equals the planned job's before preserving anything. Files are read in place.
    AsyncFunction("openFolderImport") { uriString: String ->
      if (importing() || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      cancelled.set(false)
      try {
        val root = Uri.parse(uriString)
        require(root.scheme == "content" && DocumentsContract.isTreeUri(root))
        originals().recoverStaging()
        val files = HashMap<String, FolderOriginals.Entry>()
        val snapshot = scan(root, files)
        @Suppress("UNCHECKED_CAST") val sizes = (snapshot["entries"] as List<Map<String, Any>>).map { (files[it["path"]]?.scanned?.bytes ?: -1L).toDouble() }
        importFolder = FolderOriginals(SafFolder(root), files); importBudget = null
        snapshot + ("sizes" to sizes)
      } catch (error: Exception) { folderError(error, scanning = true) } finally { busy.set(false) }
    }
    AsyncFunction("prepareFolderImport") { paths: List<String>, remaining: Double ->
      if (!busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      try {
        val folder = requireNotNull(importFolder)
        require(remaining.isFinite() && remaining >= 0 && remaining <= 64L * 1024 * 1024 * 1024 && remaining % 1.0 == 0.0)
        // Reported sizes only estimate the space needed; OriginalStore enforces the reserve on actual bytes as it writes.
        if (StatFs(requireNotNull(appContext.reactContext).filesDir.path).availableBytes < folder.knownBytes(paths) + OriginalStore.RESERVE) throw IllegalStateException("insufficient-storage")
        importBudget = OriginalStore.Budget(remaining.toLong())
        mapOf("ok" to true)
      } catch (error: Exception) { folderError(error) } finally { busy.set(false) }
    }
    AsyncFunction("preserveFolderEntry") { path: String ->
      if (!busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      try {
        val result = requireNotNull(importFolder).preserve(path, originals(), requireNotNull(importBudget)) { cancelled.get() }
        mapOf("ok" to true, "sha256" to result.sha256, "relativePath" to result.relativePath, "bytes" to result.bytes)
      } catch (error: Exception) { folderError(error) } finally { busy.set(false) }
    }
    AsyncFunction("closeFolderImport") {
      if (!busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      try { mapOf("ok" to true) } finally { importFolder = null; importBudget = null; busy.set(false) }
    }
    // Check originals (section 22). Read-only: every recorded object is read in full and classified.
    AsyncFunction("beginOriginalCheck") {
      if (importing() || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      cancelled.set(false); originalCheck = true; busy.set(false)
      mapOf("ok" to true)
    }
    AsyncFunction("checkOriginals") { hashes: List<String>, sizes: List<Double> ->
      if (!originalCheck || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      try {
        require(hashes.size == sizes.size && hashes.size <= 1000)
        val store = originals()
        val health = hashes.indices.map { index ->
          val bytes = sizes[index]
          require(bytes.isFinite() && bytes >= 0 && bytes <= OriginalStore.MAX_OBJECT && bytes % 1.0 == 0.0)
          store.inspect(hashes[index], bytes.toLong()) { cancelled.get() }.name.lowercase()
        }
        mapOf("ok" to true, "health" to health)
      } catch (error: Exception) {
        mapOf("ok" to false, "code" to if (cancelled.get()) "cancelled" else "check-failed")
      } finally { busy.set(false) }
    }
    AsyncFunction("endOriginalCheck") { originalCheck = false; mapOf("ok" to true) }
    // Repair from a backup (section 22), inside an inspection session whose manifest was validated and sealed.
    AsyncFunction("prepareBackupRepair") {
      val result = inspections.run { originals().recoverStaging(); true }
      if (result.code == null) mapOf("ok" to true) else runFailure(result)
    }
    AsyncFunction("repairBackupObject") { hash: String, bytes: Double ->
      val cacheDir = requireNotNull(appContext.reactContext).cacheDir
      val result = inspections.run { session ->
        require(bytes.isFinite() && bytes >= 0 && bytes <= OriginalStore.MAX_OBJECT && bytes % 1.0 == 0.0)
        // Thumbnails are discarded before the replacement and again after it, so none made from damaged bytes survives.
        // After every completed replacement the second eviction runs (inside repair), whatever else was reported.
        session.repair(originals(), hash, bytes.toLong(), { cancelled.get() }, { ThumbnailFiles.evict(cacheDir, hash) }, { ThumbnailFiles.evict(cacheDir, hash) })
      }
      result.value?.let { mapOf("ok" to true, "outcome" to it.outcome.name.lowercase(), "storeCleanupFailed" to it.storeCleanupFailed, "warnings" to it.warnings) }
        ?: runFailure(result)
    }
    // Repair from a recorded export (section 23). The gate reserves the operation until source cleanup finishes.
    AsyncFunction("beginExportRepair") { uriString: String, kind: String ->
      if (importing() || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      cancelled.set(false)
      val opened = exportRepairs.beginWithStatus {
        require(kind == "zip" || kind == "folder")
        if (kind == "folder") {
          val root = Uri.parse(uriString)
          val files = HashMap<String, FolderOriginals.Entry>()
          scan(root, files)
          ExportRepairSession(FolderOriginals(SafFolder(root), files))
        } else {
          val selected = openArchive(uriString)
          try {
            selected.first.pinnedSha256() ?: selected.first.sha256 { cancelled.get() }
            ExportRepairSession(ArchiveOriginals(selected.first) { cancelled.get() }, selected.second?.let { DeleteOnClose(it) })
          } catch (error: Exception) {
            try { selected.first.close() } catch (closing: Exception) { error.addSuppressed(closing) }
            selected.second?.let { DeleteOnClose.deleteOrSuppress(it, error) }
            throw error
          }
        }
      }
      if (opened.code != null) return@AsyncFunction mapOf("ok" to false, "code" to opened.code, "cleanupFailed" to opened.cleanupFailed)
      val result = exportRepairs.run { it.archiveSha256() ?: "" }
      result.value?.let { mapOf("ok" to true, "archiveSha256" to it) } ?: (runFailure(result) + ("sessionOpened" to true))
    }
    AsyncFunction("prepareExportRepair") {
      val result = exportRepairs.run { originals().recoverStaging(); true }
      if (result.code == null) mapOf("ok" to true) else runFailure(result)
    }
    AsyncFunction("repairExportObject") { hash: String, bytes: Double, path: String ->
      val result = exportRepairs.run { session ->
        require(bytes.isFinite() && bytes >= 0 && bytes <= OriginalStore.MAX_OBJECT && bytes % 1.0 == 0.0)
        val cacheDir = requireNotNull(appContext.reactContext).cacheDir
        session.repair(originals(), path, hash, bytes.toLong(), { cancelled.get() },
          { ThumbnailFiles.evict(cacheDir, hash) }, { ThumbnailFiles.evict(cacheDir, hash) })
      }
      result.value?.let { mapOf("ok" to true, "outcome" to it.outcome, "storeCleanupFailed" to it.storeCleanupFailed, "warnings" to it.warnings) }
        ?: runFailure(result)
    }
    AsyncFunction("endExportRepair") {
      val code = exportRepairs.finish()
      if (code == null) mapOf("ok" to true) else mapOf("ok" to false, "code" to code)
    }
    AsyncFunction("beginStorageReview") { mode: String ->
      if (importing() || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      cancelled.set(false)
      val opened = storageReviews.beginWithStatus {
        require(mode == "scan" || mode == "cleanup")
        if (mode == "cleanup") StorageReview.cleanup(originals()) else StorageReview.scan(originals())
      }
      if (opened.code != null) mapOf("ok" to false, "code" to opened.code) else mapOf("ok" to true)
    }
    AsyncFunction("reviewStoragePage") { kind: String, after: String, limit: Int ->
      val result = storageReviews.run { it.page(kind, after, limit) { cancelled.get() } }
      result.value?.let { page -> mapOf("ok" to true, "next" to page.next, "unrecognized" to page.unrecognized,
        "entries" to page.entries.map { mapOf("kind" to it.kind, "path" to it.path, "hash" to it.hash, "bytes" to it.bytes.toDouble(),
          "modified" to it.modified.toDouble(), "identity" to it.identity) }) }
        ?: mapOf("ok" to false, "code" to (result.code ?: "storage-review-failed"))
    }
    AsyncFunction("removeStorageEntry") { kind: String, path: String, identity: String ->
      val result = storageReviews.run { it.remove(kind, path, identity) { cancelled.get() } }
      result.value?.let { mapOf("ok" to true, "outcome" to it.outcome, "reason" to it.reason, "warning" to it.warning) }
        ?: mapOf("ok" to false, "code" to (result.code ?: "storage-review-failed"))
    }
    AsyncFunction("endStorageReview") {
      val code = storageReviews.finish()
      if (code == null) mapOf("ok" to true) else mapOf("ok" to false, "code" to code)
    }
    AsyncFunction("evictStorageThumbnail") { hash: String ->
      val result = storageReviews.run {
        try {
          require(hash.matches(Regex("[a-f0-9]{64}")))
          val context = requireNotNull(appContext.reactContext)
          val cache = synchronized(this) { thumbnails ?: com.alkval.snarchive.sources.storage.ThumbnailCache(context.filesDir, context.cacheDir).also { thumbnails = it } }
          cache.evict(hash); true
        } catch (_: Exception) { false }
      }
      mapOf("ok" to (result.value == true), "code" to if (result.value == true) null else "thumbnail-eviction-failed")
    }
    AsyncFunction("scanDirectory") { uriString: String ->
      if (importing() || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      cancelled.set(false)
      try {
        scan(Uri.parse(uriString), null)
      } catch (error: Exception) {
        // Do not expose provider errors or personal document paths to JS/logs.
        mapOf("ok" to false, "code" to if (cancelled.get()) "cancelled" else "unreadable-or-limit")
      } finally { busy.set(false) }
    }
  }

  // A failed step keeps its own code and says which kinds of cleanup also failed on that path: a private ZIP or
  // manifest copy (cleanupFailed) or a partly written original in the store's staging (storeCleanupFailed).
  private fun runFailure(result: InspectionGate.Result<*>): Map<String, Any> = mapOf("ok" to false,
    "code" to (result.code ?: "backup-unreadable"), "cleanupFailed" to result.cleanupFailed, "storeCleanupFailed" to result.storeCleanupFailed)
  private fun backupError(error: Exception): Map<String, Any> = backupResult(BackupCoordinator.code(error, cancelled.get()))
  private fun backupResult(code: String?): Map<String, Any> = if (code == null) mapOf("ok" to true) else mapOf("ok" to false, "code" to code)
  /** Only the document returned by our Create Document request is ever written or deleted. */
  private fun documentDestination(uri: Uri): BackupCoordinator.Destination {
    val resolver = requireNotNull(appContext.reactContext).contentResolver
    return object : BackupCoordinator.Destination {
      override fun openOutput(): java.io.OutputStream {
        // "w", not "wt": the document was just created empty, and some providers reject truncate mode.
        // A provider that leaves old bytes behind still fails the exact-length read-back.
        val descriptor = requireNotNull(resolver.openFileDescriptor(uri, "w"))
        return object : ParcelFileDescriptor.AutoCloseOutputStream(descriptor) {
          override fun close() {
            try { if (OsConstants.S_ISREG(Os.fstat(descriptor.fileDescriptor).st_mode)) fd.sync() } finally { super.close() }
          }
        }
      }
      override fun openInput(): java.io.InputStream? = resolver.openInputStream(uri)
      override fun delete(): Boolean = DocumentsContract.deleteDocument(resolver, uri)
    }
  }

  private fun importError(error: Exception): Map<String, Any> {
    val code = if (cancelled.get()) "cancelled" else when (error.message) {
      "source-changed", "insufficient-storage", "stored-object-corrupt" -> error.message!!
      else -> "import-failed"
    }
    return mapOf("ok" to false, "code" to code)
  }
  /** A folder run's failure: a known code (provider details never pass through) and whether a partly written original
   * was left in store staging alongside it. */
  private fun folderError(error: Exception, scanning: Boolean = false): Map<String, Any> {
    val code = if (cancelled.get()) "cancelled" else when {
      error is SecurityException -> "folder-access-denied"
      error.message in setOf("source-missing", "source-changed", "source-unreadable", "insufficient-storage", "stored-object-corrupt",
        "byte-limit", "storage-busy", OriginalStore.STAGING_CLEANUP_FAILED) -> error.message!!
      scanning -> "folder-unreadable"
      else -> "import-failed"
    }
    return mapOf("ok" to false, "code" to code, "storeCleanupFailed" to InspectionGate.storeCleanupFailed(error))
  }
  /** Read-only access to documents inside one granted tree. */
  private inner class SafFolder(private val root: Uri) : FolderOriginals.Provider {
    private val resolver get() = requireNotNull(appContext.reactContext).contentResolver
    override fun facts(documentId: String): FolderOriginals.Facts? {
      val uri = DocumentsContract.buildDocumentUriUsingTree(root, documentId)
      val cursor = try { resolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED), null, null, null) }
        catch (_: java.io.FileNotFoundException) { return null }
        catch (_: IllegalArgumentException) { return null } // Some providers report a removed document this way.
        catch (_: SecurityException) { throw IOException("source-unreadable") }
      cursor?.use { if (!it.moveToFirst()) return null; return FolderOriginals.Facts(if (it.isNull(0)) -1 else it.getLong(0), if (it.isNull(1)) -1 else it.getLong(1)) }
      throw IOException("source-unreadable")
    }
    override fun open(documentId: String): FolderOriginals.Opened {
      val uri = DocumentsContract.buildDocumentUriUsingTree(root, documentId)
      val descriptor = try { resolver.openFileDescriptor(uri, "r") }
        catch (_: java.io.FileNotFoundException) { throw IOException("source-missing") }
        catch (_: SecurityException) { throw IOException("source-unreadable") } ?: throw IOException("source-unreadable")
      val input = ParcelFileDescriptor.AutoCloseInputStream(descriptor) // Closing it closes the descriptor.
      try {
        val fd = descriptor.fileDescriptor
        val stat = Os.fstat(fd)
        if (!OsConstants.S_ISREG(stat.st_mode)) return FolderOriginals.Opened(input, -1, null) // A pipe: no length or stamp.
        // Change time cannot be set by a writer, so an in-place rewrite moves it even when the modification time is restored.
        val stamp = FolderOriginals.Stamp {
          try {
            val now = Os.fstat(fd)
            "${now.st_dev}:${now.st_ino}:${now.st_size}:${now.st_mtime}:${now.st_ctime}" +
              if (Build.VERSION.SDK_INT >= 27) ":${now.st_mtim.tv_nsec}:${now.st_ctim.tv_nsec}" else ""
          } catch (error: ErrnoException) { throw IOException("source-changed") }
        }
        return FolderOriginals.Opened(input, stat.st_size, stamp)
      } catch (error: Exception) { runCatching { input.close() }; throw IOException("source-unreadable") }
    }
  }
  /** Reads the selected document in place when the provider gives a seekable regular-file descriptor.
   * Otherwise copies it to private cache (hashed while copying). Second value is the copy to delete, if any. */
  private fun openArchive(uriString: String): Pair<ArchiveSource, File?> {
    val uri = Uri.parse(uriString); require(uri.scheme == "content" || uri.scheme == "file")
    var staged: File? = null
    val source = ArchiveSource.openSelected(previewRoot(), { openInPlace(uri) }) {
      val copy = stageArchive(uri)
      try {
        ArchiveSource.open(copy.first).also { source ->
          try { source.pinCopy(copy.second) } catch (error: Exception) { runCatching { source.close() }; throw error }
        }.also { staged = copy.first }
      } catch (error: Exception) { DeleteOnClose.deleteOrSuppress(copy.first, error); throw error }
    }
    return source to staged
  }

  private fun previewRoot(): File =
    File(requireNotNull(appContext.reactContext).cacheDir, "snarchive-zip-preview").also { check(it.isDirectory || it.mkdirs()) }

  private fun openInPlace(uri: Uri): ArchiveSource? {
    val descriptor = try { requireNotNull(appContext.reactContext).contentResolver.openFileDescriptor(uri, "r") } catch (_: Exception) { null } ?: return null
    val input = ParcelFileDescriptor.AutoCloseInputStream(descriptor) // Closing it closes the descriptor.
    try {
      val fd = descriptor.fileDescriptor
      // Pipes and sockets (streamed or generated documents) cannot be read positionally: use the copy.
      if (!OsConstants.S_ISREG(Os.fstat(fd).st_mode) || descriptor.statSize < 22) { input.close(); return null }
      val channel = input.channel
      check(channel.size() == descriptor.statSize && channel.read(ByteBuffer.allocate(1), channel.size() - 1) == 1)
      val stamp = ArchiveSource.Stamp {
        try {
          val stat = Os.fstat(fd)
          // Change time cannot be set by the writer, so in-place rewrites move it even when mtime is restored.
          "${stat.st_dev}:${stat.st_ino}:${stat.st_size}:${stat.st_mtime}:${stat.st_ctime}" +
            if (Build.VERSION.SDK_INT >= 27) ":${stat.st_mtim.tv_nsec}:${stat.st_ctim.tv_nsec}" else ""
        } catch (error: ErrnoException) { throw IOException("source-changed") }
      }
      return ArchiveSource(channel, input, stamp, File("/dev/null"))
    } catch (_: Exception) { runCatching { input.close() }; return null }
  }

  private fun stageArchive(uri: Uri): Pair<File, String> {
    val context = requireNotNull(appContext.reactContext)
    val root = previewRoot() // Abandoned copies were already removed by openArchive.
    val staged = File.createTempFile("preview-", ".part", root)
    try {
      var copied = 0L; val digest = MessageDigest.getInstance("SHA-256")
      requireNotNull(context.contentResolver.openInputStream(uri)).use { input ->
        FileOutputStream(staged).use { output ->
          val buffer = ByteArray(65536)
          while (true) {
            check(!cancelled.get()); val n = input.read(buffer); if (n == -1) break
            check(!cancelled.get() && n > 0 && n <= 32L * 1024 * 1024 * 1024 - copied)
            if (StatFs(root.path).availableBytes < 64L * 1024 * 1024 + n) throw IllegalStateException("insufficient-storage")
            output.write(buffer, 0, n); digest.update(buffer, 0, n); copied += n
          }
          output.fd.sync()
        }
      }
      return staged to digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
    } catch (error: Exception) { DeleteOnClose.deleteOrSuppress(staged, error); throw error }
  }

  /** Lists the granted tree breadth-first. With files set, also records each file's document ID and the provider's
   * size and modification time (null columns become -1), for a folder preservation run. */
  private fun scan(root: Uri, files: MutableMap<String, FolderOriginals.Entry>?): Map<String, Any> {
    require(root.scheme == "content" && DocumentsContract.isTreeUri(root))
    val resolver = requireNotNull(appContext.reactContext).contentResolver
    val pending = ArrayDeque<Pair<String, String>>()
    pending.add(DocumentsContract.getTreeDocumentId(root) to "")
    val visited = HashSet<String>()
    val paths = HashSet<String>()
    val entries = ArrayList<Map<String, Any>>()
    var metadataBytes = 0
    var count = 0
    val columns = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE,
      DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED)
    while (pending.isNotEmpty()) {
      check(!cancelled.get())
      val (parentId, prefix) = pending.removeFirst()
      check(visited.add(parentId))
      val children = DocumentsContract.buildChildDocumentsUriUsingTree(root, parentId)
      requireNotNull(resolver.query(children, columns, null, null, null)).use { cursor ->
        while (cursor.moveToNext()) {
          check(!cancelled.get())
          check(++count <= 100_000)
          val id = requireNotNull(cursor.getString(0))
          val name = requireNotNull(cursor.getString(1))
          require(name.isNotEmpty() && name != "." && name != ".." && !name.any { it == '/' || it == '\\' || it == ':' || it.code < 32 || it.code == 127 })
          val path = if (prefix.isEmpty()) name else "$prefix/$name"
          require(path.length <= 1024 && path.count { it == '/' } < 32 && paths.add(path))
          if (cursor.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) {
            pending.add(id to path)
          } else {
            val item = mutableMapOf<String, Any>("path" to path)
            files?.put(path, FolderOriginals.Entry(id, FolderOriginals.Facts(
              if (cursor.isNull(3)) -1 else cursor.getLong(3), if (cursor.isNull(4)) -1 else cursor.getLong(4))))
            if (name.equals("memories_history.json", ignoreCase = true)) {
              val uri = DocumentsContract.buildDocumentUriUsingTree(root, id)
              val bytes = ByteArrayOutputStream()
              requireNotNull(resolver.openInputStream(uri)).use { stream ->
                val buffer = ByteArray(65536)
                while (true) {
                  check(!cancelled.get())
                  val n = stream.read(buffer)
                  if (n == -1) break
                  check(n > 0 && n <= 8 * 1024 * 1024 - bytes.size() && n <= 16 * 1024 * 1024 - metadataBytes)
                  metadataBytes += n
                  bytes.write(buffer, 0, n)
                }
              }
              item["metadataText"] = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
            }
            entries.add(item)
          }
        }
      }
    }
    return mapOf("ok" to true, "entries" to entries, "metadataBytes" to metadataBytes, "visitedEntries" to count)
  }
}
