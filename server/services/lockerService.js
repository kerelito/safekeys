const { EventEmitter } = require("events");
const mongoose = require("mongoose");
const { Code, Log, Locker, RfidUser } = require("../models");
const {
  ALLOWED_LOCKERS,
  assertValidAllowedLockers,
  assertValidCode,
  assertValidDoorClosed,
  assertValidHasTag,
  assertValidHours,
  assertValidLocker,
  assertValidRecipientEmail,
  assertValidTagId,
  assertValidUserName,
  createHttpError
} = require("./lockerValidation");

function parseGenerateCodeInput(lockerOrPayload, hours) {
  if (typeof lockerOrPayload === "object" && lockerOrPayload !== null) {
    return {
      locker: Number(lockerOrPayload.locker),
      hours: Number(lockerOrPayload.hours),
      recipientEmail: assertValidRecipientEmail(lockerOrPayload.recipientEmail || lockerOrPayload.email)
    };
  }

  return {
    locker: lockerOrPayload,
    hours,
    recipientEmail: null
  };
}

function normalizeEmailError(message) {
  if (typeof message !== "string" || !message.trim()) {
    return "Nie udało się wysłać wiadomości e-mail.";
  }

  return message.trim().slice(0, 240);
}

class LockerService extends EventEmitter {
  constructor() {
    super();
    this.pendingRemoteActions = [];
    this.emailService = null;
  }

  setEmailService(emailService) {
    this.emailService = emailService;
  }

  async createLog(payload) {
    const log = await Log.create({
      source: payload.source || "system",
      actor: payload.actor || null,
      ...payload,
      timestamp: payload.timestamp ?? new Date()
    });

    this.emit("log", log);
    return log;
  }

  async generateUniqueCode() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = Math.floor(1000 + Math.random() * 9000).toString();
      const existing = await Code.exists({ code, active: true, expiresAt: { $gt: new Date() } });

