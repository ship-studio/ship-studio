const COMMANDS: &[&str] =
    &["spawn", "write", "read", "resize", "kill", "exitstatus", "process_id"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
