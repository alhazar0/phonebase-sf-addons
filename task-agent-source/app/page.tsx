import { headers } from "next/headers";
import { DashboardContent } from "./dashboard-content";
import { DocsContent } from "./docs/docs-content";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export default async function HomePage() {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const hostHeader = forwardedHost ?? requestHeaders.get("host") ?? "127.0.0.1:3012";
  const hostname = hostHeader.startsWith("[")
    ? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
    : hostHeader.split(":")[0];

  return LOCAL_HOSTS.has(hostname) ? <DashboardContent /> : <DocsContent />;
}
