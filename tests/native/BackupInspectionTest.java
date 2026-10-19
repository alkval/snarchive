import com.alkval.snarchive.sources.backup.BackupInspection;
import com.alkval.snarchive.sources.backup.BackupWriter;
import com.alkval.snarchive.sources.backup.BackupWriter.ObjectSpec;
import com.alkval.snarchive.sources.backup.DeleteOnClose;
import com.alkval.snarchive.sources.backup.InspectionGate;
import com.alkval.snarchive.sources.storage.OriginalStore;
import com.alkval.snarchive.sources.zip.ArchiveSource;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.BooleanSupplier;
import java.util.zip.CRC32;

public class BackupInspectionTest {
  interface Work { void run() throws Exception; }
  static int passed; static File root; static OriginalStore store;
  static void check(boolean ok, String what) { if (!ok) throw new AssertionError(what); }
  static void test(String name, Work work) throws Exception { work.run(); passed++; System.out.println("PASS " + name); }
  /** The code the bridge would report for whatever this throws. */
  static void fails(String code, Work work) throws Exception {
    try { work.run(); } catch (Exception e) { String actual = BackupInspection.code(e, false); check(code.equals(actual), "expected " + code + ", got " + actual + " (" + e + ")"); return; }
    throw new AssertionError("expected " + code);
  }
  static String sha(byte[] input) throws Exception {
    StringBuilder hex = new StringBuilder(); for (byte b : MessageDigest.getInstance("SHA-256").digest(input)) hex.append(String.format("%02x", b & 255)); return hex.toString();
  }
  static OriginalStore.Stored put(String text) throws Exception {
    byte[] value = text.getBytes(StandardCharsets.UTF_8);
    return store.put(new ByteArrayInputStream(value), value.length, -1, new OriginalStore.Budget(1 << 20), () -> false);
  }
  static String manifest(List<OriginalStore.Stored> objects, String extraLine) {
    List<OriginalStore.Stored> sorted = new ArrayList<>(objects); sorted.sort(Comparator.comparing(o -> o.sha256));
    StringBuilder text = new StringBuilder("{\"type\":\"header\",\"format\":\"snarchive-backup\",\"version\":1}\n");
    long bytes = 0;
    for (OriginalStore.Stored o : sorted) { text.append("{\"type\":\"object\",\"sha256\":\"").append(o.sha256).append("\",\"relativePath\":\"").append(o.relativePath).append("\",\"bytes\":").append(o.bytes).append("}\n"); bytes += o.bytes; }
    if (extraLine != null) text.append(extraLine).append('\n');
    return text.append("{\"type\":\"end\",\"records\":").append(sorted.size() + 1 + (extraLine == null ? 0 : 1)).append(",\"objects\":").append(sorted.size()).append(",\"originalBytes\":").append(bytes).append("}\n").toString();
  }
  /** A backup produced by the current exporter. */
  static File export(String manifestText, List<OriginalStore.Stored> objects, File dir) throws Exception {
    File manifest = File.createTempFile("manifest-", ".jsonl", dir); Files.write(manifest.toPath(), manifestText.getBytes(StandardCharsets.UTF_8));
    List<ObjectSpec> specs = new ArrayList<>(); for (OriginalStore.Stored o : objects) specs.add(new ObjectSpec(o.sha256, o.bytes));
    File backup = File.createTempFile("backup-", ".zip", dir);
    try (OutputStream out = new FileOutputStream(backup)) { BackupWriter.write(store, manifest, specs, out, dir, File::getUsableSpace, () -> false); }
    return backup;
  }
  static BackupInspection open(File backup, Closeable cleanup, BooleanSupplier stop) throws Exception { return BackupInspection.open(ArchiveSource.open(backup), cleanup, stop); }
  static String readAll(BackupInspection inspection, int chunk) throws Exception {
    StringBuilder text = new StringBuilder();
    for (;;) { BackupInspection.Chunk next = inspection.readManifest(chunk, () -> false); text.append(next.text); if (next.done) return text.toString(); }
  }
  static void declareAll(BackupInspection inspection, List<OriginalStore.Stored> objects) throws Exception { for (OriginalStore.Stored o : objects) inspection.declare(o.sha256, o.bytes); }
  static BackupInspection.Progress verifyAll(BackupInspection inspection, BooleanSupplier stop) throws Exception {
    for (;;) { BackupInspection.Progress p = inspection.verify(0, stop); if (p.done) return p; }
  }
  static List<String> listing(File dir) throws Exception {
    try (java.util.stream.Stream<Path> paths = Files.walk(dir.toPath())) { List<String> out = new ArrayList<>(); paths.forEach(p -> out.add(dir.toPath().relativize(p) + ":" + p.toFile().length())); Collections.sort(out); return out; }
  }

