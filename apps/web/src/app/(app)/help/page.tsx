import {
  AlertCircle,
  Check,
  CheckCheck,
  Clock,
  MessageSquarePlus,
  Paperclip,
  Reply,
  Search,
} from 'lucide-react';
import { PageHeader } from '@/components/ui';

const TICKS = [
  {
    Icon: Clock,
    label: 'Clock',
    meaning: 'Your message is being sent or is waiting in the queue.',
  },
  {
    Icon: Check,
    label: 'One tick',
    meaning: 'The message reached SMA and is being delivered.',
  },
  { Icon: CheckCheck, label: 'Two grey ticks', meaning: 'Everyone in the chat has received it.' },
  {
    Icon: CheckCheck,
    label: 'Two blue ticks · “Seen”',
    meaning: 'Everyone has read it (if your business uses read receipts).',
    tone: 'text-brand',
  },
  {
    Icon: AlertCircle,
    label: 'Red warning',
    meaning: 'Not sent. Tap “retry” — it will not be sent twice.',
    tone: 'text-danger',
  },
];

const HOW_TO = [
  {
    Icon: MessageSquarePlus,
    title: 'Start a chat',
    text: 'Open Messages and press the blue + button, then choose a colleague.',
  },
  {
    Icon: Reply,
    title: 'Reply to one message',
    text: 'Press the ⋮ button next to the message and choose “Reply”.',
  },
  {
    Icon: Paperclip,
    title: 'Share a photo or file',
    text: 'Press the paperclip, pick a file, add a caption if you like, then press Send.',
  },
  {
    Icon: Search,
    title: 'Find an old message',
    text: 'Use the search box at the top, or press Ctrl + K.',
  },
];

const FAQ = [
  {
    q: 'I forgot my password.',
    a: 'Ask your store manager or business administrator to reset it for you.',
  },
  {
    q: 'Why does a file say “Checking the file for safety”?',
    a: 'Every file is checked for viruses before anyone else can open it. This usually takes a few seconds.',
  },
  {
    q: 'Can other people see my phone number?',
    a: 'No. Colleagues only see your name. Only administrators with two-step verification can see contact details, and every view is recorded.',
  },
  {
    q: 'Are my messages end-to-end encrypted?',
    a: 'No. Messages are encrypted while travelling and when stored, and your business can review them under its policies. Do not share personal passwords or bank details in chats.',
  },
];

export default function HelpPage() {
  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 sm:p-6">
        <PageHeader title="Help" subtitle="Quick answers for everyday use" />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {HOW_TO.map(({ Icon, title, text }) => (
            <section
              key={title}
              className="rounded-3xl border border-line bg-surface p-5 shadow-card"
            >
              <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">
                <Icon className="size-6" aria-hidden />
              </span>
              <h2 className="mt-4 text-lg font-bold">{title}</h2>
              <p className="mt-1 text-muted">{text}</p>
            </section>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <section className="rounded-3xl border border-line bg-surface p-5 shadow-card sm:p-6">
            <h2 className="mb-4 text-xl font-bold">What the ticks mean</h2>
            <ul className="flex flex-col gap-3">
              {TICKS.map(({ Icon, label, meaning, tone }) => (
                <li key={label} className="flex items-start gap-3 rounded-2xl bg-surface-2 p-3">
                  <Icon className={`mt-0.5 size-6 shrink-0 ${tone ?? 'text-muted'}`} aria-hidden />
                  <p>
                    <strong>{label}:</strong> {meaning}
                  </p>
                </li>
              ))}
            </ul>
          </section>
          <section className="rounded-3xl border border-line bg-surface p-5 shadow-card sm:p-6">
            <h2 className="mb-4 text-xl font-bold">Common questions</h2>
            <dl className="flex flex-col gap-4">
              {FAQ.map(({ q, a }) => (
                <div key={q} className="rounded-2xl bg-surface-2 p-4">
                  <dt className="font-bold">{q}</dt>
                  <dd className="mt-1 text-muted">{a}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
