import crypto from "node:crypto";

function getKey() {
  const raw = process.env.TENANT_SECRET_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(raw)) throw new Error("TENANT_SECRET_ENCRYPTION_KEY 64 simvolluq hex açar olmalıdır");
  return Buffer.from(raw, "hex");
}

export function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return { iv: iv.toString("hex"), data: encrypted.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
}

export function decryptSecret(value) {
  if (!value?.iv || !value?.data || !value?.tag) throw new Error("Şifrələnmiş API açarı düzgün deyil");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(value.iv, "hex"));
  decipher.setAuthTag(Buffer.from(value.tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(value.data, "hex")), decipher.final()]).toString("utf8");
}
