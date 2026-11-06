// Privacy HP — the bridge to Rust, plus the browser-mode mirror of the table.
//
// In the Tauri app every call here goes to `privacy_hp.rs`: the price table is
// fetched once at boot (like the build config), and the ledger lives in the
// encrypted profile store where JS cannot reach it. In a plain browser — the Vite
// dev server and vitest's jsdom — there is no binary and no vault, so the mirror
// below stands in and the ledger is held in memory for the session. That keeps
// the app explorable without the desktop runtime, and it is the mode every unit
// test runs in.
//
// THE MIRROR IS NOT A SECOND SOURCE OF TRUTH. `src-tauri/privacy_hp.yaml` is the
// only one. `tests/unit/privacyHpDrift.test.ts` parses that YAML and fails if a
// single number here disagrees with it, so the two cannot quietly drift — and in
// Tauri the fetched table overwrites this one outright.

import { isTauri, invoke } from "./tauri";
import {
  type HpBalances,
  type HpEntry,
  type HpPolicy,
  deriveBalances,
  findAction,
  findRecovery,
  priceOf,
} from "../privacyHp";

// ── the mirror (see privacy_hp.yaml for the rationale behind every number) ───

const A = (
  id: string,
  kind: "toggle" | "event" | "metered",
  costCenti: number,
  explainKey: string,
  extra: { perMibCenti?: number; perMinuteCenti?: number; capPerEventCenti?: number } = {},
) => ({
  id,
  kind,
  costCenti,
  perMibCenti: extra.perMibCenti ?? 0,
  perMinuteCenti: extra.perMinuteCenti ?? 0,
  capPerEventCenti: extra.capPerEventCenti ?? 0,
  explainKey,
});

const R = (id: string, creditCenti: number, requires: string | null, explainKey: string) => ({
  id,
  creditCenti,
  requires,
  explainKey,
});

