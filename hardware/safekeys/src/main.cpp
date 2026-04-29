#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <SPI.h>
#include <I2CKeyPad.h>
#include <Adafruit_NeoPixel.h>
#include <MFRC522.h>

/*
  SafeKeys ESP32 - wariant testowy v3

  Aktualny zestaw hardware:
  - ESP32
  - keypad 4x4 po I2C
  - pasek ARGB WS2812B
  - 4 czytniki RFID RC522:
    * 3 dla skrytek
    * 1 master

  Główne cele tego firmware:
  - debug po UART i czytelne logi zdarzeń
  - obsługa kodów z keypadu
  - raportowanie obecności tagów w skrytkach do backendu
  - obsługa master RFID przez /verify-tag
  - polling /device/actions dla pełnego testowania integracji backend <-> ESP32

  Uwaga:
  - fizyczne czujniki drzwiczek / zamka są na razie opcjonalne
  - domyślnie ENABLE_LOCKER_SWITCH_INPUTS = false, bo aktualnie testujemy zestaw z RFID
*/

static const char* WIFI_SSID = "TP-Link_70FC";
static const char* WIFI_PASSWORD = "13793814";

static const char* API_BASE_URL = "https://www.safekeys.pl";
static const char* DEVICE_API_KEY = "9f0c2a7e8b6d4f1a0c3e5b789abc1234567890abcdef1234567890abcdefabcd";

static const bool ENABLE_LOCKER_SWITCH_INPUTS = false;
static const bool DEBUG_RFID_VERBOSE = true;

#ifdef LED_BUILTIN
static const uint8_t STATUS_LED_PIN = LED_BUILTIN;
#else
static const uint8_t STATUS_LED_PIN = 2;
#endif

static const bool STATUS_LED_ACTIVE_LEVEL = HIGH;

static const uint8_t I2C_SDA_PIN = 21;
static const uint8_t I2C_SCL_PIN = 22;
static const uint8_t KEYPAD_I2C_ADDRESS = 0x20;

static const uint8_t STRIP_PIN = 4;
static const uint16_t TOTAL_LEDS = 60;
static const uint8_t LOCKER_COUNT = 3;
static const uint8_t LEDS_PER_LOCKER = 20;

static const uint8_t CODE_LENGTH = 4;
static const uint8_t CODE_ENTRY_LED_POSITIONS[CODE_LENGTH] = { 9, 19, 29, 39 };

static const uint8_t STATUS_BRIGHTNESS = 48;
static const uint8_t EFFECT_BRIGHTNESS = 72;

static const uint8_t RFID_SPI_SCK_PIN = 14;
static const uint8_t RFID_SPI_MISO_PIN = 12;
static const uint8_t RFID_SPI_MOSI_PIN = 13;
static const uint8_t RFID_RST_PIN = 15;
static const uint8_t RFID_LOCKER_SS_PINS[LOCKER_COUNT] = { 5, 16, 17 };
static const uint8_t RFID_MASTER_SS_PIN = 32;

static const unsigned long WIFI_RETRY_MS = 5000;
static const unsigned long WIFI_CONNECT_TIMEOUT_MS = 15000;
static const unsigned long WIFI_LOADING_FRAME_MS = 120;
static const unsigned long HEARTBEAT_INTERVAL_MS = 15000;
static const unsigned long LOCKER_STATUS_REPORT_INTERVAL_MS = 10000;
static const unsigned long DEVICE_ACTIONS_POLL_INTERVAL_MS = 2000;
static const unsigned long RFID_REMOVAL_DEBOUNCE_MS = 900;
static const unsigned long RFID_MASTER_REARM_DELAY_MS = 1500;
static const unsigned long KEYPAD_RELEASE_DEBOUNCE_MS = 80;
static const byte RFID_APP_BLOCK = 4;
static const char RFID_APP_MAGIC_1 = 'S';
static const char RFID_APP_MAGIC_2 = 'K';
static const char RFID_APP_VERSION = '1';

static char keypadCharMap[] = {
  '1', '2', '3', 'A',
  '4', '5', '6', 'B',
  '7', '8', '9', 'C',
  '*', '0', '#', 'D',
  '\0', '?', '\0'
};

struct LockerInputPin {
  uint8_t pin;
  bool activeLow;
};

struct LockerHardwareConfig {
  LockerInputPin doorClosed;
  LockerInputPin lockClosed;
};

struct LockerState {
  bool tagPresent;
  String tagUid;
  bool doorClosed;
  bool lockClosed;
};

struct StatusLedEffect {
  bool active;
  bool pulseMode;
  bool state;
  uint8_t transitionsLeft;
  unsigned long phaseStartedMs;
  unsigned long onMs;
  unsigned long offMs;
};

struct CodeResultFlashEffect {
  bool active;
  bool success;
  uint8_t count;
  uint8_t stage;
  unsigned long stageStartedMs;
};

struct RfidScanResult {
  bool present;
  String physicalUid;
  String logicalTagId;
  bool hasCustomTag;
};

struct RfidReaderRuntime {
  const char* label;
  uint8_t ssPin;
  bool isMaster;
  uint8_t lockerNumber;
  MFRC522* reader;
  bool hasCard;
  String stableUid;
  String lastTriggeredUid;
  unsigned long lastSeenMs;
  unsigned long lastReportMs;
  bool reportDirty;
};

struct TagAssignmentMode {
  bool active;
  String assignmentId;
  String tagId;
  String itemName;
  unsigned long startedMs;
  unsigned long animationFrame;
};

static const LockerHardwareConfig LOCKERS[LOCKER_COUNT] = {
  { { 18, true }, { 19, true } },
  { { 23, true }, { 25, true } },
  { { 26, true }, { 27, true } }
};

I2CKeyPad keypad(KEYPAD_I2C_ADDRESS);
Adafruit_NeoPixel strip(TOTAL_LEDS, STRIP_PIN, NEO_GRB + NEO_KHZ800);
MFRC522 lockerReader1(RFID_LOCKER_SS_PINS[0], RFID_RST_PIN);
MFRC522 lockerReader2(RFID_LOCKER_SS_PINS[1], RFID_RST_PIN);
MFRC522 lockerReader3(RFID_LOCKER_SS_PINS[2], RFID_RST_PIN);
MFRC522 masterReader(RFID_MASTER_SS_PIN, RFID_RST_PIN);

RfidReaderRuntime lockerReaders[LOCKER_COUNT] = {
  { "locker-rfid-1", RFID_LOCKER_SS_PINS[0], false, 1, &lockerReader1, false, "", "", 0, 0, true },
  { "locker-rfid-2", RFID_LOCKER_SS_PINS[1], false, 2, &lockerReader2, false, "", "", 0, 0, true },
  { "locker-rfid-3", RFID_LOCKER_SS_PINS[2], false, 3, &lockerReader3, false, "", "", 0, 0, true }
};

RfidReaderRuntime masterReaderRuntime = {
  "master-rfid",
  RFID_MASTER_SS_PIN,
  true,
  0,
  &masterReader,
  false,
  "",
  "",
  0,
  0,
  false
};

