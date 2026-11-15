// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { decodeLink, open } from "@parity/trinity-stack"
import { describe, expect, it } from "vitest"
import { NETWORK_CONFIG } from "./config"
import { STACK_EXPECTED, STACK_FILES, STACK_LINKS, decodePayload, readHostedStack, type StackNetwork } from "./stacks"
import { HOSTED_STACKS } from "./stacks.generated"
import { TURN_ISSUE_PATH } from "./turn-pass"

const networks = Object.keys(STACK_LINKS) as StackNetwork[]
const bytesOf = (network: StackNetwork) => readFileSync(resolve(import.meta.dirname, "stacks", STACK_FILES[network]))
const envelopeOf = (network: StackNetwork) => JSON.parse(bytesOf(network).toString("utf8"))
const utf8Base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))

type Part = { role?: string; kind?: string; rpc?: unknown; genesisHash?: unknown; urls?: unknown }
type Payload = { id?: unknown; tld?: unknown; chains: Part[]; services: Part[] }

/** A descriptor payload, edited, and wrapped as an envelope (unsigned: readHostedStack does not verify). */
function edited(network: StackNetwork, change: (payload: Payload) => void) {
  const envelope = envelopeOf(network)
  const payload = decodePayload(envelope) as unknown as Payload
  change(payload)
  return { ...envelope, payload: utf8Base64(JSON.stringify(payload)) }
}
const chainOf = (p: Payload, role: string) => p.chains.find((c) => c.role === role)!
const turnOf = (p: Payload) => p.services.find((s) => s.kind === "turn")!

describe("committed descriptor copies", () => {
  it.each(networks)("%s verifies against the key its link pins", (network) => {
    const verified = open(new Uint8Array(bytesOf(network)), decodeLink(STACK_LINKS[network]))
    expect(verified.descriptor.id).toBe(STACK_EXPECTED[network].id)
    expect(verified.descriptor.tld).toBe(STACK_EXPECTED[network].tld)
  })

  it("is refused under another network's key, and once any byte of the payload changes", () => {
    expect(() => open(new Uint8Array(bytesOf("paseo")), decodeLink(STACK_LINKS.previewnet))).toThrow()
    const tampered = envelopeOf("paseo")
    tampered.payload = utf8Base64(atob(tampered.payload).replace("wss://paseo-people", "wss://evil-people"))
    expect(() => open(new TextEncoder().encode(JSON.stringify(tampered)), decodeLink(STACK_LINKS.paseo))).toThrow()
  })

  it("selects each network's own descriptor", () => {
    expect(STACK_EXPECTED).toEqual({
      paseo: { id: "paseo-next-v2", tld: "paseo", genesis: true },
      previewnet: { id: "previewnet", tld: "testnet", genesis: false },
    })
    expect(decodeLink(STACK_LINKS.paseo).url).toBe("https://stack-paseo-next.parity-testnet.parity.io/.well-known/trinity-stack.json")
    expect(decodeLink(STACK_LINKS.previewnet).url).toBe("https://previewnet.substrate.dev/.well-known/trinity-stack.json")
  })
})

