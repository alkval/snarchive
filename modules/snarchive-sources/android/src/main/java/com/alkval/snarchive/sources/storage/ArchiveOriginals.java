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
