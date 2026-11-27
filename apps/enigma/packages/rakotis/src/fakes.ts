// Fakes of the shared room engine's outside: an in-memory gossip hub (a `ChatTransport` per
// device) and an MLS stand-in (a `ChatCrypto`) whose groups live in one shared "world", so
// several channels in one process can let each other in, talk, restart and remove each other.
// For tests and demos (Teutates' demo runs its room on them); no real cryptography.

import type { ChatTransport, OpenedRoom, WsMessage, WsStatus } from "./chatTransport";
import type { ChatCrypto } from "./useChatChannel";
import type { KvBackend } from "./services/localDb";

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const dec = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));
const rid = () => Math.random().toString(36).slice(2, 10);

/** A room's slug from its name (the real one is blake3's hex; any stable text will do here). */
export const fakeSlug = (name: string) => `topic-${name}`;

type Handler = (room: string, data: WsMessage) => void;
type StatusH = (room: string, state: WsStatus, peerId?: string) => void;

/** An in-memory gossip network: devices by name, online or not. */
export class MemHub {
  private devices = new Map<string, { rooms: Set<string>; msg: Set<Handler>; st: Set<StatusH>; last: Map<string, WsStatus> }>();
  private offline = new Set<string>();
  /** Every frame broadcast: (from, room, frame). */
  log: { from: string; room: string; frame: WsMessage }[] = [];

  private dev(who: string) {
    let d = this.devices.get(who);
    if (!d) {
      d = { rooms: new Set(), msg: new Set(), st: new Set(), last: new Map() };
      this.devices.set(who, d);
    }
    return d;
  }

  private status(who: string, room: string, state: WsStatus, peer?: string) {
    const d = this.dev(who);
    d.last.set(room, state);
    setTimeout(() => d.st.forEach((h) => h(room, state, peer)), 0);
  }

  private others(who: string, room: string) {
    return [...this.devices.entries()].filter(([w, d]) => w !== who && d.rooms.has(room) && !this.offline.has(w));
  }

  /** Takes a device off the network, or puts it back. */
  setOnline(who: string, on: boolean) {
    if (on) this.offline.delete(who);
    else this.offline.add(who);
    for (const room of this.dev(who).rooms) {
      if (on && this.others(who, room).length) {
        this.status(who, room, "connected", this.others(who, room)[0][0]);
        for (const [w] of this.others(who, room)) this.status(w, room, "connected", who);
      }
      if (!on) this.status(who, room, "disconnected");
    }
  }

  /** The network as device `who` sees it (a fresh transport each call: "after a restart"). */
  transport(who: string): ChatTransport {
    const d = this.dev(who);
    d.msg.clear();
    d.st.clear();
    const join = async (name: string): Promise<OpenedRoom> => {
      const room = fakeSlug(name);
      d.rooms.add(room);
      if (!this.offline.has(who) && this.others(who, room).length) {
        this.status(who, room, "connected", this.others(who, room)[0][0]);
        for (const [w] of this.others(who, room)) this.status(w, room, "connected", who);
      } else d.last.set(room, "waiting");
      return { room, name, onion: `${who}.onion` };
    };
    return {
      createRoom: (name: string): Promise<OpenedRoom> => join(name),
      joinRoom: (name: string) => join(name),
      setPeers() {},
      cancelJoin() {},
      leaveRoom: (room: string) => { d.rooms.delete(room); },
      forgetOnion() {},
      deviceId: async () => who,
      send: (room: string, payload: Record<string, unknown>) => {
        if (this.offline.has(who)) return;
        const frame = JSON.parse(JSON.stringify(payload)) as WsMessage;
        this.log.push({ from: who, room, frame });
        for (const [, o] of this.others(who, room)) setTimeout(() => o.msg.forEach((h) => h(room, JSON.parse(JSON.stringify(frame)))), 0);
      },
      onMessage: (h: Handler) => { d.msg.add(h); return () => d.msg.delete(h); },
      onStatus: (h: StatusH) => { d.st.add(h as StatusH); return () => d.st.delete(h as StatusH); },
      lastStatus: (room: string) => d.last.get(room),
    };
  }
}

