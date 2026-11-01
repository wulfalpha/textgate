use std::process::Command;

// Help, version and argument errors must work without initializing a GUI or
// claiming the single-instance lock (also safe to run on headless CI runners).
fn cli(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_textgate"))
        .args(args)
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY")
        .output()
        .unwrap()
}

#[test]
fn help_and_version_work_without_a_display() {
    let help = cli(&["--help"]);
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout).contains("Usage: textgate"));
    let version = cli(&["--version"]);
    assert!(version.status.success());
    assert_eq!(
        String::from_utf8_lossy(&version.stdout).trim(),
        format!("Textgate {}", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn bad_arguments_exit_without_starting_the_app() {
    for args in [&["--unknown"][..], &["a.md", "b.md"], &["--"]] {
        let output = cli(args);
        assert_eq!(output.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&output.stderr).contains("Textgate:"));
    }
}
