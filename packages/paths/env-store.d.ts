export declare class EnvStoreLockedError extends Error {
  constructor(message?: string);
}

export declare function deriveEnvStoreKey(rootKey: Uint8Array): Buffer;

export declare function encryptEnvStore(
  payload: { updatedAt: number; variables: Array<{ key: string; value: string; updatedAt: number }> },
  key: Uint8Array,
): string;

export declare function decryptEnvStore(
  text: string,
  key: Uint8Array | null,
): { encrypted: boolean; updatedAt: number | null; variables: unknown[] };
