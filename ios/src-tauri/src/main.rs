// Prevents an extra console window on Windows in release; harmless everywhere else.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    rune_ios_lib::run()
}
