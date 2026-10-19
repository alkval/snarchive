package com.alkval.snarchive.sources.storage;

import java.io.*;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.function.BooleanSupplier;

/** Preserves originals from an extracted export folder, read in place through a document provider. A folder has no
 * archive hash and no CRCs, so every file is pinned within one run instead: the provider facts recorded by this
 * run's scan, then the open file's own stamp where the provider exposes a regular file. Any difference, or a length
 * other than the one pinned, is "source-changed" and nothing is finalized. Never modifies, renames or deletes a
 * source file, and never copies the folder to temporary storage.
 *
 * Per-file failures a later run can retry (source-missing, source-changed, source-unreadable) are distinct from
 * failures that stop the run (storage, cancellation, a corrupt existing original). */
public final class FolderOriginals {
  /** Provider-reported length and modification time; -1 where the provider does not report one. */
  public static final class Facts {
    public final long bytes, modified;
    public Facts(long bytes, long modified) { this.bytes = bytes; this.modified = modified; }
    /** Equal wherever both sides report a value. Unknown values cannot prove a change, or its absence. */
    boolean agrees(Facts other) {
      return (bytes < 0 || other.bytes < 0 || bytes == other.bytes) && (modified < 0 || other.modified < 0 || modified == other.modified);
    }
  }
  /** Identity of an open regular file (device, inode, size, times), re-read to detect a change while reading. */
  public interface Stamp { String read() throws IOException; }
  /** An open document. bytes is the open file's own length (fstat), or -1 for a stream such as a pipe; stamp is
   * null when the provider gives no regular file. The caller owns input. */
  public static final class Opened {
    public final InputStream input; public final long bytes; public final Stamp stamp;
    public Opened(InputStream input, long bytes, Stamp stamp) { this.input = input; this.bytes = bytes; this.stamp = stamp; }
  }
  /** Read-only access to documents in the selected tree. Implementations throw IOException with message
   * "source-missing" or "source-unreadable"; any other failure is treated as unreadable. */
  public interface Provider {
    /** Current facts, or null when the document no longer exists. */
    Facts facts(String documentId) throws IOException;
    Opened open(String documentId) throws IOException;
  }
  /** One scanned file: its document in the granted tree and the facts the scan saw. */
  public static final class Entry {
    public final String documentId; public final Facts scanned;
    public Entry(String documentId, Facts scanned) { this.documentId = documentId; this.scanned = scanned; }
  }

  public static final String MISSING = "source-missing", CHANGED = "source-changed", UNREADABLE = "source-unreadable";
  private static final String MEDIA = "(?i)\\d{4}-\\d{2}-\\d{2}_[A-Za-z0-9_-]+-(?:main\\.(?:jpg|jpeg|mp4)|overlay\\.png)";
  private final Provider provider;
  private final Map<String, Entry> entries;

  public FolderOriginals(Provider provider, Map<String, Entry> entries) {
    this.provider = provider; this.entries = Collections.unmodifiableMap(new HashMap<>(entries));
  }

  /** The length the scan saw for a path, or -1 if unknown or absent. */
  public long scannedBytes(String path) { Entry entry = entries.get(path); return entry == null ? -1 : entry.scanned.bytes; }
  /** Bytes the scan reported for these paths (unknown sizes count as zero; put still enforces actual bytes). */
  public long knownBytes(Collection<String> paths) {
    long total = 0;
    for (String path : paths) { long bytes = scannedBytes(path); if (bytes > 0) total += bytes; }
    return total;
  }

