package com.alkval.snarchive.sources.backup;

import com.alkval.snarchive.sources.storage.OriginalStore;
import java.io.*;
import java.security.*;
import java.util.*;
import java.util.function.BooleanSupplier;
import java.util.zip.*;

/** Streams a trusted, staged manifest and its catalog as a ZIP into a caller-owned output, such as
 * the user's chosen document. No private copy of the ZIP is made and no source files change.
 * The manifest and catalog must come from the same successful database snapshot. */
public final class BackupWriter {
  public static final long MAX_MANIFEST = 128L * 1024 * 1024;
  public static final long MAX_TOTAL = 64L * 1024 * 1024 * 1024;
  public static final class ObjectSpec {
    public final String sha256;
    public final long bytes;
    public ObjectSpec(String hash, long bytes) { this.sha256 = hash; this.bytes = bytes; }
  }
  /** Hash and length of exactly the bytes handed to the output, for destination read-back. */
  public static final class Written {
    public final String sha256;
    public final long bytes;
    Written(String hash, long bytes) { this.sha256 = hash; this.bytes = bytes; }
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
  /** Hashes and counts what reaches the destination. Never closes it; once failed, discards further
   * bytes so closing the ZIP stream cannot append a central directory to a partial backup. */
  private static final class Tracked extends FilterOutputStream {
    final MessageDigest digest = digest(); long count; boolean open = true;
    Tracked(OutputStream out) { super(out); }
    @Override public void write(int b) throws IOException { write(new byte[] { (byte)b }, 0, 1); }
    @Override public void write(byte[] b, int off, int len) throws IOException {
      if (!open) return;
      out.write(b, off, len); digest.update(b, off, len); count += len;
    }
    @Override public void close() throws IOException { if (open) flush(); }
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
  /** Writes the complete ZIP to output and flushes it; the caller syncs, closes and verifies the destination,
   * and deletes it on failure. reserveDir is on the device's data partition: writing stops before it would
   * fall under the reserve, since local destinations usually share that partition. */
  public static Written write(OriginalStore store, File manifest, Iterable<ObjectSpec> objects, OutputStream output,
      File reserveDir, OriginalStore.Space space, BooleanSupplier stop) throws IOException {
    require(manifest.isFile() && manifest.length() > 0 && manifest.length() <= MAX_MANIFEST, "invalid-backup-manifest");
    cancel(stop); space(reserveDir, space);
    Tracked tracked = new Tracked(output); boolean complete = false;
    ZipOutputStream zip = new ZipOutputStream(tracked);
    try {
      zip.setLevel(0); // Originals are already compressed; preserve bytes without recompression work.
      entry(zip, manifest, "manifest.jsonl", manifest.length(), null, reserveDir, space, stop);
      Set<String> seen = new HashSet<>(); long total = 0;
      for (ObjectSpec object : objects) {
        cancel(stop);
        require(object != null && object.sha256 != null && object.sha256.matches("[a-f0-9]{64}") && object.bytes >= 0 && object.bytes <= OriginalStore.MAX_OBJECT, "invalid-backup-object");
        require(seen.add(object.sha256) && seen.size() <= 100_000 && object.bytes <= MAX_TOTAL - total, "backup-limit");
        total += object.bytes;
        File original = store.confirm(object.sha256, object.bytes);
        entry(zip, original, "objects/" + object.sha256.substring(0, 2) + "/" + object.sha256, object.bytes, object.sha256, reserveDir, space, stop);
      }
      cancel(stop); zip.finish(); tracked.flush(); complete = true;
      return new Written(hex(tracked.digest.digest()), tracked.count);
    } finally {
      if (!complete) tracked.open = false;
      // Releases the deflater. After a failure the gate discards finish()'s central directory, and a close
      // error never replaces the original cause.
      try { zip.close(); } catch (IOException error) { if (complete) throw error; }
    }
  }
}
