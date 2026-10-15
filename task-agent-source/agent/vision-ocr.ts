import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

export type VisionTextItem = {
  text: string;
  confidence: number;
  left: number;
  top: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
};

export type VisionOcrResult = {
  ok: true;
  imageWidth: number;
  imageHeight: number;
  elapsedMs: number;
  items: VisionTextItem[];
};

// Literal field/keyboard reads must not autocorrect names or typed prefixes.
export type VisionOcrMode = "fast" | "accurate" | "literal";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(repositoryRoot, "scripts/vision-ocr.swift");
const binaryPath = resolve(repositoryRoot, ".runtime/vision-ocr");
const daemonSourcePath = resolve(repositoryRoot, "scripts/vision-ocr-daemon.swift");
const daemonBinaryPath = resolve(repositoryRoot, ".runtime/vision-ocr-daemon");
const OCR_MAX_LONG_EDGE = 1_600;
const OCR_DAEMON_IDLE_MS = boundedIdleMs(process.env.SCREENHAND_VISION_OCR_IDLE_MS);
let binaryPromise: Promise<string> | null = null;
let daemonBinaryPromise: Promise<string> | null = null;
let daemonPromise: Promise<VisionOcrDaemon> | null = null;
let activeDaemon: VisionOcrDaemon | null = null;

export async function recognizeVisionText(
  dataUrl: string,
  signal?: AbortSignal,
  mode: VisionOcrMode = "accurate",
): Promise<VisionOcrResult> {
  if (process.platform !== "darwin") {
    throw new Error("The low-latency Vision OCR path currently requires macOS.");
  }
  const bytes = await prepareOcrImage(decodeImageDataUrl(dataUrl));
  if (process.env.SCREENHAND_VISION_OCR_DAEMON !== "0") {
    try {
      const daemon = await visionOcrDaemon(signal);
      return await daemon.recognize(bytes, mode, signal);
    } catch (error) {
      resetVisionOcrDaemon();
      if (signal?.aborted) throw error;
    }
  }
  const executable = await ensureVisionOcrBinary(signal);
  const directory = await mkdtemp(resolve(tmpdir(), "screenhand-vision-"));
  const imagePath = resolve(directory, "frame.jpg");
  try {
    await writeFile(imagePath, bytes);
    const stdout = await runFile(executable, [mode, imagePath], signal, 15_000);
    const parsed = JSON.parse(stdout) as Partial<VisionOcrResult>;
    if (
      parsed.ok !== true ||
      !Number.isInteger(parsed.imageWidth) ||
      !Number.isInteger(parsed.imageHeight) ||
      !Array.isArray(parsed.items)
    ) {
      throw new Error("Apple Vision OCR returned an invalid response.");
    }
    return parsed as VisionOcrResult;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type PendingOcr = {
  resolve: (result: VisionOcrResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener: () => void;
};

export class VisionOcrDaemon {
  private readonly pending = new Map<string, PendingOcr>();
  private stderr = "";
  private closed = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly processExit = () => this.stop();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onStopped: () => void,
  ) {
    const lines = createInterface({ input: child.stdout });
    process.once("exit", this.processExit);
    lines.on("line", (line) => this.handleLine(line));
    // A write callback does NOT consume a stream's error event. Without this
    // listener a dead OCR child raises an uncaught EPIPE and kills the robot
    // task before its completed motor receipt can be finalized on disk.
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on("error", (error) => {
        this.finish(new Error(`Apple Vision OCR pipe failed: ${error.message}`, {cause:error}));
        child.kill("SIGTERM");
      });
    }
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4_096);
    });
    child.once("exit", (code, signal) => {
      const detail = this.stderr.trim() || `exit=${code ?? "null"} signal=${signal ?? "none"}`;
      this.finish(new Error(`Apple Vision OCR daemon stopped: ${detail}`));
    });
    child.once("error", (error) => {
      this.finish(new Error(`Apple Vision OCR daemon failed: ${error.message}`, { cause: error }));
    });
    this.scheduleIdleStop();
  }

  recognize(bytes: Buffer, mode: VisionOcrMode, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.closed || !this.child.stdin.writable) {
      return Promise.reject(new Error("Apple Vision OCR daemon is unavailable."));
    }
    const id = randomUUID();
    this.clearIdleTimer();
    return new Promise<VisionOcrResult>((resolveRequest, reject) => {
      const onAbort = () => {
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        clearTimeout(request.timer);
        reject(abortError(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        request.removeAbortListener();
        reject(new Error("Apple Vision OCR daemon timed out after 15000 ms."));
      }, 15_000);
      this.pending.set(id, {
        resolve: resolveRequest,
        reject,
        timer,
        removeAbortListener: () => signal?.removeEventListener("abort", onAbort),
      });
      const payload = JSON.stringify({
        id,
        mode,
        imageBase64: bytes.toString("base64"),
      });
      this.child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        clearTimeout(request.timer);
        request.removeAbortListener();
        reject(new Error(`Unable to write to Apple Vision OCR daemon: ${error.message}`));
      });
    });
  }

  stop() {
    if (this.closed) return;
    this.finish(new Error("Apple Vision OCR daemon stopped."));
    this.child.kill("SIGTERM");
  }

  private finish(error: Error) {
    if (this.closed) return;
    this.closed = true;
    this.clearIdleTimer();
    process.removeListener("exit", this.processExit);
    this.rejectAll(error);
    this.onStopped();
  }

  private handleLine(line: string) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = typeof payload.id === "string" ? payload.id : "";
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    request.removeAbortListener();
    if (typeof payload.error === "string" && payload.error) {
      request.reject(new Error(`Apple Vision OCR failed: ${payload.error}`));
      this.scheduleIdleStop();
      return;
    }
    const result = payload.result as Partial<VisionOcrResult> | undefined;
    if (
      result?.ok !== true ||
      !Number.isInteger(result.imageWidth) ||
      !Number.isInteger(result.imageHeight) ||
      !Array.isArray(result.items)
    ) {
      request.reject(new Error("Apple Vision OCR daemon returned an invalid response."));
      this.scheduleIdleStop();
      return;
    }
    request.resolve(result as VisionOcrResult);
    this.scheduleIdleStop();
  }

  private rejectAll(error: Error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.removeAbortListener();
      request.reject(error);
    }
    this.pending.clear();
  }

  private scheduleIdleStop() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (!this.pending.size) this.stop();
    }, OCR_DAEMON_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer() {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

async function visionOcrDaemon(signal?: AbortSignal) {
  if (!daemonPromise) {
    daemonPromise = (async () => {
      const executable = await ensureVisionOcrDaemonBinary(signal);
      const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
      const daemon = new VisionOcrDaemon(child, () => {
        if (activeDaemon !== daemon) return;
        activeDaemon = null;
        daemonPromise = null;
      });
      activeDaemon = daemon;
      return daemon;
    })().catch((error) => {
      daemonPromise = null;
      throw error;
    });
  }
  return daemonPromise;
}

function resetVisionOcrDaemon() {
  const current = daemonPromise;
  daemonPromise = null;
  void current?.then((daemon) => daemon.stop()).catch(() => undefined);
}

export async function shutdownVisionOcrDaemon() {
  const current = daemonPromise;
  daemonPromise = null;
  activeDaemon = null;
  const daemon = await current?.catch(() => null);
  daemon?.stop();
}

export async function warmVisionOcrDaemon(signal?: AbortSignal) {
  const daemon = await visionOcrDaemon(signal);
  const image = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  }).jpeg({ quality: 75 }).toBuffer();
  await daemon.recognize(image, "fast", signal);
}

