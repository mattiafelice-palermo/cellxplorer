#!/usr/bin/env python3
"""Repair the one-shot migration script before executing it."""

from pathlib import Path

path = Path(__file__).with_name("apply_beta_release_polish.py")
text = path.read_text(encoding="utf-8")

bad = '''    replace_once(
        path,
        ''' + "'''    #[test]\n    fn beta_and_standard_pending_revisions_are_independent() {'''" + ''',
        ''' + "'''    #[test]\n    fn relaunch_parent_pid_parser_is_exact() {\n        assert_eq!(\n            parse_relaunch_parent_pid([\n                \"--hidden\".to_string(),\n                RELAUNCH_AFTER_PID_ARG.to_string(),\n                \"1234\".to_string(),\n            ])\n            .unwrap(),\n            Some(1234)\n        );\n        assert_eq!(parse_relaunch_parent_pid([\"--hidden\".to_string()]).unwrap(), None);\n        assert!(parse_relaunch_parent_pid([RELAUNCH_AFTER_PID_ARG.to_string()]).is_err());\n        assert!(parse_relaunch_parent_pid([\n            RELAUNCH_AFTER_PID_ARG.to_string(),\n            \"not-a-pid\".to_string(),\n        ])\n        .is_err());\n    }\n\n    #[test]\n    fn beta_and_standard_pending_revisions_are_independent() {'''" + ''',
    )
'''
if bad not in text:
    raise RuntimeError("obsolete main.rs test insertion was not found")
text = text.replace(bad, "", 1)

main_anchor = '''    replace_once(
        path,
        ''' + "'''fn main() {\n    let context = tauri::generate_context!();'''" + ''',
        ''' + "'''fn main() {\n    match run_relaunch_helper_if_requested() {\n        Ok(true) => return,\n        Ok(false) => {}\n        Err(error) => {\n            eprintln!(\"CellXplorer relaunch helper failed: {error}\");\n            return;\n        }\n    }\n\n    let context = tauri::generate_context!();'''" + ''',
    )
'''
replacement = main_anchor + '''    replace_once(
        path,
        "fn main() {",
        ''' + "'''#[cfg(test)]\nmod relaunch_tests {\n    use super::*;\n\n    #[test]\n    fn relaunch_parent_pid_parser_is_exact() {\n        assert_eq!(\n            parse_relaunch_parent_pid([\n                \"--hidden\".to_string(),\n                RELAUNCH_AFTER_PID_ARG.to_string(),\n                \"1234\".to_string(),\n            ])\n            .unwrap(),\n            Some(1234)\n        );\n        assert_eq!(parse_relaunch_parent_pid([\"--hidden\".to_string()]).unwrap(), None);\n        assert!(parse_relaunch_parent_pid([RELAUNCH_AFTER_PID_ARG.to_string()]).is_err());\n        assert!(parse_relaunch_parent_pid([\n            RELAUNCH_AFTER_PID_ARG.to_string(),\n            \"not-a-pid\".to_string(),\n        ])\n        .is_err());\n    }\n}\n\nfn main() {'''" + ''',
    )
'''
if main_anchor not in text:
    raise RuntimeError("main.rs helper insertion anchor was not found")
text = text.replace(main_anchor, replacement, 1)

# Use the full BETA word from 48 px upward; only tiny icon frames use B.
text = text.replace("if size >= 128:", "if size >= 48:", 1)
path.write_text(text, encoding="utf-8", newline="\n")
