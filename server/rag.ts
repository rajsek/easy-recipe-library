/**
 * Full-corpus retrieval (RAG): precomputed local embeddings for the whole
 * video index + recipe cards, so an ask retrieves the top matches from ALL
 * 4468 videos - not just the extracted cards - and the model chooses from
 * that compact, relevant set. Video-only matches are labelled honestly:
 * "video found - details not extracted yet". Nothing here invents recipe
 * details for an unextracted video, and nothing leaves the server for
 * matching (vectors ship with the snapshot; the question embeds locally).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { videoDietHint } from './video-diet.js';
import { embed, cosine, loadSemantic } from './semantic.js';

export interface VideoMatch {
  video_id: string; title: string; channel: string; category: string; diet_hint: string; status: string; score: number;
}

interface Artifact {
  model: string; revision: string; dim: number; quantization?: string; count: number; library: string; generated: string;
  videos: [string, string, string, string, string, string][];
  vectors_b64_f32?: string;
  vectors_b64_i8?: string;
}

let art: Artifact | null | undefined; // undefined = not tried, null = unavailable
let vecs: Float32Array | null = null;
let artError = '';

function loadArtifact(): boolean {
  if (art !== undefined) return art !== null;
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(path.join(__dirname, 'demo-embeddings.json'), 'utf8');
    art = JSON.parse(raw);
    if (art!.vectors_b64_i8) {
      const q = new Int8Array(Buffer.from(art!.vectors_b64_i8, 'base64').buffer);
      vecs = new Float32Array(q.length);
      for (let i = 0; i < q.length; i++) vecs[i] = q[i] / 127;
    } else if (art!.vectors_b64_f32) {
      vecs = new Float32Array(Buffer.from(art!.vectors_b64_f32, 'base64').buffer);
    } else {
      throw new Error('no vectors');
    }
    return true;
  } catch (e) {
    art = null; vecs = null;
    artError = String(e && (e as Error).message || e).slice(0, 160);
    return false;
  }
}

export function ragStatus(): { ready: boolean; count: number; library?: string; generated?: string; error?: string } {
  if (!loadArtifact()) return { ready: false, count: 0, error: artError || 'unknown' };
  return { ready: true, count: art!.count, library: art!.library, generated: art!.generated };
}

/** Top-K video-index matches for a question; null when embeddings or the artifact are unavailable (callers degrade honestly). */
export async function retrieveVideos(question: string, k = 10, excludeIds: Record<string, true> = {}): Promise<VideoMatch[] | null> {
  if (!loadArtifact()) return null;
  // RAG is the core path the owner asked for: wait for the BOUNDED model
  // load (never unbounded) rather than silently dropping video retrieval on
  // a cold instance. The timeout keeps the worst case honest.
  await loadSemantic();
  const q = await embed([question]);
  if (!q) return null;
  const qv = q[0];
  const dim = art!.dim;
  if (qv.length !== dim) return null; // embedder/artifact mismatch: degrade, never garbage-rank
  const scored: VideoMatch[] = [];
  for (let i = 0; i < art!.count; i++) {
    const [video_id, title, channel, category, diet_hint, status] = art!.videos[i];
    if (excludeIds[video_id]) continue;
    let dot = 0, na = 0, nb = 0;
    const off = i * dim;
    for (let j = 0; j < dim; j++) {
      const a = qv[j], b = vecs![off + j];
      dot += a * b; na += a * a; nb += b * b;
    }
    const score = na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
    scored.push({ video_id, title, channel, category, diet_hint: videoDietHint(title, diet_hint), status, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