async function ensureVisionOcrBinary(signal?: AbortSignal) {
  if (!binaryPromise) {
    binaryPromise = (async () => {
      let shouldCompile = false;
      try {
        await access(binaryPath);
        const [source, binary] = await Promise.all([
          stat(sourcePath),
          stat(binaryPath),
        ]);
        shouldCompile = source.mtimeMs > binary.mtimeMs;
      } catch {
        shouldCompile = true;
      }
      if (shouldCompile) {
        await mkdir(dirname(binaryPath), { recursive: true });
        await compileVision(sourcePath, binaryPath, signal);
      }
      return binaryPath;
    })().catch((error) => {
      binaryPromise = null;
      throw error;
    });
  }
  return binaryPromise;
}

async function ensureVisionOcrDaemonBinary(signal?: AbortSignal) {
  if (!daemonBinaryPromise) {
    daemonBinaryPromise = compileIfNeeded(
      daemonSourcePath,
      daemonBinaryPath,
      signal,
    ).catch((error) => {
      daemonBinaryPromise = null;
      throw error;
    });
  }
  return daemonBinaryPromise;
}

async function compileIfNeeded(source: string, binary: string, signal?: AbortSignal) {
  let shouldCompile = false;
  try {
    await access(binary);
    const [sourceStat, binaryStat] = await Promise.all([stat(source), stat(binary)]);
    shouldCompile = sourceStat.mtimeMs > binaryStat.mtimeMs;
  } catch {
    shouldCompile = true;
  }
  if (shouldCompile) {
    await mkdir(dirname(binary), { recursive: true });
    await compileVision(source, binary, signal);
  }
  return binary;
}

async function compileVision(source: string, binary: string, signal?: AbortSignal) {
  // Use installed standalone tools when no explicit toolchain was selected.
  // The global xcode-select path can point at an incomplete Xcode installation;
  // do not change that machine-wide setting just to build this local worker.
  const standalone = "/Library/Developer/CommandLineTools";
  const available = !process.env.DEVELOPER_DIR && await access(`${standalone}/usr/bin/swiftc`).then(() => true, () => false);
  const directory=await mkdtemp(resolve(dirname(binary),"ocr-compile-"));
  const built=resolve(directory,"vision-ocr");
  try {
    await runFile("/usr/bin/swiftc", [source, "-O", "-o", built], signal, 90_000,
      available ? {...process.env, DEVELOPER_DIR: standalone} : process.env);
    signal?.throwIfAborted();await rename(built,binary);
  }finally{await rm(directory,{recursive:true,force:true});}
}

function boundedIdleMs(value: string | undefined) {
  if (value === undefined) return 300_000;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 300_000;
  return Math.min(3_600_000, Math.max(10_000, Math.round(parsed)));
}

function decodeImageDataUrl(value: string) {
  const match = value.match(/^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("Vision OCR requires a base64 image data URL.");
  const bytes = Buffer.from(match[1], "base64");
  if (!bytes.length) throw new Error("Vision OCR received an empty image.");
  return bytes;
}

async function prepareOcrImage(bytes: Buffer) {
  const image = sharp(bytes, { failOn: "error" });
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (Math.max(width, height) <= OCR_MAX_LONG_EDGE) return bytes;
  return image
    .resize({
      width: OCR_MAX_LONG_EDGE,
      height: OCR_MAX_LONG_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

function runFile(
  executable: string,
  args: string[],
  signal: AbortSignal | undefined,
  timeout: number,
  env = process.env,
) {
  return new Promise<string>((resolveRun, reject) => {
    execFile(
      executable,
      args,
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, signal, timeout, env },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(
            `${executable} failed: ${stderr.trim() || error.message}`,
            { cause: error },
          ));
          return;
        }
        resolveRun(stdout);
      },
    );
  });
}

function abortError(signal?: AbortSignal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The OCR request was aborted.", "AbortError");
}
