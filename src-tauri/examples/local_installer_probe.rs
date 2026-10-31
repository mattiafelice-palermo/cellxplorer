//! Read-only verifier for signed local candidate/fixture acceptance. Never installs.
#[path = "../src/app_channel.rs"]
mod app_channel;
#[path = "../src/local_installer.rs"]
mod local_installer;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 5 { return Err("Usage: local_installer_probe INSTALLER SIGNATURE PUBLIC_KEY_FILE CHANNEL CURRENT_VERSION".into()); }
    let channel = match args[3].as_str() {
        "stable" => app_channel::AppChannel::Stable,
        "beta" => app_channel::AppChannel::Beta,
        "alpha" => app_channel::AppChannel::Alpha,
        _ => return Err("Unknown channel".into()),
    };
    #[cfg(windows)]
    {
        let key = std::fs::read_to_string(&args[2])?;
        let (version, bytes) = local_installer::load(&args[0], &args[1], &key, channel, &args[4])?;
        use sha2::Digest;
        println!("{}", serde_json::json!({"version": version, "bytes": bytes.len(), "sha256": format!("{:x}", sha2::Sha256::digest(&bytes)), "installed": false}));
        Ok(())
    }
    #[cfg(not(windows))]
    { let _ = channel; Err("Windows required".into()) }
}
