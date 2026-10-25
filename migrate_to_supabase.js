import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");

const supabaseUrl = process.env.SUPABASE_URL || "https://evjvqrxrevycnjxsnjdt.supabase.co";
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseKey) {
  console.error("Missing SUPABASE_KEY in environment");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

function readJsonFile(filename) {
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8") || "[]");
  } catch (err) {
    console.warn(`Error reading ${filename}:`, err.message);
    return [];
  }
}

async function migrate() {
  console.log("=== Starting Data Migration to Supabase ===");

  // 1. Users
  const users = readJsonFile("users.json");
  console.log(`Found ${users.length} users in local file.`);
  if (users.length > 0) {
    const formattedUsers = users.map((u) => ({
      name: u.name,
      access_id: u.accessId,
      role: u.role || "general",
      status: u.status || "unclaimed",
      device_token: u.deviceToken || null,
      requested_device_token: u.requestedDeviceToken || null,
      created_at: u.createdAt || new Date().toISOString(),
      updated_at: u.updatedAt || new Date().toISOString(),
      last_active_at: u.lastActiveAt || new Date().toISOString(),
    }));

    const { error: userError } = await supabase.from("users").upsert(formattedUsers, { onConflict: "access_id" });
    if (userError) {
      console.error("Error migrating users:", userError.message);
    } else {
      console.log(`Successfully migrated ${formattedUsers.length} users.`);
    }
  }

  // 2. Vocabulary (in chunks of 100)
  const vocabularies = readJsonFile("vocabularies.json");
  console.log(`Found ${vocabularies.length} vocabulary words.`);
  if (vocabularies.length > 0) {
    const formattedVocab = vocabularies.map((v) => ({
      word: v.word,
      pos: v.pos,
      bangla_meaning: v.banglaMeaning,
      synonyms: v.synonyms || [],
      example_usage: v.exampleUsage || "",
      topic: v.topic || "Academic Word List: Sublist A",
      uploaded_by: v.uploadedBy || null,
    }));

    // Batch in chunks
    const CHUNK_SIZE = 100;
    for (let i = 0; i < formattedVocab.length; i += CHUNK_SIZE) {
      const chunk = formattedVocab.slice(i, i + CHUNK_SIZE);
      const { error: vocabError } = await supabase.from("vocabularies").insert(chunk);
      if (vocabError) {
        console.error(`Error migrating vocab chunk ${i}:`, vocabError.message);
      } else {
        console.log(`Migrated vocab words ${i + 1} to ${Math.min(i + CHUNK_SIZE, formattedVocab.length)}`);
      }
    }
  }

  // 3. Grammar Questions (in chunks of 100)
  const questions = readJsonFile("grammar_questions.json");
  console.log(`Found ${questions.length} grammar questions.`);
  if (questions.length > 0) {
    const formattedQuestions = questions.map((q) => ({
      module: q.module,
      topic_title: q.topicTitle || "",
      category: q.category || "",
      difficulty: q.difficulty || "Medium",
      question_text: q.questionText,
      options: q.options || [],
      correct_answer: q.correctAnswer,
      explanation: q.explanation,
      rule_tag: q.ruleTag || null,
    }));

    const CHUNK_SIZE = 100;
    for (let i = 0; i < formattedQuestions.length; i += CHUNK_SIZE) {
      const chunk = formattedQuestions.slice(i, i + CHUNK_SIZE);
      const { error: qError } = await supabase.from("grammar_questions").insert(chunk);
      if (qError) {
        console.error(`Error migrating questions chunk ${i}:`, qError.message);
      } else {
        console.log(`Migrated questions ${i + 1} to ${Math.min(i + CHUNK_SIZE, formattedQuestions.length)}`);
      }
    }
  }

  // 4. Vocabulary Progress
  const progress = readJsonFile("vocabulary_progress.json");
  console.log(`Found ${progress.length} progress records.`);
  if (progress.length > 0) {
    const formattedProgress = progress.map((p) => ({
      access_id: p.accessId,
      mastered_words: p.masteredWords || [],
      incorrect_words: p.incorrectWords || [],
      progress_by_topic: p.progressByTopic || {},
      total_study_seconds: p.totalStudySeconds || 0,
      total_sessions: p.totalSessions || 0,
      highest_grammar_score: p.highestGrammarScore || null,
      updated_at: p.updatedAt || new Date().toISOString(),
    }));

    const { error: pError } = await supabase.from("vocabulary_progress").upsert(formattedProgress, { onConflict: "access_id" });
    if (pError) {
      console.error("Error migrating progress:", pError.message);
    } else {
      console.log(`Successfully migrated ${formattedProgress.length} progress records.`);
    }
  }

  // 5. Audit Logs
  const logs = readJsonFile("audit_logs.json");
  console.log(`Found ${logs.length} audit logs.`);
  if (logs.length > 0) {
    const formattedLogs = logs.map((l) => ({
      action: l.action,
      user_name: l.userName || "System",
      access_id: l.accessId || "SYSTEM",
      details: l.details || "",
      timestamp: l.timestamp || new Date().toISOString(),
    }));

    const { error: logError } = await supabase.from("audit_logs").insert(formattedLogs);
    if (logError) {
      console.error("Error migrating audit logs:", logError.message);
    } else {
      console.log(`Successfully migrated ${formattedLogs.length} audit logs.`);
    }
  }

  console.log("=== Migration Complete! All tables populated in Supabase. ===");
}

migrate().catch(console.error);
