#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Keypad.h>

/*
  SafeKeys ESP32 controller

  Assumptions:
  - 3 lockers
  - 3 relay outputs controlling electric locks
  - final hardware variant may use 4 SPI RFID readers:
    - 3 readers for locker key presence
    - 1 reader for user authentication
  - current sketch keeps simple digital placeholders for locker key presence
    and exposes backend support for user RFID verification through /verify-tag
  - 3 digital inputs for door-closed contact sensors
  - 4x4 keypad for entering 4-digit access codes

  Required libraries:
  - ArduinoJson
  - Keypad

  Notes:
  - For Railway HTTPS this sketch uses setInsecure() for simplicity.
    For production, replace with certificate pinning or a root CA cert.
  - If your RFID/tag detection hardware does not expose a simple HIGH/LOW pin,
    replace readTagPresent() with your actual reader logic.
*/

static const char* WIFI_SSID = "YOUR_WIFI_NAME";
static const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

static const char* API_BASE_URL = "https://safekeys-production-2760.up.railway.app";
static const char* DEVICE_API_KEY = "YOUR_DEVICE_API_KEY";

static const bool RELAY_ACTIVE_LEVEL = LOW;
static const bool TAG_PRESENT_LEVEL = LOW;
static const bool DOOR_CLOSED_LEVEL = LOW;

static const unsigned long RELAY_PULSE_MS = 1200;
static const unsigned long SERVER_POLL_MS = 2000;
static const unsigned long STATUS_SYNC_MS = 10000;
static const unsigned long WIFI_RETRY_MS = 5000;
static const unsigned long SENSOR_DEBOUNCE_MS = 80;

static const uint8_t LOCKER_COUNT = 3;
static const uint8_t RELAY_PINS[LOCKER_COUNT] = { 14, 27, 26 };
static const uint8_t TAG_SENSOR_PINS[LOCKER_COUNT] = { 34, 35, 32 };
static const uint8_t DOOR_SENSOR_PINS[LOCKER_COUNT] = { 33, 25, 13 };

const byte KEYPAD_ROWS = 4;
const byte KEYPAD_COLS = 4;
char keypadMap[KEYPAD_ROWS][KEYPAD_COLS] = {
  { '1', '2', '3', 'A' },
  { '4', '5', '6', 'B' },
  { '7', '8', '9', 'C' },
  { '*', '0', '#', 'D' }
};
byte rowPins[KEYPAD_ROWS] = { 23, 22, 21, 19 };
byte colPins[KEYPAD_COLS] = { 18, 5, 17, 16 };
Keypad keypad = Keypad(makeKeymap(keypadMap), rowPins, colPins, KEYPAD_ROWS, KEYPAD_COLS);

struct LockerState {
  bool hasTag;
  bool isDoorClosed;
  bool lastReportedHasTag;
  bool lastReportedDoorClosed;
  unsigned long lastTagChangeMs;
  unsigned long lastDoorChangeMs;
};

struct RelayPulse {
  bool active;
  unsigned long startedAt;
};

LockerState lockers[LOCKER_COUNT];
RelayPulse relayPulses[LOCKER_COUNT];

WiFiClientSecure secureClient;
String enteredCode;

unsigned long lastServerPollMs = 0;
unsigned long lastStatusSyncMs = 0;
unsigned long lastWifiRetryMs = 0;

void connectWifi();
bool isWifiReady();
void handleKeypad();
void processEnteredCode(const String& code);
bool verifyCodeRemotely(const String& code, int& lockerNumber);
bool verifyUserTagRemotely(const String& tagId, String& responseBody);
void unlockLocker(uint8_t lockerNumber);
void unlockAllLockers();
void updateRelayPulses();
void pollRemoteActions();
void syncStatuses(bool forceSync);
void updateSensors();
bool readTagPresent(uint8_t index);
bool readDoorClosed(uint8_t index);
bool postJson(const char* path, JsonDocument& payload, String* responseBody = nullptr);
bool getJson(const char* path, JsonDocument& responseDoc);
void reportLockerTagStatus(uint8_t lockerNumber, bool hasTag);
void reportLockerDoorStatus(uint8_t lockerNumber, bool isDoorClosed);
void printHttpError(const char* context, int httpCode, const String& response);

void setup() {
  Serial.begin(115200);
  delay(300);

  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    pinMode(RELAY_PINS[i], OUTPUT);
    digitalWrite(RELAY_PINS[i], !RELAY_ACTIVE_LEVEL);

    pinMode(TAG_SENSOR_PINS[i], INPUT_PULLUP);
    pinMode(DOOR_SENSOR_PINS[i], INPUT_PULLUP);

    lockers[i].hasTag = readTagPresent(i);
    lockers[i].isDoorClosed = readDoorClosed(i);
    lockers[i].lastReportedHasTag = lockers[i].hasTag;
    lockers[i].lastReportedDoorClosed = lockers[i].isDoorClosed;
    lockers[i].lastTagChangeMs = millis();
    lockers[i].lastDoorChangeMs = millis();

    relayPulses[i].active = false;
    relayPulses[i].startedAt = 0;
  }

  secureClient.setInsecure();
  connectWifi();
  syncStatuses(true);
}

