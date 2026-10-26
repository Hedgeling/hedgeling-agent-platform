import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function required(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

const file = path.resolve(required(argument("--file"), "--file"));
const version = required(
  argument("--version") || process.env.HEDGELING_TRIAL_PACKAGE_VERSION,
  "--version or HEDGELING_TRIAL_PACKAGE_VERSION",
);
const bucket = required(
  process.env.HEDGELING_TRIAL_PACKAGE_BUCKET,
  "HEDGELING_TRIAL_PACKAGE_BUCKET",
);
const key = required(
  argument("--key") || process.env.HEDGELING_TRIAL_PACKAGE_KEY,
  "--key or HEDGELING_TRIAL_PACKAGE_KEY",
);
const region = required(
  process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
  "AWS_REGION",
);
const filename = path.basename(file);
if (!filename.endsWith(".tgz")) {
  throw new Error("The trial package artifact must be an npm .tgz archive");
}

const body = await fs.readFile(file);
const sha256 = crypto.createHash("sha256").update(body).digest("hex");
const client = new S3Client({ region });
await client.send(new PutObjectCommand({
  Bucket: bucket,
  Key: key,
  Body: body,
  ContentType: "application/gzip",
  ContentDisposition: `attachment; filename="${filename}"`,
  CacheControl: "private,max-age=31536000,immutable",
  ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
  IfNoneMatch: "*",
  Metadata: {
    "hedgeling-package-version": version,
    "hedgeling-package-sha256": sha256,
  },
}));

console.log(JSON.stringify({
  uploaded: true,
  bucket,
  key,
  version,
  filename,
  sha256,
  requiredRuntimeEnvironment: {
    HEDGELING_TRIAL_PACKAGE_DOWNLOAD_ENABLED: "true",
    HEDGELING_TRIAL_PACKAGE_BUCKET: bucket,
    HEDGELING_TRIAL_PACKAGE_KEY: key,
    HEDGELING_TRIAL_PACKAGE_VERSION: version,
    HEDGELING_TRIAL_PACKAGE_FILENAME: filename,
    HEDGELING_TRIAL_PACKAGE_SHA256: sha256,
  },
}, null, 2));
