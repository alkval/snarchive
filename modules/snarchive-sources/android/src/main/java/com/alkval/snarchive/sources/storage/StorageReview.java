package com.alkval.snarchive.sources.storage;

import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.*;
import java.util.function.BooleanSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Section 24: lists files in the originals store that may be removable, and removes exactly the ones a user selected.
 * It never decides that an object is unreferenced: the library database is the only evidence, and JS checks it inside
 * an exclusive transaction around each removal. This class only proves that the selected file is still the very file
 * that was listed, at its expected private path.
 *
 * Two modes. A scan session takes no store lock and changes nothing. A cleanup session holds the store's cross-process
 * writer lock for its whole life, so no put, repair or staging recovery (in this or another process) can create or
 * replace an object while it runs; it therefore never calls those itself. Staging parts are never listed or removed.
 *
 * Listed kinds: "object" (objects/xx/hash, a regular file whose name is a SHA-256 under its own prefix directory) and
 * "quarantine" (quarantine/hash-millis-random.damaged, a damaged copy kept by repair). Anything else in those
 * directories (other names, links, directories) is counted as unrecognized and can never be selected. */
public final class StorageReview implements Closeable {
  public static final String OBJECT = "object", QUARANTINE = "quarantine";
  private static final Pattern HASH = Pattern.compile("[a-f0-9]{64}");
  private static final Pattern PREFIX = Pattern.compile("[a-f0-9]{2}");
  private static final Pattern QUARANTINED = Pattern.compile("([a-f0-9]{64})-([0-9]{1,19})-([a-f0-9]{8})\\.damaged");
  private static final Pattern OBJECT_PATH = Pattern.compile("objects/([a-f0-9]{2})/([a-f0-9]{64})");
  private static final Pattern QUARANTINE_PATH = Pattern.compile("quarantine/(" + QUARANTINED.pattern() + ")");

  /** One listed file. identity pins the exact file: its file key (device and inode where available), length and
   * modification time, read without following links. */
  public static final class Entry {
    public final String kind, path, hash, identity; public final long bytes, modified;
    Entry(String kind, String path, String hash, long bytes, long modified, String identity) {
      this.kind = kind; this.path = path; this.hash = hash; this.bytes = bytes; this.modified = modified; this.identity = identity;
    }
  }
  /** A page of one kind, in path order; unrecognized counts the entries skipped on this page's directories. */
  public static final class Page {
    public final List<Entry> entries; public final String next; public final int unrecognized;
    Page(List<Entry> entries, String next, int unrecognized) { this.entries = entries; this.next = next; this.unrecognized = unrecognized; }
  }
  /** removed (warning "sync-failed" if the directory could not be synced afterwards: the file is gone either way);
   * skipped (reason "missing" or "changed": the listed file is not there as listed, so nothing was removed). */
  public static final class Removal {
    public final String outcome, reason, warning;
    Removal(String outcome, String reason, String warning) { this.outcome = outcome; this.reason = reason; this.warning = warning; }
  }

  private final OriginalStore store;
  private final Closeable writerLock;
  private boolean closed;

  private StorageReview(OriginalStore store, Closeable writerLock) { this.store = store; this.writerLock = writerLock; }
  /** Read-only listing. */
  public static StorageReview scan(OriginalStore store) { return new StorageReview(store, null); }
  /** Removal session: takes the writer lock now ("storage-busy" if any writer holds it) and keeps it until close. */
  public static StorageReview cleanup(OriginalStore store) throws IOException { return new StorageReview(store, store.lockWriter()); }

  private static IOException fail(String code) { return new IOException(code); }

  public Page page(String kind, String after, int limit, BooleanSupplier stop) throws IOException {
    if (closed || limit < 1 || limit > 1000 || after == null) throw fail("invalid-entry");
    if (stop.getAsBoolean()) throw fail("cancelled");
    if (OBJECT.equals(kind)) return objects(after, limit, stop);
    if (QUARANTINE.equals(kind)) return quarantine(after, limit, stop);
    throw fail("invalid-entry");
  }

  private static String identity(BasicFileAttributes attributes) {
    Object key = attributes.fileKey();
    return (key == null ? "nokey" : key.toString()) + "|" + attributes.size() + "|" + attributes.lastModifiedTime().toMillis();
  }

  private static String[] sortedNames(File directory) throws IOException {
    String[] names = directory.list();
    if (names == null) {
      if (!directory.exists()) return new String[0];
      throw fail("storage-unreadable");
    }
    Arrays.sort(names);
    return names;
  }

