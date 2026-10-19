import com.alkval.snarchive.sources.storage.*;
import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.atomic.*;

/** FolderOriginals against a real directory, through a provider that behaves like the Android one: facts by query,
 * reads in place, and a stamp of the open file where it is a regular file. Every case checks the source folder is
 * byte-for-byte unchanged afterward, except where the test itself mutates a file. */
public class FolderOriginalsTest {
  interface Work { void run() throws Exception; }
  static File base; static int passed;
  static void check(boolean ok, String what) { if (!ok) throw new AssertionError(what); }
  static void test(String name, Work work) throws Exception { work.run(); passed++; System.out.println("PASS " + name); }
  static IOException fails(String code, Work work) throws Exception {
    try { work.run(); } catch (IOException e) { check(code.equals(e.getMessage()), "expected " + code + ", got " + e.getMessage()); return e; }
    throw new AssertionError("expected " + code);
  }
  static OriginalStore.Budget budget() { return new OriginalStore.Budget(1L << 30); }
  static String sha(byte[] input) throws Exception {
    StringBuilder hex = new StringBuilder(); for (byte b : MessageDigest.getInstance("SHA-256").digest(input)) hex.append(String.format("%02x", b & 255)); return hex.toString();
  }
  static byte[] bytes(int size, int seed) { byte[] out = new byte[size]; new Random(seed).nextBytes(out); return out; }
  static final String PHOTO = "memories/2026-02-05_one-main.jpg", OVERLAY = "memories/2026-02-05_one-overlay.png",
    VIDEO = "memories/2026-02-06_two-main.mp4", SAME = "memories/2026-02-07_three-main.jpg";

  /** A synthetic extracted export; the photo and SAME have identical bytes (distinct memories). */
  static File folder() throws Exception {
    File root = Files.createTempDirectory(base.toPath(), "folder-").toFile(); new File(root, "memories").mkdirs();
    byte[] photo = bytes(200_000, 1);
    Files.write(new File(root, PHOTO).toPath(), photo); Files.write(new File(root, SAME).toPath(), photo);
    Files.write(new File(root, OVERLAY).toPath(), bytes(70_000, 2)); Files.write(new File(root, VIDEO).toPath(), bytes(300_000, 3));
    return root;
  }
  static Map<String, String> digest(File root) throws Exception {
    Map<String, String> out = new TreeMap<>();
    try (java.util.stream.Stream<Path> paths = Files.walk(root.toPath())) {
      for (Path path : (Iterable<Path>) paths.filter(Files::isRegularFile)::iterator) out.put(root.toPath().relativize(path).toString(), sha(Files.readAllBytes(path)));
    }
    return out;
  }
  static long objectFiles(File store) throws Exception {
    try (java.util.stream.Stream<Path> paths = Files.walk(new File(store, "objects").toPath())) { return paths.filter(Files::isRegularFile).count(); }
  }
  static int staged(File store) { String[] names = new File(store, "staging").list(); return names == null ? 0 : names.length; }

  /** Provider over a directory. mode: "fd" (regular file, length and stamp), "stream" (no length or stamp). */
  static final class Dir implements FolderOriginals.Provider {
    final File root; String mode = "fd"; long reportedBytes = Long.MIN_VALUE; boolean reportSizes = true, reportTimes = true;
    String failOpen; RuntimeException failFacts; Runnable afterFirstChunk;
    Dir(File root) { this.root = root; }
    Path path(String id) { return new File(root, id).toPath(); }
    public FolderOriginals.Facts facts(String id) throws IOException {
      if (failFacts != null) throw failFacts;
      Path path = path(id); if (!Files.exists(path)) return null;
      long size = reportedBytes != Long.MIN_VALUE ? reportedBytes : Files.size(path);
      return new FolderOriginals.Facts(reportSizes ? size : -1, reportTimes ? Files.getLastModifiedTime(path).toMillis() : -1);
    }
    public FolderOriginals.Opened open(String id) throws IOException {
      if (failOpen != null) throw new IOException(failOpen);
      Path path = path(id);
      AtomicBoolean closed = new AtomicBoolean();
      InputStream input = new FilterInputStream(Files.newInputStream(path)) {
        boolean first = true;
        @Override public void close() throws IOException { closed.set(true); super.close(); }
        @Override public int read(byte[] b, int off, int len) throws IOException {
          int n = super.read(b, off, len);
          if (first && n > 0 && afterFirstChunk != null) { first = false; afterFirstChunk.run(); }
          return n;
        }
      };
      if (mode.equals("stream")) return new FolderOriginals.Opened(input, -1, null);
      return new FolderOriginals.Opened(input, Files.size(path), () -> {
        // As on Android, the stamp is an fstat of the open descriptor: it cannot be read once the stream is closed.
        if (closed.get()) throw new IOException("EBADF");
        try { return Files.readAttributes(path, "unix:ino,dev,size,lastModifiedTime,ctime").toString(); }
        catch (NoSuchFileException e) { throw new IOException("gone"); }
      });
    }
  }
  static Map<String, FolderOriginals.Entry> scan(Dir dir) throws Exception {
    Map<String, FolderOriginals.Entry> out = new HashMap<>();
    for (String path : new String[] { PHOTO, OVERLAY, VIDEO, SAME }) out.put(path, new FolderOriginals.Entry(path, dir.facts(path)));
    return out;
  }
  static OriginalStore store() throws Exception { return new OriginalStore(Files.createTempDirectory(base.toPath(), "store-").toFile()); }
  static File storeRoot(OriginalStore store) throws Exception {
    java.lang.reflect.Field field = OriginalStore.class.getDeclaredField("root"); field.setAccessible(true); return (File) field.get(store);
  }

