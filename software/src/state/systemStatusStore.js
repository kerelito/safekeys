import { useSyncExternalStore } from "react";

const listeners = new Set();
let state = {
  lastHttpOk: true,
  socketConnected: false,
  systemStatusData: null
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

function formatRelativeTime(value) {
  if (!value) {
    return "brak danych";
  }

  const diffMs = Date.now() - new Date(value).getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) {
    return "przed chwilą";
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) {
    return "przed chwilą";
  }

  if (seconds < 60) {
    return `${seconds} s temu`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min temu`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours} godz. temu`;
}

export function subscribeSystemStatus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSystemStatusSnapshot() {
  return state;
}

export function syncSystemStatusContext(patch = {}) {
  return updateState(patch);
}

export function clearSystemStatusState() {
  return updateState({
    lastHttpOk: true,
    socketConnected: false,
    systemStatusData: null
  });
}

export function getSystemStatusModel(snapshot = state) {
  const { lastHttpOk, socketConnected, systemStatusData } = snapshot;
  const databaseConnected = Boolean(systemStatusData?.database?.connected);
  const esp32Connected = Boolean(systemStatusData?.esp32?.connected);
  const databaseState = systemStatusData?.database?.state || "unknown";
  const esp32 = systemStatusData?.esp32 || {};

  return {
    indicators: {
      server: {
        lines: [
          `HTTP API: ${lastHttpOk ? "OK" : "brak odpowiedzi"}`,
          `Socket.IO: ${socketConnected ? "połączony" : "rozłączony"}`
        ],
        state: lastHttpOk ? "online" : "offline",
        summary: lastHttpOk ? "API odpowiada poprawnie." : "Brak odpowiedzi z API.",
        title: "Serwer"
      },
      database: {
        lines: [
          `Stan połączenia: ${databaseState}`,
          `Ostatnia aktualizacja: ${formatRelativeTime(systemStatusData?.serverTime)}`
        ],
        state: databaseConnected ? "online" : "offline",
        summary: databaseConnected ? "MongoDB jest dostępne." : "MongoDB nie jest dostępne.",
        title: "Baza danych"
      },
      esp32: {
        lines: [
          `Ostatni kontakt: ${formatRelativeTime(esp32.lastSeenAt)}`,
          `Ping: ${typeof esp32.pingMs === "number" ? `${esp32.pingMs} ms` : "brak danych"}`,
          `WiFi RSSI: ${typeof esp32.wifiRssi === "number" ? `${esp32.wifiRssi} dBm` : "brak danych"}`,
          `IP: ${esp32.ip || "brak danych"}`
        ],
        state: esp32Connected ? "online" : "offline",
        summary: esp32Connected ? "Heartbeat dociera do serwera." : "Brak świeżego heartbeat z urządzenia.",
        title: "ESP32"
      }
    },
    summary: {
      database: {
        meta: `Stan: ${databaseState}`,
        state: databaseConnected ? "online" : "offline",
        value: databaseConnected ? "Połączona" : "Brak połączenia"
      },
      device: {
        meta: typeof esp32.pingMs === "number" ? `Ping ${esp32.pingMs} ms` : "Ping niedostępny",
        state: esp32Connected ? "online" : "offline",
        value: esp32Connected ? "Heartbeat OK" : "Brak heartbeat"
      },
      heartbeat: {
        meta: esp32.ip ? `ESP32 ${esp32.ip}` : "Czekam na adres urządzenia",
        state: esp32Connected ? "online" : "pending",
        value: formatRelativeTime(esp32.lastSeenAt)
      },
      server: {
        meta: socketConnected ? "HTTP OK, Socket połączony" : "HTTP OK, Socket rozłączony",
        state: lastHttpOk ? "online" : "offline",
        value: lastHttpOk ? "Online" : "Offline"
      }
    }
  };
}

export function useSystemStatus() {
  return useSyncExternalStore(subscribeSystemStatus, getSystemStatusSnapshot, getSystemStatusSnapshot);
}
