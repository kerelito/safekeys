const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAck,
  buildTagVerifyResult,
  mapCommandForDevice,
  mapCommandForHistory,
  normalizeCommandAckPayload,
  normalizeDeviceId,
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
