package com.alkval.snarchive.sources.zip;

import java.io.*;
import java.nio.*;
import java.nio.charset.*;
import java.text.Normalizer;
import java.util.*;

/** Small bounded validation pass before the ZIP engine may allocate its header model. */
public final class ZipGuard {
  public static final int MAX_ENTRIES = 100_000;
  public final long centralOffset;
  public final int count;
  private ZipGuard(long offset, int count) { this.centralOffset = offset; this.count = count; }
  private static long u32(byte[] b, int i) { return Integer.toUnsignedLong(ByteBuffer.wrap(b, i, 4).order(ByteOrder.LITTLE_ENDIAN).getInt()); }
  private static int u16(byte[] b, int i) { return (b[i] & 255) | ((b[i + 1] & 255) << 8); }
  private static long u64(byte[] b, int i) throws IOException {
    long n = ByteBuffer.wrap(b, i, 8).order(ByteOrder.LITTLE_ENDIAN).getLong();
    if (n < 0) throw new IOException("zip64-range"); return n;
  }
  private static void require(boolean valid) throws IOException { if (!valid) throw new IOException("unsafe-or-unsupported-zip"); }
  public static String path(String name, boolean directory) throws IOException {
    require(!name.isEmpty() && name.length() <= 1024 && !name.startsWith("/"));
    if (directory && name.endsWith("/")) name = name.substring(0, name.length() - 1);
    String[] parts = name.split("/", -1); require(parts.length <= 32);
    for (String part : parts) {
      require(!part.isEmpty() && !part.equals(".") && !part.equals("..") && !part.endsWith(".") && !part.endsWith(" "));
      for (char c : part.toCharArray()) require(c >= 32 && c != 127 && c != '\\' && c != ':');
    }
    return Normalizer.normalize(name, Normalizer.Form.NFC).toLowerCase(Locale.ROOT);
  }
  public static ZipGuard inspect(File file) throws IOException {
    try (RandomAccessFile in = new RandomAccessFile(file, "r")) {
      long length = in.length(); require(length >= 22);
      int tailLength = (int)Math.min(length, 65557);
      byte[] tail = new byte[tailLength]; in.seek(length - tailLength); in.readFully(tail);
      int end = -1;
      for (int i = tailLength - 22; i >= 0; i--) {
        if (u32(tail, i) == 0x06054b50L && i + 22 + u16(tail, i + 20) == tailLength) { end = i; break; }
      }
      require(end >= 0 && u16(tail, end + 4) == 0 && u16(tail, end + 6) == 0);
      long endOffset = length - tailLength + end;
      long count = u16(tail, end + 10), size = u32(tail, end + 12), offset = u32(tail, end + 16);
      long centralEnd = endOffset;
      require(u16(tail, end + 8) == count);
      if (count == 65535 || size == 0xffffffffL || offset == 0xffffffffL) {
        require(endOffset >= 20);
        byte[] locator = new byte[20]; in.seek(endOffset - 20); in.readFully(locator);
        require(u32(locator, 0) == 0x07064b50L && u32(locator, 4) == 0 && u32(locator, 16) == 1);
        long pos = u64(locator, 8); require(pos <= endOffset - 76);
        byte[] z64 = new byte[56]; in.seek(pos); in.readFully(z64);
        long recordSize = u64(z64, 4);
        require(u32(z64, 0) == 0x06064b50L && recordSize >= 44 && recordSize <= 1024 && pos + 12 + recordSize == endOffset - 20);
        require(u32(z64, 16) == 0 && u32(z64, 20) == 0 && u64(z64, 24) == u64(z64, 32));
        count = u64(z64, 32); size = u64(z64, 40); offset = u64(z64, 48); centralEnd = pos;
      }
      require(count <= MAX_ENTRIES && size <= 32 * 1024 * 1024 && offset <= centralEnd && size == centralEnd - offset);
      in.seek(offset);
      Set<String> paths = new HashSet<>(), files = new HashSet<>();
      byte[] header = new byte[46];
      for (int i = 0; i < count; i++) {
        require(in.getFilePointer() <= centralEnd - 46); in.readFully(header);
        require(u32(header, 0) == 0x02014b50L);
        int flags = u16(header, 8), method = u16(header, 10);
        require((flags & ~0x080e) == 0 && (method == 0 || method == 8) && u16(header, 34) == 0);
        int nameLength = u16(header, 28), extra = u16(header, 30), comment = u16(header, 32);
        require(nameLength > 0 && nameLength <= 4096 && extra <= 4096 && comment <= 4096);
        require(nameLength + extra + comment <= centralEnd - in.getFilePointer());
        int type = (int)((u32(header, 38) >>> 16) & 0170000);
        require(type == 0 || type == 0100000 || type == 0040000);
        byte[] nameBytes = new byte[nameLength]; in.readFully(nameBytes);
        if ((flags & 0x800) == 0) for (byte b : nameBytes) require(b >= 0); // Non-ASCII names must declare UTF-8.
        String name = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(nameBytes)).toString();
        boolean directory = name.endsWith("/");
        require(type != 0040000 || directory);
        String key = path(name, directory); require(paths.add(key)); if (!directory) files.add(key);
        in.seek(in.getFilePointer() + extra + comment);
      }
      require(in.getFilePointer() == centralEnd);
      for (String name : paths) {
        for (int slash = name.indexOf('/'); slash >= 0; slash = name.indexOf('/', slash + 1)) require(!files.contains(name.substring(0, slash)));
      }
      return new ZipGuard(offset, (int)count);
    }
  }
}
