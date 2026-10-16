import Foundation

let root = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent(UUID().uuidString)
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: root) }
let metadata = root.appendingPathComponent("memories_history.json")
try Data("{\"Saved Media\":[]}".utf8).write(to: metadata)
let nested = root.appendingPathComponent("memories")
try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
try Data().write(to: nested.appendingPathComponent("2026-02-05_a-main.jpg"))
func expectFailure(_ work: () throws -> Void) throws {
  var failed = false
  do { try work() } catch { failed = true }
  precondition(failed)
}
let result = try DirectoryInventory.scan(root.absoluteString, isCancelled: { false })
precondition((result["entries"] as! [[String: Any]]).count == 2)
precondition(result["visitedEntries"] as! Int == 3)
print("PASS nested directory and bounded metadata reading")
try expectFailure { _ = try DirectoryInventory.scan(root.absoluteString, isCancelled: { true }) }
print("PASS cancellation rejects snapshot")
let link = root.appendingPathComponent("linked")
try FileManager.default.createSymbolicLink(at: link, withDestinationURL: nested)
try expectFailure { _ = try DirectoryInventory.scan(root.absoluteString, isCancelled: { false }) }
try FileManager.default.removeItem(at: link)
print("PASS symlink rejected")
try Data(repeating: 65, count: 8 * 1024 * 1024 + 1).write(to: metadata)
try expectFailure { _ = try DirectoryInventory.scan(root.absoluteString, isCancelled: { false }) }
print("PASS oversized metadata rejected")
try Data([0xff, 0xfe, 0xff]).write(to: metadata)
try expectFailure { _ = try DirectoryInventory.scan(root.absoluteString, isCancelled: { false }) }
print("PASS invalid UTF-8 rejected")
print("5 host Swift tests passed. iOS runtime and permissions are NOT verified.")
