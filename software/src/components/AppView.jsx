import { useEffect } from "react";
import { AdminPages } from "./AdminPages.jsx";
import { DashboardPage } from "./DashboardPage.jsx";
import { MenuDrawer } from "./MenuDrawer.jsx";
import { TopBar } from "./TopBar.jsx";
import { useUiShell } from "../state/uiShellStore.js";

export function AppView() {
  const { closeMenu, menuOpen } = useUiShell();

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }

    const handleOutsideClick = event => {
      const drawer = document.getElementById("menuDrawer");
      const menuButton = document.getElementById("menuButton");

      if (drawer && menuButton && !drawer.contains(event.target) && !menuButton.contains(event.target)) {
        closeMenu();
      }
    };

    document.addEventListener("click", handleOutsideClick);
    return () => document.removeEventListener("click", handleOutsideClick);
  }, [closeMenu, menuOpen]);

  return (
    <div id="appView" className="hidden">
      <TopBar />
      <MenuDrawer />
      <div className="app-shell">
        <DashboardPage />
        <AdminPages />
      </div>
    </div>
  );
}
