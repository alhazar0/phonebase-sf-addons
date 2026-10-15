#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  fromJsonSchema,
  McpServer,
  SUPPORTED_PROTOCOL_VERSIONS,
  type CallToolResult,
  type JsonSchemaType,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { SCREENHAND_MAX_TEXT_LENGTH } from "../agent/action-contract";

type JsonObject = Record<string, unknown>;

type McpTool = {
  name: string;
  description: string;
  inputSchema: JsonObject;
};

const API_BASE = new URL(
  process.env.SCREENHAND_API_URL ?? "http://127.0.0.1:3013",
);
const API_TOKEN = process.env.SCREENHAND_API_TOKEN?.trim() ?? "";
const ACTION_TIMEOUT_MS = Math.min(
  300_000,
  Math.max(5_000, Number(process.env.SCREENHAND_MCP_ACTION_TIMEOUT_MS ?? 120_000)),
);
const HOME_ENABLED = process.env.SCREENHAND_MCP_ALLOW_HOME === "1";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MCP_INSTRUCTIONS = "List devices and read capabilities first. Read a fresh screenshot before coordinate actions. Use its exact frameSequence and viewport. Action tools wait for the final hardware receipt. Never bypass a safety gate or claim the workspace is clear without a human check.";
const MCP_PROTOCOL_VERSIONS = ["2026-07-28", ...SUPPORTED_PROTOCOL_VERSIONS];

if (!["http:", "https:"].includes(API_BASE.protocol)) {
  throw new Error("SCREENHAND_API_URL must use http or https");
}
if (
  !LOCAL_HOSTS.has(API_BASE.hostname) &&
  process.env.SCREENHAND_MCP_ALLOW_REMOTE !== "1"
) {
  throw new Error(
    "Remote ScreenHand MCP connections require SCREENHAND_MCP_ALLOW_REMOTE=1",
  );
}

const deviceProperty = {
  deviceId: {
    type: "string",
    minLength: 1,
    maxLength: 120,
    description: "Exact deviceId returned by screenhand_list_devices",
  },
};
const pointSchema = {
  type: "object",
  properties: {
    x: { type: "number" },
    y: { type: "number" },
  },
  required: ["x", "y"],
  additionalProperties: false,
};
const viewportSchema = {
  type: "object",
  properties: {
    width: { type: "number", minimum: 64, maximum: 8192 },
    height: { type: "number", minimum: 64, maximum: 8192 },
  },
  required: ["width", "height"],
  additionalProperties: false,
};
const touchContextProperties = {
  viewport: viewportSchema,
  frameSequence: {
    type: "integer",
    minimum: 1,
    description: "Exact recent frame sequence used to choose the coordinates",
  },
  touchZ: {
    type: "number",
    description: "Optional depth within this device's verified touch range",
  },
};

