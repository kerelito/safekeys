const DEVICE_PROTOCOL_VERSION = 1;
const DEFAULT_DEVICE_ID = process.env.DEVICE_ID || "esp32-main";
const COMMAND_TERMINAL_STATUSES = new Set(["applied", "failed"]);
const COMMAND_DELIVERABLE_STATUSES = ["pending", "delivered"];

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
  DEFAULT_DEVICE_ID,
  DEVICE_PROTOCOL_VERSION,
  buildAck,
  mapCommandForDevice,
  mapCommandForHistory,
  normalizeCommandAckPayload,
  normalizeDeviceId,
  normalizeMessageId,
  normalizeSequence
};
