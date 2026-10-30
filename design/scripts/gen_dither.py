"""Generate Polaris's dither frames (SVG) and state-coloured pixel icons.

The dither is a field of 2pt cells lit by a Bayer 4x4 threshold over a moving
diagonal wave. Each call renders one frame; vary `phase` to animate.
Standard library only:
    python3 design/scripts/gen_dither.py
Writes into design/assets/{dither,icons}.
"""
import math
import os

ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")
BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]


def out(sub, name):
    d = os.path.join(ASSETS, sub)
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, name)


def dither(w, h, color, cell=2, phase=0.0, base=0.2, amp=0.6, k=2.2):
    rects = []
    for y in range(h // cell):
        for x in range(w // cell):
            v = base + amp * 0.5 * (1 + math.sin((x * 0.9 + y * 0.6) / k - phase))
            if (BAYER4[y % 4][x % 4] + 0.5) / 16 < v:
                rects.append(
                    f'<rect x="{x * cell}" y="{y * cell}" width="{cell}" height="{cell}" '
                    f'fill="{color}" fill-opacity="{min(0.4 + 0.6 * v, 1):.2f}"/>'
                )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
        f'viewBox="0 0 {w} {h}" shape-rendering="crispEdges">' + "".join(rects) + "</svg>"
    )


FRAMES = {
    "dither-claude-16": dict(w=16, h=16, color="#D97757"),
    "dither-claude-16-light": dict(w=16, h=16, color="#C4562F"),
    "dither-codex-16": dict(w=16, h=16, color="#6FCBA0", phase=1.5),
    "dither-codex-16-light": dict(w=16, h=16, color="#1E8A5C", phase=1.5),
    "dither-opencode-16": dict(w=16, h=16, color="#E59AC1", phase=0.75),
    "dither-opencode-16-light": dict(w=16, h=16, color="#B8466A", phase=0.75),
    "dither-starlight-16": dict(w=16, h=16, color="#BCD3FF", phase=0.8),
    "dither-starlight-16-light": dict(w=16, h=16, color="#4F82E8", phase=0.8),
    "dither-claude-24": dict(w=24, h=24, color="#D97757", base=0.15, amp=0.7),
    "dither-claude-band": dict(w=120, h=6, color="#D97757", base=0.1, amp=0.75, k=3.5),
    "dither-codex-band-light": dict(w=120, h=6, color="#1E8A5C", base=0.1, amp=0.75, k=3.5, phase=1),
}

# Nucleo pixel icons (hand, square-terminal, circle-xmark), recoloured per Session State.
HAND = ["M19 21V7", "M16 10V5H17", "M13 10L13 3H14", "M10 10V1H11", "M7 12V3H10", "M4 10V16", "M6 18L6 18.01", "M8 20V21"]
TERM = ["M13 16H17", "M19 3H5", "M19 21H5", "M3 19V5", "M21 19V5", "M11.01 12L11 12", "M9.01 14L9 14", "M7.01 16L7 16", "M7.01 8L7 8", "M9.01 10L9 10"]
XMARK = ["M8 22L16 22", "M18.01 20L18 20", "M6.01 20L6 20", "M20.01 18L20 18", "M4.01 18L4 18", "M16.01 16L16 16", "M8.01 16L8 16",
         "M14.01 14L14 14", "M10.01 14L10 14", "M12.01 12L12 12", "M14.01 10L14 10", "M10.01 10L10 10", "M22 8L22 16", "M16.01 8L16 8",
         "M8.01 8L8 8", "M2 8L2 16", "M20.01 6L20 6", "M4 6L4 6.01", "M18.01 4L18 4", "M6 4L6 4.01", "M8 2L16 2"]
ICONS = {
    "px-hand-needs-dark": (HAND, "#F2C84B"),
    "px-hand-needs-light": (HAND, "#A67C00"),
    "px-term-dark": (TERM, "#9A9CA4"),
    "px-term-light": (TERM, "#74767D"),
    "px-x-failed-dark": (XMARK, "#F0645A"),
    "px-x-failed-light": (XMARK, "#D23B30"),
}


# The Polaris star: a symmetric 16x16 pixel star with a 2px spine, rays that step
# evenly (2, 4, 6, 8, 16 wide) and short diagonal rays, like an eight-point sparkle.
_HALF = {7.5: 1, 6.5: 1, 5.5: 1, 4.5: 2, 3.5: 2, 2.5: 3, 1.5: 4, 0.5: 8}


def star_cells():
    c = 7.5
    cells = set()
    for y in range(16):
        for x in range(16):
            dx, dy = abs(x - c), abs(y - c)
            if dx < _HALF[dy] or dy < _HALF[dx]:
                cells.add((x, y))
    for d in (3, 4):  # short diagonal rays
        cells |= {(d, d), (15 - d, d), (d, 15 - d), (15 - d, 15 - d)}
    return cells


def polaris_logo(tones, size=64):
    """tones: (outline, body, core). Pass one colour three times for a flat mark."""
    outline, body, core = tones
    cells = star_cells()
    rects = []
    for x, y in sorted(cells):
        edge = any((x + ox, y + oy) not in cells for ox, oy in ((1, 0), (-1, 0), (0, 1), (0, -1)))
        centre = abs(x - 7.5) + abs(y - 7.5) <= 2
        fill = core if centre else outline if edge else body
        rects.append(f'<rect x="{x}" y="{y}" width="1" height="1" fill="{fill}"/>')
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 16 16" '
        f'shape-rendering="crispEdges">' + "".join(rects) + "</svg>"
    )