WiFiClientSecure secureClient;
String enteredCode;
String serialCommandBuffer;

unsigned long lastWifiRetryMs = 0;
unsigned long lastHeartbeatMs = 0;
unsigned long lastDeviceActionsPollMs = 0;
long lastHeartbeatPingMs = -1;
uint8_t lastStableRawKey = I2C_KEYPAD_NOKEY;
bool keypadPressLocked = false;
unsigned long keypadReleaseStartedMs = 0;
bool wifiConnectInProgress = false;
unsigned long wifiConnectStartedMs = 0;
unsigned long lastWifiLoadingFrameMs = 0;
uint8_t wifiLoadingFrame = 0;
bool statusLedBaseEnabled = false;
StatusLedEffect statusLedEffect = { false, false, false, 0, 0, 0, 0 };
CodeResultFlashEffect codeResultFlash = { false, false, 0, 0, 0 };
TagAssignmentMode tagAssignmentMode = { false, "", "", "", 0, 0 };

void connectWifi();
void serviceWifiConnection(unsigned long now);
bool isWifiReady();
void handleKeypad();
void handleSerialDebug();
void maybeSendHeartbeat(unsigned long now);
void maybePollDeviceActions(unsigned long now);
void maybeReportLockerStatuses(unsigned long now);
void processEnteredCode(const String& code);
bool verifyCodeRemotely(const String& code, bool& isValid, int& lockerNumber);
bool verifyMasterTagRemotely(const String& tagId);
bool postVerifyCode(const String& code, String& responseBody);
bool postVerifyTag(const String& tagId, String& responseBody);
bool postLockerStatus(uint8_t lockerNumber, bool hasTag, const String& tagId);
bool fetchDeviceActions();
bool sendHeartbeat();
void printUsage();
void printStatus();
void printRfidSnapshot();
void setStatusLed(bool enabled);
void writeStatusLed(bool enabled);
void serviceStatusLed(unsigned long now);
void blinkLed(uint8_t times, unsigned long onMs, unsigned long offMs);
void pulseLed(unsigned long durationMs);
void configureLockerInputs();
bool readInputPin(const LockerInputPin& config);
LockerState readLockerState(uint8_t lockerIndex);
bool isLockerComplete(const LockerState& state);
void updateVisualState();
void renderLockerStatus();
void renderCodeEntry();
void renderWifiLoadingFrame(uint8_t frameIndex);
void flashCodeResult(const String& code, bool success);
void serviceCodeResultFlash(unsigned long now);
void renderCodeResultFrame(bool success, uint8_t count, bool visible);
void clearStrip();
char mapRawKeyToChar(uint8_t rawKey);
void initializeRfidReaders();
void serviceRfidReaders(unsigned long now);
bool scanRfidReader(RfidReaderRuntime& runtime, unsigned long now);
void updateReaderPresence(RfidReaderRuntime& runtime, const RfidScanResult& scanResult, unsigned long now);
RfidScanResult readTagFromReader(MFRC522& reader);
String uidToString(const MFRC522::Uid& uid);
void debugPrintReaderChipVersion(const RfidReaderRuntime& runtime);
void startTagAssignmentMode(const String& assignmentId, const String& tagId, const String& itemName);
void stopTagAssignmentMode();
void renderTagAssignmentFrame(uint8_t frameIndex);
bool tryProgramTag(MFRC522& reader, const String& tagId, String& error);
bool tryReadProgrammedTagId(MFRC522& reader, String& tagId);
bool authenticateClassicBlock(MFRC522& reader, byte blockAddr, MFRC522::MIFARE_Key& key);
bool postTagAssignmentResult(const String& assignmentId, bool success, const String& tagId, const String& physicalUid, const String& error);

uint32_t colorGreen(uint8_t brightness = STATUS_BRIGHTNESS) {
  return strip.Color(0, brightness, 0);
}

uint32_t colorRed(uint8_t brightness = STATUS_BRIGHTNESS) {
  return strip.Color(brightness, 0, 0);
}

uint32_t colorBlue(uint8_t brightness = EFFECT_BRIGHTNESS) {
  return strip.Color(0, 0, brightness);
}

uint32_t colorYellow(uint8_t brightness = EFFECT_BRIGHTNESS) {
  return strip.Color(brightness, brightness, 0);
}

void setup() {
  Serial.begin(115200);
  delay(300);

  pinMode(STATUS_LED_PIN, OUTPUT);
  setStatusLed(false);

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  const bool keypadReady = keypad.begin();
  keypad.loadKeyMap(keypadCharMap);
  keypad.setKeyPadMode(I2C_KEYPAD_4x4);
  keypad.setDebounceThreshold(75);

  strip.begin();
  strip.setBrightness(255);
  clearStrip();

  configureLockerInputs();
  initializeRfidReaders();

  secureClient.setInsecure();

  Serial.println();
  Serial.println("=== SafeKeys ESP32 v3 TEST ===");
  Serial.printf("LED pin: %u\n", STATUS_LED_PIN);
  Serial.printf("Keypad I2C address: 0x%02X\n", KEYPAD_I2C_ADDRESS);
  Serial.printf("Keypad ready: %s\n", keypadReady ? "yes" : "no");
  Serial.printf("ARGB strip pin: %u, leds: %u\n", STRIP_PIN, TOTAL_LEDS);
  Serial.printf("RFID SPI pins -> SCK=%u, MISO=%u, MOSI=%u, RST=%u\n", RFID_SPI_SCK_PIN, RFID_SPI_MISO_PIN, RFID_SPI_MOSI_PIN, RFID_RST_PIN);
  Serial.printf("API base URL: %s\n", API_BASE_URL);
  Serial.printf("Locker switch inputs enabled: %s\n", ENABLE_LOCKER_SWITCH_INPUTS ? "yes" : "no");
  printUsage();
  printRfidSnapshot();

  updateVisualState();
  connectWifi();
}

void loop() {
  const unsigned long now = millis();

  serviceStatusLed(now);
  serviceWifiConnection(now);
  serviceCodeResultFlash(now);
  handleSerialDebug();
  handleKeypad();
  serviceRfidReaders(now);
  updateVisualState();

  if (!isWifiReady()) {
    if (!wifiConnectInProgress && now - lastWifiRetryMs >= WIFI_RETRY_MS) {
      connectWifi();
    }
    return;
  }

  maybeSendHeartbeat(now);
  maybeReportLockerStatuses(now);
  maybePollDeviceActions(now);
}

