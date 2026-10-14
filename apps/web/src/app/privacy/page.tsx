import type { Metadata } from 'next';
import { ContactLine, LEGAL, LegalPage } from '@/components/legal-page';

export const metadata: Metadata = { title: 'Privacy policy · SMA' };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy">
      <p>
        {LEGAL.name} (&ldquo;SMA&rdquo;, &ldquo;we&rdquo;) provides a messaging and business
        platform to companies (&ldquo;businesses&rdquo;). Each business decides who uses SMA and
        what it puts into it; for that information the business is responsible and we process it on
        its behalf. This policy explains what we store, why, and your choices.
      </p>

      <h2>What we store</h2>
      <ul>
        <li>
          Account details: name, username, email and phone number (visible only to administrators
          who need them), password (stored only as a one-way hash) and two-step login settings.
        </li>
        <li>
          What people send: messages, files, voice notes, locations they choose to share, polls,
          status updates and call records (who called whom and how long — never the call itself).
        </li>
        <li>
          Business records the business adds: stores, staff, tasks, shifts, attendance (including
          the location at check-in), checklists, leave, customers, campaigns, and Sales &amp;
          Marketing records (leads, deals, quotes, invoices, payments).
        </li>
        <li>
          Technical data: sign-in sessions, devices registered for notifications, and security logs.
          IP addresses are stored only as one-way hashes for abuse protection.
        </li>
      </ul>

      <h2>Why we use it</h2>
      <ul>
        <li>
          To provide the service the business signed up for: deliver messages and alerts, run calls,
          store files, send invoices and reminders the business asks for.
        </li>
        <li>
          To keep accounts and the platform secure: preventing abuse, investigating incidents, and
          keeping an audit log of administrative actions.
        </li>
        <li>We do not sell personal data and do not use message content for advertising.</li>
      </ul>

      <h2>Who can see it</h2>
      <ul>
        <li>
          People in a chat see its messages. Administrators of a business manage its people and
          records according to their role. Platform staff have no routine access to message content.
        </li>
        <li>
          Phone notifications show the sender or the message only if the person and their business
          allow it.
        </li>
        <li>
          Service providers that run parts of the service for us (hosting, file storage, email
          delivery, and, when a business turns them on, WhatsApp, SMS and payment providers) receive
          only what they need to do that job.
        </li>
      </ul>

      <h2>How we protect it</h2>
      <ul>
        <li>
          All connections use HTTPS. Stored secrets (two-step login keys, provider keys, payment
          credentials) are encrypted.
        </li>
        <li>
          Files are checked for malware before anyone can download them, and download links expire
          quickly.
        </li>
        <li>
          Encrypted backups are kept for a limited time and stored separately from the live system.
        </li>
      </ul>

      <h2>How long we keep it</h2>
      <ul>
        <li>
          While the business uses SMA. Disappearing messages are removed for everyone when their
          timer ends.
        </li>
        <li>
          When a business closes its account, its data is erased for good 30 days after closing
          (backups age out on their own schedule). The business can download all of its data before
          closing.
        </li>
        <li>
          Security and audit logs are kept longer, as needed to protect the service and meet legal
          duties.
        </li>
      </ul>

      <h2>Your choices and rights</h2>
      <ul>
        <li>
          You can change your name and password, turn off notification previews, and leave groups at
          any time.
        </li>
        <li>
          To see, correct or delete information about you that a business holds, ask that
          business&rsquo;s administrator; we help businesses answer such requests.
        </li>
      </ul>

      <ContactLine />
    </LegalPage>
  );
}
