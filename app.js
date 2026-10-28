/* Digital Legacy — web workspace.
   Two ways to run this same file:
   1. With the Node backend on the same origin (local dev or Render): every call
      below goes to /api, and the server makes all authentication, OTP, identity,
      code and document-access decisions. The session lives in an HttpOnly cookie,
      so this file never handles passwords or tokens.
   2. As a standalone prototype on any static host (GitHub Pages, Live Server):
      the PROTOTYPE API layer right below answers the identical /api routes inside
      the browser, so the whole product can be clicked through with no server. It
      switches itself off as soon as a real backend answers /api/health. */
/* Digital Legacy — PROTOTYPE API (demo mode, no backend deployed).
   Lets the site run as a pure front-end prototype on any static host (GitHub
   Pages, VS Code Live Server, START_WEBSITE.bat). Every /api/* call the
   workspace makes is answered in-browser using the same response shapes as the
   Node backend, against sample data kept in this browser's localStorage.

   It self-disables when a real backend answers on the same origin, so local
   development against /api and the Render deployment are completely unaffected.

   Honest limits of the prototype (nothing here is a security guarantee):
   - SMS is simulated: the generated OTP is shown on screen, it cannot leave
     a static page.
   - Passwords use a small non-cryptographic mixin; the real backend uses scrypt.
   - Uploaded files live in browser storage, not on a server. */
