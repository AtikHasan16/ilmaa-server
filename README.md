# Imlaa Backend Server (`ilmaa-server`)

> High-performance, zero-external-dependency local REST API engine for the **Imlaa Linguistic Mastery Platform**.

---

## 🎯 Architecture & Overview
The Imlaa backend powers the authentication, device-locking validation, vocabulary repository, and administrator queue:
- **Zero Third-Party Database Lock-in**: Powered by `JsonCollection` in [db.js](file:///e:/ILMAAAA/server/db.js), persisting human-readable, schema-compatible JSON data directly into the `data/` directory.
- **Hardware & Device-Locking Pipeline**: Binds client browser UUID fingerprints to 10-digit Access IDs upon first login.
- **Role-Based Access Control (RBAC)**: Supports `general`, `advance`, and `admin` permissions with strict server-side validation.

---

## 📡 REST API Reference

### 1. Health & Status
* **`GET /api/v1/health`**
  * Returns engine status, total registered users, and active vocabulary count.

---

### 2. Authentication & Device Locking
* **`POST /api/v1/auth/login-request`**
  * **Payload**: `{ "name": "Admin User", "accessId": "1234567890", "deviceToken": "uuid" }`
  * **Behavior**:
    * Verifies that the candidate name matches the 10-digit Access ID.
    * First login binds the browser's `deviceToken`.
    * Subsequent logins from unauthorized devices trigger a `device_mismatch` 403 or route to `pending_approval`.
* **`POST /api/v1/auth/validate-device`**
  * Fast auto-login validation on client page mount using stored Access ID and device token.

---

### 3. Vocabulary Management
* **`GET /api/v1/vocabulary`**
  * Query parameters: `topic` (`Part 1: Basics`, `Part 2: Intermediate`, etc.) or `uploadedOnly=true`.
* **`POST /api/v1/vocabulary`**
  * Allows Advance and Admin users to upload custom study words.
  * **Payload**: `{ "word": "Fastidious", "pos": "Adjective", "banglaMeaning": "খুঁতখুঁতে", "synonyms": ["Meticulous"], "exampleUsage": "...", "topic": "Uploaded" }`

---

### 4. Grammar Engine
* **`GET /api/v1/grammar/questions`**
  * Query parameter: `module` (e.g., `subject-verb-agreement`, `appropriate-prepositions`, or omit for all).
  * Returns questions with multiple-choice options, answer keys, and pedagogical one-sentence explanations.

---

### 5. Administrator Portal
* **`POST /api/v1/admin/access-ids`**
  * Generates a collision-free 10-digit numeric ID for a new candidate with an assigned role (`general` | `advance` | `admin`).
* **`GET /api/v1/admin/access-requests`**
  * Returns the live queue of candidate access requests awaiting administrator clearance (`status: "pending_approval"`).
* **`PATCH /api/v1/admin/access-requests/:accessId/approve`**
  * Approves access request, binds requested device token, and optionally updates candidate role.
* **`PATCH /api/v1/admin/access-requests/:accessId/reject`**
  * Rejects candidate device request.

---

## 🛠️ Technology Stack
* **Runtime**: Node.js (ES Modules, `"type": "module"`)
* **Framework**: Express.js
* **Middleware**: `cors` (configured for client `http://localhost:5173`), `dotenv`
* **Data Storage**: Custom asynchronous `JsonCollection` with atomic updates and automatic UUID generation

---

## 🚀 Setup & Execution

```bash
# Install dependencies
npm install

# Run in development mode (auto-reload via Node watch/nodemon)
npm run dev

# Starts API on http://localhost:5000
```

---

## 🔑 Default Initial Credentials
* **Admin Name**: `Admin User`
* **Access ID**: `1234567890`
* **Role**: `admin`
