// Padova's words, in English.
//
// The sealing surface owns its own catalogue: `lockErrors.test.ts` binds
// LOCK_ERRORS to these keys in BOTH locales, so the strings and the prefixes
// they answer to have to travel together or that test goes vacuous.
//
// An app merges this into its own catalogue under the same top-level names, so
// every `t("lock.*")` and `t("security.*")` in this package keeps working
// unchanged.
export default {
  lock: {
    lockTitle: "Encrypt this file",
    unlockTitle: "Decrypt this file permanently",
    openTitle: "Open encrypted file",
    openHint: "The file is decrypted in memory only. Saving writes it back encrypted; nothing unencrypted is written to disk.",
    unlockHint: "This rewrites the file as plain text on disk. To edit it without that, open it instead.",
    open: "Open",
    lockHint: "The password is never written into the file, and each file gets its own key. Everything needed to open this file again, except the password, travels inside it.",
    password: "Password",
    confirm: "Repeat the password",
    lock: "Encrypt",
    unlock: "Decrypt",
    remember: "Remember this passphrase, so I am not asked again",
    passwordRequired: "Enter the password.",
    passwordMismatch: "Those two do not match.",
    errors: {
      no_passphrase: "No password was given, and none is remembered.",
      wrong_password: "Wrong password, or the file is damaged. Nothing was changed.",
      already_locked: "That file is already encrypted.",
      not_locked: "That file is not encrypted.",
      too_large: "That file is too big to encrypt.",
      legacy_format: "This file was encrypted by the platform. Its key settings lived on the server, so it cannot be opened here.",
      crypto: "That encrypted file is damaged. Nothing was changed.",
      changed_on_disk: "That file changed on disk while it was open. Nothing was written; open it again.",
    },
  },
  security: {
    title: "Security",
    intro: "Everything on this page is a statement of fact about this build. Nothing here is a setting.",
    files: {
      title: "Encrypt a file",
      help: "Files in your workspace folder. Encrypting rewrites the file in place, and everything needed to open it again travels inside it — so an encrypted file opens on any machine that has your password. Close the file in an editor first: a tab still holding the old text can save it back over the encrypted one.",
      noWorkspace: "Choose a workspace folder to encrypt files in it.",
      empty: "Nothing here to encrypt.",
      sealed: "Encrypted",
      refresh: "Read the folder again",
    },
    secret: {
      held: "A passphrase is remembered, so files encrypt and decrypt without asking.",
      keychain: "Kept in the system keyring.",
      memory: "Kept until this app closes \u2014 no system keyring was available.",
      none: "No passphrase is remembered. You will be asked each time.",
      forget: "Forget it",
    },
  },
} as const;
