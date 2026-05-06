import { useSyncExternalStore } from "react";
import { apiFetch } from "../services/apiClient.js";

const DEFAULT_META = "Kod pojawi się tutaj po wygenerowaniu. Możesz go zostawić tylko w panelu albo od razu wysłać na e-mail.";
const listeners = new Set();
let handlers = {
  afterGenerate: async () => {},
  canGenerate: () => false,
  showToast: () => {}
};
let state = {
  deliveryStatus: {
    label: "",
    variant: ""
  },
  generatedCode: "----",
  generatedMeta: DEFAULT_META,
  hasGeneratedCode: false,
  hours: "2",
  isSubmitting: false,
  locker: "1",
  recipientEmail: ""
};

function emit() {
  listeners.forEach(listener => listener());
}

function updateState(patch) {
  state = {
    ...state,
    ...patch
  };
  emit();
  return state;
}

function formatDateTime(value) {
  return new Date(value).toLocaleString("pl-PL", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function summarizeDeliveryError(message) {
  if (typeof message !== "string" || !message.trim()) {
    return "Sprawdź konfigurację SMTP i spróbuj ponownie.";
  }

  return message.length > 120
    ? `${message.slice(0, 117)}...`
    : message;
}

async function writeClipboard(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function renderGeneratedCodeResult(data) {
  const expiresAt = formatDateTime(data.expiresAt);
  const delivery = data.emailDelivery;

  if (delivery?.attempted) {
    if (delivery.sent) {
      updateState({
        deliveryStatus: {
          label: "E-mail wysłany",
          variant: "success"
        },
        generatedCode: data.code,
        generatedMeta: `Kod do skrytki S${data.locker} wygasa ${expiresAt}. Wysłano go na ${delivery.recipientEmail}.`,
        hasGeneratedCode: true
      });
      return;
    }

    updateState({
      deliveryStatus: {
        label: "E-mail niewysłany",
        variant: "warning"
      },
      generatedCode: data.code,
      generatedMeta: `Kod do skrytki S${data.locker} wygasa ${expiresAt}. Nie udało się wysłać go na ${delivery.recipientEmail}. ${summarizeDeliveryError(delivery.error)}`,
      hasGeneratedCode: true
    });
    return;
  }

  updateState({
    deliveryStatus: {
      label: "",
      variant: ""
    },
    generatedCode: data.code,
    generatedMeta: `Kod do skrytki S${data.locker} wygasa ${expiresAt}.`,
    hasGeneratedCode: true
  });
}

export function configureCodeGeneratorHandlers(nextHandlers = {}) {
  handlers = {
    ...handlers,
    ...nextHandlers
  };
}

export function subscribeCodeGenerator(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCodeGeneratorSnapshot() {
  return state;
}

export function setCodeGeneratorField(name, value) {
  if (!Object.prototype.hasOwnProperty.call(state, name)) {
    return state;
  }

  return updateState({ [name]: value });
}

export async function generateCodeFromStore() {
  if (!handlers.canGenerate()) {
    handlers.showToast("Nie masz uprawnień do generowania kodów.", true);
    return;
  }

  if (state.isSubmitting) {
    return;
  }

  const recipientEmail = state.recipientEmail.trim();
  if (recipientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
    handlers.showToast("Podaj poprawny adres e-mail.", true);
    return;
  }

  updateState({ isSubmitting: true });

  try {
    const data = await apiFetch("/generate-code", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        hours: Number(state.hours),
        locker: Number(state.locker),
        recipientEmail
      })
    });

    renderGeneratedCodeResult(data);

    if (data.emailDelivery?.attempted) {
      handlers.showToast(
        data.emailDelivery.sent
          ? `Kod wygenerowany i wysłany na ${data.emailDelivery.recipientEmail}.`
          : "Kod wygenerowany, ale wysyłka e-mail nie powiodła się.",
        !data.emailDelivery.sent
      );
    } else {
      handlers.showToast("Kod wygenerowany.");
    }

    await handlers.afterGenerate();
  } catch (error) {
    handlers.showToast(error.message, true);
  } finally {
    updateState({ isSubmitting: false });
  }
}

export async function copyGeneratedCode() {
  const code = state.generatedCode.trim();
  if (!state.hasGeneratedCode || !code || code === "----") {
    handlers.showToast("Nie ma czego skopiować.", true);
    return;
  }

  try {
    await writeClipboard(code);
    handlers.showToast("Skopiowano wygenerowany kod.");
  } catch (error) {
    handlers.showToast("Nie udało się skopiować do schowka.", true);
  }
}

export function clearGeneratedCode() {
  return updateState({
    deliveryStatus: {
      label: "",
      variant: ""
    },
    generatedCode: "----",
    generatedMeta: DEFAULT_META,
    hasGeneratedCode: false
  });
}

export function useCodeGenerator() {
  return useSyncExternalStore(subscribeCodeGenerator, getCodeGeneratorSnapshot, getCodeGeneratorSnapshot);
}
