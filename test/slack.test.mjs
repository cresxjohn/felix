import { test } from "node:test";
import assert from "node:assert/strict";
import { SLACK_MANIFEST, createSlack, plainText, watchList } from "../slack.mjs";

const NOW = Date.parse("2026-10-30T04:00:00Z");
const ts = (minutesAgo) => String((NOW - minutesAgo * 60e3) / 1000);

/**
 * A Slack client over a fake Slack: `answers` maps each method to its answer (an object or a function of the fields).
 * @param {Record<string, any>} answers
 * @param {{ token?: string | null }} [options]
 */
function fakeSlack(answers, { token = "xoxp-test-token" } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split("/api/")[1];
    const fields = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ method, fields });
    const a = answers[method];
    const body = typeof a === "function" ? a(fields) : a ?? { ok: false, error: "unknown_method" };
    return { status: 200, json: async () => body };
  };
  const clock = { t: NOW };
  const slack = createSlack({ readSecret: async () => token, fetchImpl, now: () => clock.t });
  return { slack, calls, clock };
}

const BASE = {
  "auth.test": { ok: true, user_id: "UME", user: "cres", team: "PURE PM", url: "https://purepm.slack.com/" },
  "users.info": ({ user }) => ({ ok: true, user: { profile: { display_name: { UB: "Brian", UE: "Eugene", UME: "Cres" }[user] || "" }, name: user.toLowerCase() } }),
  "conversations.info": ({ channel }) => ({ ok: true, channel: channel === "D1" ? { is_im: true } : { name: { C1: "team-viper", C2: "eng-releases" }[channel], last_read: ts(60) } }),
};

test("plainText reads Slack's markup the way people wrote it", () => {
  const names = { UB: "Brian" };
  assert.equal(plainText("<@UB> can you review <https://github.com/x/pull/1|fm#12276>? &lt;3 &amp; thanks", (id) => names[id] || id), "@Brian can you review fm#12276? <3 & thanks");
  assert.equal(plainText("<@UX|cres> see <#C1|team-viper> <!here> <!subteam^S1|@devs> <https://www.example.com/a>"), "@cres see #team-viper @here @devs example.com/a");
  assert.equal(plainText(undefined), "");
});

test("watchList takes channels by line or comma, with or without #, once each", () => {
  assert.deepEqual(watchList("#Eng-Releases, incidents\n\n#incidents"), ["eng-releases", "incidents"]);
  assert.deepEqual(watchList(""), []);
});

test("the manifest asks for exactly what Felix reads and posts", () => {
  for (const scope of ["search:read", "stars:read", "users:read", "channels:history", "chat:write", "users:write"]) assert.match(SLACK_MANIFEST, new RegExp(`- ${scope}\\n`));
});

test("card lists who mentioned you, where and when, newest first, leaving out your own and old ones", async () => {
  const { slack, calls } = fakeSlack({
    ...BASE,
    "search.messages": {
      ok: true,
      messages: {
        matches: [
          { user: "UB", text: "<@UME> can you review this?", ts: ts(25), channel: { id: "C1", name: "team-viper" }, permalink: "https://purepm.slack.com/archives/C1/p1" },
          { user: "UE", text: "done, <@UME>", ts: ts(80), channel: { id: "D1", name: "D1ABCDEFGH", is_im: true }, permalink: "p2" },
          { user: "UME", text: "my own <@UME>", ts: ts(90), channel: { id: "C1", name: "team-viper" } },
          { user: "UB", text: "too old", ts: ts(60 * 24 * 5), channel: { id: "C1", name: "team-viper" } },
        ],
      },
    },
    "stars.list": { ok: true, items: [{ type: "message", channel: "C2", message: { user: "UE", text: "Postmortem <https://d.co/x|doc>", ts: ts(300), permalink: "p3" } }, { type: "file" }] },
  });
  const card = await slack.card({ days: 3 });
  assert.deepEqual(card.mentions.map((m) => [m.who, m.where, m.text, m.link]), [
    ["Brian", "#team-viper", "@Cres can you review this?", "https://purepm.slack.com/archives/C1/p1"],
    ["Eugene", "a direct message", "done, @Cres", "p2"],
  ]);
  assert.deepEqual(card.saved.map((s) => [s.who, s.where, s.text]), [["Eugene", "#eng-releases", "Postmortem doc"]]);
  assert.deepEqual(card.me, { name: "cres", team: "PURE PM", url: "https://purepm.slack.com/" });
  assert.match(calls.find((c) => c.method === "search.messages").fields.query, /^<@UME> after:\d{4}-\d{2}-\d{2}$/);
  // Cached until fresh, and names are asked once.
  const before = calls.length;
  await slack.card({ days: 3 });
  assert.equal(calls.length, before);
  await slack.card({ days: 3, fresh: true });
  assert.equal(calls.filter((c) => c.method === "users.info" && c.fields.user === "UB").length, 1);
});

