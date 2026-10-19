package com.alkval.snarchive.sources.backup;

import com.alkval.snarchive.sources.storage.OriginalStore;
import java.io.*;
import java.nio.channels.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;
import java.util.function.BooleanSupplier;

/** Owns private backup staging. A file lock prevents startup cleanup touching a live writer. */
public final class BackupSession implements Closeable {
  private final File root, manifest, catalog;
  private final RandomAccessFile lockFile;
  private final FileLock lock;
  private final OriginalStore.Space space;
  private FileOutputStream manifestOut, catalogOut;
  private File archive;
  private long manifestBytes, objectBytes;
  private int objectCount;
  private boolean sealed, closed;
  public BackupSession(File directory, OriginalStore.Space space) throws IOException {
    File expected = new File(directory.getAbsoluteFile().getParentFile().getCanonicalFile(), directory.getName());
    require(directory.getCanonicalFile().equals(expected), "unsafe-storage-path");
    require(directory.isDirectory() || directory.mkdirs(), "storage-unavailable");
    root = directory.getCanonicalFile(); this.space = space;
    lockFile = new RandomAccessFile(new File(root, "session.lock"), "rw");
    FileLock acquired = null;
    try { acquired = lockFile.getChannel().tryLock(); } catch (OverlappingFileLockException ignored) {} catch (IOException e) { lockFile.close(); throw e; }
    if (acquired == null) { lockFile.close(); throw new IOException("busy"); }
    lock = acquired; manifest = new File(root, "manifest.part"); catalog = new File(root, "catalog.part");
    try {
      cleanup();
      manifestOut = new FileOutputStream(manifest); catalogOut = new FileOutputStream(catalog);
    } catch (IOException e) { try { close(); } catch (IOException ignored) {} throw e; }
  }
  private static void require(boolean ok, String code) throws IOException { if (!ok) throw new IOException(code); }
  private void writable() throws IOException { require(!closed && !sealed, "backup-state"); }
  private void space() throws IOException { require(space.available(root) >= OriginalStore.RESERVE + 262144, "insufficient-storage"); }
  public void append(String chunk) throws IOException {
    writable(); require(chunk.length() <= 65536, "backup-limit");
    byte[] bytes = chunk.getBytes(StandardCharsets.UTF_8);
    require(bytes.length <= BackupWriter.MAX_MANIFEST - manifestBytes, "backup-limit");
    space(); manifestOut.write(bytes); manifestBytes += bytes.length;
  }
  public void object(String hash, long bytes) throws IOException {
    writable(); require(hash != null && hash.matches("[a-f0-9]{64}") && bytes >= 0 && bytes <= OriginalStore.MAX_OBJECT, "invalid-backup-object");
    require(objectCount < 100000 && bytes <= BackupWriter.MAX_TOTAL - objectBytes, "backup-limit");
    space(); catalogOut.write((hash + " " + bytes + "\n").getBytes(StandardCharsets.UTF_8)); objectCount++; objectBytes += bytes;
  }
  public void build(OriginalStore store, BooleanSupplier stop) throws IOException {
    writable(); sealed = true;
    manifestOut.getFD().sync(); manifestOut.close(); manifestOut = null;
    catalogOut.getFD().sync(); catalogOut.close(); catalogOut = null;
    try (BufferedReader reader = new BufferedReader(new InputStreamReader(new FileInputStream(catalog), StandardCharsets.UTF_8))) {
      // The catalog was generated above, never supplied by an archive or user-selected path.
      Iterable<BackupWriter.ObjectSpec> objects = () -> new Iterator<BackupWriter.ObjectSpec>() {
        String next; boolean loaded;
        public boolean hasNext() {
          if (!loaded) { try { next = reader.readLine(); loaded = true; } catch (IOException e) { throw new UncheckedIOException(e); } }
          return next != null;
        }
        public BackupWriter.ObjectSpec next() {
          if (!hasNext()) throw new NoSuchElementException();
          String[] fields = next.split(" "); loaded = false;
          return new BackupWriter.ObjectSpec(fields[0], Long.parseLong(fields[1]));
        }
      };
      archive = BackupWriter.write(store, manifest, objects, root, space, stop);
    } catch (UncheckedIOException e) { throw e.getCause(); }
  }
  /** Copies a completed private ZIP, returning its SHA-256 for destination read-back verification.
   * The caller owns the destination stream and must close it before opening it for verification. */
  public String copy(OutputStream output, BooleanSupplier stop) throws IOException {
    require(!closed && archive != null, "backup-state");
    MessageDigest digest = digest(); byte[] buffer = new byte[65536];
    try (InputStream input = new FileInputStream(archive)) {
      int n; while (true) {
        require(!stop.getAsBoolean(), "cancelled"); n = input.read(buffer); if (n == -1) break;
        output.write(buffer, 0, n); digest.update(buffer, 0, n);
      }
    }
    require(!stop.getAsBoolean(), "cancelled"); output.flush(); return hex(digest.digest());
  }
  public long size() throws IOException { require(!closed && archive != null, "backup-state"); return archive.length(); }
  public static void verify(InputStream input, String expected, long bytes, BooleanSupplier stop) throws IOException {
    MessageDigest digest = digest(); byte[] buffer = new byte[65536]; int n; long read = 0;
    while (true) { require(!stop.getAsBoolean(), "cancelled"); n = input.read(buffer); if (n == -1) break; require(n > 0 && n <= bytes - read, "backup-save-failed"); digest.update(buffer, 0, n); read += n; }
    require(!stop.getAsBoolean(), "cancelled");
    require(read == bytes && expected.equals(hex(digest.digest())), "backup-save-failed");
  }
  private static MessageDigest digest() { try { return MessageDigest.getInstance("SHA-256"); } catch (NoSuchAlgorithmException e) { throw new AssertionError(e); } }
  private static String hex(byte[] bytes) { StringBuilder value = new StringBuilder(); for (byte b : bytes) value.append(Character.forDigit((b >>> 4) & 15, 16)).append(Character.forDigit(b & 15, 16)); return value.toString(); }
  private void cleanup() throws IOException {
    File[] files = root.listFiles(); require(files != null, "backup-cleanup-failed");
    for (File file : files) {
      String name = file.getName();
      if (name.equals("manifest.part") || name.equals("catalog.part") || name.matches("backup-[0-9]+\\.part")) require(file.delete(), "backup-cleanup-failed");
    }
  }
  @Override public void close() throws IOException {
    if (closed) return; closed = true;
    try {
      try { if (manifestOut != null) manifestOut.close(); } finally { if (catalogOut != null) catalogOut.close(); }
      cleanup();
    } finally { try { lock.release(); } finally { lockFile.close(); } }
  }
}
