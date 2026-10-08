/**
 * IMARTICUS DATATHON 2026 - Registration Controller & Google Form Forwarder
 * Handles sanitation, validation, deduplication, sequential ID generation,
 * rate limiting, and server-side submission to Google Form formResponse.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Load environment variables if dotenv is available
try {
  require('dotenv').config();
} catch (e) {
  // dotenv not installed yet or environment already loaded
}

// In-memory rate limiting map: IP -> Array of timestamps
const rateLimitMap = new Map();

// Path to persistent registrations file
const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'registrations.json');

// Ensure data directory and file exist
function ensureDataStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify([]), 'utf8');
    }
  } catch (err) {
    console.error('[Storage Error] Could not initialize data directory:', err.message);
  }
}

// Read all registered teams from local JSON store
function getStoredRegistrations() {
  ensureDataStore();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

// Save a new registration atomically
function saveRegistration(record) {
  ensureDataStore();
  try {
    const list = getStoredRegistrations();
    list.push(record);
    const tmpFile = `${DATA_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpFile, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmpFile, DATA_FILE);
    return true;
  } catch (err) {
    console.error('[Storage Error] Failed to persist registration:', err.message);
    return false;
  }
}

// Rate limiter helper (5 attempts per 10 minutes per IP)
function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const maxAttempts = 10;

  const timestamps = (rateLimitMap.get(ip) || []).filter(t => now - t < windowMs);
  if (timestamps.length >= maxAttempts) {
    return false;
  }
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return true;
}

// Sanitize string (trim, remove null bytes & control chars)
function cleanString(val, maxLen = 100) {
  if (typeof val !== 'string') return '';
  return val
    .trim()
    .replace(/[\x00-\x1F\x7F]/g, '')
    .slice(0, maxLen);
}

// Clean Indian Phone Number (extract 10-digit sequence)
function cleanPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) {
    return digits;
  }
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]\d{9}$/.test(digits.slice(2))) {
    return digits.slice(2);
  }
  return null;
}

// Send HTTP POST request with timeout and one automatic retry
function postToGoogleForm(urlStr, formParams, attempt = 1) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams(formParams).toString();
    const parsedUrl = new URL(urlStr);

    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ImarticusDatathonBackend/2026'
      },
      timeout: 10000 // 10s timeout
    };

    const req = client.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        // Google Forms responds with 200 or 302 on success
        if (res.statusCode >= 200 && res.statusCode < 400) {
          // Check for any Google validation error flag in body
          if (body.includes('freebirdFormviewerViewResponseError')) {
            return reject(new Error('Google Form rejected submission due to field validation error'));
          }
          return resolve({ statusCode: res.statusCode, body });
        }
        reject(new Error(`Google Form returned HTTP status ${res.statusCode}`));
      });
    });

    req.on('timeout', () => {
      req.destroy();
      if (attempt < 2) {
        setTimeout(() => {
          postToGoogleForm(urlStr, formParams, attempt + 1).then(resolve).catch(reject);
        }, 500);
      } else {
        reject(new Error('Google Form submission timed out'));
      }
    });

    req.on('error', (err) => {
      if (attempt < 2) {
        setTimeout(() => {
          postToGoogleForm(urlStr, formParams, attempt + 1).then(resolve).catch(reject);
        }, 500);
      } else {
        reject(err);
      }
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Main registration processor
 */