# Constellation: Polaris's feature mark for the task graph. Three stars on a strict
# 16x16 grid (a 5px sparkle, two 3px crosses, one lone pixel) joined by dotted lines.
_CONST_STARS = [((11, 3), 2), ((3, 7), 1), ((7, 13), 1), ((14, 11), 0)]
_CONST_LINKS = [(0, 1), (1, 2), (2, 3)]


def constellation_cells():
    stars, cores = set(), set()
    for (cx, cy), r in _CONST_STARS:
        cores.add((cx, cy))
        for d in range(-r, r + 1):
            stars |= {(cx + d, cy), (cx, cy + d)}
    near = {(x + ox, y + oy) for x, y in stars for ox, oy in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1))}
    links = set()
    for a, b in _CONST_LINKS:
        (x0, y0), (x1, y1) = _CONST_STARS[a][0], _CONST_STARS[b][0]
        n = max(abs(x1 - x0), abs(y1 - y0))
        pts = [(round(x0 + (x1 - x0) * i / n), round(y0 + (y1 - y0) * i / n)) for i in range(n + 1)]
        links |= {q for i, q in enumerate(pts) if i % 2 == 1 and q not in near}
    return stars, cores, links


def constellation_icon(star, core, line, size=16):
    stars, cores, links = constellation_cells()
    rects = [f'<rect x="{x}" y="{y}" width="1" height="1" fill="{line}"/>' for x, y in sorted(links)]
    rects += [f'<rect x="{x}" y="{y}" width="1" height="1" fill="{core if (x, y) in cores else star}"/>' for x, y in sorted(stars)]
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 16 16" '
        f'shape-rendering="crispEdges">' + "".join(rects) + "</svg>"
    )


def icon(paths, color):
    body = "".join(f'<path d="{d}"/>' for d in paths)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" '
        f'stroke="{color}" stroke-width="2" stroke-linecap="square">{body}</svg>'
    )


if __name__ == "__main__":
    for name, kw in FRAMES.items():
        with open(out("dither", f"{name}.svg"), "w") as f:
            f.write(dither(**kw))
    for name, (paths, color) in ICONS.items():
        with open(out("icons", f"{name}.svg"), "w") as f:
            f.write(icon(paths, color))
    # Shaded logo (outline, body, core) for 24px and up; flat versions for small UI use.
    LOGOS = {
        "polaris-logo-starlight": ("#7C9FE8", "#BCD3FF", "#FFFFFF"),
        "polaris-logo-blue": ("#2F5FC4", "#4F82E8", "#A9C4FA"),
        "polaris-logo-white": ("#F4F5F7",) * 3,
        "polaris-logo-ink": ("#17181A",) * 3,
    }
    for name, tones in LOGOS.items():
        with open(out("brand", f"{name}.svg"), "w") as f:
            f.write(polaris_logo(tones))
    FLAT = {"px-polaris-dark": "#BCD3FF", "px-polaris-light": "#4F82E8", "px-polaris-ink": "#17181A", "px-polaris-white": "#F4F5F7"}
    for name, color in FLAT.items():
        with open(out("icons", f"{name}.svg"), "w") as f:
            f.write(polaris_logo((color,) * 3, size=16))
    CONSTELLATION = {
        "px-constellation-dark": ("#BCD3FF", "#FFFFFF", "#BCD3FF66"),
        "px-constellation-light": ("#4F82E8", "#2F5FC4", "#4F82E873"),
        "px-constellation-white": ("#F4F5F7", "#F4F5F7", "#F4F5F766"),
    }
    for name, tones in CONSTELLATION.items():
        with open(out("icons", f"{name}.svg"), "w") as f:
            f.write(constellation_icon(*tones))
