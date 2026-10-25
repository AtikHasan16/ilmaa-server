import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || "https://evjvqrxrevycnjxsnjdt.supabase.co";
const supabaseKey = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV2anZxcnhyZXZ5Y25qeHNuamR0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI5MTUyOTgsImV4cCI6MjEwODQ5MTI5OH0.IzYM0QlDqTEhWEL5BYJMChh6FcBKDtfdfMiBrxtv6o4";

const supabase = createClient(supabaseUrl, supabaseKey);

async function testConnection() {
  console.log("Testing Supabase connection...");
  const { data, error } = await supabase.from("users").select("count", { count: "exact", head: true });
  if (error) {
    console.error("Connection failed / table check error:", error.message);
  } else {
    console.log("Success! Supabase connection established. Table reachable.");
  }
}

testConnection();
