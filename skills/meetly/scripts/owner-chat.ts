// The owner's DM uid, asked of Plow on every use (never cached: a stored uid
// would outlive the chat it names). Same rule as the Plow channel plugin: the
// one active chat with exactly two participants, this agent on its own line
// and a member whose role is owner.
import { isMain, run } from "./cli.ts";

export type Participant = {
  type?: string;
  relationship?: string;
  role?: string;
  display_name?: string | null;
  line?: { uid?: string };
};
export type Chat = { uid: string; status?: string; participants?: Participant[] };
export type Identity = { line?: { uid?: string }; chats?: Chat[] };

export type ApiOptions = { fetch?: typeof fetch; base?: string; token?: string };
export type Api = { fetch: typeof fetch; base: string; headers: Record<string, string> };

// Where and how to call Plow, from the env unless given.
export function plowApi(opts: ApiOptions = {}): Api {
  const base = (opts.base ?? process.env.PLOW_API_BASE ?? "").replace(/\/+$/, "");
  const token = opts.token ?? process.env.PLOW_AGENT_TOKEN ?? "";
  if (!base) throw new Error("PLOW_API_BASE is not set");
  if (!token) throw new Error("PLOW_AGENT_TOKEN is not set");
  return { fetch: opts.fetch ?? fetch, base, headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } };
}

export async function fetchIdentity(api: Api): Promise<Identity> {
  const res = await api.fetch(`${api.base}/v1/agents/me`, {
    headers: api.headers,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`/v1/agents/me returned HTTP ${res.status}`);
  return (await res.json()) as Identity;
}

export function findOwnerDm(identity: Identity): Chat | null {
  const line = identity.line?.uid;
  const owners = (identity.chats ?? []).filter((c) => {
    const ps = c.participants ?? [];
    return c.status === "active" && ps.length === 2 &&
      ps.some((p) => p.type === "agent" && p.relationship === "self" && p.line?.uid === line) &&
      ps.some((p) => p.type === "member" && p.role === "owner");
  });
  if (owners.length > 1) throw new Error(`expected one owner's chat; found ${owners.length}`);
  return owners[0] ?? null;
}

export function findOwnerChat(identity: Identity): string | null {
  return findOwnerDm(identity)?.uid ?? null;
}

// The name on the owner's Plow profile, as their DM shows it; undefined when
// Plow has none, or the owner has not texted this line yet.
export async function ownerDisplayName(opts: ApiOptions = {}): Promise<string | undefined> {
  const dm = findOwnerDm(await fetchIdentity(plowApi(opts)));
  const owner = dm?.participants?.find((p) => p.type === "member" && p.role === "owner");
  const name = owner?.display_name?.trim();
  // Plow uses the phone number as a display-name fallback for an unnamed profile.
  return name && !/^\+?[\d\s().-]+$/.test(name) ? name : undefined;
}

export async function ownerChat(opts: ApiOptions = {}): Promise<{ chatUid: string }> {
  const uid = findOwnerChat(await fetchIdentity(plowApi(opts)));
  if (!uid) throw new Error("the owner has not texted this line yet");
  return { chatUid: uid };
}

if (isMain(import.meta.url)) run(() => ownerChat());
