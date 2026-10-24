import "dotenv/config";
import express from "express";
import cors from "cors";
import { ObjectId } from "mongodb";
import client from "./mongoclient.js";

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json());

// Root health check
app.get("/", (req, res) => {
  res.send("Imlaa Backend API is running!");
});

async function run() {
  try {
    await client.connect();
    const db = client.db("imlaa");

    // Collections per project plan
    const usersCollection = db.collection("users");
    const vocabularyCollection = db.collection("vocabularies");
    const grammarCollection = db.collection("grammar_questions");
    const progressCollection = db.collection("vocabulary_progress");

    // Unique index on 10-digit accessId
    await usersCollection.createIndex({ accessId: 1 }, { unique: true });

    // Confirm ping
    await client.db("admin").command({ ping: 1 });
    console.log("Connected successfully to MongoDB Atlas!");

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

        const user = await usersCollection.findOne({ accessId: String(accessId).trim() });
        if (!user) {
          return res.status(404).json({
            success: false,
            message: "Invalid Access ID or Name. Please verify your credentials.",
          });
        }

        // Check if name matches (case-insensitive)
        if (user.name.trim().toLowerCase() !== name.trim().toLowerCase()) {
          return res.status(401).json({
            success: false,
            message: "Name does not match the provided Access ID.",
          });
        }

        // If approved and device token matches -> success
        if (user.status === "approved" && user.deviceToken === deviceToken) {
          return res.json({
            success: true,
            status: "approved",
            role: user.role,
            user: { name: user.name, accessId: user.accessId, role: user.role },
          });
        }

        // If approved but different device token -> reject device conflict
        if (user.status === "approved" && user.deviceToken !== deviceToken) {
          return res.status(403).json({
            success: false,
            status: "device_mismatch",
            message: "This ID is bound to another browser/device. Please contact an admin for reset.",
          });
        }

        // If rejected
        if (user.status === "rejected") {
          return res.status(403).json({
            success: false,
            status: "rejected",
            message: "Your access request was rejected. Please contact an administrator.",
          });
        }

        // If unclaimed or already pending -> transition to pending_approval
        await usersCollection.updateOne(
          { _id: user._id },
          {
            $set: {
              status: "pending_approval",
              requestedDeviceToken: deviceToken,
              updatedAt: new Date(),
            },
          }
        );

        return res.json({
          success: true,
          status: "pending_approval",
          message: "Login request received. Awaiting administrator approval.",
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
          return res.status(400).json({ success: false, message: "Missing credentials" });
        }

        const user = await usersCollection.findOne({
          accessId: String(accessId).trim(),
          deviceToken,
          status: "approved",
        });

        if (!user) {
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

    // ==========================================
    // 2. VOCABULARY ENDPOINTS
    // ==========================================

    // GET /api/v1/vocabulary
    // Fetch words (filter by topic, or uploaded words)
    app.get("/api/v1/vocabulary", async (req, res) => {
      try {
        const { topic, uploadedOnly } = req.query;
        const query = {};

        if (topic) {
          query.topic = topic;
        }
        if (uploadedOnly === "true") {
          query.uploadedBy = { $ne: null };
        }

        const words = await vocabularyCollection.find(query).toArray();
        res.json({ success: true, count: words.length, data: words });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    // POST /api/v1/vocabulary
    // Add custom word (Upload to Study) - Advance / Admin
    app.post("/api/v1/vocabulary", async (req, res) => {
      try {
        const { word, pos, banglaMeaning, synonyms, exampleUsage, topic, uploadedBy } = req.body;

        if (!word || !pos || !banglaMeaning) {
          return res.status(400).json({
            success: false,
            message: "Target Word, Part of Speech, and Bangla Meaning are required.",
          });
        }

        // Normalize synonyms array
        const synList = Array.isArray(synonyms)
          ? synonyms
          : typeof synonyms === "string"
          ? synonyms.split(",").map((s) => s.trim()).filter(Boolean)
          : [];

        const newWord = {
          word: word.trim(),
          pos: pos.trim(),
          banglaMeaning: banglaMeaning.trim(),
          synonyms: synList,
          exampleUsage: (exampleUsage || "").trim(),
          topic: topic || "Uploaded",
          uploadedBy: uploadedBy || null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await vocabularyCollection.insertOne(newWord);
        res.status(201).json({
          success: true,
          message: "Vocabulary added successfully",
          insertedId: result.insertedId,
          data: { ...newWord, _id: result.insertedId },
        });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    // ==========================================
    // 3. ADMIN ENDPOINTS
    // ==========================================

    // POST /api/v1/admin/access-ids
    // Generate a unique 10-digit ID for a candidate
    app.post("/api/v1/admin/access-ids", async (req, res) => {
      try {
        const { name, role = "general" } = req.body;
        if (!name || !name.trim()) {
          return res.status(400).json({ success: false, message: "Candidate name is required" });
        }

        // Generate unique 10-digit numeric ID
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
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await usersCollection.insertOne(newUser);
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
    // Live queue of pending requests
    app.get("/api/v1/admin/access-requests", async (req, res) => {
      try {
        const requests = await usersCollection
          .find({ status: "pending_approval" })
          .sort({ updatedAt: -1 })
          .toArray();

        res.json({ success: true, count: requests.length, data: requests });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    // PATCH /api/v1/admin/access-requests/:accessId/approve
    // Approve candidate and bind deviceToken
    app.patch("/api/v1/admin/access-requests/:accessId/approve", async (req, res) => {
      try {
        const { accessId } = req.params;
        const { role } = req.body;

        const user = await usersCollection.findOne({ accessId });
        if (!user) {
          return res.status(404).json({ success: false, message: "User not found" });
        }

        const updateFields = {
          status: "approved",
          deviceToken: user.requestedDeviceToken,
          updatedAt: new Date(),
        };

        if (role && ["general", "advance", "admin"].includes(role)) {
          updateFields.role = role;
        }

        await usersCollection.updateOne({ accessId }, { $set: updateFields });
        res.json({ success: true, message: `Access approved for ${user.name}` });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    // PATCH /api/v1/admin/access-requests/:accessId/reject
    app.patch("/api/v1/admin/access-requests/:accessId/reject", async (req, res) => {
      try {
        const { accessId } = req.params;
        await usersCollection.updateOne(
          { accessId },
          { $set: { status: "rejected", updatedAt: new Date() } }
        );
        res.json({ success: true, message: "Request rejected" });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    // POST /api/v1/admin/seed-demo
    // Seed initial demo vocabulary words if empty
    app.post("/api/v1/admin/seed-demo", async (req, res) => {
      try {
        const count = await vocabularyCollection.countDocuments();
        if (count > 0) {
          return res.json({ success: true, message: "Vocabulary already populated", count });
        }

        const demoWords = [
          {
            word: "Fastidious",
            pos: "Adjective",
            banglaMeaning: "খুঁতখুঁতে / সহজে সন্তুষ্ট হয় না এমন",
            synonyms: ["Meticulous", "Punctilious", "Scrupulous"],
            exampleUsage: "He was fastidious about his appearance, always immaculate in pressed linen.",
            topic: "Part 1: Basics",
            uploadedBy: null,
            createdAt: new Date(),
          },
          {
            word: "Ubiquitous",
            pos: "Adjective",
            banglaMeaning: "সর্বব্যাপী / যা সর্বত্র বিদ্যমান",
            synonyms: ["Omnipresent", "Pervasive", "Universal"],
            exampleUsage: "Smartphones have become ubiquitous in modern academic life.",
            topic: "Part 1: Basics",
            uploadedBy: null,
            createdAt: new Date(),
          },
          {
            word: "Ephemeral",
            pos: "Adjective",
            banglaMeaning: "ক্ষণস্থায়ী",
            synonyms: ["Transient", "Fleeting", "Short-lived"],
            exampleUsage: "Fashions are ephemeral, but true style endures.",
            topic: "Part 1: Basics",
            uploadedBy: null,
            createdAt: new Date(),
          },
        ];

        await vocabularyCollection.insertMany(demoWords);
        res.json({ success: true, message: "Demo vocabulary seeded!", inserted: demoWords.length });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });
  } catch (err) {
    console.error("MongoDB Atlas connection error:", err.message);
  }

  app.listen(port, () => {
    console.log(`Imlaa Backend is running on port ${port}`);
  });
}

run();
