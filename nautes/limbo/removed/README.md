# limbo/removed — features that were DELETED, not parked

`limbo/frontend/` and `limbo/rust/` hold features that were taken out of the
build but kept restorable, each with a restore checklist. What is here is
different: these features were **deleted outright**, and these files are their
record — what existed, why it went, and the decisions that were expensive to
get right and should not be rediscovered from scratch.

Nothing here is expected to come back as-is. Kept because a deleted feature's
reasoning is the part git history makes hardest to find.

- **cloud.md** — the Cloud tab: the user's own toto/faros server for file
  storage, an HPKE-sealed invite mailbox, a username directory and location
  beacons. Deleted 2026-08-15 to make the app serverless; the app now talks to
  no application server at all.
- **rdv.md** — the cloud rendezvous half of the above: username → NodeId
  lookup and the sealed invite mailbox.
- **beacon.md** — server-published location shares (pins/zones/routes with a
  mandatory TTL) on the Maps tab. The map's own in-room location share, which
  needs no server, survived.
