import com.alkval.snarchive.sources.backup.BackupWriter;
import com.alkval.snarchive.sources.backup.BackupWriter.ObjectSpec;
import com.alkval.snarchive.sources.storage.OriginalStore;
import com.alkval.snarchive.sources.zip.ArchiveSource;
import com.alkval.snarchive.sources.zip.ZipGuard;
import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.function.BooleanSupplier;
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
  static String sha(byte[] input) throws Exception {
    StringBuilder hex = new StringBuilder(); for (byte b : MessageDigest.getInstance("SHA-256").digest(input)) hex.append(String.format("%02x", b & 255)); return hex.toString();
  }
  /** What the Android caller does with the chosen document: stream, then delete it on failure. A failed stream
   * must never leave something that opens as a complete ZIP, in case that deletion fails. */
  static File write(OriginalStore store, File manifest, Iterable<ObjectSpec> objects, File dir, OriginalStore.Space space, BooleanSupplier stop) throws Exception {
    File file = File.createTempFile("destination-", ".zip", dir);
    try (OutputStream out = new FileOutputStream(file)) {
      BackupWriter.Written written = BackupWriter.write(store, manifest, objects, out, dir, space, stop);
      out.flush(); check(written.bytes == file.length() && written.sha256.equals(sha(Files.readAllBytes(file.toPath()))));
      return file;
    } catch (IOException e) {
      boolean opens; try (ZipFile zip = new ZipFile(file)) { opens = true; } catch (IOException notZip) { opens = false; }
      check(!opens); check(file.delete()); throw e;
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
      File backup = write(store, manifest, catalog, output, File::getUsableSpace, () -> false);
      try (ZipFile zip = new ZipFile(backup)) {
        check(zip.size() == 2); check(Arrays.equals(metadata, read(zip.getInputStream(zip.getEntry("manifest.jsonl")))));
        check(Arrays.equals(bytes, read(zip.getInputStream(zip.getEntry(stored.relativePath)))));
      }
      check(Arrays.equals(bytes, Files.readAllBytes(new File(originals, stored.relativePath).toPath()))); check(backup.delete());
    });
    test("same-length corruption fails and the partial output never opens as a ZIP", () -> {
      File file = new File(originals, stored.relativePath); byte[] damaged = bytes.clone(); damaged[10] ^= 1; Files.write(file.toPath(), damaged);
      fails("stored-object-corrupt", () -> write(store, manifest, catalog, output, File::getUsableSpace, () -> false));
      check(output.list().length == 0); Files.write(file.toPath(), bytes);
    });
    test("missing originals fail without modifying library", () -> {
      fails("stored-object-corrupt", () -> write(store, manifest, Collections.singletonList(new ObjectSpec(String.join("", Collections.nCopies(64, "a")), 1)), output, File::getUsableSpace, () -> false));
      check(output.list().length == 0);
    });
    test("cancellation during streaming leaves no openable ZIP", () -> {
      int[] calls = {0}; fails("cancelled", () -> write(store, manifest, catalog, output, File::getUsableSpace, () -> ++calls[0] > 20)); check(output.list().length == 0);
    });
    test("storage exhaustion during streaming leaves no openable ZIP", () -> {
      int[] calls = {0}; fails("insufficient-storage", () -> write(store, manifest, catalog, output, dir -> ++calls[0] < 12 ? Long.MAX_VALUE : 0, () -> false)); check(output.list().length == 0);
    });
    test("duplicate catalog entries cannot create an ambiguous archive", () -> {
      fails("backup-limit", () -> write(store, manifest, Arrays.asList(catalog.get(0), catalog.get(0)), output, File::getUsableSpace, () -> false)); check(output.list().length == 0);
    });
    test("invalid object identifiers cannot become ZIP paths", () -> {
      fails("invalid-backup-object", () -> write(store, manifest, Collections.singletonList(new ObjectSpec("../outside", 1)), output, File::getUsableSpace, () -> false)); check(output.list().length == 0);
    });
    test("empty catalog supports metadata-only backups", () -> {
      File empty = new File(root, "empty.jsonl");
      Files.write(empty.toPath(), ("{\"type\":\"header\",\"format\":\"snarchive-backup\",\"version\":1}\n{\"type\":\"end\",\"records\":1,\"objects\":0,\"originalBytes\":0}\n").getBytes("UTF-8"));
      File backup = write(store, empty, Collections.emptyList(), output, File::getUsableSpace, () -> false);
      try (ZipFile zip = new ZipFile(backup)) { check(zip.size() == 1); } check(backup.delete());
    });
    test("oversized manifest fails before creating output", () -> {
      File oversized = new File(root, "oversized"); try (RandomAccessFile file = new RandomAccessFile(oversized, "rw")) { file.setLength(BackupWriter.MAX_MANIFEST + 1); }
      fails("invalid-backup-manifest", () -> write(store, oversized, catalog, output, File::getUsableSpace, () -> false)); check(output.list().length == 0); check(oversized.delete());
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
      File backup = write(store, largeManifest, Collections.singletonList(new ObjectSpec(large.sha256, size)), output, File::getUsableSpace, () -> false);
      try (ZipFile zip = new ZipFile(backup); InputStream input = zip.getInputStream(zip.getEntry(large.relativePath))) {
        byte[] buffer = new byte[65536]; long total = 0; int n; MessageDigest digest = MessageDigest.getInstance("SHA-256");
        while ((n = input.read(buffer)) != -1) { total += n; digest.update(buffer, 0, n); }
        check(total == size); StringBuilder hex = new StringBuilder(); for (byte b : digest.digest()) hex.append(String.format("%02x", b & 255)); check(hex.toString().equals(large.sha256));
      }
      check(backup.delete());
    });
    test("over 65,535 entries uses ZIP64 records our own ZIP reader accepts", () -> {
      // System temp, not the synced workspace: this creates 65,600 small files.
      File big = Files.createTempDirectory("snarchive-zip64-").toFile();
      try {
        OriginalStore many = new OriginalStore(new File(big, "originals")); List<ObjectSpec> specs = new ArrayList<>();
        for (int i = 0; i < 65_600; i++) {
          byte[] value = ("synthetic-" + i).getBytes("UTF-8"); String hash = sha(value);
          File object = new File(big, "originals/objects/" + hash.substring(0, 2) + "/" + hash); object.getParentFile().mkdirs();
          Files.write(object.toPath(), value); specs.add(new ObjectSpec(hash, value.length));
        }
        File backup = write(many, manifest, specs, big, File::getUsableSpace, () -> false);
        try (ZipFile zip = new ZipFile(backup)) { check(zip.size() == 65_601); }
        try (ArchiveSource source = ArchiveSource.open(backup)) { check(ZipGuard.inspect(source).count == 65_601); }
      } finally {
        try (java.util.stream.Stream<Path> paths = Files.walk(big.toPath())) { paths.sorted(Comparator.reverseOrder()).forEach(path -> path.toFile().delete()); }
      }
    });
    System.out.println(passed + " backup writer host tests passed. No device or restore claim.");
  }
}
