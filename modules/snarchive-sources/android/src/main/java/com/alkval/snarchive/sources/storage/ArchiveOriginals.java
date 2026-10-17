package com.alkval.snarchive.sources.storage;

import com.alkval.snarchive.sources.zip.ZipInventory;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.function.BooleanSupplier;
import net.lingala.zip4j.ZipFile;
import net.lingala.zip4j.model.FileHeader;

/** A sequential extraction session over an immutable, private staged archive.
 * Caller owns archive staging/lifetime. This class never deletes the archive or creates memories.
 */
public final class ArchiveOriginals implements AutoCloseable {
  private final ZipFile archive;
  public ArchiveOriginals(File stagedArchive, BooleanSupplier stop) throws IOException {
    ZipInventory.scan(stagedArchive, stop); // Same bounded header and metadata validation as preview.
    archive = new ZipFile(stagedArchive); archive.setCharset(StandardCharsets.UTF_8);
  }
  public OriginalStore.Stored preserve(String path, OriginalStore store, OriginalStore.Budget budget, BooleanSupplier stop) throws IOException {
    String basename = path.substring(path.lastIndexOf('/') + 1);
    if (!basename.matches("(?i)\\d{4}-\\d{2}-\\d{2}_[A-Za-z0-9_-]+-(?:main\\.(?:jpg|jpeg|mp4)|overlay\\.png)")) throw new IOException("unsupported-entry");
    FileHeader header = archive.getFileHeader(path);
    if (header == null || !header.getFileName().equals(path) || header.isDirectory()) throw new IOException("missing-entry");
    return store.put(archive.getInputStream(header), header.getUncompressedSize(), header.getCrc(), budget, stop);
  }
  @Override public void close() throws IOException { archive.close(); }
}