void connectWifi() {
  Serial.printf("Connecting to WiFi: %s\n", WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  wifiConnectInProgress = true;
  wifiConnectStartedMs = millis();
  lastWifiRetryMs = wifiConnectStartedMs;
  lastWifiLoadingFrameMs = 0;
  wifiLoadingFrame = 0;
  renderWifiLoadingFrame(wifiLoadingFrame);
  pulseLed(35);
}

void serviceWifiConnection(unsigned long now) {
  if (!wifiConnectInProgress) {
    return;
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifiConnectInProgress = false;
    lastHeartbeatMs = 0;
    lastDeviceActionsPollMs = 0;
    Serial.println();
    Serial.print("WiFi connected. IP: ");
    Serial.println(WiFi.localIP());
    blinkLed(2, 140, 140);
    updateVisualState();
    return;
  }

  if (now - wifiConnectStartedMs >= WIFI_CONNECT_TIMEOUT_MS) {
    wifiConnectInProgress = false;
    lastWifiRetryMs = now;
    Serial.println();
    Serial.println("WiFi connection failed. ESP32 will retry automatically.");
    blinkLed(4, 150, 120);
    updateVisualState();
    return;
  }

  if (lastWifiLoadingFrameMs == 0 || now - lastWifiLoadingFrameMs >= WIFI_LOADING_FRAME_MS) {
    lastWifiLoadingFrameMs = now;
    renderWifiLoadingFrame(wifiLoadingFrame);
    wifiLoadingFrame = static_cast<uint8_t>((wifiLoadingFrame + 1) % (TOTAL_LEDS / 2));
    pulseLed(35);
    Serial.print(".");
  }
}

bool isWifiReady() {
  return WiFi.status() == WL_CONNECTED;
}

void maybeSendHeartbeat(unsigned long now) {
  if (lastHeartbeatMs != 0 && now - lastHeartbeatMs < HEARTBEAT_INTERVAL_MS) {
    return;
  }

  lastHeartbeatMs = now;
  sendHeartbeat();
}

void maybePollDeviceActions(unsigned long now) {
  if (lastDeviceActionsPollMs != 0 && now - lastDeviceActionsPollMs < DEVICE_ACTIONS_POLL_INTERVAL_MS) {
    return;
  }

  lastDeviceActionsPollMs = now;
  fetchDeviceActions();
}

void maybeReportLockerStatuses(unsigned long now) {
  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    RfidReaderRuntime& runtime = lockerReaders[i];
    if (!runtime.reportDirty && runtime.lastReportMs != 0 && now - runtime.lastReportMs < LOCKER_STATUS_REPORT_INTERVAL_MS) {
      continue;
    }

    if (postLockerStatus(runtime.lockerNumber, runtime.hasCard, runtime.stableUid)) {
      runtime.reportDirty = false;
      runtime.lastReportMs = now;
    }
  }
}

void handleKeypad() {
  const uint8_t rawKey = keypad.getKey();
  if (rawKey == I2C_KEYPAD_NOKEY || rawKey == I2C_KEYPAD_THRESHOLD) {
    if (keypadPressLocked) {
      if (keypadReleaseStartedMs == 0) {
        keypadReleaseStartedMs = millis();
      } else if (millis() - keypadReleaseStartedMs >= KEYPAD_RELEASE_DEBOUNCE_MS) {
        keypadPressLocked = false;
        keypadReleaseStartedMs = 0;
        lastStableRawKey = I2C_KEYPAD_NOKEY;
      }
    } else {
      lastStableRawKey = I2C_KEYPAD_NOKEY;
    }
    return;
  }

  keypadReleaseStartedMs = 0;

  if (rawKey == I2C_KEYPAD_FAIL) {
    lastStableRawKey = I2C_KEYPAD_NOKEY;
    keypadPressLocked = false;
    Serial.println("Keypad read failed or multiple keys pressed.");
    blinkLed(2, 50, 50);
    return;
  }

  if (keypadPressLocked || rawKey == lastStableRawKey) {
    return;
  }

  lastStableRawKey = rawKey;
  keypadPressLocked = true;

  const char key = mapRawKeyToChar(rawKey);
  if (key == '\0') {
    Serial.println("Keypad returned an unmapped key.");
    blinkLed(2, 50, 50);
    return;
  }

  Serial.printf("Key pressed: %c\n", key);
  pulseLed(30);

  if (key >= '0' && key <= '9') {
    if (enteredCode.length() >= CODE_LENGTH) {
      Serial.println("Buffer already has 4 digits. Press # to submit or * to clear.");
      blinkLed(2, 60, 60);
      return;
    }

    enteredCode += key;
    Serial.printf("Current code buffer: %s\n", enteredCode.c_str());
    renderCodeEntry();
    return;
  }

  if (key == '*') {
    enteredCode = "";
    Serial.println("Code buffer cleared.");
    blinkLed(1, 80, 80);
    updateVisualState();
    return;
  }

  if (key == '#') {
    if (enteredCode.length() != CODE_LENGTH) {
      Serial.println("Enter exactly 4 digits before sending the code.");
      blinkLed(3, 70, 70);
      renderCodeEntry();
      return;
    }

    processEnteredCode(enteredCode);
    enteredCode = "";
    updateVisualState();
    return;
  }

  if (key == 'A') {
    Serial.println("Manual WiFi reconnect requested.");
    enteredCode = "";
    WiFi.disconnect(true, true);
    connectWifi();
    return;
  }

  if (key == 'B') {
    printStatus();
    return;
  }

  if (key == 'C') {
    printUsage();
    return;
  }

  if (key == 'D') {
    enteredCode = "";
    Serial.println("Full debug reset of keypad buffer.");
    blinkLed(2, 100, 100);
    updateVisualState();
  }
}

void handleSerialDebug() {
  while (Serial.available() > 0) {
    const char ch = static_cast<char>(Serial.read());

    if (ch == '\r') {
      continue;
    }

    if (ch == '\n') {
      const String command = serialCommandBuffer;
      serialCommandBuffer = "";

      if (command.length() == 0) {
        continue;
      }

      Serial.printf("Serial command: %s\n", command.c_str());

      if (command == "help" || command == "?") {
        printUsage();
      } else if (command == "status" || command == "s") {
        printStatus();
      } else if (command == "rfid" || command == "r") {
        printRfidSnapshot();
      } else if (command == "wifi" || command == "w") {
        WiFi.disconnect(true, true);
        connectWifi();
      } else if (command == "heartbeat" || command == "h") {
        if (isWifiReady()) {
          sendHeartbeat();
        } else {
          Serial.println("Heartbeat skipped: WiFi not connected.");
        }
      } else if (command == "lockers" || command == "l") {
        for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
          lockerReaders[i].reportDirty = true;
        }
        if (isWifiReady()) {
          maybeReportLockerStatuses(millis());
        } else {
          Serial.println("Locker report queued, waiting for WiFi.");
        }
      } else if (command == "actions" || command == "a") {
        if (isWifiReady()) {
          fetchDeviceActions();
        } else {
          Serial.println("Actions poll skipped: WiFi not connected.");
        }
      } else if (command == "clear" || command == "c") {
        enteredCode = "";
        Serial.println("Code buffer cleared from serial.");
        updateVisualState();
      } else {
        Serial.println("Unknown serial command. Type 'help' or '?'.");
      }

      continue;
    }

    if (serialCommandBuffer.length() < 64) {
      serialCommandBuffer += ch;
    }
  }
}