export const FALLBACK_HP_POLICY: HpPolicy = {
  version: 1,
  confirmAtCenti: 500,
  dailyMaxCenti: 10_000,
  dailyRegenCenti: 100,
  dailyRegenPerMinutes: 15,
  dailyTorRegenPerMinutes: 5,
  historyDays: 7,
  recoveryDailyCapCenti: 1250,
  recoveryWindowCapCenti: 5000,
  dataPerMibCenti: 12,
  dataMinAwardCenti: 25,
  dataMaxPerEventCenti: 250,
  dataDailyCapCenti: 500,
  dataWindowCapCenti: 1250,
  actions: [
    // Per MINUTE while Tor runs with a stable address: ≈2.4 HP/hour. See privacy_hp.yaml.
    A("tor.stable.hold", "metered", 0, "hp.explain.torStableHold", { perMinuteCenti: 4, capPerEventCenti: 500 }),
    A("dht.nickname.publish", "toggle", 1000, "hp.explain.dhtNicknamePublish"),
    A("dht.presence.enable", "toggle", 500, "hp.explain.dhtPresenceEnable"),
    // Per MINUTE, not per event: ≈4.8 HP/hour while a room's onion stays up with a
    // never-expiring invitation outstanding. See privacy_hp.yaml.
    A("tor.persistent.hold", "metered", 0, "hp.explain.torPersistentHold", { perMinuteCenti: 8, capPerEventCenti: 500 }),
    A("room.create.clearnet", "event", 250, "hp.explain.roomCreateClearnet"),
    A("room.create.tor", "event", 50, "hp.explain.roomCreateTor"),
    A("room.join.clearnet", "event", 250, "hp.explain.roomJoinClearnet"),
    A("room.join.tor", "event", 50, "hp.explain.roomJoinTor"),
    A("invite.personal.create.clearnet", "event", 150, "hp.explain.invitePersonalCreateClearnet"),
    A("invite.personal.create.tor", "event", 50, "hp.explain.invitePersonalCreateTor"),
    A("invite.general.create.clearnet", "event", 500, "hp.explain.inviteGeneralCreateClearnet"),
    A("invite.general.create.tor", "event", 250, "hp.explain.inviteGeneralCreateTor"),
    A("msg.tor.mls", "metered", 0, "hp.explain.msgTorMls"),
    A("msg.clearnet.mls", "metered", 2, "hp.explain.msgClearnetMls", {
      perMibCenti: 2,
      capPerEventCenti: 50,
    }),
    A("msg.tor.plain", "metered", 5, "hp.explain.msgTorPlain"),
    A("msg.clearnet.plain", "metered", 25, "hp.explain.msgClearnetPlain", {
      perMibCenti: 25,
      capPerEventCenti: 250,
    }),
    A("calendar.share.tor", "metered", 0, "hp.explain.calendarShareTor"),
    A("calendar.share.clearnet", "metered", 2, "hp.explain.calendarShareClearnet", {
      perMibCenti: 2,
      capPerEventCenti: 50,
    }),
    A("file.send", "metered", 50, "hp.explain.fileSend", {
      perMibCenti: 2,
      capPerEventCenti: 250,
    }),
    A("vox.call", "metered", 150, "hp.explain.voxCall", {
      perMinuteCenti: 5,
      capPerEventCenti: 500,
    }),
    A("local.autolock.off", "toggle", 500, "hp.explain.localAutolockOff"),
    A("local.pin.enroll", "toggle", 150, "hp.explain.localPinEnroll"),
    A("local.panic_code.clear", "toggle", 150, "hp.explain.localPanicCodeClear"),
    A("local.lock_on_hide.off", "toggle", 50, "hp.explain.localLockOnHideOff"),
    A("local.file_integrity.off", "toggle", 50, "hp.explain.localFileIntegrityOff"),
  ],
  recoveries: [
    R("dht.nickname.withdraw", 500, "dht.nickname.publish", "hp.explain.dhtNicknameWithdraw"),
    R("dht.presence.withdraw", 250, "dht.presence.enable", "hp.explain.dhtPresenceWithdraw"),
    R("local.autolock.on", 250, "local.autolock.off", "hp.explain.localAutolockOn"),
    R("local.passphrase.strengthen", 500, null, "hp.explain.localPassphraseStrengthen"),
    R("local.passphrase.change", 150, null, "hp.explain.localPassphraseChange"),
    R("invite.revoke", 250, null, "hp.explain.inviteRevoke"),
    R("room.rekey", 150, null, "hp.explain.roomRekey"),
    R("room.leave", 150, null, "hp.explain.roomLeave"),
  ],
  dataSources: [
    { id: "data.delete.chat", explainKey: "hp.explain.dataDeleteChat" },
    { id: "data.delete.files", explainKey: "hp.explain.dataDeleteFiles" },
  ],
};

// ── boot ────────────────────────────────────────────────────────────────────

let policy: HpPolicy = FALLBACK_HP_POLICY;

/** Fetch the compile-time table once at boot (await before mounting, beside
 *  `initBuildConfig`). In Tauri the binary's table always wins. */
export async function initHpPolicy(): Promise<HpPolicy> {
  if (isTauri()) {
    try {
      const fetched = await invoke<HpPolicy>("hp_get_policy");
      // A table without actions is not a table; keep the mirror rather than
      // render an app whose every price silently reads zero.
      if (fetched && Array.isArray(fetched.actions) && fetched.actions.length > 0) {
        policy = fetched;
      }
    } catch {
      /* keep the mirror — browser-equivalent behaviour */
    }
  }
  return policy;
}

/** The table as fetched at boot. Never null: the mirror stands in until then. */
export function getHpPolicy(): HpPolicy {
  return policy;
}

/** Test seam — lets a unit test install a small synthetic table. */
export function setHpPolicyForTest(next: HpPolicy): void {
  policy = next;
}

// ── browser-mode ledger (memory only; the desktop app uses the vault) ───────

let browserLedger: HpEntry[] = [];
let browserHiTs = 0;

function browserStamp(): number {
  const ts = Math.max(Date.now(), browserHiTs + 1);
  browserHiTs = ts;
  return ts;
}

/** Drop the in-memory ledger. Used by tests and by a browser-mode profile reset. */
export function resetHpLedgerForTest(): void {
  browserLedger = [];
  browserHiTs = 0;
}

