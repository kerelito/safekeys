# SafeKeys

Smart skrytka i system zarzadzania kluczami oparty o ESP32, RFID, panel webowy i backend.

> Stan opisany w tym README wynika z analizy aktualnego kodu repozytorium z dnia 11 maja 2026. W repo sa tez starsze warianty firmware i artefakty frontendu, ale aktywny runtime opisany ponizej opiera sie przede wszystkim na `software/server`, `software/public` oraz `hardware/safekeys/src/main.cpp`.

## Krotki opis projektu

SafeKeys sluzy do zarzadzania obiegiem kluczy i dostepem do skrytek. System laczy fizyczne czytniki RFID i klawiature przy ESP32 z backendem Node.js, panelem operatora oraz logowaniem zdarzen w czasie rzeczywistym.

Docelowy przeplyw wyglada tak:

`RFID / keypad -> ESP32 -> WebSocket / HTTP -> backend -> panel webowy -> logi, statusy, alarmy i zdalne akcje`

W praktyce aktualny kod rozwiazuje kilka problemow naraz:

- pilnuje, czy w skrytce jest znany tag RFID, obcy tag albo brak przedmiotu,
- przyznaje dostep po 4-cyfrowym kodzie albo po autoryzowanym tagu RFID,
- pokazuje operatorowi aktualny stan systemu, kolejke polecen do urzadzenia i logi,
- utrzymuje komunikacje realtime miedzy urzadzeniem, backendem i panelem.

Wazna uwaga o aktualnym etapie firmware:

- backend i panel obsluguja logiczne akcje otwierania skrytek,
- obecny firmware testowy nie ma jeszcze skonfigurowanych wyjsc przekaznikowych do fizycznego sterowania zamkami,
- polecenia `OPEN_LOCKER` i `RELEASE_ALL_LOCKERS` sa obecnie potwierdzane przez firmware, ale nie zalaczaja realnego wyjscia zamka.

## Glowne funkcjonalnosci

### Zaimplementowane w kodzie

- obsluga 3 skrytek z numerami `1..3`,
- generowanie 4-cyfrowych kodow dostepu z czasem waznosci `2/4/6/8/12/24 h`,
- automatyczna dezaktywacja kodu po poprawnym uzyciu,
- opcjonalna wysylka wygenerowanego kodu e-mailem przez Brevo API albo SMTP,
- sesyjne logowanie do panelu WWW,
- role panelowe: `master`, `admin`, `operator`, `viewer`,
- zarzadzanie uzytkownikami RFID i przypisaniem ich do skrytek,
- zarzadzanie przedmiotami RFID i mapowaniem UID na czytelne nazwy,
- specjalne typy tagow RFID `klucz_master` i `karta_master`,
- tryb nadawania tagu RFID przez master reader,
- odroznienie RFID dostepowego od RFID obecnosci przedmiotu w skrytce,
- logi systemowe z filtrowaniem, eksportem CSV i czyszczeniem,
- eksport backupu JSON z poziomu panelu,
- alerty operacyjne na podstawie stanu skrytek, bazy i heartbeat urzadzenia,
- realtime do panelu przez Socket.IO,
- osobny WebSocket urzadzenia ESP32 na `/device/ws`,
- fallback HTTP dla ESP32: heartbeat, sync i polling polecen,
- kolejkowanie polecen do urzadzenia w MongoDB wraz z potwierdzeniami,
- idempotentna obsluga wiadomosci urzadzenia przez `messageId`,
- raportowanie stanu skrytek batchami z numeracja wersji,
- obsluga klawiatury 4x4,
- obsluga 4 czytnikow RFID RC522: 3 skrytkowych i 1 master,
- obsluga paska ARGB WS2812B jako interfejsu statusu,
- opcjonalna obsluga wejsc stanu drzwi / zamka w firmware,
- opcjonalna integracja Discord: slash commands i powiadomienia o logach.

### Obecne ograniczenia

- aktualnie serwowany panel to statyczny frontend z `software/public`, nie kompletny pipeline React/Vite,
- w repo jest katalog `software/dist`, ale backend go nie serwuje i nie ma aktualnego skryptu build odtwarzajacego ten artefakt,
- firmware w `hardware/safekeys/src/main.cpp` ma wpisane stale konfiguracyjne WiFi i backendu bezposrednio w kodzie,
- firmware testowy nie steruje jeszcze fizycznym przekaznikiem / ryglem skrytki.

### Planned / TODO

Sekcja planowanych prac znajduje sie na koncu README. Nie traktuj jej jako listy funkcji gotowych.

## Architektura systemu

### Warstwy

