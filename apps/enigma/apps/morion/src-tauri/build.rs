fn main() {
  // The default window icon is baked in at compile time: tauri-codegen copies
  // icons/icon.png into OUT_DIR and cargo only watches that copy. Without this
  // line, regenerating the icons (scripts/make_icons.py) would leave an
  // incremental build showing the old one in the title bar and taskbar.
  println!("cargo:rerun-if-changed=icons");
  tauri_build::build()
}
