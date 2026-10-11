// iMessage agent on Photon Spectrum (spectrum-ts, pinned 12.10.1).
// One-to-one chats only (free shared line). Everything here is best-effort: if Spectrum is
// down or not configured, the worker and dashboard keep running.

import { Spectrum, attachment, text } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { HELP_TEXT, parseCommand, subscriptionActive } from "./commands";
import { forgetRecipient, type AlertLog } from "./ratelimit";
import { buildReply, type StatusInput } from "./status-reply";
import { loadSubscribers, paths, readJson, writeJson } from "./store";
import type { Subscription } from "./types";

export interface AgentDeps {
  /** Snapshot of the worker's live state, used to build read-only replies. */
  input: () => StatusInput;
  log: (msg: string) => void;
}

type App = Awaited<ReturnType<typeof startSpectrum>>;

export function photonConfigured(): boolean {
  return Boolean(process.env.PHOTON_PROJECT_ID && process.env.PHOTON_PROJECT_SECRET);
}

async function startSpectrum() {
  return Spectrum({
    projectId: process.env.PHOTON_PROJECT_ID as string,
    projectSecret: process.env.PHOTON_PROJECT_SECRET as string,
    providers: [imessage.config()],
    options: { logLevel: "warn" },
  });
}

export class Agent {
  private app: App | null = null;
  status: string = photonConfigured() ? "starting" : "not configured (set PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET)";

  constructor(private readonly deps: AgentDeps) {}

  /** Connect and process inbound messages forever, reconnecting with backoff. Never throws. */
  async run(): Promise<void> {
    if (!photonConfigured()) {
      this.deps.log(`[agent] ${this.status}`);
      return;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        this.app = await startSpectrum();
        this.status = "connected";
        this.deps.log("[agent] Spectrum connected; listening for iMessages");
        attempt = 0;
        for await (const [space, message] of this.app.messages) {
          await this.handle(space, message).catch((e) => this.deps.log(`[agent] handler error: ${(e as Error).message}`));
        }
        this.status = "disconnected";
      } catch (e) {
        this.status = `error: ${(e as Error).message}`;
        this.deps.log(`[agent] Spectrum error: ${(e as Error).message}`);
      }
      this.app = null;
      const wait = Math.min(300_000, 5_000 * 2 ** Math.min(attempt, 6));
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handle(space: any, message: any): Promise<void> {
    if (message.direction === "outbound") return;
    if (space.type === "group") return; // shared line: one-to-one only
    if (message.content?.type !== "text") return;
    const body: string = message.content.text ?? "";
    const phone: string = message.sender?.id ?? space.phone ?? "unknown";
    const cmd = parseCommand(body);
    this.deps.log(`[agent] <- ${redact(phone)}: ${cmd.type}`);

    const reply = async (...content: unknown[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await space.responding(async () => (content.length === 1 ? space.send(content[0] as any) : space.send(...(content as [any, any]))));
    };

    // Read-only commands (status, traffic, stalls, cameras, subscriptions, help) share one builder
    // with `npm run agent:dry`; watch/stop change state and are handled below.
    const r = await buildReply(cmd, this.deps.input(), { phone, subscriptions: loadSubscribers() });
    if (r) {
      await reply(text(r.text), ...r.photos.map((p) => attachment(p.png, { name: p.name, mimeType: "image/png" })));
      return;
    }

    switch (cmd.type) {
      case "watch": {
        const subs = loadSubscribers().filter((s) => !(s.phone === phone && s.road === cmd.road));
        const sub: Subscription = { phone, spaceId: space.id, road: cmd.road, window: cmd.window, until: cmd.until, createdAt: Date.now() };
        subs.push(sub);
        await writeJson(paths.subscribers, subs);
        const live = subscriptionActive(sub, Date.now()) ? " (active now)" : "";
        await reply(text(`✅ Watching ${cmd.road} ${cmd.describe}${live}. I'll text a photo if a stalled vehicle shows up. Reply "stop" anytime.`));
        return;
      }
      case "watch_invalid":
        await reply(text(cmd.reason));
        return;
      case "stop": {
        // Privacy: delete the number everywhere we stored it.
        await writeJson(paths.subscribers, loadSubscribers().filter((s) => s.phone !== phone));
        const log = readJson<AlertLog>(paths.alertsLog, { sent: [] });
        forgetRecipient(log, phone);
        await writeJson(paths.alertsLog, log);
        await reply(text("🛑 Unsubscribed. Your number has been deleted from Shoulder Watch."));
        return;
      }
      default:
        await reply(text(HELP_TEXT));
    }
  }

  /** Proactive alert to a subscriber. Returns false (never throws) if Spectrum is unavailable. */
  async sendAlert(sub: Subscription, message: string, photo?: Buffer): Promise<boolean> {
    if (!this.app) return false;
    try {
      const im = imessage(this.app);
      const space = await im.space.get(sub.spaceId).catch(() => im.space.create(sub.phone));
      const parts = photo ? [text(message), attachment(photo, { name: "shoulder-watch.png", mimeType: "image/png" })] : [text(message)];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (space as any).send(...parts);
      return true;
    } catch (e) {
      this.deps.log(`[agent] alert to ${redact(sub.phone)} failed: ${(e as Error).message}`);
      return false;
    }
  }

  async stop(): Promise<void> {
    await this.app?.stop().catch(() => undefined);
  }
}

/** Log phone numbers as +1•••••1234 - never in full. */
export function redact(phone: string): string {
  return phone.length > 4 ? `${phone.slice(0, 2)}•••••${phone.slice(-4)}` : "••••";
}
