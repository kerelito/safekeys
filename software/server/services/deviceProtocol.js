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
  DEFAULT_DEVICE_ID,
  DEVICE_PROTOCOL_VERSION,
  buildAck,
  buildLockerStatusResult,
  buildTagVerifyResult,
  mapCommandForDevice,
  mapCommandForHistory,
  normalizeCommandAckPayload,
  normalizeString,
  normalizeDeviceId,
  normalizeMessageId,
  normalizeSequence
};
