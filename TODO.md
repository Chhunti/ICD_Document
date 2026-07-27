# TODO: Connect app to Google Spreadsheet backend

- [x] Step 1: Create implementation plan (approved)
- [x] Step 2: Update `backend_new.gs` - Expand Users sheet columns (Position, Phone, Birthday) and Documents sheet columns (ReviewStatus, ArchiveStatus + notes), return extra fields in login/verifySession
- [x] Step 3: Update `script.js` - Rewrite `callBackend()` to make real HTTP POST requests with localStorage fallback

## Summary

**`backend_new.gs`**:
- Users sheet now has columns: CreatedAt, Name, Email, PasswordHash, Role, Status, Token, **Position**, **Phone**, **Birthday**
- Documents sheet now has columns: ID, Title, Ref, Origin, EntryDate, Description, wfAdminStatus, **wfReviewStatus**, wfDGStatus, wfCabinetStatus, wfMinisterStatus, **wfArchiveStatus**, wfAdminNotes, **wfReviewNotes**, wfDGNotes, wfCabinetNotes, wfMinisterNotes, **wfArchiveNotes**, wfMinisterDecision, CreatedAt, CreatedBy
- Login and VerifySession responses now include `position`, `phone`, `birthday`
- SaveDocs writes all workflow fields

**`script.js`**:
- `callBackend()` now first attempts a real `fetch()` POST to the Apps Script URL
- If the backend is unreachable (network error, CORS timeout), it falls back to localStorage handlers
- This ensures documents persist in Google Sheets when the backend is deployed
