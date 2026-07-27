// ============================================================
// GOOGLE APPS SCRIPT - CLOUD DATABASE PIPELINE
// Store all workflow data in Google Sheets with unified 12-column structure
// ============================================================

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.getDataAsString());
    const action = data.action;

    if (action === 'saveWorkflow')       return handleSaveWorkflow(data);
    if (action === 'getWorkflow')        return handleGetWorkflow(data);
    if (action === 'getAllWorkflows')     return handleGetAllWorkflows(data);
    if (action === 'deleteWorkflow')     return handleDeleteWorkflow(data);
    if (action === 'saveUserAvatar')     return handleSaveUserAvatar(data);
    if (action === 'updateProfilePicture') return handleUpdateProfilePicture(data);
    if (action === 'getUserProfile')      return handleGetUserProfile(data);
    if (action === 'updateUserProfile')   return handleUpdateUserProfile(data);
    if (action === 'getUsers')           return handleGetUsers(data);
    if (action === 'register')           return handleRegister(data);
    if (action === 'login')              return handleLogin(data);

    return jsonResponse({ success: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}

// ============================================================
// WORKFLOW TABS & UNIFIED COLUMN STRUCTURE
// ============================================================

const WORKFLOW_TABS = ['To_Director', 'To_Director_General', 'To_Specific_Leader', 'To_Minister'];

const MAIN_FOLDER_ID = '1N0ZU_LeCO3sOhS-ZdmtmmE3KQ_uCFsmU';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const WORKFLOW_HEADERS = [
  'No',                    // A: Sequential row number
  'DocumentTitle',         // B: Document name
  'ReferenceNumber',       // C: Primary Key (unique identifier)
  'OriginSource',          // D: Source of document
  'DateOfEntry',           // E: Entry date
  'InChargeOf',            // F: Person responsible
  'DescriptionSummary',    // G: Brief description
  'WorkProcess',           // H: Tab name (To_Director, etc.)
  'LeaderName',            // I: Optional for Specific Leader/Minister
  'WorkflowData',          // J: JSON string with all step statuses
  'LastUpdated',           // K: ISO timestamp
  'UpdatedBy',             // L: User email/name
  'PDFFileUrl',            // M: Google Drive view URL for PDF file
  'PictureFileUrl'         // N: Google Drive view URL for image file
];

function getMainDriveFolder_() {
  const folderId = String(MAIN_FOLDER_ID || '').trim().match(/[-\w]{25,}/);
  if (!folderId || !folderId[0]) {
    throw new Error('MAIN_FOLDER_ID is not configured');
  }
  return DriveApp.getFolderById(folderId[0]);
}

function getOrCreateSubFolder(parentFolder, folderName) {
  const folders = parentFolder.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return parentFolder.createFolder(folderName);
}

function getMainDriveFolderId_() {
  const folderIdMatch = String(MAIN_FOLDER_ID || '').trim().match(/[-\w]{25,}/);
  if (!folderIdMatch || !folderIdMatch[0]) {
    throw new Error('MAIN_FOLDER_ID is not configured');
  }
  return folderIdMatch[0];
}

function saveFileToDrive(fileObj, folderName, refNum) {
  if (!fileObj || !fileObj.bytes || !fileObj.name || !fileObj.mimeType) {
    return { error: 'Invalid file payload' };
  }

  if (fileObj.size && Number(fileObj.size) > MAX_UPLOAD_BYTES) {
    return { error: 'Upload exceeds 10MB limit' };
  }

  const folderId = getMainDriveFolderId_();
  const decodedBytes = Utilities.base64Decode(String(fileObj.bytes));
  const safeRef = String(refNum || 'file').replace(/[^a-zA-Z0-9_-]+/g, '_');
  const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
  const safeName = String(fileObj.name).replace(/[\\/:*?"<>|]+/g, '_');
  const fileName = `${safeRef}_${timestamp}_${safeName}`;

  try {
    const rootFolder = getMainDriveFolder_();
    const targetFolder = getOrCreateSubFolder(rootFolder, folderName);
    const blob = Utilities.newBlob(decodedBytes, fileObj.mimeType, fileName);
    const file = targetFolder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const fileId = file.getId();
    return {
      fileId,
      fileUrl: `https://drive.google.com/uc?export=view&id=${fileId}`,
      fileName: file.getName()
    };
  } catch (err) {
    const fallback = saveFileToDriveViaDriveApi(fileObj, folderName, folderId, fileName, decodedBytes, err);
    if (fallback && fallback.fileUrl) {
      return fallback;
    }
    return { error: fallback && fallback.error ? fallback.error : String(err) };
  }
}

function saveFileToDriveViaDriveApi(fileObj, folderName, parentFolderId, fileName, decodedBytes, originalError) {
  try {
    const targetFolderId = getOrCreateSubFolderViaDriveApi(parentFolderId, folderName);
    const boundary = '-------314159265358979323846';
    const metadata = {
      name: fileName,
      parents: [targetFolderId]
    };
    const multipartBody =
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: ' + fileObj.mimeType + '\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      Utilities.base64Encode(decodedBytes) + '\r\n' +
      '--' + boundary + '--';

    const uploadResponse = UrlFetchApp.fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      {
        method: 'post',
        contentType: 'multipart/related; boundary=' + boundary,
        payload: multipartBody,
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
      }
    );

    let fileData;
    try {
      fileData = JSON.parse(uploadResponse.getContentText());
    } catch (parseErr) {
      return { error: 'Drive API upload parse failed: ' + uploadResponse.getContentText() + ' | Original: ' + originalError };
    }

    if (uploadResponse.getResponseCode() < 200 || uploadResponse.getResponseCode() > 299 || !fileData || !fileData.id) {
      return { error: 'Drive API upload failed: ' + uploadResponse.getContentText() + ' | Original: ' + originalError };
    }

    const fileId = fileData.id;
    const permissionResponse = UrlFetchApp.fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ role: 'reader', type: 'anyone' }),
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
      }
    );

    if (permissionResponse.getResponseCode() < 200 || permissionResponse.getResponseCode() > 299) {
      console.warn('Unable to set Drive permission:', permissionResponse.getContentText());
    }

    return {
      fileId,
      fileUrl: `https://drive.google.com/uc?export=view&id=${fileId}`,
      fileName
    };
  } catch (err) {
    return { error: 'Drive API fallback failed: ' + String(err) + ' | Original: ' + originalError };
  }
}

