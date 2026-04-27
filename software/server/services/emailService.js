const nodemailer = require("nodemailer");
const https = require("https");

function parseSecureFlag(value, port) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    return /^(1|true|yes|on)$/i.test(value.trim());
  }

  return Number(port) === 465;
}

function formatExpiry(value) {
  return new Date(value).toLocaleString("pl-PL", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function createDisabledEmailService(reason) {
  return {
    isEnabled() {
      return false;
    },
    getStatus() {
      return {
        enabled: false,
        reason
      };
    },
    async verifyConnection() {
      return false;
    },
    async sendGeneratedCodeEmail() {
      const error = new Error(reason);
      error.code = "EMAIL_NOT_CONFIGURED";
      throw error;
    }
  };
}

function createRequestError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

function postJson(url, headers, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Accept: "application/json",
        ...headers
      }
    }, response => {
      let body = "";

      response.setEncoding("utf8");
      response.on("data", chunk => {
        body += chunk;
      });

      response.on("end", () => {
        const contentType = response.headers["content-type"] || "";
        const isJson = contentType.includes("application/json");
        const parsedBody = isJson && body ? JSON.parse(body) : body;

        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(parsedBody);
          return;
        }

        reject(createRequestError("Brevo API request failed.", {
          code: "BREVO_API_ERROR",
          responseStatus: response.statusCode,
          responseBody: parsedBody
        }));
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(createRequestError("Connection timeout", { code: "ETIMEDOUT" }));
    });

    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

function createBrevoEmailService(config = {}) {
  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const fromEmail = typeof config.fromEmail === "string" && config.fromEmail.trim()
    ? config.fromEmail.trim()
    : "";
  const fromName = typeof config.fromName === "string" && config.fromName.trim()
    ? config.fromName.trim()
    : "SafeKeys";
  const replyTo = typeof config.replyTo === "string" && config.replyTo.trim()
    ? config.replyTo.trim()
    : undefined;

  if (!apiKey || !fromEmail) {
    return null;
  }

  const endpoint = "https://api.brevo.com/v3/smtp/email";

  function enrichApiError(error) {
    if (!error || typeof error !== "object") {
      return error;
    }

    error.emailProvider = "brevo-api";
    error.apiEndpoint = endpoint;
    return error;
  }

  return {
    isEnabled() {
      return true;
    },
    getStatus() {
      return {
        enabled: true,
        provider: "brevo-api",
        fromEmail,
        fromName
      };
    },
    async verifyConnection() {
      return true;
    },
    async sendGeneratedCodeEmail(payload) {
      const requestedByLine = payload.requestedBy
        ? `<p style="margin: 0 0 16px; color: #55657c; font-size: 14px;">Kod wygenerowany przez: <strong>${payload.requestedBy}</strong></p>`
        : "";

      const requestBody = JSON.stringify({
        sender: {
          name: fromName,
          email: fromEmail
        },
        to: [
          {
            email: payload.to
          }
        ],
        replyTo: replyTo ? { email: replyTo } : undefined,
        subject: `SafeKeys: kod dostepu do skrytki S${payload.locker}`,
        textContent: [
          `Wygenerowano nowy kod dostepu do skrytki S${payload.locker}.`,
          "",
          `Kod: ${payload.code}`,
          `Wygasa: ${formatExpiry(payload.expiresAt)}`,
          payload.requestedBy ? `Wygenerowano przez: ${payload.requestedBy}` : null,
          "",
          "Ta wiadomosc zostala wyslana automatycznie przez SafeKeys."
        ].filter(Boolean).join("\n"),
        htmlContent: `
          <div style="background: #f4f7fb; padding: 24px; font-family: Arial, sans-serif; color: #102038;">
            <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 20px; border: 1px solid #d8e2f1; padding: 32px;">
              <p style="margin: 0 0 10px; font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: #667892;">SafeKeys</p>
              <h1 style="margin: 0 0 12px; font-size: 28px; line-height: 1.1;">Nowy kod dostepu do skrytki S${payload.locker}</h1>
              <p style="margin: 0 0 20px; color: #55657c; font-size: 15px;">Ponizej znajdziesz kod wygenerowany w panelu SafeKeys.</p>
              <div style="margin: 0 0 20px; padding: 18px 20px; border-radius: 18px; background: #eef4ff; border: 1px solid #d8e2f1;">
                <p style="margin: 0 0 10px; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: #667892;">Kod dostepu</p>
                <p style="margin: 0; font-size: 34px; font-weight: 700; letter-spacing: 0.22em; color: #102038;">${payload.code}</p>
              </div>
              <p style="margin: 0 0 8px; color: #102038; font-size: 15px;"><strong>Waznosc:</strong> ${formatExpiry(payload.expiresAt)}</p>
              ${requestedByLine}
              <p style="margin: 0; color: #7a879b; font-size: 13px;">Wiadomosc zostala wyslana automatycznie. Jesli nie oczekiwales tego kodu, skontaktuj sie z administratorem SafeKeys.</p>
            </div>
          </div>
        `
      });

      try {
        return await postJson(endpoint, {
          "api-key": apiKey
        }, requestBody);
      } catch (error) {
        throw enrichApiError(error);
      }
    }
  };
}

function createEmailService(config = {}) {
  const brevoApiService = createBrevoEmailService(config);

  if (brevoApiService) {
    return brevoApiService;
  }

  const host = typeof config.host === "string" ? config.host.trim() : "";
  const port = Number(config.port) || 587;
  const secure = parseSecureFlag(config.secure, port);
  const user = typeof config.user === "string" ? config.user.trim() : "";
  const pass = typeof config.pass === "string" ? config.pass : "";
  const fromEmail = typeof config.fromEmail === "string" && config.fromEmail.trim()
    ? config.fromEmail.trim()
    : user;
  const fromName = typeof config.fromName === "string" && config.fromName.trim()
    ? config.fromName.trim()
    : "SafeKeys";
  const replyTo = typeof config.replyTo === "string" && config.replyTo.trim()
    ? config.replyTo.trim()
    : undefined;

  if (!host || !fromEmail) {
    return createDisabledEmailService("Wysylka e-mail nie jest skonfigurowana na serwerze.");
  }

  const transportConfig = {
    host,
    port,
    secure
  };

  if (user) {
    transportConfig.auth = {
      user,
      pass
    };
  }

  const transporter = nodemailer.createTransport(transportConfig);

  function enrichSmtpError(error) {
    if (!error || typeof error !== "object") {
      return error;
    }

    error.smtpHost = host;
    error.smtpPort = port;
    error.smtpSecure = secure;
    return error;
  }

  return {
    isEnabled() {
      return true;
    },
    getStatus() {
      return {
        enabled: true,
        host,
        port,
        secure,
        fromEmail,
        fromName
      };
    },
    async verifyConnection() {
      try {
        await transporter.verify();
      } catch (error) {
        throw enrichSmtpError(error);
      }

      return true;
    },
    async sendGeneratedCodeEmail(payload) {
      const requestedByLine = payload.requestedBy
        ? `<p style="margin: 0 0 16px; color: #55657c; font-size: 14px;">Kod wygenerowany przez: <strong>${payload.requestedBy}</strong></p>`
        : "";

      try {
        return await transporter.sendMail({
          from: {
            name: fromName,
            address: fromEmail
          },
          to: payload.to,
          replyTo,
          subject: `SafeKeys: kod dostepu do skrytki S${payload.locker}`,
          text: [
            `Wygenerowano nowy kod dostepu do skrytki S${payload.locker}.`,
            "",
            `Kod: ${payload.code}`,
            `Wygasa: ${formatExpiry(payload.expiresAt)}`,
            payload.requestedBy ? `Wygenerowano przez: ${payload.requestedBy}` : null,
            "",
            "Ta wiadomosc zostala wyslana automatycznie przez SafeKeys."
          ].filter(Boolean).join("\n"),
          html: `
            <div style="background: #f4f7fb; padding: 24px; font-family: Arial, sans-serif; color: #102038;">
              <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 20px; border: 1px solid #d8e2f1; padding: 32px;">
                <p style="margin: 0 0 10px; font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: #667892;">SafeKeys</p>
                <h1 style="margin: 0 0 12px; font-size: 28px; line-height: 1.1;">Nowy kod dostepu do skrytki S${payload.locker}</h1>
                <p style="margin: 0 0 20px; color: #55657c; font-size: 15px;">Ponizej znajdziesz kod wygenerowany w panelu SafeKeys.</p>
                <div style="margin: 0 0 20px; padding: 18px 20px; border-radius: 18px; background: #eef4ff; border: 1px solid #d8e2f1;">
                  <p style="margin: 0 0 10px; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: #667892;">Kod dostepu</p>
                  <p style="margin: 0; font-size: 34px; font-weight: 700; letter-spacing: 0.22em; color: #102038;">${payload.code}</p>
                </div>
                <p style="margin: 0 0 8px; color: #102038; font-size: 15px;"><strong>Waznosc:</strong> ${formatExpiry(payload.expiresAt)}</p>
                ${requestedByLine}
                <p style="margin: 0; color: #7a879b; font-size: 13px;">Wiadomosc zostala wyslana automatycznie. Jesli nie oczekiwales tego kodu, skontaktuj sie z administratorem SafeKeys.</p>
              </div>
            </div>
          `
        });
      } catch (error) {
        throw enrichSmtpError(error);
      }
    }
  };
}

module.exports = {
  createEmailService
};
