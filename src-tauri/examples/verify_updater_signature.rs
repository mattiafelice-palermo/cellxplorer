//! Release-test utility: same decoding and verification as Tauri updater 2.10.
//! An example target, never bundled as an application executable.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};

fn verify(
    data: &[u8],
    signature: &str,
    public_key: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let key = String::from_utf8(STANDARD.decode(public_key.trim())?)?;
    let signature = String::from_utf8(STANDARD.decode(signature.trim())?)?;
    PublicKey::decode(&key)?.verify(data, &Signature::decode(&signature)?, true)?;
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 6
        || args[0] != "--installer"
        || args[2] != "--signature"
        || args[4] != "--config"
    {
        return Err("Usage: verify_updater_signature --installer FILE --signature FILE --config tauri.conf.json".into());
    }
    let config: serde_json::Value = serde_json::from_slice(&std::fs::read(&args[5])?)?;
    let public_key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("Embedded updater public key is missing")?;
    verify(
        &std::fs::read(&args[1])?,
        &std::fs::read_to_string(&args[3])?,
        public_key,
    )?;
    println!("PASS: installer bytes verified against the embedded updater public key");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const KEY: &str = "untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
    const SIG: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==\n";
    #[test]
    fn accepts_valid_vector_and_rejects_changed_bytes_signature_and_key() {
        let key = STANDARD.encode(KEY);
        let sig = STANDARD.encode(SIG);
        assert!(verify(b"test", &sig, &key).is_ok());
        assert!(verify(b"tesT", &sig, &key).is_err());
        assert!(verify(b"test", &STANDARD.encode(SIG.replace("RUQf", "RUQg")), &key).is_err());
        assert!(verify(b"test", &sig, &STANDARD.encode(KEY.replace("RWQf", "RWQg"))).is_err());
        assert!(verify(b"test", "invalid", &key).is_err());
    }
}
