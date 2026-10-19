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
  public static final class Result<R> {
    public final R value; public final String code;
    Result(R value, String code) { this.value = value; this.code = code; }
  }

  private final Object lock = new Object();
  private final Executor cleanup;
  private final Codes codes;
  private final Runnable released;
  private T session;
  private boolean opening, working, finishing, finishPending;

  public InspectionGate(Executor cleanup, Codes codes, Runnable released) { this.cleanup = cleanup; this.codes = codes; this.released = released; }

  /** The opener owns its partial state: on failure it must have released what it opened. */
  public String begin(Opener<T> opener) {
    synchronized (lock) {
      if (session != null || opening || finishing) return "busy";
      opening = true; finishPending = false;
    }
    T opened = null; String code = null;
    try { opened = opener.open(); } catch (Exception error) { code = codes.code(error); }
    boolean abandon;
    synchronized (lock) {
      opening = false;
      if (code == null) session = opened;
      abandon = code == null && finishPending;
    }
    if (code != null) { released.run(); return code; }
    if (abandon) { finish(); return "cancelled"; } // Torn down while opening.
    return null;
  }

  public <R> Result<R> run(Work<T, R> work) {
    T current;
    synchronized (lock) {
      if (session == null || finishing) return new Result<>(null, "cancelled");
      if (working || opening) return new Result<>(null, "busy");
      working = true; current = session;
    }
    R value = null; String code = null;
    try { value = work.run(current); } catch (Exception error) { code = codes.code(error); }
    boolean finishNow;
    synchronized (lock) { working = false; finishNow = finishPending; finishPending = false; }
    if (finishNow) finish();
    return new Result<>(value, code);
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
    try { current.close(); } catch (Exception error) { code = "backup-cleanup-failed"; }
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
