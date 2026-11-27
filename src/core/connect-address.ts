import { endpointAddress } from "./device-endpoints";

/** Give the preferred address a head start, then overlap connection setup only. */
export const ADDRESS_HEAD_START_MS = 250;

export function connectAddress<T>(
  hosts: string[],
  port: number,
  connect: (host: string, signal: AbortSignal) => Promise<T>,
  stopOnError: (message: string) => boolean,
  onAttempt?: (host: string, error?: string) => void,
): Promise<{ host: string; value: T }> {
  return new Promise((resolve, reject) => {
    const pending = new Set<AbortController>();
    const errors: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let next = 0;
    let finished = false;
    const finish = () => {
      finished = true;
      clearTimeout(timer);
      for (const attempt of pending) attempt.abort();
    };
    const start = () => {
      clearTimeout(timer);
      if (next >= hosts.length) {
        if (!pending.size) {
          finish();
          reject(new Error(errors.join("; ") || "No management addresses configured"));
        }
        return;
      }
      const host = hosts[next++]!;
      const controller = new AbortController();
      pending.add(controller);
      if (next < hosts.length) timer = setTimeout(start, ADDRESS_HEAD_START_MS);
      void connect(host, controller.signal).then(
        (value) => {
          if (finished) return;
          pending.delete(controller);
          finish();
          onAttempt?.(host);
          resolve({ host, value });
        },
        (error: unknown) => {
          if (finished) return;
          pending.delete(controller);
          const message = error instanceof Error ? error.message : String(error);
          onAttempt?.(host, message);
          errors.push(`${endpointAddress(host, port)}: ${message}`);
          if (stopOnError(message)) {
            finish();
            reject(new Error(errors.join("; ")));
          } else {
            start();
          }
        },
      );
    };
    start();
  });
}
