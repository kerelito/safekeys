const test = require("node:test");
const assert = require("node:assert/strict");

const { lockerService } = require("../server/services/lockerService");

test("processDeviceEnvelope verifies keypad codes over websocket", async () => {
  const originalVerifyCode = lockerService.verifyCode;

  try {
    let captured = null;
    lockerService.verifyCode = async (code, context) => {
      captured = { code, context };
      return {
        valid: true,
        locker: 2
      };
    };

    const response = await lockerService.processDeviceEnvelope({
      type: "code.verify",
      deviceId: " esp32-test ",
      payload: {
        code: "1234"
      }
    }, {
      transport: "websocket",
      deviceId: "fallback-device"
    });

    assert.deepEqual(captured, {
      code: "1234",
      context: {
        source: "device-ws",
        actor: "esp32-test"
      }
    });
    assert.equal(response.ok, true);
    assert.deepEqual(response.verification, {
      valid: true,
      locker: 2
    });
  } finally {
    lockerService.verifyCode = originalVerifyCode;
  }
});

test("processDeviceEnvelope verifies RFID tags over websocket", async () => {
  const originalVerifyRfidTag = lockerService.verifyRfidTag;

  try {
    let captured = null;
    lockerService.verifyRfidTag = async (tagId, context) => {
      captured = { tagId, context };
      return {
        valid: true,
        user: {
          name: "Master RFID"
        },
        openedLockers: [1, 2, 3]
      };
    };

    const response = await lockerService.processDeviceEnvelope({
      type: "tag.verify",
      deviceId: "esp32-rfid",
      payload: {
        tagId: "ABCD1234"
      }
    }, {
      transport: "websocket"
    });

    assert.deepEqual(captured, {
      tagId: "ABCD1234",
      context: {
        source: "device-ws",
        actor: "esp32-rfid"
      }
    });
    assert.equal(response.ok, true);
    assert.deepEqual(response.tagVerification, {
      valid: true,
      user: {
        name: "Master RFID"
      },
      openedLockers: [1, 2, 3]
    });
  } finally {
    lockerService.verifyRfidTag = originalVerifyRfidTag;
  }
});