- `Hardware / Firmware ESP32`
  - czytniki RFID skrytek wykrywaja obecnosc przedmiotow,
  - master reader sluzy do autoryzacji RFID i programowania nowych tagow,
  - klawiatura przyjmuje kody i wybory skrytek,
  - pasek ARGB sygnalizuje stan,
  - firmware wysyla heartbeat i stan skrytek do backendu.
- `Backend`
  - Express udostepnia REST API,
  - Socket.IO obsluguje panel operatorski,
  - `ws` obsluguje osobny kanal WebSocket dla ESP32,
  - Mongoose zapisuje kody, logi, stan urzadzenia, uzytkownikow i polecenia.
- `Frontend / Panel`
  - statyczny panel HTML/CSS/JS jest serwowany przez Express,
  - po zalogowaniu pobiera dane z API i nasluchuje zdarzen Socket.IO.
- `Database / Persistence`
  - MongoDB przechowuje wszystkie encje runtime,
  - nie ma osobnego systemu migracji.

### Diagram tekstowy

```text
ESP32 Hardware
  -> keypad 4x4 / RFID RC522 / WS2812B / opcjonalne wejscia drzwi-zamka
  -> WebSocket / HTTP fallback

Backend (Express + Socket.IO + ws)
  -> auth sesyjne
  -> API i logika skrytek
  -> kolejka polecen do urzadzenia
  -> MongoDB

Frontend Panel
  -> dashboard realtime
  -> zarzadzanie RFID i kontami
  -> logi / alerty / backup
```

## Struktura katalogow

Pominieto `node_modules`, `dist`, `.git`, `.pio` i inne artefakty builda.

```text
/
  hardware/
    esp32/                 - starszy szkic debugowy dla Arduino IDE
      README.md
      SafeKeysESP32.ino
    safekeys/              - glowny projekt firmware PlatformIO
      include/             - katalog standardowy PlatformIO
      lib/                 - biblioteki lokalne PlatformIO (obecnie puste)
      src/
        main.cpp           - aktywny firmware ESP32
      test/                - katalog testow PlatformIO
      variants/
        main_v2.cpp        - starszy wariant firmware
      platformio.ini       - konfiguracja builda i bibliotek
  software/
    public/                - aktualnie serwowany panel WWW
      assets/
      app.js
      index.html
      styles.css
    server/                - backend Express + protokol urzadzenia
      bot/                 - opcjonalna integracja Discord
      models/              - schematy Mongoose
      services/            - logika biznesowa, walidacja i WebSocket device
      index.js             - entrypoint backendu
    test/                  - testy Node.js
    .env.example           - przykladowe zmienne srodowiskowe
    package.json           - skrypty backendu
  package.json             - skrypty pomocnicze na poziomie repo
  README.md
```

### Co warto wiedziec o strukturze

- brak osobnego katalogu `docs`; aktualna dokumentacja mieszka glownie w tym pliku i komentarzach w firmware,
- brak plikow CAD / PCB / STL / STEP w repozytorium,
- `software/dist/` istnieje, ale jest artefaktem builda i nie jest aktualnie uzywany przez backend,
- `hardware/esp32/` i `hardware/safekeys/variants/` to starsze warianty pomocnicze, nie glowna linia firmware.

## Backend

### Technologia

- Node.js `>=20`,
- Express 5,
- Socket.IO,
- `ws` dla WebSocketu urzadzenia,
- MongoDB + Mongoose,
- `express-session` dla sesji panelu,
- opcjonalnie `discord.js`,
- opcjonalnie `nodemailer` / Brevo API.

### Glowne pliki

- `software/server/index.js` - start serwera, middleware, routing HTTP, Socket.IO i bootstrap integracji,
- `software/server/services/lockerService.js` - glowna logika biznesowa,
- `software/server/services/deviceWebSocketTransport.js` - transport WebSocket dla ESP32,
- `software/server/services/deviceProtocol.js` - kontrakty protokolu urzadzenia,
- `software/server/services/panelUserService.js` - konta panelowe i role,
- `software/server/models/index.js` - schematy danych.

### Jak uruchomic

Z katalogu glownego:

```bash
npm start
```

albo bezposrednio:

```bash
cd software
npm start
```

Serwer domyslnie startuje na `0.0.0.0:3000`.

### Zmienne srodowiskowe backendu

Minimalnie wymagane do startu:

- `MONGODB_URI` - polaczenie do MongoDB,
- `SESSION_SECRET` - sekret sesji,
- co najmniej jeden zestaw `ADMIN_*` do seedowania pierwszych kont panelu, jesli baza jest pusta.

Rekomendowane:

- `DEVICE_API_KEY` - wspolny klucz urzadzenia dla HTTP i WebSocket,
- `PORT`, `HOST`,
- zmienne heartbeat / retransmisji dla ESP32,
- konfiguracja e-mail,
- konfiguracja Discord, jesli bot ma byc wlaczony.