async function processRegistration(reqBody, clientIp) {
  // 1. Honeypot bot protection
  if (reqBody.botField || reqBody.website_hp || reqBody._hp) {
    return {
      status: 400,
      body: { success: false, message: 'Invalid submission detected.' }
    };
  }

  // 2. Rate limiting check
  if (!checkRateLimit(clientIp)) {
    return {
      status: 429,
      body: { success: false, message: 'Too many registration requests. Please wait a few minutes and try again.' }
    };
  }

  // 3. Input sanitation & trimming
  const teamName = cleanString(reqBody.teamName, 100);
  const course = cleanString(reqBody.course, 50);
  const year = cleanString(reqBody.year, 30);
  const leaderName = cleanString(reqBody.leaderName, 100);
  const leaderRegNo = cleanString(reqBody.leaderRegNo, 50);
  const leaderEmail = cleanString(reqBody.leaderEmail, 100).toLowerCase();
  const leaderPhone = cleanPhone(reqBody.leaderPhone);
  const teamSize = parseInt(reqBody.teamSize, 10);
  const members = Array.isArray(reqBody.members) ? reqBody.members : [];

  // 4. Strict Validation
  if (!teamName || teamName.length < 2) {
    return { status: 400, body: { success: false, message: 'Please enter a valid Team Name (at least 2 characters).' } };
  }

  const ALLOWED_COURSES = ['BCA', 'MCA', 'BBA', 'BCOM', 'MBA', 'BBA AVIATION'];
  if (!ALLOWED_COURSES.includes(course)) {
    return { status: 400, body: { success: false, message: 'Please select an approved Course from the list.' } };
  }

  const ALLOWED_YEARS = ['1st year', '2nd year', '3rd year'];
  if (!ALLOWED_YEARS.includes(year)) {
    return { status: 400, body: { success: false, message: 'Please select a valid academic Year (1st, 2nd, or 3rd year).' } };
  }

  if (!leaderName || leaderName.length < 2) {
    return { status: 400, body: { success: false, message: "Please enter the Team Leader's Name." } };
  }

  if (!leaderRegNo || leaderRegNo.length < 2) {
    return { status: 400, body: { success: false, message: "Please enter the Team Leader's Registration Number." } };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if (!leaderEmail || !emailRegex.test(leaderEmail)) {
    return { status: 400, body: { success: false, message: "Please provide a valid email address for the Team Leader." } };
  }

  if (!leaderPhone) {
    return { status: 400, body: { success: false, message: "Please enter a valid 10-digit Indian phone number for the Team Leader." } };
  }

  if (![2, 3, 4].includes(teamSize)) {
    return { status: 400, body: { success: false, message: "Team size must be 2, 3, or 4 members." } };
  }

  const expectedMembersCount = teamSize - 1;
  if (members.length !== expectedMembersCount) {
    return { status: 400, body: { success: false, message: `A team of ${teamSize} requires details for ${expectedMembersCount} other member(s).` } };
  }

  // Validate member details and check internal duplicates
  const cleanedMembers = [];
  const allRegNos = [leaderRegNo.toUpperCase()];

  for (let i = 0; i < members.length; i++) {
    const m = members[i] || {};
    const mName = cleanString(m.name, 100);
    const mRegNo = cleanString(m.regNo, 50);

    if (!mName || mName.length < 2) {
      return { status: 400, body: { success: false, message: `Please enter the name for Team Member ${i + 2}.` } };
    }
    if (!mRegNo || mRegNo.length < 2) {
      return { status: 400, body: { success: false, message: `Please enter the registration number for Team Member ${i + 2}.` } };
    }

    const upperReg = mRegNo.toUpperCase();
    if (allRegNos.includes(upperReg)) {
      return { status: 400, body: { success: false, message: `Duplicate registration number '${mRegNo}' found within your team. Each member must have a unique Registration Number.` } };
    }
    allRegNos.push(upperReg);
    cleanedMembers.push({ name: mName, regNo: mRegNo });
  }

  // 5. Deduplication check against stored records
  const existingRecords = getStoredRegistrations();
  for (const record of existingRecords) {
    if (record.leaderEmail.toLowerCase() === leaderEmail) {
      return { status: 409, body: { success: false, message: 'A team with this Team Leader email is already registered.' } };
    }
    if (record.leaderPhone === leaderPhone) {
      return { status: 409, body: { success: false, message: 'A team with this Team Leader phone number is already registered.' } };
    }
    const recordRegNos = [record.leaderRegNo, ...(record.members || []).map(m => m.regNo)].map(r => r.toUpperCase());
    for (const reg of allRegNos) {
      if (recordRegNos.includes(reg)) {
        return { status: 409, body: { success: false, message: `Registration number '${reg}' is already registered with another team.` } };
      }
    }
  }

  // 6. Generate sequential Registration ID (e.g. REG-2026-0001)
  const nextSeq = existingRecords.length + 1;
  const regId = `REG-2026-${String(nextSeq).padStart(4, '0')}`;

  // 7. Prepare Google Form Submission Payload
  const googleFormUrl = process.env.GOOGLE_FORM_ACTION_URL || 
    'https://docs.google.com/forms/d/e/1FAIpQLScuXoumlmaV712ZRpSC8tDow-XgNP2dFmgwrnKSe4Umb4Oj2A/formResponse';

  // Entry IDs (defaults verified from live FB_PUBLIC_LOAD_DATA_)
  const TEAM_NAME_ENTRY = process.env.GOOGLE_FORM_TEAM_NAME_ENTRY || 'entry.532720504';
  const COURSE_ENTRY = process.env.GOOGLE_FORM_COURSE_ENTRY || 'entry.1505841488';
  const YEAR_ENTRY = process.env.GOOGLE_FORM_YEAR_ENTRY || 'entry.471912979';
  const LEADER_NAME_ENTRY = process.env.GOOGLE_FORM_LEADER_NAME_ENTRY || 'entry.95054344';
  const LEADER_REGNO_ENTRY = process.env.GOOGLE_FORM_LEADER_REGNO_ENTRY || 'entry.1311668077';
  const LEADER_EMAIL_ENTRY = process.env.GOOGLE_FORM_LEADER_EMAIL_ENTRY || 'entry.1169441784';
  const LEADER_PHONE_ENTRY = process.env.GOOGLE_FORM_LEADER_PHONE_ENTRY || 'entry.1786431928';
  const TEAM_SIZE_ENTRY = process.env.GOOGLE_FORM_TEAM_SIZE_ENTRY || 'entry.212519596';

  const formPayload = {
    fvv: '1',
    fbzx: '7668885094145471954',
    [TEAM_NAME_ENTRY]: teamName,
    [COURSE_ENTRY]: course,
    [YEAR_ENTRY]: year,
    [LEADER_NAME_ENTRY]: leaderName,
    [LEADER_REGNO_ENTRY]: leaderRegNo,
    [LEADER_EMAIL_ENTRY]: leaderEmail,
    [LEADER_PHONE_ENTRY]: leaderPhone,
    [TEAM_SIZE_ENTRY]: String(teamSize)
  };

  // Populate branch-specific member entries & pageHistory
  if (teamSize === 2) {
    const t2Name = process.env.GOOGLE_FORM_T2_MEMBER2_NAME_ENTRY || 'entry.197190944';
    const t2Reg = process.env.GOOGLE_FORM_T2_MEMBER2_REGNO_ENTRY || 'entry.900469978';
    formPayload[t2Name] = cleanedMembers[0].name;
    formPayload[t2Reg] = cleanedMembers[0].regNo;
    formPayload.pageHistory = '0,1,4';
  } else if (teamSize === 3) {
    const t3M2Name = process.env.GOOGLE_FORM_T3_MEMBER2_NAME_ENTRY || 'entry.470766011';
    const t3M2Reg = process.env.GOOGLE_FORM_T3_MEMBER2_REGNO_ENTRY || 'entry.806985892';
    const t3M3Name = process.env.GOOGLE_FORM_T3_MEMBER3_NAME_ENTRY || 'entry.670603800';
    const t3M3Reg = process.env.GOOGLE_FORM_T3_MEMBER3_REGNO_ENTRY || 'entry.77314024';
    formPayload[t3M2Name] = cleanedMembers[0].name;
    formPayload[t3M2Reg] = cleanedMembers[0].regNo;
    formPayload[t3M3Name] = cleanedMembers[1].name;
    formPayload[t3M3Reg] = cleanedMembers[1].regNo;
    formPayload.pageHistory = '0,2,4';
  } else if (teamSize === 4) {
    const t4M2Name = process.env.GOOGLE_FORM_T4_MEMBER2_NAME_ENTRY || 'entry.233709409';
    const t4M2Reg = process.env.GOOGLE_FORM_T4_MEMBER2_REGNO_ENTRY || 'entry.1511120998';
    const t4M3Name = process.env.GOOGLE_FORM_T4_MEMBER3_NAME_ENTRY || 'entry.604928895';
    const t4M3Reg = process.env.GOOGLE_FORM_T4_MEMBER3_REGNO_ENTRY || 'entry.396290915';
    const t4M4Name = process.env.GOOGLE_FORM_T4_MEMBER4_NAME_ENTRY || 'entry.381545999';
    const t4M4Reg = process.env.GOOGLE_FORM_T4_MEMBER4_REGNO_ENTRY || 'entry.1181572906';
    formPayload[t4M2Name] = cleanedMembers[0].name;
    formPayload[t4M2Reg] = cleanedMembers[0].regNo;
    formPayload[t4M3Name] = cleanedMembers[1].name;
    formPayload[t4M3Reg] = cleanedMembers[1].regNo;
    formPayload[t4M4Name] = cleanedMembers[2].name;
    formPayload[t4M4Reg] = cleanedMembers[2].regNo;
    formPayload.pageHistory = '0,3,4';
  }

  // Confirmation Checkbox (Required in Google Form section 5)
  const confirmEntry = process.env.GOOGLE_FORM_CONFIRMATION_ENTRY || 'entry.2117435691';
  const confirmText = process.env.GOOGLE_FORM_CONFIRMATION_TEXT || 
    'I confirm that our team has 2–4 students and the information provided is accurate.';
  formPayload[confirmEntry] = confirmText;

  // 8. Forward to Google Form backend
  try {
    await postToGoogleForm(googleFormUrl, formPayload);
  } catch (err) {
    console.error(`[Google Form Gateway Error] ${new Date().toISOString()}: ${err.message}`);
    return {
      status: 502,
      body: {
        success: false,
        message: 'Registration service encountered an upstream connectivity error. Please try again shortly.'
      }
    };
  }

  // 9. Persist verified registration locally
  const newRecord = {
    registrationId: regId,
    timestamp: new Date().toISOString(),
    teamName,
    course,
    year,
    leaderName,
    leaderRegNo,
    leaderEmail,
    leaderPhone,
    teamSize,
    members: cleanedMembers
  };

  saveRegistration(newRecord);
  console.log(`[Success] Registered ${regId} for team "${teamName}" (${teamSize} members)`);

  return {
    status: 200,
    body: {
      success: true,
      message: 'Registration successful',
      registration_id: regId,
      team_name: teamName
    }
  };
}

module.exports = {
  processRegistration,
  getStoredRegistrations
};
