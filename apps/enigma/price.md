# Enigma pricing — module valuation and edition plans

> **⚠ OPEN PRODUCT DECISION (2026-08-18):** the Light / Plus / Pro editions
> this document prices were replaced by **Basic / Standard / Professional**
> (pland.md §1) — different names AND different compositions: contacts,
> calendar and PIN unlock moved into the entry edition, and the entry edition
> dropped hosted relays. On the same day **multi-device + file sync and peer
> sync were parked**, so two of the modules priced below no longer ship in any
> edition (§3, §6, §9.5), and the Builder stopped being able to produce an
> arbitrary feature combination at all (§6, §9.6). Every tier table below
> therefore prices a product line that no longer exists. Re-cutting the tiers
> (what does Basic cost when it includes the organiser features and no device
> sync?) is a pricing decision, not a documentation one, and has deliberately
> not been made here — which is why the tables keep the old tier names: those
> numbers were set for those compositions.

> **⚠ ALSO STALE (2026-10-03):** the **Enigma Builder** this document counts as
> an asset (§4) and leans on for custom builds (§6, §9) was removed. A build is
> now configured by `build.yaml` and built by `./build.sh` — tooling that lives
> in the Rutile base repo, shared with Morion — and the Android signing checks
> the Builder carried are `rutile/scripts/android_signing`. The Builder's
> valuation and every "the Builder does X" below describe code that no longer
> exists; like the tier tables, they are left as written because re-valuing is
> a decision, not an edit.

What each module of the codebase is worth, what Light / Plus / Pro should cost,
and a lifetime licence proposal.

Two different questions live in this document and they must not be blurred:

1. **What each module cost to build** (§3–§4) — a replacement-cost valuation.
   It sets a *floor* and tells you what a competitor would have to spend. It is
   not a price.
2. **What to charge** (§5–§7) — market pricing, anchored on what comparable
   products sell for and on what Enigma's architecture makes enforceable.

**Related:** [pland.md](pland.md) (what is in each edition and why) ·
[build.md](build.md) (how an edition is built) ·
`tools/enigma_builder/README.md` (removed) (the tool that
configures and builds a product).

---

## 1. The architecture decides the commercial model

From [pland.md](pland.md), first paragraph:

> Every edition is the same binary source built with a different compile-time
> build config; there is **no runtime licence check, no server-side
> entitlement**, and no dormant code path waiting for an unlock.

That is a product virtue and a commercial constraint at the same time, and it
rules out most of the pricing playbook:

- **A subscription cannot be enforced.** There is no server to revoke access
  against, and no phone-home. A monthly plan would be an honour system.
- **Feature upsell inside the app is impossible.** A Basic binary does not
  contain the Professional features to unlock — that is the entire point of
  gating at build time.
- **What is actually sold is a build**, plus the right to future builds.

So the honest model is a **one-time purchase of an edition, and paid major
upgrades** — with a **lifetime licence** as the premium option (§7). This is not
a workaround. For a serverless product a lifetime licence is unusually credible:
there is no server to switch off, so "lifetime" means what it says, and the only
cost of honouring it is building the next version.

The recurring revenue has to come from somewhere else: organisation seats,
support and update contracts, custom builds, and audit/deployment services (§8).

---

## 2. How the numbers were produced

Every figure below traces to measured source lines in this repo, attributed
file-by-file to a module (script kept out of the repo; the attribution is listed
in §3 so it can be re-run or argued with). Lines are converted to effort, effort
to money:

| Assumption | Value | Why |
|---|---|---|
| Systems band | **40 LOC/engineer-day** | crypto, MLS, P2P transport, Tor, protocol state machines — review-heavy, test-heavy, mistakes are CVEs |
| Application band | **70 LOC/engineer-day** | Vue components, views, Pinia stores, desktop tooling |
| Test band | **100 LOC/engineer-day** | Vitest/Playwright suites |
| Day rate | **$750/day** | blended senior contractor, EU mid-market, 8h day |

**Read this correctly:** the model prices *replacement at conventional
velocity* — what it would cost someone to build this from scratch today. It is
deliberately not a timesheet of how this repo actually came to exist. For
valuation, licensing floors and "what would it cost you to build instead", the
replacement basis is the right one.

