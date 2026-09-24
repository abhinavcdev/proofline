/**
 * Minimal ambient types for the Workers runtime pieces this app uses. The full
 * @cloudflare/workers-types package redefines DOM globals, which conflicts with
 * the shared tsconfig; this keeps typecheck self-contained.
 */
declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}

interface DurableObjectState {
  readonly id: { toString(): string };
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectNamespace<T = unknown> {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub<T>;
}

type DurableObjectStub<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

interface Hyperdrive {
  readonly connectionString: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  readonly props: unknown;
}
