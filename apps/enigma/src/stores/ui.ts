// The one menu drawer (☰ in the app bar): rooms on top, then the app's pages.
// A module ref, so the app bar opens it and the chat's "Select a room" can too.
import { ref } from "vue";

export const drawerOpen = ref(false);
