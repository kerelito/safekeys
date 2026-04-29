const ALLOWED_LOCKERS = [1, 2, 3];
const ALLOWED_HOURS = [2, 4, 6, 8, 12, 24];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function assertValidCode(code) {
  if (typeof code !== "string" || !/^\d{4}$/.test(code)) {
    throw createHttpError(400, "Kod musi mieć dokładnie 4 cyfry.");
  }
}

function assertValidLocker(locker) {
  if (!Number.isInteger(locker) || !ALLOWED_LOCKERS.includes(locker)) {
    throw createHttpError(400, "Nieprawidłowy numer skrytki.");
  }
}

function assertValidHours(hours) {
  if (!Number.isInteger(hours) || !ALLOWED_HOURS.includes(hours)) {
    throw createHttpError(400, "Nieprawidłowy czas ważności kodu.");
  }
}

function assertValidHasTag(hasTag) {
  if (typeof hasTag !== "boolean") {
    throw createHttpError(400, "Pole hasTag musi być typu boolean.");
  }
}

function assertValidDoorClosed(isDoorClosed) {
  if (typeof isDoorClosed !== "boolean") {
    throw createHttpError(400, "Pole isDoorClosed musi być typu boolean.");
  }
}

function normalizeTagId(tagId) {
  return typeof tagId === "string"
    ? tagId.trim().replace(/\s+/g, "").toUpperCase()
    : "";
}

function assertValidTagId(tagId) {
  const normalizedTagId = normalizeTagId(tagId);

  if (!normalizedTagId || normalizedTagId.length < 4) {
    throw createHttpError(400, "Podaj prawidlowe ID taga RFID.");
  }

  return normalizedTagId;
}

function assertValidUserName(name) {
  if (typeof name !== "string" || name.trim().length < 2) {
    throw createHttpError(400, "Podaj nazwe uzytkownika.");
  }

  return name.trim();
}

function assertValidRfidItemName(name) {
  if (typeof name !== "string" || name.trim().length < 2) {
    throw createHttpError(400, "Podaj nazwe przedmiotu RFID.");
  }

  return name.trim();
}

function assertValidRfidItemType(itemType) {
  if (!["brelok", "karta", "inne"].includes(itemType)) {
    throw createHttpError(400, "Wybierz prawidlowy typ przedmiotu RFID.");
  }

  return itemType;
}

function assertValidPanelUsername(username) {
  const normalized = typeof username === "string"
    ? username.trim().toLowerCase()
    : "";

  if (!/^[a-z0-9._-]{3,32}$/.test(normalized)) {
    throw createHttpError(400, "Login moze zawierac 3-32 znaki: litery, cyfry, kropke, myslnik lub podkreslenie.");
  }

  return normalized;
}

function assertValidPanelDisplayName(displayName) {
  if (typeof displayName !== "string" || displayName.trim().length < 2) {
    throw createHttpError(400, "Podaj nazwe wyswietlana uzytkownika panelu.");
  }

  return displayName.trim();
}

function assertValidPanelRole(role) {
  if (!["master", "admin"].includes(role)) {
    throw createHttpError(400, "Nieprawidlowa rola uzytkownika panelu.");
  }

  return role;
}

function assertValidPanelPassword(password, { required = true } = {}) {
  if (password == null || password === "") {
    if (required) {
      throw createHttpError(400, "Podaj haslo uzytkownika panelu.");
    }

    return null;
  }

  if (typeof password !== "string" || password.length < 6) {
    throw createHttpError(400, "Haslo musi miec co najmniej 6 znakow.");
  }

  return password;
}

function normalizeEmail(email) {
  return typeof email === "string"
    ? email.trim().toLowerCase()
    : "";
}

function assertValidRecipientEmail(email) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    return null;
  }

  if (!EMAIL_REGEX.test(normalizedEmail)) {
    throw createHttpError(400, "Podaj prawidlowy adres e-mail.");
  }

  return normalizedEmail;
}

function assertValidAllowedLockers(allowedLockers) {
  if (!Array.isArray(allowedLockers) || allowedLockers.length === 0) {
    throw createHttpError(400, "Wybierz co najmniej jedna skrytke.");
  }

  const normalized = [...new Set(allowedLockers.map(value => Number(value)))];

  normalized.forEach(locker => assertValidLocker(locker));
  return normalized.sort((a, b) => a - b);
}

module.exports = {
  ALLOWED_HOURS,
  ALLOWED_LOCKERS,
  assertValidAllowedLockers,
  assertValidCode,
  assertValidDoorClosed,
  assertValidHasTag,
  assertValidHours,
  assertValidLocker,
  assertValidPanelDisplayName,
  assertValidPanelPassword,
  assertValidPanelRole,
  assertValidPanelUsername,
  assertValidRecipientEmail,
  assertValidRfidItemName,
  assertValidRfidItemType,
  assertValidTagId,
  assertValidUserName,
  createHttpError
};
