import { Global, Inject, Injectable, Module } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/config';

const ENVELOPE_VERSION = 'v1';

/**
 * Application-level cryptography helpers. Uses only standard primitives from node:crypto
 * (AES-256-GCM, HMAC-SHA256, HKDF); no custom constructions.
 */
@Injectable()
export class CryptoService {
  private readonly encryptionKey: Buffer;
  private readonly hmacKey: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const master = Buffer.from(config.DATA_ENCRYPTION_KEY, 'base64');
    // Derive independent keys so the encryption key is never used for hashing.
    this.encryptionKey = Buffer.from(
      hkdfSync('sha256', master, Buffer.alloc(0), 'storeline:aes-gcm', 32),
    );
    this.hmacKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'storeline:hmac', 32));
  }

  /** Encrypts a UTF-8 string. Output: "v1.<iv>.<tag>.<ciphertext>" (base64url parts). */
  encrypt(plaintext: string, associatedData: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [ENVELOPE_VERSION, iv, tag, ciphertext]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  decrypt(envelope: string, associatedData: string): string {
    const [version, iv, tag, ciphertext] = envelope.split('.');
    if (version !== ENVELOPE_VERSION || !iv || !tag || ciphertext === undefined) {
      throw new Error('Unsupported ciphertext envelope');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** Keyed hash for values we must match but should not store raw (IP addresses). */
  keyedHash(value: string): string {
    return createHmac('sha256', this.hmacKey).update(value).digest('hex');
  }

  /** High-entropy opaque token (refresh tokens). */
  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /** SHA-256 for high-entropy secrets (tokens) where a keyed hash is unnecessary. */
  sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}

@Global()
@Module({ providers: [CryptoService], exports: [CryptoService] })
export class CryptoModule {}
