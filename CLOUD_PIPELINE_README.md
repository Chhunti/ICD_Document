# Cloud-Based Database Pipeline - Implementation Guide

## Overview
This system establishes a unified cloud-based workflow tracking system using Google Sheets as the central database. All document metadata and workflow status are stored in Google Sheets and synchronized across devices, browsers, and user accounts.

---

## Architecture

### Google Spreadsheet Layout

**4 Workflow Process Tabs:**
- `To_Director` 
- `To_Director_General`
- `To_Specific_Leader`
- `To_Minister`

**Unified Column Structure (All Tabs, Rows 1-∞):**
```
A: No                    (Sequential row number)
B: DocumentTitle         (Document name)
C: ReferenceNumber       (Primary Key - UNIQUE identifier like MPWT/ADM/2026/001)
D: OriginSource          (Source of document)
E: DateOfEntry           (Entry date)
F: InChargeOf            (Person responsible)
G: DescriptionSummary    (Brief description)
H: WorkProcess           (Tab name - To_Director, etc.)
I: LeaderName            (Optional - for Specific Leader/Minister processes)
J: WorkflowData          (JSON string containing all step statuses, assignees, notes)
K: LastUpdated           (ISO timestamp of last update)
L: UpdatedBy             (Email of user who last updated)
```

---

## Backend: Google Apps Script (`Code.gs`)

### Key Functions

#### 1. `handleSaveWorkflow(data)`
**Purpose:** Save or update a workflow record to Google Sheets

**Request Payload:**
```javascript
{
  action: 'saveWorkflow',
  referenceNumber: 'MPWT/ADM/2026/001',
  documentTitle: 'Procurement Request',
  originSource: 'Finance Dept',
  dateOfEntry: '2026-07-25',
  inChargeOf: 'John Doe',
  descriptionSummary: 'Q3 supplies',
  workProcess: 'To_Director',
  leaderName: '',
  workflowData: {
    director: { status: 'In Progress', assign: 'Admin1', notes: 'Under review' },
    officeInCharge: { status: 'None', person: '', notes: '' },
    directorDecision: { status: 'None', outcome: '', notes: '' },
    dgDecision: { status: 'None', outcome: '', notes: '' },
    undersecDecision: { status: 'None', outcome: '', notes: '' },
    secDecision: { status: 'None', outcome: '', notes: '' },
    ministerDecision: { status: 'None', outcome: '', notes: '' }
  },
  updatedBy: 'user@example.com'
}
```

**Response:**
```javascript
{
  success: true,
  action: 'created',  // or 'updated'
  referenceNumber: 'MPWT/ADM/2026/001',
  tab: 'To_Director',
  assignedNo: 1
}
```

**Logic:**
1. Validates `referenceNumber` and `workProcess`
2. Gets or creates the target sheet tab
3. Searches Column C for existing `ReferenceNumber`
4. If exists: **Updates** the row
5. If new: **Appends** a new row
6. Sets `LastUpdated` to current ISO timestamp
7. Stores `WorkflowData` as JSON string in Column J

---

#### 2. `handleGetWorkflow(data)`
**Purpose:** Retrieve a workflow record from any of the 4 tabs

**Request Payload:**
```javascript
{
  action: 'getWorkflow',
  referenceNumber: 'MPWT/ADM/2026/001'
}
```

**Response:**
```javascript
{
  success: true,
  record: {
    no: 1,
    documentTitle: 'Procurement Request',
    referenceNumber: 'MPWT/ADM/2026/001',
    originSource: 'Finance Dept',
    dateOfEntry: '2026-07-25',
    inChargeOf: 'John Doe',
    descriptionSummary: 'Q3 supplies',
    workProcess: 'To_Director',
    leaderName: '',
    workflowData: { /* parsed JSON object */ },
    lastUpdated: '2026-07-25T14:32:00.000Z',
    updatedBy: 'user@example.com',
    tab: 'To_Director'
  }
}
```

**Logic:**
1. Searches Column C across all 4 tabs
2. Returns first match found
3. Parses JSON in Column J into object
4. Returns complete metadata + parsed workflow data

---

### Supporting Functions

#### `getOrCreateWorkflowSheet(tabName)`
- Retrieves sheet by name
- If doesn't exist: Creates new sheet and writes header row
- Sets first row as frozen

#### `getUsersSheet()`
- Manages authentication
- Returns Users sheet with Email, PasswordHash, Role, CreatedAt columns

---

## Frontend: JavaScript Cloud Sync Functions

### 1. `gasPost(payload)` - Universal GAS Communication Helper

```javascript
async function gasPost(payload) {
    const url = getAuthApiBase();
    if (!url || url.includes('PASTE_YOUR_WEB_APP_URL_HERE')) {
        return { success: false, error: 'GAS URL not configured' };
    }
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify(payload)
        });
        const text = await res.text();
        return JSON.parse(text);
    } catch (e) {
        return { success: false, error: e.message };
    }
}
```

**Key Points:**
- Uses `text/plain` headers to bypass CORS restrictions
- All GAS requests routed through this helper
- Automatic error handling with fallback responses

---

### 2. `saveWorkflowData(docData)` - Save to Cloud

```javascript
async function saveWorkflowData(docData) {
    const result = await gasPost({
        action: 'saveWorkflow',
        referenceNumber: docData.ref || '',
        documentTitle: docData.title || '',
        originSource: docData.origin || '',
        dateOfEntry: docData.entryDate || '',
        inChargeOf: docData.inCharge || '',
        descriptionSummary: docData.description || '',
        workProcess: docData.workProcess || '',
        leaderName: docData.leaderName || '',
        workflowData: docData.workflowData || {},
        updatedBy: (currentUser && currentUser.email) || ''
    });
    return result;
}
```

