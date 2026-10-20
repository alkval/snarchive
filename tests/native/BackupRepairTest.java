import com.alkval.snarchive.sources.backup.BackupInspection;
import com.alkval.snarchive.sources.backup.BackupInspection.RepairOutcome;
import com.alkval.snarchive.sources.backup.BackupWriter;
import com.alkval.snarchive.sources.backup.BackupWriter.ObjectSpec;
import com.alkval.snarchive.sources.backup.InspectionGate;
import com.alkval.snarchive.sources.storage.OriginalStore;
import com.alkval.snarchive.sources.zip.ArchiveSource;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.atomic.*;

/** Repair from a backup (section 22): BackupInspection.repair against the real exporter, inspection session and store. */
public class BackupRepairTest {
  interface Work { void run() throws Exception; }
  static int passed; static File root;
  static void check(boolean ok, String what) { if (!ok) throw new AssertionError(what); }
  static void test(String name, Work work) throws Exception { work.run(); passed++; System.out.println("PASS " + name); }
  static void fails(String code, Work work) throws Exception {
    try { work.run(); } catch (Exception e) { String actual = BackupInspection.code(e, false); check(code.equals(actual), "expected " + code + ", got " + actual + " (" + e + ")"); return; }
    throw new AssertionError("expected " + code);
  }
  static String sha(byte[] input) throws Exception {
    StringBuilder hex = new StringBuilder(); for (byte b : MessageDigest.getInstance("SHA-256").digest(input)) hex.append(String.format("%02x", b & 255)); return hex.toString();
  }
  static byte[] bytes(int size, int seed) { byte[] out = new byte[size]; new Random(seed).nextBytes(out); return out; }
  static final class Backup { File file; Map<String, byte[]> objects = new TreeMap<>(); }
  /** A backup made by the real writer (the manifest itself is validated in JS; here only its catalog matters). */
  static Backup export(byte[]... contents) throws Exception {
    File dir = Files.createTempDirectory(root.toPath(), "export-").toFile();
    OriginalStore source = new OriginalStore(new File(dir, "originals")); Backup backup = new Backup(); List<ObjectSpec> specs = new ArrayList<>();
    for (byte[] value : contents) backup.objects.put(source.put(new ByteArrayInputStream(value), value.length, -1, new OriginalStore.Budget(1 << 30), () -> false).sha256, value);
    StringBuilder manifest = new StringBuilder("{\"type\":\"header\",\"format\":\"snarchive-backup\",\"version\":1}\n"); long total = 0;
    for (Map.Entry<String, byte[]> e : backup.objects.entrySet()) {
      manifest.append("{\"type\":\"object\",\"sha256\":\"").append(e.getKey()).append("\",\"relativePath\":\"objects/").append(e.getKey(), 0, 2).append('/').append(e.getKey()).append("\",\"bytes\":").append(e.getValue().length).append("}\n");
      total += e.getValue().length; specs.add(new ObjectSpec(e.getKey(), e.getValue().length));
    }
    manifest.append("{\"type\":\"end\",\"records\":").append(backup.objects.size() + 1).append(",\"objects\":").append(backup.objects.size()).append(",\"originalBytes\":").append(total).append("}\n");
    File manifestFile = new File(dir, "manifest.jsonl"); Files.write(manifestFile.toPath(), manifest.toString().getBytes(StandardCharsets.UTF_8));
    backup.file = new File(dir, "backup.zip");
    try (OutputStream out = new FileOutputStream(backup.file)) { BackupWriter.write(source, manifestFile, specs, out, dir, File::getUsableSpace, () -> false); }
    return backup;
  }
  /** Opened in inspection mode, manifest read, every object declared, sealed: what JS does before repairing. */
  static BackupInspection sealed(File file, Backup backup) throws Exception {
    BackupInspection session = BackupInspection.open(ArchiveSource.open(file), null, () -> false);
    while (!session.readManifest(4096, () -> false).done) {}
    for (Map.Entry<String, byte[]> e : backup.objects.entrySet()) session.declare(e.getKey(), e.getValue().length);
    session.seal(); return session;
  }
  /** A library store holding the backup's objects, with the given one damaged (same length) or removed. */
  static File library(Backup backup, String damaged, String missing) throws Exception {
    File dir = Files.createTempDirectory(root.toPath(), "library-").toFile(); OriginalStore store = new OriginalStore(dir);
    for (byte[] value : backup.objects.values()) store.put(new ByteArrayInputStream(value), value.length, -1, new OriginalStore.Budget(1 << 30), () -> false);
    if (damaged != null) { File f = file(dir, damaged); byte[] bad = Files.readAllBytes(f.toPath()); bad[0] ^= 1; Files.write(f.toPath(), bad); }
    if (missing != null) Files.delete(file(dir, missing).toPath());
    return dir;
  }
  static File file(File dir, String hash) { return new File(dir, "objects/" + hash.substring(0, 2) + "/" + hash); }
  static byte[] read(File f) throws Exception { return Files.readAllBytes(f.toPath()); }

