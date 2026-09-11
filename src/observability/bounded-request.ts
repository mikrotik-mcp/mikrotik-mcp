/** Bound browser-created operations before decoding JSON or invoking a handler. */
export class DashboardInputError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function readOperationBody(req: Request, limit = 8192): Promise<string> {
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin)
    throw new DashboardInputError(403, "Cross-origin operation denied");
  if (Number(req.headers.get("content-length")) > limit)
    throw new DashboardInputError(413, "Request too large");
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new DashboardInputError(413, "Request too large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
