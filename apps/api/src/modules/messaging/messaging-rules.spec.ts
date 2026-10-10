import { describe, expect, it } from 'vitest';
import { canPost, unreadCount } from './mappers';
import { toPrefixTsQuery } from './search.service';

describe('toPrefixTsQuery', () => {
  it('builds a prefix query from words', () => {
    expect(toPrefixTsQuery('Inventory audit')).toBe('inventory:* & audit:*');
  });

  it('strips tsquery operators so user input cannot change the query structure', () => {
    expect(toPrefixTsQuery("inv:* & !') | <-> (x")).toBe('inv:* & x:*');
    expect(toPrefixTsQuery('!!! &&& |||')).toBeNull();
  });

  it('keeps non-Latin letters and digits', () => {
    expect(toPrefixTsQuery('café 42 Ünïcode')).toBe('café:* & 42:* & ünïcode:*');
  });

  it('caps the number of terms', () => {
    const query = toPrefixTsQuery(Array.from({ length: 20 }, (_, i) => `w${i}`).join(' '));
    expect(query?.split(' & ')).toHaveLength(8);
  });
});

describe('unreadCount', () => {
  it('counts messages after the read watermark', () => {
    expect(unreadCount(10, { historyFromSeq: 0, lastReadSeq: 7, markedUnread: false })).toBe(3);
  });

  it('never counts history from before the member joined', () => {
    expect(unreadCount(10, { historyFromSeq: 8, lastReadSeq: 0, markedUnread: false })).toBe(2);
  });

  it('shows at least one when manually marked unread', () => {
    expect(unreadCount(10, { historyFromSeq: 0, lastReadSeq: 10, markedUnread: true })).toBe(1);
    expect(unreadCount(10, { historyFromSeq: 0, lastReadSeq: 5, markedUnread: true })).toBe(5);
  });
});

describe('canPost', () => {
  const active = { business: { status: 'ACTIVE' }, archivedAt: null, type: 'GROUP' as const };

  it('lets everyone post in open groups', () => {
    expect(canPost({ ...active, postingPolicy: 'ALL_MEMBERS' }, { role: 'MEMBER' })).toBe(true);
  });

  it('restricts announcement groups to admins', () => {
    expect(canPost({ ...active, postingPolicy: 'ADMINS_ONLY' }, { role: 'MEMBER' })).toBe(false);
    expect(canPost({ ...active, postingPolicy: 'ADMINS_ONLY' }, { role: 'ADMIN' })).toBe(true);
  });

  it('blocks posting in archived conversations and inactive businesses', () => {
    expect(
      canPost(
        { ...active, postingPolicy: 'ALL_MEMBERS', archivedAt: new Date() },
        { role: 'ADMIN' },
      ),
    ).toBe(false);
    expect(
      canPost(
        { ...active, postingPolicy: 'ALL_MEMBERS', business: { status: 'SUSPENDED' } },
        { role: 'ADMIN' },
      ),
    ).toBe(false);
  });
});
