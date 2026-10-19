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
    {
      Path copies = Files.createTempDirectory(root, "copies-");
      Path abandoned = Files.createTempFile(copies, "preview-", ".part"); // Same naming as the module's copy fallback.
      Path unrelated = Files.write(copies.resolve("notes.part"), new byte[1]);
      Path other = Files.write(copies.resolve("preview-keep.txt"), new byte[1]);
      boolean[] copied = { false };
      try (ArchiveSource source = ArchiveSource.openSelected(copies.toFile(), () -> unlinked(root.resolve("normal.zip")), () -> { copied[0] = true; return null; })) {
        if (source == null || copied[0]) throw new AssertionError("in-place source not chosen");
      }
      if (Files.exists(abandoned) || !Files.exists(unrelated) || !Files.exists(other)) throw new AssertionError("abandoned copy cleanup");
      passed++; System.out.println("PASS abandoned copy removed when next archive is read in place");
    }
    System.out.println(passed + " ZIP-engine host tests passed. Mobile runtime is not verified.");
  }
}
