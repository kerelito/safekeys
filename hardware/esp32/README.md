# SafeKeys ESP32 Debug

Aktualny szkic w [SafeKeysESP32.ino](/Users/karol/Projects/locker-system/hardware/esp32/SafeKeysESP32.ino:1) jest przygotowany jako prosty wariant debugowy pod:

- ESP32 z wbudowana dioda LED
- klawiature 4x4
- polaczenie z backendem SafeKeys przez `https://www.safekeys.pl/verify-code`

## Co robi ten wariant

- laczy sie z Wi-Fi
- przyjmuje 4-cyfrowy kod z klawiatury
- wysyla go do backendu
- wypisuje pelny przebieg do `Serial`
- pokazuje stan na diodzie LED

## Zachowanie LED

- podczas laczenia z Wi-Fi: pojedyncze krotkie migniecia
- po udanym polaczeniu: 2 spokojne migniecia
- przy kazdym nacisnieciu klawisza: krotki impuls
- przy poprawnym kodzie: 2 dluzsze migniecia
- przy blednym kodzie: 4 migniecia
- przy bledzie sieci lub API: 5 szybkich migniec

## Co ustawic przed wgraniem

W pliku `.ino` podmien:

- `WIFI_SSID`
- `WIFI_PASSWORD`
- `API_BASE_URL`
- `DEVICE_API_KEY`
- `rowPins`
- `colPins`

Jesli Twoja plytka ma diode na innym pinie niz domyslny, zmien tez:

- `STATUS_LED_PIN`
- `STATUS_LED_ACTIVE_LEVEL`

## Obsluga klawiatury

- `0-9` dodaje cyfre do bufora
- `*` czysci bufor
- `#` wysyla 4-cyfrowy kod do backendu
- `A` wymusza ponowne laczenie z Wi-Fi
- `B` wypisuje aktualny status
- `C` wypisuje pomoc
- `D` robi szybki reset bufora

## Backend

Ten szkic zaklada, ze backend juz dziala i ma ustawione:

- `MONGODB_URI`
- `SESSION_SECRET`
- `DEVICE_API_KEY`
- `ADMIN_1_*`, `ADMIN_2_*`, `ADMIN_3_*`

Wazne:

- `DEVICE_API_KEY` w ESP32 musi byc taki sam jak `DEVICE_API_KEY` na serwerze
- endpoint `POST /verify-code` wymaga naglowka `x-device-key`
- publiczny adres produkcyjny systemu to `https://www.safekeys.pl`
- dla Railway szkic korzysta z `secureClient.setInsecure()` dla prostszego debugowania

## Biblioteki Arduino

Zainstaluj:

- `ArduinoJson`
- `Keypad`

## Dalszy krok

Kiedy potwierdzisz, ze klawiatura, LED i weryfikacja kodow dzialaja stabilnie, mozna na tej bazie z powrotem dolozyc:

- przekazniki
- czujniki drzwiczek
- czytniki RFID
- odbior zdalnych akcji z `/device/actions`
