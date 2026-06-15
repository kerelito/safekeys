#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Update.h>
#include <Preferences.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <SPI.h>
#include <esp_idf_version.h>
#include <esp_heap_caps.h>
#include <esp_system.h>
#include <esp_task_wdt.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
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
static const char* DEVICE_ID = "esp32-main";
static const char* DEVICE_WS_HOST = "www.safekeys.pl";
static const uint16_t DEVICE_WS_PORT = 443;
static const uint16_t DEVICE_PROTOCOL_VERSION = 2;
static const char* FIRMWARE_VERSION = "safekeys-esp32-v4-service-panel-ws-framed";

static const char* SERVICE_PANEL_USERNAME = "admin";
static const char* SERVICE_PANEL_PASSWORD = "safekeys-admin";
static const char* SERVICE_SETUP_AP_PASSWORD = "safekeys-setup";
static const uint16_t SERVICE_PANEL_PORT = 80;
static const uint16_t SERVICE_DNS_PORT = 53;
static const uint8_t WIFI_SETUP_FAILURE_THRESHOLD = 3;
static const unsigned long WIFI_SETUP_AUTO_START_MS = 45000;
static const unsigned long SERVICE_SETUP_TIMEOUT_MS = 10UL * 60UL * 1000UL;
static const unsigned long SERVICE_WIFI_RECONNECT_DELAY_MS = 1000;
static const unsigned long REMOTE_CONFIG_FETCH_INTERVAL_MS = 300000;
static const unsigned long REMOTE_CONFIG_FETCH_RETRY_MS = 30000;

static const bool ENABLE_KEYPAD = true;
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
static const uint8_t LOCK_RELAY_COUNT = 4;
static const uint8_t LEDS_PER_LOCKER = 20;
static const uint8_t LOCK_RELAY_PINS[LOCK_RELAY_COUNT] = {
  27, // locker 1
  26, // locker 2
  25, // locker 3
  33  // locker 4
};
static const bool RELAY_ACTIVE_LOW = true;
static const uint32_t LOCK_UNLOCK_PULSE_MS = 700;
static const bool OPEN_LOCKS_PARALLEL = true;

static_assert(LOCKER_COUNT <= LOCK_RELAY_COUNT, "Logical lockers exceed configured relay outputs.");

static const uint8_t CODE_LENGTH = 4;
static const uint8_t CODE_ENTRY_GROUP_SIZE = 3;
static const uint16_t CODE_ENTRY_LED_GROUP_STARTS[CODE_LENGTH] = { 8, 22, 36, 50 };
static const unsigned long CODE_VERIFY_PENDING_PULSE_MS = 900;
static const unsigned long CODE_RESULT_ON_MS = 180;
static const unsigned long CODE_RESULT_OFF_MS = 120;
static const uint8_t CODE_RESULT_BLINKS = 3;

static const uint8_t STATUS_BRIGHTNESS = 48;
static const uint8_t EFFECT_BRIGHTNESS = 72;

static const uint8_t RFID_SPI_SCK_PIN = 14;
static const uint8_t RFID_SPI_MISO_PIN = 12;
static const uint8_t RFID_SPI_MOSI_PIN = 13;
static const uint8_t RFID_RST_PIN = 15;
static const uint8_t RFID_LOCKER_SS_PINS[LOCKER_COUNT] = { 5, 16, 17 };
static const uint8_t RFID_MASTER_SS_PIN = 32;
static const byte RFID_ANTENNA_GAIN = MFRC522::RxGain_max;

static const unsigned long WIFI_RETRY_MS = 5000;
static const unsigned long WIFI_RETRY_MAX_MS = 60000;
static const unsigned long WIFI_AUTH_FAILURE_RETRY_MS = 30000;
static const unsigned long WIFI_CONNECT_TIMEOUT_MS = 15000;
static const unsigned long WIFI_LOADING_FRAME_MS = 120;
static const unsigned long HEARTBEAT_INTERVAL_MS = 60000;
static const unsigned long LOCKER_STATUS_RESYNC_INTERVAL_MS = 300000;
static const unsigned long DEVICE_ACTIONS_POLL_INTERVAL_MS = 8000;
static const unsigned long DEVICE_ACTIONS_POLL_INTERVAL_MAX_MS = 60000;
static const unsigned long DEVICE_ACTIONS_LONG_POLL_WAIT_MS = 3000;
static const unsigned long DEVICE_WS_SERVICE_INTERVAL_MS = 20;
static const unsigned long DEVICE_WS_RECONNECT_BASE_MS = 2000;
static const unsigned long DEVICE_WS_RECONNECT_MAX_MS = 60000;
static const unsigned long DEVICE_WS_PING_INTERVAL_MS = 15000;
static const unsigned long DEVICE_WS_PONG_TIMEOUT_MS = 5000;
static const uint8_t DEVICE_WS_DISCONNECT_TIMEOUT_COUNT = 2;
static const unsigned long DEVICE_WS_FALLBACK_AFTER_MS = 45000;
static const unsigned long DEVICE_WS_STABLE_SESSION_MS = 30000;
static const unsigned long DEVICE_WS_CONNECT_ATTEMPT_TIMEOUT_MS = 12000;
static const unsigned long DEVICE_WS_HELLO_DELAY_MS = 150;
static const unsigned long DEVICE_WS_HEAP_RETRY_MS = 30000;
static const uint32_t DEVICE_WS_MIN_FREE_HEAP = 70000;
static const uint32_t DEVICE_WS_MIN_LARGEST_BLOCK = 32768;
static const size_t DEVICE_WS_SEND_PAYLOAD_MAX = 1536;
static const bool DEVICE_STATE_WS_ACK_REQUIRED = false;
static const unsigned long DEVICE_VERIFY_CODE_TIMEOUT_MS = 20000;
static const unsigned long DEVICE_VERIFY_CODE_RESULT_GRACE_MS = 5000;
static const unsigned long DEVICE_VERIFY_MASTER_TAG_TIMEOUT_MS = 20000;
static const unsigned long DEVICE_VERIFY_MASTER_TAG_RESULT_GRACE_MS = 5000;
static const unsigned long VERIFY_DUPLICATE_COOLDOWN_MS = 5000;
static const uint8_t CODE_RATE_LIMIT_MAX_FAILURES_DEFAULT = 5;
static const unsigned long CODE_RATE_LIMIT_WINDOW_MS_DEFAULT = 300000;
static const unsigned long CODE_RATE_LIMIT_LOCKOUT_MS_DEFAULT = 30000;
static const unsigned long ACCESS_SELECTION_TIMEOUT_MS = 60000;
static const unsigned long ACCESS_SELECTION_DENIED_BLINK_MS = 500;
static const unsigned long ACCESS_SELECTION_ALLOWED_FRAME_MS = 70;
static const uint8_t ACCESS_SELECTION_TAIL_LENGTH = 3;
static const unsigned long LED_FRAME_INTERVAL_MS = 70;
static const unsigned long LED_STARTUP_EFFECT_MS = 1800;
static const unsigned long LED_SYNC_OK_EFFECT_MS = 900;
static const unsigned long LED_REMOTE_FLASH_MS = 900;
static const unsigned long LED_TAG_ASSIGNMENT_SUCCESS_MS = 1000;
static const unsigned long LED_UNKNOWN_TAG_PULSE_MS = 1600;
static const unsigned long LED_DOOR_BLINK_MS = 500;
static const unsigned long LED_BACKEND_OFFLINE_PULSE_MS = 1100;
static const unsigned long LED_ONLINE_BREATH_MS = 2600;
static const unsigned long LED_READER_ERROR_BLINK_MS = 160;
static const unsigned long LED_STATE_SYNC_PENDING_MS = 180;
static const unsigned long LED_PANEL_STATUS_RESULT_WAIT_MS = 5000;
static const unsigned long DEVICE_STATE_BATCH_ACK_TIMEOUT_MS = 8000;
static const unsigned long DEVICE_STATE_BATCH_FALLBACK_DELAY_MS = 500;
static const unsigned long DEVICE_STATE_BATCH_RETRY_BASE_MS = 5000;
static const unsigned long DEVICE_STATE_BATCH_RETRY_MAX_MS = 60000;
static const unsigned long STATE_DUPLICATE_SUPPRESS_LOG_INTERVAL_MS = 10000;
static const unsigned long LOCKER_STATUS_BATCH_WINDOW_MS = 1200;
static const unsigned long LOCKER_STATUS_RETRY_BASE_MS = 5000;
static const unsigned long LOCKER_STATUS_RETRY_MAX_MS = 120000;
static const unsigned long LOCKER_INPUT_SCAN_INTERVAL_MS = 50;
static const unsigned long LOCKER_INPUT_DEBOUNCE_MS = 250;
static const unsigned long RFID_REMOVAL_DEBOUNCE_MS = 900;
static const unsigned long RFID_MASTER_REARM_DELAY_MS = 1500;
static const unsigned long RFID_SCAN_INTERVAL_MS = 5;
static const unsigned long RFID_HEALTH_CHECK_INTERVAL_MS = 5000;
static const uint8_t KEYPAD_RELEASE_CONFIRM_SCANS = 3;
static const unsigned long KEYPAD_RELEASE_DEBOUNCE_MS = 25;
static const uint8_t RFID_PRESENT_CONFIRM_SCANS = 3;
static const uint8_t RFID_MISSING_CONFIRM_SCANS = 4;
static const unsigned long NETWORK_QUEUE_WAIT_MS = 500;
static const uint16_t HTTP_CONNECT_TIMEOUT_MS = 8000;
static const uint16_t HTTP_RESPONSE_TIMEOUT_MS = 10000;
static const uint16_t HTTP_TLS_HANDSHAKE_TIMEOUT_SECONDS = 20;
static const uint8_t NETWORK_QUEUE_LENGTH = 12;
static const uint16_t NETWORK_TASK_STACK_SIZE = 8192;
static const uint32_t TASK_WATCHDOG_TIMEOUT_SECONDS = 45;
static const uint8_t COMMAND_DEDUP_CACHE_SIZE = 12;
static const uint8_t NETWORK_FAILURES_BEFORE_WIFI_RESET = 8;
static const unsigned long NETWORK_FAILURE_RETRY_BASE_MS = 2000;
static const unsigned long NETWORK_FAILURE_RETRY_MAX_MS = 30000;
static const unsigned long NETWORK_WIFI_RECOVERY_COOLDOWN_MS = 30000;
static const byte RFID_APP_BLOCK = 4;
static const char RFID_APP_MAGIC_1 = 'S';
static const char RFID_APP_MAGIC_2 = 'K';
static const char RFID_APP_VERSION = '1';
static const uint8_t RFID_AUTH_RETRY_COUNT = 3;
static const unsigned long RFID_AUTH_RETRY_DELAY_MS = 30;

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
  bool tagProgrammed;
  String tagUid;
  bool doorClosed;
  bool lockClosed;
};

struct LockRelayState {
  bool active;
  bool pulsed;
  uint32_t startedAtMs;
  uint32_t durationMs;
};

struct LockOpenAllSequenceState {
  bool active;
  uint8_t pendingMask;
};

struct LockerLedSegment {
  uint16_t start;
  uint16_t end;
  uint16_t length;
  bool valid;
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
  bool stableHasCustomTag;
  String stableUid;
  String stablePhysicalUid;
  String lastTriggeredUid;
  String candidateUid;
  unsigned long lastSeenMs;
  unsigned long lastReportMs;
  unsigned long dirtySinceMs;
  unsigned long nextReportAttemptMs;
  bool reportDirty;
  uint8_t candidateSeenCount;
  uint8_t missingSeenCount;
  uint8_t reportFailureCount;
};

struct TagAssignmentMode {
  bool active;
  String assignmentId;
  String tagId;
  String itemName;
  unsigned long startedMs;
  unsigned long animationFrame;
};

enum LedMode : uint8_t {
  LED_MODE_NORMAL,
  LED_MODE_ACCESS_SELECTION,
  LED_MODE_ERROR_FLASH
};

enum class LockerLedStatus : uint8_t {
  Ok,
  Warning,
  Error
};

enum class LockerItemStatus : uint8_t {
  Unknown,
  Missing,
  Known,
  UnknownTag
};

enum LedStripEffectKind : uint8_t {
  LED_STRIP_EFFECT_NONE,
  LED_STRIP_EFFECT_STARTUP,
  LED_STRIP_EFFECT_SYNC_OK,
  LED_STRIP_EFFECT_TAG_ASSIGN_SUCCESS,
  LED_STRIP_EFFECT_REMOTE_ALL
};

struct LedStripEffect {
  bool active;
  LedStripEffectKind kind;
  uint32_t startedAtMs;
  uint32_t durationMs;
};

struct LedSegmentFlashEffect {
  bool active;
  uint8_t lockerNumber;
  uint32_t startedAtMs;
  uint32_t durationMs;
  uint32_t color;
};

struct AccessSelectionSession {
  bool active;
  String uid;
  bool isMaster;
  uint8_t accessibleMask;
  uint32_t startedAtMs;
  uint32_t timeoutMs;
  String requestId;
  uint32_t sessionId;
  String userId;
  String userName;
  String lastBusyUid;
};

struct ErrorFlashEffect {
  bool active;
  uint32_t startedAtMs;
  uint32_t durationMs;
};

struct RfidVerifyRequest {
  bool active;
  bool timedOut;
  bool acked;
  String uid;
  String requestId;
  uint32_t sentAtMs;
  uint32_t timeoutMs;
  uint32_t graceMs;
};

enum class NetworkJobType : uint8_t {
  Heartbeat,
  LockerStatus,
  DeviceStateBatch,
  CommandAck,
  DeviceActionsPoll,
  VerifyCode,
  VerifyMasterTag,
  AccessSelectionEvent,
  TagAssignmentResult,
  DeviceLog,
  DeviceDiagnostic,
  FetchRemoteConfig
};

struct NetworkJob {
  NetworkJobType type;
  uint8_t lockerNumber;
  bool boolValue;
  bool boolValue2;
  bool boolValue3;
  uint32_t numberValue;
  char text1[32];
  char text2[32];
  char text3[32];
  char text4[96];
  char text5[64];
  bool lockerHasTag[LOCKER_COUNT];
  bool lockerDoorClosed[LOCKER_COUNT];
  bool lockerLockClosed[LOCKER_COUNT];
  uint32_t lockerVersions[LOCKER_COUNT];
  char lockerTags[LOCKER_COUNT][24];
};

enum class NetworkResultType : uint8_t {
  Heartbeat,
  LockerStatus,
  DeviceStateBatch,
  DeviceStateAck,
  DeviceCommand,
  CommandAck,
  DeviceActionsPoll,
  VerifyCode,
  VerifyMasterTag,
  RemoteConfig
};

struct NetworkResult {
  NetworkResultType type;
  bool requestOk;
  bool boolValue1;
  bool boolValue2;
  bool boolValue3;
  bool boolValue4;
  bool boolValue5;
  bool boolValue6;
  uint8_t lockerNumber;
  uint8_t count;
  long numberValue;
  char text1[32];
  char text2[64];
  char text3[64];
  char text4[32];
  char requestId[64];
  char actionId[32];
  char actionType[32];
  uint8_t lockers[LOCKER_COUNT];
  uint32_t lockerVersions[LOCKER_COUNT];
  uint32_t configVersion;
  uint32_t heartbeatIntervalMs;
  uint32_t deviceActionsPollIntervalMs;
  uint32_t lockPulseMs;
  uint32_t codeRateLimitWindowMs;
  uint32_t codeRateLimitLockoutMs;
  uint8_t codeRateLimitMaxFailures;
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
WebSocketsClient deviceWebSocket;
WebServer serviceServer(SERVICE_PANEL_PORT);
DNSServer setupDnsServer;
Preferences devicePreferences;

RfidReaderRuntime lockerReaders[LOCKER_COUNT] = {
  { "locker-rfid-1", RFID_LOCKER_SS_PINS[0], false, 1, &lockerReader1, false, false, "", "", "", "", 0, 0, 0, 0, true, 0, 0, 0 },
  { "locker-rfid-2", RFID_LOCKER_SS_PINS[1], false, 2, &lockerReader2, false, false, "", "", "", "", 0, 0, 0, 0, true, 0, 0, 0 },
  { "locker-rfid-3", RFID_LOCKER_SS_PINS[2], false, 3, &lockerReader3, false, false, "", "", "", "", 0, 0, 0, 0, true, 0, 0, 0 }
};

RfidReaderRuntime masterReaderRuntime = {
  "master-rfid",
  RFID_MASTER_SS_PIN,
  true,
  0,
  &masterReader,
  false,
  false,
  "",
  "",
  "",
  "",
  0,
  0,
  0,
  0,
  false,
  0,
  0,
  0
};

String enteredCode;
String serialCommandBuffer;
String configuredWifiSsid;
String configuredWifiPassword;
String setupApSsid;

unsigned long lastWifiRetryMs = 0;
unsigned long lastHeartbeatMs = 0;
unsigned long lastDeviceActionsPollMs = 0;
long lastHeartbeatPingMs = -1;
uint8_t lastStableRawKey = I2C_KEYPAD_NOKEY;
bool keypadPressLocked = false;
uint8_t keypadReleaseScanCount = 0;
unsigned long keypadReleaseStartedMs = 0;
bool keypadReady = false;
bool wifiConnectInProgress = false;
unsigned long wifiConnectStartedMs = 0;
unsigned long wifiFirstConnectAttemptMs = 0;
unsigned long lastWifiLoadingFrameMs = 0;
unsigned long wifiRetryIntervalMs = WIFI_RETRY_MS;
uint8_t consecutiveWifiFailureCount = 0;
uint8_t wifiLoadingFrame = 0;
bool wifiConfigLoadedFromNvs = false;
bool servicePanelStarted = false;
bool serviceSetupPortalActive = false;
bool serviceSetupPortalStartRequested = false;
char serviceSetupPortalRequestedReason[48] = "";
unsigned long serviceSetupPortalStartedMs = 0;
bool serviceWifiReconnectRequested = false;
unsigned long serviceWifiReconnectAtMs = 0;
bool remoteConfigQueued = false;
unsigned long nextRemoteConfigFetchMs = 0;
uint32_t remoteConfigVersion = 0;
bool remoteLogHttpUnsupported = false;
bool remoteDiagnosticHttpUnsupported = false;
bool remoteConfigHttpUnsupported = false;
uint32_t runtimeHeartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;
uint32_t runtimeDeviceActionsPollBaseMs = DEVICE_ACTIONS_POLL_INTERVAL_MS;
uint32_t runtimeLockUnlockPulseMs = LOCK_UNLOCK_PULSE_MS;
bool runtimeRemoteLoggingEnabled = true;
bool runtimeCodeRateLimitEnabled = true;
bool runtimeServicePanelEnabled = true;
bool runtimeOtaEnabled = true;
bool runtimeDiagnosticsEnabled = true;
uint8_t runtimeCodeRateLimitMaxFailures = CODE_RATE_LIMIT_MAX_FAILURES_DEFAULT;
uint32_t runtimeCodeRateLimitWindowMs = CODE_RATE_LIMIT_WINDOW_MS_DEFAULT;
uint32_t runtimeCodeRateLimitLockoutMs = CODE_RATE_LIMIT_LOCKOUT_MS_DEFAULT;
uint8_t codeRateLimitFailureCount = 0;
unsigned long codeRateLimitWindowStartedMs = 0;
unsigned long codeRateLimitLockedUntilMs = 0;
bool statusLedBaseEnabled = false;
StatusLedEffect statusLedEffect = { false, false, false, 0, 0, 0, 0 };
CodeResultFlashEffect codeResultFlash = { false, false, 0, 0, 0 };
TagAssignmentMode tagAssignmentMode = { false, "", "", "", 0, 0 };
AccessSelectionSession accessSelection = {
  false,
  "",
  false,
  0,
  0,
  ACCESS_SELECTION_TIMEOUT_MS,
  "",
  0,
  "",
  "",
  ""
};
LockRelayState lockRelayStates[LOCK_RELAY_COUNT] = {};
LockOpenAllSequenceState lockOpenAllSequence = { false, 0 };
ErrorFlashEffect ledErrorFlash = { false, 0, 0 };
RfidVerifyRequest pendingMasterTagVerify = {
  false,
  false,
  false,
  "",
  "",
  0,
  DEVICE_VERIFY_MASTER_TAG_TIMEOUT_MS,
  DEVICE_VERIFY_MASTER_TAG_RESULT_GRACE_MS
};
String lastVerifiedUid;
unsigned long lastVerifyStartedAtMs = 0;
LedMode ledMode = LED_MODE_NORMAL;
bool visualStateDirty = true;
unsigned long lastRfidServiceMs = 0;
uint8_t nextRfidReaderIndex = 0;
uint8_t lastTagAssignmentFrame = 0xFF;
QueueHandle_t networkJobQueue = nullptr;
QueueHandle_t networkResultQueue = nullptr;
TaskHandle_t networkTaskHandle = nullptr;
bool heartbeatQueued = false;
bool deviceActionsPollQueued = false;
bool codeVerificationPending = false;
bool codeVerificationTimedOut = false;
bool masterTagVerificationPending = false;
bool lockerStatusQueued[LOCKER_COUNT] = { false, false, false };
bool deviceStateBatchQueued = false;
bool deviceStateAckPending = false;
bool forceNextStateBatchHttps = false;
char pendingCode[CODE_LENGTH + 1] = "";
char pendingCodeMessageId[64] = "";
char expiredCode[CODE_LENGTH + 1] = "";
char expiredCodeMessageId[64] = "";
char pendingMasterTagId[32] = "";
char pendingMasterTagMessageId[64] = "";
char expiredMasterTagId[32] = "";
char expiredMasterTagMessageId[64] = "";
char pendingStateMessageId[64] = "";
bool taskWatchdogReady = false;
volatile uint8_t consecutiveNetworkFailureCount = 0;
volatile unsigned long nextBackgroundNetworkAttemptMs = 0;
volatile unsigned long lastWifiRecoveryAttemptMs = 0;
unsigned long deviceActionsPollIntervalMs = DEVICE_ACTIONS_POLL_INTERVAL_MS;
volatile bool deviceWsConnected = false;
volatile bool deviceWsConfigured = false;
volatile bool deviceWsReconnectRequested = true;
volatile bool deviceWsConnectAttemptActive = false;
volatile bool deviceWsHelloSent = false;
volatile bool deviceWsHelloPending = false;
volatile bool deviceWsServerHelloSeen = false;
volatile unsigned long lastDeviceWsServiceMs = 0;
volatile unsigned long lastDeviceWsConnectAttemptMs = 0;
volatile unsigned long nextDeviceWsConnectAttemptMs = 0;
volatile unsigned long lastDeviceWsConnectedMs = 0;
volatile unsigned long deviceWsHelloDueMs = 0;
unsigned long deviceWsReconnectDelayMs = DEVICE_WS_RECONNECT_BASE_MS;
unsigned long lastDeviceWsHeartbeatMs = 0;
unsigned long lastDeviceStateBatchMs = 0;
unsigned long pendingCodeSentMs = 0;
unsigned long pendingMasterTagSentMs = 0;
unsigned long nextFullStateResyncDueMs = 0;
unsigned long pendingStateBatchSentMs = 0;
unsigned long nextDeviceStateBatchAttemptMs = 0;
volatile bool panelStatusResultPending = false;
volatile unsigned long panelStatusResultPendingStartedMs = 0;
uint32_t deviceMessageSequence = 0;
uint32_t lockerStateVersions[LOCKER_COUNT] = { 1, 1, 1 };
uint32_t pendingStateVersions[LOCKER_COUNT] = { 0, 0, 0 };
LockerLedStatus panelLockerLedStatuses[LOCKER_COUNT] = {
  LockerLedStatus::Warning,
  LockerLedStatus::Warning,
  LockerLedStatus::Warning
};
bool panelLockerLedStatusKnown[LOCKER_COUNT] = { false, false, false };
uint32_t panelLockerLedStatusVersions[LOCKER_COUNT] = { 0, 0, 0 };
LockerItemStatus panelLockerItemStatuses[LOCKER_COUNT] = {
  LockerItemStatus::Unknown,
  LockerItemStatus::Unknown,
  LockerItemStatus::Unknown
};
bool panelLockerDoorClosed[LOCKER_COUNT] = { true, true, true };
bool lockerReaderHealthy[LOCKER_COUNT] = { true, true, true };
bool masterReaderHealthy = true;
bool fullStateResyncPending = true;
bool pendingStateWasFull = false;
uint32_t fullStateResyncGeneration = 1;
uint32_t pendingFullStateResyncGeneration = 0;
uint32_t lastAckedFullStateResyncGeneration = 0;
uint32_t pendingStateFingerprint = 0;
uint32_t lastAckedStateFingerprint = 0;
bool lastAckedStateFingerprintReady = false;
uint8_t deviceStateBatchFailureCount = 0;
uint16_t staleStateAckLogSuppressed = 0;
unsigned long lastDuplicateStateSuppressedLogMs = 0;
char deviceBootId[17] = "";
char deviceWsPath[96] = "";
uint8_t deviceWsTxDebugFramesRemaining = 8;
bool lockerInputSnapshotReady[LOCKER_COUNT] = { false, false, false };
bool lastLockerDoorClosed[LOCKER_COUNT] = { true, true, true };
bool lastLockerLockClosed[LOCKER_COUNT] = { true, true, true };
bool lockerInputCandidateReady[LOCKER_COUNT] = { false, false, false };
bool candidateLockerDoorClosed[LOCKER_COUNT] = { true, true, true };
bool candidateLockerLockClosed[LOCKER_COUNT] = { true, true, true };
unsigned long lockerInputCandidateSinceMs[LOCKER_COUNT] = { 0, 0, 0 };
unsigned long lastLockerInputServiceMs = 0;
unsigned long lastRfidHealthCheckMs = 0;
char processedCommandIds[COMMAND_DEDUP_CACHE_SIZE][32] = {};
uint8_t nextProcessedCommandSlot = 0;
LedStripEffect ledStripEffect = { false, LED_STRIP_EFFECT_NONE, 0, 0 };
LedSegmentFlashEffect ledSegmentFlashEffect = { false, 0, 0, 0, 0 };
unsigned long lastLedFrameMs = 0;

void configureWiFiRuntime();
void loadPersistentSettings();
void saveWifiCredentials(const String& ssid, const String& password);
void clearWifiCredentials();
const String& getActiveWifiSsid();
const String& getActiveWifiPassword();
void connectWifi();
void serviceWifiConnection(unsigned long now);
void maybeStartSetupPortalAfterWifiFailures(unsigned long now);
void requestServiceSetupPortal(const char* reason);
void startServicePanel();
void serviceServicePanel(unsigned long now);
void startServiceSetupPortal(const char* reason);
void stopServiceSetupPortal();
void scheduleServiceWifiReconnect(unsigned long delayMs);
void serviceScheduledWifiReconnect(unsigned long now);
bool requireServiceAuth();
void handleServiceRoot();
void handleServiceStatusJson();
void handleServiceDiagnosticsPage();
void handleServiceDiagnosticAction();
void handleServiceWifiPage();
void handleServiceWifiSave();
void handleServiceWifiScanJson();
void handleServiceOtaPage();
void handleServiceOtaUpload();
void handleServiceOtaFinished();
void handleServiceFactoryReset();
void handleServiceCaptivePortal();
void handleServiceFavicon();
void handleServiceNotFound();
String buildStatusJson();
String htmlEscape(const String& value);
void handleWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info);
void logWiFiSnapshot(const char* prefix);
bool isWifiReady();
void initializeDeviceIdentity();
void serviceDeviceWebSocket(unsigned long now);
void configureDeviceWebSocket();
void connectDeviceWebSocket(unsigned long now, bool forceNow = false);
void disconnectDeviceWebSocket();
bool hasEnoughHeapForDeviceWebSocket();
bool isDeviceWebSocketOpen();
bool isDeviceWebSocketReady();
bool isDeviceWebSocketStable(unsigned long now);
bool sendDeviceWebSocketText(const char* payload, size_t length);
void maybeSendDeviceHello(unsigned long now);
bool shouldUseHttpsFallback(unsigned long now);
void handleDeviceWebSocketEvent(WStype_t type, uint8_t* payload, size_t length);
void handleDeviceWebSocketMessage(const char* payload, size_t length);
void handleTagVerifyResultMessage(JsonDocument& doc);
void handleCodeVerifyResultMessage(JsonDocument& doc);
void handleLockerStatusResultMessage(JsonDocument& doc);
bool sendDeviceHello();
bool sendDeviceHeartbeatWs();
bool sendDeviceStateBatchWs(const NetworkJob& job);
bool sendDeviceCommandAckWs(const NetworkJob& job);
bool sendTagAssignmentResultWs(const NetworkJob& job);
bool sendVerifyCodeWs(const NetworkJob& job);
bool sendVerifyMasterTagWs(const NetworkJob& job);
bool sendAccessSelectionEventWs(const NetworkJob& job);
bool sendDeviceLogWs(const NetworkJob& job);
bool sendDeviceDiagnosticWs(const NetworkJob& job);
bool fetchRemoteConfigForTask(NetworkResult& result);
bool postDeviceLog(const NetworkJob& job);
bool postDeviceDiagnostic(const NetworkJob& job);
bool postDeviceStateBatch(const NetworkJob& job);
bool postLegacyLockerStatusBatch(const NetworkJob& job);
bool postVerifyMasterTag(const char* tagId, NetworkResult& result);
bool postCommandAck(const NetworkJob& job);
bool postAccessSelectionEvent(const NetworkJob& job);
bool postDeviceSyncMessage(const char* messageJson, const char* requestLabel);
uint32_t nextDeviceSequence();
void buildMessageId(char* buffer, size_t bufferSize, const char* prefix, uint32_t sequence);
void buildHeartbeatPayload(JsonObject payload);
void applyRemoteConfigResult(const NetworkResult& result);
void maybeFetchRemoteConfig(unsigned long now);
void queueDeviceLog(const char* level, const char* event, const char* message);
void queueDeviceDiagnostic(const char* name, bool ok, const char* message);
void buildLockerStateBatchJob(NetworkJob& job, bool full);
void buildStateBatchMessage(const NetworkJob& job, JsonDocument& doc, uint32_t sequence, const char* messageId);
uint32_t calculateJobStateFingerprint(const NetworkJob& job);
void rememberAckedStateFingerprint(uint32_t fingerprint, bool full, uint32_t fullGeneration, unsigned long now);
bool hasDirtyLockerReports();
void clearAllLockerReportsClean(unsigned long now);
void requestFullStateResync(const char* reason);
bool isDeadlineReached(unsigned long now, unsigned long deadline);
void rememberPendingStateBatch(const NetworkJob& job, const char* messageId, unsigned long now);
void clearPendingStateBatch();
bool isPendingStateBatchTimedOut(unsigned long now);
void scheduleStateBatchRetry(unsigned long now, bool forceFull);
void resetStateBatchRetry();
void handleKeypad();
void handleSerialDebug();
void reserveStringBuffers();
void initializeTaskWatchdog();
void resetTaskWatchdog();
void initializeNetworkTask();
void networkTaskMain(void* parameter);
void maybeSendHeartbeat(unsigned long now);
void maybePollDeviceActions(unsigned long now);
bool maybeReportLockerStatuses(unsigned long now);
bool maybeQueueDeviceStateBatch(unsigned long now);
void serviceLockerInputChanges(unsigned long now);
void serviceAccessSelection(unsigned long now);
void tickAccessSelection(uint32_t nowMs);
void servicePendingMasterTagVerification(uint32_t nowMs);
void processEnteredCode(const String& code);
bool isCodeEntryRateLimited(unsigned long now);
void registerCodeVerificationFailure(unsigned long now);
void resetCodeRateLimit();
bool postLockerStatus(uint8_t lockerNumber, bool hasTag, const String& tagId);
bool sendHeartbeat();
void serviceNetworkResults();
void handleNetworkResult(const NetworkResult& result);
void recoverFromDroppedNetworkResult(const NetworkResult& result);
bool enqueueNetworkJob(const NetworkJob& job);
bool isPriorityNetworkJob(const NetworkJob& job);
void handleRemoteCommand(const NetworkResult& result);
void handleDeviceStateAck(const NetworkResult& result);
void queueCommandAck(const char* actionId, bool success, const char* status, const char* message);
bool wasCommandProcessed(const char* actionId);
void rememberProcessedCommand(const char* actionId);
void copyStringToBuffer(const String& value, char* buffer, size_t bufferSize);
void copyCStringToBuffer(const char* value, char* buffer, size_t bufferSize);
void setPendingCode(const String& code);
void clearPendingCode();
void rememberExpiredPendingCode();
bool matchesExpiredCodeRequest(const char* requestId, const char* code);
void clearExpiredCode();
void setPendingMasterTag(const String& tagId);
void clearPendingMasterTag();
void failPendingCodeVerification(const char* reason);
void markPendingCodeVerificationTimedOut();
void failPendingMasterTagVerification(const char* reason);
void markPendingMasterTagTimedOut(const char* reason);
bool isPendingMasterTagResultExpired(uint32_t nowMs);
bool isPendingMasterTagResultWindowOpen(uint32_t nowMs);
bool fetchDeviceActionsForTask(NetworkResult& result);
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
LockerLedStatus getLockerLedStatus(uint8_t lockerIndex, const LockerState& state);
LockerLedStatus getProvisionalLockerLedStatus(const LockerState& state);
bool parseLockerLedStatus(const char* value, LockerLedStatus& status);
LockerItemStatus parseLockerItemStatus(const char* value);
const char* lockerLedStatusName(LockerLedStatus status);
bool applyPanelLockerLedStatus(uint8_t lockerNumber, uint32_t version, LockerLedStatus status, LockerItemStatus itemStatus, bool doorClosed, const char* severity);
uint32_t colorForLockerLedStatus(LockerLedStatus status);
bool hasAnimatedNormalLedState(uint32_t nowMs);
bool isStateSyncPending();
bool isBackendOfflineSignalActive();
void startLedStripEffect(LedStripEffectKind kind, uint32_t durationMs);
void startLedSegmentFlash(uint8_t lockerNumber, uint32_t color, uint32_t durationMs);
void serviceLedTimedEffects(uint32_t nowMs);
void renderLockerStatusSegment(uint8_t lockerIndex, const LockerState& state, uint32_t nowMs);
void renderStartupLeds(uint32_t nowMs);
void applyNormalLedOverlays(uint32_t nowMs);
void applyStateSyncPendingOverlay(uint32_t nowMs);
void applySyncOkOverlay(uint32_t nowMs);
void applyRemoteAllOverlay(uint32_t nowMs);
void applyTagAssignmentSuccessOverlay(uint32_t nowMs);
void applySegmentFlashOverlay(uint32_t nowMs);
void applyBackendOfflineOverlay(uint32_t nowMs);
void applyOnlineBreathOverlay(uint32_t nowMs);
void fillSegment(const LockerLedSegment& segment, uint32_t color);
void clearSegment(const LockerLedSegment& segment);
bool hasAccessToLocker(uint8_t mask, int lockerNumber);
uint8_t lockerNumberToMask(int lockerNumber);
LockerLedSegment getLockerLedSegment(uint8_t lockerNumber);
void formatLockerMaskBinary(uint8_t mask, char* buffer, size_t bufferSize);
void setLedMode(LedMode nextMode);
void updateLeds(uint32_t nowMs);
void updateVisualState();
void updateAccessSelectionLeds(unsigned long nowMs);
void renderAllowedSegmentAnimation(uint8_t lockerNumber, unsigned long nowMs);
void renderDeniedSegmentBlink(uint8_t lockerNumber, unsigned long nowMs);
void startLedErrorFlash(uint32_t durationMs = 700);
void renderErrorFlashLeds(uint32_t nowMs);
void serviceLedErrorFlash(uint32_t nowMs);
void restoreNormalLedMode();
void renderLockerStatus(uint32_t nowMs);
void renderCodeEntry(uint32_t nowMs);
void renderCodeEntryProgress(uint8_t count, bool verificationPending, uint32_t nowMs);
void setCodeEntryGroup(uint8_t index, uint32_t color);
void renderWifiLoadingFrame(uint8_t frameIndex);
void flashCodeResult(const String& code, bool success);
void serviceCodeResultFlash(unsigned long now);
void renderCodeResultFrame(bool success, uint8_t count, bool visible);
void clearStrip();
char mapRawKeyToChar(uint8_t rawKey);
void initializeRfidReaders();
void serviceRfidReaderHealth(unsigned long now);
void serviceRfidReaders(unsigned long now);
bool scanRfidReader(RfidReaderRuntime& runtime, unsigned long now);
void updateReaderPresence(RfidReaderRuntime& runtime, const RfidScanResult& scanResult, unsigned long now);
RfidScanResult readTagFromReader(RfidReaderRuntime& runtime);
String uidToString(const MFRC522::Uid& uid);
byte debugPrintReaderChipVersion(const RfidReaderRuntime& runtime);
bool isHealthyRfidVersion(byte version);
void initializeLockController();
bool unlockLocker(uint8_t lockerId);
bool lockLocker(uint8_t lockerId);
bool pulseUnlockLocker(uint8_t lockerId, uint32_t durationMs = LOCK_UNLOCK_PULSE_MS);
void updateLockController(uint32_t nowMs);
void allLocksOff();
void startAccessSelection(const String& uid, uint8_t accessibleLockersMask, bool isMaster, const String& requestId = "", const String& userId = "", const String& userName = "");
void cancelAccessSelection(const char* reason);
void finishAccessSelection(const char* reason);
void handleAccessSelectionKey(char key);
void openSelectedLocker(uint8_t lockerNumber);
void openAllAccessibleLockers();
bool queueAccessSelectionEvent(const char* eventName, uint8_t lockerNumber = 0);
void startTagAssignmentMode(const String& assignmentId, const String& tagId, const String& itemName);
void stopTagAssignmentMode();
void renderTagAssignmentFrame(uint8_t frameIndex);
bool tryProgramTag(MFRC522& reader, const String& expectedPhysicalUid, const String& tagId, String& error);
bool tryReadProgrammedTagId(MFRC522& reader, String& tagId);
bool authenticateClassicBlock(MFRC522& reader, byte blockAddr, MFRC522::MIFARE_Key& key, MFRC522::StatusCode* statusOut = nullptr);
String getPiccTypeName(MFRC522::PICC_Type piccType);
void finishRfidSession(MFRC522& reader);
bool selectCardForTransaction(MFRC522& reader, String& selectedUid, MFRC522::StatusCode* wakeStatusOut = nullptr);
bool postTagAssignmentResult(const String& assignmentId, bool success, const String& tagId, const String& physicalUid, const String& error);
void configureHttpClient(HTTPClient& http, uint16_t responseTimeoutMs = HTTP_RESPONSE_TIMEOUT_MS);
bool beginSecureRequest(HTTPClient& http, WiFiClientSecure& client, const char* url, const char* requestLabel, uint16_t responseTimeoutMs = HTTP_RESPONSE_TIMEOUT_MS);
String describeHttpError(int httpCode);
void logHttpFailure(const char* requestLabel, int httpCode, WiFiClientSecure& client, const String& responseBody = "");
void noteNetworkSuccess();
void noteNetworkFailure();
bool isBackgroundNetworkBackoffActive(unsigned long now);
void maybeRecoverWifiAfterNetworkFailures(unsigned long now);
void resetDeviceActionsPollCadence(bool verbose = false);
void relaxDeviceActionsPollCadence();
void markLockerReportDirty(RfidReaderRuntime& runtime, unsigned long now);
void markLockerStateChanged(RfidReaderRuntime& runtime, unsigned long now);
void noteLockerReportSuccess(RfidReaderRuntime& runtime, unsigned long now);
void noteLockerReportFailure(RfidReaderRuntime& runtime, unsigned long now);
void markAllLockerReportsDirty(unsigned long now, bool resetRetryTimers);
void markVisualStateDirty();

