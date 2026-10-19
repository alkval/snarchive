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

/** Read-only inspection of an untrusted portable backup (format v1). Never writes the library, the originals
 * store or the selected document. The ZIP is validated with the import engine's structural rules and the v1
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
    "staging-cleanup-failed"));

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
  private Bounded manifestStream;
  private Reader manifestReader;
  private char heldSurrogate;
  private List<String> order;
  private int verified;
  private long verifiedBytes;

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
    final long size; long count;
    Bounded(InputStream input, long size) { super(input); this.size = size; }
    @Override public int read() throws IOException { byte[] one = new byte[1]; return read(one, 0, 1) == -1 ? -1 : one[0] & 255; }
    @Override public int read(byte[] b, int off, int len) throws IOException {
      int n = super.read(b, off, len);
      if (n > 0) { count += n; require(count <= size, "backup-damaged"); }
      if (n == -1) require(count == size, "backup-damaged");
      return n;
    }
  }

  /** The next piece of manifest text, at most maxChars and never split inside a surrogate pair. Malformed
   * UTF-8 fails. The entry's length and CRC are confirmed when its end is reached. */
  public Chunk readManifest(int maxChars, BooleanSupplier stop) throws IOException {
    require(!closed && maxChars >= 2 && maxChars <= MAX_CHUNK, "backup-invalid");
    if (manifestDone) return new Chunk("", true);
    try {
      if (manifestReader == null) {
        CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT);
        manifestStream = new Bounded(ZipInventory.open(source, manifest), manifest.getUncompressedSize());
        manifestReader = new InputStreamReader(manifestStream, decoder);
      }
      StringBuilder out = new StringBuilder(Math.min(maxChars, 65536));
      if (heldSurrogate != 0) { out.append(heldSurrogate); heldSurrogate = 0; }
      char[] buffer = new char[Math.min(maxChars, 16384)];
      while (out.length() < maxChars) {
        cancel(stop);
        int n = manifestReader.read(buffer, 0, Math.min(buffer.length, maxChars - out.length()));
        if (n == -1) { manifestDone = true; break; }
        out.append(buffer, 0, n);
      }
      if (manifestDone) {
        manifestReader.close(); manifestReader = null; source.checkUnchanged();
        require(out.length() == 0 || !Character.isHighSurrogate(out.charAt(out.length() - 1)), "backup-invalid");
      } else if (Character.isHighSurrogate(out.charAt(out.length() - 1))) {
        heldSurrogate = out.charAt(out.length() - 1); out.setLength(out.length() - 1);
      }
      return new Chunk(out.toString(), manifestDone);
    } catch (CharacterCodingException error) { throw new IOException("backup-invalid", error); }
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
    MessageDigest digest;
    try { digest = MessageDigest.getInstance("SHA-256"); } catch (NoSuchAlgorithmException e) { throw new AssertionError(e); }
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

  private static String hex(byte[] bytes) {
    StringBuilder out = new StringBuilder(64);
    for (byte b : bytes) out.append(Character.forDigit((b >>> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
    return out.toString();
  }

  /** Releases the source and runs cleanup (for example deleting a private copy). Never touches the backup. */
  @Override public void close() throws IOException {
    if (closed) return; closed = true;
    try { if (manifestReader != null) manifestReader.close(); } catch (IOException ignored) {}
    try { source.close(); } finally { if (cleanup != null) cleanup.close(); }
  }
}
