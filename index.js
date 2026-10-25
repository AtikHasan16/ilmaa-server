import express from "express";
import cors from "cors";
import { JsonCollection } from "./db.js";

const app = express();
const port = 5000;

// Middleware
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  }),
);
app.use(express.json());

// Initialize Local Collections
const usersCollection = new JsonCollection("users", [
  {
    name: "Admin",
    accessId: "1234567890",
    role: "admin",
    status: "approved",
    deviceToken: null,
    requestedDeviceToken: null,
    createdAt: new Date().toISOString(),
  },
]);

const vocabularyCollection = new JsonCollection("vocabularies", [
  {
    word: "Fastidious",
    pos: "Adjective",
    banglaMeaning: "খুঁতখুঁতে / সহজে সন্তুষ্ট হয় না এমন",
    synonyms: ["Meticulous", "Punctilious", "Scrupulous"],
    exampleUsage:
      "He was fastidious about his appearance, always immaculate in pressed linen.",
    topic: "Part 1: Basics",
    uploadedBy: null,
  },
  {
    word: "Ubiquitous",
    pos: "Adjective",
    banglaMeaning: "সর্বব্যাপী / যা সর্বত্র বিদ্যমান",
    synonyms: ["Omnipresent", "Pervasive", "Universal"],
    exampleUsage: "Smartphones have become ubiquitous in modern academic life.",
    topic: "Part 1: Basics",
    uploadedBy: null,
  },
  {
    word: "Ephemeral",
    pos: "Adjective",
    banglaMeaning: "ক্ষণস্থায়ী",
    synonyms: ["Transient", "Fleeting", "Short-lived"],
    exampleUsage: "Fashions are ephemeral, but true style endures.",
    topic: "Part 1: Basics",
    uploadedBy: null,
  },
]);

const grammarCollection = new JsonCollection("grammar_questions", [
  {
    module: "subject-verb-agreement",
    questionText:
      "Neither the teacher nor the students ____ present at yesterday's seminar.",
    options: ["was", "were", "is", "are"],
    correctAnswer: "were",
    explanation:
      "When subjects are connected by 'neither... nor', the verb agrees with the closer subject ('students').",
  },
  {
    module: "appropriate-prepositions",
    questionText:
      "She has always been deeply devoted ____ her scientific research.",
    options: ["to", "for", "with", "at"],
    correctAnswer: "to",
    explanation: "'Devoted' takes the preposition 'to'.",
  },
]);

const progressCollection = new JsonCollection("vocabulary_progress", []);
const auditLogsCollection = new JsonCollection("audit_logs", [
  {
    action: "SYSTEM_INIT",
    userName: "Admin User",
    accessId: "1234567890",
    details: "System initialized with baseline admin access",
    timestamp: new Date().toISOString(),
  },
]);

// Activity tracking middleware via x-device-token header
app.use(async (req, res, next) => {
  const token = req.headers["x-device-token"];
  if (token && typeof token === "string") {
    try {
      await usersCollection.updateOne(
        { deviceToken: token },
        { $set: { lastActiveAt: new Date().toISOString() } },
      );
    } catch {
      // Ignore background activity tracking failures
    }
  }
  next();
});

// Root health check
app.get("/", (req, res) => {
  res.send("Imlaa Local Backend API is running!");
});

app.get("/api/v1/health", async (req, res) => {
  const usersCount = await usersCollection.countDocuments();
  const vocabCount = await vocabularyCollection.countDocuments();
  res.json({
    success: true,
    status: "healthy (local JSON store)",
    usersCount,
    vocabCount,
  });
});

// ==========================================
// 1. AUTHENTICATION & ACCESS ENDPOINTS
// ==========================================

