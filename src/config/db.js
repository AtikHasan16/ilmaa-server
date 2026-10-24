import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/imlaa';
const client = new MongoClient(uri);

let db = null;

export async function connectDB() {
  if (db) return db;
  try {
    await client.connect();
    db = client.db();
    console.log(`[Database] Connected directly to MongoDB: ${db.databaseName}`);
    
    // Create initial indexes without any schema constraints
    await db.collection('users').createIndex({ accessId: 1 }, { unique: true });
    await db.collection('vocabulary_progress').createIndex({ userAccessId: 1, vocabularyId: 1 }, { unique: true });
    
    return db;
  } catch (error) {
    console.error('[Database] MongoDB connection error:', error.message);
    throw error;
  }
}

export function getDB() {
  if (!db) {
    throw new Error('Database not initialized. Call connectDB() first.');
  }
  return db;
}

// Convenient collection accessors
export const collections = {
  users: () => getDB().collection('users'),
  vocabulary: () => getDB().collection('vocabulary'),
  grammarQuestions: () => getDB().collection('grammar_questions'),
  vocabularyProgress: () => getDB().collection('vocabulary_progress')
};
