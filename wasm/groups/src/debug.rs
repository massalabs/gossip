//! Debug events of the full debug build (cargo feature `full-debug`).
//!
//! This module exists only with the feature. Without it, `dbg_event!`,
//! `dbg_do!` and `dbg_ctx!` expand to nothing, their arguments included: nothing is
//! evaluated, allocated or compiled in.
//!
//! An event is a static name, a level and key/value fields. Ordinary fields hold metadata
//! only (kinds, sizes, counts, reasons as static strings, short IDs of 8 hex characters);
//! raw bytes and full IDs go in `c` (content), key material in `s` (secrets), so that a
//! sender can strip them without touching the rest.
//!
//! Events go to one sink per thread ([`set_sink`]): the wasm module has one thread and one
//! engine, and each test thread its own sink. Nothing is built while no sink is installed.
//!
//! Why the engine's behaviour cannot depend on a line: the sink only receives a reference to
//! a value built from what the engine already computed, returns nothing, and is never
//! consulted by the engine; a panic or a re-entrant call in it is contained here.

use std::cell::{Cell, RefCell};
use std::fmt::Write as _;

/// The level of an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    /// A step of a healthy operation.
    Debug,
    /// A state change worth seeing in a short log.
    Info,
    /// Something refused, dropped or capped.
    Warn,
    /// A failure.
    Error,
}

impl Level {
    /// The name in the JSON line.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }
}

/// A field value.
#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    /// No value.
    Null,
    /// A boolean.
    Bool(bool),
    /// An unsigned number.
    U64(u64),
    /// A static string (a reason, a kind).
    Str(&'static str),
    /// A string built for the event (a short ID, an error).
    String(String),
    /// A list.
    List(Vec<Val>),
}

/// Conversion into a field value.
pub trait IntoVal {
    /// The value.
    fn into_val(self) -> Val;
}

impl IntoVal for Val {
    fn into_val(self) -> Val {
        self
    }
}
impl IntoVal for bool {
    fn into_val(self) -> Val {
        Val::Bool(self)
    }
}
impl IntoVal for &'static str {
    fn into_val(self) -> Val {
        Val::Str(self)
    }
}
impl IntoVal for String {
    fn into_val(self) -> Val {
        Val::String(self)
    }
}
macro_rules! unsigned {
    ($($t:ty),*) => {$(
        impl IntoVal for $t {
            fn into_val(self) -> Val {
                Val::U64(self as u64)
            }
        }
    )*};
}
unsigned!(u8, u16, u32, u64, usize);
impl<T: IntoVal> IntoVal for Option<T> {
    fn into_val(self) -> Val {
        self.map_or(Val::Null, IntoVal::into_val)
    }
}
impl<T: IntoVal> IntoVal for Vec<T> {
    fn into_val(self) -> Val {
        Val::List(self.into_iter().map(IntoVal::into_val).collect())
    }
}

