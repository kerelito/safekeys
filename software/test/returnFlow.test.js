const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isReturnEligibleItem,
  mapReturnSession,
  normalizeRfidItemPayload,
  normalizeRfidItemStatus
} = require("../server/services/returnFlow");

test("normalizes RFID item return fields from assignment and status", () => {
  assert.equal(normalizeRfidItemStatus("", 1), "IN_LOCKER");
  assert.equal(normalizeRfidItemStatus(null, null), "UNASSIGNED");
  assert.equal(normalizeRfidItemStatus("CHECKED_OUT", 2), "CHECKED_OUT");

  assert.deepEqual(normalizeRfidItemPayload({ assignedLocker: "2" }), {
    assignedLocker: 2,
    status: "IN_LOCKER",
    currentLocker: 2,
    conflictReason: null
  });

  assert.deepEqual(normalizeRfidItemPayload({
    assignedLocker: "",
    status: "CHECKED_OUT"
  }), {
    assignedLocker: null,
    status: "UNASSIGNED",
    currentLocker: null,
    conflictReason: null
  });

  assert.deepEqual(normalizeRfidItemPayload({
    assignedLocker: 3,
    status: "CHECKED_OUT"
  }, {
    currentLocker: 3,
    conflictReason: "old_conflict"
  }), {
    assignedLocker: 3,
    status: "CHECKED_OUT",
    currentLocker: null,
    conflictReason: null
  });
});

test("rejects unsupported RFID item status values", () => {
  assert.throws(
    () => normalizeRfidItemStatus("MISSING_FROM_REPO", 1),
    error => error.status === 400
  );
});

test("only checked out RFID items can start a return session", () => {
  assert.equal(isReturnEligibleItem({ status: "CHECKED_OUT" }), true);
  assert.equal(isReturnEligibleItem({ status: "IN_LOCKER" }), false);
  assert.equal(isReturnEligibleItem({ status: "RETURN_PENDING" }), false);
  assert.equal(isReturnEligibleItem({ status: "UNASSIGNED" }), false);
});

test("maps return sessions with active countdown and terminal duration", () => {
  const now = Date.now();
  const active = mapReturnSession({
    _id: "session-object-id",
    sessionId: "return-session-1",
    itemId: "item-object-id",
    itemName: "Brelok testowy",
    tagUid: "9A644335",
    assignedLocker: 2,
    status: "IN_PROGRESS",
    startedAt: new Date(now - 1000),
    expiresAt: new Date(now + 60000),
    diagnostics: { timeoutMs: 120000 }
  });

  assert.equal(active.sessionId, "return-session-1");
  assert.equal(active.assignedLocker, 2);
  assert.equal(active.rfidOnly, false);
  assert.equal(active.remainingMs > 0, true);
  assert.equal(active.remainingMs <= 60000, true);
  assert.equal(active.durationMs, null);

  const completed = mapReturnSession({
    sessionId: "return-session-2",
    itemId: "item-object-id",
    itemName: "Brelok testowy",
    tagUid: "9A644335",
    assignedLocker: 1,
    status: "COMPLETED",
    startedAt: new Date(now - 5000),
    completedAt: new Date(now),
    rfidOnly: true
  });

  assert.equal(completed.remainingMs, 0);
  assert.equal(completed.durationMs, 5000);
  assert.equal(completed.rfidOnly, true);
});
