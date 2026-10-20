package com.alkval.snarchive.sources.storage;

import java.io.File;
import java.io.IOException;

/** The thumbnail cache's file names for an original, so a repair can discard derivatives of damaged bytes. */
public final class ThumbnailFiles {
  public static final String DIRECTORY = "snarchive-thumbnails-v1";
  private ThumbnailFiles() {}
  /** Deletes the cached photo and video thumbnails for hash under cacheDir. Absent files are fine; a file that cannot
   * be deleted is "thumbnail-eviction-failed". The cache's in-memory index re-checks files on each hit. */
  public static void evict(File cacheDir, String hash) throws IOException {
    if (hash == null || !hash.matches("[a-f0-9]{64}")) throw new IOException("invalid-object");
    File root = new File(cacheDir, DIRECTORY);
    for (String kind : new String[] { "photo", "video" }) {
      File file = new File(root, hash + "-" + kind + ".jpg");
      if (file.exists() && !file.delete()) throw new IOException("thumbnail-eviction-failed");
    }
  }
}