// ── reads ───────────────────────────────────────────────────────────────────

export async function hpLedger(): Promise<HpEntry[]> {
  if (isTauri()) {
    try {
      // Same defensive read as `asDelta`: a command that answers with nothing
      // must degrade to "no history", not to a crash in every meter.
      const rows = await invoke<HpEntry[]>("hp_ledger");
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }
  return [...browserLedger];
}

/** Both meters right now. `now` is injectable so tests need no fake timers. */
export async function hpBalances(now = Date.now()): Promise<HpBalances> {
  return deriveBalances(policy, await hpLedger(), now);
}

// ── writes ──────────────────────────────────────────────────────────────────

export interface HpDelta {
  /** Centi-HP actually applied. 0 means the call was a no-op. */
  applied: number;
  code: string;
}

/**
 * Coerce whatever came back from `invoke` into a usable delta.
 *
 * A command can legitimately answer with nothing — an older binary that predates
 * these commands, a build where they are not registered, a transport hiccup. The
 * callers of these functions are ordinary UI paths (send a file, flip a switch),
 * and none of them should break because the HP layer had nothing to say. An
 * unusable answer becomes a no-op delta, exactly like a charge that was declined.
 */
function asDelta(raw: unknown, code: string): HpDelta {
  const d = raw as Partial<HpDelta> | null | undefined;
  return {
    applied: typeof d?.applied === "number" && Number.isFinite(d.applied) ? d.applied : 0,
    code: typeof d?.code === "string" && d.code ? d.code : code,
  };
}

/**
 * Charge an action. The caller names an id and, for metered actions, the
 * quantity — never an amount. Rust looks the price up in its own table, so a
 * wrong id is the worst a broken caller can manage.
 *
 * A no-op returns `applied: 0` rather than throwing: re-affirming a live toggle
 * and sending on the free Tor lane are both ordinary, and neither should flash a
 * "−0 HP" at the user.
 */
export async function hpCharge(
  actionId: string,
  opts: { bytes?: number; minutes?: number } = {},
): Promise<HpDelta> {
  if (isTauri()) {
    try {
      return asDelta(
        await invoke<HpDelta>("hp_charge", {
          actionId,
          bytes: opts.bytes ?? null,
          minutes: opts.minutes ?? null,
        }),
        actionId,
      );
    } catch {
      return { applied: 0, code: actionId };
    }
  }

  const action = findAction(policy, actionId);
  if (!action) return { applied: 0, code: actionId };
  if (action.kind === "toggle" && browserExposureLive(actionId)) {
    return { applied: 0, code: actionId };
  }
  const cost =
    action.kind === "metered" ? priceOf(action, opts.bytes ?? 0, opts.minutes ?? 0) : action.costCenti;
  if (cost <= 0) return { applied: 0, code: actionId };

  const ts = browserStamp();
  const bucket = action.kind === "metered" ? Math.floor(ts / 3_600_000) : 0;
  const open =
    bucket !== 0
      ? browserLedger.find((e) => e.bucket === bucket && e.code === actionId && e.kind === "spend")
      : undefined;
  if (open) {
    open.hp -= cost;
    open.n += 1;
  } else {
    browserLedger.push({ ts, kind: "spend", code: actionId, hp: -cost, n: 1, bucket });
  }
  return { applied: -cost, code: actionId };
}

function browserExposureLive(actionId: string): boolean {
  let chargedAt: number | null = null;
  for (const e of browserLedger) {
    if (e.kind === "spend" && e.code === actionId && (chargedAt === null || e.ts > chargedAt)) {
      chargedAt = e.ts;
    }
  }
  if (chargedAt === null) return false;
  const at = chargedAt;
  return !browserLedger.some(
    (e) => e.kind === "recover" && e.ts >= at && findRecovery(policy, e.code)?.requires === actionId,
  );
}

/**
 * Record the transport posture. A zero-HP ledger row, not a charge.
 *
 * Idempotent — re-asserting the posture already recorded writes nothing, so it
 * is safe to call at every boot, which is also what re-establishes the marker
 * after old rows are pruned.
 */
export async function hpSetTorPosture(on: boolean): Promise<boolean> {
  if (isTauri()) {
    try {
      return await invoke<boolean>("hp_set_tor_posture", { on });
    } catch {
      return false;
    }
  }
  const code = on ? "transport.tor.on" : "transport.tor.off";
  const last = [...browserLedger].filter((e) => e.kind === "posture").sort((a, b) => a.ts - b.ts).pop();
  if ((last?.code ?? "transport.tor.off") === code) return false;
  browserLedger.push({ ts: browserStamp(), kind: "posture", code, hp: 0, n: 1, bucket: 0 });
  return true;
}

/** What one tick of the hourly charges did: standing Tor rooms and the stable
 *  address (privacy_hp.rs, `hp_tor_tick`). */
export interface HpTorExposure {
  /** Centi-HP this tick charged, ≤ 0. */
  chargedCenti: number;
  /** Rooms accruing `tor.persistent.hold`. */
  rooms: string[];
  /** Centi-HP per hour all of it costs while it lasts. */
  drainPerHourCenti: number;
  /** Whether the stable address is accruing `tor.stable.hold`. */
  stable: boolean;
}

const NO_EXPOSURE: HpTorExposure = { chargedCenti: 0, rooms: [], drainPerHourCenti: 0, stable: false };

/** Bill the hourly charges for the time since the last tick. Rust decides what is
 *  exposed; the window only asks. Outside Tauri nothing is hosted, so nothing accrues. */
export async function hpTorTick(): Promise<HpTorExposure> {
  if (!isTauri()) return NO_EXPOSURE;
  try {
    return await invoke<HpTorExposure>("hp_tor_tick");
  } catch {
    return NO_EXPOSURE;
  }
}

/** The day's budget ran out: revoke these rooms' standing invitations, which is
 *  what stops their accrual (§17.4). Returns how many were revoked. */
export async function hpTorShutdown(rooms: string[]): Promise<number> {
  if (!isTauri() || rooms.length === 0) return 0;
  try {
    return await invoke<number>("hp_tor_shutdown", { rooms });
  } catch {
    return 0;
  }
}

/** Award a fixed recovery. Rust verifies the paired exposure is live and applies
 *  the caps; a credit that is not owed comes back as `applied: 0`. */
export async function hpRecover(recoveryId: string): Promise<HpDelta> {
  if (isTauri()) {
    try {
      return asDelta(await invoke<HpDelta>("hp_recover", { recoveryId }), recoveryId);
    } catch {
      return { applied: 0, code: recoveryId };
    }
  }
  const rec = findRecovery(policy, recoveryId);
  if (!rec) return { applied: 0, code: recoveryId };
  if (rec.requires && !browserExposureLive(rec.requires)) {
    return { applied: 0, code: recoveryId };
  }
  const ts = browserStamp();
  browserLedger.push({ ts, kind: "recover", code: recoveryId, hp: rec.creditCenti, n: 1, bucket: 0 });
  return { applied: rec.creditCenti, code: recoveryId };
}

/**
 * Award for data actually deleted.
 *
 * `bytesFreed` is only a hint here: in Tauri the Rust side measures what it
 * removed and ignores anything the webview claims, which is what ties the credit
 * to a verified reduction rather than an assertion.
 */
export async function hpDataCredit(sourceId: string, bytesFreed: number): Promise<HpDelta> {
  if (isTauri()) {
    try {
      return asDelta(await invoke<HpDelta>("hp_data_credit", { sourceId, bytesFreed }), sourceId);
    } catch {
      return { applied: 0, code: sourceId };
    }
  }
  if (bytesFreed <= 0) return { applied: 0, code: sourceId };
  const raw = Math.floor((bytesFreed * policy.dataPerMibCenti) / (1024 * 1024));
  const award = Math.min(
    policy.dataMaxPerEventCenti,
    Math.max(policy.dataMinAwardCenti, raw),
  );
  const ts = browserStamp();
  browserLedger.push({ ts, kind: "recover", code: sourceId, hp: award, n: 1, bucket: 0 });
  return { applied: award, code: sourceId };
}
