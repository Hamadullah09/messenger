# Online payment (JazzCash and Easypaisa)

Each business takes payments into **its own** merchant account. Customers open the invoice's
pay link, press *JazzCash wallet*, *Easypaisa wallet* or *Card*, pay on the gateway's own page
and come back. The invoice is marked paid automatically once the payment is confirmed.

## How a payment is confirmed

| Gateway | Confirmation | If it cannot be confirmed |
| --- | --- | --- |
| JazzCash | The answer is signed (HMAC-SHA256 with the business's integrity salt); a wrong signature is ignored. The amount must match the invoice balance. | Goes to **Invoices → Payments to confirm** for a manager |
| Easypaisa | The browser's "paid" is never trusted: the server asks Easypaisa (inquire transaction API) and only `PAID` with the right amount counts. | Without the transaction-check login, every Easypaisa payment goes to **Payments to confirm** |

A payment can only be recorded once, even if the return page and the notification both arrive.

## Setting up (each business, in Sales → CRM settings → Online payment)

1. Apply for a merchant account (JazzCash: *Online Payment Gateway / Hosted Checkout*;
   Easypaisa: *Easypay Online Payment*). You need your business documents and bank account.
2. They give you **sandbox** credentials first:
   - JazzCash: Merchant ID, Password, Integrity Salt.
   - Easypaisa: Store ID, Hash Key (16 characters), and the account number + username/password
     for the transaction inquiry API.
3. Enter them with **Test mode** on, tick *Customers can pay with…*, Save.
4. Give the addresses shown (Return URL, and for JazzCash the IPN URL) to the gateway's
   support team / merchant portal.
5. Make a test payment on an invoice in PKR with their test wallet or test card. Check the
   invoice turns **Paid** and the payment shows "Paid online with JazzCash (test)".
6. When the gateway moves you to production, enter the **live** credentials, turn Test mode
   off and Save. Make one small real payment and refund it to confirm.

## Before going live (developer checklist)

The integration follows the gateways' published guides (JazzCash Page Redirection v1.1,
Easypaisa Easypay plug-in + inquire API). Their field names and response codes occasionally
change between versions, so confirm in the sandbox with real merchant credentials:

- JazzCash transaction types (`MWALLET` for wallet, `MPAY` for card) and response codes
  (`000`/`121` paid, `124`/`157` pending).
- Easypaisa payment method names (`MA_PAYMENT_METHOD`, `CC_PAYMENT_METHOD`), the
  `Confirm.jsf` second step and the inquire API response (`transactionStatus: PAID`).

The adapters are in `apps/api/src/modules/sales/gateways/gateways.ts` with unit tests next to them.
