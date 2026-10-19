import com.alkval.snarchive.sources.zip.ArchiveSource;
import com.alkval.snarchive.sources.zip.ZipInventory;
import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

public class ZipInventoryTest {
  /** Like an Android document descriptor: an open channel whose path no longer exists, so nothing can reopen it. */
  static ArchiveSource unlinked(Path fixture) throws IOException {
    Path copy = Files.createTempFile(fixture.getParent(), "unlinked-", ".zip");
    Files.copy(fixture, copy, StandardCopyOption.REPLACE_EXISTING);
    FileChannel channel = FileChannel.open(copy, StandardOpenOption.READ);
    Files.delete(copy);
    return new ArchiveSource(channel, channel, () -> String.valueOf(channel.size()), new File("/dev/null"));
  }
  static String hex(byte[] bytes) { StringBuilder out = new StringBuilder(); for (byte b : bytes) out.append(String.format("%02x", b & 255)); return out.toString(); }
  public static void main(String[] args) throws Exception {
    Path root = Paths.get(args[0]);
    int passed = 0;
    String[] valid = {"normal.zip", "descriptor.zip", "zip64-count.zip"};
    for (String name : valid) {
      Map<String,Object> result = ZipInventory.scan(root.resolve(name).toFile(), () -> false);
      if (!Boolean.TRUE.equals(result.get("ok"))) throw new AssertionError(name);
      if (name.equals("normal.zip")) {
        List<?> entries = (List<?>)result.get("entries");
        if (entries.size() != 3 || ((Number)result.get("metadataBytes")).intValue() == 0) throw new AssertionError(name);
      }
      passed++; System.out.println("PASS " + name);
      try (ArchiveSource source = unlinked(root.resolve(name))) {
        String sha = source.sha256(() -> false);
        if (!sha.equals(hex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(root.resolve(name)))))) throw new AssertionError("hash " + name);
        if (!ZipInventory.scan(source, () -> false).equals(result)) throw new AssertionError("in-place " + name);
        source.checkUnchanged();
      }
      passed++; System.out.println("PASS in-place " + name);
    }
    String[] rejected = {"traversal.zip", "absolute.zip", "symlink.zip", "collision.zip", "parent.zip", "encrypted.zip", "truncated.zip", "corrupt-metadata.zip", "oversized.zip", "ratio.zip", "local-name.zip", "too-many.zip", "split.zip", "invalid-utf8.zip"};
    for (String name : rejected) {
      boolean failed = false;
      try { ZipInventory.scan(root.resolve(name).toFile(), () -> false); } catch (IOException e) { failed = true; }
      if (!failed) throw new AssertionError("Accepted " + name);
      passed++; System.out.println("PASS rejects " + name);
      failed = false;
      try (ArchiveSource source = unlinked(root.resolve(name))) { ZipInventory.scan(source, () -> false); } catch (IOException e) { failed = true; }
      if (!failed) throw new AssertionError("Accepted in place " + name);
      passed++; System.out.println("PASS rejects in place " + name);
    }
    try { ZipInventory.scan(root.resolve("normal.zip").toFile(), () -> true); throw new AssertionError("cancel ignored"); }
    catch (IOException expected) { passed++; System.out.println("PASS cancellation"); }
    try (ArchiveSource source = unlinked(root.resolve("normal.zip"))) {
      try { source.sha256(() -> true); throw new AssertionError("hash cancel ignored"); }
      catch (IOException e) { if (!"cancelled".equals(e.getMessage())) throw e; }
      try { source.checkUnchanged(); throw new AssertionError("unpinned source accepted"); }
      catch (IOException e) { if (!"source-changed".equals(e.getMessage())) throw e; }
      passed++; System.out.println("PASS in-place hash cancellation leaves source unpinned");
    }
    System.out.println(passed + " ZIP-engine host tests passed. Mobile runtime is not verified.");
  }
}
