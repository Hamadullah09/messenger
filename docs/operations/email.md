# Email that arrives (not in spam)

The app sends invoices, quotes, payment reminders and password resets over SMTP (`SMTP_URL`,
`MAIL_FROM`). In development they go to Mailpit; in production use a real provider.

## 1. Choose a provider

Any SMTP provider works: Amazon SES (cheapest at volume), Brevo, Postmark, Mailgun, Zoho
ZeptoMail, or Google Workspace for low volume. Create an account and add your domain.

## 2. Verify the domain (DNS records the provider gives you)

| Record | Purpose |
| --- | --- |
| **SPF** (`TXT @  v=spf1 include:<provider> -all`) | which servers may send for your domain |
| **DKIM** (`TXT/CNAME <selector>._domainkey`) | signs every email |
| **DMARC** (`TXT _dmarc  v=DMARC1; p=quarantine; rua=mailto:dmarc@your-domain`) | tells receivers what to do with failures |
| Return-path / bounce `CNAME` (if offered) | bounces go back to the provider |

Start DMARC with `p=none` for a week, check the reports, then move to `quarantine`.

## 3. Configure

```
SMTP_URL=smtps://USERNAME:PASSWORD@smtp.provider.com:465
MAIL_FROM=SMA <no-reply@chat.example.com>
```

`MAIL_FROM` must use the verified domain. Each business's invoices show **its** company name
in the subject and body (Sales → CRM settings).

## 4. Check

Send a test from Integrations, then send an invoice to a Gmail and an Outlook address and
open "Show original": SPF, DKIM and DMARC must all say **PASS**. mail-tester.com should give
9/10 or more.
