import com.alkval.snarchive.sources.backup.BackupSession;
import com.alkval.snarchive.sources.backup.BackupWriter;
import com.alkval.snarchive.sources.storage.OriginalStore;
import java.io.*;
import java.nio.file.*;
import java.util.*;

public class BackupSessionTest {
  interface Work { void run() throws Exception; }
  static int passed;
  static void check(boolean ok) { if (!ok) throw new AssertionError(); }
  static void test(String name, Work work) throws Exception { work.run(); passed++; System.out.println("PASS " + name); }
  static void fails(String code, Work work) throws Exception { try { work.run(); throw new AssertionError("expected " + code); } catch (IOException e) { check(code.equals(e.getMessage())); } }
  public static void main(String[] args) throws Exception {
    if (args.length == 2 && args[0].equals("abandon")) {
      BackupSession session = new BackupSession(new File(args[1]), File::getUsableSpace); session.append("interrupted"); Runtime.getRuntime().halt(0);
    }
    File root = Files.createTempDirectory(Paths.get(args[0]), "session-test-").toFile();
    File staging = new File(root, "staging"); staging.mkdir();
    OriginalStore store = new OriginalStore(new File(root, "originals"));
    byte[] original = "synthetic preserved media".getBytes("UTF-8");
    OriginalStore.Stored receipt = store.put(new ByteArrayInputStream(original), original.length, -1, new OriginalStore.Budget(original.length), () -> false);
    test("ZIP streams into the destination without a private copy and read-back is classified", () -> {
      try (BackupSession session = new BackupSession(staging, File::getUsableSpace)) {
        session.append("{\"type\":\"header\",\"format\":\"snarchive-backup\",\"version\":1}\n");
        session.append("{\"type\":\"object\",\"sha256\":\"" + receipt.sha256 + "\",\"relativePath\":\"" + receipt.relativePath + "\",\"bytes\":" + receipt.bytes + "}\n");
        session.append("{\"type\":\"end\",\"records\":2,\"objects\":1,\"originalBytes\":" + receipt.bytes + "}\n");
        session.object(receipt.sha256, receipt.bytes); session.seal();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        BackupWriter.Written written = session.write(output, store, () -> false);
        byte[] saved = output.toByteArray(); check(written.bytes == saved.length);
        // Staging holds only the manifest and catalog: no ZIP-sized private copy.
        String[] names = staging.list(); Arrays.sort(names); check(Arrays.equals(names, new String[] {"catalog.part", "manifest.part", "session.lock"}));
        BackupSession.verify(new ByteArrayInputStream(saved), written.sha256, written.bytes, () -> false);
        byte[] damaged = saved.clone(); damaged[10] ^= 1;
        fails("backup-save-failed", () -> BackupSession.verify(new ByteArrayInputStream(damaged), written.sha256, written.bytes, () -> false));
        fails("backup-save-failed", () -> BackupSession.verify(new ByteArrayInputStream(Arrays.copyOf(saved, saved.length + 1)), written.sha256, written.bytes, () -> false));
        // A provider still uploading hands back less, or fails to read: kept as unchecked, never deleted as corrupt.
        fails("backup-unverified", () -> BackupSession.verify(new ByteArrayInputStream(Arrays.copyOf(saved, saved.length / 2)), written.sha256, written.bytes, () -> false));
        fails("backup-unverified", () -> BackupSession.verify(new ByteArrayInputStream(new byte[0]), written.sha256, written.bytes, () -> false));
        fails("backup-unverified", () -> BackupSession.verify(new InputStream() { public int read() throws IOException { throw new IOException("provider"); } }, written.sha256, written.bytes, () -> false));
        fails("cancelled", () -> session.write(new ByteArrayOutputStream(), store, () -> true));
        fails("backup-state", () -> session.append("more"));
      }
      check(Arrays.equals(staging.list(), new String[] {"session.lock"}));
    });
    test("write before seal is refused", () -> {
      try (BackupSession session = new BackupSession(staging, File::getUsableSpace)) {
        session.append("x"); fails("backup-state", () -> session.write(new ByteArrayOutputStream(), store, () -> false));
      }
    });
    test("startup recovery deletes only owned abandoned files", () -> {
      for (String name : new String[] {"manifest.part", "catalog.part", "backup-123.part", "notes.part"}) Files.write(new File(staging, name).toPath(), new byte[1]);
      try (BackupSession session = new BackupSession(staging, File::getUsableSpace)) { check(!new File(staging, "backup-123.part").exists()); check(new File(staging, "notes.part").exists()); }
      check(new File(staging, "notes.part").delete());
    });
    test("live session lock prevents another opener from deleting staging", () -> {
      try (BackupSession session = new BackupSession(staging, File::getUsableSpace)) {
        session.append("owned"); fails("busy", () -> new BackupSession(staging, File::getUsableSpace));
        check(new File(staging, "manifest.part").length() == 5);
      }
    });
    test("process death releases lock and abandoned staging is recoverable", () -> {
      Process child = new ProcessBuilder(new File(System.getProperty("java.home"), "bin/java").getPath(), "-cp", System.getProperty("java.class.path"), "BackupSessionTest", "abandon", staging.getPath()).inheritIO().start();
      check(child.waitFor() == 0); check(new File(staging, "manifest.part").length() > 0);
      try (BackupSession session = new BackupSession(staging, File::getUsableSpace)) { check(new File(staging, "manifest.part").length() == 0); }
    });
    test("low staging space and oversized bridge chunks fail safely", () -> {
      try (BackupSession session = new BackupSession(staging, dir -> 0)) { fails("insufficient-storage", () -> session.append("data")); }
      try (BackupSession session = new BackupSession(staging, File::getUsableSpace)) { fails("backup-limit", () -> session.append(String.join("", Collections.nCopies(65537, "a")))); }
    });
    System.out.println(passed + " backup session host tests passed.");
  }
}
