import { SupabaseCollection } from "./db.js";

async function verify() {
  console.log("=== Verifying Supabase Backend Integration ===");
  const usersCollection = new SupabaseCollection("users");
  const vocabCollection = new SupabaseCollection("vocabularies");
  const grammarCollection = new SupabaseCollection("grammar_questions");
  const progressCollection = new SupabaseCollection("vocabulary_progress");
  const auditLogsCollection = new SupabaseCollection("audit_logs");

  const [usersCount, vocabCount, grammarCount, progressCount, logsCount] = await Promise.all([
    usersCollection.countDocuments(),
    vocabCollection.countDocuments(),
    grammarCollection.countDocuments(),
    progressCollection.countDocuments(),
    auditLogsCollection.countDocuments(),
  ]);

  console.log(`Users in Supabase: ${usersCount}`);
  console.log(`Vocab words in Supabase: ${vocabCount}`);
  console.log(`Grammar questions in Supabase: ${grammarCount}`);
  console.log(`Progress records in Supabase: ${progressCount}`);
  console.log(`Audit logs in Supabase: ${logsCount}`);

  // Test findOne user
  const adminUser = await usersCollection.findOne({ accessId: "1234567890" });
  console.log("Admin User found via Supabase:", adminUser ? `${adminUser.name} (${adminUser.role})` : "Not found");

  // Test find grammar by module
  const parallelismQuestions = await grammarCollection.find({ module: "parallelism" });
  console.log(`Parallelism questions retrieved: ${parallelismQuestions.length}`);

  console.log("=== Verification Completed Successfully! ===");
}

verify().catch(console.error);
