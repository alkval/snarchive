package com.alkval.snarchive.sources.backup;

import com.alkval.snarchive.sources.storage.OriginalStore;
import java.io.*;
import java.security.*;
import java.util.*;
import java.util.function.BooleanSupplier;
import java.util.zip.*;

/** Streams a trusted, staged manifest and its catalog into a private ZIP. No source files change.
 * Caller serializes backup operations and deletes abandoned staging after process interruption.
 * The manifest and catalog must come from the same successful database snapshot. */
public final class BackupWriter {
  public static final long MAX_MANIFEST = 128L * 1024 * 1024;
  public static final long MAX_TOTAL = 64L * 1024 * 1024 * 1024;
  public static final class ObjectSpec {
    public final String sha256;
    public final long bytes;
    public ObjectSpec(String hash, long bytes) { this.sha256 = hash; this.bytes = bytes; }
  }
  private static void require(boolean ok, String code) throws IOException { if (!ok) throw new IOException(code); }
  private static void cancel(BooleanSupplier stop) throws IOException { require(!stop.getAsBoolean(), "cancelled"); }
  private static MessageDigest digest() {
    try { return MessageDigest.getInstance("SHA-256"); } catch (NoSuchAlgorithmException e) { throw new AssertionError(e); }
  }
  private static String hex(byte[] bytes) {
    StringBuilder out = new StringBuilder(64);
    for (byte b : bytes) out.append(Character.forDigit((b >>> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
    return out.toString();
  }
  private static void space(File directory, OriginalStore.Space space) throws IOException {
    require(space.available(directory) >= OriginalStore.RESERVE + OriginalStore.CHUNK, "insufficient-storage");
  }
  private static void entry(ZipOutputStream zip, File source, String name, long expected, String hash,
      File directory, OriginalStore.Space space, BooleanSupplier stop) throws IOException {
    cancel(stop); ZipEntry entry = new ZipEntry(name); entry.setTime(0); zip.putNextEntry(entry);
    MessageDigest digest = digest(); long copied = 0; byte[] buffer = new byte[OriginalStore.CHUNK];
    try (InputStream input = new FileInputStream(source)) {
      for (;;) {
        cancel(stop); int n = input.read(buffer); cancel(stop); if (n == -1) break;
        require(n > 0 && n <= expected - copied, "backup-source-changed");
        space(directory, space); zip.write(buffer, 0, n); digest.update(buffer, 0, n); copied += n;
      }
    }
    require(copied == expected && (hash == null || hash.equals(hex(digest.digest()))), "stored-object-corrupt");
    zip.closeEntry();
  }
  /** Returns a completed private temporary file only after ZIP completion and fsync. The caller
   * owns the returned file. Every ordinary failure removes the incomplete output. */
  public static File write(OriginalStore store, File manifest, Iterable<ObjectSpec> objects, File directory,
      OriginalStore.Space space, BooleanSupplier stop) throws IOException {
    require(manifest.isFile() && manifest.length() > 0 && manifest.length() <= MAX_MANIFEST, "invalid-backup-manifest");
    require(directory.isDirectory() || directory.mkdirs(), "storage-unavailable");
    cancel(stop); space(directory, space);
    File output = File.createTempFile("backup-", ".part", directory); boolean complete = false;
    try {
      try (FileOutputStream file = new FileOutputStream(output); ZipOutputStream zip = new ZipOutputStream(file)) {
        zip.setLevel(0); // Originals are already compressed; preserve bytes without recompression work.
        entry(zip, manifest, "manifest.jsonl", manifest.length(), null, directory, space, stop);
        Set<String> seen = new HashSet<>(); long total = 0;
        for (ObjectSpec object : objects) {
          cancel(stop);
          require(object != null && object.sha256 != null && object.sha256.matches("[a-f0-9]{64}") && object.bytes >= 0 && object.bytes <= OriginalStore.MAX_OBJECT, "invalid-backup-object");
          require(seen.add(object.sha256) && seen.size() <= 100_000 && object.bytes <= MAX_TOTAL - total, "backup-limit");
          total += object.bytes;
          File original = store.confirm(object.sha256, object.bytes);
          entry(zip, original, "objects/" + object.sha256.substring(0, 2) + "/" + object.sha256, object.bytes, object.sha256, directory, space, stop);
        }
        cancel(stop); space(directory, space); zip.finish(); file.getFD().sync();
      }
      cancel(stop); complete = true; return output;
    } finally { if (!complete) require(!output.exists() || output.delete(), "backup-cleanup-failed"); }
  }
}