describe("generated stacks", () => {
  it.each(networks)("%s equals what its signed copy decodes to", (network) => {
    expect(HOSTED_STACKS[network]).toEqual(readHostedStack(envelopeOf(network), STACK_EXPECTED[network]))
  })

  it("holds the values of each network's descriptor", () => {
    expect(HOSTED_STACKS.previewnet).toMatchObject({
      tld: "testnet",
      turnUrl: "https://previewnet.substrate.dev/dub",
      peopleRpc: "wss://previewnet.substrate.dev/people",
      assetHubRpc: "wss://previewnet.substrate.dev/asset-hub",
    })
    expect(HOSTED_STACKS.paseo).toEqual({
      tld: "paseo",
      turnUrl: "https://identity.parity-prod.parity.io",
      peopleRpc: "wss://paseo-people-next-system-rpc.polkadot.io",
      assetHubRpc: "wss://paseo-asset-hub-next-rpc.polkadot.io",
      peopleGenesis: "0x4a2b5b737de1da59e209b0000a876ec2fa20035dc34fd292a848da32d255ad48",
      assetHubGenesis: "0x4349b00e54897e21196fd331015fc5be0f14e118beb0375ed2bb1793737bb57a",
    })
  })

  it("is the only thing config.ts imports of the stacks, so no bundle decodes an envelope", () => {
    const config = readFileSync(resolve(import.meta.dirname, "config.ts"), "utf8")
    expect(config).toContain('from "./stacks.generated"')
    expect(config).not.toMatch(/from "\.\/stacks"|\.json"/)
    expect(readFileSync(resolve(import.meta.dirname, "stacks.generated.ts"), "utf8")).not.toMatch(/payload|signature/)
  })

  it("leaves the issue-proof route to turn-pass, the one place that names it", () => {
    expect(TURN_ISSUE_PATH).toBe("/api/v1/turn/issue-with-proof")
  })
})

describe("readHostedStack", () => {
  it("reads the first usable entry of each list and lowercases hex", () => {
    const stack = readHostedStack(
      edited("paseo", (p) => {
        chainOf(p, "People").rpc = ["ws://plain.example", "wss://second.example/people", "wss://third.example"]
        chainOf(p, "AssetHub").genesisHash = String(chainOf(p, "AssetHub").genesisHash).toUpperCase().replace("0X", "0x")
        turnOf(p).urls = ["http://insecure.example/", "https://issuer.example/dub/", "https://other.example/"]
      }),
      STACK_EXPECTED.paseo,
    )
    expect(stack.peopleRpc).toBe("wss://second.example/people")
    expect(stack.turnUrl).toBe("https://issuer.example/dub")
    expect(stack.assetHubGenesis).toBe(HOSTED_STACKS.paseo.assetHubGenesis)
  })

  it("does not need a genesis the app does not bake, and ignores a malformed one", () => {
    const missing = readHostedStack(
      edited("previewnet", (p) => {
        delete chainOf(p, "People").genesisHash
        chainOf(p, "AssetHub").genesisHash = "0x12"
      }),
      STACK_EXPECTED.previewnet,
    )
    expect(missing.peopleGenesis).toBeUndefined()
    expect(missing.assetHubGenesis).toBeUndefined()
    expect(missing.peopleRpc).toBe("wss://previewnet.substrate.dev/people")
  })

  it("reads a payload as UTF-8", () => {
    const stack = readHostedStack(edited("previewnet", (p) => ((p as unknown as { name: string }).name = "Prévïewnet ✓")), STACK_EXPECTED.previewnet)
    expect(stack.tld).toBe("testnet")
  })

  it("fails by name, with no fallback value, on a value the app uses that it cannot read", () => {
    const expected = STACK_EXPECTED.paseo
    const cases: [string, unknown, string][] = [
      ["no envelope", undefined, "not a signed envelope"],
      ["a bare descriptor", { $v: 1, chains: [] }, "not a signed envelope"],
      ["a payload that is not base64 JSON", { $v: 1, payload: "!!", signature: "0x" }, "base64 JSON"],
      ["another network's descriptor", envelopeOf("previewnet"), 'id is "previewnet"'],
      ["another tld", edited("paseo", (p) => (p.tld = "dot")), 'tld is "dot"'],
      ["no People chain", edited("paseo", (p) => (p.chains = p.chains.filter((c) => c.role !== "People"))), "no People chain"],
      ["no AssetHub chain", edited("paseo", (p) => (p.chains = p.chains.filter((c) => c.role !== "AssetHub"))), "no AssetHub chain"],
      ["a People chain without an rpc", edited("paseo", (p) => (chainOf(p, "People").rpc = [])), "People chain has no wss rpc"],
      ["only a plain ws rpc", edited("paseo", (p) => (chainOf(p, "People").rpc = ["ws://x.example"])), "no wss rpc"],
      ["a bad genesis on a baked network", edited("paseo", (p) => (chainOf(p, "AssetHub").genesisHash = "0x12")), "AssetHub chain has no genesisHash"],
      ["no genesis on a baked network", edited("paseo", (p) => delete chainOf(p, "People").genesisHash), "People chain has no genesisHash"],
      ["no turn service", edited("paseo", (p) => (p.services = p.services.filter((s) => s.kind !== "turn"))), '"turn" service'],
      ["an empty turn service", edited("paseo", (p) => (turnOf(p).urls = [])), '"turn" service'],
      ["only an http turn url", edited("paseo", (p) => (turnOf(p).urls = ["http://issuer.example/"])), '"turn" service'],
      ["a turn url with credentials", edited("paseo", (p) => (turnOf(p).urls = ["https://u:p@issuer.example/"])), '"turn" service'],
    ]
    for (const [name, envelope, message] of cases) {
      expect(() => readHostedStack(envelope, expected), name).toThrow(message)
    }
    expect(() => readHostedStack(undefined, expected)).toThrow('Trinity stack descriptor "paseo-next-v2"')
  })
})

describe("hosted network table", () => {
  it("takes every network value from the descriptors", () => {
    expect(NETWORK_CONFIG.paseo).toEqual({
      dotnsTLD: "paseo",
      productAccount: "dim2",
      deviceUniquenessBackendUrl: "https://identity.parity-prod.parity.io",
      peopleRpc: "wss://paseo-people-next-system-rpc.polkadot.io",
      assetHubRpc: "wss://paseo-asset-hub-next-rpc.polkadot.io",
      genesis: {
        people: "0x4a2b5b737de1da59e209b0000a876ec2fa20035dc34fd292a848da32d255ad48",
        hubNextV2: "0x4349b00e54897e21196fd331015fc5be0f14e118beb0375ed2bb1793737bb57a",
      },
    })
    expect(NETWORK_CONFIG.previewnet).toEqual({
      dotnsTLD: "testnet",
      productAccount: "dim2",
      deviceUniquenessBackendUrl: "https://previewnet.substrate.dev/dub",
      peopleRpc: "wss://previewnet.substrate.dev/people",
      assetHubRpc: "wss://previewnet.substrate.dev/asset-hub",
    })
  })

  it("keeps previewnet discovery-first, with no baked genesis", () => {
    expect(NETWORK_CONFIG.previewnet.genesis).toBeUndefined()
  })

  it("carries none of the retired identity hosts", () => {
    expect(JSON.stringify(NETWORK_CONFIG)).not.toMatch(/dotspark/)
  })
})
