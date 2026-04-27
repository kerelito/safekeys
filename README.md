# SafeKeys

System do zarządzania skrytkami na klucze z panelem WWW, integracją Discord i przygotowaniem pod hardware na ESP32.

## Struktura projektu

```text
.
├── esp32/
│   ├── README.md
│   └── SafeKeysESP32.ino
├── public/
│   ├── app.js
│   ├── assets/
│   │   └── safekeys-logo.png
│   ├── index.html
│   └── styles.css
├── server/
│   ├── bot/
│   │   ├── commands.js
│   │   └── discordBot.js
│   ├── models/
│   │   └── index.js
│   ├── services/
│   │   ├── lockerService.js
│   │   └── lockerValidation.js
│   └── index.js
├── .env.example
├── package-lock.json
├── package.json
└── README.md
```

## Co gdzie jest

- `server/index.js`
  Główny serwer Express, sesje, Socket.IO, routing HTTP i boot Discorda.

- `server/services/lockerService.js`
  Logika biznesowa systemu skrytek: kody, status skrytek, RFID użytkowników, logi i zdalne akcje.

- `server/services/lockerValidation.js`
  Walidacja danych wejściowych i wspólne błędy HTTP.

- `server/models/index.js`
  Modele Mongoose używane przez backend.

- `server/bot/commands.js`
  Definicje slash commandów Discorda.

- `server/bot/discordBot.js`
  Obsługa interakcji Discord, embedów i akcji administracyjnych.

- `public/index.html`
  Struktura dashboardu i widoków panelu.

- `public/styles.css`
  Style panelu WWW.

- `public/app.js`
  Frontend dashboardu: logowanie, przełączanie podstron, żądania API, Socket.IO i renderowanie UI.

- `esp32/SafeKeysESP32.ino`
  Szkic pod firmware ESP32 przygotowany pod integrację z backendem.

## Aktualne założenia

- Panel WWW i Discord korzystają z tego samego backendu.
- Urządzenie może raportować status skrytek i pobierać zakolejkowane akcje.
- RFID użytkownika jest osobnym bytem od RFID obecności klucza w skrytce.
- Frontend pozostaje prostą aplikacją statyczną bez bundlera, żeby wdrożenie na Railway było lekkie.

## Wysyłka kodów e-mailem

Panel WWW pozwala teraz podczas generowania kodu podać opcjonalny adres e-mail. Jeśli serwer ma skonfigurowane SMTP, SafeKeys spróbuje automatycznie wysłać wygenerowany kod na wskazany adres.

Do konfiguracji użyj zmiennych:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM_EMAIL`
- `SMTP_FROM_NAME`
- `SMTP_REPLY_TO`

Jeśli operator poda adres e-mail, a SMTP nie będzie skonfigurowane albo wysyłka się nie powiedzie, kod nadal zostanie wygenerowany w systemie, a panel pokaże status błędu dostarczenia.

### Konfiguracja Brevo

Dla Brevo możesz użyć poniższego zestawu:

```env
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=twoj-login-brevo@example.com
SMTP_PASS=twoj-klucz-smtp-brevo
SMTP_FROM_EMAIL=powiadomienia@twojadomena.pl
SMTP_FROM_NAME=SafeKeys
SMTP_REPLY_TO=kontakt@twojadomena.pl
```

Uwagi:

- `SMTP_USER` to login SMTP z panelu Brevo.
- `SMTP_PASS` to klucz SMTP z Brevo, nie klucz API.
- `SMTP_FROM_EMAIL` powinien być zweryfikowanym nadawcą lub adresem z uwierzytelnionej domeny w Brevo.
- Domyślnie ustawione jest `587` i `SMTP_SECURE=false`, co odpowiada zalecanemu połączeniu bez wymuszania SSL/TLS na starcie. Jeśli chcesz użyć portu `465`, ustaw `SMTP_SECURE=true`.
- Przed wysyłką z aplikacji warto w Brevo dodać i uwierzytelnić domenę oraz skonfigurować nadawcę transakcyjnego.
