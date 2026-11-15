// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The motion of the Pocket, in the language of the chest's bubble: springs that overshoot and settle, and a cover
 * that lands with a thud.
 */
import { clamp01 } from "./book"

export interface Spring {
  x: number
  v: number
}

export interface SpringTune {
  k: number
  c: number
}

export const SNUG: SpringTune = { k: 320, c: 30 }
export const BOUNCY: SpringTune = { k: 150, c: 13 }
export const JELLY: SpringTune = { k: 420, c: 14 }

/** One step of a damped spring towards `target`, never longer than a frame at 30 fps so a stall cannot blow it up. */
export function stepSpring(spring: Spring, target: number, tune: SpringTune, dt: number): Spring {
  const h = Math.min(dt, 1 / 30)
  const v = spring.v + ((target - spring.x) * tune.k - spring.v * tune.c) * h
  return { x: spring.x + v * h, v }
}

export const settled = (spring: Spring, target: number, within = 0.002) =>
  Math.abs(spring.x - target) < within && Math.abs(spring.v) < within * 10

/**
 * How far the cover has swung shut, `t` from 0 to 1: it lifts off slowly, gathers speed over the spine and lands
 * still moving, so the landing reads as a soft thud rather than a stop.
 */
export function coverSwing(t: number): number {
  const k = clamp01(t)
  return 0.6 * k * k * (3 - 2 * k) + 0.4 * k * k
}

/**
 * How far the book has stood up off the table, `t` from 0 to 1: quick off the table, slowing as it comes upright,
 * and leaning a hair past upright before it settles, the way a book is lifted by hand.
 */
export function standUp(t: number): number {
  const k = clamp01(t)
  const lean = 1.1
  const u = k - 1
  return 1 + (lean + 1) * u * u * u + lean * u * u
}

export interface Spark {
  dx: number
  rise: number
  fall: number
  turn: number
  size: number
  delay: number
  hue: number
}

/** The confetti of the close: a fan thrown up and out that gravity brings down, the same every time for a seed. */
export function sparksFor(count: number, seed = 7): Spark[] {
  let s = seed
  const next = () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
  return Array.from({ length: count }, (_, k) => {
    const angle = -Math.PI / 2 + ((k / Math.max(1, count - 1)) * 2 - 1) * (Math.PI * 0.42) + (next() - 0.5) * 0.3
    const speed = 150 + next() * 130
    return {
      dx: Math.cos(angle) * speed,
      rise: -Math.abs(Math.sin(angle) * speed),
      fall: 180 + next() * 160,
      turn: (next() - 0.5) * 720,
      size: 6 + next() * 6,
      delay: next() * 90,
      hue: k,
    }
  })
}