      if (!existing) {
        return code;
      }
    }

    throw createHttpError(503, "Nie udało się wygenerować unikalnego kodu. Spróbuj ponownie.");
  }

  async verifyCode(code, context = {}) {
    assertValidCode(code);
    const found = await Code.findOne({ code, active: true });

    if (!found || new Date() > found.expiresAt) {
      await this.createLog({
        event: "INVALID_CODE",
        code,
        success: false,
        source: context.source || "device",
        actor: context.actor || null
      });

      return { valid: false };
    }

    await this.createLog({
      event: "LOCKER_OPENED",
      code,
      locker: found.locker,
      success: true,
      source: context.source || "device",
      actor: context.actor || null
    });

    return {
      valid: true,
      locker: found.locker
    };
  }

  async deliverCodeByEmail(codeRecord, context = {}) {
    const recipientEmail = codeRecord.recipientEmail;
    const attemptedResponse = {
      attempted: true,
      sent: false,
      recipientEmail,
      sentAt: null,
      error: null
    };

    if (!recipientEmail) {
      return {
        attempted: false,
        sent: false,
        recipientEmail: null,
        sentAt: null,
        error: null
      };
    }

    if (!this.emailService || !this.emailService.isEnabled()) {
      const errorMessage = "Wysylka e-mail nie jest skonfigurowana na serwerze.";

      codeRecord.emailDeliveryAttempted = true;
      codeRecord.emailDeliveryError = errorMessage;
      await codeRecord.save();

      await this.createLog({
        event: "CODE_EMAIL_FAILED",
        code: codeRecord.code,
        locker: codeRecord.locker,
        source: context.source || "web",
        actor: context.actor || null
      });

      return {
        ...attemptedResponse,
        error: errorMessage
      };
    }

    try {
      await this.emailService.sendGeneratedCodeEmail({
        to: recipientEmail,
        code: codeRecord.code,
        locker: codeRecord.locker,
        expiresAt: codeRecord.expiresAt,
        requestedBy: context.actor || null
      });

      codeRecord.emailDeliveryAttempted = true;
      codeRecord.emailSentAt = new Date();
      codeRecord.emailDeliveryError = null;
      await codeRecord.save();

      await this.createLog({
        event: "CODE_EMAIL_SENT",
        code: codeRecord.code,
        locker: codeRecord.locker,
        source: context.source || "web",
        actor: context.actor || null
      });

      return {
        ...attemptedResponse,
        sent: true,
        sentAt: codeRecord.emailSentAt
      };
    } catch (error) {
      const errorMessage = normalizeEmailError(error.message);

      codeRecord.emailDeliveryAttempted = true;
      codeRecord.emailDeliveryError = errorMessage;
      await codeRecord.save();

      await this.createLog({
        event: "CODE_EMAIL_FAILED",
        code: codeRecord.code,
        locker: codeRecord.locker,
        source: context.source || "web",
        actor: context.actor || null
      });

      return {
        ...attemptedResponse,
        error: errorMessage
      };
    }
  }

  async generateCode(lockerOrPayload, hoursOrContext, maybeContext = {}) {
    const { locker, hours, recipientEmail } = parseGenerateCodeInput(lockerOrPayload, hoursOrContext);
    const context = typeof lockerOrPayload === "object" && lockerOrPayload !== null
      ? (hoursOrContext || {})
      : maybeContext;

    assertValidLocker(locker);
    assertValidHours(hours);

    const code = await this.generateUniqueCode();
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

    const codeRecord = await Code.create({
      code,
      locker,
      active: true,
      expiresAt,
      recipientEmail
    });

    await this.createLog({
      event: "CODE_GENERATED",
      code,
      locker,
      source: context.source || "web",
      actor: context.actor || null
    });

    const emailDelivery = await this.deliverCodeByEmail(codeRecord, context);

    return {
      code,
      locker,
      hours,
      expiresAt,
      recipientEmail,
      emailDelivery
    };
  }

  async deactivateCode(code, context = {}) {
    assertValidCode(code);

    const found = await Code.findOne({ code, active: true });
    if (!found) {
      throw createHttpError(404, "Nie znaleziono aktywnego kodu.");
    }

    found.active = false;
    await found.save();

    await this.createLog({
      event: "CODE_DEACTIVATED",
      code,
      locker: found.locker,
      source: context.source || "web",
      actor: context.actor || null
    });

    return { success: true };
  }

  async getLockers() {
    const data = await Locker.find();

    return ALLOWED_LOCKERS.map(num => {
      const found = data.find(item => item.locker === num);
      return {
        locker: num,
        hasTag: found ? found.hasTag : false,
        isDoorClosed: found ? found.isDoorClosed !== false : true
      };
    });
  }

  async updateLockerStatus(locker, hasTag, context = {}) {
    assertValidLocker(locker);
    assertValidHasTag(hasTag);

    let found = await Locker.findOne({ locker });
    const prev = found ? found.hasTag : null;

    if (!found) {
      found = await Locker.create({ locker, hasTag });
    } else {
      found.hasTag = hasTag;
      await found.save();
    }

    if (prev !== null && prev === true && hasTag === false) {
      await this.createLog({
        event: "KEY_REMOVED",
        locker,
        source: context.source || "rfid",
        actor: context.actor || null
      });
    }

    if (prev !== null && prev === false && hasTag === true) {
      await this.createLog({
        event: "KEY_RETURNED",
        locker,
        source: context.source || "rfid",
        actor: context.actor || null
      });
    }

    return { success: true };
  }

  async updateLockerDoorStatus(locker, isDoorClosed, context = {}) {
    assertValidLocker(locker);
    assertValidDoorClosed(isDoorClosed);

    let found = await Locker.findOne({ locker });
    const prev = found ? found.isDoorClosed !== false : null;

    if (!found) {
      found = await Locker.create({ locker, hasTag: false, isDoorClosed });
    } else {
      found.isDoorClosed = isDoorClosed;
      await found.save();
    }

    if (prev !== null && prev !== isDoorClosed) {
      await this.createLog({
        event: isDoorClosed ? "LOCKER_DOOR_CLOSED" : "LOCKER_DOOR_OPENED",
        locker,
        source: context.source || "contactron",
        actor: context.actor || null
      });
    }

    return { success: true };
  }

  createRemoteAction(type, locker, context = {}) {
    const action = {
      id: new mongoose.Types.ObjectId().toString(),
      type,
      locker: locker ?? null,
      createdAt: new Date(),
      source: context.source || "web",
      actor: context.actor || null
    };

    this.pendingRemoteActions.push(action);
    this.emit("remote-action-queued", action);
    return action;
  }

  async openLocker(locker, context = {}) {
    assertValidLocker(locker);

    const action = this.createRemoteAction("OPEN_LOCKER", locker, context);
    await this.createLog({
      event: "REMOTE_UNLOCK_REQUESTED",
      locker,
      source: context.source || "web",
      actor: context.actor || null
    });

    return {
      success: true,
      actionId: action.id,
      locker
    };
  }

  async releaseAllLockers(context = {}) {
    const action = this.createRemoteAction("RELEASE_ALL_LOCKERS", null, context);
    await this.createLog({
      event: "REMOTE_RELEASE_ALL_REQUESTED",
      source: context.source || "web",
      actor: context.actor || null
    });

    return {
      success: true,
      actionId: action.id
    };
  }

  async consumeRemoteActions() {
    const actions = [...this.pendingRemoteActions];
    this.pendingRemoteActions = [];
    return actions;
  }

  async getActiveCodes() {
    const now = new Date();

    await Code.updateMany(
      { active: true, expiresAt: { $lte: now } },
      { $set: { active: false } }
    );

    return Code.find({
      active: true,
      expiresAt: { $gt: now }
    }).sort({ expiresAt: 1 });
  }

  async getLogs() {
    return Log.find().sort({ timestamp: -1 }).limit(50);
  }

  async getRfidUsers() {
    return RfidUser.find().sort({ name: 1 }).lean();
  }

  async createRfidUser(payload, context = {}) {
    const name = assertValidUserName(payload.name);
    const tagId = assertValidTagId(payload.tagId);
    const allowedLockers = assertValidAllowedLockers(payload.allowedLockers);

    const existing = await RfidUser.findOne({ tagId });
    if (existing) {
      throw createHttpError(409, "Uzytkownik z tym tagiem RFID juz istnieje.");
    }

    const user = await RfidUser.create({
      name,
      tagId,
      allowedLockers,
      updatedAt: new Date()
    });

    await this.createLog({
      event: "RFID_USER_CREATED",
      source: context.source || "web",
      actor: `${context.actor || "system"} • ${name} • ${tagId}`
    });

    return user.toObject();
  }

  async updateRfidUser(userId, payload, context = {}) {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw createHttpError(400, "Nieprawidlowe ID uzytkownika.");
    }

    const name = assertValidUserName(payload.name);
    const tagId = assertValidTagId(payload.tagId);
    const allowedLockers = assertValidAllowedLockers(payload.allowedLockers);
    const user = await RfidUser.findById(userId);

    if (!user) {
      throw createHttpError(404, "Nie znaleziono uzytkownika RFID.");
    }

    const existingWithTag = await RfidUser.findOne({ tagId, _id: { $ne: userId } });
    if (existingWithTag) {
      throw createHttpError(409, "Inny uzytkownik ma juz ten tag RFID.");
    }

    user.name = name;
    user.tagId = tagId;
    user.allowedLockers = allowedLockers;
    user.updatedAt = new Date();
    await user.save();

    await this.createLog({
      event: "RFID_USER_UPDATED",
      source: context.source || "web",
      actor: `${context.actor || "system"} • ${name} • ${tagId}`
    });

    return user.toObject();
  }

  async deleteRfidUser(userId, context = {}) {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw createHttpError(400, "Nieprawidlowe ID uzytkownika.");
    }

    const user = await RfidUser.findById(userId);
    if (!user) {
      throw createHttpError(404, "Nie znaleziono uzytkownika RFID.");
    }

    await user.deleteOne();

    await this.createLog({
      event: "RFID_USER_DELETED",
      source: context.source || "web",
      actor: `${context.actor || "system"} • ${user.name} • ${user.tagId}`
    });

    return { success: true };
  }

  async verifyRfidTag(tagId, context = {}) {
    const normalizedTagId = assertValidTagId(tagId);
    const user = await RfidUser.findOne({ tagId: normalizedTagId, active: true });

    if (!user) {
      await this.createLog({
        event: "RFID_ACCESS_DENIED",
        source: context.source || "rfid-user",
        actor: normalizedTagId
      });

      return {
        valid: false
      };
    }

    const openedLockers = [];

    for (const locker of user.allowedLockers) {
      await this.openLocker(locker, {
        source: context.source || "rfid-user",
        actor: `${user.name} • ${user.tagId}`
      });
      openedLockers.push(locker);
    }

    await this.createLog({
      event: "RFID_ACCESS_GRANTED",
      source: context.source || "rfid-user",
      actor: `${user.name} • ${user.tagId}`,
      success: true
    });

    return {
      valid: true,
      user: {
        id: user._id.toString(),
        name: user.name,
        tagId: user.tagId
      },
      allowedLockers: [...user.allowedLockers],
      openedLockers
    };
  }

  async clearLogs(context = {}) {
    await Log.deleteMany({});
    this.emit("logs-cleared", {
      source: context.source || "web",
      actor: context.actor || null
    });
    return { success: true };
  }
}

module.exports = {
  lockerService: new LockerService(),
  createHttpError
};
