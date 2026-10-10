import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

/**
 * argon2id with parameters above the OWASP minimum (m=19 MiB, t=2, p=1).
 * Hashes encode their parameters, so they can be raised later; `needsRehash` upgrades
 * stored hashes transparently at the next successful login.
 */
const OPTIONS = { type: argon2.argon2id, memoryCost: 47_104, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService {
  /** Pre-computed hash used to keep login timing uniform for unknown usernames. */
  private dummyHash: Promise<string> | null = null;

  hash(password: string): Promise<string> {
    return argon2.hash(password, OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, OPTIONS);
  }

  /** Spend comparable time when the user does not exist (prevents username enumeration by timing). */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash('storeline-timing-equaliser');
    await this.verify(await this.dummyHash, password);
  }
}