### Najwazniejsze grupy endpointow API

#### Auth

- `GET /auth/session`
- `POST /auth/login`
- `POST /auth/logout`

#### Operacje panelu / skrytek

- `POST /generate-code`
- `POST /deactivate-code`
- `POST /open-locker`
- `POST /release-all-lockers`
- `GET /lockers`
- `GET /active-codes`
- `GET /system-status`
- `GET /alerts`

#### RFID i konfiguracja dostepu

- `GET /users`
- `POST /users`
- `PUT /users/:userId`
- `DELETE /users/:userId`
- `GET /rfid-items`
- `POST /rfid-items`
- `PUT /rfid-items/:itemId`
- `DELETE /rfid-items/:itemId`
- `GET /rfid-items/tag-assignment`
- `POST /rfid-items/tag-assignment/start`
- `POST /rfid-items/tag-assignment/cancel`

#### Konta panelowe

- `GET /panel-users`
- `POST /panel-users`
- `PUT /panel-users/:userId`
- `DELETE /panel-users/:userId`

#### Monitoring i eksport

- `GET /logs`
- `GET /logs/events`
- `GET /logs/export`
- `POST /logs/clear`
- `GET /export/backup`
- `GET /device/actions/history`

#### Endpointy urzadzenia / kompatybilnosci

- `POST /verify-code`
- `POST /verify-tag`
- `POST /locker-status`
- `POST /locker-door-status`
- `POST /device/heartbeat`
- `POST /device/sync`
- `POST /device/tag-assignment-result`
- `GET /device/actions`
- `POST /device/actions/ack`

### WebSocket i zdarzenia realtime

#### Panel operatorski

Panel laczy sie przez Socket.IO i po uwierzytelnieniu odbiera miedzy innymi:

- `new-log`
- `logs-cleared`
- `active-codes-changed`
- `locker-status-changed`
- `rfid-tag-assignment-updated`
- `remote-action-queued`
- `remote-action-updated`
- `system-status`

#### Urzadzenie ESP32

Backend wystawia osobny WebSocket:

- sciezka domyslna: `/device/ws`
- autoryzacja: naglowek `x-device-key`
- `deviceId` przekazywany w query string

Backend wysyla do ESP32:

- `server.hello`
- `commands`

ESP32 wysyla do backendu:

- `hello`
- `heartbeat`
- `state.batch`
- `code.verify`
- `tag.verify`
- `access.selection`
- `command.ack`
- `tag.assignment.result`

### Przechowywanie danych

Backend zapisuje dane w MongoDB. Najwazniejsze kolekcje opisano w sekcji "Model danych / glowne encje".

## Frontend / Panel webowy

### Aktualna technologia

Aktualnie uzywany frontend to:

- `software/public/index.html`
- `software/public/styles.css`
- `software/public/app.js`

Jest to statyczny panel HTML/CSS/Vanilla JS, serwowany przez Express. Nie ma w aktualnym `software/package.json` osobnego skryptu `dev` ani `build` dla tego panelu.

### Co z React / Vite

W repo znajduje sie katalog `software/dist/` zawierajacy artefakty builda SPA z `client-assets`, a w lokalnym `node_modules` widac zaleznosci React/Vite. Jednoczesnie:

- backend w `software/server/index.js` serwuje tylko `software/public`,
- w repo brak aktualnych zrodel tej wersji React oraz brak skryptu build w `software/package.json`,
- dlatego `software/dist` nalezy traktowac jako artefakt pomocniczy / historyczny, a nie aktywny frontend produkcyjny.

### Jak uruchomic frontend lokalnie

Nie ma osobnego dev servera frontendu. Panel startuje razem z backendem:

```bash
cd software
npm start
```

Po starcie otworz:

```text
http://localhost:3000
```

### Glowne widoki panelu

- `Dashboard`
  - generowanie kodow,
  - szybki podglad skrytek,
  - alerty,
  - stan systemu,
  - aktywne kody,
  - kolejka polecen do ESP32,
  - logi systemowe.
- `Uzytkownicy RFID`
  - lista uzytkownikow RFID,
  - przypisywanie skrytek,
  - wyszukiwanie i edycja.
- `Przedmioty RFID`
  - lista znanych tagow przedmiotow,
  - nadawanie tagu przez master reader,
  - typy zwykle i master.
- `Uzytkownicy panelu`
  - tylko dla roli `master`,
  - tworzenie i edycja kont panelowych,
  - eksport backupu JSON.

### Role i uprawnienia w panelu

