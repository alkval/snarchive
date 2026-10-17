import com.alkval.snarchive.sources.zip.ZipInventory;
import java.io.*;
import java.nio.file.*;
import java.util.*;

public class ZipInventoryTest {
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
    }
    String[] rejected = {"traversal.zip", "absolute.zip", "symlink.zip", "collision.zip", "parent.zip", "encrypted.zip", "truncated.zip", "corrupt-metadata.zip", "oversized.zip", "ratio.zip", "local-name.zip", "too-many.zip", "split.zip", "invalid-utf8.zip"};
    for (String name : rejected) {
      boolean failed = false;
      try { ZipInventory.scan(root.resolve(name).toFile(), () -> false); } catch (IOException e) { failed = true; }
      if (!failed) throw new AssertionError("Accepted " + name);
      passed++; System.out.println("PASS rejects " + name);
    }
    try { ZipInventory.scan(root.resolve("normal.zip").toFile(), () -> true); throw new AssertionError("cancel ignored"); }
    catch (IOException expected) { passed++; System.out.println("PASS cancellation"); }
    System.out.println(passed + " ZIP-engine host tests passed. Mobile runtime is not verified.");
  }
}
