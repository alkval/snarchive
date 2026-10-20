import com.alkval.snarchive.sources.storage.*;
import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.CRC32;

/** OriginalStore.inspect and OriginalStore.repair (section 22) on a real directory, with real processes killed. */
public class OriginalRepairTest {
  interface Work { void run() throws Exception; }
  static File base; static int passed;
  static void check(boolean ok, String what) { if (!ok) throw new AssertionError(what); }
  static void test(String name, Work work) throws Exception { work.run(); passed++; System.out.println("PASS " + name); }
  static IOException fails(String code, Work work) throws Exception {
    try { work.run(); } catch (IOException e) { check(code.equals(e.getMessage()), "expected " + code + ", got " + e.getMessage()); return e; }
    throw new AssertionError("expected " + code);
  }
  static String sha(byte[] input) throws Exception {
    StringBuilder hex = new StringBuilder(); for (byte b : MessageDigest.getInstance("SHA-256").digest(input)) hex.append(String.format("%02x", b & 255)); return hex.toString();
  }
  static long crc(byte[] input) { CRC32 crc = new CRC32(); crc.update(input); return crc.getValue(); }
  static byte[] bytes(int size, int seed) { byte[] out = new byte[size]; new Random(seed).nextBytes(out); return out; }
  static final byte[] GOOD = bytes(200_000, 1);
  static final String HASH = sha0(GOOD);
  static String sha0(byte[] b) { try { return sha(b); } catch (Exception e) { throw new RuntimeException(e); } }
  static File root() throws Exception { return Files.createTempDirectory(base.toPath(), "store-").toFile(); }
  static File object(File root) { return new File(root, "objects/" + HASH.substring(0, 2) + "/" + HASH); }
  /** A store holding GOOD, then damaged in the given way. */
  static File damaged(String how) throws Exception {
    File root = root(); OriginalStore store = new OriginalStore(root);
    store.put(new ByteArrayInputStream(GOOD), GOOD.length, -1, new OriginalStore.Budget(1 << 30), () -> false);
    File file = object(root);
    switch (how) {
      case "same-length": { byte[] bad = GOOD.clone(); bad[123] ^= 1; Files.write(file.toPath(), bad); break; }
      case "truncated": Files.write(file.toPath(), Arrays.copyOf(GOOD, 1000)); break;
      case "missing": Files.delete(file.toPath()); break;
      case "valid": break;
      default: throw new AssertionError(how);
    }
    return root;
  }
  static List<byte[]> quarantine(File root) throws Exception {
    File dir = new File(root, "quarantine"); List<byte[]> out = new ArrayList<>();
    File[] files = dir.listFiles(); if (files == null) return out;
    Arrays.sort(files); for (File file : files) out.add(Files.readAllBytes(file.toPath()));
    return out;
  }
  static int staged(File root) { String[] names = new File(root, "staging").list(); return names == null ? 0 : names.length; }
  static OriginalStore.Repair repair(OriginalStore store, byte[] source, BooleanSupplierEx stop, OriginalStore.Check before) throws Exception {
    return full(store, source, stop, before).outcome;
  }
  static OriginalStore.RepairResult full(OriginalStore store, byte[] source, BooleanSupplierEx stop, OriginalStore.Check before) throws Exception {
    return store.repair(new ByteArrayInputStream(source), HASH, GOOD.length, crc(source), stop::get, before);
  }
  interface BooleanSupplierEx { boolean get(); }
  static byte[] read(File file) throws Exception { return Files.readAllBytes(file.toPath()); }
  static byte[] damagedCopy(File root) { byte[] bad = GOOD.clone(); bad[123] ^= 1; return bad; }

