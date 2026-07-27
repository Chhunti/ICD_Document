# ✅ QUICK SETUP GUIDE - Fixed Backend

The `backend.gs` has been updated with simplified, more robust code. Now follow these steps:

## Step 1: Save and Deploy

1. Open Google Apps Script editor (where you have `backend.gs`)
2. **Save** the file (Ctrl+S or Cmd+S)
3. Click **Deploy** → **New Deployment**
4. Select **Type**: Web app
5. Click **Deploy**
6. Copy the new deployment URL (it will look like `https://script.google.com/macros/s/AKfycbx.../exec`)

## Step 2: Add New URL to Frontend

1. Update `BACKEND_URL` in `script.js` line 7:
```javascript
const BACKEND_URL = 'https://script.google.com/macros/s/YOUR_NEW_DEPLOYMENT_ID/exec';
```

Replace `YOUR_NEW_DEPLOYMENT_ID` with the ID from your new deployment.

## Step 3: Test

1. Open your HTML file in browser
2. Press F12 to open DevTools → Console tab
3. Try to **create an account**
4. You should see:
   - `Calling backend: register URL: https://...`
   - `Response status: 200`
   - Success or error message

## Step 4: Verify in Google Sheets

1. Go to your Google Sheet
2. You should see new sheets: `Users` and `Documents`
3. Check the `Users` sheet for your new registered account

## If Still Failing

1. Check DevTools Console (F12) for exact error
2. Look at Apps Script Execution Log for server errors:
   - Go to Google Apps Script editor
   - Click **Execution log** at the bottom
   - You'll see detailed error messages

---

**Key Changes in Updated Backend:**
- Better error handling
- Detailed logging for debugging
- Simplified sheet creation logic
- Proper CORS headers
- Helper functions `handleRegister`, `handleLogin`, etc.
