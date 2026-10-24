import { MongoClient, ServerApiVersion } from "mongodb";
import "dotenv/config";

const user = process.env.MONGODB_USER || process.env.MONGO_USER;
const password = process.env.MONGODB_PASSWORD || process.env.MONGO_PASSWORD;

const uri = `mongodb+srv://${user}:${password}@cluster0.o9zecpf.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

export default client;
