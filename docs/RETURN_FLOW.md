# SafeKeys return flow

Ten dokument opisuje pelny przeplyw zwrotu przedmiotu RFID do przypisanej skrytki.

## Cel

Zwrot jest uruchamiany po przylozeniu do master readera tagu przedmiotu, ktory:

- istnieje w bazie jako `RfidItem`,
- ma `assignedLocker` ustawione na `1`, `2` albo `3`,
- ma status `CHECKED_OUT`.

Taki skan nie daje dostepu jak karta uzytkownika. Backend tworzy sesje zwrotu, wysyla do ESP32 komende `RETURN_ITEM`, a firmware otwiera docelowa skrytke i prowadzi lokalny tryb zwrotu.

## Statusy przedmiotu RFID

- `IN_LOCKER` - przedmiot jest w przypisanej skrytce.
- `CHECKED_OUT` - przedmiot zostal wydany i moze rozpoczac zwrot po skanie master readera.
- `RETURN_PENDING` - zwrot zostal przerwany albo wygasl; przedmiot nadal wymaga zwrotu.
- `RETURN_IN_PROGRESS` - trwa aktywna sesja zwrotu.
- `CONFLICT` - wykryto zly przedmiot, zla skrytke albo inna niespojnosc.
- `UNKNOWN` - stan nieznany.
- `UNASSIGNED` - przedmiot nie ma przypisanej skrytki i nie moze uruchomic zwrotu.

Tagi administracyjne `klucz_master` i `karta_master` nie sa traktowane jako zwracane przedmioty.

## Statusy sesji zwrotu

- `PENDING` - sesja utworzona, przed wyslaniem / uruchomieniem komendy.
- `IN_PROGRESS` - ESP32 ma aktywny tryb zwrotu.
- `COMPLETED` - wykryto oczekiwany tag w przypisanej skrytce i warunki zakonczenia zostaly spelnione.
- `FAILED` - wykryto blad, np. zly UID albo zla skrytke.
- `EXPIRED` - minelo okno czasu zwrotu.
- `CANCELLED` - operator anulowal sesje z panelu.

Domyslny timeout sesji to `120000 ms` (`RETURN_SESSION_TIMEOUT_MS`). Backend ogranicza zakres do `30000..300000 ms`.

## Backend

Nowe elementy danych:

- `RfidItem.assignedLocker`
- `RfidItem.status`
- `RfidItem.currentLocker`
- `RfidItem.lastDetectedAt`
- `RfidItem.conflictReason`
- kolekcja `ReturnSession`

Nowe API:

- `GET /returns` - aktywne i historyczne sesje, opcjonalnie `status=ACTIVE|HISTORY|...`.
- `GET /returns/summary` - liczniki dashboardu.
- `POST /returns/:sessionId/cancel` - anulowanie sesji.
- `POST /device/return-progress` - raport postepu z ESP32 dla fallback HTTP.

Nowe eventy Socket.IO:

- `rfid-item-changed`
- `return-session-changed`
- `return.started`
- `return.in_progress`
- `return.item_detected`
- `return.door_opened`
- `return.door_closed`
- `return.completed`
- `return.failed`
- `return.expired`

## Firmware ESP32

Nowe komendy z backendu:

- `RETURN_ITEM`
- `CANCEL_RETURN_ITEM`

`RETURN_ITEM` niesie m.in. `sessionId`, `expectedUid`, `assignedLocker`, `timeoutMs`, `holdLockUntilCompleted` i `requireDoorSensor`.

Firmware wysyla postep jako `return.progress` przez WebSocket urzadzenia, z fallbackiem HTTP przez `/device/sync`. Typowe eventy:

- `started`
- `lock_held`
- `item_detected`
- `door_opened`
- `door_closed`
- `completed`
- `failed`
- `timeout`

Domyslny impuls otwarcia zamka to `5000 ms`. Bez wlaczonych czujnikow drzwi zwrot konczy sie po wykryciu oczekiwanego UID w docelowym readerze. Po wlaczeniu czujnikow firmware moze trzymac zamek do wykrycia przedmiotu i zamkniecia drzwi albo do timeoutu/anulowania.

## Czujniki MC-38

Czujniki drzwi sa domyslnie wylaczone:

- backend: `ENABLE_DOOR_SENSORS=false`
- firmware: `ENABLE_DOOR_SENSORS = false`

Zalecane piny firmware dla trzech skrytek:

| Skrytka | GPIO |
| --- | --- |
| S1 | GPIO18 |
| S2 | GPIO19 |
| S3 | GPIO23 |

Wejscia pracuja jako `INPUT_PULLUP`, a stan zamkniety jest aktywny niskim poziomem (`DOOR_SENSOR_ACTIVE_LOW = true`), czyli zamkniety MC-38 zwiera wejscie do GND.

Wybrane GPIO omijaja piny RFID SPI/SS (`14`, `12`, `13`, `15`, `5`, `16`, `17`, `32`), relay (`27`, `26`, `25`, `33`), WS2812B (`4`), I2C (`21`, `22`) oraz typowe piny bootstrappingu.

## Konflikty i timeouty

- Skan przedmiotu bez `assignedLocker` ustawia / zostawia status `UNASSIGNED` i nie otwiera skrytki.
- Skan przedmiotu `IN_LOCKER` nie otwiera skrytki i loguje `RETURN_ITEM_ALREADY_IN_LOCKER`.
- Skan przedmiotu innego niz `CHECKED_OUT` nie rozpoczyna zwrotu.
- Obcy tag w docelowej skrytce powoduje `CONFLICT`.
- Wykrycie zwracanego tagu w zlej skrytce powoduje `CONFLICT`.
- Timeout lub anulowanie zostawia przedmiot w `RETURN_PENDING`, zeby operator mogl ponowic proces.

## Test manualny

1. Ustaw przedmiot RFID z `assignedLocker=1` i `status=CHECKED_OUT`.
2. Przyloz jego tag do master readera.
3. Sprawdz w panelu `Zwroty`, czy pojawila sie sesja `IN_PROGRESS`.
4. Sprawdz kolejke polecen, czy ESP32 dostalo `RETURN_ITEM` dla `S1`.
5. Odloz przedmiot do readera S1.
6. Bez czujnikow drzwi sesja powinna zakonczyc sie po wykryciu UID.
7. Z czujnikami drzwi sesja powinna zakonczyc sie dopiero po wykryciu UID i zamknieciu drzwi.
8. Sprawdz, czy przedmiot ma `status=IN_LOCKER`, `currentLocker=1` i odswiezony `lastDetectedAt`.

Testy automatyczne backendu:

```bash
cd software
npm test
```

Build firmware:

```bash
cd hardware/safekeys
platformio run
```
