import com.alkval.snarchive.sources.backup.BackupCoordinator;
import com.alkval.snarchive.sources.backup.BackupSession;
import com.alkval.snarchive.sources.storage.OriginalStore;
import java.io.*;
import java.nio.file.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public class BackupCoordinatorTest {
  interface Work { void run() throws Exception; }
  static int passed;
  static void check(boolean ok, String what) { if (!ok) throw new AssertionError(what); }
  static void test(String name, Work work) throws Exception { work.run(); passed++; System.out.println("PASS " + name); }
  interface Reader { InputStream open(byte[] written) throws IOException; }
  /** Stands in for the Create Document result; any provider call can be made to fail or block. */
  static final class Doc implements BackupCoordinator.Destination {
    final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    Reader reader = ByteArrayInputStream::new;
    CountDownLatch writeGate, deleteGate; final CountDownLatch writing = new CountDownLatch(1), deleting = new CountDownLatch(1);
    final AtomicInteger deletes = new AtomicInteger(); boolean deleteResult = true;
    public OutputStream openOutput() {
      bytes.reset();
      return new FilterOutputStream(bytes) {
        @Override public void write(byte[] b, int off, int len) throws IOException {
          writing.countDown(); if (writeGate != null) try { writeGate.await(); } catch (InterruptedException e) { throw new IOException(e); }
          out.write(b, off, len);
        }
      };
    }
    public InputStream openInput() throws IOException { return reader.open(bytes.toByteArray()); }
    public boolean delete() throws Exception { deleting.countDown(); if (deleteGate != null) deleteGate.await(); deletes.incrementAndGet(); return deleteResult; }
  }
  static File staging; static OriginalStore store; static OriginalStore.Stored receipt;
  static final AtomicBoolean stop = new AtomicBoolean();
  static final AtomicInteger released = new AtomicInteger();
  static BackupCoordinator coordinator(Executor cleanup) { stop.set(false); released.set(0); return new BackupCoordinator(cleanup, stop::get, released::incrementAndGet); }
  static void prepare(BackupCoordinator backups, Doc doc) {
    check(backups.begin(() -> new BackupSession(staging, File::getUsableSpace)) == null, "begin");
    check(backups.call(session -> {
      session.append("{\"type\":\"header\",\"format\":\"snarchive-backup\",\"version\":1}\n");
      session.append("{\"type\":\"end\",\"records\":1,\"objects\":1,\"originalBytes\":" + receipt.bytes + "}\n");
      session.object(receipt.sha256, receipt.bytes); session.seal();
    }) == null, "staging");
    check(backups.destination(doc) == null, "destination");
  }
  static String[] staged() { String[] names = staging.list(); java.util.Arrays.sort(names); return names; }

  public static void main(String[] args) throws Exception {
    File root = Files.createTempDirectory(Paths.get(args[0]), "coordinator-test-").toFile();
    staging = new File(root, "staging"); store = new OriginalStore(new File(root, "originals"));
    byte[] original = "synthetic preserved media".getBytes("UTF-8");
    receipt = store.put(new ByteArrayInputStream(original), original.length, -1, new OriginalStore.Budget(original.length), () -> false);
    Executor inline = Runnable::run;

    test("verified save is kept and the session released", () -> {
      BackupCoordinator backups = coordinator(inline); Doc doc = new Doc(); prepare(backups, doc);
      check(backups.save(store) == null, "save"); check(backups.finish() == null, "finish");
      check(doc.deletes.get() == 0 && released.get() == 1 && !backups.active(), "kept");
    });
    test("cancel during a failing provider read reports cancelled and deletes the output", () -> {
      BackupCoordinator backups = coordinator(inline); Doc doc = new Doc(); prepare(backups, doc);
      // The read blocks until the user cancels, then the provider throws.
      doc.reader = written -> new InputStream() { public int read() throws IOException { return read(new byte[1], 0, 1); }
        public int read(byte[] b, int off, int len) throws IOException { stop.set(true); throw new IOException("provider"); } };
      check("cancelled".equals(backups.save(store)), "reported cancelled");
      check(backups.finish() == null && doc.deletes.get() == 1, "cancelled output deleted, not kept");
    });
    test("cancel during a failing provider open reports cancelled and deletes the output", () -> {
      BackupCoordinator backups = coordinator(inline); Doc doc = new Doc(); prepare(backups, doc);
      doc.reader = written -> { stop.set(true); throw new IOException("provider"); };
      check("cancelled".equals(backups.save(store)), "reported cancelled");
      check(backups.finish() == null && doc.deletes.get() == 1, "deleted");
    });
    test("cancelled output that cannot be deleted is reported, never silently kept", () -> {
      BackupCoordinator backups = coordinator(inline); Doc doc = new Doc(); prepare(backups, doc); doc.deleteResult = false;
      doc.reader = written -> { stop.set(true); throw new IOException("provider"); };
      check("cancelled".equals(backups.save(store)), "cancelled");
      check("backup-partial-remains".equals(backups.finish()), "partial reported");
    });
    test("failing read without cancel keeps an unchecked backup and says so", () -> {
      BackupCoordinator backups = coordinator(inline); Doc doc = new Doc(); prepare(backups, doc);
      doc.reader = written -> new ByteArrayInputStream(new byte[0]); // A cloud provider still uploading.
      check("backup-unverified".equals(backups.save(store)), "unverified");
      check(backups.finish() == null && doc.deletes.get() == 0, "kept");
    });
    test("wrong read-back bytes delete the output", () -> {
      BackupCoordinator backups = coordinator(inline); Doc doc = new Doc(); prepare(backups, doc);
      doc.reader = written -> { byte[] copy = written.clone(); copy[10] ^= 1; return new ByteArrayInputStream(copy); };
      check("backup-save-failed".equals(backups.save(store)), "failed");
      check(backups.finish() == null && doc.deletes.get() == 1, "deleted");
    });
    test("teardown never waits on a blocked provider delete and keeps the session reserved", () -> {
      BackupCoordinator backups = coordinator(command -> new Thread(command).start()); Doc doc = new Doc(); prepare(backups, doc);
      doc.deleteGate = new CountDownLatch(1);
      stop.set(true); // OnDestroy sets the shared cancel flag first.
      Thread teardown = new Thread(backups::finishLater); teardown.start(); teardown.join(1000);
      boolean returned = !teardown.isAlive(); if (!returned) doc.deleteGate.countDown(); // Unblock so a failure cannot hang.
      check(returned, "teardown returned while the provider delete was blocked");
      check(doc.deleting.await(5, TimeUnit.SECONDS), "delete started");
      // The state lock is free while the provider blocks, but the session stays reserved.
      check(!backups.active() && "busy".equals(backups.begin(() -> new BackupSession(staging, File::getUsableSpace))), "reserved");
      check("busy".equals(backups.finish()) && released.get() == 0, "not released yet");
      check(java.util.Arrays.asList(staged()).contains("manifest.part"), "staging untouched by competitors");
      doc.deleteGate.countDown();
      for (int i = 0; i < 500 && released.get() == 0; i++) Thread.sleep(10);
      check(released.get() == 1 && doc.deletes.get() == 1, "released after cleanup");
      check(java.util.Arrays.equals(staged(), new String[] {"session.lock"}), "staging removed");
      stop.set(false); check(backups.begin(() -> new BackupSession(staging, File::getUsableSpace)) == null && backups.finish() == null, "next backup can start");
    });
    test("teardown during a blocked save defers cleanup to the saver", () -> {
      BackupCoordinator backups = coordinator(command -> { throw new AssertionError("cleanup must run on the saver thread"); });
      Doc doc = new Doc(); prepare(backups, doc); doc.writeGate = new CountDownLatch(1);
      AtomicReference<String> saved = new AtomicReference<>("pending");
      Thread saver = new Thread(() -> saved.set(backups.save(store))); saver.start();
      check(doc.writing.await(5, TimeUnit.SECONDS), "write started");
      stop.set(true);
      Thread teardown = new Thread(backups::finishLater); teardown.start(); teardown.join(1000);
      boolean returned = !teardown.isAlive(); if (!returned) doc.writeGate.countDown();
      check(returned && released.get() == 0, "teardown returned without cleanup while the save was blocked");
      doc.writeGate.countDown(); saver.join(5000);
      check("cancelled".equals(saved.get()) && doc.deletes.get() == 1 && released.get() == 1 && !backups.active(), "saver cleaned up");
    });
    System.out.println(passed + " backup coordinator host tests passed.");
  }
}
