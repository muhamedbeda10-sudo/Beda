// ============================================================================
// §10.7 — the photo viewer. A photo is evidence, so it has to open large and
// be examined: pinch or wheel to zoom, drag to move, double-tap to fill the
// screen, swipe sideways between photos and down to put them away. Touch and
// mouse go through the same pointer events, so a tablet on the floor and a
// desktop in the office behave alike. Where the photos can be changed, the
// viewer also offers to remove the one on screen. A photo the caller can load
// in full is saved on the device as it was taken: on a phone or a tablet
// through the share sheet ("Save image" puts it with the photos), on a
// computer as a download. Its bytes are fetched as it comes on screen, so the
// press saves at once (a phone only lets a share follow a tap closely).
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Download, Loader2, RotateCw, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { photoFileName, saveImageFile } from '@/lib/imageExport'
import { lockBodyScroll } from '@/lib/utils'

/** Minimal shape the viewer needs — decoupled from any storage model. */
export interface ViewableImage {
  id: string
  dataUrl: string
  caption?: string
  /** How to save it: its name (an extension is added from what it is) and its bytes in full. None: no Save button. */
  save?: { name: string; load: () => Promise<Blob> }
}

const MIN_ZOOM = 1
const MAX_ZOOM = 6
/** How far a finger travels before a tap counts as a drag. */
const TAP_SLOP = 12
/** Sideways travel that changes photo, and downward travel that closes. */
const SWIPE_NEXT = 60
const SWIPE_CLOSE = 110

interface Point {
  x: number
  y: number
}

