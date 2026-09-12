import { createReadStream } from "node:fs";
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { config } from "../config";

const s3Client = new S3Client({
  region: config.awsRegion,
  credentials: {
    accessKeyId: config.awsAccessKeyId,
    secretAccessKey: config.awsSecretAccessKey,
  },
});

/** Public delivery URL for a key — CloudFront if configured, else direct S3. */
export function cdnUrlFor(key: string): string {
  if (config.cdnUrl) return `${config.cdnUrl}/${key}`;
  return `https://${config.s3Bucket}.s3.${config.awsRegion}.amazonaws.com/${key}`;
}

export function isS3Configured(): boolean {
  return Boolean(config.s3Bucket && config.awsAccessKeyId && config.awsSecretAccessKey);
}

/** One object under a prefix, with the metadata a reconciler needs. */
export interface S3ObjectInfo {
  key: string;
  sizeBytes: number;
  /** Undefined only if S3 omitted it, which it does not in practice. */
  lastModified?: Date;
}

/** List objects under a prefix with their size and mtime, following pagination. */
export async function listObjects(prefix: string): Promise<S3ObjectInfo[]> {
  const objects: S3ObjectInfo[] = [];
  let token: string | undefined;
  do {
    const res = await s3Client.send(
      new ListObjectsV2Command({ Bucket: config.s3Bucket, Prefix: prefix, ContinuationToken: token })
    );
    for (const o of res.Contents ?? []) {
      if (o.Key) {
        objects.push({ key: o.Key, sizeBytes: o.Size ?? 0, lastModified: o.LastModified });
      }
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return objects;
}

/** List object keys under a prefix, following pagination. */
export async function listKeys(prefix: string): Promise<string[]> {
  return (await listObjects(prefix)).map((o) => o.key);
}

export async function keyExists(key: string): Promise<boolean> {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Upload a local file to an exact S3 key. Returns its public URL.
 *
 *  Streams the file rather than reading it into a Buffer: renders are 1080x1920
 *  MP4s and a long or high-bitrate source can be large, so buffering the whole
 *  artefact just to hand it to the SDK was a needless memory spike per
 *  concurrent render. */
export async function uploadFileAtKey(
  localPath: string,
  key: string,
  contentType: string
): Promise<string> {
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: config.s3Bucket,
      Key: key,
      Body: createReadStream(localPath),
      ContentType: contentType,
    },
  });
  await upload.done();
  // Confirm the object actually landed before we hand out a URL for it. Without
  // this, a silently-partial upload still reported success and the clip rendered
  // as a black player.
  if (!(await keyExists(key))) {
    throw new Error(`Upload reported success but S3 has no object at ${key}`);
  }
  console.log(`☁️  Uploaded to S3: ${key}`);
  return cdnUrlFor(key);
}

/** Download an object by its CDN or direct S3 URL, authenticated. */
export async function downloadFromUrl(url: string): Promise<Buffer> {
  const key = getS3KeyFromUrl(url);
  if (!key) throw new Error(`Could not resolve S3 key from URL: ${url}`);
  const res = await s3Client.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }));
  const bytes = await res.Body?.transformToByteArray();
  if (!bytes?.length) throw new Error(`Empty S3 object: ${key}`);
  return Buffer.from(bytes);
}

export async function deleteKey(key: string): Promise<void> {
  await s3Client.send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: key }));
}

/**
 * Delete a specific set of keys in batches.
 *
 * This is the surgical counterpart to `deletePrefix`: removing one clip means
 * removing one object, and computing a prefix for it would risk taking
 * neighbouring clips with it. Duplicates are collapsed, and per-key failures are
 * reported in the result rather than thrown, so a caller can still finish
 * tearing down the database row.
 */
export async function deleteKeys(keys: string[]): Promise<DeletePrefixResult> {
  const unique = [...new Set(keys.filter((k) => typeof k === "string" && k.trim().length > 0))];
  if (unique.length === 0) return { requested: 0, failed: 0 };

  let failed = 0;
  // S3 accepts at most 1000 keys per DeleteObjects request.
  for (let i = 0; i < unique.length; i += 1000) {
    const batch = unique.slice(i, i + 1000);
    try {
      const res = await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: config.s3Bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        })
      );
      const errors = res.Errors ?? [];
      failed += errors.length;
      for (const e of errors) {
        console.error(`⚠️  S3 delete failed for ${e.Key}: ${e.Message}`);
      }
    } catch (error: unknown) {
      // Never swallow: a failed delete leaves an object the account keeps paying
      // for, and the caller has no other way to learn about it.
      console.error(`⚠️  S3 batch delete failed (${batch.length} object(s)): ${String(error)}`);
      failed += batch.length;
    }
  }
  return { requested: unique.length, failed };
}

/** Outcome of a prefix teardown, so callers can report leaked objects. */
export interface DeletePrefixResult {
  requested: number;
  failed: number;
}

/**
 * Delete everything under a prefix (project teardown).
 *
 * Refuses a blank prefix outright. An empty prefix is not "nothing to do" — S3
 * lists EVERY object in the bucket for it, so a computed prefix that came back
 * empty would wipe the whole bucket, including objects belonging to anything
 * else sharing it. The previous version relied on every call site
 * truthiness-checking first, which is one refactor away from data loss.
 */
export async function deletePrefix(prefix: string): Promise<DeletePrefixResult> {
  if (typeof prefix !== "string" || prefix.trim().length < 3) {
    throw new Error(
      `Refusing to delete with an empty or too-short prefix: ${JSON.stringify(prefix)}`
    );
  }

  const keys = await listKeys(prefix);
  // Batched rather than one request per object: a project with 60 clips plus
  // every prior render was 60+ serial round-trips to tear down.
  return deleteKeys(keys);
}

/** Extract the S3 key from a direct S3 or CloudFront URL. */
export function getS3KeyFromUrl(url: string): string | null {
  const s3Parts = url.split(".amazonaws.com/");
  if (s3Parts.length >= 2) return s3Parts[1];
  if (config.cdnUrl && url.startsWith(config.cdnUrl)) {
    return url.slice(config.cdnUrl.length).replace(/^\/+/, "");
  }
  return null;
}
