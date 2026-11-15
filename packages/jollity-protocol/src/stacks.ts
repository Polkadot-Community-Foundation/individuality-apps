// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The hosted networks' own values, read from their Trinity stack descriptors.
 *
 * Each network publishes a signed descriptor (the RFC "Trinity stack
 * descriptor"). The signed copies sit in ./stacks/ and are the source of truth;
 * `npm run jollity:stacks` refreshes them from the live descriptors and
 * regenerates ./stacks.generated.ts, the plain values the app and the chat
 * actually import. `stacks.test.ts` checks every copy against the key its link
 * pins and the generated module against what the copies decode to, so a copy
 * edited by hand, signed by anyone else or left behind by the generator fails
 * CI.
 *
 * Nothing here is imported by the bundles (config.ts reads the generated
 * module only): the parser and the links serve the refresh script and the tests.
 */

/**
 * Each network's descriptor link, as the network's operators publish it. The
 * key and URL belong to one incarnation of the network: update them, and the
 * copy, when a network resets.
 */
export const STACK_LINKS = {
  paseo:
    "polkadotapp://stack?key=0x2b89d8ca74aa2e11ab55f5af1168cd6929b88d1998aecd979b42cfc1078d5377&url=https%3A%2F%2Fstack-paseo-next.parity-testnet.parity.io%2F.well-known%2Ftrinity-stack.json",
  previewnet:
    "polkadotapp://stack?key=0x4d43362f03d5511632a210632d1fb7760b5a663580f12ffca34619f79357e239&url=https%3A%2F%2Fpreviewnet.substrate.dev%2F.well-known%2Ftrinity-stack.json",
} as const

export type StackNetwork = keyof typeof STACK_LINKS

/** The file of each network's signed copy, in ./stacks/. */
export const STACK_FILES: Record<StackNetwork, string> = { paseo: "paseo-next-v2.json", previewnet: "previewnet.json" }

/**
 * What each network's copy must carry: the descriptor `id` and `tld`, and
 * whether the app bakes its genesis (paseo does; previewnet's chains are reset
 * and rotate it, so it stays discovery-first and its genesis is optional).
 */
export const STACK_EXPECTED: Record<StackNetwork, { id: string; tld: string; genesis: boolean }> = {
  paseo: { id: "paseo-next-v2", tld: "paseo", genesis: true },
  previewnet: { id: "previewnet", tld: "testnet", genesis: false },
}

/** What the app takes from a network's descriptor. */
export interface HostedStack {
  readonly tld: string
  /** Base URL of the TURN issuer (service "turn"), without a trailing slash. */
  readonly turnUrl: string
  readonly peopleRpc: string
  readonly assetHubRpc: string
  readonly peopleGenesis?: `0x${string}`
  readonly assetHubGenesis?: `0x${string}`
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

/** The payload of a signed envelope, decoded as UTF-8 JSON. Throws when it is not one. */
export function decodePayload(envelope: unknown): Json {
  if (!isObject(envelope) || envelope.$v !== 1 || typeof envelope.payload !== "string" || typeof envelope.signature !== "string") {
    throw new Error("not a signed envelope")
  }
  let payload: unknown
  try {
    const bytes = Uint8Array.from(atob(envelope.payload), (char) => char.charCodeAt(0))
    payload = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error("payload is not base64 JSON")
  }
  if (!isObject(payload)) throw new Error("payload is not an object")
  return payload
}

const WSS = /^wss:\/\/[^\s/@]+(\/\S*)?$/
const HTTPS = /^https:\/\/[^\s/@]+(\/[^\s?#]*)?$/
const HASH = /^0x[0-9a-f]{64}$/

/**
 * Reads `HostedStack` out of a signed envelope, and throws a named error for
 * any value the app uses that it cannot find. Lists are read for their first
 * usable entry, hex is lowercased, and a genesis the app does not bake is
 * optional.
 */
export function readHostedStack(envelope: unknown, expected: { id: string; tld: string; genesis: boolean }): HostedStack {
  const fail = (reason: string): never => {
    throw new Error(`Trinity stack descriptor "${expected.id}": ${reason}`)
  }
  let payload: Json
  try {
    payload = decodePayload(envelope)
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
  if (payload.id !== expected.id) return fail(`id is ${JSON.stringify(payload.id)}, not "${expected.id}"`)
  if (payload.tld !== expected.tld) return fail(`tld is ${JSON.stringify(payload.tld)}, not "${expected.tld}"`)

  const chain = (role: string) => {
    const found = Array.isArray(payload.chains) ? payload.chains.find((c) => isObject(c) && c.role === role) : undefined
    if (!isObject(found)) return fail(`has no ${role} chain`)
    const rpc = Array.isArray(found.rpc) ? found.rpc.find((url): url is string => typeof url === "string" && WSS.test(url)) : undefined
    if (rpc === undefined) return fail(`${role} chain has no wss rpc`)
    const raw = typeof found.genesisHash === "string" ? found.genesisHash.toLowerCase() : undefined
    const genesis = raw !== undefined && HASH.test(raw) ? (raw as `0x${string}`) : undefined
    if (expected.genesis && genesis === undefined) return fail(`${role} chain has no genesisHash`)
    return { rpc, genesis }
  }
  const turn = Array.isArray(payload.services) ? payload.services.find((s) => isObject(s) && s.kind === "turn") : undefined
  const turnUrl = isObject(turn) && Array.isArray(turn.urls) ? turn.urls.find((url): url is string => typeof url === "string" && HTTPS.test(url)) : undefined
  if (turnUrl === undefined) return fail('has no https "turn" service url')

  const people = chain("People")
  const assetHub = chain("AssetHub")
  return {
    tld: expected.tld,
    turnUrl: turnUrl.replace(/\/$/, ""),
    peopleRpc: people.rpc,
    assetHubRpc: assetHub.rpc,
    ...(people.genesis !== undefined && { peopleGenesis: people.genesis }),
    ...(assetHub.genesis !== undefined && { assetHubGenesis: assetHub.genesis }),
  }
}
