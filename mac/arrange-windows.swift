// Arrange Blacklist clients from their separate Wine app bundles side by side.
// Usage: swift arrange-windows.swift <app bundle being launched>
import Cocoa

let target = URL(fileURLWithPath: CommandLine.arguments[1]).standardized.path + "/"
let deadline = Date().addingTimeInterval(60)

while Date() < deadline {
    let windows = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
    ) as? [[String: Any]] ?? []
    let clients = windows.filter { window in
        guard (window[kCGWindowName as String] as? String)?.hasPrefix("Blacklist") == true,
              let pid = window[kCGWindowOwnerPID as String] as? Int,
              let path = NSRunningApplication(processIdentifier: pid_t(pid))?.executableURL?.path
        else { return false }
        return path.contains("/Splinter Cell Blacklist") && path.contains(".app/Contents/")
    }.sorted {
        ($0[kCGWindowNumber as String] as? Int ?? 0) < ($1[kCGWindowNumber as String] as? Int ?? 0)
    }
    let targetReady = clients.contains { window in
        let pid = pid_t(window[kCGWindowOwnerPID as String] as! Int)
        return NSRunningApplication(processIdentifier: pid)?.executableURL?.path.hasPrefix(target) == true
    }
    if targetReady {
        var x: CGFloat = 20
        for client in clients {
            let pid = pid_t(client[kCGWindowOwnerPID as String] as! Int)
            let app = AXUIElementCreateApplication(pid)
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
                  let appWindows = value as? [AXUIElement], !appWindows.isEmpty
            else { continue }
            for window in appWindows {
                var title: CFTypeRef?
                AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &title)
                guard (title as? String)?.hasPrefix("Blacklist") == true else { continue }
                var position = CGPoint(x: x, y: 50)
                let result = AXUIElementSetAttributeValue(
                    window, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &position)!
                )
                if result != .success {
                    fputs("Could not position Blacklist window (Accessibility error \(result.rawValue)).\n", stderr)
                }
            }
            let bounds = client[kCGWindowBounds as String] as? [String: CGFloat]
            x += (bounds?["Width"] ?? 960) + 20
        }
        exit(0)
    }
    Thread.sleep(forTimeInterval: 1)
}
fputs("No Blacklist window appeared within 60 seconds; leaving window positions unchanged.\n", stderr)
