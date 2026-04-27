#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <I2CKeyPad.h>
#include <Adafruit_NeoPixel.h>

/*
  SafeKeys ESP32 - wariant v2

  Zmiany względem bazowego firmware:
  - keypad 4x4 podłączony przez PCF8574 po I2C
  - pasek WS2812B obsługujący:
    * status 3 skrytek po 20 LED każda
    * podgląd wpisywanych cyfr
    * wynik poprawnego / błędnego kodu
    * loading WiFi

  Założenia sprzętowe do uzupełnienia:
  - 3 skrytki
  - dla każdej skrytki 3 wejścia:
    * czujnik obecności klucza
    * czujnik domknięcia drzwiczek
    * czujnik domknięcia zamka
*/

static const char* WIFI_SSID = "TP-Link_70FC";
static const char* WIFI_PASSWORD = "13793814";

static const char* API_BASE_URL = "https://safekeys-production-2760.up.railway.app";
static const char* DEVICE_API_KEY = "9f0c2a7e8b6d4f1a0c3e5b789abc1234567890abcdef1234567890abcdefabcd";

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
static const uint8_t CODE_ENTRY_LED_POSITIONS[CODE_LENGTH] = {
  9, 19, 29, 39
};

static const uint8_t STATUS_BRIGHTNESS = 48;
static const uint8_t EFFECT_BRIGHTNESS = 72;

static char keypadCharMap[] = {
  '1', '2', '3', 'A',
  '4', '5', '6', 'B',
  '7', '8', '9', 'C',
  '*', '0', '#', 'D',
  '\0', '?', '\0'
};
I2CKeyPad keypad(KEYPAD_I2C_ADDRESS);

Adafruit_NeoPixel strip(TOTAL_LEDS, STRIP_PIN, NEO_GRB + NEO_KHZ800);

struct LockerInputPin {
  uint8_t pin;
  bool activeLow;
};

struct LockerHardwareConfig {
  LockerInputPin keyPresent;
  LockerInputPin doorClosed;
  LockerInputPin lockClosed;
};

struct LockerState {
  bool keyPresent;
  bool doorClosed;
  bool lockClosed;
};

static const LockerHardwareConfig LOCKERS[LOCKER_COUNT] = {
  { { 16, true }, { 17, true }, { 18, true } },
  { { 19, true }, { 23, true }, { 25, true } },
  { { 26, true }, { 27, true }, { 33, true } }
};

WiFiClientSecure secureClient;
String enteredCode;

unsigned long lastWifiRetryMs = 0;
const unsigned long WIFI_RETRY_MS = 5000;
unsigned long lastHeartbeatMs = 0;
const unsigned long HEARTBEAT_INTERVAL_MS = 15000;
long lastHeartbeatPingMs = -1;

void connectWifi();
bool isWifiReady();
void handleKeypad();
void maybeSendHeartbeat();
void processEnteredCode(const String& code);
bool verifyCodeRemotely(const String& code, bool& isValid, int& lockerNumber);
bool postVerifyCode(const String& code, String& responseBody);
bool sendHeartbeat();
void printUsage();
void printStatus();
void setStatusLed(bool enabled);
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
void clearStrip();
char mapRawKeyToChar(uint8_t rawKey);

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
  keypad.setDebounceThreshold(25);

  strip.begin();
  strip.setBrightness(255);
  clearStrip();

  configureLockerInputs();

  secureClient.setInsecure();

  Serial.println();
  Serial.println("=== SafeKeys ESP32 v2 ===");
  Serial.printf("LED pin: %u\n", STATUS_LED_PIN);
  Serial.printf("Keypad I2C address: 0x%02X\n", KEYPAD_I2C_ADDRESS);
  Serial.printf("Keypad ready: %s\n", keypadReady ? "yes" : "no");
  Serial.printf("ARGB strip pin: %u, leds: %u\n", STRIP_PIN, TOTAL_LEDS);
  Serial.printf("API base URL: %s\n", API_BASE_URL);
  printUsage();

  updateVisualState();
  connectWifi();
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

  maybeSendHeartbeat();
  handleKeypad();
  updateVisualState();
  delay(10);
}

void connectWifi() {
  Serial.printf("Connecting to WiFi: %s\n", WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  uint8_t frame = 0;

  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    renderWifiLoadingFrame(frame);
    frame = static_cast<uint8_t>((frame + 1) % (TOTAL_LEDS / 2));
    pulseLed(35);
    Serial.print(".");
    delay(120);
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("WiFi connected. IP: ");
    Serial.println(WiFi.localIP());
    lastHeartbeatMs = 0;
    blinkLed(2, 140, 140);
    updateVisualState();
    return;
  }

  Serial.println();
  Serial.println("WiFi connection failed. ESP32 will retry automatically.");
  blinkLed(4, 150, 120);
  updateVisualState();
}