const TOOLS: McpTool[] = [
  {
    name: "screenhand_list_devices",
    description: "List physical devices, live state, frames, and per-action capabilities.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "screenhand_get_device",
    description: "Read one physical device and the reasons any capability is unavailable.",
    inputSchema: {
      type: "object",
      properties: deviceProperty,
      required: ["deviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "screenhand_get_screenshot",
    description: "Return the latest or an exact recent physical-device frame as MCP image content.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        sequence: { type: "integer", minimum: 1 },
      },
      required: ["deviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "screenhand_hover_move",
    description: "Move the arm above a frame-derived screen point without touching it.",
    inputSchema: {
      type: "object",
      properties: { ...deviceProperty, point: pointSchema, ...touchContextProperties },
      required: ["deviceId", "point", "viewport", "frameSequence"],
      additionalProperties: false,
    },
  },
  {
    name: "screenhand_tap",
    description: "Tap a point from an exact recent device frame and wait for the final hardware receipt.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        point: pointSchema,
        ...touchContextProperties,
        durationMs: { type: "integer", minimum: 30, maximum: 250 },
      },
      required: ["deviceId", "point", "viewport", "frameSequence"],
      additionalProperties: false,
    },
  },
  {
    name: "screenhand_long_press",
    description: "Long-press a frame-derived point and wait for the final hardware receipt.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        point: pointSchema,
        ...touchContextProperties,
        durationMs: { type: "integer", minimum: 500, maximum: 5000 },
      },
      required: ["deviceId", "point", "viewport", "frameSequence", "durationMs"],
      additionalProperties: false,
    },
  },
  {
    name: "screenhand_swipe",
    description: "Swipe between two frame-derived points and wait for the final hardware receipt.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        start: pointSchema,
        end: pointSchema,
        ...touchContextProperties,
        durationMs: { type: "integer", minimum: 250, maximum: 3000 },
      },
      required: ["deviceId", "start", "end", "viewport", "frameSequence", "durationMs"],
      additionalProperties: false,
    },
  },
  {
    name: "screenhand_input_text",
    description: "Type text through the selected device's strict, physically verified keyboard profile.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        text: { type: "string", minLength: 1, maxLength: SCREENHAND_MAX_TEXT_LENGTH },
        touchZ: touchContextProperties.touchZ,
      },
      required: ["deviceId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "screenhand_phone_key",
    description: "Send a calibrated Back, Enter, Home, or keyboard-language phone key.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        key: { type: "string", enum: ["back", "enter", "home", "keyboard_next"] },
      },
      required: ["deviceId", "key"],
      additionalProperties: false,
    },
  },
  ...["status", "hold", "resume"].map((action) => ({
    name: `screenhand_${action}`,
    description: action === "hold"
      ? "Immediately place the device controller in Hold."
      : action === "resume"
        ? "Release a safe controller Hold without bypassing calibration gates."
        : "Request a fresh controller status update.",
    inputSchema: {
      type: "object",
      properties: deviceProperty,
      required: ["deviceId"],
      additionalProperties: false,
    },
  })),
  {
    name: "screenhand_home",
    description: "Run homing only after a human clears the workspace and an administrator enables SCREENHAND_MCP_ALLOW_HOME=1.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        workspaceClear: {
          type: "boolean",
          const: true,
          description: "Must be true after a human clears hands, cables, and tools",
        },
      },
      required: ["deviceId", "workspaceClear"],
      additionalProperties: false,
    },
  },
  {
    name: "screenhand_wait",
    description: "Wait for a bounded duration as a deterministic physical workflow step.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        durationMs: { type: "integer", minimum: 0, maximum: 30000 },
      },
      required: ["deviceId", "durationMs"],
      additionalProperties: false,
    },
  },
  {
    name: "screenhand_get_receipt",
    description: "Read accepted, executing, completed, or failed state for a physical action.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperty,
        receiptId: { type: "string", minLength: 1, maxLength: 160 },
      },
      required: ["deviceId", "receiptId"],
      additionalProperties: false,
    },
  },
];

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function requiredString(input: JsonObject, key: string) {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalNumber(input: JsonObject, key: string) {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function headers(extra: Record<string, string> = {}) {
  return {
    Accept: "application/json",
    "X-ScreenHand-Actor": "mcp",
    "X-Request-Id": `mcp-${randomUUID()}`,
    ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    ...extra,
  };
}

async function apiJson(path: string, init: RequestInit = {}) {
  const response = await fetch(new URL(path, `${API_BASE.origin}/`), {
    ...init,
    headers: headers(init.headers as Record<string, string> | undefined),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as unknown : null;
  if (!response.ok) {
    const detail = objectValue(payload);
    throw new Error(String(detail.error ?? `ScreenHand API returned ${response.status}`));
  }
  return payload;
}

async function submitAction(deviceId: string, action: JsonObject) {
  const submitted = objectValue(await apiJson(
    `/api/v1/devices/${encodeURIComponent(deviceId)}/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: `mcp-${randomUUID()}`,
      action,
    }),
  }));
  const submittedResult = objectValue(submitted.result);
  let receipt = objectValue(submittedResult.receipt);
  const receiptId = typeof receipt.id === "string" ? receipt.id : "";
  if (!receiptId || ["completed", "failed"].includes(String(receipt.status))) {
    return submitted;
  }

  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
    const receiptPayload = objectValue(await apiJson(
      `/api/v1/devices/${encodeURIComponent(deviceId)}/actions/${encodeURIComponent(receiptId)}`,
    ));
    receipt = objectValue(receiptPayload.receipt);
    if (["completed", "failed"].includes(String(receipt.status))) {
      return {
        ...submitted,
        result: { ...submittedResult, receipt },
        mcp: { waitedForFinalReceipt: true, timedOut: false },
      };
    }
  }
  return {
    ...submitted,
    result: { ...submittedResult, receipt },
    mcp: {
      waitedForFinalReceipt: true,
      timedOut: true,
      nextTool: "screenhand_get_receipt",
    },
  };
}

function textResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

async function callTool(name: string, rawArguments: unknown): Promise<CallToolResult> {
  const input = objectValue(rawArguments);
  const deviceId = name === "screenhand_list_devices"
    ? ""
    : requiredString(input, "deviceId");

  if (name === "screenhand_list_devices") {
    return textResult(await apiJson("/api/v1/devices"));
  }
  if (name === "screenhand_get_device") {
    return textResult(await apiJson(`/api/v1/devices/${encodeURIComponent(deviceId)}`));
  }
  if (name === "screenhand_get_receipt") {
    const receiptId = requiredString(input, "receiptId");
    return textResult(await apiJson(
      `/api/v1/devices/${encodeURIComponent(deviceId)}/actions/${encodeURIComponent(receiptId)}`,
    ));
  }
  if (name === "screenhand_get_screenshot") {
    const sequence = optionalNumber(input, "sequence");
    const query = sequence === undefined ? "" : `?sequence=${Math.round(sequence)}`;
    const response = await fetch(
      new URL(`/api/v1/devices/${encodeURIComponent(deviceId)}/screenshot${query}`, `${API_BASE.origin}/`),
      { headers: headers() },
    );
    if (!response.ok) {
      const detail = objectValue(await response.json().catch(() => ({})));
      throw new Error(String(detail.error ?? `Screenshot returned ${response.status}`));
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      content: [
        {
          type: "image" as const,
          data: bytes.toString("base64"),
          mimeType: response.headers.get("content-type")?.split(";")[0] ?? "image/jpeg",
        },
        {
          type: "text" as const,
          text: JSON.stringify({
            deviceId,
            frameSequence: Number(response.headers.get("x-screenhand-frame-sequence")),
            capturedAt: Number(response.headers.get("x-screenhand-captured-at")),
            frameWidth: Number(response.headers.get("x-screenhand-frame-width")),
            frameHeight: Number(response.headers.get("x-screenhand-frame-height")),
            coordinateSpace: "full physical-screen pixels",
            nextStep: "Use this exact frameSequence and frame size for tap, long press, swipe, or hover move.",
          }),
        },
      ],
    };
  }

  const touchContext = {
    viewport: objectValue(input.viewport),
    frameSequence: optionalNumber(input, "frameSequence"),
    ...(optionalNumber(input, "touchZ") === undefined
      ? {}
      : { touchZ: optionalNumber(input, "touchZ") }),
  };
  let action: JsonObject;
  switch (name) {
    case "screenhand_hover_move":
      action = {
        type: name.replace("screenhand_", ""),
        point: objectValue(input.point),
        ...touchContext,
      };
      break;
    case "screenhand_tap":
      action = {
        type: "tap",
        point: objectValue(input.point),
        ...(optionalNumber(input, "durationMs") === undefined
          ? {}
          : { durationMs: optionalNumber(input, "durationMs") }),
        ...touchContext,
      };
      break;
    case "screenhand_long_press":
      action = {
        type: "long_press",
        point: objectValue(input.point),
        durationMs: optionalNumber(input, "durationMs"),
        ...touchContext,
      };
      break;
    case "screenhand_swipe":
      action = {
        type: "swipe",
        start: objectValue(input.start),
        end: objectValue(input.end),
        durationMs: optionalNumber(input, "durationMs"),
        ...touchContext,
      };
      break;
    case "screenhand_input_text":
      action = {
        type: "input_text",
        text: requiredString(input, "text"),
        ...(optionalNumber(input, "touchZ") === undefined
          ? {}
          : { touchZ: optionalNumber(input, "touchZ") }),
      };
      break;
    case "screenhand_phone_key":
      action = { type: "phone_key", key: requiredString(input, "key") };
      break;
    case "screenhand_home":
      if (!HOME_ENABLED) {
        throw new Error(
          "Homing through MCP is disabled. A human must clear the workspace and an administrator must set SCREENHAND_MCP_ALLOW_HOME=1.",
        );
      }
      if (input.workspaceClear !== true) {
        throw new Error("workspaceClear must be true before machine homing");
      }
      action = { type: "home", confirmation: "CLEAR_WORKSPACE_AND_HOME" };
      break;
    case "screenhand_wait":
      action = { type: "wait", durationMs: optionalNumber(input, "durationMs") };
      break;
    case "screenhand_status":
    case "screenhand_hold":
    case "screenhand_resume":
      action = { type: name.replace("screenhand_", "") };
      break;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
  return textResult(await submitAction(deviceId, action));
}

function buildServer() {
  const server = new McpServer(
    { name: "screenhand", version: "0.3.0" },
    {
      capabilities: { tools: {} },
      instructions: MCP_INSTRUCTIONS,
      supportedProtocolVersions: MCP_PROTOCOL_VERSIONS,
      cacheHints: {
        "tools/list": { ttlMs: 300_000, cacheScope: "public" },
        "server/discover": { ttlMs: 300_000, cacheScope: "public" },
      },
    },
  );
  const readOnlyTools = new Set([
    "screenhand_list_devices",
    "screenhand_get_device",
    "screenhand_get_screenshot",
    "screenhand_status",
    "screenhand_get_receipt",
  ]);

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema<JsonObject>(tool.inputSchema as JsonSchemaType),
        annotations: {
          readOnlyHint: readOnlyTools.has(tool.name),
          destructiveHint: tool.name === "screenhand_home",
          idempotentHint: tool.name !== "screenhand_home",
          openWorldHint: false,
        },
      },
      async (input) => {
        try {
          return await callTool(tool.name, input);
        } catch (error) {
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text: error instanceof Error ? error.message : "ScreenHand tool failed",
            }],
          };
        }
      },
    );
  }

  return server;
}

serveStdio(buildServer, {
  legacy: "serve",
  onerror(error) {
    process.stderr.write(`ScreenHand MCP: ${error.message}\n`);
  },
});