function getOrCreateSubFolderViaDriveApi(parentFolderId, folderName) {
  const query = `mimeType='application/vnd.google-apps.folder' and name='${folderName.replace(/'/g, "\\'")}' and '${parentFolderId}' in parents and trashed=false`;
  const listResponse = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(query) + '&fields=files(id,name)',
    {
      method: 'get',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    }
  );

  let listData;
  try {
    listData = JSON.parse(listResponse.getContentText());
  } catch (err) {
    throw new Error('Drive API folder query failed: ' + listResponse.getContentText());
  }

  if (listResponse.getResponseCode() >= 200 && listResponse.getResponseCode() < 300 && listData.files && listData.files.length > 0) {
    return listData.files[0].id;
  }

  const createResponse = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files',
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentFolderId] }),
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    }
  );

  let createData;
  try {
    createData = JSON.parse(createResponse.getContentText());
  } catch (err) {
    throw new Error('Drive API folder create failed: ' + createResponse.getContentText());
  }

  if (createResponse.getResponseCode() < 200 || createResponse.getResponseCode() > 299 || !createData || !createData.id) {
    throw new Error('Drive API folder create failed: ' + createResponse.getContentText());
  }

  return createData.id;
}

// ============================================================
// SAVE WORKFLOW (Upsert by ReferenceNumber in Column C)
// ============================================================

