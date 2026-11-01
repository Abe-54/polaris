/**
 * Fits and seals this Host's slice of the aggregate Live Activity (docs/adr/0088): the slice
 * contract lives in `@polaris/protocol/relay` (live.ts). A slice is sealed to the device like
 * a push, but under info `polaris-live/1`, so it can't be replayed as a notification.
 */
import {
  encodeHostSlice,
  fitSlice,
  fromBase64Url,
  type HostSlice,
  LIVE_HPKE_INFO,
  PUSH_ENC_BYTES,
  toBase64Url,
} from "@polaris/protocol/relay";
import { Option } from "effect";

const info = new TextEncoder().encode(LIVE_HPKE_INFO);

/** `slice`, fitted, sealed to `pushKey` (uncompressed P-256, base64url). */
export const sealSlice = async (pushKey: string, slice: HostSlice): Promise<string> => {
  const { pushSuite } = await import("./seal.ts");
  const key = Option.getOrThrow(fromBase64Url(pushKey));
  const recipientPublicKey = await pushSuite.kem.deserializePublicKey(new Uint8Array(key));
  const sender = await pushSuite.createSenderContext({ recipientPublicKey, info });

  const sealed = new Uint8Array(
    await sender.seal(new TextEncoder().encode(encodeHostSlice(fitSlice(slice))))
  );

  const out = new Uint8Array(PUSH_ENC_BYTES + sealed.byteLength);
  out.set(new Uint8Array(sender.enc));
  out.set(sealed, PUSH_ENC_BYTES);

  return toBase64Url(out);
};