uint32_t colorGreen(uint8_t brightness = STATUS_BRIGHTNESS) {
  return strip.Color(0, brightness, 0);
}

uint32_t colorRed(uint8_t brightness = STATUS_BRIGHTNESS) {
  return strip.Color(brightness, 0, 0);
}

uint32_t colorBlue(uint8_t brightness = EFFECT_BRIGHTNESS) {
  return strip.Color(0, 0, brightness);
}

uint32_t colorCyan(uint8_t brightness = EFFECT_BRIGHTNESS) {
  return strip.Color(0, brightness, brightness);
}

uint32_t colorWhite(uint8_t brightness = EFFECT_BRIGHTNESS) {
  return strip.Color(brightness, brightness, brightness);
}

uint32_t colorYellow(uint8_t brightness = EFFECT_BRIGHTNESS) {
  return strip.Color(brightness, brightness, 0);
}

uint32_t colorPurple(uint8_t brightness = EFFECT_BRIGHTNESS) {
  return strip.Color(brightness, 0, brightness);
}

uint32_t colorViolet(uint8_t brightness = EFFECT_BRIGHTNESS) {
  return strip.Color(static_cast<uint8_t>((140U * brightness) / 255U), 0, brightness);
}

bool isRelayPin(uint8_t pin) {
  for (uint8_t i = 0; i < LOCK_RELAY_COUNT; i += 1) {
    if (LOCK_RELAY_PINS[i] == pin) {
      return true;
    }
  }

  return false;
}

bool isValidRelayLockerId(uint8_t lockerId) {
  if (lockerId >= 1 && lockerId <= LOCK_RELAY_COUNT) {
    return true;
  }

  Serial.printf("[LOCK] invalid lockerId=%u\n", lockerId);
  return false;
}

uint8_t lockerRelayIndex(uint8_t lockerId) {
  return static_cast<uint8_t>(lockerId - 1);
}

uint8_t lockerRelayPin(uint8_t lockerId) {
  return LOCK_RELAY_PINS[lockerRelayIndex(lockerId)];
}

uint8_t relayMaskForLocker(uint8_t lockerId) {
  if (!isValidRelayLockerId(lockerId)) {
    return 0;
  }

  return static_cast<uint8_t>(1U << lockerRelayIndex(lockerId));
}

uint8_t allRelayLockersMask() {
  return static_cast<uint8_t>((1U << LOCK_RELAY_COUNT) - 1U);
}

void writeRelayLevel(uint8_t pin, bool active) {
  const uint8_t level = RELAY_ACTIVE_LOW
    ? (active ? LOW : HIGH)
    : (active ? HIGH : LOW);
  digitalWrite(pin, level);
}

void relayOn(uint8_t pin) {
  writeRelayLevel(pin, true);
}

void relayOff(uint8_t pin) {
  writeRelayLevel(pin, false);
}

bool anyRelayActive() {
  for (uint8_t i = 0; i < LOCK_RELAY_COUNT; i += 1) {
    if (lockRelayStates[i].active) {
      return true;
    }
  }

  return false;
}

bool pulseUnlockLockerMask(uint8_t lockerMask);
void startNextSequentialLockerPulse();

void initializeLockController() {
  for (uint8_t i = 0; i < LOCK_RELAY_COUNT; i += 1) {
    const uint8_t pin = LOCK_RELAY_PINS[i];
    pinMode(pin, OUTPUT);
    relayOff(pin);
    lockRelayStates[i] = { false, false, 0, 0 };
  }

  lockOpenAllSequence = { false, 0 };
  allLocksOff();
  Serial.printf(
    "[LOCK] init relay pins: L1=%u L2=%u L3=%u L4=%u activeLow=%s\n",
    LOCK_RELAY_PINS[0],
    LOCK_RELAY_PINS[1],
    LOCK_RELAY_PINS[2],
    LOCK_RELAY_PINS[3],
    RELAY_ACTIVE_LOW ? "true" : "false"
  );

  if (ENABLE_LOCKER_SWITCH_INPUTS) {
    Serial.println("[LOCK] warning: locker switch inputs share GPIO25/GPIO26/GPIO27 with relay outputs in this build.");
  }
}

bool unlockLocker(uint8_t lockerId) {
  if (!isValidRelayLockerId(lockerId)) {
    return false;
  }

  const uint8_t index = lockerRelayIndex(lockerId);
  const uint8_t pin = lockerRelayPin(lockerId);
  relayOn(pin);
  lockRelayStates[index] = { true, false, millis(), 0 };
  Serial.printf("[LOCK] locker=%u relay GPIO%u ON duration=manual\n", lockerId, pin);
  return true;
}

bool lockLocker(uint8_t lockerId) {
  if (!isValidRelayLockerId(lockerId)) {
    return false;
  }

  const uint8_t index = lockerRelayIndex(lockerId);
  const uint8_t pin = lockerRelayPin(lockerId);
  relayOff(pin);
  lockRelayStates[index] = { false, false, 0, 0 };
  Serial.printf("[LOCK] locker=%u relay GPIO%u OFF reason=lock_request\n", lockerId, pin);
  return true;
}

bool pulseUnlockLocker(uint8_t lockerId, uint32_t durationMs) {
  if (!isValidRelayLockerId(lockerId)) {
    return false;
  }

  const uint8_t index = lockerRelayIndex(lockerId);
  const uint8_t pin = lockerRelayPin(lockerId);
  relayOn(pin);
  lockRelayStates[index] = { true, true, millis(), durationMs };
  Serial.printf("[LOCK] locker=%u relay GPIO%u ON duration=%lums\n",
    lockerId,
    pin,
    static_cast<unsigned long>(durationMs)
  );
  return true;
}

void allLocksOff() {
  lockOpenAllSequence = { false, 0 };

  for (uint8_t i = 0; i < LOCK_RELAY_COUNT; i += 1) {
    relayOff(LOCK_RELAY_PINS[i]);
    lockRelayStates[i] = { false, false, 0, 0 };
  }

  Serial.println("[LOCK] all locks off");
}

void startNextSequentialLockerPulse() {
  if (OPEN_LOCKS_PARALLEL || !lockOpenAllSequence.active || anyRelayActive()) {
    return;
  }

  for (uint8_t lockerId = 1; lockerId <= LOCK_RELAY_COUNT; lockerId += 1) {
    const uint8_t mask = relayMaskForLocker(lockerId);
    if ((lockOpenAllSequence.pendingMask & mask) == 0) {
      continue;
    }

    lockOpenAllSequence.pendingMask = static_cast<uint8_t>(lockOpenAllSequence.pendingMask & ~mask);
    pulseUnlockLocker(lockerId, runtimeLockUnlockPulseMs);
    if (lockOpenAllSequence.pendingMask == 0) {
      lockOpenAllSequence.active = false;
    }
    return;
  }

  lockOpenAllSequence.active = false;
}

void updateLockController(uint32_t nowMs) {
  for (uint8_t lockerId = 1; lockerId <= LOCK_RELAY_COUNT; lockerId += 1) {
    const uint8_t index = lockerRelayIndex(lockerId);
    LockRelayState& state = lockRelayStates[index];
    if (!state.active || !state.pulsed) {
      continue;
    }

    if (nowMs - state.startedAtMs < state.durationMs) {
      continue;
    }

    const uint8_t pin = lockerRelayPin(lockerId);
    relayOff(pin);
    state = { false, false, 0, 0 };
    Serial.printf("[LOCK] locker=%u relay GPIO%u OFF reason=pulse_complete\n", lockerId, pin);
  }

  if (!OPEN_LOCKS_PARALLEL) {
    startNextSequentialLockerPulse();
  }
}

bool pulseUnlockLockerMask(uint8_t lockerMask) {
  if (lockerMask == 0) {
    return false;
  }

  if (OPEN_LOCKS_PARALLEL) {
    bool openedAny = false;
    for (uint8_t lockerId = 1; lockerId <= LOCK_RELAY_COUNT; lockerId += 1) {
      if ((lockerMask & relayMaskForLocker(lockerId)) == 0) {
        continue;
      }

      openedAny = pulseUnlockLocker(lockerId, runtimeLockUnlockPulseMs) || openedAny;
    }
    return openedAny;
  }

  lockOpenAllSequence.active = true;
  lockOpenAllSequence.pendingMask = lockerMask;
  startNextSequentialLockerPulse();
  return true;
}

void setup() {
  Serial.begin(115200);
  initializeLockController();
  delay(300);

  pinMode(STATUS_LED_PIN, OUTPUT);
  setStatusLed(false);

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  if (ENABLE_KEYPAD) {
    keypadReady = keypad.begin();
    if (keypadReady) {
      keypad.loadKeyMap(keypadCharMap);
      keypad.setKeyPadMode(I2C_KEYPAD_4x4);
      keypad.setDebounceThreshold(25);
    } else {
      Serial.println("Keypad initialization failed. Keypad handling will stay disabled.");
    }
  }

  strip.begin();
  strip.setBrightness(255);
  clearStrip();

  reserveStringBuffers();
  initializeDeviceIdentity();
  loadPersistentSettings();
  configureWiFiRuntime();
  startServicePanel();
  configureLockerInputs();
  initializeRfidReaders();
  startLedStripEffect(LED_STRIP_EFFECT_STARTUP, LED_STARTUP_EFFECT_MS);
  initializeTaskWatchdog();
  initializeNetworkTask();

  Serial.println();
  Serial.printf("=== SafeKeys ESP32 %s ===\n", FIRMWARE_VERSION);
  Serial.printf("LED pin: %u\n", STATUS_LED_PIN);
  Serial.printf("Keypad I2C address: 0x%02X\n", KEYPAD_I2C_ADDRESS);
  Serial.printf("Keypad enabled: %s\n", ENABLE_KEYPAD ? "yes" : "no");
  Serial.printf("Keypad ready: %s\n", ENABLE_KEYPAD ? (keypadReady ? "yes" : "no") : "skipped");
  Serial.printf("ARGB strip pin: %u, leds: %u\n", STRIP_PIN, TOTAL_LEDS);
  Serial.printf("RFID SPI pins -> SCK=%u, MISO=%u, MOSI=%u, RST=%u\n", RFID_SPI_SCK_PIN, RFID_SPI_MISO_PIN, RFID_SPI_MOSI_PIN, RFID_RST_PIN);
  Serial.printf("Lock relays -> L1=%u L2=%u L3=%u L4=%u pulse=%lums mode=%s activeLow=%s\n",
    LOCK_RELAY_PINS[0],
    LOCK_RELAY_PINS[1],
    LOCK_RELAY_PINS[2],
    LOCK_RELAY_PINS[3],
    static_cast<unsigned long>(runtimeLockUnlockPulseMs),
    OPEN_LOCKS_PARALLEL ? "parallel" : "sequential",
    RELAY_ACTIVE_LOW ? "yes" : "no"
  );
  Serial.printf("API base URL: %s\n", API_BASE_URL);
  Serial.printf("Device WebSocket: wss://%s:%u%s\n", DEVICE_WS_HOST, DEVICE_WS_PORT, deviceWsPath);
  Serial.printf("Protocol version: %u, remote config version: %lu\n", DEVICE_PROTOCOL_VERSION, static_cast<unsigned long>(remoteConfigVersion));
  Serial.printf("WiFi config: ssid=%s source=%s\n",
    configuredWifiSsid.length() > 0 ? configuredWifiSsid.c_str() : "(empty)",
    wifiConfigLoadedFromNvs ? "nvs" : "firmware fallback"
  );
  Serial.printf("Locker switch inputs enabled: %s\n", ENABLE_LOCKER_SWITCH_INPUTS ? "yes" : "no");
  printUsage();
  printRfidSnapshot();

  updateVisualState();
  connectWifi();
  queueDeviceLog("info", "BOOT", "Firmware started.");
}

void configureWiFiRuntime() {
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(false);
  WiFi.onEvent(handleWiFiEvent);
}

void loadPersistentSettings() {
  if (!devicePreferences.begin("safekeys", false)) {
    configuredWifiSsid = WIFI_SSID;
    configuredWifiPassword = WIFI_PASSWORD;
    Serial.println("[NVS] failed to open preferences, using firmware WiFi fallback.");
    return;
  }

  configuredWifiSsid = devicePreferences.getString("wifiSsid", WIFI_SSID);
  configuredWifiPassword = devicePreferences.getString("wifiPass", WIFI_PASSWORD);
  wifiConfigLoadedFromNvs = devicePreferences.isKey("wifiSsid");

  remoteConfigVersion = devicePreferences.getUInt("cfgVersion", 0);
  runtimeHeartbeatIntervalMs = devicePreferences.getUInt("hbMs", HEARTBEAT_INTERVAL_MS);
  runtimeDeviceActionsPollBaseMs = devicePreferences.getUInt("pollMs", DEVICE_ACTIONS_POLL_INTERVAL_MS);
  runtimeLockUnlockPulseMs = devicePreferences.getUInt("pulseMs", LOCK_UNLOCK_PULSE_MS);
  runtimeRemoteLoggingEnabled = devicePreferences.getBool("logEnabled", true);
  runtimeCodeRateLimitEnabled = devicePreferences.getBool("rlEnabled", true);
  runtimeCodeRateLimitMaxFailures = devicePreferences.getUChar("rlMax", CODE_RATE_LIMIT_MAX_FAILURES_DEFAULT);
  runtimeCodeRateLimitWindowMs = devicePreferences.getUInt("rlWindow", CODE_RATE_LIMIT_WINDOW_MS_DEFAULT);
  runtimeCodeRateLimitLockoutMs = devicePreferences.getUInt("rlLockout", CODE_RATE_LIMIT_LOCKOUT_MS_DEFAULT);
  runtimeServicePanelEnabled = devicePreferences.getBool("panelEnabled", true);
  runtimeOtaEnabled = devicePreferences.getBool("otaEnabled", true);
  runtimeDiagnosticsEnabled = devicePreferences.getBool("diagEnabled", true);

  runtimeHeartbeatIntervalMs = constrain(runtimeHeartbeatIntervalMs, 10000UL, 600000UL);
  runtimeDeviceActionsPollBaseMs = constrain(runtimeDeviceActionsPollBaseMs, 2000UL, 120000UL);
  runtimeLockUnlockPulseMs = constrain(runtimeLockUnlockPulseMs, 100UL, 5000UL);
  runtimeCodeRateLimitMaxFailures = constrain(runtimeCodeRateLimitMaxFailures, static_cast<uint8_t>(1), static_cast<uint8_t>(20));
  runtimeCodeRateLimitWindowMs = constrain(runtimeCodeRateLimitWindowMs, 30000UL, 3600000UL);
  runtimeCodeRateLimitLockoutMs = constrain(runtimeCodeRateLimitLockoutMs, 5000UL, 3600000UL);
  deviceActionsPollIntervalMs = runtimeDeviceActionsPollBaseMs;
}

void saveWifiCredentials(const String& ssid, const String& password) {
  devicePreferences.putString("wifiSsid", ssid);
  devicePreferences.putString("wifiPass", password);
  configuredWifiSsid = ssid;
  configuredWifiPassword = password;
  wifiConfigLoadedFromNvs = true;
}

void clearWifiCredentials() {
  devicePreferences.remove("wifiSsid");
  devicePreferences.remove("wifiPass");
  configuredWifiSsid = WIFI_SSID;
  configuredWifiPassword = WIFI_PASSWORD;
  wifiConfigLoadedFromNvs = false;
}

const String& getActiveWifiSsid() {
  return configuredWifiSsid;
}

const String& getActiveWifiPassword() {
  return configuredWifiPassword;
}

void reserveStringBuffers() {
  enteredCode.reserve(CODE_LENGTH);
  serialCommandBuffer.reserve(64);
  tagAssignmentMode.assignmentId.reserve(32);
  tagAssignmentMode.tagId.reserve(16);
  tagAssignmentMode.itemName.reserve(64);
  accessSelection.uid.reserve(24);
  accessSelection.requestId.reserve(64);
  accessSelection.userId.reserve(32);
  accessSelection.userName.reserve(64);
  accessSelection.lastBusyUid.reserve(24);
  pendingMasterTagVerify.uid.reserve(24);
  pendingMasterTagVerify.requestId.reserve(64);
  lastVerifiedUid.reserve(24);

  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    lockerReaders[i].stableUid.reserve(24);
    lockerReaders[i].stablePhysicalUid.reserve(24);
    lockerReaders[i].lastTriggeredUid.reserve(24);
    lockerReaders[i].candidateUid.reserve(24);
  }

  masterReaderRuntime.stableUid.reserve(24);
  masterReaderRuntime.stablePhysicalUid.reserve(24);
  masterReaderRuntime.lastTriggeredUid.reserve(24);
  masterReaderRuntime.candidateUid.reserve(24);
}

void initializeDeviceIdentity() {
  snprintf(deviceWsPath, sizeof(deviceWsPath), "/device/ws?deviceId=%s", DEVICE_ID);
  snprintf(
    deviceBootId,
    sizeof(deviceBootId),
    "%08lX%08lX",
    static_cast<unsigned long>(esp_random()),
    static_cast<unsigned long>(millis())
  );
  Serial.printf("Device identity: id=%s bootId=%s wsPath=%s\n", DEVICE_ID, deviceBootId, deviceWsPath);
}

void initializeTaskWatchdog() {
#if ESP_IDF_VERSION_MAJOR >= 5
  const esp_task_wdt_config_t config = {
    .timeout_ms = TASK_WATCHDOG_TIMEOUT_SECONDS * 1000,
    .idle_core_mask = 0,
    .trigger_panic = true
  };
  const esp_err_t initResult = esp_task_wdt_init(&config);
#else
  const esp_err_t initResult = esp_task_wdt_init(TASK_WATCHDOG_TIMEOUT_SECONDS, true);
#endif

  if (initResult != ESP_OK && initResult != ESP_ERR_INVALID_STATE) {
    Serial.printf("Failed to initialize task watchdog: %d\n", static_cast<int>(initResult));
    return;
  }

  const esp_err_t addResult = esp_task_wdt_add(nullptr);
  if (addResult != ESP_OK && addResult != ESP_ERR_INVALID_STATE) {
    Serial.printf("Failed to register loop task in watchdog: %d\n", static_cast<int>(addResult));
    return;
  }

  taskWatchdogReady = true;
}

void resetTaskWatchdog() {
  if (!taskWatchdogReady) {
    return;
  }

  esp_task_wdt_reset();
}

void initializeNetworkTask() {
  networkJobQueue = xQueueCreate(NETWORK_QUEUE_LENGTH, sizeof(NetworkJob));
  networkResultQueue = xQueueCreate(NETWORK_QUEUE_LENGTH, sizeof(NetworkResult));

  if (networkJobQueue == nullptr || networkResultQueue == nullptr) {
    Serial.println("Failed to create network queues.");
    return;
  }

  const BaseType_t created = xTaskCreatePinnedToCore(
    networkTaskMain,
    "network-task",
    NETWORK_TASK_STACK_SIZE,
    nullptr,
    1,
    &networkTaskHandle,
    1
  );

  if (created != pdPASS) {
    Serial.println("Failed to start network task.");
    networkTaskHandle = nullptr;
  }
}

void networkTaskMain(void* parameter) {
  (void) parameter;

  if (taskWatchdogReady) {
    const esp_err_t addResult = esp_task_wdt_add(nullptr);
    if (addResult != ESP_OK && addResult != ESP_ERR_INVALID_STATE) {
      Serial.printf("Failed to register network task in watchdog: %d\n", static_cast<int>(addResult));
    }
  }

  NetworkJob job = {};
  for (;;) {
    resetTaskWatchdog();
    serviceDeviceWebSocket(millis());

    if (xQueueReceive(networkJobQueue, &job, pdMS_TO_TICKS(DEVICE_WS_SERVICE_INTERVAL_MS)) != pdTRUE) {
      continue;
    }

    NetworkResult result = {};
    bool shouldPublishResult = false;

    switch (job.type) {
      case NetworkJobType::Heartbeat: {
        result.type = NetworkResultType::Heartbeat;
        const unsigned long heartbeatNow = millis();
        result.requestOk = isDeviceWebSocketStable(heartbeatNow) && sendDeviceHeartbeatWs();
        if (
          !result.requestOk &&
          (!isDeviceWebSocketReady() || !isDeviceWebSocketStable(heartbeatNow) || shouldUseHttpsFallback(heartbeatNow))
        ) {
          result.requestOk = sendHeartbeat();
        }
        result.numberValue = lastHeartbeatPingMs;
        shouldPublishResult = true;
        break;
      }

      case NetworkJobType::LockerStatus: {
        result.type = NetworkResultType::LockerStatus;
        result.lockerNumber = job.lockerNumber;
        result.boolValue1 = job.boolValue;
        copyCStringToBuffer(job.text1, result.text1, sizeof(result.text1));
        result.requestOk = postLockerStatus(job.lockerNumber, job.boolValue, String(job.text1));
        shouldPublishResult = true;
        break;
      }

      case NetworkJobType::DeviceStateBatch: {
        result.type = NetworkResultType::DeviceStateBatch;
        result.boolValue1 = job.boolValue;
        result.numberValue = job.numberValue;
        for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
          result.lockerVersions[i] = job.lockerVersions[i];
        }
        const unsigned long stateBatchNow = millis();
        if (forceNextStateBatchHttps || !isDeviceWebSocketStable(stateBatchNow)) {
          result.requestOk = false;
          result.boolValue2 = false;
        } else {
          result.requestOk = sendDeviceStateBatchWs(job);
          result.boolValue2 = result.requestOk && DEVICE_STATE_WS_ACK_REQUIRED;
        }
        const bool canUseStateHttpsFallback = forceNextStateBatchHttps
          || !isDeviceWebSocketReady()
          || !isDeviceWebSocketStable(stateBatchNow)
          || shouldUseHttpsFallback(stateBatchNow);
        if (!result.requestOk && canUseStateHttpsFallback) {
          result.requestOk = postDeviceStateBatch(job);
          result.boolValue2 = false;
        }
        if (!result.requestOk && forceNextStateBatchHttps && !isDeviceWebSocketReady()) {
          result.requestOk = postLegacyLockerStatusBatch(job);
          result.boolValue2 = false;
        }
        shouldPublishResult = true;
        break;
      }

      case NetworkJobType::CommandAck: {
        result.type = NetworkResultType::CommandAck;
        copyCStringToBuffer(job.text1, result.actionId, sizeof(result.actionId));
        result.requestOk = sendDeviceCommandAckWs(job);
        if (!result.requestOk) {
          result.requestOk = postCommandAck(job);
        }
        shouldPublishResult = true;
        break;
      }

      case NetworkJobType::DeviceActionsPoll: {
        result.type = NetworkResultType::DeviceActionsPoll;
        result.requestOk = fetchDeviceActionsForTask(result);
        shouldPublishResult = true;
        break;
      }

      case NetworkJobType::VerifyCode: {
        result.type = NetworkResultType::VerifyCode;
        copyCStringToBuffer(job.text1, result.text1, sizeof(result.text1));
        result.requestOk = sendVerifyCodeWs(job);
        shouldPublishResult = !result.requestOk;
        break;
      }

      case NetworkJobType::VerifyMasterTag: {
        result.type = NetworkResultType::VerifyMasterTag;
        copyCStringToBuffer(job.text1, result.text1, sizeof(result.text1));
        result.requestOk = sendVerifyMasterTagWs(job);
        if (!result.requestOk && shouldUseHttpsFallback(millis())) {
          result.requestOk = postVerifyMasterTag(job.text1, result);
          shouldPublishResult = true;
          break;
        }
        shouldPublishResult = !result.requestOk;
        break;
      }

      case NetworkJobType::AccessSelectionEvent: {
        bool requestOk = sendAccessSelectionEventWs(job);
        if (!requestOk && shouldUseHttpsFallback(millis())) {
          requestOk = postAccessSelectionEvent(job);
        }
        if (requestOk) {
          noteNetworkSuccess();
        } else {
          noteNetworkFailure();
        }
        break;
      }

      case NetworkJobType::TagAssignmentResult: {
        bool requestOk = sendTagAssignmentResultWs(job);
        if (!requestOk) {
          requestOk = postTagAssignmentResult(
            String(job.text1),
            job.boolValue,
            String(job.text2),
            String(job.text3),
            String(job.text4)
          );
        }
        if (requestOk) {
          noteNetworkSuccess();
        } else {
          noteNetworkFailure();
        }
        break;
      }

      case NetworkJobType::DeviceLog: {
        bool requestOk = sendDeviceLogWs(job);
        if (!requestOk && shouldUseHttpsFallback(millis())) {
          requestOk = postDeviceLog(job);
        }
        if (requestOk) {
          noteNetworkSuccess();
        }
        break;
      }

      case NetworkJobType::DeviceDiagnostic: {
        bool requestOk = sendDeviceDiagnosticWs(job);
        if (!requestOk && shouldUseHttpsFallback(millis())) {
          requestOk = postDeviceDiagnostic(job);
        }
        if (requestOk) {
          noteNetworkSuccess();
        }
        break;
      }

      case NetworkJobType::FetchRemoteConfig: {
        result.type = NetworkResultType::RemoteConfig;
        result.requestOk = fetchRemoteConfigForTask(result);
        shouldPublishResult = true;
        break;
      }
    }

    if (shouldPublishResult) {
      if (result.requestOk) {
        noteNetworkSuccess();
      } else {
        noteNetworkFailure();
      }
    }

    if (shouldPublishResult && networkResultQueue != nullptr) {
      if (xQueueSend(networkResultQueue, &result, 0) != pdTRUE) {
        Serial.println("Network result queue is full, dropping result.");
        recoverFromDroppedNetworkResult(result);
      }
    }
  }
}

void loop() {
  const unsigned long now = millis();

  resetTaskWatchdog();

  updateLockController(static_cast<uint32_t>(now));
  serviceServicePanel(now);
  serviceStatusLed(now);
  serviceWifiConnection(now);
  serviceLedErrorFlash(now);
  serviceLedTimedEffects(static_cast<uint32_t>(now));
  serviceCodeResultFlash(now);
  serviceAccessSelection(now);
  servicePendingMasterTagVerification(now);
  handleSerialDebug();
  if (ENABLE_KEYPAD && keypadReady) {
    handleKeypad();
  }
  serviceRfidReaders(now);
  serviceRfidReaderHealth(now);
  serviceLockerInputChanges(now);
  serviceNetworkResults();
  updateVisualState();

  if (codeVerificationPending && pendingCodeSentMs != 0) {
    const unsigned long codeVerifyNowMs = millis();
    const unsigned long codeVerifySentMs = pendingCodeSentMs;
    // The network task can set pendingCodeSentMs after loop() captured now.
    // Skip this pass instead of letting unsigned subtraction look like a huge timeout.
    if (static_cast<long>(codeVerifyNowMs - codeVerifySentMs) >= 0) {
      const unsigned long codeVerifyElapsedMs = codeVerifyNowMs - codeVerifySentMs;
      if (!codeVerificationTimedOut && codeVerifyElapsedMs >= DEVICE_VERIFY_CODE_TIMEOUT_MS) {
        markPendingCodeVerificationTimedOut();
      }
      if (codeVerifyElapsedMs >= DEVICE_VERIFY_CODE_TIMEOUT_MS + DEVICE_VERIFY_CODE_RESULT_GRACE_MS) {
        rememberExpiredPendingCode();
        failPendingCodeVerification("Code verification expired after grace period.");
      }
    }
  }

  if (!isWifiReady()) {
    maybeStartSetupPortalAfterWifiFailures(now);
    if (!serviceSetupPortalActive && !wifiConnectInProgress && now - lastWifiRetryMs >= wifiRetryIntervalMs) {
      connectWifi();
    }
    return;
  }

  maybeRecoverWifiAfterNetworkFailures(now);
  maybeFetchRemoteConfig(now);

  if (lastHeartbeatMs == 0 || now - lastHeartbeatMs >= runtimeHeartbeatIntervalMs) {
    maybeSendHeartbeat(now);
  } else if (maybeQueueDeviceStateBatch(now)) {
    // Limit background network traffic to one request per loop.
  } else if (!isDeviceWebSocketReady() && (lastDeviceActionsPollMs == 0 || now - lastDeviceActionsPollMs >= deviceActionsPollIntervalMs)) {
    maybePollDeviceActions(now);
  }
}

void connectWifi() {
  if (wifiConnectInProgress) {
    return;
  }

  if (serviceSetupPortalActive) {
    return;
  }

  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  Serial.printf("Connecting to WiFi: %s\n", getActiveWifiSsid().c_str());

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(false);
  WiFi.begin(getActiveWifiSsid().c_str(), getActiveWifiPassword().c_str());

  wifiConnectInProgress = true;
  wifiConnectStartedMs = millis();
  if (wifiFirstConnectAttemptMs == 0) {
    wifiFirstConnectAttemptMs = wifiConnectStartedMs;
  }
  lastWifiRetryMs = wifiConnectStartedMs;
  lastWifiLoadingFrameMs = 0;
  wifiLoadingFrame = 0;
  markVisualStateDirty();
  pulseLed(35);
}

void handleWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_START:
      Serial.printf("[WiFi] event=%s\n", WiFi.eventName(event));
      break;

    case ARDUINO_EVENT_WIFI_STA_CONNECTED:
      Serial.printf(
        "[WiFi] event=%s ssid=%.*s channel=%u auth=%u\n",
        WiFi.eventName(event),
        info.wifi_sta_connected.ssid_len,
        reinterpret_cast<const char*>(info.wifi_sta_connected.ssid),
        info.wifi_sta_connected.channel,
        info.wifi_sta_connected.authmode
      );
      break;

    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      wifiConnectInProgress = false;
      wifiFirstConnectAttemptMs = 0;
      consecutiveWifiFailureCount = 0;
      wifiRetryIntervalMs = WIFI_RETRY_MS;
      lastHeartbeatMs = 0;
      lastDeviceActionsPollMs = 0;
      noteNetworkSuccess();
      clearPendingStateBatch();
      resetStateBatchRetry();
      logWiFiSnapshot("[WiFi] got IP");
      for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
        lockerStatusQueued[i] = false;
      }
      markAllLockerReportsDirty(millis(), true);
      requestFullStateResync("wifi got ip");
      deviceStateBatchQueued = false;
      deviceWsReconnectRequested = true;
      nextDeviceWsConnectAttemptMs = 0;
      nextRemoteConfigFetchMs = 0;
      resetDeviceActionsPollCadence();
      if (serviceSetupPortalActive) {
        stopServiceSetupPortal();
      }
      queueDeviceLog("info", "WIFI_CONNECTED", "ESP32 connected to WiFi.");
      break;

    case ARDUINO_EVENT_WIFI_STA_LOST_IP:
      wifiConnectInProgress = false;
      logWiFiSnapshot("[WiFi] lost IP");
      consecutiveWifiFailureCount = min<uint8_t>(static_cast<uint8_t>(consecutiveWifiFailureCount + 1), 20);
      wifiRetryIntervalMs = min(WIFI_RETRY_MAX_MS, max(WIFI_RETRY_MS, wifiRetryIntervalMs * 2));
      heartbeatQueued = false;
      deviceActionsPollQueued = false;
      lastHeartbeatMs = 0;
      lastDeviceActionsPollMs = 0;
      nextBackgroundNetworkAttemptMs = millis() + wifiRetryIntervalMs;
      lastWifiRetryMs = millis();
      for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
        lockerStatusQueued[i] = false;
      }
      markAllLockerReportsDirty(millis(), true);
      requestFullStateResync("wifi lost ip");
      deviceStateBatchQueued = false;
      clearPendingStateBatch();
      disconnectDeviceWebSocket();
      resetDeviceActionsPollCadence();
      maybeStartSetupPortalAfterWifiFailures(millis());
      break;

    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
    {
      wifiConnectInProgress = false;
      const uint8_t reason = info.wifi_sta_disconnected.reason;
      Serial.printf(
        "[WiFi] event=%s reason=%u (%s)\n",
        WiFi.eventName(event),
        reason,
        WiFi.disconnectReasonName(static_cast<wifi_err_reason_t>(reason))
      );
      consecutiveWifiFailureCount = min<uint8_t>(static_cast<uint8_t>(consecutiveWifiFailureCount + 1), 20);
      const bool authRelatedFailure = reason == WIFI_REASON_AUTH_EXPIRE
        || reason == WIFI_REASON_AUTH_FAIL
        || reason == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT;
      if (authRelatedFailure) {
        wifiRetryIntervalMs = max(wifiRetryIntervalMs, WIFI_AUTH_FAILURE_RETRY_MS);
      } else {
        wifiRetryIntervalMs = min(WIFI_RETRY_MAX_MS, max(WIFI_RETRY_MS, wifiRetryIntervalMs * 2));
      }
      heartbeatQueued = false;
      deviceActionsPollQueued = false;
      lastHeartbeatMs = 0;
      lastDeviceActionsPollMs = 0;
      nextBackgroundNetworkAttemptMs = millis() + wifiRetryIntervalMs;
      lastWifiRetryMs = millis();
      for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
        lockerStatusQueued[i] = false;
      }
      markAllLockerReportsDirty(millis(), true);
      requestFullStateResync("wifi disconnected");
      deviceStateBatchQueued = false;
      clearPendingStateBatch();
      disconnectDeviceWebSocket();
      resetDeviceActionsPollCadence();
      maybeStartSetupPortalAfterWifiFailures(millis());
      break;
    }

    default:
      break;
  }
}

