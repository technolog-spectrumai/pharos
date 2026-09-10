// NEW COPY, not a transliteration.
//
// The English catalogue is written to be read by somebody deciding what to do;
// so is this. Where a phrase has no natural Polish form ("mint a token"), the
// sentence is rewritten around what the person actually does rather than
// calqued — `wygeneruj` beats a borrowed verb nobody says.
export default {
  app: {
    name: "Edytor LaTeX-a",
    tagline: "Edytuj i kompiluj LaTeX-a w Kapsule Obliczeniowej.",
  },
  connect: {
    title: "Połączenie z serwerem",
    server: "Adres serwera",
    serverHint: "Adres https Twojej platformy toto.",
    token: "Token API",
    tokenHint: "Wygeneruj go na serwerze: Kapsuły Obliczeniowe → Tokeny API, "
      + "a potem wklej tutaj. Pokazujemy go tylko raz.",
    check: "Sprawdź serwer",
    connect: "Połącz",
    forget: "Usuń token z tego komputera",
    forgetHint: "Usuwa token z tego komputera. Pozostaje ważny, dopóki nie "
      + "unieważnisz go na serwerze.",
    connectedAs: "Połączono jako {username}",
    viaToken: "tokenem nazwanym „{label}”",
    storedInKeyring: "Zapisany w systemowym pęku kluczy.",
    storedInMemory: "Przechowywany tylko w pamięci — po ponownym uruchomieniu "
      + "trzeba połączyć się jeszcze raz, bo nie było systemowego pęku kluczy.",
    untrustedCert: "Certyfikat tego serwera nie jest zaufany. Sprawdź, czy "
      + "odcisk poniżej zgadza się z tym, który podał administrator.",
    accept: "Sprawdziłem — akceptuję",
  },
  workspaces: {
    title: "Przestrzenie robocze",
    empty: "Nie masz na tym serwerze żadnych przestrzeni LaTeX-a.",
    readOnly: "Tylko do odczytu",
    open: "Otwórz",
  },
  editor: {
    save: "Zapisz",
    saved: "Zapisano",
    unsaved: "Niezapisane zmiany",
    run: "Kompiluj",
    running: "Kompilowanie…",
    noFile: "Otwórz plik z drzewa, aby zacząć edycję.",
  },
  console: {
    title: "Log kompilacji",
    clear: "Wyczyść",
    empty: "Skompiluj, aby zobaczyć tutaj wynik pdflatex-a.",
    freshEachTime: "Każda kompilacja odbywa się w Twojej Kapsule na serwerze.",
    exitCode: "kod wyjścia {code}",
    files: "Powstały pliki: {names}",
    queued: "Kompilowanie na serwerze…",
    passes: "przebiegi: {count}",
  },
  errors: {
    unreachable: "Nie udało się połączyć z tym serwerem.",
    badToken: "Ten token jest nieprawidłowy lub został unieważniony.",
    generic: "Coś poszło nie tak: {detail}",
  },
} as const;