void loop() {
  if (!isWifiReady()) {
    if (millis() - lastWifiRetryMs >= WIFI_RETRY_MS) {
      lastWifiRetryMs = millis();
      connectWifi();
    }
    delay(20);
    return;
  }

  handleKeypad();
  updateRelayPulses();
  updateSensors();

  if (millis() - lastServerPollMs >= SERVER_POLL_MS) {
    lastServerPollMs = millis();
    pollRemoteActions();
  }

  if (millis() - lastStatusSyncMs >= STATUS_SYNC_MS) {
    lastStatusSyncMs = millis();
    syncStatuses(true);
  }

  delay(10);
}

void connectWifi() {
  Serial.printf("Connecting to WiFi: %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(300);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("WiFi connected. IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println();
    Serial.println("WiFi connection failed.");
  }
}

bool isWifiReady() {
  return WiFi.status() == WL_CONNECTED;
}

void handleKeypad() {
  const char key = keypad.getKey();
  if (!key) {
    return;
  }

  if (key >= '0' && key <= '9') {
    if (enteredCode.length() < 4) {
      enteredCode += key;
      Serial.printf("Code buffer: %s\n", enteredCode.c_str());
    }
    return;
  }

  if (key == '*') {
    enteredCode = "";
    Serial.println("Code buffer cleared.");
    return;
  }

  if (key == '#') {
    if (enteredCode.length() != 4) {
      Serial.println("Enter exactly 4 digits before submit.");
      enteredCode = "";
      return;
    }

    processEnteredCode(enteredCode);
    enteredCode = "";
  }
}

void processEnteredCode(const String& code) {
  int lockerNumber = 0;
  if (!verifyCodeRemotely(code, lockerNumber)) {
    Serial.printf("Code %s rejected.\n", code.c_str());
    return;
  }

  Serial.printf("Code accepted. Opening locker S%d.\n", lockerNumber);
  unlockLocker((uint8_t)lockerNumber);
}

bool verifyCodeRemotely(const String& code, int& lockerNumber) {
  StaticJsonDocument<96> payload;
  payload["code"] = code;

  String responseBody;
  if (!postJson("/verify-code", payload, &responseBody)) {
    return false;
  }

  StaticJsonDocument<192> responseDoc;
  DeserializationError error = deserializeJson(responseDoc, responseBody);
  if (error) {
    Serial.printf("verify-code JSON parse failed: %s\n", error.c_str());
    return false;
  }

  if (!responseDoc["valid"].as<bool>()) {
    return false;
  }

  lockerNumber = responseDoc["locker"] | 0;
  return lockerNumber >= 1 && lockerNumber <= LOCKER_COUNT;
}

bool verifyUserTagRemotely(const String& tagId, String& responseBody) {
  StaticJsonDocument<96> payload;
  payload["tagId"] = tagId;
  return postJson("/verify-tag", payload, &responseBody);
}

void unlockLocker(uint8_t lockerNumber) {
  if (lockerNumber < 1 || lockerNumber > LOCKER_COUNT) {
    return;
  }

  const uint8_t index = lockerNumber - 1;
  digitalWrite(RELAY_PINS[index], RELAY_ACTIVE_LEVEL);
  relayPulses[index].active = true;
  relayPulses[index].startedAt = millis();
  Serial.printf("Relay pulse started for locker S%d.\n", lockerNumber);
}

void unlockAllLockers() {
  for (uint8_t locker = 1; locker <= LOCKER_COUNT; locker += 1) {
    unlockLocker(locker);
  }
  Serial.println("All lockers released.");
}

void updateRelayPulses() {
  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    if (!relayPulses[i].active) {
      continue;
    }

    if (millis() - relayPulses[i].startedAt >= RELAY_PULSE_MS) {
      digitalWrite(RELAY_PINS[i], !RELAY_ACTIVE_LEVEL);
      relayPulses[i].active = false;
      Serial.printf("Relay pulse ended for locker S%d.\n", i + 1);
    }
  }
}

void pollRemoteActions() {
  StaticJsonDocument<2048> responseDoc;
  if (!getJson("/device/actions", responseDoc)) {
    return;
  }

  JsonArray actions = responseDoc["actions"].as<JsonArray>();
  for (JsonObject action : actions) {
    const char* type = action["type"] | "";
    const int locker = action["locker"] | 0;

    Serial.printf("Received action: %s", type);
    if (locker > 0) {
      Serial.printf(" for S%d", locker);
    }
    Serial.println();

    if (strcmp(type, "OPEN_LOCKER") == 0) {
      unlockLocker((uint8_t)locker);
      continue;
    }

    if (strcmp(type, "RELEASE_ALL_LOCKERS") == 0) {
      unlockAllLockers();
    }
  }
}