- `master` - pelna administracja, w tym konta panelowe i tagi master,
- `admin` - zarzadzanie RFID i podstawowa administracja,
- `operator` - operacje robocze, np. generowanie kodow i otwieranie,
- `viewer` - podglad bez zmian konfiguracji.

## Hardware / Firmware ESP32

### Glowna platforma

Glowny firmware znajduje sie w:

- `hardware/safekeys/src/main.cpp`

Projekt budowany jest przez PlatformIO z konfiguracji:

- `hardware/safekeys/platformio.ini`

Srodowisko builda:

- `platform = espressif32`
- `board = esp32dev`
- `framework = arduino`

### Glowne komponenty obslugiwane przez aktywny firmware

- ESP32,
- keypad 4x4 po I2C,
- pasek ARGB WS2812B,
- 3 czytniki RFID RC522 dla skrytek,
- 1 czytnik RFID RC522 master,
- opcjonalne wejscia `doorClosed` i `lockClosed` dla 3 skrytek,
- dioda statusowa LED,
- WiFi,
- WebSocket i HTTPS do backendu.

### Komponenty, ktorych jeszcze nie ma w praktycznej obsludze

- fizyczne wyjscia przekaznikowe / tranzystorowe do otwierania zamkow nie sa skonfigurowane w aktualnym `main.cpp`,
- dlatego firmware przyjmuje komendy otwarcia, ale ich nie wykonuje na sprzecie.

### Glowny plik firmware i warianty

- `hardware/safekeys/src/main.cpp` - aktywny wariant v3 / testowy WebSocket,
- `hardware/safekeys/variants/main_v2.cpp` - starszy wariant v2,
- `hardware/esp32/SafeKeysESP32.ino` - minimalny szkic debugowy pod Arduino IDE.

### Pinout

Pinout glownego firmware da sie odczytac bezposrednio z `hardware/safekeys/src/main.cpp`.

| Funkcja | Pin / wartosc |
| --- | --- |
| LED statusowa | `LED_BUILTIN` albo `2` |
| I2C SDA | `21` |
| I2C SCL | `22` |
| Adres keypada I2C | `0x20` |
| WS2812B data | `4` |
| Liczba LED | `60` |
| LED na skrytke | `20` |
| SPI SCK dla RC522 | `14` |
| SPI MISO dla RC522 | `12` |
| SPI MOSI dla RC522 | `13` |
| RC522 RST | `15` |
| RC522 skrytka 1 SS | `5` |
| RC522 skrytka 2 SS | `16` |
| RC522 skrytka 3 SS | `17` |
| RC522 master SS | `32` |
| Wejscie `doorClosed` skrytka 1 | `18` |
| Wejscie `lockClosed` skrytka 1 | `19` |
| Wejscie `doorClosed` skrytka 2 | `23` |
| Wejscie `lockClosed` skrytka 2 | `25` |
| Wejscie `doorClosed` skrytka 3 | `26` |
| Wejscie `lockClosed` skrytka 3 | `27` |

Uwaga:

- wejscia stanu drzwi / zamka sa zdefiniowane, ale ich obsluga jest domyslnie wylaczona przez `ENABLE_LOCKER_SWITCH_INPUTS = false`,
- pinow wyjsc do sterowania zamkami obecny firmware nie definiuje.

### Biblioteki firmware

Z `platformio.ini`:

- `bblanchon/ArduinoJson`
- `adafruit/Adafruit NeoPixel`
- `robtillaart/PCF8574`
- `robtillaart/I2CKeyPad`
- `miguelbalboa/MFRC522`
- `links2004/WebSockets`

### Konfiguracja firmware

W aktywnym `main.cpp` konfiguracja jest zapisana stale w kodzie, m.in.:

- `WIFI_SSID`
- `WIFI_PASSWORD`
- `API_BASE_URL`
- `DEVICE_API_KEY`
- `DEVICE_ID`
- `DEVICE_WS_HOST`
- `DEVICE_WS_PORT`
- `DEVICE_WS_PATH`

To oznacza, ze przed buildem trzeba edytowac plik zrodlowy. Z perspektywy bezpieczenstwa i utrzymania jest to obszar do poprawy.

### Jak kompilowac i wgrywac

```bash
cd hardware/safekeys
pio run
pio run -t upload
pio device monitor -b 115200
```

## Komunikacja ESP32 <-> Backend

### Model komunikacji

Aktualny firmware probuje pracowac przede wszystkim po WebSocket, a HTTP sluzy jako fallback i kompatybilnosc wsteczna.

### WebSocket

Firmware utrzymuje stale polaczenie z:

- hostem `DEVICE_WS_HOST`,
- portem `DEVICE_WS_PORT`,
- sciezka `DEVICE_WS_PATH`, np. `/device/ws?deviceId=esp32-main`.

