import mongoose from "mongoose";
import { config } from "../config";

let isConnected = false;

/**
 * Connect to MongoDB. When the primary URI is unreachable (e.g. a local mongod
 * that is not running) and MONGODB_URI_FALLBACK is set, one retry is made
 * against the fallback — so local dev still works without editing .env.
 */
export async function connectDatabase(): Promise<void> {
  if (isConnected) return;

  const candidates = [config.mongodbUri, config.mongodbUriFallback].filter(Boolean);

  let lastError: unknown;
  for (const [index, uri] of candidates.entries()) {
    const label = index === 0 ? "MONGODB_URI" : "MONGODB_URI_FALLBACK";
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
      isConnected = true;
      console.log(`🗄️  Connected to MongoDB (${label})`);
      return;
    } catch (error) {
      lastError = error;
      if (index < candidates.length - 1) {
        console.warn(`⚠️  MongoDB unreachable at ${label}; trying fallback…`);
      }
    }
  }

  console.error("Failed to connect to MongoDB:", lastError);
  throw lastError;
}

export async function disconnectDatabase(): Promise<void> {
  if (!isConnected) return;
  await mongoose.disconnect();
  isConnected = false;
}

export { mongoose };