**Usage Example:**
```javascript
await saveWorkflowData({
    ref: 'MPWT/ADM/2026/001',
    title: 'Budget Approval',
    origin: 'Finance',
    entryDate: '2026-07-25',
    inCharge: 'Manager',
    description: 'Q3 budget',
    workProcess: 'To_Director',
    leaderName: '',
    workflowData: {
        director: { status: 'In Progress', assign: 'Admin1', notes: 'Reviewing' },
        officeInCharge: { status: 'None', person: '', notes: '' }
        // ... other steps
    }
});
```

---

### 3. `loadWorkflowData(refNum)` - Load from Cloud

```javascript
async function loadWorkflowData(refNum) {
    const result = await gasPost({ 
        action: 'getWorkflow', 
        referenceNumber: refNum 
    });
    return (result && result.success) ? result.record : null;
}
```

**Returns:**
- Complete record object with all metadata
- Parsed `workflowData` JSON
- Last updated timestamp
- Which tab the record is stored in

---

### 4. Form Population Flow

```javascript
async function loadAndDisplayWorkflow(referenceNumber) {
    // 1. Load from cloud
    const record = await loadWorkflowData(referenceNumber);
    if (!record) {
        toast('Workflow not found', 'error');
        return;
    }

    // 2. Populate metadata
    $('docNo').value = record.no;
    $('docTitle').value = record.documentTitle;
    $('docRef').value = record.referenceNumber;
    $('docOrigin').value = record.originSource;
    $('docEntryDate').value = record.dateOfEntry;
    $('docInCharge').value = record.inChargeOf;
    $('docDescription').value = record.descriptionSummary;
    $('docWorkProcess').value = record.workProcess;
    $('docLeaderName').value = record.leaderName || '';

    // 3. Set work process (triggers workflow step rendering)
    toggleLeaderNameField(record.workProcess);
    renderWorkflowStepsForm({ 
        workProcess: record.workProcess, 
        workflowData: record.workflowData 
    });

    // 4. Modal opens with populated form
    docModal.classList.add('open');
}
```

---

## Deployment Steps

### 1. Deploy Google Apps Script
1. Open your Google Spreadsheet
2. Go to **Tools → Script editor**
3. Replace `Code.gs` with the clean version
4. Click **Deploy → New Deployment**
5. Select type: **Web app**
6. Execute as: Your account
7. Who has access: **Anyone**
8. Click **Deploy**
9. Copy the deployment URL

### 2. Configure Frontend
1. Open `Flow.html`
2. In `script.js`, update `DEFAULT_AUTH_API_BASE`:
```javascript
const DEFAULT_AUTH_API_BASE = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';
```

### 3. Test Cloud Sync
1. Create a new document in Flow.html
2. Fill in all fields
3. Click Save
4. Check Google Sheet - record should appear in the appropriate tab
5. Load the same reference number from a different browser/device
6. Verify data loads correctly

---

## Data Flow Diagram

```
┌─────────────────────────────────┐
│   Flow.html / Browser App       │
│  (User fills workflow form)     │
└────────────┬────────────────────┘
             │
             │ gasPost() with saveWorkflow action
             ↓
┌─────────────────────────────────┐
│ Google Apps Script Web App       │
│ (doPost → handleSaveWorkflow)   │
└────────────┬────────────────────┘
             │
             │ Upsert to Google Sheet
             ↓
┌─────────────────────────────────┐
│ Google Spreadsheet              │
│ (To_Director / Other Tabs)      │
│ (Columns A-L with metadata)     │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│ User on Device B / Browser C    │
│ Enters Reference Number         │
└────────────┬────────────────────┘
             │
             │ gasPost() with getWorkflow action
             ↓
┌─────────────────────────────────┐
│ Google Apps Script Web App       │
│ (doPost → handleGetWorkflow)    │
└────────────┬────────────────────┘
             │
             │ Search Column C across all tabs
             ↓
┌─────────────────────────────────┐
│ Google Spreadsheet              │
│ (Returns matching record)       │
└────────────┬────────────────────┘
             │
             │ Return parsed JSON to frontend
             ↓
┌─────────────────────────────────┐
│ Flow.html populates form        │
│ (User sees live data)           │
└─────────────────────────────────┘
```

---

## Key Features

✅ **Centralized Storage:** All data in one Google Spreadsheet
✅ **Cross-Device Sync:** Same data regardless of device/browser
✅ **Primary Key Upsert:** ReferenceNumber prevents duplicates
✅ **CORS Compatible:** Uses text/plain headers for Google Apps Script
✅ **JSON Workflow Data:** Flexible step tracking with status, assignees, notes
✅ **Auto Tab Creation:** Workflow tabs created on first save
✅ **Frozen Headers:** Row 1 always visible when scrolling
✅ **Timestamps:** LastUpdated and UpdatedBy tracked automatically

---

## Troubleshooting

### "GAS URL not configured"
→ Update `DEFAULT_AUTH_API_BASE` in script.js with your deployment URL

### Data not saving to Sheet
→ Check Google Apps Script deployment permissions (must be "Anyone")

### Can't load previously saved records
→ Verify ReferenceNumber matches exactly (case-sensitive)

### 403 Error on fetch
→ Ensure Google Apps Script Web App is deployed with "Anyone" access

---

## API Reference

### All Workflow Actions

| Action | Method | Required Fields | Returns |
|--------|--------|-----------------|---------|
| `saveWorkflow` | POST | `referenceNumber`, `workProcess`, `workflowData` | `{ success, action, tab, assignedNo }` |
| `getWorkflow` | POST | `referenceNumber` | `{ success, record }` |
| `register` | POST | `email`, `password` | `{ success, user }` |
| `login` | POST | `email`, `password` | `{ success, user }` |