void logWiFiSnapshot(const char* prefix) {
  Serial.printf(
    "%s: status=%d ip=%s gw=%s mask=%s rssi=%d\n",
    prefix,
    static_cast<int>(WiFi.status()),
    WiFi.localIP().toString().c_str(),
    WiFi.gatewayIP().toString().c_str(),
    WiFi.subnetMask().toString().c_str(),
    WiFi.RSSI()
  );
}

void serviceWifiConnection(unsigned long now) {
  if (!wifiConnectInProgress) {
    return;
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifiConnectInProgress = false;
    lastHeartbeatMs = 0;
    lastDeviceActionsPollMs = 0;
    noteNetworkSuccess();
    Serial.println();
    Serial.print("WiFi connected. IP: ");
    Serial.println(WiFi.localIP());
    blinkLed(2, 140, 140);
    markVisualStateDirty();
    updateVisualState();
    return;
  }

  if (now - wifiConnectStartedMs >= WIFI_CONNECT_TIMEOUT_MS) {
    wifiConnectInProgress = false;
    lastWifiRetryMs = now;
    consecutiveWifiFailureCount = min<uint8_t>(static_cast<uint8_t>(consecutiveWifiFailureCount + 1), 20);
    wifiRetryIntervalMs = min(WIFI_RETRY_MAX_MS, max(WIFI_RETRY_MS, wifiRetryIntervalMs * 2));
    Serial.println();
    Serial.printf("WiFi connection failed. Retry in %lu ms.\n", wifiRetryIntervalMs);
    blinkLed(4, 150, 120);
    markVisualStateDirty();
    updateVisualState();
    maybeStartSetupPortalAfterWifiFailures(now);
    return;
  }

  if (lastWifiLoadingFrameMs == 0 || now - lastWifiLoadingFrameMs >= WIFI_LOADING_FRAME_MS) {
    lastWifiLoadingFrameMs = now;
    wifiLoadingFrame = static_cast<uint8_t>((wifiLoadingFrame + 1) % (TOTAL_LEDS / 2));
    markVisualStateDirty();
    pulseLed(35);
    Serial.print(".");
  }
}

void maybeStartSetupPortalAfterWifiFailures(unsigned long now) {
  if (serviceSetupPortalActive || isWifiReady()) {
    return;
  }

  const bool tooManyFailures = consecutiveWifiFailureCount >= WIFI_SETUP_FAILURE_THRESHOLD;
  const bool waitingTooLong = wifiFirstConnectAttemptMs != 0
    && now - wifiFirstConnectAttemptMs >= WIFI_SETUP_AUTO_START_MS;
  if (!tooManyFailures && !waitingTooLong) {
    return;
  }

  requestServiceSetupPortal(tooManyFailures ? "wifi failures" : "wifi setup timeout");
}

void requestServiceSetupPortal(const char* reason) {
  if (serviceSetupPortalActive) {
    return;
  }

  copyCStringToBuffer(
    reason != nullptr && strlen(reason) > 0 ? reason : "manual",
    serviceSetupPortalRequestedReason,
    sizeof(serviceSetupPortalRequestedReason)
  );
  serviceSetupPortalStartRequested = true;
}

void scheduleServiceWifiReconnect(unsigned long delayMs) {
  serviceWifiReconnectRequested = true;
  serviceWifiReconnectAtMs = millis() + delayMs;
}

void serviceScheduledWifiReconnect(unsigned long now) {
  if (!serviceWifiReconnectRequested) {
    return;
  }

  if (static_cast<long>(now - serviceWifiReconnectAtMs) < 0) {
    return;
  }

  serviceWifiReconnectRequested = false;
  disconnectDeviceWebSocket();
  if (serviceSetupPortalActive) {
    stopServiceSetupPortal();
  }
  WiFi.disconnect(false, false);
  wifiConnectInProgress = false;
  wifiFirstConnectAttemptMs = 0;
  consecutiveWifiFailureCount = 0;
  wifiRetryIntervalMs = WIFI_RETRY_MS;
  lastWifiRetryMs = 0;
  connectWifi();
}

bool requireServiceAuth() {
  if (!runtimeServicePanelEnabled && !serviceSetupPortalActive) {
    serviceServer.send(503, "text/plain", "Service panel disabled by remote config.");
    return false;
  }

  if (serviceServer.authenticate(SERVICE_PANEL_USERNAME, SERVICE_PANEL_PASSWORD)) {
    return true;
  }

  serviceServer.requestAuthentication(BASIC_AUTH, "SafeKeys Service");
  return false;
}

String htmlEscape(const String& value) {
  String escaped;
  escaped.reserve(value.length() + 8);
  for (size_t i = 0; i < value.length(); i += 1) {
    const char ch = value.charAt(i);
    switch (ch) {
      case '&': escaped += F("&amp;"); break;
      case '<': escaped += F("&lt;"); break;
      case '>': escaped += F("&gt;"); break;
      case '"': escaped += F("&quot;"); break;
      default: escaped += ch; break;
    }
  }
  return escaped;
}

String buildStatusJson() {
  JsonDocument doc;
  doc["deviceId"] = DEVICE_ID;
  doc["firmware"] = FIRMWARE_VERSION;
  doc["protocolVersion"] = DEVICE_PROTOCOL_VERSION;
  doc["bootId"] = deviceBootId;
  doc["uptimeMs"] = millis();
  doc["freeHeap"] = ESP.getFreeHeap();
  doc["minFreeHeap"] = ESP.getMinFreeHeap();
  doc["wifiStatus"] = static_cast<int>(WiFi.status());
  doc["wifiSsid"] = getActiveWifiSsid();
  doc["wifiSource"] = wifiConfigLoadedFromNvs ? "nvs" : "firmware";
  doc["staIp"] = WiFi.localIP().toString();
  doc["apActive"] = serviceSetupPortalActive;
  doc["apSsid"] = setupApSsid;
  doc["apIp"] = WiFi.softAPIP().toString();
  doc["rssi"] = isWifiReady() ? WiFi.RSSI() : 0;
  doc["wsConnected"] = deviceWsConnected;
  doc["configVersion"] = remoteConfigVersion;
  doc["heartbeatIntervalMs"] = runtimeHeartbeatIntervalMs;
  doc["actionsPollIntervalMs"] = runtimeDeviceActionsPollBaseMs;
  doc["lockPulseMs"] = runtimeLockUnlockPulseMs;
  doc["codeRateLimitEnabled"] = runtimeCodeRateLimitEnabled;
  doc["codeRateLimitFailures"] = codeRateLimitFailureCount;
  doc["codeRateLimitLockedUntilMs"] = codeRateLimitLockedUntilMs;

  JsonArray relays = doc["relays"].to<JsonArray>();
  for (uint8_t lockerId = 1; lockerId <= LOCK_RELAY_COUNT; lockerId += 1) {
    JsonObject relay = relays.add<JsonObject>();
    const LockRelayState& state = lockRelayStates[lockerRelayIndex(lockerId)];
    relay["locker"] = lockerId;
    relay["pin"] = lockerRelayPin(lockerId);
    relay["active"] = state.active;
    relay["pulsed"] = state.pulsed;
  }

  JsonArray readers = doc["rfid"].to<JsonArray>();
  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    JsonObject reader = readers.add<JsonObject>();
    reader["label"] = lockerReaders[i].label;
    reader["locker"] = lockerReaders[i].lockerNumber;
    reader["healthy"] = lockerReaderHealthy[i];
    reader["hasCard"] = lockerReaders[i].hasCard;
    reader["uid"] = lockerReaders[i].stableUid;
  }
  JsonObject master = doc["masterRfid"].to<JsonObject>();
  master["healthy"] = masterReaderHealthy;
  master["hasCard"] = masterReaderRuntime.hasCard;
  master["uid"] = masterReaderRuntime.stableUid;

  String output;
  serializeJson(doc, output);
  return output;
}

void handleServiceRoot() {
  if (!requireServiceAuth()) {
    return;
  }

  String html;
  html.reserve(3600);
  html += F("<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>");
  html += F("<title>SafeKeys Service</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:24px;background:#f7f8fa;color:#111}main{max-width:920px;margin:auto}section{margin:18px 0;padding:16px;border:1px solid #ddd;background:#fff}button,input,select{font:inherit;padding:8px;margin:4px 0}code{background:#eef;padding:2px 5px}a{display:inline-block;margin:6px 10px 6px 0}</style></head><body><main>");
  html += F("<h1>SafeKeys ESP32 Service</h1>");
  html += F("<section><h2>Status</h2><p>Firmware: <code>");
  html += FIRMWARE_VERSION;
  html += F("</code></p><p>Protocol: <code>");
  html += String(DEVICE_PROTOCOL_VERSION);
  html += F("</code>, config: <code>");
  html += String(remoteConfigVersion);
  html += F("</code></p><p>WiFi: <code>");
  html += htmlEscape(getActiveWifiSsid());
  html += F("</code> ");
  html += isWifiReady() ? WiFi.localIP().toString() : String("not connected");
  html += F("</p><p>Setup AP: ");
  html += serviceSetupPortalActive ? htmlEscape(setupApSsid) : String("off");
  html += F("</p><p>WebSocket: ");
  html += deviceWsConnected ? "connected" : "offline";
  html += F("</p></section>");
  html += F("<section><h2>Actions</h2><a href='/api/status'>JSON status</a><a href='/diag'>Diagnostics</a><a href='/wifi'>WiFi setup</a><a href='/ota'>OTA upload</a></section>");
  html += F("<section><h2>Quick relay test</h2>");
  for (uint8_t lockerId = 1; lockerId <= LOCK_RELAY_COUNT; lockerId += 1) {
    html += F("<form method='post' action='/diag/action' style='display:inline'><input type='hidden' name='action' value='relay'><input type='hidden' name='locker' value='");
    html += String(lockerId);
    html += F("'><button>Pulse L");
    html += String(lockerId);
    html += F("</button></form> ");
  }
  html += F("</section><section><h2>Safety</h2><form method='post' action='/factory-reset' onsubmit=\"return confirm('Factory reset WiFi/config and restart?')\"><input name='confirm' value='RESET'><button>Factory reset</button></form></section>");
  html += F("</main></body></html>");
  serviceServer.send(200, "text/html", html);
}

void handleServiceStatusJson() {
  if (!requireServiceAuth()) {
    return;
  }
  serviceServer.send(200, "application/json", buildStatusJson());
}

void handleServiceDiagnosticsPage() {
  if (!requireServiceAuth()) {
    return;
  }

  String html;
  html.reserve(2600);
  html += F("<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Diagnostics</title><style>body{font-family:system-ui;margin:24px}button{font:inherit;padding:8px;margin:4px}</style></head><body>");
  html += F("<h1>Diagnostics</h1><p><a href='/'>Back</a> <a href='/api/status'>JSON status</a></p>");
  html += F("<form method='post' action='/diag/action'><input type='hidden' name='action' value='led-success'><button>LED success</button></form>");
  html += F("<form method='post' action='/diag/action'><input type='hidden' name='action' value='led-error'><button>LED error</button></form>");
  html += F("<form method='post' action='/diag/action'><input type='hidden' name='action' value='rfid'><button>RFID health log</button></form>");
  html += F("<form method='post' action='/diag/action'><input type='hidden' name='action' value='reconnect'><button>Reconnect WiFi</button></form>");
  for (uint8_t lockerId = 1; lockerId <= LOCK_RELAY_COUNT; lockerId += 1) {
    html += F("<form method='post' action='/diag/action'><input type='hidden' name='action' value='relay'><input type='hidden' name='locker' value='");
    html += String(lockerId);
    html += F("'><button>Pulse relay L");
    html += String(lockerId);
    html += F("</button></form>");
  }
  html += F("</body></html>");
  serviceServer.send(200, "text/html", html);
}

void handleServiceDiagnosticAction() {
  if (!requireServiceAuth()) {
    return;
  }
  if (!runtimeDiagnosticsEnabled) {
    serviceServer.send(403, "text/plain", "Diagnostics disabled by remote config.");
    return;
  }

  const String action = serviceServer.arg("action");
  bool ok = true;
  String message = "ok";

  if (action == "relay") {
    const uint8_t locker = static_cast<uint8_t>(serviceServer.arg("locker").toInt());
    ok = pulseUnlockLocker(locker, runtimeLockUnlockPulseMs);
    message = ok ? String("relay pulsed") : String("invalid relay");
  } else if (action == "led-success") {
    flashCodeResult("0000", true);
    message = "success led shown";
  } else if (action == "led-error") {
    flashCodeResult("0000", false);
    message = "error led shown";
  } else if (action == "rfid") {
    printRfidSnapshot();
    message = "rfid snapshot printed";
  } else if (action == "reconnect") {
    wifiRetryIntervalMs = WIFI_RETRY_MS;
    consecutiveWifiFailureCount = 0;
    scheduleServiceWifiReconnect(SERVICE_WIFI_RECONNECT_DELAY_MS);
    message = "wifi reconnect scheduled";
  } else {
    ok = false;
    message = "unknown diagnostic action";
  }

  queueDeviceDiagnostic(action.c_str(), ok, message.c_str());
  serviceServer.sendHeader("Location", "/diag");
  serviceServer.send(303, "text/plain", "");
}

void handleServiceWifiPage() {
  if (!requireServiceAuth()) {
    return;
  }

  String html;
  html.reserve(5200);
  html += F("<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>WiFi Setup</title><style>body{font-family:system-ui;margin:24px}input,select,button{font:inherit;padding:8px;margin:4px 0;width:100%;max-width:420px}.muted{color:#555}</style></head><body>");
  html += F("<h1>WiFi Setup</h1><p><a href='/'>Back</a></p><form method='post' action='/wifi/save'><label>SSID</label><select id='ssid' name='ssid'><option value='");
  html += htmlEscape(getActiveWifiSsid());
  html += F("'>");
  html += htmlEscape(getActiveWifiSsid());
  html += F("</option></select><p id='scanStatus' class='muted'>Scanning networks...</p><label>Or SSID</label><input name='ssidManual' placeholder='Manual SSID'><label>Password</label><input name='password' type='password' autocomplete='new-password'><button>Save and reconnect</button></form>");
  html += F("<p>Current source: ");
  html += wifiConfigLoadedFromNvs ? "NVS" : "firmware fallback";
  html += F("</p><script>const current=");
  JsonDocument currentDoc;
  currentDoc["ssid"] = getActiveWifiSsid();
  String currentJson;
  serializeJson(currentDoc["ssid"], currentJson);
  html += currentJson;
  html += F(";const select=document.getElementById('ssid');const status=document.getElementById('scanStatus');fetch('/api/wifi/scan').then(r=>r.json()).then(d=>{select.textContent='';let found=false;(d.networks||[]).forEach(n=>{const o=document.createElement('option');o.value=n.ssid;o.textContent=n.ssid+' ('+n.rssi+' dBm)';if(n.ssid===current){o.selected=true;found=true;}select.appendChild(o);});if(!found&&current){const o=document.createElement('option');o.value=current;o.textContent=current+' (saved)';o.selected=true;select.insertBefore(o,select.firstChild);}status.textContent=(d.networks||[]).length+' networks found';}).catch(()=>{status.textContent='Scan failed. Use manual SSID.';});</script></body></html>");
  serviceServer.send(200, "text/html", html);
}

void handleServiceWifiSave() {
  if (!requireServiceAuth()) {
    return;
  }

  String ssid = serviceServer.arg("ssidManual");
  if (!ssid.length()) {
    ssid = serviceServer.arg("ssid");
  }
  const String password = serviceServer.arg("password");
  ssid.trim();

  if (!ssid.length()) {
    serviceServer.send(400, "text/plain", "SSID is required.");
    return;
  }

  saveWifiCredentials(ssid, password);
  queueDeviceLog("info", "WIFI_CONFIG_UPDATED", "WiFi credentials updated from service panel.");
  wifiConnectInProgress = false;
  consecutiveWifiFailureCount = 0;
  wifiRetryIntervalMs = WIFI_RETRY_MS;
  lastWifiRetryMs = 0;
  serviceServer.sendHeader("Connection", "close");
  serviceServer.send(200, "text/html", "<!doctype html><html><body><p>WiFi saved. ESP32 will close setup WiFi and reconnect in a moment.</p><p><a href='/'>Back</a></p></body></html>");
  scheduleServiceWifiReconnect(SERVICE_WIFI_RECONNECT_DELAY_MS);
}

void handleServiceWifiScanJson() {
  if (!requireServiceAuth()) {
    return;
  }

  JsonDocument doc;
  JsonArray networks = doc["networks"].to<JsonArray>();
  const int count = WiFi.scanNetworks(false, true);
  for (int i = 0; i < count; i += 1) {
    JsonObject item = networks.add<JsonObject>();
    item["ssid"] = WiFi.SSID(i);
    item["rssi"] = WiFi.RSSI(i);
    item["encryption"] = WiFi.encryptionType(i);
  }
  WiFi.scanDelete();
  String output;
  serializeJson(doc, output);
  serviceServer.send(200, "application/json", output);
}

void handleServiceOtaPage() {
  if (!requireServiceAuth()) {
    return;
  }
  if (!runtimeOtaEnabled) {
    serviceServer.send(403, "text/plain", "OTA disabled by remote config.");
    return;
  }

  serviceServer.send(200, "text/html",
    "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>OTA</title></head><body>"
    "<h1>OTA firmware upload</h1><p><a href='/'>Back</a></p>"
    "<form method='post' action='/ota' enctype='multipart/form-data'><input type='file' name='firmware' accept='.bin'><button>Upload firmware</button></form>"
    "</body></html>"
  );
}

void handleServiceOtaUpload() {
  if (!runtimeOtaEnabled || !serviceServer.authenticate(SERVICE_PANEL_USERNAME, SERVICE_PANEL_PASSWORD)) {
    return;
  }

  HTTPUpload& upload = serviceServer.upload();
  if (upload.status == UPLOAD_FILE_START) {
    Serial.printf("[OTA] upload start: %s\n", upload.filename.c_str());
    queueDeviceLog("info", "OTA_UPLOAD_STARTED", "OTA upload started from service panel.");
    if (!Update.begin(UPDATE_SIZE_UNKNOWN)) {
      Update.printError(Serial);
    }
  } else if (upload.status == UPLOAD_FILE_WRITE) {
    if (Update.write(upload.buf, upload.currentSize) != upload.currentSize) {
      Update.printError(Serial);
    }
  } else if (upload.status == UPLOAD_FILE_END) {
    if (Update.end(true)) {
      Serial.printf("[OTA] upload success: %u bytes\n", upload.totalSize);
      queueDeviceLog("info", "OTA_UPLOAD_COMPLETED", "OTA upload completed; restarting.");
    } else {
      Update.printError(Serial);
      queueDeviceLog("error", "OTA_UPLOAD_FAILED", "OTA update failed.");
    }
  }
}

void handleServiceOtaFinished() {
  if (!requireServiceAuth()) {
    return;
  }
  if (!runtimeOtaEnabled) {
    serviceServer.send(403, "text/plain", "OTA disabled by remote config.");
    return;
  }

  const bool ok = !Update.hasError();
  serviceServer.sendHeader("Connection", "close");
  serviceServer.send(ok ? 200 : 500, "text/plain", ok ? "OTA OK. Restarting." : "OTA failed.");
  if (ok) {
    delay(500);
    ESP.restart();
  }
}

void handleServiceFactoryReset() {
  if (!requireServiceAuth()) {
    return;
  }

  if (serviceServer.arg("confirm") != "RESET") {
    serviceServer.send(400, "text/plain", "Type RESET to confirm.");
    return;
  }

  queueDeviceLog("warn", "FACTORY_RESET", "Factory reset requested from service panel.");
  clearWifiCredentials();
  devicePreferences.clear();
  serviceServer.send(200, "text/plain", "Factory reset done. Restarting.");
  delay(500);
  ESP.restart();
}

void handleServiceCaptivePortal() {
  serviceServer.sendHeader("Cache-Control", "no-store");
  serviceServer.sendHeader("Location", "/", true);
  serviceServer.send(302, "text/plain", "");
}

void handleServiceFavicon() {
  serviceServer.sendHeader("Cache-Control", "max-age=86400");
  serviceServer.send(204, "text/plain", "");
}

void handleServiceNotFound() {
  if (serviceSetupPortalActive) {
    handleServiceCaptivePortal();
    return;
  }

  serviceServer.send(404, "text/plain", "Not found.");
}

void startServicePanel() {
  if (servicePanelStarted) {
    return;
  }

  serviceServer.on("/", HTTP_GET, handleServiceRoot);
  serviceServer.on("/api/status", HTTP_GET, handleServiceStatusJson);
  serviceServer.on("/diag", HTTP_GET, handleServiceDiagnosticsPage);
  serviceServer.on("/diag/action", HTTP_POST, handleServiceDiagnosticAction);
  serviceServer.on("/wifi", HTTP_GET, handleServiceWifiPage);
  serviceServer.on("/wifi/save", HTTP_POST, handleServiceWifiSave);
  serviceServer.on("/api/wifi/scan", HTTP_GET, handleServiceWifiScanJson);
  serviceServer.on("/ota", HTTP_GET, handleServiceOtaPage);
  serviceServer.on("/ota", HTTP_POST, handleServiceOtaFinished, handleServiceOtaUpload);
  serviceServer.on("/factory-reset", HTTP_POST, handleServiceFactoryReset);
  serviceServer.on("/generate_204", HTTP_GET, handleServiceCaptivePortal);
  serviceServer.on("/gen_204", HTTP_GET, handleServiceCaptivePortal);
  serviceServer.on("/hotspot-detect.html", HTTP_GET, handleServiceCaptivePortal);
  serviceServer.on("/library/test/success.html", HTTP_GET, handleServiceCaptivePortal);
  serviceServer.on("/connecttest.txt", HTTP_GET, handleServiceCaptivePortal);
  serviceServer.on("/ncsi.txt", HTTP_GET, handleServiceCaptivePortal);
  serviceServer.on("/fwlink", HTTP_GET, handleServiceCaptivePortal);
  serviceServer.on("/favicon.ico", HTTP_GET, handleServiceFavicon);
  serviceServer.onNotFound(handleServiceNotFound);
  serviceServer.begin();
  servicePanelStarted = true;
  Serial.printf("[SERVICE] panel listening on port %u\n", SERVICE_PANEL_PORT);
}

void startServiceSetupPortal(const char* reason) {
  if (serviceSetupPortalActive) {
    return;
  }

  setupApSsid = String("SafeKeys-Setup-") + String(deviceBootId).substring(0, 4);
  disconnectDeviceWebSocket();
  WiFi.disconnect(false, false);
  WiFi.mode(WIFI_AP_STA);
  WiFi.setSleep(false);
  WiFi.softAPConfig(
    IPAddress(192, 168, 4, 1),
    IPAddress(192, 168, 4, 1),
    IPAddress(255, 255, 255, 0)
  );
  const bool apStarted = WiFi.softAP(setupApSsid.c_str(), SERVICE_SETUP_AP_PASSWORD, 1, false, 4);
  if (!apStarted) {
    Serial.println("[SERVICE] failed to start setup AP.");
    return;
  }

  wifiConnectInProgress = false;
  wifiFirstConnectAttemptMs = 0;
  lastWifiRetryMs = millis();
  setupDnsServer.start(SERVICE_DNS_PORT, "*", WiFi.softAPIP());
  serviceSetupPortalActive = true;
  serviceSetupPortalStartRequested = false;
  serviceSetupPortalRequestedReason[0] = '\0';
  serviceSetupPortalStartedMs = millis();
  Serial.printf("[SERVICE] setup AP started ssid=%s ip=%s reason=%s\n",
    setupApSsid.c_str(),
    WiFi.softAPIP().toString().c_str(),
    reason != nullptr ? reason : "manual"
  );
  queueDeviceLog("warn", "WIFI_SETUP_PORTAL_STARTED", reason != nullptr ? reason : "setup portal started");
  markVisualStateDirty();
}

void stopServiceSetupPortal() {
  if (!serviceSetupPortalActive) {
    return;
  }

  setupDnsServer.stop();
  WiFi.softAPdisconnect(true);
  serviceSetupPortalActive = false;
  serviceSetupPortalStartedMs = 0;
  setupApSsid = "";
  WiFi.mode(WIFI_STA);
  Serial.println("[SERVICE] setup AP stopped.");
  queueDeviceLog("info", "WIFI_SETUP_PORTAL_STOPPED", "Setup portal stopped.");
}

void serviceServicePanel(unsigned long now) {
  if (serviceSetupPortalStartRequested && !serviceSetupPortalActive) {
    serviceSetupPortalStartRequested = false;
    startServiceSetupPortal(
      serviceSetupPortalRequestedReason[0] != '\0'
        ? serviceSetupPortalRequestedReason
        : "manual"
    );
    serviceSetupPortalRequestedReason[0] = '\0';
    return;
  }

  if (servicePanelStarted) {
    serviceServer.handleClient();
  }

  serviceScheduledWifiReconnect(millis());

  if (serviceSetupPortalActive) {
    setupDnsServer.processNextRequest();
    const unsigned long portalNow = millis();
    if (
      SERVICE_SETUP_TIMEOUT_MS > 0 &&
      !wifiConnectInProgress &&
      static_cast<long>(portalNow - serviceSetupPortalStartedMs) >= 0 &&
      portalNow - serviceSetupPortalStartedMs >= SERVICE_SETUP_TIMEOUT_MS
    ) {
      stopServiceSetupPortal();
    }
  }
}

bool isWifiReady() {
  return WiFi.status() == WL_CONNECTED;
}

void serviceDeviceWebSocket(unsigned long now) {
  if (!isWifiReady()) {
    return;
  }

  if (!deviceWsConfigured) {
    configureDeviceWebSocket();
  }

  if (
    deviceWsConnectAttemptActive &&
    !deviceWsConnected &&
    lastDeviceWsConnectAttemptMs != 0 &&
    now - lastDeviceWsConnectAttemptMs >= DEVICE_WS_CONNECT_ATTEMPT_TIMEOUT_MS
  ) {
    deviceWsConnectAttemptActive = false;
  }

  if (!deviceWsConnected && (deviceWsReconnectRequested || now >= nextDeviceWsConnectAttemptMs)) {
    connectDeviceWebSocket(now);
  }

  const bool shouldServiceSocket =
    deviceWsConnected ||
    deviceWsConnectAttemptActive ||
    deviceWsReconnectRequested ||
    nextDeviceWsConnectAttemptMs == 0 ||
    now >= nextDeviceWsConnectAttemptMs;

  if (shouldServiceSocket && now - lastDeviceWsServiceMs >= DEVICE_WS_SERVICE_INTERVAL_MS) {
    lastDeviceWsServiceMs = now;
    deviceWebSocket.loop();
  }

  maybeSendDeviceHello(millis());
}

void configureDeviceWebSocket() {
  static char extraHeaders[128];
  snprintf(extraHeaders, sizeof(extraHeaders), "x-device-key: %s", DEVICE_API_KEY);

  deviceWebSocket.onEvent(handleDeviceWebSocketEvent);
  deviceWebSocket.beginSSL(DEVICE_WS_HOST, DEVICE_WS_PORT, deviceWsPath, "", "");
  deviceWebSocket.setExtraHeaders(extraHeaders);
  deviceWebSocket.setReconnectInterval(DEVICE_WS_RECONNECT_BASE_MS);
  deviceWebSocket.disableHeartbeat();
  deviceWsConfigured = true;
}

void connectDeviceWebSocket(unsigned long now, bool forceNow) {
  if (!isWifiReady() || deviceWsConnected) {
    return;
  }

  if (!forceNow && nextDeviceWsConnectAttemptMs != 0 && now < nextDeviceWsConnectAttemptMs) {
    return;
  }

  if (!hasEnoughHeapForDeviceWebSocket()) {
    deviceWsConnectAttemptActive = false;
    deviceWsReconnectRequested = false;
    nextDeviceWsConnectAttemptMs = now + DEVICE_WS_HEAP_RETRY_MS;
    forceNextStateBatchHttps = true;
    return;
  }

  lastDeviceWsConnectAttemptMs = now;
  deviceWsConnectAttemptActive = true;
  deviceWsReconnectRequested = false;
  nextDeviceWsConnectAttemptMs = now + deviceWsReconnectDelayMs;
  deviceWebSocket.setReconnectInterval(deviceWsReconnectDelayMs);

  Serial.printf(
    "[WS] connecting to wss://%s:%u%s (backoff=%lu ms)\n",
    DEVICE_WS_HOST,
    DEVICE_WS_PORT,
    deviceWsPath,
    deviceWsReconnectDelayMs
  );

  deviceWsReconnectDelayMs = min(DEVICE_WS_RECONNECT_MAX_MS, deviceWsReconnectDelayMs * 2);
  deviceWebSocket.loop();
}

void disconnectDeviceWebSocket() {
  if (deviceWsConfigured) {
    deviceWebSocket.disconnect();
  }
  deviceWsConnected = false;
  deviceWsConnectAttemptActive = false;
  deviceWsHelloSent = false;
  deviceWsHelloPending = false;
  deviceWsServerHelloSeen = false;
  deviceWsHelloDueMs = 0;
  deviceWsReconnectRequested = true;
  nextDeviceWsConnectAttemptMs = 0;
}

bool hasEnoughHeapForDeviceWebSocket() {
  const uint32_t freeHeap = ESP.getFreeHeap();
  const uint32_t largestBlock = heap_caps_get_largest_free_block(MALLOC_CAP_8BIT);
  if (freeHeap >= DEVICE_WS_MIN_FREE_HEAP && largestBlock >= DEVICE_WS_MIN_LARGEST_BLOCK) {
    return true;
  }

  Serial.printf(
    "[WS] connect delayed: low heap free=%lu largest=%lu, retry in %lums\n",
    static_cast<unsigned long>(freeHeap),
    static_cast<unsigned long>(largestBlock),
    static_cast<unsigned long>(DEVICE_WS_HEAP_RETRY_MS)
  );
  return false;
}

bool isDeviceWebSocketOpen() {
  return isWifiReady() && deviceWsConnected;
}

bool isDeviceWebSocketReady() {
  return isDeviceWebSocketOpen() && deviceWsServerHelloSeen && deviceWsHelloSent;
}

bool isDeviceWebSocketStable(unsigned long now) {
  return isDeviceWebSocketReady()
    && lastDeviceWsConnectedMs != 0
    && now - lastDeviceWsConnectedMs >= DEVICE_WS_STABLE_SESSION_MS;
}

bool sendDeviceWebSocketText(const char* payload, size_t length) {
  if (!isDeviceWebSocketOpen() || payload == nullptr || length == 0) {
    return false;
  }

  if (length > DEVICE_WS_SEND_PAYLOAD_MAX) {
    Serial.printf("[WS] payload too large for framed send bytes=%u\n", static_cast<unsigned int>(length));
    return false;
  }

  if (deviceWsTxDebugFramesRemaining > 0) {
    deviceWsTxDebugFramesRemaining -= 1;
    Serial.printf(
      "[WS] tx text bytes=%u first=0x%02X heap=%lu largest=%lu\n",
      static_cast<unsigned int>(length),
      static_cast<unsigned int>(static_cast<uint8_t>(payload[0])),
      static_cast<unsigned long>(ESP.getFreeHeap()),
      static_cast<unsigned long>(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT))
    );
  }
  return deviceWebSocket.sendTXT(reinterpret_cast<const uint8_t*>(payload), length);
}

void maybeSendDeviceHello(unsigned long now) {
  if (
    !deviceWsHelloPending ||
    deviceWsHelloSent ||
    !isDeviceWebSocketOpen() ||
    !deviceWsServerHelloSeen ||
    (deviceWsHelloDueMs != 0 && now < deviceWsHelloDueMs)
  ) {
    return;
  }

  deviceWsHelloPending = false;
  sendDeviceHello();
}

bool shouldUseHttpsFallback(unsigned long now) {
  if (!isWifiReady() || wifiConnectInProgress || isBackgroundNetworkBackoffActive(now)) {
    return false;
  }

  if (isDeviceWebSocketReady()) {
    return false;
  }

  if (lastDeviceWsConnectAttemptMs == 0) {
    return true;
  }

  return now - lastDeviceWsConnectAttemptMs >= DEVICE_WS_FALLBACK_AFTER_MS;
}

void handleDeviceWebSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      deviceWsConnected = true;
      deviceWsConnectAttemptActive = false;
      deviceWsHelloSent = false;
      deviceWsHelloPending = false;
      deviceWsServerHelloSeen = false;
      deviceWsHelloDueMs = 0;
      lastDeviceWsConnectedMs = millis();
      lastDeviceWsHeartbeatMs = 0;
      requestFullStateResync("ws connected");
      deviceStateBatchQueued = false;
      resetDeviceActionsPollCadence();
      Serial.printf("[WS] connected: %.*s\n", static_cast<int>(length), payload);
      break;

    case WStype_DISCONNECTED:
    {
      const unsigned long disconnectedAtMs = millis();
      if (deviceWsConnected) {
        Serial.printf("[WS] disconnected%s%.*s\n", length > 0 ? ": " : "", static_cast<int>(length), payload);
      }
      const bool stableSession = lastDeviceWsConnectedMs != 0
        && disconnectedAtMs - lastDeviceWsConnectedMs >= DEVICE_WS_STABLE_SESSION_MS
        && deviceWsServerHelloSeen;
      if (stableSession) {
        deviceWsReconnectDelayMs = DEVICE_WS_RECONNECT_BASE_MS;
      }
      deviceWsConnected = false;
      deviceWsConnectAttemptActive = false;
      deviceWsHelloSent = false;
      deviceWsHelloPending = false;
      deviceWsServerHelloSeen = false;
      deviceWsHelloDueMs = 0;
      deviceWsReconnectRequested = true;
      nextDeviceWsConnectAttemptMs = disconnectedAtMs + deviceWsReconnectDelayMs;
      if (codeVerificationPending) {
        failPendingCodeVerification("WebSocket disconnected.");
      }
      if (masterTagVerificationPending) {
        failPendingMasterTagVerification("WebSocket disconnected.");
      }
      break;
    }

    case WStype_TEXT:
      handleDeviceWebSocketMessage(reinterpret_cast<const char*>(payload), length);
      break;

    case WStype_ERROR:
      Serial.printf("[WS] error: %.*s\n", static_cast<int>(length), payload);
      deviceWsConnected = false;
      deviceWsConnectAttemptActive = false;
      deviceWsHelloSent = false;
      deviceWsHelloPending = false;
      deviceWsServerHelloSeen = false;
      deviceWsHelloDueMs = 0;
      deviceWsReconnectRequested = true;
      nextDeviceWsConnectAttemptMs = millis() + deviceWsReconnectDelayMs;
      if (codeVerificationPending) {
        failPendingCodeVerification("WebSocket error.");
      }
      if (masterTagVerificationPending) {
        failPendingMasterTagVerification("WebSocket error.");
      }
      break;

    case WStype_PONG:
      Serial.println("[WS] pong");
      break;

    case WStype_PING:
      Serial.println("[WS] ping");
      break;

    default:
      break;
  }
}

