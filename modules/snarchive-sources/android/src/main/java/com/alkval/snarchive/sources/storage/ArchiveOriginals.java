package com.alkval.snarchive.sources.storage;

import com.alkval.snarchive.sources.zip.ArchiveSource;
import com.alkval.snarchive.sources.zip.ZipInventory;
import java.io.*;
import java.util.function.BooleanSupplier;
import net.lingala.zip4j.headers.HeaderUtil;
import net.lingala.zip4j.model.FileHeader;
import net.lingala.zip4j.model.ZipModel;

/** A sequential extraction session over a hash-pinned archive source, read in place or from a private copy.
 * Owns and closes the source. This class never deletes the archive or creates memories.
 */
public final class ArchiveOriginals implements AutoCloseable {
  private final ArchiveSource source;
  private final ZipModel archive;
  /** source.sha256() must already have run and matched the planned job hash. */
  public ArchiveOriginals(ArchiveSource source, BooleanSupplier stop) throws IOException {
    this.source = source;
    try {
      if (source.pinnedSha256() == null) throw new IOException("source-changed");
      ZipInventory.scan(source, stop); // Same bounded header and metadata validation as preview.
      archive = ZipInventory.headers(source);
      source.checkUnchanged();
    } catch (IOException | RuntimeException error) { try { source.close(); } catch (IOException ignored) {} throw error; }
  }
  public OriginalStore.Stored preserve(String path, OriginalStore store, OriginalStore.Budget budget, BooleanSupplier stop) throws IOException {
    String basename = path.substring(path.lastIndexOf('/') + 1);
    if (!basename.matches("(?i)\\d{4}-\\d{2}-\\d{2}_[A-Za-z0-9_-]+-(?:main\\.(?:jpg|jpeg|mp4)|overlay\\.png)")) throw new IOException("unsupported-entry");
    FileHeader header = HeaderUtil.getFileHeader(archive, path);
    if (header == null || !header.getFileName().equals(path) || header.isDirectory()) throw new IOException("missing-entry");
    source.checkUnchanged();
    OriginalStore.Stored stored = store.put(ZipInventory.open(source, header), header.getUncompressedSize(), header.getCrc(), budget, stop);
    // A stored object is content-addressed and CRC-checked, but the job must not record bytes read while the source moved.
    source.checkUnchanged();
    return stored;
  }
  /** The pinned archive identity used to select only this archive's recorded observations for repair. */
  public String sha256() { return source.pinnedSha256(); }
  /** Repair one recorded path, requiring the library's exact bytes. The stamp is checked before replacement. */
  public OriginalStore.RepairResult repair(String path, String hash, long bytes, OriginalStore store,
      BooleanSupplier stop, OriginalStore.Check beforeReplace) throws IOException {
    FileHeader header = HeaderUtil.getFileHeader(archive, path);
    if (header == null || !header.getFileName().equals(path) || header.isDirectory()) throw new IOException("source-missing");
    source.checkUnchanged();
    try (RepairInput input = new RepairInput(ZipInventory.open(source, header))) {
      return store.repair(input, hash, bytes, header.getCrc(), stop,
        () -> { source.checkUnchanged(); beforeReplace.run(); });
    }
  }
  private static final class RepairInput extends FilterInputStream {
    private boolean closed;
    RepairInput(InputStream input) { super(input); }
    @Override public void close() throws IOException { if (!closed) { closed = true; super.close(); } }
  }
  public void checkUnchanged() throws IOException { source.checkUnchanged(); }
  public long totalOriginalBytes() throws IOException {
    long total = 0;
    for (FileHeader header : archive.getCentralDirectory().getFileHeaders()) {
      String name = header.getFileName(); String base = name.substring(name.lastIndexOf('/') + 1);
      if (base.matches("(?i)\\d{4}-\\d{2}-\\d{2}_[A-Za-z0-9_-]+-(?:main\\.(?:jpg|jpeg|mp4)|overlay\\.png)")) total += header.getUncompressedSize();
    }
    return total;
  }
  @Override public void close() throws IOException { source.close(); }
}