function handleSaveUserAvatar(data) {
  const email = String(data.email || '').trim().toLowerCase();
  if (!email) return jsonResponse({ success: false, error: 'Email is required' });
  if (!data.file || !data.file.bytes) return jsonResponse({ success: false, error: 'Image file is required' });

  const saved = saveFileToDrive(data.file, 'Picture', email);
  let finalUrl = '';
  let fallbackMode = '';

  if (saved && saved.fileUrl) {
    finalUrl = saved.fileUrl;
  } else {
    // Drive upload failed. Fallback to storing the base64 data URL in the Users sheet.
    if (data.file && data.file.bytes && data.file.mimeType) {
      finalUrl = `data:${data.file.mimeType};base64,${String(data.file.bytes)}`;
      fallbackMode = 'sheet-base64';
    }
    if (!finalUrl) {
      return jsonResponse({ success: false, error: saved && saved.error ? saved.error : 'Failed to save avatar image' });
    }
  }

  const sheet = getUsersSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const index = headers.reduce((acc, name, idx) => { acc[String(name || '').trim()] = idx; return acc; }, {});
  const values = sheet.getDataRange().getValues();
  const lastUpdated = new Date().toISOString();
  let updatedRow = -1;

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][index.Email] || '').trim().toLowerCase() === email) {
      if (index.ProfilePictureUrl !== undefined) {
        sheet.getRange(i + 1, index.ProfilePictureUrl + 1).setValue(finalUrl);
      }
      if (index.LastUpdated !== undefined) {
        sheet.getRange(i + 1, index.LastUpdated + 1).setValue(lastUpdated);
      }
      if (index.AvatarUrl !== undefined) {
        sheet.getRange(i + 1, index.AvatarUrl + 1).setValue(finalUrl);
      }
      updatedRow = i + 1;
      break;
    }
  }

  if (updatedRow === -1) {
    const row = [];
    for (let c = 0; c < sheet.getLastColumn(); c++) row.push('');
    row[0] = email;
    if (index.Password !== undefined) row[index.Password] = '';
    if (index.FullName !== undefined) row[index.FullName] = '';
    if (index.ProfilePictureUrl !== undefined) row[index.ProfilePictureUrl] = finalUrl;
    if (index.LastUpdated !== undefined) row[index.LastUpdated] = lastUpdated;
    if (index.PasswordHash !== undefined) row[index.PasswordHash] = '';
    if (index.Role !== undefined) row[index.Role] = 'user';
    if (index.CreatedAt !== undefined) row[index.CreatedAt] = lastUpdated;
    if (index.AvatarUrl !== undefined) row[index.AvatarUrl] = finalUrl;
    sheet.appendRow(row);
    updatedRow = sheet.getLastRow();
  }

  const writtenUrl = String(sheet.getRange(updatedRow, index.ProfilePictureUrl + 1).getValue() || '').trim();
  return jsonResponse({ success: true, profilePictureUrl: finalUrl, avatarUrl: finalUrl, writtenProfilePictureUrl: writtenUrl, row: updatedRow, fileId: saved && saved.fileId ? saved.fileId : null, fallbackMode });
}

function handleUpdateProfilePicture(data) {
  return handleSaveUserAvatar(data);
}

function handleGetUsers(data) {
  const sheet = getUsersSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const index = headers.reduce((acc, name, idx) => {
    acc[String(name || '').trim()] = idx;
    return acc;
  }, {});

  const values = sheet.getDataRange().getValues();
  const users = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const email = String(row[index.Email] || '').trim().toLowerCase();
    if (!email) continue;
    users.push({
      email,
      role: String(row[index.Role] || 'user').trim().toLowerCase(),
      name: String(row[index.FullName] || row[index.Name] || '').trim(),
      position: String(row[index.Position] || '').trim(),
      phone: String(row[index.Phone] || '').trim(),
      birthday: String(row[index.Birthday] || '').trim(),
      status: String(row[index.Status] || 'active').trim(),
      approvedAt: String(row[index.ApprovedAt] || '').trim(),
      createdAt: String(row[index.CreatedAt] || '').trim(),
      profilePictureUrl: String(row[index.ProfilePictureUrl] || row[index.AvatarUrl] || '').trim(),
      avatarUrl: String(row[index.AvatarUrl] || '').trim()
    });
  }

  return jsonResponse({ success: true, users });
}

