const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getReturnBlockMessage,
  isActiveReturnSessionStatus,
  isLockerReadyForReturn
} = require("../server/services/lockerService");

test("return session active statuses are explicit", () => {
  assert.equal(isActiveReturnSessionStatus("WAITING_FOR_ITEM"), true);
  assert.equal(isActiveReturnSessionStatus("ITEM_DETECTED"), true);
  assert.equal(isActiveReturnSessionStatus("WAITING_FOR_DOOR_CLOSE"), true);
  assert.equal(isActiveReturnSessionStatus("COMPLETED"), false);
  assert.equal(isActiveReturnSessionStatus("MISMATCH"), false);
  assert.equal(isActiveReturnSessionStatus("EXPIRED"), false);
});

test("RFID-only return readiness does not require door state", () => {
  const result = isLockerReadyForReturn(
    {
      locker: 1,
      hasTag: false,
      detectedTagId: null,
      isDoorClosed: false
    },
    {
      doorSensorsEnabled: false
    },
    {
      readerOnline: true
    }
  );

  assert.equal(result.ready, true);
  assert.equal(result.reason, null);
});

test("return readiness blocks occupied and offline lockers", () => {
  const occupied = isLockerReadyForReturn(
    { locker: 2, hasTag: true, detectedTagId: "ABCD" },
    { doorSensorsEnabled: false },
    { readerOnline: true }
  );

  assert.equal(occupied.ready, false);
  assert.equal(occupied.reason, "LOCKER_OCCUPIED");

  const offline = isLockerReadyForReturn(
    { locker: 2, hasTag: false, detectedTagId: null },
    { doorSensorsEnabled: false },
    { readerOnline: false }
  );

  assert.equal(offline.ready, false);
  assert.equal(offline.reason, "LOCKER_READER_OFFLINE");
});

test("door sensors can gate future return completion mode", () => {
  const result = isLockerReadyForReturn(
    {
      locker: 3,
      hasTag: false,
      detectedTagId: null,
      isDoorClosed: false
    },
    {
      doorSensorsEnabled: true
    },
    {
      readerOnline: true
    }
  );

  assert.equal(result.ready, false);
  assert.equal(result.reason, "DOOR_NOT_CLOSED");
  assert.match(getReturnBlockMessage(result.reason, 3), /Drzwi skrytki S3/);
});
