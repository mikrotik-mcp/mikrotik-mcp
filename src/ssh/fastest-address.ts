import { connect } from "node:net";
import type { Socket } from "node:net";

/** Each address starts this long after the one before it. */
export const ADDRESS_HEAD_START_MS = 500;

/**
 * Put the first address that accepts a TCP connection at the front.
 *
 * The addresses start one after another, so the primary wins when it answers
 * within its head start. A dead primary then costs half a second, not a whole
 * SSH timeout. When no address answers in `limitMs` the order stays as it was,
 * and the SSH attempts report the real errors.
 */
export function fastestFirst(hosts: string[], port: number, limitMs: number): Promise<string[]> {
  if (hosts.length < 2) return Promise.resolve(hosts);
  return new Promise((resolve) => {
    const sockets: Socket[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    let failed = 0;
    const done = (winner?: string): void => {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      resolve(winner ? [winner, ...hosts.filter((host) => host !== winner)] : hosts);
    };
    timers.push(setTimeout(done, limitMs));
    hosts.forEach((host, index) => {
      timers.push(
        setTimeout(() => {
          const socket = connect({ host, port });
          sockets.push(socket);
          socket.once("connect", () => done(host));
          socket.once("error", () => {
            failed += 1;
            if (failed === hosts.length) done();
          });
        }, index * ADDRESS_HEAD_START_MS),
      );
    });
  });
}
