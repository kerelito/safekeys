#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Keypad.h>

/*
  SafeKeys ESP32 debug controller

  Current hardware assumptions:
  - ESP32 dev board with onboard LED
  - 4x4 matrix keypad
  - no relays, RFID readers or door sensors connected yet

  Flow:
  - user enters a 4-digit code on the keypad
  - ESP32 sends the code to POST /verify-code
  - backend responds whether the code is valid and for which locker
  - result is shown in Serial logs and on the onboard LED
*/

static const char* WIFI_SSID = "TP-Link_70FC";
static const char* WIFI_PASSWORD = "13793814";

static const char* API_BASE_URL = "https://www.safekeys.pl";
static const char* DEVICE_API_KEY = "9f0c2a7e8b6d4f1a0c3e5b789abc1234567890abcdef1234567890abcdefabcd";

#ifdef LED_BUILTIN
static const uint8_t STATUS_LED_PIN = LED_BUILTIN;
#else
static const uint8_t STATUS_LED_PIN = 2;
#endif

static const bool STATUS_LED_ACTIVE_LEVEL = HIGH;

const byte KEYPAD_ROWS = 4;
const byte KEYPAD_COLS = 4;
char keypadMap[KEYPAD_ROWS][KEYPAD_COLS] = {
  { '1', '2', '3', 'A' },
  { '4', '5', '6', 'B' },
  { '7', '8', '9', 'C' },
  { '*', '0', '#', 'D' }
};

byte rowPins[KEYPAD_ROWS] = { 13, 12, 14, 27 };
byte colPins[KEYPAD_COLS] = { 26, 25, 33, 32 };
Keypad keypad = Keypad(makeKeymap(keypadMap), rowPins, colPins, KEYPAD_ROWS, KEYPAD_COLS);

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

void setup() {
  Serial.begin(115200);
  delay(300);

  pinMode(STATUS_LED_PIN, OUTPUT);
  setStatusLed(false);

  secureClient.setInsecure();

  Serial.println();
  Serial.println("=== SafeKeys ESP32 Debug ===");
  Serial.printf("LED pin: %u\n", STATUS_LED_PIN);
  Serial.printf("API base URL: %s\n", API_BASE_URL);
  printUsage();

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
  delay(10);
}

void connectWifi() {
  Serial.printf("Connecting to WiFi: %s\n", WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    blinkLed(1, 120, 180);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("WiFi connected. IP: ");
    Serial.println(WiFi.localIP());
    lastHeartbeatMs = 0;
    blinkLed(2, 140, 140);
    return;
  }

  Serial.println();
  Serial.println("WiFi connection failed. ESP32 will retry automatically.");
  blinkLed(4, 150, 120);
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
  const char key = keypad.getKey();
  if (!key) {
    return;
  }

  Serial.printf("Key pressed: %c\n", key);
  pulseLed(35);

  if (key >= '0' && key <= '9') {
    if (enteredCode.length() >= 4) {
      Serial.println("Buffer already has 4 digits. Press # to submit or * to clear.");
      blinkLed(2, 60, 60);
      return;
    }

    enteredCode += key;
    Serial.printf("Current code buffer: %s\n", enteredCode.c_str());
    return;
  }

  if (key == '*') {
    enteredCode = "";
    Serial.println("Code buffer cleared.");
    blinkLed(1, 80, 80);
    return;
  }

  if (key == '#') {
    if (enteredCode.length() != 4) {
      Serial.println("Enter exactly 4 digits before sending the code.");
      blinkLed(3, 70, 70);
      return;
    }

    processEnteredCode(enteredCode);
    enteredCode = "";
    return;
  }

  if (key == 'A') {
    Serial.println("Manual WiFi reconnect requested.");
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
  }
}

void processEnteredCode(const String& code) {
  bool isValid = false;
  int lockerNumber = 0;

  Serial.printf("Sending code %s to backend...\n", code.c_str());
  setStatusLed(true);

  const bool requestOk = verifyCodeRemotely(code, isValid, lockerNumber);

  setStatusLed(false);

  if (!requestOk) {
    Serial.println("Code verification request failed.");
    blinkLed(5, 80, 80);
    return;
  }

  if (!isValid) {
    Serial.printf("Code %s is invalid.\n", code.c_str());
    blinkLed(4, 120, 90);
    return;
  }

  Serial.printf("Code %s is valid for locker S%d.\n", code.c_str(), lockerNumber);
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
  payload["firmware"] = "safekeys-esp32-debug";
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