Po polaczeniu:

- backend wysyla `server.hello` z `resyncRequired`,
- firmware wysyla `hello`,
- potem cyklicznie wysyla `heartbeat`,
- stan skrytek jest wysylany jako `state.batch`,
- backend moze dostarczyc kolejke komend w komunikacie `commands`.

### Heartbeat

Firmware buduje heartbeat z danymi:

- `deviceId`
- `bootId`
- `protocolVersion`
- `firmware`
- `ip`
- `wifiRssi`
- `uptimeMs`
- `freeHeap`
- `minFreeHeap`
- `lockersWithTags`
- `masterReaderPresent`
- `networkFailureCount`
- zrzut skrytek

Domyslny interwal heartbeat w firmware to `60000 ms`.

### Synchronizacja stanu

Stan skrytek idzie batchami jako `state.batch`:

- pelny snapshot po reconnect lub wymuszonym resync,
- delta po zmianach RFID / wejsc,
- per skrytka przesylane sa `locker`, `hasTag`, `tagId`, `doorClosed`, `lockClosed`, `version`.

Backend:

- porownuje `version`,
- zapisuje stan do MongoDB,
- emituje `locker-status-changed`,
- zapisuje logi typu `KEY_REMOVED`, `KEY_RETURNED`, `LOCKER_DOOR_OPENED`, `LOCKER_DOOR_CLOSED`,
- zapamietuje receipts po `messageId`, dzieki czemu te same wiadomosci sa idempotentne.

### HTTP fallback

Firmware korzysta tez z:

- `POST /device/heartbeat`
- `POST /device/sync`
- `GET /device/actions`
- `POST /device/actions/ack`
- `POST /verify-code`
- `POST /verify-tag`
- `POST /locker-status`

Znaczenie:

- `/device/sync` przenosi te same typy wiadomosci co WebSocket,
- `/device/actions` sluzy jako polling kolejki, gdy WebSocket nie dziala,
- `/locker-status` zostal zachowany jako starszy fallback dla raportu skrytek.

### Obsluga bledow i reconnectow

W firmware sa zaimplementowane:

- ping/pong WebSocket,
- timeout i ponowne laczenie WebSocket z backoffem,
- fallback z WebSocket do HTTPS,
- kolejkowanie zadan sieciowych,
- wykrywanie wielu kolejnych bledow sieci i proba spokojnego reconnectu WiFi,
- retry `state.batch` z eskalacja do pelnego resync.

### Weryfikacja kodu i RFID

- kod z klawiatury jest wysylany jako `code.verify` albo przez `POST /verify-code`,
- tag master / uzytkownika jest weryfikowany jako `tag.verify` albo przez `POST /verify-tag`,
- po poprawnej odpowiedzi RFID firmware uruchamia lokalna sesje wyboru skrytki,
- klawisze `1..3` wybieraja jedna skrytke, `#` prosi o otwarcie wszystkich dostepnych, `*` anuluje sesje.

## Zmienne srodowiskowe

### Backend i baza

- `MONGODB_URI` - adres polaczenia MongoDB. Wymagany.
- `PORT` - port HTTP serwera. Domyslnie `3000`.
- `HOST` - adres bindowania serwera. Domyslnie `0.0.0.0`.
- `SESSION_SECRET` - sekret sesji Express. Wymagany.

### Urzadzenie ESP32 / protokol

- `DEVICE_API_KEY` - wspolny klucz autoryzacyjny urzadzenia.
- `DEVICE_ID` - domyslny identyfikator urzadzenia, np. `esp32-main`.
- `DEVICE_WS_PATH` - sciezka WebSocketu urzadzenia. Domyslnie `/device/ws`.
- `DEVICE_HEARTBEAT_TIMEOUT_MS` - po jakim czasie brak heartbeat oznacza offline.
- `DEVICE_COMMAND_REDELIVER_AFTER_MS` - po jakim czasie backend moze ponownie dostarczyc polecenie.
- `DEVICE_COMMAND_DELIVERY_LIMIT` - limit komend w jednej dostawie.
- `DEVICE_WS_PING_INTERVAL_MS` - interwal pingow serwera do urzadzenia.

### Seeding pierwszych kont panelu

Uzywane tylko wtedy, gdy kolekcja `PanelUser` jest pusta:

- `ADMIN_1_USERNAME`
- `ADMIN_1_PASSWORD`
- `ADMIN_1_DISPLAY_NAME`
- `ADMIN_2_USERNAME`
- `ADMIN_2_PASSWORD`
- `ADMIN_2_DISPLAY_NAME`
- `ADMIN_3_USERNAME`
- `ADMIN_3_PASSWORD`
- `ADMIN_3_DISPLAY_NAME`

