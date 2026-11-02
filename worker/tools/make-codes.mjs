// Makes Interrogation Pack codes and loads them into Cloudflare.
// Usage (from the worker folder):  node tools/make-codes.mjs 20
// Writes the new codes to codes/pack-codes.csv (kept out of git). Sell each code once.
import { randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";

const CREDITS = 100;
const count = parseInt(process.argv[2] || "10", 10);
const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I mix-ups
const part = () => Array.from({ length: 4 }, () => ABC[randomInt(ABC.length)]).join("");
const codes = Array.from({ length: count }, () => `VP9-${part()}-${part()}`);

mkdirSync("codes", { recursive: true });
writeFileSync("codes/upload.json", JSON.stringify(codes.map(c => ({ key: `code:${c}`, value: String(CREDITS) }))));
execFileSync(process.platform === "win32" ? "npx.cmd" : "npx",
  ["wrangler", "kv", "bulk", "put", "codes/upload.json", "--binding", "LIMITS", "--remote"],
  { stdio: "inherit", shell: process.platform === "win32" });

const csv = "codes/pack-codes.csv";
if (!existsSync(csv)) writeFileSync(csv, "code,credits,created,sold_to\n");
appendFileSync(csv, codes.map(c => `${c},${CREDITS},${new Date().toISOString().slice(0, 10)},`).join("\n") + "\n");
writeFileSync("codes/upload.json", "[]");
console.log(`\nAdded ${count} codes worth ${CREDITS} verdicts each. See ${csv}`);
