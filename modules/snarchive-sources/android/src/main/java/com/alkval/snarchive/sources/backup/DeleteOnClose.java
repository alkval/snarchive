package com.alkval.snarchive.sources.backup;

import java.io.Closeable;
import java.io.File;
import java.io.IOException;

/** Cleanup for a private temporary copy, never for the user's chosen document. An already-absent file counts as
 * deleted; a file that remains is reported as "backup-cleanup-failed" rather than left behind silently. */
public final class DeleteOnClose implements Closeable {
  private final File file;
  public DeleteOnClose(File file) { this.file = file; }
  @Override public void close() throws IOException {
    if (!file.delete() && file.exists()) throw new IOException(InspectionGate.CLEANUP_FAILED);
  }

  /** For failure paths: tries to delete the copy and, if it remains, records that on the original error as a
   * suppressed exception, so the caller learns both what failed and that a copy was left behind. */
  public static void deleteOrSuppress(File file, Throwable error) {
    try { new DeleteOnClose(file).close(); } catch (IOException cleanup) { error.addSuppressed(cleanup); }
  }
}
