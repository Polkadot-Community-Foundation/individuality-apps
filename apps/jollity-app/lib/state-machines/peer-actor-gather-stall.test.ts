// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * #1951 / #1956: the actor's gathering-stall deadline. A connection whose
 * ICE gathering stalls on host candidates (one host candidate, then
 * nothing, five rebuilds each found only by the ~15 s ICE timeout) is rebuilt
 * at gatherStallBy, 5 s after both its descriptions are in, through the
 * existing recover path, once per peer per round.
 */
import { describe, expect, it } from "vitest"
import { createPeerActorState, deadlineInstants, nextDeadline, stepPeerActor, type PeerActorEvent, type PeerActorState } from "./peer-actor"
import { clockOf, type SupervisorTickFacts } from "./peer-actor.test-helper"
import { tickFacts } from "./peer.definition"

const T0 = 100_000
/** both descriptions are in at T0 + 1 s: ours at +100 ms, theirs applied at +1 s */
const DESCRIBED = T0 + 1_000
const STALL_AT = DESCRIBED + 5_000

const at = <Event extends Omit<PeerActorEvent, "roomEpoch" | "connectionEpoch">>(value: Event, connectionEpoch = 1): PeerActorEvent =>
  ({ ...value, roomEpoch: 1, connectionEpoch }) as PeerActorEvent

function step(state: PeerActorState, event: PeerActorEvent): PeerActorState {
  return stepPeerActor(state, event).state
}

/** The initiator's connection: the peer heard at T0, our offer set, their
 *  answer applied. */
function described(options: { everConnected?: boolean; connectionEpoch?: number; state?: PeerActorState } = {}): PeerActorState {
  const epoch = options.connectionEpoch ?? 1
  let state = options.state ?? createPeerActorState({ game: 1, roomEpoch: 1, peer: "peer" }, { initiator: true, connectingSince: T0, everConnected: options.everConnected ?? false })
  state = step(state, at({ type: "peer-heard", at: T0, now: T0 }, epoch))
  state = step(state, at({ type: "local-description-set", now: T0 + 100 }, epoch))
  const observed = stepPeerActor(state, at({ type: "description-observed", lane: false, description: "answer", now: T0 + 800 }, epoch))
  const srd = observed.commands.find((command) => command.kind === "set-remote-description")!
  return step(observed.state, at({ type: "command-completed", commandEpoch: srd.commandEpoch, commandKind: "set-remote-description", outcome: "resolved", now: DESCRIBED }, epoch))
}

/** What the sweep reads of a connection that is still checking with host
 *  candidates only, made with TURN, not relay only. */
const stalled = (now: number, overrides: Partial<SupervisorTickFacts> = {}): SupervisorTickFacts => tickFacts({
  now,
  browserConnectionState: "connecting",
  everConnected: false,
  laneOpen: false,
  hasChannel: true,
  haveLocalOffer: false,
  localDescription: true,
  remoteDescription: true,
  framesSeen: 0,
  downAt: 0,
  disconnectedAt: 0,
  srflxOrRelaySeen: false,
  gatheringComplete: false,
  turnConfigured: true,
  relayOnly: false,
  ...overrides,
})
const sweep = (state: PeerActorState, facts: SupervisorTickFacts, connectionEpoch = 1) =>
  stepPeerActor(state, clockOf(facts, { roomEpoch: 1, connectionEpoch }))
const replaces = (result: ReturnType<typeof stepPeerActor>) =>
  result.commands.filter((command) => command.kind === "replace-connection").map((command) => (command as { cause: string }).cause)

