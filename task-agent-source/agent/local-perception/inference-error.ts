export type InferenceErrorCode="timeout"|"cancelled"|"http"|"transport"|"invalid_json"|"invalid_schema"|"invalid_evidence"|"incomplete"|"response_limit"|"internal";
const labels:Record<InferenceErrorCode,string>={timeout:"模型请求超时",cancelled:"请求已取消",http:"模型服务拒绝请求",transport:"模型网络连接失败",invalid_json:"模型返回的 JSON 无法解析",invalid_schema:"模型返回格式不符合约定",invalid_evidence:"模型引用了不存在或不足的画面证据",incomplete:"模型输出未完整结束",response_limit:"模型响应超过大小限制",internal:"推理处理失败（原因未分类）"};
export class InferenceError extends Error {
  constructor(readonly code:InferenceErrorCode,readonly details:{timeoutMs?:number;httpStatus?:number}={}) {
    super(labels[code]+(details.timeoutMs?`（${details.timeoutMs} ms）`:details.httpStatus?`（HTTP ${details.httpStatus}）`:""));
  }
}
/** Never expose provider bodies, validation input, OCR text or credentials. */
export function inferenceFailure(error:unknown,options:{cancelled?:boolean;timedOut?:boolean;timeoutMs?:number}={}):InferenceError {
  if(options.cancelled)return new InferenceError("cancelled");
  if(options.timedOut)return new InferenceError("timeout",{timeoutMs:options.timeoutMs});
  if(error instanceof InferenceError)return error;
  if(error instanceof Error) {
    if(error.name==="TimeoutError")return new InferenceError("timeout",{timeoutMs:options.timeoutMs});
    if(error.name==="AbortError")return new InferenceError("cancelled");
    if(error.name==="ZodError")return new InferenceError("invalid_schema");
    if(error instanceof SyntaxError)return new InferenceError("invalid_json");
    if(error instanceof TypeError)return new InferenceError("transport");
  }
  return new InferenceError("internal");
}