  /** Stored entries written by hand, so tests can build archives java.util.zip refuses to: duplicates,
   * encrypted flags, directories, invalid UTF-8. */
  static final class RawZip {
    final ByteArrayOutputStream body = new ByteArrayOutputStream(), central = new ByteArrayOutputStream(); int count;
    static void le(ByteArrayOutputStream out, long value, int bytes) { for (int i = 0; i < bytes; i++) out.write((int)(value >>> (8 * i)) & 255); }
    RawZip add(String name, byte[] data) { return add(name, data, 0); }
    RawZip add(String name, byte[] data, int flags) {
      byte[] n = name.getBytes(StandardCharsets.UTF_8); CRC32 crc = new CRC32(); crc.update(data); int offset = body.size();
      le(body, 0x04034b50L, 4); le(body, 20, 2); le(body, flags, 2); le(body, 0, 2); le(body, 0, 2); le(body, 0x21, 2);
      le(body, crc.getValue(), 4); le(body, data.length, 4); le(body, data.length, 4); le(body, n.length, 2); le(body, 0, 2);
      body.write(n, 0, n.length); body.write(data, 0, data.length);
      le(central, 0x02014b50L, 4); le(central, 20, 2); le(central, 20, 2); le(central, flags, 2); le(central, 0, 2); le(central, 0, 2); le(central, 0x21, 2);
      le(central, crc.getValue(), 4); le(central, data.length, 4); le(central, data.length, 4); le(central, n.length, 2); le(central, 0, 2); le(central, 0, 2);
      le(central, 0, 2); le(central, 0, 2); le(central, 0, 4); le(central, offset, 4); central.write(n, 0, n.length);
      count++; return this;
    }
    File write(File dir) throws Exception {
      ByteArrayOutputStream out = new ByteArrayOutputStream(); body.writeTo(out); int centralOffset = out.size(); central.writeTo(out);
      le(out, 0x06054b50L, 4); le(out, 0, 2); le(out, 0, 2); le(out, count, 2); le(out, count, 2); le(out, central.size(), 4); le(out, centralOffset, 4); le(out, 0, 2);
      File file = File.createTempFile("raw-", ".zip", dir); Files.write(file.toPath(), out.toByteArray()); return file;
    }
  }

