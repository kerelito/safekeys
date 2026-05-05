import { AppView } from "./components/AppView.jsx";
import { AuthView } from "./components/AuthView.jsx";
import { ConfirmOverlay } from "./components/ConfirmOverlay.jsx";
import { LockerDetailsOverlay } from "./components/LockerDetailsOverlay.jsx";
import { LogDetailsOverlay } from "./components/LogDetailsOverlay.jsx";
import { Toast } from "./components/Toast.jsx";

export function App() {
  return (
    <>
      <AuthView />
      <AppView />
      <ConfirmOverlay />
      <LogDetailsOverlay />
      <LockerDetailsOverlay />
      <Toast />
    </>
  );
}
