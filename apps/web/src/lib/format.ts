import type { MessageDto, SystemEventDto } from '@storeline/shared';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});
const shortDayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function formatTime(iso: string): string {
  return timeFormat.format(new Date(iso));
}

/** "Today", "Yesterday", or a full date — used for date separators. */
export function formatDay(iso: string, now = new Date()): string {
  const diffDays = Math.round((startOfDay(now) - startOfDay(new Date(iso))) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return dayFormat.format(new Date(iso));
}

/** Compact timestamp for conversation lists. */
export function formatListTime(iso: string, now = new Date()): string {
  const diffDays = Math.round((startOfDay(now) - startOfDay(new Date(iso))) / 86_400_000);
  if (diffDays === 0) return formatTime(iso);
  if (diffDays === 1) return 'Yesterday';
  return shortDayFormat.format(new Date(iso));
}

export function sameDay(a: string, b: string): boolean {
  return startOfDay(new Date(a)) === startOfDay(new Date(b));
}

/** Human-readable text for system messages. `nameOf` resolves user ids to display names. */
export function describeSystemEvent(event: SystemEventDto, nameOf: (id: string) => string): string {
  const actor = nameOf(event.actorId);
  switch (event.type) {
    case 'group_created':
      return `${actor} created the group “${event.title}”`;
    case 'members_added':
      return `${actor} added ${event.userIds.map(nameOf).join(', ')}`;
    case 'member_removed':
      return `${actor} removed ${nameOf(event.userId)}`;
    case 'member_left':
      return `${actor} left`;
    case 'group_renamed':
      return `${actor} renamed the group to “${event.title}”`;
    case 'admin_changed':
      return event.role === 'ADMIN'
        ? `${actor} made ${nameOf(event.userId)} a group admin`
        : `${actor} removed ${nameOf(event.userId)} as a group admin`;
    case 'emergency_raised':
      return `${actor} raised an emergency alert at ${event.storeName}`;
    case 'emergency_escalated':
      return `No response in time — alert escalated to ${event.userIds.map(nameOf).join(', ')}`;
    case 'emergency_joined':
      return `${actor} joined the response`;
    case 'emergency_acknowledged':
      return `${actor} is responding`;
    case 'emergency_resolved':
      return `${actor} marked the emergency resolved`;
    case 'emergency_cancelled':
      return `${actor} cancelled the alert — they are safe`;
  }
}

export function messagePreview(
  message: MessageDto | null,
  nameOf: (id: string) => string,
  myId?: string,
): string {
  if (!message) return 'No messages yet';
  if (message.deleted) return 'This message was deleted';
  if (message.systemEvent) return describeSystemEvent(message.systemEvent, nameOf);
  if (message.attachment) {
    const label =
      message.attachment.kind === 'IMAGE'
        ? '📷 Photo'
        : message.attachment.kind === 'VIDEO'
          ? '🎬 Video'
          : `📄 ${message.attachment.fileName}`;
    const prefix = message.sender.id === myId ? 'You: ' : '';
    return `${prefix}${label}${message.body ? ` · ${message.body}` : ''}`;
  }
  const prefix = message.sender.id === myId ? 'You: ' : '';
  return `${prefix}${message.body ?? ''}`;
}

/** Compact relative time as in the reference design: "now", "25m ago", "3h ago", "2d ago", then a date. */
export function formatRelativeShort(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return shortDayFormat.format(new Date(iso));
}