void processEnteredCode(const String& code) {
  bool isValid = false;
  int lockerNumber = 0;

  Serial.printf("Sending code %s to backend...\n", code.c_str());
  setStatusLed(true);
  renderCodeEntry();

  const bool requestOk = verifyCodeRemotely(code, isValid, lockerNumber);

  setStatusLed(false);

  if (!requestOk) {
    Serial.println("Code verification request failed.");
    flashCodeResult(code, false);
    blinkLed(5, 80, 80);
    return;
  }

  if (!isValid) {
    Serial.printf("Code %s is invalid.\n", code.c_str());
    flashCodeResult(code, false);
    blinkLed(4, 120, 90);
    return;
  }

  Serial.printf("Code %s is valid for locker S%d.\n", code.c_str(), lockerNumber);
  flashCodeResult(code, true);
  blinkLed(2, 260, 140);
}

bool verifyCodeRemotely(const String& code, bool& isValid, int& lockerNumber) {
  isValid = false;
  lockerNumber = 0;

  String responseBody;
  if (!postVerifyCode(code, responseBody)) {
    return false;
  }

  StaticJsonDocument<192> responseDoc;
  const DeserializationError error = deserializeJson(responseDoc, responseBody);
  if (error) {
    Serial.printf("verify-code JSON parse failed: %s\n", error.c_str());
    Serial.printf("Raw response: %s\n", responseBody.c_str());
    return false;
  }

  isValid = responseDoc["valid"] | false;
  lockerNumber = responseDoc["locker"] | 0;

  Serial.printf("Backend response: valid=%s, locker=%d\n", isValid ? "true" : "false", lockerNumber);
  return true;
}

bool verifyMasterTagRemotely(const String& tagId) {
  String responseBody;
  if (!postVerifyTag(tagId, responseBody)) {
    Serial.printf("Master tag verification failed for UID %s\n", tagId.c_str());
    blinkLed(4, 70, 70);
    return false;
  }

  StaticJsonDocument<512> responseDoc;
  const DeserializationError error = deserializeJson(responseDoc, responseBody);
  if (error) {
    Serial.printf("verify-tag JSON parse failed: %s\n", error.c_str());
    Serial.printf("Raw response: %s\n", responseBody.c_str());
    blinkLed(4, 70, 70);
    return false;
  }

  const bool valid = responseDoc["valid"] | false;
  if (!valid) {
    Serial.printf("Master RFID denied for UID %s\n", tagId.c_str());

    const JsonObject item = responseDoc["item"];
    if (!item.isNull()) {
      const bool known = item["itemKnown"] | false;
      const char* itemName = item["itemName"] | "";
      const char* itemType = item["itemType"] | "";
      if (known && strlen(itemName) > 0) {
        Serial.printf("Denied item: %s (%s)\n", itemName, itemType);
      }
    }

    blinkLed(4, 90, 80);
    return true;
  }

  const JsonObject user = responseDoc["user"];
  const char* userName = user["name"] | "unknown";
  const JsonArray openedLockers = responseDoc["openedLockers"];
  Serial.printf("Master RFID granted for %s, UID=%s\n", userName, tagId.c_str());

  Serial.print("Opened lockers: ");
  if (openedLockers.isNull() || openedLockers.size() == 0) {
    Serial.println("(none)");
  } else {
    for (JsonVariant value : openedLockers) {
      Serial.printf("S%d ", value.as<int>());
    }
    Serial.println();
  }

  const JsonObject item = responseDoc["item"];
  if (!item.isNull()) {
    const bool known = item["itemKnown"] | false;
    const char* itemName = item["itemName"] | "";
    const char* itemType = item["itemType"] | "";
    if (known && strlen(itemName) > 0) {
      Serial.printf("Recognized item: %s (%s)\n", itemName, itemType);
    } else {
      Serial.printf("Recognized foreign UID: %s\n", tagId.c_str());
    }
  }

  blinkLed(2, 220, 120);
  return true;
}

bool postVerifyCode(const String& code, String& responseBody) {
  HTTPClient http;
  const String url = String(API_BASE_URL) + "/verify-code";

  if (!http.begin(secureClient, url)) {
    Serial.println("HTTP begin failed for /verify-code");
    return false;
  }

  http.addHeader("Content-Type", "application/json");

  if (strlen(DEVICE_API_KEY) > 0) {
    http.addHeader("x-device-key", DEVICE_API_KEY);
  }

  StaticJsonDocument<96> payload;
  payload["code"] = code;

  String body;
  serializeJson(payload, body);

  Serial.printf("POST %s\n", url.c_str());
  Serial.printf("Payload: %s\n", body.c_str());

  const int httpCode = http.POST(body);
  responseBody = http.getString();
  http.end();

  Serial.printf("HTTP status: %d\n", httpCode);
  if (responseBody.length() > 0) {
    Serial.printf("HTTP response: %s\n", responseBody.c_str());
  }

  return httpCode >= 200 && httpCode < 300;
}

