// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A pair connection whose ICE gathering stalls (#1951): made
 * with TURN (not relay only), 5 s after both its descriptions are in it holds
 * host candidates only, no srflx and no relay, and its gathering never
 * completes. The peer actor's gatherStallBy deadline (#1956's decision) is due
 * then: the actor rebuilds the connection through recover(), as it would a
 * failed one (same attempt accounting), with the cause gathering-stalled,
 * instead of waiting out the ~15 s ICE failure. Mesh only reports the facts:
 * our local description set, and at each sweep the candidate and ICE facts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PeerRoomRunner } from "../state-machines/peer-runner"
import { monoNow } from "./mesh"
import { backoffMs, SUPERVISE_MS } from "./supervisor-timing"
import { actorCommands, actorEvents, FakePC } from "./test-pc"

type Internals = {
  conns: Map<string, { pc: FakePC; lastSignalAt: number }>
  runner: PeerRoomRunner
  supervise: () => void
}

const STUN: RTCIceServer = { urls: "stun:stun.l.google.com:19302" }
const TURN: RTCIceServer = { urls: ["turn:turn.example.net:3478?transport=udp"], username: "u", credential: "p" }
const STALL_MS = 5_000
const WITH_TURN: RTCConfiguration = { iceServers: [STUN, TURN] }

function candidate(type: "host" | "srflx" | "relay", address = "192.168.1.20", protocol = "udp") {
  const line = `candidate:1 1 ${protocol} 2122260223 ${address} 50000 typ ${type}`
  return { type, protocol, address, candidate: line, sdpMLineIndex: 0, sdpMid: "0", toJSON: () => ({ candidate: line, sdpMLineIndex: 0, sdpMid: "0" }) }
}

/** A Mesh for `myId` made with `config`, its one peer added and heard, the
 *  connection checking and gathering. `gathered` are handed out after the
 *  `gathering` state (default one host candidate), `early` before it, as a
 *  browser that sends a candidate first does. */
async function gathering(config: RTCConfiguration, { myId = "a", peerId = "b", gathered = [candidate("host")], early = [] as ReturnType<typeof candidate>[] } = {}) {
  vi.resetModules()
  FakePC.last = []
  vi.stubGlobal("RTCPeerConnection", FakePC)
  const { Mesh } = await import("./mesh")
  const mesh = new Mesh(myId, { getVideoTracks: () => [], getTracks: () => [] } as unknown as MediaStream, config, () => {}, () => {}, () => {}, () => {}, { decisionRoom: "g7", decisionRoomEpoch: 3 })
  mesh.addPeer(peerId)
  const internals = mesh as unknown as Internals
  const conn = () => internals.conns.get(peerId)!
  const pc = conn().pc
  pc.connectionState = "connecting"
  pc.iceConnectionState = "checking"
  for (const c of early) pc.emitCandidate(c)
  pc.iceGatheringState = "gathering"
  pc.onicegatheringstatechange!()
  for (const c of gathered) pc.emitCandidate(c)
  const commands = actorCommands(mesh)
  const replaces = () => commands.filter(({ command }) => command.kind === "replace-connection").map(({ command }) => (command as { cause: string }).cause)
  /** both descriptions in, as the initiator has them: our offer set, then the
   *  peer's answer, which the actor applies */
  const describe = async (target = pc) => {
    await target.setLocalDescription({ type: "offer", sdp: "v=0" })
    await mesh.onRtc(peerId, { rtc: { desc: { type: "answer", sdp: "v=0" } } } as never)
    await vi.advanceTimersByTimeAsync(0)
  }
  /** one sweep, with the peer still heard */
  const sweep = () => {
    if (internals.conns.get(peerId)) {
      conn().lastSignalAt = monoNow()
      internals.runner.state(peerId)!.lastSignalAt = monoNow()
    }
    internals.supervise()
  }
  const rebuilt = () => internals.conns.get(peerId)?.pc !== pc
  return { mesh, pc, internals, conn, replaces, describe, sweep, rebuilt }
}