void handleDeviceWebSocketMessage(const char* payload, size_t length) {
  JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, payload, length);
  if (error) {
    Serial.printf("[WS] JSON parse failed: %s\n", error.c_str());
    return;
  }

  const char* type = doc["type"] | "";
  if (strcmp(type, "hello") == 0 || strcmp(type, "server.hello") == 0) {
    const bool resyncRequired = doc["resyncRequired"] | false;
    deviceWsServerHelloSeen = true;
    Serial.printf("[WS] server hello, resync=%s connectionId=%s\n", resyncRequired ? "true" : "false", doc["connectionId"] | "(none)");
    if (resyncRequired) {
      requestFullStateResync("server hello");
      deviceStateBatchQueued = false;
    }
    if (!deviceWsHelloSent) {
      deviceWsHelloPending = true;
      deviceWsHelloDueMs = millis() + DEVICE_WS_HELLO_DELAY_MS;
      Serial.printf("[WS] hello scheduled in %lums\n", static_cast<unsigned long>(DEVICE_WS_HELLO_DELAY_MS));
    }
    return;
  }

  if (strcmp(type, "tag.verify.result") == 0) {
    handleTagVerifyResultMessage(doc);
    return;
  }

  if (strcmp(type, "code.verify.result") == 0) {
    handleCodeVerifyResultMessage(doc);
    return;
  }

  if (strcmp(type, "locker.status.result") == 0) {
    handleLockerStatusResultMessage(doc);
    return;
  }

  if (strcmp(type, "ack") == 0) {
    const bool ok = doc["ok"] | false;
    const char* messageId = doc["messageId"] | "(none)";
    const bool matchesPendingCodeAck = codeVerificationPending
      && pendingCodeMessageId[0] != '\0'
      && strcmp(messageId, pendingCodeMessageId) == 0;
    const bool matchesExpiredCodeAck = !codeVerificationPending
      && expiredCodeMessageId[0] != '\0'
      && strcmp(messageId, expiredCodeMessageId) == 0;
    if (matchesPendingCodeAck || matchesExpiredCodeAck) {
      Serial.printf("[WS ACK] code verify delivered requestId=%s ok=%s\n", messageId, ok ? "true" : "false");
      const JsonObject verification = doc["verification"];
      if (ok && verification.isNull()) {
        return;
      }

      NetworkResult result = {};
      result.type = NetworkResultType::VerifyCode;
      result.requestOk = ok;
      copyCStringToBuffer(matchesPendingCodeAck ? pendingCode : expiredCode, result.text1, sizeof(result.text1));
      copyCStringToBuffer(messageId, result.requestId, sizeof(result.requestId));
      if (!verification.isNull()) {
        result.boolValue1 = ok && (verification["valid"] | false);
        result.lockerNumber = static_cast<uint8_t>(verification["locker"] | 0);
        if (codeVerificationTimedOut || matchesExpiredCodeAck) {
          Serial.printf("[CODE VERIFY RESULT] late legacy ack result accepted code=%s requestId=%s\n",
            matchesPendingCodeAck ? pendingCode : expiredCode,
            messageId
          );
        }
        Serial.printf(
          "[CODE VERIFY RESULT] legacy ack result accepted code=%s requestId=%s valid=%s locker=%u ok=%s\n",
          matchesPendingCodeAck ? pendingCode : expiredCode,
          messageId,
          result.boolValue1 ? "true" : "false",
          result.lockerNumber,
          ok ? "true" : "false"
        );
      }
      if (matchesExpiredCodeAck) {
        clearExpiredCode();
      }
      if (networkResultQueue != nullptr && xQueueSend(networkResultQueue, &result, 0) != pdTRUE) {
        Serial.printf("[WS] verify code result queue full for %s\n", messageId);
        recoverFromDroppedNetworkResult(result);
      }
      return;
    }
    if (masterTagVerificationPending && pendingMasterTagMessageId[0] != '\0' && strcmp(messageId, pendingMasterTagMessageId) == 0) {
      pendingMasterTagVerify.acked = ok;
      Serial.printf("[WS] ack %s for %s\n", ok ? "ok" : "failed", messageId);
      Serial.printf("[WS ACK] request delivered requestId=%s ok=%s\n", messageId, ok ? "true" : "false");
      if (!ok) {
        NetworkResult result = {};
        result.type = NetworkResultType::VerifyMasterTag;
        result.requestOk = false;
        copyCStringToBuffer(pendingMasterTagId, result.text1, sizeof(result.text1));
        copyCStringToBuffer(messageId, result.requestId, sizeof(result.requestId));
        if (networkResultQueue != nullptr && xQueueSend(networkResultQueue, &result, 0) != pdTRUE) {
          Serial.printf("[WS] verify master tag ack failure queue full for %s\n", messageId);
          recoverFromDroppedNetworkResult(result);
        }
      }
      return;
    }
    if (strncmp(messageId, "state-", 6) == 0) {
      NetworkResult result = {};
      result.type = NetworkResultType::DeviceStateAck;
      result.requestOk = ok;
      copyCStringToBuffer(messageId, result.text1, sizeof(result.text1));
      if (networkResultQueue != nullptr && xQueueSend(networkResultQueue, &result, 0) != pdTRUE) {
        Serial.printf("[WS] state ack queue full for %s\n", messageId);
      }
      return;
    }

    if (!ok) {
      Serial.printf("[WS] protocol ack failed for %s: %s\n", messageId, doc["error"] | "unknown");
    } else if (DEBUG_RFID_VERBOSE) {
      Serial.printf("[WS] ack ok for %s\n", messageId);
    }
    return;
  }

  if (strcmp(type, "commands") != 0) {
    Serial.printf("[WS] unsupported message type: %s\n", type);
    return;
  }

  const JsonArray commands = doc["commands"];
  if (commands.isNull()) {
    return;
  }

  for (JsonObject command : commands) {
    NetworkResult result = {};
    result.type = NetworkResultType::DeviceCommand;
    result.requestOk = true;
    copyCStringToBuffer(command["id"] | "", result.actionId, sizeof(result.actionId));
    copyCStringToBuffer(command["type"] | "UNKNOWN", result.actionType, sizeof(result.actionType));
    result.lockerNumber = static_cast<uint8_t>(command["locker"] | 0);

    const JsonObject commandPayload = command["payload"];
    if (!commandPayload.isNull()) {
      copyCStringToBuffer(commandPayload["assignmentId"] | "", result.text1, sizeof(result.text1));
      copyCStringToBuffer(commandPayload["tagId"] | "", result.text2, sizeof(result.text2));
      copyCStringToBuffer(commandPayload["itemName"] | "", result.text3, sizeof(result.text3));
    }

    Serial.printf(
      "[WS] command received id=%s type=%s locker=%u\n",
      result.actionId,
      result.actionType,
      result.lockerNumber
    );

    if (networkResultQueue != nullptr && xQueueSend(networkResultQueue, &result, 0) != pdTRUE) {
      Serial.println("[WS] command result queue full, sending failed ack.");
      NetworkJob ack = {};
      ack.type = NetworkJobType::CommandAck;
      ack.boolValue = false;
      copyCStringToBuffer(result.actionId, ack.text1, sizeof(ack.text1));
      copyCStringToBuffer("failed", ack.text2, sizeof(ack.text2));
      copyCStringToBuffer("Firmware command queue full.", ack.text3, sizeof(ack.text3));
      enqueueNetworkJob(ack);
    }
  }
}

void handleTagVerifyResultMessage(JsonDocument& doc) {
  const uint32_t now = millis();
  const char* requestId = doc["requestId"] | "";
  const char* uid = doc["uid"] | "";
  if (strlen(uid) == 0) {
    uid = doc["tagId"] | "";
  }
  if (strlen(uid) == 0) {
    uid = pendingMasterTagId;
  }

  const bool ok = doc["ok"] | false;
  const bool known = doc["known"] | ok;
  const bool isMaster = doc["isMaster"] | false;
  const char* error = doc["error"] | "";
  uint8_t accessibleMask = static_cast<uint8_t>((doc["accessibleLockersMask"] | 0) & 0xFF);

  NetworkResult result = {};
  result.type = NetworkResultType::VerifyMasterTag;
  result.requestOk = strlen(error) == 0;
  result.boolValue1 = ok && known;
  result.boolValue2 = known;
  result.boolValue3 = isMaster;
  result.numberValue = accessibleMask;
  copyCStringToBuffer(uid, result.text1, sizeof(result.text1));
  copyCStringToBuffer(doc["displayName"] | "", result.text2, sizeof(result.text2));
  copyCStringToBuffer(doc["userId"] | "", result.text4, sizeof(result.text4));
  copyCStringToBuffer(requestId, result.requestId, sizeof(result.requestId));

  const JsonArray lockers = doc["lockers"];
  if (!lockers.isNull()) {
    for (JsonVariant value : lockers) {
      if (result.count >= LOCKER_COUNT) {
        break;
      }
      const uint8_t lockerNumber = static_cast<uint8_t>(value.as<int>());
      result.lockers[result.count] = lockerNumber;
      result.count += 1;
      accessibleMask |= lockerNumberToMask(lockerNumber);
    }
    result.numberValue = accessibleMask;
  }

  if (result.count == 0 && accessibleMask != 0) {
    for (uint8_t lockerNumber = 1; lockerNumber <= LOCKER_COUNT; lockerNumber += 1) {
      if (hasAccessToLocker(accessibleMask, lockerNumber)) {
        result.lockers[result.count] = lockerNumber;
        result.count += 1;
      }
    }
  }

  char maskText[8];
  formatLockerMaskBinary(static_cast<uint8_t>(result.numberValue & 0xFF), maskText, sizeof(maskText));
  Serial.printf(
    "[RFID VERIFY RESULT] uid=%s requestId=%s known=%s master=%s mask=%s ok=%s%s%s\n",
    result.text1,
    strlen(requestId) > 0 ? requestId : "(none)",
    known ? "true" : "false",
    isMaster ? "true" : "false",
    maskText,
    ok ? "true" : "false",
    strlen(error) > 0 ? " error=" : "",
    strlen(error) > 0 ? error : ""
  );

  if (!masterTagVerificationPending) {
    if (
      strlen(requestId) > 0 &&
      expiredMasterTagMessageId[0] != '\0' &&
      strcmp(requestId, expiredMasterTagMessageId) == 0
    ) {
      Serial.printf("[RFID VERIFY RESULT] stale result ignored uid=%s requestId=%s reason=expired_result_window\n",
        result.text1,
        requestId
      );
      return;
    }

    Serial.printf("[RFID VERIFY RESULT] stale result ignored uid=%s requestId=%s reason=no_pending_request\n",
      result.text1,
      strlen(requestId) > 0 ? requestId : "(none)"
    );
    return;
  }

  if (strlen(requestId) > 0 && pendingMasterTagMessageId[0] != '\0' && strcmp(requestId, pendingMasterTagMessageId) != 0) {
    Serial.printf("[RFID VERIFY RESULT] stale result ignored uid=%s requestId=%s expected=%s\n",
      result.text1,
      requestId,
      pendingMasterTagMessageId
    );
    return;
  }

  if (strlen(result.text1) > 0 && strcmp(result.text1, pendingMasterTagId) != 0) {
    Serial.printf("[RFID VERIFY RESULT] stale result ignored uid=%s expectedUid=%s\n",
      result.text1,
      pendingMasterTagId
    );
    return;
  }

  if (isPendingMasterTagResultExpired(now)) {
    Serial.printf("[RFID VERIFY RESULT] stale result ignored uid=%s requestId=%s reason=expired_result_window\n",
      result.text1,
      strlen(requestId) > 0 ? requestId : "(none)"
    );
    clearPendingMasterTag();
    startLedErrorFlash(700);
    return;
  }

  if (pendingMasterTagVerify.timedOut) {
    Serial.printf("[RFID VERIFY RESULT] late result accepted uid=%s requestId=%s\n",
      result.text1,
      strlen(requestId) > 0 ? requestId : "(none)"
    );
  }

  if (networkResultQueue != nullptr && xQueueSend(networkResultQueue, &result, 0) != pdTRUE) {
    Serial.printf("[WS] tag verify result queue full requestId=%s\n", strlen(requestId) > 0 ? requestId : "(none)");
    recoverFromDroppedNetworkResult(result);
  }
}

bool matchesExpiredCodeRequest(const char* requestId, const char* code) {
  const bool requestMatches = (
    requestId != nullptr &&
    requestId[0] != '\0' &&
    expiredCodeMessageId[0] != '\0' &&
    strcmp(requestId, expiredCodeMessageId) == 0
  );
  const bool codeMatches = (
    code != nullptr &&
    code[0] != '\0' &&
    expiredCode[0] != '\0' &&
    strcmp(code, expiredCode) == 0
  );
  return requestMatches || codeMatches;
}

void clearExpiredCode() {
  expiredCode[0] = '\0';
  expiredCodeMessageId[0] = '\0';
}

void handleCodeVerifyResultMessage(JsonDocument& doc) {
  const char* requestId = doc["requestId"] | "";
  if (strlen(requestId) == 0) {
    requestId = doc["messageId"] | "";
  }

  const char* code = doc["code"] | "";
  if (strlen(code) == 0) {
    code = pendingCode;
  }

  const bool ok = doc["ok"] | false;
  const bool valid = doc["valid"] | false;
  const uint8_t lockerNumber = static_cast<uint8_t>(doc["locker"] | 0);
  const char* error = doc["error"] | "";

  Serial.printf(
    "[CODE VERIFY RESULT] code=%s requestId=%s valid=%s locker=%u ok=%s%s%s\n",
    strlen(code) > 0 ? code : "(none)",
    strlen(requestId) > 0 ? requestId : "(none)",
    valid ? "true" : "false",
    lockerNumber,
    ok ? "true" : "false",
    strlen(error) > 0 ? " error=" : "",
    strlen(error) > 0 ? error : ""
  );

  if (!codeVerificationPending) {
    if (matchesExpiredCodeRequest(requestId, code)) {
      Serial.printf(
        "[CODE VERIFY RESULT] late result accepted after local expiry code=%s requestId=%s\n",
        strlen(code) > 0 ? code : "(none)",
        strlen(requestId) > 0 ? requestId : "(none)"
      );
    } else {
      Serial.printf(
        "[CODE VERIFY RESULT] stale result ignored code=%s requestId=%s reason=no_pending_request\n",
        strlen(code) > 0 ? code : "(none)",
        strlen(requestId) > 0 ? requestId : "(none)"
      );
      return;
    }
  } else {
    if (strlen(requestId) > 0 && pendingCodeMessageId[0] != '\0' && strcmp(requestId, pendingCodeMessageId) != 0) {
      Serial.printf(
        "[CODE VERIFY RESULT] stale result ignored code=%s requestId=%s expected=%s\n",
        strlen(code) > 0 ? code : "(none)",
        requestId,
        pendingCodeMessageId
      );
      return;
    }

    if (strlen(code) > 0 && strcmp(code, pendingCode) != 0) {
      Serial.printf(
        "[CODE VERIFY RESULT] stale result ignored code=%s expectedCode=%s\n",
        code,
        pendingCode
      );
      return;
    }
  }

  const unsigned long now = millis();
  const unsigned long sentAtMs = pendingCodeSentMs;
  if (
    codeVerificationPending &&
    sentAtMs != 0 &&
    static_cast<long>(now - sentAtMs) >= 0 &&
    now - sentAtMs >= DEVICE_VERIFY_CODE_TIMEOUT_MS + DEVICE_VERIFY_CODE_RESULT_GRACE_MS
  ) {
    Serial.printf(
      "[CODE VERIFY RESULT] stale result ignored code=%s requestId=%s reason=expired_result_window\n",
      strlen(code) > 0 ? code : pendingCode,
      strlen(requestId) > 0 ? requestId : "(none)"
    );
    rememberExpiredPendingCode();
    failPendingCodeVerification("Code verification result arrived after grace period.");
    return;
  }

  if (codeVerificationTimedOut) {
    Serial.printf(
      "[CODE VERIFY RESULT] late result accepted code=%s requestId=%s\n",
      strlen(code) > 0 ? code : pendingCode,
      strlen(requestId) > 0 ? requestId : "(none)"
    );
  }

  NetworkResult result = {};
  result.type = NetworkResultType::VerifyCode;
  result.requestOk = ok;
  result.boolValue1 = ok && valid;
  result.lockerNumber = lockerNumber;
  copyCStringToBuffer(
    strlen(code) > 0
      ? code
      : (codeVerificationPending ? pendingCode : expiredCode),
    result.text1,
    sizeof(result.text1)
  );
  copyCStringToBuffer(requestId, result.requestId, sizeof(result.requestId));
  clearExpiredCode();

  if (networkResultQueue != nullptr && xQueueSend(networkResultQueue, &result, 0) != pdTRUE) {
    Serial.printf("[WS] code verify result queue full requestId=%s\n", strlen(requestId) > 0 ? requestId : "(none)");
    recoverFromDroppedNetworkResult(result);
  }
}

void handleLockerStatusResultMessage(JsonDocument& doc) {
  const char* messageId = doc["messageId"] | "(none)";
  JsonArray lockers = doc["lockers"];
  if (lockers.isNull()) {
    JsonObject state = doc["state"];
    if (!state.isNull()) {
      lockers = state["accepted"];
    }
  }

  if (lockers.isNull()) {
    Serial.printf("[LED STATUS] result ignored messageId=%s reason=no_lockers\n", messageId);
    return;
  }

  uint8_t applied = 0;
  for (JsonVariant item : lockers) {
    if ((item["accepted"] | true) == false) {
      continue;
    }

    const uint8_t lockerNumber = static_cast<uint8_t>(item["locker"] | 0);
    const uint32_t version = static_cast<uint32_t>(item["version"] | 0);
    const char* severity = item["severity"] | "";
    const LockerItemStatus itemStatus = parseLockerItemStatus(item["itemStatus"] | "");
    const bool doorClosed = item["isDoorClosed"] | true;
    LockerLedStatus status;
    if (!parseLockerLedStatus(severity, status)) {
      Serial.printf("[LED STATUS] locker=%u ignored reason=unknown_severity value=%s\n",
        lockerNumber,
        strlen(severity) > 0 ? severity : "(empty)"
      );
      continue;
    }

    if (applyPanelLockerLedStatus(lockerNumber, version, status, itemStatus, doorClosed, severity)) {
      applied += 1;
    }
  }

  if (applied > 0) {
    panelStatusResultPending = false;
    panelStatusResultPendingStartedMs = 0;
    Serial.printf("[LED STATUS] applied panel statuses count=%u messageId=%s\n", applied, messageId);
    startLedStripEffect(LED_STRIP_EFFECT_SYNC_OK, LED_SYNC_OK_EFFECT_MS);
    markVisualStateDirty();
    updateVisualState();
  }
}

uint32_t nextDeviceSequence() {
  deviceMessageSequence += 1;
  if (deviceMessageSequence == 0) {
    deviceMessageSequence = 1;
  }
  return deviceMessageSequence;
}

void buildMessageId(char* buffer, size_t bufferSize, const char* prefix, uint32_t sequence) {
  snprintf(buffer, bufferSize, "%s-%s-%lu", prefix, deviceBootId, static_cast<unsigned long>(sequence));
}

void maybeSendHeartbeat(unsigned long now) {
  if (isBackgroundNetworkBackoffActive(now)) {
    return;
  }

  if (!isDeviceWebSocketReady() && !shouldUseHttpsFallback(now)) {
    return;
  }

  if (isDeviceWebSocketReady() && !isDeviceWebSocketStable(now)) {
    return;
  }

  if (heartbeatQueued || (lastHeartbeatMs != 0 && now - lastHeartbeatMs < runtimeHeartbeatIntervalMs)) {
    return;
  }

  NetworkJob job = {};
  job.type = NetworkJobType::Heartbeat;
  if (enqueueNetworkJob(job)) {
    heartbeatQueued = true;
    lastHeartbeatMs = now;
  }
}

void maybePollDeviceActions(unsigned long now) {
  if (isBackgroundNetworkBackoffActive(now)) {
    return;
  }

  if (deviceActionsPollQueued || (lastDeviceActionsPollMs != 0 && now - lastDeviceActionsPollMs < deviceActionsPollIntervalMs)) {
    return;
  }

  NetworkJob job = {};
  job.type = NetworkJobType::DeviceActionsPoll;
  if (enqueueNetworkJob(job)) {
    deviceActionsPollQueued = true;
    lastDeviceActionsPollMs = now;
  }
}

bool maybeQueueDeviceStateBatch(unsigned long now) {
  if (isBackgroundNetworkBackoffActive(now)) {
    return false;
  }

  if (nextDeviceStateBatchAttemptMs != 0 && now < nextDeviceStateBatchAttemptMs) {
    return false;
  }

  if (deviceStateAckPending) {
    if (!isPendingStateBatchTimedOut(now)) {
      return false;
    }

    const bool retryFull = pendingStateWasFull;
    if (isDeviceWebSocketReady()) {
      Serial.printf("[WS] state batch ack timeout for %s, keeping WebSocket transport only.\n", pendingStateMessageId);
      pendingStateBatchSentMs = now;
      if (deviceStateBatchFailureCount < 255) {
        deviceStateBatchFailureCount += 1;
      }
      return false;
    }

    Serial.printf("[WS] state batch ack timeout for %s, HTTPS fallback scheduled.\n", pendingStateMessageId);
    clearPendingStateBatch();
    forceNextStateBatchHttps = true;
    if (retryFull) {
      requestFullStateResync("state ws ack timeout");
      markAllLockerReportsDirty(now, false);
    }
    nextDeviceStateBatchAttemptMs = now + DEVICE_STATE_BATCH_FALLBACK_DELAY_MS;
    return false;
  }

  if (deviceStateBatchQueued) {
    return false;
  }

  if (!isDeviceWebSocketReady() && !shouldUseHttpsFallback(now)) {
    return false;
  }

  if (isDeviceWebSocketReady() && !isDeviceWebSocketStable(now) && !forceNextStateBatchHttps) {
    return false;
  }

  bool hasDirty = fullStateResyncPending;
  const bool periodicFullResyncDue =
    !fullStateResyncPending &&
    nextFullStateResyncDueMs != 0 &&
    isDeadlineReached(now, nextFullStateResyncDueMs);

  if (periodicFullResyncDue) {
    hasDirty = true;
    nextFullStateResyncDueMs = 0;
    requestFullStateResync("periodic full snapshot");
  }

  bool allDirtyPastBatchWindow = true;
  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    RfidReaderRuntime& runtime = lockerReaders[i];
    if (!runtime.reportDirty) {
      continue;
    }

    hasDirty = true;
    if (runtime.nextReportAttemptMs != 0 && now < runtime.nextReportAttemptMs) {
      return false;
    }

    if (runtime.dirtySinceMs == 0) {
      runtime.dirtySinceMs = now;
    }

    if (now - runtime.dirtySinceMs < LOCKER_STATUS_BATCH_WINDOW_MS) {
      allDirtyPastBatchWindow = false;
    }
  }

  if (!hasDirty || !allDirtyPastBatchWindow) {
    return false;
  }

  NetworkJob job = {};
  job.type = NetworkJobType::DeviceStateBatch;
  buildLockerStateBatchJob(job, fullStateResyncPending);

  const bool hasDirtyReports = hasDirtyLockerReports();
  const bool duplicateAckedState =
    lastAckedStateFingerprintReady &&
    job.numberValue == lastAckedStateFingerprint;
  const bool fullGenerationAlreadyAcked =
    !job.boolValue ||
    fullStateResyncGeneration == lastAckedFullStateResyncGeneration;

  if (duplicateAckedState && fullGenerationAlreadyAcked) {
    if (
      (hasDirtyReports || fullStateResyncPending) &&
      (lastDuplicateStateSuppressedLogMs == 0 || now - lastDuplicateStateSuppressedLogMs >= STATE_DUPLICATE_SUPPRESS_LOG_INTERVAL_MS)
    ) {
      Serial.println("[state] duplicate locker snapshot suppressed; no effective state change.");
      lastDuplicateStateSuppressedLogMs = now;
    }
    fullStateResyncPending = false;
    clearAllLockerReportsClean(now);
    return false;
  }

  if (!enqueueNetworkJob(job)) {
    return false;
  }

  deviceStateBatchQueued = true;
  lastDeviceStateBatchMs = now;
  return true;
}

bool maybeReportLockerStatuses(unsigned long now) {
  if (isBackgroundNetworkBackoffActive(now)) {
    return false;
  }

  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    RfidReaderRuntime& runtime = lockerReaders[i];
    if (lockerStatusQueued[i]) {
      continue;
    }
    const bool needsPeriodicResync = runtime.lastReportMs != 0
      && now - runtime.lastReportMs >= LOCKER_STATUS_RESYNC_INTERVAL_MS;

    if (!runtime.reportDirty && !needsPeriodicResync) {
      continue;
    }

    if (runtime.nextReportAttemptMs != 0 && now < runtime.nextReportAttemptMs) {
      continue;
    }

    if (runtime.reportDirty) {
      if (runtime.dirtySinceMs == 0) {
        runtime.dirtySinceMs = now;
      }

      if (now - runtime.dirtySinceMs < LOCKER_STATUS_BATCH_WINDOW_MS) {
        continue;
      }
    }

    NetworkJob job = {};
    job.type = NetworkJobType::LockerStatus;
    job.lockerNumber = runtime.lockerNumber;
    job.boolValue = runtime.hasCard;
    copyStringToBuffer(runtime.stableUid, job.text1, sizeof(job.text1));

    if (enqueueNetworkJob(job)) {
      lockerStatusQueued[i] = true;
      return true;
    }

    return false;
  }

  return false;
}

void buildLockerStateBatchJob(NetworkJob& job, bool full) {
  job.boolValue = full;
  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    const LockerState state = readLockerState(i);
    job.lockerHasTag[i] = state.tagPresent;
    job.lockerDoorClosed[i] = state.doorClosed;
    job.lockerLockClosed[i] = state.lockClosed;
    job.lockerVersions[i] = lockerStateVersions[i];
    copyStringToBuffer(state.tagUid, job.lockerTags[i], sizeof(job.lockerTags[i]));
  }
  job.numberValue = calculateJobStateFingerprint(job);
}

void serviceLockerInputChanges(unsigned long now) {
  if (!ENABLE_LOCKER_SWITCH_INPUTS) {
    return;
  }

  if (lastLockerInputServiceMs != 0 && now - lastLockerInputServiceMs < LOCKER_INPUT_SCAN_INTERVAL_MS) {
    return;
  }
  lastLockerInputServiceMs = now;

  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    const LockerState state = readLockerState(i);
    if (!lockerInputSnapshotReady[i]) {
      lockerInputSnapshotReady[i] = true;
      lastLockerDoorClosed[i] = state.doorClosed;
      lastLockerLockClosed[i] = state.lockClosed;
      candidateLockerDoorClosed[i] = state.doorClosed;
      candidateLockerLockClosed[i] = state.lockClosed;
      lockerInputCandidateReady[i] = false;
      lockerInputCandidateSinceMs[i] = 0;
      continue;
    }

    if (state.doorClosed == lastLockerDoorClosed[i] && state.lockClosed == lastLockerLockClosed[i]) {
      lockerInputCandidateReady[i] = false;
      lockerInputCandidateSinceMs[i] = 0;
      continue;
    }

    if (
      !lockerInputCandidateReady[i] ||
      state.doorClosed != candidateLockerDoorClosed[i] ||
      state.lockClosed != candidateLockerLockClosed[i]
    ) {
      lockerInputCandidateReady[i] = true;
      candidateLockerDoorClosed[i] = state.doorClosed;
      candidateLockerLockClosed[i] = state.lockClosed;
      lockerInputCandidateSinceMs[i] = now;
      continue;
    }

    if (now - lockerInputCandidateSinceMs[i] < LOCKER_INPUT_DEBOUNCE_MS) {
      continue;
    }

    lastLockerDoorClosed[i] = candidateLockerDoorClosed[i];
    lastLockerLockClosed[i] = candidateLockerLockClosed[i];
    lockerInputCandidateReady[i] = false;
    lockerInputCandidateSinceMs[i] = 0;
    markLockerStateChanged(lockerReaders[i], now);
    Serial.printf(
      "Locker S%u input changed -> door=%s lock=%s\n",
      i + 1,
      lastLockerDoorClosed[i] ? "closed" : "open",
      lastLockerLockClosed[i] ? "closed" : "open"
    );
  }
}

void handleKeypad() {
  const unsigned long now = millis();
  const uint8_t rawKey = keypad.getKey();
  const bool noStableKey =
    rawKey == I2C_KEYPAD_NOKEY ||
    rawKey == I2C_KEYPAD_THRESHOLD ||
    rawKey == I2C_KEYPAD_FAIL;

  if (noStableKey) {
    if (keypadPressLocked) {
      if (keypadReleaseStartedMs == 0) {
        keypadReleaseStartedMs = now;
      }

      if (keypadReleaseScanCount < KEYPAD_RELEASE_CONFIRM_SCANS) {
        keypadReleaseScanCount += 1;
      }
    }

    if (
      !keypadPressLocked ||
      (
        keypadReleaseScanCount >= KEYPAD_RELEASE_CONFIRM_SCANS &&
        keypadReleaseStartedMs != 0 &&
        now - keypadReleaseStartedMs >= KEYPAD_RELEASE_DEBOUNCE_MS
      )
    ) {
      keypadPressLocked = false;
      lastStableRawKey = I2C_KEYPAD_NOKEY;
      keypadReleaseScanCount = 0;
      keypadReleaseStartedMs = 0;
    }

    if (rawKey == I2C_KEYPAD_FAIL && !keypadPressLocked) {
      Serial.println("Keypad read failed or multiple keys pressed.");
      blinkLed(2, 50, 50);
    }
    return;
  }

  keypadReleaseStartedMs = 0;

  if (keypadPressLocked || rawKey == lastStableRawKey) {
    return;
  }

  lastStableRawKey = rawKey;
  keypadPressLocked = true;
  keypadReleaseScanCount = 0;

  const char key = mapRawKeyToChar(rawKey);
  if (key == '\0') {
    Serial.println("Keypad returned an unmapped key.");
    blinkLed(2, 50, 50);
    return;
  }

  Serial.printf("Key pressed: %c\n", key);
  pulseLed(30);

  if (accessSelection.active) {
    handleAccessSelectionKey(key);
    return;
  }

  if (key >= '0' && key <= '9') {
    if (enteredCode.length() >= CODE_LENGTH) {
      Serial.println("Buffer already has 4 digits. Press # to submit or * to clear.");
      blinkLed(2, 60, 60);
      return;
    }

    enteredCode += key;
    Serial.printf("Current code buffer: %s\n", enteredCode.c_str());
    markVisualStateDirty();
    renderCodeEntry(now);
    return;
  }

  if (key == '*') {
    enteredCode = "";
    Serial.println("Code buffer cleared.");
    blinkLed(1, 80, 80);
    markVisualStateDirty();
    updateVisualState();
    return;
  }

  if (key == '#') {
    if (enteredCode.length() != CODE_LENGTH) {
      Serial.println("Enter exactly 4 digits before sending the code.");
      blinkLed(3, 70, 70);
      markVisualStateDirty();
      renderCodeEntry(now);
      return;
    }

    processEnteredCode(enteredCode);
    enteredCode = "";
    markVisualStateDirty();
    updateVisualState();
    return;
  }

  if (key == 'A') {
    Serial.println("Manual WiFi reconnect requested.");
    enteredCode = "";
    markVisualStateDirty();
    wifiRetryIntervalMs = WIFI_RETRY_MS;
    consecutiveWifiFailureCount = 0;
    if (serviceSetupPortalActive) {
      scheduleServiceWifiReconnect(0);
    } else {
      WiFi.disconnect(false, false);
      connectWifi();
    }
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
    markVisualStateDirty();
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
        wifiRetryIntervalMs = WIFI_RETRY_MS;
        consecutiveWifiFailureCount = 0;
        if (serviceSetupPortalActive) {
          scheduleServiceWifiReconnect(0);
        } else {
          WiFi.disconnect(false, false);
          connectWifi();
        }
      } else if (command == "wifi-setup") {
        Serial.println("Service setup portal requested.");
        requestServiceSetupPortal("serial command");
      } else if (command == "config") {
        if (remoteConfigHttpUnsupported) {
          Serial.println("[CONFIG] /device/config unavailable on backend; fetch skipped.");
          continue;
        }
        nextRemoteConfigFetchMs = 0;
        maybeFetchRemoteConfig(millis());
      } else if (command == "heartbeat" || command == "h") {
        if (isWifiReady()) {
          maybeSendHeartbeat(millis());
        } else {
          Serial.println("Heartbeat skipped: WiFi not connected.");
        }
      } else if (command == "lockers" || command == "l") {
        for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
          markLockerReportDirty(lockerReaders[i], millis());
        }
        requestFullStateResync("serial lockers");
        if (isWifiReady()) {
          maybeQueueDeviceStateBatch(millis());
        } else {
          Serial.println("Locker report queued, waiting for WiFi.");
        }
      } else if (command == "actions" || command == "a") {
        if (isWifiReady()) {
          maybePollDeviceActions(millis());
        } else {
          Serial.println("Actions poll skipped: WiFi not connected.");
        }
      } else if (command == "openall") {
        if (pulseUnlockLockerMask(allRelayLockersMask())) {
          Serial.println("Manual relay test: all configured lockers triggered.");
        } else {
          Serial.println("Manual relay test failed for openall.");
        }
      } else if (command == "locksoff") {
        allLocksOff();
      } else if (command.startsWith("open ")) {
        const int lockerNumber = command.substring(5).toInt();
        if (lockerNumber <= 0 || !pulseUnlockLocker(static_cast<uint8_t>(lockerNumber), runtimeLockUnlockPulseMs)) {
          Serial.println("Manual relay test failed. Use: open 1..4");
        } else {
          Serial.printf("Manual relay test: locker %d triggered.\n", lockerNumber);
        }
      } else if (command == "clear" || command == "c") {
        enteredCode = "";
        Serial.println("Code buffer cleared from serial.");
        markVisualStateDirty();
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
  const unsigned long now = millis();
  if (isCodeEntryRateLimited(now)) {
    const unsigned long remainingMs = codeRateLimitLockedUntilMs > now ? codeRateLimitLockedUntilMs - now : 0;
    Serial.printf("[CODE RATE LIMIT] code entry locked for %lu ms\n", remainingMs);
    queueDeviceLog("warn", "CODE_RATE_LIMITED", "Keypad code entry is temporarily locked.");
    startLedErrorFlash(700);
    flashCodeResult(code, false);
    blinkLed(5, 70, 70);
    return;
  }

  if (codeVerificationPending) {
    Serial.println("Code verification already in progress.");
    blinkLed(2, 80, 80);
    return;
  }

  Serial.printf("Queueing code %s for backend verification...\n", code.c_str());
  setPendingCode(code);
  setStatusLed(true);
  renderCodeEntry(millis());

  NetworkJob job = {};
  job.type = NetworkJobType::VerifyCode;
  copyStringToBuffer(code, job.text1, sizeof(job.text1));

  if (!enqueueNetworkJob(job)) {
    clearPendingCode();
    setStatusLed(false);
    Serial.println("Failed to queue code verification.");
    flashCodeResult(code, false);
    blinkLed(5, 80, 80);
  }
}

bool isCodeEntryRateLimited(unsigned long now) {
  if (!runtimeCodeRateLimitEnabled) {
    return false;
  }

  return codeRateLimitLockedUntilMs != 0 && static_cast<long>(now - codeRateLimitLockedUntilMs) < 0;
}

void registerCodeVerificationFailure(unsigned long now) {
  if (!runtimeCodeRateLimitEnabled) {
    return;
  }

  if (codeRateLimitWindowStartedMs == 0 || now - codeRateLimitWindowStartedMs > runtimeCodeRateLimitWindowMs) {
    codeRateLimitWindowStartedMs = now;
    codeRateLimitFailureCount = 0;
  }

  if (codeRateLimitFailureCount < 255) {
    codeRateLimitFailureCount += 1;
  }

  if (codeRateLimitFailureCount >= runtimeCodeRateLimitMaxFailures) {
    codeRateLimitLockedUntilMs = now + runtimeCodeRateLimitLockoutMs;
    Serial.printf(
      "[CODE RATE LIMIT] lockout started failures=%u lockout=%lums\n",
      codeRateLimitFailureCount,
      static_cast<unsigned long>(runtimeCodeRateLimitLockoutMs)
    );
    queueDeviceLog("warn", "CODE_RATE_LIMIT_LOCKOUT", "Too many invalid keypad codes; lockout started.");
  }
}

void resetCodeRateLimit() {
  codeRateLimitFailureCount = 0;
  codeRateLimitWindowStartedMs = 0;
  codeRateLimitLockedUntilMs = 0;
}

void serviceNetworkResults() {
  if (networkResultQueue == nullptr) {
    return;
  }

  NetworkResult result = {};
  while (xQueueReceive(networkResultQueue, &result, 0) == pdTRUE) {
    handleNetworkResult(result);
  }
}

