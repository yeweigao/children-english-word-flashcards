// Privileged host work: the product's own speech synthesis.
//
// Pronunciation does not borrow the viewer's device voices (on iOS the
// downloaded Enhanced/Premium voices are not exposed to web pages at
// all). This handler runs the host's bundled `tts` CLI — a high-quality
// neural voice — and returns the MP3 bytes as base64. The action layer
// (actions.ts) caches those bytes in blob storage keyed by accent+text,
// so each clip is synthesized exactly once and then served instantly.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";

export const privileged = definePrivilegedContracts({
  synthesizeSpeech: {
    request: z.object({
      text: z.string().min(1).max(300),
      voiceId: z.string().min(1).max(80),
    }),
    response: z.object({
      audioBase64: z.string(),
      contentType: z.literal("audio/mpeg"),
    }),
    capabilities: ["process.exec", "tmp.write"],
    timeoutMs: 60_000,
  },
});

const TTS_BIN = "/opt/hatch/bin/tts";

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async synthesizeSpeech(args) {
    const dir = await mkdtemp(join(tmpdir(), "flashcard-tts-"));
    const outPath = join(dir, "speech.mp3");
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          TTS_BIN,
          [
            "speak",
            "--output",
            outPath,
            "--text-stdin",
            "--language",
            "en",
            // Slightly slow for young learners following along.
            "--speed",
            "88",
            "--voice",
            args.voiceId,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        let err = "";
        child.stderr.on("data", (d: Buffer) => {
          err += d.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(`tts exited with code ${code}: ${err.slice(0, 300)}`),
            );
        });
        child.stdin.end(args.text, "utf8");
      });
      const bytes = await readFile(outPath);
      if (bytes.length === 0) {
        throw new Error("tts produced an empty audio file");
      }
      return {
        audioBase64: bytes.toString("base64"),
        contentType: "audio/mpeg" as const,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
});