Day-rate sensitivity on the full 774-day estimate (§3, after the 2026-08 cloud
deletion and the 2026-08-18 park):

| Rate | Basis | Total build cost |
|---|---|---|
| $400/day | CEE contractor | **$309,600** |
| $750/day | blended EU senior *(used below)* | **$580,500** |
| $1,200/day | US/UK senior security engineer | **$928,800** |

---

## 3. Module valuation

Line counts are real, measured across `src-tauri/src`, `apps/enigma/src`,
`packages/rakotis/src`, the vendored crates, the test suites and
`tools/map_packager`. "sys" is the systems band, "app" the application band.

| Module | sys | app | test | LOC | Days | Build cost |
|---|---:|---:|---:|---:|---:|---:|
| **Core platform** | 11,731 | 10,874 | 4,602 | 27,207 | 495 | **$371,000** |
| Maps | 1,426 | 4,670 | 1,210 | 7,306 | 114 | **$85,800** |
| Calendar | 0 | 2,320 | 1,540 | 3,860 | 49 | **$36,400** |
| Vox (1:1 voice calls) | 1,271 | 818 | 302 | 2,391 | 46 | **$34,900** |
| Contacts + presence | 664 | 1,274 | 755 | 2,693 | 42 | **$31,800** |
| DHT discovery | 901 | 0 | 548 | 1,449 | 28 | **$21,000** |
| **Total** | **15,993** | **19,956** | **8,957** | **44,906** | **774** | **$580,900** |

**Two rows left this table on 2026-08-18.** Multi-device + file sync
(3,163 sys / 1,228 app / 1,843 test = 6,234 LOC, 115 days, **$86,300**) and peer
sync (1,754 / 1,564 / 1,134 = 4,452 LOC, 78 days, **$58,200**) were **parked** —
frontend to `limbo/frontend/{devices,peers}/`, Rust to
`limbo/rust/{devices,peers}/` (pland.md §2). The code still exists, so unlike
Cloud it is not written off; it moves to the parked pile in §9.5, on the same
rule that keeps Kanban/Sketch/Mind out of a table of what ships. Together they
take $144,500 and 193 days out of the basis, which is why the total is $580,900
where this document said $725,400 in July.

**Enigma Cloud was a further row here** — 2,150 sys / 2,463 app / 1,183 test =
5,796 LOC, 101 days, **$75,600** — until the feature was deleted in 2026-08
(technology.md §16). The row is gone rather than parked: unlike Kanban/Sketch/Mind
(§9.5) there is no `limbo/` copy to price back in later. Its numbers are simply
subtracted above.

**Caveat on the residual.** The deletion also removed code this table counts under
*other* modules — `tor.rs` and `invite_seal.rs`, the cloud halves of
`appStorage.ts`, both i18n catalogues and several views (Core platform, ≈1,650
lines), the beacon layer in `MapPanel` (Maps, ≈550) and the server-search UI
(Contacts, ≈150). Those rows have **not** been re-measured, so they over-count by
roughly 2,350 lines — on the order of **$30,000**, about two-thirds of it in Core
platform and therefore inflating Light and Plus, the rest inflating Pro-only
modules. Re-run the attribution before quoting §4 as a floor.

What sits in each module:

- **Core platform** — MLS chat and the whole transport stack (`p2p_iroh`,
  `p2p_tor`, `p2p_invite`, `realtime`, `file_xfer`), the
  encrypted-at-rest vault and panic code (`vault`, `protasius`), per-file
  locking (`local_lock`), the vendored crypto crates (`rotor_core`,
  `gervasius`), the chat/files/profile/settings UI, the notes and SVG editors,
  `useChatChannel` + `appStorage` in rakotis, and both i18n catalogues.
- **Maps** — `maps.rs`, the map UI and share layer (the in-room location share
  over MLS; the server-side beacon layer went with Cloud), plus the standalone
  `tools/map_packager` region packager, which is a product in its own right.
- **Calendar** — meetings and scheduling polls. Pure application code, but
  heavily tested (1,540 test lines against 2,320 of implementation).
- **Vox** — 1:1 voice over the room's MLS group, incl. the audio pipeline.
- **Contacts + presence** — the nickname directory search, direct room invites,
  and DHT presence.
