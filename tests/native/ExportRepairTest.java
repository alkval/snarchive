import com.alkval.snarchive.sources.storage.*;
import com.alkval.snarchive.sources.backup.InspectionGate;
import com.alkval.snarchive.sources.zip.ArchiveSource;
import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.FileTime;
import java.util.*;
import java.util.concurrent.atomic.*;
import java.util.zip.*;

/** Production export readers, repair operation and session over synthetic files. No Android/device claim. */
public class ExportRepairTest extends FolderOriginalsTest {
  static File zip(File folder) throws Exception {
    File zip = File.createTempFile("export-", ".zip", base);
    try (ZipOutputStream out = new ZipOutputStream(new FileOutputStream(zip))) {
      for (String path : new String[] { PHOTO, OVERLAY, VIDEO, SAME }) {
        out.putNextEntry(new ZipEntry(path)); out.write(Files.readAllBytes(new File(folder, path).toPath())); out.closeEntry();
      }
    }
    return zip;
  }
  static ExportRepairSession archive(File zip, Closeable cleanup) throws Exception {
    ArchiveSource source = ArchiveSource.open(zip); source.sha256(() -> false);
    return new ExportRepairSession(new ArchiveOriginals(source, () -> false), cleanup);
  }
  static File target(OriginalStore store, String hash) throws Exception {
    return new File(storeRoot(store), "objects/" + hash.substring(0, 2) + "/" + hash);
  }
  static void damage(OriginalStore store, byte[] good) throws Exception {
    store.put(new ByteArrayInputStream(good), good.length, -1, budget(), () -> false);
    byte[] bad = good.clone(); bad[0] ^= 1; Files.write(target(store, sha(good)).toPath(), bad);
  }
  static ExportRepairSession.Result repair(ExportRepairSession session, OriginalStore store, String path, byte[] expected) throws Exception {
    return session.repair(store, path, sha(expected), expected.length, () -> false, () -> {}, () -> {});
  }
  public static void main(String[] args) throws Exception {
    base = Files.createTempDirectory(Paths.get(args[0]), "export-repair-").toFile();
    test("ZIP photo, overlay and video repairs are exact; the archive stays unchanged", () -> {
      File folder = folder(), zip = zip(folder); byte[] originalZip = Files.readAllBytes(zip.toPath()); OriginalStore store = store();
      try (ExportRepairSession session = archive(zip, null)) {
        check(session.archiveSha256().equals(sha(originalZip)), "pinned identity");
        for (String path : new String[] { PHOTO, OVERLAY, VIDEO }) {
          byte[] good = Files.readAllBytes(new File(folder, path).toPath()); damage(store, good);
          check(repair(session, store, path, good).outcome.equals("repaired"), "repaired");
          check(Arrays.equals(good, Files.readAllBytes(target(store, sha(good)).toPath())), "exact bytes");
        }
      }
      check(Arrays.equals(originalZip, Files.readAllBytes(zip.toPath())), "source unchanged");
    });
    test("folder repair reads exact bytes without requiring an old inventory; unused new files are untouched", () -> {
      File root = folder(); Files.write(new File(root, "new-note.txt").toPath(), new byte[] { 1 }); Map<String, String> before = digest(root);
      Dir provider = new Dir(root); OriginalStore store = store(); byte[] good = Files.readAllBytes(new File(root, PHOTO).toPath());
      try (ExportRepairSession session = new ExportRepairSession(new FolderOriginals(provider, scan(provider)))) {
        check(repair(session, store, PHOTO, good).outcome.equals("repaired"), "missing target filled");
        check(session.archiveSha256() == null && digest(root).equals(before), "folder unchanged");
      }
    });
    test("wrong bytes or length never replace an original, from either kind of source", () -> {
      File root = folder(), zip = zip(root); Dir provider = new Dir(root);
      byte[] expected = bytes(200_000, 99);
      for (boolean folder : new boolean[] { false, true }) {
        OriginalStore store = store(); damage(store, expected); byte[] before = Files.readAllBytes(target(store, sha(expected)).toPath());
        try (ExportRepairSession session = folder ? new ExportRepairSession(new FolderOriginals(provider, scan(provider))) : archive(zip, null)) {
          check(repair(session, store, PHOTO, expected).outcome.equals("mismatch"), "wrong hash");
          check(repair(session, store, PHOTO, Arrays.copyOf(expected, 100)).outcome.equals("mismatch"), "wrong size");
        }
        check(Arrays.equals(before, Files.readAllBytes(target(store, sha(expected)).toPath())) && staged(storeRoot(store)) == 0, "target unchanged");
      }
    });
    test("a folder changed during reading is refused even when the bytes read would hash correctly", () -> {
      File root = folder(); Dir provider = new Dir(root); OriginalStore store = store(); byte[] good = Files.readAllBytes(new File(root, PHOTO).toPath()); damage(store, good);
      FolderOriginals reader = new FolderOriginals(provider, scan(provider));
      provider.afterFirstChunk = () -> { try { Path p = new File(root, PHOTO).toPath(); Files.setLastModifiedTime(p, FileTime.fromMillis(Files.getLastModifiedTime(p).toMillis() + 5000)); } catch (IOException e) { throw new RuntimeException(e); } };
      try (ExportRepairSession session = new ExportRepairSession(reader)) {
        fails("source-changed", () -> repair(session, store, PHOTO, good));
      }
      check(store.inspect(sha(good), good.length, () -> false) == OriginalStore.Health.DAMAGED && staged(storeRoot(store)) == 0, "not finalized");
    });
    test("a ZIP changing during staging stops before replacement and keeps any staging cleanup failure", () -> {
      File root = folder(), zip = zip(root); byte[] good = Files.readAllBytes(new File(root, PHOTO).toPath()); OriginalStore seed = store(); damage(seed, good);
      File storeRoot = storeRoot(seed), staging = new File(storeRoot, "staging");
      OriginalStore store = new OriginalStore(storeRoot, File::getUsableSpace, p -> {
        if (p.equals("after-chunk")) { zip.setLastModified(zip.lastModified() + 5000); staging.setWritable(false); }
      });
      try (ExportRepairSession session = archive(zip, null)) {
        IOException error;
        try { error = fails("source-changed", () -> repair(session, store, PHOTO, good)); } finally { staging.setWritable(true); }
        check(InspectionGate.storeCleanupFailed(error), "leftover retained");
      }
      check(seed.inspect(sha(good), good.length, () -> false) == OriginalStore.Health.DAMAGED, "unchanged");
    });
    test("a valid original is left untouched, with no eviction, even when the source path has other bytes", () -> {
      File root = folder(); Dir provider = new Dir(root); OriginalStore store = store(); byte[] good = bytes(100, 90);
      store.put(new ByteArrayInputStream(good), good.length, -1, budget(), () -> false);
      target(store, sha(good)).setLastModified(1_600_000_000_000L); AtomicInteger evictions = new AtomicInteger();
      try (ExportRepairSession session = new ExportRepairSession(new FolderOriginals(provider, scan(provider)))) {
        check(session.repair(store, PHOTO, sha(good), good.length, () -> false, evictions::incrementAndGet, evictions::incrementAndGet).outcome.equals("already_valid"), "already valid");
      }
      check(target(store, sha(good)).lastModified() == 1_600_000_000_000L && evictions.get() == 0, "untouched");
    });
    test("missing and unreadable source paths use safe codes, and cancellation stores nothing", () -> {
      File root = folder(); Dir provider = new Dir(root); OriginalStore store = store(); byte[] good = Files.readAllBytes(new File(root, PHOTO).toPath());
      try (ExportRepairSession session = new ExportRepairSession(new FolderOriginals(provider, scan(provider)))) {
        fails("source-missing", () -> repair(session, store, "memories/2026-02-08_missing-main.jpg", good));
        fails("export-unreadable", () -> session.repair(store, PHOTO, "../invalid", good.length, () -> false, () -> {}, () -> {}));
        provider.failOpen = "private provider path"; IOException error = fails("source-unreadable", () -> repair(session, store, PHOTO, good));
        check(ExportRepairSession.code(error, false).equals("source-unreadable"), "sanitized");
      }
      provider.failOpen = null; AtomicBoolean stop = new AtomicBoolean(); provider.afterFirstChunk = () -> stop.set(true);
      try (ExportRepairSession session = new ExportRepairSession(new FolderOriginals(provider, scan(provider)))) {
        fails("cancelled", () -> session.repair(store, PHOTO, sha(good), good.length, stop::get, () -> {}, () -> {}));
      }
      check(!target(store, sha(good)).exists() && staged(storeRoot(store)) == 0, "nothing finalized");
      // A store rejection before it owns the stream must still close the provider input exactly once.
      provider.afterFirstChunk = null; AtomicInteger closes = new AtomicInteger();
      FolderOriginals.Provider counted = new FolderOriginals.Provider() {
        public FolderOriginals.Facts facts(String id) throws IOException { return provider.facts(id); }
        public FolderOriginals.Opened open(String id) throws IOException {
          FolderOriginals.Opened opened = provider.open(id);
          return new FolderOriginals.Opened(new FilterInputStream(opened.input) {
            @Override public void close() throws IOException { closes.incrementAndGet(); super.close(); }
          }, opened.bytes, opened.stamp);
        }
      };
      OriginalStore unsafe = store(); File outside = Files.createTempDirectory(base.toPath(), "outside-").toFile();
      Files.createSymbolicLink(new File(storeRoot(unsafe), "objects/" + sha(good).substring(0, 2)).toPath(), outside.toPath());
      try (ExportRepairSession session = new ExportRepairSession(new FolderOriginals(counted, scan(provider)))) {
        fails("unsafe-storage-path", () -> repair(session, unsafe, PHOTO, good));
      }
      check(closes.get() == 1, "provider input closed on early store rejection");
    });
    test("sync and eviction warnings both survive a completed repair", () -> {
      File root = folder(); Dir provider = new Dir(root); OriginalStore seed = store(); byte[] good = Files.readAllBytes(new File(root, PHOTO).toPath()); damage(seed, good);
      OriginalStore faulty = new OriginalStore(storeRoot(seed), File::getUsableSpace, p -> { if (p.equals("sync-object-directory")) throw new IOException("injected"); });
      try (ExportRepairSession session = new ExportRepairSession(new FolderOriginals(provider, scan(provider)))) {
        ExportRepairSession.Result result = session.repair(faulty, PHOTO, sha(good), good.length, () -> false, () -> {}, () -> { throw new IOException("injected"); });
        check(result.outcome.equals("repaired") && result.warnings.equals(Arrays.asList("sync-failed", "thumbnail-eviction-failed")), "both warnings");
      }
      check(seed.inspect(sha(good), good.length, () -> false) == OriginalStore.Health.VALID, "repaired");
    });
    test("gate teardown closes the archive and attempts private-copy cleanup before releasing once", () -> {
      File root = folder(), zip = zip(root); AtomicInteger released = new AtomicInteger(), cleaned = new AtomicInteger();
      InspectionGate<ExportRepairSession> gate = new InspectionGate<>(Runnable::run, e -> ExportRepairSession.code(e, false), released::incrementAndGet);
      check(gate.begin(() -> archive(zip, () -> { cleaned.incrementAndGet(); throw new IOException("backup-cleanup-failed"); })) == null, "opened");
      check(gate.finish().equals("backup-cleanup-failed") && released.get() == 1 && cleaned.get() == 1, "cleanup then release");
      check(gate.finish() == null && released.get() == 1, "no double release");
      // An exceptional descriptor close must not skip deleting the owned private copy.
      java.nio.channels.FileChannel channel = java.nio.channels.FileChannel.open(zip.toPath(), StandardOpenOption.READ);
      ArchiveSource source = new ArchiveSource(channel, () -> { channel.close(); throw new RuntimeException("close-failed"); }, () -> "stable", zip);
      source.sha256(() -> false);
      AtomicInteger attempted = new AtomicInteger();
      ExportRepairSession closing = new ExportRepairSession(new ArchiveOriginals(source, () -> false), attempted::incrementAndGet);
      try { closing.close(); throw new AssertionError("expected close failure"); }
      catch (RuntimeException expected) { check(expected.getMessage().equals("close-failed"), "original close failure"); }
      closing.close(); check(attempted.get() == 1, "private cleanup still ran, once");
    });
    System.out.println(passed + " export repair host tests passed. No device claim.");
  }
}
