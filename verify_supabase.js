import { SupabaseCollection } from "./db.js";

async function verify() {
  console.log("=== Verifying Supabase Backend Integration ===");
  const profilesCollection = new SupabaseCollection("profiles");
  const vocabCollection = new SupabaseCollection("vocabularies");
  const grammarCollection = new SupabaseCollection("grammar_questions");
  const spellingProgressCollection = new SupabaseCollection("spelling_progress");
  const flashcardProgressCollection = new SupabaseCollection("flashcard_progress");
  const auditLogsCollection = new SupabaseCollection("audit_logs");

  const [profilesCount, vocabCount, grammarCount, spellingCount, flashcardCount, logsCount] = await Promise.all([
    profilesCollection.countDocuments(),
    vocabCollection.countDocuments(),
    grammarCollection.countDocuments(),
    spellingProgressCollection.countDocuments(),
    flashcardProgressCollection.countDocuments(),
    auditLogsCollection.countDocuments(),
  ]);

  console.log(`Profiles in Supabase: ${profilesCount}`);
  console.log(`Vocab words in Supabase: ${vocabCount}`);
  console.log(`Grammar questions in Supabase: ${grammarCount}`);
  console.log(`Spelling progress records in Supabase: ${spellingCount}`);
  console.log(`Flashcard progress records in Supabase: ${flashcardCount}`);
  console.log(`Audit logs in Supabase: ${logsCount}`);

  // Test find grammar by module
  const parallelismQuestions = await grammarCollection.find({ module: "parallelism" });
  console.log(`Parallelism questions retrieved: ${parallelismQuestions.length}`);

  console.log("=== Verification Completed Successfully! ===");
}

verify().catch(console.error);
