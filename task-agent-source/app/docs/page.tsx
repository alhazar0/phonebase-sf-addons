import type { Metadata } from "next";
import { DocsContent } from "./docs-content";

export const metadata: Metadata = {
  title: "ScreenHand Developer Docs",
  description:
    "Set up a ScreenHand robot arm, control a real phone, and connect your own Agent through REST or MCP.",
};

export default function DocsPage() {
  return <DocsContent />;
}
