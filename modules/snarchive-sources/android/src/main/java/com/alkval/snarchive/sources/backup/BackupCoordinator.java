package com.alkval.snarchive.sources.backup;

import com.alkval.snarchive.sources.storage.OriginalStore;
import java.io.*;
import java.util.concurrent.Executor;
import java.util.function.BooleanSupplier;

/** Backup state between the bridge and the chosen document. Provider calls (write, read-back, delete)
 * never run under the state lock, so teardown cannot wait on a slow provider. The session stays reserved,
 * and released() is not called, until cleanup has finished, so another backup cannot start meanwhile.
 * Methods return null on success or an error code. */
public final class BackupCoordinator {
  /** The document returned by this flow's Create Document request. */
  public interface Destination {
    /** close() must sync and commit the written bytes. */
    OutputStream openOutput() throws IOException;
    /** May return null when the provider cannot read the document back. */
    InputStream openInput() throws IOException;
    /** May block on the provider. */
    boolean delete() throws Exception;
  }
  public interface Opener { BackupSession open() throws IOException; }
  public interface Work { void run(BackupSession session) throws IOException; }

  private final Object lock = new Object();
  private final Executor cleanup;
  private final BooleanSupplier stop;
  private final Runnable released;
  private BackupSession session;
  private Destination destination;
  private boolean saved, keep, working, finishing, finishPending;

  public BackupCoordinator(Executor cleanup, BooleanSupplier stop, Runnable released) {
    this.cleanup = cleanup; this.stop = stop; this.released = released;
  }

  public static String code(Exception error, boolean cancelled) {
    if (cancelled) return "cancelled";
    String message = error.getMessage();
    if (message == null) return "backup-failed";
    switch (message) {
      case "busy": case "insufficient-storage": case "stored-object-corrupt": case "backup-limit":
      case "backup-cleanup-failed": case "backup-save-failed": case "backup-unverified": return message;
      default: return "backup-failed";
    }
  }

  public String begin(Opener opener) {
    synchronized (lock) {
      if (session != null || finishing) return "busy";
      try { session = opener.open(); } catch (Exception error) { return code(error, false); }
      destination = null; saved = false; keep = false; working = false; finishPending = false;
      return null;
    }
  }

  /** Short private-staging work (append, catalog, seal). */
  public String call(Work work) {
    synchronized (lock) {
      if (stop.getAsBoolean()) return "cancelled";
      if (session == null || working || finishing) return "busy";
      try { work.run(session); return null; } catch (Exception error) { return code(error, stop.getAsBoolean()); }
    }
  }

  public boolean active() { synchronized (lock) { return session != null && !finishing; } }

  public String destination(Destination chosen) {
    synchronized (lock) {
      if (session == null || working || finishing || destination != null) return "busy";
      destination = chosen; return null;
    }
  }

  /** Streams the ZIP into the destination, then reads it back. The reported code alone decides whether
   * cleanup keeps the destination: only "backup-unverified" (written, not readable back, not cancelled) does. */
  public String save(OriginalStore store) {
    BackupSession current; Destination target;
    synchronized (lock) {
      if (stop.getAsBoolean()) return "cancelled";
      if (session == null || destination == null || working || finishing) return "backup-failed";
      working = true; current = session; target = destination;
    }
    String code = null;
    try {
      BackupWriter.Written written;
      try (OutputStream output = target.openOutput()) { written = current.write(output, store, stop); }
      InputStream opened;
      try { opened = target.openInput(); } catch (IOException | RuntimeException error) { throw new IOException("backup-unverified", error); }
      if (opened == null) throw new IOException("backup-unverified");
      try (InputStream input = opened) { BackupSession.verify(input, written.sha256, written.bytes, stop); }
    } catch (Exception error) {
      // A cancel that lands while a provider read is blocked reports "cancelled", so the output is deleted.
      code = code(error, stop.getAsBoolean());
    }
    boolean finishNow;
    synchronized (lock) {
      if (code == null) saved = true; else if (code.equals("backup-unverified")) keep = true;
      working = false; finishNow = finishPending; finishPending = false;
    }
    if (finishNow) finish();
    return code;
  }

  /** Deletes an unsaved destination (unless kept as unchecked), removes staging and releases the session.
   * Provider deletion runs outside the lock. Returns "busy" if a save is still running; it then finishes itself. */
  public String finish() {
    BackupSession current; Destination target; boolean delete, wasSaved;
    synchronized (lock) {
      if (session == null) return null;
      if (working) { finishPending = true; return "busy"; }
      if (finishing) return "busy";
      finishing = true; current = session; target = destination; wasSaved = saved; delete = !saved && !keep && target != null;
    }
    String code = null;
    try {
      if (delete) {
        boolean removed;
        try { removed = target.delete(); } catch (Exception error) { removed = false; }
        if (!removed) code = "backup-partial-remains";
      }
      try { current.close(); } catch (IOException error) { if (code == null) code = wasSaved ? "backup-saved-cleanup-failed" : "backup-cleanup-failed"; }
    } finally {
      synchronized (lock) { session = null; destination = null; saved = false; keep = false; finishing = false; finishPending = false; }
      released.run();
    }
    return code;
  }

  /** For teardown: never blocks on the provider. A running save finishes cleanup itself when it returns. */
  public void finishLater() {
    synchronized (lock) {
      if (session == null || finishing) return;
      if (working) { finishPending = true; return; }
    }
    cleanup.execute(this::finish);
  }
}
