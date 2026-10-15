export type ActionReceiptDecision = {
  id: string;
  status: "executing" | "completed" | "failed";
  error: string | null;
  result: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

type RetainedReceipt = {
  id: string;
  deviceId: string;
  status: "accepted" | "executing" | "completed" | "failed";
};

export function receiptIdsToPrune(
  receipts: RetainedReceipt[],
  maximumPerDevice: number,
  maximumTotal: number,
) {
  const removable = (receipt: RetainedReceipt) =>
    receipt.status === "completed" || receipt.status === "failed";
  const selected = new Set<string>();
  const byDevice = new Map<string, RetainedReceipt[]>();
  for (const receipt of receipts) {
    const group = byDevice.get(receipt.deviceId) ?? [];
    group.push(receipt);
    byDevice.set(receipt.deviceId, group);
  }
  for (const group of byDevice.values()) {
    let excess = Math.max(0, group.length - maximumPerDevice);
    for (const receipt of group) {
      if (excess <= 0) break;
      if (!removable(receipt)) continue;
      selected.add(receipt.id);
      excess -= 1;
    }
  }
  let retainedTotal = receipts.length - selected.size;
  for (const receipt of receipts) {
    if (retainedTotal <= maximumTotal) break;
    if (selected.has(receipt.id) || !removable(receipt)) continue;
    selected.add(receipt.id);
    retainedTotal -= 1;
  }
  return [...selected];
}

export function compactHoverReceiptOperation(value: unknown) {
  const operation = record(value);
  const nested = record(operation.result);
  const result = Object.keys(nested).length > 0 ? nested : operation;
  const position = record(result.position);
  return {
    ok: operation.ok === true || result.ok === true,
    ...(result.superseded === true ? { superseded: true } : {}),
    ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
    ...(typeof result.state === "string" ? { state: result.state } : {}),
    ...(Object.keys(position).length > 0 ? { position } : {}),
  };
}

export function operationReceiptDecision(
  operationValue: unknown,
): ActionReceiptDecision | null {
  const operation = record(operationValue);
  const id = String(operation.id ?? "");
  if (!id) return null;
  const status = String(operation.status ?? "running");
  if (status === "completed") {
    return { id, status, error: null, result: operation };
  }
  if (status === "failed") {
    return {
      id,
      status,
      error: String(operation.error ?? "The physical action failed."),
      result: operation,
    };
  }
  return { id, status: "executing", error: null, result: operation };
}

export function commandResultReceiptDecision(
  payloadValue: unknown,
): ActionReceiptDecision | null {
  const payload = record(payloadValue);
  const id = String(payload.id ?? "");
  if (!id) return null;
  if (payload.ok !== true) {
    return {
      id,
      status: "failed",
      error: String(
        payload.error ?? "The hardware node rejected the action.",
      ),
      result: payload,
    };
  }
  const action = String(payload.action ?? "");
  // Tracked physical operations acknowledge twice: first when the node has
  // accepted/started the operation (without a result), then via heartbeat or
  // the final operation snapshot.  Never let the initial acknowledgement
  // complete a receipt, otherwise visual verification can race the hardware
  // and a final Hold can interrupt a multi-tap text sequence.
  const status = [
    "home",
    "tap",
    "long_press",
    "swipe",
    "system_edge_swipe",
    "system_edge_tap",
    "input_text",
    "jog",
  ].includes(action)
    ? "executing"
    : "completed";
  return { id, status, error: null, result: payload };
}
