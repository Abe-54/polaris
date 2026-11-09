import * as ffi from "bun:ffi";
import { ptr, ptr as address } from "bun:ffi";

declare const call: (...args: ReadonlyArray<unknown>) => number;
const view = new Uint8Array(8);

call(ptr(view));
call(1, address(view, 4));
call(ffi.ptr(view));
call(ptr(view) as never);
call(view);
call(view.subarray(4));
const stored = BigInt(ptr(view));
const at = ptr(view, 4);
call(stored, at);
