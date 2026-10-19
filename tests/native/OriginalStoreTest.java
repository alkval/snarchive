import com.alkval.snarchive.sources.storage.*;
import com.alkval.snarchive.sources.zip.ArchiveSource;
import java.io.*;
import java.nio.file.*;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.*;

public class OriginalStoreTest {
  interface Work { void run() throws Exception; }
  static File base; static int passed;
  static byte[] bytes = "synthetic original bytes\u0000unchanged".getBytes(java.nio.charset.StandardCharsets.UTF_8);
  static OriginalStore.Budget budget() { return new OriginalStore.Budget(64L * 1024 * 1024); }
  static File root() throws Exception { return Files.createTempDirectory(base.toPath(), "case-").toFile(); }
  static void check(boolean ok) { if (!ok) throw new AssertionError(); }
  static void fails(String code, Work work) throws Exception {
    try { work.run(); throw new AssertionError("expected " + code); }
    catch (IOException e) { if (code != null) check(code.equals(e.getMessage())); }
  }
  static void test(String name, Work work) throws Exception { work.run(); passed++; System.out.println("PASS " + name); }
  static OriginalStore.Stored put(OriginalStore store, byte[] value) throws Exception { return store.put(new ByteArrayInputStream(value), value.length, -1, budget(), () -> false); }
  static void emptyStage(File root) { check(new File(root, "staging").list().length == 0); }
  static int objects(File root) throws Exception {
    try (java.util.stream.Stream<Path> paths = Files.walk(new File(root, "objects").toPath())) { return (int) paths.filter(Files::isRegularFile).count(); }
  }
  static String sha(byte[] input) throws Exception {
    StringBuilder text = new StringBuilder(); for (byte b : MessageDigest.getInstance("SHA-256").digest(input)) text.append(String.format("%02x", b & 255)); return text.toString();
  }
  static File zip(String path, byte[] payload) throws Exception {
    File zip = File.createTempFile("fixture-", ".zip", base);
    try (ZipOutputStream out = new ZipOutputStream(new FileOutputStream(zip))) {
      CRC32 crc = new CRC32(); crc.update(payload);
      ZipEntry entry = new ZipEntry(path); entry.setMethod(ZipEntry.STORED); entry.setSize(payload.length); entry.setCompressedSize(payload.length); entry.setCrc(crc.getValue());
      out.putNextEntry(entry); out.write(payload); out.closeEntry();
    }
    return zip;
  }
  /** Hash-pinned session, as openImportArchive builds it after the planned hash matched. */
  static ArchiveOriginals session(File archive) throws Exception {
    ArchiveSource source = ArchiveSource.open(archive); source.sha256(() -> false); return new ArchiveOriginals(source, () -> false);
  }
  public static void main(String[] args) throws Exception {
    if (args[0].startsWith("crash-")) {
      String point = args[0].equals("crash-write") ? "after-chunk" : "after-finalize";
      OriginalStore store = new OriginalStore(new File(args[1]), dir -> Long.MAX_VALUE, at -> { if (at.equals(point)) Runtime.getRuntime().halt(23); });
      put(store, bytes); throw new AssertionError("crash point not reached");
    }
    base = Files.createTempDirectory(Paths.get(args[0]), "run-").toFile();
    test("byte-identical copy and SHA-256 path", () -> {
      File r = root(); OriginalStore.Stored stored = put(new OriginalStore(r), bytes);
      check(stored.sha256.equals(sha(bytes)) && stored.bytes == bytes.length && !stored.reused);
      check(Arrays.equals(Files.readAllBytes(new File(r, stored.relativePath).toPath()), bytes)); emptyStage(r);
    });
    test("identical bytes reuse one verified object", () -> {
      File r = root(); OriginalStore store = new OriginalStore(r); put(store, bytes);
      check(put(store, bytes).reused && objects(r) == 1); emptyStage(r);
    });
    test("existing corrupt object is never overwritten", () -> {
      File r = root(); OriginalStore store = new OriginalStore(r); OriginalStore.Stored first = put(store, bytes);
      byte[] changed = bytes.clone(); changed[0] ^= 1; File object = new File(r, first.relativePath); Files.write(object.toPath(), changed);
      fails("stored-object-corrupt", () -> put(store, bytes)); check(Arrays.equals(Files.readAllBytes(object.toPath()), changed)); emptyStage(r);
    });
    test("short source rejects and cleans staging", () -> {
      File r = root(); OriginalStore store = new OriginalStore(r);
      fails("size-mismatch", () -> store.put(new ByteArrayInputStream(bytes), bytes.length + 1, -1, budget(), () -> false));
      emptyStage(r); check(objects(r) == 0);
    });
    test("actual output exceeds declaration", () -> {
      File r = root(); OriginalStore store = new OriginalStore(r);
      fails("size-mismatch", () -> store.put(new ByteArrayInputStream(bytes), bytes.length - 1, -1, budget(), () -> false)); emptyStage(r);
    });
    test("unknown-size source still obeys actual-byte budget", () -> {
      File r = root(); OriginalStore store = new OriginalStore(r);
      fails("byte-limit", () -> store.put(new ByteArrayInputStream(bytes), -1, -1, new OriginalStore.Budget(1), () -> false)); emptyStage(r);
    });
    test("shared budget preserves prior objects on exhaustion", () -> {
      File r = root(); OriginalStore store = new OriginalStore(r); OriginalStore.Budget quota = new OriginalStore.Budget(bytes.length);
      store.put(new ByteArrayInputStream(bytes), bytes.length, -1, quota, () -> false);
      fails("byte-limit", () -> store.put(new ByteArrayInputStream(bytes), bytes.length, -1, quota, () -> false)); check(objects(r) == 1 && quota.remaining() == 0);
    });
    test("CRC mismatch never finalizes", () -> {
      File r = root(); OriginalStore store = new OriginalStore(r);
      fails("crc-mismatch", () -> store.put(new ByteArrayInputStream(bytes), bytes.length, 0, budget(), () -> false)); emptyStage(r); check(objects(r) == 0);
    });
    test("low storage stops before writing", () -> {
      File r = root(); OriginalStore store = new OriginalStore(r, dir -> OriginalStore.RESERVE, point -> {});
      fails("insufficient-storage", () -> put(store, bytes)); emptyStage(r); check(objects(r) == 0);
    });
    test("cancellation after a written chunk cleans staging", () -> {
      File r = root(); AtomicBoolean stop = new AtomicBoolean();
      OriginalStore store = new OriginalStore(r, dir -> Long.MAX_VALUE, point -> { if (point.equals("after-chunk")) stop.set(true); });
      fails("cancelled", () -> store.put(new ByteArrayInputStream(new byte[100_000]), 100_000, -1, budget(), stop::get)); emptyStage(r); check(objects(r) == 0);
    });
    test("write-stage failure leaves existing objects alone", () -> {
      File r = root(); put(new OriginalStore(r), bytes);
      OriginalStore store = new OriginalStore(r, dir -> Long.MAX_VALUE, point -> { if (point.equals("after-chunk")) throw new IOException("injected-write"); });
      fails("injected-write", () -> put(store, new byte[100_000])); emptyStage(r); check(objects(r) == 1);
    });
    test("failure before rename exposes no completed object", () -> {
      File r = root(); OriginalStore store = new OriginalStore(r, dir -> Long.MAX_VALUE, point -> { if (point.equals("before-finalize")) throw new IOException("injected-finalize"); });
      fails("injected-finalize", () -> put(store, bytes)); emptyStage(r); check(objects(r) == 0);
    });
    test("failure after rename permits verified reuse on retry", () -> {
      File r = root(); OriginalStore store = new OriginalStore(r, dir -> Long.MAX_VALUE, point -> { if (point.equals("after-finalize")) throw new IOException("injected-after-finalize"); });
      fails("injected-after-finalize", () -> put(store, bytes)); emptyStage(r); check(objects(r) == 1);
      check(put(new OriginalStore(r), bytes).reused);
    });
    test("source close failure prevents finalization and closes once", () -> {
      File r = root(); OriginalStore store = new OriginalStore(r); AtomicInteger closes = new AtomicInteger();
      InputStream source = new ByteArrayInputStream(bytes) { public void close() throws IOException { closes.incrementAndGet(); throw new IOException("source-close"); } };
      fails("source-close", () -> store.put(source, bytes.length, -1, budget(), () -> false));
      check(closes.get() == 1 && objects(r) == 0); emptyStage(r);
    });
    test("recovery removes only recognized abandoned parts", () -> {
      File r = root(); OriginalStore store = new OriginalStore(r); put(store, bytes);
      Files.write(new File(r, "staging/" + UUID.randomUUID() + ".part").toPath(), bytes);
      Files.write(new File(r, "staging/unrelated.txt").toPath(), bytes);
      check(store.recoverStaging() == 1 && objects(r) == 1 && new File(r, "staging/unrelated.txt").exists());
    });
    // Store cleanup failures: deletion is made impossible by removing write permission from staging mid-write.
    test("a failed staging delete keeps the write error and is attached to it", () -> {
      File r = root(); put(new OriginalStore(r), bytes); File staging = new File(r, "staging");
      OriginalStore store = new OriginalStore(r, dir -> Long.MAX_VALUE, point -> {
        if (point.equals("after-chunk")) { check(staging.setWritable(false)); throw new IOException("injected-write"); } });
      IOException error = null;
      try { put(store, new byte[100_000]); } catch (IOException e) { error = e; }
      try {
        check(error != null && "injected-write".equals(error.getMessage()) && error.getSuppressed().length == 1
          && OriginalStore.STAGING_CLEANUP_FAILED.equals(error.getSuppressed()[0].getMessage()));
        check(staging.list().length == 1 && objects(r) == 1);
        fails(OriginalStore.STAGING_CLEANUP_FAILED, store::recoverStaging); check(staging.list().length == 1); // Recovery reports it too.
      } finally { check(staging.setWritable(true)); }
      // Once deletion is possible again, recovery removes the part and the same write succeeds.
      check(store.recoverStaging() == 1); emptyStage(r);
      check(!put(new OriginalStore(r), new byte[100_000]).reused && objects(r) == 2); emptyStage(r);
    });
    test("a failed staging delete is reported beside cancellation", () -> {
      File r = root(); File staging = new File(r, "staging"); AtomicBoolean stop = new AtomicBoolean();
      OriginalStore store = new OriginalStore(r, dir -> Long.MAX_VALUE, point -> {
        if (point.equals("after-chunk")) { check(staging.setWritable(false)); stop.set(true); } });
      IOException error = null;
      try { store.put(new ByteArrayInputStream(new byte[100_000]), 100_000, -1, budget(), stop::get); } catch (IOException e) { error = e; }
      try {
        check(error != null && "cancelled".equals(error.getMessage()) && error.getSuppressed().length == 1
          && OriginalStore.STAGING_CLEANUP_FAILED.equals(error.getSuppressed()[0].getMessage()) && objects(r) == 0);
      } finally { check(staging.setWritable(true)); }
      check(store.recoverStaging() == 1); emptyStage(r);
    });
    test("a successful staging delete adds nothing to the error", () -> {
      File r = root(); OriginalStore store = new OriginalStore(r, dir -> Long.MAX_VALUE, point -> { if (point.equals("after-chunk")) throw new IOException("injected-write"); });
      IOException error = null;
      try { put(store, new byte[100_000]); } catch (IOException e) { error = e; }
      check(error != null && "injected-write".equals(error.getMessage()) && error.getSuppressed().length == 0); emptyStage(r);
    });
    test("a failing pre-finalize check stores nothing and never reports reuse; a passing one changes nothing", () -> {
      File r = root(); OriginalStore store = new OriginalStore(r); AtomicInteger checks = new AtomicInteger();
      fails("source-changed", () -> store.put(new ByteArrayInputStream(bytes), bytes.length, -1, null, budget(), () -> false, () -> { throw new IOException("source-changed"); }));
      emptyStage(r); check(objects(r) == 0);
      check(!store.put(new ByteArrayInputStream(bytes), bytes.length, -1, null, budget(), () -> false, checks::incrementAndGet).reused && checks.get() == 1);
      // An object with these bytes now exists: the check still runs first, and a failure is not turned into reuse.
      fails("source-changed", () -> store.put(new ByteArrayInputStream(bytes), bytes.length, -1, null, budget(), () -> false, () -> { throw new IOException("source-changed"); }));
      emptyStage(r); check(objects(r) == 1);
    });
    test("process death while writing leaves only recoverable staging", () -> {
      File r = root();
      Process child = new ProcessBuilder(new File(System.getProperty("java.home"), "bin/java").getPath(), "-cp", System.getProperty("java.class.path"), "OriginalStoreTest", "crash-write", r.getPath()).inheritIO().start();
      check(child.waitFor() == 23 && objects(r) == 0);
      OriginalStore store = new OriginalStore(r); check(store.recoverStaging() == 1); emptyStage(r);
      check(!put(store, bytes).reused);
    });
    test("process death after rename retains a verifiable completed object", () -> {
      File r = root();
      Process child = new ProcessBuilder(new File(System.getProperty("java.home"), "bin/java").getPath(), "-cp", System.getProperty("java.class.path"), "OriginalStoreTest", "crash-finalize", r.getPath()).inheritIO().start();
      check(child.waitFor() == 23 && objects(r) == 1);
      OriginalStore store = new OriginalStore(r); check(store.recoverStaging() == 0 && put(store, bytes).reused);
    });
    test("writer lock prevents competing finalizations", () -> {
      File r = root(); OriginalStore store = new OriginalStore(r);
      try (RandomAccessFile file = new RandomAccessFile(new File(r, "writer.lock"), "rw"); FileLock lock = file.getChannel().lock()) {
        fails("storage-busy", () -> put(store, bytes));
      }
      check(objects(r) == 0); emptyStage(r);
    });
    test("symlinked storage directory cannot redirect writes", () -> {
      File r = root(), outside = root(); OriginalStore store = new OriginalStore(r);
      check(new File(r, "staging").delete()); Files.createSymbolicLink(new File(r, "staging").toPath(), outside.toPath());
      fails("unsafe-storage-path", () -> put(store, bytes)); check(outside.list().length == 0);
    });
    test("32 MiB stream uses bounded read requests", () -> {
      File r = root(); final long size = 32L * 1024 * 1024;
      InputStream generated = new InputStream() { long left = size; public int read() { throw new AssertionError(); }
        public int read(byte[] b, int off, int len) { check(len <= OriginalStore.CHUNK); if (left == 0) return -1; int n = (int)Math.min(left, len); Arrays.fill(b, off, off + n, (byte)42); left -= n; return n; } };
      OriginalStore.Stored saved = new OriginalStore(r).put(generated, size, -1, budget(), () -> false);
      check(saved.bytes == size && new File(r, saved.relativePath).length() == size); emptyStage(r);
    });
    test("ZIP overlay bytes remain exact and source unchanged", () -> {
      File r = root(), archive = zip("memories/2026-02-05_memoryA-overlay.png", bytes);
      byte[] before = Files.readAllBytes(archive.toPath());
      try (ArchiveOriginals session = session(archive)) {
        OriginalStore.Stored saved = session.preserve("memories/2026-02-05_memoryA-overlay.png", new OriginalStore(r), budget(), () -> false);
        check(Arrays.equals(bytes, Files.readAllBytes(new File(r, saved.relativePath).toPath())));
      }
      check(Arrays.equals(before, Files.readAllBytes(archive.toPath())));
    });
    test("ZIP payload corruption is rejected during preservation", () -> {
      File r = root(), archive = zip("2026-02-05_memoryA-main.jpg", bytes);
      byte[] content = Files.readAllBytes(archive.toPath()); int name = (content[26] & 255) | ((content[27] & 255) << 8); int extra = (content[28] & 255) | ((content[29] & 255) << 8); content[30 + name + extra] ^= 1; Files.write(archive.toPath(), content);
      try (ArchiveOriginals session = session(archive)) {
        fails(null, () -> session.preserve("2026-02-05_memoryA-main.jpg", new OriginalStore(r), budget(), () -> false));
      }
      emptyStage(r); check(objects(r) == 0);
    });
    test("ZIP traversal and unsupported files cannot enter object storage", () -> {
      File r = root(), bad = zip("../2026-02-05_memoryA-main.jpg", bytes);
      fails(null, () -> { try (ArchiveOriginals session = session(bad)) {} });
      File html = zip("index.html", bytes);
      try (ArchiveOriginals session = session(html)) {
        fails("unsupported-entry", () -> session.preserve("index.html", new OriginalStore(r), budget(), () -> false));
      }
      check(objects(r) == 0);
    });
    test("confirm accepts finalized objects and rejects missing or truncated ones", () -> {
      File r = root(); OriginalStore store = new OriginalStore(r); OriginalStore.Stored stored = put(store, bytes);
      check(store.confirm(stored.sha256, stored.bytes).equals(new File(r, stored.relativePath).getCanonicalFile()));
      fails("stored-object-corrupt", () -> store.confirm(stored.sha256, stored.bytes + 1));
      fails("invalid-object", () -> store.confirm("../" + stored.sha256, stored.bytes));
      Files.write(new File(r, stored.relativePath).toPath(), Arrays.copyOf(bytes, bytes.length - 1));
      fails("stored-object-corrupt", () -> store.confirm(stored.sha256, stored.bytes));
      new File(r, stored.relativePath).delete();
      fails("stored-object-corrupt", () -> store.confirm(stored.sha256, stored.bytes));
    });
    test("LRU index evicts oldest files by count and bytes without rescanning", () -> {
      File r = root(); java.util.regex.Pattern names = java.util.regex.Pattern.compile("[a-z]\\.jpg");
      for (String name : new String[] { "a.jpg", "b.jpg", "ignored.txt" }) Files.write(new File(r, name).toPath(), new byte[10]);
      new File(r, "a.jpg").setLastModified(1000); new File(r, "b.jpg").setLastModified(2000);
      LruFileIndex index = new LruFileIndex(r, names, 3, 35);
      check(index.count() == 2 && index.bytes() == 20);
      check(index.hit("a.jpg") != null); // a is now most recent; b is oldest.
      index.reserve(10); Files.write(new File(r, "c.jpg").toPath(), new byte[10]); index.added("c.jpg", 10);
      check(index.count() == 3 && new File(r, "b.jpg").exists());
      index.reserve(10); // Count limit: evicts b.
      check(!new File(r, "b.jpg").exists() && new File(r, "a.jpg").exists() && index.count() == 2);
      Files.write(new File(r, "d.jpg").toPath(), new byte[10]); index.added("d.jpg", 10);
      index.reserve(15); // Byte limit 35: evicts a (oldest after the hit), keeps c and d.
      check(!new File(r, "a.jpg").exists() && index.bytes() == 20 && new File(r, "ignored.txt").exists());
      new File(r, "c.jpg").delete(); check(index.hit("c.jpg") == null && index.count() == 1 && index.bytes() == 10);
      fails("cache-entry-too-large", () -> index.reserve(36));
    });
    test("in-place source preserves exact bytes after its path is gone", () -> {
      File r = root(), archive = zip("memories/2026-02-05_memoryA-main.jpg", bytes);
      String expected = sha(Files.readAllBytes(archive.toPath()));
      FileChannel channel = FileChannel.open(archive.toPath(), StandardOpenOption.READ);
      check(archive.delete()); // Nothing below can reopen the archive by path.
      ArchiveSource source = new ArchiveSource(channel, channel, () -> String.valueOf(channel.size()), new File("/dev/null"));
      check(source.sha256(() -> false).equals(expected));
      try (ArchiveOriginals session = new ArchiveOriginals(source, () -> false)) {
        OriginalStore.Stored saved = session.preserve("memories/2026-02-05_memoryA-main.jpg", new OriginalStore(r), budget(), () -> false);
        check(saved.sha256.equals(sha(bytes)) && Arrays.equals(bytes, Files.readAllBytes(new File(r, saved.relativePath).toPath())));
      }
      check(!channel.isOpen()); emptyStage(r);
    });
    test("unpinned source cannot start extraction", () -> {
      File archive = zip("2026-02-05_memoryA-main.jpg", bytes); ArchiveSource source = ArchiveSource.open(archive);
      fails("source-changed", () -> new ArchiveOriginals(source, () -> false));
      fails(null, () -> source.size()); // Rejected sources are closed.
    });
    test("source rewritten between hash and extraction start is rejected", () -> {
      File archive = zip("2026-02-05_memoryA-main.jpg", bytes); ArchiveSource source = ArchiveSource.open(archive);
      source.sha256(() -> false);
      byte[] content = Files.readAllBytes(archive.toPath()); Files.write(archive.toPath(), content); archive.setLastModified(archive.lastModified() + 5000);
      fails("source-changed", () -> new ArchiveOriginals(source, () -> false));
    });
    test("source rewritten mid-import stops before storing", () -> {
      File r = root(), archive = zip("2026-02-05_memoryA-main.jpg", bytes);
      try (ArchiveOriginals session = session(archive)) {
        byte[] content = Files.readAllBytes(archive.toPath()); content[content.length - 30] ^= 1; // Central directory, same size.
        Files.write(archive.toPath(), content); archive.setLastModified(archive.lastModified() + 5000);
        fails("source-changed", () -> session.preserve("2026-02-05_memoryA-main.jpg", new OriginalStore(r), budget(), () -> false));
      }
      check(objects(r) == 0); emptyStage(r);
    });
    test("source growing mid-import stops before storing", () -> {
      File r = root(), archive = zip("2026-02-05_memoryA-main.jpg", bytes);
      try (ArchiveOriginals session = session(archive)) {
        Files.write(archive.toPath(), new byte[] { 0 }, StandardOpenOption.APPEND);
        fails("source-changed", () -> session.preserve("2026-02-05_memoryA-main.jpg", new OriginalStore(r), budget(), () -> false));
      }
      check(objects(r) == 0);
    });
    test("private copy pinned while copying needs no second hash", () -> {
      File r = root(), archive = zip("2026-02-05_memoryA-overlay.png", bytes);
      ArchiveSource source = ArchiveSource.open(archive); source.pinCopy(sha(Files.readAllBytes(archive.toPath())));
      try (ArchiveOriginals session = new ArchiveOriginals(source, () -> false)) {
        check(session.preserve("2026-02-05_memoryA-overlay.png", new OriginalStore(r), budget(), () -> false).sha256.equals(sha(bytes)));
      }
      ArchiveSource bad = ArchiveSource.open(archive); fails("source-changed", () -> bad.pinCopy("not-a-hash")); bad.close();
    });
    System.out.println(passed + " original-storage host tests passed. No mobile-runtime or completed-import claim.");
  }
}
