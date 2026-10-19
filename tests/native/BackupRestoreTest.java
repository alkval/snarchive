import com.alkval.snarchive.sources.backup.BackupInspection;
import com.alkval.snarchive.sources.backup.BackupWriter;
import com.alkval.snarchive.sources.backup.BackupWriter.ObjectSpec;
import com.alkval.snarchive.sources.backup.DeleteOnClose;
import com.alkval.snarchive.sources.storage.OriginalStore;
import com.alkval.snarchive.sources.zip.ArchiveSource;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.atomic.*;
import java.util.function.BooleanSupplier;

/** Restore mode of BackupInspection against the real exporter and the real OriginalStore. */
public class BackupRestoreTest {
  interface Work { void run() throws Exception; }
  static int passed; static File root;
  static void check(boolean ok, String what) { if (!ok) throw new AssertionError(what); }
  static void test(String name, Work work) throws Exception { work.run(); passed++; System.out.println("PASS " + name); }
  static void fails(String code, Work work) throws Exception {
    try { work.run(); } catch (Exception e) {
      // Production maps cancellation through the cancel flag; here the raw message is the check.
      String actual = "cancelled".equals(e.getMessage()) ? "cancelled" : BackupInspection.code(e, false);
      check(code.equals(actual), "expected " + code + ", got " + actual + " (" + e + ")"); return;
    }
    throw new AssertionError("expected " + code);
  }
  static String sha(byte[] input) throws Exception {
    StringBuilder hex = new StringBuilder(); for (byte b : MessageDigest.getInstance("SHA-256").digest(input)) hex.append(String.format("%02x", b & 255)); return hex.toString();
  }
  static final class Backup { File file; String manifest; Map<String, byte[]> objects = new TreeMap<>(); }
  /** A backup made by the real exporter from a source store holding the given contents. */
  static Backup export(String... contents) throws Exception {
    File dir = Files.createTempDirectory(root.toPath(), "export-").toFile();
    OriginalStore source = new OriginalStore(new File(dir, "originals"));
    Backup backup = new Backup(); List<ObjectSpec> specs = new ArrayList<>();
    for (String text : contents) {
      byte[] value = text.getBytes(StandardCharsets.UTF_8);
      OriginalStore.Stored stored = source.put(new ByteArrayInputStream(value), value.length, -1, new OriginalStore.Budget(1 << 20), () -> false);
      backup.objects.put(stored.sha256, value);
    }
    StringBuilder manifest = new StringBuilder("{\"type\":\"header\",\"format\":\"snarchive-backup\",\"version\":1}\n"); long bytes = 0;
    for (Map.Entry<String, byte[]> e : backup.objects.entrySet()) {
      manifest.append("{\"type\":\"object\",\"sha256\":\"").append(e.getKey()).append("\",\"relativePath\":\"objects/").append(e.getKey(), 0, 2).append('/').append(e.getKey()).append("\",\"bytes\":").append(e.getValue().length).append("}\n");
      bytes += e.getValue().length; specs.add(new ObjectSpec(e.getKey(), e.getValue().length));
    }
    manifest.append("{\"type\":\"end\",\"records\":").append(backup.objects.size() + 1).append(",\"objects\":").append(backup.objects.size()).append(",\"originalBytes\":").append(bytes).append("}\n");
    backup.manifest = manifest.toString();
    File manifestFile = new File(dir, "manifest.jsonl"); Files.write(manifestFile.toPath(), backup.manifest.getBytes(StandardCharsets.UTF_8));
    backup.file = new File(dir, "backup.zip");
    try (OutputStream out = new FileOutputStream(backup.file)) { BackupWriter.write(source, manifestFile, specs, out, dir, File::getUsableSpace, () -> false); }
    return backup;
  }
  /** Pass 1 in restore mode: open, stage and read the manifest, declare, seal. */
  static BackupInspection openRestore(File backup, File staged, BooleanSupplier stop) throws Exception {
    BackupInspection session = BackupInspection.open(ArchiveSource.open(backup), new DeleteOnClose(staged), stop);
    session.enableRestore(staged);
    StringBuilder text = new StringBuilder();
    for (;;) { BackupInspection.Chunk chunk = session.readManifest(64, stop); text.append(chunk.text); if (chunk.done) break; }
    return session;
  }
  static void declareAll(BackupInspection session, Backup backup) throws Exception {
    for (Map.Entry<String, byte[]> e : backup.objects.entrySet()) session.declare(e.getKey(), e.getValue().length);
    session.seal();
  }
  static BackupInspection.Stored storeAll(BackupInspection session, OriginalStore store, BooleanSupplier stop) throws Exception {
    for (;;) { BackupInspection.Stored step = session.store(store, 0, stop); if (step.done) return step; }
  }
  static String readStaged(BackupInspection session) throws Exception {
    StringBuilder text = new StringBuilder();
    for (;;) { BackupInspection.Chunk chunk = session.readStagedManifest(64, () -> false); text.append(chunk.text); if (chunk.done) return text.toString(); }
  }
  static File staged() throws Exception { return File.createTempFile("preview-", ".part", Files.createTempDirectory(root.toPath(), "cache-").toFile()); }
  static List<String> files(File dir) throws Exception {
    if (!dir.exists()) return Collections.emptyList();
    try (java.util.stream.Stream<Path> paths = Files.walk(dir.toPath())) { List<String> out = new ArrayList<>(); paths.filter(Files::isRegularFile).forEach(p -> out.add(dir.toPath().relativize(p).toString())); Collections.sort(out); return out; }
  }