bool postVerifyTag(const String& tagId, String& responseBody) {
  HTTPClient http;
  const String url = String(API_BASE_URL) + "/verify-tag";

  if (!http.begin(secureClient, url)) {
    Serial.println("HTTP begin failed for /verify-tag");
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  if (strlen(DEVICE_API_KEY) > 0) {
    http.addHeader("x-device-key", DEVICE_API_KEY);
  }

  StaticJsonDocument<128> payload;
  payload["tagId"] = tagId;

  String body;
  serializeJson(payload, body);

  Serial.printf("POST %s\n", url.c_str());
  Serial.printf("Payload: %s\n", body.c_str());

  const int httpCode = http.POST(body);
  responseBody = http.getString();
  http.end();

  Serial.printf("HTTP status: %d\n", httpCode);
  if (responseBody.length() > 0) {
    Serial.printf("HTTP response: %s\n", responseBody.c_str());
  }

  return httpCode >= 200 && httpCode < 300;
}

bool postLockerStatus(uint8_t lockerNumber, bool hasTag, const String& tagId) {
  HTTPClient http;
  const String url = String(API_BASE_URL) + "/locker-status";

  if (!http.begin(secureClient, url)) {
    Serial.println("HTTP begin failed for /locker-status");
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  if (strlen(DEVICE_API_KEY) > 0) {
    http.addHeader("x-device-key", DEVICE_API_KEY);
  }

  StaticJsonDocument<160> payload;
  payload["locker"] = lockerNumber;
  payload["hasTag"] = hasTag;
  if (hasTag && tagId.length() > 0) {
    payload["tagId"] = tagId;
  }

  String body;
  serializeJson(payload, body);

  const int httpCode = http.POST(body);
  const String responseBody = http.getString();
  http.end();

  Serial.printf("Locker report S%u -> hasTag=%s, uid=%s, HTTP=%d\n",
    lockerNumber,
    hasTag ? "true" : "false",
    hasTag && tagId.length() > 0 ? tagId.c_str() : "(none)",
    httpCode
  );

  if (responseBody.length() > 0 && DEBUG_RFID_VERBOSE) {
    Serial.printf("Locker report response: %s\n", responseBody.c_str());
  }

  return httpCode >= 200 && httpCode < 300;
}

bool fetchDeviceActions() {
  HTTPClient http;
  const String url = String(API_BASE_URL) + "/device/actions";

  if (!http.begin(secureClient, url)) {
    Serial.println("HTTP begin failed for /device/actions");
    return false;
  }

  if (strlen(DEVICE_API_KEY) > 0) {
    http.addHeader("x-device-key", DEVICE_API_KEY);
  }

  const int httpCode = http.GET();
  const String responseBody = http.getString();
  http.end();

  if (httpCode < 200 || httpCode >= 300) {
    Serial.printf("Device actions poll failed, HTTP=%d\n", httpCode);
    if (responseBody.length() > 0) {
      Serial.printf("Device actions response: %s\n", responseBody.c_str());
    }
    return false;
  }

  StaticJsonDocument<1024> responseDoc;
  const DeserializationError error = deserializeJson(responseDoc, responseBody);
  if (error) {
    Serial.printf("device/actions JSON parse failed: %s\n", error.c_str());
    Serial.printf("Raw response: %s\n", responseBody.c_str());
    return false;
  }

  const JsonArray actions = responseDoc["actions"];
  if (actions.isNull() || actions.size() == 0) {
    return true;
  }

  Serial.printf("Received %u remote action(s)\n", static_cast<unsigned>(actions.size()));
  for (JsonObject action : actions) {
    const char* type = action["type"] | "UNKNOWN";
    const int locker = action["locker"] | 0;
    const char* actor = action["actor"] | "unknown";
    Serial.printf("Remote action -> type=%s locker=%d actor=%s\n", type, locker, actor);

    if (String(type) == "ASSIGN_RFID_TAG") {
      const JsonObject payload = action["payload"];
      const char* assignmentId = payload["assignmentId"] | "";
      const char* tagId = payload["tagId"] | "";
      const char* itemName = payload["itemName"] | "";

      if (strlen(assignmentId) > 0 && strlen(tagId) > 0) {
        startTagAssignmentMode(String(assignmentId), String(tagId), String(itemName));
      }
    }
  }

  blinkLed(2, 60, 60);
  return true;
}

bool sendHeartbeat() {
  HTTPClient http;
  const String url = String(API_BASE_URL) + "/device/heartbeat";

  if (!http.begin(secureClient, url)) {
    Serial.println("HTTP begin failed for /device/heartbeat");
    return false;
  }

  http.addHeader("Content-Type", "application/json");

  if (strlen(DEVICE_API_KEY) > 0) {
    http.addHeader("x-device-key", DEVICE_API_KEY);
  }

  uint8_t lockerTagsPresent = 0;
  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    if (lockerReaders[i].hasCard) {
      lockerTagsPresent += 1;
    }
  }

  StaticJsonDocument<384> payload;
  payload["firmware"] = "safekeys-esp32-v3-test";
  payload["ip"] = WiFi.localIP().toString();
  payload["wifiRssi"] = WiFi.RSSI();
  payload["uptimeMs"] = millis();
  payload["freeHeap"] = ESP.getFreeHeap();
  payload["lockersWithTags"] = lockerTagsPresent;
  payload["masterReaderPresent"] = masterReaderRuntime.hasCard;

  if (lastHeartbeatPingMs >= 0) {
    payload["pingMs"] = lastHeartbeatPingMs;
  }

  String body;
  serializeJson(payload, body);

  const unsigned long startedAt = millis();
  const int httpCode = http.POST(body);
  const String responseBody = http.getString();
  const unsigned long durationMs = millis() - startedAt;
  http.end();

  if (httpCode >= 200 && httpCode < 300) {
    lastHeartbeatPingMs = static_cast<long>(durationMs);
    Serial.printf("Heartbeat OK (%lu ms)\n", durationMs);
    return true;
  }

  Serial.printf("Heartbeat failed, HTTP status: %d\n", httpCode);
  if (responseBody.length() > 0) {
    Serial.printf("Heartbeat response: %s\n", responseBody.c_str());
  }

  return false;
}

void printUsage() {
  Serial.println("Keypad actions:");
  Serial.println("  0-9 -> add digit to 4-digit code");
  Serial.println("  *   -> clear code buffer");
  Serial.println("  #   -> send code to backend");
  Serial.println("  A   -> reconnect WiFi");
  Serial.println("  B   -> print current status");
  Serial.println("  C   -> print this help");
  Serial.println("  D   -> clear buffer (debug reset)");
  Serial.println("Serial debug commands:");
  Serial.println("  help / ?  -> show help");
  Serial.println("  status/s  -> print full device status");
  Serial.println("  rfid/r    -> print RFID snapshot");
  Serial.println("  wifi/w    -> reconnect WiFi");
  Serial.println("  heartbeat/h -> send heartbeat now");
  Serial.println("  lockers/l -> force locker RFID report");
  Serial.println("  actions/a -> poll remote actions");
  Serial.println("  clear/c   -> clear code buffer");
  Serial.println("LED visuals:");
  Serial.println("  - green  -> locker ready / tag present");
  Serial.println("  - red    -> locker without tag");
  Serial.println("  - yellow -> locker tag present but optional switches report problem");
  Serial.println("  - blue   -> keypad code entry");
  Serial.println("  - yellow chase -> WiFi connecting");
  Serial.println("  - green chase  -> master reader in tag assignment mode");
}

void printStatus() {
  Serial.println("--- ESP32 status ---");
  Serial.printf("WiFi connected: %s\n", isWifiReady() ? "yes" : "no");
  if (isWifiReady()) {
    Serial.printf("IP: %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("RSSI: %d dBm\n", WiFi.RSSI());
  }
  if (lastHeartbeatPingMs >= 0) {
    Serial.printf("Last heartbeat ping: %ld ms\n", lastHeartbeatPingMs);
  } else {
    Serial.println("Last heartbeat ping: n/a");
  }

  Serial.printf("Current code buffer: %s\n", enteredCode.length() > 0 ? enteredCode.c_str() : "(empty)");
  Serial.printf("Locker switch inputs enabled: %s\n", ENABLE_LOCKER_SWITCH_INPUTS ? "yes" : "no");
  printRfidSnapshot();

  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    const LockerState state = readLockerState(i);
    Serial.printf(
      "Locker S%u -> tag=%s uid=%s door=%s lock=%s ready=%s lastReport=%lu ms ago\n",
      i + 1,
      state.tagPresent ? "yes" : "no",
      state.tagPresent ? state.tagUid.c_str() : "(none)",
      ENABLE_LOCKER_SWITCH_INPUTS ? (state.doorClosed ? "closed" : "open") : "n/a",
      ENABLE_LOCKER_SWITCH_INPUTS ? (state.lockClosed ? "closed" : "open") : "n/a",
      isLockerComplete(state) ? "yes" : "no",
      lockerReaders[i].lastReportMs == 0 ? 0UL : millis() - lockerReaders[i].lastReportMs
    );
  }
}

void printRfidSnapshot() {
  Serial.println("--- RFID snapshot ---");
  Serial.printf("Assignment mode: %s", tagAssignmentMode.active ? "active" : "inactive");
  if (tagAssignmentMode.active) {
    Serial.printf(" (assignmentId=%s tagId=%s item=%s)",
      tagAssignmentMode.assignmentId.c_str(),
      tagAssignmentMode.tagId.c_str(),
      tagAssignmentMode.itemName.length() > 0 ? tagAssignmentMode.itemName.c_str() : "(unnamed)"
    );
  }
  Serial.println();

  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    const RfidReaderRuntime& runtime = lockerReaders[i];
    Serial.printf(
      "[%s] ss=%u present=%s uid=%s dirty=%s lastSeen=%lu\n",
      runtime.label,
      runtime.ssPin,
      runtime.hasCard ? "yes" : "no",
      runtime.hasCard ? runtime.stableUid.c_str() : "(none)",
      runtime.reportDirty ? "yes" : "no",
      runtime.lastSeenMs
    );
  }

  Serial.printf(
    "[%s] ss=%u present=%s uid=%s armedUid=%s lastSeen=%lu\n",
    masterReaderRuntime.label,
    masterReaderRuntime.ssPin,
    masterReaderRuntime.hasCard ? "yes" : "no",
    masterReaderRuntime.hasCard ? masterReaderRuntime.stableUid.c_str() : "(none)",
    masterReaderRuntime.lastTriggeredUid.length() > 0 ? masterReaderRuntime.lastTriggeredUid.c_str() : "(none)",
    masterReaderRuntime.lastSeenMs
  );
}

