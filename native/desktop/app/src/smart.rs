//! Smart-playlist rules (web `lib/smartRules.ts`): the fields and operators the server accepts, when a rule is complete, and
//! the wire form of a rule. The builder dialog is in `smartdlg.rs`.
use serde_json::{json, Value};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind { Text, Number, Date, Enum }

pub struct Op { pub op: &'static str, pub label: &'static str, pub no_value: bool }
pub struct Field { pub id: &'static str, pub label: &'static str, pub kind: Kind, pub ops: Vec<Op>, pub options: &'static [&'static str], pub placeholder: &'static str }

fn op(op: &'static str, label: &'static str) -> Op { Op { op, label, no_value: false } }
fn text_ops() -> Vec<Op> { vec![op("contains", "contains"), op("eq", "is"), op("ne", "is not"), op("notContains", "does not contain"), op("startsWith", "starts with")] }
fn num_ops() -> Vec<Op> { vec![op("eq", "is"), op("gte", "is at least"), op("lte", "is at most"), op("gt", "is more than"), op("lt", "is less than"), op("between", "is between")] }
fn date_ops() -> Vec<Op> { vec![op("gt", "is after"), op("lt", "is before"), op("between", "is between")] }

pub fn fields() -> Vec<Field> {
    let f = |id, label, kind, ops, options, placeholder| Field { id, label, kind, ops, options, placeholder };
    vec![
        f("genre", "Genre", Kind::Text, text_ops(), &[], "Jazz"),
        f("artist", "Artist", Kind::Text, text_ops(), &[], "Artist name"),
        f("year", "Year", Kind::Number, num_ops(), &[], "1990"),
        f("format", "Format", Kind::Text, text_ops().into_iter().take(3).collect(), &[], "FLAC"),
        f("source", "Source", Kind::Enum, vec![op("eq", "is"), op("ne", "is not")], &["local", "spotify"], ""),
        f("added", "Date added", Kind::Date, date_ops(), &[], ""),
        f("plays", "Play count", Kind::Number, num_ops().into_iter().filter(|o| o.op != "between").collect(), &[], "0"),
        f("lastPlayed", "Last played", Kind::Date, { let mut v = vec![Op { op: "never", label: "never", no_value: true }, Op { op: "played", label: "has been played", no_value: true }]; v.extend(date_ops()); v }, &[], ""),
    ]
}

pub const SORTS: [(&str, &str); 8] = [("artist", "Artist"), ("title", "Title"), ("album", "Album"), ("year", "Year"), ("added", "Date added"), ("plays", "Play count"), ("lastPlayed", "Last played"), ("duration", "Length")];

/// One rule while it is being edited: raw strings from the boxes.
#[derive(Clone, Debug, PartialEq)]
pub struct Draft { pub field: &'static str, pub op: &'static str, pub a: String, pub b: String }

pub fn field_def(id: &str) -> Field { fields().into_iter().find(|f| f.id == id).unwrap_or_else(|| fields().remove(0)) }

pub fn blank(field: &str) -> Draft {
    let f = field_def(field);
    Draft { field: f.id, op: f.ops[0].op, a: if f.kind == Kind::Enum { f.options[0].to_string() } else { String::new() }, b: String::new() }
}

fn needs_value(d: &Draft) -> bool { !field_def(d.field).ops.iter().find(|o| o.op == d.op).is_some_and(|o| o.no_value) }

pub fn rule_complete(d: &Draft) -> bool {
    if !needs_value(d) { return true; }
    let k = field_def(d.field).kind;
    let ok = |v: &str| if k == Kind::Number { !v.trim().is_empty() && v.trim().parse::<f64>().is_ok() } else { !v.trim().is_empty() };
    ok(&d.a) && (d.op != "between" || ok(&d.b))
}

pub fn spec_complete(rules: &[Draft]) -> bool { !rules.is_empty() && rules.iter().all(rule_complete) }

/// The wire form of a rule (numbers as numbers, dates as ISO strings).
pub fn rule_to_spec(d: &Draft) -> Value {
    if !needs_value(d) { return json!({"field": d.field, "op": d.op}); }
    let num = field_def(d.field).kind == Kind::Number;
    let conv = |v: &str| if num { json!(v.trim().parse::<f64>().unwrap_or(0.)) } else { json!(v.trim()) };
    json!({"field": d.field, "op": d.op, "value": if d.op == "between" { json!([conv(&d.a), conv(&d.b)]) } else { conv(&d.a) }})
}

/// The `{rules, match, sort, limit}` body of the preview and create calls.
pub fn spec(rules: &[Draft], match_all: bool, sort: &str, desc: bool, limit: Option<u32>) -> Value {
    let mut v = json!({"rules": rules.iter().map(rule_to_spec).collect::<Vec<_>>(), "match": if match_all { "all" } else { "any" }, "sort": format!("{sort}:{}", if desc { "desc" } else { "asc" })});
    if let Some(l) = limit { v["limit"] = json!(l); }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    #[::core::prelude::v1::test]
    fn a_rule_is_complete_when_its_values_are_filled() {
        let mut d = blank("year");
        assert!(!rule_complete(&d));
        d.a = "1990".into();
        assert!(rule_complete(&d));
        d.op = "between";
        assert!(!rule_complete(&d));
        d.b = "abc".into();
        assert!(!rule_complete(&d));
        d.b = "1999".into();
        assert!(rule_complete(&d));
        let mut never = blank("lastPlayed");
        never.op = "never";
        assert!(rule_complete(&never));
        assert!(!spec_complete(&[]));
    }
    #[::core::prelude::v1::test]
    fn the_wire_form_matches_the_web() {
        let mut d = blank("year");
        d.op = "between"; d.a = "1980".into(); d.b = "1989".into();
        assert_eq!(rule_to_spec(&d), json!({"field": "year", "op": "between", "value": [1980., 1989.]}));
        let mut g = blank("genre"); g.a = " Jazz ".into();
        assert_eq!(rule_to_spec(&g), json!({"field": "genre", "op": "contains", "value": "Jazz"}));
        let mut n = blank("lastPlayed"); n.op = "never";
        assert_eq!(rule_to_spec(&n), json!({"field": "lastPlayed", "op": "never"}));
        assert_eq!(spec(&[g], false, "title", true, Some(50))["sort"], "title:desc");
        assert_eq!(blank("source").a, "local");
    }
}
