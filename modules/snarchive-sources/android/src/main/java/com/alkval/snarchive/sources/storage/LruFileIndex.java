package com.alkval.snarchive.sources.storage;

import java.io.File;
import java.io.IOException;
import java.util.*;
import java.util.regex.Pattern;

/** Least-recently-used accounting for one directory of disposable files.
 * The directory is listed once; later hits and inserts cost O(1) instead of a full rescan.
 * Files removed by the OS (cache clearing) are dropped from the index when next touched.
 */
public final class LruFileIndex {
  private final File root;
  private final Pattern names;
  private final int maxFiles;
  private final long maxBytes;
  private final LinkedHashMap<String, Long> sizes = new LinkedHashMap<>(16, 0.75f, true);
  private long total;

  public LruFileIndex(File root, Pattern names, int maxFiles, long maxBytes) {
    if (maxFiles < 1 || maxBytes < 1) throw new IllegalArgumentException("invalid-limits");
    this.root = root; this.names = names; this.maxFiles = maxFiles; this.maxBytes = maxBytes;
    File[] entries = root.listFiles();
    if (entries == null) return;
    Arrays.sort(entries, Comparator.comparingLong(File::lastModified));
    for (File entry : entries) {
      if (entry.isFile() && names.matcher(entry.getName()).matches()) { sizes.put(entry.getName(), entry.length()); total += entry.length(); }
    }
  }

  public int count() { return sizes.size(); }
  public long bytes() { return total; }

  /** Returns the cached file and marks it recently used, or null when absent. */
  public File hit(String name) {
    Long size = sizes.get(name);
    if (size == null) return null;
    File file = new File(root, name);
    if (!file.isFile() || file.length() != size) { sizes.remove(name); total -= size; return null; }
    file.setLastModified(System.currentTimeMillis()); // Keeps order across process restarts.
    return file;
  }

  /** Evicts least-recently-used files until one more file of this size fits. */
  public void reserve(long size) throws IOException {
    if (size < 0 || size > maxBytes) throw new IOException("cache-entry-too-large");
    Iterator<Map.Entry<String, Long>> oldest = sizes.entrySet().iterator();
    while (oldest.hasNext() && (sizes.size() >= maxFiles || total + size > maxBytes)) {
      Map.Entry<String, Long> entry = oldest.next();
      File file = new File(root, entry.getKey());
      if (file.exists() && !file.delete()) throw new IOException("cache-eviction-failed");
      total -= entry.getValue(); oldest.remove();
    }
  }

  /** Records a file that was just renamed into place. Call reserve() first. */
  public void added(String name, long size) {
    if (!names.matcher(name).matches()) throw new IllegalArgumentException("invalid-name");
    Long previous = sizes.put(name, size);
    total += size - (previous == null ? 0 : previous);
  }
}
