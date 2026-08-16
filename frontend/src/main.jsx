import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import { registerSW } from "virtual:pwa-register";
import ErrorBoundary from "./components/ErrorBoundary.jsx";

registerSW({ immediate: true });

/*
 * The outermost boundary, above the router.
 *
 * App.jsx has its own, closer to the routes, and that one is where almost every
 * crash should land — it keeps the provider tree alive so an in-progress call
 * survives. This is the backstop for the things below that: a provider throwing
 * while it mounts, or the router itself. It sits outside `<BrowserRouter>`,
 * which is why ErrorScreen navigates with `window.location` rather than
 * `useNavigate` — at this depth there is no router to navigate with.
 */
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ErrorBoundary label="root">
      <BrowserRouter>
        <App />
        <Toaster />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>
);
