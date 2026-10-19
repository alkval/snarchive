import com.alkval.snarchive.sources.backup.BackupWriter;
import com.alkval.snarchive.sources.backup.BackupWriter.ObjectSpec;
import com.alkval.snarchive.sources.storage.OriginalStore;
import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;

public class BackupWriterTest {
  interface Work { void run() throws Exception; }
  static int passed;
  static void check(boolean ok) { if (!ok) throw new AssertionError(); }
  static void test(String label, Work work) throws Exception { work.run(); passed++; System.out.println("PASS " + label); }
  static void fails(String code, Work work) throws Exception {
    try { work.run(); throw new AssertionError("expected " + code); } catch (IOException e) { check(code.equals(e.getMessage())); }
  }
  static byte[] read(InputStream input) throws IOException {
    try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[65536]; int n; while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n); return out.toByteArray();
    }
  }
  public static void main(String[] args) throws Exception {
    File root = Files.createTempDirectory(Paths.get(args[0]), "backup-test-").toFile();
    File originals = new File(root, "originals"), output = new File(root, "output"); output.mkdir();
    OriginalStore store = new OriginalStore(originals);
    byte[] bytes = new byte[2 * 1024 * 1024]; new Random(42).nextBytes(bytes);
    OriginalStore.Stored stored = store.put(new ByteArrayInputStream(bytes), bytes.length, -1, new OriginalStore.Budget(bytes.length), () -> false);
    List<ObjectSpec> catalog = Collections.singletonList(new ObjectSpec(stored.sha256, stored.bytes));
    File manifest = new File(root, "manifest.jsonl");
    byte[] metadata = ("{\"type\":\"header\",\"format\":\"snarchive-backup\",\"version\":1}\n" +
      "{\"type\":\"object\",\"sha256\":\"" + stored.sha256 + "\",\"relativePath\":\"" + stored.relativePath + "\",\"bytes\":" + stored.bytes + "}\n" +
      "{\"type\":\"end\",\"records\":2,\"objects\":1,\"originalBytes\":" + stored.bytes + "}\n").getBytes("UTF-8");
    Files.write(manifest.toPath(), metadata);
    test("portable ZIP contains exact manifest and verified original bytes", () -> {
      File backup = BackupWriter.write(store, manifest, catalog, output, File::getUsableSpace, () -> false);
      try (ZipFile zip = new ZipFile(backup)) {
        check(zip.size() == 2); check(Arrays.equals(metadata, read(zip.getInputStream(zip.getEntry("manifest.jsonl")))));
        check(Arrays.equals(bytes, read(zip.getInputStream(zip.getEntry(stored.relativePath)))));
      }
      check(Arrays.equals(bytes, Files.readAllBytes(new File(originals, stored.relativePath).toPath()))); check(backup.delete());
    });
    test("same-length corruption prevents a completed backup and removes partial ZIP", () -> {
      File file = new File(originals, stored.relativePath); byte[] damaged = bytes.clone(); damaged[10] ^= 1; Files.write(file.toPath(), damaged);
      fails("stored-object-corrupt", () -> BackupWriter.write(store, manifest, catalog, output, File::getUsableSpace, () -> false));
      check(output.list().length == 0); Files.write(file.toPath(), bytes);
    });
    test("missing originals fail without modifying library", () -> {
      fails("stored-object-corrupt", () -> BackupWriter.write(store, manifest, Collections.singletonList(new ObjectSpec(String.join("", Collections.nCopies(64, "a")), 1)), output, File::getUsableSpace, () -> false));
      check(output.list().length == 0);
    });
    test("cancellation during streaming cleans partial output", () -> {
      int[] calls = {0}; fails("cancelled", () -> BackupWriter.write(store, manifest, catalog, output, File::getUsableSpace, () -> ++calls[0] > 20)); check(output.list().length == 0);
    });
    test("storage exhaustion during streaming cleans partial output", () -> {
      int[] calls = {0}; fails("insufficient-storage", () -> BackupWriter.write(store, manifest, catalog, output, dir -> ++calls[0] < 12 ? Long.MAX_VALUE : 0, () -> false)); check(output.list().length == 0);
    });
    test("duplicate catalog entries cannot create an ambiguous archive", () -> {
      fails("backup-limit", () -> BackupWriter.write(store, manifest, Arrays.asList(catalog.get(0), catalog.get(0)), output, File::getUsableSpace, () -> false)); check(output.list().length == 0);
    });
    test("invalid object identifiers cannot become ZIP paths", () -> {
      fails("invalid-backup-object", () -> BackupWriter.write(store, manifest, Collections.singletonList(new ObjectSpec("../outside", 1)), output, File::getUsableSpace, () -> false)); check(output.list().length == 0);
    });
    test("empty catalog supports metadata-only backups", () -> {
      File empty = new File(root, "empty.jsonl");
      Files.write(empty.toPath(), ("{\"type\":\"header\",\"format\":\"snarchive-backup\",\"version\":1}\n{\"type\":\"end\",\"records\":1,\"objects\":0,\"originalBytes\":0}\n").getBytes("UTF-8"));
      File backup = BackupWriter.write(store, empty, Collections.emptyList(), output, File::getUsableSpace, () -> false);
      try (ZipFile zip = new ZipFile(backup)) { check(zip.size() == 1); } check(backup.delete());
    });
    test("oversized manifest fails before creating output", () -> {
      File oversized = new File(root, "oversized"); try (RandomAccessFile file = new RandomAccessFile(oversized, "rw")) { file.setLength(BackupWriter.MAX_MANIFEST + 1); }
      fails("invalid-backup-manifest", () -> BackupWriter.write(store, oversized, catalog, output, File::getUsableSpace, () -> false)); check(output.list().length == 0); check(oversized.delete());
    });
    test("32 MiB original streams within a 64 MiB test heap", () -> {
      final long size = 32L * 1024 * 1024;
      InputStream generated = new InputStream() {
        long remaining = size;
        @Override public int read() { if (remaining == 0) return -1; remaining--; return 0; }
        @Override public int read(byte[] b, int off, int len) {
          if (remaining == 0) return -1; int n = (int)Math.min(len, remaining); Arrays.fill(b, off, off + n, (byte)0); remaining -= n; return n;
        }
      };
      OriginalStore.Stored large = store.put(generated, size, -1, new OriginalStore.Budget(size), () -> false);
      File largeManifest = new File(root, "large.jsonl");
      String json = new String(metadata, "UTF-8").replace(stored.relativePath, large.relativePath).replace(stored.sha256, large.sha256).replace(Long.toString(stored.bytes), Long.toString(size));
      Files.write(largeManifest.toPath(), json.getBytes("UTF-8"));
      File backup = BackupWriter.write(store, largeManifest, Collections.singletonList(new ObjectSpec(large.sha256, size)), output, File::getUsableSpace, () -> false);
      try (ZipFile zip = new ZipFile(backup); InputStream input = zip.getInputStream(zip.getEntry(large.relativePath))) {
        byte[] buffer = new byte[65536]; long total = 0; int n; MessageDigest digest = MessageDigest.getInstance("SHA-256");
        while ((n = input.read(buffer)) != -1) { total += n; digest.update(buffer, 0, n); }
        check(total == size); StringBuilder hex = new StringBuilder(); for (byte b : digest.digest()) hex.append(String.format("%02x", b & 255)); check(hex.toString().equals(large.sha256));
      }
      check(backup.delete());
    });
    System.out.println(passed + " backup writer host tests passed. No device or restore claim.");
  }
}
