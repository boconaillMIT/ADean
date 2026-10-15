# PI-status saves from Research Pre-Check

After checking an email, every PI-status requester type has an **Add PI-status request to QuickBase** form. Review the extracted values, enter the researcher Kerberos in the labeled field at the top of the save form, the required PI-requested-for and lead PI/mentor choices, and explicitly choose a decision. Saving does not open, draft, or send an email. The existing email actions remain separate. Post-tenure status and department endorsement do not trigger automatic approval.

Use exact existing QuickBase multiple-choice values. The required fields marked in the supplied table screenshots are lead PI/mentor (20) and PI requested for (22). The app also requires Kerberos, source email subject/date and request date to identify the record and detect retries. Optional text fields can be edited before saving. Source email text includes any pasted attachment text supplied to the check.

## Backend mapping

`netlify/functions/qb-pi-status.js` writes only to PI Status table `bsskfjj57`, using server-side `QB_RESEARCH_TOKEN` as a QuickBase user token for realm `mit.quickbase.com`.

| Field | ID |
| --- | --- |
| Date of request / effort / decision date | 6 / 7 / 8 |
| DLC head endorsement choice / proposal value | 9 / 10 |
| Detailed notes / email body / email date / email subject | 14 / 15 / 16 / 17 |
| Lead PI, supervisor or mentor / PI status requested for | 20 / 22 |
| Proposal number / end / start | 23 / 24 / 25 |
| Sponsor / department | 28 / 29 |
| PI status approval / PI status request | 37 / 38 |
| Proposal title / reason PI status is needed | 41 / 42 |
| Requester's last / first name | 53 / 54 |
| Kerberos | 56 |

Fields 51/52 belong to the lead PI and are deliberately not used for the requester's name. Effort entered as 25% is sent as 0.25. Pending requests omit approval and decision-date fields; a human explicitly selects approved or not approved for decided records. The chosen decision is also recorded in Detailed Notes. The existing history endpoint treats unchecked approval as not approved, including pending records; it does not distinguish pending from denied in its historical counts.

Before creating, the function queries Kerberos + source subject + source email date. A matching request returns a link instead of creating another record. A failed duplicate lookup prevents writing. After creating, it queries the returned record ID and checks Kerberos before reporting success. If verification fails, review the linked record before retrying. This check is not a transactional uniqueness constraint: concurrent saves from separate clients can still race. Distinct requests sharing researcher, subject and date need manual review in QuickBase.

## Validation and release

Run `node --test tests/qb-pi-status.test.js`. Tests mock QuickBase and cover field mappings, explicit decisions, duplicate checks, failed writes, verification and input validation.

Browser validation used Chromium with mocked Office and API responses, including all three requester types, required decision/Kerberos, save-only behavior, failure links, duplicates and retained email actions. No real records were created. Live QuickBase validation remains blocked by the research token/settings save issue.

Deploy the updated page, Netlify function and manifest together. The manifest retains the add-in ID, is version 1.0.1.0, and labels the app and Outlook button **Research Pre-Check**. Update the installed/sideloaded manifest to refresh the Outlook name.
