# Clip Display System - Implementation Plan

## Overview

Clips are visual representations of Melee gameplay segments from Slippi data. The display system has 4 modes based on zoom level, optimized to handle millions of clips smoothly.

---

## The 4 Modes

| Mode | Name | Rendering | Scroll | Content |
|------|------|-----------|--------|---------|
| 1 | **Full** | DOM | Yes | Stage, icons, text, buttons - full detail |
| 2 | **Detail** | DOM | No | Stage, icons, text, buttons - smaller |
| 3 | **Compact** | GPU | No | Stage image, character icons |
| 4 | **Micro** | GPU | No | Colored squares (stage color) |

### Mode Selection Logic

```typescript
const getMode = (zoomSize: number, visibleCount: number): Mode => {
  if (zoomSize >= thresholds.full) return 'full'
  if (zoomSize >= thresholds.mode2 && visibleCount <= limits.maxDomElements) return 'mode2'
  if (zoomSize >= thresholds.mode3) return 'mode3'
  return 'mode4'
}
```

Mode 2 has a dual constraint: zoom size AND element count. If there would be more than ~1000 visible clips, skip to GPU mode regardless of zoom.

---

## Data Strategy

### Two-Tier Data Model

**Light Data (all clips, always loaded):**
- Stage ID only (1 byte per clip)
- 10M clips = 10MB
- Used for GPU rendering colors
- Loaded once on archive open

**Full Data (on demand):**
- Stage, characters, players, frames, path, combo info, etc.
- Fetched only for visible range + buffer
- Cached by range
- Used for DOM modes

### Why Two Tiers?

GPU mode can render 10M colored squares without loading 10M full records. Only when you scroll/zoom to specific clips do we fetch their full data.

---

## Rendering Architecture

### Layer Structure

```
<Tray>
  <TrayControls />           // Zoom buttons, showing count
  <GpuLayer />               // Canvas, always mounted, opacity 0 or 1
  <DomLayer>                 // Virtualized container
    <Clip />...              // Individual clip elements (modes 1-2 only)
  </DomLayer>
</Tray>
```

Both layers stay mounted. Toggle visibility via opacity/display. Avoids mount/unmount overhead during mode transitions.

### GPU Layer (Modes 3-4)

- Single WebGL canvas
- Renders colored rectangles (mode 4) or textured quads (mode 3)
- Stage images as texture atlas
- Character icons as texture atlas (mode 3)
- No DOM elements for clips
- Click handling via canvas coordinates → clip index

### DOM Layer (Modes 1-2)

- Mode 1: Virtualized scrolling list, only visible clips mounted
- Mode 2: All clips mounted (capped at ~1000), no scroll
- Real DOM elements with event handlers

---

## Clip Component Structure (DOM)

```html
<div class="clip" style="width: {size}px; height: {size}px;">
  <!-- Everything inside is absolute positioned -->
  <!-- Container dimensions are the ONLY source of truth for size -->

  <div class="clip-bg">
    <img class="clip-stage" />     <!-- object-fit: cover -->
  </div>

  <div class="clip-characters">    <!-- centered overlay -->
    <img class="clip-char" />
    <img class="clip-arrow" />
    <img class="clip-char" />
  </div>

  <div class="clip-info">          <!-- bottom overlay, modes 1-2 -->
    <!-- player names, duration, etc -->
  </div>

  <div class="clip-actions">       <!-- top-right, modes 1-2 -->
    <button class="clip-play" />
    <button class="clip-record" />
  </div>
</div>
```

### CSS Principles

1. `.clip` gets explicit `width` and `height` (same value) via inline style
2. All children are `position: absolute`
3. Nothing inside can affect container dimensions
4. `overflow: hidden` on container clips everything
5. Images use `object-fit: cover` to fill without distorting