function handleGetUserProfile(data) {
  const email = String(data.email || '').trim().toLowerCase();
  if (!email) return jsonResponse({ success: false, error: 'Email is required' });

  const sheet = getUsersSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const index = headers.reduce((acc, name, idx) => {
    acc[String(name || '').trim()] = idx;
    return acc;
  }, {});

  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    const rowEmail = String(values[i][index.Email] || '').trim().toLowerCase();
    if (rowEmail !== email) continue;
    return jsonResponse({
      success: true,
      user: {
        email,
        role: String(values[i][index.Role] || 'user').trim().toLowerCase(),
        name: String(values[i][index.FullName] || values[i][index.Name] || '').trim(),
        position: String(values[i][index.Position] || '').trim(),
        phone: String(values[i][index.Phone] || '').trim(),
        birthday: String(values[i][index.Birthday] || '').trim(),
        status: String(values[i][index.Status] || 'active').trim(),
        approvedAt: String(values[i][index.ApprovedAt] || '').trim(),
        createdAt: String(values[i][index.CreatedAt] || '').trim(),
        profilePictureUrl: String(values[i][index.ProfilePictureUrl] || values[i][index.AvatarUrl] || '').trim(),
        avatarUrl: String(values[i][index.AvatarUrl] || '').trim()
      }
    });
  }

  return jsonResponse({ success: false, error: 'User not found' });
}

function handleUpdateUserProfile(data) {
  const email = String(data.email || '').trim().toLowerCase();
  if (!email) return jsonResponse({ success: false, error: 'Email is required' });

  const sheet = getUsersSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const index = headers.reduce((acc, name, idx) => {
    acc[String(name || '').trim()] = idx;
    return acc;
  }, {});

  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    const rowEmail = String(values[i][index.Email] || '').trim().toLowerCase();
    if (rowEmail !== email) continue;

    const rowNumber = i + 1;
    const updates = {
      FullName: String(data.name || '').trim(),
      Name: String(data.name || '').trim(),
      Position: String(data.position || '').trim(),
      Phone: String(data.phone || '').trim(),
      Birthday: String(data.birthday || '').trim(),
      Status: String(data.status || '').trim(),
      ApprovedAt: String(data.approvedAt || '').trim(),
      AvatarUrl: String(data.avatarUrl || '').trim(),
      ProfilePictureUrl: String(data.avatarUrl || String(data.profilePictureUrl || '')).trim(),
      LastUpdated: new Date().toISOString()
    };

    Object.keys(updates).forEach((key) => {
      if (updates[key] !== undefined && updates[key] !== null && key in index) {
        sheet.getRange(rowNumber, index[key] + 1).setValue(updates[key]);
      }
    });

    if (data.newPassword) {
      if (!data.currentPassword) {
        return jsonResponse({ success: false, error: 'Current password is required to set a new password' });
      }
      const storedHash = String(values[i][index.PasswordHash] || '');
      if (storedHash !== Utilities.base64Encode(String(data.currentPassword))) {
        return jsonResponse({ success: false, error: 'Current password is incorrect' });
      }
      sheet.getRange(rowNumber, index.PasswordHash + 1).setValue(Utilities.base64Encode(String(data.newPassword)));
    }

    return jsonResponse({ success: true, user: {
      email,
      role: String(values[i][index.Role] || 'user').trim().toLowerCase(),
      name: updates.Name || String(values[i][index.Name] || '').trim(),
      position: updates.Position || String(values[i][index.Position] || '').trim(),
      phone: updates.Phone || String(values[i][index.Phone] || '').trim(),
      birthday: updates.Birthday || String(values[i][index.Birthday] || '').trim(),
      status: updates.Status || String(values[i][index.Status] || 'active').trim(),
      approvedAt: updates.ApprovedAt || String(values[i][index.ApprovedAt] || '').trim(),
      createdAt: String(values[i][index.CreatedAt] || '').trim(),
      avatarUrl: updates.AvatarUrl || String(values[i][index.AvatarUrl] || '').trim()
    }});
  }

  return jsonResponse({ success: false, error: 'User not found' });
}

