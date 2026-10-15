export type ControlPlaneEndpoint = {
  baseUrl: string;
  accessToken: string;
  remote: boolean;
};

export type ControlPlaneEndpointResolution = {
  endpoint: ControlPlaneEndpoint | null;
  error: string;
};

const LOCAL_CONTROL_PLANE_URL =
  process.env.NEXT_PUBLIC_SCREENHAND_LOCAL_CONTROL_PLANE_URL?.trim() ||
  "http://127.0.0.1:3013";
const USE_LOCAL_CONTROL_PLANE_PROXY =
  process.env.NEXT_PUBLIC_SCREENHAND_LOCAL_CONTROL_PLANE_PROXY === "1";
const DEFAULT_REMOTE_CONTROL_PLANE_URL =
  process.env.NEXT_PUBLIC_SCREENHAND_REMOTE_CONTROL_PLANE_URL?.trim() ?? "";
const DEFAULT_REMOTE_ACCESS_TOKEN =
  process.env.NEXT_PUBLIC_SCREENHAND_REMOTE_ACCESS_TOKEN?.trim() ?? "";
const SESSION_KEY = "screenhand.remote.endpoint.v2";
const LEGACY_SESSION_KEY = "screenhand.remote.endpoint.v1";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
type StoredControlPlaneEndpoint = Partial<ControlPlaneEndpoint> & {
  source?: "paired" | "default";
};

function normalizedRemoteEndpoint(
  baseUrlValue: string,
  accessTokenValue: string,
): ControlPlaneEndpoint | null {
  try {
    const url = new URL(baseUrlValue);
    const localHttp = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
    if (url.protocol !== "https:" && !localHttp) return null;
    if (url.username || url.password || url.search || url.hash) return null;

    const accessToken = accessTokenValue.trim();
    if (accessToken.length < 32 || accessToken.length > 256) return null;
    return {
      baseUrl: url.origin,
      accessToken,
      remote: !localHttp,
    };
  } catch {
    return null;
  }
}

function clearPairingFragment() {
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}

export function resolveControlPlaneEndpoint(): ControlPlaneEndpointResolution {
  if (typeof window === "undefined") {
    return { endpoint: null, error: "" };
  }

  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const fragmentEndpoint = fragment.get("controlPlane") ?? "";
  const fragmentToken = fragment.get("token") ?? "";
  if (fragmentEndpoint || fragmentToken) {
    const endpoint = normalizedRemoteEndpoint(fragmentEndpoint, fragmentToken);
    clearPairingFragment();
    if (!endpoint) {
      window.sessionStorage.removeItem(SESSION_KEY);
      window.sessionStorage.removeItem(LEGACY_SESSION_KEY);
      return {
        endpoint: null,
        error: "This remote access link is invalid or incomplete.",
      };
    }
    window.sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...endpoint, source: "paired" }),
    );
    return { endpoint, error: "" };
  }

  const defaultRemoteEndpoint = normalizedRemoteEndpoint(
    DEFAULT_REMOTE_CONTROL_PLANE_URL,
    DEFAULT_REMOTE_ACCESS_TOKEN,
  );
  const storedValue = window.sessionStorage.getItem(SESSION_KEY) ??
    window.sessionStorage.getItem(LEGACY_SESSION_KEY);
  if (storedValue) {
    try {
      const stored = JSON.parse(storedValue) as StoredControlPlaneEndpoint;
      const endpoint = normalizedRemoteEndpoint(
        String(stored.baseUrl ?? ""),
        String(stored.accessToken ?? ""),
      );
      if (
        endpoint &&
        (stored.source === "paired" || !defaultRemoteEndpoint)
      ) {
        window.sessionStorage.setItem(
          SESSION_KEY,
          JSON.stringify({ ...endpoint, source: stored.source ?? "paired" }),
        );
        window.sessionStorage.removeItem(LEGACY_SESSION_KEY);
        return { endpoint, error: "" };
      }
    } catch {
      // Fall through to the safe unconfigured state.
    }
    window.sessionStorage.removeItem(SESSION_KEY);
    window.sessionStorage.removeItem(LEGACY_SESSION_KEY);
  }

  if (LOCAL_HOSTS.has(window.location.hostname)) {
    return {
      endpoint: {
        baseUrl: USE_LOCAL_CONTROL_PLANE_PROXY
          ? window.location.origin
          : LOCAL_CONTROL_PLANE_URL,
        accessToken: "",
        remote: false,
      },
      error: "",
    };
  }

  if (defaultRemoteEndpoint) {
    window.sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...defaultRemoteEndpoint, source: "default" }),
    );
    return { endpoint: defaultRemoteEndpoint, error: "" };
  }

  return {
    endpoint: null,
    error: "Open the private ScreenHand access link supplied by the operator.",
  };
}

export function controlPlaneUrl(endpoint: ControlPlaneEndpoint, path: string) {
  return new URL(path, `${endpoint.baseUrl}/`).toString();
}

export function liveControlPlaneBaseUrl(endpoint: ControlPlaneEndpoint) {
  // The local Vite/Cloudflare development proxy forwards REST correctly, but
  // its upgraded WebSocket can stall after the first binary frame. Keep REST
  // same-origin on :3011 while sending the low-latency camera stream directly
  // to the loopback control plane.
  return USE_LOCAL_CONTROL_PLANE_PROXY && !endpoint.remote
    ? LOCAL_CONTROL_PLANE_URL
    : endpoint.baseUrl;
}

export async function controlPlaneFetch(
  endpoint: ControlPlaneEndpoint,
  path: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  if (endpoint.accessToken) {
    headers.set("Authorization", `Bearer ${endpoint.accessToken}`);
  }
  if (endpoint.remote) {
    headers.set("Ngrok-Skip-Browser-Warning", "1");
  }
  const request = () => fetch(controlPlaneUrl(endpoint, path), { ...init, headers });
  if (!endpoint.remote) return request();

  const retryableStatuses = new Set([502, 503, 504, 520, 522, 524]);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await request();
      if (!retryableStatuses.has(response.status) || attempt === 2) {
        return response;
      }
      await response.body?.cancel();
    } catch (error) {
      if (attempt === 2) throw error;
      lastError = error;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1)));
  }
  throw lastError;
}
