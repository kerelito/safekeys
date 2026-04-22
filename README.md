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
