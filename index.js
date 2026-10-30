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
import { SupabaseCollection, supabase } from "./db.js";

const usersCollection = new SupabaseCollection("users");
const vocabularyCollection = new SupabaseCollection("vocabularies");
const grammarCollection = new SupabaseCollection("grammar_questions");
const auditLogsCollection = new SupabaseCollection("audit_logs");

async function authenticateSupabaseUser(req, res, next) {
  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res
      .status(401)
      .json({ success: false, message: "Authentication required." });
  }

  try {
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(match[1]);
    if (authError || !user) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid or expired session." });
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (profileError) {
      console.error("[Auth profile lookup failed]:", profileError.message);
      return res.status(503).json({
        success: false,
        message: "Unable to verify account permissions.",
      });
    }

    req.authUser = user;
    req.authRole = profile?.role || "general";
    return next();
  } catch (err) {
    console.error("[Request authentication failed]:", err);
    return res.status(503).json({
      success: false,
      message: "Unable to verify account permissions.",
    });
  }
}

function requireAdmin(req, res, next) {
  if (req.authRole !== "admin") {
    return res
      .status(403)
      .json({ success: false, message: "Administrator access required." });
  }
  return next();
}

function requireOwnAccessId(getAccessId) {
  return (req, res, next) => {
    const accessId = String(getAccessId(req) || "").trim();
    if (!(userId || accessId)) {
      return res
        .status(400)
        .json({ success: false, message: "Missing accessId." });
    }
    if (req.authRole !== "admin" && accessId !== req.authUser.id) {
      return res.status(403).json({
        success: false,
        message: "Cannot access another user's data.",
      });
    }
    return next();
  };
}

function requireSupabaseUserId(value) {
  const userId = String(value || "").trim();
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(userId)) {
    throw new Error("A valid Supabase user ID is required.");
  }
  return userId;
}

async function loadVocabularyProgress(userId) {
  const { data, error } = await supabase
    .from("spelling_progress")
    .select("topic, mastered_words, incorrect_words, last_index")
    .eq("user_id", userId);
  if (error) throw error;

  const masteredWords = new Set();
  const incorrectWords = new Set();
  const progressByTopic = {};
  for (const row of data || []) {
    const mastered = row.mastered_words || [];
    const incorrect = row.incorrect_words || [];
    mastered.forEach((word) => masteredWords.add(word));
    incorrect.forEach((word) => incorrectWords.add(word));
    progressByTopic[row.topic] = {
      mastered: mastered.length,
      incorrect: incorrect.length,
      lastIndex: row.last_index || 0,
    };
  }

  return {
    masteredWords: [...masteredWords],
    incorrectWords: [...incorrectWords],
    progressByTopic,
  };
}

app.use("/api/v1/admin", authenticateSupabaseUser, requireAdmin);

