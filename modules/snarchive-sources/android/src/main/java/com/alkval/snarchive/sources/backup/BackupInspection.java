package com.alkval.snarchive.sources.backup;

import com.alkval.snarchive.sources.storage.OriginalStore;
import com.alkval.snarchive.sources.zip.ArchiveSource;
import com.alkval.snarchive.sources.zip.ZipInventory;
import java.io.*;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.*;
import java.util.function.BooleanSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.CRC32;
import net.lingala.zip4j.exception.ZipException;
import net.lingala.zip4j.model.FileHeader;

/** Inspection of an untrusted portable backup (formats 1 and 2). Inspection never writes the library, the originals
 * store or the selected document; restore and repair modes write only the originals store. The ZIP is validated with the import engine's structural rules and the v1
 * layout; the manifest is handed out as strictly decoded UTF-8 text in bounded chunks for the JS validator;
 * every declared object is then streamed and checked for exact length, ZIP CRC and SHA-256. */
public final class BackupInspection implements Closeable {
  public static final String MANIFEST = "manifest.jsonl";
  public static final int MAX_OBJECTS = 100_000;
  /** One manifest plus the object catalog; objects up to the store's limit; catalog total plus the manifest. */
  public static final ZipInventory.Limits LIMITS = new ZipInventory.Limits(MAX_OBJECTS + 1, OriginalStore.MAX_OBJECT, BackupWriter.MAX_TOTAL + BackupWriter.MAX_MANIFEST);
  public static final int MAX_CHUNK = 256 * 1024;
  private static final Pattern OBJECT = Pattern.compile("objects/([a-f0-9]{2})/([a-f0-9]{64})");
  private static final Set<String> CODES = new HashSet<>(Arrays.asList("unsafe-or-unsupported-zip", "backup-not-snarchive",
    "backup-invalid", "backup-damaged", "backup-limit", "source-changed", "insufficient-storage", "busy", "backup-cleanup-failed",
    // A leftover private copy from an earlier operation could not be removed, so the chosen backup was never opened.
    "staging-cleanup-failed",
    // Restore: a local original of the wrong length or content; the store is left unchanged.
    "stored-object-corrupt",
    // Restore: a partly written original in the store's staging could not be removed (see OriginalStore).
    OriginalStore.STAGING_CLEANUP_FAILED,
    // Repair (section 22): a damaged original could not be kept in quarantine, a missing one reappeared before the
    // repair finished, or a cached thumbnail could not be discarded. The original is unchanged in each case.
    "quarantine-failed", "repair-target-appeared", "repair-target-inaccessible", "thumbnail-eviction-failed", "storage-busy"));

  public static final class Chunk {
    public final String text; public final boolean done;
    Chunk(String text, boolean done) { this.text = text; this.done = done; }
  }
  public static final class Progress {
    public final int verified, total; public final long bytes, totalBytes; public final boolean done;
    Progress(int verified, int total, long bytes, long totalBytes) { this.verified = verified; this.total = total; this.bytes = bytes; this.totalBytes = totalBytes; this.done = verified == total; }
  }

  private final ArchiveSource source;
  private final Closeable cleanup;
  private final FileHeader manifest;
  private final Map<String, FileHeader> objects;
  private final long objectBytes;
  private final Map<String, Long> declared = new HashMap<>();
  private boolean sealed, manifestDone, closed;
  private TextChunks manifestText;
  private List<String> order;
  private int verified;
  private long verifiedBytes;
  // Restore mode: the manifest bytes read in pass 1 are teed to a private file and hashed, objects are stored,
  // and the staged copy is read again (hash-checked) for the merge.
  private File stagedManifest;
  private OutputStream stagedOut;
  private MessageDigest stagedDigest;
  private String manifestSha256;
  private TextChunks stagedText;
  private MessageDigest stagedCheck;
  private long stagedCount;
  private int stored, added, reused;
  private long storedBytes;

  private static void require(boolean ok, String code) throws IOException { if (!ok) throw new IOException(code); }
  private static void cancel(BooleanSupplier stop) throws IOException { require(!stop.getAsBoolean(), "cancelled"); }
  /** Safe, fixed codes only: provider messages, paths and payloads never leave this class. */
  public static String code(Exception error, boolean cancelled) {
    if (cancelled) return "cancelled";
    if (error instanceof ZipException && ((ZipException) error).getType() == ZipException.Type.CHECKSUM_MISMATCH) return "backup-damaged";
    String message = error.getMessage();
    return message != null && CODES.contains(message) ? message : "backup-unreadable";
  }

