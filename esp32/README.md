# SafeKeys ESP32

Gotowy szkic startowy dla ESP32 znajdziesz w [SafeKeysESP32.ino](/Users/karol/Projects/locker-system/esp32/SafeKeysESP32.ino:1).

## Co obsluguje

- Wi-Fi + polaczenie z backendem SafeKeys
- pobieranie zdalnych akcji z `GET /device/actions`
- otwieranie konkretnej skrytki
- zwolnienie wszystkich skrytek naraz
- raportowanie stanu RFID przez `POST /locker-status`
- raportowanie stanu kontraktonu przez `POST /locker-door-status`
- weryfikacje 4-cyfrowego kodu przez `POST /verify-code`
- weryfikacje uzytkownika RFID przez `POST /verify-tag`

## Zalozenia sprzetowe

- 3 przekazniki do zamkow
- docelowo 4 czytniki RFID po SPI:
  3 do sprawdzania obecnosci klucza w skrytkach
  1 dla uzytkownika przykladajacego swoja karte
- obecny szkic zostawia miejsce na podpiecie biblioteki czytnika i endpointu `/verify-tag`
- 3 wejscia cyfrowe dla informacji `isDoorClosed`
- klawiatura 4x4 do wpisywania kodu

## Co ustawic przed wgraniem

W pliku `.ino` podmien:

- `WIFI_SSID`
- `WIFI_PASSWORD`
- `API_BASE_URL`
- `DEVICE_API_KEY`
- piny przekaznikow, czujnikow i klawiatury
- poziomy aktywne `RELAY_ACTIVE_LEVEL`, `TAG_PRESENT_LEVEL`, `DOOR_CLOSED_LEVEL`

## Biblioteki Arduino

Zainstaluj:

- `ArduinoJson`
- `Keypad`

## Wazna uwaga

Jesli Twoj modul RFID nie daje prostego sygnalu HIGH/LOW, tylko trzeba czytac go po SPI/UART/I2C, to zamien funkcje `readTagPresent()` na wlasna implementacje dla konkretnego czytnika i wykorzystaj `verifyUserTagRemotely()` dla czytnika uzytkownika.
