//! Self-hosted Harbr server.
//!
//! The web counterpart to `main.rs` (the desktop app). Same backend crate, HTTP
//! + WebSocket instead of Tauri IPC. Built only with `--features web`.

fn main() {
    if let Err(e) = ship_studio_lib::logging::init_server_logging() {
        eprintln!("Failed to initialize logging: {e}");
    }

    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("Failed to start the async runtime: {e}");
            std::process::exit(1);
        }
    };

    if let Err(e) = runtime.block_on(ship_studio_lib::web::serve()) {
        // Config and bind failures land here. They're operator errors (missing
        // token, port in use), so a bare message beats a panic backtrace.
        eprintln!("harbr-server: {e}");
        std::process::exit(1);
    }
}