void handleNetworkResult(const NetworkResult& result) {
  const unsigned long now = millis();

  switch (result.type) {
    case NetworkResultType::Heartbeat:
      heartbeatQueued = false;
      if (!result.requestOk) {
        lastHeartbeatMs = 0;
      }
      break;

    case NetworkResultType::LockerStatus: {
      const uint8_t lockerIndex = result.lockerNumber > 0 ? result.lockerNumber - 1 : LOCKER_COUNT;
      if (lockerIndex < LOCKER_COUNT) {
        lockerStatusQueued[lockerIndex] = false;
        if (result.requestOk) {
          RfidReaderRuntime& runtime = lockerReaders[lockerIndex];
          const bool stateMatches = result.boolValue1 == runtime.hasCard
            && (
              !result.boolValue1 ||
              String(result.text1) == runtime.stableUid
            );

          if (stateMatches) {
            noteLockerReportSuccess(runtime, now);
          } else {
            // A delayed HTTP success can acknowledge an older state after the
            // tag has already been removed or replaced. Keep the locker dirty
            // so the current state is resent immediately.
            markLockerReportDirty(runtime, now);
            Serial.printf(
              "Locker S%u state changed while report was in flight. Acked hasTag=%s uid=%s, current hasTag=%s uid=%s. Resync queued.\n",
              result.lockerNumber,
              result.boolValue1 ? "true" : "false",
              result.boolValue1 && strlen(result.text1) > 0 ? result.text1 : "(none)",
              runtime.hasCard ? "true" : "false",
              runtime.hasCard && runtime.stableUid.length() > 0 ? runtime.stableUid.c_str() : "(none)"
            );
          }
        } else {
          noteLockerReportFailure(lockerReaders[lockerIndex], now);
        }
      }
      break;
    }

    case NetworkResultType::DeviceStateBatch:
      deviceStateBatchQueued = false;
      if (result.requestOk) {
        if (result.boolValue2) {
          Serial.printf("Device state batch queued via WebSocket (%s), waiting for backend ack.\n", result.boolValue1 ? "full" : "delta");
          break;
        }

        for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
          if (lockerStateVersions[i] == result.lockerVersions[i]) {
            noteLockerReportSuccess(lockerReaders[i], now);
          } else {
            markLockerReportDirty(lockerReaders[i], now);
          }
          lockerStatusQueued[i] = false;
        }
        fullStateResyncPending = false;
        resetStateBatchRetry();
        forceNextStateBatchHttps = false;
        rememberAckedStateFingerprint(static_cast<uint32_t>(result.numberValue), result.boolValue1, fullStateResyncGeneration, now);
        if (!panelStatusResultPending) {
          startLedStripEffect(LED_STRIP_EFFECT_SYNC_OK, LED_SYNC_OK_EFFECT_MS);
        }
        Serial.printf("Device state batch delivered via %s\n", isDeviceWebSocketReady() ? "WebSocket" : "HTTPS fallback");
      } else {
        for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
          noteLockerReportFailure(lockerReaders[i], now);
        }
        scheduleStateBatchRetry(now, true);
        Serial.println("Device state batch failed, resync retry scheduled.");
      }
      break;

    case NetworkResultType::DeviceStateAck:
      handleDeviceStateAck(result);
      break;

    case NetworkResultType::DeviceCommand:
      handleRemoteCommand(result);
      break;

    case NetworkResultType::CommandAck:
      if (!result.requestOk) {
        Serial.printf("Command ack failed for actionId=%s\n", result.actionId);
      }
      break;

    case NetworkResultType::DeviceActionsPoll:
      deviceActionsPollQueued = false;
      if (!result.requestOk) {
        lastDeviceActionsPollMs = 0;
        break;
      }

      if (result.count > 0) {
        Serial.printf("Received %u remote action(s)\n", result.count);
        blinkLed(2, 60, 60);
      }

      if (result.boolValue1) {
        startTagAssignmentMode(String(result.text1), String(result.text2), String(result.text3));
      }

      if (result.boolValue2) {
        const bool assignmentMatches = strlen(result.text4) == 0 || String(result.text4) == tagAssignmentMode.assignmentId;
        if (tagAssignmentMode.active && assignmentMatches) {
          Serial.printf("Cancelling tag assignment mode for assignmentId=%s\n", result.text4);
          stopTagAssignmentMode();
          blinkLed(2, 90, 90);
        }
      }

      if (result.count > 0 || result.boolValue1 || result.boolValue2 || tagAssignmentMode.active) {
        resetDeviceActionsPollCadence();
      } else {
        relaxDeviceActionsPollCadence();
      }
      break;

    case NetworkResultType::VerifyCode:
      setStatusLed(false);
      if (!codeVerificationPending) {
        if (!matchesExpiredCodeRequest(result.requestId, result.text1)) {
          break;
        }
      } else if (strcmp(result.text1, pendingCode) != 0) {
        break;
      }

      clearPendingCode();
      clearExpiredCode();

      if (!result.requestOk) {
        Serial.printf("[CODE VERIFY] request failed code=%s requestId=%s\n",
          result.text1,
          strlen(result.requestId) > 0 ? result.requestId : "(none)"
        );
        flashCodeResult(String(result.text1), false);
        blinkLed(5, 80, 80);
        break;
      }

      if (!result.boolValue1) {
        Serial.printf("[CODE VERIFY] invalid code=%s requestId=%s\n",
          result.text1,
          strlen(result.requestId) > 0 ? result.requestId : "(none)"
        );
        registerCodeVerificationFailure(now);
        flashCodeResult(String(result.text1), false);
        blinkLed(4, 120, 90);
        break;
      }

      Serial.printf("[CODE VERIFY] valid code=%s locker=S%u requestId=%s\n",
        result.text1,
        result.lockerNumber,
        strlen(result.requestId) > 0 ? result.requestId : "(none)"
      );
      if (!pulseUnlockLocker(result.lockerNumber, runtimeLockUnlockPulseMs)) {
        Serial.printf("[CODE VERIFY] relay pulse failed locker=S%u\n", result.lockerNumber);
        flashCodeResult(String(result.text1), false);
        startLedErrorFlash(700);
        blinkLed(4, 90, 80);
        break;
      }
      resetCodeRateLimit();
      flashCodeResult(String(result.text1), true);
      if (result.lockerNumber >= 1 && result.lockerNumber <= LOCKER_COUNT) {
        startLedSegmentFlash(result.lockerNumber, colorWhite(190), LED_REMOTE_FLASH_MS);
      }
      blinkLed(2, 260, 140);
      break;

    case NetworkResultType::VerifyMasterTag: {
      if (masterTagVerificationPending && strcmp(result.text1, pendingMasterTagId) == 0) {
        clearPendingMasterTag();
      }

      if (!result.requestOk) {
        Serial.printf("[RFID VERIFY] request failed uid=%s requestId=%s\n",
          strlen(result.text1) > 0 ? result.text1 : "(unknown)",
          strlen(result.requestId) > 0 ? result.requestId : "(none)"
        );
        startLedErrorFlash(700);
        blinkLed(4, 70, 70);
        break;
      }

      uint8_t accessibleMask = static_cast<uint8_t>(result.numberValue & 0xFF);
      for (uint8_t i = 0; i < result.count && i < LOCKER_COUNT; i += 1) {
        accessibleMask |= lockerNumberToMask(result.lockers[i]);
      }

      char maskText[8];
      formatLockerMaskBinary(accessibleMask, maskText, sizeof(maskText));

      if (!result.boolValue1) {
        Serial.printf("[RFID VERIFY] access denied uid=%s requestId=%s known=%s master=%s mask=%s reason=not_authorized\n",
          result.text1,
          strlen(result.requestId) > 0 ? result.requestId : "(none)",
          result.boolValue2 ? "true" : "false",
          result.boolValue3 ? "true" : "false",
          maskText
        );
        startLedErrorFlash(700);
        blinkLed(4, 90, 80);
        break;
      }

      if (accessibleMask == 0) {
        Serial.printf("[RFID VERIFY] selection not started uid=%s requestId=%s reason=no_accessible_lockers mask=%s\n",
          result.text1,
          strlen(result.requestId) > 0 ? result.requestId : "(none)",
          maskText
        );
        startLedErrorFlash(700);
        blinkLed(4, 90, 80);
        break;
      }

      Serial.printf(
        "[ACCESS SELECTION] starting displayName=%s uid=%s requestId=%s mask=%s master=%s timeout=%lums\n",
        strlen(result.text2) > 0 ? result.text2 : "(unknown)",
        result.text1,
        strlen(result.requestId) > 0 ? result.requestId : "(none)",
        maskText,
        result.boolValue3 ? "true" : "false",
        static_cast<unsigned long>(ACCESS_SELECTION_TIMEOUT_MS)
      );
      startAccessSelection(
        String(result.text1),
        accessibleMask,
        result.boolValue3,
        String(result.requestId),
        String(result.text4),
        String(result.text2)
      );
      blinkLed(2, 220, 120);
      break;
    }

    case NetworkResultType::RemoteConfig:
      remoteConfigQueued = false;
      if (result.requestOk) {
        applyRemoteConfigResult(result);
        nextRemoteConfigFetchMs = now + REMOTE_CONFIG_FETCH_INTERVAL_MS;
      } else if (remoteConfigHttpUnsupported) {
        nextRemoteConfigFetchMs = now + REMOTE_CONFIG_FETCH_INTERVAL_MS;
        Serial.println("[CONFIG] /device/config unavailable on backend; HTTP fetch disabled until reboot.");
      } else {
        nextRemoteConfigFetchMs = now + REMOTE_CONFIG_FETCH_RETRY_MS;
        Serial.println("[CONFIG] remote config fetch failed.");
      }
      break;
  }
}

void recoverFromDroppedNetworkResult(const NetworkResult& result) {
  const unsigned long now = millis();

  switch (result.type) {
    case NetworkResultType::Heartbeat:
      heartbeatQueued = false;
      lastHeartbeatMs = 0;
      break;

    case NetworkResultType::LockerStatus: {
      const uint8_t lockerIndex = result.lockerNumber > 0 ? result.lockerNumber - 1 : LOCKER_COUNT;
      if (lockerIndex < LOCKER_COUNT) {
        lockerStatusQueued[lockerIndex] = false;
        noteLockerReportFailure(lockerReaders[lockerIndex], now);
      }
      break;
    }

    case NetworkResultType::DeviceStateBatch:
      deviceStateBatchQueued = false;
      clearPendingStateBatch();
      for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
        noteLockerReportFailure(lockerReaders[i], now);
      }
      scheduleStateBatchRetry(now, true);
      break;

    case NetworkResultType::DeviceStateAck:
      break;

    case NetworkResultType::DeviceCommand:
      queueCommandAck(result.actionId, false, "failed", "Firmware dropped command result.");
      break;

    case NetworkResultType::CommandAck:
      break;

    case NetworkResultType::DeviceActionsPoll:
      deviceActionsPollQueued = false;
      lastDeviceActionsPollMs = 0;
      break;

    case NetworkResultType::VerifyCode:
      setStatusLed(false);
      clearPendingCode();
      break;

    case NetworkResultType::VerifyMasterTag:
      clearPendingMasterTag();
      break;

    case NetworkResultType::RemoteConfig:
      remoteConfigQueued = false;
      nextRemoteConfigFetchMs = now + REMOTE_CONFIG_FETCH_RETRY_MS;
      break;
  }
}

bool enqueueNetworkJob(const NetworkJob& job) {
  if (networkJobQueue == nullptr) {
    Serial.println("Network queue is not initialized.");
    return false;
  }

  const BaseType_t queued = isPriorityNetworkJob(job)
    ? xQueueSendToFront(networkJobQueue, &job, 0)
    : xQueueSend(networkJobQueue, &job, 0);

  if (queued == pdTRUE) {
    return true;
  }

  Serial.println("Network job queue is full.");
  return false;
}

bool isPriorityNetworkJob(const NetworkJob& job) {
  switch (job.type) {
    case NetworkJobType::LockerStatus:
    case NetworkJobType::DeviceStateBatch:
    case NetworkJobType::CommandAck:
    case NetworkJobType::VerifyCode:
    case NetworkJobType::VerifyMasterTag:
    case NetworkJobType::AccessSelectionEvent:
    case NetworkJobType::DeviceDiagnostic:
      return true;

    case NetworkJobType::Heartbeat:
    case NetworkJobType::DeviceActionsPoll:
    case NetworkJobType::TagAssignmentResult:
    case NetworkJobType::DeviceLog:
    case NetworkJobType::FetchRemoteConfig:
      return false;
  }

  return false;
}

void handleRemoteCommand(const NetworkResult& result) {
  if (strlen(result.actionId) == 0) {
    Serial.println("Remote command missing actionId.");
    return;
  }

  if (wasCommandProcessed(result.actionId)) {
    Serial.printf("Duplicate remote command ignored actionId=%s type=%s\n", result.actionId, result.actionType);
    queueCommandAck(result.actionId, true, "acknowledged", "Duplicate command already handled.");
    return;
  }

  bool success = true;
  const char* status = "applied";
  const char* message = "Command applied.";

  if (strcmp(result.actionType, "ASSIGN_RFID_TAG") == 0) {
    if (strlen(result.text1) == 0 || strlen(result.text2) == 0) {
      success = false;
      message = "Missing tag assignment payload.";
    } else {
      startTagAssignmentMode(String(result.text1), String(result.text2), String(result.text3));
      message = "Tag assignment mode started.";
    }
  } else if (strcmp(result.actionType, "CANCEL_RFID_TAG_ASSIGNMENT") == 0) {
    const bool assignmentMatches = strlen(result.text1) == 0 || String(result.text1) == tagAssignmentMode.assignmentId;
    if (tagAssignmentMode.active && assignmentMatches) {
      Serial.printf("Cancelling tag assignment mode for assignmentId=%s\n", result.text1);
      stopTagAssignmentMode();
      blinkLed(2, 90, 90);
      message = "Tag assignment mode cancelled.";
    } else {
      message = "No matching active tag assignment mode.";
    }
  } else if (strcmp(result.actionType, "OPEN_LOCKER") == 0) {
    if (!pulseUnlockLocker(result.lockerNumber, runtimeLockUnlockPulseMs)) {
      success = false;
      message = "Invalid locker number or relay pulse failed.";
    } else {
      Serial.printf("Remote open command applied for locker S%u.\n", result.lockerNumber);
      if (result.lockerNumber >= 1 && result.lockerNumber <= LOCKER_COUNT) {
        startLedSegmentFlash(result.lockerNumber, colorWhite(190), LED_REMOTE_FLASH_MS);
      }
      blinkLed(2, 120, 80);
      message = "Locker relay pulsed.";
    }
  } else if (strcmp(result.actionType, "RELEASE_ALL_LOCKERS") == 0) {
    if (!pulseUnlockLockerMask(allRelayLockersMask())) {
      success = false;
      message = "Failed to pulse locker relays.";
    } else {
      Serial.println("Remote release-all command applied.");
      startLedStripEffect(LED_STRIP_EFFECT_REMOTE_ALL, LED_REMOTE_FLASH_MS);
      blinkLed(3, 120, 80);
      message = OPEN_LOCKS_PARALLEL ? "All locker relays pulsed in parallel." : "All locker relays queued sequentially.";
    }
  } else {
    success = false;
    message = "Unsupported command type.";
    Serial.printf("Unsupported remote command type: %s\n", result.actionType);
  }

  if (success) {
    rememberProcessedCommand(result.actionId);
  }
  queueCommandAck(result.actionId, success, success ? status : "failed", message);
}

void queueCommandAck(const char* actionId, bool success, const char* status, const char* message) {
  if (actionId == nullptr || strlen(actionId) == 0) {
    return;
  }

  NetworkJob ack = {};
  ack.type = NetworkJobType::CommandAck;
  ack.boolValue = success;
  copyCStringToBuffer(actionId, ack.text1, sizeof(ack.text1));
  copyCStringToBuffer(status != nullptr ? status : (success ? "applied" : "failed"), ack.text2, sizeof(ack.text2));
  copyCStringToBuffer(message != nullptr ? message : "", ack.text3, sizeof(ack.text3));

  if (!enqueueNetworkJob(ack)) {
    Serial.printf("Failed to queue command ack for actionId=%s\n", actionId);
  }
}

bool wasCommandProcessed(const char* actionId) {
  if (actionId == nullptr || strlen(actionId) == 0) {
    return false;
  }

  for (uint8_t i = 0; i < COMMAND_DEDUP_CACHE_SIZE; i += 1) {
    if (strcmp(processedCommandIds[i], actionId) == 0) {
      return true;
    }
  }

  return false;
}

void rememberProcessedCommand(const char* actionId) {
  if (actionId == nullptr || strlen(actionId) == 0) {
    return;
  }

  copyCStringToBuffer(actionId, processedCommandIds[nextProcessedCommandSlot], sizeof(processedCommandIds[nextProcessedCommandSlot]));
  nextProcessedCommandSlot = static_cast<uint8_t>((nextProcessedCommandSlot + 1) % COMMAND_DEDUP_CACHE_SIZE);
}

uint32_t calculateJobStateFingerprint(const NetworkJob& job) {
  uint32_t hash = 2166136261UL;

  const auto mixByte = [&hash](uint8_t value) {
    hash ^= value;
    hash *= 16777619UL;
  };

  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    mixByte(i + 1);
    mixByte(job.lockerHasTag[i] ? 1 : 0);
    mixByte(job.lockerDoorClosed[i] ? 1 : 0);
    mixByte(job.lockerLockClosed[i] ? 1 : 0);

    if (job.lockerHasTag[i]) {
      const char* tag = job.lockerTags[i];
      for (size_t pos = 0; tag[pos] != '\0'; pos += 1) {
        mixByte(static_cast<uint8_t>(tag[pos]));
      }
    }

    mixByte(0xFF);
  }

  return hash == 0 ? 1 : hash;
}

void rememberAckedStateFingerprint(uint32_t fingerprint, bool full, uint32_t fullGeneration, unsigned long now) {
  if (fingerprint == 0) {
    return;
  }

  lastAckedStateFingerprint = fingerprint;
  lastAckedStateFingerprintReady = true;
  if (full) {
    lastAckedFullStateResyncGeneration = fullGeneration;
    nextFullStateResyncDueMs = now + LOCKER_STATUS_RESYNC_INTERVAL_MS;
  }
}

bool hasDirtyLockerReports() {
  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    if (lockerReaders[i].reportDirty) {
      return true;
    }
  }
  return false;
}

void clearAllLockerReportsClean(unsigned long now) {
  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    noteLockerReportSuccess(lockerReaders[i], now);
    lockerStatusQueued[i] = false;
  }
}

void requestFullStateResync(const char* reason) {
  const bool alreadyPending = fullStateResyncPending;
  if (!alreadyPending) {
    fullStateResyncGeneration += 1;
    if (fullStateResyncGeneration == 0) {
      fullStateResyncGeneration = 1;
    }
  }

  fullStateResyncPending = true;
  nextFullStateResyncDueMs = 0;
  if (DEBUG_RFID_VERBOSE && !alreadyPending) {
    Serial.printf("[state] full resync requested: %s gen=%lu\n", reason != nullptr ? reason : "unknown", static_cast<unsigned long>(fullStateResyncGeneration));
  }
}

bool isDeadlineReached(unsigned long now, unsigned long deadline) {
  return deadline != 0 && static_cast<long>(now - deadline) >= 0;
}

void rememberPendingStateBatch(const NetworkJob& job, const char* messageId, unsigned long now) {
  deviceStateAckPending = true;
  pendingStateWasFull = job.boolValue;
  pendingStateBatchSentMs = now;
  pendingStateFingerprint = job.numberValue;
  pendingFullStateResyncGeneration = job.boolValue ? fullStateResyncGeneration : 0;
  copyCStringToBuffer(messageId, pendingStateMessageId, sizeof(pendingStateMessageId));
  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    pendingStateVersions[i] = job.lockerVersions[i];
  }
}

void clearPendingStateBatch() {
  deviceStateAckPending = false;
  pendingStateWasFull = false;
  pendingStateBatchSentMs = 0;
  pendingStateFingerprint = 0;
  pendingFullStateResyncGeneration = 0;
  pendingStateMessageId[0] = '\0';
  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    pendingStateVersions[i] = 0;
  }
}

bool isPendingStateBatchTimedOut(unsigned long now) {
  return deviceStateAckPending
    && pendingStateBatchSentMs != 0
    && now - pendingStateBatchSentMs >= DEVICE_STATE_BATCH_ACK_TIMEOUT_MS;
}

void scheduleStateBatchRetry(unsigned long now, bool forceFull) {
  if (deviceStateBatchFailureCount < 255) {
    deviceStateBatchFailureCount += 1;
  }

  const uint8_t failureLevel = min<uint8_t>(deviceStateBatchFailureCount, 5);
  const unsigned long backoffMs = min(
    DEVICE_STATE_BATCH_RETRY_MAX_MS,
    DEVICE_STATE_BATCH_RETRY_BASE_MS * (1UL << (failureLevel - 1))
  );

  nextDeviceStateBatchAttemptMs = now + backoffMs;
  if (forceFull) {
    requestFullStateResync("state retry");
    markAllLockerReportsDirty(now, false);
  }

  Serial.printf(
    "[WS] state retry in %lu ms (failures=%u, full=%s)\n",
    backoffMs,
    deviceStateBatchFailureCount,
    forceFull ? "true" : "false"
  );
}

void resetStateBatchRetry() {
  nextDeviceStateBatchAttemptMs = 0;
  deviceStateBatchFailureCount = 0;
}

void handleDeviceStateAck(const NetworkResult& result) {
  const unsigned long now = millis();
  if (!deviceStateAckPending || strcmp(result.text1, pendingStateMessageId) != 0) {
    if (DEBUG_RFID_VERBOSE && staleStateAckLogSuppressed == 0) {
      Serial.printf("[WS] stale state ack ignored for %s\n", result.text1);
    }
    if (staleStateAckLogSuppressed < UINT16_MAX) {
      staleStateAckLogSuppressed += 1;
    }
    return;
  }

  const bool ackedFull = pendingStateWasFull;
  const uint32_t ackedFingerprint = pendingStateFingerprint;
  const uint32_t ackedFullGeneration = pendingFullStateResyncGeneration;

  if (!result.requestOk) {
    Serial.printf("[WS] state ack failed for %s, retry queued.\n", result.text1);
    clearPendingStateBatch();
    scheduleStateBatchRetry(now, true);
    return;
  }

  resetStateBatchRetry();
  if (DEBUG_RFID_VERBOSE && staleStateAckLogSuppressed > 0) {
    Serial.printf("[WS] ignored %u stale state ack(s)\n", staleStateAckLogSuppressed);
  }
  staleStateAckLogSuppressed = 0;

  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    if (lockerStateVersions[i] == pendingStateVersions[i]) {
      noteLockerReportSuccess(lockerReaders[i], now);
    } else {
      markLockerReportDirty(lockerReaders[i], now);
    }
    lockerStatusQueued[i] = false;
  }

  rememberAckedStateFingerprint(ackedFingerprint, ackedFull, ackedFullGeneration, now);
  forceNextStateBatchHttps = false;
  if (!ackedFull || ackedFullGeneration == fullStateResyncGeneration) {
    fullStateResyncPending = false;
  }
  Serial.printf("[WS] state ack ok for %s\n", result.text1);
  startLedStripEffect(LED_STRIP_EFFECT_SYNC_OK, LED_SYNC_OK_EFFECT_MS);
  clearPendingStateBatch();
}

void copyCStringToBuffer(const char* value, char* buffer, size_t bufferSize) {
  if (bufferSize == 0) {
    return;
  }

  if (value == nullptr) {
    buffer[0] = '\0';
    return;
  }

  snprintf(buffer, bufferSize, "%s", value);
}

void copyStringToBuffer(const String& value, char* buffer, size_t bufferSize) {
  copyCStringToBuffer(value.c_str(), buffer, bufferSize);
}

void setPendingCode(const String& code) {
  codeVerificationPending = true;
  codeVerificationTimedOut = false;
  copyStringToBuffer(code, pendingCode, sizeof(pendingCode));
  pendingCodeMessageId[0] = '\0';
  pendingCodeSentMs = 0;
  expiredCode[0] = '\0';
  expiredCodeMessageId[0] = '\0';
}

void clearPendingCode() {
  codeVerificationPending = false;
  codeVerificationTimedOut = false;
  pendingCode[0] = '\0';
  pendingCodeMessageId[0] = '\0';
  pendingCodeSentMs = 0;
}

void rememberExpiredPendingCode() {
  copyCStringToBuffer(pendingCode, expiredCode, sizeof(expiredCode));
  copyCStringToBuffer(pendingCodeMessageId, expiredCodeMessageId, sizeof(expiredCodeMessageId));
}

void setPendingMasterTag(const String& tagId) {
  masterTagVerificationPending = true;
  copyStringToBuffer(tagId, pendingMasterTagId, sizeof(pendingMasterTagId));
  pendingMasterTagVerify.active = true;
  pendingMasterTagVerify.timedOut = false;
  pendingMasterTagVerify.acked = false;
  pendingMasterTagVerify.uid = tagId;
  pendingMasterTagVerify.requestId = "";
  pendingMasterTagVerify.sentAtMs = 0;
  pendingMasterTagVerify.timeoutMs = DEVICE_VERIFY_MASTER_TAG_TIMEOUT_MS;
  pendingMasterTagVerify.graceMs = DEVICE_VERIFY_MASTER_TAG_RESULT_GRACE_MS;
  expiredMasterTagId[0] = '\0';
  expiredMasterTagMessageId[0] = '\0';
}

void clearPendingMasterTag() {
  masterTagVerificationPending = false;
  pendingMasterTagId[0] = '\0';
  pendingMasterTagMessageId[0] = '\0';
  pendingMasterTagSentMs = 0;
  pendingMasterTagVerify.active = false;
  pendingMasterTagVerify.timedOut = false;
  pendingMasterTagVerify.acked = false;
  pendingMasterTagVerify.uid = "";
  pendingMasterTagVerify.requestId = "";
  pendingMasterTagVerify.sentAtMs = 0;
  pendingMasterTagVerify.timeoutMs = DEVICE_VERIFY_MASTER_TAG_TIMEOUT_MS;
  pendingMasterTagVerify.graceMs = DEVICE_VERIFY_MASTER_TAG_RESULT_GRACE_MS;
}

void failPendingCodeVerification(const char* reason) {
  if (!codeVerificationPending) {
    return;
  }

  NetworkResult result = {};
  result.type = NetworkResultType::VerifyCode;
  result.requestOk = false;
  copyCStringToBuffer(pendingCode, result.text1, sizeof(result.text1));
  copyCStringToBuffer(pendingCodeMessageId, result.requestId, sizeof(result.requestId));
  clearPendingCode();
  setStatusLed(false);

  if (reason != nullptr && strlen(reason) > 0) {
    Serial.println(reason);
  }

  if (networkResultQueue != nullptr && xQueueSend(networkResultQueue, &result, 0) != pdTRUE) {
    recoverFromDroppedNetworkResult(result);
  }
}

void markPendingCodeVerificationTimedOut() {
  if (!codeVerificationPending) {
    return;
  }

  codeVerificationTimedOut = true;
  Serial.printf(
    "[CODE VERIFY] verification timed out code=%s requestId=%s elapsed=%lums grace=%lums\n",
    pendingCode[0] != '\0' ? pendingCode : "(none)",
    pendingCodeMessageId[0] != '\0' ? pendingCodeMessageId : "(none)",
    pendingCodeSentMs != 0 ? static_cast<unsigned long>(millis() - pendingCodeSentMs) : 0UL,
    static_cast<unsigned long>(DEVICE_VERIFY_CODE_RESULT_GRACE_MS)
  );
}

void failPendingMasterTagVerification(const char* reason) {
  if (!masterTagVerificationPending) {
    return;
  }

  NetworkResult result = {};
  result.type = NetworkResultType::VerifyMasterTag;
  result.requestOk = false;
  copyCStringToBuffer(pendingMasterTagId, result.text1, sizeof(result.text1));
  copyCStringToBuffer(pendingMasterTagMessageId, result.requestId, sizeof(result.requestId));
  clearPendingMasterTag();

  if (reason != nullptr && strlen(reason) > 0) {
    Serial.printf("[RFID VERIFY] %s uid=%s requestId=%s\n",
      reason,
      strlen(result.text1) > 0 ? result.text1 : "(unknown)",
      strlen(result.requestId) > 0 ? result.requestId : "(none)"
    );
  }

  if (networkResultQueue != nullptr && xQueueSend(networkResultQueue, &result, 0) != pdTRUE) {
    recoverFromDroppedNetworkResult(result);
  }
}

void markPendingMasterTagTimedOut(const char* reason) {
  if (!masterTagVerificationPending || pendingMasterTagVerify.timedOut) {
    return;
  }

  pendingMasterTagVerify.timedOut = true;
  Serial.printf("[RFID VERIFY] %s uid=%s requestId=%s\n",
    reason != nullptr && strlen(reason) > 0 ? reason : "verification timed out",
    pendingMasterTagId[0] != '\0' ? pendingMasterTagId : "(unknown)",
    pendingMasterTagMessageId[0] != '\0' ? pendingMasterTagMessageId : "(none)"
  );
}

bool isPendingMasterTagResultExpired(uint32_t nowMs) {
  if (!masterTagVerificationPending || pendingMasterTagSentMs == 0) {
    return false;
  }

  const uint32_t sentAtMs = static_cast<uint32_t>(pendingMasterTagSentMs);
  if (static_cast<int32_t>(nowMs - sentAtMs) < 0) {
    return false;
  }

  const uint32_t windowMs = static_cast<uint32_t>(DEVICE_VERIFY_MASTER_TAG_TIMEOUT_MS + DEVICE_VERIFY_MASTER_TAG_RESULT_GRACE_MS);
  return nowMs - sentAtMs >= windowMs;
}

bool isPendingMasterTagResultWindowOpen(uint32_t nowMs) {
  return masterTagVerificationPending
    && pendingMasterTagSentMs != 0
    && !isPendingMasterTagResultExpired(nowMs);
}

void servicePendingMasterTagVerification(uint32_t nowMs) {
  if (!masterTagVerificationPending || pendingMasterTagSentMs == 0) {
    return;
  }

  const uint32_t sentAtMs = static_cast<uint32_t>(pendingMasterTagSentMs);
  if (static_cast<int32_t>(nowMs - sentAtMs) < 0) {
    return;
  }

  const uint32_t elapsedMs = nowMs - sentAtMs;
  if (!pendingMasterTagVerify.timedOut && elapsedMs >= DEVICE_VERIFY_MASTER_TAG_TIMEOUT_MS) {
    markPendingMasterTagTimedOut("verification timed out");
  }

  if (isPendingMasterTagResultExpired(nowMs)) {
    copyCStringToBuffer(pendingMasterTagId, expiredMasterTagId, sizeof(expiredMasterTagId));
    copyCStringToBuffer(pendingMasterTagMessageId, expiredMasterTagMessageId, sizeof(expiredMasterTagMessageId));
    Serial.printf("[RFID VERIFY] result window expired uid=%s requestId=%s\n",
      pendingMasterTagId[0] != '\0' ? pendingMasterTagId : "(unknown)",
      pendingMasterTagMessageId[0] != '\0' ? pendingMasterTagMessageId : "(none)"
    );
    clearPendingMasterTag();
    startLedErrorFlash(700);
  }
}

bool postLockerStatus(uint8_t lockerNumber, bool hasTag, const String& tagId) {
  WiFiClientSecure secureClient;
  HTTPClient http;
  char url[128];
  snprintf(url, sizeof(url), "%s/locker-status", API_BASE_URL);

  if (!beginSecureRequest(http, secureClient, url, "/locker-status")) {
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  if (strlen(DEVICE_API_KEY) > 0) {
    http.addHeader("x-device-key", DEVICE_API_KEY);
  }

  JsonDocument payload;
  payload["locker"] = lockerNumber;
  payload["hasTag"] = hasTag;
  if (hasTag && tagId.length() > 0) {
    payload["tagId"] = tagId;
  }

  char body[160];
  const size_t bodyLen = serializeJson(payload, body, sizeof(body));

  const int httpCode = http.POST(reinterpret_cast<uint8_t*>(body), bodyLen);
  const String responseBody = http.getString();
  http.end();

  Serial.printf("Locker report S%u -> hasTag=%s, uid=%s, HTTP=%d\n",
    lockerNumber,
    hasTag ? "true" : "false",
    hasTag && tagId.length() > 0 ? tagId.c_str() : "(none)",
    httpCode
  );
  if (httpCode < 200 || httpCode >= 300) {
    logHttpFailure("/locker-status", httpCode, secureClient, responseBody);
  }

  if (responseBody.length() > 0 && DEBUG_RFID_VERBOSE) {
    Serial.printf("Locker report response: %s\n", responseBody.c_str());
  }

  return httpCode >= 200 && httpCode < 300;
}

bool postVerifyMasterTag(const char* tagId, NetworkResult& result) {
  WiFiClientSecure secureClient;
  HTTPClient http;
  char url[128];
  snprintf(url, sizeof(url), "%s/verify-tag", API_BASE_URL);

  if (!beginSecureRequest(http, secureClient, url, "/verify-tag")) {
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  if (strlen(DEVICE_API_KEY) > 0) {
    http.addHeader("x-device-key", DEVICE_API_KEY);
  }

  JsonDocument payload;
  payload["tagId"] = tagId != nullptr ? tagId : "";

  char body[128];
  const size_t bodyLen = serializeJson(payload, body, sizeof(body));
  const int httpCode = http.POST(reinterpret_cast<uint8_t*>(body), bodyLen);
  const String responseBody = http.getString();
  http.end();

  Serial.printf("[RFID VERIFY] HTTP fallback uid=%s HTTP=%d\n", tagId != nullptr ? tagId : "(none)", httpCode);
  if (httpCode < 200 || httpCode >= 300) {
    logHttpFailure("/verify-tag", httpCode, secureClient, responseBody);
    return false;
  }

  JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, responseBody);
  if (error) {
    Serial.printf("[RFID VERIFY] HTTP fallback JSON parse failed: %s\n", error.c_str());
    return false;
  }

  const bool valid = doc["valid"] | false;
  const bool isMaster = doc["isMaster"] | false;
  uint8_t accessibleMask = static_cast<uint8_t>((doc["accessibleLockersMask"] | 0) & 0xFF);

  result.requestOk = true;
  result.boolValue1 = valid;
  result.boolValue2 = valid;
  result.boolValue3 = isMaster;
  result.numberValue = accessibleMask;
  copyCStringToBuffer(tagId != nullptr ? tagId : "", result.text1, sizeof(result.text1));
  copyCStringToBuffer(pendingMasterTagMessageId, result.requestId, sizeof(result.requestId));

  const JsonObject item = doc["item"];
  if (!item.isNull()) {
    copyCStringToBuffer(item["itemName"] | "", result.text3, sizeof(result.text3));
    if (strlen(result.text1) == 0) {
      copyCStringToBuffer(item["tagId"] | "", result.text1, sizeof(result.text1));
    }
  }

  const JsonObject user = doc["user"];
  if (!user.isNull()) {
    copyCStringToBuffer(user["name"] | "", result.text2, sizeof(result.text2));
    copyCStringToBuffer(user["id"] | "", result.text4, sizeof(result.text4));
  }

  const JsonArray allowedLockers = doc["allowedLockers"];
  if (!allowedLockers.isNull()) {
    for (JsonVariant value : allowedLockers) {
      if (result.count >= LOCKER_COUNT) {
        break;
      }
      const uint8_t lockerNumber = static_cast<uint8_t>(value.as<int>());
      result.lockers[result.count] = lockerNumber;
      result.count += 1;
      accessibleMask |= lockerNumberToMask(lockerNumber);
    }
    result.numberValue = accessibleMask;
  }

  char maskText[8];
  formatLockerMaskBinary(static_cast<uint8_t>(result.numberValue & 0xFF), maskText, sizeof(maskText));
  Serial.printf(
    "[RFID VERIFY RESULT] uid=%s source=http known=%s master=%s mask=%s\n",
    result.text1,
    result.boolValue1 ? "true" : "false",
    result.boolValue3 ? "true" : "false",
    maskText
  );

  return true;
}

void buildHeartbeatPayload(JsonObject payload) {
  uint8_t lockerTagsPresent = 0;
  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    if (lockerReaders[i].hasCard) {
      lockerTagsPresent += 1;
    }
  }

  payload["deviceId"] = DEVICE_ID;
  payload["bootId"] = deviceBootId;
  payload["protocolVersion"] = DEVICE_PROTOCOL_VERSION;
  payload["firmware"] = FIRMWARE_VERSION;
  payload["ip"] = WiFi.localIP().toString();
  payload["servicePanelIp"] = WiFi.localIP().toString();
  payload["servicePanelActive"] = servicePanelStarted && runtimeServicePanelEnabled;
  payload["configVersion"] = remoteConfigVersion;
  payload["wifiRssi"] = WiFi.RSSI();
  payload["uptimeMs"] = millis();
  payload["freeHeap"] = ESP.getFreeHeap();
  payload["minFreeHeap"] = ESP.getMinFreeHeap();
  payload["lockersWithTags"] = lockerTagsPresent;
  payload["masterReaderPresent"] = masterReaderRuntime.hasCard;
  payload["deviceActionsPollIntervalMs"] = deviceActionsPollIntervalMs;
  payload["heartbeatIntervalMs"] = runtimeHeartbeatIntervalMs;
  payload["lockPulseMs"] = runtimeLockUnlockPulseMs;
  payload["networkFailureCount"] = consecutiveNetworkFailureCount;
  payload["wsConnected"] = deviceWsConnected;

  JsonArray capabilities = payload["capabilities"].to<JsonArray>();
  capabilities.add("service-panel");
  capabilities.add("wifi-setup");
  capabilities.add("local-ota");
  capabilities.add("diagnostics");
  capabilities.add("remote-logs");
  capabilities.add("remote-config");
  capabilities.add("code-rate-limit");

  JsonArray lockers = payload["lockers"].to<JsonArray>();
  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    JsonObject locker = lockers.add<JsonObject>();
    locker["locker"] = lockerReaders[i].lockerNumber;
    locker["hasTag"] = lockerReaders[i].hasCard;
    locker["tagId"] = lockerReaders[i].stableUid;
    locker["dirty"] = lockerReaders[i].reportDirty;
    locker["reportFailures"] = lockerReaders[i].reportFailureCount;
    locker["version"] = lockerStateVersions[i];
  }

  if (lastHeartbeatPingMs >= 0) {
    payload["pingMs"] = lastHeartbeatPingMs;
  }
}