bool isWifiReady() {
  return WiFi.status() == WL_CONNECTED;
}

void maybeSendHeartbeat() {
  if (lastHeartbeatMs != 0 && millis() - lastHeartbeatMs < HEARTBEAT_INTERVAL_MS) {
    return;
  }

  lastHeartbeatMs = millis();
  sendHeartbeat();
}

void handleKeypad() {
  const uint8_t rawKey = keypad.getKey();
  if (rawKey == I2C_KEYPAD_NOKEY || rawKey == I2C_KEYPAD_THRESHOLD) {
    return;
  }

  if (rawKey == I2C_KEYPAD_FAIL) {
    Serial.println("Keypad read failed or multiple keys pressed.");
    blinkLed(2, 50, 50);
    return;
  }

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
    delay(200);
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

  if (httpCode < 200 || httpCode >= 300) {
    return false;
  }

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

  StaticJsonDocument<256> payload;
  payload["firmware"] = "safekeys-esp32-v2";
  payload["ip"] = WiFi.localIP().toString();
  payload["wifiRssi"] = WiFi.RSSI();
  payload["uptimeMs"] = millis();
  payload["freeHeap"] = ESP.getFreeHeap();

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
  Serial.println("v2 visuals:");
  Serial.println("  - lockers: green = complete, red = incomplete");
  Serial.println("  - code entry: leds 10/20/30/40 light blue progressively");
  Serial.println("  - WiFi connect: yellow loading on every second LED");
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

  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    const LockerState state = readLockerState(i);
    Serial.printf(
      "Locker S%u -> key=%s, door=%s, lock=%s, complete=%s\n",
      i + 1,
      state.keyPresent ? "yes" : "no",
      state.doorClosed ? "closed" : "open",
      state.lockClosed ? "closed" : "open",
      isLockerComplete(state) ? "yes" : "no"
    );
  }
}

void setStatusLed(bool enabled) {
  digitalWrite(STATUS_LED_PIN, enabled ? STATUS_LED_ACTIVE_LEVEL : !STATUS_LED_ACTIVE_LEVEL);
}

void blinkLed(uint8_t times, unsigned long onMs, unsigned long offMs) {
  for (uint8_t i = 0; i < times; i += 1) {
    setStatusLed(true);
    delay(onMs);
    setStatusLed(false);
    if (i + 1 < times) {
      delay(offMs);
    }
  }
}

void pulseLed(unsigned long durationMs) {
  setStatusLed(true);
  delay(durationMs);
  setStatusLed(false);
}

void configureLockerInputs() {
  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    pinMode(LOCKERS[i].keyPresent.pin, INPUT_PULLUP);
    pinMode(LOCKERS[i].doorClosed.pin, INPUT_PULLUP);
    pinMode(LOCKERS[i].lockClosed.pin, INPUT_PULLUP);
  }
}

bool readInputPin(const LockerInputPin& config) {
  const bool raw = digitalRead(config.pin) == HIGH;
  return config.activeLow ? !raw : raw;
}

LockerState readLockerState(uint8_t lockerIndex) {
  const LockerHardwareConfig& cfg = LOCKERS[lockerIndex];
  return {
    readInputPin(cfg.keyPresent),
    readInputPin(cfg.doorClosed),
    readInputPin(cfg.lockClosed)
  };
}

bool isLockerComplete(const LockerState& state) {
  return state.keyPresent && state.doorClosed && state.lockClosed;
}

void updateVisualState() {
  if (!isWifiReady()) {
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
    const uint32_t color = isLockerComplete(state) ? colorGreen() : colorRed();
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

void flashCodeResult(const String& code, bool success) {
  const uint32_t resultColor = success ? colorGreen(EFFECT_BRIGHTNESS) : colorRed(EFFECT_BRIGHTNESS);
  const uint8_t count = min(static_cast<size_t>(CODE_LENGTH), code.length());

  clearStrip();
  for (uint8_t i = 0; i < count; i += 1) {
    strip.setPixelColor(CODE_ENTRY_LED_POSITIONS[i], resultColor);
  }
  strip.show();
  delay(180);

  clearStrip();
  strip.show();
  delay(120);

  for (uint8_t i = 0; i < count; i += 1) {
    strip.setPixelColor(CODE_ENTRY_LED_POSITIONS[i], resultColor);
  }
  strip.show();
  delay(180);
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
