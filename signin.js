const SESSION_KEY = 'docuflow_session';
const AUTH_API_BASE_KEY = 'docuflow_auth_api_base';
const DEFAULT_AUTH_API_BASE = 'https://script.google.com/macros/s/AKfycbysXZYfSx5_QJ9OwV5dYV3WD-i1Ip5ZXxkG3cT_4JPrg2TIti6418GimPkOnKyYecE/exec';

const $ = id => document.getElementById(id);

function isValidGASUrl(url) {
    return typeof url === 'string' && /^https:\/\/script\.google\.com\/macros\/s\/[^\/]+\/exec(?:\?.*)?$/.test(url.trim());
}

function normalizeGASUrl(url) {
    return String(url || '').trim().replace(/\s+$/g, '').replace(/\/+$|\?+$/g, '');
}

function getAuthApiBase() {
    const customBase = String(localStorage.getItem(AUTH_API_BASE_KEY) || '').trim();
    const defaultBase = String(DEFAULT_AUTH_API_BASE || '').trim();
    const normalizedCustom = normalizeGASUrl(customBase);
    if (isValidGASUrl(normalizedCustom)) return normalizedCustom;
    const normalizedDefault = normalizeGASUrl(defaultBase);
    if (isValidGASUrl(normalizedDefault)) return normalizedDefault;
    return '';
}

function saveSession(session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function getDisplayNameFromEmail(email) {
    const local = String(email || '').split('@')[0] || 'User';
    return local
        .split(/[._-]/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ') || 'User';
}

async function apiRequest(action, body = {}) {
    const url = getAuthApiBase();
    if (!url) {
        return { response: { ok: false, status: 0 }, data: { success: false, error: 'Set your Google Apps Script Web App URL first.' } };
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ action, ...body })
    });
    const text = await response.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch (_err) {
        data = { success: false, error: 'Invalid server response' };
    }
    return { response, data };
}

// Wire UI
const showRegisterLink = $('showRegisterLink');
const showLoginLink = $('showLoginLink');
const loginFormSmall = $('loginFormSmall');
const registerFormSmall = $('registerFormSmall');
const messageBox = $('messageBox');
const loadingOverlay = $('loadingOverlay');

function showMessage(text, type = 'success') {
    if (!messageBox) return;
    messageBox.textContent = text;
    messageBox.className = `message-box show ${type}`;
}

function clearMessage() {
    if (!messageBox) return;
    messageBox.className = 'message-box';
    messageBox.textContent = '';
}

function showLoginForm() {
    clearMessage();
    loginFormSmall.classList.add('active');
    registerFormSmall.classList.remove('active');
}

function showRegisterForm() {
    clearMessage();
    loginFormSmall.classList.remove('active');
    registerFormSmall.classList.add('active');
}

function showLoadingOverlay(duration = 2400) {
    if (!loadingOverlay) return Promise.resolve();
    loadingOverlay.classList.add('show');
    loadingOverlay.setAttribute('aria-hidden', 'false');
    if (loginFormSmall) loginFormSmall.querySelector('button[type="submit"]').disabled = true;
    if (registerFormSmall) registerFormSmall.querySelector('button[type="submit"]').disabled = true;
    return new Promise((resolve) => setTimeout(resolve, duration));
}

if (showRegisterLink) {
    showRegisterLink.addEventListener('click', showRegisterForm);
}

if (showLoginLink) {
    showLoginLink.addEventListener('click', showLoginForm);
}

if (loginFormSmall) {
    loginFormSmall.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = $('loginEmailSmall').value.trim();
        const password = $('loginPasswordSmall').value;
        clearMessage();
        try {
            const { response, data } = await apiRequest('login', { email, password });
            if (!response.ok || !data.success) {
                showMessage((data && data.error) || 'Login failed', 'error');
                return;
            }
            const user = data.user || {};
            saveSession({
                email: user.email || email.toLowerCase(),
                token: 'gas-session',
                name: getDisplayNameFromEmail(user.email || email),
                role: user.role || 'user'
            });
        } catch (_err) {
            showMessage('Unable to reach authentication server.', 'error');
            return;
        }
        await showLoadingOverlay(1400);
        window.location.href = 'Flow.html';
    });
}

if (registerFormSmall) {
    registerFormSmall.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = $('regEmailSmall').value.trim();
        const password = $('regPasswordSmall').value;
        clearMessage();
        try {
            const role = $('regRoleSmall').value || 'user';
            const { response, data } = await apiRequest('register', { email, password, role });
            if (!response.ok || !data.success) {
                showMessage((data && data.error) || 'Registration failed', 'error');
                return;
            }
            showMessage('Registered successfully. You can sign in now.', 'success');
        } catch (_err) {
            showMessage('Unable to reach authentication server.', 'error');
            return;
        }
        showLoginForm();
    });
}
