const nodemailer = require("nodemailer");
const dns = require("dns");
const { promisify } = require("util");

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = process.env.SMTP_SECURE === "true";
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL;
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || "SafeKeys";

let transporter = null;
const resolve4 = promisify(dns.resolve4);

function isEmailConfigured() {
  return Boolean(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && SMTP_FROM_EMAIL);
}

function getTransporter() {
  if (!isEmailConfigured()) {
    throw new Error("Brakuje konfiguracji SMTP dla wysylki email.");
  }

  return transporter;
}

async function sendGeneratedCodeEmail({ recipientName, recipientEmail, code, locker, expiresAt }) {
  getTransporter();
  const [smtpIpv4Address] = await resolve4(SMTP_HOST);

  if (!smtpIpv4Address) {
    throw new Error("Nie udalo sie rozwiazac adresu IPv4 dla serwera SMTP.");
  }

  transporter = nodemailer.createTransport({
    host: smtpIpv4Address,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    },
    tls: {
      servername: SMTP_HOST
    }
  });

  const mailer = transporter;
  const expiresAtText = new Date(expiresAt).toLocaleString("pl-PL", {
    dateStyle: "medium",
    timeStyle: "short"
  });

  await mailer.sendMail({
    from: {
      name: SMTP_FROM_NAME,
      address: SMTP_FROM_EMAIL
    },
    to: recipientEmail,
    subject: `SafeKeys: kod dostepu do skrytki S${locker}`,
    text: [
      `Dzien dobry ${recipientName},`,
      "",
      `Twoj kod dostepu do skrytki S${locker}: ${code}`,
      `Kod jest wazny do: ${expiresAtText}`,
      "",
      "Wiadomosc wygenerowana automatycznie przez SafeKeys."
    ].join("\n"),
    html: `
      <div style="font-family: Arial, sans-serif; color: #142033; line-height: 1.6;">
        <h2 style="margin-bottom: 12px;">SafeKeys</h2>
        <p>Dzien dobry ${recipientName},</p>
        <p>Twoj kod dostepu do skrytki <strong>S${locker}</strong> jest gotowy.</p>
        <p style="font-size: 28px; letter-spacing: 0.18em; font-weight: 700; margin: 20px 0;">${code}</p>
        <p>Kod jest wazny do: <strong>${expiresAtText}</strong></p>
        <p>Wiadomosc wygenerowana automatycznie przez SafeKeys.</p>
      </div>
    `
  });
}

module.exports = {
  isEmailConfigured,
  sendGeneratedCodeEmail
};
