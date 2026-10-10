import { describe, expect, it } from 'vitest';
import { statesBelow } from './emergency.mapper';

describe('alert receipt states', () => {
  it('only moves a delivery state forward', () => {
    expect(statesBelow('DELIVERED_TO_DEVICE').sort()).toEqual(
      ['FAILED', 'QUEUED', 'SENT_TO_GATEWAY'].sort(),
    );
    expect(statesBelow('READ')).not.toContain('READ');
    expect(statesBelow('READ')).not.toContain('ACKNOWLEDGED');
  });

  it('never wakes recipients who were not alerted (later levels, skipped)', () => {
    for (const target of ['DELIVERED_TO_DEVICE', 'READ', 'ACKNOWLEDGED'] as const) {
      expect(statesBelow(target)).not.toContain('PENDING');
      expect(statesBelow(target)).not.toContain('SKIPPED');
    }
  });
});