  public static void main(String[] args) throws Exception {
    root = Files.createTempDirectory(Paths.get(args[0]), "inspection-").toFile();
    store = new OriginalStore(new File(root, "originals"));
    OriginalStore.Stored a = put("synthetic original A"), b = put("synthetic original B, a little longer");
    List<OriginalStore.Stored> both = Arrays.asList(a, b);
    // A non-ASCII line across chunk edges exercises surrogate handling; the JS reader validates the JSON itself.
    String text = manifest(both, "{\"type\":\"favorite\",\"memoryId\":\"mø🙂\"}");
    File valid = export(text, both, root);

    test("exporter output: manifest text, declarations and every object verify", () -> {
      byte[] before = Files.readAllBytes(valid.toPath()); List<String> originalsBefore = listing(new File(root, "originals"));
      AtomicInteger cleaned = new AtomicInteger();
      try (BackupInspection inspection = open(valid, cleaned::incrementAndGet, () -> false)) {
        check(inspection.objectCount() == 2 && inspection.objectBytes() == a.bytes + b.bytes, "catalog");
        check(readAll(inspection, 7).equals(text), "manifest text survives 7-char chunks");
        declareAll(inspection, both); inspection.seal();
        BackupInspection.Progress done = verifyAll(inspection, () -> false);
        check(done.verified == 2 && done.bytes == a.bytes + b.bytes, "progress");
      }
      check(cleaned.get() == 1, "cleanup ran once");
      check(Arrays.equals(before, Files.readAllBytes(valid.toPath())), "backup unchanged");
      check(originalsBefore.equals(listing(new File(root, "originals"))), "originals store unchanged");
    });
    test("empty library backup verifies with no objects", () -> {
      String empty = manifest(Collections.emptyList(), null); File backup = export(empty, Collections.emptyList(), root);
      try (BackupInspection inspection = open(backup, null, () -> false)) {
        check(readAll(inspection, 64).equals(empty), "text"); inspection.seal(); check(inspection.verify(0, () -> false).done, "done");
      }
    });
    test("declared object missing from the archive is damage", () -> {
      File backup = export(manifest(both, null), Collections.singletonList(a), root);
      try (BackupInspection inspection = open(backup, null, () -> false)) {
        readAll(inspection, 4096); inspection.declare(a.sha256, a.bytes); fails("backup-damaged", () -> inspection.declare(b.sha256, b.bytes));
      }
    });
    test("an object the manifest does not declare is rejected", () -> {
      try (BackupInspection inspection = open(valid, null, () -> false)) {
        readAll(inspection, 4096); inspection.declare(a.sha256, a.bytes); fails("backup-invalid", inspection::seal);
      }
    });
    test("wrong declared size and duplicate declarations are rejected", () -> {
      try (BackupInspection inspection = open(valid, null, () -> false)) {
        fails("backup-invalid", () -> inspection.declare(a.sha256, a.bytes + 1));
        inspection.declare(a.sha256, a.bytes); fails("backup-invalid", () -> inspection.declare(a.sha256, a.bytes));
        fails("backup-invalid", () -> inspection.declare("../" + a.sha256.substring(3), 1));
        fails("backup-invalid", inspection::seal); // Manifest not yet read to its end.
      }
    });
    test("same-length object corruption fails verification", () -> {
      byte[] bytes = Files.readAllBytes(valid.toPath()); byte[] payload = "synthetic original B".getBytes(StandardCharsets.UTF_8);
      int at = indexOf(bytes, payload); check(at > 0, "payload found"); bytes[at + 3] ^= 1;
      File damaged = File.createTempFile("damaged-", ".zip", root); Files.write(damaged.toPath(), bytes);
      try (BackupInspection inspection = open(damaged, null, () -> false)) {
        readAll(inspection, 4096); declareAll(inspection, both); inspection.seal();
        fails("backup-damaged", () -> verifyAll(inspection, () -> false));
      }
    });
    test("corrupted manifest bytes fail before any record is trusted", () -> {
      byte[] bytes = Files.readAllBytes(valid.toPath()); int at = indexOf(bytes, "snarchive-backup".getBytes(StandardCharsets.UTF_8)); bytes[at] ^= 1;
      File damaged = File.createTempFile("damaged-", ".zip", root); Files.write(damaged.toPath(), bytes);
      try (BackupInspection inspection = open(damaged, null, () -> false)) { fails("backup-damaged", () -> readAll(inspection, 4096)); }
    });
    test("invalid UTF-8 in the manifest is rejected", () -> {
      File raw = new RawZip().add("manifest.jsonl", new byte[] { '{', (byte) 0xC3, '}', '\n' }).write(root);
      try (BackupInspection inspection = open(raw, null, () -> false)) { fails("backup-invalid", () -> readAll(inspection, 4096)); }
    });
    test("truncated archives are rejected before reading", () -> {
      byte[] bytes = Files.readAllBytes(valid.toPath()); File cut = File.createTempFile("cut-", ".zip", root);
      Files.write(cut.toPath(), Arrays.copyOf(bytes, bytes.length - 40)); fails("unsafe-or-unsupported-zip", () -> open(cut, null, () -> false).close());
      Files.write(cut.toPath(), Arrays.copyOf(bytes, bytes.length / 2)); fails("unsafe-or-unsupported-zip", () -> open(cut, null, () -> false).close());
    });
    test("entries outside the v1 layout mean this is not a Snarchive backup", () -> {
      byte[] m = text.getBytes(StandardCharsets.UTF_8), data = "synthetic original A".getBytes(StandardCharsets.UTF_8);
      String path = "objects/" + a.sha256.substring(0, 2) + "/" + a.sha256;
      Map<String, RawZip> cases = new LinkedHashMap<>();
      cases.put("extra file", new RawZip().add("manifest.jsonl", m).add(path, data).add("notes.txt", data));
      cases.put("directory entry", new RawZip().add("manifest.jsonl", m).add("objects/", new byte[0]).add(path, data));
      cases.put("uppercase hash", new RawZip().add("manifest.jsonl", m).add(path.toUpperCase(Locale.ROOT).replace("OBJECTS", "objects"), data));
      cases.put("prefix mismatch", new RawZip().add("manifest.jsonl", m).add("objects/" + (a.sha256.startsWith("00") ? "01" : "00") + "/" + a.sha256, data));
      cases.put("no manifest", new RawZip().add(path, data));
      cases.put("Snapchat export", new RawZip().add("memories/2026-02-05_memoryA-main.jpg", data));
      for (Map.Entry<String, RawZip> item : cases.entrySet()) {
        File file = item.getValue().write(root);
        fails("backup-not-snarchive", () -> open(file, null, () -> false).close());
      }
    });
    test("duplicate entry names and encrypted entries are unsafe", () -> {
      byte[] m = text.getBytes(StandardCharsets.UTF_8), data = "synthetic original A".getBytes(StandardCharsets.UTF_8);
      String path = "objects/" + a.sha256.substring(0, 2) + "/" + a.sha256;
      File duplicate = new RawZip().add("manifest.jsonl", m).add(path, data).add(path, data).write(root);
      fails("unsafe-or-unsupported-zip", () -> open(duplicate, null, () -> false).close());
      File doubleManifest = new RawZip().add("manifest.jsonl", m).add("manifest.jsonl", m).write(root);
      fails("unsafe-or-unsupported-zip", () -> open(doubleManifest, null, () -> false).close());
      File encrypted = new RawZip().add("manifest.jsonl", m, 1).write(root);
      fails("unsafe-or-unsupported-zip", () -> open(encrypted, null, () -> false).close());
      File traversal = new RawZip().add("manifest.jsonl", m).add("../" + path, data).write(root);
      fails("unsafe-or-unsupported-zip", () -> open(traversal, null, () -> false).close());
    });
    test("a manifest over 128 MiB is refused before it is read", () -> {
      File big = Files.createTempDirectory("snarchive-inspect-limit-").toFile();
      try {
        File file = spacesManifestZip(big, BackupWriter.MAX_MANIFEST + 1);
        fails("backup-limit", () -> open(file, null, () -> false).close());
      } finally { deleteTree(big); }
    });
    test("cancellation during verification stops, cleans up, and a retry succeeds", () -> {
      AtomicInteger calls = new AtomicInteger(), cleaned = new AtomicInteger();
      BackupInspection inspection = open(valid, cleaned::incrementAndGet, () -> calls.incrementAndGet() > 12);
      try { readAll(inspection, 4096); declareAll(inspection, both); inspection.seal();
        try { verifyAll(inspection, () -> calls.incrementAndGet() > 12); throw new AssertionError("not cancelled"); }
        catch (IOException e) { check("cancelled".equals(e.getMessage()), "cancelled"); }
      } finally { inspection.close(); }
      check(cleaned.get() == 1, "cleaned once");
      try (BackupInspection retry = open(valid, null, () -> false)) { readAll(retry, 4096); declareAll(retry, both); retry.seal(); check(verifyAll(retry, () -> false).done, "retry"); }
    });
    test("a backup rewritten during inspection is reported as changed", () -> {
      File copy = File.createTempFile("changing-", ".zip", root); Files.copy(valid.toPath(), copy.toPath(), StandardCopyOption.REPLACE_EXISTING);
      try (BackupInspection inspection = open(copy, null, () -> false)) {
        readAll(inspection, 4096); declareAll(inspection, both); inspection.seal();
        Files.write(copy.toPath(), new byte[] { 0 }, StandardOpenOption.APPEND); copy.setLastModified(copy.lastModified() + 5000);
        fails("source-changed", () -> verifyAll(inspection, () -> false));
      }
    });
    test("ZIP64 backups from the exporter (65,601 entries) inspect fully", () -> {
      File big = Files.createTempDirectory("snarchive-inspect-zip64-").toFile();
      try {
        OriginalStore many = new OriginalStore(new File(big, "originals")); List<OriginalStore.Stored> objects = new ArrayList<>();
        OriginalStore previous = store; store = many;
        try {
          for (int i = 0; i < 65_600; i++) {
            byte[] value = ("synthetic-" + i).getBytes(StandardCharsets.UTF_8); String hash = sha(value);
            File object = new File(big, "originals/objects/" + hash.substring(0, 2) + "/" + hash); object.getParentFile().mkdirs(); Files.write(object.toPath(), value);
            objects.add(many.confirm(hash, value.length) != null ? stored(hash, value.length) : null);
          }
          String largeText = manifest(objects, null); File backup = export(largeText, objects, big);
          try (BackupInspection inspection = open(backup, null, () -> false)) {
            check(inspection.objectCount() == 65_600, "count"); check(readAll(inspection, BackupInspection.MAX_CHUNK).equals(largeText), "text");
            declareAll(inspection, objects); inspection.seal(); check(verifyAll(inspection, () -> false).verified == 65_600, "all verified");
          }
        } finally { store = previous; }
      } finally { deleteTree(big); }
    });

    // The session gate: provider work and cleanup never run under its lock, and a session is never released early.
    class Session implements Closeable { final AtomicInteger closes = new AtomicInteger(); CountDownLatch closeGate; boolean failClose;
      public void close() throws IOException { closes.incrementAndGet(); if (closeGate != null) try { closeGate.await(); } catch (InterruptedException e) { throw new IOException(e); } if (failClose) throw new IOException("provider"); } }
    InspectionGate.Codes codes = error -> BackupInspection.code(error, false);
    test("gate: one session at a time, released exactly once after close", () -> {
      AtomicInteger released = new AtomicInteger(); InspectionGate<Session> gate = new InspectionGate<>(Runnable::run, codes, released::incrementAndGet);
      Session session = new Session();
      check(gate.begin(() -> session) == null && gate.active(), "open");
      check("busy".equals(gate.begin(Session::new)), "second session refused");
      check(gate.run(s -> 7).value == 7, "work");
      check(gate.finish() == null && session.closes.get() == 1 && released.get() == 1 && !gate.active(), "closed and released");
      check("cancelled".equals(gate.run(s -> 1).code), "no work after close");
    });
    test("gate: a failed open releases the guard and returns a safe code", () -> {
      AtomicInteger released = new AtomicInteger(); InspectionGate<Session> gate = new InspectionGate<>(Runnable::run, codes, released::incrementAndGet);
      check("backup-not-snarchive".equals(gate.begin(() -> { throw new IOException("backup-not-snarchive"); })) && released.get() == 1, "failed open");
      check("backup-unreadable".equals(gate.begin(() -> { throw new IOException("/storage/emulated/0/private.zip: EACCES"); })), "provider text never surfaces");
    });
    test("gate: teardown during a blocked open closes the session when the open returns", () -> {
      AtomicInteger released = new AtomicInteger(); InspectionGate<Session> gate = new InspectionGate<>(c -> { throw new AssertionError("no cleanup thread needed"); }, codes, released::incrementAndGet);
      CountDownLatch opening = new CountDownLatch(1), proceed = new CountDownLatch(1); Session session = new Session(); AtomicReference<String> result = new AtomicReference<>("pending");
      Thread opener = new Thread(() -> result.set(gate.begin(() -> { opening.countDown(); proceed.await(); return session; }))); opener.start();
      check(opening.await(5, TimeUnit.SECONDS), "opening");
      Thread teardown = new Thread(gate::finishLater); teardown.start(); teardown.join(1000); check(!teardown.isAlive(), "teardown returned at once");
      check("busy".equals(gate.begin(Session::new)), "no second session while opening");
      proceed.countDown(); opener.join(5000);
      check("cancelled".equals(result.get()) && session.closes.get() == 1 && released.get() == 1 && !gate.active(), "closed after open");
    });
    test("gate: teardown during blocked work never closes under it; the worker cleans up", () -> {
      AtomicInteger released = new AtomicInteger(); InspectionGate<Session> gate = new InspectionGate<>(c -> { throw new AssertionError("worker must clean up"); }, codes, released::incrementAndGet);
      Session session = new Session(); gate.begin(() -> session);
      CountDownLatch working = new CountDownLatch(1), proceed = new CountDownLatch(1);
      Thread worker = new Thread(() -> gate.run(s -> { working.countDown(); proceed.await(); return null; })); worker.start();
      check(working.await(5, TimeUnit.SECONDS), "working");
      Thread teardown = new Thread(gate::finishLater); teardown.start(); teardown.join(1000); check(!teardown.isAlive(), "teardown returned");
      check(session.closes.get() == 0 && "busy".equals(gate.finish()) && "busy".equals(gate.run(s -> 1).code), "not closed while working");
      proceed.countDown(); worker.join(5000);
      check(session.closes.get() == 1 && released.get() == 1, "worker closed it");
    });
    test("gate: a blocked cleanup keeps the session reserved, and teardown does not wait for it", () -> {
      AtomicInteger released = new AtomicInteger(); InspectionGate<Session> gate = new InspectionGate<>(c -> new Thread(c).start(), codes, released::incrementAndGet);
      Session session = new Session(); session.closeGate = new CountDownLatch(1); gate.begin(() -> session);
      Thread teardown = new Thread(gate::finishLater); teardown.start(); teardown.join(1000); check(!teardown.isAlive(), "teardown returned");
      for (int i = 0; i < 200 && session.closes.get() == 0; i++) Thread.sleep(5);
      check(session.closes.get() == 1 && released.get() == 0 && "busy".equals(gate.begin(Session::new)), "reserved during cleanup");
      session.closeGate.countDown(); for (int i = 0; i < 200 && released.get() == 0; i++) Thread.sleep(5);
      check(released.get() == 1 && gate.begin(Session::new) == null, "retry after cleanup");
    });
    test("gate: a failed cleanup is reported and still releases the guard", () -> {
      AtomicInteger released = new AtomicInteger(); InspectionGate<Session> gate = new InspectionGate<>(Runnable::run, codes, released::incrementAndGet);
      Session session = new Session(); session.failClose = true; gate.begin(() -> session);
      check("backup-cleanup-failed".equals(gate.finish()) && released.get() == 1 && !gate.active(), "reported and released");
    });
    test("temporary-copy cleanup: deleted, already absent, or reported when it remains", () -> {
      File dir = Files.createTempDirectory(root.toPath(), "copies-").toFile();
      File copy = new File(dir, "preview-1.part"); Files.write(copy.toPath(), new byte[] { 1 });
      new DeleteOnClose(copy).close(); check(!copy.exists(), "deleted");
      new DeleteOnClose(copy).close(); // Already absent: still a successful cleanup.
      File stuck = new File(dir, "preview-2.part"); Files.write(stuck.toPath(), new byte[] { 1 });
      check(dir.setWritable(false), "directory locked");
      try { fails("backup-cleanup-failed", () -> new DeleteOnClose(stuck).close()); check(stuck.exists(), "file remains"); }
      finally { dir.setWritable(true); }
    });
    test("a remaining temporary copy reaches the inspection cleanup result; the chosen backup is never touched", () -> {
      File dir = Files.createTempDirectory(root.toPath(), "copies-").toFile();
      File copy = new File(dir, "preview-3.part"); Files.copy(valid.toPath(), copy.toPath());
      byte[] chosen = Files.readAllBytes(valid.toPath());
      AtomicInteger released = new AtomicInteger();
      InspectionGate<BackupInspection> gate = new InspectionGate<>(Runnable::run, error -> BackupInspection.code(error, false), released::incrementAndGet);
      // As in the module: the private copy is the source being read, and DeleteOnClose removes it afterwards.
      check(gate.begin(() -> BackupInspection.open(ArchiveSource.open(copy), new DeleteOnClose(copy), () -> false)) == null, "open");
      check(dir.setWritable(false), "directory locked");
      try {
        check("backup-cleanup-failed".equals(gate.finish()) && released.get() == 1 && !gate.active(), "failure reported, guard released after cleanup");
        check(copy.exists(), "copy still there");
      } finally { dir.setWritable(true); }
      check(Arrays.equals(chosen, Files.readAllBytes(valid.toPath())), "chosen backup unchanged");
      check(gate.begin(() -> BackupInspection.open(ArchiveSource.open(copy), new DeleteOnClose(copy), () -> false)) == null && gate.finish() == null && !copy.exists(), "successful cleanup reports nothing");
    });
    test("deleteOrSuppress keeps the original error and records a copy that remains", () -> {
      File dir = Files.createTempDirectory(root.toPath(), "copies-").toFile();
      File gone = new File(dir, "preview-4.part"); Files.write(gone.toPath(), new byte[] { 1 });
      IOException clean = new IOException("unsafe-or-unsupported-zip"); DeleteOnClose.deleteOrSuppress(gone, clean);
      check(!gone.exists() && clean.getSuppressed().length == 0 && !InspectionGate.cleanupFailed(clean), "deleted, nothing recorded");
      DeleteOnClose.deleteOrSuppress(gone, clean); check(clean.getSuppressed().length == 0, "absent is not a failure");
      File stuck = new File(dir, "preview-5.part"); Files.write(stuck.toPath(), new byte[] { 1 });
      IllegalStateException cancelled = new IllegalStateException("insufficient-storage");
      check(dir.setWritable(false), "directory locked");
      try { DeleteOnClose.deleteOrSuppress(stuck, cancelled); } finally { dir.setWritable(true); }
      check("insufficient-storage".equals(cancelled.getMessage()) && InspectionGate.cleanupFailed(cancelled) && stuck.exists(), "both outcomes kept");
    });
    test("a failed open whose copy cannot be deleted reports both outcomes, releases once, and a retry works", () -> {
      File dir = Files.createTempDirectory(root.toPath(), "copies-").toFile();
      File copy = new File(dir, "preview-6.part"); byte[] bytes = Files.readAllBytes(valid.toPath());
      Files.write(copy.toPath(), Arrays.copyOf(bytes, bytes.length / 2)); // A malformed private copy.
      AtomicBoolean stop = new AtomicBoolean(); AtomicInteger released = new AtomicInteger();
      InspectionGate<BackupInspection> gate = new InspectionGate<>(Runnable::run, error -> BackupInspection.code(error, stop.get()), released::incrementAndGet);
      check(dir.setWritable(false), "directory locked");
      try {
        InspectionGate.Opened failed = gate.beginWithStatus(() -> BackupInspection.open(ArchiveSource.open(copy), new DeleteOnClose(copy), stop::get));
        check("unsafe-or-unsupported-zip".equals(failed.code) && failed.cleanupFailed, "original code and cleanup failure");
        check(copy.exists() && released.get() == 1 && !gate.active() && gate.finish() == null, "copy remains; guard released once");
        stop.set(true); // The same failure while cancelling: still reported, and still a cancellation.
        InspectionGate.Opened cancelled = gate.beginWithStatus(() -> BackupInspection.open(ArchiveSource.open(copy), new DeleteOnClose(copy), stop::get));
        check("cancelled".equals(cancelled.code) && cancelled.cleanupFailed && released.get() == 2, "cancellation keeps the cleanup failure");
      } finally { dir.setWritable(true); stop.set(false); }
      check(Arrays.equals(bytes, Files.readAllBytes(valid.toPath())), "chosen backup unchanged");
      File retry = new File(dir, "preview-7.part"); Files.copy(valid.toPath(), retry.toPath());
      InspectionGate.Opened ok = gate.beginWithStatus(() -> BackupInspection.open(ArchiveSource.open(retry), new DeleteOnClose(retry), stop::get));
      check(ok.code == null && !ok.cleanupFailed && gate.finish() == null && !retry.exists() && released.get() == 3, "retry opens and cleans up");
    });
    test("teardown during an open whose cleanup then fails reports a cancellation with the cleanup failure", () -> {
      File dir = Files.createTempDirectory(root.toPath(), "copies-").toFile();
      File copy = new File(dir, "preview-8.part"); Files.copy(valid.toPath(), copy.toPath());
      AtomicInteger released = new AtomicInteger();
      InspectionGate<BackupInspection> gate = new InspectionGate<>(c -> { throw new AssertionError("the opener cleans up"); }, error -> BackupInspection.code(error, false), released::incrementAndGet);
      CountDownLatch opening = new CountDownLatch(1), proceed = new CountDownLatch(1); AtomicReference<InspectionGate.Opened> result = new AtomicReference<>();
      Thread opener = new Thread(() -> result.set(gate.beginWithStatus(() -> { opening.countDown(); proceed.await();
        return BackupInspection.open(ArchiveSource.open(copy), new DeleteOnClose(copy), () -> false); }))); opener.start();
      check(opening.await(5, TimeUnit.SECONDS), "opening");
      gate.finishLater();
      check(dir.setWritable(false), "directory locked");
      try { proceed.countDown(); opener.join(5000); } finally { dir.setWritable(true); }
      check("cancelled".equals(result.get().code) && result.get().cleanupFailed && copy.exists() && released.get() == 1, "both reported, released once");
    });
    test("an undeletable leftover copy stops inspection before the chosen backup is opened; a retry recovers", () -> {
      File dir = Files.createTempDirectory(root.toPath(), "copies-").toFile();
      File leftover = new File(dir, "preview-123.part"); Files.write(leftover.toPath(), new byte[] { 1, 2, 3 });
      byte[] chosen = Files.readAllBytes(valid.toPath());
      AtomicInteger openedChosen = new AtomicInteger(), released = new AtomicInteger();
      InspectionGate<BackupInspection> gate = new InspectionGate<>(Runnable::run, error -> BackupInspection.code(error, false), released::incrementAndGet);
      // The module's opening path: clear abandoned copies, then read the chosen document in place (or copy it).
      InspectionGate.Opener<BackupInspection> opener = () -> BackupInspection.open(ArchiveSource.openSelected(dir,
        () -> { openedChosen.incrementAndGet(); return ArchiveSource.open(valid); },
        () -> { openedChosen.incrementAndGet(); return null; }), null, () -> false);
      check(dir.setWritable(false), "directory locked");
      try {
        InspectionGate.Opened stuck = gate.beginWithStatus(opener);
        check("staging-cleanup-failed".equals(stuck.code) && stuck.cleanupFailed, "cleanup failure, not an unreadable backup: " + stuck.code);
        check(openedChosen.get() == 0 && leftover.exists() && released.get() == 1 && !gate.active(), "chosen backup never opened; guard released once");
      } finally { dir.setWritable(true); }
      InspectionGate.Opened retry = gate.beginWithStatus(opener);
      check(retry.code == null && !retry.cleanupFailed && !leftover.exists() && openedChosen.get() == 1, "retry removes the leftover and opens");
      check(gate.finish() == null && released.get() == 2, "closed and released");
      check(Arrays.equals(chosen, Files.readAllBytes(valid.toPath())), "chosen backup unchanged");
    });
    System.out.println(passed + " backup inspection host tests passed. No device or restore claim.");
  }