/// One event.
#[derive(Debug, Clone, PartialEq)]
pub struct DebugEvent {
    /// The name, stable and dotted (`engine.event.in`).
    pub ev: &'static str,
    /// The level.
    pub lvl: Level,
    /// The ordinary fields.
    pub f: Vec<(&'static str, Val)>,
    /// Content: raw bytes, full IDs, names.
    pub c: Vec<(&'static str, Val)>,
    /// Secrets: key material.
    pub s: Vec<(&'static str, Val)>,
}

impl DebugEvent {
    /// A field by name, for tests and sinks.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Val> {
        self.f.iter().find(|(k, _)| *k == key).map(|(_, v)| v)
    }

    /// A field as a string (a static or built one), for tests and sinks.
    #[must_use]
    pub fn str(&self, key: &str) -> Option<&str> {
        match self.get(key)? {
            Val::Str(s) => Some(s),
            Val::String(s) => Some(s),
            _ => None,
        }
    }

    /// The event as one JSON object: `{"ev","lvl","f","c"?,"s"?}`.
    #[must_use]
    pub fn to_json(&self) -> String {
        let mut out = String::with_capacity(128);
        out.push_str("{\"ev\":");
        json_str(&mut out, self.ev);
        out.push_str(",\"lvl\":");
        json_str(&mut out, self.lvl.as_str());
        out.push_str(",\"f\":");
        json_map(&mut out, &self.f);
        if !self.c.is_empty() {
            out.push_str(",\"c\":");
            json_map(&mut out, &self.c);
        }
        if !self.s.is_empty() {
            out.push_str(",\"s\":");
            json_map(&mut out, &self.s);
        }
        out.push('}');
        out
    }
}

fn json_str(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn json_val(out: &mut String, v: &Val) {
    match v {
        Val::Null => out.push_str("null"),
        Val::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        // Beyond 2^53 a JSON number loses precision in JavaScript: sent as a string.
        Val::U64(n) if *n > 9_007_199_254_740_991 => {
            let _ = write!(out, "\"{n}\"");
        }
        Val::U64(n) => {
            let _ = write!(out, "{n}");
        }
        Val::Str(s) => json_str(out, s),
        Val::String(s) => json_str(out, s),
        Val::List(l) => {
            out.push('[');
            for (i, x) in l.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                json_val(out, x);
            }
            out.push(']');
        }
    }
}

fn json_map(out: &mut String, m: &[(&'static str, Val)]) {
    out.push('{');
    for (i, (k, v)) in m.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        json_str(out, k);
        out.push(':');
        json_val(out, v);
    }
    out.push('}');
}

type Sink = Box<dyn Fn(&DebugEvent)>;

thread_local! {
    static SINK: RefCell<Option<Sink>> = const { RefCell::new(None) };
    static CTX: Cell<(&'static str, usize)> = const { Cell::new(("", 0)) };
}

/// Installs (or removes, with `None`) the sink of this thread.
pub fn set_sink(sink: Option<Sink>) {
    SINK.with(|s| {
        if let Ok(mut s) = s.try_borrow_mut() {
            *s = sink;
        }
    });
}

/// Whether a sink is installed: nothing is built otherwise.
#[must_use]
pub fn enabled() -> bool {
    SINK.with(|s| s.try_borrow().is_ok_and(|s| s.is_some()))
}

/// Hands `event` to the sink. A call from inside the sink is dropped.
pub fn emit(event: &DebugEvent) {
    SINK.with(|s| {
        if let Ok(s) = s.try_borrow()
            && let Some(f) = s.as_ref()
        {
            f(event);
        }
    });
}

/// Sets how the item being received arrived and its size, read by the verdict of a message
/// event (which receives a decoded event and knows neither).
pub fn set_ctx(via: &'static str, size: usize) {
    CTX.with(|c| c.set((via, size)));
}

/// See [`set_ctx`].
#[must_use]
pub fn ctx() -> (&'static str, usize) {
    CTX.with(Cell::get)
}

const HEX: &[u8; 16] = b"0123456789abcdef";

/// The first 8 hex characters of an ID.
pub fn short<T: AsRef<[u8]> + ?Sized>(id: &T) -> Val {
    let b = id.as_ref();
    let mut s = String::with_capacity(8);
    for x in b.iter().take(4) {
        s.push(HEX[usize::from(x >> 4)] as char);
        s.push(HEX[usize::from(x & 15)] as char);
    }
    Val::String(s)
}

/// The short IDs of a list.
pub fn shorts<'a, T: AsRef<[u8]> + 'a>(ids: impl IntoIterator<Item = &'a T>) -> Val {
    Val::List(ids.into_iter().map(|i| short(i)).collect())
}

/// The full hex of bytes (content and secret fields only).
pub fn hex<T: AsRef<[u8]> + ?Sized>(bytes: &T) -> Val {
    let b = bytes.as_ref();
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(HEX[usize::from(x >> 4)] as char);
        s.push(HEX[usize::from(x & 15)] as char);
    }
    Val::String(s)
}

/// A `Debug` rendering (an error), for ordinary fields: errors of this crate carry no bytes.
pub fn dbg<T: core::fmt::Debug + ?Sized>(v: &T) -> Val {
    Val::String(format!("{v:?}"))
}

#[cfg(test)]
pub(crate) mod capture {
    //! A sink that keeps the events of the test thread.
    use super::{DebugEvent, set_sink};
    use std::cell::RefCell;
    use std::rc::Rc;

    /// Installs a capturing sink; the events are read with [`Captured::take`].
    pub(crate) fn install() -> Captured {
        let buf: Rc<RefCell<Vec<DebugEvent>>> = Rc::default();
        let b = Rc::clone(&buf);
        set_sink(Some(Box::new(move |e| b.borrow_mut().push(e.clone()))));
        Captured(buf)
    }

    pub(crate) struct Captured(Rc<RefCell<Vec<DebugEvent>>>);

    impl Captured {
        pub(crate) fn take(&self) -> Vec<DebugEvent> {
            core::mem::take(&mut *self.0.borrow_mut())
        }
    }

    impl Drop for Captured {
        fn drop(&mut self) {
            set_sink(None);
        }
    }
}
