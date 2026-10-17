package com.alkval.snarchive.sources

import android.net.Uri
import android.os.StatFs
import java.io.File
import java.io.FileOutputStream
import com.alkval.snarchive.sources.zip.ZipInventory
import android.provider.DocumentsContract
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean

class SnarchiveSourcesModule : Module() {
  private val busy = AtomicBoolean(false)
  private val cancelled = AtomicBoolean(false)
  override fun definition() = ModuleDefinition {
    Name("SnarchiveSources")
    Function("cancel") { cancelled.set(true) }
    AsyncFunction("scanArchive") { uriString: String ->
      if (!busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      cancelled.set(false)
      var staged: File? = null
      try {
        val context = requireNotNull(appContext.reactContext)
        val root = File(context.cacheDir, "snarchive-zip-preview")
        check(root.isDirectory || root.mkdirs())
        // One native operation at a time. Remove only this scanner's abandoned staging files.
        root.listFiles()?.filter { it.name.startsWith("preview-") && it.name.endsWith(".part") }?.forEach { check(it.delete()) }
        staged = File.createTempFile("preview-", ".part", root)
        val uri = Uri.parse(uriString)
        require(uri.scheme == "content" || uri.scheme == "file")
        var copied = 0L
        requireNotNull(context.contentResolver.openInputStream(uri)).use { input ->
          FileOutputStream(staged).use { output ->
            val buffer = ByteArray(65536)
            while (true) {
              check(!cancelled.get())
              val n = input.read(buffer)
              if (n == -1) break
              check(!cancelled.get() && n > 0 && n <= 32L * 1024 * 1024 * 1024 - copied)
              if (StatFs(root.path).availableBytes < 64L * 1024 * 1024 + n) throw IllegalStateException("insufficient-storage")
              output.write(buffer, 0, n); copied += n
            }
            output.fd.sync()
          }
        }
        ZipInventory.scan(staged) { cancelled.get() }
      } catch (error: Exception) {
        mapOf("ok" to false, "code" to if (cancelled.get()) "cancelled" else if (error.message == "insufficient-storage") "insufficient-storage" else "unsafe-or-unsupported-zip")
      } finally { staged?.delete(); busy.set(false) }
    }
    AsyncFunction("scanDirectory") { uriString: String ->
      if (!busy.compareAndSet(false, true)) return@AsyncFunction mapOf("ok" to false, "code" to "busy")
      cancelled.set(false)
      try {
        scan(Uri.parse(uriString))
      } catch (error: Exception) {
        // Do not expose provider errors or personal document paths to JS/logs.
        mapOf("ok" to false, "code" to if (cancelled.get()) "cancelled" else "unreadable-or-limit")
      } finally { busy.set(false) }
    }
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
