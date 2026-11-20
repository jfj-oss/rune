import Foundation

/// Settings in ~/Library/Application Support/rune-mini: config.json (server URL, zone) and `token` (mode 600).
/// RUNE_MINI_CONFIG_DIR overrides the folder. No host and no token is built in: the first run asks for the URL.
enum Store {
    struct Config: Codable, Equatable {
        var url = ""
        var zone = "pc"
    }

    static var dir: URL {
        if let d = ProcessInfo.processInfo.environment["RUNE_MINI_CONFIG_DIR"], !d.isEmpty { return URL(fileURLWithPath: d) }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("rune-mini")
    }

    static func load() -> Config {
        guard let d = try? Data(contentsOf: dir.appendingPathComponent("config.json")),
              let c = try? JSONDecoder().decode(Config.self, from: d) else { return Config() }
        return c
    }

    static func save(_ c: Config) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let d = try? enc.encode(c) { try? d.write(to: dir.appendingPathComponent("config.json"), options: .atomic) }
    }

    static var tokenURL: URL { dir.appendingPathComponent("token") }

    /// The token, or "" when there is none. A file readable by others is tightened to 600 on the way.
    static func loadToken() -> String {
        let p = tokenURL.path
        if let a = try? FileManager.default.attributesOfItem(atPath: p), let perm = a[.posixPermissions] as? Int, perm & 0o077 != 0 {
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: p)
        }
        return ((try? String(contentsOfFile: p, encoding: .utf8)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Created with mode 600 from the first byte.
    static func saveToken(_ t: String) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let p = tokenURL.path
        try? FileManager.default.removeItem(atPath: p)
        FileManager.default.createFile(atPath: p, contents: Data(t.trimmingCharacters(in: .whitespacesAndNewlines).utf8), attributes: [.posixPermissions: 0o600])
    }
}
