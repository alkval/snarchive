package snarchive.prototype;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.function.BooleanSupplier;

/** Android-compatible stream primitive. Not a ZIP parser or a complete extractor.
 * Caller owns streams, a fresh private staging file, integrity checks, and cleanup.
 * Quotas are shared by sequential entries, never concurrent workers.
 */
public final class BoundedCopy {
  public static final int BUFFER_BYTES = 64 * 1024;
  private BoundedCopy() {}

  public static final class Quota {
    private long remaining;
    public Quota(long bytes) {
      if (bytes < 0) throw new IllegalArgumentException("invalid-quota");
      remaining = bytes;
    }
    public long remaining() { return remaining; }
  }

  public static long copy(InputStream input, OutputStream output, long declaredBytes,
                          long entryLimit, Quota quota, BooleanSupplier cancelled) throws IOException {
    if (declaredBytes < 0 || entryLimit < 0) throw new IOException("invalid-size");
    if (declaredBytes > entryLimit || declaredBytes > quota.remaining) throw new IOException("byte-limit");
    byte[] buffer = new byte[BUFFER_BYTES];
    long written = 0;
    while (true) {
      if (cancelled.getAsBoolean()) throw new IOException("cancelled");
      int count = input.read(buffer);
      if (cancelled.getAsBoolean()) throw new IOException("cancelled");
      if (count == -1) break;
      if (count <= 0) throw new IOException("invalid-stream");
      // Subtraction avoids overflow. Reject BEFORE writing the offending chunk.
      if (count > entryLimit - written || count > quota.remaining) throw new IOException("byte-limit");
      if (count > declaredBytes - written) throw new IOException("size-mismatch");
      quota.remaining -= count; // Conservative reservation even if a write partially fails.
      output.write(buffer, 0, count);
      written += count;
    }
    if (written != declaredBytes) throw new IOException("size-mismatch");
    return written;
  }
}