  public static void main(String[] args) throws Exception {
    if (args[0].equals("crash-store")) { crashChild(new File(args[1]), new File(args[2]), new File(args[3])); return; }
    root = Files.createTempDirectory(Paths.get(args[0]), "restore-").toFile();
    Backup backup = export("synthetic photo bytes", "synthetic video bytes, longer", "shared overlay");
    byte[] chosen = Files.readAllBytes(backup.file.toPath());

    test("restore stores every object byte-for-byte, re-reads the same manifest, and cleans up its private files", () -> {
      OriginalStore store = new OriginalStore(Files.createTempDirectory(root.toPath(), "library-").toFile()); File staged = staged();
      try (BackupInspection session = openRestore(backup.file, staged, () -> false)) {
        declareAll(session, backup);
        check(session.missingBytes(store) == backup.objects.values().stream().mapToLong(v -> v.length).sum(), "all missing");
        BackupInspection.Stored done = storeAll(session, store, () -> false);
        check(done.added == 3 && done.reused == 0, "three added");
        check(readStaged(session).equals(backup.manifest), "staged manifest is the validated text");
        for (Map.Entry<String, byte[]> e : backup.objects.entrySet()) check(Arrays.equals(e.getValue(), Files.readAllBytes(store.confirm(e.getKey(), e.getValue().length).toPath())), "bytes");
      }
      check(!staged.exists(), "staged manifest deleted"); check(Arrays.equals(chosen, Files.readAllBytes(backup.file.toPath())), "backup unchanged");
    });
    test("a second restore re-hashes and reuses existing objects without rewriting them", () -> {
      File libraryDir = Files.createTempDirectory(root.toPath(), "library-").toFile(); OriginalStore store = new OriginalStore(libraryDir);
      try (BackupInspection session = openRestore(backup.file, staged(), () -> false)) { declareAll(session, backup); storeAll(session, store, () -> false); }
      Map<String, Long> modified = new HashMap<>();
      for (String hash : backup.objects.keySet()) modified.put(hash, store.confirm(hash, backup.objects.get(hash).length).lastModified());
      try (BackupInspection session = openRestore(backup.file, staged(), () -> false)) {
        declareAll(session, backup); check(session.missingBytes(store) == 0, "nothing missing");
        BackupInspection.Stored done = storeAll(session, store, () -> false); check(done.added == 0 && done.reused == 3, "all reused");
      }
      for (String hash : backup.objects.keySet()) check(store.confirm(hash, backup.objects.get(hash).length).lastModified() == modified.get(hash), "not rewritten");
    });
    test("same-length corruption of an existing local object stops the restore and leaves that file as it was", () -> {
      OriginalStore store = new OriginalStore(Files.createTempDirectory(root.toPath(), "library-").toFile());
      String hash = backup.objects.keySet().iterator().next(); byte[] value = backup.objects.get(hash).clone(); value[0] ^= 1;
      File local = new File(store.confirm(storeOne(store, backup, hash), backup.objects.get(hash).length).getPath());
      Files.write(local.toPath(), value); // Same length, wrong content.
      try (BackupInspection session = openRestore(backup.file, staged(), () -> false)) {
        declareAll(session, backup); check(session.missingBytes(store) < backup.objects.values().stream().mapToLong(v -> v.length).sum(), "counted as present");
        fails("stored-object-corrupt", () -> storeAll(session, store, () -> false));
      }
      check(Arrays.equals(value, Files.readAllBytes(local.toPath())), "corrupt local file not overwritten");
    });
    test("an existing local object of the wrong length is reported before anything is stored", () -> {
      OriginalStore store = new OriginalStore(Files.createTempDirectory(root.toPath(), "library-").toFile());
      String hash = backup.objects.keySet().iterator().next(); File local = store.confirm(storeOne(store, backup, hash), backup.objects.get(hash).length);
      Files.write(local.toPath(), new byte[] { 1 });
      try (BackupInspection session = openRestore(backup.file, staged(), () -> false)) { declareAll(session, backup); fails("stored-object-corrupt", () -> session.missingBytes(store)); }
    });
    test("a damaged object in the backup is never finalized into the store", () -> {
      byte[] bytes = Files.readAllBytes(backup.file.toPath()); byte[] payload = "synthetic video bytes".getBytes(StandardCharsets.UTF_8);
      int at = indexOf(bytes, payload); check(at > 0, "payload"); bytes[at + 2] ^= 1;
      File damaged = new File(root, "damaged.zip"); Files.write(damaged.toPath(), bytes);
      File libraryDir = Files.createTempDirectory(root.toPath(), "library-").toFile(); OriginalStore store = new OriginalStore(libraryDir);
      String bad = sha("synthetic video bytes, longer".getBytes(StandardCharsets.UTF_8));
      try (BackupInspection session = openRestore(damaged, staged(), () -> false)) { declareAll(session, backup); fails("backup-damaged", () -> storeAll(session, store, () -> false)); }
      check(!new File(libraryDir, "objects/" + bad.substring(0, 2) + "/" + bad).exists(), "no object for damaged bytes");
      check(files(new File(libraryDir, "staging")).isEmpty(), "no staging leftovers");
    });
    test("a staged manifest that changes before the merge is detected", () -> {
      File staged = staged();
      try (BackupInspection session = openRestore(backup.file, staged, () -> false)) {
        declareAll(session, backup); storeAll(session, new OriginalStore(Files.createTempDirectory(root.toPath(), "library-").toFile()), () -> false);
        byte[] text = Files.readAllBytes(staged.toPath()); text[text.length - 3] ^= 1; Files.write(staged.toPath(), text);
        fails("backup-damaged", () -> readStaged(session));
      }
    });
    test("the steps cannot run out of order", () -> {
      try (BackupInspection plain = BackupInspection.open(ArchiveSource.open(backup.file), null, () -> false)) {
        fails("backup-invalid", () -> plain.missingBytes(new OriginalStore(Files.createTempDirectory(root.toPath(), "library-").toFile())));
      }
      try (BackupInspection session = openRestore(backup.file, staged(), () -> false)) {
        declareAll(session, backup); fails("backup-invalid", () -> session.readStagedManifest(64, () -> false)); // Objects not stored yet.
      }
    });
    test("a backup rewritten during the restore is reported as changed", () -> {
      File copy = new File(root, "changing.zip"); Files.copy(backup.file.toPath(), copy.toPath(), StandardCopyOption.REPLACE_EXISTING);
      try (BackupInspection session = openRestore(copy, staged(), () -> false)) {
        declareAll(session, backup);
        Files.write(copy.toPath(), new byte[] { 0 }, StandardOpenOption.APPEND); copy.setLastModified(copy.lastModified() + 5000);
        fails("source-changed", () -> storeAll(session, new OriginalStore(Files.createTempDirectory(root.toPath(), "library-").toFile()), () -> false));
      }
    });
    test("low storage stops before writing and leaves no staging", () -> {
      File libraryDir = Files.createTempDirectory(root.toPath(), "library-").toFile();
      OriginalStore store = new OriginalStore(libraryDir, dir -> OriginalStore.RESERVE, point -> {});
      try (BackupInspection session = openRestore(backup.file, staged(), () -> false)) { declareAll(session, backup); fails("insufficient-storage", () -> storeAll(session, store, () -> false)); }
      check(files(new File(libraryDir, "objects")).isEmpty() && files(new File(libraryDir, "staging")).isEmpty(), "nothing stored");
    });
    test("cancellation while storing leaves only complete objects, and a retry finishes", () -> {
      File libraryDir = Files.createTempDirectory(root.toPath(), "library-").toFile(); OriginalStore store = new OriginalStore(libraryDir);
      AtomicInteger calls = new AtomicInteger();
      try (BackupInspection session = openRestore(backup.file, staged(), () -> false)) {
        declareAll(session, backup); fails("cancelled", () -> storeAll(session, store, () -> calls.incrementAndGet() > 6));
      }
      check(files(new File(libraryDir, "staging")).isEmpty(), "no partial objects");
      try (BackupInspection session = openRestore(backup.file, staged(), () -> false)) { declareAll(session, backup); check(storeAll(session, store, () -> false).done, "retry"); }
    });
    test("a process killed after an object is finalized leaves a verifiable object; a retry reuses it", () -> {
      File libraryDir = Files.createTempDirectory(root.toPath(), "library-").toFile(); File staged = staged();
      Process child = new ProcessBuilder(new File(System.getProperty("java.home"), "bin/java").getPath(), "-cp", System.getProperty("java.class.path"),
        "BackupRestoreTest", "crash-store", backup.file.getPath(), libraryDir.getPath(), staged.getPath()).inheritIO().start();
      check(child.waitFor() == 23, "child halted at the fault point");
      OriginalStore store = new OriginalStore(libraryDir); store.recoverStaging();
      check(files(new File(libraryDir, "objects")).size() == 1 && files(new File(libraryDir, "staging")).isEmpty(), "one finalized object, no staging");
      try (BackupInspection session = openRestore(backup.file, staged(), () -> false)) {
        declareAll(session, backup); BackupInspection.Stored done = storeAll(session, store, () -> false);
        check(done.reused == 1 && done.added == 2, "the finalized object is re-hashed and reused");
      }
      check(Arrays.equals(chosen, Files.readAllBytes(backup.file.toPath())), "backup unchanged");
    });
    test("a private file that cannot be deleted is reported when the session closes", () -> {
      File staged = staged(); BackupInspection session = openRestore(backup.file, staged, () -> false);
      check(staged.getParentFile().setWritable(false), "locked");
      try { fails("backup-cleanup-failed", session::close); check(staged.exists(), "remains"); } finally { staged.getParentFile().setWritable(true); }
      new DeleteOnClose(staged).close(); check(!staged.exists(), "deleted once allowed");
    });
    System.out.println(passed + " backup restore host tests passed. No device claim.");
  }