  private Page objects(String after, int limit, BooleanSupplier stop) throws IOException {
    File objects = store.checkedPath("objects");
    List<Entry> out = new ArrayList<>(); int unrecognized = 0;
    String afterPrefix = after.isEmpty() ? "" : after.substring(0, Math.min(2, after.length()));
    for (String prefix : sortedNames(objects)) {
      if (prefix.compareTo(afterPrefix) < 0) continue;
      if (stop.getAsBoolean()) throw fail("cancelled");
      Path prefixPath = new File(objects, prefix).toPath();
      BasicFileAttributes prefixAttributes = attributes(prefixPath);
      if (prefixAttributes == null) continue;
      if (!PREFIX.matcher(prefix).matches() || !prefixAttributes.isDirectory()) {
        if (after.isEmpty() || prefix.compareTo(afterPrefix) > 0) unrecognized++; // Counted once, on the page that reaches it.
        continue;
      }
      for (String name : sortedNames(prefixPath.toFile())) {
        String path = "objects/" + prefix + "/" + name;
        if (path.compareTo("objects/" + after) <= 0 && !after.isEmpty()) continue;
        BasicFileAttributes attributes = attributes(prefixPath.resolve(name));
        if (attributes == null) continue;
        if (!HASH.matcher(name).matches() || !name.startsWith(prefix) || !attributes.isRegularFile()) { unrecognized++; continue; }
        out.add(new Entry(OBJECT, path, name, attributes.size(), attributes.lastModifiedTime().toMillis(), identity(attributes)));
        if (out.size() == limit) return new Page(out, prefix + "/" + name, unrecognized);
      }
    }
    return new Page(out, null, unrecognized);
  }

  private Page quarantine(String after, int limit, BooleanSupplier stop) throws IOException {
    File directory = store.checkedPath("quarantine");
    List<Entry> out = new ArrayList<>(); int unrecognized = 0;
    for (String name : sortedNames(directory)) {
      if (!after.isEmpty() && name.compareTo(after) <= 0) continue;
      if (stop.getAsBoolean()) throw fail("cancelled");
      BasicFileAttributes attributes = attributes(directory.toPath().resolve(name));
      if (attributes == null) continue;
      Matcher match = QUARANTINED.matcher(name);
      if (!match.matches() || !attributes.isRegularFile()) { unrecognized++; continue; }
      out.add(new Entry(QUARANTINE, "quarantine/" + name, match.group(1), attributes.size(), attributes.lastModifiedTime().toMillis(), identity(attributes)));
      if (out.size() == limit) return new Page(out, name, unrecognized);
    }
    return new Page(out, null, unrecognized);
  }

  /** Attributes without following a link; null when the entry vanished; other failures are "storage-unreadable". */
  private static BasicFileAttributes attributes(Path path) throws IOException {
    try { return Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS); }
    catch (NoSuchFileException gone) { return null; }
    catch (IOException | SecurityException unknown) { throw fail("storage-unreadable"); }
  }

  /** Removes the listed file at path if, and only if, it is still exactly that file. The caller has already proved, in
   * an exclusive database transaction that stays open until this returns, that nothing in the library refers to it.
   * Refuses: an unknown kind or name ("invalid-entry"), a path that resolves outside its expected private location, for
   * example through a linked directory ("unsafe-path"), and one whose presence or attributes cannot be read
   * ("inaccessible"). A file that is gone is skipped as "missing"; a link, directory or any change of file key, length
   * or modification time is skipped as "changed". An unlink that fails is "delete-failed" and leaves the file. */
  public Removal remove(String kind, String path, String identity, BooleanSupplier stop) throws IOException {
    if (closed || writerLock == null) throw fail("invalid-entry"); // Only a cleanup session, holding the writer lock, removes.
    if (identity == null || path == null) throw fail("invalid-entry");
    Pattern shape = OBJECT.equals(kind) ? OBJECT_PATH : QUARANTINE.equals(kind) ? QUARANTINE_PATH : null;
    Matcher match = shape == null ? null : shape.matcher(path);
    if (match == null || !match.matches() || (OBJECT.equals(kind) && !match.group(2).startsWith(match.group(1)))) throw fail("invalid-entry");
    File file;
    try { file = store.checkedPath(path); } catch (IOException unsafe) { throw fail("unsafe-path"); }
    // The parent must be the expected real directory, not a link to somewhere else.
    File parent = store.checkedPath(path.substring(0, path.lastIndexOf('/')));
    if (!file.getParentFile().equals(parent)) throw fail("unsafe-path");
    BasicFileAttributes current;
    try { current = Files.readAttributes(file.toPath(), BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS); }
    catch (NoSuchFileException gone) { return new Removal("skipped", "missing", null); }
    catch (IOException | SecurityException unknown) { throw fail("inaccessible"); }
    if (!current.isRegularFile() || !identity.equals(identity(current))) return new Removal("skipped", "changed", null);
    if (stop.getAsBoolean()) throw fail("cancelled");
    store.fault("before-unlink");
    try { Files.delete(file.toPath()); }
    catch (NoSuchFileException gone) { return new Removal("skipped", "missing", null); }
    catch (IOException | SecurityException failed) { throw fail("delete-failed"); }
    // Removed. A failure from here on is a warning on a completed removal, never an unchanged failure.
    try { store.fault("after-unlink"); store.sync(parent, "sync-cleanup-directory"); }
    catch (IOException | RuntimeException failed) { return new Removal("removed", null, "sync-failed"); }
    return new Removal("removed", null, null);
  }

  /** Releases the writer lock (cleanup sessions) once. */
  @Override public void close() throws IOException {
    if (closed) return; closed = true;
    if (writerLock != null) writerLock.close();
  }
}
