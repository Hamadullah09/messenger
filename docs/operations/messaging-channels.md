# WhatsApp and SMS (campaigns and invoice reminders)

The code is ready for both; they turn on when their keys are set (in `.env.production`, or by
a Super Admin in the app under **Integrations**, where they are stored encrypted). Campaigns
go only to store customers who opted in; invoice reminders go to the invoice's phone number
when the business picks WhatsApp or SMS in Sales → CRM settings.

## WhatsApp (Meta WhatsApp Business Platform, Cloud API)

1. Create a Meta Business account and verify the business (documents, a few days).
2. In developers.facebook.com create an app → add **WhatsApp** → add and verify your phone
   number (a number not already used on the WhatsApp app).
3. Create a **System User** in Business Settings with a permanent access token that has
   `whatsapp_business_messaging` permission.
4. Create and submit a **message template** (category *Utility* or *Marketing*) with two
   variables, for example: `Hello {{1}}, {{2}}` — `{{1}}` is the customer's name and `{{2}}`
   the message. Wait for approval.
5. Set `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_TEMPLATE_NAME` and
   `WHATSAPP_TEMPLATE_LANGUAGE`, then press **Send test** in Integrations.

Business-initiated WhatsApp messages must use an approved template and are charged per
conversation by Meta. Customers can opt out; the app honours unsubscribes.

## SMS (Twilio)

1. Create a Twilio account, upgrade it (trial accounts only send to verified numbers).
2. Buy a number or register an alphanumeric sender ID allowed in your country (Pakistan:
   check Twilio's country rules; local aggregators such as Jazz/Zong/Telenor corporate SMS
   can be added as another adapter later).
3. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` and send a test.

## What we cannot do for you

Meta business verification, template approval, Twilio account upgrade and sender
registration need your company documents and payment method.
