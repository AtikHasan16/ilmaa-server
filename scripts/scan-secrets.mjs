import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

const listedFiles = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
);

if (listedFiles.error || listedFiles.status !== 0) {
  throw listedFiles.error || new Error("Could not list repository files for secret scanning.");
}

const detectors = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Supabase secret key", /\bsb_secret_[A-Za-z0-9_-]{20,}\b/],
  ["JWT credential", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  [
    "hard-coded credential assignment",
    /\b(?:api[_-]?key|secret|access[_-]?token|password)\b\s*[:=]\s*(['"`])(?!(?:your[_\s-]|replace[_\s-]|example|changeme|placeholder|process\.env|import\.meta\.env))[A-Za-z0-9+/_=-]{16,}\1/i,
  ],
];

const findings = [];
for (const file of listedFiles.stdout.split("\0").filter(Boolean)) {
  const fileName = basename(file);
  if (
    fileName === ".env" ||
    (fileName.startsWith(".env.") && fileName !== ".env.example") ||
    file.split(/[\\/]/).some((part) => part === "node_modules" || part === "dist")
  ) {
    continue;
  }

  let contents;
  try {
    const buffer = readFileSync(file);
    if (buffer.includes(0)) continue;
    contents = buffer.toString("utf8");
  } catch {
    continue;
  }

  const lines = contents.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [label, detector] of detectors) {
      if (detector.test(line)) findings.push(`${file}:${index + 1}: ${label}`);
    }
  });
}

if (findings.length) {
  console.error("Potential committed credentials detected:");
  findings.forEach((finding) => console.error(finding));
  process.exitCode = 1;
} else {
  console.log("No known credential patterns found in repository files.");
}
