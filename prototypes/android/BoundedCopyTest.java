package snarchive.prototype;

import java.io.*;
import java.nio.file.*;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.*;

public final class BoundedCopyTest {
  private static int passed;
  private static void check(boolean value) { if (!value) throw new AssertionError(); }
  private interface Action { void run() throws Exception; }
  private static void test(String name, Action action) throws Exception {
    action.run(); passed++; System.out.println("PASS " + name);
  }
  private static void fails(String code, Action action) throws Exception {
    try { action.run(); } catch (IOException e) {
      if (code != null) check(code.equals(e.getMessage()));
      return;
    }
    throw new AssertionError("Expected failure");
  }
  private static class CountingSink extends OutputStream {
    long count;
    public void write(int value) { count++; }
    public void write(byte[] bytes, int offset, int length) { count += length; }
  }
  private static byte[] archive(byte[] payload) throws IOException {
    var bytes = new ByteArrayOutputStream();
    try (var zip = new ZipOutputStream(bytes)) {
      var entry = new ZipEntry("synthetic.bin");
      var crc = new CRC32(); crc.update(payload);
      entry.setMethod(ZipEntry.STORED); entry.setSize(payload.length);
      entry.setCompressedSize(payload.length); entry.setCrc(crc.getValue());
      zip.putNextEntry(entry); zip.write(payload); zip.closeEntry();
    }
    return bytes.toByteArray();
  }
  private static void readZip(byte[] bytes, CountingSink sink) throws IOException {
    try (var zip = new ZipInputStream(new ByteArrayInputStream(bytes))) {
      var entry = zip.getNextEntry();
      if (entry == null) throw new IOException("missing-entry");
      BoundedCopy.copy(zip, sink, entry.getSize(), 1024, new BoundedCopy.Quota(1024), () -> false);
      zip.closeEntry();
    }
  }
  public static void main(String[] args) throws Exception {
    test("128 MiB stream uses reads no larger than 64 KiB", () -> {
      final long size = 128L * 1024 * 1024;
      var stream = new InputStream() {
        long remaining = size;
        public int read() { throw new AssertionError("single byte read"); }
        public int read(byte[] buffer, int offset, int length) {
          check(length <= BoundedCopy.BUFFER_BYTES);
          if (remaining == 0) return -1;
          int count = (int)Math.min(remaining, length); remaining -= count; return count;
        }
      };
      var sink = new CountingSink();
      check(BoundedCopy.copy(stream, sink, size, size, new BoundedCopy.Quota(size), () -> false) == size);
      check(sink.count == size);
    });
    test("underdeclared size cannot write oversized chunk", () -> {
      var sink = new CountingSink();
      fails("size-mismatch", () -> BoundedCopy.copy(new ByteArrayInputStream(new byte[10]), sink, 1, 100, new BoundedCopy.Quota(100), () -> false));
      check(sink.count == 0);
    });
    test("premature EOF fails", () -> fails("size-mismatch", () ->
      BoundedCopy.copy(new ByteArrayInputStream(new byte[1]), new CountingSink(), 10, 100, new BoundedCopy.Quota(100), () -> false)));
    test("entry limit fails before output", () -> fails("byte-limit", () ->
      BoundedCopy.copy(new ByteArrayInputStream(new byte[10]), new CountingSink(), 10, 9, new BoundedCopy.Quota(100), () -> false)));
    test("total quota is shared across entries", () -> {
      var quota = new BoundedCopy.Quota(15);
      BoundedCopy.copy(new ByteArrayInputStream(new byte[10]), new CountingSink(), 10, 100, quota, () -> false);
      check(quota.remaining() == 5);
      fails("byte-limit", () -> BoundedCopy.copy(new ByteArrayInputStream(new byte[10]), new CountingSink(), 10, 100, quota, () -> false));
    });
    test("cancellation during read prevents next write", () -> {
      var cancelled = new AtomicBoolean(false);
      var stream = new ByteArrayInputStream(new byte[10]) {
        public int read(byte[] b, int offset, int length) {
          cancelled.set(true); return super.read(b, offset, length);
        }
      };
      var sink = new CountingSink();
      fails("cancelled", () -> BoundedCopy.copy(stream, sink, 10, 10, new BoundedCopy.Quota(10), cancelled::get));
      check(sink.count == 0);
    });
    test("write failure propagates without success", () -> {
      var sink = new OutputStream() { public void write(int b) throws IOException { throw new IOException("disk-full"); } };
      fails("disk-full", () -> BoundedCopy.copy(new ByteArrayInputStream(new byte[10]), sink, 10, 10, new BoundedCopy.Quota(10), () -> false));
    });
    byte[] payload = "synthetic-memory".getBytes(java.nio.charset.StandardCharsets.UTF_8);
    byte[] valid = archive(payload);
    test("real ZIP entry streams through bounded copier", () -> {
      var sink = new CountingSink(); readZip(valid, sink); check(sink.count == payload.length);
    });
    test("DEFLATE entry with data descriptor streams and validates CRC", () -> {
      var bytes = new ByteArrayOutputStream();
      try (var zip = new ZipOutputStream(bytes)) {
        zip.putNextEntry(new ZipEntry("compressed.bin"));
        zip.write(new byte[8192]); zip.closeEntry();
      }
      try (var zip = new ZipInputStream(new ByteArrayInputStream(bytes.toByteArray()))) {
        check(zip.getNextEntry().getSize() == -1);
        // A production adapter must obtain declared size from validated central metadata.
        var sink = new CountingSink();
        BoundedCopy.copy(zip, sink, 8192, 8192, new BoundedCopy.Quota(8192), () -> false);
        zip.closeEntry(); check(sink.count == 8192);
      }
    });
    test("CRC corruption is rejected by the ZIP stream", () -> {
      var corrupt = valid.clone();
      int offset = 30 + "synthetic.bin".length(); corrupt[offset] ^= 1;
      fails(null, () -> readZip(corrupt, new CountingSink()));
    });
    test("truncated entry is rejected", () -> {
      int offset = 30 + "synthetic.bin".length();
      fails(null, () -> readZip(Arrays.copyOf(valid, offset + 2), new CountingSink()));
    });
    test("host JDK reads ZIP64 entry count of 65536", () -> {
      // Test ZIP64 central-directory counts, not a >4 GiB entry or Android's runtime.
      Path file = Files.createTempFile(Path.of(args[0]), "synthetic-zip64-", ".zip");
      try {
        try (var zip = new ZipOutputStream(Files.newOutputStream(file))) {
          for (int i = 0; i < 65536; i++) {
            var entry = new ZipEntry("entry-" + i);
            entry.setMethod(ZipEntry.STORED); entry.setSize(0); entry.setCompressedSize(0); entry.setCrc(0);
            zip.putNextEntry(entry); zip.closeEntry();
          }
        }
        try (var zip = new ZipFile(file.toFile())) { check(zip.size() == 65536); }
      } finally { Files.deleteIfExists(file); }
    });
    System.out.println(passed + " host-JVM tests passed. Android/iOS are NOT verified.");
  }
}
