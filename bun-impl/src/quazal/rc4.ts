/** RC4 keystream generator. */
export class Rc4 {
  private i = 0;
  private j = 0;
  private readonly state = new Uint8Array(256);

  constructor(key: Uint8Array) {
    if (key.length === 0 || key.length > 256) {
      throw new Error("RC4 key length must be between 1 and 256 bytes");
    }
    for (let i = 0; i < 256; i++) {
      this.state[i] = i;
    }
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + this.state[i] + key[i % key.length]) & 0xff;
      [this.state[i], this.state[j]] = [this.state[j], this.state[i]];
    }
  }

  next() {
    this.i = (this.i + 1) & 0xff;
    this.j = (this.j + this.state[this.i]) & 0xff;
    [this.state[this.i], this.state[this.j]] = [this.state[this.j], this.state[this.i]];
    return this.state[(this.state[this.i] + this.state[this.j]) & 0xff];
  }

  /** XORs `data` with the keystream. */
  apply(data: Uint8Array) {
    const result = Buffer.alloc(data.length);
    for (let k = 0; k < data.length; k++) {
      result[k] = data[k] ^ this.next();
    }
    return result;
  }
}

/** Encrypts/decrypts `data` with a fresh RC4 keystream for `key`. */
export function cryptKey(key: Uint8Array, data: Uint8Array) {
  return new Rc4(key).apply(data);
}
