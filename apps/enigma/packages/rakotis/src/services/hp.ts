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
  confirmAtCenti: 1000,
  dailyMaxCenti: 10_000,
  dailyRegenCenti: 100,
  dailyRegenPerMinutes: 15,
  weeklyMaxCenti: 70_000,
  weeklyRegenCenti: 100,
  weeklyRegenPerMinutes: 60,
  weeklyWindowDays: 7,
  recoveryDailyCapCenti: 2500,
  recoveryWeeklyCapCenti: 10_000,
  dataPerMibCenti: 25,
  dataMinAwardCenti: 50,
  dataMaxPerEventCenti: 500,
  dataDailyCapCenti: 1000,
  dataWeeklyCapCenti: 2500,
  actions: [
    A("transport.tor.disable", "toggle", 2000, "hp.explain.transportTorDisable"),
    A("transport.onion_stable.enable", "toggle", 300, "hp.explain.transportOnionStableEnable"),
    A("dht.nickname.publish", "toggle", 2000, "hp.explain.dhtNicknamePublish"),
    A("dht.presence.enable", "toggle", 1000, "hp.explain.dhtPresenceEnable"),
    A("dht.room_code.publish", "event", 500, "hp.explain.dhtRoomCodePublish"),
    A("ticket.export.clearnet", "event", 1000, "hp.explain.ticketExportClearnet"),
    A("ticket.export.tor", "event", 300, "hp.explain.ticketExportTor"),
    A("room.create.clearnet", "event", 500, "hp.explain.roomCreateClearnet"),
    A("room.create.tor", "event", 100, "hp.explain.roomCreateTor"),
    A("room.join.clearnet", "event", 500, "hp.explain.roomJoinClearnet"),
    A("room.join.tor", "event", 100, "hp.explain.roomJoinTor"),
    A("msg.tor.mls", "metered", 0, "hp.explain.msgTorMls"),
    A("msg.clearnet.mls", "metered", 5, "hp.explain.msgClearnetMls", {
      perMibCenti: 5,
      capPerEventCenti: 100,
    }),
    A("msg.tor.plain", "metered", 10, "hp.explain.msgTorPlain"),
    A("msg.clearnet.plain", "metered", 50, "hp.explain.msgClearnetPlain", {
      perMibCenti: 50,
      capPerEventCenti: 500,
    }),
    A("file.send", "metered", 100, "hp.explain.fileSend", {
      perMibCenti: 5,
      capPerEventCenti: 500,
    }),
    A("vox.call", "metered", 300, "hp.explain.voxCall", {
      perMinuteCenti: 10,
      capPerEventCenti: 1000,
    }),
    A("local.autolock.off", "toggle", 1000, "hp.explain.localAutolockOff"),
    A("local.pin.enroll", "toggle", 300, "hp.explain.localPinEnroll"),
    A("local.panic_code.clear", "toggle", 300, "hp.explain.localPanicCodeClear"),
    A("local.lock_on_hide.off", "toggle", 100, "hp.explain.localLockOnHideOff"),
    A("local.file_integrity.off", "toggle", 100, "hp.explain.localFileIntegrityOff"),
  ],
  recoveries: [
    R("transport.tor.enable", 1000, "transport.tor.disable", "hp.explain.transportTorEnable"),
    R("dht.nickname.withdraw", 1000, "dht.nickname.publish", "hp.explain.dhtNicknameWithdraw"),
    R("dht.presence.withdraw", 500, "dht.presence.enable", "hp.explain.dhtPresenceWithdraw"),
    R("local.autolock.on", 500, "local.autolock.off", "hp.explain.localAutolockOn"),
    R("local.passphrase.strengthen", 1000, null, "hp.explain.localPassphraseStrengthen"),
    R("local.passphrase.change", 300, null, "hp.explain.localPassphraseChange"),
    R("local.reencrypt.keyring", 1000, null, "hp.explain.localReencryptKeyring"),
    R("local.reencrypt.files", 1000, null, "hp.explain.localReencryptFiles"),
    R("room.rekey", 300, null, "hp.explain.roomRekey"),
    R("room.leave", 300, null, "hp.explain.roomLeave"),
  ],
  dataSources: [
    { id: "data.delete.chat", explainKey: "hp.explain.dataDeleteChat" },
    { id: "data.delete.maps", explainKey: "hp.explain.dataDeleteMaps" },
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
      policy = await invoke<HpPolicy>("hp_get_policy");
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
      return await invoke<HpEntry[]>("hp_ledger");
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
      return await invoke<HpDelta>("hp_charge", {
        actionId,
        bytes: opts.bytes ?? null,
        minutes: opts.minutes ?? null,
      });
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

/** Award a fixed recovery. Rust verifies the paired exposure is live and applies
 *  the caps; a credit that is not owed comes back as `applied: 0`. */
export async function hpRecover(recoveryId: string): Promise<HpDelta> {
  if (isTauri()) {
    try {
      return await invoke<HpDelta>("hp_recover", { recoveryId });
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
      return await invoke<HpDelta>("hp_data_credit", { sourceId, bytesFreed });
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
