package com.alkval.snarchive.sources.storage;

import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.util.HashSet;
import java.util.Set;
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
  /** A partly written object in this store's staging could not be removed. Distinct from other temporary files. */
  public static final String STAGING_CLEANUP_FAILED = "store-staging-cleanup-failed";
  public interface Space { long available(File directory); }
  public interface Faults { void at(String point) throws IOException; }
  /** Runs after every byte was read and the source closed, before anything is finalized or reused. */
  public interface Check { void run() throws IOException; }
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
    return put(source, expectedBytes, expectedCrc, null, budget, stop);
  }

  /** As put, but when expectedSha256 is given the bytes must hash to it before anything is finalized
   * ("content-mismatch"); a restore never places unexpected bytes into the store. */
  public Stored put(InputStream source, long expectedBytes, long expectedCrc, String expectedSha256, Budget budget, BooleanSupplier stop) throws IOException {
    return put(source, expectedBytes, expectedCrc, expectedSha256, budget, stop, () -> {});
  }

  /** As put, with beforeFinalize run once the source is drained and closed, before the content hash is used: a source
   * without a CRC (a folder file) proves there that it did not change while it was read; if it throws, nothing is
   * finalized or reused, and the error (with any staging cleanup failure attached) propagates. */
  public Stored put(InputStream source, long expectedBytes, long expectedCrc, String expectedSha256, Budget budget, BooleanSupplier stop,
      Check beforeFinalize) throws IOException {
    return locked(source, expectedBytes, expectedCrc, budget, stop, (input, stage) -> {
      Staged staged = writeStage(input, stage, expectedBytes, expectedCrc, expectedSha256, budget, stop, beforeFinalize);
      String hash = staged.hash; long count = staged.count;
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
    });
  }

  private interface LockedWork<T> { T run(InputStream input, File stage) throws IOException; }
  private static final class Staged { final String hash; final long count; Staged(String hash, long count) { this.hash = hash; this.count = count; } }

  /** Owns and closes source. Holds the writer lock and one fresh staging file for the work; afterwards the staging file
   * is deleted if it is still there, and a failed delete is attached to the work's own failure, never in its place. */
  private <T> T locked(InputStream source, long expectedBytes, long expectedCrc, Budget budget, BooleanSupplier stop, LockedWork<T> work) throws IOException {
    require(source != null, "invalid-source");
    try (InputStream input = new OwnedInput(source)) {
      require(expectedBytes >= -1 && expectedCrc >= -1 && expectedCrc <= 0xffffffffL, "invalid-source");
      require(expectedBytes <= MAX_OBJECT && expectedBytes <= budget.remaining, "byte-limit");
      cancel(stop);
      // Shared by all instances/processes. Overlapping locks fail instead of racing a finalization.
      try (RandomAccessFile lockFile = new RandomAccessFile(checked("writer.lock"), "rw"); FileLock lock = acquire(lockFile)) {
        require(lock != null, "storage-busy");
        File stage = checked("staging/" + UUID.randomUUID() + ".part");
        require(stage.createNewFile(), "staging-failed");
        Throwable failure = null;
        try {
          return work.run(input, stage);
        } catch (IOException | RuntimeException | Error error) {
          failure = error; throw error;
        } finally {
          // A failed delete never replaces the reason the write stopped: it is attached to it. Only when nothing
          // else failed is the leftover part itself the error.
          if (stage.exists() && !stage.delete()) {
            IOException cleanup = new IOException(STAGING_CLEANUP_FAILED);
            if (failure != null) failure.addSuppressed(cleanup); else throw cleanup;
          }
        }
      }
    }
  }

  /** Copies input into stage under every limit, syncs it, closes input, runs beforeFinalize, and checks the result. */
  private Staged writeStage(InputStream input, File stage, long expectedBytes, long expectedCrc, String expectedSha256, Budget budget,
      BooleanSupplier stop, Check beforeFinalize) throws IOException {
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
    beforeFinalize.run();
    String hash = hex(sha.digest());
    require(expectedSha256 == null || expectedSha256.equals(hash), "content-mismatch");
    return new Staged(hash, count);
  }

  /** What a full check found for one recorded object. */
  public enum Health { VALID, MISSING, DAMAGED, UNREADABLE }

  /** The attributes of whatever is at path, without following a link; null only when the filesystem reports that
   * nothing is there (ENOENT, including a missing parent directory). Any other failure, such as a directory on the way
   * that cannot be searched or an I/O error, is "object-inaccessible": it is never mistaken for absence. */
  private static BasicFileAttributes stat(Path path) throws IOException {
    try { return Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS); }
    catch (NoSuchFileException absent) { return null; }
    catch (IOException | SecurityException unknown) { throw new IOException("object-inaccessible", unknown); }
  }

  /** Reads one recorded object in full and classifies it; never changes anything. MISSING: the filesystem reports
   * nothing at the hash path. DAMAGED: not a regular file, the wrong length, or different content. UNREADABLE: its
   * presence or content could not be determined (access or I/O error, on the file or a directory above it).
   * Cancellation throws "cancelled", checked before any verdict. */
  public Health inspect(String hash, long size, BooleanSupplier stop) throws IOException {
    cancel(stop);
    File file = object(hash, size);
    BasicFileAttributes attributes;
    try { attributes = stat(file.toPath()); } catch (IOException unknown) { return Health.UNREADABLE; }
    if (attributes == null) return Health.MISSING;
    if (!attributes.isRegularFile() || attributes.size() != size) return Health.DAMAGED;
    MessageDigest digest = digest(); long read = 0;
    try (InputStream input = new FileInputStream(file)) {
      byte[] buffer = new byte[CHUNK];
      for (;;) {
        cancel(stop); int n = input.read(buffer); cancel(stop); if (n == -1) break;
        if (n > size - read) return Health.DAMAGED; // Grew while being read.
        digest.update(buffer, 0, n); read += n;
      }
    } catch (IOException error) {
      if ("cancelled".equals(error.getMessage())) throw error;
      return Health.UNREADABLE;
    }
    return read == size && hex(digest.digest()).equals(hash) ? Health.VALID : Health.DAMAGED;
  }

  /** What a repair did. ALREADY_VALID: the current file verified, so nothing was read from the source or written. */
  public enum Repair { REPAIRED, ALREADY_VALID }
  /** A repair's outcome. warning is set only on REPAIRED, for a problem after the replacement had happened
   * ("sync-failed": a directory could not be synced); the new, verified file is then already in place. */
  public static final class RepairResult {
    public final Repair outcome; public final String warning;
    RepairResult(Repair outcome, String warning) { this.outcome = outcome; this.warning = warning; }
  }

  /** Replaces the object recorded as (hash, size) with verified bytes from source. Owns and closes source.
   * Under the writer lock:
   *  1. The current path is examined. If its presence cannot be determined, "repair-target-inaccessible" and nothing
   *     changes. A file that verifies is left exactly as it is (contents and modification time): ALREADY_VALID.
   *  2. source is staged under put's limits and must have exactly this length, CRC (when given) and SHA-256.
   *  3. beforeReplace runs (the backup's stamp check and thumbnail eviction); if it fails, nothing changes.
   *  4. An existing file is kept in quarantine/: a hard link, or a synced copy where links are refused. A failure is
   *     "quarantine-failed" (cancellation stays "cancelled"); a partial copy is removed and the target is unchanged.
   *  5. The staged file is renamed over the target (atomically), or into a missing target's place without replacing a
   *     file that appeared ("repair-target-appeared").
   *  6. The object's directory and the staging directory are synced (and any directory created on the way, with its
   *     parent). From step 5 on, the target has been replaced: a later failure is a warning on REPAIRED, never an error.
   * Interruption: until step 5 the original path is untouched; the rename leaves the old file or the new one, never
   * neither (tested by killing processes). Power loss depends on the filesystem honouring fsync of files and
   * directories, which is not tested. */
  public RepairResult repair(InputStream source, String hash, long size, long expectedCrc, BooleanSupplier stop, Check beforeReplace) throws IOException {
    File target = object(hash, size);
    // The exact length is required, so the budget only must not fire first: a longer source is size-mismatch.
    return locked(source, size, expectedCrc, new Budget(MAX_OBJECT), stop, (input, stage) -> {
      if (presence(target) != null) {
        try { verifyExisting(target, hash, size, stop); return new RepairResult(Repair.ALREADY_VALID, null); }
        catch (IOException error) { if ("cancelled".equals(error.getMessage())) throw error; } // Damaged or unreadable: replace it.
      }
      writeStage(input, stage, size, expectedCrc, hash, new Budget(MAX_OBJECT), stop, () -> {});
      cancel(stop);
      faults.at("before-replace");
      beforeReplace.run();
      File parent = directorySynced("objects/" + hash.substring(0, 2));
      if (presence(target) != null) {
        File quarantine = directorySynced("quarantine");
        File kept = checked("quarantine/" + hash + "-" + System.currentTimeMillis() + "-" + UUID.randomUUID().toString().substring(0, 8) + ".damaged");
        try { keep(target, kept, stop); } catch (IOException | RuntimeException error) {
          if (Files.exists(kept.toPath(), LinkOption.NOFOLLOW_LINKS) && !kept.delete()) error.addSuppressed(new IOException("quarantine-cleanup-failed"));
          if ("cancelled".equals(error.getMessage())) throw error;
          IOException failed = new IOException("quarantine-failed", error); for (Throwable s : error.getSuppressed()) failed.addSuppressed(s); throw failed;
        }
        syncDirectory(quarantine, "sync-quarantine");
        faults.at("after-quarantine"); cancel(stop);
        Files.move(stage.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
      } else {
        faults.at("before-fill"); cancel(stop);
        try { Files.move(stage.toPath(), target.toPath()); } // No REPLACE_EXISTING: a file that appeared is not replaced.
        catch (FileAlreadyExistsException error) { throw new IOException("repair-target-appeared", error); }
      }
      // Replaced. Nothing below may report the target as unchanged: a failure here is a warning on a completed repair.
      try {
        syncDirectory(parent, "sync-object-directory");
        syncDirectory(checked("staging"), "sync-staging-directory"); // The other side of the rename.
        faults.at("after-replace");
      } catch (IOException | RuntimeException error) { return new RepairResult(Repair.REPAIRED, "sync-failed"); }
      return new RepairResult(Repair.REPAIRED, null);
    });
  }

  /** The current file's attributes, or null when nothing is there; an undeterminable presence fails the repair before
   * anything changes. */
  private BasicFileAttributes presence(File target) throws IOException {
    try { return stat(target.toPath()); } catch (IOException unknown) { throw new IOException("repair-target-inaccessible", unknown); }
  }

  /** As directory(), and when it had to create the directory, syncs its parent so the new entry is recorded too. */
  private File directorySynced(String relative) throws IOException {
    File file = checked(relative);
    if (file.isDirectory()) return file;
    File created = directory(relative);
    syncDirectory(created.getParentFile(), "sync-new-directory");
    syncDirectory(created, "sync-new-directory");
    return created;
  }

  /** Keeps the damaged file's bytes under quarantine: a hard link where allowed, else a synced copy. Android denies apps
   * link() on their own data files (SELinux, seen on API 35), so there the copy is what runs; it needs the damaged
   * file's size in free space plus the reserve. The copy is cancellable between chunks. A file the store cannot read
   * (its permissions changed) gets owner-read for the copy only: its permissions are put back afterwards whatever
   * happens. On any failure or cancellation the partial copy is removed (a removal that fails is attached). */
  private void keep(File target, File kept, BooleanSupplier stop) throws IOException {
    faults.at("quarantine"); cancel(stop);
    try { faults.at("quarantine-link"); Files.createLink(kept.toPath(), target.toPath()); return; }
    catch (UnsupportedOperationException | IOException linkFailed) {
      if (Files.exists(kept.toPath(), LinkOption.NOFOLLOW_LINKS)) throw linkFailed instanceof IOException ? (IOException) linkFailed : new IOException(linkFailed);
    }
    faults.at("quarantine-copy"); cancel(stop);
    require(space.available(root) >= RESERVE + target.length(), "insufficient-storage");
    Path path = target.toPath(); Set<PosixFilePermission> original = null;
    if (!target.canRead()) {
      try {
        Set<PosixFilePermission> before = Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS), readable = new HashSet<>(before);
        readable.add(PosixFilePermission.OWNER_READ); Files.setPosixFilePermissions(path, readable); original = before;
      } catch (UnsupportedOperationException | IOException ignored) {} // The copy below then fails and is reported.
    }
    Throwable failure = null;
    try (InputStream in = new FileInputStream(target); FileOutputStream out = new FileOutputStream(kept)) {
      byte[] buffer = new byte[CHUNK];
      for (;;) {
        cancel(stop); int n = in.read(buffer); if (n == -1) break;
        out.write(buffer, 0, n); faults.at("quarantine-chunk");
      }
      cancel(stop);
      out.getFD().sync();
    } catch (IOException | RuntimeException error) {
      failure = error;
      if (Files.exists(kept.toPath(), LinkOption.NOFOLLOW_LINKS) && !kept.delete()) error.addSuppressed(new IOException("quarantine-cleanup-failed"));
      throw error;
    } finally {
      if (original != null) {
        try { Files.setPosixFilePermissions(path, original); }
        catch (IOException | RuntimeException restore) {
          IOException restoring = new IOException("permission-restore-failed", restore);
          if (failure != null) failure.addSuppressed(restoring); else throw restoring;
        }
      }
    }
  }

  private void syncDirectory(File directory, String point) throws IOException {
    faults.at(point);
    try (FileChannel channel = FileChannel.open(directory.toPath(), StandardOpenOption.READ)) { channel.force(true); }
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

  /** False when no object exists at the hash path; true when one exists with the expected length (its content
   * is not checked here); "stored-object-corrupt" when a file exists with the wrong length. */
  public boolean present(String hash, long size) throws IOException {
    File file = object(hash, size);
    if (!file.exists()) return false;
    require(file.isFile() && file.length() == size, "stored-object-corrupt");
    return true;
  }

  /** Removes abandoned parts only; completed objects are retained for later job reconciliation. */
  public int recoverStaging() throws IOException {
    try (RandomAccessFile lockFile = new RandomAccessFile(checked("writer.lock"), "rw"); FileLock lock = acquire(lockFile)) {
      require(lock != null, "storage-busy");
      File[] entries = directory("staging").listFiles(); require(entries != null, "storage-unavailable"); int removed = 0;
      for (File entry : entries) {
        if (!entry.getName().matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.part")) continue;
        File part = checked("staging/" + entry.getName());
        require(part.delete() || !part.exists(), STAGING_CLEANUP_FAILED); removed++; // Already gone counts as removed.
      }
      return removed;
    }
  }
}
