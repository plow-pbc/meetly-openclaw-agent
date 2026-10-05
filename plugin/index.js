// Meetly's guest scheduling tools and setup gate. Before the owner's DM turns it runs
// setup-status.ts and hands the model the answer, so the turn starts from what
// setup needs now instead of from whatever the chat history last asked. The
// prompt keeps "run setup-status.ts first" as the fallback: nothing is added
// when the script cannot run, and the model then runs it itself.
//
// Plain JavaScript on purpose: the image ships it as is, with no build step,
// and preboot copies it into the state volume's plugin root on every boot.
import { registerPipelineHooks } from "./pipeline.js";
import { ownerTurns } from "./owner-turn.js";
import { calendarPolicy } from "./calendar-policy.js";
import { execFile } from "node:child_process";
import { guestTurns } from "./guest-turn.js";
import { registerGuestTools } from "./guest-tools.js";
import { registerOwnerTools, registerOwnerGroupTool, registerOwnerDmTool, registerMovableTool } from "./owner-tools.js";

export const OWNER_DM_SESSION = "agent:main:main";
export const SETUP_STATUS = "/opt/plow/skills/meetly/scripts/setup-status.ts";

/** The owner's phone DM as the hook sees it: the Plow chat account, the owner's session, a user turn. */
export function isOwnerDmTurn(ctx) {
  return ctx?.channel === "plow" && (ctx.accountId ?? "chat") === "chat" &&
    ctx.sessionKey === OWNER_DM_SESSION && (ctx.trigger === undefined || ctx.trigger === "user");
}

/** What the model is told this turn, from setup-status.ts's JSON line; undefined when that is not a status. */
export function gateContext(stdout) {
  let status;
  try {
    status = JSON.parse(String(stdout).trim().split("\n").at(-1));
  } catch {
    return undefined;
  }
  if (status?.status === "READY") {
    return [
      "Meetly setup check, already run for this turn (setup-status.ts): READY.",
      "Do not run setup-status.ts again this turn. Handle the owner's message as \"How Meetly works\" says.",
      `setup-status.ts output: ${JSON.stringify(status)}`,
    ].join("\n");
  }
  if (status?.status !== "SETUP_NEEDED") return undefined;
  const name = status.draft?.ownerName;
  // No Mac: the calendars question cannot be answered, so the owner gets
  // Plow Latch instead; a time zone the owner can still type in.
  const noMac = status.mac?.connected === false;
  const latch = noMac
    ? [`- Their Mac is not connected. In one or two lines, say Meetly reads their iMessages and Google Calendar on their Mac through Plow Latch, that they can download it at ${status.mac.download} (more at ${status.mac.about}), and to tell you once it is installed and connected.`]
    : [];
  if (noMac && status.next === "calendars") {
    return [
      "Meetly setup check, already run for this turn (setup-status.ts): SETUP_NEEDED. Setup is not finished.",
      "Do not run setup-status.ts again this turn, and ignore any earlier setup question in the chat: this is the current state.",
      "Your reply, in the owner's language:",
      ...latch,
      "- Do not ask which calendars to use yet: that needs the Mac. End the turn.",
      `setup-status.ts output: ${JSON.stringify(status)}`,
    ].join("\n");
  }
  // Only what nobody can infer is ever asked: the name and the zone, when Plow
  // and the Mac could not answer them. The calendars are read from the Mac.
  const asking = status.next === "ownerName" || status.next === "timezone";
  const d = status.defaults;
  const defaults = ` and that you start with ${d.days.join(",")}, ${d.windowStart}-${d.windowEnd}, ${d.durationMin}-minute meetings by default; coffee 30 minutes, lunch and dinner 60 minutes; up to ${d.horizonDays} days ahead, and they can change any of it by saying so`;
  return [
    "Meetly setup check, already run for this turn (setup-status.ts): SETUP_NEEDED. Setup is not finished.",
    "Do not run setup-status.ts again this turn, and ignore any earlier setup question in the chat: this is the current state.",
    "Your reply, in the owner's language:",
    `- If you have not introduced yourself in this conversation yet, open with one line: use your conversation name, then say you are their AI scheduling assistant, who books their meetings from their calendar and reaches people for them${defaults}.`,
    ...(name ? [`- In that line, say you will refer to them as ${name} when you talk to other people, and that they can change it.`] : []),
    ...latch,
    ...(asking
      ? [
        `- First check whether the owner's latest message answers ${status.next}. A bare name is a complete answer to ownerName; it does not need a "call me" prefix. If answered, save it with record-setup.ts (see meetly-setup) before replying, then continue from the returned next field. Do not ask the answered question again.`,
        "- If the owner asked for something else, such as reaching someone, say you will do it as soon as this is answered.",
        `- Only if the latest message does not answer ${status.next}, ask this question, translated into the owner's language, and end the turn: ${status.question}`,
      ]
      : [
        ...(status.next === "calendars"
          ? ["- Do not ask which calendars to use: read them from the Mac and record every calendar with selected: true except read-only holiday subscriptions, as meetly-setup says."]
          : []),
        "- Then run record-setup.ts --done, and carry out what the owner asked in this same turn.",
        "- If the owner asked for nothing yet, add one short line: tell me who to meet.",
      ]),
    `setup-status.ts output: ${JSON.stringify(status)}`,
  ].join("\n");
}

// setup-status.ts may ask Plow for the owner's name and the Mac for their time zone.
const runStatus = () => new Promise((resolve, reject) => {
  execFile(process.execPath, [SETUP_STATUS], { env: process.env, timeout: 30_000, maxBuffer: 65_536 },
    (error, stdout) => error ? reject(error) : resolve(stdout));
});

export default {
  id: "meetly",
  name: "Meetly",
  description: "Guest scheduling tools and the owner DM setup check.",
  register(api) {
    registerPipelineHooks(api);
    registerGuestTools(api);
    registerOwnerTools(api);
    registerOwnerGroupTool(api);
    registerOwnerDmTool(api);
    registerMovableTool(api);
    api.on("before_tool_call", (event, ctx) => { ownerTurns.beforeTool(event, ctx); guestTurns.beforeTool(event, ctx); return calendarPolicy(event, ctx); });
    api.on("agent_end", (event, ctx) => { guestTurns.end(event, ctx); ownerTurns.end(event, ctx); });
    api.on("before_prompt_build", async (_event, ctx) => {
      guestTurns.begin(ctx);
      ownerTurns.begin(ctx);
      if (!isOwnerDmTurn(ctx)) return undefined;
      let context;
      try {
        context = gateContext(await runStatus());
      } catch (error) {
        api.logger.info(`meetly setup gate unavailable (${error instanceof Error ? error.message : String(error)}); prompt fallback applies`);
        return undefined;
      }
      // One line per owner turn, so a live run shows the gate reached the prompt.
      api.logger.info(context ? `meetly setup gate prepended: ${context.split("\n")[0]}` : "meetly setup gate: unreadable status; prompt fallback applies");
      return context ? { prependContext: context } : undefined;
    });
  },
};
