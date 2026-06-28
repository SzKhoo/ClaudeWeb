import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

// No StrictMode: it double-invokes effects in dev, which would open two WebSocket connections.
const el = document.getElementById("root");
if (!el) throw new Error("missing #root element");
createRoot(el).render(<App />);
