interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

type D1Database = import("@miniflare/d1").D1Database;

declare module "cloudflare:workers" {
  export const env: {
    DB?: import("@miniflare/d1").D1Database;
  };
}
