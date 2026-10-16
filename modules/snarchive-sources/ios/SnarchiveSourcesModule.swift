import ExpoModulesCore
import Foundation

public class SnarchiveSourcesModule: Module {
  private let state = NSLock()
  private var busy = false
  private var cancelled = false
  private func isCancelled() -> Bool {
    state.lock(); defer { state.unlock() }; return cancelled
  }
  public func definition() -> ModuleDefinition {
    Name("SnarchiveSources")
    Function("cancel") { () -> Void in
      self.state.lock(); self.cancelled = true; self.state.unlock()
    }
    AsyncFunction("scanDirectory") { (uri: String) -> [String: Any] in
      self.state.lock()
      if self.busy { self.state.unlock(); return ["ok": false, "code": "busy"] }
      self.busy = true; self.cancelled = false; self.state.unlock()
      defer { self.state.lock(); self.busy = false; self.state.unlock() }
      do { return try DirectoryInventory.scan(uri, isCancelled: { self.isCancelled() }) }
      catch { return ["ok": false, "code": self.isCancelled() ? "cancelled" : "unreadable-or-limit"] }
    }
  }
}
