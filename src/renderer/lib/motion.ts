import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Motion helpers (styles/Motion.css has the CSS side). Short, eased, never in
 * the way: nothing here delays an action, and everything is skipped when the
 * OS asks for reduced motion.
 */

export const EASE_OUT = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

export function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** Play a short Web Animation on an element (no-op with reduced motion). */
export function play(
  el: Element | null | undefined,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions = {},
): void {
  if (!el || reducedMotion() || typeof el.animate !== 'function') return
  el.animate(keyframes, { duration: 220, easing: EASE_OUT, ...options })
}

/** Fade and lift an element in, e.g. the results tray when its contents change. */
export function useEnterOnChange(
  ref: RefObject<HTMLElement | null>,
  key: unknown,
  { lift = true } = {},
): void {
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    play(
      ref.current,
      lift
        ? [
            { opacity: 0, transform: 'translateY(6px)' },
            { opacity: 1, transform: 'none' },
          ]
        : [{ opacity: 0 }, { opacity: 1 }],
      { duration: 240 },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}

/**
 * A number that counts up (or down) to `value` over `duration` ms when it
 * changes, instead of jumping. Shows `value` straight away with reduced motion,
 * on first render, and while `live` (a running count already ticks by itself).
 */
export function useCountUp(
  value: number | null | undefined,
  { duration = 600, live = false } = {},
): number | null | undefined {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  useEffect(() => {
    const start = from.current
    from.current = value
    if (
      value == null ||
      start == null ||
      live ||
      start === value ||
      reducedMotion()
    ) {
      setShown(value)
      return undefined
    }
    let frame = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration)
      const eased = 1 - (1 - p) ** 3
      setShown(Math.round(start + (value - start) * eased))
      if (p < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [value, live, duration])
  return shown
}

/** True for `ms` after `trigger` turns true (e.g. a step that just finished). */
export function useFlash(trigger: boolean, ms = 900): boolean {
  const [on, setOn] = useState(false)
  const was = useRef(trigger)
  useEffect(() => {
    const rising = trigger && !was.current
    was.current = trigger
    if (!rising || reducedMotion()) return undefined
    setOn(true)
    const t = setTimeout(() => setOn(false), ms)
    return () => clearTimeout(t)
  }, [trigger, ms])
  return on
}
