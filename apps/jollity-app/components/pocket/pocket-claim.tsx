// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/* eslint-disable @next/next/no-img-element -- gateway collectable art and a static cover asset */

/**
 * The chest's way into the Pocket: a ray falls from the pieces onto the open book at the foot of the screen, and a
 * swipe down raises the book while every collectable follows the finger onto its cell, before the cover snaps shut.
 *
 * The geometry is lib/pocket/book and the motion lib/pocket/motion. The swipe starts anywhere on `surface` except
 * inside a list scrolled away from its top, so a drag down in a scrolled inventory scrolls it back instead of
 * starting the swipe. A piece still in the chest's scatter flies in its shell from where the scatter draws it
 * (`ring`), and a pinned one flies as the flat art that carries `data-chest-piece`.
 *
 * The beats, by phase: `rest` (ray idle) → `held` (the swipe drags the book open and leans the pieces into the ray)
 * → either `returning` (let go short of the claim; everything springs back to `rest`) or `landing` (each piece flies
 * down the ray to its cell, STAGGER_MS apart) → `swelling` (the full book swells, SWELL_MS) → `closing` (the book
 * stands up and the cover swings shut, then bounces and sparkles) → `shut` (title and Continue).
 */
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react"
import { asset } from "@/lib/asset"
import { Button } from "@/components/ui/button"
import type { PieceSpot } from "@/components/chest/chest-scene"
import { BOOK, CLAIM_AT, PAGE_HALF, clamp01, claims, closedBookAt, landing, onCover, openBookAt, openScale, trackSwipe, type Point, type Swipe } from "@/lib/pocket/book"
import { JELLY, SNUG, coverSwing, standUp, settled, sparksFor, stepSpring, type Spark, type Spring } from "@/lib/pocket/motion"
import { wrappingExpected } from "@/lib/wrapping/availability"
import { ensureFields } from "@/lib/wrapping/fieldCache"
import { BASE, materialFor, wrappingPhase } from "@/lib/wrapping/materials"
import type { WrappingRenderer } from "@/lib/wrapping/renderer"

/** The bubble's own film colours, for the confetti. */
const FILM = ["#ff9ad5", "#c7a4ff", "#86d4ff", "#9cf0cf", "#ffe3a0", "#ffad8c"]
/** px a finger moves before the gesture decides whether it is a swipe down */
const SLOP = 8
/** px the ray reaches above the book's pages */
const RAY_LENGTH = 170
/** the ray's strength at rest, 0..1 (the `--ray` CSS variable) */
const RAY_AT_REST = 0.55
/** how fast the ray fades as the swipe progresses (gone at progress 1/3) */
const RAY_FADE = 3
/** where the ray meets the pages, as a share of their height from the top */
const RAY_ON_PAGES = 0.42
/** ms the swipe takes to finish once the finger lets go */
const LAND_MS = 700
/** ms into the close before the cover starts to swing */
const COVER_FROM_MS = 220
/** ms the book takes to stand up as it closes */
const STAND_MS = 1000
/** ms the cover takes to swing shut */
const COVER_MS = 1150
/** ms after the cover lands before the screen counts as shut */
const SHUT_AFTER_MS = 420
/** ms the book, title and Continue fade out on Continue, or back in after a refused hand-off */
const FADE_MS = 300
/** how many confetti sparks the shut throws */
const CONFETTI = 26
/** the cover's rebound velocity as it lands, in degrees per second */
const COVER_BOUNCE = -130
/** spring tunes (stiffness k, damping c; lib/pocket/motion stepSpring): the cover settling after its bounce */
const SETTLE = { k: 200, c: 16 }
/** the closed book gliding to the middle */
const GLIDE = { k: 42, c: 11 }
/** the closing book growing to its closed size */
const GROW = { k: 55, c: 9 }
/** the veil's opacity at a full swipe, scaled by the swipe's progress */
const VEIL_HELD = 0.75
/** the veil's opacity while the pieces land and the book closes */
const VEIL_LANDING = 0.92
/** the open book's horizontal position */
const POSITION = { k: 140, c: 22 }

type Phase = "rest" | "held" | "returning" | "landing" | "closing" | "shut"

