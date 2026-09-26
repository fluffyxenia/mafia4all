import type { RawTranscript } from "./transcript.js";

/**
 * Caches uploaded transcripts entirely client-side (IndexedDB), so a
 * transcript only needs to be uploaded once and then reappears in the
 * dropdown on later visits — without any host filesystem involvement. This
 * is deliberately per-browser, not shared: replay is a local recording tool,
 * not another live-game data path, so there's nothing here for the game
 * server to serve or gate behind auth.
 */

const DB_NAME = "mafia4all-replay";
const DB_VERSION = 1;
const STORE = "transcripts";

export interface TranscriptMeta {
  id: string;
  winner: string | undefined;
  dayCount: number;
  playerCount: number;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("failed to open replay cache"));
  });
}

interface StoredRecord extends TranscriptMeta {
  raw: RawTranscript;
}

export async function saveTranscript(id: string, raw: RawTranscript): Promise<void> {
  const db = await openDb();
  const record: StoredRecord = {
    id,
    winner: raw.winner?.result,
    dayCount: raw.dayNumber,
    playerCount: raw.players.length,
    savedAt: Date.now(),
    raw,
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("failed to save transcript"));
  });
  db.close();
}

export async function listTranscripts(): Promise<TranscriptMeta[]> {
  const db = await openDb();
  const records = await new Promise<StoredRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as StoredRecord[]);
    req.onerror = () => reject(req.error ?? new Error("failed to list transcripts"));
  });
  db.close();
  return records
    .map(({ raw: _raw, ...meta }) => meta)
    .sort((a, b) => b.savedAt - a.savedAt);
}

export async function getTranscript(id: string): Promise<RawTranscript | undefined> {
  const db = await openDb();
  const record = await new Promise<StoredRecord | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result as StoredRecord | undefined);
    req.onerror = () => reject(req.error ?? new Error("failed to load transcript"));
  });
  db.close();
  return record?.raw;
}