void applyRemoteConfigResult(const NetworkResult& result) {
  if (!result.requestOk || result.configVersion == 0) {
    return;
  }

  remoteConfigVersion = result.configVersion;
  runtimeHeartbeatIntervalMs = constrain(result.heartbeatIntervalMs, 10000UL, 600000UL);
  runtimeDeviceActionsPollBaseMs = constrain(result.deviceActionsPollIntervalMs, 2000UL, 120000UL);
  runtimeLockUnlockPulseMs = constrain(result.lockPulseMs, 100UL, 5000UL);
  runtimeCodeRateLimitWindowMs = constrain(result.codeRateLimitWindowMs, 30000UL, 3600000UL);
  runtimeCodeRateLimitLockoutMs = constrain(result.codeRateLimitLockoutMs, 5000UL, 3600000UL);
  runtimeCodeRateLimitMaxFailures = constrain(result.codeRateLimitMaxFailures, static_cast<uint8_t>(1), static_cast<uint8_t>(20));
  runtimeRemoteLoggingEnabled = result.boolValue1;
  runtimeCodeRateLimitEnabled = result.boolValue2;
  runtimeServicePanelEnabled = result.boolValue3;
  runtimeOtaEnabled = result.boolValue4;
  runtimeDiagnosticsEnabled = result.boolValue5;
  const unsigned long cappedPollMs = deviceActionsPollIntervalMs > DEVICE_ACTIONS_POLL_INTERVAL_MAX_MS
    ? DEVICE_ACTIONS_POLL_INTERVAL_MAX_MS
    : deviceActionsPollIntervalMs;
  deviceActionsPollIntervalMs = cappedPollMs < runtimeDeviceActionsPollBaseMs
    ? runtimeDeviceActionsPollBaseMs
    : cappedPollMs;

  devicePreferences.putUInt("cfgVersion", remoteConfigVersion);
  devicePreferences.putUInt("hbMs", runtimeHeartbeatIntervalMs);
  devicePreferences.putUInt("pollMs", runtimeDeviceActionsPollBaseMs);
  devicePreferences.putUInt("pulseMs", runtimeLockUnlockPulseMs);
  devicePreferences.putBool("logEnabled", runtimeRemoteLoggingEnabled);
  devicePreferences.putBool("rlEnabled", runtimeCodeRateLimitEnabled);
  devicePreferences.putUChar("rlMax", runtimeCodeRateLimitMaxFailures);
  devicePreferences.putUInt("rlWindow", runtimeCodeRateLimitWindowMs);
  devicePreferences.putUInt("rlLockout", runtimeCodeRateLimitLockoutMs);
  devicePreferences.putBool("panelEnabled", runtimeServicePanelEnabled);
  devicePreferences.putBool("otaEnabled", runtimeOtaEnabled);
  devicePreferences.putBool("diagEnabled", runtimeDiagnosticsEnabled);

  Serial.printf(
    "[CONFIG] applied version=%lu heartbeat=%lums poll=%lums pulse=%lums rateLimit=%s/%u\n",
    static_cast<unsigned long>(remoteConfigVersion),
    static_cast<unsigned long>(runtimeHeartbeatIntervalMs),
    static_cast<unsigned long>(runtimeDeviceActionsPollBaseMs),
    static_cast<unsigned long>(runtimeLockUnlockPulseMs),
    runtimeCodeRateLimitEnabled ? "on" : "off",
    runtimeCodeRateLimitMaxFailures
  );
}

void maybeFetchRemoteConfig(unsigned long now) {
  if (remoteConfigQueued) {
    return;
  }

  if (remoteConfigHttpUnsupported) {
    return;
  }

  if (!isWifiReady() || isBackgroundNetworkBackoffActive(now)) {
    return;
  }

  if (nextRemoteConfigFetchMs != 0 && now < nextRemoteConfigFetchMs) {
    return;
  }

  NetworkJob job = {};
  job.type = NetworkJobType::FetchRemoteConfig;
  if (enqueueNetworkJob(job)) {
    remoteConfigQueued = true;
    nextRemoteConfigFetchMs = now + REMOTE_CONFIG_FETCH_RETRY_MS;
  }
}

void queueDeviceLog(const char* level, const char* event, const char* message) {
  if (!runtimeRemoteLoggingEnabled || networkJobQueue == nullptr) {
    return;
  }

  NetworkJob job = {};
  job.type = NetworkJobType::DeviceLog;
  copyCStringToBuffer(level != nullptr ? level : "info", job.text1, sizeof(job.text1));
  copyCStringToBuffer(event != nullptr ? event : "DEVICE_LOG", job.text2, sizeof(job.text2));
  copyCStringToBuffer(message != nullptr ? message : "", job.text4, sizeof(job.text4));
  enqueueNetworkJob(job);
}

void queueDeviceDiagnostic(const char* name, bool ok, const char* message) {
  if (networkJobQueue == nullptr) {
    return;
  }

  NetworkJob job = {};
  job.type = NetworkJobType::DeviceDiagnostic;
  job.boolValue = ok;
  copyCStringToBuffer(name != nullptr ? name : "diagnostic", job.text1, sizeof(job.text1));
  copyCStringToBuffer(message != nullptr ? message : "", job.text4, sizeof(job.text4));
  enqueueNetworkJob(job);
}

bool sendDeviceHello() {
  if (!isDeviceWebSocketOpen()) {
    return false;
  }

  const uint32_t sequence = nextDeviceSequence();
  char messageId[64];
  buildMessageId(messageId, sizeof(messageId), "hello", sequence);

  JsonDocument doc;
  doc["type"] = "device.hello";
  doc["deviceId"] = DEVICE_ID;
  doc["messageId"] = messageId;
  doc["seq"] = sequence;

  char body[256];
  const size_t bodyLen = serializeJson(doc, body, sizeof(body));
  if (bodyLen == 0 || bodyLen >= sizeof(body)) {
    Serial.println("[WS] hello payload too large.");
    return false;
  }

  const bool sent = sendDeviceWebSocketText(body, bodyLen);
  if (sent) {
    deviceWsHelloSent = true;
  }
  Serial.printf("[WS] hello %s seq=%lu\n", sent ? "sent" : "failed", static_cast<unsigned long>(sequence));
  return sent;
}

bool sendDeviceHeartbeatWs() {
  if (!isDeviceWebSocketReady()) {
    return false;
  }

  const uint32_t sequence = nextDeviceSequence();
  char messageId[64];
  buildMessageId(messageId, sizeof(messageId), "heartbeat", sequence);

  JsonDocument doc;
  doc["type"] = "heartbeat";
  doc["deviceId"] = DEVICE_ID;
  doc["messageId"] = messageId;
  doc["seq"] = sequence;
  JsonObject payload = doc["payload"].to<JsonObject>();
  buildHeartbeatPayload(payload);

  char body[1024];
  const size_t bodyLen = serializeJson(doc, body, sizeof(body));
  if (bodyLen == 0 || bodyLen >= sizeof(body)) {
    Serial.println("[WS] heartbeat payload too large.");
    return false;
  }

  const unsigned long startedAt = millis();
  const bool sent = sendDeviceWebSocketText(body, bodyLen);
  if (sent) {
    lastHeartbeatPingMs = static_cast<long>(millis() - startedAt);
    lastDeviceWsHeartbeatMs = millis();
    Serial.println("[WS] heartbeat sent");
  }
  return sent;
}

void buildStateBatchMessage(const NetworkJob& job, JsonDocument& doc, uint32_t sequence, const char* messageId) {
  doc["type"] = "state.batch";
  doc["deviceId"] = DEVICE_ID;
  doc["messageId"] = messageId;
  doc["seq"] = sequence;
  doc["bootId"] = deviceBootId;

  JsonObject payload = doc["payload"].to<JsonObject>();
  payload["full"] = job.boolValue;
  payload["bootId"] = deviceBootId;
  payload["reason"] = job.boolValue ? "resync" : "dirty-batch";

  JsonArray lockers = payload["lockers"].to<JsonArray>();
  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    JsonObject locker = lockers.add<JsonObject>();
    locker["locker"] = i + 1;
    locker["hasTag"] = job.lockerHasTag[i];
    locker["tagId"] = job.lockerHasTag[i] ? job.lockerTags[i] : "";
    locker["doorClosed"] = job.lockerDoorClosed[i];
    locker["lockClosed"] = job.lockerLockClosed[i];
    locker["version"] = job.lockerVersions[i];
  }
}

bool sendDeviceStateBatchWs(const NetworkJob& job) {
  if (!isDeviceWebSocketReady()) {
    return false;
  }

  if (deviceStateAckPending && !isPendingStateBatchTimedOut(millis())) {
    return false;
  }

  const uint32_t sequence = nextDeviceSequence();
  char messageId[64];
  buildMessageId(messageId, sizeof(messageId), "state", sequence);

  JsonDocument doc;
  buildStateBatchMessage(job, doc, sequence, messageId);

  char body[1280];
  const size_t bodyLen = serializeJson(doc, body, sizeof(body));
  if (bodyLen == 0 || bodyLen >= sizeof(body)) {
    Serial.println("[WS] state batch payload too large.");
    return false;
  }

  const bool sent = sendDeviceWebSocketText(body, bodyLen);
  Serial.printf("[WS] state batch %s full=%s bytes=%u\n", sent ? "sent" : "failed", job.boolValue ? "true" : "false", static_cast<unsigned int>(bodyLen));
  if (sent) {
    panelStatusResultPending = true;
    panelStatusResultPendingStartedMs = millis();
  } else {
    forceNextStateBatchHttps = true;
  }
  if (sent && DEVICE_STATE_WS_ACK_REQUIRED) {
    rememberPendingStateBatch(job, messageId, millis());
  }
  return sent;
}

bool sendDeviceCommandAckWs(const NetworkJob& job) {
  if (!isDeviceWebSocketReady()) {
    return false;
  }

  const uint32_t sequence = nextDeviceSequence();
  char messageId[64];
  buildMessageId(messageId, sizeof(messageId), "cmdack", sequence);

  JsonDocument doc;
  doc["type"] = "command.ack";
  doc["deviceId"] = DEVICE_ID;
  doc["messageId"] = messageId;
  doc["seq"] = sequence;
  JsonObject payload = doc["payload"].to<JsonObject>();
  payload["commandId"] = job.text1;
  payload["status"] = job.text2;
  payload["success"] = job.boolValue;
  payload["message"] = job.text3;

  char body[512];
  const size_t bodyLen = serializeJson(doc, body, sizeof(body));
  if (bodyLen == 0 || bodyLen >= sizeof(body)) {
    Serial.println("[WS] command ack payload too large.");
    return false;
  }

  const bool sent = sendDeviceWebSocketText(body, bodyLen);
  Serial.printf("[WS] command ack %s actionId=%s\n", sent ? "sent" : "failed", job.text1);
  return sent;
}

bool sendTagAssignmentResultWs(const NetworkJob& job) {
  if (!isDeviceWebSocketReady()) {
    return false;
  }

  const uint32_t sequence = nextDeviceSequence();
  char messageId[64];
  buildMessageId(messageId, sizeof(messageId), "tagassign", sequence);

  JsonDocument doc;
  doc["type"] = "tag.assignment.result";
  doc["deviceId"] = DEVICE_ID;
  doc["messageId"] = messageId;
  doc["seq"] = sequence;
  JsonObject payload = doc["payload"].to<JsonObject>();
  payload["assignmentId"] = job.text1;
  payload["success"] = job.boolValue;
  payload["tagId"] = job.text2;
  payload["physicalUid"] = job.text3;
  if (!job.boolValue && strlen(job.text4) > 0) {
    payload["error"] = job.text4;
  }

  char body[512];
  const size_t bodyLen = serializeJson(doc, body, sizeof(body));
  if (bodyLen == 0 || bodyLen >= sizeof(body)) {
    Serial.println("[WS] tag assignment result payload too large.");
    return false;
  }

  const bool sent = sendDeviceWebSocketText(body, bodyLen);
  Serial.printf("[WS] tag assignment result %s assignmentId=%s\n", sent ? "sent" : "failed", job.text1);
  return sent;
}

bool sendVerifyCodeWs(const NetworkJob& job) {
  if (!isDeviceWebSocketReady()) {
    return false;
  }

  const uint32_t sequence = nextDeviceSequence();
  char messageId[64];
  buildMessageId(messageId, sizeof(messageId), "verify", sequence);

  JsonDocument doc;
  doc["type"] = "code.verify";
  doc["deviceId"] = DEVICE_ID;
  doc["messageId"] = messageId;
  doc["seq"] = sequence;
  JsonObject payload = doc["payload"].to<JsonObject>();
  payload["code"] = job.text1;

  char body[256];
  const size_t bodyLen = serializeJson(doc, body, sizeof(body));
  if (bodyLen == 0 || bodyLen >= sizeof(body)) {
    Serial.println("[WS] verify code payload too large.");
    return false;
  }

  const bool sent = sendDeviceWebSocketText(body, bodyLen);
  if (sent) {
    copyCStringToBuffer(messageId, pendingCodeMessageId, sizeof(pendingCodeMessageId));
    pendingCodeSentMs = millis();
  }
  Serial.printf("[WS] verify code %s code=%s requestId=%s\n",
    sent ? "sent" : "failed",
    job.text1,
    messageId
  );
  return sent;
}

bool sendVerifyMasterTagWs(const NetworkJob& job) {
  if (!isDeviceWebSocketReady()) {
    return false;
  }

  const uint32_t sequence = nextDeviceSequence();
  char messageId[64];
  buildMessageId(messageId, sizeof(messageId), "tagverify", sequence);

  JsonDocument doc;
  doc["type"] = "tag.verify";
  doc["deviceId"] = DEVICE_ID;
  doc["messageId"] = messageId;
  doc["seq"] = sequence;
  JsonObject payload = doc["payload"].to<JsonObject>();
  payload["tagId"] = job.text1;

  char body[256];
  const size_t bodyLen = serializeJson(doc, body, sizeof(body));
  if (bodyLen == 0 || bodyLen >= sizeof(body)) {
    Serial.println("[WS] verify master tag payload too large.");
    return false;
  }

  const bool sent = sendDeviceWebSocketText(body, bodyLen);
  if (sent) {
    copyCStringToBuffer(messageId, pendingMasterTagMessageId, sizeof(pendingMasterTagMessageId));
    pendingMasterTagSentMs = millis();
    pendingMasterTagVerify.requestId = messageId;
    pendingMasterTagVerify.sentAtMs = pendingMasterTagSentMs;
    pendingMasterTagVerify.timedOut = false;
    pendingMasterTagVerify.acked = false;
  }
  Serial.printf("[RFID VERIFY] sent uid=%s requestId=%s ok=%s\n", job.text1, messageId, sent ? "true" : "false");
  return sent;
}

bool sendAccessSelectionEventWs(const NetworkJob& job) {
  if (!isDeviceWebSocketReady()) {
    return false;
  }

  const uint32_t sequence = nextDeviceSequence();
  char messageId[64];
  buildMessageId(messageId, sizeof(messageId), "accesssel", sequence);

  JsonDocument doc;
  doc["type"] = "access.selection";
  doc["deviceId"] = DEVICE_ID;
  doc["messageId"] = messageId;
  doc["seq"] = sequence;

  JsonObject payload = doc["payload"].to<JsonObject>();
  payload["event"] = job.text3;
  payload["tagId"] = job.text1;
  payload["isMaster"] = job.boolValue;
  payload["accessibleLockersMask"] = static_cast<uint8_t>(job.numberValue & 0xFF);
  if (strlen(job.text2) > 0) {
    payload["userId"] = job.text2;
  }
  if (strlen(job.text4) > 0) {
    payload["userName"] = job.text4;
  }
  if (strlen(job.text5) > 0) {
    payload["requestId"] = job.text5;
  }
  if (job.lockerNumber > 0) {
    payload["locker"] = job.lockerNumber;
  }

  char body[512];
  const size_t bodyLen = serializeJson(doc, body, sizeof(body));
  if (bodyLen == 0 || bodyLen >= sizeof(body)) {
    Serial.println("[WS] access selection payload too large.");
    return false;
  }

  const bool sent = sendDeviceWebSocketText(body, bodyLen);
  Serial.printf("[WS] access selection %s event=%s uid=%s\n", sent ? "sent" : "failed", job.text3, job.text1);
  return sent;
}

bool sendDeviceLogWs(const NetworkJob& job) {
  if (!isDeviceWebSocketReady()) {
    return false;
  }

  const uint32_t sequence = nextDeviceSequence();
  char messageId[64];
  buildMessageId(messageId, sizeof(messageId), "devlog", sequence);

  JsonDocument doc;
  doc["type"] = "device.log";
  doc["deviceId"] = DEVICE_ID;
  doc["messageId"] = messageId;
  doc["seq"] = sequence;
  JsonObject payload = doc["payload"].to<JsonObject>();
  payload["level"] = job.text1;
  payload["event"] = job.text2;
  payload["message"] = job.text4;
  payload["firmware"] = FIRMWARE_VERSION;
  payload["protocolVersion"] = DEVICE_PROTOCOL_VERSION;
  payload["uptimeMs"] = millis();
  payload["freeHeap"] = ESP.getFreeHeap();

  char body[512];
  const size_t bodyLen = serializeJson(doc, body, sizeof(body));
  if (bodyLen == 0 || bodyLen >= sizeof(body)) {
    return false;
  }

  return sendDeviceWebSocketText(body, bodyLen);
}

bool sendDeviceDiagnosticWs(const NetworkJob& job) {
  if (!isDeviceWebSocketReady()) {
    return false;
  }

  const uint32_t sequence = nextDeviceSequence();
  char messageId[64];
  buildMessageId(messageId, sizeof(messageId), "diag", sequence);

  JsonDocument doc;
  doc["type"] = "diagnostic.result";
  doc["deviceId"] = DEVICE_ID;
  doc["messageId"] = messageId;
  doc["seq"] = sequence;
  JsonObject payload = doc["payload"].to<JsonObject>();
  payload["name"] = job.text1;
  payload["ok"] = job.boolValue;
  payload["message"] = job.text4;
  payload["firmware"] = FIRMWARE_VERSION;
  payload["protocolVersion"] = DEVICE_PROTOCOL_VERSION;
  payload["uptimeMs"] = millis();
  JsonObject details = payload["details"].to<JsonObject>();
  details["freeHeap"] = ESP.getFreeHeap();
  details["wifiRssi"] = isWifiReady() ? WiFi.RSSI() : 0;
  details["wsConnected"] = deviceWsConnected;

  char body[640];
  const size_t bodyLen = serializeJson(doc, body, sizeof(body));
  if (bodyLen == 0 || bodyLen >= sizeof(body)) {
    return false;
  }

  return sendDeviceWebSocketText(body, bodyLen);
}

bool postDeviceLog(const NetworkJob& job) {
  if (remoteLogHttpUnsupported) {
    return false;
  }

  WiFiClientSecure secureClient;
  HTTPClient http;
  char url[128];
  snprintf(url, sizeof(url), "%s/device/logs", API_BASE_URL);

  if (!beginSecureRequest(http, secureClient, url, "/device/logs")) {
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  if (strlen(DEVICE_API_KEY) > 0) {
    http.addHeader("x-device-key", DEVICE_API_KEY);
  }

  JsonDocument payload;
  payload["deviceId"] = DEVICE_ID;
  payload["level"] = job.text1;
  payload["event"] = job.text2;
  payload["message"] = job.text4;
  payload["firmware"] = FIRMWARE_VERSION;
  payload["protocolVersion"] = DEVICE_PROTOCOL_VERSION;
  payload["uptimeMs"] = millis();
  payload["freeHeap"] = ESP.getFreeHeap();

  char body[512];
  const size_t bodyLen = serializeJson(payload, body, sizeof(body));
  const int httpCode = http.POST(reinterpret_cast<uint8_t*>(body), bodyLen);
  const String responseBody = http.getString();
  http.end();

  if (httpCode < 200 || httpCode >= 300) {
    logHttpFailure("/device/logs", httpCode, secureClient, responseBody);
    if (httpCode == 404 || httpCode == 405) {
      remoteLogHttpUnsupported = true;
      Serial.println("[LOGS] /device/logs unavailable on backend; HTTP log fallback disabled until reboot.");
    }
  }

  return httpCode >= 200 && httpCode < 300;
}

bool postDeviceDiagnostic(const NetworkJob& job) {
  if (remoteDiagnosticHttpUnsupported) {
    return false;
  }

  WiFiClientSecure secureClient;
  HTTPClient http;
  char url[128];
  snprintf(url, sizeof(url), "%s/device/diagnostics", API_BASE_URL);

  if (!beginSecureRequest(http, secureClient, url, "/device/diagnostics")) {
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  if (strlen(DEVICE_API_KEY) > 0) {
    http.addHeader("x-device-key", DEVICE_API_KEY);
  }

  JsonDocument payload;
  payload["deviceId"] = DEVICE_ID;
  payload["name"] = job.text1;
  payload["ok"] = job.boolValue;
  payload["message"] = job.text4;
  payload["firmware"] = FIRMWARE_VERSION;
  payload["protocolVersion"] = DEVICE_PROTOCOL_VERSION;
  payload["uptimeMs"] = millis();
  JsonObject details = payload["details"].to<JsonObject>();
  details["freeHeap"] = ESP.getFreeHeap();
  details["wifiRssi"] = isWifiReady() ? WiFi.RSSI() : 0;
  details["wsConnected"] = deviceWsConnected;

  char body[640];
  const size_t bodyLen = serializeJson(payload, body, sizeof(body));
  const int httpCode = http.POST(reinterpret_cast<uint8_t*>(body), bodyLen);
  const String responseBody = http.getString();
  http.end();

  if (httpCode < 200 || httpCode >= 300) {
    logHttpFailure("/device/diagnostics", httpCode, secureClient, responseBody);
    if (httpCode == 404 || httpCode == 405) {
      remoteDiagnosticHttpUnsupported = true;
      Serial.println("[DIAG] /device/diagnostics unavailable on backend; HTTP diagnostic fallback disabled until reboot.");
    }
  }

  return httpCode >= 200 && httpCode < 300;
}

bool fetchRemoteConfigForTask(NetworkResult& result) {
  if (remoteConfigHttpUnsupported) {
    return false;
  }

  WiFiClientSecure secureClient;
  HTTPClient http;
  char url[192];
  snprintf(url, sizeof(url), "%s/device/config?deviceId=%s", API_BASE_URL, DEVICE_ID);

  if (!beginSecureRequest(http, secureClient, url, "/device/config")) {
    return false;
  }

  if (strlen(DEVICE_API_KEY) > 0) {
    http.addHeader("x-device-key", DEVICE_API_KEY);
  }

  const int httpCode = http.GET();
  const String responseBody = http.getString();
  http.end();

  if (httpCode < 200 || httpCode >= 300) {
    logHttpFailure("/device/config", httpCode, secureClient, responseBody);
    if (httpCode == 404 || httpCode == 405) {
      remoteConfigHttpUnsupported = true;
    }
    return false;
  }

  JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, responseBody);
  if (error) {
    Serial.printf("[CONFIG] JSON parse failed: %s\n", error.c_str());
    return false;
  }

  JsonObject config = doc["config"].as<JsonObject>();
  if (config.isNull()) {
    return false;
  }

  result.configVersion = static_cast<uint32_t>(doc["configVersion"] | 1);
  result.heartbeatIntervalMs = static_cast<uint32_t>(config["heartbeatIntervalMs"] | HEARTBEAT_INTERVAL_MS);
  result.deviceActionsPollIntervalMs = static_cast<uint32_t>(config["deviceActionsPollIntervalMs"] | DEVICE_ACTIONS_POLL_INTERVAL_MS);
  result.lockPulseMs = static_cast<uint32_t>(config["lockPulseMs"] | LOCK_UNLOCK_PULSE_MS);
  JsonObject remoteLogging = config["remoteLogging"].as<JsonObject>();
  result.boolValue1 = remoteLogging.isNull() ? true : (remoteLogging["enabled"] | true);
  JsonObject codeRateLimit = config["codeRateLimit"].as<JsonObject>();
  result.boolValue2 = codeRateLimit.isNull() ? true : (codeRateLimit["enabled"] | true);
  result.codeRateLimitMaxFailures = static_cast<uint8_t>(codeRateLimit.isNull() ? CODE_RATE_LIMIT_MAX_FAILURES_DEFAULT : (codeRateLimit["maxFailures"] | CODE_RATE_LIMIT_MAX_FAILURES_DEFAULT));
  result.codeRateLimitWindowMs = static_cast<uint32_t>(codeRateLimit.isNull() ? CODE_RATE_LIMIT_WINDOW_MS_DEFAULT : (codeRateLimit["windowMs"] | CODE_RATE_LIMIT_WINDOW_MS_DEFAULT));
  result.codeRateLimitLockoutMs = static_cast<uint32_t>(codeRateLimit.isNull() ? CODE_RATE_LIMIT_LOCKOUT_MS_DEFAULT : (codeRateLimit["lockoutMs"] | CODE_RATE_LIMIT_LOCKOUT_MS_DEFAULT));
  JsonObject servicePanel = config["servicePanel"].as<JsonObject>();
  JsonObject ota = config["ota"].as<JsonObject>();
  JsonObject diagnostics = config["diagnostics"].as<JsonObject>();
  result.boolValue3 = servicePanel.isNull() ? true : (servicePanel["enabled"] | true);
  result.boolValue4 = ota.isNull() ? true : (ota["enabled"] | true);
  result.boolValue5 = diagnostics.isNull() ? true : (diagnostics["enabled"] | true);
  return true;
}

bool postAccessSelectionEvent(const NetworkJob& job) {
  JsonDocument doc;
  doc["type"] = "access.selection";
  doc["deviceId"] = DEVICE_ID;
  doc["seq"] = nextDeviceSequence();
  JsonObject payload = doc["payload"].to<JsonObject>();
  payload["event"] = job.text3;
  payload["tagId"] = job.text1;
  payload["isMaster"] = job.boolValue;
  payload["accessibleLockersMask"] = static_cast<uint8_t>(job.numberValue & 0xFF);
  if (strlen(job.text2) > 0) {
    payload["userId"] = job.text2;
  }
  if (strlen(job.text4) > 0) {
    payload["userName"] = job.text4;
  }
  if (strlen(job.text5) > 0) {
    payload["requestId"] = job.text5;
  }
  if (job.lockerNumber > 0) {
    payload["locker"] = job.lockerNumber;
  }

  char messageBody[512];
  const size_t messageLen = serializeJson(doc, messageBody, sizeof(messageBody));
  if (messageLen == 0 || messageLen >= sizeof(messageBody)) {
    Serial.println("Access selection HTTPS payload too large.");
    return false;
  }

  return postDeviceSyncMessage(messageBody, "/device/sync access.selection");
}

bool postDeviceStateBatch(const NetworkJob& job) {
  const uint32_t sequence = nextDeviceSequence();
  char messageId[64];
  buildMessageId(messageId, sizeof(messageId), "state", sequence);

  JsonDocument doc;
  buildStateBatchMessage(job, doc, sequence, messageId);

  char messageBody[1280];
  const size_t messageLen = serializeJson(doc, messageBody, sizeof(messageBody));
  if (messageLen == 0 || messageLen >= sizeof(messageBody)) {
    Serial.println("HTTPS state batch payload too large.");
    return false;
  }

  return postDeviceSyncMessage(messageBody, "/device/sync state.batch");
}

bool postLegacyLockerStatusBatch(const NetworkJob& job) {
  bool allOk = true;
  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    const String tagId = job.lockerHasTag[i] ? String(job.lockerTags[i]) : String("");
    const bool ok = postLockerStatus(i + 1, job.lockerHasTag[i], tagId);
    allOk = allOk && ok;
  }

  if (allOk) {
    Serial.println("Device state delivered via legacy /locker-status fallback.");
  } else {
    Serial.println("Legacy /locker-status fallback failed for at least one locker.");
  }

  return allOk;
}

