import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const extensionByMimeType: Record<string, string> = {
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
};

export interface AudioStorage {
  saveAudio(data: Buffer, mimeType: string): Promise<string>;
  removeAudio(key: string): Promise<void>;
  readAudio(key: string): Promise<Buffer>;
}

export class LocalAudioStorage implements AudioStorage {
  private readonly root = path.resolve(process.env.STORAGE_DIR ?? "uploads");

  async saveAudio(data: Buffer, mimeType: string): Promise<string> {
    const extension = extensionByMimeType[mimeType];
    if (!extension) throw new Error(`Unsupported audio storage type: ${mimeType}`);
    const key = `noise/${randomUUID()}${extension}`;
    const destination = this.resolve(key);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data, { flag: "wx", mode: 0o600 });
    return key;
  }

  async removeAudio(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async readAudio(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  private resolve(key: string): string {
    if (!/^noise\/[0-9a-f-]+\.(webm|ogg|wav|mp3|m4a|aac)$/.test(key)) {
      throw new Error("Invalid audio storage key");
    }
    const destination = path.resolve(this.root, key);
    if (!destination.startsWith(`${this.root}${path.sep}`)) throw new Error("Audio path escapes storage root");
    return destination;
  }
}