interface Flight {
  pinned: HTMLImageElement | null
  cx: number
  cy: number
  art: number
  rotation: number
}

interface Drawn {
  cx: number
  cy: number
  scale: number
  rotate: number
  opacity: number
}

interface Finger {
  id: number
  start: Point
  ours: boolean | null
}

export interface PocketPiece {
  image: string
  rare: boolean
}

const still = (x: number): Spring => ({ x, v: 0 })
const easeOut = (t: number) => 1 - (1 - clamp01(t)) ** 3
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

export function PocketClaim({
  surface,
  pieces,
  ring,
  onRelease,
  hidden,
  claimed,
  refusals,
  onClaim,
  onDone,
}: {
  /** the element whose swipe down claims the pieces (the chest page) */
  surface: RefObject<HTMLElement | null>
  /** the collectables to send to the Pocket, in chest order */
  pieces: PocketPiece[]
  /** where the chest scene drew each unpinned piece on its last frame */
  ring: RefObject<PieceSpot[]>
  /** true when the pieces are lifted off the chest (it should stop drawing them), false when put back */
  onRelease: (released: boolean) => void
  /** ignore new swipes and hide the book (a piece is zoomed or the picker is open) */
  hidden: boolean
  /** the screen has claimed: run the landing without a swipe */
  claimed: boolean
  /** counts hand-offs the host refused; each new one brings Continue back */
  refusals: number
  /** the player claimed, by swipe or by the Claim all button */
  onClaim: () => void
  /** the player pressed Continue and the fade-out finished */
  onDone: () => void
}) {
  const [shut, setShut] = useState(false)
  const [confetti, setConfetti] = useState<Spark[] | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const veilRef = useRef<HTMLDivElement>(null)
  const rayRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<HTMLDivElement>(null)
  const coverRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const shellsRef = useRef<HTMLCanvasElement>(null)
  const shownRef = useRef<HTMLDivElement[]>([])
  const cellRefs = useRef<(HTMLImageElement | null)[]>([])
  const spriteRefs = useRef<(HTMLImageElement | null)[]>([])
  const renderer = useRef<WrappingRenderer | null>(null)
  const callbacks = useRef({ onClaim, onDone, onRelease })
  const hiddenRef = useRef(hidden)
  useEffect(() => {
    hiddenRef.current = hidden
  }, [hidden])
  const finger = useRef<Finger | null>(null)
  const swipe = useRef<Swipe | null>(null)
  const sim = useRef({
    phase: "rest" as Phase,
    phaseAt: 0,
    now: 0,
    progress: 0,
    returning: still(0),
    flights: [] as (Flight | null)[],
    drawn: [] as (Drawn | null)[],
    released: 0,
    closedAt: 0,
    veil: 0,
    ray: still(RAY_AT_REST),
    bookX: still(0),
    bookY: still(0),
    scale: still(1),
    tilt: still(BOOK.tilt),
    cover: still(BOOK.bend - 180),
    squash: still(0),
    sparkled: false,
    landedAt: 0,
    placed: false,
  })

  useEffect(() => {
    callbacks.current = { onClaim, onDone, onRelease }
  }, [onClaim, onDone, onRelease])

  const art = pieces.map((piece, index) => ({ src: piece.image, rare: piece.rare, index })).filter((piece) => piece.src)
  const cover = onCover(art.length)

  const frame = () => rootRef.current!.getBoundingClientRect()

  const rayBase = (box: DOMRect) => {
    const pages = [...bookRef.current!.querySelectorAll(".pocket-book-page, .pocket-book-face--inner")].map((el) => el.getBoundingClientRect())
    const top = Math.min(...pages.map((page) => page.top))
    const bottom = Math.min(box.bottom, Math.max(...pages.map((page) => page.bottom)))
    return top + (bottom - top) * RAY_ON_PAGES - box.top
  }

  const cellOnScreen = (k: number, box: DOMRect) => {
    const cell = cellRefs.current[k]!.getBoundingClientRect()
    return { at: { x: cell.left - box.left + cell.width / 2, y: cell.top - box.top + cell.height / 2 }, size: cell.width }
  }

  const fromPin = (index: number, box: DOMRect): Flight | null => {
    const pinned = surface.current?.querySelector<HTMLImageElement>(`img[data-chest-piece="${index}"]`)
    if (!pinned) return null
    const rect = pinned.getBoundingClientRect()
    if (rect.width === 0) return null
    const style = getComputedStyle(pinned)
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    return { pinned, cx: rect.left - box.left + rect.width / 2, cy: rect.top - box.top + rect.height / 2, art: Math.max(1, rect.width - padding), rotation: 0 }
  }

  const fromRing = (index: number, box: DOMRect): Flight | null => {
    const spot = ring.current?.find((s) => s.index === index)
    if (!spot) return null
    return { pinned: null, cx: spot.cx - box.left, cy: spot.cy - box.top, art: spot.size * BASE.fit, rotation: spot.rotation }
  }

  const lift = () => {
    const s = sim.current
    if (s.flights.length) return
    const box = frame()
    s.flights = art.map(({ index }, k) => {
      const flight = fromPin(index, box) ?? fromRing(index, box)
      const sprite = spriteRefs.current[k]
      if (!flight || !sprite) return null
      Object.assign(sprite.style, {
        left: `${flight.cx - flight.art / 2}px`,
        top: `${flight.cy - flight.art / 2}px`,
        width: `${flight.art}px`,
        height: `${flight.art}px`,
      })
      if (flight.pinned) flight.pinned.style.visibility = "hidden"
      return flight
    })
    s.drawn = s.flights.map((flight) => (flight ? { cx: flight.cx, cy: flight.cy, scale: 1, rotate: flight.rotation, opacity: 1 } : null))
    callbacks.current.onRelease(true)
  }

  const putBack = () => {
    const s = sim.current
    s.flights.forEach((flight, k) => {
      if (flight?.pinned) flight.pinned.style.visibility = ""
      const sprite = spriteRefs.current[k]
      if (sprite) sprite.style.opacity = "0"
    })
    s.flights = []
    s.drawn = []
    callbacks.current.onRelease(false)
  }

  const enter = (phase: Phase) => {
    sim.current.phase = phase
    sim.current.phaseAt = sim.current.now
  }

  const claim = (fromPlayer: boolean) => {
    const s = sim.current
    if (s.phase === "landing" || s.phase === "closing" || s.phase === "shut") return
    finger.current = null
    swipe.current = null
    lift()
    s.released = s.progress
    enter("landing")
    if (fromPlayer) callbacks.current.onClaim()
  }

  const letGo = () => {
    const held = swipe.current?.progress ?? 0
    swipe.current = null
    if (claims(held)) return claim(true)
    sim.current.returning = still(held)
    enter("returning")
  }

  const step = (now: number) => {
    const s = sim.current
    const dt = s.now ? (now - s.now) / 1000 : 0
    s.now = now
    const book = bookRef.current
    if (!rootRef.current || !book) return
    const box = frame()
    const stage = { width: box.width, height: box.height }
    const since = now - s.phaseAt

    if (s.phase === "held") s.progress = swipe.current?.progress ?? s.progress
    if (s.phase === "returning") {
      s.returning = stepSpring(s.returning, 0, SNUG, dt)
      s.progress = Math.max(0, s.returning.x)
      if (settled(s.returning, 0, 0.004)) {
        s.progress = 0
        putBack()
        enter("rest")
      }
    }
    if (s.phase === "landing") {
      s.progress = s.released + (1 - s.released) * easeOut(since / LAND_MS)
      if (since >= LAND_MS) {
        s.progress = 1
        navigator.vibrate?.(14)
        s.closedAt = now
        enter("closing")
      }
    }
    if (s.phase === "closing" && s.sparkled && now - s.landedAt > SHUT_AFTER_MS) {
      enter("shut")
      setShut(true)
    }

    const closed = s.phase === "closing" || s.phase === "shut"
    const closeSince = now - s.closedAt
    const swung = closed ? (s.sparkled ? 1 : coverSwing((closeSince - COVER_FROM_MS) / COVER_MS)) : 0
    const middle = closedBookAt(stage)
    const open = openScale(stage)
    const target = closed ? { x: middle.x + PAGE_HALF * open * (1 - swung), y: middle.y } : openBookAt(s.progress, stage)
    if (!s.placed) {
      s.bookX = still(target.x)
      s.bookY = still(target.y)
      s.scale = still(open)
      s.placed = true
    }
    s.bookX = stepSpring(s.bookX, target.x, closed ? GLIDE : POSITION, dt)
    s.bookY = stepSpring(s.bookY, target.y, closed ? GLIDE : SNUG, dt)
    s.scale = stepSpring(s.scale, closed ? open + (BOOK.grown - open) * swung : open, closed ? GROW : SNUG, dt)
    const stood = closed ? standUp(closeSince / STAND_MS) : 0
    s.tilt = closed ? still(BOOK.tilt * (1 - stood)) : stepSpring(s.tilt, BOOK.tilt, SNUG, dt)
    pageRef.current!.style.transform = `rotateY(${-BOOK.bend * (1 - Math.min(1, stood))}deg)`
    const opened = BOOK.bend - 180
    if (!closed) s.cover = stepSpring(s.cover, opened, SNUG, dt)
    else if (!s.sparkled) s.cover = still(opened * (1 - swung))
    else {
      s.cover = stepSpring(s.cover, 0, SETTLE, dt)
      if (s.cover.x > 0) s.cover = still(0)
    }
    if (s.phase === "closing" && !s.sparkled && closeSince >= COVER_FROM_MS + COVER_MS) {
      s.cover = { x: 0, v: COVER_BOUNCE }
      s.sparkled = true
      s.landedAt = now
      s.squash = { x: s.squash.x, v: s.squash.v + 3.4 }
      navigator.vibrate?.([12, 30, 20])
      book.classList.add("is-shimmering")
      if (!reducedMotion()) setConfetti(sparksFor(CONFETTI))
    }
    s.squash = stepSpring(s.squash, 0, JELLY, dt)
    const squash = Math.max(-0.14, Math.min(0.14, s.squash.x * 0.05))
    book.style.transform =
      `translate(${s.bookX.x - BOOK.width / 2}px, ${s.bookY.x - BOOK.height / 2}px) ` +
      `rotateX(${s.tilt.x}deg) scale(${s.scale.x * (1 - squash * 0.6)}, ${s.scale.x * (1 + squash)})`
    coverRef.current!.style.transform = `rotateY(${s.cover.x}deg) translateZ(1px)`

    const veilTarget = closed || s.phase === "landing" ? VEIL_LANDING : s.progress * VEIL_HELD
    s.veil += (veilTarget - s.veil) * Math.min(1, dt * 9)
    veilRef.current!.style.opacity = s.veil.toFixed(3)

    art.forEach((_, k) => {
      const cell = cellRefs.current[k]
      const flight = s.flights[k]
      const sprite = spriteRefs.current[k]
      if (!flight || !sprite) {
        if (cell) cell.style.opacity = String(closed ? 1 : clamp01((s.progress - CLAIM_AT) / (1 - CLAIM_AT)))
        return
      }
      const onPage = cellOnScreen(k, box)
      const pose = landing({
        from: { x: flight.cx, y: flight.cy },
        to: onPage.at,
        progress: closed ? 1 : s.progress,
        rotation: flight.rotation,
        endScale: onPage.size / flight.art,
      })
      const drawn: Drawn = { cx: flight.cx + pose.x, cy: flight.cy + pose.y, scale: pose.scale, rotate: pose.rotate, opacity: closed ? 0 : pose.opacity }
      s.drawn[k] = drawn
      if (cell) cell.style.opacity = String(1 - drawn.opacity)
      const shelled = !flight.pinned && !!renderer.current?.has(art[k]!.src)
      sprite.style.transform = `translate(${drawn.cx - flight.cx}px, ${drawn.cy - flight.cy}px) rotate(${drawn.rotate}deg) scale(${drawn.scale})`
      sprite.style.opacity = shelled ? "0" : String(drawn.opacity)
    })

    const ray = rayRef.current!
    const bottom = stage.height
    const top = rayBase(box) - RAY_LENGTH
    const rayTarget = s.phase === "rest" || s.phase === "held" || s.phase === "returning" ? RAY_AT_REST * (1 - clamp01(s.progress * RAY_FADE)) : 0
    s.ray = stepSpring(s.ray, rayTarget, SNUG, dt)
    ray.style.top = `${top}px`
    ray.style.height = `${bottom - top}px`
    ray.style.setProperty("--ray", Math.max(0, s.ray.x).toFixed(3))

    const shells = renderer.current
    if (shells) {
      const entries = s.flights.flatMap((flight, k) => {
        const piece = art[k]
        const drawn = s.drawn[k]
        if (!flight || flight.pinned || !piece || !drawn || drawn.opacity <= 0 || !shells.has(piece.src)) return []
        return [
          {
            id: String(piece.index),
            url: piece.src,
            material: materialFor(piece.src, piece.rare),
            phase: wrappingPhase(piece.index),
            brk: 0,
            hit: [0.5, 0.5] as const,
            moving: true,
            place: {
              cx: box.left + drawn.cx,
              cy: box.top + drawn.cy,
              size: (flight.art / BASE.fit) * drawn.scale,
              rotation: drawn.rotate,
              opacity: drawn.opacity,
            },
          },
        ]
      })
      shells.draw(entries, now)
    }
  }

  const handlers = useRef({ step, claim, letGo, putBack, lift, enter })
  useEffect(() => {
    handlers.current = { step, claim, letGo, putBack, lift, enter }
  })

  useEffect(() => {
    let frameId = 0
    const loop = (now: number) => {
      handlers.current.step(now)
      frameId = requestAnimationFrame(loop)
    }
    frameId = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(frameId)
      handlers.current.putBack()
    }
  }, [])

  useEffect(() => {
    if (claimed) handlers.current.claim(false)
  }, [claimed])

  useEffect(() => {
    const canvas = shellsRef.current
    if (!canvas || !wrappingExpected()) return
    let disposed = false
    void import("@/lib/wrapping/renderer").then(({ WrappingRenderer: Renderer }) => {
      if (disposed) return
      try {
        renderer.current = new Renderer(canvas)
      } catch {
        return
      }
      for (const { src } of art) {
        void ensureFields(src)
          .then((entry) => {
            if (!disposed) renderer.current?.upload(src, entry, entry.image)
          })
          .catch(() => {})
      }
    })
    return () => {
      disposed = true
      renderer.current?.dispose()
      renderer.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one renderer for the life of the Pocket
  }, [])

  useEffect(() => {
    const area = surface.current
    if (!area) return

    const scrolledAway = (target: EventTarget | null) => {
      for (let el = target as HTMLElement | null; el && el !== area; el = el.parentElement) {
        if (el.scrollTop > 0) return true
      }
      return false
    }

    const decide = (at: Point, target: EventTarget | null) => {
      const held = finger.current
      if (!held || held.ours !== null) return held?.ours ?? false
      const dx = at.x - held.start.x
      const dy = at.y - held.start.y
      if (Math.hypot(dx, dy) < SLOP) return false
      held.ours = dy > Math.abs(dx) && !scrolledAway(target)
      if (held.ours) {
        handlers.current.lift()
        swipe.current = trackSwipe(null, held.start)
        handlers.current.enter("held")
      }
      return held.ours
    }

    const idle = () => sim.current.phase === "rest" || sim.current.phase === "returning"

    const onDown = (event: PointerEvent) => {
      if (hiddenRef.current || !idle() || finger.current || (event.target as Element | null)?.closest("button")) return
      finger.current = { id: event.pointerId, start: { x: event.clientX, y: event.clientY }, ours: null }
    }

    const onMove = (event: PointerEvent) => {
      if (finger.current?.id !== event.pointerId) return
      if (!decide({ x: event.clientX, y: event.clientY }, event.target)) return
      swipe.current = trackSwipe(swipe.current, { x: event.clientX, y: event.clientY })
      if (swipe.current.progress >= 1) handlers.current.claim(true)
    }

    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!touch || !finger.current) return
      if (decide({ x: touch.clientX, y: touch.clientY }, event.target) && event.cancelable) event.preventDefault()
    }

    const onUp = (event: PointerEvent) => {
      if (finger.current?.id !== event.pointerId) return
      const ours = finger.current.ours
      finger.current = null
      if (ours) handlers.current.letGo()
    }

    const onCancel = (event: PointerEvent) => {
      if (finger.current?.id !== event.pointerId) return
      const ours = finger.current.ours
      finger.current = null
      if (!ours || sim.current.phase !== "held") return
      sim.current.returning = still(swipe.current?.progress ?? 0)
      swipe.current = null
      handlers.current.enter("returning")
    }

    area.addEventListener("pointerdown", onDown)
    area.addEventListener("touchmove", onTouchMove, { passive: false })
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
    return () => {
      area.removeEventListener("pointerdown", onDown)
      area.removeEventListener("touchmove", onTouchMove)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
    }
  }, [surface])

  useEffect(() => {
    if (refusals === 0) return
    for (const el of shownRef.current) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: "ease-out", fill: "forwards" })
  }, [refusals])

  const leave = () => {
    const shown = shownRef.current.filter(Boolean)
    if (shown.length === 0) return callbacks.current.onDone()
    const fades = shown.map((el) => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: "ease-in", fill: "forwards" }))
    void fades[0]!.finished.then(
      () => callbacks.current.onDone(),
      () => {},
    )
  }

  const cell = ({ src }: { src: string }, k: number) => (
    <img
      key={k}
      ref={(el) => {
        cellRefs.current[k] = el
      }}
      className="pocket-book-cell"
      src={src}
      alt=""
      draggable={false}
      decoding="async"
    />
  )

  return (
    <div ref={rootRef} className={`pocket-claim${shut ? " is-shut" : ""}${hidden ? " is-hidden" : ""}`} data-testid="pocket-claim" data-shut={shut ? "true" : "false"}>
      <div ref={veilRef} className="pocket-veil" aria-hidden="true" />
      <div
        ref={(el) => {
          if (el) shownRef.current[0] = el
        }}
        aria-hidden="true"
      >
        <div ref={bookRef} className="pocket-book">
          <div ref={pageRef} className="pocket-book-page">
            <div className="pocket-book-grid">{art.slice(cover).map((piece, k) => cell(piece, cover + k))}</div>
          </div>
          <div ref={coverRef} className="pocket-book-cover">
            <div className="pocket-book-face pocket-book-face--inner">
              <div className="pocket-book-grid">{art.slice(0, cover).map((piece, k) => cell(piece, k))}</div>
            </div>
            <div className="pocket-book-face pocket-book-face--outer">
              <img src={asset("/assets/album-cover.webp")} alt="" draggable={false} />
            </div>
          </div>
        </div>
      </div>
      <div ref={rayRef} className="pocket-ray" aria-hidden="true">
        <span className="pocket-ray-spark" />
      </div>
      {art.map(({ src }, k) => (
        <img
          key={k}
          ref={(el) => {
            spriteRefs.current[k] = el
          }}
          className="pocket-flight"
          src={src}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
      ))}
      <canvas ref={shellsRef} className="pocket-shells" aria-hidden="true" />
      {confetti ? (
        <div className="pocket-confetti" aria-hidden="true">
          {confetti.map((spark, k) => (
            <i
              key={k}
              style={
                {
                  "--dx": `${spark.dx}px`,
                  "--rise": `${spark.rise}px`,
                  "--fall": `${spark.fall}px`,
                  "--turn": `${spark.turn}deg`,
                  "--size": `${spark.size}px`,
                  "--film": FILM[spark.hue % FILM.length],
                  animationDelay: `${spark.delay}ms`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      ) : null}
      <div
        ref={(el) => {
          if (el) shownRef.current[1] = el
        }}
      >
        <h1 className="pocket-title" aria-hidden={!shut}>
          Added to your Pocket
        </h1>
      </div>
      {shut ? (
        <div
          ref={(el) => {
            if (el) shownRef.current[2] = el
          }}
          className="pocket-foot"
        >
          <Button size="lg" className="w-full max-w-sm" onClick={leave}>
            Continue
          </Button>
        </div>
      ) : (
        <button type="button" className="pocket-claim-without-gesture" onClick={() => claim(true)}>
          Claim all
        </button>
      )}
    </div>
  )
}