bool postCommandAck(const NetworkJob& job) {
  WiFiClientSecure secureClient;
  HTTPClient http;
  char url[160];
  snprintf(url, sizeof(url), "%s/device/actions/ack", API_BASE_URL);

  if (!beginSecureRequest(http, secureClient, url, "/device/actions/ack")) {
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  if (strlen(DEVICE_API_KEY) > 0) {
    http.addHeader("x-device-key", DEVICE_API_KEY);
  }

  JsonDocument payload;
  payload["actionId"] = job.text1;
  payload["status"] = job.text2;
  payload["success"] = job.boolValue;
  payload["message"] = job.text3;

  char body[384];
  const size_t bodyLen = serializeJson(payload, body, sizeof(body));
  const int httpCode = http.POST(reinterpret_cast<uint8_t*>(body), bodyLen);
  const String responseBody = http.getString();
  http.end();

  if (httpCode < 200 || httpCode >= 300) {
    logHttpFailure("/device/actions/ack", httpCode, secureClient, responseBody);
  }

  return httpCode >= 200 && httpCode < 300;
}

bool postDeviceSyncMessage(const char* messageJson, const char* requestLabel) {
  WiFiClientSecure secureClient;
  HTTPClient http;
  char url[128];
  snprintf(url, sizeof(url), "%s/device/sync", API_BASE_URL);

  if (!beginSecureRequest(http, secureClient, url, requestLabel)) {
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  if (strlen(DEVICE_API_KEY) > 0) {
    http.addHeader("x-device-key", DEVICE_API_KEY);
  }

  char body[1536];
  const int bodyLen = snprintf(body, sizeof(body), "{\"deviceId\":\"%s\",\"messages\":[%s]}", DEVICE_ID, messageJson);
  if (bodyLen <= 0 || static_cast<size_t>(bodyLen) >= sizeof(body)) {
    Serial.printf("%s body too large.\n", requestLabel);
    http.end();
    return false;
  }

  const int httpCode = http.POST(reinterpret_cast<uint8_t*>(body), static_cast<size_t>(bodyLen));
  const String responseBody = http.getString();
  http.end();

  Serial.printf("%s HTTPS fallback HTTP=%d\n", requestLabel, httpCode);
  if (httpCode < 200 || httpCode >= 300) {
    logHttpFailure(requestLabel, httpCode, secureClient, responseBody);
  }

  if (responseBody.length() > 0 && DEBUG_RFID_VERBOSE) {
    Serial.printf("%s response: %s\n", requestLabel, responseBody.c_str());
  }

  return httpCode >= 200 && httpCode < 300;
}

bool fetchDeviceActionsForTask(NetworkResult& result) {
  WiFiClientSecure secureClient;
  HTTPClient http;
  char url[192];
  snprintf(url, sizeof(url), "%s/device/actions?waitMs=%lu", API_BASE_URL, DEVICE_ACTIONS_LONG_POLL_WAIT_MS);

  if (!beginSecureRequest(
    http,
    secureClient,
    url,
    "/device/actions",
    static_cast<uint16_t>(DEVICE_ACTIONS_LONG_POLL_WAIT_MS + HTTP_RESPONSE_TIMEOUT_MS)
  )) {
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
    logHttpFailure("/device/actions", httpCode, secureClient, responseBody);
    return false;
  }

  JsonDocument responseDoc;
  const DeserializationError error = deserializeJson(responseDoc, responseBody);
  if (error) {
    Serial.printf("device/actions JSON parse failed: %s\n", error.c_str());
    Serial.printf("Raw response: %s\n", responseBody.c_str());
    return false;
  }

  const JsonArray actions = responseDoc["actions"];
  if (actions.isNull()) {
    return true;
  }

  result.count = static_cast<uint8_t>(min(static_cast<size_t>(255), actions.size()));

  for (JsonObject action : actions) {
    const char* type = action["type"] | "UNKNOWN";
    const int locker = action["locker"] | 0;
    const char* actor = action["actor"] | "unknown";
    Serial.printf("Remote action -> type=%s locker=%d actor=%s\n", type, locker, actor);

    NetworkResult commandResult = {};
    commandResult.type = NetworkResultType::DeviceCommand;
    commandResult.requestOk = true;
    commandResult.lockerNumber = static_cast<uint8_t>(locker);
    copyCStringToBuffer(action["id"] | "", commandResult.actionId, sizeof(commandResult.actionId));
    copyCStringToBuffer(type, commandResult.actionType, sizeof(commandResult.actionType));

    const JsonObject payload = action["payload"];
    if (!payload.isNull()) {
      copyCStringToBuffer(payload["assignmentId"] | "", commandResult.text1, sizeof(commandResult.text1));
      copyCStringToBuffer(payload["tagId"] | "", commandResult.text2, sizeof(commandResult.text2));
      copyCStringToBuffer(payload["itemName"] | "", commandResult.text3, sizeof(commandResult.text3));
    }

    if (networkResultQueue != nullptr && xQueueSend(networkResultQueue, &commandResult, 0) != pdTRUE) {
      Serial.println("Failed to queue HTTP-polled remote command result.");
      if (strlen(commandResult.actionId) > 0) {
        NetworkJob ack = {};
        ack.type = NetworkJobType::CommandAck;
        ack.boolValue = false;
        copyCStringToBuffer(commandResult.actionId, ack.text1, sizeof(ack.text1));
        copyCStringToBuffer("failed", ack.text2, sizeof(ack.text2));
        copyCStringToBuffer("Firmware command queue full.", ack.text3, sizeof(ack.text3));
        enqueueNetworkJob(ack);
      }
    }
  }

  return true;
}

bool sendHeartbeat() {
  WiFiClientSecure secureClient;
  HTTPClient http;
  char url[128];
  snprintf(url, sizeof(url), "%s/device/heartbeat", API_BASE_URL);

  if (!beginSecureRequest(http, secureClient, url, "/device/heartbeat")) {
    return false;
  }

  http.addHeader("Content-Type", "application/json");

  if (strlen(DEVICE_API_KEY) > 0) {
    http.addHeader("x-device-key", DEVICE_API_KEY);
  }

  JsonDocument payload;
  JsonObject payloadObject = payload.to<JsonObject>();
  buildHeartbeatPayload(payloadObject);

  char body[1024];
  const size_t bodyLen = serializeJson(payload, body, sizeof(body));

  const unsigned long startedAt = millis();
  const int httpCode = http.POST(reinterpret_cast<uint8_t*>(body), bodyLen);
  const String responseBody = http.getString();
  const unsigned long durationMs = millis() - startedAt;
  http.end();

  if (httpCode >= 200 && httpCode < 300) {
    lastHeartbeatPingMs = static_cast<long>(durationMs);
    Serial.printf("Heartbeat OK (%lu ms)\n", durationMs);
    return true;
  }

  Serial.printf("Heartbeat failed, HTTP status: %d\n", httpCode);
  logHttpFailure("/device/heartbeat", httpCode, secureClient, responseBody);

  return false;
}

void printUsage() {
  if (ENABLE_KEYPAD) {
    Serial.println("Keypad actions:");
    Serial.println("  0-9 -> add digit to 4-digit code");
    Serial.println("  *   -> clear code buffer");
    Serial.println("  #   -> send code to backend");
    Serial.println("  A   -> reconnect WiFi");
    Serial.println("  B   -> print current status");
    Serial.println("  C   -> print this help");
    Serial.println("  D   -> clear buffer (debug reset)");
  } else {
    Serial.println("Keypad actions: disabled for this build");
  }
  Serial.println("Serial debug commands:");
  Serial.println("  help / ?  -> show help");
  Serial.println("  status/s  -> print full device status");
  Serial.println("  rfid/r    -> print RFID snapshot");
  Serial.println("  wifi/w    -> reconnect WiFi");
  Serial.println("  wifi-setup -> start temporary SafeKeys setup AP");
  Serial.println("  config    -> fetch remote device config now");
  Serial.println("  heartbeat/h -> send heartbeat now");
  Serial.println("  lockers/l -> force locker RFID report");
  Serial.println("  actions/a -> poll remote actions");
  Serial.println("  open <1-4> -> pulse selected locker relay");
  Serial.println("  openall   -> pulse all configured locker relays");
  Serial.println("  locksoff  -> force all relays OFF");
  Serial.println("  clear/c   -> clear code buffer");
  Serial.println("Network:");
  Serial.println("  - primary transport: persistent WebSocket /device/ws");
  Serial.println("  - fallback: batched HTTPS /device/sync plus legacy verify endpoints");
  Serial.println("LED visuals:");
  Serial.println("  - green  -> OK: programmed tag present and locker closed");
  Serial.println("  - yellow -> warning: missing key or locker not fully closed");
  Serial.println("  - red    -> error: unknown tag or missing key with open locker");
  Serial.println("  - red pulse -> unknown RFID item in locker");
  Serial.println("  - yellow/red blink -> open locker according to panel severity");
  Serial.println("  - blue breath -> backend WebSocket online");
  Serial.println("  - red dotted pulse -> backend/WiFi offline");
  Serial.println("  - cyan sweep -> state synchronized with panel");
  Serial.println("  - white flash -> remote/open action");
  Serial.println("  - blue groups -> keypad code entry progress");
  Serial.println("  - cyan pulse -> keypad code verification pending");
  Serial.println("  - 3x green/red blink -> code accepted/rejected");
  Serial.println("  - yellow chase -> WiFi connecting");
  Serial.println("  - cyan/green chase -> master reader in tag assignment mode");
}

void printStatus() {
  Serial.println("--- ESP32 status ---");
  Serial.printf("WiFi connected: %s\n", isWifiReady() ? "yes" : "no");
  if (isWifiReady()) {
    Serial.printf("IP: %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("RSSI: %d dBm\n", WiFi.RSSI());
  }
  Serial.printf("WiFi retry interval: %lu ms, WiFi failures: %u\n", wifiRetryIntervalMs, consecutiveWifiFailureCount);
  Serial.printf("WiFi configured SSID: %s (source=%s)\n",
    configuredWifiSsid.length() > 0 ? configuredWifiSsid.c_str() : "(empty)",
    wifiConfigLoadedFromNvs ? "nvs" : "firmware"
  );
  Serial.printf("Service panel: started=%s enabled=%s setupAp=%s ssid=%s apIp=%s\n",
    servicePanelStarted ? "yes" : "no",
    runtimeServicePanelEnabled ? "yes" : "no",
    serviceSetupPortalActive ? "yes" : "no",
    setupApSsid.length() > 0 ? setupApSsid.c_str() : "(none)",
    WiFi.softAPIP().toString().c_str()
  );
  Serial.printf("Firmware=%s protocol=%u configVersion=%lu heartbeat=%lu ms\n",
    FIRMWARE_VERSION,
    DEVICE_PROTOCOL_VERSION,
    static_cast<unsigned long>(remoteConfigVersion),
    static_cast<unsigned long>(runtimeHeartbeatIntervalMs)
  );
  if (lastHeartbeatPingMs >= 0) {
    Serial.printf("Last heartbeat ping: %ld ms\n", lastHeartbeatPingMs);
  } else {
    Serial.println("Last heartbeat ping: n/a");
  }
  Serial.printf("Device actions poll interval: %lu ms\n", deviceActionsPollIntervalMs);
  Serial.printf("Consecutive network failures: %u\n", consecutiveNetworkFailureCount);
  Serial.printf("Device WebSocket: %s, reconnectDelay=%lu ms, fullResync=%s\n",
    isDeviceWebSocketReady() ? "connected" : "disconnected",
    deviceWsReconnectDelayMs,
    fullStateResyncPending ? "yes" : "no"
  );
  Serial.printf("Device bootId: %s, next message seq=%lu\n", deviceBootId, static_cast<unsigned long>(deviceMessageSequence + 1));

  Serial.printf("Current code buffer: %s\n", enteredCode.length() > 0 ? enteredCode.c_str() : "(empty)");
  Serial.printf("Code rate limit: enabled=%s failures=%u/%u window=%lu ms lockoutUntil=%lu\n",
    runtimeCodeRateLimitEnabled ? "yes" : "no",
    codeRateLimitFailureCount,
    runtimeCodeRateLimitMaxFailures,
    static_cast<unsigned long>(runtimeCodeRateLimitWindowMs),
    static_cast<unsigned long>(codeRateLimitLockedUntilMs)
  );
  Serial.printf("Locker switch inputs enabled: %s\n", ENABLE_LOCKER_SWITCH_INPUTS ? "yes" : "no");
  Serial.printf("Lock relays: pulse=%lu ms mode=%s activeLow=%s\n",
    static_cast<unsigned long>(runtimeLockUnlockPulseMs),
    OPEN_LOCKS_PARALLEL ? "parallel" : "sequential",
    RELAY_ACTIVE_LOW ? "yes" : "no"
  );
  for (uint8_t lockerId = 1; lockerId <= LOCK_RELAY_COUNT; lockerId += 1) {
    const LockRelayState& state = lockRelayStates[lockerRelayIndex(lockerId)];
    const unsigned long remainingMs = (state.active && state.pulsed && millis() - state.startedAtMs < state.durationMs)
      ? state.durationMs - (millis() - state.startedAtMs)
      : 0UL;
    Serial.printf(
      "Relay L%u -> gpio=%u active=%s pulse=%s remaining=%lu ms\n",
      lockerId,
      lockerRelayPin(lockerId),
      state.active ? "yes" : "no",
      state.pulsed ? "yes" : "no",
      remainingMs
    );
  }
  printRfidSnapshot();

  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    const LockerState state = readLockerState(i);
    const LockerLedStatus ledStatus = getLockerLedStatus(i, state);
    Serial.printf(
      "Locker S%u -> tag=%s programmed=%s uid=%s door=%s lock=%s ready=%s led=%s panelLed=%s version=%lu lastReport=%lu ms ago dirty=%s retryIn=%lu failCount=%u\n",
      i + 1,
      state.tagPresent ? "yes" : "no",
      state.tagProgrammed ? "yes" : "no",
      state.tagPresent ? state.tagUid.c_str() : "(none)",
      ENABLE_LOCKER_SWITCH_INPUTS ? (state.doorClosed ? "closed" : "open") : "n/a",
      ENABLE_LOCKER_SWITCH_INPUTS ? (state.lockClosed ? "closed" : "open") : "n/a",
      isLockerComplete(state) ? "yes" : "no",
      lockerLedStatusName(ledStatus),
      panelLockerLedStatusKnown[i] ? "yes" : "no",
      static_cast<unsigned long>(lockerStateVersions[i]),
      lockerReaders[i].lastReportMs == 0 ? 0UL : millis() - lockerReaders[i].lastReportMs,
      lockerReaders[i].reportDirty ? "yes" : "no",
      lockerReaders[i].nextReportAttemptMs > millis() ? lockerReaders[i].nextReportAttemptMs - millis() : 0UL,
      lockerReaders[i].reportFailureCount
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
      "[%s] ss=%u healthy=%s present=%s programmed=%s uid=%s physical=%s candidate=%s seen=%u missing=%u dirty=%s dirtySince=%lu nextRetry=%lu failCount=%u lastSeen=%lu\n",
      runtime.label,
      runtime.ssPin,
      lockerReaderHealthy[i] ? "yes" : "no",
      runtime.hasCard ? "yes" : "no",
      runtime.stableHasCustomTag ? "yes" : "no",
      runtime.hasCard ? runtime.stableUid.c_str() : "(none)",
      runtime.stablePhysicalUid.length() > 0 ? runtime.stablePhysicalUid.c_str() : "(none)",
      runtime.candidateUid.length() > 0 ? runtime.candidateUid.c_str() : "(none)",
      runtime.candidateSeenCount,
      runtime.missingSeenCount,
      runtime.reportDirty ? "yes" : "no",
      runtime.dirtySinceMs,
      runtime.nextReportAttemptMs,
      runtime.reportFailureCount,
      runtime.lastSeenMs
    );
  }

  Serial.printf(
    "[%s] ss=%u healthy=%s present=%s uid=%s candidate=%s seen=%u missing=%u armedUid=%s lastSeen=%lu\n",
    masterReaderRuntime.label,
    masterReaderRuntime.ssPin,
    masterReaderHealthy ? "yes" : "no",
    masterReaderRuntime.hasCard ? "yes" : "no",
    masterReaderRuntime.hasCard ? masterReaderRuntime.stableUid.c_str() : "(none)",
    masterReaderRuntime.candidateUid.length() > 0 ? masterReaderRuntime.candidateUid.c_str() : "(none)",
    masterReaderRuntime.candidateSeenCount,
    masterReaderRuntime.missingSeenCount,
    masterReaderRuntime.lastTriggeredUid.length() > 0 ? masterReaderRuntime.lastTriggeredUid.c_str() : "(none)",
    masterReaderRuntime.lastSeenMs
  );
}

void startTagAssignmentMode(const String& assignmentId, const String& tagId, const String& itemName) {
  if (accessSelection.active) {
    finishAccessSelection("tag_assignment_override");
  }

  tagAssignmentMode.active = true;
  tagAssignmentMode.assignmentId = assignmentId;
  tagAssignmentMode.tagId = tagId;
  tagAssignmentMode.itemName = itemName;
  tagAssignmentMode.startedMs = millis();
  tagAssignmentMode.animationFrame = 0;
  lastTagAssignmentFrame = 0xFF;
  masterReaderRuntime.lastTriggeredUid = "";
  resetDeviceActionsPollCadence();
  markVisualStateDirty();

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
  lastTagAssignmentFrame = 0xFF;
  resetDeviceActionsPollCadence();
  markVisualStateDirty();
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
    if (isRelayPin(LOCKERS[i].doorClosed.pin)) {
      Serial.printf("[LOCK] locker=%u door input GPIO%u skipped due to relay pin conflict\n", i + 1, LOCKERS[i].doorClosed.pin);
    } else {
      pinMode(LOCKERS[i].doorClosed.pin, INPUT_PULLUP);
    }

    if (isRelayPin(LOCKERS[i].lockClosed.pin)) {
      Serial.printf("[LOCK] locker=%u lock input GPIO%u skipped due to relay pin conflict\n", i + 1, LOCKERS[i].lockClosed.pin);
    } else {
      pinMode(LOCKERS[i].lockClosed.pin, INPUT_PULLUP);
    }
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
    if (!isRelayPin(cfg.doorClosed.pin)) {
      doorClosed = readInputPin(cfg.doorClosed);
    }
    if (!isRelayPin(cfg.lockClosed.pin)) {
      lockClosed = readInputPin(cfg.lockClosed);
    }
  }

  return {
    runtime.hasCard,
    runtime.stableHasCustomTag,
    runtime.stableUid,
    doorClosed,
    lockClosed
  };
}

bool isLockerComplete(const LockerState& state) {
  return state.tagPresent && state.doorClosed && state.lockClosed;
}

LockerLedStatus getLockerLedStatus(uint8_t lockerIndex, const LockerState& state) {
  if (
    lockerIndex < LOCKER_COUNT &&
    panelLockerLedStatusKnown[lockerIndex] &&
    panelLockerLedStatusVersions[lockerIndex] == lockerStateVersions[lockerIndex]
  ) {
    return panelLockerLedStatuses[lockerIndex];
  }

  return getProvisionalLockerLedStatus(state);
}

LockerLedStatus getProvisionalLockerLedStatus(const LockerState& state) {
  const bool chamberClosed = state.doorClosed && state.lockClosed;

  if (!state.tagPresent && !chamberClosed) {
    return LockerLedStatus::Error;
  }

  return LockerLedStatus::Warning;
}

bool parseLockerLedStatus(const char* value, LockerLedStatus& status) {
  if (value == nullptr) {
    return false;
  }

  if (strcmp(value, "ok") == 0 || strcmp(value, "OK") == 0) {
    status = LockerLedStatus::Ok;
    return true;
  }

  if (strcmp(value, "warn") == 0 || strcmp(value, "warning") == 0 || strcmp(value, "info") == 0) {
    status = LockerLedStatus::Warning;
    return true;
  }

  if (strcmp(value, "critical") == 0 || strcmp(value, "error") == 0 || strcmp(value, "bad") == 0) {
    status = LockerLedStatus::Error;
    return true;
  }

  return false;
}

LockerItemStatus parseLockerItemStatus(const char* value) {
  if (value == nullptr || strlen(value) == 0) {
    return LockerItemStatus::Unknown;
  }

  if (strcmp(value, "known") == 0) {
    return LockerItemStatus::Known;
  }

  if (strcmp(value, "missing") == 0) {
    return LockerItemStatus::Missing;
  }

  if (strcmp(value, "unknown") == 0) {
    return LockerItemStatus::UnknownTag;
  }

  return LockerItemStatus::Unknown;
}

const char* lockerLedStatusName(LockerLedStatus status) {
  switch (status) {
    case LockerLedStatus::Ok:
      return "ok";
    case LockerLedStatus::Warning:
      return "warn";
    case LockerLedStatus::Error:
    default:
      return "critical";
  }
}

bool applyPanelLockerLedStatus(uint8_t lockerNumber, uint32_t version, LockerLedStatus status, LockerItemStatus itemStatus, bool doorClosed, const char* severity) {
  if (lockerNumber < 1 || lockerNumber > LOCKER_COUNT) {
    return false;
  }

  const uint8_t index = lockerNumber - 1;
  const uint32_t currentVersion = lockerStateVersions[index];
  if (version != 0 && version != currentVersion) {
    Serial.printf("[LED STATUS] stale panel status ignored locker=%u severity=%s version=%lu current=%lu\n",
      lockerNumber,
      severity != nullptr && strlen(severity) > 0 ? severity : lockerLedStatusName(status),
      static_cast<unsigned long>(version),
      static_cast<unsigned long>(currentVersion)
    );
    return false;
  }

  panelLockerLedStatuses[index] = status;
  panelLockerItemStatuses[index] = itemStatus;
  panelLockerDoorClosed[index] = doorClosed;
  panelLockerLedStatusKnown[index] = true;
  panelLockerLedStatusVersions[index] = currentVersion;
  Serial.printf("[LED STATUS] locker=%u severity=%s color=%s version=%lu source=panel\n",
    lockerNumber,
    severity != nullptr && strlen(severity) > 0 ? severity : lockerLedStatusName(status),
    lockerLedStatusName(status),
    static_cast<unsigned long>(currentVersion)
  );
  return true;
}

uint32_t colorForLockerLedStatus(LockerLedStatus status) {
  switch (status) {
    case LockerLedStatus::Ok:
      return colorGreen(STATUS_BRIGHTNESS);
    case LockerLedStatus::Warning:
      return colorYellow(STATUS_BRIGHTNESS);
    case LockerLedStatus::Error:
    default:
      return colorRed(STATUS_BRIGHTNESS);
  }
}

bool hasAnimatedNormalLedState(uint32_t nowMs) {
  (void) nowMs;
  if (
    ledStripEffect.active ||
    ledSegmentFlashEffect.active ||
    wifiConnectInProgress ||
    tagAssignmentMode.active ||
    isStateSyncPending() ||
    isBackendOfflineSignalActive() ||
    isDeviceWebSocketReady()
  ) {
    return true;
  }

  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    if (!lockerReaderHealthy[i]) {
      return true;
    }
    if (
      panelLockerLedStatusKnown[i] &&
      panelLockerLedStatusVersions[i] == lockerStateVersions[i] &&
      (panelLockerItemStatuses[i] == LockerItemStatus::UnknownTag || !panelLockerDoorClosed[i])
    ) {
      return true;
    }
  }

  return false;
}

bool isStateSyncPending() {
  return deviceStateBatchQueued || deviceStateAckPending || panelStatusResultPending;
}

bool isBackendOfflineSignalActive() {
  if (wifiConnectInProgress) {
    return false;
  }

  if (!isWifiReady()) {
    return true;
  }

  return !isDeviceWebSocketReady() && (consecutiveNetworkFailureCount > 0 || !deviceWsServerHelloSeen);
}

void startLedStripEffect(LedStripEffectKind kind, uint32_t durationMs) {
  ledStripEffect = { true, kind, millis(), durationMs };
  markVisualStateDirty();
}

void startLedSegmentFlash(uint8_t lockerNumber, uint32_t color, uint32_t durationMs) {
  ledSegmentFlashEffect = { true, lockerNumber, millis(), durationMs, color };
  markVisualStateDirty();
}

void serviceLedTimedEffects(uint32_t nowMs) {
  bool changed = false;

  if (ledStripEffect.active && nowMs - ledStripEffect.startedAtMs >= ledStripEffect.durationMs) {
    ledStripEffect = { false, LED_STRIP_EFFECT_NONE, 0, 0 };
    changed = true;
  }

  if (ledSegmentFlashEffect.active && nowMs - ledSegmentFlashEffect.startedAtMs >= ledSegmentFlashEffect.durationMs) {
    ledSegmentFlashEffect = { false, 0, 0, 0, 0 };
    changed = true;
  }

  if (
    panelStatusResultPending &&
    panelStatusResultPendingStartedMs != 0 &&
    nowMs - panelStatusResultPendingStartedMs >= LED_PANEL_STATUS_RESULT_WAIT_MS
  ) {
    panelStatusResultPending = false;
    panelStatusResultPendingStartedMs = 0;
    changed = true;
  }

  if (changed) {
    markVisualStateDirty();
  }
}

bool hasAccessToLocker(uint8_t mask, int lockerNumber) {
  return (mask & lockerNumberToMask(lockerNumber)) != 0;
}

uint8_t lockerNumberToMask(int lockerNumber) {
  if (lockerNumber < 1 || lockerNumber > LOCKER_COUNT) {
    return 0;
  }

  return static_cast<uint8_t>(1U << (lockerNumber - 1));
}

LockerLedSegment getLockerLedSegment(uint8_t lockerNumber) {
  if (lockerNumber < 1 || lockerNumber > LOCKER_COUNT) {
    return { 0, 0, 0, false };
  }

  const uint16_t start = static_cast<uint16_t>((lockerNumber - 1) * LEDS_PER_LOCKER);
  const uint16_t end = static_cast<uint16_t>(min<uint16_t>(TOTAL_LEDS, start + LEDS_PER_LOCKER) - 1);
  if (start >= TOTAL_LEDS || end < start) {
    return { 0, 0, 0, false };
  }

  return {
    start,
    end,
    static_cast<uint16_t>(end - start + 1),
    true
  };
}

void formatLockerMaskBinary(uint8_t mask, char* buffer, size_t bufferSize) {
  if (bufferSize == 0) {
    return;
  }

  snprintf(
    buffer,
    bufferSize,
    "0b%c%c%c",
    (mask & lockerNumberToMask(3)) != 0 ? '1' : '0',
    (mask & lockerNumberToMask(2)) != 0 ? '1' : '0',
    (mask & lockerNumberToMask(1)) != 0 ? '1' : '0'
  );
}

void startAccessSelection(const String& uid, uint8_t accessibleLockersMask, bool isMaster, const String& requestId, const String& userId, const String& userName) {
  accessSelection.active = true;
  accessSelection.startedAtMs = millis();
  accessSelection.timeoutMs = ACCESS_SELECTION_TIMEOUT_MS;
  accessSelection.sessionId += 1;
  accessSelection.uid = uid;
  accessSelection.isMaster = isMaster;
  accessSelection.accessibleMask = accessibleLockersMask;
  accessSelection.requestId = requestId;
  accessSelection.userId = userId;
  accessSelection.userName = userName;
  accessSelection.lastBusyUid = "";
  enteredCode = "";
  codeResultFlash.active = false;
  ledErrorFlash.active = false;
  masterReaderRuntime.lastTriggeredUid = uid;
  setLedMode(LED_MODE_ACCESS_SELECTION);

  char maskText[8];
  formatLockerMaskBinary(accessibleLockersMask, maskText, sizeof(maskText));
  Serial.printf(
    "[ACCESS SELECTION] started uid=%s requestId=%s master=%s mask=%s timeout=%lums session=%lu\n",
    uid.c_str(),
    requestId.length() > 0 ? requestId.c_str() : "(none)",
    isMaster ? "true" : "false",
    maskText,
    static_cast<unsigned long>(accessSelection.timeoutMs),
    static_cast<unsigned long>(accessSelection.sessionId)
  );
  Serial.printf("[LED] access selection mode active mask=%s\n", maskText);

  queueAccessSelectionEvent("access_selection_started");
  markVisualStateDirty();
  updateVisualState();
}

void cancelAccessSelection(const char* reason) {
  if (!accessSelection.active) {
    return;
  }

  const char* eventName = reason;
  if (reason != nullptr && strcmp(reason, "user_cancelled") == 0) {
    eventName = "access_selection_cancelled";
  } else if (reason != nullptr && strcmp(reason, "timeout") == 0) {
    eventName = "access_selection_timeout";
  }

  if (eventName != nullptr && strlen(eventName) > 0) {
    queueAccessSelectionEvent(eventName);
  }

  finishAccessSelection(reason);
}

void finishAccessSelection(const char* reason) {
  if (!accessSelection.active) {
    return;
  }

  Serial.printf(
    "[ACCESS SELECTION] finished reason=%s session=%lu\n",
    reason != nullptr && strlen(reason) > 0 ? reason : "(none)",
    static_cast<unsigned long>(accessSelection.sessionId)
  );

  accessSelection.active = false;
  accessSelection.startedAtMs = 0;
  accessSelection.timeoutMs = ACCESS_SELECTION_TIMEOUT_MS;
  accessSelection.uid = "";
  accessSelection.isMaster = false;
  accessSelection.accessibleMask = 0;
  accessSelection.requestId = "";
  accessSelection.userId = "";
  accessSelection.userName = "";
  accessSelection.lastBusyUid = "";

  restoreNormalLedMode();
}

void serviceAccessSelection(unsigned long now) {
  tickAccessSelection(static_cast<uint32_t>(now));
}

void tickAccessSelection(uint32_t nowMs) {
  if (!accessSelection.active) {
    return;
  }

  if (nowMs - accessSelection.startedAtMs >= accessSelection.timeoutMs) {
    cancelAccessSelection("timeout");
  }
}

void handleAccessSelectionKey(char key) {
  Serial.printf("[KEYPAD] selection key=%c\n", key);

  if (key >= '1' && key <= static_cast<char>('0' + LOCKER_COUNT)) {
    openSelectedLocker(static_cast<uint8_t>(key - '0'));
    return;
  }

  if (key == '*') {
    cancelAccessSelection("user_cancelled");
    blinkLed(1, 80, 80);
    return;
  }

  if (key == '#') {
    openAllAccessibleLockers();
    return;
  }

  Serial.printf("[ACCESS SELECTION] ignored key=%c\n", key);
  queueAccessSelectionEvent("invalid_selection_key");
  blinkLed(2, 60, 60);
}

void openSelectedLocker(uint8_t lockerNumber) {
  if (!accessSelection.active) {
    return;
  }

  char maskText[8];
  formatLockerMaskBinary(accessSelection.accessibleMask, maskText, sizeof(maskText));
  if (!hasAccessToLocker(accessSelection.accessibleMask, lockerNumber)) {
    Serial.printf("[ACCESS SELECTION] denied locker=%d mask=%s uid=%s\n", lockerNumber, maskText, accessSelection.uid.c_str());
    queueAccessSelectionEvent("access_selection_invalid_locker", static_cast<uint8_t>(lockerNumber));
    startLedErrorFlash(350);
    blinkLed(3, 70, 70);
    return;
  }

  if (!queueAccessSelectionEvent("access_selection_open_single", static_cast<uint8_t>(lockerNumber))) {
    blinkLed(4, 70, 70);
    return;
  }

  if (!pulseUnlockLocker(lockerNumber, runtimeLockUnlockPulseMs)) {
    startLedErrorFlash(350);
    blinkLed(4, 70, 70);
    return;
  }

  Serial.printf("[LOCKER] opening locker=%d reason=access_selection uid=%s\n", lockerNumber, accessSelection.uid.c_str());
  startLedSegmentFlash(lockerNumber, colorWhite(190), LED_REMOTE_FLASH_MS);
  finishAccessSelection("open_single");
  blinkLed(2, 220, 120);
}

void openAllAccessibleLockers() {
  if (!accessSelection.active) {
    return;
  }

  if (accessSelection.accessibleMask == 0) {
    startLedErrorFlash(350);
    blinkLed(4, 70, 70);
    return;
  }

  if (!queueAccessSelectionEvent("access_selection_open_all")) {
    blinkLed(4, 70, 70);
    return;
  }

  if (!pulseUnlockLockerMask(accessSelection.accessibleMask)) {
    startLedErrorFlash(350);
    blinkLed(4, 70, 70);
    return;
  }

  char maskText[8];
  formatLockerMaskBinary(accessSelection.accessibleMask, maskText, sizeof(maskText));
  Serial.printf("[LOCKER] opening all reason=access_selection uid=%s mask=%s\n",
    accessSelection.uid.c_str(),
    maskText
  );
  startLedStripEffect(LED_STRIP_EFFECT_REMOTE_ALL, LED_REMOTE_FLASH_MS);
  finishAccessSelection("open_all");
  blinkLed(3, 180, 90);
}

bool queueAccessSelectionEvent(const char* eventName, uint8_t lockerNumber) {
  if (eventName == nullptr || strlen(eventName) == 0) {
    return false;
  }

  NetworkJob job = {};
  job.type = NetworkJobType::AccessSelectionEvent;
  job.lockerNumber = lockerNumber;
  job.boolValue = accessSelection.isMaster;
  job.numberValue = accessSelection.accessibleMask;
  copyStringToBuffer(accessSelection.uid, job.text1, sizeof(job.text1));
  copyStringToBuffer(accessSelection.userId, job.text2, sizeof(job.text2));
  copyCStringToBuffer(eventName, job.text3, sizeof(job.text3));
  copyStringToBuffer(accessSelection.userName, job.text4, sizeof(job.text4));
  copyStringToBuffer(accessSelection.requestId, job.text5, sizeof(job.text5));

  if (!enqueueNetworkJob(job)) {
    Serial.printf("Failed to queue access selection event: %s\n", eventName);
    return false;
  }

  return true;
}

void setLedMode(LedMode nextMode) {
  if (ledMode == nextMode) {
    return;
  }

  ledMode = nextMode;
  markVisualStateDirty();
}

void updateLeds(uint32_t nowMs) {
  if (accessSelection.active) {
    ledMode = LED_MODE_ACCESS_SELECTION;
    updateAccessSelectionLeds(nowMs);
    strip.show();
    return;
  }

  if (ledMode == LED_MODE_ERROR_FLASH && ledErrorFlash.active) {
    renderErrorFlashLeds(nowMs);
    strip.show();
    return;
  }

  if (tagAssignmentMode.active) {
    const uint8_t frame = static_cast<uint8_t>((nowMs / LED_FRAME_INTERVAL_MS) % (TOTAL_LEDS / 2));
    if (frame != lastTagAssignmentFrame) {
      lastTagAssignmentFrame = frame;
      renderTagAssignmentFrame(frame);
    }
    return;
  }

  if (codeResultFlash.active) {
    return;
  }

  const bool codeEntryVisible = enteredCode.length() > 0 || codeVerificationPending;
  const bool codeEntryAnimated = codeVerificationPending;
  const bool animated = codeEntryAnimated || hasAnimatedNormalLedState(nowMs);
  if (!visualStateDirty && (!animated || nowMs - lastLedFrameMs < LED_FRAME_INTERVAL_MS)) {
    return;
  }
  lastLedFrameMs = nowMs;

  if (codeEntryVisible) {
    renderCodeEntry(nowMs);
  } else if (ledStripEffect.active && ledStripEffect.kind == LED_STRIP_EFFECT_STARTUP) {
    renderStartupLeds(nowMs);
  } else if (wifiConnectInProgress) {
    renderWifiLoadingFrame(wifiLoadingFrame);
  } else {
    renderLockerStatus(nowMs);
  }

  visualStateDirty = false;
}

void updateVisualState() {
  updateLeds(millis());
}

void markVisualStateDirty() {
  visualStateDirty = true;
}

void updateAccessSelectionLeds(unsigned long nowMs) {
  clearStrip();

  for (uint8_t lockerNumber = 1; lockerNumber <= LOCKER_COUNT; lockerNumber += 1) {
    if (hasAccessToLocker(accessSelection.accessibleMask, lockerNumber)) {
      renderAllowedSegmentAnimation(lockerNumber, nowMs);
    } else {
      renderDeniedSegmentBlink(lockerNumber, nowMs);
    }
  }
}

void renderAllowedSegmentAnimation(uint8_t lockerNumber, unsigned long nowMs) {
  const LockerLedSegment segment = getLockerLedSegment(lockerNumber);
  if (!segment.valid || segment.length == 0) {
    return;
  }

  for (uint16_t led = segment.start; led <= segment.end; led += 1) {
    strip.setPixelColor(led, strip.Color(3, 0, 8));
  }

  const uint16_t cycleLength = segment.length > 1
    ? static_cast<uint16_t>((segment.length - 1) * 2)
    : 1;
  const uint16_t frame = static_cast<uint16_t>((nowMs / ACCESS_SELECTION_ALLOWED_FRAME_MS) % cycleLength);
  const bool forward = frame < segment.length;
  const uint16_t localPosition = forward ? frame : (cycleLength - frame);

  for (uint8_t offset = 0; offset < ACCESS_SELECTION_TAIL_LENGTH; offset += 1) {
    int16_t tailPosition = forward
      ? static_cast<int16_t>(localPosition) - static_cast<int16_t>(offset)
      : static_cast<int16_t>(localPosition) + static_cast<int16_t>(offset);

    if (tailPosition < 0 || tailPosition >= static_cast<int16_t>(segment.length)) {
      continue;
    }

    const uint16_t ledIndex = static_cast<uint16_t>(segment.start + tailPosition);
    const uint8_t brightness = offset == 0
      ? 255
      : (offset == 1 ? 140 : 70);
    strip.setPixelColor(ledIndex, colorViolet(brightness));
  }
}

void renderDeniedSegmentBlink(uint8_t lockerNumber, unsigned long nowMs) {
  const LockerLedSegment segment = getLockerLedSegment(lockerNumber);
  if (!segment.valid) {
    return;
  }

  const bool visible = ((nowMs / ACCESS_SELECTION_DENIED_BLINK_MS) % 2) == 0;
  if (!visible) {
    return;
  }

  for (uint16_t led = segment.start; led <= segment.end; led += 1) {
    strip.setPixelColor(led, colorRed(EFFECT_BRIGHTNESS));
  }
}

void startLedErrorFlash(uint32_t durationMs) {
  if (accessSelection.active) {
    blinkLed(2, 50, 50);
    return;
  }

  ledErrorFlash = { true, millis(), durationMs };
  setLedMode(LED_MODE_ERROR_FLASH);
  markVisualStateDirty();
  updateVisualState();
}

void renderErrorFlashLeds(uint32_t nowMs) {
  clearStrip();
  const bool visible = ((nowMs / 120) % 2) == 0;
  if (!visible) {
    return;
  }

  for (uint16_t led = 0; led < TOTAL_LEDS; led += 1) {
    strip.setPixelColor(led, colorRed(EFFECT_BRIGHTNESS));
  }
}

void serviceLedErrorFlash(uint32_t nowMs) {
  if (!ledErrorFlash.active) {
    return;
  }

  if (nowMs - ledErrorFlash.startedAtMs < ledErrorFlash.durationMs) {
    return;
  }

  ledErrorFlash.active = false;
  setLedMode(accessSelection.active ? LED_MODE_ACCESS_SELECTION : LED_MODE_NORMAL);
  markVisualStateDirty();
}

void restoreNormalLedMode() {
  setLedMode(LED_MODE_NORMAL);
  Serial.println("[LED] restored normal mode");
  markVisualStateDirty();
  updateVisualState();
}

void fillSegment(const LockerLedSegment& segment, uint32_t color) {
  if (!segment.valid) {
    return;
  }

  for (uint16_t led = segment.start; led <= segment.end; led += 1) {
    strip.setPixelColor(led, color);
  }
}

void clearSegment(const LockerLedSegment& segment) {
  fillSegment(segment, 0);
}

void renderLockerStatusSegment(uint8_t lockerIndex, const LockerState& state, uint32_t nowMs) {
  const LockerLedSegment segment = getLockerLedSegment(lockerIndex + 1);
  if (!segment.valid) {
    return;
  }

  if (!lockerReaderHealthy[lockerIndex]) {
    if (((nowMs / LED_READER_ERROR_BLINK_MS) % 2) == 0) {
      fillSegment(segment, colorRed(EFFECT_BRIGHTNESS));
    } else {
      clearSegment(segment);
    }
    return;
  }

  const bool panelStatusFresh = panelLockerLedStatusKnown[lockerIndex]
    && panelLockerLedStatusVersions[lockerIndex] == lockerStateVersions[lockerIndex];
  const LockerLedStatus ledStatus = getLockerLedStatus(lockerIndex, state);
  const uint32_t statusColor = colorForLockerLedStatus(ledStatus);

  if (panelStatusFresh && panelLockerItemStatuses[lockerIndex] == LockerItemStatus::UnknownTag) {
    const uint32_t phase = nowMs % LED_UNKNOWN_TAG_PULSE_MS;
    const uint32_t half = LED_UNKNOWN_TAG_PULSE_MS / 2;
    const uint8_t brightness = static_cast<uint8_t>(24 + (phase < half
      ? (96UL * phase / half)
      : (96UL * (LED_UNKNOWN_TAG_PULSE_MS - phase) / half)));
    fillSegment(segment, colorRed(brightness));
    return;
  }

  const bool doorClosed = panelStatusFresh
    ? panelLockerDoorClosed[lockerIndex]
    : (state.doorClosed && state.lockClosed);
  if (!doorClosed) {
    if (((nowMs / LED_DOOR_BLINK_MS) % 2) == 0) {
      fillSegment(segment, statusColor);
    } else {
      clearSegment(segment);
    }
    return;
  }

  fillSegment(segment, statusColor);
}

void applyStateSyncPendingOverlay(uint32_t nowMs) {
  if (!isStateSyncPending()) {
    return;
  }

  const uint16_t pos = static_cast<uint16_t>((nowMs / LED_STATE_SYNC_PENDING_MS) % TOTAL_LEDS);
  strip.setPixelColor(pos, colorYellow(180));
  if (pos > 0) {
    strip.setPixelColor(pos - 1, colorYellow(60));
  }
}

void applySyncOkOverlay(uint32_t nowMs) {
  if (!ledStripEffect.active || ledStripEffect.kind != LED_STRIP_EFFECT_SYNC_OK) {
    return;
  }

  const uint32_t elapsed = nowMs - ledStripEffect.startedAtMs;
  const uint16_t pos = static_cast<uint16_t>(min<uint32_t>(
    static_cast<uint32_t>(TOTAL_LEDS - 1),
    (elapsed * TOTAL_LEDS) / max<uint32_t>(1, ledStripEffect.durationMs)
  ));
  strip.setPixelColor(pos, colorCyan(180));
  if (pos > 0) {
    strip.setPixelColor(pos - 1, colorWhite(70));
  }
  if (pos + 1 < TOTAL_LEDS) {
    strip.setPixelColor(pos + 1, colorCyan(80));
  }
}

void applyRemoteAllOverlay(uint32_t nowMs) {
  if (!ledStripEffect.active || ledStripEffect.kind != LED_STRIP_EFFECT_REMOTE_ALL) {
    return;
  }

  const bool visible = ((nowMs / 120) % 2) == 0;
  if (visible) {
    for (uint8_t lockerNumber = 1; lockerNumber <= LOCKER_COUNT; lockerNumber += 1) {
      fillSegment(getLockerLedSegment(lockerNumber), colorWhite(170));
    }
  }
}

