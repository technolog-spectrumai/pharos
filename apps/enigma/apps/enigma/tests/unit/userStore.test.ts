import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";

// The local identity store. Enigma26 is serverless — there is no login and no
// /me — so "who you are" is entirely a locally stored offline profile, and this
// store is what the chat display name and avatar are read from.
//
// It had no tests. What matters here is that every mutation re-reads the
// authoritative state Rust returns instead of trusting the local ref, and that
// a partial profile from disk is always widened to the full shape (a missing
// field would otherwise reach the template as `undefined` and render "undefined").

const state = {
  offline_profile: {} as Record<string, unknown>,
  offline_profiles: [] as { id: string; label: string }[],
  selected_offline_profile_id: "",
};
const getProfileState = vi.fn(async () => structuredClone(state));
const setOfflineProfile = vi.fn(async () => {});
const clearOfflineProfile = vi.fn(async () => structuredClone(state));
const clearProfileState = vi.fn(async () => structuredClone(state));
const setSelectedOfflineProfile = vi.fn(async () => structuredClone(state));
const upsertOfflineProfile = vi.fn(async () => structuredClone(state));

vi.mock("rakotis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("rakotis")>();
  return {
    ...actual,
    getProfileState: () => getProfileState(),
    setOfflineProfile: (...a: unknown[]) => setOfflineProfile(...(a as [])),
    clearOfflineProfile: () => clearOfflineProfile(),
    clearProfileState: () => clearProfileState(),
    setSelectedOfflineProfile: (...a: unknown[]) => setSelectedOfflineProfile(...(a as [])),
    upsertOfflineProfile: (...a: unknown[]) => upsertOfflineProfile(...(a as [])),
  };
});

import { useUserStore } from "../../src/stores/user";

beforeEach(() => {
  vi.clearAllMocks();
  state.offline_profile = {};
  state.offline_profiles = [];
  state.selected_offline_profile_id = "";
  setActivePinia(createPinia());
});

describe("initial state", () => {
  it("starts empty and unloaded, so the UI can tell 'no name' from 'not read yet'", () => {
    const u = useUserStore();
    expect(u.offlineProfileLoaded).toBe(false);
    expect(u.displayName).toBe("");
    expect(u.avatarDataUrl).toBe("");
    expect(u.offlineProfiles).toEqual([]);
  });
});

describe("loadOfflineProfile", () => {
  it("adopts the stored profile and marks itself loaded", async () => {
    state.offline_profile = { display_name: "Ada", bio: "hi" };
    state.offline_profiles = [{ id: "p1", label: "Ada" }];
    state.selected_offline_profile_id = "p1";
    const u = useUserStore();

    await u.loadOfflineProfile();

    expect(u.displayName).toBe("Ada");
    expect(u.offlineProfiles).toEqual([{ id: "p1", label: "Ada" }]);
    expect(u.selectedOfflineProfileId).toBe("p1");
    expect(u.offlineProfileLoaded).toBe(true);
  });

  it("widens a partial stored profile to the full shape", async () => {
    // Only one field on disk — everything else must still be a string, or the
    // profile form binds `undefined` and renders it.
    state.offline_profile = { display_name: "Ada" };
    const u = useUserStore();

    await u.loadOfflineProfile();

    for (const k of ["email", "phone", "bio", "date_of_birth", "avatar"] as const) {
      expect(u.offlineProfile[k]).toBe("");
    }
  });

  it("trims the display name — whitespace is not a name", async () => {
    state.offline_profile = { display_name: "  Ada  " };
    const u = useUserStore();
    await u.loadOfflineProfile();
    expect(u.displayName).toBe("Ada");

    u.offlineProfile.display_name = "   ";
    expect(u.displayName).toBe("");
  });

  it("survives a stored profile with no display name at all", async () => {
    state.offline_profile = { bio: "anonymous" };
    const u = useUserStore();
    await u.loadOfflineProfile();
    expect(u.displayName).toBe("");
  });
});

describe("saveOfflineProfile", () => {
  it("writes, then RE-READS — the stored state stays authoritative", async () => {
    const u = useUserStore();
    u.offlineProfile.display_name = "Grace";
    // Rust normalizes on write (and may reject or alter fields).
    state.offline_profile = { display_name: "Grace", bio: "normalized" };

    await u.saveOfflineProfile();

    expect(setOfflineProfile).toHaveBeenCalledWith(
      expect.objectContaining({ display_name: "Grace" }),
    );
    expect(getProfileState).toHaveBeenCalled();
    expect(u.offlineProfile.bio).toBe("normalized");
  });
});

describe("profile switching", () => {
  it("selecting a profile adopts the state the switch returned", async () => {
    state.offline_profile = { display_name: "Bob" };
    state.selected_offline_profile_id = "p2";
    setSelectedOfflineProfile.mockResolvedValueOnce(structuredClone(state));
    const u = useUserStore();

    await u.selectOfflineProfile("p2");

    expect(setSelectedOfflineProfile).toHaveBeenCalledWith("p2");
    expect(u.displayName).toBe("Bob");
    expect(u.selectedOfflineProfileId).toBe("p2");
    expect(u.offlineProfileLoaded).toBe(true);
  });

  it("saving as a new profile sends the CURRENT edits under the new id", async () => {
    const u = useUserStore();
    u.offlineProfile.display_name = "Work me";

    await u.saveOfflineProfileAs("p3", "Work");

    expect(upsertOfflineProfile).toHaveBeenCalledWith(
      "p3",
      "Work",
      expect.objectContaining({ display_name: "Work me" }),
    );
    expect(u.offlineProfileLoaded).toBe(true);
  });
});

describe("clearing", () => {
  it("clearing the selection reverts to whatever state Rust reports", async () => {
    const u = useUserStore();
    u.offlineProfile.display_name = "Ada";
    clearOfflineProfile.mockResolvedValueOnce({
      offline_profile: {},
      offline_profiles: [{ id: "p1", label: "Ada" }],
      selected_offline_profile_id: "",
    } as never);

    await u.clearSelectedOfflineProfile();

    expect(u.displayName).toBe("");
    // Deselecting is not deleting: the saved profile is still on the list.
    expect(u.offlineProfiles).toEqual([{ id: "p1", label: "Ada" }]);
  });

  it("clearing all data empties the identity AND the profile list", async () => {
    const u = useUserStore();
    u.offlineProfile.display_name = "Ada";
    u.offlineProfiles = [{ id: "p1", label: "Ada" }];
    clearProfileState.mockResolvedValueOnce({
      offline_profile: {},
      offline_profiles: [],
      selected_offline_profile_id: "",
    } as never);

    await u.clearAllProfileData();

    expect(u.displayName).toBe("");
    expect(u.offlineProfiles).toEqual([]);
    expect(u.selectedOfflineProfileId).toBe("");
  });
});

describe("avatar", () => {
  it("passes a stored data URL through for chat + presence", async () => {
    state.offline_profile = { display_name: "Ada", avatar: "data:image/jpeg;base64,AAA" };
    const u = useUserStore();
    await u.loadOfflineProfile();
    expect(u.avatarDataUrl).toBe("data:image/jpeg;base64,AAA");
  });

  it("reports no avatar as an empty string, never undefined", async () => {
    state.offline_profile = { display_name: "Ada" };
    const u = useUserStore();
    await u.loadOfflineProfile();
    expect(u.avatarDataUrl).toBe("");
  });
});
