// Padova's catalogue, for an app to merge into its own.
//
// Shipped as data rather than installed as a vue-i18n instance: an app has ONE
// i18n, and a package that created a second would give its own components a
// different locale from everything around them. `padovaMessages.en` is spread
// into the app's `en` object, under the same `lock.*` / `security.*` names the
// components already use.
import en from "./en";
import pl from "./pl";

export const padovaMessages = { en, pl } as const;
export type PadovaMessages = typeof padovaMessages;