  public OriginalStore.Stored preserve(String path, OriginalStore store, OriginalStore.Budget budget, BooleanSupplier stop) throws IOException {
    String basename = path.substring(path.lastIndexOf('/') + 1);
    if (!basename.matches(MEDIA)) throw new IOException("unsupported-entry");
    Entry entry = entries.get(path);
    if (entry == null) throw new IOException(MISSING);
    Facts before = facts(entry.documentId);
    if (!before.agrees(entry.scanned)) throw new IOException(CHANGED);
    Opened opened = open(entry.documentId);
    String stamp;
    try { stamp = opened.stamp == null ? null : opened.stamp.read(); }
    catch (IOException | RuntimeException error) { closeQuietly(opened.input, error); throw unreadable(error); }
    // The open file's own length governs when there is one; a provider's report is only a hint that must not move.
    long expected = opened.bytes >= 0 ? opened.bytes : before.bytes >= 0 ? before.bytes : -1;
    Reading reading = new Reading(opened.input, opened.stamp);
    try {
      return store.put(reading, expected, -1, null, budget, stop, () -> {
        // The stamp taken at end of file, while the descriptor was still open (put closes it before this check).
        if (stamp != null && !stamp.equals(reading.endStamp())) throw new IOException(CHANGED);
        Facts after = facts(entry.documentId);
        if (!after.agrees(before)) throw new IOException(CHANGED);
      });
    } catch (IOException error) {
      // More or fewer bytes than pinned means the file was truncated, grew or was replaced while it was read.
      if ("size-mismatch".equals(error.getMessage())) throw keepSuppressed(new IOException(CHANGED, error), error);
      throw error;
    }
  }

  private Facts facts(String documentId) throws IOException {
    Facts facts;
    try { facts = provider.facts(documentId); } catch (IOException | RuntimeException error) { throw known(error); }
    if (facts == null) throw new IOException(MISSING);
    return facts;
  }
  private Opened open(String documentId) throws IOException {
    try { Opened opened = provider.open(documentId); if (opened == null || opened.input == null) throw new IOException(UNREADABLE); return opened; }
    catch (IOException | RuntimeException error) { throw known(error); }
  }
  /** Provider messages may contain private paths: only the two known codes pass through, everything else is unreadable. */
  private static IOException known(Throwable error) {
    String message = error.getMessage();
    if (MISSING.equals(message) || UNREADABLE.equals(message)) return error instanceof IOException ? (IOException) error : new IOException(message, error);
    if (error instanceof FileNotFoundException) return new IOException(MISSING, error);
    return unreadable(error);
  }
  private static IOException unreadable(Throwable error) { return new IOException(UNREADABLE, error); }
  private static IOException keepSuppressed(IOException replacement, Throwable original) {
    for (Throwable suppressed : original.getSuppressed()) replacement.addSuppressed(suppressed);
    return replacement;
  }
  private static void closeQuietly(InputStream input, Throwable error) {
    try { input.close(); } catch (IOException | RuntimeException closing) { error.addSuppressed(closing); }
  }

  /** Read and close failures from the provider become source-unreadable, without the provider's message. At the first
   * end of file it re-reads the open file's stamp, so the check before finalizing needs no open descriptor. */
  private static final class Reading extends FilterInputStream {
    private final Stamp stamp; private String end; private IOException endFailure;
    Reading(InputStream input, Stamp stamp) { super(input); this.stamp = stamp; }
    @Override public int read() throws IOException {
      int value; try { value = super.read(); } catch (IOException | RuntimeException e) { throw unreadable(e); }
      if (value == -1) atEnd(); return value;
    }
    @Override public int read(byte[] buffer, int offset, int length) throws IOException {
      int n; try { n = super.read(buffer, offset, length); } catch (IOException | RuntimeException e) { throw unreadable(e); }
      if (n == -1) atEnd(); return n;
    }
    private void atEnd() {
      if (stamp == null || end != null || endFailure != null) return;
      try { end = stamp.read(); } catch (IOException | RuntimeException e) { endFailure = new IOException(CHANGED, e); }
    }
    /** The stamp at end of file; a stream not read to its end, or a stamp that could not be read, is a change. */
    String endStamp() throws IOException {
      if (endFailure != null) throw endFailure;
      if (end == null) throw new IOException(CHANGED);
      return end;
    }
    @Override public void close() throws IOException { try { super.close(); } catch (IOException | RuntimeException e) { throw unreadable(e); } }
  }
}