- **DHT discovery** — the smallest module and the one with the most leverage:
  it is what makes ticketless room codes and the nickname directory possible.

**Not sold as modules, but real assets:** the Enigma Builder
(`tools/enigma_builder`, ~4,800 lines with `build.rs`, ≈ **$51,000** at the same
model) and ~3,900 lines of architecture and decision documentation. The Builder
matters commercially — see §6.

---

## 4. Build cost per edition

| Edition | Modules | LOC | Build cost |
|---|---|---:|---:|
| **Light** | Core platform | 27,207 | **$371,000** |
| **Plus** | Light + Vox | 29,598 | **$406,000** |
| **Pro** | everything | 44,906 | **$580,900** |

Note the shape: **Light is 61% of the code but carries 100% of the hard parts.**
Everything a buyer is actually paying for in the security story — MLS, the Tor
transport, the vault, panic code, at-rest crypto — is in the edition with the
lowest price. Pro is where the *breadth* is, not where the *difficulty* is.
That has a direct pricing consequence: Light must not be priced as a toy, or
you are giving away the expensive half.

---

## 5. Edition pricing

Perpetual licence for one major version, per user, incl. all patch and minor
updates to that version. Prices in USD, net of VAT.

### Individual

| | Light | Plus | Pro |
|---|---:|---:|---:|
| **Perpetual (one major version)** | **$29** | **$49** | **$129** |
| Upgrade to next major | $15 | $25 | $59 |
| Lifetime (§7) | $79 | $129 | **$299** |

### Organisation — Pro, per seat, perpetual

| Seats | Per seat | Lifetime per seat |
|---|---:|---:|
| 1–9 | $199 | $449 |
| 10–49 | $159 | $359 |
| 50–199 | $119 | $269 |
| 200+ | $89 | $199 |
| Site licence (one legal entity, unlimited seats) | $29,000 | $69,000 |

**Where these land against the market.** Threema sells at €5.99 one-off but is a
mass-market messenger with a company behind the directory; Signal is free and
donation-funded; Wire and Element sit at $5–9/user/month but are *hosted*
products where the price buys infrastructure Enigma's users run themselves;
purpose-built secure-comms suites for government and NGO buyers run to hundreds
or thousands per seat. Enigma Pro is not a messenger — it is a serverless
collaboration suite with offline maps, a room calendar and voice calls, sold to
people who deliberately want no vendor in the path. Since 2026-08 it does not
talk to any server, the user's own included, which sharpens rather than weakens
that pitch. A
one-off $129 individual / $199-per-seat org price undercuts every hosted
alternative within roughly 18 months of use, which is the argument to lead with.

**Why Light is $29, not $5.** The $5 tier invites comparison with Threema, which
Enigma loses on polish and wins on architecture — a bad trade. At $29 the
comparison is with a professional tool, and §4 shows the price is justified by
what is actually in the binary.

---

## 6. Per-module add-on pricing

> **This section has lost its mechanism (2026-08-18).** It was written when the
> Enigma Builder (removed) could compile any combination
> of gates from a checkbox screen, which is what made per-module SKUs cheap
> enough to sell. The Builder now deliberately has **no custom feature set**: its
> Features tab is an edition picker, and a config whose gates match no edition is
> refused at save, at load and at build. À-la-carte would first need that
> refusal lifted — a product decision, not a build step (§9.6). Two of the
> modules priced here are parked besides. The prices are kept because the
> per-module *ratios* are still the useful part of the analysis.

Add-ons on top of Light, perpetual, individual:

| Module | Add-on price | Build cost | Sales to recover it |
|---|---:|---:|---:|
| Vox (voice calls) | $15 | $34,900 | 2,320 |
| DHT discovery | $15 | $21,000 | 1,400 |
| Contacts + presence | $20 | $31,800 | 1,590 |
| Calendar | $20 | $36,400 | 1,820 |
| Maps | $35 | $85,800 | 2,450 |
| **Light + all five** | **$105** | | |
| **Pro bundle** | **$129** | | **+23%** |