/** A device's view: its group, its key packages, the members as its last commit said. */
interface FakeSession { gid: string; kps: string[]; members: string[] }
interface FakeGroup { members: string[]; epoch: number }

/** The fake MLS's world: groups and saved sessions (the saved half survives a "restart"). */
export class MlsWorld {
  groups = new Map<string, FakeGroup>();
  sessions = new Map<string, FakeSession>();
}

/** An MLS stand-in on `world`: a member reads a group's messages while it is in the group. */
export function fakeMls(world: MlsWorld): ChatCrypto {
  const key = (room: string, id: string) => `${room}|${id}`;
  const get = (room: string, id: string) => {
    const s = world.sessions.get(key(room, id));
    if (!s) throw new Error("session not initialised");
    return s;
  };
  const group = (gid: string) => world.groups.get(gid) ?? { members: [], epoch: 0 };
  return {
    async initSession(room, id) {
      if (world.sessions.has(key(room, id))) return true;
      const gid = rid();
      world.groups.set(gid, { members: [id], epoch: 0 });
      world.sessions.set(key(room, id), { gid, kps: [], members: [id] });
      return false;
    },
    async keyPackage(room, id) {
      const n = rid();
      get(room, id).kps.push(n);
      return enc({ kp: id, n });
    },
    async addMember(room, id, kp) {
      const s = get(room, id);
      const k = dec(kp);
      const g = group(s.gid);
      if (!g.members.includes(k.kp)) g.members.push(k.kp);
      g.epoch++;
      world.groups.set(s.gid, g);
      s.members = [...g.members];
      return { welcome: enc({ welcome: s.gid, to: k.kp, n: k.n, members: s.members }), commit: enc({ commit: s.gid, epoch: g.epoch, members: s.members }) };
    },
    async adoptSession(from, to, id) {
      const s = world.sessions.get(key(from, id));
      if (!s) return false;
      world.sessions.delete(key(from, id));
      world.sessions.set(key(to, id), s);
      return true;
    },
    async joinFromWelcome(room, id, w) {
      const s = world.sessions.get(key(room, id));
      const v = dec(w);
      if (!s || v.to !== id || !s.kps.includes(v.n)) return false;
      s.gid = v.welcome;
      s.members = v.members;
      return true;
    },
    async processMessage(room, id, bytes) {
      const s = get(room, id);
      const v = dec(bytes);
      if (v.commit !== undefined) {
        if (v.commit !== s.gid) throw new Error("group id differs");
        s.members = v.members;
        return null;
      }
      if (v.app !== s.gid || !group(s.gid).members.includes(id)) throw new Error("cannot decrypt");
      return new TextEncoder().encode(v.text);
    },
    async encrypt(room, id, text) {
      return enc({ app: get(room, id).gid, text });
    },
    async clearState(room, id) {
      world.sessions.delete(key(room, id));
    },
    async members(room, id) {
      const s = world.sessions.get(key(room, id));
      return s ? [...s.members] : [];
    },
    async removeMember(room, id, target) {
      const s = get(room, id);
      const g = group(s.gid);
      g.members = g.members.filter((m) => m !== target);
      g.epoch++;
      s.members = [...g.members];
      return enc({ commit: s.gid, epoch: g.epoch, members: s.members });
    },
  };
}

/** A kv store in memory (one per device). */
export function memKv(): KvBackend & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const k = (ns: string, scope: string, key: string) => `${ns}\u0000${scope}\u0000${key}`;
  return {
    data,
    async get(ns, scope, key) { return data.get(k(ns, scope, key)) ?? null; },
    async put(ns, scope, key, v) { data.set(k(ns, scope, key), v); },
    async delete(ns, scope, key) { data.delete(k(ns, scope, key)); },
  };
}
