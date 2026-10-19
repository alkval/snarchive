package com.alkval.snarchive.sources.zip;

import java.io.*;
import java.nio.*;
import java.nio.charset.*;
import java.util.*;
import java.util.function.BooleanSupplier;
import java.util.zip.CRC32;
import net.lingala.zip4j.headers.HeaderReader;
import net.lingala.zip4j.io.inputstream.ZipInputStream;
import net.lingala.zip4j.model.FileHeader;
import net.lingala.zip4j.model.LocalFileHeader;
import net.lingala.zip4j.model.Zip4jConfig;
import net.lingala.zip4j.model.ZipModel;
import net.lingala.zip4j.util.InternalZipConstants;

/** Preview: extracts metadata only. Originals are never written or represented as imported. */
public final class ZipInventory {
  /** Structural limits. Import keeps IMPORT; other readers (backup inspection) pass their own. */
  public static final class Limits {
    public final int maxEntries; public final long maxEntry, maxTotal;
    public Limits(int maxEntries, long maxEntry, long maxTotal) { this.maxEntries = maxEntries; this.maxEntry = maxEntry; this.maxTotal = maxTotal; }
  }
  public static final Limits IMPORT = new Limits(ZipGuard.MAX_ENTRIES, 8L * 1024 * 1024 * 1024, 64L * 1024 * 1024 * 1024);
  private static void require(boolean ok) throws IOException { if (!ok) throw new IOException("unsafe-or-unsupported-zip"); }
  private static void checkCancel(BooleanSupplier cancelled) throws IOException { if (cancelled.getAsBoolean()) throw new IOException("cancelled"); }
  private static int le16(byte[] b, int i) { return (b[i] & 255) | ((b[i+1] & 255) << 8); }

  private static Zip4jConfig config() { return new Zip4jConfig(StandardCharsets.UTF_8, InternalZipConstants.BUFF_SIZE, true); }

  /** Zip4j's own central-directory parse, read through the source rather than a reopened path. */
  public static ZipModel headers(ArchiveSource source) throws IOException {
    try (RandomAccessFile in = source.randomAccess()) { return new HeaderReader().readAllHeaders(in, config()); }
  }

  /** Same decoding and CRC check as ZipFile.getInputStream, from a positional stream at the local header. */
  public static InputStream open(ArchiveSource source, FileHeader header) throws IOException {
    ZipInputStream input = new ZipInputStream(source.openAt(header.getOffsetLocalHeader()), (char[])null, config());
    if (input.getNextEntry(header, false) == null) { input.close(); throw new IOException("unsafe-or-unsupported-zip"); }
    return input;
  }

  public static Map<String, Object> scan(File file, BooleanSupplier cancelled) throws IOException {
    try (ArchiveSource source = ArchiveSource.open(file)) { return scan(source, cancelled); }
  }

  /** The bounded guard pass, Zip4j's parse, per-entry limits, local/central cross-checks and overlap checks.
   * Returns the validated central-directory headers. Reads no entry data. */
  public static List<FileHeader> validate(ArchiveSource source, Limits limits, BooleanSupplier cancelled) throws IOException {
    checkCancel(cancelled);
    ZipGuard guard = ZipGuard.inspect(source, limits.maxEntries);
    ZipModel zip = headers(source);
    List<FileHeader> headers = zip.getCentralDirectory().getFileHeaders(); require(headers.size() == guard.count && !zip.isSplitArchive());
    long total = 0;
    List<long[]> ranges = new ArrayList<>();
    for (FileHeader h : headers) {
      checkCancel(cancelled);
      long size = h.getUncompressedSize(), compressed = h.getCompressedSize(), start = h.getOffsetLocalHeader();
      require(!h.isEncrypted() && h.getDiskNumberStart() == 0 && size >= 0 && size <= limits.maxEntry && compressed >= 0);
      require(size <= limits.maxTotal - total && (compressed >= size || size / (double)Math.max(1, compressed) <= 1000)); total += size;
      require(!h.isDirectory() || size == 0);
      require(start >= 0 && start <= guard.centralOffset - 30);
      long dataStart;
      try (InputStream file = source.openAt(start)) {
        byte[] fixed = new byte[30]; new DataInputStream(file).readFully(fixed);
        int nameLength = le16(fixed, 26), extraLength = le16(fixed, 28);
        require(nameLength > 0 && nameLength <= 4096 && extraLength <= 4096);
        dataStart = start + 30 + nameLength + extraLength;
        require(dataStart <= guard.centralOffset && compressed <= guard.centralOffset - dataStart);
      }
      try (InputStream file = source.openAt(start)) {
        LocalFileHeader local = new HeaderReader().readLocalFileHeader(file, StandardCharsets.UTF_8);
        require(local != null && h.getFileName().equals(local.getFileName()) && !local.isEncrypted());
        require(Arrays.equals(h.getGeneralPurposeFlag(), local.getGeneralPurposeFlag()) && h.getCompressionMethod() == local.getCompressionMethod());
        if (!local.isDataDescriptorExists()) require(local.getUncompressedSize() == size && local.getCompressedSize() == compressed && local.getCrc() == h.getCrc());
        ranges.add(new long[] { start, dataStart + compressed });
      }
    }
    ranges.sort(Comparator.comparingLong(a -> a[0]));
    long previousEnd = 0;
    for (long[] range : ranges) { require(range[0] >= previousEnd); previousEnd = range[1]; }
    return headers;
  }

  public static Map<String, Object> scan(ArchiveSource source, BooleanSupplier cancelled) throws IOException {
    List<FileHeader> headers = validate(source, IMPORT, cancelled);
    List<Map<String,Object>> entries = new ArrayList<>();
    int metadataBytes = 0;
    for (FileHeader h : headers) {
      checkCancel(cancelled);
      if (h.isDirectory()) continue;
      Map<String,Object> item = new HashMap<>(); item.put("path", h.getFileName());
      String basename = h.getFileName().substring(h.getFileName().lastIndexOf('/') + 1);
      if (basename.equalsIgnoreCase("memories_history.json")) {
        require(h.getUncompressedSize() <= 8 * 1024 * 1024 && h.getUncompressedSize() <= 16 * 1024 * 1024 - metadataBytes);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        CRC32 crc = new CRC32();
        try (InputStream input = open(source, h)) {
          byte[] buffer = new byte[65536];
          for (;;) {
            checkCancel(cancelled); int n = input.read(buffer); checkCancel(cancelled); if (n == -1) break;
            require(n > 0 && n <= h.getUncompressedSize() - output.size());
            output.write(buffer, 0, n); crc.update(buffer, 0, n);
          }
        }
        require(output.size() == h.getUncompressedSize() && crc.getValue() == h.getCrc());
        metadataBytes += output.size();
        item.put("metadataText", StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(output.toByteArray())).toString());
      }
      entries.add(item);
    }
    Map<String,Object> result = new HashMap<>();
    result.put("ok", true); result.put("entries", entries); result.put("metadataBytes", metadataBytes); result.put("visitedEntries", headers.size());
    return result;
  }
}