export function Lightbox({
  images,
  startIndex = 0,
  onClose,
  onRemove,
  onIndexChange,
}: {
  images: ViewableImage[]
  startIndex?: number
  onClose: () => void
  /**
   * Given where the photos can be changed: a "Remove photo" button, which
   * passes the index of the photo on screen. The caller removes it, and
   * decides whether the viewer stays open on the rest.
   */
  onRemove?: (index: number) => void
  /** Told which photo is on screen as it changes, so the caller can fetch it in full. */
  onIndexChange?: (index: number) => void
}) {
  const [idx, setIdx] = useState(startIndex)
  useEffect(() => {
    onIndexChange?.(idx)
  }, [idx, onIndexChange])
  // A photo removed from under the viewer shortens the list: stay on the last one rather than past the end.
  useEffect(() => {
    if (images.length > 0 && idx > images.length - 1) setIdx(images.length - 1)
  }, [idx, images.length])
  const [zoom, setZoom] = useState(1)
  const [rot, setRot] = useState(0)
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 })
  /** Animate the transform: on for a snap back or a button, off while a finger is down. */
  const [smooth, setSmooth] = useState(false)

  // Each photo's bytes, asked for as it comes on screen: ready when Save is pressed.
  const loads = useRef(new Map<string, Promise<Blob>>())
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const onScreen = images[Math.min(idx, images.length - 1)]
  const loadOf = useCallback((im: ViewableImage): Promise<Blob> | null => {
    if (!im.save) return null
    let p = loads.current.get(im.id)
    if (!p) {
      p = im.save.load()
      // A failure is said when Save is pressed, not as an unhandled rejection meanwhile.
      p.catch(() => undefined)
      loads.current.set(im.id, p)
    }
    return p
  }, [])
  useEffect(() => {
    setSaveError(null)
    if (onScreen) loadOf(onScreen)
  }, [onScreen, loadOf])
  const save = async () => {
    const im = onScreen
    const p = im && loadOf(im)
    if (!im?.save || !p || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const blob = await p
      await saveImageFile(photoFileName(im.save.name, blob.type), blob)
    } catch {
      // Asked again on the next press.
      loads.current.delete(im.id)
      setSaveError('The photo could not be saved. Check the connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  const stage = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  /** Every finger (or the mouse) currently down, by pointer id. */
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<{ zoom: number; pan: Point; distance: number; middle: Point; start: Point; moved: boolean } | null>(null)
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null)

  const reset = useCallback(() => {
    setZoom(1)
    setRot(0)
    setPan({ x: 0, y: 0 })
  }, [])

  const go = useCallback(
    (d: number) => {
      if (images.length < 2) return
      setSmooth(false)
      setIdx((i) => (i + d + images.length) % images.length)
      reset()
    },
    [images.length, reset],
  )

  /** The container's centre in screen coordinates. */
  const centre = (): Point => {
    const r = stage.current?.getBoundingClientRect()
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 }
  }

  /**
   * How far the photo may be moved so part of it always stays on screen: half
   * the difference between its size on screen and the container. A quarter
   * turn swaps its width and height.
   */
  const clamp = useCallback((next: Point, z: number, r: number): Point => {
    const el = imgRef.current
    const box = stage.current?.getBoundingClientRect()
    if (!el || !box) return next
    const quarter = Math.abs(r / 90) % 2 === 1
    const w = (quarter ? el.offsetHeight : el.offsetWidth) * z
    const h = (quarter ? el.offsetWidth : el.offsetHeight) * z
    const limitX = Math.max(0, (w - box.width) / 2)
    const limitY = Math.max(0, (h - box.height) / 2)
    return { x: Math.min(limitX, Math.max(-limitX, next.x)), y: Math.min(limitY, Math.max(-limitY, next.y)) }
  }, [])

  /**
   * Zoom to `next` keeping whatever is under `at` where it is. The photo's
   * centre sits at the container centre plus the pan, so the pan that holds a
   * point still is d(1 − f) + f·pan, with d the point's offset from the centre
   * and f the change in scale.
   */
  const zoomAt = useCallback(
    (next: number, at: Point) => {
      const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
      const f = target / zoom
      const c = centre()
      const d = { x: at.x - c.x, y: at.y - c.y }
      setZoom(target)
      setPan(clamp({ x: d.x * (1 - f) + f * pan.x, y: d.y * (1 - f) + f * pan.y }, target, rot))
    },
    [clamp, pan.x, pan.y, rot, zoom],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === '+' || e.key === '=') {
        setSmooth(true)
        zoomAt(zoom + 0.5, centre())
      } else if (e.key === '-') {
        setSmooth(true)
        zoomAt(zoom - 0.5, centre())
      } else if (e.key === '0') {
        setSmooth(true)
        reset()
      }
    }
    document.addEventListener('keydown', onKey)
    const unlock = lockBodyScroll()
    return () => {
      document.removeEventListener('keydown', onKey)
      unlock()
    }
  }, [go, onClose, reset, zoom, zoomAt])

  // ---- Gestures -------------------------------------------------------------

  const positions = (): Point[] => Array.from(pointers.current.values())
  const distanceOf = (p: Point[]) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)
  const middleOf = (p: Point[]) => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 })

  const beginGesture = () => {
    const p = positions()
    gesture.current = {
      zoom,
      pan,
      distance: p.length > 1 ? distanceOf(p) : 0,
      middle: p.length > 1 ? middleOf(p) : p[0],
      start: p[0],
      moved: gesture.current?.moved ?? false,
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    // A middle or right button is not a gesture.
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // Keeping the pointer means a finger that slides off the photo still
    // moves it. A browser that refuses simply pans a little less far.
    try {
      stage.current?.setPointerCapture(e.pointerId)
    } catch {
      /* not capturable */
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    setSmooth(false)
    beginGesture()
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (!g) return
    const p = positions()

    if (p.length > 1) {
      // Two fingers: the distance between them sets the scale, and their
      // middle moving carries the photo with it.
      const scale = distanceOf(p) / (g.distance || 1)
      const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, g.zoom * scale))
      const f = target / g.zoom
      const c = centre()
      const now = middleOf(p)
      const d = { x: g.middle.x - c.x, y: g.middle.y - c.y }
      const next = {
        x: d.x * (1 - f) + f * g.pan.x + (now.x - g.middle.x),
        y: d.y * (1 - f) + f * g.pan.y + (now.y - g.middle.y),
      }
      g.moved = true
      setZoom(target)
      setPan(clamp(next, target, rot))
      return
    }

    const dx = p[0].x - g.start.x
    const dy = p[0].y - g.start.y
    if (Math.hypot(dx, dy) > TAP_SLOP) g.moved = true
    // Zoomed in, the finger moves the photo; at full view it drags the whole
    // photo, and letting go decides: next photo, close, or back where it was.
    setPan(zoom > 1 ? clamp({ x: g.pan.x + dx, y: g.pan.y + dy }, zoom, rot) : { x: g.pan.x + dx, y: g.pan.y + dy })
  }

  const finishPointer = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return
    const g = gesture.current
    if (pointers.current.size > 0) {
      // A finger was lifted mid-pinch: carry on from where the rest are.
      beginGesture()
      return
    }
    gesture.current = null
    if (!g) return

    if (!g.moved) {
      const point = { x: e.clientX, y: e.clientY }
      const onPhoto = imgRef.current?.contains(e.target as Node) ?? false
      const previous = lastTap.current
      const quick = previous && Date.now() - previous.at < 300 && Math.hypot(point.x - previous.x, point.y - previous.y) < 40
      if (onPhoto && quick) {
        lastTap.current = null
        setSmooth(true)
        zoomAt(zoom > 1 ? MIN_ZOOM : 2.5, point)
        return
      }
      lastTap.current = { at: Date.now(), ...point }
      // A tap beside the photo puts it away; a tap on the photo waits to see
      // whether a second one follows.
      if (!onPhoto) onClose()
      return
    }

    if (zoom > 1) return

    const dx = pan.x
    const dy = pan.y
    setSmooth(true)
    if (Math.abs(dx) > SWIPE_NEXT && Math.abs(dx) > Math.abs(dy) && images.length > 1) {
      go(dx < 0 ? 1 : -1)
      return
    }
    if (dy > SWIPE_CLOSE) {
      onClose()
      return
    }
    setPan({ x: 0, y: 0 })
  }

  if (images.length === 0) return null
  const img = images[Math.min(idx, images.length - 1)]
  // Black behind the photo while it is being read; swiping it away at full
  // view fades that black with the movement, so the page reappears underneath.
  const backdrop = zoom === 1 ? Math.max(0, 1 - Math.abs(pan.y) / 420) : 1

  const control = 'grid h-11 w-11 place-items-center rounded-xl text-white transition-colors hover:bg-white/15 active:bg-white/25 disabled:opacity-40 disabled:hover:bg-transparent'

  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col animate-fade-in" style={{ backgroundColor: `rgba(0,0,0,${backdrop})` }}>
      {/* Top bar */}
      <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-white safe-top">
        <span className="min-w-0 flex-1 truncate text-xs opacity-80 sm:text-sm">
          {images.length > 1 && <span className="font-semibold tabular-nums">{idx + 1} / {images.length}</span>}
          {img.caption ? `${images.length > 1 ? ' · ' : ''}${img.caption}` : ''}
          {saveError && (
            <span role="alert" className="block truncate font-semibold text-rose-300">
              {saveError}
            </span>
          )}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            className={control}
            onClick={() => {
              setSmooth(true)
              zoomAt(zoom - 0.5, centre())
            }}
            disabled={zoom <= MIN_ZOOM}
            aria-label="Zoom out"
          >
            <ZoomOut className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setSmooth(true)
              reset()
            }}
            className="min-w-[3rem] rounded-lg px-1 py-2 text-center text-xs font-semibold tabular-nums text-white/80 hover:bg-white/10"
            aria-label="Reset zoom"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            className={control}
            onClick={() => {
              setSmooth(true)
              zoomAt(zoom + 0.5, centre())
            }}
            disabled={zoom >= MAX_ZOOM}
            aria-label="Zoom in"
          >
            <ZoomIn className="h-5 w-5" />
          </button>
          {img.save && (
            <button className={control} onClick={() => void save()} disabled={saving} aria-label="Save photo" data-tip="Save photo">
              {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Download className="h-5 w-5" />}
            </button>
          )}
          <button
            className={control}
            onClick={() => {
              setSmooth(true)
              setRot((r) => r + 90)
              setPan({ x: 0, y: 0 })
            }}
            aria-label="Rotate"
          >
            <RotateCw className="h-5 w-5" />
          </button>
          <button className={control} onClick={onClose} aria-label="Close">
            <X className="h-6 w-6" />
          </button>
        </div>
      </div>

      {/* Photo stage */}
      <div
        ref={stage}
        className="relative flex-1 select-none overflow-hidden overscroll-contain"
        style={{ touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onWheel={(e) => {
          setSmooth(false)
          zoomAt(zoom - e.deltaY * 0.003 * zoom, { x: e.clientX, y: e.clientY })
        }}
      >
        <img
          ref={imgRef}
          src={img.dataUrl}
          alt={img.caption || 'inspection photo'}
          draggable={false}
          className={`absolute left-1/2 top-1/2 max-h-full max-w-full object-contain ${smooth ? 'transition-transform duration-200 ease-out' : ''}`}
          style={{
            transform: `translate(-50%,-50%) translate(${pan.x}px,${pan.y}px) scale(${zoom}) rotate(${rot}deg)`,
            cursor: zoom > 1 ? 'grab' : 'zoom-in',
          }}
        />

        {/* A mouse gets arrows; a finger swipes. */}
        {images.length > 1 && (
          <>
            <button
              className="absolute left-2 top-1/2 hidden -translate-y-1/2 place-items-center rounded-full bg-black/40 p-2.5 text-white hover:bg-black/60 [@media(hover:hover)]:grid"
              onClick={() => go(-1)}
              aria-label="Previous photo"
            >
              <ChevronLeft className="h-7 w-7" />
            </button>
            <button
              className="absolute right-2 top-1/2 hidden -translate-y-1/2 place-items-center rounded-full bg-black/40 p-2.5 text-white hover:bg-black/60 [@media(hover:hover)]:grid"
              onClick={() => go(1)}
              aria-label="Next photo"
            >
              <ChevronRight className="h-7 w-7" />
            </button>
          </>
        )}
      </div>

      {/* Thumbnails, and the way to remove the photo on screen */}
      {(images.length > 1 || onRemove) && (
        <div className="flex items-center gap-2 px-3 py-2 safe-bottom">
          {images.length > 1 && (
            <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
              {images.map((im, i) => (
                <button
                  key={im.id}
                  onClick={() => {
                    setSmooth(false)
                    setIdx(i)
                    reset()
                  }}
                  className={`h-14 w-14 shrink-0 overflow-hidden rounded-lg ring-2 transition-opacity ${i === idx ? 'ring-brand-500' : 'opacity-60 ring-transparent'}`}
                  aria-label={`Photo ${i + 1}`}
                >
                  <img src={im.dataUrl} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(Math.min(idx, images.length - 1))}
              className="ms-auto inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-xl bg-white/10 px-4 text-sm font-semibold text-white transition-colors hover:bg-rose-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-white active:bg-rose-700"
            >
              <Trash2 className="h-4 w-4" /> Remove photo
            </button>
          )}
        </div>
      )}
    </div>,
    document.body,
  )
}
