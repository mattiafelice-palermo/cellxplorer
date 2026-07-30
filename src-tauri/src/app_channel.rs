use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppChannel {
    Stable,
    Beta,
}

pub const STABLE_IDENTIFIER: &str = "com.cellxplorer.desktop";
pub const BETA_IDENTIFIER: &str = "com.cellxplorer.desktop.beta";

pub const STABLE_CHANNEL_ENDPOINT: &str =
    "https://raw.githubusercontent.com/mattiafelice-palermo/cellxplorer/release-channels/stable/latest.json";
pub const BETA_CHANNEL_ENDPOINT: &str =
    "https://raw.githubusercontent.com/mattiafelice-palermo/cellxplorer/release-channels/beta/latest.json";

pub const BETA_PRODUCT_NAME: &str = "CellXplorer Beta";

pub fn validate_release_version(channel: AppChannel, value: &str) -> Result<(), String> {
    let version = semver::Version::parse(value).map_err(|_| {
        format!(
            "{} update version {value:?} is not exact SemVer.",
            channel.product_name()
        )
    })?;

    if !version.build.is_empty() {
        return Err(format!(
            "{} update version {value:?} must not contain build metadata.",
            channel.product_name()
        ));
    }

    match channel {
        AppChannel::Stable if version.pre.is_empty() => Ok(()),
        AppChannel::Stable => Err(format!(
            "CellXplorer Stable accepts only MAJOR.MINOR.PATCH update versions."
        )),
        AppChannel::Beta => {
            let prerelease = version.pre.as_str();
            let sequence = if let Some(seq) = prerelease.strip_prefix("beta.") {
                seq
            } else if let Some(seq) = prerelease.strip_prefix("beta") {
                seq
            } else {
                return Err(
                    "CellXplorer Beta accepts only MAJOR.MINOR.PATCH-beta.N or MAJOR.MINOR.PATCH-betaNNN update versions."
                        .to_string(),
                );
            };
            if sequence.is_empty() || !sequence.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(
                    "CellXplorer Beta accepts only MAJOR.MINOR.PATCH-beta.N or MAJOR.MINOR.PATCH-betaNNN update versions."
                        .to_string(),
                );
            }
            Ok(())
        }
    }
}

impl AppChannel {
    pub fn from_identifier(identifier: &str) -> Result<Self, String> {
        match identifier {
            STABLE_IDENTIFIER => Ok(AppChannel::Stable),
            BETA_IDENTIFIER => Ok(AppChannel::Beta),
            other => Err(format!(
                "Unsupported CellXplorer application identifier: {other}"
            )),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            AppChannel::Stable => "stable",
            AppChannel::Beta => "beta",
        }
    }

    pub fn product_name(&self) -> &'static str {
        match self {
            AppChannel::Stable => "CellXplorer",
            AppChannel::Beta => "CellXplorer Beta",
        }
    }

    pub fn autostart_registry_value(&self) -> &'static str {
        self.product_name()
    }

    pub fn deep_link_scheme(&self) -> &'static str {
        match self {
            AppChannel::Stable => "cellxplorer",
            AppChannel::Beta => "cellxplorer-beta",
        }
    }

    pub fn deep_link_import_prefix(&self) -> String {
        format!("{}://import-analysis", self.deep_link_scheme())
    }

    pub fn accepts_deep_link(&self, url: &str) -> bool {
        url.starts_with(&self.deep_link_import_prefix())
    }

    #[cfg(target_os = "windows")]
    pub fn frame_color_bgr(&self) -> u32 {
        match self {
            AppChannel::Stable => 0x0086_b812,
            AppChannel::Beta => 0x00_b7_7836,
        }
    }

    pub fn window_icon_rgba(&self) -> &'static [u8] {
        match self {
            AppChannel::Stable => include_bytes!("../icons/icon-256.rgba"),
            AppChannel::Beta => include_bytes!("../icons-beta/icon-256.rgba"),
        }
    }

    pub fn default_data_dir_name(&self) -> &'static str {
        match self {
            AppChannel::Stable => ".cellxplorer",
            AppChannel::Beta => ".cellxplorer-beta",
        }
    }

    pub fn default_data_root(&self, home: &Path) -> PathBuf {
        home.join(self.default_data_dir_name())
    }
}

