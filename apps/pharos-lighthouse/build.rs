fn main() {
    // Fluent follows the system's light/dark scheme; our own Theme global does the rest.
    let cfg = slint_build::CompilerConfiguration::new().with_style("fluent".into());
    slint_build::compile_with_config("ui/app.slint", cfg).expect("compile ui/app.slint");
}
