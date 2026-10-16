# Email to Account — Outlook add-in

Reads a fund notification from the open Outlook message, accepts pasted text from its PDF gift memo, and proposes editable values for **SoE Finance → Accounts** (`br2xvsvpw`). The user reviews the values and explicitly creates an account. If the Cost Object already exists, the pane links to that account; it never updates it or offers a duplicate override.

For the supplied example, the proposal is Cost Object `3947890`, Cost Object Name `Quantum Life Sciences Fellowship Fund`. The boilerplate “created … OR … updated” is flagged as ambiguous. Description and restrictions stay blank until document evidence is supplied.

## Fields

Verified through the signed-in table settings on October 16, 2026:

| Proposal | Field ID | Type |
| --- | --- | --- |
| Cost Object / fund number | 7 | Required unique text; table key |
| Cost Object Name | 8 | Text (also required by this tool) |
| Fund Center | 6 | Choice |
| Pool Code | 9 | Choice |
| Admin Flag | 11 | Choice |
| Fund Description | 20 | Multiline |
| Fund Restriction | 21 | Multiline |
| Notes | 22 | Multiline |
| Stewardship | 41 | Choice |
| Stewardship Note | 42 | Multiline |

Choice lists are loaded from Quickbase on each proposal and validated again before creation. Balances, amounts, and review-status checkboxes are excluded. Attachment field 27 stores the source email as an .eml file when selected. No PDF attachment is interpreted in this version. Exported .eml messages can include their original attachments. Pasted PDF text is used for extraction, not automatically stored as the original gift memo.

## Run and test

Node 20+; no package installation required.

```
npm test
npm run dev
```

Open `http://127.0.0.1:8787`. Outside Outlook, expand **Email text** and paste the notice. The backend needs a Quickbase token to load fields and create records. Tests mock all remote calls and do not write live records.

## Deploy alongside the existing add-ins

1. Copy `account.html`, `account.css`, `account.js`, `email-source.js`, `account_manifest.xml`, `icons/fund-account-*.png`, `netlify/functions/qb-account.js`, `netlify/functions/parley-account-extract.js`, and `netlify/functions/lib/accounts.js` into the existing ADean site's corresponding folders. Preserve its existing files and configuration. Alternatively deploy this project as a separate Netlify site.
2. Set **QB_FINANCE_TOKEN** in the server-side Netlify environment to a Quickbase user token with read-field, query, and create permissions for Accounts. Never put tokens in browser code.
3. Set **PARLEY_FINANCE_API_KEY** to the shared finance MIT Parley key. It does not fall back to other Parley keys. Email-only standard notices work without Parley; missing or failed PDF interpretation is clearly flagged for manual entry.
4. The included manifest targets the existing `https://waivercheck.netlify.app` host. If deploying elsewhere, replace that origin in every manifest URL. It has its own add-in ID and uses `ReadItem` permission. Increment the manifest version when changing it.
5. Redeploy, then sideload `account_manifest.xml` in Outlook's custom add-ins manager. Open a fund notice and choose **Email to Account**. Paste the PDF text, select **Propose account**, review/edit, check the review box, and select **Create account in Quickbase**.

The supplied `netlify.toml` is for a standalone deployment. Preserve the existing site's authentication/access restrictions when integrating. Like the existing add-ins, these functions use server-side service tokens; Outlook `ReadItem` permission does not authenticate callers of an HTTP function. No add-in access code or application-level sign-in is required. Any endpoint access restrictions must be provided by the hosting environment. Calls act as the Quickbase token owner.

## Validation and remaining setup

The test suite covers the exact sample, ambiguous multi-fund threads, absent Parley configuration, conflicting email/PDF identities, invalid inputs, duplicates, failed duplicate checks, the exact mapped write payload, and Quickbase line errors. Live creation requires deployment and server-side credentials; no real Accounts record is created by the tests.

## References

- [Microsoft Outlook add-in APIs](https://learn.microsoft.com/en-us/office/dev/add-ins/outlook/apis)
- [Quickbase REST API](https://developer.quickbase.com/)

## Deployment status — October 16, 2026

Deployed to https://waivercheck.netlify.app/account.html from ADean commit `373af9ca357e9aa21a30a039380f6fdc089db3a8`. Live Quickbase field loading and Parley PDF-text extraction were verified without creating records. Production uses the existing `QB_FINANCE_TOKEN` and `PARLEY_FINANCE_API_KEY`.

For mailbox installation, open https://aka.ms/olksideload, select **My add-ins → Custom Addins → Add a custom add-in → Add from File**, and select the local `account_manifest.xml`. In classic Outlook, **File → Info → Manage Add-ins** also opens the installation dialog. The modern Apps catalog is a different screen and may not expose custom XML installation. Mailbox installation has not yet been confirmed.

## Save and icon update — version 1.0.1.0

Creation uses Quickbase API_AddRecord (insert-only), after a duplicate lookup. Each Quickbase request has a ten-second timeout. Save progress and errors appear beside the Create button, and the read-only Check for existing account action can confirm the fund before retrying. The custom ledger/checkmark icons have new filenames to avoid cached dollar-sign icons. Reinstall the updated manifest to refresh Outlook ribbon icons; the hosted save fix takes effect when the pane reloads.

## Source email storage

Store source email is selected by default. In Outlook supporting Mailbox 1.14, the original .eml is exported using getAsFileAsync and saved in Accounts Attachment (field 27) in the same insert-only API_AddRecord request. If export is unavailable or fails, creation stops; upload a saved .eml (up to 3 MB), retry export, or explicitly uncheck email storage. No partial account is silently created without the requested email. Existing records and their attachments are never updated by this flow. Outside Outlook, use the upload option.
