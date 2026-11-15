// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * #2014: a statement counts only from the account that signed it.
 *
 * Anyone with a statement allowance can put a co-player's presence topic on a
 * statement and write that co-player's id in `from`. Without the signer, a
 * forged hello with a newer sid switched a linked peer to a session that does
 * not exist, and a forged bye with the peer's real sid (in the clear in every
 * hello) ended its session. With `signerOf` set, a statement whose proof's
 * signer is not the account its `from` names is dropped before any frame in it
 * is read.
 */
import { describe, expect, it, vi } from "vitest"
import { statementTransport } from "./statementTransport"
import { toHex, type StatementStoreLike } from "./store"
import type { SignalHandlers, SignalTransport } from "./transport"

const enc = new TextEncoder()
type AnyFrame = Record<string, unknown>
type Signed = { frame: AnyFrame; signer?: string }

const PEER_KEY = "0x" + "aa".repeat(32)
const OTHER_KEY = "0x" + "bb".repeat(32) // an attacker with an allowance of its own
const signerOf = (peer: string) => (peer === "peer" ? PEER_KEY : null)

function fakeStore() {
  let onPage: ((page: { statements: Array<{ data?: string; signer?: string }> }) => void) | null = null
  const store: StatementStoreLike = {
    createProofAuthorized: () => Promise.resolve("fake-proof"),
    submit: async () => {},
    subscribe: (_filter, cb) => {
      onPage = cb
      return { unsubscribe: () => {} }
    },
  }
  return {
    store,
    push: (...statements: Signed[]) =>
      onPage?.({
        statements: statements.map(({ frame, signer }) => ({
          data: toHex(enc.encode(JSON.stringify(frame))),
          ...(signer !== undefined ? { signer } : {}),
        })),
      }),
    subscribed: () => onPage !== null,
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r))
const settle = async (rounds = 20, minMs = 5) => {
  const t0 = performance.now()
  for (let i = 0; i < rounds || performance.now() - t0 < minMs; i++) await tick()
}
const until = async (cond: () => boolean, what: string, maxMs = 15_000) => {
  const t0 = performance.now()
  while (!cond()) {
    if (performance.now() - t0 > maxMs) throw new Error(`timed out waiting for ${what}`)
    await tick()
  }
}

/** The app's wire: a roster, one bundle per phone, and (unless `bound` is false) the signer rule. */
async function open(fake: ReturnType<typeof fakeStore>, bound = true, log: (m: string) => void = () => {}) {
  const handlers = {
    onPeerSession: vi.fn<(id: string, sid: string) => void>(),
    onPeerJoined: vi.fn<(id: string, name: string, seen?: boolean) => void>(),
    onPeerLeft: vi.fn<(id: string) => void>(),
    onSignal: vi.fn<(from: string, data: unknown) => void>(),
  } satisfies SignalHandlers
  const factory = statementTransport({
    resolveStore: async () => fake.store,
    namespace: "test.ns",
    bundle: true,
    log,
    ...(bound ? { signerOf } : {}),
  })
  const transport: SignalTransport = factory({ base: "", room: "room1", id: "me", name: "me", peers: ["peer"], handlers })
  await until(fake.subscribed, "the transport to subscribe")
  return { transport, handlers }
}

const SID_A = "1800000000000-aaaa"
const SID_B = "1800000005000-bbbb" // a later boot: what a reload, or a forger, claims
const hello = (sid: string) => ({ t: "hello", from: "peer", name: "Peer", sid })
const bye = (sid: string) => ({ t: "bye", from: "peer", sid })
const offer = (sid: string, gen: string, sdp: string) => ({ t: "d", from: "peer", name: "Peer", sid, gen, desc: { type: "offer", sdp } })
const bundle = (sid: string, f: Record<string, AnyFrame>) => ({ t: "b", from: "peer", sid, f })
const delivered = (h: Awaited<ReturnType<typeof open>>["handlers"]) =>
  h.onSignal.mock.calls.map(([, d]) => (d as { rtc: { desc?: { sdp?: string } } }).rtc.desc?.sdp).filter((s): s is string => !!s)

/** the peers announced as joined (the transport also announces its own room on open) */
const joined = (h: Awaited<ReturnType<typeof open>>["handlers"]) => h.onPeerJoined.mock.calls.map(([id]) => id).filter((id) => id === "peer")

