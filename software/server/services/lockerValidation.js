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
  assertValidRecipientEmail,
  assertValidTagId,
  assertValidUserName,
  createHttpError
};
