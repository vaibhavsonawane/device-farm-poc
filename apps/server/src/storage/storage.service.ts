import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Global, Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { InjectEnv } from '../config/config.module';
import { type Env } from '../config/env';

/**
 * Object storage for builds, screenshots, recordings and logs.
 * `s3` targets the on-prem MinIO; `fs` stores under STORAGE_DIR (dev / single-node).
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3: S3Client | null;
  private readonly root: string;

  constructor(@InjectEnv() private readonly env: Env) {
    this.root = path.resolve(env.STORAGE_DIR);
    this.s3 =
      env.STORAGE_DRIVER === 's3'
        ? new S3Client({
            endpoint: env.S3_ENDPOINT,
            region: env.S3_REGION,
            forcePathStyle: true,
            credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
          })
        : null;
  }

  get driver(): 's3' | 'fs' {
    return this.s3 ? 's3' : 'fs';
  }

  async onModuleInit(): Promise<void> {
    if (!this.s3) {
      await mkdir(this.root, { recursive: true });
      this.logger.log(`storage: filesystem at ${this.root}`);
      return;
    }
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.env.S3_BUCKET }));
    } catch {
      try {
        await this.s3.send(new CreateBucketCommand({ Bucket: this.env.S3_BUCKET }));
        this.logger.log(`storage: created bucket ${this.env.S3_BUCKET}`);
      } catch (err) {
        this.logger.error(
          `storage: bucket ${this.env.S3_BUCKET} unavailable: ${(err as Error).message}`,
        );
      }
    }
  }

  private fsPath(key: string): string {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error('invalid storage key');
    return p;
  }

  async put(
    key: string,
    body: Buffer | Readable,
    contentType: string,
    size?: number,
  ): Promise<void> {
    if (this.s3) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.env.S3_BUCKET,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: Buffer.isBuffer(body) ? body.byteLength : size,
        }),
      );
      return;
    }
    const p = this.fsPath(key);
    await mkdir(path.dirname(p), { recursive: true });
    await pipeline(Buffer.isBuffer(body) ? Readable.from([body]) : body, createWriteStream(p));
  }

  async putFile(key: string, filePath: string, contentType: string): Promise<void> {
    const { size } = await stat(filePath);
    await this.put(key, createReadStream(filePath), contentType, size);
  }

  async get(key: string): Promise<Readable> {
    if (this.s3) {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key }),
      );
      if (!res.Body) throw new Error('empty object');
      return res.Body as Readable;
    }
    return createReadStream(this.fsPath(key));
  }

  async delete(key: string): Promise<void> {
    if (this.s3) {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key }));
      return;
    }
    await rm(this.fsPath(key), { force: true });
  }
}

@Global()
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
