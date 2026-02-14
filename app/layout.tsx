import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ConvexClientProvider } from "./ConvexClientProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Minimal RLM Sandbox",
  description: "Upload a large text file, run an RLM loop, and watch execution events live.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </body>
    </html>
  );
}
