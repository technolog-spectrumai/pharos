import { ref } from "vue";
import type { ChatChannel } from "rakotis";

// Shared P2P room state + actions for the chat surface. One instance is created in
// ChatPanel and passed to both the desktop rooms sidebar and the mobile drawer so
// they stay in sync (the refs are shared by reference).
export function useP2pRooms(channel: ChatChannel) {
  const name = ref("");
  const ticket = ref("");
  const createdTicket = ref("");
  const scanError = ref(""); // i18n key, "" when clear

  async function createRoom() {
    const n = name.value.trim();
    if (!n) return;
    const t = await channel.createRoom(n);
    if (t) {
      createdTicket.value = t;
      name.value = "";
    }
  }

  async function joinRoom() {
    const t = ticket.value.trim();
    if (!t) return;
    await channel.joinByTicket(t);
    ticket.value = "";
  }

  async function joinTicket(raw: string) {
    ticket.value = raw.trim();
    await joinRoom();
  }

  // Join by decoding a QR image file (off-screen #p2p-qr-file-region lives in ChatPanel).
  async function scanFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    scanError.value = "";
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const reader = new Html5Qrcode("p2p-qr-file-region");
      const decoded: string = await reader.scanFile(file, false);
      try {
        await reader.clear();
      } catch {
        /* ignore */
      }
      await joinTicket(decoded);
    } catch {
      scanError.value = "chat.qrNotFound";
    }
  }

  return { name, ticket, createdTicket, scanError, createRoom, joinRoom, joinTicket, scanFile };
}

export type P2pRoomsController = ReturnType<typeof useP2pRooms>;