(function () {
'use strict';
const STATE_KEY = 'digitalLegacy:demoState:v1';
const SESSION_KEY = 'digitalLegacy:demoSession:v1';
const SEED_VERSION = 1;
const FORCE_OFF = false;  // true: never mock, even with no backend
const DAY = 86400000;
const PORTAL_MS = 10 * 60 * 1000;
const CODE_MAX_ACTIVE = 3;
const DEMO_CREDENTIALS = { email: 'demo@digitalegacy.app', password: 'demo1234' };

const realFetch = window.fetch ? window.fetch.bind(window) : null;
if (!realFetch) return;

/* ---------------- utilities ---------------- */
const HEX = '0123456789abcdef';
const uid = (p) => p + '-' + Array.from({ length: 8 }, () => HEX[(Math.random() * 16) | 0]).join('');
const now = () => Date.now();
const clone = (v) => JSON.parse(JSON.stringify(v));
const safeGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
const signedIn = () => safeGet(SESSION_KEY) === '1';
const setSignedIn = (on) => safeSet(SESSION_KEY, on ? '1' : '0');
function mixin(text) { // prototype stand-in for the backend's scrypt hash
  let a = 0x811c9dc5 >>> 0, b = 0x01000193 >>> 0;
  const s = String(text);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 16777619) >>> 0; b = Math.imul(b + c, 0x5bd1e995) >>> 0; }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
class Fail extends Error {
  constructor(status, message, extra) { super(message); this.status = status; Object.assign(this, extra || {}); }
}
const bad = (m, code) => new Fail(400, m, { code });
const unauth = (m, code) => new Fail(401, m, { code });
const denied = (reason, m) => new Fail(403, m, { code: 'access_denied', reason });
const conflict = (m, code) => new Fail(409, m, { code });
const notFound = (m, code) => new Fail(404, m, { code });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- domain constants (mirror backend/constants.js) ------------- */
const CATEGORIES = ['Financial account', 'Insurance', 'Important documents', 'Social media', 'Investment', 'Digital service', 'Other'];
const RELATIONS = ['Family member', 'Partner', 'Friend', 'Legal representative', 'Other'];
const DOC_TYPES = ['Aadhaar Card', 'PAN Card', 'Voter ID', 'Passport', 'Driving Licence', 'Other'];
const OTP_POLICY = { length: 6, ttlSeconds: 300, maxAttempts: 5, resendAfterSeconds: 30, maxResends: 3 };
const MAX_UPLOAD = 10485760;
const CAPABILITY = {
  status: 'public',
  sms: { mode: 'test', transport: 'test', live: false, reveal: true, summary: 'Prototype mode: SMS delivery is simulated in the browser, so no real message is sent.' },
  otpPolicy: OTP_POLICY,
  uploads: { allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'], maxBytes: MAX_UPLOAD },
  identity: { docTypes: DOC_TYPES, verificationModel: 'owner_review' }
};

/* ---------------- sample PDF (valid enough for the browser viewer) ----------- */
function makePdf(lines) {
  const esc = (s) => String(s).replace(/[\\()]/g, (c) => '\\' + c);
  let stream = '';
  lines.forEach((line, i) => {
    stream += `BT /F1 ${i === 0 ? 22 : (i === 1 ? 13 : 11)} Tf 70 ${770 - i * 22} Td (${esc(line)}) Tj ET\n`;
  });
  const bodies = [
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Kids [3 0 R] /Count 1>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources <</Font <</F1 5 0 R>>>> /Contents 4 0 R>>',
    `streamobj`,
    '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  bodies.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += i === 3 ? `4 0 obj\n<</Length ${stream.length}>>\nstream\n${stream}\nendstream\nendobj\n` : `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => { pdf += String(o).padStart(10, '0') + ' 00000 n \n'; });
  pdf += `trailer\n<</Size ${bodies.length + 1} /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

/* ---------------- state ---------------- */
let S = null;
function seed() {
  const ts = now();
  const files = {};
  const putSample = (id, lines, name) => {
    const text = makePdf(lines);
    files[id] = { storedName: id, originalName: name, mimeType: 'application/pdf', sizeBytes: text.length, text, dataUrl: null };
  };
  const owner = { id: uid('owner'), name: 'Aarav Mehta', email: DEMO_CREDENTIALS.email, mobile: '9876543210', passwordHash: mixin(DEMO_CREDENTIALS.password), createdAt: ts - 12 * DAY };
  const documents = [
    { title: 'Last will and testament', category: 'Important documents', description: 'Original signed copy is held with the family lawyer.', visibility: 'shared', shareWithVerified: true, age: 9 },
    { title: 'Home insurance policy', category: 'Insurance', description: 'Policy number is available with the issuer.', visibility: 'shared', shareWithVerified: true, age: 6 },
    { title: 'Fixed deposit receipt', category: 'Financial account', description: '', visibility: 'private', shareWithVerified: false, age: 3 }
  ].map((d) => {
    const id = uid('doc');
    putSample(id, ['Digital Legacy — sample record', d.title, d.category, 'Created in the browser for this prototype demonstration.'], d.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.pdf');
    return { id, ownerId: owner.id, title: d.title, category: d.category, description: d.description, kind: 'pdf', mimeType: 'application/pdf', sizeBytes: files[id].sizeBytes, originalName: files[id].originalName, visibility: d.visibility, shareWithVerified: d.shareWithVerified, createdAt: ts - d.age * DAY, updatedAt: ts - d.age * DAY, storedName: id };
  });
  const identityDocs = [];
  const nominees = [
    { name: 'Priya Mehta', email: 'priya@example.com', mobile: '9123456780', relation: 'Family member', permissions: ['Important documents', 'Insurance'], mobileVerified: true, identity: 'approved', age: 8 },
    { name: 'Rohan Iyer', email: 'rohan@example.com', mobile: '9234567810', relation: 'Legal representative', permissions: ['Important documents'], mobileVerified: false, identity: 'pending', age: 2 },
    { name: 'Meera Nair', email: 'meera@example.com', mobile: '9345678120', relation: 'Friend', permissions: ['Financial account'], mobileVerified: true, identity: 'none', age: 1 }
  ].map((n) => {
    const id = uid('nom');
    let identityDocId = null;
    if (n.identity !== 'none') {
      identityDocId = uid('id');
      const docType = n.identity === 'approved' ? 'PAN Card' : 'Aadhaar Card';
      putSample(identityDocId, ['Digital Legacy — identity document', `Type: ${docType}`, 'Stored privately; numbers are kept masked.'], docType.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.pdf');
      identityDocs.push({ id: identityDocId, nomineeId: id, docType, maskedNumber: n.identity === 'approved' ? 'XXXXXXXX9055' : 'XXXXXXXX4821', status: n.identity, createdAt: ts - n.age * DAY + 3600000, updatedAt: ts - n.age * DAY + 3600000, approvedAt: n.identity === 'approved' ? ts - (n.age - 1) * DAY : null, reviewNote: n.identity === 'approved' ? 'Verified against the original in person.' : '', storedName: identityDocId });
    }
    return { id, ownerId: owner.id, name: n.name, email: n.email, mobile: n.mobile, relation: n.relation, permissions: n.permissions, mobileVerified: n.mobileVerified, status: 'active', createdAt: ts - n.age * DAY, updatedAt: ts - n.age * DAY, identityDocId, codes: [], otp: null };
  });
  // One live access code, so the nominee portal can be demonstrated immediately.
  const plain = 'DL-DEMO-' + Array.from({ length: 12 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(Math.random() * 32) | 0]).join('');
  nominees[0].codes.push({ id: uid('code'), plaintext: plain, codeHint: 'DL-••••-' + plain.slice(-4), status: 'active', permissions: ['Important documents', 'Insurance'], singleUse: false, requiresDocumentApproval: true, createdAt: ts - DAY, expiresAt: ts + 6 * DAY, revokedAt: null, usedAt: null, attempts: 0 });
  const audit = [
    { action: 'account_created', detail: '', age: 12 },
    { action: 'nominee_added', detail: 'Priya Mehta', age: 8 },
    { action: 'nominee_verified', detail: 'Priya Mehta', age: 8 },
    { action: 'identity_doc_approved', detail: 'Priya Mehta', age: 7 },
    { action: 'document_uploaded', detail: 'Last will and testament', age: 6 },
    { action: 'security_code_generated', detail: 'Priya Mehta', age: 1 }
  ].map((e) => ({ id: uid('evt'), action: e.action, actorType: 'owner', actorId: owner.id, targetType: null, targetId: null, detail: e.detail, createdAt: ts - e.age * DAY + 7200000 }));
  return {
    v: SEED_VERSION, seededAt: ts, files, users: [owner], currentUserId: owner.id, demoCode: plain, demoMobile: nominees[0].mobile,
    workspaces: { [owner.id]: { nominees, documents, identityDocs, audit } }
  };
}
function save() { try { localStorage.setItem(STATE_KEY, JSON.stringify(S)); } catch (e) { /* private mode: session only */ } }
function load() {
  let parsed = null;
  try { parsed = JSON.parse(safeGet(STATE_KEY) || 'null'); } catch (e) { parsed = null; }
  S = (parsed && parsed.v === SEED_VERSION && parsed.files && parsed.workspaces) ? parsed : seed();
  if (!S.workspaces[S.currentUserId]) S.workspaces[S.currentUserId] = { nominees: [], documents: [], identityDocs: [], audit: [] };
  save();
}
function resetDemo() { S = seed(); save(); setSignedIn(false); }
const me = () => S.users.find((u) => u.id === S.currentUserId) || S.users[0];
const ws = () => {
  const id = me().id;
  if (!S.workspaces[id]) S.workspaces[id] = { nominees: [], documents: [], identityDocs: [], audit: [] };
  return S.workspaces[id];
};
function log(action, detail) {
  const w = ws();
  w.audit.unshift({ id: uid('evt'), action, actorType: 'owner', actorId: me().id, targetType: null, targetId: null, detail: detail || '', createdAt: now() });
  if (w.audit.length > 120) w.audit.length = 120;
}

/* ---------------- validators ---------------- */
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());
const isMobile = (v) => /^\d{10}$/.test(String(v || '').trim());
const isOtp = (v) => /^\d{6}$/.test(String(v || '').trim());
function validName(v, label) {
  const s = String(v || '').trim().slice(0, 80);
  if (s.length < 2) throw bad(`Enter a valid ${String(label || 'name').toLowerCase()}.`, 'invalid');
  return s;
}
function validMobile(v, label) {
  if (!isMobile(v)) throw bad(`Enter a valid 10-digit ${String(label || 'mobile').toLowerCase()}.`, 'invalid');
  return String(v).trim();
}
function enforceMask(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const alnum = s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return alnum.length <= 4 ? alnum : 'XXXXXXXX' + alnum.slice(-4);
}

/* ---------------- view models ---------------- */
function codeView(c) {
  const displayStatus = c.status === 'revoked' ? 'revoked' : c.status === 'used' ? 'used' : c.expiresAt < now() ? 'expired' : c.status;
  return { id: c.id, codeHint: c.codeHint, status: c.status, displayStatus, permissions: c.permissions.slice(), singleUse: !!c.singleUse, requiresDocumentApproval: !!c.requiresDocumentApproval, expiresAt: c.expiresAt, createdAt: c.createdAt, revokedAt: c.revokedAt, usedAt: c.usedAt, attempts: c.attempts || 0 };
}
const liveCodes = (n) => (n.codes || []).filter((c) => (c.status === 'active' || c.status === 'gated') && c.expiresAt > now());
function identityState(n, workspace) {
  const w = workspace && workspace.identityDocs ? workspace : ws();
  const doc = n.identityDocId ? w.identityDocs.find((d) => d.id === n.identityDocId) : null;
  if (!doc) return { status: 'none', doc: null };
  const f = S.files[doc.id] || {};
  return { status: doc.status, doc: { id: doc.id, status: doc.status, docType: doc.docType, maskedNumber: doc.maskedNumber, kind: 'pdf', originalName: f.originalName || 'identity.pdf', mimeType: f.mimeType || 'application/pdf', sizeBytes: f.sizeBytes || 0, createdAt: doc.createdAt, approvedAt: doc.approvedAt || null, reviewNote: doc.reviewNote || '' } };
}
/* Nominee rows never carry the OTP or the plaintext access code: like the real
   backend, only hashes-of-record matter to the client. */
function clientNominee(n) {
  const copy = clone(n);
  delete copy.otp;
  copy.codes = (n.codes || []).map(codeView);
  return copy;
}
function summary(n, workspace) {
  const identity = identityState(n, workspace);
  const count = liveCodes(n).length;
  let label = 'Registered';
  if (n.mobileVerified && identity.status === 'approved') label = 'Mobile & identity verified';
  else if (n.mobileVerified && identity.status === 'pending') label = 'Mobile verified · identity pending';
  else if (n.mobileVerified) label = 'Mobile verified';
  else if (identity.status === 'approved') label = 'Identity approved · mobile pending';
  return Object.assign(clientNominee(n), {
    identity, activeCodes: count,
    accessStatus: n.status === 'active' ? (count ? 'codes_issued' : 'awaiting_access') : 'inactive',
    verification: { registered: true, mobileVerified: !!n.mobileVerified, identityStatus: identity.status, securityCodesIssued: count, authorizedForAccess: !!n.mobileVerified && count > 0, label }
  });
}
const publicDoc = (d) => ({ id: d.id, title: d.title, category: d.category, description: d.description || '', kind: d.kind, mimeType: d.mimeType, sizeBytes: d.sizeBytes, originalName: d.originalName, visibility: d.visibility, shareWithVerified: !!d.shareWithVerified, createdAt: d.createdAt, updatedAt: d.updatedAt });
const pubUser = (u) => ({ id: u.id, name: u.name, email: u.email, mobile: u.mobile || '', createdAt: u.createdAt });
const activeNominees = () => ws().nominees.filter((n) => n.status !== 'removed');
function needNominee(id) { const n = ws().nominees.find((x) => x.id === id); if (!n || n.status === 'removed') throw notFound('Nominee not found.', 'nominee_not_found'); return n; }
function needDocument(id) { const d = ws().documents.find((x) => x.id === id); if (!d) throw notFound('Document not found.', 'doc_not_found'); return d; }
function needCode(id) {
  for (const n of ws().nominees) { const c = (n.codes || []).find((x) => x.id === id); if (c) return { nominee: n, code: c }; }
  throw notFound('Security code not found.', 'code_not_found');
}
function documentsForNominee(workspace, nominee, permissions) {
  if (!nominee.mobileVerified) return [];
  return workspace.documents.filter((d) => d.visibility === 'shared' && d.shareWithVerified && (permissions || []).includes(d.category)).map(publicDoc);
}

/* ---------------- simulated OTP ---------------- */
function issueOtp(n) {
  const pending = n.otp && !n.otp.consumed && n.otp.expiresAt > now();
  if (pending) {
    if (n.otp.resendAt > now()) return { sent: false, reason: 'cooldown', retryAfter: Math.ceil((n.otp.resendAt - now()) / 1000), resendAfter: OTP_POLICY.resendAfterSeconds, policy: OTP_POLICY, dev_otp: n.otp.code };
    if (n.otp.resends >= OTP_POLICY.maxResends) return { sent: false, reason: 'max_resends', retryAfter: 0, resendAfter: OTP_POLICY.resendAfterSeconds, policy: OTP_POLICY, dev_otp: n.otp.code };
    n.otp.resends += 1;
  } else {
    n.otp = { code: String(Math.floor(100000 + Math.random() * 900000)), resends: 0, attempts: 0, consumed: false };
  }
  n.otp.createdAt = now();
  n.otp.expiresAt = now() + OTP_POLICY.ttlSeconds * 1000;
  n.otp.resendAt = now() + OTP_POLICY.resendAfterSeconds * 1000;
  log('nominee_otp_requested', `${n.name} (simulated SMS)`);
  save();
  return { sent: true, expiresAt: n.otp.expiresAt, resendAfter: OTP_POLICY.resendAfterSeconds, policy: OTP_POLICY, delivery: { delivered: true, live: false, mode: 'test', transport: 'test', error: null }, dev_otp: n.otp.code };
}
function verifyOtp(n, code) {
  if (!n.otp || n.otp.consumed) return { ok: false, reason: 'no_active' };
  if (n.otp.expiresAt < now()) { n.otp.consumed = true; return { ok: false, reason: 'expired' }; }
  if (n.otp.attempts >= OTP_POLICY.maxAttempts) { n.otp.consumed = true; return { ok: false, reason: 'too_many' }; }
  if (String(code) !== n.otp.code) {
    n.otp.attempts += 1;
    const attemptsLeft = Math.max(0, OTP_POLICY.maxAttempts - n.otp.attempts);
    if (attemptsLeft === 0) n.otp.consumed = true;
    return { ok: false, reason: 'invalid', attemptsLeft };
  }
  n.otp.consumed = true;
  return { ok: true };
}
const otpPayload = (r) => ({ sent: r.sent, reason: r.reason || null, retryAfter: r.retryAfter || 0, expiresAt: r.expiresAt || null, resendAfter: r.resendAfter || OTP_POLICY.resendAfterSeconds, policy: r.policy || OTP_POLICY, delivery: r.delivery || null, dev_otp: r.dev_otp });

/* ---------------- file handling ---------------- */
const mimeFor = (kind) => kind === 'pdf' ? 'application/pdf' : kind === 'jpg' ? 'image/jpeg' : 'image/png';
function sniffKind(file) {
  const m = /\.([a-z0-9]+)$/i.exec(file && file.name ? file.name : '');
  const ext = (m ? m[1] : '').toLowerCase();
  if (ext === 'jpeg') return 'jpg';
  return ['pdf', 'jpg', 'png'].includes(ext) ? ext : null;
}
const sessionFiles = {};   // object URLs for files uploaded during this session
const blobCache = {};
function putUpload(id, file, kind) {
  sessionFiles[id] = URL.createObjectURL(file);
  S.files[id] = { storedName: id, originalName: String(file.name || `document.${kind}`).slice(0, 180), mimeType: file.type || mimeFor(kind), sizeBytes: file.size, text: null, dataUrl: null };
  if (file.size <= 1500000) {
    const fr = new FileReader();
    fr.onload = () => { if (S.files[id]) { S.files[id].dataUrl = fr.result; save(); } };
    fr.onerror = () => {};
    fr.readAsDataURL(file);
  }
}
function fileIdFor(kind, id) {
  if (kind === 'identity') return ws().identityDocs.some((d) => d.id === id) ? id : null;
  return ws().documents.some((d) => d.id === id) ? id : null;
}
function demoFileUrl(kind, id) { // synchronous: used for iframe src and downloads
  const fileId = fileIdFor(kind, id);
  if (!fileId) return null;
  if (sessionFiles[fileId]) return sessionFiles[fileId];
  const f = S.files[fileId];
  if (!f) return null;
  if (f.dataUrl) return f.dataUrl;
  if (f.text) return blobCache[fileId] || (blobCache[fileId] = URL.createObjectURL(new Blob([f.text], { type: f.mimeType })));
  return null;
}
function downloadName(kind, id) {
  if (kind === 'identity') return (S.files[id] || {}).originalName || 'identity-document.pdf';
  const d = ws().documents.find((x) => x.id === id);
  return d ? d.originalName : 'document.pdf';
}

/* ---------------- route handlers ---------------- */
const ROUTES = {
  'GET /api/capability': () => ({ capability: CAPABILITY }),
  'GET /api/auth/me': () => ({ user: pubUser(me()) }),
  'POST /api/auth/logout': () => { setSignedIn(false); save(); return { signedOut: true }; },
  'POST /api/auth/register': (b) => {
    const name = validName(b.name, 'Full name');
    if (!isEmail(b.email)) throw bad('Enter a valid email address.', 'invalid');
    const mobile = validMobile(b.mobile, 'Mobile number');
    if (String(b.password || '').length < 8) throw bad('Use at least 8 characters for your password.', 'invalid');
    const email = String(b.email).trim().toLowerCase();
    if (S.users.some((u) => u.email === email)) throw conflict('An account with this email already exists. Please sign in.', 'email_taken');
    const user = { id: uid('owner'), name, email, mobile, passwordHash: mixin(b.password), createdAt: now() };
    S.users.push(user);
    S.currentUserId = user.id;
    S.workspaces[user.id] = { nominees: [], documents: [], identityDocs: [], audit: [] };
    setSignedIn(true);
    log('account_created', '');
    save();
    return { user: pubUser(user), token: 'demo-session' };
  },
  'POST /api/auth/login': (b) => {
    const email = String(b.email || '').trim().toLowerCase();
    const user = S.users.find((u) => u.email === email);
    if (!user || user.passwordHash !== mixin(b.password)) {
      if (user) { S.currentUserId = user.id; log('login_failed', 'bad_password'); } else log('login_failed', 'unknown_email');
      save();
      throw unauth('Email or password is incorrect.', 'invalid_credentials');
    }
    S.currentUserId = user.id;
    setSignedIn(true);
    log('login_success', ''); save();
    return { user: pubUser(user), token: 'demo-session' };
  },
  'PATCH /api/auth/profile': (b) => {
    const u = me();
    if (b.name === undefined && b.mobile === undefined) throw bad('Nothing to update.');
    if (b.name !== undefined) u.name = validName(b.name, 'Full name');
    if (b.mobile !== undefined) u.mobile = validMobile(b.mobile, 'Mobile number');
    log('profile_updated', ''); save();
    return { user: pubUser(u) };
  },
  'GET /api/nominees': () => ({ nominees: activeNominees().map((n) => summary(n)), capability: CAPABILITY }),
  'GET /api/documents': () => ({ documents: ws().documents.map((d) => publicDoc(d)) }),
  'POST /api/nominees': (b) => {
    const mobile = validMobile(b.mobile, 'Mobile number');
    const permissions = CATEGORIES.filter((c) => (b.permissions || []).includes(c));
    if (!permissions.length) throw bad('Choose at least one allowed category.', 'permissions');
    const email = b.email ? String(b.email).trim().toLowerCase() : '';
    const dupe = activeNominees().find((x) => x.mobile === mobile || (email && x.email === email));
    if (dupe) throw conflict(`A nominee with these contact details already exists (${dupe.name}).`, 'duplicate_nominee');
    const n = { id: uid('nom'), ownerId: me().id, name: validName(b.name, 'Nominee name'), email, mobile, relation: RELATIONS.includes(b.relation) ? b.relation : RELATIONS[0], permissions, mobileVerified: false, status: 'active', createdAt: now(), updatedAt: now(), identityDocId: null, codes: [], otp: null };
    ws().nominees.push(n);
    log('nominee_added', n.name);
    const r = issueOtp(n);
    save();
    return { nominee: summary(n), otp: otpPayload(r) };
  },
  'GET /api/owners/access': () => {
    const nominees = activeNominees().map((n) => {
      const s = summary(n);
      const codes = (n.codes || []).map(codeView);
      return Object.assign(clientNominee(n), {
        identityApproved: s.identity.status === 'approved', identityStatus: s.identity.status, verification: s.verification,
        codes, activeCodes: codes.filter((c) => c.displayStatus === 'active' || c.displayStatus === 'gated').length
      });
    });
    return { nominees, audit: clone(ws().audit.slice(0, 40)) };
  },
  'GET /api/owners/audit': () => ({ audit: clone(ws().audit.slice(0, 60)) }),
  'POST /api/owners/codes': (b) => {
    const n = needNominee(b.nomineeId);
    if (n.status !== 'active') throw conflict('This nominee is not active.', 'nominee_inactive');
    if (identityState(n).status !== 'approved') { log('security_code_blocked', `${n.name}: identity_not_approved`); save(); throw conflict('Approve the nominee’s identity document before generating a security code.', 'identity_not_approved'); }
    if (liveCodes(n).length >= CODE_MAX_ACTIVE) throw conflict('Too many active codes for this nominee. Revoke one before generating another.', 'code_limit');
    const requested = (b.permissions || []).filter(Boolean);
    const overreach = requested.filter((p) => !n.permissions.includes(p));
    if (overreach.length) throw bad('A security code cannot grant categories the nominee was not given.', 'permissions');
    const permissions = requested.length ? CATEGORIES.filter((c) => requested.includes(c)) : n.permissions.slice();
    if (!permissions.length) throw bad('Select at least one category for this code.', 'permissions');
    const ttlMinutes = Math.min(Math.max(Number(b.ttlMinutes) || 10080, 1), 7 * 24 * 60);
    const body16 = Array.from({ length: 16 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(Math.random() * 32) | 0]).join('');
    const plaintext = `DL-${body16.slice(0, 4)}-${body16.slice(4, 8)}-${body16.slice(8, 12)}-${body16.slice(12, 16)}`;
    const code = { id: uid('code'), plaintext, codeHint: 'DL-••••-' + plaintext.slice(-4), status: 'active', permissions, singleUse: !!b.singleUse, requiresDocumentApproval: true, createdAt: now(), expiresAt: now() + ttlMinutes * 60000, revokedAt: null, usedAt: null, attempts: 0 };
    (n.codes || (n.codes = [])).unshift(code);
    log('security_code_generated', `${n.name} · ${ttlMinutes}m`); save();
    return { code: codeView(code), plaintextCode: plaintext, ttlMinutes, shownOnce: true };
  },
  'POST /api/portal/identify': (b) => {
    const mobile = String(b.mobile || '').trim();
    if (!isMobile(mobile)) throw bad('Enter a valid 10-digit mobile number.', 'invalid_number');
    const matches = S.users.reduce((acc, u) => acc.concat((S.workspaces[u.id] || {}).nominees || []), []).filter((n) => n.mobile === mobile && n.status === 'active');
    if (!matches.length) return { found: false, status: 'refused', message: 'We could not match those details. Please re-check your mobile number or ask the account owner to confirm it.' };
    const hasLive = matches.some((n) => liveCodes(n).length);
    if (!hasLive) return { found: true, status: 'no_active_code', reason: 'missing_code', message: 'You are registered as a nominee, but no active security code has been issued yet. Ask the account owner to generate a security code and share its expiry with you.' };
    return { found: true, status: 'awaiting_code', message: 'Enter the security code the owner shared with you to continue.' };
  },
  'POST /api/portal/redeem': (b) => {
    const mobile = String(b.mobile || '').trim();
    const code = String(b.code || '').trim().toUpperCase();
    if (!isMobile(mobile)) throw bad('Enter a valid 10-digit mobile number.', 'invalid_number');
    if (!/^DL-[A-Z0-9-]{6,}$/.test(code)) throw bad('Enter the security code exactly as the owner provided it.', 'invalid_code');
    const ownerEntry = Object.keys(S.workspaces).find((wid) => ((S.workspaces[wid] || {}).nominees || []).some((n) => n.mobile === mobile && n.status === 'active'));
    if (!ownerEntry) throw denied('mismatch', 'The mobile number and security code do not match any authorised access.');
    const workspace = S.workspaces[ownerEntry];
    const nominee = workspace.nominees.find((n) => n.mobile === mobile && n.status === 'active');
    if (!nominee) throw denied('mismatch', 'The mobile number and security code do not match any authorised access.');
    const found = (nominee.codes || []).find((c) => c.plaintext === code);
    if (!found) throw denied('mismatch', 'The mobile number and security code do not match any authorised access.');
    found.attempts = (found.attempts || 0) + 1;
    const deny = (reason, message) => { save(); throw denied(reason, message); };
    if (found.status === 'revoked') deny('revoked', 'This security code has been revoked by the owner.');
    if (found.status === 'used') deny('used', 'This security code has already been used. Ask the owner to generate a new one.');
    if (found.expiresAt < now()) deny('expired', 'This security code has expired. Ask the owner to generate a new one.');
    const identity = identityState(nominee, workspace);
    if (found.requiresDocumentApproval && identity.status !== 'approved') deny('activation_pending', 'Access is not yet available. The owner’s release conditions have not been met.');
    if (found.singleUse) { found.status = 'used'; found.usedAt = now(); }
    const ownerName = (S.users.find((u) => u.id === ownerEntry) || {}).name || 'Account owner';
    log('portal_granted', nominee.name); save();
    return { granted: true, expiresAt: now() + PORTAL_MS, owner: { name: ownerName }, nominee: { name: nominee.name }, permissions: found.permissions.slice(), documents: documentsForNominee(workspace, nominee, found.permissions) };
  },
  'POST /api/portal/logout': () => ({ signedOut: true })
};

/* Routes the real backend guards with requireOwner / requirePortal. The portal
   and auth entry points are the only public ones in prototype mode. */
const PUBLIC_PATHS = new Set(['/api/capability', '/api/auth/login', '/api/auth/register', '/api/auth/logout', '/api/portal/identify', '/api/portal/redeem', '/api/portal/logout']);

/* Regex-matched routes (they carry ids in the path). */
function dynamic(method, path, body, form) {
  const key = method + ' ' + path;
  let m;
  if (method === 'GET' && (m = /^\/api\/nominees\/([^/]+)$/.exec(path))) return { nominee: summary(needNominee(m[1])), capability: CAPABILITY };
  if (method === 'PATCH' && (m = /^\/api\/nominees\/([^/]+)$/.exec(path))) {
    const n = needNominee(m[1]);
    if (n.status === 'removed') throw notFound('Nominee not found.', 'nominee_not_found');
    if (body.name !== undefined) n.name = validName(body.name, 'Nominee name');
    if (body.email !== undefined) n.email = body.email ? String(body.email).trim().toLowerCase() : '';
    if (body.relation !== undefined && RELATIONS.includes(body.relation)) n.relation = body.relation;
    if (body.permissions !== undefined) {
      const perms = CATEGORIES.filter((c) => (body.permissions || []).includes(c));
      if (!perms.length) throw bad('Keep at least one allowed category.', 'permissions');
      n.permissions = perms;
    }
    if (body.mobile !== undefined) {
      const mobile = validMobile(body.mobile, 'Mobile number');
      if (mobile !== n.mobile) { n.mobile = mobile; n.mobileVerified = false; n.otp = null; }
    }
    if (body.status !== undefined && ['active', 'inactive', 'removed'].includes(body.status)) n.status = body.status;
    n.updatedAt = now();
    log('nominee_updated', n.name); save();
    return { nominee: summary(n) };
  }
  if (method === 'DELETE' && (m = /^\/api\/nominees\/([^/]+)$/.exec(path))) {
    const n = needNominee(m[1]);
    n.status = 'removed';
    (n.codes || []).forEach((c) => { if (c.status === 'active' || c.status === 'gated') { c.status = 'revoked'; c.revokedAt = now(); } });
    log('nominee_removed', n.name); save();
    return { removed: true, id: n.id };
  }
  if (method === 'POST' && (m = /^\/api\/nominees\/([^/]+)\/otp\/send$/.exec(path))) {
    const n = needNominee(m[1]);
    if (!n.mobile) throw bad('This nominee has no mobile number to verify.', 'no_mobile');
    if (n.mobileVerified) return { alreadyVerified: true, nominee: summary(n) };
    return { otp: otpPayload(issueOtp(n)) };
  }
  if (method === 'POST' && (m = /^\/api\/nominees\/([^/]+)\/otp\/verify$/.exec(path))) {
    const n = needNominee(m[1]);
    if (!isOtp(body.code)) throw bad('Enter the 6-digit code.', 'invalid');
    const r = verifyOtp(n, body.code);
    if (!r.ok) {
      log('nominee_otp_failed', `${n.name}: ${r.reason}`); save();
      const message = { expired: 'That code has expired. Request a new one.', too_many: 'Too many incorrect attempts. Request a new code.', invalid: 'That code is incorrect.', no_active: 'No active code. Please request one.' }[r.reason] || 'Verification failed.';
      const err = bad(message, r.reason);
      if (r.attemptsLeft !== undefined) err.attemptsLeft = r.attemptsLeft;
      throw err;
    }
    n.mobileVerified = true; n.updatedAt = now();
    log('nominee_verified', n.name); save();
    return { verified: true, nominee: summary(n) };
  }
  if (method === 'POST' && (m = /^\/api\/nominees\/([^/]+)\/identity-document$/.exec(path))) {
    const n = needNominee(m[1]);
    const file = form && form.get ? form.get('file') : null;
    if (!file || !file.size) throw bad('No file was uploaded.', 'no_file');
    if (file.size > MAX_UPLOAD) throw bad('The file is larger than the 10 MB upload limit.', 'too_large');
    const kind = sniffKind(file);
    if (!kind) throw bad('Only PDF, JPG or PNG files can be stored here.', 'bad_content');
    const id = uid('id');
    putUpload(id, file, kind);
    const docType = DOC_TYPES.includes(form.get('docType')) ? form.get('docType') : DOC_TYPES[0];
    const doc = { id, nomineeId: n.id, docType, maskedNumber: enforceMask(form.get('maskedNumber')), status: 'pending', createdAt: now(), updatedAt: now(), approvedAt: null, reviewNote: '', storedName: id };
    ws().identityDocs.push(doc);
    n.identityDocId = id;
    log('identity_doc_uploaded', `${n.name}: ${docType} pending`); save();
    return { nominee: summary(n), document: Object.assign({}, doc, { originalName: S.files[id].originalName, sizeBytes: S.files[id].sizeBytes }) };
  }
  if (method === 'POST' && (m = /^\/api\/nominees\/([^/]+)\/identity-document\/([^/]+)\/(approve|reject)$/.exec(path))) {
    const n = needNominee(m[1]);
    const doc = ws().identityDocs.find((d) => d.id === m[2] && d.nomineeId === n.id);
    if (!doc) throw notFound('Identity document not found.', 'doc_not_found');
    const approve = m[3] === 'approve';
    doc.status = approve ? 'approved' : 'rejected';
    doc.reviewNote = String(body.note || '').slice(0, 300);
    doc.updatedAt = now();
    if (approve) doc.approvedAt = now(); else n.identityDocId = doc.id;
    log(approve ? 'identity_doc_approved' : 'identity_doc_rejected', n.name); save();
    return { document: clone(doc), nominee: summary(n) };
  }
  if (method === 'GET' && (m = /^\/api\/documents\/([^/]+)$/.exec(path))) return { document: publicDoc(needDocument(m[1])) };
  if (method === 'POST' && path === '/api/documents') {
    const file = form && form.get ? form.get('file') : null;
    if (!file || !file.size) throw bad('No file was uploaded.', 'no_file');
    if (file.size > MAX_UPLOAD) throw bad('The file is larger than the 10 MB upload limit.', 'too_large');
    const kind = sniffKind(file);
    if (!kind) throw bad('Uploads are validated by content in the real system: PDF, JPG or PNG only.', 'bad_content');
    const title = String(form.get('title') || '').trim().slice(0, 120);
    if (!title) throw bad('Enter a document title.', 'invalid');
    const category = CATEGORIES.includes(form.get('category')) ? form.get('category') : CATEGORIES[2];
    const id = uid('doc');
    putUpload(id, file, kind);
    const visibility = form.get('visibility') === 'shared' ? 'shared' : 'private';
    const d = {
      id, ownerId: me().id, title, category, description: String(form.get('description') || '').slice(0, 1000),
      kind, mimeType: S.files[id].mimeType, sizeBytes: S.files[id].sizeBytes, originalName: S.files[id].originalName,
      visibility, shareWithVerified: visibility === 'shared' && form.get('shareWithVerified') === 'true',
      createdAt: now(), updatedAt: now(), storedName: id
    };
    ws().documents.push(d);
    log('document_uploaded', `${d.title} (${d.category})`); save();
    return { document: publicDoc(d) };
  }
  if (method === 'PATCH' && (m = /^\/api\/documents\/([^/]+)$/.exec(path))) {
    const d = needDocument(m[1]);
    if (body.title !== undefined) { const t = String(body.title).trim().slice(0, 120); if (!t) throw bad('Enter a document title.', 'invalid'); d.title = t; }
    if (body.category !== undefined && CATEGORIES.includes(body.category)) d.category = body.category;
    if (body.description !== undefined) d.description = String(body.description || '').slice(0, 1000);
    if (body.visibility !== undefined) d.visibility = body.visibility === 'shared' ? 'shared' : 'private';
    if (body.shareWithVerified !== undefined) d.shareWithVerified = !!body.shareWithVerified && d.visibility === 'shared';
    d.updatedAt = now();
    log('document_updated', d.title); save();
    return { document: publicDoc(d) };
  }
  if (method === 'DELETE' && (m = /^\/api\/documents\/([^/]+)$/.exec(path))) {
    const d = needDocument(m[1]);
    ws().documents = ws().documents.filter((x) => x.id !== d.id);
    delete S.files[d.id];
    log('document_deleted', d.title); save();
    return { removed: true, id: d.id };
  }
  if (method === 'GET' && (m = /^\/api\/owners\/nominees\/([^/]+)\/codes$/.exec(path))) return { codes: (needNominee(m[1]).codes || []).map(codeView) };
  if (method === 'GET' && (m = /^\/api\/owners\/nominees\/([^/]+)\/code-eligibility$/.exec(path))) {
    const n = needNominee(m[1]);
    const approved = identityState(n).status === 'approved';
    const count = liveCodes(n).length;
    return { eligibility: { exists: true, mobileVerified: !!n.mobileVerified, identityApproved: approved, activeCodes: count, canGenerate: approved && count < CODE_MAX_ACTIVE && n.status === 'active', reason: approved ? (count >= CODE_MAX_ACTIVE ? 'limit_reached' : null) : 'identity_not_approved' } };
  }
  if (method === 'POST' && (m = /^\/api\/owners\/codes\/([^/]+)\/revoke$/.exec(path))) {
    const { code } = needCode(m[1]);
    if (code.status !== 'active' && code.status !== 'gated') throw conflict('This code can no longer be revoked.', 'not_revocable');
    code.status = 'revoked'; code.revokedAt = now();
    log('security_code_revoked', code.codeHint); save();
    return { code: codeView(code) };
  }
  return undefined;
}

/* ---------------- fetch interception ---------------- */
function normalize(pathname) {
  const i = pathname.indexOf('/api/');
  return i === -1 ? pathname : pathname.slice(i);
}
function json(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
function errorBody(err) {
  const e = { code: err.code || 'error', message: err.message };
  if (err.reason) e.reason = err.reason;
  if (err.field) e.field = err.field;
  if (err.attemptsLeft !== undefined) e.attemptsLeft = err.attemptsLeft;
  if (err.retryAfter) e.retryAfter = err.retryAfter;
  return { ok: false, error: e };
}
async function parseBody(init, input) {
  const raw = (init && init.body) || (typeof input === 'object' && input ? input.body : null);
  if (!raw) return { json: {}, form: null };
  if (typeof FormData !== 'undefined' && raw instanceof FormData) {
    const out = {};
    raw.forEach((v, k) => { if (typeof v === 'string') out[k] = v; });
    return { json: out, form: raw };
  }
  if (typeof raw === 'string') { try { return { json: JSON.parse(raw) || {}, form: null }; } catch (e) { return { json: {}, form: null }; } }
  return { json: {}, form: null };
}
function methodOf(init, input) {
  return String((init && init.method) || (typeof input === 'object' && input && input.method) || 'GET').toUpperCase();
}

window.fetch = async function (input, init) {
  const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : (input && input.url) || '';
  let url;
  try { url = new URL(rawUrl, location.href); } catch (e) { return realFetch(input, init); }
  if (url.origin !== location.origin) return realFetch(input, init);
  const path = normalize(url.pathname);
  if (path.indexOf('/api/') !== 0) return realFetch(input, init);
  const method = methodOf(init, input);
  if (method === 'GET' && (path === '/api/health' || path === '/api/')) return realFetch(input, init);
  const body = await parseBody(init, input);
  if (!PUBLIC_PATHS.has(path) && !signedIn()) return json(401, { ok: false, error: { code: 'session_expired', message: 'Your session has expired. Please sign in again.' } });
  const created = method === 'POST' && /\/(register|documents|identity-document)$/.test(path);
  try {
    const out = ROUTES[method + ' ' + path] !== undefined ? ROUTES[method + ' ' + path](body.json, body.form) : dynamic(method, path, body.json, body.form);
    if (out === undefined) return json(404, { ok: false, error: { code: 'not_found', message: 'That endpoint does not exist.' } });
    await delay(140 + Math.random() * 200); // keep loading states honest
    return json(created ? 201 : 200, Object.assign({ ok: true }, out));
  } catch (err) {
    if (err instanceof Fail) return json(err.status, errorBody(err));
    return json(500, { ok: false, error: { code: 'internal_error', message: 'Something went wrong. Please try again.' } });
  }
};

/* ---------------- public helper for the front end ----------------
   iframes and downloads are real browser navigations, so they can never be
   intercepted by fetch; app.js asks for a browser-local URL instead. */
window.DigitalLegacyDemo = {
  on: false,
  credentials: DEMO_CREDENTIALS,
  sampleNominee: () => ({ mobile: S.demoMobile, code: S.demoCode }),
  fileUrl: demoFileUrl,
  fileName: downloadName,
  reset: resetDemo,
  clear: () => { try { localStorage.removeItem(STATE_KEY); } catch (e) {} resetDemo(); }
};

/* ---------------- install, unless a real backend answers ----------------
   app.js awaits DigitalLegacyDemoReady before its first request, so the two
   modes never overlap. */
load();
if (FORCE_OFF) {
  window.DigitalLegacyDemoReady = Promise.resolve();
} else {
  const mock = window.fetch;
  window.fetch = realFetch;
  window.DigitalLegacyDemoReady = (async function detect() {
    try {
      const probe = await realFetch('api/health', { method: 'GET', headers: { Accept: 'application/json' } });
      if (probe.ok && String(probe.headers.get('content-type') || '').indexOf('json') !== -1) {
        const data = await probe.clone().json().catch(() => null);
        if (data && data.ok === true && data.service) return; // the genuine backend is live
      }
    } catch (e) { /* static host: no backend, so stay in prototype mode */ }
    window.fetch = mock;
    window.DigitalLegacyDemo.on = true;
  })();
}
})();

const $ = (selector, root = document) => (typeof root === 'string' ? (document.querySelector(root) || document) : root).querySelector(selector);
const $$ = (selector, root = document) => [...(typeof root === 'string' ? (document.querySelector(root) || document) : root).querySelectorAll(selector)];
const THEME_KEY = 'digitalLegacy:theme';
function readStoredTheme() { try { const t = localStorage.getItem(THEME_KEY); if (t === 'light' || t === 'dark') return t; } catch (e) {} return 'dark'; }
function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#eef3f8' : '#071521');
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  applyTheme(next);
  if (app.user) toast(next === 'light' ? 'Light mode on.' : 'Dark mode on.');
}

const app = {
  user: null,
  capability: null,
  nominees: [],
  documents: [],
  access: null,      // GET /api/owners/access aggregate
  audit: [],
  page: 'dashboard',
  timers: [],        // intervals cleared on every render
  cooldowns: {},     // nomineeId -> timestamp when resend unlocks
  portal: { mobile: '', session: null }
};

const pageTitles = {
  dashboard: 'Overview', legacy: 'My Documents', nominees: 'Nominees & Access',
  portal: 'Nominee Access', security: 'Security & Privacy',
  notifications: 'Activity', settings: 'Profile & Settings'
};
const RELATIONS = ['Family member', 'Partner', 'Friend', 'Legal representative', 'Other'];
const docMeta = {
  'Financial account': { icon: '₹', tone: 'blue', desc: 'Banking and financial records' },
  'Insurance': { icon: '◇', tone: 'blue', desc: 'Policies and certificates' },
  'Important documents': { icon: '▤', tone: 'orange', desc: 'Wills, deeds and key documents' },
  'Social media': { icon: '◎', tone: 'orange', desc: 'Social account records' },
  'Investment': { icon: '↗', tone: 'mint', desc: 'Property, trading and portfolio records' },
  'Digital service': { icon: '⌘', tone: 'blue', desc: 'Subscriptions and online services' },
  'Other': { icon: '＋', tone: 'mint', desc: 'Everything else you choose to keep' }
};
const auditLabels = {
  account_created: ['Account created', 'Your Digital Legacy account was created.'],
  login_success: ['Signed in', 'A new session was opened for your account.'],
  login_failed: ['Failed sign-in attempt', 'An incorrect email or password was used.'],
  profile_updated: ['Profile updated', 'Your account details were changed.'],
  nominee_added: ['Nominee added', 'A trusted nominee was added to your plan.'],
  nominee_updated: ['Nominee updated', 'A nominee record was changed.'],
  nominee_removed: ['Nominee removed', 'A nominee was removed from your plan.'],
  nominee_otp_requested: ['Verification code sent', 'An SMS verification code was requested for a nominee.'],
  nominee_otp_failed: ['Verification failed', 'An incorrect verification code was entered.'],
  nominee_verified: ['Nominee mobile verified', 'A nominee confirmed their mobile number with a valid OTP.'],
  identity_doc_uploaded: ['Identity document uploaded', 'An identity document was uploaded and is awaiting your review.'],
  identity_doc_approved: ['Identity document approved', 'You approved a nominee identity document.'],
  identity_doc_rejected: ['Identity document rejected', 'An identity document was sent back.'],
  identity_doc_deleted: ['Identity document removed', 'An identity document record was deleted.'],
  identity_doc_accessed: ['Identity document opened', 'An identity document was viewed or downloaded.'],
  document_uploaded: ['Document uploaded', 'A document was added to your secure vault.'],
  document_updated: ['Document updated', 'A document record was changed.'],
  document_deleted: ['Document deleted', 'A document was removed from your vault.'],
  document_viewed: ['Document opened', 'One of your documents was previewed.'],
  document_downloaded: ['Document downloaded', 'One of your documents was downloaded.'],
  security_code_blocked: ['Code blocked', 'A security code request was blocked until identity is approved.'],
  security_code_generated: ['Security code generated', 'A new nominee security code was issued.'],
  security_code_revoked: ['Security code revoked', 'A security code was cancelled.'],
  portal_granted: ['Nominee access granted', 'A nominee redeemed a security code.'],
  portal_denied: ['Nominee access refused', 'A security code redemption did not grant access.'],
  portal_unknown_code: ['Unknown security code', 'A redemption attempt used a code that does not exist.'],
  portal_no_code: ['Code requested by nominee', 'A registered nominee asked for their security code.'],
  portal_invalid_number: ['Invalid portal number', 'An invalid mobile number was entered on the access portal.'],
  portal_document_accessed: ['Shared document opened', 'A nominee opened a document released to them.'],
  portal_document_denied: ['Document access denied', 'A nominee tried to open a document outside their permission.']
};

/* ---------- small UI helpers (kept from the original design system) ---------- */
function toast(message, ms = 3000) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(window.__dlToastTimer);
  window.__dlToastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
function esc(value = '') { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function attr(value = '') { return esc(value).replace(/`/g, '&#96;'); }
function dateLabel(value = new Date()) { return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
function dateTimeLabel(value) { return new Date(value).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }
function sizeLabel(bytes) { if (!bytes) return ''; const kb = bytes / 1024; return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`; }
function setHidden(selector, hidden) { const el = $(selector); if (el) el.classList.toggle('hidden', !!hidden); }
function closeModal() { $('#modalBackdrop').classList.add('hidden'); $('#modalContent').innerHTML = ''; }
function openModal(html) {
  $('#modalContent').innerHTML = html;
  $('#modalBackdrop').classList.remove('hidden');
  const firstHeading = $('#modalContent h2');
  if (firstHeading) firstHeading.id = 'modalTitle';
  setTimeout(() => $('#modalContent input:not([type=hidden]), #modalContent select, #modalContent textarea, #modalContent button')?.focus(), 60);
}
function showAuthPanel(which = 'welcome') {
  ['welcomePanel', 'loginPanel', 'registerPanel'].forEach(id => $('#' + id).classList.toggle('hidden', id !== which + 'Panel'));
}
function pageHeader(kicker, title, description, actions = '') {
  return `<div class="page-heading"><div><div class="page-kicker">${esc(kicker)}</div><h1>${title}</h1><p>${esc(description)}</p></div>${actions ? `<div class="page-actions">${actions}</div>` : ''}</div>`;
}
function iconMark(icon, tone = 'blue') { return `<span class="record-icon ${tone}">${icon}</span>`; }
function emptyState(icon, title, description, buttonText = '', action = '') {
  return `<div class="empty-state"><div class="empty-symbol">${icon}</div><h3>${esc(title)}</h3><p>${esc(description)}</p>${buttonText ? `<button class="primary-btn" ${action}>${esc(buttonText)} <span>→</span></button>` : ''}</div>`;
}
function statusClass(status = '') {
  if (/approved|verified|active|complete|granted/i.test(status)) return 'success';
  if (/pending|waiting|awaiting|review|not submitted|registered/i.test(status)) return 'pending';
  if (/revoked|expired|used|failed|removed|inactive|refused/i.test(status)) return 'danger';
  return 'info';
}
function statusPill(status) { return `<span class="status-pill ${statusClass(status)}">${esc(status || 'Not submitted')}</span>`; }
function spinner(label = 'Loading…') { return `<div class="empty-state"><div class="empty-symbol dl-spin">◌</div><h3>${esc(label)}</h3></div>`; }
function relTime(ts) {
  const t = Date.parse(ts); if (!Number.isFinite(t)) return 'Recently';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' hr ago';
  if (s < 604800) return Math.floor(s / 86400) + ' days ago';
  return dateLabel(new Date(t));
}

/* ---------- API layer ---------- */
class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error && body.error.message) || 'The server could not be reached.');
    this.status = status;
    this.code = body && body.error ? body.error.code : 'network';
    this.reason = body && body.error ? body.error.reason : null;
    this.field = body && body.error ? body.error.field : null;
    this.attemptsLeft = body && body.error ? body.error.attemptsLeft : undefined;
    this.retryAfter = body && body.error ? body.error.retryAfter : 0;
  }
}
async function api(method, url, opts = {}) {
  const headers = Object.assign({}, opts.headers);
  let body;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  else if (opts.form !== undefined) { body = opts.form; }
  const res = await fetch(url, { method, headers, body, credentials: 'same-origin' });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON (file responses use direct links) */ }
  if (!res.ok || (json && json.ok === false)) {
    const err = new ApiError(res.status, json || { error: { message: `Request failed (${res.status})` } });
    if (res.status === 401 && app.user && url !== '/api/auth/me') forceSignedOut(err.message);
    throw err;
  }
  return json;
}
function forceSignedOut(message) {
  app.user = null; app.nominees = []; app.documents = []; app.access = null; app.audit = [];
  $('#appView').classList.add('hidden'); $('#portalView').classList.add('hidden');
  $('#authView').classList.remove('hidden'); showAuthPanel('login');
  toast(message || 'Your session has expired. Please sign in again.', 4500);
}

/* ---------- prototype file links ----------
   When no backend is deployed (demo-api.js is answering /api in this browser),
   document previews and downloads cannot go through a URL — a browser refuses
   to navigate an iframe or a link to a path only this script knows about. So in
   prototype mode they use a object URL held in memory instead. With the real
   backend running, the normal /api paths are used unchanged. */
const demoMode = () => !!(window.DigitalLegacyDemo && window.DigitalLegacyDemo.on);
function fileSrc(kind, id, apiPath) {
  if (demoMode()) { const url = window.DigitalLegacyDemo.fileUrl(kind, id); return url || ''; }
  return apiPath;
}
function downloadFile(kind, id, apiPath) {
  if (!demoMode()) { window.location.href = apiPath; return; }
  const url = window.DigitalLegacyDemo.fileUrl(kind, id);
  if (!url) { toast('Prototype note: files larger than 1.5 MB are not kept after a page refresh.', 4500); return; }
  const a = document.createElement('a');
  a.href = url; a.download = window.DigitalLegacyDemo.fileName(kind, id) || 'document';
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- data loading ---------- */
async function loadCapability() {
  try { const r = await api('GET', '/api/capability'); app.capability = r.capability; } catch (e) { app.capability = null; }
}
async function loadNominees() {
  const r = await api('GET', '/api/nominees'); app.nominees = r.nominees || [];
  if (r.capability) app.capability = r.capability;
}
async function loadDocuments() { const r = await api('GET', '/api/documents'); app.documents = r.documents || []; }
async function loadAccess() { const r = await api('GET', '/api/owners/access'); app.access = r; app.audit = r.audit || []; }
async function loadAudit() { const r = await api('GET', '/api/owners/audit'); app.audit = r.audit || []; }

function updateGlobalUI() {
  if (!app.user) return;
  const first = (app.user.name || 'User').trim().split(/\s+/)[0] || 'User';
  $('#sidebarUserName').textContent = app.user.name || 'Your account';
  $('#sidebarAvatar').textContent = first.slice(0, 1).toUpperCase();
  $('#topbarAvatar').textContent = first.slice(0, 1).toUpperCase();
  $('#topbarUserName').textContent = first;
  // Activity is server-recorded; the badge simply marks whether any events exist.
  $('#navNotificationCount').classList.add('hidden');
  $('#bnavNotifCount').classList.add('hidden');
  $('#topbarUnreadDot').classList.toggle('show', false);
}

/* ---------- auth (server-side sessions) ---------- */
$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#regName').value.trim(), email = $('#regEmail').value.trim().toLowerCase();
  const mobile = $('#regMobile').value.trim(), password = $('#regPassword').value, confirm = $('#regConfirm').value;
  if (name.length < 2) { toast('Enter your full name.'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('Enter a valid email address.'); return; }
  if (!/^\d{10}$/.test(mobile)) { toast('Enter a 10-digit mobile number.'); return; }
  if (password.length < 8) { toast('Use at least 8 characters for your password.'); return; }
  if (password !== confirm) { toast('Passwords do not match.'); return; }
  if (!$('#consent').checked) { toast('Please accept the privacy principles to continue.'); return; }
  const btn = $('#registerForm button[type=submit]'); btn.disabled = true;
  try {
    await api('POST', '/api/auth/register', { json: { name, email, mobile, password } });
    await enterApp();
    toast('Your account is ready. Welcome to Digital Legacy.', 4000);
  } catch (err) { toast(err.message, 4500); }
  finally { btn.disabled = false; }
});
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#loginEmail').value.trim().toLowerCase(), password = $('#loginPassword').value;
  const btn = $('#loginForm button[type=submit]'); btn.disabled = true;
  try {
    await api('POST', '/api/auth/login', { json: { email, password } });
    try { if ($('#rememberEmail').checked) localStorage.setItem('digitalLegacy:rememberEmail', email); else localStorage.removeItem('digitalLegacy:rememberEmail'); } catch (e2) {}
    await enterApp();
    toast('Welcome back. Your secure session is open.');
  } catch (err) { toast(err.message, 4500); }
  finally { btn.disabled = false; }
});
async function signOut() {
  try { await api('POST', '/api/auth/logout'); } catch (e) {}
  app.user = null; app.nominees = []; app.documents = []; app.access = null; app.audit = [];
  closeModal(); $('#appView').classList.add('hidden'); $('#portalView').classList.add('hidden');
  $('#authView').classList.remove('hidden'); $('#loginPassword').value = ''; $('#profileMenu').classList.add('hidden');
  showAuthPanel('welcome');
  toast('Signed out. Your server-side session was closed.');
}
async function enterApp(destination = 'dashboard') {
  const r = await api('GET', '/api/auth/me');
  app.user = r.user;
  $('#authView').classList.add('hidden'); $('#portalView').classList.add('hidden'); $('#appView').classList.remove('hidden');
  $('#profileMenu').classList.add('hidden');
  updateGlobalUI();
  await loadCapability();
  renderPage(destination);
}

/* ---------- nominee access portal (dedicated nominee experience) ---------- */
function openPortalView() {
  $('#authView').classList.add('hidden');
  // The portal is a full-screen experience: never leave the workspace stacked under it.
  $('#appView').classList.add('hidden');
  $('#portalView').classList.remove('hidden');
  setPortalPanel('mobile');
  $('#portalMobile').value = app.portal.mobile || '';
}
function closePortalView() {
  $('#portalView').classList.add('hidden');
  if (app.user) { renderPage(app.page); } else { $('#authView').classList.remove('hidden'); showAuthPanel('welcome'); }
  setPortalPanel('mobile');
}
function setPortalPanel(which) {
  const active = 'portal' + which.charAt(0).toUpperCase() + which.slice(1) + 'Panel';
  ['portalMobilePanel', 'portalCodePanel', 'portalSessionPanel'].forEach(id => $('#' + id).classList.toggle('hidden', id !== active));
  portalClearErrors();
}
function portalClearErrors() { $$('#portalView .portal-err').forEach(b => b.remove()); }
function portalError(html) {
  const active = ['portalMobilePanel', 'portalCodePanel', 'portalSessionPanel'].find(id => !$('#' + id).classList.contains('hidden')) || 'portalMobilePanel';
  let box = $('#' + active + ' .portal-err');
  if (!box) { box = document.createElement('div'); box.className = 'portal-err'; $('#' + active).append(box); }
  box.innerHTML = `<div class="notice warning">${html}</div>`;
}
async function portalIdentify(e) {
  e.preventDefault();
  const mobile = $('#portalMobile').value.trim();
  if (!/^\d{10}$/.test(mobile)) { portalError('Enter the 10-digit mobile number the owner registered for you.'); return; }
  const btn = $('#portalIdentifyBtn'); btn.disabled = true;
  try {
    const r = await api('POST', '/api/portal/identify', { json: { mobile } });
    app.portal.mobile = mobile;
    if (!r.found) { portalError(esc(r.message)); return; }
    if (r.reason === 'missing_code') { portalError(esc(r.message)); return; }
    $('#portalCodeMobile').textContent = `Mobile: ${mobile}`;
    setPortalPanel('code');
    $('#portalCode').value = '';
  } catch (err) { portalError(esc(err.message)); }
  finally { btn.disabled = false; }
}
async function portalRedeem(e) {
  e.preventDefault();
  const code = $('#portalCode').value.trim().toUpperCase();
  if (!code) { portalError('Enter the security code exactly as the owner provided it.'); return; }
  const btn = $('#portalRedeemBtn'); btn.disabled = true;
  try {
    const r = await api('POST', '/api/portal/redeem', { json: { mobile: app.portal.mobile, code } });
    app.portal.session = { expiresAt: r.expiresAt, owner: r.owner, nominee: r.nominee, permissions: r.permissions, documents: r.documents };
    renderPortalSession();
    setPortalPanel('session');
    toast('Access granted. This session expires automatically.', 4500);
  } catch (err) {
    const why = { revoked: 'This security code has been revoked by the owner.', used: 'This code has already been used.', expired: 'This code has expired. Ask the owner for a new one.', activation_pending: 'The owner has not released this access yet.', mismatch: 'The number and code combination is not valid.', locked: 'Too many incorrect attempts — please wait before trying again.', rate_limited: 'Too many attempts — please wait before trying again.' }[err.reason || err.code] || err.message;
    portalError(esc(why));
  } finally { btn.disabled = false; }
}
function renderPortalSession() {
  const s = app.portal.session; if (!s) return;
  const remaining = Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000));
  $('#portalSessionBody').innerHTML = `
    <div class="record-detail-list">
      <div class="record-detail-row"><span>Shared by</span><span>${esc(s.owner.name)}</span></div>
      <div class="record-detail-row"><span>You are</span><span>${esc(s.nominee.name)}</span></div>
      <div class="record-detail-row"><span>Permission</span><span>${s.permissions.map(p => `<span class="permission-tag">${esc(p)}</span>`).join(' ')}</span></div>
      <div class="record-detail-row"><span>Session ends</span><span><span id="portalCountdown">${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}</span> left</span></div>
    </div>
    <div class="notice info">${esc(s.documents.length ? `You can open only the documents the owner authorised for this code (${s.documents.length} available).` : 'No documents are available under this permission yet. The owner may share more later.')}</div>
    ${s.documents.length ? `<div class="record-grid" style="margin-top:14px">${s.documents.map(portalDocCard).join('')}</div>` : ''}
    <div class="form-actions"><button class="outline-btn" id="portalEndBtn">End access</button></div>`;
  clearInterval(app.portalTimer);
  app.portalTimer = setInterval(() => {
    const el = $('#portalCountdown'); if (!el) return clearInterval(app.portalTimer);
    const secs = Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000));
    el.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    if (secs === 0) { clearInterval(app.portalTimer); app.portal.session = null; closeModal(); setPortalPanel('mobile'); toast('Your nominee session expired.', 4500); }
  }, 1000);
}
function portalDocCard(d) {
  const meta = docMeta[d.category] || docMeta.Other;
  return `<article class="record-card"><div class="record-card-top">${iconMark(meta.icon, meta.tone)}<div class="record-title-group"><h3>${esc(d.title)}</h3><p>${esc(d.category)}</p></div></div><div class="record-card-body"><div class="record-meta-row"><span>Type</span><span>${esc((d.kind || '').toUpperCase())} · ${esc(sizeLabel(d.sizeBytes))}</span></div><div class="record-meta-row"><span>Shared</span><span>${esc(dateLabel(d.createdAt))}</span></div></div><div class="record-card-footer"><small>Released to you by the owner</small><div class="record-card-actions"><button class="tiny-icon-btn" title="Preview" aria-label="Preview ${attr(d.title)}" data-portal-preview="${attr(d.id)}">↗</button><button class="tiny-icon-btn" title="Download" aria-label="Download ${attr(d.title)}" data-portal-download="${attr(d.id)}">⇩</button></div></div></article>`;
}
async function portalLogout() {
  try { await api('POST', '/api/portal/logout'); } catch (e) {}
  clearInterval(app.portalTimer);
  app.portal.session = null;
  closeModal(); setPortalPanel('mobile');
  toast('Nominee session ended.');
}

/* ---------- shell navigation ---------- */
function renderPage(page) {
  if (!app.user) return;
  app.page = pageTitles[page] ? page : 'dashboard';
  // The workspace shell must always be visible here — the portal and auth
  // screens are mutually exclusive full-screen views and may have hidden it.
  $('#appView').classList.remove('hidden');
  $('#authView').classList.add('hidden');
  $('#portalView').classList.add('hidden');
  app.timers.forEach(clearInterval); app.timers = [];
  $('#breadcrumbTitle').textContent = pageTitles[app.page];
  $$('.nav-item').forEach(b => { b.classList.toggle('active', b.dataset.page === app.page); b.setAttribute('aria-current', b.dataset.page === app.page ? 'page' : 'false'); });
  $$('.bottom-nav-item').forEach(b => { b.classList.toggle('active', b.dataset.page === app.page); b.setAttribute('aria-current', b.dataset.page === app.page ? 'page' : 'false'); });
  $('#sidebar').classList.remove('open'); $('#sidebarOverlay').classList.remove('show'); $('#profileMenu').classList.add('hidden');
  updateGlobalUI();
  const renderers = { dashboard: dashboardPage, legacy: documentsPage, nominees: nomineesPage, security: securityPage, notifications: notificationsPage, settings: settingsPage };
  const load = { dashboard: () => Promise.all([loadAccess(), loadDocuments()]), legacy: loadDocuments, nominees: loadNominees, security: loadAudit, notifications: loadAudit, settings: () => Promise.resolve() }[app.page] || loadAccess;
  $('#pageContent').innerHTML = spinner();
  Promise.resolve(load()).then(() => {
    $('#pageContent').innerHTML = (renderers[app.page] || dashboardPage)();
    if (app.page === 'nominees') startResendCountdowns();
  }).catch(err => { $('#pageContent').innerHTML = `<div class="notice warning">Could not load this page: ${esc(err.message)}</div>`; });
  $('#pageContent').focus({ preventScroll: true });
}

/* ---------- Overview ---------- */
function dashboardPage() {
  const noms = app.access ? app.access.nominees : [];
  const verified = noms.filter(n => (n.verification ? n.verification.mobileVerified : n.mobileVerified)).length;
  const activeCodes = noms.reduce((sum, n) => sum + (n.activeCodes || 0), 0);
  const docs = app.documents.length;
  const checks = [!!app.user.mobile, docs > 0, noms.length > 0, verified > 0];
  const percent = Math.round(checks.filter(Boolean).length / checks.length * 100);
  const act = (app.audit || []).slice(0, 5);
  return `${pageHeader('YOUR DIGITAL LIFE, IN ONE PLACE', `Welcome back, ${esc((app.user.name || 'there').trim().split(/\s+/)[0])}.`, 'A little planning today can make things clearer for the people you care about.', `<button class="primary-btn small" data-action="add-document">＋ Add document</button>`)}
    <section class="welcome-hero"><div class="welcome-hero-copy"><div class="hero-label">YOUR INFORMATION. YOUR CHOICE.</div><h2>Your legacy starts<br>with <span>a thoughtful plan.</span></h2><p>Keep important documents in a secure vault, verify the people you trust, and release access only through codes you control.</p><div class="hero-actions"><button class="primary-btn" data-page="legacy">View my documents →</button><button class="outline-btn" data-page="nominees">Manage nominees</button></div></div><div class="hero-emblem" aria-hidden="true"><svg viewBox="0 0 100 100"><path d="M26 14h31l18 18v52H26z" fill="#102f43" stroke="#6dcaef" stroke-width="2.5" stroke-linejoin="round"/><path d="M57 14v18h18" fill="none" stroke="#6dcaef" stroke-width="2.5"/><path d="M38 45h25M38 55h25M38 65h16" stroke="#d7eef8" stroke-width="3" stroke-linecap="round"/><circle cx="70" cy="72" r="15" fill="#ff784f" stroke="#102f43" stroke-width="3"/><path d="m63 72 5 5 9-10" fill="none" stroke="#102f43" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></div></section>
    <div class="stats-grid"><div class="stat-card"><div class="stat-card-top">Secure documents <span class="stat-icon">▤</span></div><div class="stat-value">${docs}</div><div class="stat-note">Stored on the server, never public</div></div><div class="stat-card"><div class="stat-card-top">Trusted nominees <span class="stat-icon orange">♙</span></div><div class="stat-value">${noms.length}</div><div class="stat-note">${verified} with a verified mobile</div></div><div class="stat-card"><div class="stat-card-top">Active access codes <span class="stat-icon mint">◇</span></div><div class="stat-value">${activeCodes}</div><div class="stat-note">Revocable at any moment</div></div><div class="stat-card"><div class="stat-card-top">Plan readiness <span class="stat-icon orange">✦</span></div><div class="stat-value">${percent}<small style="font-size:12px;color:#6e8e9a">%</small></div><div class="stat-note">Setup checklist progress</div></div></div>
    <div class="dashboard-columns"><section class="panel"><div class="panel-heading"><div><h3>Recent activity</h3><p>Recorded by the server, visible to you only</p></div><button class="link-button" data-page="notifications">View all →</button></div><div class="activity-list">${act.length ? act.map(a => { const [title] = auditLabels[a.action] || [prettifyAction(a.action), '']; return `<div class="activity-row"><span class="activity-symbol">${/failed|denied|blocked|revoked/.test(a.action) ? '!' : '✓'}</span><div class="activity-copy"><strong>${esc(title)}</strong><p>${esc(a.detail || '')}</p></div><span class="activity-time">${esc(relTime(a.createdAt))}</span></div>`; }).join('') : `<div class="empty-state"><div class="empty-symbol">◷</div><h3>No activity yet</h3><p>Changes you make in your workspace will appear here.</p></div>`}</div></section><section class="panel"><div class="panel-heading"><div><h3>Quick actions</h3><p>Keep your plan moving forward</p></div></div><div class="quick-actions"><button class="quick-action" data-action="add-document"><span class="qa-icon">＋</span><strong>Upload a document</strong><small>PDF or image, stored securely.</small></button><button class="quick-action" data-page="nominees"><span class="qa-icon">♙</span><strong>Verify a nominee</strong><small>SMS OTP + identity review.</small></button><button class="quick-action" data-page="nominees"><span class="qa-icon">◇</span><strong>Issue an access code</strong><small>Only after identity is approved.</small></button><button class="quick-action" data-page="security"><span class="qa-icon">⚙</span><strong>Security centre</strong><small>See how the system protects you.</small></button></div></section></div>
    <section class="panel readiness-panel"><div class="readiness-top"><strong>Plan setup checklist</strong><span>${percent}% complete</span></div><div class="progress-track"><div class="progress-bar" style="width:${percent}%"></div></div><p class="readiness-tip">${percent === 100 ? 'Your setup is complete. Review your documents and nominees regularly.' : 'Add a document, register a nominee, verify their mobile, approve their identity document, then issue an access code.'}</p></section>`;
}
function prettifyAction(a = '') { return a.split(/[_-]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '); }

/* ---------- My Documents ---------- */
function documentsPage() {
  const actions = `<button class="primary-btn small" data-action="add-document">＋ Upload document</button>`;
  const content = app.documents.length ? `<div class="toolbar"><div class="search-field"><span>⌕</span><input type="search" id="docSearch" placeholder="Search documents by title or category"></div><select id="docFilter" aria-label="Filter documents by category"><option value="all">All categories</option>${Object.keys(docMeta).map(t => `<option value="${attr(t)}">${esc(t)}</option>`).join('')}</select></div><div class="record-grid" id="docGrid">${app.documents.map(docCard).join('')}</div>` : emptyState('▤', 'Your secure vault is empty', 'Upload the PDFs and images your plan depends on — wills, policies, deeds. Files are validated, renamed and stored on the server, never in a public folder.', 'Upload your first document', 'data-action="add-document"');
  return `${pageHeader('YOUR INFORMATION, SECURED', 'My Documents', 'Files live on the server behind authentication. Sharing with verified nominees is opt-in, per document.', actions)}
    <div class="section-note"><span class="note-glyph">◇</span><div><strong>Server-side protection:</strong> uploads are validated by content (PDF/JPG/PNG only, executables rejected), stored with random names outside the web root, and only ever served back to accounts the backend authorises.</div></div>${content}`;
}
function docCard(d) {
  const meta = docMeta[d.category] || docMeta.Other;
  const shared = d.visibility === 'shared' && d.shareWithVerified;
  return `<article class="record-card" data-doc-id="${attr(d.id)}"><div class="record-card-top">${iconMark(meta.icon, meta.tone)}<div class="record-title-group"><h3>${esc(d.title)}</h3><p>${esc(d.category)} · ${(d.kind || '').toUpperCase()} · ${esc(sizeLabel(d.sizeBytes))}</p></div></div><div class="record-card-body"><div class="record-meta-row"><span>File</span><span>${esc(d.originalName)}</span></div>${d.description ? `<div class="record-meta-row"><span>Notes</span><span>${esc(d.description)}</span></div>` : ''}<div class="record-meta-row"><span>Added</span><span>${esc(dateLabel(d.createdAt))}</span></div><div class="record-meta-row"><span>Access</span><span>${shared ? '<span class="status-pill success">Shared with verified nominees</span>' : '<span class="status-pill neutral">Private</span>'}</span></div></div><div class="record-card-footer"><small>Stored on secure server</small><div class="record-card-actions"><button class="tiny-icon-btn" title="Preview" aria-label="Preview ${attr(d.title)}" data-doc-preview="${attr(d.id)}">↗</button><button class="tiny-icon-btn" title="Download" aria-label="Download ${attr(d.title)}" data-doc-download="${attr(d.id)}">⇩</button><button class="tiny-icon-btn" title="${shared ? 'Make private' : 'Share with verified nominees'}" aria-label="Toggle sharing" data-doc-share="${attr(d.id)}">${shared ? '⊘' : '⇗'}</button><button class="tiny-icon-btn" title="Delete" aria-label="Delete ${attr(d.title)}" data-doc-delete="${attr(d.id)}">⌫</button></div></div></article>`;
}
function documentUploadModal() {
  openModal(`<div class="card-kicker">SECURE VAULT</div><h2>Upload a document</h2><p>PDF, JPG or PNG up to ${app.capability ? Math.round(app.capability.uploads.maxBytes / 1048576) : 10} MB. The file is validated by its actual contents, not its name.</p>
    <form id="docUploadForm"><div class="form-grid">
      <div class="field"><label for="docFile">Choose file</label><input id="docFile" class="file-input" type="file" accept=".pdf,.jpg,.jpeg,.png" required><small class="password-hint">Executable and archive files are rejected automatically.</small></div>
      <div class="field"><label for="docTitle">Document title</label><input id="docTitle" type="text" maxlength="120" required placeholder="e.g. Last will and testament"></div>
      <div class="field"><label for="docCategory">Category</label><select id="docCategory">${Object.keys(docMeta).map(t => `<option value="${attr(t)}">${esc(t)}</option>`).join('')}</select><small class="password-hint">Nominee permissions use the same categories.</small></div>
      <div class="field"><label for="docVisibility">Access</label><select id="docVisibility"><option value="private">Private — only I can open it</option><option value="shared">Shared — eligible verified nominees may see it</option></select></div>
      <div class="field full-field"><label for="docNotes">Notes (optional)</label><textarea id="docNotes" maxlength="1000" placeholder="Where the original is kept, issuer references, and similar reminders."></textarea></div>
    </div>
    <label class="check-line"><input id="docShareVerified" type="checkbox" checked> Share with verified nominees whose permission covers this category</label>
    <div class="notice info">Sharing is never automatic: a nominee can only open this if their mobile is verified, their identity is approved, and the owner issues them a code that includes this category.</div>
    <div class="form-actions"><button type="button" class="outline-btn" data-close>Cancel</button><button type="submit" class="primary-btn">Upload securely →</button></div></form>`);
  // Keep the access select and the share checkbox consistent (the server
  // requires BOTH shared visibility and the flag before anyone can see a file).
  const syncShare = () => {
    const shared = $('#docVisibility').value === 'shared';
    const cb = $('#docShareVerified');
    cb.disabled = !shared;
    cb.checked = shared;
    cb.closest('.check-line').style.opacity = shared ? '1' : '.5';
  };
  $('#docVisibility').addEventListener('change', syncShare);
  syncShare();
}
async function submitDocumentUpload() {
  const file = $('#docFile').files[0];
  if (!file) { toast('Choose a file first.'); return; }
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('title', $('#docTitle').value.trim());
  form.append('category', $('#docCategory').value);
  form.append('description', $('#docNotes').value.trim());
  form.append('visibility', $('#docVisibility').value);
  form.append('shareWithVerified', $('#docShareVerified').checked ? 'true' : 'false');
  const btn = $('#docUploadForm button[type=submit]'); btn.disabled = true;
  try {
    await api('POST', '/api/documents', { form });
    closeModal(); await loadDocuments(); renderPage('legacy');
    toast('Document stored securely.');
  } catch (err) { toast(err.message, 4500); btn.disabled = false; }
}
function previewDocument(id) {
  const d = app.documents.find(x => x.id === id); if (!d) return;
  openModal(`<div class="card-kicker">DOCUMENT PREVIEW</div><h2 style="margin-bottom:4px">${esc(d.title)}</h2><p>${esc(d.category)} · ${esc(d.originalName)} · ${esc(sizeLabel(d.sizeBytes))}</p>
    ${docPreviewFrame('document', id, `/api/documents/${attr(id)}/content`, d.title)}
    <div class="form-actions"><button class="outline-btn" data-close>Close</button><button class="primary-btn" data-file-download="document:${attr(id)}">Download <span>⇩</span></button></div>`);
}
function docPreviewFrame(kind, id, apiPath, label) {
  const src = fileSrc(kind, id, apiPath);
  if (!src) return `<div class="notice warning">This prototype could not keep the file contents for this record. Re-open it after uploading again.</div>`;
  return `<iframe class="doc-preview-frame" src="${attr(src)}" title="${attr(label || 'document')} preview"></iframe>`;
}

/* ---------- Nominees: security & access ---------- */
function nomineesPage() {
  const actions = `<button class="primary-btn small" data-action="add-nominee">＋ Add nominee</button>`;
  const live = app.capability && app.capability.sms.live;
  const content = app.nominees.length ? `<div class="nominee-grid">${app.nominees.map(nomineeCard).join('')}</div>` : emptyState('♙', 'No nominees yet', 'Add a trusted person, verify their mobile with a real SMS code, review their identity document, then issue an access code you control.', 'Add a trusted nominee', 'data-action="add-nominee"');
  return `${pageHeader('PEOPLE YOU TRUST · VERIFIED ACCESS', 'Nominees &amp; Access', 'A nominee is a contact until YOU complete verification: SMS OTP on their number, your review of their identity document, and a revocable security code.', actions)}
    <div class="section-note ${live ? '' : 'note-warning'}"><span class="note-glyph">${live ? '✓' : '!'}</span><div><strong>SMS status:</strong> ${live ? 'A live provider is configured — verification codes are delivered by SMS.' : 'No live SMS provider is configured yet. Codes are generated, hashed and verified by the server, but real SMS delivery is not active. The status below always tells you the truth.'}</div></div>${content}`;
}
function nomineeCard(n) {
  const id = attr(n.id);
  const identity = n.identity && n.identity.doc;
  // /api/owners/access returns flat nominee rows; /api/nominees returns a verification object.
  const ver = n.verification || { mobileVerified: !!n.mobileVerified, identityStatus: n.identityStatus, label: n.identityStatus === 'approved' ? n.status || 'Verified' : n.status || 'Registered' };
  const identityStatus = (n.identity && n.identity.status) || ver.identityStatus || (identity && identity.status) || 'none';
  const statusChip = statusPill(ver.label);
  const otpBtn = ver.mobileVerified
    ? `<span class="status-pill success">Mobile verified</span>`
    : `<button class="outline-btn small" data-nom-otp="${id}">Verify mobile (OTP)</button>`;
  const identityBtn = !identity || identityStatus === 'none'
    ? `<button class="outline-btn small" data-nom-identity="${id}">Upload identity</button>`
    : identityStatus === 'pending'
      ? `<button class="primary-btn small" data-nom-review="${id}">Review identity (${esc(identity.docType)})</button>`
      : identityStatus === 'approved'
        ? `<span class="status-pill success">Identity approved</span>`
        : `<button class="outline-btn small" data-nom-identity="${id}">Re-upload identity</button>`;
  return `<article class="nominee-card"><div class="entity-card-top"><span class="entity-icon orange">♙</span><div class="entity-title-group"><h3>${esc(n.name)}</h3><p>${esc(n.relation)} · ${esc(n.mobile || n.email || 'No contact')} · ${esc(n.status)}</p></div>${statusChip}</div>
    <div class="entity-subtext">${ver.authorizedForAccess ? 'This nominee can access the documents you have released under an active code.' : 'No access is granted by being listed — verification and codes are required.'}${identity && identity.maskedNumber ? `<br>Identity: ${esc(identity.docType)} ${esc(identity.maskedNumber)}` : ''}</div>
    <div class="permission-list">${(n.permissions || []).map(p => `<span class="permission-tag">${esc(p)}</span>`).join('')}</div>
    <div class="owner-status-row"><small>Active codes: ${n.activeCodes} · ${esc(n.accessStatus === 'codes_issued' ? 'access available' : 'awaiting access')}</small></div>
    <div class="entity-actions" style="margin-top:13px; display:flex; gap:8px; flex-wrap:wrap">${otpBtn}${identityBtn}<button class="primary-btn small" data-nom-codes="${id}">Access codes (${n.activeCodes})</button><button class="outline-btn small" data-nom-edit="${id}">Edit</button><button class="tiny-icon-btn" aria-label="Remove ${attr(n.name)}" data-nom-delete="${id}">⌫</button></div></article>`;
}
function nomineeModal(id = null) {
  const n = id ? app.nominees.find(x => x.id === id) : null;
  const v = n || { name: '', email: '', mobile: '', relation: 'Family member', permissions: ['Important documents'] };
  openModal(`<div class="card-kicker">TRUSTED CONTACTS</div><h2>${n ? 'Edit nominee' : 'Add a trusted nominee'}</h2><p>${n ? 'Changes never grant extra access — permissions narrow what a code could share, they never widen it.' : 'The mobile number must be theirs: it is how they will verify with SMS and redeem your security code.'}</p>
    <form id="nomineeForm"><input type="hidden" id="nomineeId" value="${attr(n ? n.id : '')}"><div class="form-grid">
      <div class="field"><label for="nomineeName">Full name</label><input id="nomineeName" type="text" maxlength="80" required value="${attr(v.name)}" placeholder="Nominee full name"></div>
      <div class="field"><label for="nomineeRelation">Relationship</label><select id="nomineeRelation">${RELATIONS.map(t => `<option ${v.relation === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="field"><label for="nomineeEmail">Email address</label><input id="nomineeEmail" type="email" value="${attr(v.email || '')}" placeholder="nominee@example.com"></div>
      <div class="field"><label for="nomineeMobile">Mobile number</label><input id="nomineeMobile" type="tel" pattern="[0-9]{10}" maxlength="10" required value="${attr(v.mobile || '')}" placeholder="10-digit mobile"></div>
      <div class="field full-field"><label>Allowed categories</label><div class="check-grid">${Object.keys(docMeta).map(t => `<label class="check-option"><input type="checkbox" name="nomineePermission" value="${attr(t)}" ${(v.permissions || []).includes(t) ? 'checked' : ''}><span>${esc(t)}<small>Only documents shared with verified nominees in this category can ever be seen.</small></span></label>`).join('')}</div></div>
    </div>
    <div class="notice info">Adding a nominee sends an SMS verification code to their number. Nothing is granted until that code is entered correctly.</div>
    <div class="form-actions"><button type="button" class="outline-btn" data-close>Cancel</button><button type="submit" class="primary-btn">${n ? 'Save changes' : 'Add nominee & send OTP'} →</button></div></form>`);
}
async function submitNomineeForm() {
  const id = $('#nomineeId').value;
  const payload = {
    name: $('#nomineeName').value.trim(),
    email: $('#nomineeEmail').value.trim(),
    mobile: $('#nomineeMobile').value.trim(),
    relation: $('#nomineeRelation').value,
    permissions: $$('[name=nomineePermission]:checked').map(x => x.value)
  };
  if (payload.name.length < 2) { toast('Enter the nominee name.'); return; }
  if (!/^\d{10}$/.test(payload.mobile)) { toast('Enter a valid 10-digit mobile number.'); return; }
  if (!payload.permissions.length) { toast('Choose at least one allowed category.'); return; }
  const btn = $('#nomineeForm button[type=submit]'); btn.disabled = true;
  try {
    if (id) {
      await api('PATCH', `/api/nominees/${id}`, { json: payload });
      closeModal(); await loadNominees(); renderPage('nominees'); toast('Nominee updated.');
    } else {
      const r = await api('POST', '/api/nominees', { json: payload });
      closeModal(); await loadNominees(); renderPage('nominees');
      otpModal(r.nominee, r.otp);
    }
  } catch (err) { toast(err.message, 4500); btn.disabled = false; }
}
function otpDeliveryNote(otp) {
  const live = app.capability && app.capability.sms.live;
  if (otp.sent && live) return `<div class="notice success">A verification code was sent by SMS to the nominee's number.</div>`;
  if (otp.sent && !live) return `<div class="notice warning"><strong>No live SMS provider is configured.</strong> The code was generated and verified by the server${otp.dev_otp ? `, and (because this deployment has the local test reveal enabled) it is <span class="mono">${esc(otp.dev_otp)}</span>` : ''}. Real delivery activates once MSG91 credentials are set — the UI never pretends a message was sent when it was not.</div>`;
  if (!otp.sent && otp.reason === 'cooldown') return `<div class="notice warning">Please wait before requesting another code.</div>`;
  if (!otp.sent && otp.reason === 'max_resends') return `<div class="notice warning">The resend limit for this code has been reached. The code stays usable until it expires.</div>`;
  if (!otp.sent && otp.reason === 'delivery_failed') return `<div class="notice warning">The SMS transport refused the message, so no code is active. Check the provider configuration and try again.</div>`;
  return '';
}
function otpModal(n, otp) {
  const policy = otp.policy || (app.capability ? app.capability.otpPolicy : {});
  app.cooldowns[n.id] = Date.now() + (otp.resendAfter || policy.resendAfterSeconds || 60) * 1000;
  openModal(`<div class="card-kicker">MOBILE VERIFICATION</div><h2>Verify ${esc(n.name)}</h2>
    <p>Enter the 6-digit code delivered by SMS to <strong>${esc(n.mobile)}</strong>. Codes are hashed on the server, expire in ${esc(policy.ttlSeconds ? Math.round(policy.ttlSeconds / 60) + ' minutes' : '5 minutes')}, and allow ${esc(policy.maxAttempts || 5)} attempts.</p>
    <div id="otpNote">${otpDeliveryNote(otp)}</div>
    <form id="otpForm"><div class="field"><label for="otpCode">Verification code</label><input id="otpCode" class="otp-code mono" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" required></div>
    <div id="otpStatus"></div>
    <div class="form-actions">
      <button type="button" class="outline-btn" id="otpResendBtn" data-nom="${attr(n.id)}">Resend code</button>
      <button type="submit" class="primary-btn">Verify now →</button>
    </div></form>
    <small class="password-hint" id="otpCountdownHint"></small>`);
  startResendCountdown(n.id);
}
function startResendCountdown(nomineeId) {
  const tick = () => {
    const btn = $('#otpResendBtn'); if (!btn || btn.dataset.nom !== nomineeId) return clearInterval(app.otpTimer);
    const left = Math.ceil(((app.cooldowns[nomineeId] || 0) - Date.now()) / 1000);
    if (left > 0) { btn.disabled = true; const hint = $('#otpCountdownHint'); if (hint) hint.textContent = `You can request a new code in ${left}s.`; }
    else { btn.disabled = false; const hint = $('#otpCountdownHint'); if (hint) hint.textContent = 'Code expired after its window? Request a new one.'; }
  };
  clearInterval(app.otpTimer); app.otpTimer = setInterval(tick, 1000); tick();
}
function startResendCountdowns() { /* page-level; the OTP modal manages its own timer */ }
async function resendOtp(nomineeId, btn) {
  btn.disabled = true;
  try {
    const r = await api('POST', `/api/nominees/${nomineeId}/otp/send`);
    if (r.alreadyVerified) { closeModal(); await loadNominees(); renderPage('nominees'); toast('This nominee is already verified.'); return; }
    $('#otpNote').innerHTML = otpDeliveryNote(r.otp);
    app.cooldowns[nomineeId] = Date.now() + (r.otp.resendAfter || 60) * 1000;
    if (r.otp.sent) toast('New code requested.');
    else if (r.otp.retryAfter) app.cooldowns[nomineeId] = Date.now() + r.otp.retryAfter * 1000;
    else if (r.otp.reason === 'max_resends') toast('Resend limit reached for this code.', 4000);
  } catch (err) { toast(err.message, 4500); btn.disabled = false; }
}
async function submitOtpVerification(e) {
  e.preventDefault();
  const btn = $('#otpResendBtn');
  const nomineeId = btn ? btn.dataset.nom : null;
  const code = $('#otpCode').value.trim();
  if (!nomineeId || !/^\d{6}$/.test(code)) { toast('Enter the 6-digit code.'); return; }
  const status = $('#otpStatus');
  status.innerHTML = spinner('Checking with the server…');
  try {
    const r = await api('POST', `/api/nominees/${nomineeId}/otp/verify`, { json: { code } });
    closeModal(); await loadNominees(); renderPage('nominees');
    toast(`${r.nominee.name}'s mobile is now verified.`, 4000);
  } catch (err) {
    if (status) status.innerHTML = `<div class="notice warning">${esc(err.message)}${err.attemptsLeft !== undefined ? ` <strong>${err.attemptsLeft} attempt${err.attemptsLeft === 1 ? '' : 's'}</strong> remain.` : ''}</div>`;
    $('#otpCode').value = '';
  }
}
function identityModal(nomineeId) {
  const n = app.nominees.find(x => x.id === nomineeId); if (!n) return;
  openModal(`<div class="card-kicker">IDENTITY DOCUMENT</div><h2>Identity proof for ${esc(n.name)}</h2><p>Upload the document the nominee provided (front of Aadhaar, PAN, passport…). It is stored privately and stays <strong>pending</strong> until you personally approve it — approval is what unlocks access codes.</p>
    <form id="identityForm"><input type="hidden" id="identityNominee" value="${attr(nomineeId)}">
    <div class="form-grid">
      <div class="field"><label for="identityFile">Document file</label><input id="identityFile" class="file-input" type="file" accept=".pdf,.jpg,.jpeg,.png" required></div>
      <div class="field"><label for="identityType">Document type</label><select id="identityType">${(app.capability ? app.capability.identity.docTypes : ['Aadhaar Card', 'PAN Card', 'Voter ID', 'Passport', 'Driving Licence', 'Other']).map(t => `<option>${esc(t)}</option>`).join('')}</select></div>
      <div class="field full-field"><label for="identityMasked">Document number (optional)</label><input id="identityMasked" type="text" maxlength="24" placeholder="e.g. 4321 — last digits only"><small class="password-hint">The server stores it masked automatically — a full number is never kept.</small></div>
    </div>
    <div class="notice info">Identity numbers are always masked on the server (only the last digits are stored). The document file itself is kept privately in the server vault, visible only to you.</div>
    <div class="form-actions"><button type="button" class="outline-btn" data-close>Cancel</button><button type="submit" class="primary-btn">Upload for review →</button></div></form>`);
}
async function submitIdentityForm() {
  const nomineeId = $('#identityNominee').value;
  const file = $('#identityFile').files[0];
  if (!file) { toast('Choose the identity document file.'); return; }
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('docType', $('#identityType').value);
  form.append('maskedNumber', $('#identityMasked').value.trim());
  const btn = $('#identityForm button[type=submit]'); btn.disabled = true;
  try {
    await api('POST', `/api/nominees/${nomineeId}/identity-document`, { form });
    closeModal(); await loadNominees(); renderPage('nominees');
    toast('Document uploaded — review it to approve or reject.');
  } catch (err) { toast(err.message, 4500); btn.disabled = false; }
}
function reviewIdentityModal(nomineeId) {
  const n = app.nominees.find(x => x.id === nomineeId); const doc = n && n.identity && n.identity.doc;
  if (!doc) { toast('No identity document on file.'); return; }
  openModal(`<div class="card-kicker">HUMAN REVIEW</div><h2>Review ${esc(n.name)}'s identity</h2>
    <div class="record-detail-list">
      <div class="record-detail-row"><span>Type</span><span>${esc(doc.docType)}</span></div>
      <div class="record-detail-row"><span>Masked number</span><span class="mono">${esc(doc.maskedNumber || '—')}</span></div>
      <div class="record-detail-row"><span>File</span><span>${esc(doc.originalName)} · ${esc(sizeLabel(doc.sizeBytes))}</span></div>
      <div class="record-detail-row"><span>Uploaded</span><span>${esc(dateLabel(doc.createdAt))}</span></div>
      <div class="record-detail-row"><span>Status</span><span>${statusPill(doc.status)}</span></div>
    </div>
    <div class="field" style="margin-top:12px"><label for="reviewNote">Review note (optional, kept on record)</label><input id="reviewNote" type="text" maxlength="300" placeholder="e.g. Verified against original in person"></div>
    ${docPreviewFrame('identity', doc.id, `/api/nominees/${attr(nomineeId)}/identity-document/${attr(doc.id)}/download`, 'identity document')}
    <div class="notice warning">Approving marks this identity as verified and allows an access code to be issued. Only approve if the document is genuinely the nominee's.</div>
    <div class="form-actions"><button class="outline-btn" id="identityRejectBtn" data-nom="${attr(nomineeId)}" data-doc="${attr(doc.id)}">Reject</button><button class="outline-btn" data-file-download="identity:${attr(doc.id)}">Download <span>⇩</span></button><button class="primary-btn" id="identityApproveBtn" data-nom="${attr(nomineeId)}" data-doc="${attr(doc.id)}">Approve identity →</button></div>`);
}
async function decideIdentity(approve) {
  const btn = approve ? $('#identityApproveBtn') : $('#identityRejectBtn');
  const nomineeId = btn.dataset.nom, docId = btn.dataset.doc;
  btn.disabled = true;
  try {
    await api('POST', `/api/nominees/${nomineeId}/identity-document/${docId}/${approve ? 'approve' : 'reject'}`, { json: { note: $('#reviewNote').value.trim() } });
    closeModal(); await loadNominees(); renderPage('nominees');
    toast(approve ? 'Identity approved — access codes can now be issued.' : 'Identity rejected. The nominee can upload another document.');
  } catch (err) { toast(err.message, 4500); btn.disabled = false; }
}
async function codesModal(nomineeId) {
  const n = app.nominees.find(x => x.id === nomineeId); if (!n) return;
  let codes = [];
  try { codes = (await api('GET', `/api/owners/nominees/${nomineeId}/codes`)).codes; } catch (err) { toast(err.message); return; }
  const eligible = n.verification.identityStatus === 'approved';
  openModal(`<div class="card-kicker">SECURITY CODES</div><h2>Access for ${esc(n.name)}</h2>
    ${eligible ? '' : `<div class="notice warning">Codes can only be issued after ${esc(n.name)}'s identity document is approved. ${esc(n.name)}'s current identity status: ${esc(n.verification.identityStatus)}.</div>`}
    <div class="record-detail-list">${codes.length ? codes.map(c => `<div class="record-detail-row"><span><span class="mono">${esc(c.codeHint)}</span><br><small>${c.permissions.map(p => esc(p)).join(', ')}${c.singleUse ? ' · single use' : ''} · ends ${esc(dateTimeLabel(c.expiresAt))}</small></span><span>${statusPill(c.displayStatus)}${c.displayStatus === 'active' || c.displayStatus === 'gated' ? ` <button class="outline-btn small" data-revoke-code="${attr(c.id)}">Revoke</button>` : ''}</span></div>`).join('') : '<div class="record-detail-row"><span>No codes yet</span><span>Generate one when you are ready to release access</span></div>'}</div>
    <div class="form-actions">${eligible ? `<button class="primary-btn" id="genCodeBtn" data-nom="${attr(nomineeId)}">Generate security code →</button>` : ''}<button class="outline-btn" data-close>Close</button></div>`);
}
function generateCodeModal(nomineeId) {
  const n = app.nominees.find(x => x.id === nomineeId); if (!n) return;
  openModal(`<div class="card-kicker">NEW SECURITY CODE</div><h2>Issue an access code for ${esc(n.name)}</h2>
    <form id="codeForm"><input type="hidden" id="codeNominee" value="${attr(nomineeId)}">
    <div class="form-grid">
      <div class="field"><label for="codeTtl">Valid for</label><select id="codeTtl"><option value="1440">1 day</option><option value="4320">3 days</option><option value="10080" selected>7 days</option><option value="60">1 hour (quick handover)</option></select></div>
      <div class="field"><label for="codeSingle">Use limit</label><select id="codeSingle"><option value="false">Reusable until expiry</option><option value="true">Single use</option></select></div>
      <div class="field full-field"><label>Categories this code unlocks</label><div class="check-grid">${(n.permissions || []).map(p => `<label class="check-option"><input type="checkbox" name="codePermission" value="${attr(p)}" checked><span>${esc(p)}<small>Sharing stays per-document too — private documents are never included.</small></span></label>`).join('')}</div></div>
    </div>
    <div class="notice info">The code is random, shown once, stored only as a hash, bound to ${esc(n.name)}'s mobile number, and revocable instantly.</div>
    <div class="form-actions"><button type="button" class="outline-btn" data-close>Cancel</button><button type="submit" class="primary-btn">Generate code →</button></div></form>`);
}
async function submitCodeForm() {
  const nomineeId = $('#codeNominee').value;
  const permissions = $$('[name=codePermission]:checked').map(x => x.value);
  if (!permissions.length) { toast('Select at least one category for this code.'); return; }
  const btn = $('#codeForm button[type=submit]'); btn.disabled = true;
  try {
    const r = await api('POST', '/api/owners/codes', { json: { nomineeId, permissions, ttlMinutes: Number($('#codeTtl').value), singleUse: $('#codeSingle').value === 'true' } });
    showCodeOnce(r.plaintextCode, new Date(Date.now() + r.ttlMinutes * 60000), r.code.permissions);
  } catch (err) { toast(err.message, 5000); btn.disabled = false; }
}
function showCodeOnce(plaintext, expiresAt, permissions) {
  openModal(`<div class="card-kicker">SHOW THIS ONCE</div><h2>Security code ready</h2>
    <div class="code-reveal mono" id="revealCode">${esc(plaintext)}</div>
    <div class="notice warning">This code is shown <strong>one time only</strong> — the server stores just its hash. Share it with the nominee through a channel you trust, and tell them it is valid until <strong>${esc(dateTimeLabel(expiresAt))}</strong> for: ${permissions.map(p => esc(p)).join(', ')}.</div>
    <div class="form-actions"><button class="outline-btn" id="copyCodeBtn" data-code="${attr(plaintext)}">Copy code</button><button class="primary-btn" data-close>Done</button></div>`);
  loadNominees().then(() => { if (app.page === 'nominees') renderPage('nominees'); });
}
async function revokeCode(codeId) {
  try {
    await api('POST', `/api/owners/codes/${codeId}/revoke`);
    toast('Code revoked — any nominee session using it is cut off immediately.');
    closeModal();
    renderPage(app.page);
  } catch (err) { toast(err.message, 4500); }
}

/* ---------- Security & Privacy / Activity ---------- */
function securityPage() {
  const cap = app.capability || {};
  const sms = cap.sms || {};
  const otp = cap.otpPolicy || {};
  const up = cap.uploads || {};
  return `${pageHeader('CONTROL AND TRANSPARENCY', 'Security & Privacy', 'How this workspace protects your information — reported live from the server, not hardcoded here.')}
    <div class="security-badge"><span class="security-badge-icon">◇</span><div><strong>Server-enforced security</strong><small>Passwords use scrypt hashing, sessions use HttpOnly cookies, OTP and access codes are stored only as hashes, and every document request is authorised on the server.</small></div></div>
    <div class="setting-grid"><section class="panel"><div class="panel-heading"><div><h3>Live service status</h3><p>Read directly from the backend</p></div></div><div class="record-detail-list">
      <div class="record-detail-row"><span>SMS delivery</span><span>${sms.live ? '<span class="status-pill success">Live provider</span>' : '<span class="status-pill pending">Test transport — no real SMS</span>'}</span></div>
      <div class="record-detail-row"><span>OTP policy</span><span>${esc(otp.length || 6)} digits · ${esc(Math.round((otp.ttlSeconds || 300) / 60))} min · ${esc(otp.maxAttempts || 5)} attempts · ${esc(otp.maxResends || 3)} resends</span></div>
      <div class="record-detail-row"><span>Uploads</span><span>${(up.allowedTypes || []).join(', ').toUpperCase()} · max ${esc(Math.round((up.maxBytes || 0) / 1048576))} MB · validated by content</span></div>
      <div class="record-detail-row"><span>Identity review</span><span>${esc(cap.identity ? (cap.identity.verificationModel === 'owner_review' ? 'Approved only by you, the account owner' : cap.identity.verificationModel) : '')}</span></div>
      <div class="record-detail-row"><span>Session</span><span>HttpOnly · SameSite=Strict cookie</span></div>
    </div></section><section class="panel"><div class="panel-heading"><div><h3>How access is released</h3><p>The full chain, every step server-checked</p></div></div><div class="info-list">
      <div class="info-list-item"><span>1</span><div><strong>Add the nominee.</strong> Nothing is granted — they become a contact on your plan.</div></div>
      <div class="info-list-item"><span>2</span><div><strong>SMS OTP.</strong> The code is generated, hashed and verified on the server. It expires, locks after wrong attempts, and cannot be reused.</div></div>
      <div class="info-list-item"><span>3</span><div><strong>Identity document.</strong> Uploaded privately. It stays pending until you personally approve it.</div></div>
      <div class="info-list-item"><span>4</span><div><strong>Security code.</strong> Random, shown once, stored hashed, bound to their number, revocable. Blocked until identity approval.</div></div>
      <div class="info-list-item"><span>5</span><div><strong>Scoped access.</strong> The nominee portal session can open only shared documents inside the code's categories — nothing else, ever.</div></div>
    </div><div class="form-actions"><button class="outline-btn" data-action="lock-vault">Sign out</button></div></section></div>
    <section class="panel" style="margin-top:16px"><div class="panel-heading"><div><h3>Recent security events</h3><p>The server records every sensitive action under your account</p></div><button class="link-button" data-page="notifications">Full activity →</button></div>
    <div class="record-detail-list">${(app.audit || []).slice(0, 8).map(a => `<div class="record-detail-row"><span>${esc((auditLabels[a.action] || [prettifyAction(a.action)])[0])}<br><small>${esc(a.detail || '')}</small></span><span>${esc(relTime(a.createdAt))}</span></div>`).join('') || '<div class="record-detail-row"><span>No events yet</span><span>—</span></div>'}</div></section>`;
}
function notificationsPage() {
  const items = app.audit || [];
  const content = items.length ? `<section class="panel"><div class="panel-heading"><div><h3>Activity log</h3><p>Recorded by the server for your account only</p></div></div>${items.map(a => { const [title = prettifyAction(a.action), detail = a.detail || ''] = auditLabels[a.action] || []; return `<div class="notification-card"><span class="notification-icon ${/failed|denied|blocked|revoked/.test(a.action) ? 'pending' : ''}">${/failed|denied|blocked|revoked/.test(a.action) ? '!' : '✓'}</span><div class="notification-body"><strong>${esc(title)}</strong><p>${esc(detail)}${a.detail ? ` <em>(${esc(a.detail)})</em>` : ''}</p><small>${esc(relTime(a.createdAt))}</small></div></div>`; }).join('')}</section>` : emptyState('◷', 'No activity yet', 'Sign-ins, verifications, uploads and code events will appear here.');
  return `${pageHeader('STAY INFORMED', 'Activity', 'A complete, server-side log of everything happening in your workspace.')}${content}`;
}

/* ---------- Settings ---------- */
function settingsPage() {
  const u = app.user;
  return `${pageHeader('YOUR ACCOUNT', 'Profile & Settings', 'Update your details and manage your account.')}
    <div class="setting-grid"><section class="panel"><div class="panel-heading"><div><h3>Profile details</h3><p>Stored on your secure server account</p></div></div>
      <form id="profileForm" class="profile-form"><div class="field full-field"><label for="profileName">Full name</label><input id="profileName" type="text" value="${attr(u.name)}" required maxlength="80"></div>
      <div class="field full-field"><label for="profileEmail">Email address</label><input id="profileEmail" type="email" value="${attr(u.email)}" disabled><small class="password-hint">Your sign-in email cannot be changed.</small></div>
      <div class="field full-field"><label for="profileMobile">Mobile number</label><input id="profileMobile" type="tel" pattern="[0-9]{10}" maxlength="10" value="${attr(u.mobile || '')}" required></div>
      <div class="field full-field"><button class="primary-btn" type="submit">Save profile changes →</button></div></form></section>
    <section class="panel"><div class="panel-heading"><div><h3>Account information</h3><p>Live counts from the server</p></div></div>
      <div class="record-detail-list"><div class="record-detail-row"><span>Account email</span><span>${esc(u.email)}</span></div>
      <div class="record-detail-row"><span>Documents</span><span>${app.documents.length}</span></div>
      <div class="record-detail-row"><span>Trusted nominees</span><span>${app.nominees.length}</span></div>
      <div class="record-detail-row"><span>Password</span><span>scrypt-hashed on the server — never stored in plaintext</span></div>
      <div class="record-detail-row"><span>Sessions</span><span>HttpOnly cookie · expires automatically</span></div></div>
      <div class="notice info" style="margin-top:16px">Password reset: because the server never stores your password, reset is handled by the account owner process on the server side. Keep your password safe.</div>
      <div class="form-actions"><button class="outline-btn" data-action="lock-vault">Sign out</button></div></section>
    ${demoMode() ? `<section class="panel"><div class="panel-heading"><div><h3>Prototype data</h3><p>This build runs in your browser</p></div></div><div class="record-detail-list"><div class="record-detail-row"><span>Storage</span><span>This browser only (localStorage)</span></div><div class="record-detail-row"><span>Backend</span><span>Not deployed — the workspace is a clickable prototype</span></div><div class="record-detail-row"><span>SMS &amp; files</span><span>Simulated in the browser</span></div></div><div class="form-actions"><button class="outline-btn" data-action="reset-prototype">Reset to sample data</button></div></section>` : ''}</div>`;
}
async function saveProfile(e) {
  e.preventDefault();
  const name = $('#profileName').value.trim(), mobile = $('#profileMobile').value.trim();
  if (name.length < 2) { toast('Enter your full name.'); return; }
  if (!/^\d{10}$/.test(mobile)) { toast('Enter a valid 10-digit mobile number.'); return; }
  try {
    const r = await api('PATCH', '/api/auth/profile', { json: { name, mobile } });
    app.user = r.user; updateGlobalUI(); renderPage('settings'); toast('Profile updated on the server.');
  } catch (err) { toast(err.message, 4500); }
}

/* ---------- event delegation ---------- */
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-toggle-input]');
  if (toggle) { const input = $('#' + toggle.dataset.toggleInput); if (!input) return; input.type = input.type === 'password' ? 'text' : 'password'; toggle.textContent = input.type === 'password' ? 'Show' : 'Hide'; return; }

  const page = e.target.closest('[data-page]');
  if (page) { if (page.dataset.page === 'portal') { openPortalView(); } else if (app.user) { renderPage(page.dataset.page); } return; }
  const closeBtn = e.target.closest('[data-close]'); if (closeBtn) { closeModal(); return; }
  const backWelcome = e.target.closest('[data-back-welcome]'); if (backWelcome) { showAuthPanel('welcome'); return; }
  const openAuth = e.target.closest('[data-open-auth]'); if (openAuth) { showAuthPanel(openAuth.dataset.openAuth); return; }

  if (e.target.closest('#nomineeChoice')) { openPortalView(); return; }
  if (e.target.closest('#portalBackBtn')) { closePortalView(); return; }
  if (e.target.closest('[data-portal-back]')) { setPortalPanel('mobile'); return; }
  if (e.target.closest('#portalEndBtn')) { portalLogout(); return; }
  if (e.target.closest('#copyCodeBtn')) { const b = e.target.closest('#copyCodeBtn'); navigator.clipboard?.writeText(b.dataset.code).then(() => toast('Code copied.')).catch(() => toast('Copy is unavailable — select the code manually.')); return; }
  // Portal session actions run while SIGNED OUT as the nominee — must precede the owner gate below.
  const portalPreview = e.target.closest('[data-portal-preview]');
  if (portalPreview) { const id = portalPreview.dataset.portalPreview; const d = (app.portal.session || {}).documents?.find(x => x.id === id); openModal(`<div class="card-kicker">SHARED DOCUMENT</div><h2>${esc(d ? d.title : 'Document')}</h2>${docPreviewFrame('document', id, `/api/portal/documents/${attr(id)}/content`, 'shared document')}<div class="form-actions"><button class="outline-btn" data-close>Close</button><button class="primary-btn" data-file-download="document:${attr(id)}">Download <span>⇩</span></button></div>`); return; }
  const fileDownload = e.target.closest('[data-file-download]');
  if (fileDownload) {
    const [kind, id] = fileDownload.dataset.fileDownload.split(':');
    downloadFile(kind, id, kind === 'identity' ? `/api/nominees/0/identity-document/${id}/download?download=1` : `/api/documents/${id}/download`);
    return;
  }
  const portalDownload = e.target.closest('[data-portal-download]'); if (portalDownload) { downloadFile('document', portalDownload.dataset.portalDownload, `/api/portal/documents/${portalDownload.dataset.portalDownload}/content?download=1`); return; }
  if (e.target.closest('#identityApproveBtn')) { decideIdentity(true); return; }
  if (e.target.closest('#identityRejectBtn')) { decideIdentity(false); return; }
  if (e.target.closest('#otpResendBtn')) { const b = e.target.closest('#otpResendBtn'); resendOtp(b.dataset.nom, b); return; }
  if (e.target.closest('#genCodeBtn')) { generateCodeModal(e.target.closest('#genCodeBtn').dataset.nom); return; }
  const revoke = e.target.closest('[data-revoke-code]'); if (revoke) { revokeCode(revoke.dataset.revokeCode); return; }

  if (!app.user) return;
  const action = e.target.closest('[data-action]');
  if (action) {
    switch (action.dataset.action) {
      case 'add-document': documentUploadModal(); return;
      case 'add-nominee': nomineeModal(); return;
      case 'lock-vault': signOut(); return;
      case 'reset-prototype': window.DigitalLegacyDemo.reset(); forceSignedOut('Sample workspace restored. Sign in with the sample account.'); return;
    }
  }
  const nomOtp = e.target.closest('[data-nom-otp]');
  if (nomOtp) { const n = app.nominees.find(x => x.id === nomOtp.dataset.nomOtp); if (n) openModalFromOtpSend(n); return; }
  const nomId = e.target.closest('[data-nom-identity]'); if (nomId) { identityModal(nomId.dataset.nomIdentity); return; }
  const nomReview = e.target.closest('[data-nom-review]'); if (nomReview) { reviewIdentityModal(nomReview.dataset.nomReview); return; }
  const nomCodes = e.target.closest('[data-nom-codes]'); if (nomCodes) { codesModal(nomCodes.dataset.nomCodes); return; }
  const nomEdit = e.target.closest('[data-nom-edit]'); if (nomEdit) { nomineeModal(nomEdit.dataset.nomEdit); return; }
  const nomDel = e.target.closest('[data-nom-delete]');
  if (nomDel) { const n = app.nominees.find(x => x.id === nomDel.dataset.nomDelete); if (n && confirm(`Remove ${n.name} from your nominees? Their codes stop working immediately.`)) { api('DELETE', `/api/nominees/${n.id}`).then(() => { toast('Nominee removed.'); renderPage('nominees'); }).catch(err => toast(err.message, 4500)); } return; }
  const preview = e.target.closest('[data-doc-preview]'); if (preview) { previewDocument(preview.dataset.docPreview); return; }
  const download = e.target.closest('[data-doc-download]'); if (download) { downloadFile('document', download.dataset.docDownload, `/api/documents/${download.dataset.docDownload}/download`); return; }
  const share = e.target.closest('[data-doc-share]');
  if (share) { const d = app.documents.find(x => x.id === share.dataset.docShare); if (d) { const toShared = !(d.visibility === 'shared' && d.shareWithVerified); api('PATCH', `/api/documents/${d.id}`, { json: { visibility: toShared ? 'shared' : 'private', shareWithVerified: toShared } }).then(() => { toast(toShared ? 'Now shareable with eligible verified nominees.' : 'Document is private again.'); renderPage('legacy'); }).catch(err => toast(err.message, 4500)); } return; }
  const del = e.target.closest('[data-doc-delete]');
  if (del) { const d = app.documents.find(x => x.id === del.dataset.docDelete); if (d && confirm(`Delete “${d.title}”? The file is removed from the server permanently.`)) { api('DELETE', `/api/documents/${d.id}`).then(() => { toast('Document deleted.'); renderPage('legacy'); }).catch(err => toast(err.message, 4500)); } return; }
});
async function openModalFromOtpSend(n) {
  try {
    const r = await api('POST', `/api/nominees/${n.id}/otp/send`, { json: {} });
    if (r.alreadyVerified) { toast('This nominee is already verified.'); renderPage('nominees'); return; }
    otpModal(n, r.otp);
  } catch (err) { toast(err.message, 4500); }
}
document.addEventListener('submit', (e) => {
  if (e.target.id === 'portalIdentifyForm') { e.preventDefault(); portalIdentify(e); return; }
  if (e.target.id === 'portalRedeemForm') { e.preventDefault(); portalRedeem(e); return; }
  if (e.target.id === 'otpForm') { submitOtpVerification(e); return; }
  if (!app.user) return;
  e.preventDefault();
  if (e.target.id === 'nomineeForm') submitNomineeForm();
  else if (e.target.id === 'docUploadForm') submitDocumentUpload();
  else if (e.target.id === 'identityForm') submitIdentityForm();
  else if (e.target.id === 'codeForm') submitCodeForm();
  else if (e.target.id === 'profileForm') saveProfile(e);
});
$('#pageContent').addEventListener('input', (e) => { if (e.target.id === 'docSearch') filterDocuments(); });
$('#pageContent').addEventListener('change', (e) => { if (e.target.id === 'docFilter' || e.target.id === 'docSearch') filterDocuments(); });
function filterDocuments() {
  const search = ($('#docSearch')?.value || '').trim().toLowerCase(), filter = $('#docFilter')?.value || 'all';
  $$('.record-card', $('#docGrid')).forEach(card => {
    const d = app.documents.find(x => x.id === card.dataset.docId);
    const matches = !!d && (filter === 'all' || d.category === filter) && [d.title, d.category, d.description, d.originalName].join(' ').toLowerCase().includes(search);
    card.classList.toggle('hidden', !matches);
  });
}

/* ---------- shell wiring ---------- */
$('#mainNav').addEventListener('click', e => { const btn = e.target.closest('[data-page]'); if (btn) { if (btn.dataset.page === 'portal') openPortalView(); else renderPage(btn.dataset.page); } });
$('#bottomNav').addEventListener('click', e => { const btn = e.target.closest('[data-page]'); if (btn) renderPage(btn.dataset.page); });
$('#topbarNotifications').addEventListener('click', () => renderPage('notifications'));
$('#sidebarProfileBtn').addEventListener('click', () => renderPage('settings'));
$('#profileMenuToggle').addEventListener('click', () => $('#profileMenu').classList.toggle('hidden'));
$('#profileMenu').addEventListener('click', e => { const btn = e.target.closest('[data-go-page]'); if (btn) renderPage(btn.dataset.goPage); });
$('#topbarSignOut').addEventListener('click', signOut);
$('#modalClose').addEventListener('click', closeModal);
$('#modalBackdrop').addEventListener('click', e => { if (e.target === $('#modalBackdrop')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modalBackdrop').classList.contains('hidden')) closeModal(); });
function quickGuideModal() {
  const step = (n, title, body) => `<div class="guide-step"><span class="guide-step-num">${n}</span><div><strong>${title}</strong><p>${body}</p></div></div>`;
  openModal(`<div class="form-symbol">?</div><h2 id="modalTitle">How Digital Legacy works</h2><p>A complete chain, every step enforced by the secure backend.</p>
    ${step(1, 'My Documents', 'Upload the PDFs and images your plan depends on. Files are validated by content, stored privately, and stay private until you share them.')}
    ${step(2, 'Add a nominee', 'Register the person and the categories they may access. Being listed grants nothing on its own.')}
    ${step(3, 'Verify their mobile', 'The server sends a real SMS OTP to their number — hashed, five-minute expiry, attempt-limited.')}
    ${step(4, 'Review identity', 'They give you an identity document; you upload it and approve or reject it personally. Codes are blocked until then.')}
    ${step(5, 'Issue & share a code', 'A random one-time-shown code bound to their mobile. Revoke it any time — access stops instantly.')}
    ${step(6, 'Nominee access', 'They open the Nominee Access page, confirm their mobile and code, and see only the shared documents their code allows.')}
    <div class="notice info">Everything above is verified on the server for every request. Nothing in the website itself can bypass a step.</div>
    <div class="form-actions"><button class="outline-btn" data-close>Close</button><button class="primary-btn" data-page="legacy">Go to my documents →</button></div>`);
}
$('#helpGuideBtn').addEventListener('click', quickGuideModal);
$('#privacyPrinciplesBtn').addEventListener('click', () => openModal(`<h2>Privacy principles</h2><p>Digital Legacy is built around consent, minimum necessary access, and clear review procedures.</p><h3>How your data is protected</h3><p>Your password is hashed with scrypt and never stored in plaintext. Session cookies are HttpOnly and SameSite. OTPs and security codes exist on the server only as salted hashes. Uploaded files are validated by content, renamed randomly, stored outside the web root, and served only through authorised requests.</p><h3>Access is never automatic</h3><p>Adding a nominee sends no access. Mobile verification proves ownership of the number; identity documents are approved by you, a human; codes are bound, expiring, revocable; and a nominee session can open only the exact documents the code allows.</p>`));
$('#forgotPasswordBtn').addEventListener('click', () => openModal(`<h2>Forgot your password?</h2><p>Your password is hashed on the server and cannot be recovered by anyone — including us. That is the point: no backdoor exists that could be misused.</p><div class="notice warning">If you cannot sign in, an administrator can remove your account and its data on request; a new account can then be created. Records that matter legally should also be kept with their official issuers.</div><div class="form-actions"><button class="outline-btn" data-close>Back to sign in</button></div>`));

/* ---------- prototype affordances (only when no backend is deployed) -------- */
function wirePrototypeMode() {
  if (!demoMode()) return;
  const panel = $('#welcomePanel');
  if (!panel || $('#protoNote')) return;
  const box = document.createElement('div');
  box.id = 'protoNote';
  box.className = 'notice info';
  box.style.marginTop = '16px';
  const sample = window.DigitalLegacyDemo.sampleNominee();
  box.innerHTML = `<strong>Prototype mode.</strong> Nothing is sent to a server: this build runs on sample data stored in your browser.<br>` +
    `<button type="button" class="text-action" id="protoFillBtn">Fill the sample account</button>` +
    ` · Sample nominee for the access portal: mobile <span class="mono">${esc(sample.mobile)}</span>, code <span class="mono">${esc(sample.code)}</span>`;
  panel.append(box);
  $('#protoFillBtn').addEventListener('click', () => {
    const c = window.DigitalLegacyDemo.credentials;
    showAuthPanel('login');
    $('#loginEmail').value = c.email;
    $('#loginPassword').value = c.password;
    toast('Sample details filled in — press “Continue securely”.');
  });
}

/* ---------- boot ---------- */
applyTheme(document.documentElement.getAttribute('data-theme') || readStoredTheme());
$('#authThemeBtn').addEventListener('click', toggleTheme);
$('#appThemeBtn').addEventListener('click', toggleTheme);
try { const remembered = localStorage.getItem('digitalLegacy:rememberEmail'); if (remembered) { $('#loginEmail').value = remembered; $('#rememberEmail').checked = true; } } catch (e) {}
(async function boot() {
  // Wait for the prototype detector so the first request goes to the right place.
  if (window.DigitalLegacyDemoReady) { try { await window.DigitalLegacyDemoReady; } catch (e) {} }
  wirePrototypeMode();
  await loadCapability();
  try {
    const r = await api('GET', '/api/auth/me');
    app.user = r.user;
    $('#authView').classList.add('hidden'); $('#appView').classList.remove('hidden');
    updateGlobalUI(); renderPage('dashboard');
  } catch (err) {
    app.user = null;
    showAuthPanel('welcome');
  }
})();
