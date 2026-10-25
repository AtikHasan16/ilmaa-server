import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || "https://evjvqrxrevycnjxsnjdt.supabase.co";
const supabaseKey = process.env.SUPABASE_KEY;

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

// Helper to convert snake_case (Postgres/Supabase) to camelCase (Frontend JavaScript)
function toCamel(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(toCamel);

  const newObj = {};
  for (const [key, val] of Object.entries(obj)) {
    // Map id to _id for compatibility
    if (key === "id") newObj["_id"] = val;

    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    newObj[camelKey] = val;
  }
  return newObj;
}

// Helper to convert camelCase to snake_case
function toSnake(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(toSnake);

  const newObj = {};
  for (const [key, val] of Object.entries(obj)) {
    if (key === "_id") {
      newObj["id"] = val;
      continue;
    }
    const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    newObj[snakeKey] = val;
  }
  return newObj;
}

/**
 * SupabaseCollection adapter that implements the exact same API as JsonCollection
 * (.find, .findOne, .insertOne, .insertMany, .updateOne, .deleteOne, .deleteMany, .countDocuments)
 */
export class SupabaseCollection {
  constructor(tableName) {
    this.table = tableName;
  }

  async find(filter = {}) {
    let query = supabase.from(this.table).select("*");

    for (const [key, val] of Object.entries(filter)) {
      if (key === "$or" && Array.isArray(val)) {
        // e.g. [{ module: 'modifiers-dangling' }, { module: 'modifiers-and-splices' }]
        const conditions = val
          .map((cond) => {
            const [k, v] = Object.entries(cond)[0];
            return `${k.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`)}.eq.${v}`;
          })
          .join(",");
        query = query.or(conditions);
        continue;
      }

      const snakeKey = key.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`);
      if (val && typeof val === "object" && val.$ne !== undefined) {
        if (val.$ne === null) {
          query = query.not(snakeKey, "is", null);
        } else {
          query = query.neq(snakeKey, val.$ne);
        }
      } else {
        query = query.eq(snakeKey, val);
      }
    }

    const { data, error } = await query;
    if (error) {
      console.error(`[Supabase error on ${this.table}.find]:`, error.message);
      return [];
    }
    return toCamel(data || []);
  }

  async findOne(filter = {}) {
    let query = supabase.from(this.table).select("*");

    for (const [key, val] of Object.entries(filter)) {
      const snakeKey = key.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`);
      if (val && typeof val === "object" && val.$ne !== undefined) {
        if (val.$ne === null) {
          query = query.not(snakeKey, "is", null);
        } else {
          query = query.neq(snakeKey, val.$ne);
        }
      } else {
        query = query.eq(snakeKey, val);
      }
    }

    const { data, error } = await query.limit(1);
    if (error) {
      console.error(`[Supabase error on ${this.table}.findOne]:`, error.message);
      return null;
    }
    return data && data.length > 0 ? toCamel(data[0]) : null;
  }

  async insertOne(doc) {
    const snakeDoc = toSnake(doc);
    const { data, error } = await supabase.from(this.table).insert(snakeDoc).select();
    if (error) {
      console.error(`[Supabase error on ${this.table}.insertOne]:`, error.message);
      throw error;
    }
    const inserted = data && data[0] ? toCamel(data[0]) : {};
    return { insertedId: inserted._id || inserted.id, acknowledged: true };
  }

  async insertMany(docs) {
    const snakeDocs = docs.map(toSnake);
    const { data, error } = await supabase.from(this.table).insert(snakeDocs).select();
    if (error) {
      console.error(`[Supabase error on ${this.table}.insertMany]:`, error.message);
      throw error;
    }
    return { insertedCount: (data || []).length };
  }

  async updateOne(filter, update) {
    const snakeUpdate = toSnake(update.$set || update);
    let query = supabase.from(this.table).update(snakeUpdate);

    for (const [key, val] of Object.entries(filter)) {
      const snakeKey = key.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`);
      query = query.eq(snakeKey, val);
    }

    const { data, error } = await query.select();
    if (error) {
      console.error(`[Supabase error on ${this.table}.updateOne]:`, error.message);
      throw error;
    }
    return { matchedCount: (data || []).length, modifiedCount: (data || []).length };
  }

  async deleteOne(filter) {
    let query = supabase.from(this.table).delete();
    for (const [key, val] of Object.entries(filter)) {
      const snakeKey = key.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`);
      query = query.eq(snakeKey, val);
    }
    const { data, error } = await query.select();
    if (error) {
      console.error(`[Supabase error on ${this.table}.deleteOne]:`, error.message);
      throw error;
    }
    return { deletedCount: (data || []).length };
  }

  async deleteMany(filter = {}) {
    let query = supabase.from(this.table).delete();
    if (Object.keys(filter).length > 0) {
      for (const [key, val] of Object.entries(filter)) {
        const snakeKey = key.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`);
        query = query.eq(snakeKey, val);
      }
    } else {
      // Delete all (neq dummy id)
      query = query.neq("id", "00000000-0000-0000-0000-000000000000");
    }

    const { data, error } = await query.select();
    if (error) {
      console.error(`[Supabase error on ${this.table}.deleteMany]:`, error.message);
      throw error;
    }
    return { deletedCount: (data || []).length };
  }

  async countDocuments(filter = {}) {
    let query = supabase.from(this.table).select("*", { count: "exact", head: true });
    for (const [key, val] of Object.entries(filter)) {
      const snakeKey = key.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`);
      query = query.eq(snakeKey, val);
    }
    const { count, error } = await query;
    if (error) {
      console.error(`[Supabase error on ${this.table}.countDocuments]:`, error.message);
      return 0;
    }
    return count || 0;
  }
}