  public static void main(String[] args) throws Exception {
    if (args[0].startsWith("crash-")) { crashChild(args[0].substring(6), new File(args[1]), new File(args[2])); return; }
    base = Files.createTempDirectory(Paths.get(args[0]), "repair-").toFile();

    test("inspect classifies valid, missing, wrong-length, same-length and non-file objects without changing them", () -> {
      for (String how : new String[] { "valid", "missing", "truncated", "same-length" }) {
        File root = damaged(how); File file = object(root); byte[] before = file.exists() ? read(file) : null;
        OriginalStore.Health health = new OriginalStore(root).inspect(HASH, GOOD.length, () -> false);
        check(health == (how.equals("valid") ? OriginalStore.Health.VALID : how.equals("missing") ? OriginalStore.Health.MISSING : OriginalStore.Health.DAMAGED), how + ": " + health);
        check(before == null ? !file.exists() : Arrays.equals(before, read(file)), how + " unchanged");
      }
      File root = damaged("missing"); check(object(root).mkdir(), "a directory at the path");
      check(new OriginalStore(root).inspect(HASH, GOOD.length, () -> false) == OriginalStore.Health.DAMAGED, "not a regular file");
    });
    test("an unreadable object is reported as unreadable, not damaged; cancellation is not a verdict", () -> {
      File root = damaged("valid"); File file = object(root); check(file.setReadable(false), "chmod");
      try { check(new OriginalStore(root).inspect(HASH, GOOD.length, () -> false) == OriginalStore.Health.UNREADABLE, "unreadable"); }
      finally { file.setReadable(true); }
      fails("cancelled", () -> new OriginalStore(root).inspect(HASH, GOOD.length, () -> true));
    });
    test("missing, wrong-length and same-length damage are repaired with exact bytes; damaged copies are quarantined", () -> {
      for (String how : new String[] { "missing", "truncated", "same-length" }) {
        File root = damaged(how); byte[] before = object(root).exists() ? read(object(root)) : null;
        AtomicInteger evicted = new AtomicInteger();
        check(repair(new OriginalStore(root), GOOD, () -> false, evicted::incrementAndGet) == OriginalStore.Repair.REPAIRED, how);
        check(Arrays.equals(GOOD, read(object(root))) && evicted.get() == 1 && staged(root) == 0, how + ": exact bytes");
        List<byte[]> kept = quarantine(root);
        check(before == null ? kept.isEmpty() : kept.size() == 1 && Arrays.equals(before, kept.get(0)), how + ": quarantine");
        check(new OriginalStore(root).inspect(HASH, GOOD.length, () -> false) == OriginalStore.Health.VALID, how + ": verifies");
      }
    });
    test("an unreadable target is replaced and kept in quarantine", () -> {
      File root = damaged("same-length"); File file = object(root); byte[] before = read(file); check(file.setReadable(false), "chmod");
      try { check(repair(new OriginalStore(root), GOOD, () -> false, () -> {}) == OriginalStore.Repair.REPAIRED, "repaired"); }
      finally { file.setReadable(true); for (File q : Optional.ofNullable(new File(root, "quarantine").listFiles()).orElse(new File[0])) q.setReadable(true); }
      check(Arrays.equals(GOOD, read(object(root))) && Arrays.equals(before, quarantine(root).get(0)), "replaced, old kept");
    });
    test("a valid target is left exactly as it is: contents, modification time, no eviction, no quarantine, source unread", () -> {
      File root = damaged("valid"); File file = object(root); Files.setLastModifiedTime(file.toPath(), FileTime.fromMillis(1_600_000_000_000L));
      AtomicBoolean read = new AtomicBoolean(), closed = new AtomicBoolean(); AtomicInteger evicted = new AtomicInteger();
      InputStream source = new ByteArrayInputStream(GOOD) {
        @Override public synchronized int read(byte[] b, int off, int len) { read.set(true); return super.read(b, off, len); }
        @Override public void close() { closed.set(true); }
      };
      check(new OriginalStore(root).repair(source, HASH, GOOD.length, crc(GOOD), () -> false, evicted::incrementAndGet).outcome == OriginalStore.Repair.ALREADY_VALID, "already valid");
      check(Arrays.equals(GOOD, read(file)) && file.lastModified() == 1_600_000_000_000L, "unchanged");
      check(!read.get() && closed.get() && evicted.get() == 0 && quarantine(root).isEmpty() && staged(root) == 0, "nothing else happened");
    });
    test("wrong bytes, length or CRC never replace the target", () -> {
      byte[] wrong = GOOD.clone(); wrong[5] ^= 1;
      for (Object[] c : new Object[][] { { wrong, crc(wrong), "content-mismatch" }, { Arrays.copyOf(GOOD, GOOD.length - 1), -1L, "size-mismatch" },
          { Arrays.copyOf(GOOD, GOOD.length + 1), -1L, "size-mismatch" }, { GOOD, crc(GOOD) ^ 1, "crc-mismatch" } }) {
        File root = damaged("same-length"); byte[] before = read(object(root)); long time = object(root).lastModified(); AtomicInteger evicted = new AtomicInteger();
        fails((String) c[2], () -> new OriginalStore(root).repair(new ByteArrayInputStream((byte[]) c[0]), HASH, GOOD.length, (Long) c[1], () -> false, evicted::incrementAndGet));
        check(Arrays.equals(before, read(object(root))) && object(root).lastModified() == time && quarantine(root).isEmpty() && staged(root) == 0 && evicted.get() == 0, c[2] + ": unchanged");
      }
    });
    test("if quarantining fails the target is unchanged; where links fail, a synced copy is kept instead", () -> {
      File root = damaged("same-length"); byte[] before = read(object(root));
      OriginalStore failing = new OriginalStore(root, File::getUsableSpace, p -> { if (p.equals("quarantine")) throw new IOException("injected"); });
      fails("quarantine-failed", () -> repair(failing, GOOD, () -> false, () -> {}));
      check(Arrays.equals(before, read(object(root))) && quarantine(root).isEmpty() && staged(root) == 0, "unchanged");
      OriginalStore noLinks = new OriginalStore(root, File::getUsableSpace, p -> { if (p.equals("quarantine-link")) throw new IOException("no links here"); });
      check(repair(noLinks, GOOD, () -> false, () -> {}) == OriginalStore.Repair.REPAIRED, "repaired by copy");
      File kept = new File(root, "quarantine").listFiles()[0];
      check(Arrays.equals(before, read(kept)) && !Files.isSameFile(kept.toPath(), object(root).toPath()), "copy kept");
      File root2 = damaged("same-length"); byte[] before2 = read(object(root2));
      OriginalStore neither = new OriginalStore(root2, File::getUsableSpace, p -> { if (p.equals("quarantine-link") || p.equals("quarantine-copy")) throw new IOException("injected"); });
      fails("quarantine-failed", () -> repair(neither, GOOD, () -> false, () -> {}));
      check(Arrays.equals(before2, read(object(root2))) && staged(root2) == 0, "unchanged when neither works");
    });
    test("where links fail, an unreadable damaged file is still kept: owner-read for the copy, or its permissions put back", () -> {
      File root = damaged("same-length"); File file = object(root); byte[] before = read(file); check(file.setReadable(false), "chmod");
      OriginalStore noLinks = new OriginalStore(root, File::getUsableSpace, p -> { if (p.equals("quarantine-link")) throw new IOException("denied"); });
      check(repair(noLinks, GOOD, () -> false, () -> {}) == OriginalStore.Repair.REPAIRED, "repaired");
      File kept = new File(root, "quarantine").listFiles()[0];
      check(Arrays.equals(GOOD, read(object(root))) && Arrays.equals(before, read(kept)), "replaced; damaged bytes kept");
      File root2 = damaged("same-length"); File file2 = object(root2); check(file2.setReadable(false), "chmod");
      java.util.Set<java.nio.file.attribute.PosixFilePermission> mode = Files.getPosixFilePermissions(file2.toPath());
      OriginalStore failing = new OriginalStore(root2, File::getUsableSpace, p -> {
        if (p.equals("quarantine-link")) throw new IOException("denied");
        if (p.equals("quarantine-copy")) { /* Make the copy itself fail after permissions were granted. */ new File(root2, "quarantine").setWritable(false); } });
      try { fails("quarantine-failed", () -> repair(failing, GOOD, () -> false, () -> {})); } finally { new File(root2, "quarantine").setWritable(true); }
      check(Files.getPosixFilePermissions(file2.toPath()).equals(mode), "permissions put back");
      file2.setReadable(true); check(Arrays.equals(read(file2), damagedCopy(root2)), "target unchanged");
    });
    test("a failed thumbnail eviction leaves the target unchanged", () -> {
      File root = damaged("same-length"); byte[] before = read(object(root));
      fails("thumbnail-eviction-failed", () -> repair(new OriginalStore(root), GOOD, () -> false, () -> { throw new IOException("thumbnail-eviction-failed"); }));
      check(Arrays.equals(before, read(object(root))) && quarantine(root).isEmpty() && staged(root) == 0, "unchanged");
    });
    test("cancellation before the replacement leaves the target unchanged; after it, the repair stands", () -> {
      for (String point : new String[] { "after-chunk", "before-replace", "after-quarantine" }) {
        File root = damaged("same-length"); byte[] before = read(object(root)); AtomicBoolean stop = new AtomicBoolean();
        OriginalStore store = new OriginalStore(root, File::getUsableSpace, p -> { if (p.equals(point)) stop.set(true); });
        fails("cancelled", () -> repair(store, GOOD, stop::get, () -> {}));
        check(Arrays.equals(before, read(object(root))) && staged(root) == 0, point + ": unchanged");
      }
      File root = damaged("same-length"); AtomicBoolean stop = new AtomicBoolean();
      OriginalStore store = new OriginalStore(root, File::getUsableSpace, p -> { if (p.equals("after-replace")) stop.set(true); });
      check(repair(store, GOOD, stop::get, () -> {}) == OriginalStore.Repair.REPAIRED && Arrays.equals(GOOD, read(object(root))), "cancel after the rename is too late");
    });
    test("a file that appears at a missing target before the fill is not replaced", () -> {
      File root = damaged("missing"); byte[] other = bytes(10, 9);
      OriginalStore store = new OriginalStore(root, File::getUsableSpace, p -> { if (p.equals("before-fill")) Files.write(object(root).toPath(), other); });
      fails("repair-target-appeared", () -> repair(store, GOOD, () -> false, () -> {}));
      check(Arrays.equals(other, read(object(root))) && staged(root) == 0, "appeared file kept");
    });
    test("writer contention, and a staging part that cannot be deleted, keep the original error", () -> {
      File root = damaged("same-length"); byte[] before = read(object(root));
      try (RandomAccessFile lock = new RandomAccessFile(new File(root, "writer.lock"), "rw"); java.nio.channels.FileLock held = lock.getChannel().lock()) {
        fails("storage-busy", () -> repair(new OriginalStore(root), GOOD, () -> false, () -> {}));
      }
      File staging = new File(root, "staging"); byte[] wrong = GOOD.clone(); wrong[7] ^= 1;
      OriginalStore store = new OriginalStore(root, File::getUsableSpace, p -> { if (p.equals("after-chunk")) check(staging.setWritable(false), "locked"); });
      IOException error;
      try { error = fails("content-mismatch", () -> repair(store, wrong, () -> false, () -> {})); } finally { staging.setWritable(true); }
      check(Arrays.stream(error.getSuppressed()).anyMatch(s -> OriginalStore.STAGING_CLEANUP_FAILED.equals(s.getMessage())), "cleanup attached");
      check(Arrays.equals(before, read(object(root))), "unchanged");
      check(new OriginalStore(root).recoverStaging() == 1 && repair(new OriginalStore(root), GOOD, () -> false, () -> {}) == OriginalStore.Repair.REPAIRED, "retry");
    });
    test("faults after quarantine or after the rename leave a damaged or a valid file, never neither; repeats use unique quarantine names", () -> {
      File root = damaged("same-length"); byte[] before = read(object(root));
      OriginalStore beforeRename = new OriginalStore(root, File::getUsableSpace, p -> { if (p.equals("after-quarantine")) throw new IOException("injected"); });
      fails("injected", () -> repair(beforeRename, GOOD, () -> false, () -> {}));
      check(Arrays.equals(before, read(object(root))) && quarantine(root).size() == 1 && staged(root) == 0, "still damaged, one copy kept");
      // A failure after the rename is not an unchanged target: the repair is reported, with a warning.
      OriginalStore afterRename = new OriginalStore(root, File::getUsableSpace, p -> { if (p.equals("after-replace")) throw new IOException("injected"); });
      OriginalStore.RepairResult late = full(afterRename, GOOD, () -> false, () -> {});
      check(late.outcome == OriginalStore.Repair.REPAIRED && "sync-failed".equals(late.warning), "repaired with a warning");
      check(Arrays.equals(GOOD, read(object(root))) && quarantine(root).size() == 2, "replaced; a second, uniquely named copy");
      check(repair(new OriginalStore(root), GOOD, () -> false, () -> {}) == OriginalStore.Repair.ALREADY_VALID, "now valid");
    });
    test("a process killed mid-repair leaves the old or the new file; recovery then completes; thumbnails never outlive the damage", () -> {
      for (String point : new String[] { "after-chunk", "after-quarantine", "after-replace" }) {
        File root = damaged("same-length"); byte[] before = read(object(root));
        File cache = Files.createTempDirectory(base.toPath(), "cache-").toFile(); File thumbs = new File(cache, ThumbnailFiles.DIRECTORY); thumbs.mkdirs();
        File thumb = new File(thumbs, HASH + "-photo.jpg"); Files.write(thumb.toPath(), new byte[] { 1, 2, 3 }); // Made from the damaged bytes.
        Process child = new ProcessBuilder(new File(System.getProperty("java.home"), "bin/java").getPath(), "-cp", System.getProperty("java.class.path"),
          "OriginalRepairTest", "crash-" + point, root.getPath(), cache.getPath()).inheritIO().start();
        check(child.waitFor() == 23, point + ": halted");
        byte[] now = read(object(root));
        check(Arrays.equals(now, point.equals("after-replace") ? GOOD : before), point + ": old or new, never neither");
        check(point.equals("after-chunk") ? thumb.exists() : !thumb.exists(), point + ": thumbnail evicted before any replacement");
        OriginalStore store = new OriginalStore(root); store.recoverStaging(); check(staged(root) == 0, point + ": staging recovered");
        OriginalStore.Repair again = repair(store, GOOD, () -> false, () -> ThumbnailFiles.evict(cache, HASH));
        check(again == (point.equals("after-replace") ? OriginalStore.Repair.ALREADY_VALID : OriginalStore.Repair.REPAIRED) && Arrays.equals(GOOD, read(object(root))), point + ": recovered");
        check(!thumb.exists(), point + ": no thumbnail of damaged bytes remains");
      }
    });
    test("cancelling the quarantine copy keeps cancellation as the code, removes the partial copy and restores permissions", () -> {
      File root = damaged("same-length"); File file = object(root); byte[] before = read(file); check(file.setReadable(false), "chmod");
      java.util.Set<java.nio.file.attribute.PosixFilePermission> mode = Files.getPosixFilePermissions(file.toPath());
      AtomicBoolean stop = new AtomicBoolean(); AtomicInteger chunks = new AtomicInteger();
      OriginalStore copying = new OriginalStore(root, File::getUsableSpace, p -> {
        if (p.equals("quarantine-link")) throw new IOException("denied");
        if (p.equals("quarantine-chunk") && chunks.incrementAndGet() == 2) stop.set(true); });
      fails("cancelled", () -> repair(copying, GOOD, stop::get, () -> {}));
      check(chunks.get() == 2 && quarantine(root).isEmpty() && staged(root) == 0, "stopped mid-copy; partial copy removed");
      check(Files.getPosixFilePermissions(file.toPath()).equals(mode), "permissions restored");
      file.setReadable(true); check(Arrays.equals(before, read(file)), "target unchanged");
      // A partial copy that cannot be removed is attached to the cancellation, which stays the code.
      File quarantineDir = new File(root, "quarantine"); stop.set(false); chunks.set(0);
      OriginalStore stuck = new OriginalStore(root, File::getUsableSpace, p -> {
        if (p.equals("quarantine-link")) throw new IOException("denied");
        if (p.equals("quarantine-chunk") && chunks.incrementAndGet() == 1) { stop.set(true); check(quarantineDir.setWritable(false), "locked"); } });
      IOException error;
      try { error = fails("cancelled", () -> repair(stuck, GOOD, stop::get, () -> {})); } finally { quarantineDir.setWritable(true); }
      check(Arrays.stream(error.getSuppressed()).anyMatch(e -> "quarantine-cleanup-failed".equals(e.getMessage())), "cleanup failure attached");
      check(Arrays.equals(before, read(file)), "target unchanged");
    });
    test("inspect honours cancellation before an early verdict (missing or wrong length)", () -> {
      for (String how : new String[] { "missing", "truncated" }) fails("cancelled", () -> new OriginalStore(damaged(how)).inspect(HASH, GOOD.length, () -> true));
    });
    test("an object under a directory that cannot be searched is unreadable, not missing, and repair leaves it alone", () -> {
      File root = damaged("valid"); File prefix = object(root).getParentFile(); check(prefix.setExecutable(false) && prefix.setReadable(false), "chmod");
      try {
        check(new OriginalStore(root).inspect(HASH, GOOD.length, () -> false) == OriginalStore.Health.UNREADABLE, "unreadable, not missing");
        fails("repair-target-inaccessible", () -> repair(new OriginalStore(root), GOOD, () -> false, () -> {}));
        check(staged(root) == 0 && quarantine(root).isEmpty(), "nothing staged or kept");
      } finally { prefix.setExecutable(true); prefix.setReadable(true); }
      check(Arrays.equals(GOOD, read(object(root))), "the object is untouched");
      File missing = damaged("missing"); check(new OriginalStore(missing).inspect(HASH, GOOD.length, () -> false) == OriginalStore.Health.MISSING, "a genuinely missing object");
      File noPrefix = damaged("missing"); Files.delete(object(noPrefix).getParentFile().toPath());
      check(new OriginalStore(noPrefix).inspect(HASH, GOOD.length, () -> false) == OriginalStore.Health.MISSING, "a missing prefix directory is absence too");
    });
    test("directory syncs: a failure before the replacement changes nothing; after it the repair stands with a warning", () -> {
      for (String point : new String[] { "sync-quarantine", "sync-quarantine-parent", "sync-prefix-parent" }) {
        File root = damaged(point.equals("sync-prefix-parent") ? "missing" : "same-length");
        if (point.equals("sync-prefix-parent")) Files.delete(object(root).getParentFile().toPath()); // The prefix directory must be created.
        boolean existed = object(root).exists(); byte[] before = existed ? read(object(root)) : null;
        OriginalStore store = new OriginalStore(root, File::getUsableSpace, p -> { if (p.equals(point)) throw new IOException("injected"); });
        fails("injected", () -> repair(store, GOOD, () -> false, () -> {}));
        check(existed ? Arrays.equals(before, read(object(root))) : !object(root).exists(), point + ": target unchanged");
        check(staged(root) == 0, point + ": staging clean");
      }
      for (String point : new String[] { "sync-object-directory", "sync-staging-directory" }) {
        File root = damaged("same-length");
        OriginalStore store = new OriginalStore(root, File::getUsableSpace, p -> { if (p.equals(point)) throw new IOException("injected"); });
        OriginalStore.RepairResult result = full(store, GOOD, () -> false, () -> {});
        check(result.outcome == OriginalStore.Repair.REPAIRED && "sync-failed".equals(result.warning) && Arrays.equals(GOOD, read(object(root))), point + ": repaired with a warning");
      }
      // The calls a repair makes (fault points; these tests check the calls and their failures, not power loss).
      File root = damaged("missing"); Files.delete(object(root).getParentFile().toPath()); List<String> calls = new ArrayList<>();
      OriginalStore recording = new OriginalStore(root, File::getUsableSpace, p -> { if (p.startsWith("sync-")) calls.add(p); });
      check(repair(recording, GOOD, () -> false, () -> {}) == OriginalStore.Repair.REPAIRED, "repaired");
      check(calls.equals(Arrays.asList("sync-prefix-parent", "sync-object-directory", "sync-staging-directory")), "missing target: " + calls);
      File damagedRoot = damaged("same-length"); List<String> replacing = new ArrayList<>();
      check(repair(new OriginalStore(damagedRoot, File::getUsableSpace, p -> { if (p.startsWith("sync-")) replacing.add(p); }), GOOD, () -> false, () -> {}) == OriginalStore.Repair.REPAIRED, "repaired");
      check(replacing.equals(Arrays.asList("sync-prefix-parent", "sync-quarantine-parent", "sync-quarantine", "sync-object-directory", "sync-staging-directory")), "existing target: " + replacing);
    });
    test("a directory left by an attempt whose parent sync failed is synced again by the next repair", () -> {
      // quarantine/: created by the first attempt, whose parent sync then failed.
      File root = damaged("same-length"); byte[] before = read(object(root)); AtomicBoolean failOnce = new AtomicBoolean(true);
      OriginalStore first = new OriginalStore(root, File::getUsableSpace, p -> { if (p.equals("sync-quarantine-parent") && failOnce.getAndSet(false)) throw new IOException("injected"); });
      fails("injected", () -> repair(first, GOOD, () -> false, () -> {}));
      check(new File(root, "quarantine").isDirectory() && Arrays.equals(before, read(object(root))) && staged(root) == 0, "directory left, target unchanged");
      List<String> calls = new ArrayList<>();
      OriginalStore.RepairResult retry = full(new OriginalStore(root, File::getUsableSpace, p -> { if (p.startsWith("sync-")) calls.add(p); }), GOOD, () -> false, () -> {});
      check(retry.outcome == OriginalStore.Repair.REPAIRED && retry.warning == null && calls.contains("sync-quarantine-parent"), "retry syncs its parent: " + calls);
      // The object's prefix directory: created by the first attempt, whose parent sync then failed.
      File missing = damaged("missing"); Files.delete(object(missing).getParentFile().toPath()); AtomicBoolean prefixOnce = new AtomicBoolean(true);
      OriginalStore firstFill = new OriginalStore(missing, File::getUsableSpace, p -> { if (p.equals("sync-prefix-parent") && prefixOnce.getAndSet(false)) throw new IOException("injected"); });
      fails("injected", () -> repair(firstFill, GOOD, () -> false, () -> {}));
      check(object(missing).getParentFile().isDirectory() && !object(missing).exists() && staged(missing) == 0, "prefix left, target still missing");
      List<String> fill = new ArrayList<>();
      OriginalStore.RepairResult filled = full(new OriginalStore(missing, File::getUsableSpace, p -> { if (p.startsWith("sync-")) fill.add(p); }), GOOD, () -> false, () -> {});
      check(filled.outcome == OriginalStore.Repair.REPAIRED && fill.contains("sync-prefix-parent") && Arrays.equals(GOOD, read(object(missing))), "retry syncs the prefix's parent: " + fill);
    });
    test("thumbnail eviction removes only that original's derivatives and reports a file it cannot delete", () -> {
      File cache = Files.createTempDirectory(base.toPath(), "cache-").toFile(); File thumbs = new File(cache, ThumbnailFiles.DIRECTORY); thumbs.mkdirs();
      String other = String.join("", Collections.nCopies(64, "b"));
      for (String name : new String[] { HASH + "-photo.jpg", HASH + "-video.jpg", other + "-photo.jpg" }) Files.write(new File(thumbs, name).toPath(), new byte[] { 1 });
      ThumbnailFiles.evict(cache, HASH);
      check(!new File(thumbs, HASH + "-photo.jpg").exists() && !new File(thumbs, HASH + "-video.jpg").exists() && new File(thumbs, other + "-photo.jpg").exists(), "only this hash");
      ThumbnailFiles.evict(cache, HASH); // Absent is fine.
      Files.write(new File(thumbs, HASH + "-photo.jpg").toPath(), new byte[] { 1 }); check(thumbs.setWritable(false), "locked");
      try { fails("thumbnail-eviction-failed", () -> ThumbnailFiles.evict(cache, HASH)); } finally { thumbs.setWritable(true); }
      fails("invalid-object", () -> ThumbnailFiles.evict(cache, "../x"));
    });
    System.out.println(passed + " original repair host tests passed. No device claim.");
  }

  /** Child process: halts (as a killed app would) at a point in a repair whose replacement evicts thumbnails first. */
  static void crashChild(String point, File root, File cache) throws Exception {
    OriginalStore store = new OriginalStore(root, File::getUsableSpace, p -> { if (p.equals(point)) Runtime.getRuntime().halt(23); });
    store.repair(new ByteArrayInputStream(GOOD), HASH, GOOD.length, crc(GOOD), () -> false, () -> ThumbnailFiles.evict(cache, HASH));
    throw new AssertionError("crash point not reached");
  }
}
