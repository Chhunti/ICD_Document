# Troubleshooting Account Creation - "Fail to Fetch" Error

## Problem
When trying to register a new account, you get "fail to fetch" error.

## Root Causes & Solutions

### 1. **Apps Script Not Redeployed** (MOST COMMON)
After editing `backend.gs`, you MUST redeploy it.

**Steps:**
1. Go to **Google Apps Script editor** for your project
2. Open the `backend.gs` file
3. Click **Deploy** (top right, blue button)
4. Select **New Deployment**
5. Choose **type**: Web app
6. Set **Execute as**: Your email/account
7. Set **Who has access**: Anyone
8. Click **Deploy**
9. Copy the new **Deployment ID** URL that appears
10. Update `BACKEND_URL` in `script.js` with the new URL
11. **Important**: Make sure the URL ends in `/exec`

Example correct URL:
```
https://script.google.com/macros/s/AKfycbwuL1avLw8Onm1lns82g06SglWrv4JZSc-dyV23qQcx5a_vNrJP2bO6XbS4_74ani0j/exec
```

### 2. **CORS Headers Not Applied**
The backend now includes CORS headers. If you still get errors after redeploying, verify in browser DevTools:

**Steps:**
1. Open your HTML file in browser
2. Press **F12** to open DevTools
3. Go to **Console** tab
4. Try to register an account
5. Look for error messages in the console
6. Check **Network** tab to see the actual request

### 3. **Spreadsheet Not Accessible**
The Apps Script needs permission to access your Google Sheet.

**Steps:**
1. Open `backend.gs` in Google Apps Script
2. Click **Run** next to `doPost` function
3. Authorize the script to access Google Sheets (will prompt)
4. Check that `SPREADSHEET_ID` in `backend.gs` matches your actual sheet

### 4. **Verify Backend URL Format**
Make sure `BACKEND_URL` in `script.js`:
- ✅ Starts with `https://script.google.com/macros/s/`
- ✅ Contains a deployment ID (long random string)
- ✅ Ends with `/exec`
- ❌ Does NOT end in `/edit`
- ❌ Does NOT contain editor URLs

### 5. **Check App Key Match**
Verify in both files:
- `script.js`: `const APP_API_KEY = 'myicddepartment';`
- `backend.gs`: `const APP_KEY = 'myicddepartment';`

These MUST match exactly.

### 6. **Test Backend with curl** (Advanced)
You can test the backend directly from terminal:

```bash
curl -X POST https://your-deployment-url/exec \
  -H "Content-Type: application/json" \
  -d '{
    "action": "register",
    "appKey": "myicddepartment",
    "name": "Test User",
    "email": "test@example.com",
    "password": "test123"
  }'
```

Replace the URL with your actual deployment URL.

## Quick Checklist

- [ ] Updated `backend.gs` with CORS headers?
- [ ] Redeployed `backend.gs` as a new Web App?
- [ ] Copied the new deployment URL?
- [ ] Updated `BACKEND_URL` in `script.js` with `/exec` endpoint?
- [ ] Verified `APP_API_KEY` matches `APP_KEY` in both files?
- [ ] Checked DevTools Console for actual error messages?
- [ ] Authorized the Apps Script to access Google Sheets?

## Next Steps

1. Redeploy `backend.gs` (most important)
2. Update `BACKEND_URL` in `script.js` with the new deployment URL
3. Open your HTML file and try registering again
4. Check browser console (F12) for detailed error messages
5. Report back with the exact error message from DevTools Console

