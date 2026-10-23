import sandboxHtml from '../../public/sandbox.html?raw';

// Server-side validation must run a driver exactly as the presenter's sandbox does, so it reuses the
// runtime helpers shipped in public/sandbox.html instead of keeping a second copy.
const HELPERS_START = '/* runner-helpers:start';
const HELPERS_END = '/* runner-helpers:end */';

function runnerHelpers(): string {
  const start = sandboxHtml.indexOf(HELPERS_START);
  const end = sandboxHtml.indexOf(HELPERS_END, start);
  if (start < 0 || end < 0) throw new Error('sandbox.html is missing its runner-helpers markers.');
  return sandboxHtml.slice(sandboxHtml.indexOf('\n', start) + 1, end);
}

/**
 * Body of a function that evaluates compiled driver code (from compileUserCode) and returns its
 * `autopilot` function, or undefined if the code does not define one. Inspection hooks are no-ops.
 */
export function driverFactoryBody(js: string): string {
  return `'use strict';
// graph(...) only feeds the presenter's telemetry charts; it sits outside the driver's scope, as in the browser sandbox.
const graph = (name, value) => value;
return (() => {
const __playgroundTraceValue = (id, value) => value;
const __playgroundTracePostfix = (id, readCurrent, expressionResult) => expressionResult;
const __playgroundTraceToolboxCall = (id, name, fn, args) => Reflect.apply(fn, undefined, args);
const exports = {};
const module = { exports };
// Same shadowed names as the browser sandbox, so code that redeclares one fails in both places.
const require = () => { throw new Error('Network, storage, and import APIs are disabled for autopilot code.'); };
const fetch = require;
const XMLHttpRequest = undefined;
const WebSocket = undefined;
const EventSource = undefined;
const importScripts = require;
const localStorage = undefined;
const sessionStorage = undefined;
const indexedDB = undefined;
const caches = undefined;
const postMessage = undefined;
${runnerHelpers()}
${js}
return module.exports.autopilot || exports.autopilot || (typeof autopilot === 'function' ? autopilot : undefined);
})();`;
}

/**
 * ES module for a Cloudflare Dynamic Worker that runs one driver. `start()` returns a session whose
 * `step()` runs one autopilot call, so a whole test drive is a single billed RPC session. Load errors
 * are thrown from `start()` rather than at startup, so the validator can tell players what went wrong.
 */
export function driverWorkerModule(js: string): string {
  return `import { RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';
// The loader also cuts this worker off from the network; these make attempts fail fast instead of hanging.
const __blocked = () => { throw new Error('Network, storage, and import APIs are disabled for autopilot code.'); };
for (const name of ['fetch', 'connect', 'caches', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
  try { Object.defineProperty(globalThis, name, { value: name === 'fetch' || name === 'connect' ? __blocked : undefined, writable: false, configurable: false }); } catch (_) {}
}
let __autopilot;
let __loadError;
try {
  __autopilot = (() => {
${driverFactoryBody(js)}
  })();
  if (typeof __autopilot !== 'function') __loadError = 'User code must export or define function autopilot(input).';
} catch (error) {
  __loadError = error && error.message ? String(error.message) : String(error);
}
class Session extends RpcTarget {
  step(input) {
    const output = __autopilot(input);
    if (output && typeof output.then === 'function') throw new Error('autopilot(input) must return its output directly, not a Promise.');
    return output;
  }
}
export default class Driver extends WorkerEntrypoint {
  start() {
    if (__loadError !== undefined) throw new Error(__loadError);
    return new Session();
  }
}
`;
}
