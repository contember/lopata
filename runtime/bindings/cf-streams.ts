/**
 * Cloudflare-specific stream classes: IdentityTransformStream and FixedLengthStream.
 */

/**
 * IdentityTransformStream — passes bytes through unchanged.
 * Functionally equivalent to `new TransformStream()` but semantically indicates byte stream passthrough.
 */
export class IdentityTransformStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor() {
    super();
  }
}

/**
 * FixedLengthStream — enforces exact byte count.
 * Errors if total bytes written exceed `expectedLength` or if closed before reaching it.
 */
export class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  readonly expectedLength: number;

  constructor(expectedLength: number | bigint) {
    const length = Number(expectedLength);
    if (!Number.isFinite(length) || length < 0) {
      throw new TypeError("FixedLengthStream requires a non-negative length");
    }

    let bytesWritten = 0;

    super({
      transform(chunk, controller) {
        bytesWritten += chunk.byteLength;
        if (bytesWritten > length) {
          controller.error(
            new TypeError(
              `FixedLengthStream: exceeded expected length of ${length} bytes (got ${bytesWritten})`
            )
          );
          return;
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (bytesWritten < length) {
          controller.error(
            new TypeError(
              `FixedLengthStream: stream closed with ${bytesWritten} bytes, expected ${length}`
            )
          );
        }
      },
    });

    this.expectedLength = length;
  }
}
