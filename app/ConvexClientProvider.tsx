"use client";

import { type ReactNode, useMemo } from "react";
import { ConvexProvider, ConvexReactClient } from "convex/react";

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const client = useMemo(() => {
    if (!convexUrl) {
      return null;
    }
    return new ConvexReactClient(convexUrl);
  }, [convexUrl]);

  if (!client) {
    return (
      <main className="app-shell">
        <section className="panel">
          <h1>Missing Convex Configuration</h1>
          <p>Set NEXT_PUBLIC_CONVEX_URL in your environment before running the app.</p>
        </section>
      </main>
    );
  }

  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
