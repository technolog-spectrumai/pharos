// Padova — the sealing surface, as an app sees it.
//
// The Rust half is `crates/padova`. This is the front end that talks to it:
// the six invoke wrappers, the passphrase prompt, and the Security tab.
//
// **Nothing here imports from an app.** The Security tab takes its workspace
// store as a prop, so three apps can hand it three stores; `lock.ts` takes
// plain paths. That is what makes this a package rather than a directory.
//
// Registration stays per app. Importing this does not put a command on an
// app's IPC surface — `generate_handler!` does, and it is per app. An app that
// wants only the padlock wires `probeSealed` and registers `is_file_locked`
// alone; an app that offers sealing registers all six.
export {
  LOCK_ERRORS,
  lockErrorKey,
  sealFile,
  unsealFile,
  rememberPassphrase,
  forgetPassphrase,
  passphraseStatus,
  probeSealed,
  type SealedInfo,
  type SecretStore,
  type SecretStatus,
} from "./lock";

export { default as LockModal } from "./components/LockModal.vue";
export { default as SecurityView } from "./components/SecurityView.vue";
export type { SecurityRow, SecurityWorkspace } from "./components/SecurityView.vue";
