const DEVICE_PROTOCOL_VERSION = 2;
const DEFAULT_DEVICE_ID = process.env.DEVICE_ID || "esp32-main";
const COMMAND_TERMINAL_STATUSES = new Set(["applied", "failed"]);
const COMMAND_DELIVERABLE_STATUSES = ["pending", "delivered"];

const DEFAULT_DEVICE_CONFIG = {
  heartbeatIntervalMs: 60000,
  deviceActionsPollIntervalMs: 8000,
  lockPulseMs: 700,
  remoteLogging: {
    enabled: true,
    minLevel: "info"
  },
  codeRateLimit: {
    enabled: true,
    maxFailures: 5,
    windowMs: 300000,
    lockoutMs: 30000
  },
  servicePanel: {
    enabled: true
  },
  ota: {
    enabled: true
  },
  diagnostics: {
    enabled: true
  },
  returns: {
    doorSensorsEnabled: false,
    returnSessionTimeoutSeconds: 120,
    readerFreshnessMs: 180000,
    masterScanDebounceMs: 3000
  }
};

function normalizeString(value, fallback = "") {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : fallback;
}

function normalizeDeviceId(value) {
  return normalizeString(value, DEFAULT_DEVICE_ID).slice(0, 64);
}

function normalizeMessageId(value) {
  return normalizeString(value).slice(0, 96);
}

function normalizeSequence(value) {
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

function clampNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

function normalizeBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }

  return fallback;
}

function normalizeDeviceConfig(config = {}) {
  const source = typeof config === "object" && config !== null ? config : {};
  const defaultConfig = DEFAULT_DEVICE_CONFIG;
  const remoteLogging = typeof source.remoteLogging === "object" && source.remoteLogging !== null
    ? source.remoteLogging
    : {};
  const codeRateLimit = typeof source.codeRateLimit === "object" && source.codeRateLimit !== null
    ? source.codeRateLimit
    : {};
  const servicePanel = typeof source.servicePanel === "object" && source.servicePanel !== null
    ? source.servicePanel
    : {};
  const ota = typeof source.ota === "object" && source.ota !== null
    ? source.ota
    : {};
  const diagnostics = typeof source.diagnostics === "object" && source.diagnostics !== null
    ? source.diagnostics
    : {};
  const returns = typeof source.returns === "object" && source.returns !== null
    ? source.returns
    : {};

  const minLevel = normalizeString(remoteLogging.minLevel, defaultConfig.remoteLogging.minLevel).toLowerCase();

  return {
    heartbeatIntervalMs: clampNumber(source.heartbeatIntervalMs, defaultConfig.heartbeatIntervalMs, 10000, 600000),
    deviceActionsPollIntervalMs: clampNumber(source.deviceActionsPollIntervalMs, defaultConfig.deviceActionsPollIntervalMs, 2000, 120000),
    lockPulseMs: clampNumber(source.lockPulseMs, defaultConfig.lockPulseMs, 100, 5000),
    remoteLogging: {
      enabled: normalizeBoolean(remoteLogging.enabled, defaultConfig.remoteLogging.enabled),
      minLevel: ["debug", "info", "warn", "error"].includes(minLevel) ? minLevel : defaultConfig.remoteLogging.minLevel
    },
    codeRateLimit: {
      enabled: normalizeBoolean(codeRateLimit.enabled, defaultConfig.codeRateLimit.enabled),
      maxFailures: clampNumber(codeRateLimit.maxFailures, defaultConfig.codeRateLimit.maxFailures, 1, 20),
      windowMs: clampNumber(codeRateLimit.windowMs, defaultConfig.codeRateLimit.windowMs, 30000, 3600000),
      lockoutMs: clampNumber(codeRateLimit.lockoutMs, defaultConfig.codeRateLimit.lockoutMs, 5000, 3600000)
    },
    servicePanel: {
      enabled: normalizeBoolean(servicePanel.enabled, defaultConfig.servicePanel.enabled)
    },
    ota: {
      enabled: normalizeBoolean(ota.enabled, defaultConfig.ota.enabled)
    },
    diagnostics: {
      enabled: normalizeBoolean(diagnostics.enabled, defaultConfig.diagnostics.enabled)
    },
    returns: {
      // Faza testowa bez kontaktronów: zwrot potwierdza wyłącznie RFID w skrytce.
      doorSensorsEnabled: normalizeBoolean(returns.doorSensorsEnabled, defaultConfig.returns.doorSensorsEnabled),
      returnSessionTimeoutSeconds: clampNumber(
        returns.returnSessionTimeoutSeconds,
        defaultConfig.returns.returnSessionTimeoutSeconds,
        30,
        1800
      ),
      readerFreshnessMs: clampNumber(returns.readerFreshnessMs, defaultConfig.returns.readerFreshnessMs, 10000, 900000),
      masterScanDebounceMs: clampNumber(returns.masterScanDebounceMs, defaultConfig.returns.masterScanDebounceMs, 1000, 10000)
    }
  };
}

