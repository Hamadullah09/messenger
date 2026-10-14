'use client';

import { FOLLOW_UP_KINDS, type FollowUpKind } from '@storeline/shared';
import { Footprints, Mail, MessageCircle, MoreHorizontal, Phone, Users, type LucideIcon } from 'lucide-react';
import { SelectField } from '@/components/ui';
import { FOLLOW_UP_LABEL } from './labels';

export const FOLLOW_UP_ICON: Record<FollowUpKind, LucideIcon> = {
  MEETING: Users,
  CALL: Phone,
  VISIT: Footprints,
  WHATSAPP: MessageCircle,
  EMAIL: Mail,
  OTHER: MoreHorizontal,
};

/** "What is it?" for a planned follow-up: a meeting, call, visit… */
export function FollowUpKindField({
  value,
  onChange,
  label = 'What is it?',
}: {
  value: FollowUpKind | '';
  onChange: (value: FollowUpKind | '') => void;
  label?: string;
}) {
  return (
    <SelectField label={label} value={value} onChange={(e) => onChange(e.target.value as FollowUpKind | '')}>
      <option value="">Follow-up</option>
      {FOLLOW_UP_KINDS.filter((k) => k !== 'OTHER').map((k) => (
        <option key={k} value={k}>
          {FOLLOW_UP_LABEL[k]}
        </option>
      ))}
    </SelectField>
  );
}


/** An ISO time as a datetime-local input value, in the viewer's own time zone. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