  private BackupInspection(ArchiveSource source, Closeable cleanup, FileHeader manifest, Map<String, FileHeader> objects, long objectBytes) {
    this.source = source; this.cleanup = cleanup; this.manifest = manifest; this.objects = objects; this.objectBytes = objectBytes;
  }

  /** Takes ownership of source and cleanup (for example deleting a private copy); both are released on failure. */
  public static BackupInspection open(ArchiveSource source, Closeable cleanup, BooleanSupplier stop) throws IOException {
    try {
      if (source.pinnedSha256() == null) source.pinStamp(); // A private copy is already pinned.
      List<FileHeader> headers = ZipInventory.validate(source, LIMITS, stop);
      FileHeader manifest = null; Map<String, FileHeader> objects = new HashMap<>(); long total = 0;
      for (FileHeader header : headers) {
        cancel(stop);
        String name = header.getFileName();
        // The v1 layout has no directory entries and nothing besides the manifest and hash-named objects.
        require(!header.isDirectory(), "backup-not-snarchive");
        if (name.equals(MANIFEST)) { manifest = header; continue; }
        Matcher match = OBJECT.matcher(name);
        require(match.matches() && match.group(2).startsWith(match.group(1)), "backup-not-snarchive");
        require(objects.size() < MAX_OBJECTS && header.getUncompressedSize() <= OriginalStore.MAX_OBJECT
          && header.getUncompressedSize() <= BackupWriter.MAX_TOTAL - total, "backup-limit");
        total += header.getUncompressedSize();
        require(objects.put(match.group(2), header) == null, "backup-invalid");
      }
      require(manifest != null, "backup-not-snarchive");
      require(manifest.getUncompressedSize() > 0 && manifest.getUncompressedSize() <= BackupWriter.MAX_MANIFEST, "backup-limit");
      source.checkUnchanged();
      return new BackupInspection(source, cleanup, manifest, objects, total);
    } catch (IOException | RuntimeException error) {
      try { source.close(); } catch (IOException ignored) {}
      // Keep the original failure, and record a copy that could not be deleted alongside it.
      if (cleanup != null) try { cleanup.close(); } catch (IOException cleanupError) { error.addSuppressed(cleanupError); }
      throw error;
    }
  }

  public int objectCount() { return objects.size(); }
  public long objectBytes() { return objectBytes; }
  public long manifestBytes() { return manifest.getUncompressedSize(); }

  /** Counts every byte, fails past the declared size, and requires exactly that size at the end. */
  private static final class Bounded extends FilterInputStream {
    final long size; long count; private boolean closed;
    Bounded(InputStream input, long size) { super(input); this.size = size; }
    @Override public int read() throws IOException { byte[] one = new byte[1]; return read(one, 0, 1) == -1 ? -1 : one[0] & 255; }
    @Override public int read(byte[] b, int off, int len) throws IOException {
      int n = super.read(b, off, len);
      if (n > 0) { count += n; require(count <= size, "backup-damaged"); }
      if (n == -1) require(count == size, "backup-damaged");
      return n;
    }
    @Override public void close() throws IOException { if (!closed) { closed = true; super.close(); } }
  }

