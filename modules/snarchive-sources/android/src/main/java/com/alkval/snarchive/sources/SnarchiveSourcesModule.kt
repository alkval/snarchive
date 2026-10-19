package com.alkval.snarchive.sources

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
  private var thumbnails: com.alkval.snarchive.sources.storage.ThumbnailCache? = null
  private val busy = AtomicBoolean(false)
  private val cancelled = AtomicBoolean(false)
  private var importArchive: ArchiveOriginals? = null
  private var importFile: File? = null
  private var importBudget: OriginalStore.Budget? = null
  private fun originals(): OriginalStore = OriginalStore(File(requireNotNull(appContext.reactContext).filesDir, "snarchive-originals"))
  override fun definition() = ModuleDefinition {
    Name("SnarchiveSources")
    Function("cancel") { cancelled.set(true) }
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
    openInPlace(uri)?.let { return it to null }
    val copy = stageArchive(uri)
    try {
      return ArchiveSource.open(copy.first).also { source ->
        try { source.pinCopy(copy.second) } catch (error: Exception) { runCatching { source.close() }; throw error }
      } to copy.first
    } catch (error: Exception) { copy.first.delete(); throw error }
  }

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
    val root = File(context.cacheDir, "snarchive-zip-preview")
    check(root.isDirectory || root.mkdirs())
    root.listFiles()?.filter { it.name.startsWith("preview-") && it.name.endsWith(".part") }?.forEach { check(it.delete()) }
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
