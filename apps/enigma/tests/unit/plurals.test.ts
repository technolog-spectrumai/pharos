// Polish plural forms.
//
// vue-i18n's default rule is English — one form for 1, one for everything else. A
// Polish catalog written against it can only ever offer two forms, so the middle
// one ("2 uczestnicy") is unreachable no matter what the translator writes. These
// assertions are the only thing that proves the custom rule in
// packages/rakotis/src/i18n/index.ts is actually wired in.

import { describe, it, expect, beforeEach } from "vitest";
import { i18n, setLocale } from "../../src/i18n";

const t = (key: string, n: number) =>
  (i18n.global.t as unknown as (k: string, p: number) => string)(key, n);

describe("Polish plurals pick the right of three forms", () => {
  beforeEach(() => setLocale("pl", false));

  it("uses the singular, the few-form and the many-form", () => {
    expect(t("chat.participantCount", 1)).toBe("1 uczestnik");
    expect(t("chat.participantCount", 2)).toBe("2 uczestnicy");
    expect(t("chat.participantCount", 4)).toBe("4 uczestnicy");
    expect(t("chat.participantCount", 5)).toBe("5 uczestników");
    expect(t("chat.participantCount", 21)).toBe("21 uczestników");
  });

  it("sends the teens to the many-form despite their last digit", () => {
    // 12/13/14 end in 2/3/4 but take the many-form — the carve-out that a naive
    // `n % 10` rule gets wrong, and the reason the rule is a function.
    expect(t("chat.participantCount", 12)).toBe("12 uczestników");
    expect(t("chat.participantCount", 13)).toBe("13 uczestników");
    expect(t("chat.participantCount", 14)).toBe("14 uczestników");
    // …while 22/23/24 go back to the few-form.
    expect(t("chat.participantCount", 22)).toBe("22 uczestnicy");
    expect(t("chat.participantCount", 24)).toBe("24 uczestnicy");
  });

  it("declines the day count", () => {
    expect(t("invite.inDays", 1)).toBe("1 dzień");
    expect(t("invite.inDays", 3)).toBe("3 dni");
    expect(t("invite.inDays", 7)).toBe("7 dni");
  });
});

describe("English plurals", () => {
  beforeEach(() => setLocale("en", false));

  it("no longer says '1 days'", () => {
    // This was wrong in English too, not just Polish: the count was passed as a
    // named param, which interpolates but never selects a form.
    expect(t("invite.inDays", 1)).toBe("1 day");
    expect(t("invite.inDays", 2)).toBe("2 days");
    expect(t("invite.inHours", 1)).toBe("1 hour");
    expect(t("invite.inHours", 5)).toBe("5 hours");
    expect(t("chat.participantCount", 1)).toBe("1 participant");
    expect(t("chat.participantCount", 3)).toBe("3 participants");
  });
});
