//! wasm-bindgen exports for the bordercrypt database.

use wasm_bindgen::prelude::*;

use crate::db::{self, SqlValue};
use crate::vfs::{idb_vfs, memory_vfs};

/// Initialise the database engine on the given backend.
///
/// `backend` must be one of `"memory"`, `"idb"`, or `"opfs"`.
#[wasm_bindgen(js_name = initDatabase)]
pub async fn init_database(backend: &str) -> Result<(), JsValue> {
    console_error_panic_hook::set_once();

    match backend {
        "memory" => {
            memory_vfs::register();
            db::open(memory_vfs::VFS_NAME).map_err(|e| JsValue::from_str(&e.to_string()))
        }
        "idb" => {
            idb_vfs::restore().await?;
            idb_vfs::register();
            db::open(idb_vfs::VFS_NAME).map_err(|e| JsValue::from_str(&e.to_string()))
        }
        _ => Err(JsValue::from_str(&format!("unknown backend: {backend}"))),
    }
}

/// Execute a SQL statement with bind parameters.
///
/// `params` is a JS `Array` of values (null, number, string, Uint8Array).
/// Returns a JS object: `{ columns, rows, lastInsertRowId, changes }`.
#[wasm_bindgen]
pub fn execute(sql: &str, params: JsValue) -> Result<JsValue, JsValue> {
    let ps = parse_params(&params)?;
    let result = db::execute(sql, &ps).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(result_to_js(&result))
}

/// Close the database and release resources.
#[wasm_bindgen(js_name = closeDatabase)]
pub fn close_database() -> Result<(), JsValue> {
    db::close().map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Flush all pending writes to IndexedDB (awaitable).
///
/// Called before lock / close to ensure durability.
#[wasm_bindgen]
pub async fn flush() -> Result<(), JsValue> {
    idb_vfs::flush().await
}

// ── JS ↔ Rust conversion ────────────────────────────────────────────

fn parse_params(val: &JsValue) -> Result<Vec<SqlValue>, JsValue> {
    if val.is_null() || val.is_undefined() {
        return Ok(Vec::new());
    }
    let arr = js_sys::Array::from(val);
    let mut out = Vec::with_capacity(arr.length() as usize);
    for i in 0..arr.length() {
        out.push(js_to_sql(&arr.get(i))?);
    }
    Ok(out)
}

fn js_to_sql(v: &JsValue) -> Result<SqlValue, JsValue> {
    if v.is_null() || v.is_undefined() {
        Ok(SqlValue::Null)
    } else if let Some(s) = v.as_string() {
        Ok(SqlValue::Text(s))
    } else if let Some(n) = v.as_f64() {
        if n.fract() == 0.0 && (i64::MIN as f64..=i64::MAX as f64).contains(&n) {
            Ok(SqlValue::Integer(n as i64))
        } else {
            Ok(SqlValue::Real(n))
        }
    } else if v.is_instance_of::<js_sys::Uint8Array>() {
        let a = js_sys::Uint8Array::new(v);
        Ok(SqlValue::Blob(a.to_vec()))
    } else {
        Err(JsValue::from_str("unsupported param type"))
    }
}

fn result_to_js(r: &db::QueryResult) -> JsValue {
    let obj = js_sys::Object::new();

    let cols = js_sys::Array::new();
    for c in &r.columns {
        cols.push(&JsValue::from_str(c));
    }
    js_sys::Reflect::set(&obj, &"columns".into(), &cols).unwrap();

    let rows = js_sys::Array::new();
    for row in &r.rows {
        let js_row = js_sys::Array::new();
        for val in row {
            js_row.push(&sql_to_js(val));
        }
        rows.push(&js_row);
    }
    js_sys::Reflect::set(&obj, &"rows".into(), &rows).unwrap();

    js_sys::Reflect::set(
        &obj,
        &"lastInsertRowId".into(),
        &JsValue::from_f64(r.last_insert_rowid as f64),
    )
    .unwrap();

    js_sys::Reflect::set(&obj, &"changes".into(), &JsValue::from_f64(r.changes as f64)).unwrap();

    obj.into()
}

fn sql_to_js(v: &SqlValue) -> JsValue {
    match v {
        SqlValue::Null => JsValue::NULL,
        SqlValue::Integer(n) => JsValue::from_f64(*n as f64),
        SqlValue::Real(f) => JsValue::from_f64(*f),
        SqlValue::Text(s) => JsValue::from_str(s),
        SqlValue::Blob(b) => {
            let a = js_sys::Uint8Array::new_with_length(b.len() as u32);
            a.copy_from(b);
            a.into()
        }
    }
}
