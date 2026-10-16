import Foundation

// Shared with the host test harness; iOS security-scoped behavior still needs device testing.
enum DirectoryInventory {
  static func scan(_ uri: String, isCancelled: () -> Bool) throws -> [String: Any] {
    guard let root = URL(string: uri), root.isFileURL else { throw ScanError.invalid }
    let access = root.startAccessingSecurityScopedResource()
    defer { if access { root.stopAccessingSecurityScopedResource() } }
    let keys: Set<URLResourceKey> = [.isSymbolicLinkKey, .isDirectoryKey, .isRegularFileKey]
    let rootValues = try root.resourceValues(forKeys: keys)
    guard rootValues.isDirectory == true, rootValues.isSymbolicLink != true else { throw ScanError.invalid }
    let rootPath = root.resolvingSymlinksInPath().standardizedFileURL.path
    var enumerationFailed = false
    guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: Array(keys), options: [], errorHandler: { _, _ in enumerationFailed = true; return false }) else { throw ScanError.invalid }
    var entries: [[String: Any]] = []
    var metadataBytes = 0
    var count = 0
    for case let url as URL in enumerator {
      guard !isCancelled() else { throw ScanError.invalid }
      count += 1
      guard count <= 100_000 else { throw ScanError.invalid }
      let values = try url.resourceValues(forKeys: keys)
      guard values.isSymbolicLink != true else { throw ScanError.invalid }
      let resolved = url.resolvingSymlinksInPath().standardizedFileURL.path
      guard resolved.hasPrefix(rootPath + "/") else { throw ScanError.invalid }
      let path = String(resolved.dropFirst(rootPath.count + 1))
      guard path.utf16.count <= 1024, path.split(separator: "/").count <= 32 else { throw ScanError.invalid }
      if values.isDirectory == true { continue }
      guard values.isRegularFile == true else { throw ScanError.invalid }
      var item: [String: Any] = ["path": path]
      if url.lastPathComponent.lowercased() == "memories_history.json" {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var bytes = Data()
        while true {
          guard !isCancelled() else { throw ScanError.invalid }
          let chunk = try handle.read(upToCount: 65536) ?? Data()
          if chunk.isEmpty { break }
          guard chunk.count <= 8 * 1024 * 1024 - bytes.count, chunk.count <= 16 * 1024 * 1024 - metadataBytes else { throw ScanError.invalid }
          metadataBytes += chunk.count; bytes.append(chunk)
        }
        guard let text = String(data: bytes, encoding: .utf8) else { throw ScanError.invalid }
        item["metadataText"] = text
      }
      entries.append(item)
    }
    guard !enumerationFailed, !isCancelled() else { throw ScanError.invalid }
    return ["ok": true, "entries": entries, "metadataBytes": metadataBytes, "visitedEntries": count]
  }
}
private enum ScanError: Error { case invalid }
