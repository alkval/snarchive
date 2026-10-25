package com.alkval.snarchive.sources.storage;

import java.io.File;
import java.io.IOException;

/** The thumbnail cache's file names for an original, so a repair can discard derivatives of damaged bytes. */
public final class ThumbnailFiles {
  public static final String DIRECTORY = "snarchive-thumbnails-v1";
  public static final String COMPOSED_DIRECTORY = "snarchive-thumbnails-v2";
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
    File composed = new File(cacheDir, COMPOSED_DIRECTORY);
    String[] names = composed.list();
    if (names == null) { if (composed.exists()) throw new IOException("thumbnail-eviction-failed"); return; }
    for (String name : names) {
      if (!name.matches("[a-f0-9]{64}-([a-f0-9]{64}|none)-(photo|video)\\.jpg")) continue;
      if (!name.startsWith(hash + "-") && !name.substring(65).startsWith(hash + "-")) continue;
      File file = new File(composed, name);
      if (!file.delete() && file.exists()) throw new IOException("thumbnail-eviction-failed");
    }
  }
}
