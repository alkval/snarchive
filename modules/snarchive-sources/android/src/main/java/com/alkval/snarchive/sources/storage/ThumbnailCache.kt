package com.alkval.snarchive.sources.storage

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import kotlin.math.abs
import kotlin.math.ln
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.os.Build
import java.io.File
import java.io.FileOutputStream
import java.util.regex.Pattern

/** Disposable derivatives only. Originals are confirmed present on cache misses and never changed. */
class ThumbnailCache(private val files: File, private val cache: File) {
  @Synchronized fun evict(hash: String) { ThumbnailFiles.evict(cache, hash) }
  private val root = File(cache, "snarchive-thumbnails-v1")
  private var retiredLegacy = false
  private val composedRoot = File(cache, ThumbnailFiles.COMPOSED_DIRECTORY)
  private var composedIndex: LruFileIndex? = null

  @Synchronized fun create(hash: String, bytes: Long, video: Boolean): File = composed(hash, bytes, video, "", 0)

  /** A new cache namespace makes existing previews rebuild without any re-import. Identity includes BOTH objects. */
  @Synchronized fun composed(hash: String, bytes: Long, isVideo: Boolean, layerHash: String, layerBytes: Long): File {
    require(hash.matches(Regex("[a-f0-9]{64}")) && (layerHash.isEmpty() || layerHash.matches(Regex("[a-f0-9]{64}"))))
    require(bytes in 0..OriginalStore.MAX_OBJECT && layerBytes in 0..OriginalStore.MAX_OBJECT)
    if (!retiredLegacy) { PrivateFiles.deleteTree(root); retiredLegacy = true }
    check(composedRoot.isDirectory || composedRoot.mkdirs())
    val lru = composedIndex ?: LruFileIndex(composedRoot, COMPOSED_NAME, MAX_FILES, MAX_BYTES).also { composedIndex = it }
    val name = "$hash-${layerHash.ifEmpty { "none" }}-${if (isVideo) "video" else "photo"}.jpg"
    lru.hit(name)?.let { return it }
    val store = OriginalStore(File(files, "snarchive-originals"))
    var base: Bitmap? = null
    try {
      val frame = if (isVideo) video(store.confirm(hash, bytes), 512) else Frame(photo(store.confirm(hash, bytes), 1024), true)
      base = frame.bitmap
      val scale = minOf(1.0, 512.0 / maxOf(base.width, base.height))
      val output = Bitmap.createBitmap(maxOf(1, (base.width * scale).toInt()), maxOf(1, (base.height * scale).toInt()), Bitmap.Config.ARGB_8888)
      try {
        val canvas = Canvas(output)
        val bounds = RectF(0f, 0f, output.width.toFloat(), output.height.toFloat())
        val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        canvas.drawBitmap(base, null, bounds, paint)
        if (layerHash.isNotEmpty() && frame.geometryKnown) {
          var layer: Bitmap? = null
          try {
            layer = photo(store.confirm(layerHash, layerBytes), 1024)
            val ratio = (base.width.toDouble() / base.height) / (layer.width.toDouble() / layer.height)
            if (abs(ln(ratio)) <= ln(1.01)) canvas.drawBitmap(layer, null, bounds, paint)
          } catch (_: Exception) { /* An unavailable overlay must not hide a readable base thumbnail. */ }
          finally { layer?.recycle() }
        }
        val part = File(composedRoot, "thumbnail.part")
        val target = File(composedRoot, name)
        try {
          FileOutputStream(part).use { check(output.compress(Bitmap.CompressFormat.JPEG, 92, it)) }
          check(part.length() in 1..MAX_FILE); lru.reserve(part.length())
          check(part.renameTo(target)); lru.added(name, target.length()); return target
        } finally { part.delete() }
      } finally { output.recycle() }
    } finally { base?.recycle() }
  }

  @Synchronized fun clear(): Boolean {
    val ok = PrivateFiles.deleteTree(root) and PrivateFiles.deleteTree(composedRoot)
    composedIndex = null
    return ok
  }

  private fun photo(file: File, maximum: Int = 640): Bitmap {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    require(bounds.outWidth > 0 && bounds.outHeight > 0 && bounds.outWidth.toLong() * bounds.outHeight <= 200_000_000)
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > maximum) sample *= 2
    val original = requireNotNull(BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample }))
    try {
      val orientation = ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1)
      val matrix = Matrix()
      when (orientation) {
        2 -> matrix.setScale(-1f, 1f)
        3 -> matrix.setRotate(180f)
        4 -> { matrix.setRotate(180f); matrix.postScale(-1f, 1f) }
        5 -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
        6 -> matrix.setRotate(90f)
        7 -> { matrix.setRotate(-90f); matrix.postScale(-1f, 1f) }
        8 -> matrix.setRotate(-90f)
      }
      val result = Bitmap.createBitmap(original, 0, 0, original.width, original.height, matrix, true)
      if (result !== original) original.recycle()
      return result
    } catch (error: Exception) { original.recycle(); throw error }
  }
  private data class Frame(val bitmap: Bitmap, val geometryKnown: Boolean)
  private fun video(file: File, maximum: Int): Frame {
    require(Build.VERSION.SDK_INT >= 27)
    val reader = MediaMetadataRetriever()
    try {
      reader.setDataSource(file.path)
      val width = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
      val height = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
      val rotation = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: -1
      val raw = requireNotNull(reader.getScaledFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, maximum, maximum))
      val known = width > 0 && height > 0 && rotation in setOf(0, 90, 180, 270)
      val swapped = rotation == 90 || rotation == 270
      val wanted = if (swapped) height.toDouble() / maxOf(1, width) else width.toDouble() / maxOf(1, height)
      // Frame retrieval normally applies rotation. Only correct a demonstrable axes mismatch; never guess
      // another turn for 180-degree or square frames, which would double-rotate an already oriented picture.
      val needsRotation = known && swapped && width != height && abs(ln((raw.width.toDouble() / raw.height) / wanted)) > ln(1.01)
      if (!needsRotation) return Frame(raw, known)
      try {
        val matrix = Matrix().apply { postRotate(rotation.toFloat()) }
        val turned = Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, matrix, true)
        if (turned !== raw) raw.recycle()
        return Frame(turned, true)
      } catch (error: Exception) { raw.recycle(); throw error }
    } finally { reader.release() }
  }
  private companion object {
    val NAME: Pattern = Pattern.compile("[a-f0-9]{64}-(photo|video)\\.jpg")
    val COMPOSED_NAME: Pattern = Pattern.compile("[a-f0-9]{64}-([a-f0-9]{64}|none)-(photo|video)\\.jpg")
    const val MAX_FILES = 20_000
    const val MAX_BYTES = 256L * 1024 * 1024
    const val MAX_FILE = 1024L * 1024
  }
}
