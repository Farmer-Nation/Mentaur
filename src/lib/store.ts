import { promises as fs } from "fs";
import path from "path";
import type { CaptureSession, TeachSession } from "./types";

const DATA_DIR = path.join(process.cwd(), "data", "sessions");
const TEACH_DIR = path.join(process.cwd(), "data", "teach-sessions");

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function saveSession(session: CaptureSession): Promise<void> {
  await ensureDir(DATA_DIR);
  const file = path.join(DATA_DIR, `${session.id}.json`);
  await fs.writeFile(file, JSON.stringify(session, null, 2), "utf-8");
}

export async function loadSession(id: string): Promise<CaptureSession | null> {
  try {
    const file = path.join(DATA_DIR, `${id}.json`);
    const raw = await fs.readFile(file, "utf-8");
    return JSON.parse(raw) as CaptureSession;
  } catch {
    return null;
  }
}

export async function listSessions(): Promise<CaptureSession[]> {
  await ensureDir(DATA_DIR);
  const files = await fs.readdir(DATA_DIR);
  const sessions = await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => {
        const raw = await fs.readFile(path.join(DATA_DIR, f), "utf-8");
        return JSON.parse(raw) as CaptureSession;
      })
  );
  return sessions.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveTeachSession(session: TeachSession): Promise<void> {
  await ensureDir(TEACH_DIR);
  const file = path.join(TEACH_DIR, `${session.id}.json`);
  await fs.writeFile(file, JSON.stringify(session, null, 2), "utf-8");
}

export async function loadTeachSession(id: string): Promise<TeachSession | null> {
  try {
    const file = path.join(TEACH_DIR, `${id}.json`);
    const raw = await fs.readFile(file, "utf-8");
    return JSON.parse(raw) as TeachSession;
  } catch {
    return null;
  }
}
