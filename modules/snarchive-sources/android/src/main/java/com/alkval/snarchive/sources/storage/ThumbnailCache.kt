package com.alkval.snarchive.sources.storage

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.os.Build
import java.io.File
import java.io.FileOutputStream

/** Disposable derivatives only. Originals are verified on cache misses and never changed. */
class ThumbnailCache(private val files: File, private val cache: File) {
  @Synchronized fun create(hash: String, bytes: Long, video: Boolean): File {
    require(hash.matches(Regex("[a-f0-9]{64}")))
    require(bytes >= 0 && bytes <= OriginalStore.MAX_OBJECT)
    val root = File(cache, "snarchive-thumbnails-v1")
    check(root.isDirectory || root.mkdirs())
    val target = File(root, "$hash-${if (video) "video" else "photo"}.jpg")
    if (target.isFile && target.length() in 1..1048576) {
      target.setLastModified(System.currentTimeMillis()); return target
    }
    OriginalStore(File(files, "snarchive-originals")).verify(hash, bytes) { false }
    val source = File(files, "snarchive-originals/objects/${hash.take(2)}/$hash")
    var bitmap: Bitmap? = null
    try {
      bitmap = if (video) video(source) else photo(source)
      val scale = minOf(1.0, 320.0 / maxOf(bitmap.width, bitmap.height))
      if (scale < 1) {
        val resized = Bitmap.createScaledBitmap(bitmap, maxOf(1, (bitmap.width * scale).toInt()), maxOf(1, (bitmap.height * scale).toInt()), true)
        if (resized !== bitmap) bitmap.recycle()
        bitmap = resized
      }
      // Evict before writing: at most 63 existing JPEGs, under 15 MiB, plus this <=1 MiB file.
      val entries = root.listFiles().orEmpty().filter { it.name.matches(Regex("[a-f0-9]{64}-(photo|video)\\.jpg")) }.sortedBy { it.lastModified() }.toMutableList()
      var total = entries.sumOf { it.length() }
      while (entries.size >= 64 || total > 15L * 1024 * 1024) {
        val oldest = entries.removeAt(0); total -= oldest.length(); check(oldest.delete())
      }
      val part = File(root, "thumbnail.part")
      try {
        FileOutputStream(part).use { check(bitmap.compress(Bitmap.CompressFormat.JPEG, 80, it)) }
        check(part.length() in 1..1048576)
        check(part.renameTo(target))
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
}