app.use("/api/v1/auth", (_req, res) => {
  res.status(410).json({
    success: false,
    message:
      "Legacy device-token authentication has been removed. Use Supabase Auth.",
  });
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
app.get(
  "/api/v1/vocabulary/stats",
  authenticateSupabaseUser,
  async (req, res) => {
    try {
      const reqUserId = req.authUser.id;
      const reqUserName = String(
        req.authUser.user_metadata?.full_name ||
          req.authUser.user_metadata?.name ||
          "",
      )
        .trim()
        .toLowerCase();
      const isAdmin = req.authRole === "admin";

      const allWords = await vocabularyCollection.find({});
      const stats = {};
      const uploadedTopicsMap = {};
      const activeTopicsMap = {};
      const listeningTopicsMap = {};
      let totalUploaded = 0;

      for (const item of allWords) {
        const topicName = item.topic || "Uploaded";

        const lowerTopic = topicName.toLowerCase();
        const lowerTab = (item.targetTab || "").toLowerCase();

        const uploaderStr = (item.uploadedBy || "").toLowerCase();

        // 1. Tagged in targetTab or uploadedBy
        const isTaggedActive =
          lowerTab === "active" ||
          uploaderStr.startsWith("active:") ||
          uploaderStr.includes("active") ||
          uploaderStr === "admin";
        const isTaggedListening =
          lowerTab === "listening" ||
          uploaderStr.startsWith("listening:") ||
          uploaderStr.includes("listening");
        const isTaggedUploaded =
          lowerTab === "uploaded" || uploaderStr.startsWith("uploaded:");

        // 2. Semantic title checks
        const isListeningTitle =
          lowerTopic.includes("studying university") ||
          lowerTopic.includes("subjects") ||
          lowerTopic.includes("listening") ||
          lowerTopic.includes("1200");

        const isAcademicTitle = lowerTopic.includes("academic word list");

        let assignedTab = "uploaded";
        if (
          isTaggedListening ||
          (!isTaggedActive && !isTaggedUploaded && isListeningTitle)
        ) {
          assignedTab = "listening";
        } else if (isTaggedActive || isAcademicTitle) {
          assignedTab = "active";
        } else {
          assignedTab = "uploaded";
        }

        // Parse uploader name
        let parsedUploaderName = "";
        let parsedUploaderId = "";
        const uploaderRaw = item.uploadedBy || "";
        if (uploaderRaw.includes(":")) {
          const segs = uploaderRaw.split(":");
          if (segs.length >= 3) {
            parsedUploaderId = segs[1];
            parsedUploaderName = segs.slice(2).join(":");
          } else if (segs.length === 2) {
            parsedUploaderName = segs[1];
          }
        }

        // Rule 1: Uploaded vocabulary only visible to uploader or admin
        if (assignedTab === "uploaded" && !isAdmin) {
          const matchesId = reqUserId && parsedUploaderId === reqUserId;
          if (!matchesId) {
            continue;
          }
        }

        stats[topicName] = (stats[topicName] || 0) + 1;

        if (assignedTab === "listening") {
          listeningTopicsMap[topicName] =
            (listeningTopicsMap[topicName] || 0) + 1;
        } else if (assignedTab === "active") {
          activeTopicsMap[topicName] = (activeTopicsMap[topicName] || 0) + 1;
        } else {
          totalUploaded += 1;
          if (!uploadedTopicsMap[topicName]) {
            uploadedTopicsMap[topicName] = {
              count: 0,
              uploaderName:
                parsedUploaderName ||
                (isAdmin ? "Admin" : reqUserName || "Candidate"),
            };
          }
          uploadedTopicsMap[topicName].count += 1;
          if (
            parsedUploaderName &&
            !uploadedTopicsMap[topicName].uploaderName
          ) {
            uploadedTopicsMap[topicName].uploaderName = parsedUploaderName;
          }
        }
      }

      // Default Academic Word List if empty in DB
      if (!activeTopicsMap["Academic Word List: Sublist A"]) {
        activeTopicsMap["Academic Word List: Sublist A"] =
          stats["Academic Word List: Sublist A"] || 300;
      }

      const uploadedTopics = Object.keys(uploadedTopicsMap).map(
        (topicName) => ({
          title: topicName,
          count: uploadedTopicsMap[topicName].count,
          uploaderName: uploadedTopicsMap[topicName].uploaderName,
        }),
      );

      const activeTopics = Object.keys(activeTopicsMap).map((topicName) => ({
        title: topicName,
        count: activeTopicsMap[topicName],
      }));

      const listeningTopics = Object.keys(listeningTopicsMap).map(
        (topicName) => ({
          title: topicName,
          count: listeningTopicsMap[topicName],
        }),
      );

      res.json({
        success: true,
        totalCount: Object.values(stats).reduce(
          (total, count) => total + count,
          0,
        ),
        uploadedCount: totalUploaded,
        byTopic: stats,
        activeTopics,
        listeningTopics,
        uploadedTopics,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// GET /api/v1/vocabulary
app.get("/api/v1/vocabulary", authenticateSupabaseUser, async (req, res) => {
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
    const visibleWords = words.filter((word) => {
      if (req.authRole === "admin") return true;
      const uploadedBy = String(word.uploadedBy || "").toLowerCase();
      const isPrivateUpload =
        word.targetTab === "uploaded" || uploadedBy.startsWith("uploaded:");
      return (
        !isPrivateUpload ||
        uploadedBy.startsWith(`uploaded:${req.authUser.id.toLowerCase()}:`)
      );
    });
    res.json({ success: true, count: visibleWords.length, data: visibleWords });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/v1/vocabulary/audit-logs - Monitoring upload history and reports
app.get(
  "/api/v1/vocabulary/audit-logs",
  authenticateSupabaseUser,
  requireAdmin,
  async (req, res) => {
    try {
      const logs = await auditLogsCollection.find({});
      // Return sorted newest first
      logs.sort(
        (a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0),
      );
      res.json({ success: true, count: logs.length, data: logs });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// DELETE /api/v1/vocabulary/topic - Delete an entire topic group card
app.delete(
  "/api/v1/vocabulary/topic",
  authenticateSupabaseUser,
  requireAdmin,
  async (req, res) => {
    try {
      const { topic, deletedBy = "admin" } = req.body;
      if (!topic) {
        return res
          .status(400)
          .json({ success: false, message: "Missing topic name." });
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
  },
);

// DELETE /api/v1/vocabulary/:id - Delete a single word entry
app.delete(
  "/api/v1/vocabulary/:id",
  authenticateSupabaseUser,
  requireAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const result = await vocabularyCollection.deleteOne({ id });
      res.json({ success: true, message: "Word deleted successfully", result });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// POST /api/v1/vocabulary (Upload to Study)
app.post("/api/v1/vocabulary", authenticateSupabaseUser, async (req, res) => {
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

    const requestedTab = ["active", "listening", "uploaded"].includes(targetTab)
      ? targetTab
      : "active";
    const resolvedTab = req.authRole === "admin" ? requestedTab : "uploaded";

    const synList = Array.isArray(synonyms)
      ? synonyms
      : typeof synonyms === "string"
        ? synonyms
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

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
      uploadedBy:
        req.authRole === "admin"
          ? uploadedBy || "admin"
          : `uploaded:${req.authUser.id}:${req.authUser.user_metadata?.full_name || "Candidate"}`,
    };
    const actorName = String(
      req.authUser.user_metadata?.full_name ||
        req.authUser.user_metadata?.name ||
        "Candidate",
    );

    const result = await vocabularyCollection.insertOne(newWord);

    // Audit log
    await auditLogsCollection.insertOne({
      userId: req.authUser.id,
      action: "VOCAB_SINGLE_UPLOAD",
      userName: req.authRole === "admin" ? uploadedBy || actorName : actorName,
      accessId: req.authUser.id,
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
app.post(
  "/api/v1/vocabulary/bulk",
  authenticateSupabaseUser,
  async (req, res) => {
    try {
      const {
        items,
        defaultTopic = "Academic Word List: Sublist A",
        targetTab = "active",
        uploadedBy = "bulk-upload",
      } = req.body;

      const isAdmin = req.authRole === "admin";

      // Backend Rule 1: Non-admin users are strictly limited to the "uploaded" tab
      if (!isAdmin && targetTab !== "uploaded") {
        return res.status(403).json({
          success: false,
          message:
            "General members are only authorized to upload into the Uploaded tab.",
        });
      }

      // Backend Rule 2: Non-admin daily quota check (200 words max per day)
      if (!isAdmin) {
        if (!Array.isArray(items) || items.length > 200) {
          return res.status(400).json({
            success: false,
            message:
              "General users cannot import more than 200 words in a single batch (200 words/day limit).",
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

      const resolvedTab = isAdmin
        ? targetTab === "listening"
          ? "listening"
          : targetTab === "uploaded"
            ? "uploaded"
            : "active"
        : "uploaded";
      const actorName = String(
        req.authUser.user_metadata?.full_name ||
          req.authUser.user_metadata?.name ||
          "Candidate",
      );
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
          targetTab: resolvedTab,
          uploadedBy: isAdmin
            ? row.uploadedBy || uploadedBy
            : `uploaded:${req.authUser.id}:${req.authUser.user_metadata?.full_name || "Candidate"}`,
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
        userId: req.authUser.id,
        action: "VOCAB_BULK_UPLOAD",
        userName: isAdmin ? uploadedBy : actorName,
        accessId: req.authUser.id,
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
  },
);

// ==========================================
// 2.5 USER VOCABULARY PROGRESS ENDPOINTS
// ==========================================

// GET /api/v1/vocabulary/progress - Get candidate's personal progress
app.get(
  "/api/v1/vocabulary/progress",
  authenticateSupabaseUser,
  requireOwnAccessId((req) => req.query.userId || req.query.accessId || req.headers["x-access-id"]),
  async (req, res) => {
    try {
      const userId = requireSupabaseUserId(
        req.query.userId || req.query.accessId || req.headers["x-access-id"],
      );
      const userProgress = await loadVocabularyProgress(userId);
      res.json({ success: true, data: userProgress });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// POST /api/v1/vocabulary/progress - Record an answer (correct or incorrect)
app.post(
  "/api/v1/vocabulary/progress",
  authenticateSupabaseUser,
  requireOwnAccessId((req) => req.body.userId || req.body.accessId),
  async (req, res) => {
    try {
      const {
        userId,
        accessId,
        word,
        isCorrect,
        topic = "Academic Word List: Sublist A",
        currentIndex = null,
      } = req.body;
      if (!(userId || accessId) || !word) {
        return res
          .status(400)
          .json({ success: false, message: "accessId and word are required" });
      }

      const cleanId = requireSupabaseUserId(userId || accessId);
      const cleanWord = String(word).trim();
      const { data: existing, error: selectError } = await supabase
        .from("spelling_progress")
        .select("mastered_words, incorrect_words")
        .eq("user_id", cleanId)
        .eq("topic", topic)
        .maybeSingle();
      if (selectError) throw selectError;

      let mastered = existing?.mastered_words || [];
      let incorrect = existing?.incorrect_words || [];

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

      const { error: upsertError } = await supabase
        .from("spelling_progress")
        .upsert({
          user_id: cleanId,
          topic,
          mastered_words: mastered,
          incorrect_words: incorrect,
          last_index: Number.isInteger(currentIndex) ? currentIndex : 0,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id,topic" });
      if (upsertError) throw upsertError;

      res.json({
        success: true,
        data: await loadVocabularyProgress(cleanId),
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// POST /api/v1/vocabulary/progress/reset - Reset progress for a group/topic
app.post(
  "/api/v1/vocabulary/progress/reset",
  authenticateSupabaseUser,
  requireOwnAccessId((req) => req.body.userId || req.body.accessId),
  async (req, res) => {
    try {
      const userId = requireSupabaseUserId(req.body.userId || req.body.accessId);
      let query = supabase.from("spelling_progress").delete().eq("user_id", userId);
      if (req.body.topic) query = query.eq("topic", req.body.topic);
      const { error } = await query;
      if (error) throw error;
      res.json({ success: true, message: "Progress reset successfully" });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// POST /api/v1/user/study-session - Record study session duration & grammar drill scores
app.post(
  "/api/v1/user/study-session",
  authenticateSupabaseUser,
  requireOwnAccessId((req) => req.body.userId || req.body.accessId),
  async (req, res) => {
    try {
      const {
        userId,
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

      const cleanId = requireSupabaseUserId(userId || accessId);
      const cleanDuration = Math.max(0, Number.parseInt(durationSeconds, 10) || 0);
      const timestamp = new Date().toISOString();
      const hasGrammarScore =
        grammarScore !== null &&
        grammarScore !== undefined &&
        totalQuestions !== null &&
        totalQuestions !== undefined &&
        Number.isFinite(Number(grammarScore)) &&
        Number.isFinite(Number(totalQuestions)) &&
        Number(totalQuestions) > 0;
      const { error: activityError } = await supabase
        .from("user_activity_logs")
        .insert({
          user_id: cleanId,
          action: "STUDY_SESSION",
          details: hasGrammarScore
            ? JSON.stringify({
                grammarScore: Number(grammarScore),
                totalQuestions: Number(totalQuestions),
              })
            : null,
          duration_seconds: cleanDuration,
          timestamp,
        });
      if (activityError) throw activityError;

      let highestScore = null;
      if (hasGrammarScore) {
        const { data: current, error: grammarSelectError } = await supabase
          .from("grammar_progress")
          .select("highest_score, total_questions")
          .eq("user_id", cleanId)
          .maybeSingle();
        if (grammarSelectError) throw grammarSelectError;

        const currentPercent = Number(grammarScore) / Number(totalQuestions);
        const previousPercent = current?.total_questions
          ? Number(current.highest_score || 0) / Number(current.total_questions)
          : -1;
        if (currentPercent > previousPercent) {
          const { error: grammarUpsertError } = await supabase
            .from("grammar_progress")
            .upsert({
              user_id: cleanId,
              highest_score: Number(grammarScore),
              total_questions: Number(totalQuestions),
              updated_at: timestamp,
            }, { onConflict: "user_id" });
          if (grammarUpsertError) throw grammarUpsertError;
          highestScore = {
            score: Number(grammarScore),
            total: Number(totalQuestions),
            percent: Math.round(currentPercent * 100),
            achievedAt: timestamp,
          };
        } else if (current) {
          highestScore = {
            score: current.highest_score,
            total: current.total_questions,
            percent: Math.round(previousPercent * 100),
          };
        }
      }

      res.json({
        success: true,
        data: {
          durationSeconds: cleanDuration,
          highestGrammarScore: highestScore,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// GET /api/v1/user/profile-metrics - Comprehensive study stats for candidate
app.get(
  "/api/v1/user/profile-metrics",
  authenticateSupabaseUser,
  requireOwnAccessId((req) => req.query.userId || req.query.accessId || req.headers["x-access-id"]),
  async (req, res) => {
    try {
      const userId = requireSupabaseUserId(
        req.query.userId || req.query.accessId || req.headers["x-access-id"],
      );
      const [
        { data: spellingRows, error: spellingError },
        { data: flashcardRows, error: flashcardError },
        { data: activityRows, error: activityError },
        { data: grammar, error: grammarError },
        totalVocab,
      ] = await Promise.all([
        supabase.from("spelling_progress").select("mastered_words, incorrect_words").eq("user_id", userId),
        supabase.from("flashcard_progress").select("known_words, unknown_words, forgot_words").eq("user_id", userId),
        supabase.from("user_activity_logs").select("duration_seconds").eq("user_id", userId).eq("action", "STUDY_SESSION"),
        supabase.from("grammar_progress").select("highest_score, total_questions").eq("user_id", userId).maybeSingle(),
        vocabularyCollection.countDocuments(),
      ]);
      const queryError = spellingError || flashcardError || activityError || grammarError;
      if (queryError) throw queryError;

      const mastered = new Set();
      const inProgress = new Set();
      for (const row of spellingRows || []) {
        (row.mastered_words || []).forEach((word) => mastered.add(word));
        (row.incorrect_words || []).forEach((word) => inProgress.add(word));
      }
      for (const row of flashcardRows || []) {
        (row.known_words || []).forEach((word) => mastered.add(word));
        (row.unknown_words || []).forEach((word) => inProgress.add(word));
        (row.forgot_words || []).forEach((word) => inProgress.add(word));
      }

      const totalSessions = (activityRows || []).length || (mastered.size > 0 ? 1 : 0);
      const recordedSeconds = (activityRows || []).reduce(
        (total, row) => total + Math.max(0, Number(row.duration_seconds) || 0),
        0,
      );
      const totalStudySeconds =
        recordedSeconds || mastered.size * 30 + inProgress.size * 20;
      const highestGrammarScore = grammar?.highest_score
        ? {
            score: grammar.highest_score,
            total: grammar.total_questions || 0,
            percent: grammar.total_questions
              ? Math.round((grammar.highest_score / grammar.total_questions) * 100)
              : 0,
          }
        : null;

      res.json({
        success: true,
        data: {
          totalVocabInCorpus: totalVocab,
          masteredCount: mastered.size,
          inProgressCount: inProgress.size,
          totalSessions,
          totalStudySeconds,
          highestGrammarScore,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

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
      // Map frontend topic IDs to module slugs in the grammar_questions table
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
      console.warn(
        "[EdgeTTS Handshake warning, switching to direct HTTP audio stream]:",
        edgeErr.message,
      );
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
        return res
          .status(502)
          .json({ success: false, message: "Audio stream unavailable" });
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
