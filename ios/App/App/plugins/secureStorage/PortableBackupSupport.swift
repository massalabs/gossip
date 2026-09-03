import Foundation

struct PortableBackupEntry: Codable {
    var bookmark: Data
    let name: String
    var unverified: Bool
}

enum PortableBackupSupportError: Error {
    case securityScopeDenied
    case coordinationFailed
}

final class PortableBackupRuntime {
    let url: URL
    var written: UInt64 = 0
    var inputOffset: UInt64 = 0
    var exportOpen = false
    var verificationOpen = false

    init(url: URL) throws {
        self.url = url
        guard url.startAccessingSecurityScopedResource() else {
            throw PortableBackupSupportError.securityScopeDenied
        }
    }

    func close() {
        exportOpen = false
        verificationOpen = false
    }

    deinit {
        url.stopAccessingSecurityScopedResource()
    }
}

enum PortableBackupCoordinatedAccess {
    static func read<T>(_ url: URL, accessor: (URL) throws -> T) throws -> T {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var result: Result<T, Error>?
        coordinator.coordinate(
            readingItemAt: url,
            options: [],
            error: &coordinationError
        ) { coordinatedURL in
            result = Result { try accessor(coordinatedURL) }
        }
        if let coordinationError { throw coordinationError }
        guard let result else { throw PortableBackupSupportError.coordinationFailed }
        return try result.get()
    }

    static func write<T>(
        _ url: URL,
        options: NSFileCoordinator.WritingOptions,
        accessor: (URL) throws -> T
    ) throws -> T {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var result: Result<T, Error>?
        coordinator.coordinate(
            writingItemAt: url,
            options: options,
            error: &coordinationError
        ) { coordinatedURL in
            result = Result { try accessor(coordinatedURL) }
        }
        if let coordinationError { throw coordinationError }
        guard let result else { throw PortableBackupSupportError.coordinationFailed }
        return try result.get()
    }
}

enum PortableBackupJournalStore {
    static var url: URL {
        let directory = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("portable-backup", isDirectory: true)
        return directory.appendingPathComponent("pending-output-journal.json")
    }

    static func load() throws -> [String: PortableBackupEntry] {
        let journal = url
        guard FileManager.default.fileExists(atPath: journal.path) else { return [:] }
        return try JSONDecoder().decode(
            [String: PortableBackupEntry].self,
            from: Data(contentsOf: journal)
        )
    }

    static func persist(_ entries: [String: PortableBackupEntry]) throws {
        let journal = url
        let directoryURL = journal.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true
        )
        var directoryValues = URLResourceValues()
        directoryValues.isExcludedFromBackup = true
        var mutableDirectoryURL = directoryURL
        try mutableDirectoryURL.setResourceValues(directoryValues)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: directoryURL.path
        )
        let data = try JSONEncoder().encode(entries)
        try data.write(
            to: journal,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
        var fileValues = URLResourceValues()
        fileValues.isExcludedFromBackup = true
        var mutableJournalURL = journal
        try mutableJournalURL.setResourceValues(fileValues)
    }
}
