import type { HttpBindings } from '@hono/node-server';

/**
 * Hono environment for the mock. `Bindings` are only present when served through
 * @hono/node-server (real sockets); `app.request()` in tests leaves them undefined.
 */
export type MockEnv = {
  Bindings: Partial<HttpBindings>;
  Variables: {
    droppedConnection?: boolean;
    userLogin?: string;
  };
};
