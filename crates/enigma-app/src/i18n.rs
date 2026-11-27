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
    ("join.scan", "Scan with the camera", "Zeskanuj aparatem"),
    ("join.scanFile", "Read a QR code from a picture", "Odczytaj kod QR ze zdjęcia"),
    ("join.picturePath", "Path to a picture (PNG or JPEG)", "Ścieżka do zdjęcia (PNG lub JPEG)"),
    ("join.peek", "Check", "Sprawdź"),
    ("settings.theme", "Theme", "Motyw"),
    ("theme.system", "System", "Systemowy"),
    ("theme.light", "Light", "Jasny"),
    ("theme.dark", "Dark", "Ciemny"),
    ("settings.tabs", "Tabs", "Karty"),
    ("tab.chat", "Chat", "Czat"),
    ("tab.files", "Files", "Pliki"),
    ("tab.friends", "Friends", "Znajomi"),
    ("settings.files", "Files", "Pliki"),
    ("settings.maxFile", "Largest file (MB)", "Największy plik (MB)"),
    ("settings.chunk", "Chunk size (KB)", "Rozmiar fragmentu (KB)"),
    ("settings.notifications", "Notify me of new messages", "Powiadamiaj o nowych wiadomościach"),
    ("beacon.title", "Your Beacon", "Twój Beacon"),
    ("beacon.intro", "Your Beacon is a small computer at home (a Raspberry Pi or a Linux PC) running the Beacon app. This device connects to it over Tor; it carries your rooms' sealed messages and keeps them while you are offline. It cannot read them.", "Twój Beacon to mały komputer w domu (Raspberry Pi albo PC z Linuksem) z aplikacją Beacon. To urządzenie łączy się z nim przez Tora; przenosi zapieczętowane wiadomości twoich pokojów i przechowuje je, gdy jesteś offline. Nie może ich przeczytać."),
    ("beacon.paste", "Paste the pharos-beacon: code from the Beacon's screen", "Wklej kod pharos-beacon: z ekranu Beacona"),
    ("beacon.set", "Set", "Ustaw"),
    ("beacon.remove", "Remove", "Usuń"),
    ("beacon.current", "Attached to {name}", "Połączono z {name}"),
    ("beacon.none", "No Beacon yet: rooms cannot reach anyone.", "Brak Beacona: pokoje nie mogą z nikim się połączyć."),
    ("beacon.discovery", "Only my phones", "Tylko moje telefony"),
    ("beacon.discoveryHint", "If your Beacon lets only your phones find it, add this key on the Beacon (Phones → Allow):", "Jeśli twój Beacon pozwala się znaleźć tylko twoim telefonom, dodaj ten klucz na Beaconie (Telefony → Zezwól):"),
    ("beacon.discoveryWait", "The key appears once Tor is up.", "Klucz pojawi się, gdy Tor wystartuje."),
    ("net.offline", "Offline mode (no Tor, no Beacon link)", "Tryb offline (bez Tora i Beacona)"),
    ("net.timeout", "Connection timeout (seconds)", "Limit czasu połączenia (sekundy)"),
    ("sec.title", "Security", "Bezpieczeństwo"),
    ("sec.changePass", "Change passphrase", "Zmień hasło"),
    ("sec.current", "Current passphrase", "Obecne hasło"),
    ("sec.new", "New passphrase", "Nowe hasło"),
    ("sec.again", "New passphrase again", "Powtórz nowe hasło"),
    ("sec.pin", "PIN unlock", "Odblokowanie PIN-em"),
    ("sec.pinHint", "A PIN of 4–12 digits unlocks until the app restarts; 5 wrong PINs forget it.", "PIN z 4–12 cyfr odblokowuje do ponownego uruchomienia; 5 błędnych PIN-ów go usuwa."),
    ("sec.pinSet", "Set PIN", "Ustaw PIN"),
    ("sec.pinClear", "Remove PIN", "Usuń PIN"),
    ("sec.idle", "Lock after idle (minutes, 0 = never)", "Blokuj po bezczynności (minuty, 0 = nigdy)"),
    ("sec.lockOnHide", "Lock when the window is hidden", "Blokuj, gdy okno jest ukryte"),
    ("sec.panic", "Panic code", "Kod paniki"),
    ("sec.panicHint", "Typing it instead of your passphrase erases every profile, silently, and opens an empty app.", "Wpisanie go zamiast hasła po cichu kasuje wszystkie profile i otwiera pustą aplikację."),
    ("sec.panicSet", "Set panic code", "Ustaw kod paniki"),
    ("sec.panicClear", "Remove panic code", "Usuń kod paniki"),
    ("sec.panicOn", "A panic code is set.", "Kod paniki jest ustawiony."),
    ("sec.lockNow", "Lock now", "Zablokuj teraz"),
    ("prof.title", "Profiles", "Profile"),
    ("prof.active", "Active profile: {name}", "Aktywny profil: {name}"),
    ("prof.name", "Profile name", "Nazwa profilu"),
    ("prof.switch", "Switch / create", "Przełącz / utwórz"),
    ("danger.title", "Danger zone", "Strefa zagrożenia"),
    ("danger.erase", "Erase this profile", "Wymaż ten profil"),
    ("danger.eraseHint", "Deletes this profile's rooms, messages, friends and keys from this device. It cannot be undone.", "Usuwa z tego urządzenia pokoje, wiadomości, znajomych i klucze tego profilu. Nie da się tego cofnąć."),
    ("danger.confirm", "Type ERASE to confirm", "Wpisz ERASE, aby potwierdzić"),
    ("gate.welcome", "Welcome to Enigma27", "Witaj w Enigma27"),
    ("gate.about", "Private rooms, end-to-end encrypted (MLS), carried over Tor by your own Beacon. No accounts, no phone numbers, no servers that can read you.", "Prywatne pokoje, szyfrowane end-to-end (MLS), przenoszone przez Tora przez twój własny Beacon. Bez kont, numerów telefonu i serwerów, które mogą cię czytać."),
    ("gate.choose", "Choose a passphrase: it seals everything on this device.", "Wybierz hasło: pieczętuje wszystko na tym urządzeniu."),
    ("gate.passphrase", "Passphrase", "Hasło"),
    ("gate.again", "Passphrase again", "Powtórz hasło"),
    ("gate.create", "Create my vault", "Utwórz mój sejf"),
    ("gate.locked", "Enigma27 is locked", "Enigma27 jest zablokowana"),
    ("gate.unlock", "Unlock", "Odblokuj"),
    ("gate.pin", "PIN", "PIN"),
    ("gate.usePin", "Use PIN", "Użyj PIN-u"),
    ("gate.usePass", "Use passphrase", "Użyj hasła"),
    ("gate.tauri", "Found the profile of the earlier Enigma27 app: unlock it with its passphrase.", "Znaleziono profil wcześniejszej aplikacji Enigma27: odblokuj go jej hasłem."),
    ("idle.warn", "Locking in {s} s (no activity).", "Blokada za {s} s (brak aktywności)."),
    ("idle.stay", "Stay unlocked", "Nie blokuj"),
    ("banner.waiting", "Waiting to be let in: the inviter's device admits you when it is online.", "Czekasz na wpuszczenie: urządzenie zapraszającego wpuści cię, gdy będzie online."),
    ("banner.alone", "You are alone here. Invite someone (⋮ → Invite).", "Jesteś tu sam. Zaproś kogoś (⋮ → Zaproś)."),
    ("invite.ttl", "Valid for", "Ważne przez"),
    ("invite.ttl1h", "1 hour", "1 godzinę"),
    ("invite.ttl1d", "1 day", "1 dzień"),
    ("invite.ttl7d", "7 days", "7 dni"),
    ("invite.ttlNone", "No expiry", "Bez terminu"),
    ("invite.for", "For", "Dla"),
    ("invite.anyone", "Anyone with the code", "Każdego z kodem"),
    ("invite.make", "New invitation", "Nowe zaproszenie"),
    ("invite.list", "Invitations made here", "Zaproszenia stąd"),
    ("invite.revoke", "Withdraw", "Wycofaj"),
    ("invite.none", "None yet.", "Jeszcze żadnych."),
    ("files.title", "Files", "Pliki"),
    ("files.offer", "Send a file", "Wyślij plik"),
    ("files.path", "Path to the file", "Ścieżka do pliku"),
    ("files.accept", "Accept", "Przyjmij"),
    ("files.decline", "Decline", "Odrzuć"),
    ("files.none", "No files in this room yet.", "W tym pokoju nie ma jeszcze plików."),
    ("chat.picture", "Picture", "Zdjęcie"),
    ("chat.record", "Record", "Nagraj"),
    ("chat.stop", "Stop", "Stop"),
    ("chat.play", "Play", "Odtwórz"),
    ("friends.remove", "Remove", "Usuń"),
    ("conn.notConnected", "Not connected: set Your Beacon in Settings.", "Brak połączenia: ustaw Twój Beacon w Ustawieniach."),
    ("conn.offline", "Offline mode is on.", "Tryb offline jest włączony."),
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
