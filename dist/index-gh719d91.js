// @bun
// src/clip/bounded-byte-buffer.ts
class BoundedByteBuffer {
  #maxBytes;
  #storage = new Uint8Array;
  #length = 0;
  constructor(maxBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError("byte buffer limit must be a non-negative safe integer");
    }
    this.#maxBytes = maxBytes;
  }
  get byteLength() {
    return this.#length;
  }
  append(chunk) {
    if (chunk.byteLength > this.#maxBytes - this.#length)
      return false;
    if (chunk.byteLength === 0)
      return true;
    const required = this.#length + chunk.byteLength;
    if (required > this.#storage.byteLength)
      this.#grow(required);
    this.#storage.set(chunk, this.#length);
    this.#length = required;
    return true;
  }
  toUint8Array() {
    if (this.#length === this.#storage.byteLength)
      return this.#storage;
    return this.#storage.slice(0, this.#length);
  }
  #grow(required) {
    let capacity = this.#storage.byteLength;
    if (capacity === 0)
      capacity = Math.min(this.#maxBytes, Math.max(1024, required));
    while (capacity < required) {
      capacity = capacity <= Math.floor(this.#maxBytes / 2) ? capacity * 2 : this.#maxBytes;
    }
    const grown = new Uint8Array(capacity);
    grown.set(this.#storage.subarray(0, this.#length));
    this.#storage = grown;
  }
}
async function readBoundedByteStream(stream, maxBytes, overflowLabel = "stream") {
  const bytes = new BoundedByteBuffer(maxBytes);
  const reader = stream.getReader();
  try {
    for (;; ) {
      const result = await reader.read();
      if (result.done)
        break;
      if (!bytes.append(result.value)) {
        throw new Error(`${overflowLabel} exceeded ${maxBytes} bytes`);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return bytes.toUint8Array();
}

export { BoundedByteBuffer, readBoundedByteStream };
