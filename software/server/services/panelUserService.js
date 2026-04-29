const crypto = require("crypto");
const mongoose = require("mongoose");
const { PanelUser } = require("../models");
const {
  assertValidPanelDisplayName,
  assertValidPanelPassword,
  assertValidPanelRole,
  assertValidPanelUsername,
  createHttpError
} = require("./lockerValidation");

const HASH_KEYLEN = 64;

function hashPassword(password) {
  const normalizedPassword = assertValidPanelPassword(password);
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(normalizedPassword, salt, HASH_KEYLEN).toString("hex");
  return `scrypt:${salt}:${derived}`;
}

function verifyPassword(password, passwordHash) {
  if (typeof password !== "string" || typeof passwordHash !== "string") {
    return false;
  }

  const [algorithm, salt, storedHash] = passwordHash.split(":");
  if (algorithm !== "scrypt" || !salt || !storedHash) {
    return false;
  }

  const derived = crypto.scryptSync(password, salt, HASH_KEYLEN).toString("hex");
  return crypto.timingSafeEqual(
    Buffer.from(derived, "hex"),
    Buffer.from(storedHash, "hex")
  );
}

function sanitizePanelUser(user) {
  return {
    _id: user._id.toString(),
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    active: user.active,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

class PanelUserService {
  async ensureSeededFromEnv() {
    const existingUsersCount = await PanelUser.countDocuments();
    if (existingUsersCount > 0) {
      return;
    }

    const seedUsers = [1, 2, 3]
      .map(index => ({
        username: process.env[`ADMIN_${index}_USERNAME`],
        password: process.env[`ADMIN_${index}_PASSWORD`],
        displayName: process.env[`ADMIN_${index}_DISPLAY_NAME`]
      }))
      .filter(user => user.username && user.password && user.displayName);

    if (seedUsers.length === 0) {
      throw new Error("Brakuje kont panelu w bazie i nie znaleziono danych startowych ADMIN_* w zmiennych środowiskowych.");
    }

    const normalizedSeedUsers = seedUsers.map((user, index) => {
      const username = assertValidPanelUsername(user.username);
      return {
        username,
        displayName: assertValidPanelDisplayName(user.displayName),
        passwordHash: hashPassword(user.password),
        role: index === 0 || username === "admin" ? "master" : "admin",
        active: true,
        createdAt: new Date(),
        updatedAt: new Date()
      };
    });

    await PanelUser.insertMany(normalizedSeedUsers);
  }

  async authenticate(username, password) {
    const normalizedUsername = assertValidPanelUsername(username);
    const user = await PanelUser.findOne({ username: normalizedUsername, active: true });

    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw createHttpError(401, "Nieprawidlowy login lub haslo.");
    }

    return sanitizePanelUser(user);
  }

  async getPanelUsers() {
    const users = await PanelUser.find().sort({ role: 1, displayName: 1 }).lean();
    return users.map(sanitizePanelUser);
  }

  async createPanelUser(payload) {
    const username = assertValidPanelUsername(payload.username);
    const displayName = assertValidPanelDisplayName(payload.displayName);
    const role = assertValidPanelRole(payload.role);
    const password = assertValidPanelPassword(payload.password);

    const existing = await PanelUser.findOne({ username });
    if (existing) {
      throw createHttpError(409, "Uzytkownik panelu z takim loginem juz istnieje.");
    }

    const user = await PanelUser.create({
      username,
      displayName,
      role,
      active: true,
      passwordHash: hashPassword(password),
      updatedAt: new Date()
    });

    return sanitizePanelUser(user);
  }

  async updatePanelUser(userId, payload, context = {}) {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw createHttpError(400, "Nieprawidlowe ID uzytkownika panelu.");
    }

    const user = await PanelUser.findById(userId);
    if (!user) {
      throw createHttpError(404, "Nie znaleziono uzytkownika panelu.");
    }

    const username = assertValidPanelUsername(payload.username);
    const displayName = assertValidPanelDisplayName(payload.displayName);
    const role = assertValidPanelRole(payload.role);
    const password = assertValidPanelPassword(payload.password, { required: false });

    const existing = await PanelUser.findOne({ username, _id: { $ne: userId } });
    if (existing) {
      throw createHttpError(409, "Inny uzytkownik panelu ma juz ten login.");
    }

    if (context.currentUserId && user._id.toString() === context.currentUserId && role !== "master") {
      throw createHttpError(400, "Nie mozna odebrac sobie roli master.");
    }

    if (user.role === "master" && role !== "master") {
      const mastersCount = await PanelUser.countDocuments({ role: "master", active: true });
      if (mastersCount <= 1) {
        throw createHttpError(400, "W systemie musi pozostac przynajmniej jeden aktywny uzytkownik master.");
      }
    }

    user.username = username;
    user.displayName = displayName;
    user.role = role;
    user.updatedAt = new Date();

    if (password) {
      user.passwordHash = hashPassword(password);
    }

    await user.save();
    return sanitizePanelUser(user);
  }

  async deletePanelUser(userId, context = {}) {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw createHttpError(400, "Nieprawidlowe ID uzytkownika panelu.");
    }

    const user = await PanelUser.findById(userId);
    if (!user) {
      throw createHttpError(404, "Nie znaleziono uzytkownika panelu.");
    }

    if (context.currentUserId && user._id.toString() === context.currentUserId) {
      throw createHttpError(400, "Nie mozna usunac aktualnie zalogowanego uzytkownika.");
    }

    if (user.role === "master") {
      const mastersCount = await PanelUser.countDocuments({ role: "master", active: true });
      if (mastersCount <= 1) {
        throw createHttpError(400, "Nie mozna usunac ostatniego uzytkownika master.");
      }
    }

    await user.deleteOne();
    return sanitizePanelUser(user);
  }
}

module.exports = {
  panelUserService: new PanelUserService()
};
