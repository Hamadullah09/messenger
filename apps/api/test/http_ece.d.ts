/** Minimal typings for http_ece (RFC 8188/8291 content encoding), used to decrypt test pushes. */
declare module 'http_ece' {
  import type { ECDH } from 'node:crypto';
  export function decrypt(
    buffer: Buffer,
    params: { version: 'aes128gcm'; privateKey: ECDH; authSecret: Buffer },
  ): Buffer;
  const ece: { decrypt: typeof decrypt };
  export default ece;
}
