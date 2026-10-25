package com.alkval.snarchive.sources.storage;

import java.io.File;
import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;

/** Deletes an explicitly owned private subtree. Never follows links, including a link at the root itself. */
public final class PrivateFiles {
  private PrivateFiles() {}
  public static boolean deleteTree(File root) {
    if (Files.notExists(root.toPath(), LinkOption.NOFOLLOW_LINKS)) return true;
    final boolean[] ok = { true };
    try {
      Files.walkFileTree(root.toPath(), new SimpleFileVisitor<Path>() {
        private void remove(Path path) { try { Files.deleteIfExists(path); } catch (IOException | SecurityException failure) { ok[0] = false; } }
        @Override public FileVisitResult visitFile(Path path, BasicFileAttributes attributes) { remove(path); return FileVisitResult.CONTINUE; }
        @Override public FileVisitResult visitFileFailed(Path path, IOException error) { if (!(error instanceof NoSuchFileException)) ok[0] = false; return FileVisitResult.CONTINUE; }
        @Override public FileVisitResult postVisitDirectory(Path path, IOException error) { if (error != null) ok[0] = false; remove(path); return FileVisitResult.CONTINUE; }
      });
    } catch (NoSuchFileException gone) { return true; }
    catch (IOException | SecurityException failure) { return false; }
    return ok[0];
  }
}