### Discord

- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`
- `DISCORD_NOTIFICATIONS_CHANNEL_ID`

Jesli `DISCORD_BOT_TOKEN` albo `DISCORD_CLIENT_ID` nie sa ustawione, integracja Discord jest pomijana.

### E-mail / Brevo / SMTP

- `BREVO_API_KEY` - rekomendowany sposob wysylki przez HTTPS.
- `SMTP_FROM_EMAIL` - adres nadawcy.
- `SMTP_FROM_NAME` - nazwa nadawcy.
- `SMTP_REPLY_TO` - opcjonalny reply-to.
- `SMTP_HOST` - host SMTP.
- `SMTP_PORT` - port SMTP.
- `SMTP_SECURE` - `true` / `false`.
- `SMTP_USER` - login SMTP.
- `SMTP_PASS` - haslo / klucz SMTP.

## Instalacja i uruchomienie lokalne

### 1. Klonowanie repozytorium

```bash
git clone <URL_REPOZYTORIUM>
cd locker-system
```

### 2. Instalacja zaleznosci backendu

Aktualne skrypty znajduja sie w `software/package.json`.

```bash
cd software
npm ci
```

Alternatywnie z katalogu glownego:

```bash
npm --prefix software ci
```

### 3. Konfiguracja `.env`

```bash
cp software/.env.example software/.env
```

Nastepnie uzupelnij przynajmniej:

- `MONGODB_URI`
- `SESSION_SECRET`
- `DEVICE_API_KEY`
- `ADMIN_1_*`

### 4. Uruchomienie backendu i panelu

Z poziomu `software`:

```bash
npm start
```

albo z root repo:

```bash
npm start
```

Po starcie panel jest dostepny pod:

```text
http://localhost:3000
```

### 5. Testy backendu

```bash
cd software
npm test
```

Aktualnie testy obejmuja warstwe protokolu urzadzenia.

### 6. Frontend

W aktualnym stanie repo nie uruchamia sie osobnego dev servera frontendu. Panel jest serwowany statycznie przez Express.

## Build produkcyjny

### Jak to dziala obecnie

Aktualny runtime produkcyjny nie ma odrebnego procesu bundlowania panelu:

- Express serwuje `software/public`,
- `software/public/index.html` laduje `app.js` i `styles.css`,
- uruchomienie produkcyjne to po prostu start backendu z poprawnym `.env`.

### Jak uruchomic produkcyjnie

```bash
cd software
npm ci
npm start
```

albo z katalogu glownego:

```bash
npm start
```

### Wazna uwaga o skrypcie `build`

W katalogu glownym jest skrypt:

```bash
npm run build
```

ale jego aktualne dzialanie to:

```bash
npm --prefix software ci
```

Czyli:

- ten skrypt nie buduje frontendu,
- wykonuje jedynie czysta instalacje zaleznosci w `software/`.

Jesli chcesz miec prawdziwy pipeline build SPA, trzeba go dopiero uzupelnic albo przywrocic brakujace zrodla i skrypty dla wariantu z `software/dist`.

## Firmware upload

### Wymagane narzedzia

- PlatformIO Core albo rozszerzenie PlatformIO dla VS Code,
- sterownik i dostep do portu USB ESP32.

### Build

```bash
cd hardware/safekeys
pio run
```

### Upload

```bash
pio run -t upload
```

Jesli trzeba, dopisz `upload_port` w `platformio.ini` albo podaj port z CLI.

### Monitor serial

```bash
pio device monitor -b 115200
```

### Co skonfigurowac przed wgraniem

W `hardware/safekeys/src/main.cpp` sprawdz i zmien:

- `WIFI_SSID`
- `WIFI_PASSWORD`
- `API_BASE_URL`
- `DEVICE_API_KEY`
- `DEVICE_ID`
- `DEVICE_WS_HOST`
- `DEVICE_WS_PORT`
- `DEVICE_WS_PATH`

Wazne:

- `DEVICE_API_KEY` musi zgadzac sie z backendem,
- obecnie firmware korzysta z `secureClient.setInsecure()`, co upraszcza testy, ale nie jest najlepsza praktyka produkcyjna.

## Model danych / glowne encje

### `PanelUser`

Uzytkownik panelu operatorskiego:

- `username`
- `displayName`
- `passwordHash`
- `role`
- `active`

### `RfidUser`

Osoba / uzytkownik obslugiwany tagiem RFID:

- `name`
- `tagId`
- `allowedLockers`
- `active`

### `RfidItem`

Znany przedmiot lub karta RFID rozpoznawana przez system:

- `name`
- `tagId`
- `itemType`
- `active`

`itemType` moze byc zwykly albo administracyjny:

- `brelok`
- `karta`
- `inne`
- `klucz_master`
- `karta_master`

### `Locker`

Stan biezacy skrytki:

- `locker`
- `hasTag`
- `isDoorClosed`
- `detectedTagId`
- `detectedItemName`
- `detectedItemType`
- `detectedItemKnown`
- `detectedAt`

### `Code`

Jednorazowy kod dostepu:

- `code`
- `locker`
- `active`
- `expiresAt`
- `recipientEmail`
- status proby wysylki e-mail

### `Log`

Zdarzenie systemowe:

- `event`
- `locker`
- `code`
- `tagId`
- `itemName`
- `recipientEmail`
- `source`
- `actor`
- `success`
- `details`
- `timestamp`

### `DeviceCommand`

Polecenie do urzadzenia:

- `type`
- `locker`
- `payload`
- `status`
- `deliveryCount`
- `deliveries`
- `result`

Typy komend obecne w modelu:

- `OPEN_LOCKER`
- `RELEASE_ALL_LOCKERS`
- `ASSIGN_RFID_TAG`
- `CANCEL_RFID_TAG_ASSIGNMENT`

### `DeviceState`

Stan ostatnio widzianego urzadzenia:

- `deviceId`
- `connected`
- `transport`
- `bootId`
- `lastSeenAt`
- `pingMs`
- `wifiRssi`
- `firmware`
- `networkFailureCount`
- `lockers[]`

### `DeviceMessageReceipt`

Pomocnicza kolekcja potwierdzen do idempotentnej obslugi wiadomosci z ESP32:

- `messageId`
- `deviceId`
- `type`
- `sequence`
- `status`
- `response`

## Workflow uzytkownika

### Przyklad 1: kod dostepu

1. Operator loguje sie do panelu.
2. Wybiera skrytke i czas waznosci.
3. Backend generuje unikalny kod 4-cyfrowy i zapisuje go w MongoDB.
4. Opcjonalnie backend probuje wyslac kod e-mailem.
5. Kod pojawia sie na liscie aktywnych kodow i w logach.
6. Uzytkownik wpisuje kod na klawiaturze przy ESP32.
7. ESP32 wysyla `code.verify` do backendu.
8. Backend weryfikuje kod, dezaktywuje go i zapisuje log `LOCKER_OPENED`.
9. Firmware sygnalizuje wynik lokalnie LED/UART.

Uwaga:

- obecny firmware nie zalacza jeszcze fizycznego wyjscia otwarcia zamka po poprawnym kodzie.

### Przyklad 2: dostep RFID

1. Administrator dodaje `RfidUser` i przypisuje mu skrytki.
2. Uzytkownik przyklada tag do master readera.
3. ESP32 wysyla `tag.verify`.
4. Backend zwraca, czy tag jest prawidlowy, czy jest masterem i jakie ma dostepy.
5. Firmware rozpoczyna lokalna sesje wyboru skrytki.
6. Klawisz `1..3` wybiera jedna skrytke, `#` prosi o wszystkie dostepne, `*` anuluje.
7. ESP32 wysyla `access.selection`.
8. Backend loguje zdarzenie i wrzuca komendy `OPEN_LOCKER` do kolejki.
9. Panel dostaje aktualizacje realtime i pokazuje polecenia / logi.