describe("a pair connection whose ICE gathering stalls with host candidates only (#1951)", () => {
  let log: { mock: { calls: unknown[][] } }
  const lines = () => log.mock.calls.map((args) => args.join(" "))
  const stallLines = () => lines().filter((line) => line.includes("gathering stalled"))
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000)
    log = vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("tells the actor when both descriptions are in: our local description set, theirs applied", async () => {
    const { mesh, internals, describe } = await gathering(WITH_TURN)
    expect(internals.runner.state("b")!.localDescribedAt).toBeNull()
    const before = monoNow()
    await describe()
    const state = internals.runner.state("b")!
    expect(state.localDescribedAt).toBeGreaterThanOrEqual(before)
    expect(state.remoteDescribedAt).toBeGreaterThanOrEqual(state.localDescribedAt!)
    expect(state.deadlines.gatherStallBy).toBe(state.remoteDescribedAt! + STALL_MS)
    mesh.close()
  })

  it("tells the actor our local description on every signalling change that has one, so a dropped one is told again", async () => {
    const { mesh, pc, describe } = await gathering(WITH_TURN)
    const events = actorEvents(mesh)
    await describe(pc)
    // our offer set, then their answer applied: two signalling changes with our description in
    expect(events.filter(({ event }) => event.type === "local-description-set")).toHaveLength(2)
    mesh.close()
  })

  it("tells no local description before ours is set: the answerer's applied offer alone is none", async () => {
    const { mesh } = await gathering(WITH_TURN, { myId: "b", peerId: "a" })
    const events = actorEvents(mesh)
    const applied = mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: "v=0" } } } as never)
    await vi.advanceTimersByTimeAsync(1_000)
    await applied
    // their offer applied (no description of ours yet), then our answer set: one
    expect(events.filter(({ event }) => event.type === "local-description-set")).toHaveLength(1)
    mesh.close()
  })

  it("is rebuilt once, at the first sweep 5 s after both descriptions are in, as a failure the actor counts", async () => {
    const { mesh, internals, replaces, describe, sweep, rebuilt } = await gathering(WITH_TURN)
    // gathering started 3 s before the answer came: those 3 s do not count
    vi.advanceTimersByTime(3_000)
    await describe()
    vi.advanceTimersByTime(STALL_MS - 1)
    sweep()
    expect(rebuilt()).toBe(false)
    expect(replaces()).toEqual([])
    vi.advanceTimersByTime(1)
    sweep()
    expect(rebuilt()).toBe(true)
    expect(replaces()).toEqual(["gathering-stalled"])
    expect(internals.runner.state("b")!.budgets.failCount).toBe(1)
    expect(internals.runner.state("b")!.budgets.gatherStallRebuilds).toBe(1)
    expect(stallLines()).toEqual(["[jollity-rtc] gathering stalled → rebuild b gathered 1/0/0 (host/srflx/relay)"])
    expect(lines()).toContain("[jollity-rtc] self-heal: rebuild b (attempt 1)")
    // the fresh connection has no descriptions: nothing more fires
    vi.advanceTimersByTime(SUPERVISE_MS * 3)
    sweep()
    expect(replaces()).toEqual(["gathering-stalled"])
    expect(stallLines()).toHaveLength(1)
    mesh.close()
  })

  it("fires on the supervisor's own interval, between 5 and 8 s after the descriptions", async () => {
    const { mesh, conn, internals, replaces, describe, rebuilt } = await gathering(WITH_TURN)
    await describe()
    for (let ms = 1_000; ms <= STALL_MS + SUPERVISE_MS; ms += 1_000) {
      conn().lastSignalAt = monoNow()
      internals.runner.state("b")!.lastSignalAt = monoNow()
      vi.advanceTimersByTime(1_000)
      if (ms < STALL_MS) expect(rebuilt()).toBe(false)
    }
    expect(rebuilt()).toBe(true)
    expect(replaces()).toEqual(["gathering-stalled"])
    mesh.close()
  })

  it("never fires on a link that has connected, not even through an ICE restart", async () => {
    const { mesh, pc, replaces, describe, sweep } = await gathering(WITH_TURN)
    await describe()
    pc.connectionState = "connected"
    pc.iceConnectionState = "connected"
    pc.onconnectionstatechange!()
    // the link drops and ICE restarts: checking again, host candidates only
    pc.connectionState = "disconnected"
    pc.onconnectionstatechange!()
    pc.connectionState = "connecting"
    pc.iceConnectionState = "checking"
    pc.iceGatheringState = "gathering"
    pc.onicegatheringstatechange!()
    pc.emitCandidate(candidate("host", "192.168.1.21"))
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(SUPERVISE_MS)
      sweep()
    }
    expect(replaces()).not.toContain("gathering-stalled")
    expect(stallLines()).toEqual([])
    mesh.close()
  })

  it("rebuilds early once a round: a second stall waits for the ICE timeout; the next round may rebuild early again", async () => {
    const { mesh, internals, replaces, describe, sweep } = await gathering(WITH_TURN)
    await describe()
    vi.advanceTimersByTime(STALL_MS)
    sweep()
    expect(replaces()).toEqual(["gathering-stalled"])
    // the fresh connection stalls the same way
    const fresh = internals.conns.get("b")!.pc
    fresh.connectionState = "connecting"
    fresh.iceConnectionState = "checking"
    fresh.iceGatheringState = "gathering"
    fresh.onicegatheringstatechange!()
    fresh.emitCandidate(candidate("host"))
    await describe(fresh)
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(SUPERVISE_MS)
      sweep()
    }
    expect(replaces()).toEqual(["gathering-stalled"])
    expect(stallLines()).toHaveLength(1)
    // a new round gives the peer its early rebuild back
    mesh.setRound(1)
    sweep()
    expect(replaces()).toEqual(["gathering-stalled", "gathering-stalled"])
    // the third connection's stall waits for ICE: it times out, and today's path rebuilds it
    const third = internals.conns.get("b")!.pc
    third.connectionState = "connecting"
    third.iceConnectionState = "checking"
    third.iceGatheringState = "gathering"
    third.onicegatheringstatechange!()
    await describe(third)
    vi.advanceTimersByTime(STALL_MS + SUPERVISE_MS)
    sweep()
    expect(replaces()).toEqual(["gathering-stalled", "gathering-stalled"])
    third.connectionState = "failed"
    third.onconnectionstatechange!()
    vi.advanceTimersByTime(backoffMs(2))
    sweep()
    expect(replaces()).toEqual(["gathering-stalled", "gathering-stalled", "failed"])
    mesh.close()
  })

  it("does not fire before the remote description is in, however long the signalling takes", async () => {
    const { mesh, pc, replaces, sweep, rebuilt } = await gathering(WITH_TURN)
    await pc.setLocalDescription({ type: "offer", sdp: "v=0" })
    vi.advanceTimersByTime(STALL_MS + 5_000)
    sweep()
    expect(rebuilt()).toBe(false)
    expect(replaces()).toEqual([])
    expect(stallLines()).toEqual([])
    mesh.close()
  })

  it("fires on the answerer too, and only on the side whose gathering stalled", async () => {
    // the answerer (b) stalls on one host candidate; the initiator (a) gathers srflx and relay, as in #1951
    const answerer = await gathering(WITH_TURN, { myId: "b", peerId: "a" })
    const initiator = await gathering(WITH_TURN, { gathered: [candidate("host"), candidate("srflx", "198.51.100.7"), candidate("relay", "203.0.113.9")] })
    const applied = answerer.mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: "v=0" } } } as never)
    // the answer waits for the non-trickle gather (750 ms) before it is set
    await vi.advanceTimersByTimeAsync(1_000)
    await applied
    expect(answerer.internals.runner.state("a")!.localDescribedAt).not.toBeNull()
    await initiator.describe()
    vi.advanceTimersByTime(STALL_MS)
    answerer.sweep()
    initiator.sweep()
    expect(answerer.replaces()).toEqual(["gathering-stalled"])
    expect(initiator.replaces()).toEqual([])
    expect(initiator.rebuilt()).toBe(false)
    answerer.mesh.close()
    initiator.mesh.close()
  })

  it("fires on a rejoin's connection: the never-connected test is the connection's, not the peer's", async () => {
    const { mesh, internals, replaces, describe, sweep } = await gathering(WITH_TURN)
    // the peer connected before (a crash and rejoin); this connection never has
    internals.runner.state("b")!.everConnected = true
    await describe()
    vi.advanceTimersByTime(STALL_MS)
    sweep()
    expect(replaces()).toEqual(["gathering-stalled"])
    mesh.close()
  })

  it("does not fire while the page is hidden, and does not count the hidden time", async () => {
    const { mesh, replaces, describe, sweep } = await gathering(WITH_TURN)
    await describe()
    vi.advanceTimersByTime(1_000)
    mesh.setSelfAway(true)
    vi.advanceTimersByTime(STALL_MS)
    sweep()
    expect(replaces()).toEqual([])
    mesh.setSelfAway(false, STALL_MS)
    // 1 s counted before the page hid: 4 s still to go
    vi.advanceTimersByTime(STALL_MS - 1_000 - 1)
    sweep()
    expect(replaces()).toEqual([])
    vi.advanceTimersByTime(1)
    sweep()
    expect(replaces()).toEqual(["gathering-stalled"])
    mesh.close()
  })

  it("does not fire once a relay candidate was gathered, a TCP or TLS one included", async () => {
    for (const protocol of ["udp", "tcp"]) {
      const { mesh, pc, replaces, describe, sweep } = await gathering(WITH_TURN)
      pc.emitCandidate(candidate("relay", "203.0.113.9", protocol))
      await describe()
      vi.advanceTimersByTime(STALL_MS + 1_000)
      sweep()
      expect(replaces()).toEqual([])
      mesh.close()
    }
    expect(stallLines()).toEqual([])
  })

  it("does not fire once a srflx candidate was gathered", async () => {
    const { mesh, pc, replaces, describe, sweep } = await gathering(WITH_TURN)
    pc.emitCandidate(candidate("srflx", "198.51.100.7"))
    await describe()
    vi.advanceTimersByTime(STALL_MS + 1_000)
    sweep()
    expect(replaces()).toEqual([])
    mesh.close()
  })

  it("keeps a candidate handed out before the gathering state: a srflx one there still counts", async () => {
    const { mesh, replaces, describe, sweep } = await gathering(WITH_TURN, { early: [candidate("srflx", "198.51.100.7")] })
    await describe()
    vi.advanceTimersByTime(STALL_MS + 1_000)
    sweep()
    expect(replaces()).toEqual([])
    mesh.close()
  })

  it("does not fire without TURN configured", async () => {
    for (const config of [{}, { iceServers: [STUN] }]) {
      const { mesh, replaces, describe, sweep } = await gathering(config)
      await describe()
      vi.advanceTimersByTime(STALL_MS + 1_000)
      sweep()
      expect(replaces()).toEqual([])
      mesh.close()
    }
    expect(stallLines()).toEqual([])
  })

  it("does not fire on a connection made before TURN arrived (late credentials)", async () => {
    const { mesh, replaces, describe, sweep } = await gathering({ iceServers: [STUN] })
    mesh.setIceServers([STUN, TURN])
    await describe()
    vi.advanceTimersByTime(STALL_MS + 1_000)
    sweep()
    expect(replaces()).toEqual([])
    mesh.close()
  })

  it("does not fire on a connection made relay only; one made before the switch is judged by the policy it gathered with", async () => {
    const relayOnly = await gathering({ ...WITH_TURN, iceTransportPolicy: "relay" })
    await relayOnly.describe()
    vi.advanceTimersByTime(STALL_MS + 1_000)
    relayOnly.sweep()
    expect(relayOnly.replaces()).toEqual([])
    relayOnly.mesh.close()
    expect(stallLines()).toEqual([])

    // gathered with every transport, host candidates only: relay only coming later does not unstall it
    const switched = await gathering(WITH_TURN)
    switched.mesh.setIcePolicy("relay", ["tcp", "tls"])
    await switched.describe()
    vi.advanceTimersByTime(STALL_MS + 1_000)
    switched.sweep()
    expect(switched.replaces()).toContain("gathering-stalled")
    switched.mesh.close()
  })

  it("does not fire once gathering completed", async () => {
    const { mesh, pc, replaces, describe, sweep } = await gathering(WITH_TURN)
    pc.iceGatheringState = "complete"
    await describe()
    vi.advanceTimersByTime(STALL_MS + 1_000)
    sweep()
    expect(replaces()).toEqual([])
    mesh.close()
  })

  it("does nothing for a connection closed before 5 s", async () => {
    const { mesh, replaces, describe } = await gathering(WITH_TURN)
    await describe()
    vi.advanceTimersByTime(STALL_MS - 1_000)
    mesh.removePeer("b")
    vi.advanceTimersByTime(STALL_MS + SUPERVISE_MS)
    expect(FakePC.last).toHaveLength(1)
    expect(replaces()).toEqual([])
    expect(stallLines()).toEqual([])
    mesh.close()
  })
})
