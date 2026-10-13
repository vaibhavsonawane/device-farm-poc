import { type Response } from 'express';
import { type Readable } from 'node:stream';

/** Stream a file to the client as an attachment with a safe filename. */
export function sendDownload(
  res: Response,
  file: { stream: Readable; fileName: string; contentType: string; size?: number },
  inline = false,
): void {
  const safe = file.fileName.replace(/[^\w.-]+/g, '_');
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safe}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  if (file.size !== undefined) res.setHeader('Content-Length', String(file.size));
  file.stream.on('error', () => res.destroy());
  file.stream.pipe(res);
}