function handleSaveWorkflow(data) {
  const refNum   = String(data.referenceNumber || '').trim();
  const process  = String(data.workProcess || '').trim();

  if (!refNum)   return jsonResponse({ success: false, error: 'ReferenceNumber is required' });
  if (!process)  return jsonResponse({ success: false, error: 'WorkProcess is required' });
  if (WORKFLOW_TABS.indexOf(process) === -1) {
    return jsonResponse({ success: false, error: 'Invalid workProcess value' });
  }

  const sheet = getOrCreateWorkflowSheet(process);
  const values = sheet.getDataRange().getValues();
  let existingPdfUrl = '';
  let existingPictureUrl = '';

  // Search for existing record by ReferenceNumber (Column C, index 2)
  // Skip header row (index 0)
  let existingRow = -1;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][2] || '').trim() === refNum) {
      existingRow = i + 1; // Convert to 1-based row number
      break;
    }
  }

  const now = new Date().toISOString();
  if (existingRow > 0) {
    existingPdfUrl = String(values[existingRow - 1][12] || '');
    existingPictureUrl = String(values[existingRow - 1][13] || '');
  }

  let pdfFileUrl = existingPdfUrl;
  let pictureFileUrl = existingPictureUrl;

  if (data.pdfFile && data.pdfFile.bytes) {
    const savedPdf = saveFileToDrive(data.pdfFile, 'PDF', refNum);
    if (savedPdf && savedPdf.fileUrl) {
      pdfFileUrl = savedPdf.fileUrl;
    }
  }

  if (data.imgFile && data.imgFile.bytes) {
    const savedImg = saveFileToDrive(data.imgFile, 'Picture', refNum);
    if (savedImg && savedImg.fileUrl) {
      pictureFileUrl = savedImg.fileUrl;
    }
  }

  const rowData = [
    existingRow > 0 ? values[existingRow - 1][0] : sheet.getLastRow(),  // No (sequential)
    String(data.documentTitle || ''),       // B: DocumentTitle
    refNum,                                 // C: ReferenceNumber (PK)
    String(data.originSource || ''),        // D: OriginSource
    String(data.dateOfEntry || ''),         // E: DateOfEntry
    String(data.inChargeOf || ''),          // F: InChargeOf
    String(data.descriptionSummary || ''),  // G: DescriptionSummary
    process,                                // H: WorkProcess
    String(data.leaderName || ''),          // I: LeaderName
    JSON.stringify(data.workflowData || {}),// J: WorkflowData (JSON)
    now,                                    // K: LastUpdated
    String(data.updatedBy || ''),           // L: UpdatedBy
    pdfFileUrl,                             // M: PDFFileUrl
    pictureFileUrl                          // N: PictureFileUrl
  ];

  if (existingRow > 0) {
    // Update existing row
    sheet.getRange(existingRow, 1, 1, rowData.length).setValues([rowData]);
    return jsonResponse({
      success: true,
      action: 'updated',
      referenceNumber: refNum,
      tab: process,
      assignedNo: rowData[0],
      pdfFileUrl,
      pictureFileUrl
    });
  } else {
    // Append new row
    rowData[0] = sheet.getLastRow();
    sheet.appendRow(rowData);
    return jsonResponse({
      success: true,
      action: 'created',
      referenceNumber: refNum,
      tab: process,
      assignedNo: rowData[0],
      pdfFileUrl,
      pictureFileUrl
    });
  }
}

