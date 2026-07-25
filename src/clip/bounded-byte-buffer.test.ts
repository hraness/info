import { describe, expect, test } from "bun:test";

import { BoundedByteBuffer, readBoundedByteStream } from "./bounded-byte-buffer.js";

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to reject");
}

describe("BoundedByteBuffer", () => {
  test("copies chunks into owned storage and returns exact bytes", () => {
    const source = new Uint8Array([1, 2, 3]);
    const buffer = new BoundedByteBuffer(8);
    expect(buffer.append(source)).toBeTrue();
    source.fill(9);
    expect(buffer.append(new Uint8Array([4, 5]))).toBeTrue();
    expect(buffer.byteLength).toBe(5);
    expect([...buffer.toUint8Array()]).toEqual([1, 2, 3, 4, 5]);
  });

  test("rejects an overflowing chunk without changing retained content", () => {
    const buffer = new BoundedByteBuffer(4);
    expect(buffer.append(new Uint8Array([1, 2, 3]))).toBeTrue();
    expect(buffer.append(new Uint8Array([4, 5]))).toBeFalse();
    expect(buffer.byteLength).toBe(3);
    expect([...buffer.toUint8Array()]).toEqual([1, 2, 3]);
  });

  test("handles zero-byte limits and rejects invalid bounds", () => {
    const empty = new BoundedByteBuffer(0);
    expect(empty.append(new Uint8Array())).toBeTrue();
    expect(empty.append(new Uint8Array([1]))).toBeFalse();
    expect(empty.toUint8Array()).toHaveLength(0);
    expect(() => new BoundedByteBuffer(-1)).toThrow();
    expect(() => new BoundedByteBuffer(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("readBoundedByteStream", () => {
  test("collects chunks into exact owned bytes and releases the reader", async () => {
    const source = new Uint8Array([1, 2, 3]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(source);
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });

    const bytes = await readBoundedByteStream(stream, 5);
    source.fill(9);

    expect([...bytes]).toEqual([1, 2, 3, 4, 5]);
    expect(stream.locked).toBeFalse();
  });

  test("preserves the configured overflow label and releases the reader", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });

    const error = await rejectedValue(readBoundedByteStream(stream, 4, "process output"));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("process output exceeded 4 bytes");
    expect(stream.locked).toBeFalse();
  });

  test("releases the reader without masking a stream failure", async () => {
    const failure = new Error("synthetic stream failure");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    });

    expect(await rejectedValue(readBoundedByteStream(stream, 4))).toBe(failure);
    expect(stream.locked).toBeFalse();
  });

  test("rejects an invalid bound before locking the stream", async () => {
    const stream = new ReadableStream<Uint8Array>();

    const error = await rejectedValue(readBoundedByteStream(stream, -1));
    expect(error).toBeInstanceOf(RangeError);
    expect((error as RangeError).message).toBe("byte buffer limit must be a non-negative safe integer");
    expect(stream.locked).toBeFalse();
  });
});
