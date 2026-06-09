// ScriptMath.js — tiny math helpers shared by the Scripted Video modules.

export const radians = (d) => d * Math.PI / 180;
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }; // smoothstep ease
