// Application entry point: syncs the mobile viewport CSS variables and mounts the React root.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./view/App";
import "./styles.css";

let viewportFrame = 0;
let viewportSettleTimers: number[] = [];

// Apply the current visual viewport height and offset as CSS variables for mobile layouts.
function syncViewportGeometry() {
  cancelAnimationFrame(viewportFrame);
  viewportFrame = requestAnimationFrame(() => {
    const viewport = window.visualViewport;
    const height = viewport?.height || window.innerHeight;
    const pageOffset = viewport ? viewport.pageTop - window.scrollY : 0;
    const bodyPan = Math.max(0, -document.body.getBoundingClientRect().top - window.scrollY);
    const top = Math.max(0, viewport?.offsetTop || 0, pageOffset, bodyPan);
    document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
    document.documentElement.style.setProperty("--app-top", `${Math.round(top)}px`);
  });
}

// Re-sync the viewport variables several times while the keyboard and orientation settle.
function settleViewportGeometry() {
  for (const timer of viewportSettleTimers) window.clearTimeout(timer);
  viewportSettleTimers = [];
  syncViewportGeometry();
  for (const delay of [50, 150, 350, 600]) {
    viewportSettleTimers.push(window.setTimeout(syncViewportGeometry, delay));
  }
}

syncViewportGeometry();
window.addEventListener("resize", syncViewportGeometry, { passive: true });
window.addEventListener("orientationchange", settleViewportGeometry, { passive: true });
window.visualViewport?.addEventListener("resize", syncViewportGeometry, { passive: true });
window.visualViewport?.addEventListener("scroll", syncViewportGeometry, { passive: true });
document.addEventListener("focusin", settleViewportGeometry, { passive: true });
document.addEventListener("focusout", settleViewportGeometry, { passive: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