  /** Strict UTF-8 text in bounded chunks, never split inside a surrogate pair. */
  private static final class TextChunks {
    private final Reader reader; private char held; boolean done;
    TextChunks(InputStream input) {
      CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT);
      reader = new InputStreamReader(input, decoder);
    }
    String next(int maxChars, BooleanSupplier stop) throws IOException {
      try {
        StringBuilder out = new StringBuilder(Math.min(maxChars, 65536));
        if (held != 0) { out.append(held); held = 0; }
        char[] buffer = new char[Math.min(maxChars, 16384)];
        while (out.length() < maxChars) {
          cancel(stop);
          int n = reader.read(buffer, 0, Math.min(buffer.length, maxChars - out.length()));
          if (n == -1) { done = true; break; }
          out.append(buffer, 0, n);
        }
        if (done) {
          reader.close();
          require(out.length() == 0 || !Character.isHighSurrogate(out.charAt(out.length() - 1)), "backup-invalid");
        } else if (Character.isHighSurrogate(out.charAt(out.length() - 1))) {
          held = out.charAt(out.length() - 1); out.setLength(out.length() - 1);
        }
        return out.toString();
      } catch (CharacterCodingException error) { throw new IOException("backup-invalid", error); }
    }
    void close() { try { reader.close(); } catch (IOException ignored) {} }
  }

  /** Copies every byte read to a private file and a digest (restore mode). */
  private static final class Tee extends FilterInputStream {
    final OutputStream copy; final MessageDigest digest;
    Tee(InputStream input, OutputStream copy, MessageDigest digest) { super(input); this.copy = copy; this.digest = digest; }
    @Override public int read() throws IOException { byte[] one = new byte[1]; return read(one, 0, 1) == -1 ? -1 : one[0] & 255; }
    @Override public int read(byte[] b, int off, int len) throws IOException {
      int n = super.read(b, off, len);
      if (n > 0) { copy.write(b, off, n); digest.update(b, off, n); }
      return n;
    }
  }

  /** Restore mode, before the manifest is read: pass 1 also writes the manifest bytes to this private file. */
  public void enableRestore(File stagedManifest) throws IOException {
    require(!closed && manifestText == null && this.stagedManifest == null, "backup-invalid");
    this.stagedManifest = stagedManifest; stagedOut = new FileOutputStream(stagedManifest); stagedDigest = digest();
  }

  /** The next piece of manifest text, at most maxChars and never split inside a surrogate pair. Malformed
   * UTF-8 fails. The entry's length and CRC are confirmed when its end is reached. */
  public Chunk readManifest(int maxChars, BooleanSupplier stop) throws IOException {
    require(!closed && maxChars >= 2 && maxChars <= MAX_CHUNK, "backup-invalid");
    if (manifestDone) return new Chunk("", true);
    if (manifestText == null) {
      InputStream entry = new Bounded(ZipInventory.open(source, manifest), manifest.getUncompressedSize());
      manifestText = new TextChunks(stagedOut == null ? entry : new Tee(entry, stagedOut, stagedDigest));
    }
    String text = manifestText.next(maxChars, stop);
    if (manifestText.done) {
      manifestDone = true; source.checkUnchanged();
      if (stagedOut != null) {
        stagedOut.flush(); ((FileOutputStream) stagedOut).getFD().sync(); stagedOut.close(); stagedOut = null;
        manifestSha256 = hex(stagedDigest.digest());
      }
    }
    return new Chunk(text, manifestDone);
  }

  /** Records an object the manifest declares. It must exist in the ZIP exactly once with that length. */
  public void declare(String hash, long bytes) throws IOException {
    require(!closed && !sealed && hash != null && hash.matches("[a-f0-9]{64}") && bytes >= 0, "backup-invalid");
    FileHeader header = objects.get(hash);
    require(header != null, "backup-damaged"); // Declared but absent from the archive.
    require(header.getUncompressedSize() == bytes, "backup-invalid");
    require(declared.put(hash, bytes) == null, "backup-invalid");
  }

  /** After the manifest's end record: every object in the ZIP must have been declared. */
  public void seal() throws IOException {
    require(!closed && !sealed && manifestDone, "backup-invalid");
    require(declared.size() == objects.size(), "backup-invalid"); // An object the manifest does not declare.
    order = new ArrayList<>(objects.keySet());
    order.sort(Comparator.comparingLong(hash -> objects.get(hash).getOffsetLocalHeader())); // Sequential reads.
    sealed = true;
  }

  /** Verifies objects in archive order until maxMillis has passed (at least one object), so callers can
   * report progress and cancel between calls. Every object is read in full: length, ZIP CRC and SHA-256. */
  public Progress verify(long maxMillis, BooleanSupplier stop) throws IOException {
    require(!closed && sealed, "backup-invalid");
    long start = System.nanoTime();
    MessageDigest digest = digest();
    byte[] buffer = new byte[OriginalStore.CHUNK];
    while (verified < order.size()) {
      cancel(stop);
      String hash = order.get(verified); FileHeader header = objects.get(hash);
      digest.reset(); CRC32 crc = new CRC32();
      try (Bounded input = new Bounded(ZipInventory.open(source, header), header.getUncompressedSize())) {
        for (;;) {
          cancel(stop); int n = input.read(buffer); if (n == -1) break;
          digest.update(buffer, 0, n); crc.update(buffer, 0, n);
        }
      }
      require(crc.getValue() == header.getCrc() && hex(digest.digest()).equals(hash), "backup-damaged");
      source.checkUnchanged();
      verified++; verifiedBytes += header.getUncompressedSize();
      if (System.nanoTime() - start >= maxMillis * 1_000_000L) break;
    }
    return new Progress(verified, order.size(), verifiedBytes, objectBytes);
  }

  private static MessageDigest digest() {
    try { return MessageDigest.getInstance("SHA-256"); } catch (NoSuchAlgorithmException e) { throw new AssertionError(e); }
  }

  public static final class Stored {
    public final int stored, total, added, reused; public final long bytes, totalBytes; public final boolean done;
    Stored(int stored, int total, int added, int reused, long bytes, long totalBytes) {
      this.stored = stored; this.total = total; this.added = added; this.reused = reused; this.bytes = bytes; this.totalBytes = totalBytes; this.done = stored == total;
    }
  }

  /** Restore mode: bytes of declared objects not yet in the store. A local object of the wrong length fails here. */
  public long missingBytes(OriginalStore store) throws IOException {
    require(!closed && sealed && stagedManifest != null, "backup-invalid");
    long missing = 0;
    for (String hash : order) { long size = objects.get(hash).getUncompressedSize(); if (!store.present(hash, size)) missing += size; }
    return missing;
  }

  /** Restore mode: places every object in the store, in archive order, until maxMillis has passed. A new object
   * is written through OriginalStore.put, which checks length, CRC and the declared SHA-256 before its atomic
   * rename. An object already present is never overwritten: the backup's copy is still read and checked, and the
   * local file is fully re-hashed; a mismatch there is "stored-object-corrupt" and nothing is changed. */
  public Stored store(OriginalStore store, long maxMillis, BooleanSupplier stop) throws IOException {
    require(!closed && sealed && stagedManifest != null && manifestSha256 != null, "backup-invalid");
    long start = System.nanoTime();
    OriginalStore.Budget budget = new OriginalStore.Budget(BackupWriter.MAX_TOTAL);
    byte[] buffer = new byte[OriginalStore.CHUNK];
    while (stored < order.size()) {
      cancel(stop);
      String hash = order.get(stored); FileHeader header = objects.get(hash); long size = header.getUncompressedSize();
      if (store.present(hash, size)) {
        MessageDigest digest = digest(); CRC32 crc = new CRC32();
        try (Bounded input = new Bounded(ZipInventory.open(source, header), size)) {
          for (;;) { cancel(stop); int n = input.read(buffer); if (n == -1) break; digest.update(buffer, 0, n); crc.update(buffer, 0, n); }
        }
        require(crc.getValue() == header.getCrc() && hex(digest.digest()).equals(hash), "backup-damaged");
        store.verify(hash, size, stop); // Same-length local corruption fails here; the local file is left as it is.
        reused++;
      } else {
        try {
          OriginalStore.Stored result = store.put(new Bounded(ZipInventory.open(source, header), size), size, header.getCrc(), hash, budget, stop);
          if (result.reused) reused++; else added++;
        } catch (IOException error) {
          String message = error.getMessage();
          if ("content-mismatch".equals(message) || "crc-mismatch".equals(message) || "size-mismatch".equals(message)) {
            IOException damaged = new IOException("backup-damaged", error);
            for (Throwable cleanup : error.getSuppressed()) damaged.addSuppressed(cleanup); // Keep any cleanup failure.
            throw damaged;
          }
          throw error;
        }
      }
      source.checkUnchanged();
      stored++; storedBytes += size;
      if (System.nanoTime() - start >= maxMillis * 1_000_000L) break;
    }
    return new Stored(stored, order.size(), added, reused, storedBytes, objectBytes);
  }

  /** What repairing one recorded original from this backup did. */
  public enum RepairOutcome { REPAIRED, ALREADY_VALID, UNAVAILABLE, MISMATCH }
  /** warnings: on REPAIRED, every problem after the replacement ("sync-failed", "thumbnail-eviction-failed"); the
   * repaired file is in place in each case. Empty otherwise. */
  public static final class Repaired {
    public final RepairOutcome outcome; public final boolean storeCleanupFailed; public final List<String> warnings;
    Repaired(RepairOutcome outcome, boolean storeCleanupFailed) { this(outcome, storeCleanupFailed, Collections.emptyList()); }
    Repaired(RepairOutcome outcome, boolean storeCleanupFailed, List<String> warnings) {
      this.outcome = outcome; this.storeCleanupFailed = storeCleanupFailed; this.warnings = Collections.unmodifiableList(new ArrayList<>(warnings));
    }
  }

  /** Repair (section 22), after the manifest was validated, every object declared and the session sealed: replaces the
   * library's original recorded as (hash, bytes) with this backup's copy, through OriginalStore.repair. The library's
   * record is the target. UNAVAILABLE: the backup has no object with that hash. MISMATCH: its entry has another length,
   * or its bytes failed the length, ZIP CRC or SHA-256 check (nothing was replaced). ALREADY_VALID: the local file
   * verified, so the backup's copy was not read. Only the requested object is read; other media are not re-hashed. */
  public Repaired repair(OriginalStore store, String hash, long bytes, BooleanSupplier stop, OriginalStore.Check beforeReplace) throws IOException {
    return repair(store, hash, bytes, stop, beforeReplace, () -> {});
  }

  /** As repair, with afterReplace (the second thumbnail eviction) run after every completed replacement, whatever the
   * store reported. Its failure is the "thumbnail-eviction-failed" warning, added to any warning the store gave. */
  public Repaired repair(OriginalStore store, String hash, long bytes, BooleanSupplier stop, OriginalStore.Check beforeReplace,
      OriginalStore.Check afterReplace) throws IOException {
    require(!closed && sealed && stagedManifest == null, "backup-invalid");
    require(hash != null && hash.matches("[a-f0-9]{64}") && bytes >= 0, "backup-invalid");
    FileHeader header = objects.get(hash);
    if (header == null) return new Repaired(RepairOutcome.UNAVAILABLE, false);
    if (header.getUncompressedSize() != bytes) return new Repaired(RepairOutcome.MISMATCH, false);
    try (Bounded input = new Bounded(ZipInventory.open(source, header), bytes)) {
      // The backup must not have moved while its copy was read; checked before anything is replaced, so a changed
      // backup stops the repair instead of being reported after a replacement.
      OriginalStore.RepairResult result = store.repair(input, hash, bytes, header.getCrc(), stop,
        () -> { source.checkUnchanged(); beforeReplace.run(); });
      if (result.outcome != OriginalStore.Repair.REPAIRED) return new Repaired(RepairOutcome.ALREADY_VALID, false);
      List<String> warnings = new ArrayList<>();
      if (result.warning != null) warnings.add(result.warning);
      try { afterReplace.run(); } catch (IOException | RuntimeException evictionFailed) { warnings.add("thumbnail-eviction-failed"); }
      return new Repaired(RepairOutcome.REPAIRED, false, warnings);
    } catch (IOException error) {
      String message = error.getMessage();
      boolean mismatch = "content-mismatch".equals(message) || "crc-mismatch".equals(message) || "size-mismatch".equals(message)
        || "backup-damaged".equals(message) || (error instanceof ZipException && ((ZipException) error).getType() == ZipException.Type.CHECKSUM_MISMATCH);
      if (!mismatch) throw error;
      // A backup that changed while being read is source-changed, not a bad copy. The mismatch's store leftover stays
      // attached to whichever error is reported.
      try { source.checkUnchanged(); }
      catch (IOException changed) { for (Throwable suppressed : error.getSuppressed()) changed.addSuppressed(suppressed); throw changed; }
      boolean leftover = false;
      for (Throwable suppressed : error.getSuppressed()) leftover |= OriginalStore.STAGING_CLEANUP_FAILED.equals(suppressed.getMessage());
      return new Repaired(RepairOutcome.MISMATCH, leftover);
    }
  }

  /** Restore mode, after every object is stored: the manifest again, from the private copy made in pass 1. Its
   * length and SHA-256 must match pass 1, so the merge consumes exactly the bytes that were validated. */
  public Chunk readStagedManifest(int maxChars, BooleanSupplier stop) throws IOException {
    require(!closed && manifestSha256 != null && stored == order.size() && maxChars >= 2 && maxChars <= MAX_CHUNK, "backup-invalid");
    if (stagedText != null && stagedText.done) return new Chunk("", true);
    if (stagedText == null) {
      stagedCheck = digest(); stagedCount = 0;
      InputStream file = new FilterInputStream(new FileInputStream(stagedManifest)) {
        @Override public int read() throws IOException { byte[] one = new byte[1]; return read(one, 0, 1) == -1 ? -1 : one[0] & 255; }
        @Override public int read(byte[] b, int off, int len) throws IOException {
          int n = super.read(b, off, len); if (n > 0) { stagedCheck.update(b, off, n); stagedCount += n; } return n;
        }
      };
      stagedText = new TextChunks(file);
    }
    String text = stagedText.next(maxChars, stop);
    if (stagedText.done) require(stagedCount == manifest.getUncompressedSize() && hex(stagedCheck.digest()).equals(manifestSha256), "backup-damaged");
    return new Chunk(text, stagedText.done);
  }

  private static String hex(byte[] bytes) {
    StringBuilder out = new StringBuilder(64);
    for (byte b : bytes) out.append(Character.forDigit((b >>> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
    return out.toString();
  }

  /** Releases the source and runs cleanup (for example deleting a private copy). Never touches the backup. */
  @Override public void close() throws IOException {
    if (closed) return; closed = true;
    if (manifestText != null) manifestText.close();
    if (stagedText != null) stagedText.close();
    if (stagedOut != null) try { stagedOut.close(); } catch (IOException ignored) {}
    try { source.close(); } finally { if (cleanup != null) cleanup.close(); }
  }
}