void startTagAssignmentMode(const String& assignmentId, const String& tagId, const String& itemName) {
  tagAssignmentMode.active = true;
  tagAssignmentMode.assignmentId = assignmentId;
  tagAssignmentMode.tagId = tagId;
  tagAssignmentMode.itemName = itemName;
  tagAssignmentMode.startedMs = millis();
  tagAssignmentMode.animationFrame = 0;

  Serial.printf("Tag assignment mode enabled. assignmentId=%s tagId=%s item=%s\n",
    assignmentId.c_str(),
    tagId.c_str(),
    itemName.length() > 0 ? itemName.c_str() : "(unnamed)"
  );
}

void stopTagAssignmentMode() {
  tagAssignmentMode.active = false;
  tagAssignmentMode.assignmentId = "";
  tagAssignmentMode.tagId = "";
  tagAssignmentMode.itemName = "";
  tagAssignmentMode.startedMs = 0;
  tagAssignmentMode.animationFrame = 0;
  updateVisualState();
}

void setStatusLed(bool enabled) {
  statusLedBaseEnabled = enabled;
  if (!statusLedEffect.active) {
    writeStatusLed(enabled);
  }
}

void writeStatusLed(bool enabled) {
  digitalWrite(STATUS_LED_PIN, enabled ? STATUS_LED_ACTIVE_LEVEL : !STATUS_LED_ACTIVE_LEVEL);
}

void serviceStatusLed(unsigned long now) {
  if (!statusLedEffect.active) {
    return;
  }

  if (statusLedEffect.pulseMode) {
    if (now - statusLedEffect.phaseStartedMs >= statusLedEffect.onMs) {
      statusLedEffect.active = false;
      writeStatusLed(statusLedBaseEnabled);
    }
    return;
  }

  const unsigned long phaseDuration = statusLedEffect.state ? statusLedEffect.onMs : statusLedEffect.offMs;
  if (now - statusLedEffect.phaseStartedMs < phaseDuration) {
    return;
  }

  if (statusLedEffect.transitionsLeft == 0) {
    statusLedEffect.active = false;
    writeStatusLed(statusLedBaseEnabled);
    return;
  }

  statusLedEffect.state = !statusLedEffect.state;
  statusLedEffect.transitionsLeft -= 1;
  statusLedEffect.phaseStartedMs = now;
  writeStatusLed(statusLedEffect.state);

  if (statusLedEffect.transitionsLeft == 0 && !statusLedEffect.state) {
    statusLedEffect.active = false;
    writeStatusLed(statusLedBaseEnabled);
  }
}

void blinkLed(uint8_t times, unsigned long onMs, unsigned long offMs) {
  if (times == 0) {
    return;
  }

  statusLedEffect = {
    true,
    false,
    true,
    static_cast<uint8_t>(times * 2 - 1),
    millis(),
    onMs,
    offMs
  };
  writeStatusLed(true);
}

void pulseLed(unsigned long durationMs) {
  statusLedEffect = {
    true,
    true,
    true,
    0,
    millis(),
    durationMs,
    0
  };
  writeStatusLed(true);
}

void configureLockerInputs() {
  if (!ENABLE_LOCKER_SWITCH_INPUTS) {
    return;
  }

  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    pinMode(LOCKERS[i].doorClosed.pin, INPUT_PULLUP);
    pinMode(LOCKERS[i].lockClosed.pin, INPUT_PULLUP);
  }
}

bool readInputPin(const LockerInputPin& config) {
  const bool raw = digitalRead(config.pin) == HIGH;
  return config.activeLow ? !raw : raw;
}

LockerState readLockerState(uint8_t lockerIndex) {
  const RfidReaderRuntime& runtime = lockerReaders[lockerIndex];
  bool doorClosed = true;
  bool lockClosed = true;

  if (ENABLE_LOCKER_SWITCH_INPUTS) {
    const LockerHardwareConfig& cfg = LOCKERS[lockerIndex];
    doorClosed = readInputPin(cfg.doorClosed);
    lockClosed = readInputPin(cfg.lockClosed);
  }

  return {
    runtime.hasCard,
    runtime.stableUid,
    doorClosed,
    lockClosed
  };
}

bool isLockerComplete(const LockerState& state) {
  return state.tagPresent && state.doorClosed && state.lockClosed;
}

void updateVisualState() {
  if (codeResultFlash.active || wifiConnectInProgress) {
    return;
  }

  if (tagAssignmentMode.active) {
    renderTagAssignmentFrame(static_cast<uint8_t>((millis() / 140) % (TOTAL_LEDS / 2)));
    return;
  }

  if (enteredCode.length() > 0) {
    renderCodeEntry();
    return;
  }

  renderLockerStatus();
}

void renderLockerStatus() {
  clearStrip();

  for (uint8_t lockerIndex = 0; lockerIndex < LOCKER_COUNT; lockerIndex += 1) {
    const LockerState state = readLockerState(lockerIndex);
    uint32_t color = colorRed();

    if (state.tagPresent) {
      color = isLockerComplete(state)
        ? colorGreen()
        : colorYellow();
    }

    const uint16_t start = lockerIndex * LEDS_PER_LOCKER;
    const uint16_t end = start + LEDS_PER_LOCKER;

    for (uint16_t led = start; led < end; led += 1) {
      strip.setPixelColor(led, color);
    }
  }

  strip.show();
}

