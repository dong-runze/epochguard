import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import PreviewApp from "./preview/PreviewApp";

const root = document.getElementById("epochguard-preview-root");

if (root === null) {
  throw new Error("EpochGuard Preview root is missing.");
}

createRoot(root).render(
  <StrictMode>
    <PreviewApp />
  </StrictMode>,
);