  public static void main(String[] args) throws Exception {
    if (args[0].equals("crash-folder")) { crashChild(new File(args[1]), new File(args[2])); return; }
    base = Files.createTempDirectory(Paths.get(args[0]), "folder-run-").toFile();

    test("exact bytes for photo, overlay and video; distinct memories with identical bytes share one object", () -> {
      File root = folder(); Map<String, String> before = digest(root); Dir dir = new Dir(root); OriginalStore store = store();
      FolderOriginals folder = new FolderOriginals(dir, scan(dir));
      for (String path : new String[] { PHOTO, OVERLAY, VIDEO }) {
        OriginalStore.Stored stored = folder.preserve(path, store, budget(), () -> false);
        check(stored.sha256.equals(sha(Files.readAllBytes(new File(root, path).toPath()))) && !stored.reused, "exact " + path);
        check(Arrays.equals(Files.readAllBytes(new File(root, path).toPath()), Files.readAllBytes(store.confirm(stored.sha256, stored.bytes).toPath())), "bytes " + path);
      }
      OriginalStore.Stored same = folder.preserve(SAME, store, budget(), () -> false);
      check(same.reused && same.sha256.equals(sha(Files.readAllBytes(new File(root, PHOTO).toPath()))), "identical bytes reuse the object");
      check(staged(storeRoot(store)) == 0 && digest(root).equals(before), "no staging; source unchanged");
    });
    test("a file deleted after the scan is source-missing and nothing is stored", () -> {
      File root = folder(); Dir dir = new Dir(root); FolderOriginals folder = new FolderOriginals(dir, scan(dir)); OriginalStore store = store();
      Files.delete(new File(root, PHOTO).toPath());
      fails("source-missing", () -> folder.preserve(PHOTO, store, budget(), () -> false));
      fails("source-missing", () -> folder.preserve("memories/2026-02-08_absent-main.jpg", store, budget(), () -> false));
      check(staged(storeRoot(store)) == 0, "nothing staged");
    });
    test("an inaccessible file is source-unreadable, without the provider's message", () -> {
      File root = folder(); Dir dir = new Dir(root); FolderOriginals folder = new FolderOriginals(dir, scan(dir)); OriginalStore store = store();
      dir.failOpen = "/private/user/path/secret.jpg: permission denied";
      fails("source-unreadable", () -> folder.preserve(PHOTO, store, budget(), () -> false));
      dir.failOpen = null; dir.failFacts = new SecurityException("Permission Denial: /private/user/path");
      fails("source-unreadable", () -> folder.preserve(PHOTO, store, budget(), () -> false));
      dir.failFacts = null; File file = new File(root, VIDEO); check(file.setReadable(false), "chmod");
      try { fails("source-unreadable", () -> folder.preserve(VIDEO, store, budget(), () -> false)); } finally { file.setReadable(true); }
      check(staged(storeRoot(store)) == 0, "nothing staged");
    });
    test("unavailable provider sizes: a stream is copied by its actual bytes, and the budget applies to them", () -> {
      File root = folder(); Map<String, String> before = digest(root); Dir dir = new Dir(root); dir.mode = "stream"; dir.reportSizes = false; dir.reportTimes = false;
      FolderOriginals folder = new FolderOriginals(dir, scan(dir)); OriginalStore store = store();
      check(folder.scannedBytes(PHOTO) == -1 && folder.knownBytes(Arrays.asList(PHOTO, VIDEO)) == 0, "unknown sizes");
      OriginalStore.Stored stored = folder.preserve(VIDEO, store, budget(), () -> false);
      check(stored.bytes == 300_000 && stored.sha256.equals(sha(Files.readAllBytes(new File(root, VIDEO).toPath()))), "actual bytes");
      fails("byte-limit", () -> folder.preserve(PHOTO, store, new OriginalStore.Budget(100_000), () -> false));
      check(staged(storeRoot(store)) == 0 && digest(root).equals(before), "nothing staged; source unchanged");
    });
    test("an incorrect provider size: an open regular file's own length governs; a stream that disagrees is rejected", () -> {
      File root = folder(); Dir dir = new Dir(root); dir.reportedBytes = 123; FolderOriginals folder = new FolderOriginals(dir, scan(dir)); OriginalStore store = store();
      check(folder.preserve(PHOTO, store, budget(), () -> false).bytes == 200_000, "fstat length used");
      dir.mode = "stream";
      fails("source-changed", () -> folder.preserve(VIDEO, store, budget(), () -> false));
      check(staged(storeRoot(store)) == 0, "nothing staged");
    });
    test("a file changed between the scan and the copy is source-changed", () -> {
      File root = folder(); Dir dir = new Dir(root); FolderOriginals folder = new FolderOriginals(dir, scan(dir)); OriginalStore store = store();
      Files.write(new File(root, PHOTO).toPath(), bytes(150_000, 9)); // Truncated and rewritten: a new length.
      fails("source-changed", () -> folder.preserve(PHOTO, store, budget(), () -> false));
      Path video = new File(root, VIDEO).toPath(); Files.write(video, bytes(300_000, 10)); // Same length, newer time.
      Files.setLastModifiedTime(video, FileTime.fromMillis(Files.getLastModifiedTime(video).toMillis() + 5000));
      fails("source-changed", () -> folder.preserve(VIDEO, store, budget(), () -> false));
      check(staged(storeRoot(store)) == 0, "nothing staged");
    });
    test("truncation, growth, replacement and an in-place rewrite during the copy are rejected before finalizing", () -> {
      for (String change : new String[] { "truncate", "grow", "replace", "rewrite" }) {
        File root = folder(); Dir dir = new Dir(root); FolderOriginals folder = new FolderOriginals(dir, scan(dir)); OriginalStore store = store();
        Path video = new File(root, VIDEO).toPath();
        dir.afterFirstChunk = () -> { try {
          if (change.equals("truncate")) try (RandomAccessFile file = new RandomAccessFile(video.toFile(), "rw")) { file.setLength(100_000); }
          if (change.equals("grow")) Files.write(video, bytes(10, 4), StandardOpenOption.APPEND);
          if (change.equals("replace")) { Path next = video.resolveSibling("next.tmp"); Files.write(next, bytes(300_000, 5)); Files.move(next, video, StandardCopyOption.REPLACE_EXISTING); }
          if (change.equals("rewrite")) { FileTime time = Files.getLastModifiedTime(video); Thread.sleep(20);
            try (RandomAccessFile file = new RandomAccessFile(video.toFile(), "rw")) { file.seek(250_000); file.write(bytes(100, 6)); }
            Files.setLastModifiedTime(video, time); } // Restoring the time does not hide it: the change time moved.
        } catch (Exception e) { throw new RuntimeException(e); } };
        fails("source-changed", () -> folder.preserve(VIDEO, store, budget(), () -> false));
        check(staged(storeRoot(store)) == 0 && objectFiles(storeRoot(store)) == 0, change + ": nothing finalized");
      }
    });
    test("insufficient storage stops before finalizing and leaves no staging", () -> {
      File root = folder(); Dir dir = new Dir(root); FolderOriginals folder = new FolderOriginals(dir, scan(dir));
      OriginalStore store = new OriginalStore(Files.createTempDirectory(base.toPath(), "store-").toFile(), d -> OriginalStore.RESERVE + 1_000, p -> {});
      fails("insufficient-storage", () -> folder.preserve(VIDEO, store, budget(), () -> false));
      check(staged(storeRoot(store)) == 0, "nothing staged");
    });
    test("a corrupt existing original is reported and never overwritten", () -> {
      File root = folder(); Dir dir = new Dir(root); FolderOriginals folder = new FolderOriginals(dir, scan(dir)); OriginalStore store = store();
      OriginalStore.Stored stored = folder.preserve(PHOTO, store, budget(), () -> false);
      File object = store.confirm(stored.sha256, stored.bytes); byte[] damaged = Files.readAllBytes(object.toPath()); damaged[7] ^= 1;
      Files.write(object.toPath(), damaged);
      fails("stored-object-corrupt", () -> folder.preserve(SAME, store, budget(), () -> false));
      check(Arrays.equals(damaged, Files.readAllBytes(object.toPath())), "not overwritten");
    });
    test("cancellation during the copy and just before finalizing stores nothing; after finalizing, a retry reuses", () -> {
      File root = folder(); Dir dir = new Dir(root); FolderOriginals folder = new FolderOriginals(dir, scan(dir));
      AtomicBoolean stop = new AtomicBoolean(); File storeDir = Files.createTempDirectory(base.toPath(), "store-").toFile();
      OriginalStore during = new OriginalStore(storeDir, File::getUsableSpace, p -> { if (p.equals("after-chunk")) stop.set(true); });
      fails("cancelled", () -> folder.preserve(VIDEO, during, budget(), stop::get)); stop.set(false);
      OriginalStore beforeFinalize = new OriginalStore(storeDir, File::getUsableSpace, p -> { if (p.equals("before-finalize")) stop.set(true); });
      fails("cancelled", () -> folder.preserve(VIDEO, beforeFinalize, budget(), stop::get)); stop.set(false);
      check(staged(storeDir) == 0 && objectFiles(storeDir) == 0, "nothing stored");
      OriginalStore afterFinalize = new OriginalStore(storeDir, File::getUsableSpace, p -> { if (p.equals("after-finalize")) throw new IOException("injected-after-finalize"); });
      fails("injected-after-finalize", () -> folder.preserve(VIDEO, afterFinalize, budget(), () -> false));
      check(folder.preserve(VIDEO, new OriginalStore(storeDir), budget(), () -> false).reused, "the finalized object is verified and reused");
    });
    test("a staged part that cannot be deleted is attached to source-changed, not put in its place", () -> {
      File root = folder(); Dir dir = new Dir(root); FolderOriginals folder = new FolderOriginals(dir, scan(dir));
      File storeDir = Files.createTempDirectory(base.toPath(), "store-").toFile(); OriginalStore store = new OriginalStore(storeDir);
      File staging = new File(storeDir, "staging"); Path video = new File(root, VIDEO).toPath();
      dir.afterFirstChunk = () -> { try { Files.write(video, bytes(10, 7), StandardOpenOption.APPEND); } catch (IOException e) { throw new UncheckedIOException(e); } check(staging.setWritable(false), "locked"); };
      IOException error;
      try { error = fails("source-changed", () -> folder.preserve(VIDEO, store, budget(), () -> false)); } finally { check(staging.setWritable(true), "unlocked"); }
      check(Arrays.stream(error.getSuppressed()).anyMatch(s -> OriginalStore.STAGING_CLEANUP_FAILED.equals(s.getMessage())), "store cleanup failure attached");
      check(staged(storeDir) == 1 && store.recoverStaging() == 1 && staged(storeDir) == 0, "recovered once deletion is possible");
    });
    test("a process killed mid-copy leaves only recoverable staging; a retry completes with exact bytes", () -> {
      File root = folder(); Map<String, String> before = digest(root); File storeDir = Files.createTempDirectory(base.toPath(), "store-").toFile();
      Process child = new ProcessBuilder(new File(System.getProperty("java.home"), "bin/java").getPath(), "-cp", System.getProperty("java.class.path"),
        "FolderOriginalsTest", "crash-folder", root.getPath(), storeDir.getPath()).inheritIO().start();
      check(child.waitFor() == 23, "child halted mid-copy");
      OriginalStore store = new OriginalStore(storeDir); check(store.recoverStaging() == 1 && staged(storeDir) == 0, "part removed");
      Dir dir = new Dir(root); OriginalStore.Stored stored = new FolderOriginals(dir, scan(dir)).preserve(VIDEO, store, budget(), () -> false);
      check(!stored.reused && stored.sha256.equals(sha(Files.readAllBytes(new File(root, VIDEO).toPath()))), "retry stores exact bytes");
      check(digest(root).equals(before), "source unchanged");
    });
    test("only recognized media names in this run's scan can be preserved", () -> {
      File root = folder(); Dir dir = new Dir(root); FolderOriginals folder = new FolderOriginals(dir, scan(dir)); OriginalStore store = store();
      fails("unsupported-entry", () -> folder.preserve("memories/memories_history.json", store, budget(), () -> false));
      fails("unsupported-entry", () -> folder.preserve("memories/notes.txt", store, budget(), () -> false));
    });
    System.out.println(passed + " folder preservation host tests passed. No device claim.");
  }

  /** Child process: halts (as a killed app would) after the first chunk of a folder file is staged. */
  static void crashChild(File root, File storeDir) throws Exception {
    OriginalStore store = new OriginalStore(storeDir, File::getUsableSpace, p -> { if (p.equals("after-chunk")) Runtime.getRuntime().halt(23); });
    Dir dir = new Dir(root); new FolderOriginals(dir, scan(dir)).preserve(VIDEO, store, budget(), () -> false);
    throw new AssertionError("crash point not reached");
  }
}
