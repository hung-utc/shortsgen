import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { mountStudio } from "~/studio/studio";
import "~/studio/studio.css";

export const Route = createFileRoute("/")({
  component: StudioPage,
});

function StudioPage() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const dispose = mountStudio(ref.current);
    return dispose;
  }, []);

  // Register the app-shell service worker (client-side only — this effect
  // never runs during SSR, so `navigator`/`window` access here is safe).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline shell is a bonus — studio works without it */
    });
  }, []);

  return (
    <div
      ref={ref}
      style={{
        minHeight: "100dvh",
        background: "#0b0b10",
        colorScheme: "dark",
      }}
    />
  );
}
