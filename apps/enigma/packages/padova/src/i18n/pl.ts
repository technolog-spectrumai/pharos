// Padova's words, in Polish. See ./en.ts for why this catalogue lives in the
// package rather than in an app.
export default {
  lock: {
    lockTitle: "Zaszyfruj ten plik",
    openTitle: "Otwórz zaszyfrowany plik",
    openHint: "Plik jest odszyfrowywany tylko w pamięci. Zapis zapisuje go z powrotem zaszyfrowany; nic nieszyfrowanego nie trafia na dysk.",
    unlockHint: "To zapisze plik na dysku jako zwykły tekst. Aby edytować bez tego, po prostu go otwórz.",
    open: "Otwórz",
    unlockTitle: "Odszyfruj ten plik na stałe",
    lockHint: "Hasło nigdy nie trafia do pliku, a każdy plik dostaje własny klucz. Wszystko, co potrzebne do ponownego otwarcia tego pliku, poza hasłem, jest zapisane w nim samym.",
    password: "Hasło",
    confirm: "Powtórz hasło",
    lock: "Zaszyfruj",
    unlock: "Odszyfruj",
    remember: "Zapami\u0119taj to has\u0142o, \u017ceby wi\u0119cej nie pyta\u0107",
    passwordRequired: "Podaj hasło.",
    passwordMismatch: "Te dwa nie są takie same.",
    errors: {
      no_passphrase: "Nie podano has\u0142a i \u017cadne nie jest zapami\u0119tane.",
      wrong_password: "Złe hasło albo plik jest uszkodzony. Nic nie zostało zmienione.",
      already_locked: "Ten plik jest już zaszyfrowany.",
      not_locked: "Ten plik nie jest zaszyfrowany.",
      too_large: "Ten plik jest za duży, by go zaszyfrować.",
      legacy_format: "Ten plik został zaszyfrowany przez platformę. Ustawienia jego klucza były na serwerze, więc nie da się go tutaj otworzyć.",
      crypto: "Ten zaszyfrowany plik jest uszkodzony. Nic nie zostało zmienione.",
      changed_on_disk: "Ten plik zmienił się na dysku, gdy był otwarty. Nic nie zapisano; otwórz go ponownie.",
    },
  },
  security: {
    title: "Bezpieczeństwo",
    intro: "Wszystko na tej stronie to stwierdzenie faktu o tej wersji. Nic tu nie jest ustawieniem.",
    files: {
      title: "Zaszyfruj plik",
      help: "Pliki w Twoim folderze roboczym. Szyfrowanie nadpisuje plik w miejscu, a wszystko, co potrzebne do jego ponownego otwarcia, podróżuje w jego wnętrzu — więc zaszyfrowany plik otworzy się na każdym komputerze, na którym podasz hasło. Zamknij plik najpierw w edytorze: karta, która wciąż trzyma starą treść, może zapisać ją z powrotem na zaszyfrowanym pliku.",
      noWorkspace: "Wybierz folder roboczy, żeby szyfrować w nim pliki.",
      empty: "Nie ma tu czego szyfrować.",
      sealed: "Zaszyfrowany",
      refresh: "Odczytaj folder ponownie",
    },
    secret: {
      held: "Has\u0142o jest zapami\u0119tane, wi\u0119c pliki szyfruj\u0105 si\u0119 i odszyfrowuj\u0105 bez pytania.",
      keychain: "Trzymane w p\u0119ku kluczy systemu.",
      memory: "Trzymane do zamkni\u0119cia aplikacji \u2014 p\u0119k kluczy systemu by\u0142 niedost\u0119pny.",
      none: "\u017badne has\u0142o nie jest zapami\u0119tane. Zapytamy za ka\u017cdym razem.",
      forget: "Zapomnij",
    },
  },
} as const;
