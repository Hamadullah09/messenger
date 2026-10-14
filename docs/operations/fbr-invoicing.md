# FBR invoices (Digital Invoicing)

For businesses registered for sales tax, Pakistan's FBR requires invoices to be reported
through **Digital Invoicing**, run by PRAL. Each invoice sent gets an **FBR invoice number**,
which must be printed on the invoice with its QR code.

## Turning it on (each business, Sales → CRM settings → FBR invoices)

1. Register for Digital Invoicing on the FBR IRIS portal and request API access from PRAL.
   PRAL gives a **sandbox token** and a list of **scenarios** to pass (e.g. `SN001`).
2. Enter the token, your NTN (7 digits) or CNIC (13), registered name, province and address,
   the **HS code** for what you sell, the **sale type** and **unit of measure** (from FBR's
   reference lists), keep **Test mode** on and Save.
3. On an issued PKR invoice press **Send to FBR**, add the buyer's NTN/CNIC (or leave it
   empty for an unregistered buyer) and province. Work through each PRAL scenario.
4. When PRAL approves the sandbox runs they issue a **production token**: enter it, turn
   Test mode off and Save. From then on, send every invoice to FBR after issuing it.

The FBR number and QR code appear on the invoice panel and the printed invoice. An invoice is
sent once; FBR's error message is shown if it is refused (fix the details and send again).

## Before going live (developer checklist)

The integration follows PRAL's Digital Invoicing API specification (`postinvoicedata` /
`postinvoicedata_sb`, Bearer token, `validationResponse.statusCode = "00"`). Confirm in the
sandbox: province spellings (`FBR_PROVINCES`), sale types and units for the business's
products, and whether the business needs per-item HS codes (today one default per business).
The adapter and its tests: `apps/api/src/modules/sales/gateways/fbr.ts`. FBR's printed
invoices may also require the FBR Digital Invoicing logo; add the official artwork once FBR
provides it to the business.
