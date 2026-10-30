import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import crypto from "crypto";
import { EdgeTTS } from "node-edge-tts";

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
app.use(express.json());

// Initialize Supabase Collections (Persistent cloud database over HTTPS port 443)
import { SupabaseCollection } from "./db.js";

const usersCollection = new SupabaseCollection("users");
const vocabularyCollection = new SupabaseCollection("vocabularies");
const grammarCollection = new SupabaseCollection("grammar_questions");
const progressCollection = new SupabaseCollection("vocabulary_progress");
const auditLogsCollection = new SupabaseCollection("audit_logs");

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
    status: "healthy (Supabase cloud store)",
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
    const activeTopicsMap = {};
    const listeningTopicsMap = {};
    let totalUploaded = 0;

    for (const item of allWords) {
      const topicName = item.topic || "Uploaded";
      stats[topicName] = (stats[topicName] || 0) + 1;

      const lowerTopic = topicName.toLowerCase();
      const lowerTab = (item.targetTab || "").toLowerCase();

      const uploaderStr = (item.uploadedBy || "").toLowerCase();

      // 1. Tagged in targetTab or uploadedBy
      const isTaggedActive = lowerTab === "active" || uploaderStr.startsWith("active:") || uploaderStr.includes("active") || uploaderStr === "admin";
      const isTaggedListening = lowerTab === "listening" || uploaderStr.startsWith("listening:") || uploaderStr.includes("listening");
      const isTaggedUploaded = lowerTab === "uploaded" || uploaderStr.startsWith("uploaded:");

      // 2. Semantic title checks
      const isListeningTitle =
        lowerTopic.includes("studying university") ||
        lowerTopic.includes("subjects") ||
        lowerTopic.includes("listening") ||
        lowerTopic.includes("1200");

      const isAcademicTitle = lowerTopic.includes("academic word list");

      let assignedTab = "uploaded";
      if (isTaggedListening || (!isTaggedActive && !isTaggedUploaded && isListeningTitle)) {
        assignedTab = "listening";
      } else if (isTaggedActive || isAcademicTitle) {
        assignedTab = "active";
      } else {
        assignedTab = "uploaded";
      }

      if (assignedTab === "listening") {
        listeningTopicsMap[topicName] = (listeningTopicsMap[topicName] || 0) + 1;
      } else if (assignedTab === "active") {
        activeTopicsMap[topicName] = (activeTopicsMap[topicName] || 0) + 1;
      } else {
        totalUploaded += 1;
        uploadedTopicsMap[topicName] = (uploadedTopicsMap[topicName] || 0) + 1;
      }
    }

    // Default Academic Word List if empty in DB
    if (!activeTopicsMap["Academic Word List: Sublist A"]) {
      activeTopicsMap["Academic Word List: Sublist A"] = stats["Academic Word List: Sublist A"] || 300;
    }

    const uploadedTopics = Object.keys(uploadedTopicsMap).map((topicName) => ({
      title: topicName,
      count: uploadedTopicsMap[topicName],
    }));

    const activeTopics = Object.keys(activeTopicsMap).map((topicName) => ({
      title: topicName,
      count: activeTopicsMap[topicName],
    }));

    const listeningTopics = Object.keys(listeningTopicsMap).map((topicName) => ({
      title: topicName,
      count: listeningTopicsMap[topicName],
    }));

    res.json({
      success: true,
      totalCount: allWords.length,
      uploadedCount: totalUploaded,
      byTopic: stats,
      activeTopics,
      listeningTopics,
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

// GET /api/v1/vocabulary/audit-logs - Monitoring upload history and reports
app.get("/api/v1/vocabulary/audit-logs", async (req, res) => {
  try {
    const logs = await auditLogsCollection.find({});
    // Return sorted newest first
    logs.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    res.json({ success: true, count: logs.length, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/v1/vocabulary/topic - Delete an entire topic group card
app.delete("/api/v1/vocabulary/topic", async (req, res) => {
  try {
    const { topic, deletedBy = "admin" } = req.body;
    if (!topic) {
      return res.status(400).json({ success: false, message: "Missing topic name." });
    }

    const result = await vocabularyCollection.deleteMany({ topic });

    // Record audit log
    await auditLogsCollection.insertOne({
      action: "VOCAB_TOPIC_DELETED",
      userName: deletedBy,
      accessId: "ADMIN",
      details: `Deleted topic "${topic}" (${result.deletedCount || 0} words removed)`,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: `Topic "${topic}" and all its ${result.deletedCount || 0} words deleted.`,
      deletedCount: result.deletedCount || 0,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/v1/vocabulary/:id - Delete a single word entry
app.delete("/api/v1/vocabulary/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await vocabularyCollection.deleteOne({ id });
    res.json({ success: true, message: "Word deleted successfully", result });
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
      targetTab = "active", // 'active' | 'uploaded'
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

    const resolvedTab = targetTab === "listening" ? "listening" : targetTab === "uploaded" ? "uploaded" : "active";
    const defaultFallbackTopic =
      resolvedTab === "listening"
        ? "Studying university/college"
        : resolvedTab === "active"
          ? "Academic Word List: Sublist A"
          : "Uploaded";

    const newWord = {
      word: word.trim(),
      pos: pos.trim(),
      banglaMeaning: banglaMeaning.trim(),
      synonyms: synList,
      exampleUsage: (exampleUsage || "").trim(),
      topic: topic || defaultFallbackTopic,
      targetTab: resolvedTab,
      uploadedBy: uploadedBy || "user-upload",
    };

    const result = await vocabularyCollection.insertOne(newWord);

    // Audit log
    await auditLogsCollection.insertOne({
      action: "VOCAB_SINGLE_UPLOAD",
      userName: uploadedBy || "user-upload",
      accessId: "SYSTEM",
      details: `Added word "${newWord.word}" to topic "${newWord.topic}" [${resolvedTab}]`,
      timestamp: new Date().toISOString(),
    });

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
      defaultTopic = "Academic Word List: Sublist A",
      targetTab = "active",
      uploadedBy = "bulk-upload",
      userId,
      userRole = "general",
    } = req.body;

    const isAdmin = userRole === "admin" || req.headers["x-user-role"] === "admin";

    // Backend Rule 1: Non-admin users are strictly limited to the "uploaded" tab
    if (!isAdmin && targetTab !== "uploaded") {
      return res.status(403).json({
        success: false,
        message: "General members are only authorized to upload into the Uploaded tab.",
      });
    }

    // Backend Rule 2: Non-admin daily quota check (200 words max per day)
    if (!isAdmin) {
      if (!Array.isArray(items) || items.length > 200) {
        return res.status(400).json({
          success: false,
          message: "General users cannot import more than 200 words in a single batch (200 words/day limit).",
        });
      }
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Payload must include an array of items.",
      });
    }

    const validatedDocs = [];
    const skipped = [];

    const resolvedTab = targetTab === "listening" ? "listening" : targetTab === "uploaded" ? "uploaded" : "active";
    const defaultFallbackTopic =
      resolvedTab === "listening"
        ? "Studying university/college"
        : resolvedTab === "active"
          ? "Academic Word List: Sublist A"
          : "Uploaded";

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
        topic: (row.topic || defaultTopic || defaultFallbackTopic).trim(),
        targetTab: row.targetTab || resolvedTab,
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
      details: `Bulk imported ${validatedDocs.length} words into "${defaultTopic || defaultFallbackTopic}" [${resolvedTab}] (skipped: ${skipped.length})`,
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
      currentIndex = null,
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
    const currTopic = topicStats[topic] || { mastered: 0, incorrect: 0, lastIndex: 0 };

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
    currTopic.lastWord = cleanWord;
    if (typeof currentIndex === "number") {
      currTopic.lastIndex = currentIndex;
    }
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

// Initialize audio cache folder (uses OS temp dir for serverless compatibility)
const AUDIO_CACHE_DIR = path.join(os.tmpdir(), "ilmaa_audio_cache");
try {
  if (!fs.existsSync(AUDIO_CACHE_DIR)) {
    fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
  }
} catch (e) {
  // Harmless in serverless
}

// GET /api/v1/tts - Microsoft Edge Neural Text-to-Speech (Christopher Neural via node-edge-tts)
app.get("/api/v1/tts", async (req, res) => {
  try {
    const rawText = (req.query.text || "").trim();
    const voice = req.query.voice || "en-US-ChristopherNeural";

    if (!rawText) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res
        .status(400)
        .json({ success: false, message: "Text parameter is required" });
    }

    if (rawText.length > 500) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(400).json({
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
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return fs.createReadStream(cachePath).pipe(res);
    }

    // Try generating speech using node-edge-tts directly into cachePath
    try {
      const tts = new EdgeTTS({
        voice,
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        rate: "-5%", // Slightly articulated pace for pristine pronunciation clarity
        timeout: 4000,
      });

      await tts.ttsPromise(rawText, cachePath);

      if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 100) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return fs.createReadStream(cachePath).pipe(res);
      }
    } catch (edgeErr) {
      console.warn("[EdgeTTS Handshake warning, switching to direct HTTP audio stream]:", edgeErr.message);
    }

    // High-availability HTTP Stream Failover (Google Speech API via HTTP - 100% reliable, zero WebSockets)
    const encodedQ = encodeURIComponent(rawText);
    const googleTtsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodedQ}&tl=en&client=tw-ob`;

    https
      .get(googleTtsUrl, (streamRes) => {
        if (streamRes.statusCode === 200) {
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
          res.setHeader("Content-Type", "audio/mpeg");
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

          // Save to cache in background
          const fileStream = fs.createWriteStream(cachePath);
          streamRes.pipe(fileStream);

          return streamRes.pipe(res);
        }

        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.status(502).json({ success: false, message: "Audio stream unavailable" });
      })
      .on("error", (err) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.status(502).json({ success: false, message: err.message });
      });
  } catch (err) {
    console.error("[TTS Error]", err);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).json({ success: false, message: err.message });
  }
});

// Start Server (Binds to Render's dynamic PORT or local 5000)
app.listen(port, () => {
  console.log(`[Imlaa Backend] Running smoothly on port ${port}`);
});

export default app;