```css
.clip {
  position: relative;  /* or absolute when positioned in grid */
  overflow: hidden;
  box-sizing: border-box;
  /* width and height set via inline style */
}

.clip-bg {
  position: absolute;
  inset: 0;
}

.clip-stage {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.clip-characters {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12%;
  gap: 10%;
}

.clip-info {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  max-height: 40%;
  overflow: hidden;
}

.clip-actions {
  position: absolute;
  top: 8px;
  right: 8px;
}
```

---

## Configuration

```typescript
export const clipDisplayConfig = {
  // Zoom thresholds (px) for mode transitions
  thresholds: {
    full: 300,      // >= 300px = full mode
    mode2: 100,     // >= 100px = mode 2 (if under element limit)
    mode3: 20,      // >= 20px = mode 3
    // below 20px = mode 4
  },

  // Hard limits
  limits: {
    maxDomElements: 1000,  // Force GPU if more than this visible
  },

  // Feature visibility (can be adjusted per mode or by size)
  features: {
    buttons:   { minSize: 80 },
    text:      { minSize: 80 },
    charIcons: { minSize: 30 },
    borders:   { minSize: 20 },
    gaps:      { minSize: 15 },
  },

  // Visual tweaks
  style: {
    gapRatio: 0.05,        // gap as fraction of tile size
    borderWidth: 1,
    infoMaxHeight: '40%',
  },
}
```

---

## Performance Guarantees

### General

1. **No iteration of all clips in render** - position is calculated: `row = floor(i / cols)`, `col = i % cols`
2. **Throttle everything** - scroll/zoom handlers run through rAF, max once per frame
3. **No layout thrashing** - never read layout (getBoundingClientRect) during scroll/zoom
4. **Stable React keys** - clips don't recreate unnecessarily

### DOM Modes

5. **Virtualization** - Mode 1 only renders visible clips + small buffer
6. **CSS containment** - `contain: strict` on clips isolates layout
7. **Mode 2 cap** - never more than 1000 DOM clip elements

### GPU Modes

8. **Single draw call** - batch all rectangles/quads
9. **Texture atlas** - stage images in one texture, one bind
10. **Typed arrays** - position/color data in Float32Array, no GC pressure
11. **No CPU work per clip** - shader does all positioning

---

## Scroll Behavior

### Mode 1 (Full) - Scrollable

- Container has height based on total clips: `totalRows * cellSize + padding`
- Virtualized: only visible clips are in DOM
- Scroll position preserved when zooming in from other modes
- Standard browser scrolling

### Modes 2-4 - No Scroll

- All content fits in viewport (either limited by count or by tiny size)
- Zoom to see different levels of detail
- Click clip in GPU mode → could zoom to that clip in Full mode (future)

---

## Mode Transitions

### For Now: Instant

- Calculate new mode from zoom + visible count
- Swap layer visibility immediately
- No animation

### Future Enhancement

- Crossfade between layers
- Or: maintain position continuity (center of view stays centered)

---

## File Structure

```
src/renderer/
  components/
    Clip/
      Clip.tsx           # Main clip component (DOM)
      ClipFull.tsx       # Full mode variant
      ClipCompact.tsx    # Mode 2 variant
      Clip.css           # All clip styles
    Tray/
      Tray.tsx           # Main container, mode switching
      TrayControls.tsx   # Zoom buttons, count
      DomLayer.tsx       # Virtualized DOM clip list
      GpuLayer.tsx       # WebGL canvas rendering
      Tray.css
  config/
    clipDisplay.ts       # Thresholds, limits, feature flags
  hooks/
    useClipMode.ts       # Determines current mode
    useVisibleRange.ts   # Calculates visible clip range
    useGpuRenderer.ts    # WebGL setup and rendering
```

---

## Implementation Order

1. **Config** - Set up clipDisplayConfig with thresholds
2. **Clip component** - Rebuild from scratch with strict square constraint
3. **Mode detection** - useClipMode hook
4. **DOM layer** - Mode 1 with virtualization, Mode 2 without scroll
5. **GPU layer** - Mode 4 first (simple colors), then Mode 3 (textures)
6. **Integration** - Wire up in Tray, handle transitions
7. **Polish** - Tweak thresholds, test performance with large datasets
