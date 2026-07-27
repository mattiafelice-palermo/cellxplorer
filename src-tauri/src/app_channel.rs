#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppChannel {
    Stable,
    Beta,
}

pub const STABLE_IDENTIFIER: &str = "com.cellxplorer.desktop";
pub const BETA_IDENTIFIER: &str = "com.cellxplorer.desktop.beta";

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
        assert_eq!(
            AppChannel::Stable.autostart_registry_value(),
            "CellXplorer"
        );
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
}
