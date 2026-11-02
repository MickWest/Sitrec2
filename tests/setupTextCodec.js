// jsdom has no TextDecoder or TextEncoder, and browsers do. The MISB decoder makes
// a TextDecoder when it loads, so a suite in jsdom cannot import it without these.
import {TextDecoder, TextEncoder} from "util";

globalThis.TextDecoder ??= TextDecoder;
globalThis.TextEncoder ??= TextEncoder;