// ============================================================
// GET WORKFLOW (Search all 4 tabs by ReferenceNumber)
// ============================================================

function handleGetWorkflow(data) {
  const refNum = String(data.referenceNumber || '').trim();
  if (!refNum) return jsonResponse({ success: false, error: 'ReferenceNumber is required' });

  // Search all 4 workflow tabs
  for (let t = 0; t < WORKFLOW_TABS.length; t++) {
    const tabName = WORKFLOW_TABS[t];
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(tabName);

    if (!sheet) continue;

    const values = sheet.getDataRange().getValues();

    // Search Column C (ReferenceNumber) starting from row 2 (index 1)
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][2] || '').trim() === refNum) {
        const row = values[i];
        let workflowData = {};

        try {
          workflowData = JSON.parse(String(row[9] || '{}'));
        } catch (_) {
          // If JSON parsing fails, use empty object
        }

        return jsonResponse({
          success: true,
          record: {
            no:                  row[0],
            documentTitle:       row[1],
            referenceNumber:     row[2],
            originSource:        row[3],
            dateOfEntry:         row[4],
            inChargeOf:          row[5],
            descriptionSummary:  row[6],
            workProcess:         row[7],
            leaderName:          row[8],
            workflowData:        workflowData,
            lastUpdated:         row[10],
            updatedBy:           row[11],
            pdfFileUrl:          row[12] || '',
            pictureFileUrl:      row[13] || '',
            tab:                 tabName
          }
        });
      }
    }
  }

  return jsonResponse({ success: false, error: 'Record not found' });
}

// ============================================================
// DELETE WORKFLOW (removes row by ReferenceNumber from its tab)
// ============================================================

function handleDeleteWorkflow(data) {
  const refNum = String(data.referenceNumber || '').trim();
  if (!refNum) return jsonResponse({ success: false, error: 'ReferenceNumber is required' });

  for (let t = 0; t < WORKFLOW_TABS.length; t++) {
    const tabName = WORKFLOW_TABS[t];
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) continue;

    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][2] || '').trim() === refNum) {
        sheet.deleteRow(i + 1); // 1-based row index
        return jsonResponse({ success: true, referenceNumber: refNum, tab: tabName });
      }
    }
  }

  return jsonResponse({ success: false, error: 'Record not found' });
}

// ============================================================
// GET ALL WORKFLOWS (returns all records from all 4 tabs)
// ============================================================

function handleGetAllWorkflows(data) {
  const allRecords = [];

  for (let t = 0; t < WORKFLOW_TABS.length; t++) {
    const tabName = WORKFLOW_TABS[t];
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(tabName);

    if (!sheet) continue;

    const values = sheet.getDataRange().getValues();

    // Skip header row (index 0), read data from index 1 onwards
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      if (!row[2]) continue; // skip empty ReferenceNumber rows

      let workflowData = {};
      try {
        workflowData = JSON.parse(String(row[9] || '{}'));
      } catch (_) {}

      allRecords.push({
        no:                  row[0],
        documentTitle:       row[1],
        referenceNumber:     row[2],
        originSource:        row[3],
        dateOfEntry:         row[4],
        inChargeOf:          row[5],
        descriptionSummary:  row[6],
        workProcess:         row[7],
        leaderName:          row[8],
        workflowData:        workflowData,
        lastUpdated:         row[10],
        updatedBy:           row[11],
        pdfFileUrl:          row[12] || '',
        pictureFileUrl:      row[13] || '',
        tab:                 tabName
      });
    }
  }

  return jsonResponse({ success: true, records: allRecords });
}

// ============================================================
// AUTO-CREATE WORKFLOW SHEET WITH HEADERS
// ============================================================

function getOrCreateWorkflowSheet(tabName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(tabName);

  if (!sheet) {
    sheet = ss.insertSheet(tabName);
  }

  if (sheet.getMaxColumns() < WORKFLOW_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), WORKFLOW_HEADERS.length - sheet.getMaxColumns());
  }

  sheet.getRange(1, 1, 1, WORKFLOW_HEADERS.length).setValues([WORKFLOW_HEADERS]);
  sheet.setFrozenRows(1);

  return sheet;
}

