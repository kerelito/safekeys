const test = require("node:test");
const assert = require("node:assert/strict");

const {
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
  normalizeDeviceId,
  normalizeDeviceLogPayload,
  normalizeMessageId,
  normalizeSequence
} = require("../server/services/deviceProtocol");

test("normalizes device envelope identity fields", () => {
  assert.equal(normalizeDeviceId("  esp32-main  "), "esp32-main");
  assert.equal(normalizeDeviceId(""), "esp32-main");
  assert.equal(normalizeMessageId("  state-abc  "), "state-abc");
  assert.equal(normalizeSequence("42"), 42);
  assert.equal(normalizeSequence("-1"), null);
  assert.equal(normalizeSequence("not-a-number"), null);
});

test("normalizes command ack payload into terminal status", () => {
  assert.deepEqual(normalizeCommandAckPayload({
    commandId: "abc123",
    success: true,
    message: "Applied"
  }), {
    commandId: "abc123",
    status: "applied",
    success: true,
    message: "Applied"
  });

  assert.deepEqual(normalizeCommandAckPayload({
    actionId: "legacy123",
    status: "failed"
  }), {
    commandId: "legacy123",
    status: "failed",
    success: false,
    message: null
  });
});

test("maps persisted command for device and history contracts", () => {
  const createdAt = new Date("2026-05-04T10:00:00.000Z");
  const command = {
    _id: "507f1f77bcf86cd799439011",
    type: "OPEN_LOCKER",
    locker: 2,
    payload: null,
    source: "web",
    actor: "Operator",
    status: "delivered",
    deliveryCount: 3,
    createdAt,
    deliveredAt: createdAt,
    result: { success: true }
  };

  assert.deepEqual(mapCommandForDevice(command), {
    id: "507f1f77bcf86cd799439011",
    type: "OPEN_LOCKER",
    locker: 2,
    payload: null,
    source: "web",
    actor: "Operator",
    status: "delivered",
    deliveryCount: 3,
    createdAt
  });

  assert.equal(mapCommandForHistory(command).result.success, true);
  assert.equal(mapCommandForHistory(command).deliveredAt, createdAt);
});

test("builds protocol ack with stable envelope metadata", () => {
  const ack = buildAck({ messageId: "heartbeat-1" }, {
    state: { accepted: [] }
  });

  assert.equal(ack.type, "ack");
  assert.equal(ack.messageId, "heartbeat-1");
  assert.equal(ack.ok, true);
  assert.deepEqual(ack.state, { accepted: [] });
  assert.match(ack.serverTime, /^\d{4}-\d{2}-\d{2}T/);
});

test("normalizes remote device config with guarded ranges", () => {
  const config = normalizeDeviceConfig({
    heartbeatIntervalMs: 1000,
    lockPulseMs: 9000,
    remoteLogging: { enabled: false, minLevel: "WARN" },
    codeRateLimit: { maxFailures: 0, windowMs: 10, lockoutMs: 2000 },
    servicePanel: { enabled: false }
  });

  assert.equal(config.heartbeatIntervalMs, 10000);
  assert.equal(config.lockPulseMs, 5000);
  assert.equal(config.remoteLogging.enabled, false);
  assert.equal(config.remoteLogging.minLevel, "warn");
  assert.equal(config.codeRateLimit.maxFailures, 1);
  assert.equal(config.codeRateLimit.windowMs, 30000);
  assert.equal(config.codeRateLimit.lockoutMs, 5000);
  assert.equal(config.servicePanel.enabled, false);
});

test("builds device config response for firmware", () => {
  const response = buildDeviceConfigResponse("esp32-test", {
    lockPulseMs: 900
  }, {
    configVersion: 12
  });

  assert.equal(response.type, "device.config");
  assert.equal(response.ok, true);
  assert.equal(response.deviceId, "esp32-test");
  assert.equal(response.configVersion, 12);
  assert.equal(response.config.lockPulseMs, 900);
});

test("normalizes device log and diagnostic payloads", () => {
  assert.deepEqual(normalizeDeviceLogPayload({
    level: "ERROR",
    event: "OTA_FAILED",
    message: "Upload failed",
    protocolVersion: 2,
    uptimeMs: "42"
  }), {
    level: "error",
    event: "OTA_FAILED",
    message: "Upload failed",
    firmware: null,
    protocolVersion: 2,
    uptimeMs: 42,
    freeHeap: null,
    details: null
  });

  assert.equal(normalizeDeviceDiagnosticPayload({
    name: "relay",
    ok: false,
    message: "L1 failed"
  }).ok, false);
});

test("builds locker status result for firmware LED sync", () => {
  const result = buildLockerStatusResult({
    messageId: "state-1"
  }, {
    full: false,
    accepted: [
      {
        locker: 1,
        accepted: true,
        version: 4,
        hasTag: true,
        isDoorClosed: true,
        itemStatus: "known",
        detectedItemKnown: true,
        severity: "ok"
      },
      {
        locker: 2,
        accepted: false,
        reason: "stale_version"
      }
    ]
  });

  assert.equal(result.type, "locker.status.result");
  assert.equal(result.messageId, "state-1");
  assert.equal(result.full, false);
  assert.deepEqual(result.lockers, [{
    locker: 1,
    version: 4,
    hasTag: true,
    isDoorClosed: true,
    itemStatus: "known",
    detectedItemKnown: true,
    severity: "ok"
  }]);
});

test("builds RFID verification result separate from transport ack", () => {
  const result = buildTagVerifyResult({
    messageId: "tagverify-7",
    payload: { tagId: "9A644335" }
  }, {
    valid: true,
    isMaster: true,
    item: {
      tagId: "9A644335",
      itemName: "Master"
    },
    user: {
      id: null,
      name: "Master",
      tagId: "9A644335"
    },
    allowedLockers: [1, 2, 3],
    accessibleLockersMask: 7
  });

  assert.equal(result.type, "tag.verify.result");
  assert.equal(result.requestId, "tagverify-7");
  assert.equal(result.uid, "9A644335");
  assert.equal(result.ok, true);
  assert.equal(result.known, true);
  assert.equal(result.isMaster, true);
  assert.equal(result.accessibleLockersMask, 7);
  assert.deepEqual(result.lockers, [1, 2, 3]);
  assert.equal(result.displayName, "Master");
});

test("builds code verification result separate from transport ack", () => {
  const result = buildCodeVerifyResult({
    messageId: "verify-9",
    payload: { code: "6996" }
  }, {
    valid: true,
    locker: 2
  });

  assert.equal(result.type, "code.verify.result");
  assert.equal(result.requestId, "verify-9");
  assert.equal(result.code, "6996");
  assert.equal(result.ok, true);
  assert.equal(result.valid, true);
  assert.equal(result.locker, 2);
  assert.match(result.serverTime, /^\d{4}-\d{2}-\d{2}T/);
});
