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
  private fun backupRoot() = File(requireNotNull(appContext.reactContext).noBackupFilesDir, "snarchive-backups")
  private var thumbnails: com.alkval.snarchive.sources.storage.ThumbnailCache? = null
  private var importArchive: ArchiveOriginals? = null
  private var importFile: File? = null
  private var importBudget: OriginalStore.Budget? = null
  private fun originals(): OriginalStore = OriginalStore(File(requireNotNull(appContext.reactContext).filesDir, "snarchive-originals"))
  override fun definition() = ModuleDefinition {
    Name("SnarchiveSources")
    Function("cancel") { cancelled.set(true) }
    OnDestroy {
      cancelled.set(true)
      synchronized(backupLock) { backupPicker?.resolve(mapOf("ok" to true, "canceled" to true)); backupPicker = null }
      backups.finishLater()
      inspections.finishLater()
    }
    AsyncFunction("recoverBackups") {
      if (importArchive != null || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      // Also removes private ZIP copies an interrupted preview, import or inspection left behind.
      try { BackupSession(backupRoot(), File::getUsableSpace).use { }; ArchiveSource.removeAbandonedCopies(previewRoot()); mapOf("ok" to true) }
      catch (error: Exception) { backupError(error) }
      finally { busy.set(false) }
    }
    AsyncFunction("beginBackup") {
      if (importArchive != null || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
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
      if (importArchive != null || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      cancelled.set(false)
      var inPlace = false
      // Read in place when the provider allows it; otherwise a bounded, cancellable private copy that is deleted on close.
      val code = inspections.begin {
        val opened = openArchive(uriString)
        inPlace = opened.second == null
        val copy = opened.second
        BackupInspection.open(opened.first, copy?.let { DeleteOnClose(it) }) { cancelled.get() }
      }
      if (code != null) return@AsyncFunction mapOf("ok" to false, "code" to code) // The gate already released the guard.
      val info = inspections.run { mapOf("ok" to true, "inPlace" to inPlace, "objects" to it.objectCount(), "objectBytes" to it.objectBytes().toDouble()) }
      info.value ?: mapOf("ok" to false, "code" to (info.code ?: "backup-unreadable"))
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
      if (importArchive != null || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
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
      if (importArchive != null || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
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
      if (importArchive != null || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      cancelled.set(false)
      try {
        require(bytes.isFinite() && bytes >= 0 && bytes <= OriginalStore.MAX_OBJECT && bytes % 1.0 == 0.0)
        val file = originals().confirm(hash, bytes.toLong())
        mapOf("ok" to true, "uri" to Uri.fromFile(file).toString())
      } catch (error: Exception) { importError(error) } finally { busy.set(false) }
    }
    AsyncFunction("originalVideo") { hash: String, bytes: Double ->
      if (importArchive != null || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
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
    AsyncFunction("scanDirectory") { uriString: String ->
      if (importArchive != null || !busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      cancelled.set(false)
      try {
        scan(Uri.parse(uriString))
      } catch (error: Exception) {
        // Do not expose provider errors or personal document paths to JS/logs.
        mapOf("ok" to false, "code" to if (cancelled.get()) "cancelled" else "unreadable-or-limit")
      } finally { busy.set(false) }
    }
  }

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
      } catch (error: Exception) { copy.first.delete(); throw error }
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
    } catch (error: Exception) { staged.delete(); throw error }
  }

  private fun scan(root: Uri): Map<String, Any> {
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
      DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE)
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