function buildDeviceConfigResponse(deviceId = DEFAULT_DEVICE_ID, config = {}, extra = {}) {
  return {
    type: "device.config",
    ok: extra.ok !== false,
    deviceId: normalizeDeviceId(deviceId),
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    configVersion: clampNumber(extra.configVersion, 1, 1, Number.MAX_SAFE_INTEGER),
    serverTime: new Date().toISOString(),
    config: normalizeDeviceConfig(config)
  };
}

function normalizeDeviceLogPayload(payload = {}) {
  const level = normalizeString(payload.level, "info").toLowerCase();
  return {
    level: ["debug", "info", "warn", "error"].includes(level) ? level : "info",
    event: normalizeString(payload.event, "DEVICE_LOG").slice(0, 80),
    message: normalizeString(payload.message, "").slice(0, 500),
    firmware: normalizeString(payload.firmware, null),
    protocolVersion: normalizeSequence(payload.protocolVersion),
    uptimeMs: normalizeSequence(payload.uptimeMs),
    freeHeap: normalizeSequence(payload.freeHeap),
    details: typeof payload.details === "object" && payload.details !== null ? payload.details : null
  };
}

function normalizeDeviceDiagnosticPayload(payload = {}) {
  return {
    name: normalizeString(payload.name, "diagnostic").slice(0, 80),
    ok: payload.ok !== false,
    message: normalizeString(payload.message, "").slice(0, 500),
    firmware: normalizeString(payload.firmware, null),
    protocolVersion: normalizeSequence(payload.protocolVersion),
    uptimeMs: normalizeSequence(payload.uptimeMs),
    details: typeof payload.details === "object" && payload.details !== null ? payload.details : null
  };
}

function mapCommandForDevice(command) {
  const plain = typeof command.toObject === "function" ? command.toObject() : command;

  return {
    id: String(plain._id || plain.id),
    type: plain.type,
    locker: plain.locker ?? null,
    payload: plain.payload || null,
    source: plain.source || "web",
    actor: plain.actor || null,
    status: plain.status,
    deliveryCount: plain.deliveryCount || 0,
    createdAt: plain.createdAt
  };
}

function mapCommandForHistory(command) {
  const plain = typeof command.toObject === "function" ? command.toObject() : command;

  return {
    ...mapCommandForDevice(plain),
    updatedAt: plain.updatedAt || null,
    deliveredAt: plain.deliveredAt || null,
    lastDeliveryAt: plain.lastDeliveryAt || null,
    acknowledgedAt: plain.acknowledgedAt || null,
    appliedAt: plain.appliedAt || null,
    failedAt: plain.failedAt || null,
    result: plain.result || null
  };
}

function buildAck(message, extra = {}) {
  return {
    type: "ack",
    messageId: message?.messageId || null,
    ok: extra.ok !== false,
    serverTime: new Date().toISOString(),
    ...extra
  };
}

function normalizeLockerList(lockers = []) {
  if (!Array.isArray(lockers)) {
    return [];
  }

  return [...new Set(lockers
    .map(locker => Number(locker))
    .filter(locker => Number.isInteger(locker) && locker >= 1 && locker <= 31)
  )].sort((a, b) => a - b);
}