### Przyklad 3: nadanie nowego taga RFID

1. Administrator w panelu wybiera "Nadaj tag".
2. Backend tworzy zadanie `ASSIGN_RFID_TAG` i losuje logiczny `tagId`.
3. ESP32 odbiera komenda i wlacza tryb programowania na master readerze.
4. Po przylozeniu karty firmware zapisuje identyfikator w bloku aplikacyjnym MIFARE.
5. ESP32 odsyla `tag.assignment.result`.
6. Panel i logi pokazuja wynik operacji.

## Troubleshooting

### ESP32 nie laczy sie z WiFi

Sprawdz:

- czy `WIFI_SSID` i `WIFI_PASSWORD` w `hardware/safekeys/src/main.cpp` sa poprawne,
- logi z `pio device monitor -b 115200`,
- czy zasilanie ESP32 i czytnikow RFID jest stabilne,
- czy firmware nie wszedl w backoff po wielu bledach sieci.

### WebSocket zbyt czesto reconnectuje

Sprawdz:

- zgodnosc `DEVICE_API_KEY` miedzy backendem i firmware,
- czy `DEVICE_WS_PATH` po stronie firmware zgadza sie z backendem,
- jak wyglada `WiFi.RSSI` i licznik `networkFailureCount`,
- czy serwer odpowiada pod `/device/ws`,
- czy po drodze nie ma reverse proxy ubijajacego polaczenie.

### RFID nie wykrywa tagu

