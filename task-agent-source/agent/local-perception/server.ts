import dotenv from "dotenv";
import { LocalPerceptionService } from "./service";
import { warmVisionOcrDaemon, shutdownVisionOcrDaemon } from "../vision-ocr";
import { OpenRouterTextClassifier, TextSemanticAssistant } from "./text-semantics";
import { createPerceptionServer } from "./http";
import { actionContextReader } from "./action-context";

dotenv.config({quiet:true});
const port = Number(process.env.SCREENHAND_PERCEPTION_PORT ?? 3026);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid local perception port");
const base=process.env.SCREENHAND_API_URL ?? "http://127.0.0.1:3013";
const service = new LocalPerceptionService(base,undefined,undefined,actionContextReader(base));
const semantics = new TextSemanticAssistant(process.env.SCREENHAND_TEXT_SEMANTICS_ENABLED === "1" && process.env.OPENROUTER_API_KEY?.trim()
  ? new OpenRouterTextClassifier({apiKey:process.env.OPENROUTER_API_KEY,model:process.env.SCREENHAND_TEXT_SEMANTICS_MODEL,timeoutMs:Number(process.env.SCREENHAND_TEXT_SEMANTICS_TIMEOUT_MS ?? 5000)}) : null,
  ()=>Date.now(),30,record=>console.log("[text-semantics]",JSON.stringify(record)));
const warmup = warmVisionOcrDaemon().catch(error => console.error("[local-perception] OCR warmup:", error.message));
const server=createPerceptionServer(service,semantics,warmup);
server.listen(port, "127.0.0.1", () => console.log(`[local-perception] http://127.0.0.1:${port}; text assistance ${semantics.enabled?"available (explicit POST only; GET never submits)":"disabled"}; no image uploads, no physical actions`));
let stopping = false;
for (const name of ["SIGINT", "SIGTERM"] as const) process.on(name, () => {
  if (stopping) return;
  stopping = true;
  semantics.close();
  server.close(); server.closeAllConnections();
  void shutdownVisionOcrDaemon().finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 3_000).unref();
});
