import com.alkval.snarchive.sources.backup.InspectionGate;
import com.alkval.snarchive.sources.storage.*;
import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;

/** StorageReview (section 24) on a real directory: listing, the writer lock, exact removal and refusals, faults, and
 * real processes halted around the unlink. Whether an object is referenced is decided in JS (tests/storageCleanup.test.ts). */
public class StorageReviewTest {
  interface Work { void run() throws Exception; }
  static File base; static int passed;
  static void check(boolean ok, String what) { if (!ok) throw new AssertionError(what); }
  static void test(String name, Work work) throws Exception { work.run(); passed++; System.out.println("PASS " + name); }
  static IOException fails(String code, Work work) throws Exception {
    try { work.run(); } catch (IOException e) { check(code.equals(e.getMessage()), "expected " + code + ", got " + e.getMessage()); return e; }
    throw new AssertionError("expected " + code);
  }
  static String sha(byte[] input) {
    try {
      StringBuilder hex = new StringBuilder(); for (byte b : MessageDigest.getInstance("SHA-256").digest(input)) hex.append(String.format("%02x", b & 255)); return hex.toString();
    } catch (Exception e) { throw new RuntimeException(e); }
  }
  static byte[] bytes(int size, int seed) { byte[] out = new byte[size]; new Random(seed).nextBytes(out); return out; }
  static File root() throws Exception { return Files.createTempDirectory(base.toPath(), "store-").toFile(); }
  static String put(OriginalStore store, byte[] content) throws Exception {
    store.put(new ByteArrayInputStream(content), content.length, -1, new OriginalStore.Budget(1L << 30), () -> false); return sha(content);
  }
  static String objectPath(String hash) { return "objects/" + hash.substring(0, 2) + "/" + hash; }
  static String quarantine(File root, String hash, int seed) throws Exception {
    File dir = new File(root, "quarantine"); dir.mkdirs();
    String name = hash + "-" + (1700000000000L + seed) + "-" + String.format("%08x", seed);
    Files.write(new File(dir, name + ".damaged").toPath(), bytes(1000 + seed, seed)); return "quarantine/" + name + ".damaged";
  }
  static List<StorageReview.Entry> all(StorageReview review, String kind, int limit, int[] unrecognized) throws Exception {
    List<StorageReview.Entry> out = new ArrayList<>();
    for (String after = ""; ; ) {
      StorageReview.Page page = review.page(kind, after, limit, () -> false);
      out.addAll(page.entries); if (unrecognized != null) unrecognized[0] += page.unrecognized;
      if (page.next == null) return out;
      check(page.entries.size() == limit, "only full pages have a cursor");
      after = page.next;
    }
  }
  static StorageReview.Entry entry(StorageReview review, String kind, String path) throws Exception {
    for (StorageReview.Entry e : all(review, kind, 1000, null)) if (e.path.equals(path)) return e;
    throw new AssertionError("not listed: " + path);
  }
  static List<String> paths(List<StorageReview.Entry> entries) { List<String> out = new ArrayList<>(); for (StorageReview.Entry e : entries) out.add(e.path); return out; }
  static Process child(String... args) throws Exception {
    List<String> command = new ArrayList<>(Arrays.asList(new File(System.getProperty("java.home"), "bin/java").getPath(), "-cp", System.getProperty("java.class.path"), "StorageReviewTest"));
    command.addAll(Arrays.asList(args));
    return new ProcessBuilder(command).redirectError(ProcessBuilder.Redirect.INHERIT).start();
  }

