package com.alkval.snarchive.sources.storage

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.os.Build
import java.io.File
import java.io.FileOutputStream
import java.util.regex.Pattern

/** Disposable derivatives only. Originals are confirmed present on cache misses and never changed. */
class ThumbnailCache(private val files: File, private val cache: File) {
  private val root = File(cache, "snarchive-thumbnails-v1")
  private var index: LruFileIndex? = null

  @Synchronized fun create(hash: String, bytes: Long, video: Boolean): File {
    require(hash.matches(Regex("[a-f0-9]{64}")))
    require(bytes >= 0 && bytes <= OriginalStore.MAX_OBJECT)
    check(root.isDirectory || root.mkdirs())
    // Sized to keep a whole library's grid cached: ~8,000 memories at 20-30 KiB per 320px JPEG
    // is about 200 MiB. The OS may still clear cacheDir; everything here is rebuildable.
    val lru = index ?: LruFileIndex(root, NAME, MAX_FILES, MAX_BYTES).also { index = it }
    val name = "$hash-${if (video) "video" else "photo"}.jpg"
    lru.hit(name)?.let { return it }
    // Presence and length only. Decoding detects unreadable media; a full rehash per miss
    // made scrolling a large library re-read gigabytes of originals.
    val source = OriginalStore(File(files, "snarchive-originals")).confirm(hash, bytes)
    var bitmap: Bitmap? = null
    try {
      bitmap = if (video) video(source) else photo(source)
      val scale = minOf(1.0, 320.0 / maxOf(bitmap.width, bitmap.height))
      if (scale < 1) {
        val resized = Bitmap.createScaledBitmap(bitmap, maxOf(1, (bitmap.width * scale).toInt()), maxOf(1, (bitmap.height * scale).toInt()), true)
        if (resized !== bitmap) bitmap.recycle()
        bitmap = resized
      }
      val part = File(root, "thumbnail.part")
      val target = File(root, name)
      try {
        FileOutputStream(part).use { check(bitmap.compress(Bitmap.CompressFormat.JPEG, 80, it)) }
        check(part.length() in 1..MAX_FILE)
        lru.reserve(part.length())
        check(part.renameTo(target))
        lru.added(name, target.length())
      } finally { part.delete() }
      return target
    } finally { bitmap?.recycle() }
  }
  private fun photo(file: File): Bitmap {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    require(bounds.outWidth > 0 && bounds.outHeight > 0 && bounds.outWidth.toLong() * bounds.outHeight <= 200_000_000)
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 640) sample *= 2
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
  private fun video(file: File): Bitmap {
    require(Build.VERSION.SDK_INT >= 27) // Older devices retain a video placeholder; never decode a full-size frame.
    val reader = MediaMetadataRetriever()
    try {
      reader.setDataSource(file.path)
      return requireNotNull(reader.getScaledFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 320, 320))
    } finally { reader.release() }
  }
  private companion object {
    val NAME: Pattern = Pattern.compile("[a-f0-9]{64}-(photo|video)\\.jpg")
    const val MAX_FILES = 20_000
    const val MAX_BYTES = 256L * 1024 * 1024
    const val MAX_FILE = 1024L * 1024
  }
}
