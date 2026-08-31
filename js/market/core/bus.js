// Late binding between market modules, so a feature never has to import the shell.
//
// The dependency runs one way by design: the shell imports features, features import
// core/. But a feature still has to be able to say "repaint the panel" or "start tracking
// this bridge", and importing the shell back would make a cycle whose evaluation order is
// exactly the kind of thing that breaks quietly in money-handling code.
//
// So the shell registers what it offers, once, at boot; features call it through `shell`.
// This is the same trick js/app.js already uses for its feature modules (see lazy()), and
// it replaces the window CustomEvent hop that js/profile.js needs for the same reason.
//
//   // shell, at boot
//   provide({ render, runBridge, showGasHelp });
//
//   // feature, any time after
//   import { shell } from './core/bus.js';
//   shell.render();
//
// Calling something nobody registered logs which name was missing and returns undefined,
// rather than throwing "undefined is not a function" from three frames away.

const impls = Object.create(null);

/** Register implementations. Call once from the shell at boot; later calls merge. */
export function provide(map) { Object.assign(impls, map); }

/** True when `name` has an implementation — for the rare caller that wants to degrade. */
export const has = name => typeof impls[name] === 'function';

export const shell = new Proxy(Object.create(null), {
  get: (_t, name) => (...args) => {
    const fn = impls[name];
    if (typeof fn !== 'function') {
      console.error(`[market] nothing provides "${String(name)}" — did the shell forget to register it?`);
      return undefined;
    }
    return fn(...args);
  },
  // So `'render' in shell` and console inspection tell the truth.
  has: (_t, name) => name in impls,
  ownKeys: () => Reflect.ownKeys(impls),
  getOwnPropertyDescriptor: (_t, name) =>
    (name in impls ? { value: impls[name], enumerable: true, configurable: true } : undefined),
});
