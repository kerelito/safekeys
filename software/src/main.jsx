import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import "../public/styles.css";
import { App } from "./App.jsx";
import { bootLegacyApp } from "./legacyApp.js";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Brakuje elementu #root dla aplikacji SafeKeys.");
}

const root = createRoot(rootElement);

flushSync(() => {
  root.render(<App />);
});

bootLegacyApp();