Three modules have left this table: Enigma Cloud at $30 (deleted, 2026-08), peer
sync at $25 and multi-device + file sync at $35 (both parked, 2026-08-18). That
is $90 off the à-la-carte ceiling, and it **inverts the argument this section was
built on**: buying every remaining module separately now costs $105, so the $129
bundle is a 23% *premium* rather than the 34% discount that made Pro look
correctly priced. Whether the answer is a cheaper bundle, a repriced add-on set
or no à-la-carte at all is a pricing decision, not a documentation one — §9.6.

The right-hand column is the check on whether these prices are proportionate:
every module recovers its own build cost within a 1,400–2,500 sale band, so no
module is quietly subsidising another. That much is unchanged.

À-la-carte was always meant to serve the buyer who genuinely wants a minimal
binary (the high-risk user in pland.md's entry-edition pitch, who wants maps but
not a directory), never to be the default path — every extra SKU is another build
to produce, sign and support. If it comes back, the same rule applies:
organisation deals and paid custom builds (§8), not the consumer storefront.

---

## 7. Lifetime licence — the proposal

**Enigma Pro Lifetime — $299 individual, $449/seat organisation (1–9 seats).**

### What it grants

Every future major version of the purchased edition, for the life of the
product, for one named user. Delivered as signed builds plus the reproducible
build inputs, so the licence survives the vendor: if Enigma stops shipping, the
holder still has a working binary and the config that produced it.

### Why 3× the perpetual price

Priced off the upgrade path it replaces. On an ~18-month major-version cadence
and a 50%-of-base upgrade fee, a user who stays six years pays
`$129 + 3 × $59 = $306` — so **$299 is a small discount for paying up front**,
not a giveaway. It is defensible in public, which matters for this audience.

| Horizon | Pay-as-you-go (Pro) | Lifetime |
|---|---:|---:|
| Launch | $129 | $299 |
| +18 months | $188 | $299 |
| +3 years | $247 | $299 |
| **+4.5 years** | **$306** | **$299** ← crossover |
| +6 years | $365 | $299 |

### Why it is a good deal for the vendor too

- **Cash now**, which is what an unfunded product needs, from the users most
  likely to advocate for it.
- **No carried cost.** A lifetime user of a serverless app consumes no
  infrastructure. The marginal cost of honouring the licence forever is one
  extra download.
- **It matches what is enforceable anyway.** Given §1, a determined user already
  effectively has a perpetual licence. Charging honestly for that turns an
  unenforceable weakness into a headline feature.

### Guard rails

- Cap the launch cohort — **250 seats at $249 as a founding price**, then $299.
  Scarcity does the work a discount would otherwise have to.
- Lifetime is **per named user, non-transferable**; org lifetime is per seat and
  transferable within the entity (people leave).
- Define "lifetime" in writing as *the life of the Enigma product line*, and
  state what happens on discontinuation: final build plus build config released
  to holders. Ambiguity here is where lifetime deals go wrong.
- **Do not sell a lifetime site licence below $69,000.** One cheap unlimited
  entity licence can erase a year of seat revenue.

---

## 8. Break-even and the revenue that is not licences

Against the $580,900 replacement-cost basis at $750/day (§3 — the basis fell
with the cloud deletion and the 2026-08-18 park, so every count below is lower
than it was in July for reasons that have nothing to do with the prices):

| Product | Price | Units to cover build cost |
|---|---:|---:|
| Pro individual, perpetual | $129 | 4,505 |
| Pro individual, lifetime | $299 | 1,945 |
| Pro org seat (1–9) | $199 | 2,920 |
| Pro org seat, lifetime (1–9) | $449 | 1,295 |
| Site licence | $29,000 | 20 |
| Site licence, lifetime | $69,000 | 8 |

Eight lifetime site licences covering the entire build is the number worth
remembering: **the org channel is the business, and the consumer storefront is
the credibility that feeds it.**

Non-licence revenue, all of which fits the architecture rather than fighting it:

| Line | Suggested price |
|---|---|
| Custom build (edition, branding, release signing — from a product config) | $2,500 setup + $500/rebuild |
| Deployment + key-management workshop (org onboarding) | $4,000/engagement |
| Priority support + guaranteed rebuilds, annual | 18% of licence value/year |
| Third-party security audit, sponsored and published | cost + 15% |
| Map region packaging for a customer's territories | $1,500/region set |

