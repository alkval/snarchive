package com.alkval.snarchive.sources.backup;

import java.io.Closeable;
import java.util.concurrent.Executor;

/** One read-only session at a time (backup inspection). Opening, provider reads and cleanup never run under the
 * state lock, so teardown cannot wait on a slow provider. The session stays reserved, and released() is not
 * called, until its cleanup has finished, so a retry can never share or delete an active session's files. */
public final class InspectionGate<T extends Closeable> {
  public interface Opener<T> { T open() throws Exception; }
  public interface Work<T, R> { R run(T session) throws Exception; }
  public interface Codes { String code(Exception error); }
  public static final String CLEANUP_FAILED = "backup-cleanup-failed";
  /** ArchiveSource.removeAbandonedCopies: a private copy left by an earlier operation could not be removed. */
  public static final String STAGING_CLEANUP_FAILED = "staging-cleanup-failed";
  /** OriginalStore: a partly written original in the store's staging could not be removed. */
  public static final String STORE_STAGING_CLEANUP_FAILED = "store-staging-cleanup-failed";
  /** The opening outcome: the original failure code (or null), and whether a temporary copy could not be deleted. */
  public static final class Opened {
    public final String code; public final boolean cleanupFailed;
    Opened(String code, boolean cleanupFailed) { this.code = code; this.cleanupFailed = cleanupFailed; }
  }
  private static boolean isCleanupFailure(String message) { return CLEANUP_FAILED.equals(message) || STAGING_CLEANUP_FAILED.equals(message); }
  /** True when cleanup failed on this error's path; the error's own code is reported separately. */
  public static boolean cleanupFailed(Throwable error) {
    if (isCleanupFailure(error.getMessage())) return true;
    for (Throwable suppressed : error.getSuppressed()) if (isCleanupFailure(suppressed.getMessage())) return true;
    return false;
  }
  /** True when a partly written original was left in the store's staging on this error's path. */
  public static boolean storeCleanupFailed(Throwable error) {
    if (STORE_STAGING_CLEANUP_FAILED.equals(error.getMessage())) return true;
    for (Throwable suppressed : error.getSuppressed()) if (STORE_STAGING_CLEANUP_FAILED.equals(suppressed.getMessage())) return true;
    return false;
  }
  /** The work's value, or its original failure code plus which kinds of cleanup failed alongside it. */
  public static final class Result<R> {
    public final R value; public final String code; public final boolean cleanupFailed, storeCleanupFailed;
    Result(R value, String code) { this(value, code, false, false); }
    Result(R value, String code, boolean cleanupFailed, boolean storeCleanupFailed) {
      this.value = value; this.code = code; this.cleanupFailed = cleanupFailed; this.storeCleanupFailed = storeCleanupFailed;
    }
  }

  private final Object lock = new Object();
  private final Executor cleanup;
  private final Codes codes;
  private final Runnable released;
  private T session;
  private boolean opening, working, finishing, finishPending;

  public InspectionGate(Executor cleanup, Codes codes, Runnable released) { this.cleanup = cleanup; this.codes = codes; this.released = released; }

  /** The opener owns its partial state: on failure it must have released what it opened, recording a cleanup
   * failure as a suppressed exception (see DeleteOnClose.deleteOrSuppress). */
  public Opened beginWithStatus(Opener<T> opener) {
    synchronized (lock) {
      if (session != null || opening || finishing) return new Opened("busy", false);
      opening = true; finishPending = false;
    }
    T opened = null; String code = null; boolean cleanupFailed = false;
    try { opened = opener.open(); } catch (Exception error) { code = codes.code(error); cleanupFailed = cleanupFailed(error); }
    boolean abandon;
    synchronized (lock) {
      opening = false;
      if (code == null) session = opened;
      abandon = code == null && finishPending;
    }
    if (code != null) { released.run(); return new Opened(code, cleanupFailed); }
    if (abandon) return new Opened("cancelled", finish() != null); // Torn down while opening.
    return new Opened(null, false);
  }

  public String begin(Opener<T> opener) { return beginWithStatus(opener).code; }

  public <R> Result<R> run(Work<T, R> work) {
    T current;
    synchronized (lock) {
      if (session == null || finishing) return new Result<>(null, "cancelled");
      if (working || opening) return new Result<>(null, "busy");
      working = true; current = session;
    }
    R value = null; String code = null; boolean cleanup = false, storeCleanup = false;
    try { value = work.run(current); }
    catch (Exception error) { code = codes.code(error); cleanup = cleanupFailed(error); storeCleanup = storeCleanupFailed(error); }
    boolean finishNow;
    synchronized (lock) { working = false; finishNow = finishPending; finishPending = false; }
    if (finishNow) finish();
    return new Result<>(value, code, cleanup, storeCleanup);
  }

  public boolean active() { synchronized (lock) { return session != null && !finishing; } }

  /** Closes the session outside the lock. Returns "busy" if work is running; that work then finishes it. */
  public String finish() {
    T current;
    synchronized (lock) {
      if (opening || working) { finishPending = true; return "busy"; }
      if (session == null || finishing) return null;
      finishing = true; current = session;
    }
    String code = null;
    try { current.close(); } catch (Exception error) { code = CLEANUP_FAILED; }
    finally {
      synchronized (lock) { session = null; finishing = false; finishPending = false; }
      released.run();
    }
    return code;
  }

  /** For teardown: never blocks. Running work or an open in progress finishes the session when it returns. */
  public void finishLater() {
    synchronized (lock) {
      if (opening || working) { finishPending = true; return; }
      if (session == null || finishing) return;
    }
    cleanup.execute(this::finish);
  }
}
