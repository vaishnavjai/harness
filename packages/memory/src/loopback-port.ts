import { createServer } from "node:net";

export const LOOPBACK_HOST = "127.0.0.1";

/** Whether nothing is listening on 127.0.0.1:port right now. */
export function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: LOOPBACK_HOST, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** An ephemeral 127.0.0.1 port the OS reports as free. */
export function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("Could not allocate a loopback port"))));
    });
  });
}
