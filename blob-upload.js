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
      await bb.uploadFile(abs, { blobHTTPHeaders: { blobContentType: contentType } });
    }
  }
}