describe("the gathering-stall deadline (#1951)", () => {
  it("is armed 5 s after both descriptions are in, and nextDeadline reaches it", () => {
    const state = described()
    expect(state.localDescribedAt).toBe(T0 + 100)
    expect(state.remoteDescribedAt).toBe(DESCRIBED)
    expect(state.deadlines.gatherStallBy).toBe(STALL_AT)
    expect(deadlineInstants(state)).toContain(STALL_AT)
    expect(nextDeadline(state, STALL_AT - 1)).toBe(STALL_AT)
  })

  it("is not armed before both descriptions are in", () => {
    let state = createPeerActorState({ game: 1, roomEpoch: 1, peer: "peer" }, { connectingSince: T0 })
    state = step(state, at({ type: "local-description-set", now: T0 }))
    expect(state.deadlines.gatherStallBy).toBeNull()
    // a remote description only observed, not yet applied, does not count either
    state = step(state, at({ type: "description-observed", lane: false, description: "answer", now: T0 + 500 }))
    expect(state.remoteDescribedAt).toBeNull()
    expect(state.deadlines.gatherStallBy).toBeNull()
  })

  it("rebuilds once at the deadline, as a failure the actor counts, and not a millisecond before", () => {
    const state = described()
    const early = sweep(state, stalled(STALL_AT - 1))
    expect(early.commands).toEqual([])
    const due = sweep(state, stalled(STALL_AT))
    expect(replaces(due)).toEqual(["gathering-stalled"])
    expect(due.commands).toEqual([expect.objectContaining({ kind: "replace-connection", cause: "gathering-stalled", initiate: true, attempt: 1, at: STALL_AT })])
    expect(due.state.budgets.failCount).toBe(1)
    expect(due.state.budgets.gatherStallRebuilds).toBe(1)
    expect(due.state.lastAttemptAt).toBe(STALL_AT)
    // the fresh connection starts without the old one's descriptions
    expect(due.state.localDescribedAt).toBeNull()
    expect(due.state.remoteDescribedAt).toBeNull()
    expect(due.state.deadlines.gatherStallBy).toBeNull()
  })

  it("takes the later description: a remote one applied late starts the clock late", () => {
    let state = createPeerActorState({ game: 1, roomEpoch: 1, peer: "peer" }, { initiator: false, connectingSince: T0 })
    state = step(state, at({ type: "peer-heard", at: T0, now: T0 }))
    const observed = stepPeerActor(state, at({ type: "description-observed", lane: false, description: "offer", now: T0 + 200 }))
    const srd = observed.commands.find((command) => command.kind === "set-remote-description")!
    state = step(observed.state, at({ type: "command-completed", commandEpoch: srd.commandEpoch, commandKind: "set-remote-description", outcome: "resolved", now: T0 + 300 }))
    // the answerer's answer is set later, after its non-trickle gather
    state = step(state, at({ type: "local-description-set", now: T0 + 3_000 }))
    expect(state.deadlines.gatherStallBy).toBe(T0 + 8_000)
    // no role gate: the answerer's stall is rebuilt too
    expect(replaces(sweep(state, stalled(T0 + 8_000)))).toEqual(["gathering-stalled"])
  })

  it("keeps only the first local description of a connection", () => {
    const state = described()
    const again = stepPeerActor(state, at({ type: "local-description-set", now: T0 + 4_000 }))
    expect(again.state).toBe(state)
    expect(again.commands).toEqual([])
  })

  it("does not rebuild a connection that gathered a srflx or relay candidate, or completed its gathering", () => {
    const state = described()
    expect(sweep(state, stalled(STALL_AT + 3_000, { srflxOrRelaySeen: true })).commands).toEqual([])
    expect(sweep(state, stalled(STALL_AT + 3_000, { gatheringComplete: true })).commands).toEqual([])
  })

  it("does not rebuild without TURN in this connection's own config, relay only, or a sweep that carries no gather facts", () => {
    const state = described()
    expect(sweep(state, stalled(STALL_AT, { turnConfigured: false })).commands).toEqual([])
    expect(sweep(state, stalled(STALL_AT, { relayOnly: true })).commands).toEqual([])
    const { srflxOrRelaySeen: _s, gatheringComplete: _g, turnConfigured: _t, relayOnly: _r, ...old } = stalled(STALL_AT)
    void _s; void _g; void _t; void _r
    expect(sweep(state, old as SupervisorTickFacts).commands).toEqual([])
  })

  it("does not rebuild a connection that connected", () => {
    const up = step(described(), at({ type: "connection-observed", state: "connected", now: T0 + 2_000 }))
    expect(up.deadlines.gatherStallBy).toBeNull()
    // the link dropped and checks again: it was up on this connection, so it is not a stall
    const down = step(up, at({ type: "connection-observed", state: "disconnected", now: T0 + 3_000 }))
    expect(sweep(down, stalled(STALL_AT + 1_000, { browserConnectionState: "connecting", everConnected: true })).commands.map((command) => command.kind)).not.toContain("replace-connection")
    expect(replaces(sweep(down, stalled(STALL_AT + 1_000, { everConnected: true })))).not.toContain("gathering-stalled")
  })

  it("rebuilds early once a round: the round's budget spent, the next stall waits; a new round restores it", () => {
    const first = sweep(described(), stalled(STALL_AT))
    expect(replaces(first)).toEqual(["gathering-stalled"])
    // the fresh connection stalls the same way; 10 s on is past the backoff and before its connectBy
    const later = STALL_AT + 10_000
    const second = described({ state: first.state, connectionEpoch: 2 })
    expect(second.deadlines.gatherStallBy).toBeNull()
    expect(sweep(second, stalled(later), 2).commands).toEqual([])
    const nextRound = step(second, at({ type: "round-changed", roundGeneration: 1, now: later }, 2))
    expect(nextRound.budgets.gatherStallRebuilds).toBe(0)
    expect(nextRound.deadlines.gatherStallBy).not.toBeNull()
    expect(replaces(sweep(nextRound, stalled(later), 2))).toEqual(["gathering-stalled"])
  })

  it("waits out the backoff of an earlier failure", () => {
    const state = { ...described(), lastAttemptAt: STALL_AT - 1_000, budgets: { ...described().budgets, failCount: 1 } }
    const armed = { ...state, deadlines: { ...state.deadlines, nextAttemptAt: STALL_AT + 5_000 } }
    expect(sweep(armed, stalled(STALL_AT)).commands).toEqual([])
    expect(replaces(sweep(armed, stalled(STALL_AT + 5_000)))).toEqual(["gathering-stalled"])
  })

  it("does not count time with the page hidden, and holds a sweep while hidden", () => {
    let state = described()
    state = step(state, at({ type: "visibility-changed", hidden: true, now: T0 + 2_000 }))
    expect(sweep(state, stalled(STALL_AT)).ignored).toBe("held")
    // back after 3 s hidden, all of it after the descriptions were in
    state = step(state, at({ type: "visibility-changed", hidden: false, hiddenForMs: 3_000, now: T0 + 5_000 }))
    expect(state.deadlines.gatherStallBy).toBe(STALL_AT + 3_000)
    expect(sweep(state, stalled(STALL_AT + 2_999)).commands).toEqual([])
    expect(replaces(sweep(state, stalled(STALL_AT + 3_000)))).toEqual(["gathering-stalled"])
  })

  it("counts only the hidden time after both descriptions were in", () => {
    let state = createPeerActorState({ game: 1, roomEpoch: 1, peer: "peer" }, { connectingSince: T0 })
    state = step(state, at({ type: "visibility-changed", hidden: true, now: T0 - 4_000 }))
    state = described({ state })
    // hidden from T0 - 4 s to T0 + 2 s: only the 1 s after DESCRIBED counts
    state = step(state, at({ type: "visibility-changed", hidden: false, hiddenForMs: 6_000, now: T0 + 2_000 }))
    expect(state.gatherHiddenMs).toBe(1_000)
    expect(state.deadlines.gatherStallBy).toBe(STALL_AT + 1_000)
  })

  it("does not shift a deadline that had passed before the page hid", () => {
    let state: PeerActorState = { ...described(), lastAttemptAt: STALL_AT - 1_000, budgets: { ...described().budgets, failCount: 2 } }
    // the deadline passed inside the backoff; the page hid after it
    state = step(state, at({ type: "visibility-changed", hidden: true, now: STALL_AT + 1_000 }))
    state = step(state, at({ type: "visibility-changed", hidden: false, hiddenForMs: 4_000, now: STALL_AT + 5_000 }))
    expect(state.gatherHiddenMs).toBe(0)
    expect(state.deadlines.gatherStallBy).toBe(STALL_AT)
  })

  it("keeps no hidden time on a connected link or once the round's early rebuild is spent", () => {
    const up = step(described(), at({ type: "connection-observed", state: "connected", now: T0 + 2_000 }))
    const hiddenUp = step(step(up, at({ type: "visibility-changed", hidden: true, now: T0 + 3_000 })), at({ type: "visibility-changed", hidden: false, hiddenForMs: 2_000, now: T0 + 5_000 }))
    expect(hiddenUp.gatherHiddenMs).toBe(0)
    const spent = { ...described(), budgets: { ...described().budgets, gatherStallRebuilds: 1 } }
    const armedOff = { ...spent, deadlines: { ...spent.deadlines, gatherStallBy: null } }
    const hiddenSpent = step(step(armedOff, at({ type: "visibility-changed", hidden: true, now: T0 + 3_000 })), at({ type: "visibility-changed", hidden: false, hiddenForMs: 2_000, now: T0 + 5_000 }))
    expect(hiddenSpent.gatherHiddenMs).toBe(0)
  })

  it("forgets our local offer's time when it is rolled back, so the next local description starts the clock", () => {
    const state = { ...described(), laneOpen: true }
    const offered = stepPeerActor(state, at({ type: "local-offer-requested", lane: true, now: T0 + 2_000 }))
    const rolled = step(offered.state, at({ type: "local-offer-superseded", haveLocalOffer: true, now: T0 + 2_500 }))
    expect(rolled.localDescribedAt).toBeNull()
    expect(rolled.deadlines.gatherStallBy).toBeNull()
    const again = step(rolled, at({ type: "local-description-set", now: T0 + 3_000 }))
    expect(again.localDescribedAt).toBe(T0 + 3_000)
    expect(again.deadlines.gatherStallBy).toBe(T0 + 8_000)
  })

  it("rebuilds a rejoin's connection too: the never-connected test is this connection's, not the peer's", () => {
    const state = described({ everConnected: true })
    expect(replaces(sweep(state, stalled(STALL_AT, { everConnected: true })))).toEqual(["gathering-stalled"])
  })

  it("rebuilds a stall the sweep reads disconnected before its fact lands, never restarting ICE on it", () => {
    const state = { ...described(), laneOpen: true }
    const due = sweep(state, stalled(STALL_AT, { browserConnectionState: "disconnected", laneOpen: true }))
    expect(due.commands.map((command) => command.kind)).toEqual(["replace-connection"])
    expect(replaces(due)).toEqual(["gathering-stalled"])
  })

  it("keeps the first remote description applied: a later one does not move the clock", () => {
    const state = described()
    const observed = stepPeerActor(state, at({ type: "description-observed", lane: false, description: "offer", now: T0 + 3_000 }))
    const srd = observed.commands.find((command) => command.kind === "set-remote-description")!
    const later = step(observed.state, at({ type: "command-completed", commandEpoch: srd.commandEpoch, commandKind: "set-remote-description", outcome: "resolved", now: T0 + 3_500 }))
    expect(later.remoteDescribedAt).toBe(DESCRIBED)
    expect(later.deadlines.gatherStallBy).toBe(STALL_AT)
  })

  it("starts a fresh connection's clock without the old connection's hidden time", () => {
    let state = described()
    state = step(state, at({ type: "visibility-changed", hidden: true, now: T0 + 2_000 }))
    state = step(state, at({ type: "visibility-changed", hidden: false, hiddenForMs: 3_000, now: T0 + 5_000 }))
    expect(state.gatherHiddenMs).toBe(3_000)
    const rebuilt = sweep(state, stalled(STALL_AT + 3_000)).state
    expect(rebuilt.gatherHiddenMs).toBe(0)
    const next = described({ state: step(rebuilt, at({ type: "round-changed", roundGeneration: 1, now: STALL_AT + 3_000 }, 2)), connectionEpoch: 2 })
    expect(next.deadlines.gatherStallBy).toBe(STALL_AT)
  })

  it("leaves a failed link's cause as failed", () => {
    expect(replaces(sweep(described(), stalled(STALL_AT, { browserConnectionState: "failed" })))).toEqual(["failed"])
  })

  it("leaves a peer who said it left, or one no longer heard, to presence", () => {
    expect(sweep(described(), stalled(STALL_AT, { away: "said" })).commands).toEqual([])
    expect(sweep(described(), stalled(T0 + 46_000)).commands).toEqual([])
  })
})
