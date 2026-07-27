# Google Sheets Auth Demo

This project is a very simple authentication demo that uses Google Sheets as a lightweight database and Google Apps Script as the API backend.

## 1. Create the Google Sheet
1. Create a new Google Sheet.
2. Rename the first tab to `Users`.
3. Add these headers in row 1:
   - `Email`
   - `PasswordHash`
   - `Role`
   - `CreatedAt`

Example:

| Email | PasswordHash | Role | CreatedAt |
| --- | --- | --- | --- |
| admin@example.com | base64encodedpassword | admin | 2026-07-25T00:00:00.000Z |

## 2. Deploy the Apps Script
1. Open Google Sheets.
2. Go to Extensions > Apps Script.
3. Paste the contents of `Code.gs` into the script editor.
4. Save the project.
5. Click Deploy > New deployment.
6. Choose Web app.
7. Set:
   - Execute as: `Me`
   - Who has access: `Anyone`
8. Deploy and copy the web app URL.

## 3. Connect the frontend
1. Open `index.html`.
2. Replace `PASTE_YOUR_WEB_APP_URL_HERE` with the web app URL you copied.
3. Open `index.html` in a browser.

## 4. How it works
- `register` saves a new user into the `Users` sheet.
- `login` checks the submitted email and password against the sheet.
- The frontend stores the logged-in user in `localStorage`.
- `dashboard.html` redirects to `index.html` if no user session exists.

## Notes
- This is meant for small internal use and simple demos.
- Passwords are only obfuscated with `Utilities.base64Encode()` for this simple example.
- For production, use stronger hashing such as SHA-256 with salting or a proper backend service.