/** The peer heard on SID_A, signed by its own account, and our link to it up. */
async function linkedPeer(fake: ReturnType<typeof fakeStore>, opened: Awaited<ReturnType<typeof open>>) {
  fake.push({ frame: hello(SID_A), signer: PEER_KEY })
  await settle()
  expect(opened.handlers.onPeerJoined).toHaveBeenCalledWith("peer", "Peer", true)
  opened.transport.setLinked?.("peer", true)
}

describe("statementTransport — a statement counts only from the account that signed it (#2014)", () => {
  it("drops a newer-sid hello for a linked peer signed by another account: no session switch, the live session kept", async () => {
    const fake = fakeStore()
    const opened = await open(fake)
    await linkedPeer(fake, opened)
    fake.push({ frame: hello(SID_B), signer: OTHER_KEY })
    await settle()
    expect(opened.handlers.onPeerSession).not.toHaveBeenCalled()
    // the real session still delivers
    fake.push({ frame: bundle(SID_A, { p: hello(SID_A), "d:me": offer(SID_A, `${SID_A}.1`, "real") }), signer: PEER_KEY })
    await settle()
    expect(delivered(opened.handlers)).toEqual(["real"])
    expect(opened.transport.stats?.().signerDropped).toBe(1)
  })

  it("drops a bye carrying the peer's real sid signed by another account: no onPeerLeft, the session stays live", async () => {
    const fake = fakeStore()
    const opened = await open(fake)
    await linkedPeer(fake, opened)
    fake.push({ frame: bye(SID_A), signer: OTHER_KEY })
    await settle()
    expect(opened.handlers.onPeerLeft).not.toHaveBeenCalled()
    fake.push({ frame: bundle(SID_A, { p: hello(SID_A), "d:me": offer(SID_A, `${SID_A}.1`, "still") }), signer: PEER_KEY })
    await settle()
    expect(delivered(opened.handlers)).toEqual(["still"])
  })

  it("switches to none of a fresh forged sid on every repost", async () => {
    const fake = fakeStore()
    const log = vi.fn<(m: string) => void>()
    const opened = await open(fake, true, log)
    await linkedPeer(fake, opened)
    for (let i = 1; i <= 5; i++) {
      fake.push({ frame: hello(`18000000${10 + i}000-f${i}`), signer: OTHER_KEY })
      await settle()
    }
    expect(opened.handlers.onPeerSession).not.toHaveBeenCalled()
    expect(opened.transport.stats?.().signerDropped).toBe(5)
    // said once for the peer, and never with the frame's contents
    const said = log.mock.calls.map(([m]) => m).filter((m) => m.includes("signer"))
    expect(said).toHaveLength(1)
    expect(said[0]).not.toMatch(/f1|hello|Peer/)
  })

  it("drops a forged bundle (hello and desc) from another signer entirely", async () => {
    const fake = fakeStore()
    const opened = await open(fake)
    fake.push({ frame: bundle(SID_B, { p: hello(SID_B), "d:me": offer(SID_B, `${SID_B}.1`, "forged") }), signer: OTHER_KEY })
    await settle()
    expect(joined(opened.handlers)).toEqual([])
    expect(opened.handlers.onPeerSession).not.toHaveBeenCalled()
    expect(opened.handlers.onSignal).not.toHaveBeenCalled()
    expect(opened.transport.stats?.().framesRecv).toBe(0)
  })

  it("drops a statement that comes with no signer", async () => {
    const fake = fakeStore()
    const opened = await open(fake)
    fake.push({ frame: hello(SID_A) })
    await settle()
    expect(joined(opened.handlers)).toEqual([])
    expect(opened.transport.stats?.().signerDropped).toBe(1)
  })

  it("still switches on a genuine reload: a newer sid signed by the peer's own account", async () => {
    const fake = fakeStore()
    const opened = await open(fake)
    await linkedPeer(fake, opened)
    fake.push({ frame: hello(SID_B), signer: PEER_KEY.toUpperCase().replace("0X", "0x") }) // hex case is not identity
    await settle()
    expect(opened.handlers.onPeerSession).toHaveBeenCalledWith("peer", SID_B)
    expect(opened.transport.stats?.().signerDropped).toBe(0)
  })

  it("without signerOf, an unsigned statement works as before", async () => {
    const fake = fakeStore()
    const opened = await open(fake, false)
    fake.push({ frame: hello(SID_A) })
    await settle()
    expect(opened.handlers.onPeerJoined).toHaveBeenCalledWith("peer", "Peer", true)
    expect(opened.transport.stats?.().signerDropped).toBeUndefined()
  })
})
