# DocuFlow MPWT — Google Sheets Authentication Backend

This project now supports user registration/login and stores data in Google Sheets via a Google Apps Script backend.

## Files added
- `Flow.html` — updated to include login/register flows.
- `style.css` — updated with auth overlay styling.
- `script.js` — updated with auth handling and backend integration.
- `backend.gs` — Google Apps Script backend for authentication and document storage.

## Setup
1. Create a Google Spreadsheet to hold user and document data.
2. Copy the spreadsheet ID from the URL.
3. Open Google Apps Script at [script.google.com](https://script.google.com).
4. Create a new project and paste the contents of `backend.gs`.
5. Replace `REPLACE_WITH_YOUR_SPREADSHEET_ID` and `REPLACE_WITH_YOUR_BACKEND_KEY` in `backend.gs`.
6. Deploy the Apps Script as a Web App:
   - Execute as: `Me`
   - Who has access: `Anyone`
7. Copy the deployment URL and paste it into `script.js` as `BACKEND_URL`.
8. Set the same `APP_API_KEY` value in `script.js`.

## Example: deployment URL and Google Sheets import

If you've deployed the Apps Script Web App, you can use the following URL (the one you provided) as the `BACKEND_URL` in `script.js` and for Google Sheets imports:

```
https://script.google.com/macros/s/AKfycbw7fRhyQd8cpvNfno9U5hjFY2CeepSjeHWqJae_ziuz28WxewRdGrYcLuEWS4g2bMCL/exec
```

To import the simplified documents table into a Google Sheet using IMPORTHTML, use:

```
=IMPORTHTML("https://script.google.com/macros/s/AKfycbw7fRhyQd8cpvNfno9U5hjFY2CeepSjeHWqJae_ziuz28WxewRdGrYcLuEWS4g2bMCL/exec?action=publicDocsSimple", "table", 1)
```

Notes:
- For IMPORTHTML to work from Google Sheets, redeploy the Apps Script Web App with "Who has access" set to "Anyone, even anonymous".
- The public endpoint `?action=publicDocsSimple` returns a simple HTML table suitable for IMPORTHTML/IMPORTXML.

## Users and Approval
- New registrations are saved to the `Users` sheet with status `pending`.
- As admin, you must approve accounts manually by changing the `Status` to `active` in the `Users` sheet.
- Admin accounts can be created by setting `Role` to `admin`.

## Important
This implementation uses a simple backend key and session token for access control. For production usage, secure your script deployment and consider adding stronger authentication controls or Google Identity.
