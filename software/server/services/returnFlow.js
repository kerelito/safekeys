const {
  RFID_ITEM_STATUSES,
  assertValidRfidItemStatus,
  normalizeAssignedLocker
} = require("./lockerValidation");

const RETURN_ACTIVE_STATUSES = ["PENDING", "IN_PROGRESS"];
const RETURN_ITEM_ACTIVE_STATUSES = ["RETURN_PENDING", "RETURN_IN_PROGRESS"];
const RETURN_COMPLETION_STATUSES = ["COMPLETED", "FAILED", "EXPIRED", "CANCELLED"];
const RETURN_ALLOWED_ITEM_STATUSES = ["CHECKED_OUT"];

function normalizeRfidItemStatus(status, assignedLocker) {
  if (status === null || status === undefined || status === "") {
    return assignedLocker ? "IN_LOCKER" : "UNASSIGNED";
  }

  if (RFID_ITEM_STATUSES.includes(status)) {
    return assertValidRfidItemStatus(status);
  }

  return assertValidRfidItemStatus(status);
}

function normalizeRfidItemPayload(payload = {}, previous = null) {
  const assignedLocker = normalizeAssignedLocker(payload.assignedLocker);
  const status = normalizeRfidItemStatus(payload.status, assignedLocker);

  return {
    assignedLocker,
    status: assignedLocker ? status : "UNASSIGNED",
    currentLocker: assignedLocker && status === "IN_LOCKER" ? assignedLocker : null,
    conflictReason: status === "CONFLICT" ? (previous?.conflictReason || "manual_status") : null
  };
}

function isReturnEligibleItem(item = {}) {
  return RETURN_ALLOWED_ITEM_STATUSES.includes(item.status);
}

function isActiveReturnStatus(status) {
  return RETURN_ACTIVE_STATUSES.includes(status);
}

function mapReturnSession(session) {
  if (!session) {
    return null;
  }

  const plain = typeof session.toObject === "function" ? session.toObject() : session;
  const startedAt = plain.startedAt || plain.createdAt || null;
  const expiresAt = plain.expiresAt || null;
  const completedAt = plain.completedAt || null;
  const failedAt = plain.failedAt || null;
  const now = Date.now();
  const expiresTime = expiresAt ? new Date(expiresAt).getTime() : null;
  const remainingMs = isActiveReturnStatus(plain.status) && Number.isFinite(expiresTime)
    ? Math.max(0, expiresTime - now)
    : 0;

  return {
    id: String(plain._id || plain.id || ""),
    sessionId: plain.sessionId,
    itemId: plain.itemId ? String(plain.itemId) : null,
    itemName: plain.itemName,
    tagUid: plain.tagUid,
    assignedLocker: plain.assignedLocker,
    status: plain.status,
    startedAt,
    expiresAt,
    completedAt,
    failedAt,
    failureReason: plain.failureReason || null,
    sourceReader: plain.sourceReader || null,
    doorOpenedAt: plain.doorOpenedAt || null,
    doorClosedAt: plain.doorClosedAt || null,
    rfidDetectedAt: plain.rfidDetectedAt || null,
    createdBy: plain.createdBy || null,
    deviceId: plain.deviceId || null,
    commandId: plain.commandId || null,
    detectedUid: plain.detectedUid || null,
    detectedLocker: plain.detectedLocker || null,
    doorClosed: typeof plain.doorClosed === "boolean" ? plain.doorClosed : null,
    rfidOnly: plain.rfidOnly === true,
    diagnostics: plain.diagnostics || {},
    remainingMs,
    durationMs: completedAt || failedAt
      ? new Date(completedAt || failedAt).getTime() - new Date(startedAt).getTime()
      : null,
    createdAt: plain.createdAt || null,
    updatedAt: plain.updatedAt || null
  };
}

module.exports = {
  RETURN_ACTIVE_STATUSES,
  RETURN_ITEM_ACTIVE_STATUSES,
  RETURN_COMPLETION_STATUSES,
  isActiveReturnStatus,
  isReturnEligibleItem,
  mapReturnSession,
  normalizeRfidItemPayload,
  normalizeRfidItemStatus
};
