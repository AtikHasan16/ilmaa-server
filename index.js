import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { EdgeTTS } from "@andresaya/edge-tts";
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

// GET /api/v1/vocabulary/stats (Topic counts for dynamic dashboard and cards)
app.get("/api/v1/vocabulary/stats", async (req, res) => {
  try {
    const allWords = await vocabularyCollection.find({});
    const stats = {};
    const uploadedTopicsMap = {};
    let totalUploaded = 0;

    for (const item of allWords) {
      const topicName = item.topic || "Uploaded";
      stats[topicName] = (stats[topicName] || 0) + 1;

      // Words uploaded by users (not part of the fixed Academic Word List)
      if (item.uploadedBy && item.topic !== "Academic Word List: Sublist A") {
        totalUploaded += 1;
        uploadedTopicsMap[topicName] = (uploadedTopicsMap[topicName] || 0) + 1;
      }
    }

    const uploadedTopics = Object.keys(uploadedTopicsMap).map((topicName) => ({
      title: topicName,
      count: uploadedTopicsMap[topicName],
    }));

    res.json({
      success: true,
      totalCount: allWords.length,
      uploadedCount: totalUploaded,
      byTopic: stats,
      uploadedTopics,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/v1/vocabulary
app.get("/api/v1/vocabulary", async (req, res) => {
  try {
    const { topic, uploadedOnly } = req.query;
    const filter = {};
    if (topic && topic !== "all") {
      filter.topic = topic;
    }
    if (uploadedOnly === "true") {
      filter.uploadedBy = { $ne: null };
    }

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
    const {
      items,
      defaultTopic = "Uploaded",
      uploadedBy = "bulk-upload",
    } = req.body;

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
        skipped.push({
          rowNumber: idx + 1,
          reason: "Missing word or banglaMeaning",
        });
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
// 2.5 USER VOCABULARY PROGRESS ENDPOINTS
// ==========================================

// GET /api/v1/vocabulary/progress - Get candidate's personal progress
app.get("/api/v1/vocabulary/progress", async (req, res) => {
  try {
    const accessId = req.query.accessId || req.headers["x-access-id"];
    if (!accessId) {
      return res
        .status(400)
        .json({ success: false, message: "Missing accessId" });
    }

    const cleanId = String(accessId).trim();
    let userProgress = await progressCollection.findOne({ accessId: cleanId });

    if (!userProgress) {
      userProgress = {
        accessId: cleanId,
        masteredWords: [], // list of word strings correctly spelled
        incorrectWords: [], // list of word strings with spelling errors
        progressByTopic: {}, // { [topic]: { mastered: 0, incorrect: 0, lastIndex: 0 } }
        updatedAt: new Date().toISOString(),
      };
    }

    res.json({ success: true, data: userProgress });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/v1/vocabulary/progress - Record an answer (correct or incorrect)
app.post("/api/v1/vocabulary/progress", async (req, res) => {
  try {
    const {
      accessId,
      word,
      isCorrect,
      topic = "Academic Word List: Sublist A",
    } = req.body;
    if (!accessId || !word) {
      return res
        .status(400)
        .json({ success: false, message: "accessId and word are required" });
    }

    const cleanId = String(accessId).trim();
    const cleanWord = String(word).trim();

    let record = await progressCollection.findOne({ accessId: cleanId });
    if (!record) {
      record = {
        accessId: cleanId,
        masteredWords: [],
        incorrectWords: [],
        progressByTopic: {},
        updatedAt: new Date().toISOString(),
      };
      await progressCollection.insertOne(record);
    }

    let mastered = Array.isArray(record.masteredWords)
      ? [...record.masteredWords]
      : [];
    let incorrect = Array.isArray(record.incorrectWords)
      ? [...record.incorrectWords]
      : [];
    const topicStats = record.progressByTopic || {};
    const currTopic = topicStats[topic] || { mastered: 0, incorrect: 0 };

    if (isCorrect) {
      if (!mastered.includes(cleanWord)) {
        mastered.push(cleanWord);
      }
      // If previously incorrect, user has now mastered it
      incorrect = incorrect.filter((w) => w !== cleanWord);
    } else {
      if (!incorrect.includes(cleanWord)) {
        incorrect.push(cleanWord);
      }
      // Cannot be mastered if just answered incorrectly
      mastered = mastered.filter((w) => w !== cleanWord);
    }

    currTopic.mastered = mastered.length;
    currTopic.incorrect = incorrect.length;
    topicStats[topic] = currTopic;

    await progressCollection.updateOne(
      { accessId: cleanId },
      {
        $set: {
          masteredWords: mastered,
          incorrectWords: incorrect,
          progressByTopic: topicStats,
          updatedAt: new Date().toISOString(),
        },
      },
    );

    res.json({
      success: true,
      data: {
        masteredWords: mastered,
        incorrectWords: incorrect,
        progressByTopic: topicStats,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/v1/vocabulary/progress/reset - Reset progress for a group/topic
app.post("/api/v1/vocabulary/progress/reset", async (req, res) => {
  try {
    const { accessId, topic } = req.body;
    if (!accessId) {
      return res
        .status(400)
        .json({ success: false, message: "Missing accessId" });
    }

    const cleanId = String(accessId).trim();
    const record = await progressCollection.findOne({ accessId: cleanId });

    if (record) {
      const topicStats = record.progressByTopic || {};
      if (topic) {
        delete topicStats[topic];
      }

      await progressCollection.updateOne(
        { accessId: cleanId },
        {
          $set: {
            masteredWords: topic ? record.masteredWords : [],
            incorrectWords: topic ? record.incorrectWords : [],
            progressByTopic: topic ? topicStats : {},
            updatedAt: new Date().toISOString(),
          },
        },
      );
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/v1/user/study-session - Record study session duration & grammar drill scores
app.post("/api/v1/user/study-session", async (req, res) => {
  try {
    const {
      accessId,
      durationSeconds = 0,
      grammarScore = null,
      totalQuestions = null,
    } = req.body;
    if (!accessId) {
      return res
        .status(400)
        .json({ success: false, message: "Missing accessId" });
    }

    const cleanId = String(accessId).trim();
    let record = await progressCollection.findOne({ accessId: cleanId });

    if (!record) {
      record = {
        accessId: cleanId,
        masteredWords: [],
        incorrectWords: [],
        progressByTopic: {},
        totalStudySeconds: 0,
        totalSessions: 0,
        highestGrammarScore: null,
        updatedAt: new Date().toISOString(),
      };
      await progressCollection.insertOne(record);
    }

    const newSessions = (record.totalSessions || 0) + 1;
    const newSeconds =
      (record.totalStudySeconds || 0) +
      Math.max(0, parseInt(durationSeconds, 10) || 0);

    let highestScore = record.highestGrammarScore || null;
    if (
      grammarScore !== null &&
      totalQuestions !== null &&
      totalQuestions > 0
    ) {
      const currentPct = Math.round((grammarScore / totalQuestions) * 100);
      const prevPct = highestScore
        ? Math.round((highestScore.score / highestScore.total) * 100)
        : -1;
      if (currentPct > prevPct) {
        highestScore = {
          score: grammarScore,
          total: totalQuestions,
          percent: currentPct,
          achievedAt: new Date().toISOString(),
        };
      }
    }

    await progressCollection.updateOne(
      { accessId: cleanId },
      {
        $set: {
          totalSessions: newSessions,
          totalStudySeconds: newSeconds,
          highestGrammarScore: highestScore,
          updatedAt: new Date().toISOString(),
        },
      },
    );

    res.json({
      success: true,
      data: {
        totalSessions: newSessions,
        totalStudySeconds: newSeconds,
        highestGrammarScore: highestScore,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/v1/user/profile-metrics - Comprehensive study stats for candidate
app.get("/api/v1/user/profile-metrics", async (req, res) => {
  try {
    const accessId = req.query.accessId || req.headers["x-access-id"];
    if (!accessId) {
      return res
        .status(400)
        .json({ success: false, message: "Missing accessId" });
    }

    const cleanId = String(accessId).trim();
    const [progress, totalVocab] = await Promise.all([
      progressCollection.findOne({ accessId: cleanId }),
      vocabularyCollection.countDocuments(),
    ]);

    const masteredCount = progress?.masteredWords?.length || 0;
    const inProgressCount = progress?.incorrectWords?.length || 0;
    const totalSessions =
      progress?.totalSessions || (masteredCount > 0 ? 1 : 0);
    // Baseline duration estimate: if sessions exist, at least session count * 2 mins or recorded duration
    const totalStudySeconds =
      progress?.totalStudySeconds || masteredCount * 30 + inProgressCount * 20;
    const highestGrammarScore = progress?.highestGrammarScore || null;

    res.json({
      success: true,
      data: {
        totalVocabInCorpus: totalVocab,
        masteredCount,
        inProgressCount,
        totalSessions,
        totalStudySeconds,
        highestGrammarScore,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 3. GRAMMAR ENDPOINTS
// ==========================================

// GET /api/v1/grammar/stats (Module counts for dynamic topic cards)
app.get("/api/v1/grammar/stats", async (req, res) => {
  try {
    const allQuestions = await grammarCollection.find({});
    const stats = {};

    for (const q of allQuestions) {
      const mod = q.module || "general";
      stats[mod] = (stats[mod] || 0) + 1;
    }

    res.json({
      success: true,
      totalCount: allQuestions.length,
      byModule: stats,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/v1/grammar/questions", async (req, res) => {
  try {
    const { module: modParam } = req.query;
    let filter = {};

    if (modParam && modParam !== "all" && modParam !== "mixed") {
      // Map frontend topic IDs to module slugs in grammar_questions.json
      if (
        modParam === "modifiers-dangling" ||
        modParam === "run-on-comma-splices"
      ) {
        filter = {
          $or: [{ module: modParam }, { module: "modifiers-and-splices" }],
        };
      } else {
        filter = { module: modParam };
      }
    }

    let questions = await grammarCollection.find(filter);

    // If a specific module returned 0 (e.g. subject-verb-agreement), provide sample fallback from all questions
    if (questions.length === 0 && modParam) {
      questions = await grammarCollection.find({});
    }

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
      const isOnline =
        u.status === "approved" && Date.now() - lastSeen < 5 * 60 * 1000;

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
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
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

// Initialize EdgeTTS service and audio cache folder
const ttsService = new EdgeTTS();
const AUDIO_CACHE_DIR = path.resolve("./data/audio_cache");
if (!fs.existsSync(AUDIO_CACHE_DIR)) {
  fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
}

// GET /api/v1/tts - Microsoft Edge Neural Text-to-Speech (Christopher Neural)
app.get("/api/v1/tts", async (req, res) => {
  try {
    const rawText = (req.query.text || "").trim();
    const voice = req.query.voice || "en-US-ChristopherNeural";

    if (!rawText) {
      return res
        .status(400)
        .json({ success: false, message: "Text parameter is required" });
    }

    if (rawText.length > 500) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Text is too long (max 500 characters)",
        });
    }

    // Cache key based on voice and text
    const hash = crypto
      .createHash("md5")
      .update(`${voice}:${rawText.toLowerCase()}`)
      .digest("hex");
    const cachePath = path.join(AUDIO_CACHE_DIR, `${hash}.mp3`);

    // Check if audio file is already cached locally
    if (fs.existsSync(cachePath)) {
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return fs.createReadStream(cachePath).pipe(res);
    }

    // Generate speech using Microsoft Christopher Neural voice
    const result = await ttsService.generate(rawText, voice, {
      rate: "-5%", // Slightly articulated pace for pristine pronunciation clarity
    });

    if (!result || !result.audio) {
      return res
        .status(502)
        .json({ success: false, message: "Failed to generate speech audio" });
    }

    // Save generated audio to cache asynchronously
    fs.writeFile(cachePath, result.audio, (err) => {
      if (err) console.error("[TTS Cache Error]", err);
    });

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(result.audio);
  } catch (err) {
    console.error("[TTS Error]", err);
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
