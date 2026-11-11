import { EventEmitter } from 'node:events';
import { Readable, type Writable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';

import { isLegacyStoragePlugin, wrapLegacyStoragePlugin } from '../src/legacy-storage-adapter';

function legacyUpload() {
  const upload = new EventEmitter() as EventEmitter & {
    write: (chunk: any) => boolean;
    end: () => void;
    done: () => void;
    abort: () => void;
  };
  upload.write = () => true;
  upload.end = vi.fn();
  upload.done = vi.fn();
  upload.abort = vi.fn();
  return upload;
}

describe('legacy-storage-adapter', () => {
  test('detects callback-based storage plugins', () => {
    expect(isLegacyStoragePlugin({ get: (cb: any) => cb(null, []) })).toBe(true);
    expect(isLegacyStoragePlugin({ get: async () => [] })).toBe(false);
  });

  test('aborting a write does not emit an uncaught error', async () => {
    const upload = legacyUpload();
    const plugin = {
      get: (cb: any) => cb(null, []),
      add: (_name: string, cb: any) => cb(),
      remove: (_name: string, cb: any) => cb(),
      search: (_onPkg: any, onEnd: any) => onEnd(),
      getSecret: () => 'secret',
      setSecret: () => undefined,
      getPackageStorage: () => ({
        writeTarball: () => upload,
        readTarball: () => Readable.from([]),
        readPackage: (_n: string, cb: any) => cb(null, {}),
        createPackage: (_n: string, _m: any, cb: any) => cb(),
        savePackage: (_n: string, _v: any, cb: any) => cb(),
        deletePackage: (_f: string, cb: any) => cb(),
        removePackage: (cb: any) => cb(),
        updatePackage: () => undefined,
      }),
    };
    const logger = { warn: vi.fn() } as any;
    const wrapped = wrapLegacyStoragePlugin(plugin, logger);
    const handler = wrapped.getPackageStorage('foo');
    const abort = new AbortController();
    const bridge = (await handler.writeTarball('foo-1.0.0.tgz', {
      signal: abort.signal,
    })) as Writable;

    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      abort.abort();
      await new Promise((resolve) => setImmediate(resolve));
      expect(upload.abort).toHaveBeenCalledOnce();
      expect(bridge.destroyed).toBe(true);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      bridge.destroy();
    }
  });
});