test("watched channels get their unread counts, and ones you're not in are named", async () => {
  const { slack } = fakeSlack({
    ...BASE,
    "search.messages": { ok: true, messages: { matches: [] } },
    "users.conversations": ({ cursor }) => (cursor
      ? { ok: true, channels: [{ id: "C2", name: "eng-releases" }] }
      : { ok: true, channels: [{ id: "C1", name: "team-viper" }], response_metadata: { next_cursor: "page2" } }),
    "conversations.info": ({ channel }) => ({ ok: true, channel: channel === "C1" ? { unread_count_display: 4 } : { last_read: ts(60) } }),
    "conversations.history": { ok: true, messages: [{ ts: ts(10) }, { ts: ts(5), subtype: "channel_join" }, { ts: ts(2), subtype: "bot_message" }] },
  });
  const card = await slack.card({ watch: ["team-viper", "eng-releases", "nope"], saved: false });
  assert.deepEqual(card.unread.map((u) => [u.channel, u.count, u.link]), [["team-viper", 4, "https://purepm.slack.com/archives/C1"], ["eng-releases", 2, "https://purepm.slack.com/archives/C2"]]);
  assert.deepEqual(card.missing, ["nope"]);
  assert.equal(card.saved, null);
});

test("a section Slack won't give is noted, not fatal; a refused token is", async () => {
  const { slack } = fakeSlack({
    ...BASE,
    "search.messages": { ok: true, messages: { matches: [] } },
    "stars.list": { ok: false, error: "missing_scope", needed: "stars:read" },
    "users.conversations": { ok: false, error: "ratelimited" },
  });
  const card = await slack.card({ watch: ["x"] });
  assert.match(card.problems.saved, /stars:read/);
  assert.match(card.problems.unread, /slow down/);
  const revoked = fakeSlack({ ...BASE, "search.messages": { ok: false, error: "token_revoked" } }).slack;
  await assert.rejects(revoked.card(), { code: "auth" });
  await assert.rejects(fakeSlack(BASE, { token: null }).slack.card(), { code: "no-token" });
  const starsAuth = fakeSlack({ ...BASE, "search.messages": { ok: true, messages: { matches: [] } }, "stars.list": { ok: false, error: "invalid_auth" } }).slack;
  await assert.rejects(starsAuth.card(), { code: "auth" });
  const listAuth = fakeSlack({ ...BASE, "search.messages": { ok: true, messages: { matches: [] } }, "users.conversations": { ok: false, error: "invalid_auth" } }).slack;
  await assert.rejects(listAuth.card({ watch: ["x"], saved: false }), { code: "auth" });
});

test("names and places fall back gracefully, and reset forgets the cache", async () => {
  const { slack, calls } = fakeSlack({
    ...BASE,
    "users.info": { ok: false, error: "user_not_found" },
    "conversations.info": ({ channel }) => (channel === "G1" ? { ok: true, channel: { is_mpim: true } } : { ok: false, error: "channel_not_found" }),
    "search.messages": { ok: true, messages: { matches: [
      { user: "UZ", text: "hi <@UME>", ts: ts(5), channel: { id: "G1", name: "mpdm-x" } },
      { username: "deploybot", text: "<@UME> deployed", ts: ts(6), channel: { id: "C9", name: "C9ABCDEFGHI" } },
      { text: "<@UME> ping", ts: ts(7), channel: { id: "G2", is_mpim: true } },
    ] } },
    "stars.list": { ok: true, items: [{ type: "message", channel: "C9", message: { username: "bot", text: "saved", ts: ts(9) } }] },
  });
  const card = await slack.card();
  assert.deepEqual(card.mentions.map((m) => [m.who, m.where]), [["UZ", "#mpdm-x"], ["deploybot", "a conversation"], ["Someone", "a group message"]]);
  assert.deepEqual(card.saved.map((s) => [s.who, s.where]), [["bot", "a conversation"]]);
  slack.reset();
  const n = calls.length;
  await slack.card();
  assert.ok(calls.length > n);
});

test("a Slack search gives who said what, where and when, with names filled in", async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const method = url.split("/").pop();
    sent.push([method, Object.fromEntries(new URLSearchParams(init.body))]);
    const answers = {
      "search.messages": { ok: true, messages: { total: 1, matches: [{ user: "U1", channel: { id: "C1", name: "team" }, text: "release at 3 <@U2>", ts: "1793300000.000", permalink: "https://slack/p1" }] } },
      "users.info": { ok: true, user: { real_name: "Anna", profile: { display_name: "Anna" } } },
      "conversations.info": { ok: true, channel: { name: "team" } },
    };
    return new Response(JSON.stringify(answers[method] || { ok: true }));
  };
  const slack = createSlack({ readSecret: async () => "xoxp-1", fetchImpl });
  const found = await slack.search("release", 100);
  assert.deepEqual(sent[0], ["search.messages", { query: "release", sort: "timestamp", sort_dir: "desc", count: "30" }]);
  assert.equal(found.total, 1);
  assert.equal(found.messages[0].who, "Anna");
  assert.equal(found.messages[0].link, "https://slack/p1");
  assert.match(found.messages[0].text, /release at 3/);
});

test("Felix's own tools call Slack methods that only read", async () => {
  const asked = [];
  const fetchImpl = async (url, init) => { asked.push([url, String(init.body)]); return { ok: true, status: 200, json: async () => ({ ok: true, members: [] }) }; };
  const slack = createSlack({ readSecret: async () => "xoxp-1", fetchImpl });
  assert.deepEqual(await slack.read("users.list", { limit: 5 }), { ok: true, members: [] });
  assert.deepEqual(asked, [["https://slack.com/api/users.list", "limit=5"]]);
  await slack.read("conversations.history");
  await slack.read("users.profile.get");
  for (const m of ["chat.postMessage", "users.setPresence", "conversations.invite", "chat.delete"]) {
    await assert.rejects(slack.read(m), /only read from Slack/, m);
  }
});
