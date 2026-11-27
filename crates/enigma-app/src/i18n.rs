//! English and Polish texts (wording from `apps/enigma/src/i18n/en.ts` and `pl.ts`).

/// The UI language.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Lang {
    /// English.
    #[default]
    En,
    /// Polski.
    Pl,
}

impl Lang {
    /// "en" / "pl".
    #[must_use]
    pub fn code(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Pl => "pl",
        }
    }
    /// From "en" / "pl" (anything else is English).
    #[must_use]
    pub fn from_code(s: &str) -> Self {
        if s.eq_ignore_ascii_case("pl") {
            Self::Pl
        } else {
            Self::En
        }
    }
}

/// (key, English, Polish).
const TEXTS: &[(&str, &str, &str)] = &[
    ("app.name", "Enigma27", "Enigma27"),
    ("nav.chats", "Chats", "Czaty"),
    ("nav.newChat", "New chat", "Nowy czat"),
    ("nav.joinChat", "Join chat", "Dołącz do czatu"),
    ("nav.friends", "Friends", "Znajomi"),
    ("nav.settings", "Settings", "Ustawienia"),
    ("nav.connections", "Connections", "Połączenia"),
    ("nav.back", "Back", "Wstecz"),
    ("common.cancel", "Cancel", "Anuluj"),
    ("common.close", "Close", "Zamknij"),
    ("common.copy", "Copy", "Kopiuj"),
    ("common.copied", "Copied", "Skopiowano"),
    ("common.save", "Save", "Zapisz"),
    ("chat.placeholder", "Message", "Wiadomość"),
    ("chat.send", "Send", "Wyślij"),
    ("chat.noRoom", "Pick a chat, or start a new one.", "Wybierz czat albo zacznij nowy."),
    ("chat.encrypted", "🔒 Encrypted", "🔒 Szyfrowany"),
    ("chat.keyExchange", "Key exchange…", "Wymiana kluczy…"),
    ("chat.cryptoError", "Encryption error", "Błąd szyfrowania"),
    ("chat.linkedTo", "Linked to {n}", "Połączono z {n}"),
    ("chat.viaBeacon", "Via Beacon", "Przez Beacon"),
    ("chat.direct", "Direct", "Bezpośrednio"),
    ("chat.notReady", "Not encrypted yet: wait for the key exchange.", "Jeszcze nie zaszyfrowano: poczekaj na wymianę kluczy."),
    ("menu.invite", "Invite", "Zaproś"),
    ("menu.participants", "Participants", "Uczestnicy"),
    ("menu.roomInfo", "Room info", "O pokoju"),
    ("menu.resetEncryption", "Reset encryption", "Zresetuj szyfrowanie"),
    ("menu.leave", "Leave", "Wyjdź"),
    ("menu.deleteRoom", "Delete room", "Usuń pokój"),
    ("new.title", "New chat", "Nowy czat"),
    ("new.name", "Room name", "Nazwa pokoju"),
    ("new.create", "Create", "Utwórz"),
    ("join.title", "Join chat", "Dołącz do czatu"),
    ("join.paste", "Paste the invitation code", "Wklej kod zaproszenia"),
    ("join.scan", "Scan with the camera (coming soon)", "Zeskanuj aparatem (wkrótce)"),
    ("join.join", "Join", "Dołącz"),
    ("join.notACode", "That is not an invitation code.", "To nie jest kod zaproszenia."),
    ("invite.title", "Invite to {room}", "Zaproś do {room}"),
    ("invite.hint", "Let them scan this code, or send them the text below.", "Niech zeskanują ten kod albo wyślij im tekst poniżej."),
    ("friends.title", "Friends", "Znajomi"),
    ("friends.intro", "Pair once by scanning each other's codes. Then you can invite a friend to any room with one tap.", "Sparujcie się raz, skanując nawzajem swoje kody. Potem zaprosisz znajomego do dowolnego pokoju jednym dotknięciem."),
    ("friends.myCode", "Your code", "Twój kod"),
    ("friends.myCodeHint", "Let your friend scan this code, and scan theirs. It only says who you are. Don't post it publicly.", "Niech znajomy zeskanuje ten kod, a ty zeskanuj jego. Mówi tylko, kim jesteś. Nie publikuj go."),
    ("friends.add", "Add a friend", "Dodaj znajomego"),
    ("friends.paste", "…or paste their code", "…albo wklej jego kod"),
    ("friends.addButton", "Add", "Dodaj"),
    ("friends.notACode", "That is not an Enigma27 friend code.", "To nie jest kod znajomego Enigma27."),
    ("friends.thatIsYou", "That is your own code.", "To twój własny kod."),
    ("friends.list", "Your friends ({n})", "Twoi znajomi ({n})"),
    ("friends.none", "No friends yet.", "Nie masz jeszcze znajomych."),
    ("friends.checkCode", "Check code (the same on both phones):", "Kod kontrolny (taki sam na obu telefonach):"),
    ("friends.added", "Added {name}. Check code: {code}", "Dodano {name}. Kod kontrolny: {code}"),
    ("settings.title", "Settings", "Ustawienia"),
    ("settings.nickname", "Nickname", "Pseudonim"),
    ("settings.nicknameHint", "Its first letter is your icon in every room. No photos are used.", "Jego pierwsza litera to twoja ikona w każdym pokoju. Zdjęcia nie są używane."),
    ("settings.language", "Language", "Język"),
    ("settings.theme", "Theme follows the system", "Motyw zgodny z systemem"),
    ("beacon.title", "Your Beacon (optional)", "Twój Beacon (opcjonalnie)"),
    ("beacon.intro", "A Beacon is a small helper reachable only over Tor. It keeps room messages for people who are offline. It cannot read them. Without it, rooms work directly between devices.", "Beacon to mały pomocnik dostępny tylko przez Tor. Przechowuje wiadomości pokoju dla osób offline. Nie może ich przeczytać. Bez niego pokoje działają bezpośrednio między urządzeniami."),
    ("beacon.enable", "Enable Beacon", "Włącz Beacon"),
    ("beacon.disable", "Disable Beacon", "Wyłącz Beacon"),
    ("beacon.on", "Beacon on", "Beacon włączony"),
    ("beacon.off", "Beacon off", "Beacon wyłączony"),
    ("beacon.onHint", "This computer is a Beacon. Share its address with friends.", "Ten komputer jest Beaconem. Udostępnij jego adres znajomym."),
    ("beacon.address", "Address", "Adres"),
    ("beacon.clientOnly", "This device is a client. Run the Beacon on a computer or a Raspberry Pi.", "To urządzenie jest klientem. Uruchom Beacon na komputerze albo Raspberry Pi."),
    ("tor.on", "Tor on", "Tor działa"),
    ("tor.starting", "Tor starting…", "Tor startuje…"),
    ("tor.off", "Tor off", "Tor wyłączony"),
    ("tor.error", "Tor error", "Błąd Tora"),
    ("tor.demo", "Tor simulated (demo)", "Tor symulowany (demo)"),
    ("participants.title", "Participants", "Uczestnicy"),
    ("participants.you", "you", "ty"),
    ("participants.linked", "linked", "połączony"),
    ("participants.notLinked", "not linked", "niepołączony"),
    ("info.title", "Room info", "O pokoju"),
    ("info.host", "You host this room", "Jesteś gospodarzem tego pokoju"),
    ("info.member", "You are a member", "Jesteś członkiem"),
    ("conn.notConnected", "Not connected yet. The Tor link to a Beacon arrives in stage 2; try --demo.", "Jeszcze nie połączono. Łącze Tor z Beaconem pojawi się w etapie 2; spróbuj --demo."),
];

/// The text for `key` in `lang` (the key itself if unknown).
#[must_use]
pub fn t(lang: Lang, key: &str) -> &str {
    TEXTS.iter().find(|(k, _, _)| *k == key).map_or(key, |(_, en, pl)| if lang == Lang::Pl { pl } else { en })
}

/// [`t`] with `{name}` placeholders filled.
#[must_use]
pub fn tf(lang: Lang, key: &str, params: &[(&str, &str)]) -> String {
    let mut s = t(lang, key).to_string();
    for (k, v) in params {
        s = s.replace(&format!("{{{k}}}"), v);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_languages_cover_every_key() {
        for (k, en, pl) in TEXTS {
            assert!(!en.is_empty() && !pl.is_empty(), "{k}");
        }
        assert_eq!(t(Lang::Pl, "nav.friends"), "Znajomi");
        assert_eq!(tf(Lang::En, "chat.linkedTo", &[("n", "2")]), "Linked to 2");
        assert_eq!(t(Lang::En, "no.such"), "no.such");
        assert_eq!(Lang::from_code("PL"), Lang::Pl);
    }
}
