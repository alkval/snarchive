package com.alkval.snarchive.sources.storage;

import java.io.*;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.security.*;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.zip.CRC32;

/** Single-writer, byte-preserving storage. It does not create logical memories or import jobs. */
public final class OriginalStore {
  public static final int CHUNK = 65536;
  public static final long MAX_OBJECT = 8L * 1024 * 1024 * 1024;
  public static final long RESERVE = 64L * 1024 * 1024;
  public interface Space { long available(File directory); }
  public interface Faults { void at(String point) throws IOException; }
  public static final class Budget {
    private long remaining;
    public Budget(long bytes) { if (bytes < 0) throw new IllegalArgumentException("invalid-budget"); remaining = bytes; }
    public long remaining() { return remaining; }
  }
  public static final class Stored {
    public final String sha256, relativePath;
    public final long bytes;
    public final boolean reused;
    Stored(String hash, long bytes, boolean reused) {
      this.sha256 = hash; this.relativePath = "objects/" + hash.substring(0, 2) + "/" + hash;
      this.bytes = bytes; this.reused = reused;
    }
  }
  private final File root;
  private final Space space;
  private final Faults faults;
  public OriginalStore(File root) throws IOException { this(root, File::getUsableSpace, point -> {}); }
  public OriginalStore(File root, Space space, Faults faults) throws IOException {
    // Caller supplies the private app directory, never a path taken from an export.
    File expectedRoot = new File(root.getAbsoluteFile().getParentFile().getCanonicalFile(), root.getName());
    require(root.getCanonicalFile().equals(expectedRoot), "unsafe-storage-path");
    if (!root.isDirectory() && !root.mkdirs()) throw new IOException("storage-unavailable");
    this.root = root.getCanonicalFile(); this.space = space; this.faults = faults;
    directory("staging"); directory("objects");
  }
  private static void require(boolean ok, String code) throws IOException { if (!ok) throw new IOException(code); }
  private static FileLock acquire(RandomAccessFile file) throws IOException {
    try { FileLock lock = file.getChannel().tryLock(); require(lock != null, "storage-busy"); return lock; }
    catch (OverlappingFileLockException e) { throw new IOException("storage-busy"); }
  }
  private static void cancel(BooleanSupplier stop) throws IOException { require(!stop.getAsBoolean(), "cancelled"); }
  private File checked(String relative) throws IOException {
    File file = new File(root, relative);
    require(file.getCanonicalFile().equals(file.getAbsoluteFile()), "unsafe-storage-path"); return file;
  }
  private File directory(String relative) throws IOException {
    File file = checked(relative);
    require(file.isDirectory() || file.mkdirs(), "storage-unavailable"); return checked(relative);
  }
  private static MessageDigest digest() { try { return MessageDigest.getInstance("SHA-256"); } catch (NoSuchAlgorithmException e) { throw new AssertionError(e); } }
  private static String hex(byte[] bytes) {
    StringBuilder out = new StringBuilder(64);
    for (byte b : bytes) out.append(Character.forDigit((b >>> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
    return out.toString();
  }
  private void verifyExisting(File file, String hash, long size, BooleanSupplier stop) throws IOException {
    require(file.isFile() && file.length() == size, "stored-object-corrupt");
    MessageDigest digest = digest(); long read = 0;
    try (InputStream input = new FileInputStream(file)) {
      byte[] buffer = new byte[CHUNK];
      for (;;) {
        cancel(stop); int n = input.read(buffer); cancel(stop); if (n == -1) break;
        require(n > 0 && n <= size - read, "stored-object-corrupt"); digest.update(buffer, 0, n); read += n;
      }
    }
    require(read == size && hex(digest.digest()).equals(hash), "stored-object-corrupt");
  }

  private static final class OwnedInput extends FilterInputStream {
    private boolean closed;
    OwnedInput(InputStream input) { super(input); }
    @Override public void close() throws IOException { if (!closed) { closed = true; super.close(); } }
  }

  /** Owns and closes input, including failure paths. Negative expected size/CRC means unknown. */
  public Stored put(InputStream source, long expectedBytes, long expectedCrc, Budget budget, BooleanSupplier stop) throws IOException {
    require(source != null, "invalid-source");
    try (InputStream input = new OwnedInput(source)) {
      require(input != null && expectedBytes >= -1 && expectedCrc >= -1 && expectedCrc <= 0xffffffffL, "invalid-source");
      require(expectedBytes <= MAX_OBJECT && expectedBytes <= budget.remaining, "byte-limit");
      cancel(stop);
      // Shared by all instances/processes. Overlapping locks fail instead of racing a finalization.
      try (RandomAccessFile lockFile = new RandomAccessFile(checked("writer.lock"), "rw"); FileLock lock = acquire(lockFile)) {
        require(lock != null, "storage-busy");
        File stage = checked("staging/" + UUID.randomUUID() + ".part");
        require(stage.createNewFile(), "staging-failed");
        try {
          MessageDigest sha = digest(); CRC32 crc = new CRC32(); long count = 0;
          try (FileOutputStream output = new FileOutputStream(stage)) {
            byte[] buffer = new byte[CHUNK];
            for (;;) {
              cancel(stop); int n = input.read(buffer); cancel(stop); if (n == -1) break;
              require(n > 0, "invalid-stream");
              require(n <= MAX_OBJECT - count && n <= budget.remaining, "byte-limit");
              require(expectedBytes < 0 || n <= expectedBytes - count, "size-mismatch");
              require(space.available(root) >= RESERVE + n, "insufficient-storage");
              budget.remaining -= n; // Conservative even if the write fails after reserving bytes.
              output.write(buffer, 0, n); sha.update(buffer, 0, n); crc.update(buffer, 0, n); count += n;
              faults.at("after-chunk");
            }
            require(expectedBytes < 0 || count == expectedBytes, "size-mismatch");
            require(expectedCrc < 0 || crc.getValue() == expectedCrc, "crc-mismatch");
            output.getFD().sync();
          }
          // A source can report a close error. Do not finalize until it has closed successfully.
          input.close();
          cancel(stop);
          String hash = hex(sha.digest());
          directory("objects/" + hash.substring(0, 2));
          File target = checked("objects/" + hash.substring(0, 2) + "/" + hash);
          if (target.exists()) {
            verifyExisting(target, hash, count, stop);
            return new Stored(hash, count, true);
          }
          faults.at("before-finalize"); cancel(stop);
          // Both paths live on the same private filesystem. Never fall back to copying into target.
          require(stage.renameTo(target), "finalize-failed");
          faults.at("after-finalize");
          return new Stored(hash, count, false);
        } finally {
          if (stage.exists() && !stage.delete()) throw new IOException("staging-cleanup-failed");
        }
      }
    }
  }

  private File object(String hash, long size) throws IOException {
    require(hash != null && hash.matches("[a-f0-9]{64}") && size >= 0 && size <= MAX_OBJECT, "invalid-object");
    return checked("objects/" + hash.substring(0, 2) + "/" + hash);
  }

  /** Full SHA-256 read. Reserve for integrity checks (backup, restore, repair), not routine opens. */
  public void verify(String hash, long size, BooleanSupplier stop) throws IOException {
    verifyExisting(object(hash, size), hash, size, stop);
  }

  /** Cheap presence check. put() syncs bytes before its atomic rename, so a finalized object is
   * complete or absent; this catches lost renames and truncation, not later bit rot. */
  public File confirm(String hash, long size) throws IOException {
    File file = object(hash, size);
    require(file.isFile() && file.length() == size, "stored-object-corrupt");
    return file;
  }

  /** Removes abandoned parts only; completed objects are retained for later job reconciliation. */
  public int recoverStaging() throws IOException {
    try (RandomAccessFile lockFile = new RandomAccessFile(checked("writer.lock"), "rw"); FileLock lock = acquire(lockFile)) {
      require(lock != null, "storage-busy");
      File[] entries = directory("staging").listFiles(); require(entries != null, "storage-unavailable"); int removed = 0;
      for (File entry : entries) {
        if (!entry.getName().matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.part")) continue;
        File part = checked("staging/" + entry.getName());
        require(part.isFile() && part.delete(), "staging-cleanup-failed"); removed++;
      }
      return removed;
    }
  }
}
