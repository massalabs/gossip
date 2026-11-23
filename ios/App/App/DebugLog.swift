import Foundation
import os

/// The only way the app's own Swift code writes a log line, as `DebugLog.kt`
/// on Android.
///
/// A debug build (`DEBUG`) writes to the unified log, as before; a release
/// build writes nothing, as no log may remain in a release build: the unified
/// log can be read from a connected computer or a sysdiagnose.
///
/// The full debug build (`FULL_DEBUG`, see `DebugLogWriter.swift`) also writes
/// every line to its on-disk record, with `src:"native"`. In any other build
/// both branches are compiled out and the arguments, taken as autoclosures,
/// are never evaluated.
///
/// Content and secrets go only in `c` and `s` of `event(...)`, never in `msg`,
/// so that a send without them can remove them.
enum DebugLog {
    static func d(_ tag: String, _ msg: @autoclosure () -> String) {
        record("debug", tag, msg, nil)
    }

    static func i(_ tag: String, _ msg: @autoclosure () -> String) {
        record("info", tag, msg, nil)
    }

    static func w(_ tag: String, _ msg: @autoclosure () -> String, _ error: Error? = nil) {
        record("warn", tag, msg, error)
    }

    static func e(_ tag: String, _ msg: @autoclosure () -> String, _ error: Error? = nil) {
        record("error", tag, msg, error)
    }

    /// A structured line: `ev` (stable, dotted), its fields, and its
    /// duration in ms when it ends an operation. Full debug build only.
    static func event(
        _ tag: String,
        _ ev: String,
        lvl: String = "info",
        dur: Int? = nil,
        _ fields: @autoclosure () -> [String: Any] = [:]
    ) {
        #if FULL_DEBUG
        var f = fields()
        f["tag"] = tag
        DebugLogWriter.shared.event(ev, lvl: lvl, f: f, dur: dur)
        #endif
    }

    /// Milliseconds since `start` (a `DispatchTime`), for `dur`.
    static func ms(since start: DispatchTime) -> Int {
        let now = DispatchTime.now().uptimeNanoseconds
        let then = start.uptimeNanoseconds
        return now >= then ? Int((now - then) / 1_000_000) : 0
    }

    private static func record(_ lvl: String, _ tag: String, _ msg: () -> String, _ error: Error?) {
        #if DEBUG
        let text = msg()
        let logger = Logger(subsystem: "net.massa.gossip", category: tag)
        switch lvl {
        case "error": logger.error("\(text, privacy: .public)")
        case "warn": logger.warning("\(text, privacy: .public)")
        case "info": logger.info("\(text, privacy: .public)")
        default: logger.debug("\(text, privacy: .public)")
        }
        #endif
        #if FULL_DEBUG
        DebugLogWriter.shared.native(lvl, tag, msg(), error)
        #endif
    }
}
