export const API = window.location.origin;

let onHttpStatusChange = () => {};
let onUnauthorized = () => {};

export function configureApiClient(handlers = {}) {
  onHttpStatusChange = typeof handlers.onHttpStatusChange === "function"
    ? handlers.onHttpStatusChange
    : () => {};
  onUnauthorized = typeof handlers.onUnauthorized === "function"
    ? handlers.onUnauthorized
    : () => {};
}

export function buildQueryString(params = {}) {
  const query = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && String(value).trim() !== "") {
      query.set(key, String(value).trim());
    }
  });

  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

export function downloadUrl(path) {
  window.location.href = API + path;
}

export async function apiFetch(path, options = {}) {
  let res;
  const method = String(options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers || {});

  if (method === "GET" || method === "HEAD") {
    headers.set("Cache-Control", "no-cache");
    headers.set("Pragma", "no-cache");
  }

  try {
    res = await fetch(API + path, {
      ...options,
      credentials: "same-origin",
      cache: "no-store",
      headers
    });
  } catch (error) {
    onHttpStatusChange(false);
    throw new Error("Brak połączenia z serwerem.");
  }

  let data = null;
  const isJson = res.headers.get("content-type")?.includes("application/json");

  if (isJson) {
    data = await res.json();
  }

  if (!res.ok) {
    if (res.status === 401) {
      onUnauthorized();
    }

    if (res.status >= 500) {
      onHttpStatusChange(false);
    }

    throw new Error(data?.error || "Operacja nie powiodła się.");
  }

  onHttpStatusChange(true);
  return data;
}
