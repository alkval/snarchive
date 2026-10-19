package com.alkval.snarchive.sources.backup;

import java.io.Closeable;
import java.io.File;
import java.io.IOException;

/** Cleanup for a private temporary copy, never for the user's chosen document. An already-absent file counts as
 * deleted; a file that remains is reported as "backup-cleanup-failed" rather than left behind silently. */
public final class DeleteOnClose implements Closeable {
  private final File[] files;
  /** Null entries are skipped, so a session can pass "the private copy, if any" alongside other private files. */
  public DeleteOnClose(File... files) { this.files = files; }
  /** Tries every file, then reports a failure if any of them remains. */
  @Override public void close() throws IOException {
    boolean remains = false;
    for (File file : files) if (file != null && !file.delete() && file.exists()) remains = true;
    if (remains) throw new IOException(InspectionGate.CLEANUP_FAILED);
  }

  /** For failure paths: tries to delete the copy and, if it remains, records that on the original error as a
   * suppressed exception, so the caller learns both what failed and that a copy was left behind. */
  public static void deleteOrSuppress(File file, Throwable error) {
    try { new DeleteOnClose(file).close(); } catch (IOException cleanup) { error.addSuppressed(cleanup); }
  }
}