  /** A stored manifest entry of `size` spaces, streamed to disk so the test never holds it in memory. */
  static File spacesManifestZip(File dir, long size) throws Exception {
    byte[] chunk = new byte[1 << 20]; Arrays.fill(chunk, (byte) ' ');
    CRC32 crc = new CRC32(); for (long left = size; left > 0; left -= Math.min(left, chunk.length)) crc.update(chunk, 0, (int) Math.min(left, chunk.length));
    byte[] name = "manifest.jsonl".getBytes(StandardCharsets.UTF_8);
    File file = File.createTempFile("big-", ".zip", dir);
    try (OutputStream out = new BufferedOutputStream(new FileOutputStream(file))) {
      ByteArrayOutputStream header = new ByteArrayOutputStream();
      RawZip.le(header, 0x04034b50L, 4); RawZip.le(header, 20, 2); RawZip.le(header, 0, 2); RawZip.le(header, 0, 2); RawZip.le(header, 0, 2); RawZip.le(header, 0x21, 2);
      RawZip.le(header, crc.getValue(), 4); RawZip.le(header, size, 4); RawZip.le(header, size, 4); RawZip.le(header, name.length, 2); RawZip.le(header, 0, 2); header.write(name, 0, name.length);
      header.writeTo(out);
      for (long left = size; left > 0; left -= Math.min(left, chunk.length)) out.write(chunk, 0, (int) Math.min(left, chunk.length));
      ByteArrayOutputStream central = new ByteArrayOutputStream();
      RawZip.le(central, 0x02014b50L, 4); RawZip.le(central, 20, 2); RawZip.le(central, 20, 2); RawZip.le(central, 0, 2); RawZip.le(central, 0, 2); RawZip.le(central, 0, 2); RawZip.le(central, 0x21, 2);
      RawZip.le(central, crc.getValue(), 4); RawZip.le(central, size, 4); RawZip.le(central, size, 4); RawZip.le(central, name.length, 2); RawZip.le(central, 0, 2); RawZip.le(central, 0, 2);
      RawZip.le(central, 0, 2); RawZip.le(central, 0, 2); RawZip.le(central, 0, 4); RawZip.le(central, 0, 4); central.write(name, 0, name.length);
      long centralOffset = header.size() + size; central.writeTo(out);
      ByteArrayOutputStream end = new ByteArrayOutputStream();
      RawZip.le(end, 0x06054b50L, 4); RawZip.le(end, 0, 2); RawZip.le(end, 0, 2); RawZip.le(end, 1, 2); RawZip.le(end, 1, 2); RawZip.le(end, central.size(), 4); RawZip.le(end, centralOffset, 4); RawZip.le(end, 0, 2);
      end.writeTo(out);
    }
    return file;
  }
  static OriginalStore.Stored stored(String hash, long bytes) throws Exception {
    java.lang.reflect.Constructor<OriginalStore.Stored> make = OriginalStore.Stored.class.getDeclaredConstructor(String.class, long.class, boolean.class);
    make.setAccessible(true); return make.newInstance(hash, bytes, false);
  }
  static int indexOf(byte[] haystack, byte[] needle) {
    outer: for (int i = 0; i <= haystack.length - needle.length; i++) { for (int j = 0; j < needle.length; j++) if (haystack[i + j] != needle[j]) continue outer; return i; }
    return -1;
  }
  static void deleteTree(File dir) throws IOException {
    try (java.util.stream.Stream<Path> paths = Files.walk(dir.toPath())) { paths.sorted(Comparator.reverseOrder()).forEach(path -> path.toFile().delete()); }
  }
}
