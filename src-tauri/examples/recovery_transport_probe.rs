//! Test-only executable for the real client transport against harmless NSIS code.
//! No Tauri app/backend is initialized and no installed application is changed.
#![allow(dead_code)]
#[path = "../src/app_channel.rs"]
mod app_channel;
#[path = "../src/installation_scope.rs"]
mod installation_scope;
#[path = "../src/update_recovery.rs"]
mod update_recovery;

#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::var_os("CX_RECOVERY_PROBE_INSTALLER").ok_or("Missing harmless fixture payload")?;
    let bytes = std::fs::read(path)?;
    // Production callers supply signature-verified bytes. This example supplies
    // a compiler fixture only: it tests transport, NOT cryptographic trust/UAC.
    let mut prepared = update_recovery::prepare_verified_recovery(&bytes, "1.0.0", "stable")
        .map_err(std::io::Error::other)?;
    prepared.commit().map_err(std::io::Error::other)?;
    prepared.authorize_exit().map_err(std::io::Error::other)?;
    std::mem::forget(prepared);
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    panic!("Native recovery transport probe requires Windows");
}