Sprawdz:

- piny SPI i piny `SS`,
- zasilanie RC522,
- logi typu `MFRC522 version`,
- czy karta jest kompatybilna z RC522 / MIFARE,
- czy master reader nie jest akurat w trybie nadawania taga.

### Zamek nie dziala

To obecnie oczekiwane zachowanie aktualnego firmware testowego:

- komendy otwarcia sa logowane i potwierdzane,
- ale `main.cpp` nie ma jeszcze skonfigurowanych wyjsc sterujacych zamkiem / przekaznikiem.

Jesli chcesz fizycznie otwierac skrytki, trzeba dopisac warstwe wyjsc sprzetowych w firmware.

### Panel nie pokazuje aktualnego statusu

Sprawdz:

- czy backend dziala i odpowiada na `/system-status` oraz `/lockers`,
- czy zalogowana sesja jest aktywna,
- czy Socket.IO laczy sie poprawnie,
- czy ESP32 wysyla heartbeat i `state.batch`.

### Frontend nie buduje sie

Aktualny stan repo nie zawiera kompletnego, odtwarzalnego pipeline build panelu. Jesli probujesz budowac `software/dist`, pamietaj, ze:

- backend nie serwuje `dist`,
- `software/package.json` nie ma skryptu `build`,
- aktywny panel to `software/public`.

### Backend nie startuje

Najczestsze przyczyny:

- brak `MONGODB_URI`,
- brak `SESSION_SECRET`,
- pusta kolekcja `PanelUser` i brak danych `ADMIN_*`,
- niedostepne MongoDB,
- bledna konfiguracja `.env`.

### Brak logow / brak polecen do ESP32

Sprawdz:

- czy `DeviceCommand` dostaje wpisy po akcjach z panelu,
- czy `/device/actions/history` pokazuje kolejke,
- czy ESP32 odbiera `commands` po WebSocket albo polluje `/device/actions`,
- czy potwierdzenia `command.ack` wracaja poprawnie.

## Development notes

### Gdzie rozwijac backend

- nowe endpointy dodawaj w `software/server/index.js`,
- logike biznesowa dopisuj w `software/server/services/lockerService.js`,
- walidacje danych trzymaj w `software/server/services/lockerValidation.js`,
- zmiany schematow wprowadzaj w `software/server/models/index.js`.

### Gdzie rozwijac frontend

- aktualnie aktywny panel edytuj w `software/public/index.html`, `software/public/app.js` i `software/public/styles.css`,
- jesli chcesz przywrocic pipeline React/Vite, najpierw uporzadkuj stan `software/dist` i dodaj zrodla + skrypty build.

### Gdzie rozwijac firmware

- glowna linia: `hardware/safekeys/src/main.cpp`,
- starsze warianty traktuj jako referencje, nie jako zrodlo prawdy.

### Jak testowac zmiany

- backend: `cd software && npm test`,
- API: testuj przez panel oraz bezposrednio przez REST,
- firmware: `pio device monitor -b 115200` i obserwacja heartbeat / state batch / RFID.

### Dobre praktyki dla dalszego rozwoju

- nie blokuj firmware dlugimi `delay()` w glownym `loop()`,
- korzystaj z kolejki zadan sieciowych i juz istniejacego modelu retry,
- nie zapisuj nowych sekretow bezposrednio w repo,
- nie omijaj `messageId` i `version` w protokole urzadzenia,
- utrzymuj rozdzial: transport urzadzenia w `deviceWebSocketTransport.js`, kontrakt w `deviceProtocol.js`, logika domenowa w `lockerService.js`.

## Roadmap / TODO

Planowane kierunki rozwoju, nie funkcje gotowe:

- dodanie realnych wyjsc do sterowania zamkami / przekaznikami,
- przeniesienie konfiguracji WiFi i kluczy firmware poza kod zrodlowy,
- dopracowanie produkcyjnego pipeline frontendowego i decyzja: `public` albo React/Vite,
- rozszerzenie testow automatycznych poza `deviceProtocol`,
- stabilizacja i obserwowalnosc kanalu WebSocket,
- lepsza klasyfikacja i agregacja alertow,
- role / audyt bardziej szczegolowy po stronie panelu,
- OTA dla firmware ESP32,
- dokumentacja elektryczna / PCB / obudowa 3D,
- czyszczenie starszych wariantow i artefaktow repo.

## License / author

- Projekt: `SafeKeys`
- Autor: Karol / wlasciciel repozytorium
- License: TODO

Uwaga:

- w `software/package.json` widnieje pole `license: ISC`,
- ale w repozytorium nie ma pliku `LICENSE`,
- przed publiczna dystrybucja warto to jednoznacznie uporzadkowac.