  public static void main(String[] args) throws Exception {
    root = Files.createTempDirectory(Paths.get(args[0]), "repair-").toFile();
    Backup backup = export(bytes(150_000, 1), bytes(80_000, 2), bytes(5, 3));
    List<String> hashes = new ArrayList<>(backup.objects.keySet());
    String a = hashes.get(0), b = hashes.get(1), c = hashes.get(2);
    byte[] chosen = read(backup.file);

    test("damaged and missing originals are repaired from the backup with exact bytes; only those objects are read", () -> {
      File dir = library(backup, a, b); long untouched = file(dir, c).lastModified();
      try (BackupInspection session = sealed(backup.file, backup)) {
        OriginalStore store = new OriginalStore(dir); AtomicInteger evicted = new AtomicInteger();
        check(session.repair(store, a, backup.objects.get(a).length, () -> false, evicted::incrementAndGet).outcome == RepairOutcome.REPAIRED, "damaged");
        check(session.repair(store, b, backup.objects.get(b).length, () -> false, evicted::incrementAndGet).outcome == RepairOutcome.REPAIRED, "missing");
        check(session.repair(store, c, backup.objects.get(c).length, () -> false, evicted::incrementAndGet).outcome == RepairOutcome.ALREADY_VALID, "valid");
        check(evicted.get() == 2, "evicted only for replacements");
      }
      for (String h : hashes) check(Arrays.equals(backup.objects.get(h), read(file(dir, h))), "exact bytes");
      check(file(dir, c).lastModified() == untouched && Arrays.equals(chosen, read(backup.file)), "valid original and backup unchanged");
    });
    test("an object the backup lacks is unavailable, and one recorded with another length is a mismatch; nothing changes", () -> {
      Backup partial = export(backup.objects.get(c)); File dir = library(backup, a, null); byte[] before = read(file(dir, a));
      try (BackupInspection session = sealed(partial.file, partial)) {
        check(session.repair(new OriginalStore(dir), a, backup.objects.get(a).length, () -> false, () -> {}).outcome == RepairOutcome.UNAVAILABLE, "unavailable");
      }
      try (BackupInspection session = sealed(backup.file, backup)) {
        check(session.repair(new OriginalStore(dir), a, backup.objects.get(a).length + 1, () -> false, () -> {}).outcome == RepairOutcome.MISMATCH, "length differs");
      }
      check(Arrays.equals(before, read(file(dir, a))), "unchanged");
    });
    test("a backup copy that fails its CRC or SHA-256 is a mismatch and is never placed", () -> {
      byte[] zip = read(backup.file); byte[] payload = backup.objects.get(a); int at = indexOf(zip, Arrays.copyOf(payload, 64)); check(at > 0, "payload");
      zip[at + 100] ^= 1; File bad = new File(root, "bad.zip"); Files.write(bad.toPath(), zip);
      File dir = library(backup, a, null); byte[] before = read(file(dir, a));
      try (BackupInspection session = sealed(bad, backup)) {
        BackupInspection.Repaired result = session.repair(new OriginalStore(dir), a, payload.length, () -> false, () -> {});
        check(result.outcome == RepairOutcome.MISMATCH && !result.storeCleanupFailed, "mismatch");
      }
      check(Arrays.equals(before, read(file(dir, a))) && !new File(dir, "quarantine").exists(), "unchanged, nothing quarantined");
    });
    test("repair needs a sealed inspection session, never restore mode, and stops if the backup changes", () -> {
      try (BackupInspection open = BackupInspection.open(ArchiveSource.open(backup.file), null, () -> false)) {
        fails("backup-invalid", () -> open.repair(new OriginalStore(library(backup, a, null)), a, 1, () -> false, () -> {}));
      }
      File copy = new File(root, "changing.zip"); Files.copy(backup.file.toPath(), copy.toPath());
      File dir = library(backup, a, null); byte[] before = read(file(dir, a));
      try (BackupInspection session = sealed(copy, backup)) {
        Files.write(copy.toPath(), new byte[] { 0 }, StandardOpenOption.APPEND); copy.setLastModified(copy.lastModified() + 5000);
        fails("source-changed", () -> session.repair(new OriginalStore(dir), a, backup.objects.get(a).length, () -> false, () -> {}));
      }
      check(Arrays.equals(before, read(file(dir, a))), "unchanged");
    });
    test("through the gate: a repair failure keeps its code and reports a store staging leftover beside it", () -> {
      File dir = library(backup, a, null); File staging = new File(dir, "staging");
      InspectionGate<BackupInspection> gate = new InspectionGate<>(Runnable::run, error -> BackupInspection.code(error, false), () -> {});
      check(gate.beginWithStatus(() -> sealed(backup.file, backup)).code == null, "opened");
      OriginalStore store = new OriginalStore(dir, File::getUsableSpace, p -> { if (p.equals("after-chunk")) check(staging.setWritable(false), "locked"); if (p.equals("quarantine")) throw new IOException("injected"); });
      InspectionGate.Result<BackupInspection.Repaired> result;
      try { result = gate.run(session -> session.repair(store, a, backup.objects.get(a).length, () -> false, () -> {})); } finally { staging.setWritable(true); }
      check("quarantine-failed".equals(result.code) && result.storeCleanupFailed, "code and leftover: " + result.code);
      check(gate.finish() == null, "closed");
    });
    test("a bad copy from a backup that also changed reports source-changed, with the store leftover still beside it", () -> {
      byte[] zip = read(backup.file); byte[] payload = backup.objects.get(a); int at = indexOf(zip, Arrays.copyOf(payload, 64)); check(at > 0, "payload");
      zip[at + 100] ^= 1; File bad = new File(root, "bad-changing.zip"); Files.write(bad.toPath(), zip);
      File dir = library(backup, a, null); File staging = new File(dir, "staging"); byte[] before = read(file(dir, a));
      InspectionGate<BackupInspection> gate = new InspectionGate<>(Runnable::run, error -> BackupInspection.code(error, false), () -> {});
      check(gate.beginWithStatus(() -> sealed(bad, backup)).code == null, "opened");
      AtomicBoolean once = new AtomicBoolean();
      OriginalStore store = new OriginalStore(dir, File::getUsableSpace, p -> {
        if (p.equals("after-chunk") && once.compareAndSet(false, true)) {
          check(staging.setWritable(false), "locked");
          Files.write(bad.toPath(), new byte[] { 0 }, StandardOpenOption.APPEND); bad.setLastModified(bad.lastModified() + 5000);
        } });
      InspectionGate.Result<BackupInspection.Repaired> result;
      try { result = gate.run(session -> session.repair(store, a, payload.length, () -> false, () -> {})); } finally { staging.setWritable(true); }
      check("source-changed".equals(result.code) && result.storeCleanupFailed, "code and leftover: " + result.code + " " + result.storeCleanupFailed);
      check(gate.finish() == null && Arrays.equals(before, read(file(dir, a))), "unchanged");
    });
    test("a problem after the replacement is a warning on a completed repair, never an unchanged failure", () -> {
      File dir = library(backup, a, null);
      OriginalStore store = new OriginalStore(dir, File::getUsableSpace, p -> { if (p.equals("sync-object-directory")) throw new IOException("injected"); });
      try (BackupInspection session = sealed(backup.file, backup)) {
        BackupInspection.Repaired result = session.repair(store, a, backup.objects.get(a).length, () -> false, () -> {});
        check(result.outcome == RepairOutcome.REPAIRED && result.warnings.equals(Collections.singletonList("sync-failed")), "repaired with a warning");
      }
      check(Arrays.equals(backup.objects.get(a), read(file(dir, a))), "repaired bytes in place");
    });
    test("the second eviction runs after every completed repair, even with a sync warning, and both warnings are kept", () -> {
      for (boolean evictionFails : new boolean[] { false, true }) {
        File dir = library(backup, a, null); AtomicInteger after = new AtomicInteger();
        OriginalStore store = new OriginalStore(dir, File::getUsableSpace, p -> { if (p.equals("sync-object-directory")) throw new IOException("injected"); });
        try (BackupInspection session = sealed(backup.file, backup)) {
          BackupInspection.Repaired result = session.repair(store, a, backup.objects.get(a).length, () -> false, () -> {},
            () -> { after.incrementAndGet(); if (evictionFails) throw new IOException("thumbnail-eviction-failed"); });
          check(after.get() == 1, "eviction ran despite the sync warning");
          check(result.outcome == RepairOutcome.REPAIRED && result.warnings.equals(evictionFails ? Arrays.asList("sync-failed", "thumbnail-eviction-failed") : Collections.singletonList("sync-failed")),
            "repaired with " + result.warnings);
        }
        check(Arrays.equals(backup.objects.get(a), read(file(dir, a))), "repaired bytes in place");
      }
      File dir = library(backup, a, null); AtomicInteger after = new AtomicInteger();
      try (BackupInspection session = sealed(backup.file, backup)) {
        check(session.repair(new OriginalStore(dir), c, backup.objects.get(c).length, () -> false, () -> {}, after::incrementAndGet).outcome == RepairOutcome.ALREADY_VALID && after.get() == 0, "not after an already-valid file");
        BackupInspection.Repaired clean = session.repair(new OriginalStore(dir), a, backup.objects.get(a).length, () -> false, () -> {}, after::incrementAndGet);
        check(clean.outcome == RepairOutcome.REPAIRED && clean.warnings.isEmpty() && after.get() == 1, "a clean repair has no warnings");
      }
    });
    test("repair rejects an unsafe target before reading, and the same backup session can still repair a safe store", () -> {
      File dir = library(backup, null, a); OriginalStore store = new OriginalStore(dir);
      Path prefix = file(dir, a).toPath().getParent();
      // Move the existing prefix aside, then replace it with a link after the store was opened.
      Path outside = prefix.resolveSibling(prefix.getFileName() + "-kept"); Files.move(prefix, outside);
      Files.createSymbolicLink(prefix, outside);
      try (BackupInspection session = sealed(backup.file, backup)) {
        try {
          session.repair(store, a, backup.objects.get(a).length, () -> false, () -> {});
          throw new AssertionError("unsafe target accepted");
        } catch (IOException error) { check("unsafe-storage-path".equals(error.getMessage()), "raw unsafe-path failure"); }
        check(!Files.exists(file(dir, a).toPath()), "unsafe target unchanged");
        Files.delete(prefix); Files.move(outside, prefix);
        check(session.repair(store, a, backup.objects.get(a).length, () -> false, () -> {}).outcome == RepairOutcome.REPAIRED, "session remains usable");
        check(Arrays.equals(backup.objects.get(a), read(file(dir, a))), "exact repaired bytes");
      }
    });
    System.out.println(passed + " backup repair host tests passed. No device claim.");
  }
  static int indexOf(byte[] haystack, byte[] needle) {
    outer: for (int i = 0; i <= haystack.length - needle.length; i++) { for (int j = 0; j < needle.length; j++) if (haystack[i + j] != needle[j]) continue outer; return i; }
    return -1;
  }
}
