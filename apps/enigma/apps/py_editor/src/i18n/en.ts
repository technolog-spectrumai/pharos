export default {
  app: {
    name: "Python Editor",
    tagline: "Edit and run Python in a Compute Capsule.",
  },
  connect: {
    title: "Connect to a server",
    server: "Server address",
    serverHint: "The https address of your toto platform.",
    token: "API token",
    // The only place a person is told where the token comes from. Without it
    // the field is a dead end: nothing else on this screen says the token is
    // minted on the server rather than typed here.
    tokenHint: "Mint one on the server at Compute Capsules → API tokens, then "
      + "paste it here. It is shown once.",
    check: "Check server",
    connect: "Connect",
    forget: "Forget this token",
    // Deliberately not "sign out". The token stays valid until it is revoked
    // on the server — saying otherwise would be a lie in the direction that
    // matters.
    forgetHint: "Removes the token from this computer. It stays valid until "
      + "you revoke it on the server.",
    connectedAs: "Connected as {username}",
    viaToken: "using the token you called “{label}”",
    storedInKeyring: "Stored in your system keyring.",
    storedInMemory: "Kept in memory only — you will reconnect after a restart, "
      + "because no system keyring was available.",
    untrustedCert: "This server's certificate is not trusted. Check the "
      + "fingerprint below matches the one your administrator gave you.",
    accept: "I have checked it — accept",
  },
  workspaces: {
    title: "Workspaces",
    empty: "You have no Python workspaces on this server.",
    readOnly: "Read-only",
    open: "Open",
  },
  editor: {
    save: "Save",
    saved: "Saved",
    unsaved: "Unsaved changes",
    run: "Run",
    running: "Running…",
    noFile: "Open a file from the tree to start editing.",
  },
  console: {
    title: "Output",
    clear: "Clear",
    empty: "Run something to see its output here.",
    // One sentence, not a tooltip — it changes what a person can do.
    freshEachTime: "Each Run starts fresh — variables do not carry over.",
    exitCode: "exit {code}",
    files: "Produced: {names}",
    queued: "Queued — polling for the result.",
  },
  errors: {
    unreachable: "Could not reach that server.",
    badToken: "That token is not valid, or it has been revoked.",
    generic: "Something went wrong: {detail}",
  },
} as const;