  public static void main(String[] args) throws Exception {
    if (args[0].equals("hold")) { holdChild(new File(args[1])); return; }
    if (args[0].startsWith("crash-")) { crashChild(args[0].substring(6), new File(args[1]), args[2], args[3], args[4]); return; }
    base = Files.createTempDirectory(Paths.get(args[0]), "review-").toFile();

    test("a scan lists object and quarantine files in path order across pages, and counts but never lists anything else", () -> {
      File root = root(); OriginalStore store = new OriginalStore(root);
      List<String> objects = new ArrayList<>();
      for (int i = 0; i < 7; i++) objects.add(objectPath(put(store, bytes(100 + i, i))));
      Collections.sort(objects);
      String h0 = objects.get(0).substring(11);
      List<String> kept = new ArrayList<>(Arrays.asList(quarantine(root, h0, 1), quarantine(root, h0, 2), quarantine(root, h0, 3)));
      Collections.sort(kept);
      // Never candidates: staging parts, unknown names, links, directories, a hash under the wrong prefix.
      Files.write(new File(root, "staging/" + UUID.randomUUID() + ".part").toPath(), bytes(10, 9));
      File prefix = new File(root, objects.get(0)).getParentFile();
      Files.write(new File(prefix, "notes.txt").toPath(), bytes(3, 3));
      Files.createSymbolicLink(new File(prefix, sha(bytes(1, 77)).replaceFirst("^..", prefix.getName())).toPath(), new File(root, objects.get(1)).toPath());
      new File(prefix, prefix.getName() + String.join("", Collections.nCopies(62, "0"))).mkdir();
      String wrongPrefix = sha(bytes(5, 5)); if (wrongPrefix.startsWith(prefix.getName())) throw new AssertionError("fixture");
      Files.write(new File(prefix, wrongPrefix).toPath(), bytes(5, 5));
      new File(root, "objects/zz").mkdir();
      Files.createSymbolicLink(new File(root, "objects/ff").toPath(), prefix.toPath());
      Files.write(new File(root, "quarantine/other.damaged").toPath(), bytes(4, 4));
      Files.createSymbolicLink(new File(root, "quarantine/" + h0 + "-1-0000000a.damaged").toPath(), new File(root, objects.get(0)).toPath());
      byte[] before = Files.readAllBytes(new File(root, objects.get(0)).toPath());
      try (StorageReview review = StorageReview.scan(store)) {
        for (int limit : new int[] { 1, 2, 3, 1000 }) {
          int[] unrecognized = { 0 }, unknownKept = { 0 };
          check(paths(all(review, "object", limit, unrecognized)).equals(objects), "objects in order, limit " + limit);
          check(paths(all(review, "quarantine", limit, unknownKept)).equals(kept), "quarantine in order, limit " + limit);
          check(unrecognized[0] == 6 && unknownKept[0] == 2, "unrecognized counted once: " + unrecognized[0] + "/" + unknownKept[0]);
        }
        StorageReview.Entry first = entry(review, "object", objects.get(0));
        check(first.hash.equals(h0) && first.bytes == before.length && first.identity.contains("|" + before.length + "|"), "entry fields");
        check(entry(review, "quarantine", kept.get(0)).hash.equals(h0), "quarantine hash from the name");
        fails("invalid-entry", () -> review.page("staging", "", 10, () -> false));
        fails("invalid-entry", () -> review.page("object", "", 1001, () -> false));
        fails("cancelled", () -> review.page("object", "", 10, () -> true));
        // A scan session cannot remove.
        fails("invalid-entry", () -> review.remove("object", objects.get(0), first.identity, () -> false));
      }
      check(Arrays.equals(before, Files.readAllBytes(new File(root, objects.get(0)).toPath())), "scan changed nothing");
      check(new File(root, "staging").list().length == 1, "staging untouched");
    });

    test("an empty or new store lists nothing", () -> {
      File root = root(); OriginalStore store = new OriginalStore(root);
      try (StorageReview review = StorageReview.scan(store)) {
        check(all(review, "object", 10, null).isEmpty() && all(review, "quarantine", 10, null).isEmpty(), "empty");
      }
    });

    test("a cleanup session holds the writer lock: other writers in this and other processes are refused until it closes", () -> {
      File root = root(); OriginalStore store = new OriginalStore(root);
      StorageReview cleanup = StorageReview.cleanup(store);
      // Refused attempts in this process must not drop the lock (closing any descriptor of a POSIX-locked file would).
      fails("storage-busy", () -> StorageReview.cleanup(new OriginalStore(root)));
      fails("storage-busy", () -> put(new OriginalStore(root), bytes(50, 50)));
      fails("storage-busy", () -> new OriginalStore(root).recoverStaging());
      Process other = child("hold", root.getPath());
      check(other.waitFor() == 31, "another process is refused while held, after refused attempts here");
      cleanup.close(); cleanup.close(); // Released once.
      put(new OriginalStore(root), bytes(50, 50));
      // And the other way round: a session in another process blocks this one.
      Process holder = child("hold", root.getPath());
      BufferedReader out = new BufferedReader(new InputStreamReader(holder.getInputStream()));
      check("held".equals(out.readLine()), "child holds the lock");
      fails("storage-busy", () -> StorageReview.cleanup(store));
      fails("storage-busy", () -> put(store, bytes(51, 51)));
      holder.getOutputStream().close();
      check(holder.waitFor() == 0, "child released");
      try (StorageReview again = StorageReview.cleanup(store)) { check(again != null, "free again"); }
    });

    test("removes exactly the selected file and syncs its directory; unselected files are untouched", () -> {
      File root = root(); OriginalStore store = new OriginalStore(root);
      String a = objectPath(put(store, bytes(300, 1))), b = objectPath(put(store, bytes(301, 2)));
      String h = a.substring(11), q1 = quarantine(root, h, 1), q2 = quarantine(root, h, 2);
      byte[] bBytes = Files.readAllBytes(new File(root, b).toPath()), q2Bytes = Files.readAllBytes(new File(root, q2).toPath());
      List<String> syncs = new ArrayList<>();
      OriginalStore watched = new OriginalStore(root, File::getUsableSpace, point -> syncs.add(point));
      try (StorageReview review = StorageReview.cleanup(watched)) {
        StorageReview.Removal removed = review.remove("object", a, entry(review, "object", a).identity, () -> false);
        check(removed.outcome.equals("removed") && removed.warning == null, "removed");
        StorageReview.Removal kept = review.remove("quarantine", q1, entry(review, "quarantine", q1).identity, () -> false);
        check(kept.outcome.equals("removed"), "quarantine copy removed");
      }
      check(!new File(root, a).exists() && !new File(root, q1).exists(), "selected gone");
      check(Arrays.equals(bBytes, Files.readAllBytes(new File(root, b).toPath())) && Arrays.equals(q2Bytes, Files.readAllBytes(new File(root, q2).toPath())), "unselected unchanged");
      check(syncs.equals(Arrays.asList("before-unlink", "after-unlink", "sync-cleanup-directory", "before-unlink", "after-unlink", "sync-cleanup-directory")), "fault points " + syncs);
    });

    test("a changed, replaced, linked or missing file is skipped, never removed", () -> {
      File root = root(); OriginalStore store = new OriginalStore(root);
      String a = objectPath(put(store, bytes(400, 1))), b = objectPath(put(store, bytes(401, 2))), c = objectPath(put(store, bytes(402, 3)));
      String q = quarantine(root, a.substring(11), 4);
      try (StorageReview review = StorageReview.cleanup(store)) {
        String ia = entry(review, "object", a).identity, ib = entry(review, "object", b).identity, ic = entry(review, "object", c).identity, iq = entry(review, "quarantine", q).identity;
        Files.write(new File(root, a).toPath(), bytes(399, 9)); // Different length.
        Files.setLastModifiedTime(new File(root, b).toPath(), FileTime.fromMillis(946684800000L)); // Same bytes, new time.
        File cFile = new File(root, c), moved = new File(root, "moved"); // Replaced by another file of the same size and time.
        long time = cFile.lastModified(); Files.move(cFile.toPath(), moved.toPath()); Files.write(cFile.toPath(), bytes(402, 3)); cFile.setLastModified(time);
        Files.delete(new File(root, q).toPath());
        Files.createDirectory(new File(root, q).toPath()); // A directory where the copy was.
        for (String[] e : new String[][] { { "object", a, ia }, { "object", b, ib }, { "object", c, ic }, { "quarantine", q, iq } }) {
          StorageReview.Removal r = review.remove(e[0], e[1], e[2], () -> false);
          check(r.outcome.equals("skipped") && r.reason.equals("changed"), e[1] + ": " + r.outcome + "/" + r.reason);
        }
        check(new File(root, a).isFile() && new File(root, b).isFile() && cFile.isFile() && new File(root, q).isDirectory(), "all kept");
        Files.delete(new File(root, b).toPath());
        StorageReview.Removal gone = review.remove("object", b, ib, () -> false);
        check(gone.outcome.equals("skipped") && gone.reason.equals("missing"), "missing");
      }
    });

    test("links, traversal, unexpected names and staging parts are refused before anything is touched", () -> {
      File root = root(); OriginalStore store = new OriginalStore(root);
      String a = objectPath(put(store, bytes(500, 1))); String h = a.substring(11);
      File outside = new File(base, "outside-" + System.nanoTime()); Files.write(outside.toPath(), bytes(500, 1));
      String linkedHash = sha(bytes(500, 2)), linkedPrefix = linkedHash.substring(0, 2);
      // A link in place of an object file, and a prefix directory that is a link elsewhere.
      new File(root, "objects/" + linkedPrefix).mkdirs();
      File link = new File(root, objectPath(linkedHash)); Files.createSymbolicLink(link.toPath(), outside.toPath());
      String candidate = sha(bytes(500, 3)); while (candidate.startsWith(linkedPrefix) || candidate.startsWith(h.substring(0, 2))) candidate = sha(candidate.getBytes());
      String other = candidate;
      File elsewhere = new File(base, "elsewhere-" + System.nanoTime()); elsewhere.mkdirs(); Files.write(new File(elsewhere, other).toPath(), bytes(9, 9));
      Files.createSymbolicLink(new File(root, "objects/" + other.substring(0, 2)).toPath(), elsewhere.toPath());
      String staging = "staging/" + UUID.randomUUID() + ".part"; Files.write(new File(root, staging).toPath(), bytes(9, 9));
      try (StorageReview review = StorageReview.cleanup(store)) {
        String id = entry(review, "object", a).identity;
        String linkId = Files.readAttributes(outside.toPath(), java.nio.file.attribute.BasicFileAttributes.class).fileKey() + "|500|" + outside.lastModified();
        fails("unsafe-path", () -> review.remove("object", objectPath(linkedHash), linkId, () -> false));
        fails("unsafe-path", () -> review.remove("object", objectPath(other), id, () -> false));
        for (String[] bad : new String[][] {
          { "object", "objects/" + h.substring(0, 2) + "/../" + h.substring(0, 2) + "/" + h }, { "object", "../" + a }, { "object", "/" + a },
          { "object", "objects/" + h.substring(0, 2) + "/" + h.toUpperCase() }, { "object", "objects/" + (h.startsWith("00") ? "01" : "00") + "/" + h },
          { "object", staging }, { "quarantine", staging }, { "quarantine", a }, { "object", "quarantine/" + h + "-1-00000000.damaged" },
          { "quarantine", "quarantine/" + h + "-1-0000000.damaged" }, { "quarantine", "quarantine/x/../" + h + "-1-00000000.damaged" },
          { "thumbnail", a }, { "object", "" } }) {
          fails("invalid-entry", () -> review.remove(bad[0], bad[1], id, () -> false));
        }
        fails("invalid-entry", () -> review.remove("object", a, null, () -> false));
      }
      check(new File(root, a).isFile() && outside.isFile() && new File(elsewhere, other).isFile() && Files.isSymbolicLink(link.toPath()) && new File(root, staging).isFile(), "nothing touched");
    });

    test("permission errors: an unreadable directory is inaccessible, an unwritable one is a failed delete; both keep the file", () -> {
      File root = root(); OriginalStore store = new OriginalStore(root);
      String a = objectPath(put(store, bytes(600, 1))); File parent = new File(root, a).getParentFile();
      try (StorageReview review = StorageReview.cleanup(store)) {
        String id = entry(review, "object", a).identity;
        check(parent.setWritable(false), "chmod -w");
        try { fails("delete-failed", () -> review.remove("object", a, id, () -> false)); } finally { parent.setWritable(true); }
        check(parent.setExecutable(false), "chmod -x");
        try { fails("inaccessible", () -> review.remove("object", a, id, () -> false)); } finally { parent.setExecutable(true); }
        check(new File(root, a).isFile(), "kept");
        check(review.remove("object", a, id, () -> false).outcome.equals("removed"), "removable once permitted");
      }
    });

    test("cancellation before the unlink keeps the file; a failure at the unlink point keeps it too", () -> {
      File root = root(); AtomicInteger calls = new AtomicInteger();
      OriginalStore store = new OriginalStore(root, File::getUsableSpace, point -> { if (point.equals("before-unlink") && calls.incrementAndGet() == 1) throw new IOException("injected"); });
      String a = objectPath(put(store, bytes(700, 1)));
      try (StorageReview review = StorageReview.cleanup(store)) {
        String id = entry(review, "object", a).identity;
        fails("cancelled", () -> review.remove("object", a, id, () -> true));
        check(calls.get() == 0 && new File(root, a).isFile(), "cancelled before the fault point");
        fails("injected", () -> review.remove("object", a, id, () -> false));
        check(new File(root, a).isFile(), "kept after a failure before unlink");
        check(review.remove("object", a, id, () -> false).outcome.equals("removed"), "then removed");
      }
    });

    test("a failure after the unlink is a warning on a completed removal, never a failure", () -> {
      for (String point : new String[] { "after-unlink", "sync-cleanup-directory" }) {
        File root = root();
        OriginalStore store = new OriginalStore(root, File::getUsableSpace, p -> { if (p.equals(point)) throw new IOException("injected"); });
        String a = objectPath(put(store, bytes(800, 1)));
        try (StorageReview review = StorageReview.cleanup(store)) {
          StorageReview.Removal r = review.remove("object", a, entry(review, "object", a).identity, () -> false);
          check(r.outcome.equals("removed") && "sync-failed".equals(r.warning), point + ": " + r.outcome + "/" + r.warning);
        }
        check(!new File(root, a).exists(), point + ": gone");
      }
    });

    test("a closed session removes nothing and lists nothing", () -> {
      File root = root(); OriginalStore store = new OriginalStore(root); String a = objectPath(put(store, bytes(900, 1)));
      StorageReview review = StorageReview.cleanup(store); String id = entry(review, "object", a).identity; review.close();
      fails("invalid-entry", () -> review.remove("object", a, id, () -> false));
      fails("invalid-entry", () -> review.page("object", "", 10, () -> false));
      check(new File(root, a).isFile(), "kept");
    });

    test("the shared guard is released exactly once: failed opening, normal finish, repeated finish and teardown during work", () -> {
      File root = root(); OriginalStore store = new OriginalStore(root); AtomicInteger released = new AtomicInteger();
      InspectionGate<StorageReview> gate = new InspectionGate<>(Runnable::run, e -> e.getMessage(), released::incrementAndGet);
      try (StorageReview held = StorageReview.cleanup(new OriginalStore(root))) {
        check("storage-busy".equals(gate.beginWithStatus(() -> StorageReview.cleanup(store)).code), "busy open");
      }
      check(released.get() == 1 && !gate.active(), "released after a failed open");
      check(gate.beginWithStatus(() -> StorageReview.cleanup(store)).code == null, "opened");
      check(gate.finish() == null && gate.finish() == null && released.get() == 2, "finished once");
      try (StorageReview free = StorageReview.cleanup(new OriginalStore(root))) { check(free != null, "lock released"); }
      check(gate.beginWithStatus(() -> StorageReview.cleanup(store)).code == null, "opened again");
      InspectionGate.Result<Integer> during = gate.run(review -> { gate.finishLater(); check(released.get() == 2, "not while working"); return 1; });
      check(during.value == 1 && released.get() == 3 && !gate.active(), "teardown finished after the work");
      gate.finishLater(); check(released.get() == 3, "no second release");
      try (StorageReview free = StorageReview.cleanup(new OriginalStore(root))) { check(free != null, "lock released after teardown"); }
    });

    test("a process killed before the unlink keeps the file; after it, the file is gone; the lock never outlives the process", () -> {
      for (String point : new String[] { "before-unlink", "after-unlink", "sync-cleanup-directory" }) {
        File root = root(); OriginalStore store = new OriginalStore(root);
        String a = objectPath(put(store, bytes(1000, 1))), b = objectPath(put(store, bytes(1001, 2)));
        String id;
        try (StorageReview review = StorageReview.scan(store)) { id = entry(review, "object", a).identity; }
        Process crashed = child("crash-" + point, root.getPath(), "object", a, id);
        check(crashed.waitFor() == 23, point + ": halted");
        check(new File(root, a).exists() == point.equals("before-unlink"), point + ": file state");
        check(new File(root, b).isFile(), point + ": other file kept");
        try (StorageReview again = StorageReview.cleanup(store)) {
          List<String> listed = paths(all(again, "object", 10, null));
          check(listed.contains(b) && listed.contains(a) == point.equals("before-unlink"), point + ": rescan " + listed);
        }
      }
    });

    System.out.println(passed + " storage review tests passed");
  }

  /** Child: exits 31 if the writer lock is taken; otherwise holds a cleanup session until stdin closes. */
  static void holdChild(File root) throws Exception {
    StorageReview review;
    try { review = StorageReview.cleanup(new OriginalStore(root)); } catch (IOException busy) { System.exit("storage-busy".equals(busy.getMessage()) ? 31 : 1); return; }
    System.out.println("held"); System.out.flush();
    while (System.in.read() != -1) { }
    review.close();
  }
  /** Child: halts (as a killed app would) at a point in a removal. */
  static void crashChild(String point, File root, String kind, String path, String identity) throws Exception {
    OriginalStore store = new OriginalStore(root, File::getUsableSpace, p -> { if (p.equals(point)) Runtime.getRuntime().halt(23); });
    try (StorageReview review = StorageReview.cleanup(store)) { review.remove(kind, path, identity, () -> false); }
    System.exit(1);
  }
}
