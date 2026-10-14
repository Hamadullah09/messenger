import type { Metadata } from 'next';
import { ContactLine, LEGAL, LegalPage } from '@/components/legal-page';

export const metadata: Metadata = { title: 'Terms of service · SMA' };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service">
      <p>
        These terms apply between {LEGAL.name} (&ldquo;SMA&rdquo;) and the business that opens an
        SMA account, and to everyone that business lets use it. By using SMA you agree to them.
      </p>

      <h2>Accounts</h2>
      <ul>
        <li>
          The business is responsible for who it adds, the roles it gives them, and for keeping
          administrator accounts protected with two-step login.
        </li>
        <li>
          Keep your password private. Tell your administrator at once if you think someone else used
          your account.
        </li>
      </ul>

      <h2>Acceptable use</h2>
      <ul>
        <li>
          Do not use SMA to break the law, harass people, send spam, or share content you have no
          right to share.
        </li>
        <li>
          Customer campaigns may only go to customers who agreed to receive them, and must let them
          unsubscribe.
        </li>
        <li>
          Do not try to get into accounts, businesses or data that are not yours, or to disrupt the
          service.
        </li>
      </ul>

      <h2>Emergency alerts</h2>
      <p>
        The emergency button notifies the people a business has set up. It is not a replacement for
        police, fire or ambulance services: in danger, always call your local emergency number.
      </p>

      <h2>Plans and payment</h2>
      <ul>
        <li>
          New businesses start with a free trial. After that, the business pays the plan agreed with
          SMA; invoices are due on the date shown on them.
        </li>
        <li>
          If an invoice stays unpaid, SMA may limit or suspend the account after telling the
          business.
        </li>
        <li>
          Payments a business takes from its own customers through SMA go to the business&rsquo;s
          own merchant accounts and are between the business and its customers.
        </li>
      </ul>

      <h2>Your content</h2>
      <p>
        The business keeps ownership of everything it and its people put into SMA. SMA uses it only
        to provide the service. The business can export its data at any time and ask to close its
        account; data is erased for good 30 days after closing.
      </p>

      <h2>Service and liability</h2>
      <ul>
        <li>
          We work to keep SMA available and secure, back it up and fix problems quickly, but no
          online service can promise to be free of interruptions.
        </li>
        <li>
          To the extent the law allows, SMA is not liable for indirect losses, and its total
          liability is limited to the fees the business paid in the 12 months before the claim.
        </li>
      </ul>

      <h2>Changes</h2>
      <p>
        We may update these terms; we will tell businesses about important changes before they take
        effect.
      </p>

      <ContactLine />
    </LegalPage>
  );
}