void renderCodeEntry() {
  clearStrip();

  for (uint8_t i = 0; i < enteredCode.length() && i < CODE_LENGTH; i += 1) {
    strip.setPixelColor(CODE_ENTRY_LED_POSITIONS[i], colorBlue());
  }

  strip.show();
}

void renderWifiLoadingFrame(uint8_t frameIndex) {
  clearStrip();

  const uint8_t evenLedCount = TOTAL_LEDS / 2;
  const uint8_t litDots = (frameIndex % evenLedCount) + 1;

  for (uint8_t i = 0; i < litDots; i += 1) {
    const uint16_t ledIndex = i * 2;
    if (ledIndex < TOTAL_LEDS) {
      strip.setPixelColor(ledIndex, colorYellow());
    }
  }

  strip.show();
}

void renderTagAssignmentFrame(uint8_t frameIndex) {
  clearStrip();

  const uint8_t evenLedCount = TOTAL_LEDS / 2;
  const uint8_t litDots = (frameIndex % evenLedCount) + 1;

  for (uint8_t i = 0; i < litDots; i += 1) {
    const uint16_t ledIndex = i * 2;
    if (ledIndex < TOTAL_LEDS) {
      strip.setPixelColor(ledIndex, colorGreen(EFFECT_BRIGHTNESS));
    }
  }

  strip.show();
}

void flashCodeResult(const String& code, bool success) {
  codeResultFlash = {
    true,
    success,
    static_cast<uint8_t>(min(static_cast<size_t>(CODE_LENGTH), code.length())),
    0,
    millis()
  };
  renderCodeResultFrame(codeResultFlash.success, codeResultFlash.count, true);
}

void serviceCodeResultFlash(unsigned long now) {
  if (!codeResultFlash.active) {
    return;
  }

  static const unsigned long STAGE_DURATIONS_MS[] = { 180, 120, 180 };
  if (now - codeResultFlash.stageStartedMs < STAGE_DURATIONS_MS[codeResultFlash.stage]) {
    return;
  }

  codeResultFlash.stageStartedMs = now;
  codeResultFlash.stage += 1;

  if (codeResultFlash.stage == 1) {
    renderCodeResultFrame(codeResultFlash.success, codeResultFlash.count, false);
    return;
  }

  if (codeResultFlash.stage == 2) {
    renderCodeResultFrame(codeResultFlash.success, codeResultFlash.count, true);
    return;
  }

  codeResultFlash.active = false;
  updateVisualState();
}

void renderCodeResultFrame(bool success, uint8_t count, bool visible) {
  clearStrip();

  if (visible) {
    const uint32_t resultColor = success ? colorGreen(EFFECT_BRIGHTNESS) : colorRed(EFFECT_BRIGHTNESS);
    for (uint8_t i = 0; i < count; i += 1) {
      strip.setPixelColor(CODE_ENTRY_LED_POSITIONS[i], resultColor);
    }
  }

  strip.show();
}

void clearStrip() {
  strip.clear();
}

char mapRawKeyToChar(uint8_t rawKey) {
  if (rawKey >= 16) {
    return '\0';
  }

  return keypadCharMap[rawKey];
}

void initializeRfidReaders() {
  SPI.begin(RFID_SPI_SCK_PIN, RFID_SPI_MISO_PIN, RFID_SPI_MOSI_PIN);

  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    pinMode(lockerReaders[i].ssPin, OUTPUT);
    digitalWrite(lockerReaders[i].ssPin, HIGH);
  }

  pinMode(masterReaderRuntime.ssPin, OUTPUT);
  digitalWrite(masterReaderRuntime.ssPin, HIGH);

  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    lockerReaders[i].reader->PCD_Init();
    lockerReaders[i].reader->PCD_SetAntennaGain(MFRC522::RxGain_max);
    debugPrintReaderChipVersion(lockerReaders[i]);
  }

  masterReaderRuntime.reader->PCD_Init();
  masterReaderRuntime.reader->PCD_SetAntennaGain(MFRC522::RxGain_max);
  debugPrintReaderChipVersion(masterReaderRuntime);
}

void serviceRfidReaders(unsigned long now) {
  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    scanRfidReader(lockerReaders[i], now);
  }

  scanRfidReader(masterReaderRuntime, now);
}

bool scanRfidReader(RfidReaderRuntime& runtime, unsigned long now) {
  const RfidScanResult scanResult = readTagFromReader(*runtime.reader);
  updateReaderPresence(runtime, scanResult, now);
  return scanResult.present;
}

void updateReaderPresence(RfidReaderRuntime& runtime, const RfidScanResult& scanResult, unsigned long now) {
  if (scanResult.present) {
    runtime.lastSeenMs = now;

    if (scanResult.logicalTagId.length() > 0) {
      const bool uidChanged = !runtime.hasCard || scanResult.logicalTagId != runtime.stableUid;

      if (uidChanged) {
        runtime.stableUid = scanResult.logicalTagId;
        if (!runtime.isMaster) {
          runtime.reportDirty = true;
        }

        Serial.printf("[%s] tag detected: %s (physical UID: %s)%s\n",
          runtime.label,
          scanResult.logicalTagId.c_str(),
          scanResult.physicalUid.length() > 0 ? scanResult.physicalUid.c_str() : "(unknown)",
          scanResult.hasCustomTag ? " [programmed]" : ""
        );
      }
    }

    runtime.hasCard = true;

    if (runtime.isMaster) {
      if (tagAssignmentMode.active) {
        if (scanResult.physicalUid.length() > 0 && scanResult.physicalUid != runtime.lastTriggeredUid) {
          runtime.lastTriggeredUid = scanResult.physicalUid;

          String error;
          const bool writeOk = tryProgramTag(*runtime.reader, tagAssignmentMode.tagId, error);
          if (writeOk) {
            Serial.printf("Tag programming success. physical UID=%s logical tag=%s\n",
              scanResult.physicalUid.c_str(),
              tagAssignmentMode.tagId.c_str()
            );
          } else {
            Serial.printf("Tag programming failed for physical UID=%s: %s\n",
              scanResult.physicalUid.c_str(),
              error.c_str()
            );
          }

          postTagAssignmentResult(
            tagAssignmentMode.assignmentId,
            writeOk,
            tagAssignmentMode.tagId,
            scanResult.physicalUid,
            writeOk ? "" : error
          );

          if (writeOk) {
            blinkLed(2, 220, 120);
          } else {
            blinkLed(4, 90, 80);
          }

          stopTagAssignmentMode();
        }
      } else if (runtime.stableUid.length() > 0 && runtime.stableUid != runtime.lastTriggeredUid) {
        runtime.lastTriggeredUid = runtime.stableUid;
        verifyMasterTagRemotely(runtime.stableUid);
      }
    }

    return;
  }

  if (!runtime.hasCard) {
    if (runtime.isMaster && runtime.lastTriggeredUid.length() > 0 && now - runtime.lastSeenMs >= RFID_MASTER_REARM_DELAY_MS) {
      runtime.lastTriggeredUid = "";
    }
    return;
  }

  if (now - runtime.lastSeenMs < RFID_REMOVAL_DEBOUNCE_MS) {
    return;
  }

  Serial.printf("[%s] UID removed: %s\n", runtime.label, runtime.stableUid.length() > 0 ? runtime.stableUid.c_str() : "(unknown)");
  runtime.hasCard = false;

  if (!runtime.isMaster) {
    runtime.reportDirty = true;
  } else {
    runtime.lastTriggeredUid = "";
  }

  runtime.stableUid = "";
}

