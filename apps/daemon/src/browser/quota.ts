/**
 * How many byte streams each connection holds open, of both kinds together (ENG-613): a
 * Browser opens many connections at once, but no one Client may hold the Daemon's buffers.
 */
import { MAX_BYTE_STREAMS_PER_CONNECTION } from "@polaris/protocol";
import { Context, Layer } from "effect";

export class ByteStreamQuota extends Context.Service<
  ByteStreamQuota,
  {
    /** Counts one more stream for the connection; false when it is at the limit. */
    readonly acquire: (connectionId: number) => boolean;
    readonly release: (connectionId: number) => void;
    readonly open: (connectionId: number) => number;
  }
>()("polaris/daemon/browser/ByteStreamQuota") {
  static make(limit = MAX_BYTE_STREAMS_PER_CONNECTION): ByteStreamQuota["Service"] {
    const open = new Map<number, number>();

    return ByteStreamQuota.of({
      acquire: (connectionId) => {
        const count = open.get(connectionId) ?? 0;

        if (count >= limit) return false;
        open.set(connectionId, count + 1);

        return true;
      },
      release: (connectionId) => {
        const count = (open.get(connectionId) ?? 0) - 1;

        if (count <= 0) open.delete(connectionId);
        else open.set(connectionId, count);
      },
      open: (connectionId) => open.get(connectionId) ?? 0,
    });
  }

  static layer(limit?: number) {
    return Layer.sync(ByteStreamQuota)(() => ByteStreamQuota.make(limit));
  }
}