void syncStatuses(bool forceSync) {
  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    if (forceSync || lockers[i].hasTag != lockers[i].lastReportedHasTag) {
      reportLockerTagStatus(i + 1, lockers[i].hasTag);
    }

    if (forceSync || lockers[i].isDoorClosed != lockers[i].lastReportedDoorClosed) {
      reportLockerDoorStatus(i + 1, lockers[i].isDoorClosed);
    }
  }
}

void updateSensors() {
  const unsigned long now = millis();

  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    const bool currentTag = readTagPresent(i);
    if (currentTag != lockers[i].hasTag) {
      if (now - lockers[i].lastTagChangeMs >= SENSOR_DEBOUNCE_MS) {
        lockers[i].hasTag = currentTag;
        lockers[i].lastTagChangeMs = now;
        reportLockerTagStatus(i + 1, currentTag);
      }
    } else {
      lockers[i].lastTagChangeMs = now;
    }

    const bool currentDoor = readDoorClosed(i);
    if (currentDoor != lockers[i].isDoorClosed) {
      if (now - lockers[i].lastDoorChangeMs >= SENSOR_DEBOUNCE_MS) {
        lockers[i].isDoorClosed = currentDoor;
        lockers[i].lastDoorChangeMs = now;
        reportLockerDoorStatus(i + 1, currentDoor);
      }
    } else {
      lockers[i].lastDoorChangeMs = now;
    }
  }
}

bool readTagPresent(uint8_t index) {
  return digitalRead(TAG_SENSOR_PINS[index]) == TAG_PRESENT_LEVEL;
}

bool readDoorClosed(uint8_t index) {
  return digitalRead(DOOR_SENSOR_PINS[index]) == DOOR_CLOSED_LEVEL;
}

bool postJson(const char* path, JsonDocument& payload, String* responseBody) {
  HTTPClient http;
  String url = String(API_BASE_URL) + path;

  if (!http.begin(secureClient, url)) {
    Serial.printf("HTTP begin failed for %s\n", path);
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  if (strlen(DEVICE_API_KEY) > 0) {
    http.addHeader("x-device-key", DEVICE_API_KEY);
  }

  String body;
  serializeJson(payload, body);

  int httpCode = http.POST(body);
  String response = http.getString();
  http.end();

  if (responseBody != nullptr) {
    *responseBody = response;
  }

  if (httpCode < 200 || httpCode >= 300) {
    printHttpError(path, httpCode, response);
    return false;
  }

  return true;
}

bool getJson(const char* path, JsonDocument& responseDoc) {
  HTTPClient http;
  String url = String(API_BASE_URL) + path;

  if (!http.begin(secureClient, url)) {
    Serial.printf("HTTP begin failed for %s\n", path);
    return false;
  }

  if (strlen(DEVICE_API_KEY) > 0) {
    http.addHeader("x-device-key", DEVICE_API_KEY);
  }

  int httpCode = http.GET();
  String response = http.getString();
  http.end();

  if (httpCode < 200 || httpCode >= 300) {
    printHttpError(path, httpCode, response);
    return false;
  }

  DeserializationError error = deserializeJson(responseDoc, response);
  if (error) {
    Serial.printf("GET %s JSON parse failed: %s\n", path, error.c_str());
    return false;
  }

  return true;
}

void reportLockerTagStatus(uint8_t lockerNumber, bool hasTag) {
  StaticJsonDocument<96> payload;
  payload["locker"] = lockerNumber;
  payload["hasTag"] = hasTag;

  if (postJson("/locker-status", payload)) {
    lockers[lockerNumber - 1].lastReportedHasTag = hasTag;
    Serial.printf("Reported tag state for S%d: %s\n", lockerNumber, hasTag ? "present" : "missing");
  }
}

void reportLockerDoorStatus(uint8_t lockerNumber, bool isDoorClosed) {
  StaticJsonDocument<96> payload;
  payload["locker"] = lockerNumber;
  payload["isDoorClosed"] = isDoorClosed;

  if (postJson("/locker-door-status", payload)) {
    lockers[lockerNumber - 1].lastReportedDoorClosed = isDoorClosed;
    Serial.printf("Reported door state for S%d: %s\n", lockerNumber, isDoorClosed ? "closed" : "open");
  }
}

void printHttpError(const char* context, int httpCode, const String& response) {
  Serial.printf("HTTP error on %s: %d\n", context, httpCode);
  if (response.length() > 0) {
    Serial.println(response);
  }
}
