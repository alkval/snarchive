package com.alkval.snarchive.sources.storage;

import java.io.*;
import java.util.*;
import java.util.function.BooleanSupplier;
import net.lingala.zip4j.exception.ZipException;

/** One reselected export, held behind the operation gate. Paths are hints from recorded observations; only the
 * expected hash and length authorize replacement. Never changes the source or library records. */
public final class ExportRepairSession implements Closeable {
  private final ArchiveOriginals archive;
  private final FolderOriginals folder;
  private final Closeable cleanup;
  private boolean closed;
  public ExportRepairSession(ArchiveOriginals archive, Closeable cleanup) {
    this.archive = Objects.requireNonNull(archive); this.folder = null; this.cleanup = cleanup;
  }
  public ExportRepairSession(FolderOriginals folder) {
    this.folder = Objects.requireNonNull(folder); this.archive = null; this.cleanup = null;
  }
  public String archiveSha256() { return archive == null ? null : archive.sha256(); }
  public static final class Result {
    public final String outcome;
    public final boolean storeCleanupFailed;
    public final List<String> warnings;
    Result(String outcome, boolean leftover, List<String> warnings) {
      this.outcome = outcome; this.storeCleanupFailed = leftover;
      this.warnings = Collections.unmodifiableList(new ArrayList<>(warnings));
    }
  }
  /** Only fixed codes leave this class; provider exception text and private paths stay native. */
  public static String code(Exception error, boolean cancelled) {
    if (cancelled) return "cancelled";
    String message = error.getMessage();
    return message != null && Arrays.asList("cancelled", "source-changed", "source-missing", "source-unreadable",
      "insufficient-storage", "byte-limit", "storage-busy", "quarantine-failed", "repair-target-inaccessible",
      "repair-target-appeared", "thumbnail-eviction-failed", OriginalStore.STAGING_CLEANUP_FAILED,
      "staging-cleanup-failed", "backup-cleanup-failed").contains(message) ? message : "export-unreadable";
  }
  private static boolean leftover(Throwable error) {
    if (OriginalStore.STAGING_CLEANUP_FAILED.equals(error.getMessage())) return true;
    for (Throwable suppressed : error.getSuppressed()) if (leftover(suppressed)) return true;
    return false;
  }
  public Result repair(OriginalStore store, String path, String hash, long bytes, BooleanSupplier stop,
      OriginalStore.Check beforeReplace, OriginalStore.Check afterReplace) throws IOException {
    if (closed || path == null || path.length() > 1024 || hash == null || !hash.matches("[a-f0-9]{64}")
        || bytes < 0 || bytes > OriginalStore.MAX_OBJECT) throw new IOException("export-unreadable");
    if (stop.getAsBoolean()) throw new IOException("cancelled");
    try {
      OriginalStore.RepairResult result = archive != null
        ? archive.repair(path, hash, bytes, store, stop, beforeReplace)
        : folder.repair(path, hash, bytes, store, stop, beforeReplace);
      if (result.outcome == OriginalStore.Repair.ALREADY_VALID) return new Result("already_valid", false, Collections.emptyList());
      List<String> warnings = new ArrayList<>();
      if (result.warning != null) warnings.add(result.warning);
      try { afterReplace.run(); } catch (IOException | RuntimeException error) { warnings.add("thumbnail-eviction-failed"); }
      return new Result("repaired", false, warnings);
    } catch (IOException error) {
      boolean mismatch = Arrays.asList("content-mismatch", "size-mismatch", "crc-mismatch").contains(error.getMessage())
        || error instanceof ZipException && ((ZipException) error).getType() == ZipException.Type.CHECKSUM_MISMATCH;
      if (!mismatch) throw error;
      // A moved ZIP invalidates the whole session; retain any cleanup failure from the rejected candidate.
      if (archive != null) try { archive.checkUnchanged(); } catch (IOException changed) {
        for (Throwable suppressed : error.getSuppressed()) changed.addSuppressed(suppressed);
        throw changed;
      }
      return new Result("mismatch", leftover(error), Collections.emptyList());
    }
  }
  @Override public void close() throws IOException {
    if (closed) return; closed = true;
    Throwable failure = null;
    if (archive != null) try { archive.close(); } catch (IOException | RuntimeException | Error error) { failure = error; }
    if (cleanup != null) try { cleanup.close(); } catch (IOException | RuntimeException | Error error) {
      if (failure == null) failure = error; else failure.addSuppressed(error);
    }
    if (failure instanceof IOException) throw (IOException) failure;
    if (failure instanceof RuntimeException) throw (RuntimeException) failure;
    if (failure instanceof Error) throw (Error) failure;
  }
}
