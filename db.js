import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export class JsonCollection {
  constructor(name, defaultData = []) {
    this.name = name;
    this.filePath = path.join(DATA_DIR, `${name}.json`);
    if (!fs.existsSync(this.filePath)) {
      this._save(defaultData);
    }
  }

  _read() {
    try {
      const content = fs.readFileSync(this.filePath, "utf-8");
      return JSON.parse(content || "[]");
    } catch {
      return [];
    }
  }

  _save(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async find(filter = {}) {
    const items = this._read();
    if (Object.keys(filter).length === 0) return items;
    return items.filter((item) => {
      for (const [key, val] of Object.entries(filter)) {
        if (val && typeof val === "object" && val.$ne !== undefined) {
          if (item[key] === val.$ne) return false;
        } else if (item[key] !== val) {
          return false;
        }
      }
      return true;
    });
  }

  async findOne(filter = {}) {
    const items = await this.find(filter);
    return items[0] || null;
  }

  async insertOne(doc) {
    const items = this._read();
    const newDoc = {
      _id: uuidv4(),
      ...doc,
      createdAt: doc.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    items.push(newDoc);
    this._save(items);
    return { insertedId: newDoc._id, acknowledged: true };
  }

  async insertMany(docs) {
    const items = this._read();
    const inserted = docs.map((doc) => ({
      _id: uuidv4(),
      ...doc,
      createdAt: doc.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    items.push(...inserted);
    this._save(items);
    return { insertedCount: inserted.length };
  }

  async updateOne(filter, update) {
    const items = this._read();
    const index = items.findIndex((item) => {
      for (const [key, val] of Object.entries(filter)) {
        if (item[key] !== val) return false;
      }
      return true;
    });

    if (index === -1) return { matchedCount: 0, modifiedCount: 0 };

    if (update.$set) {
      items[index] = {
        ...items[index],
        ...update.$set,
        updatedAt: new Date().toISOString(),
      };
    }
    this._save(items);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async countDocuments(filter = {}) {
    const items = await this.find(filter);
    return items.length;
  }
}
