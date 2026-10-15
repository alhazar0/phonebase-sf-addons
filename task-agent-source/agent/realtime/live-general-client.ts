import type { ScreenHandSemanticAction } from "../action-contract";
import type {
  AgentActionResult,
  AgentDevice,
  ExecuteActionOptions,
  GeneralAgentDeviceClient,
} from "../general-agent-client";
import type { AgentFrame } from "../screen-observer";
import type { RealtimeFrameHub } from "./frame-hub";

/**
 * Adapts the generic agent to the already-open realtime camera stream.
 * Hardware actions still go through the audited control-plane client, but
 * observations never perform a device preflight or transfer a duplicate JPEG.
 */
export class LiveGeneralAgentClient implements GeneralAgentDeviceClient {
  constructor(
    private readonly control: GeneralAgentDeviceClient,
    private readonly frames: RealtimeFrameHub,
  ) {}

  getDevice(signal?: AbortSignal): Promise<AgentDevice> {
    return this.control.getDevice(signal);
  }

  getScreenshot(): Promise<AgentFrame> {
    return this.frames.latestModelFrame();
  }

  waitForNewScreenshot(
    afterSequence: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<AgentFrame> {
    return this.frames.waitForModelFrame(afterSequence, timeoutMs, signal);
  }

  executeAction(
    action: ScreenHandSemanticAction,
    signal?: AbortSignal,
    options?: ExecuteActionOptions,
  ): Promise<AgentActionResult> {
    return this.control.executeAction(action, signal, options);
  }
}