function buildAccessMaskFromLockers(lockers = []) {
  return normalizeLockerList(lockers).reduce(
    (mask, locker) => mask | (1 << (locker - 1)),
    0
  );
}

function buildTagVerifyResult(message = {}, verification = {}, extra = {}) {
  const payload = message.payload || {};
  const user = verification?.user || null;
  const item = verification?.item || null;
  const lockers = normalizeLockerList(verification?.allowedLockers);
  const maskValue = Number(verification?.accessibleLockersMask);
  const accessibleLockersMask = Number.isInteger(maskValue)
    ? (maskValue & 0xFF)
    : (buildAccessMaskFromLockers(lockers) & 0xFF);
  const uid = normalizeString(
    extra.uid
      || item?.tagId
      || user?.tagId
      || payload.tagId
      || payload.uid
  );
  const known = verification?.valid === true;
  const ok = extra.ok !== false && known;
  const displayName = normalizeString(
    extra.displayName
      || user?.name
      || item?.itemName,
    null
  );

  const result = {
    type: "tag.verify.result",
    requestId: normalizeString(message?.messageId || payload.requestId, null),
    uid,
    ok,
    known,
    isMaster: verification?.isMaster === true,
    accessibleLockersMask,
    lockers,
    userId: normalizeString(user?.id, null),
    displayName,
    serverTime: new Date().toISOString()
  };

  if (extra.error) {
    result.error = String(extra.error);
  }

  return result;
}

function buildCodeVerifyResult(message = {}, verification = {}, extra = {}) {
  const payload = message.payload || {};
  const code = normalizeString(
    extra.code
      || verification?.code
      || payload.code
  );
  const valid = verification?.valid === true;
  const locker = Number(verification?.locker);
  const result = {
    type: "code.verify.result",
    requestId: normalizeString(message?.messageId || payload.requestId, null),
    code,
    ok: extra.ok !== false,
    valid,
    locker: Number.isInteger(locker) ? locker : null,
    serverTime: new Date().toISOString()
  };

  if (extra.error) {
    result.error = String(extra.error);
  }

  return result;
}

function buildLockerStatusResult(message = {}, state = {}) {
  const lockers = Array.isArray(state?.accepted)
    ? state.accepted
      .filter(item => item?.accepted !== false)
      .map(item => ({
        locker: Number(item.locker),
        version: Number(item.version) || 0,
        hasTag: item.hasTag === true,
        isDoorClosed: item.isDoorClosed !== false,
        itemStatus: normalizeString(item.itemStatus, null),
        detectedItemKnown: typeof item.detectedItemKnown === "boolean" ? item.detectedItemKnown : null,
        severity: normalizeString(item.severity, "warn")
      }))
      .filter(item => Number.isInteger(item.locker) && item.locker >= 1 && item.locker <= 31)
    : [];

  return {
    type: "locker.status.result",
    messageId: normalizeMessageId(message?.messageId),
    serverTime: new Date().toISOString(),
    full: state?.full === true,
    lockers
  };
}

function normalizeCommandAckPayload(payload = {}) {
  const status = normalizeString(payload.status);
  const success = payload.success !== false && status !== "failed";

  return {
    commandId: normalizeString(payload.commandId || payload.actionId).slice(0, 64),
    status: status || (success ? "applied" : "failed"),
    success,
    message: normalizeString(payload.message, null)?.slice(0, 240) || null
  };
}

module.exports = {
  COMMAND_DELIVERABLE_STATUSES,
  COMMAND_TERMINAL_STATUSES,
  DEFAULT_DEVICE_CONFIG,
  DEFAULT_DEVICE_ID,
  DEVICE_PROTOCOL_VERSION,
  buildAck,
  buildCodeVerifyResult,
  buildDeviceConfigResponse,
  buildLockerStatusResult,
  buildTagVerifyResult,
  mapCommandForDevice,
  mapCommandForHistory,
  normalizeCommandAckPayload,
  normalizeDeviceConfig,
  normalizeDeviceDiagnosticPayload,
  normalizeString,
  normalizeDeviceId,
  normalizeDeviceLogPayload,
  normalizeMessageId,
  normalizeSequence
};