pub fn resolve_data_root(channel: AppChannel, home: &Path) -> PathBuf {
    if let Ok(value) = std::env::var("CELLXPLORER_DATA") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }
    channel.default_data_root(home)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_exact_identifiers() {
        assert_eq!(
            AppChannel::from_identifier(STABLE_IDENTIFIER).unwrap(),
            AppChannel::Stable
        );
        assert_eq!(
            AppChannel::from_identifier(BETA_IDENTIFIER).unwrap(),
            AppChannel::Beta
        );
    }

    #[test]
    fn rejects_unknown_identifier() {
        assert!(AppChannel::from_identifier("com.example.app").is_err());
    }

    #[test]
    fn autostart_names_match_product_names() {
        assert_eq!(AppChannel::Stable.autostart_registry_value(), "CellXplorer");
        assert_eq!(
            AppChannel::Beta.autostart_registry_value(),
            "CellXplorer Beta"
        );
    }

    #[test]
    fn deep_links_are_channel_specific() {
        let stable = AppChannel::Stable;
        let beta = AppChannel::Beta;
        assert!(stable.accepts_deep_link("cellxplorer://import-analysis"));
        assert!(!stable.accepts_deep_link("cellxplorer-beta://import-analysis"));
        assert!(beta.accepts_deep_link("cellxplorer-beta://import-analysis"));
        assert!(!beta.accepts_deep_link("cellxplorer://import-analysis"));
    }

    #[test]
    fn frame_colors_differ_by_channel() {
        assert_ne!(
            AppChannel::Stable.frame_color_bgr(),
            AppChannel::Beta.frame_color_bgr()
        );
        assert_eq!(AppChannel::Beta.frame_color_bgr(), 0x00_b7_7836);
    }

    #[test]
    fn default_data_roots_differ_by_channel() {
        let home = Path::new(r"C:\Users\example");
        assert_eq!(
            AppChannel::Stable.default_data_root(home),
            PathBuf::from(r"C:\Users\example\.cellxplorer")
        );
        assert_eq!(
            AppChannel::Beta.default_data_root(home),
            PathBuf::from(r"C:\Users\example\.cellxplorer-beta")
        );
    }

    #[test]
    fn resolve_data_root_honors_explicit_override() {
        let home = Path::new(r"C:\Users\example");
        std::env::set_var("CELLXPLORER_DATA", r"C:\disposable\data");
        let resolved = super::resolve_data_root(AppChannel::Beta, home);
        std::env::remove_var("CELLXPLORER_DATA");
        assert_eq!(resolved, PathBuf::from(r"C:\disposable\data"));
    }

    #[test]
    fn stable_release_versions_are_exact() {
        for version in ["0.18.0", "1.0.0", "12.34.56"] {
            assert!(validate_release_version(AppChannel::Stable, version).is_ok());
        }
        for version in [
            "v0.18.0",
            "0.18",
            "0.18.0-beta.1",
            "0.18.0+build.1",
            "0.18.0-rc.1",
        ] {
            assert!(
                validate_release_version(AppChannel::Stable, version).is_err(),
                "{version}"
            );
        }
    }

    #[test]
    fn beta_release_versions_are_exact() {
        for version in [
            "0.18.0-beta.1",
            "1.0.0-beta.0",
            "12.34.56-beta.123",
            "0.17.0-beta011",
            "0.17.0-beta012",
        ] {
            assert!(validate_release_version(AppChannel::Beta, version).is_ok());
        }
        for version in [
            "0.18.0",
            "v0.18.0-beta.1",
            "0.18.0-beta",
            "0.18.0-beta.01",
            "0.18.0-beta.1.extra",
            "0.18.0-beta.1+build.1",
            "0.18.0-BETA.1",
            "0.18.0-rc.1",
        ] {
            assert!(
                validate_release_version(AppChannel::Beta, version).is_err(),
                "{version}"
            );
        }
    }

    #[test]
    fn compact_beta_successors_keep_semver_order() {
        let beta_11 = semver::Version::parse("0.17.0-beta011").unwrap();
        let beta_12 = semver::Version::parse("0.17.0-beta012").unwrap();
        let dotted_beta_12 = semver::Version::parse("0.17.0-beta.12").unwrap();

        assert!(beta_12 > beta_11);
        assert!(
            dotted_beta_12 < beta_11,
            "do not switch back to dotted prereleases within a compact Beta line"
        );
    }
}