RfidScanResult readTagFromReader(MFRC522& reader) {
  RfidScanResult result = { false, "", "", false };

  byte atqa[2];
  byte atqaSize = sizeof(atqa);
  const MFRC522::StatusCode wakeStatus = reader.PICC_WakeupA(atqa, &atqaSize);

  if (wakeStatus != MFRC522::STATUS_OK && wakeStatus != MFRC522::STATUS_COLLISION) {
    return result;
  }

  result.present = true;

  if (!reader.PICC_ReadCardSerial()) {
    return result;
  }

  result.physicalUid = uidToString(reader.uid);

  String programmedTagId;
  if (tryReadProgrammedTagId(reader, programmedTagId)) {
    result.logicalTagId = programmedTagId;
    result.hasCustomTag = true;
  } else {
    result.logicalTagId = result.physicalUid;
  }

  reader.PICC_HaltA();
  reader.PCD_StopCrypto1();
  return result;
}

String uidToString(const MFRC522::Uid& uid) {
  String value;

  for (byte i = 0; i < uid.size; i += 1) {
    if (uid.uidByte[i] < 0x10) {
      value += '0';
    }

    value += String(uid.uidByte[i], HEX);
  }

  value.toUpperCase();
  return value;
}

void debugPrintReaderChipVersion(const RfidReaderRuntime& runtime) {
  const byte version = runtime.reader->PCD_ReadRegister(MFRC522::VersionReg);
  Serial.printf("[%s] SS=%u, MFRC522 version=0x%02X\n", runtime.label, runtime.ssPin, version);
}

bool authenticateClassicBlock(MFRC522& reader, byte blockAddr, MFRC522::MIFARE_Key& key) {
  for (byte i = 0; i < 6; i += 1) {
    key.keyByte[i] = 0xFF;
  }

  const MFRC522::StatusCode status = reader.PCD_Authenticate(
    MFRC522::PICC_CMD_MF_AUTH_KEY_A,
    blockAddr,
    &key,
    &(reader.uid)
  );

  return status == MFRC522::STATUS_OK;
}

bool tryReadProgrammedTagId(MFRC522& reader, String& tagId) {
  tagId = "";

  const MFRC522::PICC_Type piccType = reader.PICC_GetType(reader.uid.sak);
  if (
    piccType != MFRC522::PICC_TYPE_MIFARE_MINI &&
    piccType != MFRC522::PICC_TYPE_MIFARE_1K &&
    piccType != MFRC522::PICC_TYPE_MIFARE_4K
  ) {
    return false;
  }

  MFRC522::MIFARE_Key key;
  if (!authenticateClassicBlock(reader, RFID_APP_BLOCK, key)) {
    return false;
  }

  byte buffer[18];
  byte size = sizeof(buffer);
  const MFRC522::StatusCode status = reader.MIFARE_Read(RFID_APP_BLOCK, buffer, &size);
  if (status != MFRC522::STATUS_OK) {
    return false;
  }

  if (buffer[0] != RFID_APP_MAGIC_1 || buffer[1] != RFID_APP_MAGIC_2 || buffer[2] != RFID_APP_VERSION) {
    return false;
  }

  const byte length = min(static_cast<byte>(12), buffer[3]);
  if (length == 0) {
    return false;
  }

  for (byte i = 0; i < length; i += 1) {
    const char ch = static_cast<char>(buffer[4 + i]);
    if (ch == '\0' || ch == 0xFF) {
      break;
    }
    tagId += ch;
  }

  tagId.trim();
  tagId.toUpperCase();
  return tagId.length() > 0;
}

bool tryProgramTag(MFRC522& reader, const String& tagId, String& error) {
  error = "";

  const MFRC522::PICC_Type piccType = reader.PICC_GetType(reader.uid.sak);
  if (
    piccType != MFRC522::PICC_TYPE_MIFARE_MINI &&
    piccType != MFRC522::PICC_TYPE_MIFARE_1K &&
    piccType != MFRC522::PICC_TYPE_MIFARE_4K
  ) {
    error = "Tag nie wspiera zapisu MIFARE Classic.";
    return false;
  }

  const String normalizedTagId = tagId.substring(0, 12);
  if (normalizedTagId.length() == 0) {
    error = "Brak logicznego ID do zapisu.";
    return false;
  }

  MFRC522::MIFARE_Key key;
  if (!authenticateClassicBlock(reader, RFID_APP_BLOCK, key)) {
    error = "Nie udalo sie uwierzytelnic bloku RFID.";
    return false;
  }

  byte buffer[16];
  memset(buffer, 0, sizeof(buffer));
  buffer[0] = RFID_APP_MAGIC_1;
  buffer[1] = RFID_APP_MAGIC_2;
  buffer[2] = RFID_APP_VERSION;
  buffer[3] = static_cast<byte>(normalizedTagId.length());

  for (uint8_t i = 0; i < normalizedTagId.length() && i < 12; i += 1) {
    buffer[4 + i] = static_cast<byte>(normalizedTagId.charAt(i));
  }

  const MFRC522::StatusCode status = reader.MIFARE_Write(RFID_APP_BLOCK, buffer, 16);
  if (status != MFRC522::STATUS_OK) {
    error = String("Zapis MIFARE nie powiodl sie: ") + reader.GetStatusCodeName(status);
    return false;
  }

  return true;
}

bool postTagAssignmentResult(const String& assignmentId, bool success, const String& tagId, const String& physicalUid, const String& error) {
  HTTPClient http;
  const String url = String(API_BASE_URL) + "/device/tag-assignment-result";

  if (!http.begin(secureClient, url)) {
    Serial.println("HTTP begin failed for /device/tag-assignment-result");
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  if (strlen(DEVICE_API_KEY) > 0) {
    http.addHeader("x-device-key", DEVICE_API_KEY);
  }

  StaticJsonDocument<256> payload;
  payload["assignmentId"] = assignmentId;
  payload["success"] = success;
  payload["tagId"] = tagId;
  payload["physicalUid"] = physicalUid;
  if (!success && error.length() > 0) {
    payload["error"] = error;
  }

  String body;
  serializeJson(payload, body);

  const int httpCode = http.POST(body);
  const String responseBody = http.getString();
  http.end();

  Serial.printf("Tag assignment result -> success=%s tagId=%s physicalUid=%s HTTP=%d\n",
    success ? "true" : "false",
    tagId.c_str(),
    physicalUid.c_str(),
    httpCode
  );

  if (responseBody.length() > 0 && DEBUG_RFID_VERBOSE) {
    Serial.printf("Tag assignment response: %s\n", responseBody.c_str());
  }

  return httpCode >= 200 && httpCode < 300;
}
