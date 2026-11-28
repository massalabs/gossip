//! Full-debug build only: forwards every `tracing` event of the mesh crates to
//! Android's system log, tag `GossipMesh`, where the full-debug app reads its own
//! lines back into its debug record (`MeshLogPump.kt`). Elsewhere (host tests) the
//! lines go to stderr.
//!
//! Compiled only with the `full-debug` feature: a normal build has neither this
//! module nor any log line (`quiet-release`). It is installed when the library is
//! loaded (an `.init_array` entry), so no function of the crate and no part of the
//! UniFFI interface changes.
//!
//! One line per event, a JSON object:
//! `{"t":<ms since 1970>,"lvl":"debug","target":"gossip_repl::handler","msg":"...","f":{...}}`.

#[cfg(feature = "quiet-release")]
compile_error!("full-debug needs --no-default-features: quiet-release compiles every log line out");

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Level, Metadata, Subscriber};

/// Logcat tag of the mesh lines; also the marker the privacy check looks for.
pub const TAG: &str = "GossipMesh";

/// Logcat drops what is past about 4 KiB.
const MAX_LINE: usize = 4000;

struct Forwarder {
    next_span: AtomicU64,
}

#[derive(Default)]
struct Fields {
    msg: String,
    f: serde_json::Map<String, serde_json::Value>,
}

impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.put(field, serde_json::Value::String(format!("{value:?}")));
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        self.put(field, value.into());
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.put(field, value.into());
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.put(field, value.into());
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.put(field, value.into());
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.put(field, value.into());
    }
}

impl Fields {
    fn put(&mut self, field: &Field, value: serde_json::Value) {
        if field.name() == "message" {
            self.msg = match value {
                serde_json::Value::String(s) => s,
                other => other.to_string(),
            };
        } else {
            self.f.insert(field.name().to_string(), value);
        }
    }
}

impl Subscriber for Forwarder {
    fn enabled(&self, _: &Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _: &Attributes<'_>) -> Id {
        Id::from_u64(self.next_span.fetch_add(1, Ordering::Relaxed))
    }
    fn record(&self, _: &Id, _: &Record<'_>) {}
    fn record_follows_from(&self, _: &Id, _: &Id) {}
    fn enter(&self, _: &Id) {}
    fn exit(&self, _: &Id) {}
    fn event(&self, event: &Event<'_>) {
        let meta = event.metadata();
        let mut fields = Fields::default();
        event.record(&mut fields);
        let t = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        let lvl = match *meta.level() {
            Level::ERROR => "error",
            Level::WARN => "warn",
            Level::INFO => "info",
            Level::DEBUG => "debug",
            Level::TRACE => "trace",
        };
        let line = serde_json::json!({
            "t": t,
            "lvl": lvl,
            "target": meta.target(),
            "msg": fields.msg,
            "f": fields.f,
        })
        .to_string();
        write(*meta.level(), &line);
    }
}

fn truncated(line: &str) -> &str {
    if line.len() <= MAX_LINE {
        return line;
    }
    let mut end = MAX_LINE;
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    &line[..end]
}

#[cfg(target_os = "android")]
fn write(level: Level, line: &str) {
    use std::ffi::{c_char, c_int, CString};
    #[link(name = "log")]
    unsafe extern "C" {
        fn __android_log_write(prio: c_int, tag: *const c_char, text: *const c_char) -> c_int;
    }
    let prio: c_int = match level {
        Level::ERROR => 6,
        Level::WARN => 5,
        Level::INFO => 4,
        Level::DEBUG => 3,
        Level::TRACE => 2,
    };
    // JSON escapes control characters, so the line has no NUL
    let (Ok(tag), Ok(text)) = (CString::new(TAG), CString::new(truncated(line))) else {
        return;
    };
    // SAFETY: two valid NUL-terminated strings that outlive the call
    unsafe {
        __android_log_write(prio, tag.as_ptr(), text.as_ptr());
    }
}

#[cfg(not(target_os = "android"))]
fn write(_: Level, line: &str) {
    eprintln!("{TAG} {}", truncated(line));
}

extern "C" fn install() {
    // another subscriber already set (a test harness): keep it
    let _ = tracing::subscriber::set_global_default(Forwarder {
        next_span: AtomicU64::new(1),
    });
}

/// Runs [`install`] when the library is loaded (ELF targets: Android, and Linux for
/// host tests).
#[cfg(any(target_os = "android", target_os = "linux"))]
#[used]
#[unsafe(link_section = ".init_array")]
static INSTALL: extern "C" fn() = install;

/// Same on Apple targets (Mach-O): the iOS app reads the stderr lines back into its
/// debug record (`DebugLogWriter.swift`). The library is static there: the object
/// holding this entry is linked only if it is the crate's single codegen unit, which
/// `scripts/build-mesh-ios.sh --full-debug` sets.
#[cfg(target_vendor = "apple")]
#[used]
#[unsafe(link_section = "__DATA,__mod_init_func")]
static INSTALL_APPLE: extern "C" fn() = install;