void applyTagAssignmentSuccessOverlay(uint32_t nowMs) {
  if (!ledStripEffect.active || ledStripEffect.kind != LED_STRIP_EFFECT_TAG_ASSIGN_SUCCESS) {
    return;
  }

  const bool visible = ((nowMs / 140) % 2) == 0;
  fillSegment(getLockerLedSegment(1), visible ? colorGreen(150) : colorCyan(80));
  fillSegment(getLockerLedSegment(2), visible ? colorCyan(120) : colorGreen(90));
  fillSegment(getLockerLedSegment(3), visible ? colorGreen(150) : colorCyan(80));
}

void applySegmentFlashOverlay(uint32_t nowMs) {
  if (!ledSegmentFlashEffect.active) {
    return;
  }

  const bool visible = ((nowMs / 110) % 2) == 0;
  if (!visible) {
    return;
  }

  if (ledSegmentFlashEffect.lockerNumber == 0) {
    for (uint8_t lockerNumber = 1; lockerNumber <= LOCKER_COUNT; lockerNumber += 1) {
      fillSegment(getLockerLedSegment(lockerNumber), ledSegmentFlashEffect.color);
    }
    return;
  }

  fillSegment(getLockerLedSegment(ledSegmentFlashEffect.lockerNumber), ledSegmentFlashEffect.color);
}

void applyBackendOfflineOverlay(uint32_t nowMs) {
  if (!isBackendOfflineSignalActive()) {
    return;
  }

  const uint32_t phase = nowMs % LED_BACKEND_OFFLINE_PULSE_MS;
  const uint32_t half = LED_BACKEND_OFFLINE_PULSE_MS / 2;
  const uint8_t brightness = static_cast<uint8_t>(20 + (phase < half
    ? (120UL * phase / half)
    : (120UL * (LED_BACKEND_OFFLINE_PULSE_MS - phase) / half)));

  for (uint16_t led = 0; led < TOTAL_LEDS; led += 6) {
    strip.setPixelColor(led, colorRed(brightness));
  }
}

void applyOnlineBreathOverlay(uint32_t nowMs) {
  if (!isDeviceWebSocketReady() || isStateSyncPending() || isBackendOfflineSignalActive()) {
    return;
  }

  const uint32_t phase = nowMs % LED_ONLINE_BREATH_MS;
  const uint32_t half = LED_ONLINE_BREATH_MS / 2;
  const uint8_t brightness = static_cast<uint8_t>(10 + (phase < half
    ? (44UL * phase / half)
    : (44UL * (LED_ONLINE_BREATH_MS - phase) / half)));

  for (uint8_t lockerNumber = 1; lockerNumber <= LOCKER_COUNT; lockerNumber += 1) {
    const LockerLedSegment segment = getLockerLedSegment(lockerNumber);
    if (segment.valid) {
      strip.setPixelColor(segment.start, colorBlue(brightness));
      strip.setPixelColor(segment.end, colorBlue(brightness));
    }
  }
}

void applyNormalLedOverlays(uint32_t nowMs) {
  applyOnlineBreathOverlay(nowMs);
  applyBackendOfflineOverlay(nowMs);
  applyStateSyncPendingOverlay(nowMs);
  applySyncOkOverlay(nowMs);
  applyRemoteAllOverlay(nowMs);
  applyTagAssignmentSuccessOverlay(nowMs);
  applySegmentFlashOverlay(nowMs);
}

void renderStartupLeds(uint32_t nowMs) {
  clearStrip();

  for (uint8_t lockerNumber = 1; lockerNumber <= LOCKER_COUNT; lockerNumber += 1) {
    const bool healthy = lockerReaderHealthy[lockerNumber - 1];
    fillSegment(
      getLockerLedSegment(lockerNumber),
      healthy ? strip.Color(0, 28, 12) : colorRed(70)
    );
  }

  const uint16_t pos = static_cast<uint16_t>((nowMs / 45) % TOTAL_LEDS);
  strip.setPixelColor(pos, colorWhite(180));

  const uint32_t masterColor = masterReaderHealthy ? colorCyan(100) : colorRed(130);
  for (uint8_t i = 0; i < 3 && i < TOTAL_LEDS; i += 1) {
    strip.setPixelColor(i, masterColor);
    strip.setPixelColor(TOTAL_LEDS - 1 - i, masterColor);
  }

  strip.show();
}

void renderLockerStatus(uint32_t nowMs) {
  clearStrip();

  for (uint8_t lockerIndex = 0; lockerIndex < LOCKER_COUNT; lockerIndex += 1) {
    const LockerState state = readLockerState(lockerIndex);
    renderLockerStatusSegment(lockerIndex, state, nowMs);
  }

  applyNormalLedOverlays(nowMs);
  strip.show();
  visualStateDirty = false;
}

void setCodeEntryGroup(uint8_t index, uint32_t color) {
  if (index >= CODE_LENGTH) {
    return;
  }

  const uint16_t start = CODE_ENTRY_LED_GROUP_STARTS[index];
  for (uint8_t offset = 0; offset < CODE_ENTRY_GROUP_SIZE; offset += 1) {
    const uint16_t ledIndex = start + offset;
    if (ledIndex < TOTAL_LEDS) {
      strip.setPixelColor(ledIndex, color);
    }
  }
}

void renderCodeEntryProgress(uint8_t count, bool verificationPending, uint32_t nowMs) {
  clearStrip();

  uint8_t visibleCount = count < CODE_LENGTH ? count : CODE_LENGTH;
  uint32_t color = colorBlue(EFFECT_BRIGHTNESS);

  if (verificationPending) {
    visibleCount = CODE_LENGTH;
    const uint32_t phase = nowMs % CODE_VERIFY_PENDING_PULSE_MS;
    const uint32_t half = CODE_VERIFY_PENDING_PULSE_MS / 2;
    const uint8_t brightness = static_cast<uint8_t>(36 + (phase < half
      ? (84UL * phase / half)
      : (84UL * (CODE_VERIFY_PENDING_PULSE_MS - phase) / half)));
    color = colorCyan(brightness);
  }

  for (uint8_t i = 0; i < visibleCount; i += 1) {
    setCodeEntryGroup(i, color);
  }

  strip.show();
  visualStateDirty = false;
}

void renderCodeEntry(uint32_t nowMs) {
  const size_t rawCount = codeVerificationPending ? strlen(pendingCode) : enteredCode.length();
  const uint8_t count = rawCount < CODE_LENGTH ? static_cast<uint8_t>(rawCount) : CODE_LENGTH;
  renderCodeEntryProgress(count, codeVerificationPending, nowMs);
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
      strip.setPixelColor(ledIndex, (i % 2 == 0) ? colorCyan(EFFECT_BRIGHTNESS) : colorGreen(EFFECT_BRIGHTNESS));
    }
  }

  strip.show();
}

void flashCodeResult(const String& code, bool success) {
  const size_t rawCount = code.length();
  uint8_t count = rawCount < CODE_LENGTH ? static_cast<uint8_t>(rawCount) : CODE_LENGTH;
  if (count == 0) {
    count = CODE_LENGTH;
  }

  codeResultFlash = {
    true,
    success,
    count,
    0,
    millis()
  };
  renderCodeResultFrame(codeResultFlash.success, codeResultFlash.count, true);
}

void serviceCodeResultFlash(unsigned long now) {
  if (!codeResultFlash.active) {
    return;
  }

  const bool visibleStage = (codeResultFlash.stage % 2) == 0;
  const unsigned long stageDuration = visibleStage ? CODE_RESULT_ON_MS : CODE_RESULT_OFF_MS;
  if (now - codeResultFlash.stageStartedMs < stageDuration) {
    return;
  }

  codeResultFlash.stageStartedMs = now;
  codeResultFlash.stage += 1;

  if (codeResultFlash.stage >= CODE_RESULT_BLINKS * 2) {
    codeResultFlash.active = false;
    markVisualStateDirty();
    updateVisualState();
    return;
  }

  renderCodeResultFrame(
    codeResultFlash.success,
    codeResultFlash.count,
    (codeResultFlash.stage % 2) == 0
  );
}

void renderCodeResultFrame(bool success, uint8_t count, bool visible) {
  clearStrip();

  if (visible) {
    const uint32_t resultColor = success ? colorGreen(EFFECT_BRIGHTNESS) : colorRed(EFFECT_BRIGHTNESS);
    for (uint8_t i = 0; i < count; i += 1) {
      setCodeEntryGroup(i, resultColor);
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
    lockerReaders[i].reader->PCD_SetAntennaGain(RFID_ANTENNA_GAIN);
    const byte version = debugPrintReaderChipVersion(lockerReaders[i]);
    lockerReaderHealthy[i] = isHealthyRfidVersion(version);
  }

  masterReaderRuntime.reader->PCD_Init();
  masterReaderRuntime.reader->PCD_SetAntennaGain(RFID_ANTENNA_GAIN);
  masterReaderHealthy = isHealthyRfidVersion(debugPrintReaderChipVersion(masterReaderRuntime));
}

void serviceRfidReaderHealth(unsigned long now) {
  if (lastRfidHealthCheckMs != 0 && now - lastRfidHealthCheckMs < RFID_HEALTH_CHECK_INTERVAL_MS) {
    return;
  }
  lastRfidHealthCheckMs = now;

  bool changed = false;
  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    const byte version = lockerReaders[i].reader->PCD_ReadRegister(MFRC522::VersionReg);
    const bool healthy = isHealthyRfidVersion(version);
    if (healthy != lockerReaderHealthy[i]) {
      lockerReaderHealthy[i] = healthy;
      changed = true;
      Serial.printf("[RFID HEALTH] locker=%u version=0x%02X healthy=%s\n",
        i + 1,
        version,
        healthy ? "true" : "false"
      );
    }
  }

  const byte masterVersion = masterReaderRuntime.reader->PCD_ReadRegister(MFRC522::VersionReg);
  const bool masterHealthy = isHealthyRfidVersion(masterVersion);
  if (masterHealthy != masterReaderHealthy) {
    masterReaderHealthy = masterHealthy;
    changed = true;
    Serial.printf("[RFID HEALTH] master version=0x%02X healthy=%s\n",
      masterVersion,
      masterHealthy ? "true" : "false"
    );
  }

  if (changed) {
    markVisualStateDirty();
  }
}

void serviceRfidReaders(unsigned long now) {
  if (now - lastRfidServiceMs < RFID_SCAN_INTERVAL_MS) {
    return;
  }

  lastRfidServiceMs = now;

  if (nextRfidReaderIndex < LOCKER_COUNT) {
    scanRfidReader(lockerReaders[nextRfidReaderIndex], now);
  } else {
    scanRfidReader(masterReaderRuntime, now);
  }

  nextRfidReaderIndex = static_cast<uint8_t>((nextRfidReaderIndex + 1) % (LOCKER_COUNT + 1));
}

bool scanRfidReader(RfidReaderRuntime& runtime, unsigned long now) {
  const RfidScanResult scanResult = readTagFromReader(runtime);
  updateReaderPresence(runtime, scanResult, now);
  return scanResult.present;
}

void updateReaderPresence(RfidReaderRuntime& runtime, const RfidScanResult& scanResult, unsigned long now) {
  if (scanResult.present) {
    runtime.lastSeenMs = now;
    runtime.missingSeenCount = 0;

    String observedLogicalTagId = scanResult.logicalTagId;
    if (
      runtime.hasCard &&
      scanResult.physicalUid.length() > 0 &&
      scanResult.physicalUid == runtime.stablePhysicalUid &&
      !scanResult.hasCustomTag &&
      runtime.stableUid.length() > 0
    ) {
      // MIFARE block reads can fail intermittently while UID reads still work.
      // Keep the last logical tag for the same physical card instead of
      // oscillating between programmed ID and physical UID.
      observedLogicalTagId = runtime.stableUid;
    }

    if (observedLogicalTagId.length() > 0) {
      if (observedLogicalTagId == runtime.candidateUid) {
        if (runtime.candidateSeenCount < RFID_PRESENT_CONFIRM_SCANS) {
          runtime.candidateSeenCount += 1;
        }
      } else {
        runtime.candidateUid = observedLogicalTagId;
        runtime.candidateSeenCount = 1;
      }

      if (runtime.candidateSeenCount < RFID_PRESENT_CONFIRM_SCANS) {
        return;
      }

      const bool uidChanged = !runtime.hasCard || observedLogicalTagId != runtime.stableUid;

      if (uidChanged) {
        runtime.stableUid = observedLogicalTagId;
        runtime.stableHasCustomTag = scanResult.hasCustomTag;
        runtime.stablePhysicalUid = scanResult.physicalUid;
        if (!runtime.isMaster) {
          markLockerStateChanged(runtime, now);
        }
        markVisualStateDirty();

        Serial.printf("[%s] tag detected: %s (physical UID: %s)%s\n",
          runtime.label,
          observedLogicalTagId.c_str(),
          scanResult.physicalUid.length() > 0 ? scanResult.physicalUid.c_str() : "(unknown)",
          scanResult.hasCustomTag ? " [programmed]" : ""
        );
      }
    }

    runtime.hasCard = true;
    if (runtime.stablePhysicalUid.length() == 0 && scanResult.physicalUid.length() > 0) {
      runtime.stablePhysicalUid = scanResult.physicalUid;
    }

    if (runtime.isMaster) {
      if (tagAssignmentMode.active) {
        if (scanResult.physicalUid.length() > 0 && scanResult.physicalUid != runtime.lastTriggeredUid) {
          runtime.lastTriggeredUid = scanResult.physicalUid;

          String error;
          const bool writeOk = tryProgramTag(*runtime.reader, scanResult.physicalUid, tagAssignmentMode.tagId, error);
          if (writeOk) {
            runtime.lastTriggeredUid = tagAssignmentMode.tagId;
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

          NetworkJob job = {};
          job.type = NetworkJobType::TagAssignmentResult;
          job.boolValue = writeOk;
          copyStringToBuffer(tagAssignmentMode.assignmentId, job.text1, sizeof(job.text1));
          copyStringToBuffer(tagAssignmentMode.tagId, job.text2, sizeof(job.text2));
          copyStringToBuffer(scanResult.physicalUid, job.text3, sizeof(job.text3));
          copyStringToBuffer(writeOk ? String("") : error, job.text4, sizeof(job.text4));
          if (!enqueueNetworkJob(job)) {
            Serial.println("Failed to queue tag assignment result.");
          }

          if (writeOk) {
            startLedStripEffect(LED_STRIP_EFFECT_TAG_ASSIGN_SUCCESS, LED_TAG_ASSIGNMENT_SUCCESS_MS);
            blinkLed(2, 220, 120);
          } else {
            startLedErrorFlash(700);
            blinkLed(4, 90, 80);
          }

          stopTagAssignmentMode();
        }
      } else if (runtime.stableUid.length() > 0 && runtime.stableUid != runtime.lastTriggeredUid) {
        if (accessSelection.active) {
          if (runtime.stableUid != accessSelection.lastBusyUid) {
            accessSelection.lastBusyUid = runtime.stableUid;
            Serial.printf("[RFID VERIFY] ignored uid=%s reason=access_selection_active activeUid=%s\n",
              runtime.stableUid.c_str(),
              accessSelection.uid.c_str()
            );
            queueAccessSelectionEvent("access_selection_busy");
            blinkLed(2, 60, 60);
          }
          runtime.lastTriggeredUid = runtime.stableUid;
          return;
        }

        if (masterTagVerificationPending) {
          Serial.printf("[RFID VERIFY] duplicate ignored uid=%s reason=pending pendingUid=%s requestId=%s\n",
            runtime.stableUid.c_str(),
            pendingMasterTagId,
            pendingMasterTagMessageId[0] != '\0' ? pendingMasterTagMessageId : "(none)"
          );
          runtime.lastTriggeredUid = runtime.stableUid;
          return;
        }

        if (
          lastVerifiedUid.length() > 0 &&
          runtime.stableUid == lastVerifiedUid &&
          now - lastVerifyStartedAtMs < VERIFY_DUPLICATE_COOLDOWN_MS
        ) {
          Serial.printf("[RFID VERIFY] ignored uid=%s reason=duplicate_tag_detected cooldownRemainingMs=%lu\n",
            runtime.stableUid.c_str(),
            static_cast<unsigned long>(VERIFY_DUPLICATE_COOLDOWN_MS - (now - lastVerifyStartedAtMs))
          );
          runtime.lastTriggeredUid = runtime.stableUid;
          return;
        }

        runtime.lastTriggeredUid = runtime.stableUid;
        setPendingMasterTag(runtime.stableUid);
        lastVerifiedUid = runtime.stableUid;
        lastVerifyStartedAtMs = now;

        NetworkJob job = {};
        job.type = NetworkJobType::VerifyMasterTag;
        copyStringToBuffer(runtime.stableUid, job.text1, sizeof(job.text1));

        if (enqueueNetworkJob(job)) {
          Serial.printf("[RFID VERIFY] queued uid=%s\n", runtime.stableUid.c_str());
        } else {
          clearPendingMasterTag();
          Serial.println("Failed to queue master RFID verification.");
        }
      }
    }

    return;
  }

  runtime.candidateSeenCount = 0;
  runtime.candidateUid = "";

  if (!runtime.hasCard) {
    if (runtime.isMaster && runtime.lastTriggeredUid.length() > 0 && now - runtime.lastSeenMs >= RFID_MASTER_REARM_DELAY_MS) {
      runtime.lastTriggeredUid = "";
    }
    return;
  }

  if (runtime.missingSeenCount < RFID_MISSING_CONFIRM_SCANS) {
    runtime.missingSeenCount += 1;
  }

  if (runtime.missingSeenCount < RFID_MISSING_CONFIRM_SCANS) {
    return;
  }

  if (now - runtime.lastSeenMs < RFID_REMOVAL_DEBOUNCE_MS) {
    return;
  }

  Serial.printf("[%s] UID removed: %s\n", runtime.label, runtime.stableUid.length() > 0 ? runtime.stableUid.c_str() : "(unknown)");
  runtime.hasCard = false;

  if (!runtime.isMaster) {
    markLockerStateChanged(runtime, now);
  } else {
    runtime.lastTriggeredUid = "";
    if (accessSelection.active) {
      Serial.println("[ACCESS SELECTION] still active after UID removed");
    }
  }

  runtime.stableUid = "";
  runtime.stableHasCustomTag = false;
  runtime.stablePhysicalUid = "";
  runtime.missingSeenCount = 0;
  markVisualStateDirty();
}

RfidScanResult readTagFromReader(RfidReaderRuntime& runtime) {
  MFRC522& reader = *runtime.reader;
  RfidScanResult result = { false, "", "", false };

  String selectedUid;
  if (!selectCardForTransaction(reader, selectedUid)) {
    return result;
  }

  result.present = true;
  result.physicalUid = selectedUid;

  const bool skipCustomTagRead = runtime.isMaster && tagAssignmentMode.active;
  if (!skipCustomTagRead) {
    String programmedTagId;
    if (tryReadProgrammedTagId(reader, programmedTagId)) {
      result.logicalTagId = programmedTagId;
      result.hasCustomTag = true;
    } else {
      result.logicalTagId = result.physicalUid;
    }
  } else {
    result.logicalTagId = result.physicalUid;
  }

  finishRfidSession(reader);
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

byte debugPrintReaderChipVersion(const RfidReaderRuntime& runtime) {
  const byte version = runtime.reader->PCD_ReadRegister(MFRC522::VersionReg);
  Serial.printf("[%s] SS=%u, MFRC522 version=0x%02X%s\n",
    runtime.label,
    runtime.ssPin,
    version,
    isHealthyRfidVersion(version) ? "" : " [reader error]"
  );
  return version;
}

bool isHealthyRfidVersion(byte version) {
  return version != 0x00 && version != 0xFF;
}

void configureHttpClient(HTTPClient& http, uint16_t responseTimeoutMs) {
  http.setConnectTimeout(HTTP_CONNECT_TIMEOUT_MS);
  http.setTimeout(responseTimeoutMs);
  http.useHTTP10(true);
  http.setReuse(false);
}

bool beginSecureRequest(HTTPClient& http, WiFiClientSecure& client, const char* url, const char* requestLabel, uint16_t responseTimeoutMs) {
  if (!isWifiReady() || wifiConnectInProgress) {
    Serial.printf("Skipping %s: WiFi is not ready for HTTPS (status=%d, connecting=%s).\n",
      requestLabel,
      static_cast<int>(WiFi.status()),
      wifiConnectInProgress ? "yes" : "no"
    );
    return false;
  }

  client.setInsecure();
  client.setHandshakeTimeout(HTTP_TLS_HANDSHAKE_TIMEOUT_SECONDS);

  if (!http.begin(client, url)) {
    Serial.printf("HTTP begin failed for %s\n", requestLabel);
    return false;
  }

  configureHttpClient(http, responseTimeoutMs);
  return true;
}

String describeHttpError(int httpCode) {
  switch (httpCode) {
    case HTTPC_ERROR_CONNECTION_REFUSED:
      return "connect failed";
    case HTTPC_ERROR_READ_TIMEOUT:
      return "read timeout";
    default:
      return HTTPClient::errorToString(httpCode);
  }
}

void logHttpFailure(const char* requestLabel, int httpCode, WiFiClientSecure& client, const String& responseBody) {
  Serial.printf("%s request failed: HTTP=%d", requestLabel, httpCode);
  if (httpCode < 0) {
    Serial.printf(" (%s)", describeHttpError(httpCode).c_str());
  }

  char tlsError[128];
  const int tlsCode = client.lastError(tlsError, sizeof(tlsError));
  if (tlsCode < 0) {
    Serial.printf(", TLS=%d (%s)", tlsCode, tlsError);
  }

  Serial.printf(
    ", WiFi=%s RSSI=%d ip=%s gateway=%s freeHeap=%u minFreeHeap=%u largestBlock=%u failures=%u\n",
    isWifiReady() ? "connected" : "disconnected",
    isWifiReady() ? WiFi.RSSI() : 0,
    isWifiReady() ? WiFi.localIP().toString().c_str() : "0.0.0.0",
    isWifiReady() ? WiFi.gatewayIP().toString().c_str() : "0.0.0.0",
    ESP.getFreeHeap(),
    ESP.getMinFreeHeap(),
    heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
    consecutiveNetworkFailureCount
  );

  if (responseBody.length() > 0) {
    Serial.printf("%s response: %s\n", requestLabel, responseBody.c_str());
  }
}

void noteNetworkSuccess() {
  consecutiveNetworkFailureCount = 0;
  nextBackgroundNetworkAttemptMs = 0;
}

void noteNetworkFailure() {
  if (consecutiveNetworkFailureCount < 255) {
    consecutiveNetworkFailureCount += 1;
  }

  const uint8_t failureLevel = min<uint8_t>(static_cast<uint8_t>(consecutiveNetworkFailureCount), 5);
  const unsigned long backoffMs = min(
    NETWORK_FAILURE_RETRY_MAX_MS,
    NETWORK_FAILURE_RETRY_BASE_MS * (1UL << (failureLevel - 1))
  );
  nextBackgroundNetworkAttemptMs = millis() + backoffMs;
}

bool isBackgroundNetworkBackoffActive(unsigned long now) {
  return nextBackgroundNetworkAttemptMs != 0 && now < nextBackgroundNetworkAttemptMs;
}

void maybeRecoverWifiAfterNetworkFailures(unsigned long now) {
  if (consecutiveNetworkFailureCount < NETWORK_FAILURES_BEFORE_WIFI_RESET) {
    return;
  }

  if (wifiConnectInProgress || !isWifiReady()) {
    return;
  }

  if (
    lastWifiRecoveryAttemptMs != 0 &&
    now - lastWifiRecoveryAttemptMs < NETWORK_WIFI_RECOVERY_COOLDOWN_MS
  ) {
    return;
  }

  lastWifiRecoveryAttemptMs = now;
  Serial.printf(
    "Detected %u consecutive network failures while WiFi stayed associated. Scheduling a calm WiFi reconnect after backoff.\n",
    consecutiveNetworkFailureCount
  );
  disconnectDeviceWebSocket();
  WiFi.disconnect(false, false);
  wifiConnectInProgress = false;
  consecutiveWifiFailureCount = min<uint8_t>(static_cast<uint8_t>(consecutiveWifiFailureCount + 1), 20);
  wifiRetryIntervalMs = min(WIFI_RETRY_MAX_MS, max(WIFI_AUTH_FAILURE_RETRY_MS, wifiRetryIntervalMs * 2));
  lastWifiRetryMs = now;
  nextBackgroundNetworkAttemptMs = now + wifiRetryIntervalMs;
}

void resetDeviceActionsPollCadence(bool verbose) {
  const unsigned long previousIntervalMs = deviceActionsPollIntervalMs;
  deviceActionsPollIntervalMs = runtimeDeviceActionsPollBaseMs;
  if (verbose && previousIntervalMs != deviceActionsPollIntervalMs) {
    Serial.printf("Device actions poll interval reset to %lu ms\n", deviceActionsPollIntervalMs);
  }
}

void relaxDeviceActionsPollCadence() {
  const unsigned long previousIntervalMs = deviceActionsPollIntervalMs;
  const unsigned long doubledIntervalMs = previousIntervalMs * 2;
  const unsigned long flooredIntervalMs = doubledIntervalMs < runtimeDeviceActionsPollBaseMs
    ? runtimeDeviceActionsPollBaseMs
    : doubledIntervalMs;
  deviceActionsPollIntervalMs = flooredIntervalMs > DEVICE_ACTIONS_POLL_INTERVAL_MAX_MS
    ? DEVICE_ACTIONS_POLL_INTERVAL_MAX_MS
    : flooredIntervalMs;

  if (deviceActionsPollIntervalMs != previousIntervalMs) {
    Serial.printf("Device actions poll interval relaxed to %lu ms\n", deviceActionsPollIntervalMs);
  }
}

void markLockerReportDirty(RfidReaderRuntime& runtime, unsigned long now) {
  runtime.reportDirty = true;
  runtime.lastReportMs = 0;
  runtime.dirtySinceMs = now;
  runtime.nextReportAttemptMs = 0;
  runtime.reportFailureCount = 0;
}

void markLockerStateChanged(RfidReaderRuntime& runtime, unsigned long now) {
  if (runtime.lockerNumber > 0 && runtime.lockerNumber <= LOCKER_COUNT) {
    const uint8_t index = runtime.lockerNumber - 1;
    uint32_t& version = lockerStateVersions[index];
    version += 1;
    if (version == 0) {
      version = 1;
    }
    panelLockerLedStatusKnown[index] = false;
    panelLockerLedStatusVersions[index] = version;
  }
  nextDeviceStateBatchAttemptMs = 0;
  markLockerReportDirty(runtime, now);
}

void noteLockerReportSuccess(RfidReaderRuntime& runtime, unsigned long now) {
  runtime.reportDirty = false;
  runtime.lastReportMs = now;
  runtime.dirtySinceMs = 0;
  runtime.nextReportAttemptMs = 0;
  runtime.reportFailureCount = 0;
}

void noteLockerReportFailure(RfidReaderRuntime& runtime, unsigned long now) {
  runtime.reportDirty = true;
  runtime.lastReportMs = 0;

  if (runtime.dirtySinceMs == 0) {
    runtime.dirtySinceMs = now;
  }

  if (runtime.reportFailureCount < 255) {
    runtime.reportFailureCount += 1;
  }

  const uint8_t failureLevel = min<uint8_t>(runtime.reportFailureCount, 5);
  const unsigned long backoffMs = min(
    LOCKER_STATUS_RETRY_MAX_MS,
    LOCKER_STATUS_RETRY_BASE_MS * (1UL << (failureLevel - 1))
  );
  runtime.nextReportAttemptMs = now + backoffMs;
}

void markAllLockerReportsDirty(unsigned long now, bool resetRetryTimers) {
  for (uint8_t i = 0; i < LOCKER_COUNT; i += 1) {
    lockerReaders[i].reportDirty = true;
    lockerReaders[i].lastReportMs = 0;
    lockerReaders[i].dirtySinceMs = now;
    if (resetRetryTimers) {
      lockerReaders[i].nextReportAttemptMs = 0;
      lockerReaders[i].reportFailureCount = 0;
    }
  }
}

String getPiccTypeName(MFRC522::PICC_Type piccType) {
  return String(MFRC522::PICC_GetTypeName(piccType));
}

void finishRfidSession(MFRC522& reader) {
  reader.PICC_HaltA();
  reader.PCD_StopCrypto1();
}

bool selectCardForTransaction(MFRC522& reader, String& selectedUid, MFRC522::StatusCode* wakeStatusOut) {
  selectedUid = "";

  byte atqa[2];
  byte atqaSize = sizeof(atqa);
  const MFRC522::StatusCode wakeStatus = reader.PICC_WakeupA(atqa, &atqaSize);

  if (wakeStatusOut != nullptr) {
    *wakeStatusOut = wakeStatus;
  }

  if (wakeStatus != MFRC522::STATUS_OK && wakeStatus != MFRC522::STATUS_COLLISION) {
    return false;
  }

  if (!reader.PICC_ReadCardSerial()) {
    reader.PCD_StopCrypto1();
    return false;
  }

  selectedUid = uidToString(reader.uid);
  return true;
}

bool authenticateClassicBlock(MFRC522& reader, byte blockAddr, MFRC522::MIFARE_Key& key, MFRC522::StatusCode* statusOut) {
  for (byte i = 0; i < 6; i += 1) {
    key.keyByte[i] = 0xFF;
  }

  const MFRC522::StatusCode status = reader.PCD_Authenticate(
    MFRC522::PICC_CMD_MF_AUTH_KEY_A,
    blockAddr,
    &key,
    &(reader.uid)
  );

  if (statusOut != nullptr) {
    *statusOut = status;
  }

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

bool tryProgramTag(MFRC522& reader, const String& expectedPhysicalUid, const String& tagId, String& error) {
  error = "";

  const MFRC522::PICC_Type piccType = reader.PICC_GetType(reader.uid.sak);
  const String piccTypeName = getPiccTypeName(piccType);
  if (DEBUG_RFID_VERBOSE) {
    Serial.printf(
      "Tag assignment candidate -> physical UID=%s, PICC type=%s, target block=%u, logical tag=%s\n",
      expectedPhysicalUid.length() > 0 ? expectedPhysicalUid.c_str() : uidToString(reader.uid).c_str(),
      piccTypeName.c_str(),
      RFID_APP_BLOCK,
      tagId.c_str()
    );
  }

  if (
    piccType != MFRC522::PICC_TYPE_MIFARE_MINI &&
    piccType != MFRC522::PICC_TYPE_MIFARE_1K &&
    piccType != MFRC522::PICC_TYPE_MIFARE_4K
  ) {
    error = String("Tag nie wspiera zapisu MIFARE Classic. Wykryty typ: ")
      + piccTypeName;
    return false;
  }

  String normalizedTagId = tagId.substring(0, 12);
  normalizedTagId.trim();
  normalizedTagId.toUpperCase();
  if (normalizedTagId.length() == 0) {
    error = "Brak logicznego ID do zapisu.";
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

  for (uint8_t attempt = 1; attempt <= RFID_AUTH_RETRY_COUNT; attempt += 1) {
    String selectedUid;
    MFRC522::StatusCode wakeStatus = MFRC522::STATUS_ERROR;
    if (!selectCardForTransaction(reader, selectedUid, &wakeStatus)) {
      if (wakeStatus == MFRC522::STATUS_OK || wakeStatus == MFRC522::STATUS_COLLISION) {
        error = "Nie udalo sie ponownie wybrac karty RFID po wybudzeniu.";
      } else {
        error = String("Nie udalo sie wybudzic karty RFID: ")
          + reader.GetStatusCodeName(wakeStatus)
          + " (kod="
          + static_cast<int>(wakeStatus)
          + ")";
      }

      if (DEBUG_RFID_VERBOSE) {
        Serial.printf(
          "RFID select attempt %u/%u failed for block %u, expected UID=%s: %s\n",
          attempt,
          RFID_AUTH_RETRY_COUNT,
          RFID_APP_BLOCK,
          expectedPhysicalUid.length() > 0 ? expectedPhysicalUid.c_str() : "(unknown)",
          error.c_str()
        );
      }

      if (attempt < RFID_AUTH_RETRY_COUNT) {
        delay(RFID_AUTH_RETRY_DELAY_MS);
      }
      continue;
    }

    if (expectedPhysicalUid.length() > 0 && selectedUid != expectedPhysicalUid) {
      finishRfidSession(reader);
      error = String("Po ponownym wyborze wykryto inny UID RFID. Oczekiwano ")
        + expectedPhysicalUid
        + ", odczytano "
        + selectedUid
        + ".";
      return false;
    }

    MFRC522::MIFARE_Key key;
    MFRC522::StatusCode authStatus = MFRC522::STATUS_ERROR;
    if (!authenticateClassicBlock(reader, RFID_APP_BLOCK, key, &authStatus)) {
      error = String("Nie udalo sie uwierzytelnic bloku RFID: ")
        + reader.GetStatusCodeName(authStatus)
        + " (kod="
        + static_cast<int>(authStatus)
        + ")";

      if (DEBUG_RFID_VERBOSE) {
        Serial.printf(
          "RFID auth attempt %u/%u failed for block %u, UID=%s: %s\n",
          attempt,
          RFID_AUTH_RETRY_COUNT,
          RFID_APP_BLOCK,
          selectedUid.c_str(),
          error.c_str()
        );
      }

      finishRfidSession(reader);

      if (attempt < RFID_AUTH_RETRY_COUNT) {
        delay(RFID_AUTH_RETRY_DELAY_MS);
      }
      continue;
    }

    const MFRC522::StatusCode writeStatus = reader.MIFARE_Write(RFID_APP_BLOCK, buffer, 16);
    if (writeStatus != MFRC522::STATUS_OK) {
      finishRfidSession(reader);
      error = String("Zapis MIFARE nie powiodl sie: ") + reader.GetStatusCodeName(writeStatus);
      return false;
    }

    byte verifyBuffer[18];
    byte verifySize = sizeof(verifyBuffer);
    const MFRC522::StatusCode verifyStatus = reader.MIFARE_Read(RFID_APP_BLOCK, verifyBuffer, &verifySize);
    if (verifyStatus != MFRC522::STATUS_OK) {
      finishRfidSession(reader);
      error = String("Weryfikacja odczytem po zapisie nie powiodla sie: ") + reader.GetStatusCodeName(verifyStatus);
      return false;
    }

    finishRfidSession(reader);

    if (memcmp(buffer, verifyBuffer, sizeof(buffer)) != 0) {
      error = "Weryfikacja zapisu RFID nie powiodla sie: odczytany blok rozni sie od zapisanego.";
      return false;
    }

    return true;
  }

  return false;
}

bool postTagAssignmentResult(const String& assignmentId, bool success, const String& tagId, const String& physicalUid, const String& error) {
  WiFiClientSecure secureClient;
  HTTPClient http;
  char url[160];
  snprintf(url, sizeof(url), "%s/device/tag-assignment-result", API_BASE_URL);

  if (!beginSecureRequest(http, secureClient, url, "/device/tag-assignment-result")) {
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  if (strlen(DEVICE_API_KEY) > 0) {
    http.addHeader("x-device-key", DEVICE_API_KEY);
  }

  JsonDocument payload;
  payload["assignmentId"] = assignmentId;
  payload["success"] = success;
  payload["tagId"] = tagId;
  payload["physicalUid"] = physicalUid;
  if (!success && error.length() > 0) {
    payload["error"] = error;
  }

  char body[256];
  const size_t bodyLen = serializeJson(payload, body, sizeof(body));

  const int httpCode = http.POST(reinterpret_cast<uint8_t*>(body), bodyLen);
  const String responseBody = http.getString();
  http.end();

  Serial.printf("Tag assignment result -> success=%s tagId=%s physicalUid=%s HTTP=%d\n",
    success ? "true" : "false",
    tagId.c_str(),
    physicalUid.c_str(),
    httpCode
  );
  if (httpCode < 200 || httpCode >= 300) {
    logHttpFailure("/device/tag-assignment-result", httpCode, secureClient, responseBody);
  }

  if (responseBody.length() > 0 && DEBUG_RFID_VERBOSE) {
    Serial.printf("Tag assignment response: %s\n", responseBody.c_str());
  }

  return httpCode >= 200 && httpCode < 300;
}