// POST /api/v1/auth/login-request
// Submit name, accessId (10-digit), deviceToken
app.post("/api/v1/auth/login-request", async (req, res) => {
  try {
    const { name, accessId, deviceToken } = req.body;
    if (!name || !accessId || !deviceToken) {
      return res.status(400).json({
        success: false,
        message: "Name, 10-digit Access ID, and device token are required.",
      });
    }

    const cleanId = String(accessId).trim();
    const user = await usersCollection.findOne({ accessId: cleanId });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Invalid Access ID or Name. Please check with administrator.",
      });
    }

    if (user.name.trim().toLowerCase() !== name.trim().toLowerCase()) {
      return res.status(401).json({
        success: false,
        message: "Name does not match the provided Access ID.",
      });
    }

    // If approved and device token matches -> logged in
    if (
      user.status === "approved" &&
      (user.deviceToken === deviceToken || !user.deviceToken)
    ) {
      // Bind device token if first login
      if (!user.deviceToken) {
        await usersCollection.updateOne(
          { accessId: cleanId },
          { $set: { deviceToken } },
        );
      }
      return res.json({
        success: true,
        status: "approved",
        role: user.role,
        user: { name: user.name, accessId: user.accessId, role: user.role },
      });
    }

    // If approved on a DIFFERENT device
    if (user.status === "approved" && user.deviceToken !== deviceToken) {
      return res.status(403).json({
        success: false,
        status: "device_mismatch",
        message:
          "This ID is bound to another browser/device. Please contact an admin for reset.",
      });
    }

    if (user.status === "rejected") {
      return res.status(403).json({
        success: false,
        status: "rejected",
        message: "Your access request was rejected by an administrator.",
      });
    }

    // Transition unclaimed or pending to pending_approval
    await usersCollection.updateOne(
      { accessId: cleanId },
      {
        $set: {
          status: "pending_approval",
          requestedDeviceToken: deviceToken,
        },
      },
    );

    res.json({
      success: true,
      status: "pending_approval",
      message: "Access request submitted. Awaiting administrator approval.",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/v1/auth/validate-device
// Fast auto-login check on page load using stored accessId + deviceToken
app.post("/api/v1/auth/validate-device", async (req, res) => {
  try {
    const { accessId, deviceToken } = req.body;
    if (!accessId || !deviceToken) {
      return res
        .status(400)
        .json({ success: false, message: "Missing credentials" });
    }

    const cleanId = String(accessId).trim();
    const user = await usersCollection.findOne({
      accessId: cleanId,
      status: "approved",
    });

    if (!user || user.deviceToken !== deviceToken) {
      return res.status(401).json({
        success: false,
        message: "Session invalid or device not approved.",
      });
    }

    res.json({
      success: true,
      status: "approved",
      role: user.role,
      user: { name: user.name, accessId: user.accessId, role: user.role },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/v1/auth/heartbeat
// Periodic background ping to maintain online presence
app.post("/api/v1/auth/heartbeat", async (req, res) => {
  try {
    const token = req.headers["x-device-token"];
    if (token) {
      await usersCollection.updateOne(
        { deviceToken: token },
        { $set: { lastActiveAt: new Date().toISOString() } },
      );
    }
    res.json({ success: true, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/v1/vocabulary
app.get("/api/v1/vocabulary", async (req, res) => {
  try {
    const { topic, uploadedOnly } = req.query;
    const filter = {};
    if (topic) filter.topic = topic;
    if (uploadedOnly === "true") filter.uploadedBy = { $ne: null };

    const words = await vocabularyCollection.find(filter);
    res.json({ success: true, count: words.length, data: words });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/v1/vocabulary (Upload to Study)
app.post("/api/v1/vocabulary", async (req, res) => {
  try {
    const {
      word,
      pos,
      banglaMeaning,
      synonyms,
      exampleUsage,
      topic,
      uploadedBy,
    } = req.body;

    if (!word || !pos || !banglaMeaning) {
      return res.status(400).json({
        success: false,
        message:
          "Target Word, Part of Speech, and Bangla Meaning are required.",
      });
    }

    const synList = Array.isArray(synonyms)
      ? synonyms
      : typeof synonyms === "string"
        ? synonyms
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

    const newWord = {
      word: word.trim(),
      pos: pos.trim(),
      banglaMeaning: banglaMeaning.trim(),
      synonyms: synList,
      exampleUsage: (exampleUsage || "").trim(),
      topic: topic || "Uploaded",
      uploadedBy: uploadedBy || "user-upload",
    };

    const result = await vocabularyCollection.insertOne(newWord);
    res.status(201).json({
      success: true,
      message: "Word uploaded successfully",
      data: { ...newWord, _id: result.insertedId },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/v1/vocabulary/bulk (Bulk Import TSV/CSV)
app.post("/api/v1/vocabulary/bulk", async (req, res) => {
  try {
    const { items, defaultTopic = "Uploaded", uploadedBy = "bulk-upload" } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Payload must include an array of items.",
      });
    }

    const validatedDocs = [];
    const skipped = [];

    for (const [idx, row] of items.entries()) {
      const word = (row.word || "").trim();
      const pos = (row.pos || "Adjective").trim();
      const banglaMeaning = (row.banglaMeaning || "").trim();

      if (!word || !banglaMeaning) {
        skipped.push({ rowNumber: idx + 1, reason: "Missing word or banglaMeaning" });
        continue;
      }

      const synList = Array.isArray(row.synonyms)
        ? row.synonyms
        : typeof row.synonyms === "string"
        ? row.synonyms
            .split(/[,|;]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

      validatedDocs.push({
        word,
        pos,
        banglaMeaning,
        synonyms: synList,
        exampleUsage: (row.exampleUsage || "").trim(),
        topic: (row.topic || defaultTopic || "Uploaded").trim(),
        uploadedBy: row.uploadedBy || uploadedBy,
      });
    }

    if (validatedDocs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid rows found to import.",
        skipped,
      });
    }

    const result = await vocabularyCollection.insertMany(validatedDocs);

    // Audit log
    await auditLogsCollection.insertOne({
      action: "VOCAB_BULK_UPLOAD",
      userName: uploadedBy,
      accessId: "SYSTEM",
      details: `Bulk imported ${validatedDocs.length} words (skipped: ${skipped.length})`,
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({
      success: true,
      message: `Successfully imported ${validatedDocs.length} vocabulary words.`,
      insertedCount: result.insertedCount,
      skippedCount: skipped.length,
      skipped,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 3. GRAMMAR ENDPOINTS
// ==========================================

app.get("/api/v1/grammar/questions", async (req, res) => {
  try {
    const { module } = req.query;
    const filter = module ? { module } : {};
    const questions = await grammarCollection.find(filter);
    res.json({ success: true, count: questions.length, data: questions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 4. ADMIN ENDPOINTS
// ==========================================

// POST /api/v1/admin/access-ids
// Generate unique 10-digit ID for a candidate
app.post("/api/v1/admin/access-ids", async (req, res) => {
  try {
    const { name, role = "general" } = req.body;
    if (!name || !name.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Candidate name is required" });
    }

    let accessId = "";
    let isUnique = false;
    while (!isUnique) {
      accessId = Math.floor(1000000000 + Math.random() * 9000000000).toString();
      const existing = await usersCollection.findOne({ accessId });
      if (!existing) isUnique = true;
    }

    const newUser = {
      name: name.trim(),
      accessId,
      role: ["general", "advance", "admin"].includes(role) ? role : "general",
      status: "unclaimed",
      deviceToken: null,
      requestedDeviceToken: null,
    };

    const result = await usersCollection.insertOne(newUser);

    await auditLogsCollection.insertOne({
      action: "ID_GENERATED",
      userName: newUser.name,
      accessId: newUser.accessId,
      details: `Generated new 10-digit ID with role: ${newUser.role}`,
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({
      success: true,
      message: "Access ID generated successfully",
      data: { ...newUser, _id: result.insertedId },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/v1/admin/access-requests
app.get("/api/v1/admin/access-requests", async (req, res) => {
  try {
    const requests = await usersCollection.find({ status: "pending_approval" });
    res.json({ success: true, count: requests.length, data: requests });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/v1/admin/access-requests/:accessId/approve
app.patch(
  "/api/v1/admin/access-requests/:accessId/approve",
  async (req, res) => {
    try {
      const { accessId } = req.params;
      const { role } = req.body;

      const user = await usersCollection.findOne({ accessId });
      if (!user) {
        return res
          .status(404)
          .json({ success: false, message: "User not found" });
      }

      const updateSet = {
        status: "approved",
        deviceToken: user.requestedDeviceToken || "token-" + Date.now(),
        lastActiveAt: new Date().toISOString(),
      };
      if (role && ["general", "advance", "admin"].includes(role)) {
        updateSet.role = role;
      }

      await usersCollection.updateOne({ accessId }, { $set: updateSet });

      // Record in audit log
      await auditLogsCollection.insertOne({
        action: "ACCESS_APPROVED",
        userName: user.name,
        accessId,
        details: `Approved device access with role: ${role || user.role}`,
        timestamp: new Date().toISOString(),
      });

      res.json({ success: true, message: `Access approved for ${user.name}` });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// PATCH /api/v1/admin/access-requests/:accessId/reject
app.patch(
  "/api/v1/admin/access-requests/:accessId/reject",
  async (req, res) => {
    try {
      const { accessId } = req.params;
      const user = await usersCollection.findOne({ accessId });

      await usersCollection.updateOne(
        { accessId },
        { $set: { status: "rejected" } },
      );

      if (user) {
        await auditLogsCollection.insertOne({
          action: "ACCESS_REJECTED",
          userName: user.name,
          accessId,
          details: "Access request rejected by admin",
          timestamp: new Date().toISOString(),
        });
      }

      res.json({ success: true, message: "Request rejected" });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// GET /api/v1/admin/users-audit
// Returns complete list of users, their device binding, online status (active in last 5 min)
app.get("/api/v1/admin/users-audit", async (req, res) => {
  try {
    const allUsers = await usersCollection.find({});
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

    const users = allUsers.map((u) => {
      const lastSeen = u.lastActiveAt ? new Date(u.lastActiveAt).getTime() : 0;
      const isOnline = u.status === "approved" && Date.now() - lastSeen < 5 * 60 * 1000;

      return {
        id: u._id || u.accessId,
        name: u.name,
        accessId: u.accessId,
        role: u.role,
        status: u.status,
        deviceBound: !!u.deviceToken,
        createdAt: u.createdAt,
        lastActiveAt: u.lastActiveAt || null,
        isOnline,
      };
    });

    const activeNowCount = users.filter((u) => u.isOnline).length;
    const approvedCount = users.filter((u) => u.status === "approved").length;

    res.json({
      success: true,
      totalRegistered: users.length,
      approvedCount,
      activeNowCount,
      users,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/v1/admin/audit-logs
app.get("/api/v1/admin/audit-logs", async (req, res) => {
  try {
    const logs = await auditLogsCollection.find({});
    // Return newest first
    const sorted = logs.slice().reverse();
    res.json({ success: true, count: sorted.length, data: sorted });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/v1/admin/audit-logs/:id
app.delete("/api/v1/admin/audit-logs/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await auditLogsCollection.deleteOne({ _id: id });
    res.json({ success: true, message: "Log entry deleted", result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/v1/admin/audit-logs (Clear all logs)
app.delete("/api/v1/admin/audit-logs", async (req, res) => {
  try {
    const result = await auditLogsCollection.deleteMany({});
    res.json({ success: true, message: "All audit logs cleared", result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/v1/admin/users/:accessId/reset-device
// Resets a user's bound device so they can log in from a new device/browser
app.patch("/api/v1/admin/users/:accessId/reset-device", async (req, res) => {
  try {
    const { accessId } = req.params;
    const user = await usersCollection.findOne({ accessId });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    await usersCollection.updateOne(
      { accessId },
      { $set: { deviceToken: null, requestedDeviceToken: null } },
    );

    await auditLogsCollection.insertOne({
      action: "DEVICE_RESET",
      userName: user.name,
      accessId,
      details: "Admin reset hardware device binding",
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: `Device binding cleared for ${user.name}. User can now re-bind from any device.`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Start Server
app.listen(port, () => {
  console.log(`[Imlaa Backend] Running smoothly on http://localhost:${port}`);
  console.log(
    `[Imlaa Backend] Local JSON database loaded. Zero network dependency.`,
  );
});