  /** Puts one object of the backup into a store directly, as an earlier import would have. */
  static String storeOne(OriginalStore store, Backup backup, String hash) throws Exception {
    byte[] value = backup.objects.get(hash);
    return store.put(new ByteArrayInputStream(value), value.length, -1, new OriginalStore.Budget(1 << 20), () -> false).sha256;
  }
  static int indexOf(byte[] haystack, byte[] needle) {
    outer: for (int i = 0; i <= haystack.length - needle.length; i++) { for (int j = 0; j < needle.length; j++) if (haystack[i + j] != needle[j]) continue outer; return i; }
    return -1;
  }
  /** Child process: halts (as a killed app would) right after the first object is finalized. */
  static void crashChild(File backupFile, File libraryDir, File staged) throws Exception {
    OriginalStore store = new OriginalStore(libraryDir, File::getUsableSpace, point -> { if (point.equals("after-finalize")) Runtime.getRuntime().halt(23); });
    root = staged.getParentFile();
    BackupInspection session = BackupInspection.open(ArchiveSource.open(backupFile), null, () -> false);
    session.enableRestore(staged);
    while (!session.readManifest(4096, () -> false).done) {}
    // Declarations come from the manifest; here, from the archive's own catalog via a fresh export description.
    String text = new String(Files.readAllBytes(staged.toPath()), StandardCharsets.UTF_8);
    for (String line : text.split("\n")) {
      if (!line.contains("\"type\":\"object\"")) continue;
      String hash = line.replaceAll(".*\"sha256\":\"([a-f0-9]{64})\".*", "$1"); long bytes = Long.parseLong(line.replaceAll(".*\"bytes\":([0-9]+).*", "$1"));
      session.declare(hash, bytes);
    }
    session.seal();
    while (!session.store(store, 0, () -> false).done) {}
    throw new AssertionError("fault point not reached");
  }
}
