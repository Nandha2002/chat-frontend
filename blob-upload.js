import { BlobServiceClient } from '@azure/storage-blob';
import path from 'node:path';
import fs from 'fs-extra';
import mime from 'mime-types';

function getBlobServiceClient() {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not set');
  return BlobServiceClient.fromConnectionString(conn);
}

export async function ensureContainer(containerName) {
  if (!containerName) throw new Error('Container name is required');
  const svc = getBlobServiceClient();
  const container = svc.getContainerClient(containerName);
  // Public read access for blobs (not container listing).
  await container.createIfNotExists({ access: 'blob' });
  return container;
}

/** Recursively upload a directory to container under prefix. Returns base URL. */
export async function uploadDirectory(containerClient, localDir, prefix) {
  if (!(await fs.pathExists(localDir))) {
    throw new Error(`uploadDirectory: localDir does not exist: ${localDir}`);
  }
  await walkAndUpload(containerClient, localDir, prefix);
  return `${containerClient.url}/${encodeURI(prefix)}/`;
}

async function walkAndUpload(containerClient, dir, prefix) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const blobPath = prefix ? `${prefix}/${e.name}` : e.name;

    if (e.isDirectory()) {
      await walkAndUpload(containerClient, abs, blobPath);
    } else {
      const contentType = mime.lookup(abs) || 'application/octet-stream';
      const bb = containerClient.getBlockBlobClient(blobPath);
      await bb.uploadFile(abs, {
        blobHTTPHeaders: {
          blobContentType: contentType,
          blobCacheControl: 'no-store, no-cache, must-revalidate, max-age=0'
        }
      });
    }
  }
}

export async function downloadPrefixToDirectory(containerClient, prefix, localDir) {
  if (!prefix || typeof prefix !== 'string') {
    throw new Error('downloadPrefixToDirectory: prefix is required');
  }

  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, '');
  const listPrefix = `${normalizedPrefix}/`;

  const tempDir = `${localDir}.sync-${Date.now()}`;
  await fs.remove(tempDir);
  await fs.ensureDir(tempDir);

  let foundAny = false;
  for await (const blob of containerClient.listBlobsFlat({ prefix: listPrefix })) {
    foundAny = true;
    const rel = blob.name.slice(listPrefix.length);
    if (!rel || rel.endsWith('/')) continue;

    const destPath = path.join(tempDir, rel);
    await fs.ensureDir(path.dirname(destPath));
    const client = containerClient.getBlobClient(blob.name);
    await client.downloadToFile(destPath);
  }

  if (!foundAny) {
    await fs.remove(tempDir);
    return { foundAny, localDir, prefix: normalizedPrefix };
  }

  await fs.remove(localDir);
  await fs.move(tempDir, localDir, { overwrite: true });

  return { foundAny, localDir, prefix: normalizedPrefix };
}
