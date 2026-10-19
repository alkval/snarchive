package com.alkval.snarchive.sources.zip;

import java.io.*;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.security.*;
import java.util.function.BooleanSupplier;

/** Read-only, seekable view of a selected archive, without needing a path to reopen it.
 * Reads are positional (pread), so the archive is never copied and no stream shares a file position.
 * Identity: sha256() pins the hash together with a cheap stamp (size, inode, change time); every
 * later step calls checkUnchanged() so an in-place rewrite of the source fails with "source-changed".
 */
public final class ArchiveSource implements Closeable {
  public static final int CHUNK = 65536;
  public interface Stamp { String read() throws IOException; }
  private final FileChannel channel;
  private final Closeable owner;
  private final Stamp stamp;
  private final File anchor;
  private String pinnedStamp, sha256;
  private long pinnedSize = -1;

  /** Takes ownership of owner (closing it must close channel). anchor: any readable file, never read;
   * RandomAccessFile subclasses must open something, and this keeps them off the source's path. */
  public ArchiveSource(FileChannel channel, Closeable owner, Stamp stamp, File anchor) {
    this.channel = channel; this.owner = owner; this.stamp = stamp; this.anchor = anchor;
  }
  /** Host tests and the copy fallback. The stamp still catches size or modification-time changes. */
  public static ArchiveSource open(File file) throws IOException {
    FileInputStream input = new FileInputStream(file);
    FileChannel channel = input.getChannel();
    return new ArchiveSource(channel, input, () -> channel.size() + ":" + file.lastModified(), file);
  }
  private static void require(boolean ok, String code) throws IOException { if (!ok) throw new IOException(code); }

  /** Returns null when that way of reading is unavailable. */
  public interface Opener { ArchiveSource open() throws Exception; }

  /** Deletes copies left by an interrupted earlier operation: only File.createTempFile("preview-", ".part") names. */
  public static int removeAbandonedCopies(File copies) throws IOException {
    File[] entries = copies.listFiles(); if (entries == null) return 0; int removed = 0;
    for (File entry : entries) {
      if (!entry.getName().matches("preview-[0-9]+\\.part")) continue;
      require(entry.delete() || !entry.exists(), "staging-cleanup-failed"); removed++; // Already gone counts as removed.
    }
    return removed;
  }

  /** Caller holds the exclusive operation guard, so no live copy exists. Cleanup runs before
   * either reading path is chosen; reading in place must not leave earlier copies behind. */
  public static ArchiveSource openSelected(File copies, Opener inPlace, Opener copy) throws Exception {
    removeAbandonedCopies(copies);
    ArchiveSource source = inPlace.open();
    return source != null ? source : copy.open();
  }

  public long size() throws IOException { return channel.size(); }

  /** Single sequential read. Pins the identity used by checkUnchanged(). */
  public String sha256(BooleanSupplier stop) throws IOException {
    String before = stamp.read(); long size = channel.size();
    MessageDigest digest;
    try { digest = MessageDigest.getInstance("SHA-256"); } catch (NoSuchAlgorithmException e) { throw new AssertionError(e); }
    ByteBuffer buffer = ByteBuffer.allocate(CHUNK); long position = 0;
    while (position < size) {
      require(!stop.getAsBoolean(), "cancelled");
      buffer.clear(); buffer.limit((int)Math.min(CHUNK, size - position));
      int n = channel.read(buffer, position); require(n > 0, "source-changed");
      digest.update(buffer.array(), 0, n); position += n;
    }
    require(channel.size() == size && before.equals(stamp.read()), "source-changed");
    StringBuilder hex = new StringBuilder(64);
    for (byte b : digest.digest()) hex.append(Character.forDigit((b >>> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
    pinnedStamp = before; pinnedSize = size; sha256 = hex.toString();
    return sha256;
  }
  /** Copy fallback only: a private copy hashed while it was written needs no second read. */
  public void pinCopy(String copiedSha256) throws IOException {
    require(copiedSha256 != null && copiedSha256.matches("[a-f0-9]{64}"), "source-changed");
    pinnedStamp = stamp.read(); pinnedSize = channel.size(); sha256 = copiedSha256;
  }
  /** For readers that verify their own content (backup inspection): pins the stamp without a whole-file hash,
   * so checkUnchanged() still catches an in-place rewrite. pinnedSha256() stays null. */
  public void pinStamp() throws IOException { pinnedStamp = stamp.read(); pinnedSize = channel.size(); }
  public String pinnedSha256() { return sha256; }

  public void checkUnchanged() throws IOException {
    require(pinnedStamp != null && channel.isOpen() && channel.size() == pinnedSize && pinnedStamp.equals(stamp.read()), "source-changed");
  }

  /** Independent stream starting at offset; closing it does not close the source. */
  public InputStream openAt(long offset) throws IOException {
    require(offset >= 0 && offset <= channel.size(), "unsafe-or-unsupported-zip");
    return new InputStream() {
      private long position = offset;
      @Override public int read() throws IOException { byte[] one = new byte[1]; return read(one, 0, 1) == -1 ? -1 : one[0] & 255; }
      @Override public int read(byte[] b, int off, int len) throws IOException {
        if (len == 0) return 0;
        int n = channel.read(ByteBuffer.wrap(b, off, Math.min(len, CHUNK)), position);
        if (n > 0) position += n;
        return n;
      }
      @Override public long skip(long n) throws IOException { long skipped = Math.max(0, Math.min(n, channel.size() - position)); position += skipped; return skipped; }
      @Override public int available() throws IOException { return (int)Math.max(0, Math.min(Integer.MAX_VALUE, channel.size() - position)); }
    };
  }

  /** For Zip4j's HeaderReader and ZipGuard, which only use read/readFully/seek/length/skipBytes.
   * Every read goes to the channel; the anchor descriptor opened by the superclass is never read. */
  public RandomAccessFile randomAccess() throws IOException {
    return new RandomAccessFile(anchor, "r") {
      private long position;
      @Override public int read() throws IOException { byte[] one = new byte[1]; return read(one, 0, 1) == -1 ? -1 : one[0] & 255; }
      @Override public int read(byte[] b) throws IOException { return read(b, 0, b.length); }
      @Override public int read(byte[] b, int off, int len) throws IOException {
        if (len == 0) return 0;
        int n = channel.read(ByteBuffer.wrap(b, off, len), position);
        if (n > 0) position += n;
        return n;
      }
      @Override public long getFilePointer() { return position; }
      @Override public void seek(long pos) throws IOException { if (pos < 0) throw new IOException("negative-seek"); position = pos; }
      @Override public long length() throws IOException { return channel.size(); }
      @Override public int skipBytes(int n) throws IOException {
        if (n <= 0) return 0; long skipped = Math.min(n, Math.max(0, channel.size() - position)); position += skipped; return (int)skipped;
      }
      @Override public void setLength(long newLength) throws IOException { throw new IOException("read-only"); }
      @Override public void write(int b) throws IOException { throw new IOException("read-only"); }
      @Override public void write(byte[] b, int off, int len) throws IOException { throw new IOException("read-only"); }
    };
  }

  @Override public void close() throws IOException { owner.close(); }
}
