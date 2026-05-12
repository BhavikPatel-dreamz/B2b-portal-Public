import crypto from "node:crypto";

type StoreSmtpSource = {
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpSecure?: boolean | null;
  smtpUser?: string | null;
  smtpPassEncrypted?: string | null;
  smtpFromEmail?: string | null;
  smtpFromName?: string | null;
};

export type ResolvedSmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromEmail: string;
  fromName: string;
};

function getEncryptionKey() {
  const seed =
    process.env.SMTP_ENCRYPTION_KEY ||
    process.env.SHOPIFY_API_SECRET ||
    "b2b-portal-smtp-fallback";
  return crypto.createHash("sha256").update(seed).digest();
}

export function encryptSmtpSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSmtpSecret(value?: string | null) {
  if (!value) return "";

  const [ivHex, tagHex, encryptedHex] = value.split(":");
  if (!ivHex || !tagHex || !encryptedHex) return "";

  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      getEncryptionKey(),
      Buffer.from(ivHex, "hex"),
    );
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedHex, "hex")),
      decipher.final(),
    ]);

    return decrypted.toString("utf8");
  } catch (err) {
    console.error(
      "❌ Failed to decrypt SMTP secret. This likely means the encryption key (SHOPIFY_API_SECRET or SMTP_ENCRYPTION_KEY) has changed since the secret was saved.",
      err,
    );
    return "";
  }
}

export function resolveStoreSmtpConfig(
  store?: StoreSmtpSource | null,
): ResolvedSmtpConfig | null {
  const host = store?.smtpHost?.trim() || process.env.SMTP_HOST  ||"";
  const port = Number(
    store?.smtpPort ||
      process.env.SMTP_PORT ||
      process.env.SMTP_PORT ||
      587,
  );
  const secure =
    store?.smtpSecure ??
    (process.env.SMTP_SECURE === "true");
  const user = store?.smtpUser?.trim() || process.env.SMTP_USER || "";
  const pass =
    decryptSmtpSecret(store?.smtpPassEncrypted) ||
    process.env.SMTP_PASSWORD ||
    "";
  const fromEmail =
    store?.smtpFromEmail?.trim() ||
    process.env.SMTP_FROM_EMAIL ||
    "";
  const fromName =
    store?.smtpFromName?.trim() || process.env.SMTP_FROM_NAME || "SmartB2B";

  if (!host || !port || !user || !pass || !fromEmail) {
    return null;
  }

  return {
    host,
    port,
    secure: Boolean(secure),
    user,
    pass,
    fromEmail,
    fromName,
  };
}
