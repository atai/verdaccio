import buildDebug from 'debug';
import { Writable } from 'node:stream';

import type { Logger } from '@verdaccio/types';

const debug = buildDebug('verdaccio:storage:legacy-adapter');

type AnyFn = (...args: any[]) => any;

function fromCallback<T = any>(invoke: (cb: (err: any, data?: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    invoke((err, data) => (err ? reject(err) : resolve(data as T)));
  });
}

/** Detect a legacy callback-based storage plugin by method arity. */
export function isLegacyStoragePlugin(plugin: any): boolean {
  if (!plugin || typeof plugin.get !== 'function') {
    return false;
  }
  const getIsCallback = plugin.get.length >= 1;
  const addIsCallback = typeof plugin.add === 'function' && plugin.add.length >= 2;
  return getIsCallback || addIsCallback;
}

function hasPackage(handler: any, pkgName: string): Promise<boolean> {
  return new Promise((resolve) => {
    handler.readPackage(pkgName, (err: any) => resolve(!err));
  });
}

function hasTarball(handler: any, fileName: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let stream: any = handler.readTarball(fileName);
    let isOpen = false;
    stream.on('error', (err: any) => {
      const notFound = err?.code === 'ENOENT' || err?.status === 404;
      if (isOpen || !notFound) {
        if (!isOpen) {
          resolve(false);
        } else {
          reject(err);
        }
      } else {
        resolve(false);
      }
      stream?.abort?.();
      stream = null;
    });
    stream.on('open', () => {
      isOpen = true;
      stream.abort?.();
      stream = null;
      resolve(true);
    });
  });
}

function readTarball(handler: any, fileName: string, options: { signal?: AbortSignal } = {}) {
  const stream = handler.readTarball(fileName);
  const { signal } = options;
  if (signal) {
    if (signal.aborted) {
      stream.abort?.();
    } else {
      signal.addEventListener('abort', () => stream.abort?.(), { once: true });
    }
  }
  return Promise.resolve(stream);
}

function writeTarball(handler: any, fileName: string, options: { signal?: AbortSignal } = {}) {
  const upload = handler.writeTarball(fileName);
  const { signal } = options;

  const bridge = new Writable({
    write(chunk, _enc, cb): void {
      if (upload.write(chunk)) {
        cb();
      } else {
        upload.once('drain', cb);
      }
    },
    final(cb): void {
      upload.once('success', () => cb());
      upload.once('error', (err: any) => cb(err));
      upload.end();
      upload.done();
    },
  });

  upload.on('open', () => bridge.emit('open'));
  // Swallow late errors after destroy so abort cleanup cannot crash the process.
  upload.on('error', (err: any) => {
    if (!bridge.destroyed) {
      bridge.destroy(err);
    }
  });
  bridge.on('error', () => {});

  if (signal) {
    const onAbort = (): void => {
      debug('tarball upload aborted for %o', fileName);
      try {
        upload.abort?.();
      } catch {
        // plugin abort must not become an uncaught exception
      }
      if (!bridge.destroyed) {
        // Destroy without a reason: pipeline({ signal }) already rejects with AbortError.
        bridge.destroy();
      }
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }
  return Promise.resolve(bridge);
}

function updatePackage(handler: any, name: string, handleUpdate: AnyFn): Promise<any> {
  return new Promise((resolve, reject) => {
    let updated: any;
    handler.updatePackage(
      name,
      (json: any, cb: (err?: any) => void) => {
        Promise.resolve(handleUpdate(json))
          .then((result) => {
            updated = result;
            cb();
          })
          .catch(cb);
      },
      (_name: string, _data: any, cb: (err?: any) => void) => cb(),
      (json: any) => updated ?? json,
      (err: any) => (err ? reject(err) : resolve(updated))
    );
  });
}

function wrapLegacyHandler(handler: any): any {
  if (!handler) {
    return handler;
  }
  return {
    readPackage: (name: string) => fromCallback((cb) => handler.readPackage(name, cb)),
    createPackage: (name: string, manifest: any) =>
      fromCallback((cb) => handler.createPackage(name, manifest, cb)),
    savePackage: (name: string, value: any) =>
      fromCallback((cb) => handler.savePackage(name, value, cb)),
    deletePackage: (fileName: string) => fromCallback((cb) => handler.deletePackage(fileName, cb)),
    removePackage: () => fromCallback((cb) => handler.removePackage(cb)),
    hasPackage: (name?: string) => hasPackage(handler, name as string),
    hasTarball: (fileName: string) => hasTarball(handler, fileName),
    readTarball: (fileName: string, options?: { signal?: AbortSignal }) =>
      readTarball(handler, fileName, options),
    writeTarball: (fileName: string, options?: { signal?: AbortSignal }) =>
      writeTarball(handler, fileName, options),
    updatePackage: (name: string, handleUpdate: AnyFn) =>
      updatePackage(handler, name, handleUpdate),
  };
}

function toSearchItem(item: any): any {
  if (item !== null && typeof item === 'object' && 'package' in item) {
    return item;
  }
  return {
    package: item,
    score: { final: 1, detail: { quality: 1, popularity: 1, maintenance: 1 } },
  };
}

function search(plugin: any, query: any): Promise<any[]> {
  const text = typeof query?.text === 'string' ? query.text.toLowerCase() : undefined;
  const matches = (name: unknown): boolean =>
    text === undefined || (typeof name === 'string' && name.toLowerCase().includes(text));

  return new Promise((resolve, reject) => {
    const items: any[] = [];
    try {
      plugin.search(
        (item: any, done: () => void) => {
          const searchItem = toSearchItem(item);
          if (matches(searchItem?.package?.name)) {
            items.push(searchItem);
          }
          done();
        },
        (err: any) => (err ? reject(err) : resolve(items)),
        () => true
      );
    } catch (err) {
      reject(err);
    }
  });
}

/** Wrap a legacy callback storage plugin for `@verdaccio/store`. */
export function wrapLegacyStoragePlugin(plugin: any, logger: Logger): any {
  debug('wrapping legacy callback storage plugin');
  logger.warn(
    'a legacy callback-based storage plugin was detected and wrapped for compatibility; ' +
      'consider upgrading it to the promise-based storage API'
  );

  const wrapped: Record<string, AnyFn> = {
    init: () =>
      typeof plugin.init === 'function'
        ? Promise.resolve(plugin.init())
        : Promise.resolve(undefined),
    getSecret: () => Promise.resolve(plugin.getSecret()),
    setSecret: (secret: string) => Promise.resolve(plugin.setSecret(secret)),
    get: () => fromCallback((cb) => plugin.get(cb)),
    add: (name: string) => fromCallback((cb) => plugin.add(name, cb)),
    remove: (name: string) => fromCallback((cb) => plugin.remove(name, cb)),
    search: (query: any) => search(plugin, query),
    getPackageStorage: (packageName: string) =>
      wrapLegacyHandler(plugin.getPackageStorage(packageName)),
  };

  for (const tokenMethod of ['saveToken', 'deleteToken', 'readTokens'] as const) {
    if (typeof plugin[tokenMethod] === 'function') {
      wrapped[tokenMethod] = (...args: any[]) => Promise.resolve(plugin[tokenMethod](...args));
    }
  }

  return Object.assign(Object.create(plugin), wrapped);
}