// ============================================================
// AUTHENTICATION (Users Sheet)
// ============================================================

function handleRegister(data) {
  const email = String(data.email || '').trim().toLowerCase();
  const password = String(data.password || '');
  const name = String(data.name || '').trim();
  const role = String(data.role || 'user').trim().toLowerCase();

  if (!email || !password) {
    return jsonResponse({ success: false, error: 'Email and password are required' });
  }

  if (role !== 'user' && role !== 'admin') {
    return jsonResponse({ success: false, error: 'Role must be user or admin' });
  }

  const sheet = getUsersSheet();
  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0] || '').trim().toLowerCase() === email) {
      return jsonResponse({ success: false, error: 'Email already exists' });
    }
  }

  const passwordHash = Utilities.base64Encode(password);
  const createdAt = new Date().toISOString();
  const lastUpdated = createdAt;

  sheet.appendRow([
    email,
    password,
    name,
    '',
    lastUpdated,
    passwordHash,
    role,
    createdAt,
    name,
    '',
    '',
    '',
    'active',
    createdAt,
    ''
  ]);

  return jsonResponse({
    success: true,
    user: {
      email,
      role,
      name,
      position: '',
      phone: '',
      birthday: '',
      status: 'active',
      approvedAt: createdAt,
      profilePictureUrl: '',
      avatarUrl: ''
    }
  });
}

function handleLogin(data) {
  const email = String(data.email || '').trim().toLowerCase();
  const password = String(data.password || '');

  if (!email || !password) {
    return jsonResponse({ success: false, error: 'Email and password are required' });
  }

  const sheet = getUsersSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const index = headers.reduce((acc, name, idx) => {
    acc[String(name || '').trim()] = idx;
    return acc;
  }, {});
  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    const rowEmail = String(values[i][index.Email] || '').trim().toLowerCase();
    const storedHash = String(values[i][index.PasswordHash] || '');
    const role = String(values[i][index.Role] || 'user').trim().toLowerCase();

    if (rowEmail === email && storedHash === Utilities.base64Encode(password)) {
      return jsonResponse({
        success: true,
        user: {
          email,
          role,
          name: String(values[i][index.FullName] || values[i][index.Name] || '').trim(),
          position: String(values[i][index.Position] || '').trim(),
          phone: String(values[i][index.Phone] || '').trim(),
          birthday: String(values[i][index.Birthday] || '').trim(),
          status: String(values[i][index.Status] || 'active').trim(),
          approvedAt: String(values[i][index.ApprovedAt] || '').trim(),
          profilePictureUrl: String(values[i][index.ProfilePictureUrl] || values[i][index.AvatarUrl] || '').trim(),
          avatarUrl: String(values[i][index.AvatarUrl] || '').trim()
        }
      });
    }
  }

  return jsonResponse({ success: false, error: 'Invalid email or password' });
}

function getUsersSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Users');
  const headers = [
    'Email',
    'Password',
    'FullName',
    'ProfilePictureUrl',
    'LastUpdated',
    'PasswordHash',
    'Role',
    'CreatedAt',
    'Name',
    'Position',
    'Phone',
    'Birthday',
    'Status',
    'ApprovedAt',
    'AvatarUrl'
  ];

  if (!sheet) {
    sheet = ss.insertSheet('Users');
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return sheet;
  }

  const lastCol = sheet.getLastColumn();
  if (lastCol < headers.length) {
    sheet.insertColumnsAfter(lastCol, headers.length - lastCol);
  }

  const existingHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  headers.forEach((header) => {
    if (existingHeaders.indexOf(header) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header);
    }
  });

  return sheet;
}

// ============================================================
// HELPER: JSON RESPONSE
// ============================================================

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