The custom-build line is only profitable because the Builder exists; each one is
now minutes of work plus signing, against a day of careful YAML editing before —
and Android release signing is part of the product rather than a customer's
problem: the Builder resolves the keystore from `gen/android/keystore.properties`,
env vars or `~/.config/enigma-builder/signing.properties`, refuses the SDK debug
key for a release, and can pin the release fingerprint so a swapped keystore
fails the build. Note what a "custom build" is not: the app name, bundle id and
icon are fixed (pland.md §3, icons.md), and the feature set is one of the three
editions — what varies per customer is the branding directory, the edition and
the signing identity.

---

## 9. Open questions before publishing a price list

1. **VAT/GST.** These are net prices. EU B2C must display VAT-inclusive; a
   merchant of record (Paddle, Lemon Squeezy) handles this and takes ~5%, which
   should be added to the price rather than absorbed.
2. **What does the free tier look like?** Currently there is none. A
   time-unlimited Light demo with no persistence, or a 30-day full Pro build,
   both work — but a serverless app cannot enforce a trial expiry any more than
   it can enforce a subscription. A watermarked demo build is the practical
   option.
3. **Is Light free?** A defensible alternative to §5: give Light away to make
   the security story ubiquitous and price only Plus and Pro. That forfeits
   ~$371,000 of build value as a marketing spend — a real strategy, but it
   should be a decision, not a drift.
4. **Does Pro's price move now that Enigma Cloud is gone?** *(2026-08, open —
   this is a product decision, not a documentation one.)* Pro lost a module worth
   $75,600 of build cost, ~9% of the basis, and is still listed at $129
   individual / $199 per seat. Three defensible answers: **hold the price** (the
   §8 break-even actually *improves* — fewer units cover a smaller basis, and the
   remaining modules are the ones buyers cite), **cut it** to keep the
   per-module ratio honest against the à-la-carte ceiling — the ~$115 figure
   suggested here was anchored on a $194 ceiling that has since fallen to $105,
   so the same reasoning now implies a deeper cut (§6, and question 6 below), or
   **hold it and say why** — the cloud client was the one feature that put a
   server in the path, and removing it is arguably worth more to this buyer than
   it cost. The document assumes *hold* until someone decides otherwise. Two
   sentences elsewhere depend on the answer: §5's market paragraph and §6's
   bundle-discount line.
5. **Parked features.** Kanban (1,769 lines), the Mind map (4,594) and the
   collaborative Sketch board (2,433 + 396) sit in `limbo/` — about 9,200 lines,
   **≈ $98,000** of build cost already spent and currently earning nothing.
   Multi-device + file sync (6,234 lines, **$86,300**) and peer sync (4,452,
   **$58,200**) joined them on 2026-08-18, taking the parked pile to ~19,900
   lines and **≈ $242,500** — a third as much as everything that does ship.
   None of it is priced here because none of it ships. If a shipping edition
   regains a feature, that justifies a price rise rather than being absorbed
   silently. Device linking is the exception to even that: it is being
   reimplemented rather than restored, so its $86,300 is a record of what was
   spent, not a shelf-ready asset to price back in.
6. **Is à-la-carte still a product at all?** *(2026-08-18, open — a product
   decision.)* §6's per-module SKUs assumed a Builder that could compile any
   combination of gates. It refuses to, by design: the Features tab is an
   edition picker and a non-edition gate set is rejected at save, at load and at
   build. With Cloud, peer sync and multi-device also gone from the module list,
   the à-la-carte ceiling on top of Light is $105 against a $129 bundle — the
   discount that justified the bundle is now a premium. Three defensible
   answers: **retire à-la-carte** (the Builder already assumes it is gone, and
   every SKU is a build to produce, sign and support), **reprice the bundle**
   against the five remaining modules, or **re-open custom gate sets** in the
   Builder and accept the combinatorial support load that the edition picker was
   introduced to remove. Nothing here should be decided by a documentation edit.
7. **Source availability.** The pitch is "auditable". Auditable by whom, under
   what licence? A source-available licence with a paid commercial grant
   (BSL-style) fits this product better than a closed binary, and changes §5
   materially.
